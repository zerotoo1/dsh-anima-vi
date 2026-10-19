/**
 * dsh-voice-v synthesis + cache: one cached MP3 per
 * sha256(text + voice + rate + pitch + volume), produced by the `edge-tts` CLI
 * — or, when a deployment opts in, by an OpenAI-compatible HTTP endpoint.
 *
 * Three properties matter here.
 *
 * 1. No caller text ever reaches a shell or an argv element. The CLI is spawned
 *    with `shell: false`, the text travels through a UTF-8 temp file read by
 *    `--file`, and every other argument is a plugin-owned literal.
 * 2. Child output is not captured through pipes. stdout is ignored and stderr
 *    is redirected to a real file descriptor, which keeps the module usable
 *    under a confined sandbox where `child_process` cannot open named pipes.
 * 3. Concurrent callers asking for the same chunk share one edge-tts process.
 *
 * ## The two providers
 *
 * `edge-tts` is the default and is not changed in any way by the custom
 * endpoint: the same binary, the same argv, the same cache slot, the same
 * errors. The HTTP path is taken only when the effective settings name the
 * `custom` provider AND carry a base URL and a model — an opt-in that a
 * deployment switches on with three settings.
 *
 * The HTTP path speaks the OpenAI `POST /audio/speech` shape and writes its
 * bytes into the very same MP3 cache, so the `/speak` flow, the audio route
 * and the client are unchanged by the switch. The API key is a secret: it
 * travels in the `Authorization` header, it is never logged, it never reaches
 * an error message, and it is deliberately NOT part of the cache key.
 *
 * @module dsh-voice-v/synth
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TTS_PROVIDER_CUSTOM,
  TTS_PROVIDER_EDGE,
  buildEdgeTtsArgs,
  normalizePitch,
  normalizeRate,
  normalizeTtsProvider,
  normalizeVolume,
} from './config.js';

/**
 * The bounds OpenAI's `speed` parameter accepts.
 *
 * The plugin's own tempo slider is a percentage around 100%, which maps onto
 * `1 + rate/100`; the bounds are the provider's, not the plugin's, and a
 * tempo outside them is clamped rather than rejected.
 */
export const SPEED_RANGE = Object.freeze({ min: 0.25, max: 4.0 });

/**
 * Cache key for one synthesis request.
 *
 * The key covers the material of the audio: the text, the voice, the tempo,
 * the tone and the volume. The custom provider adds its own material — the
 * provider, the model and the base URL — so two providers never share a cache
 * slot and a file spoken by `edge-tts` is never served for a custom request.
 *
 * The API key is NOT part of the key: a secret must never reach a cache key
 * (the key is the file's name), and replacing a key must not re-synthesize
 * everything.
 * @param request - `text`, `voice`, `rate`, `pitch`, and optional `volume`,
 *   `ttsProvider`, `customModel` and `customBaseUrl`.
 * @returns Lowercase hex sha256, the cache file's basename.
 */
export function cacheKeyFor(request) {
  const material = [
    request.text,
    request.voice,
    normalizeRate(request.rate),
    normalizePitch(request.pitch),
    normalizeVolume(request.volume ?? '+0%'),
  ].join('\u0000');
  const provider = normalizeTtsProvider(request.ttsProvider);
  if (provider === TTS_PROVIDER_EDGE) {
    // The local CLI keeps the key it always had: an opt-in endpoint must not
    // invalidate the cache of a deployment that does not use it.
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }
  const custom = [
    material,
    provider,
    String(request.customModel ?? '').trim(),
    String(request.customBaseUrl ?? '').trim(),
  ].join('\u0000');
  return createHash('sha256').update(custom, 'utf8').digest('hex');
}

