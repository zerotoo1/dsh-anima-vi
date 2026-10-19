/**
 * dsh-voice-v host half.
 *
 * Registers a `/dsh-voice-v` prefix route on the injected `webServer` Cordis
 * service (`ctx.webServer`, the `WebServer` from
 * `@deepseek-ai/dsh-host-webserver`; the plugin obtains it by declaring
 * `inject: ['webServer']`). Six endpoints:
 *
 * | Route | Purpose |
 * |---|---|
 * | `GET /dsh-voice-v/health` | liveness plus the effective voice settings |
 * | `GET /dsh-voice-v/config` | the resolved preset / voice / rate / pitch, the preset table, the voice catalogue, the dictionary defaults, and the slider domains |
 * | `GET /dsh-voice-v/speak` | resolve `(sessionId, messageId)` to text, clean it, chunk it, and return one cached part per chunk |
 * | `GET\|POST /dsh-voice-v/preview` | synthesize with the caller's own rate/pitch/voice and answer `audio/mpeg` — the settings card's Listen button |
 * | `GET\|HEAD /dsh-voice-v/audio/<sha256>.mp3` | the cached MP3 for one part, `Accept-Ranges` and single-range `206` support |
 *
 * The browser never sends message text for the normal path: `speak` reads the
 * assistant message out of the session log by id (see `./session-text.js`). A
 * `text` parameter exists only as an explicit fallback and is documented in
 * `README.md`.
 *
 * Every route except `preview` reads the LIVE voice settings through
 * `createLiveSettings`: the settings card writes into this plugin's own `config`
 * (the namespace is derived from the Loader row id and its schema from the
 * `Config` exported below), the Loader commits the volatile fields into the
 * references `createLiveSettings` reads, and so a change reaches the next
 * sentence without a Host restart. `preview` deliberately bypasses all of that:
 * it synthesizes exactly what the caller sent, which is what lets the card
 * audition unsaved slider positions.
 *
 * One more thing happens on the `speak` path: the `autoPreset` switch (on by
 * default) lets the tone of the message pick the narration preset for THAT
 * message — tired prose is read slowly and low, a warm answer briskly and
 * higher, work talk evenly, a flirtatious line boldly. The choice is a
 * per-request override (see `lib/tone.js`): it never changes what is stored,
 * it never changes the voice, and a tempo or a tone the user pinned explicitly
 * still wins over it.
 *
 * @module dsh-voice-v
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PREVIEW_TEXT,
  DEFAULT_VOICE,
  PITCH_RANGE,
  RATE_RANGE,
  SETTINGS_FIELDS,
  SETTINGS_NAMESPACE,
  SPECTRUM_VARIANTS,
  describePresets,
  describeVoices,
  normalizePitch,
  normalizeRate,
  resolvePreviewOptions,
} from './config.js';
import { DEFAULT_PRONUNCIATION, prepareForSpeech } from './text.js';
import { createLiveSettings } from './host-settings.js';
import { resolveAssistantText } from './session-text.js';
import { CACHE_KEY_RE, createSynthService, warmChunks } from './synth.js';
import { analyzeTone } from './tone.js';

/**
 * The schema the Loader validates this plugin row's `config` against, and the
 * only thing that puts the `dsh-voice-v` settings form on the Host's settings
 * surface. Exported here because the namespace is derived, not registered:
 * `dsh-settings.describe()` reads `entry.options.id` and takes the schema from
 * `entry.fiber.runtime.Config` — this binding. It is `undefined` only in a
 * deployment where no volatile-capable schemastery could be loaded (see
 * `lib/host-settings.js`); the routes below are unaffected either way.
 */
export { Config } from './host-settings.js';

/** Mount prefix for every route this plugin owns. */
export const ROUTE_PREFIX = '/dsh-voice-v';

/** Largest accepted request body for the POST spelling of `speak` and `preview`. */
const MAX_BODY_BYTES = 64 * 1024;

/** Default cache location, beside the profile the web server runs for. */
export function defaultCacheDir() {
  return join(homedir(), '.dsh', 'cache', 'dsh-voice-v');
}

/** JSON response with no-store caching. */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/** Error response in the single `{ ok: false, code, message }` shape. */
function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, code, message }, extraHeaders);
}

/** Reject any method outside the allowed set with a proper `Allow` header. */
function methodNotAllowed(res, allowed) {
  sendError(res, 405, 'method-not-allowed', `allowed methods: ${allowed.join(', ')}`, {
    Allow: allowed.join(', '),
  });
}

/** Read a request body up to {@link MAX_BODY_BYTES}, or throw a coded error. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'body-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Serve one cached MP3 with `HEAD` and single-range support.
 * @param req - Incoming request.
 * @param res - Response to write.
 * @param file - Absolute path of the cached media file.
 * @param options - `cacheControl` header value; defaults to the immutable one,
 *   which is wrong for a preview whose bytes depend on unsaved settings.
 */