/** Cache keys are exactly this shape; nothing else ever touches the disk. */
export const CACHE_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The URL of the OpenAI-compatible speech endpoint.
 *
 * The base URL is trimmed of whitespace and of its trailing slashes; a base
 * that already names the endpoint is used as it is, so a full endpoint URL is
 * never doubled:
 *
 *  * `https://api.openai.com/v1` → `https://api.openai.com/v1/audio/speech`
 *  * `https://api.openai.com/v1/audio/speech` → unchanged
 * @param baseUrl - The configured base URL.
 * @returns The endpoint URL, or an empty string when no base URL is given.
 */
export function customSpeechUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  if (raw === '') return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (/\/audio\/speech$/i.test(trimmed)) return trimmed;
  return `${trimmed}/audio/speech`;
}

/**
 * The `speed` parameter of the OpenAI speech API, derived from the plugin's
 * tempo.
 *
 * The tempo is an edge-tts literal (`+6%`); OpenAI's `speed` is a multiplier
 * around 1, so `+6%` becomes `1.06`. A tempo nobody configured produces no
 * parameter at all — the provider's own default then decides.
 * @param rate - The tempo literal, or nothing.
 * @returns The speed multiplier, or `null` when there is no usable tempo.
 */
export function speedForRate(rate) {
  const raw = String(rate ?? '').trim();
  if (raw === '') return null;
  const match = /^([+-]?\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  if (match === null) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return null;
  return Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, 1 + percent / 100));
}

/**
 * Build the request of the OpenAI-compatible speech endpoint.
 *
 * The body is the shape the API documents — `{ model, input, voice,
 * response_format }` — plus the `speed` derived from the tempo when a tempo is
 * configured. The key is not part of the body: it travels in the
 * `Authorization` header, and it is left out entirely when none is set (a
 * local endpoint that needs no key still works).
 * @param options - `baseUrl`, `model`, `voice`, `text`, `rate` and `apiKey`.
 * @returns `{ url, headers, body }`.
 */
export function customSpeechRequest(options) {
  const body = {
    model: String(options.model ?? '').trim(),
    input: String(options.text ?? ''),
    voice: String(options.voice ?? ''),
    response_format: 'mp3',
  };
  const speed = speedForRate(options.rate);
  if (speed !== null) body.speed = speed;
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = String(options.apiKey ?? '').trim();
  if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;
  return { url: customSpeechUrl(options.baseUrl), headers, body };
}

/**
 * Remove a secret from a text that is about to be logged or reported.
 *
 * A provider may echo the key back in its error body, and a base URL may
 * carry it in a query string; either way the key must not reach a log line or
 * an error message.
 * @param text - The text to clean.
 * @param secret - The secret to remove.
 * @returns The text without the secret.
 */
function redact(text, secret) {
  const raw = String(text ?? '');
  const key = String(secret ?? '').trim();
  if (key === '') return raw;
  return raw.split(key).join('***');
}

/**
 * Whether a path is a readable, non-empty regular file.
 * @param path - Candidate path.
 * @returns True when the file exists with content.
 */
async function isUsableFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Move a freshly written media file into its cache slot. `rename` fails when a
 * concurrent writer already published the slot, so a copy is the fallback.
 * @param from - Temp media path.
 * @param to - Final cache path.
 */
async function publishMedia(from, to) {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/**
 * Build the synthesis service bound to one voice configuration.
 *
 * The voice, tempo, and pitch are read through a provider rather than captured
 * once: a caller that passes `voiceOptions` (a function returning
 * `{ voice, rate, pitch, volume }`) gets live settings applied to every call,
 * which is how a change made in the settings card reaches the next sentence
 * without a Host restart. Without the provider the three options are constant,
 * as before.
 *
 * The same provider may carry the TTS provider settings (`ttsProvider`,
 * `customBaseUrl`, `customApiKey`, `customModel`), and the service then speaks
 * to the OpenAI-compatible endpoint instead of the local CLI. The branch is
 * decided per call, so switching the provider in the card takes effect on the
 * next narration.
 *
 * `ensure` and `cached` also accept a per-call `override`, the seam `/preview`
 * uses to synthesize with values the user has not saved.
 *
 * @param options - `binPath`, `cacheDir`, `voice`/`rate`/`pitch`/`volume` (or a
 *   `voiceOptions` provider), `timeoutMs`, an optional `logger`, and an optional
 *   `spawnImpl` seam for tests. `fetchImpl` is the same kind of seam for the
 *   HTTP provider: it defaults to the global `fetch`.
 * @returns The service: `ensure`, `cached`, `keyFor`, `pathFor`, `counters`.
 */
export function createSynthService(options) {
  const binPath = options.binPath;
  const cacheDir = options.cacheDir;
  const staticOptions = {
    voice: options.voice,
    rate: options.rate,
    pitch: options.pitch,
    volume: options.volume ?? '+0%',
    ttsProvider: options.ttsProvider,
    customBaseUrl: options.customBaseUrl,
    customApiKey: options.customApiKey,
    customModel: options.customModel,
  };
  const optionsProvider =
    typeof options.voiceOptions === 'function' ? options.voiceOptions : () => staticOptions;
  const timeoutMs = options.timeoutMs ?? 60000;
  const logger = options.logger;
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tempDir = join(cacheDir, '.tmp');

  /** Normalize one voice triple into the literals edge-tts and the cache key use. */
  function voiceOf(override) {
    const current = { ...optionsProvider(), ...(override ?? {}) };
    return {
      voice: current.voice,
      rate: normalizeRate(current.rate),
      pitch: normalizePitch(current.pitch),
      volume: normalizeVolume(current.volume ?? '+0%'),
      // The tempo as it was given, before the normalization: the HTTP provider
      // needs to know whether a tempo was configured at all, and an unset one
      // is not the same thing as a zero one.
      tempo: typeof current.rate === 'string' && current.rate.trim() !== '' ? current.rate.trim() : '',
      ttsProvider: normalizeTtsProvider(current.ttsProvider),
      customBaseUrl: typeof current.customBaseUrl === 'string' ? current.customBaseUrl.trim() : '',
      customApiKey: typeof current.customApiKey === 'string' ? current.customApiKey.trim() : '',
      customModel: typeof current.customModel === 'string' ? current.customModel.trim() : '',
    };
  }

  /**
   * Whether one call speaks to the HTTP endpoint instead of the local CLI.
   *
   * The custom provider is opt-in and needs three things: the provider itself,
   * a base URL and a model. Anything less falls back to `edge-tts`, which is
   * the default and always works.
   * @param voice - The normalized voice of the call.
   * @returns True when the HTTP path is taken.
   */
  function usesCustomEndpoint(voice) {
    return (
      voice.ttsProvider === TTS_PROVIDER_CUSTOM &&
      voice.customBaseUrl !== '' &&
      voice.customModel !== ''
    );
  }

  /** In-flight syntheses by cache key: concurrent callers share one process. */
  const inFlight = new Map();
  const counters = { launched: 0, served: 0, failed: 0 };

  /**
   * Run edge-tts once for `text`, publishing the result at `target`.
   * @param text - Narration text for this chunk.
   * @param target - Final cache path.
   * @param voice - Normalized `{ voice, rate, pitch, volume }` for this run.
   */
  async function runEdgeTts(text, target, voice) {
    await mkdir(tempDir, { recursive: true });
    const textFile = join(tempDir, `${randomUUID()}.txt`);
    const mediaFile = join(tempDir, `${randomUUID()}.mp3`);
    const logFile = join(tempDir, `${randomUUID()}.log`);
    let logFd;

    try {
      await writeFile(textFile, text, 'utf8');
      const argv = buildEdgeTtsArgs({
        voice: voice.voice,
        rate: voice.rate,
        pitch: voice.pitch,
        volume: voice.volume,
        textFile,
        mediaFile,
      });
      logFd = openSync(logFile, 'w');
      counters.launched += 1;

      await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };

        let child;
        try {
          child = spawnImpl(binPath, argv, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', logFd],
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          });
        } catch (error) {
          finish(error);
          return;
        }

        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish(new Error(`edge-tts timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.on('error', (error) => finish(error));
        child.on('close', (code) => {
          if (code === 0) finish(undefined);
          else finish(new Error(`edge-tts exited with code ${String(code)}`));
        });
      });

      if (!(await isUsableFile(mediaFile))) {
        const log = await readFile(logFile, 'utf8').catch(() => '');
        throw new Error(
          `edge-tts produced no media${log.trim() === '' ? '' : `: ${log.trim().slice(-400)}`}`,
        );
      }
      await publishMedia(mediaFile, target);
    } catch (error) {
      counters.failed += 1;
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(`dsh-voice-v: synthesis failed: ${String(error?.message ?? error)}`);
      }
      throw error;
    } finally {
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          /* already closed */
        }
      }
      await rm(textFile, { force: true }).catch(() => {});
      await rm(mediaFile, { force: true }).catch(() => {});
      await rm(logFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Read the audio bytes out of a successful answer.
   * @param response - The provider's response.
   * @returns The bytes of the MP3.
   */
  async function readAudioBytes(response) {
    if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer());
    if (typeof response.buffer === 'function') return Buffer.from(await response.buffer());
    if (typeof response.text === 'function') return Buffer.from(String(await response.text()), 'utf8');
    throw new Error('the custom TTS endpoint answered with no readable body');
  }

  /**
   * The provider's own error text, when the answer carries one.
   *
   * The OpenAI shape puts it in `error.message`; other providers use
   * `error` as a plain string, or `message` at the top level. A body that is
   * not JSON is used as it is.
   * @param response - The provider's failed response.
   * @returns A short detail, or an empty string.
   */
  async function readErrorDetail(response) {
    let raw = '';
    try {
      if (typeof response.text === 'function') raw = String(await response.text());
    } catch {
      raw = '';
    }
    if (raw.trim() === '') return '';
    let detail = raw.trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const error = parsed.error;
        if (typeof error === 'string' && error.trim() !== '') detail = error.trim();
        else if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
          detail = error.message.trim();
        } else if (typeof parsed.message === 'string' && parsed.message.trim() !== '') {
          detail = parsed.message.trim();
        }
      }
    } catch {
      /* not JSON: the raw body is the message */
    }
    return detail.slice(0, 400);
  }

  /**
   * Ask the OpenAI-compatible endpoint for the audio of one chunk.
   * @param request - `{ url, headers, body }` from {@link customSpeechRequest}.
   * @param secret - The API key, used to keep it out of every message.
   * @returns The bytes of the MP3.
   */
  async function fetchSpeech(request, secret) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('the custom TTS endpoint needs a fetch implementation, and none is available');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        ...(controller === null ? {} : { signal: controller.signal }),
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      const reason = aborted ? `timed out after ${timeoutMs} ms` : String(error?.message ?? error);
      throw new Error(`the custom TTS endpoint request failed: ${redact(reason, secret)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response === null || response === undefined) {
      throw new Error('the custom TTS endpoint answered nothing');
    }
    const ok =
      response.ok === undefined
        ? typeof response.status === 'number' && response.status >= 200 && response.status < 300
        : response.ok === true;
    if (!ok) {
      const status = typeof response.status === 'number' ? response.status : 0;
      const detail = redact(await readErrorDetail(response), secret);
      throw new Error(
        `the custom TTS endpoint answered ${status}${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    return readAudioBytes(response);
  }

  /**
   * Run the OpenAI-compatible endpoint once for `text`, publishing the result
   * at `target`.
   *
   * The bytes land in the very same MP3 cache the local CLI fills, so the
   * `/speak` flow, the audio route and the client cannot tell the two
   * providers apart.
   * @param text - Narration text for this chunk.
   * @param target - Final cache path.
   * @param voice - Normalized voice of this run, provider fields included.
   */
  async function runCustomEndpoint(text, target, voice) {
    await mkdir(tempDir, { recursive: true });
    const mediaFile = join(tempDir, `${randomUUID()}.mp3`);
    try {
      const request = customSpeechRequest({
        baseUrl: voice.customBaseUrl,
        model: voice.customModel,
        voice: voice.voice,
        text,
        rate: voice.tempo,
        apiKey: voice.customApiKey,
      });
      counters.launched += 1;
      const bytes = await fetchSpeech(request, voice.customApiKey);
      if (bytes.length === 0) {
        throw new Error('the custom TTS endpoint returned no audio');
      }
      await writeFile(mediaFile, bytes);
      await publishMedia(mediaFile, target);
    } catch (error) {
      counters.failed += 1;
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(
          `dsh-voice-v: synthesis failed: ${redact(String(error?.message ?? error), voice.customApiKey)}`,
        );
      }
      throw error;
    } finally {
      await rm(mediaFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Ensure one narration chunk exists in the cache.
   * @param text - Narration text for this chunk.
   * @param override - Optional per-call `{ voice, rate, pitch, volume }`.
   * @returns `{ key, file, bytes, cached, voice }`; `cached` is true on a cache hit.
   */
  async function ensure(text, override) {
    const voice = voiceOf(override);
    const key = cacheKeyFor({ text, ...voice });
    const file = join(cacheDir, `${key}.mp3`);
    if (await isUsableFile(file)) {
      counters.served += 1;
      return { key, file, bytes: (await stat(file)).size, cached: true, voice };
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      await pending;
      counters.served += 1;
      return { key, file, bytes: (await stat(file)).size, cached: true, voice };
    }
    // The branch is per call: the local CLI by default, the HTTP endpoint only
    // when a deployment opted in and configured it completely.
    const run = usesCustomEndpoint(voice) ? runCustomEndpoint : runEdgeTts;
    const task = run(text, file, voice).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    await task;
    return { key, file, bytes: (await stat(file)).size, cached: false, voice };
  }

  /**
   * Whether a chunk is already cached, without synthesizing it.
   * @param text - Narration text for this chunk.
   * @param override - Optional per-call `{ voice, rate, pitch, volume }`.
   * @returns `{ key, file, cached, voice }`.
   */
  async function cached(text, override) {
    const voice = voiceOf(override);
    const key = cacheKeyFor({ text, ...voice });
    const file = join(cacheDir, `${key}.mp3`);
    return { key, file, cached: await isUsableFile(file), voice };
  }

  return {
    ensure,
    cached,
    cacheKeyFor,
    keyFor: (text, override) => cacheKeyFor({ text, ...voiceOf(override) }),
    pathFor: (key) => join(cacheDir, `${key}.mp3`),
    get cacheDir() {
      return cacheDir;
    },
    get voiceOptions() {
      return voiceOf();
    },
    get counters() {
      return { ...counters };
    },
  };
}

/**
 * Warm a list of chunks in the background, bounded by `concurrency`. Failures
 * are swallowed: a warm-up is an optimization, never a correctness dependency.
 *
 * `override` is the per-call voice triple the first chunk was synthesized
 * with — the automatic preset of a `/speak` request, say. It must be passed
 * here as well, or the rest of the message would be warmed (and spoken) with
 * the configured voice while the first sentence used another one.
 * @param synth - The synthesis service.
 * @param chunks - Narration chunks to pre-synthesize.
 * @param concurrency - Maximum simultaneous syntheses.
 * @param override - Optional per-call `{ voice, rate, pitch, volume }`.
 * @returns A promise settling once every chunk has been attempted.
 */
export async function warmChunks(synth, chunks, concurrency = 2, override = undefined) {
  const queue = [...chunks];
  const width = Math.max(1, Math.min(concurrency, queue.length));
  const workers = [];
  for (let index = 0; index < width; index += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const next = queue.shift();
          if (next === undefined) return;
          try {
            await synth.ensure(next, override);
          } catch {
            /* a warm-up failure surfaces when the client requests that part */
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}