async function serveAudioFile(req, res, file, options = {}) {
  let info;
  try {
    info = await stat(file);
  } catch {
    sendError(res, 404, 'not-synthesized', 'this part is not cached yet');
    return;
  }
  if (!info.isFile() || info.size === 0) {
    sendError(res, 404, 'not-synthesized', 'this part is not cached yet');
    return;
  }

  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl ?? 'public, max-age=31536000, immutable',
  };

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match !== null) {
      const start = match[1] === '' ? Math.max(0, info.size - Number(match[2] ?? 0)) : Number(match[1]);
      const end = match[2] === '' || match[1] === '' ? info.size - 1 : Math.min(Number(match[2]), info.size - 1);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < info.size) {
        res.writeHead(206, {
          ...headers,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
        });
        if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
      sendError(res, 416, 'range-not-satisfiable', 'requested range is not satisfiable', {
        'Content-Range': `bytes */${info.size}`,
      });
      return;
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
  if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Build the `/dsh-voice-v` request handler.
 *
 * @param options - `synth` (the synthesis service), `ctx`, and either a
 *   `liveSettings` reader or a static `settings` object. `liveSettings` is what
 *   the mounted plugin passes: it re-resolves the composition config and the
 *   user's settings section on every call, so no route caches a value a user can
 *   change.
 * @returns An async `(req, res)` handler owning the full response lifecycle.
 */
export function createVoiceHandler(options) {
  const synth = options.synth;
  const ctx = options.ctx;
  const liveSettings =
    typeof options.liveSettings === 'function' ? options.liveSettings : () => options.settings;

  /** `GET|POST /dsh-voice-v/speak` — the narration manifest for one message. */
  async function handleSpeak(req, res, url, body) {
    const settings = liveSettings();
    const sessionId = url.searchParams.get('sessionId') ?? body.sessionId ?? '';
    const messageId = url.searchParams.get('messageId') ?? body.messageId ?? '';
    const fallbackText =
      url.searchParams.get('text') ?? (typeof body.text === 'string' ? body.text : '');

    let text = '';
    let source = 'none';
    if (sessionId !== '') {
      const resolved = await resolveAssistantText(ctx, sessionId, messageId);
      if (resolved.text !== null) {
        text = resolved.text;
        source = resolved.source;
      }
    }
    if (text === '' && fallbackText !== '') {
      text = fallbackText;
      source = 'text';
    }
    if (text.trim() === '') {
      sendError(
        res,
        404,
        sessionId === '' ? 'session-required' : 'message-not-found',
        sessionId === ''
          ? 'pass sessionId (and messageId) so the host can read the message, or an explicit text parameter'
          : `no assistant message with text found for session ${sessionId}${
              messageId === '' ? '' : ` and message ${messageId}`
            }`,
      );
      return;
    }

    const prepared = prepareForSpeech(text, {
      dictionary: settings.dictionary,
      stripCode: settings.stripCode,
      maxChunkChars: settings.maxChunkChars,
      maxTextChars: settings.maxTextChars,
    });
    if (prepared.chunks.length === 0) {
      sendError(res, 422, 'nothing-to-say', 'the message has no speakable text after cleaning');
      return;
    }

    // The tone of the message picks the preset for THIS message only: a
    // per-request override that never touches the stored configuration. The
    // analysis runs on the raw text, before the cleaning, because the wording
    // that carries the mood is what the cleaning would have thrown away.
    //
    // A tempo or a tone the user pinned explicitly still wins over the
    // detected preset, field by field, and the voice is never changed by the
    // automatic choice at all.
    const tone = settings.autoPreset === true ? analyzeTone(text) : null;
    const detected = tone !== null && tone.preset !== null ? tone.preset : null;
    const detectedPreset = detected === null ? null : (settings.presets[detected] ?? null);
    const autoApplied =
      detectedPreset !== null && (settings.rateOverridden === false || settings.pitchOverridden === false);
    let effectivePreset = settings.preset;
    let effectiveRate = settings.rate;
    let effectivePitch = settings.pitch;
    let override = undefined;
    if (autoApplied) {
      effectivePreset = detected;
      if (settings.rateOverridden === false) effectiveRate = normalizeRate(detectedPreset.rate);
      if (settings.pitchOverridden === false) effectivePitch = normalizePitch(detectedPreset.pitch);
      override = {
        voice: settings.voice,
        rate: effectiveRate,
        pitch: effectivePitch,
        volume: settings.volume,
      };
    }

    const parts = [];
    for (const chunk of prepared.chunks) {
      const info = await synth.cached(chunk, override);
      parts.push({ key: info.key, cached: info.cached, chars: chunk.length, text: chunk });
    }

    // Synthesize the first part now so playback can start immediately; warm the
    // rest in the background so the client rarely waits between sentences.
    // The warming carries the very same override, or the rest of the message
    // would be spoken with another voice than the first sentence.
    try {
      await synth.ensure(prepared.chunks[0], override);
    } catch (error) {
      sendError(
        res,
        502,
        'synthesis-failed',
        `edge-tts did not produce the first part: ${String(error?.message ?? error)}`,
      );
      return;
    }
    parts[0].cached = true;
    const rest = prepared.chunks.slice(1);
    if (rest.length > 0) {
      warmChunks(synth, rest, settings.warmConcurrency, override).catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      voice: settings.voice,
      rate: effectiveRate,
      pitch: effectivePitch,
      volume: settings.volume,
      preset: effectivePreset,
      configuredPreset: settings.preset,
      autoPreset: autoApplied,
      autoPresetEnabled: settings.autoPreset === true,
      tone:
        detected === null
          ? null
          : {
              preset: tone.preset,
              matched: tone.matched,
              score: tone.score,
              candidates: tone.candidates,
            },
      stripCode: settings.stripCode,
      // The visualization the button shows while this voice plays. The
      // manifest is the one request the button already makes, so the variant
      // travels with it: the button never has to ask twice.
      spectrum: settings.spectrum,
      sessionId,
      messageId,
      source,
      chars: prepared.cleaned.length,
      truncated: prepared.truncated,
      parts: parts.map((part) => ({
        key: part.key,
        url: `${ROUTE_PREFIX}/audio/${part.key}.mp3`,
        chars: part.chars,
        cached: part.cached,
      })),
    });
  }

  /**
   * `GET|POST /dsh-voice-v/preview` — synthesize with the caller's own values.
   *
   * Nothing here reads the settings document and nothing writes to it: the
   * values come from the request, the preset table, and the built-in defaults,
   * in that order. That is what makes the card's Listen button audible while the
   * sliders are still unsaved (and while the settings document is unwritable).
   */
  async function handlePreview(req, res, url, body) {
    const input = { ...body };
    for (const key of ['text', 'preset', 'rate', 'pitch', 'voice', 'stripCode']) {
      const fromQuery = url.searchParams.get(key);
      if (fromQuery !== null && input[key] === undefined) input[key] = fromQuery;
    }
    const text = typeof input.text === 'string' && input.text.trim() !== '' ? input.text : DEFAULT_PREVIEW_TEXT;
    const options = resolvePreviewOptions(input);
    const prepared = prepareForSpeech(text, {
      dictionary: options.dictionary,
      stripCode: options.stripCode,
      maxChunkChars: options.maxChunkChars,
      maxTextChars: options.maxTextChars,
    });
    if (prepared.chunks.length === 0) {
      sendError(res, 422, 'nothing-to-say', 'the preview text has nothing speakable after cleaning');
      return;
    }

    let info;
    try {
      info = await synth.ensure(prepared.chunks[0], {
        voice: options.voice,
        rate: options.rate,
        pitch: options.pitch,
        volume: options.volume,
      });
    } catch (error) {
      sendError(res, 502, 'synthesis-failed', `edge-tts did not produce the preview: ${String(error?.message ?? error)}`);
      return;
    }
    res.setHeader?.('X-Voice-V-Rate', options.rate);
    res.setHeader?.('X-Voice-V-Pitch', options.pitch);
    res.setHeader?.('X-Voice-V-Voice', options.voice);
    await serveAudioFile(req, res, info.file, { cacheControl: 'no-store' });
  }

  /** Parse a JSON body, answering the caller itself when it is unusable. */
  async function readJsonBody(req, res) {
    try {
      const raw = await readBody(req);
      const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === 'body-too-large') {
        sendError(res, 413, 'body-too-large', 'the request body exceeds 64 KiB');
        return null;
      }
      sendError(res, 400, 'bad-body', 'the request body must be a JSON object');
      return null;
    }
  }

  return async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendError(res, 400, 'bad-url', 'the request URL could not be parsed');
      return;
    }
    const pathname = url.pathname;

    if (pathname === `${ROUTE_PREFIX}/health`) {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(res, ['GET', 'HEAD']);
        return;
      }
      const settings = liveSettings();
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-voice-v',
        voice: settings.voice,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
        preset: settings.preset,
        stripCode: settings.stripCode,
        autoPreset: settings.autoPreset,
        spectrum: settings.spectrum,
        settingsNamespace: SETTINGS_NAMESPACE,
        cacheDir: synth.cacheDir,
        counters: synth.counters,
      });
      return;
    }

    if (pathname === `${ROUTE_PREFIX}/config`) {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(res, ['GET', 'HEAD']);
        return;
      }
      const settings = liveSettings();
      sendJson(res, 200, {
        ok: true,
        preset: settings.preset,
        requestedPreset: settings.requestedPreset,
        presetKnown: settings.presetKnown,
        voice: settings.voice,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
        stripCode: settings.stripCode,
        autoPreset: settings.autoPreset,
        // The variant the message button shows while a voice plays, and the
        // variants the settings card offers: the card renders what the host
        // reports, so the allow-list lives in one place only.
        spectrum: settings.spectrum,
        spectrumVariants: SPECTRUM_VARIANTS,
        rateOverridden: settings.rateOverridden,
        pitchOverridden: settings.pitchOverridden,
        voiceOverridden: settings.voiceOverridden,
        binPath: settings.binPath,
        cacheDir: synth.cacheDir,
        maxChunkChars: settings.maxChunkChars,
        presets: settings.presets,
        userPresets: settings.userPresets,
        presetList: describePresets(settings),
        voiceList: describeVoices(settings),
        defaultVoice: DEFAULT_VOICE,
        dictionary: settings.dictionary,
        dictionaryDefaults: DEFAULT_PRONUNCIATION,
        defaultPreviewText: DEFAULT_PREVIEW_TEXT,
        settingsNamespace: SETTINGS_NAMESPACE,
        settingsFields: SETTINGS_FIELDS,
        settingsRegistered:
          typeof liveSettings.settingsRegistered === 'function' ? liveSettings.settingsRegistered() : false,
        rateRange: RATE_RANGE,
        pitchRange: PITCH_RANGE,
      });
      return;
    }

    if (pathname.startsWith(`${ROUTE_PREFIX}/audio/`)) {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(res, ['GET', 'HEAD']);
        return;
      }
      const raw = pathname.slice(`${ROUTE_PREFIX}/audio/`.length);
      const key = raw.endsWith('.mp3') ? raw.slice(0, -4) : raw;
      if (!CACHE_KEY_RE.test(key)) {
        sendError(res, 400, 'bad-key', 'the audio key must be a 64-character lowercase sha256 hex string');
        return;
      }
      await serveAudioFile(req, res, synth.pathFor(key));
      return;
    }

    if (pathname === `${ROUTE_PREFIX}/speak`) {
      if (method === 'GET' || method === 'HEAD') {
        await handleSpeak(req, res, url, {});
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        await handleSpeak(req, res, url, body);
        return;
      }
      methodNotAllowed(res, ['GET', 'HEAD', 'POST']);
      return;
    }

    if (pathname === `${ROUTE_PREFIX}/preview`) {
      if (method === 'GET') {
        await handlePreview(req, res, url, {});
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        await handlePreview(req, res, url, body);
        return;
      }
      methodNotAllowed(res, ['GET', 'POST']);
      return;
    }

    sendError(res, 404, 'not-found', `no dsh-voice-v endpoint at ${pathname}`);
  };
}

/** Cordis service dependencies: the route registry this plugin registers into. */
export const inject = ['webServer'];

/** Plugin name, matching the package name so the loader row reads plainly. */
export const name = 'dsh-voice-v';

/**
 * Mount the host half: resolve settings, build the synthesis service, and
 * register the `/dsh-voice-v` prefix route on the web server.
 * @param ctx - Host context carrying `webServer` (and, for message lookup, the
 *   `sessions` / `sessionPersistence` services read lazily at request time).
 * @param config - The plugin row's `config` object.
 */
/**
 * Mount the host half: resolve settings, build the synthesis service, and
 * register the `/dsh-voice-v` prefix route on the web server.
 *
 * The voice, tempo, and pitch are read through `liveSettings` on every request
 * and through the synth service's `voiceOptions` provider on every synthesis, so
 * a value written from the settings card applies to the next sentence with no
 * restart: the Loader commits a volatile-only edit into the very references
 * `liveSettings` reads (see `lib/host-settings.js`). The cache key already
 * carries the voice triple, so a changed setting lands in its own cache slot
 * instead of reusing the previous one.
 *
 * @param ctx - Host context carrying `webServer` (and, for message lookup, the
 *   `sessions` / `sessionPersistence` services read lazily at request time).
 * @param config - The plugin row's parsed `config` object.
 */
export function apply(ctx, config) {
  const logger = ctx.logger;

  const liveSettings = createLiveSettings(ctx, config, { logger });
  const boot = liveSettings();
  const cacheDir = boot.cacheDir ?? defaultCacheDir();

  const synth = createSynthService({
    binPath: boot.binPath,
    cacheDir,
    voiceOptions: () => {
      const settings = liveSettings();
      return {
        voice: settings.voice,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
      };
    },
    timeoutMs: boot.timeoutMs,
    logger,
  });

  const handler = createVoiceHandler({ ctx, liveSettings, synth });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      }),
    'dsh-voice-v: routes',
  );
}
