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
 * ## The three providers
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
 * The Yandex provider is opt-in too: it needs the provider itself and a key.
 * It speaks the v3 REST shape of the service — `POST
 * /tts/v3/utteranceSynthesis`, the route the service's own descriptor names —
 * and its answer is a server-streaming set of audio chunks, which the parser
 * takes apart in every shape it may arrive in.
 *
 * @module dsh-voice-v/synth
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GOOGLE_FREE_MAX_CHARS,
  GOOGLE_FREE_TTS_URL,
  GOOGLE_TTS_URL,
  PITCH_RANGE,
  TTS_PROVIDER_CUSTOM,
  TTS_PROVIDER_EDGE,
  TTS_PROVIDER_GOOGLE,
  TTS_PROVIDER_GOOGLE_FREE,
  TTS_PROVIDER_YANDEX,
  YANDEX_SPEECH_URL,
  buildEdgeTtsArgs,
  normalizeGoogleVoice,
  normalizePitch,
  normalizeRate,
  normalizeTtsProvider,
  normalizeVolume,
  normalizeYandexVoice,
  parsePitchHz,
  parseRatePct,
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
 * The bounds the Yandex service accepts for the volume multiplier.
 *
 * The plugin's own volume is a percentage around 100%, which maps onto
 * `1 + percent/100`. The bounds are the service's, and a volume outside them
 * is clamped rather than rejected.
 */
export const VOLUME_RANGE = Object.freeze({ min: 0.25, max: 4.0 });

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
    String(request.yandexVoice ?? '').trim(),
    String(request.googleVoice ?? '').trim(),
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
 * The tempo of the plugin as the Yandex service wants it: a plain multiplier.
 *
 * The plugin's own tempo is an edge-tts literal, and the two readings of a
 * number are told apart by the `%` sign:
 *
 *  * `+6%`, `-5%` — a change of tempo: `1 + percent/100` (`1.06`, `0.95`);
 *  * `1.0` — a multiplier already: `1`;
 *  * `0` — no change at all, the way edge-tts reads a bare zero: `1`.
 *
 * A bare number outside the multiplier range is a percentage again (`6` →
 * `1.06`), so a tempo typed by hand lands in the same place either way. A
 * tempo nobody configured produces no speed at all — the service's own default
 * then decides.
 * @param rate - The tempo literal, or nothing.
 * @returns The speed multiplier, or `null` when there is no usable tempo.
 */
export function yandexSpeedForRate(rate) {
  const raw = String(rate ?? '').trim();
  if (raw === '') return null;
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(%)?$/.exec(raw);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  let speed;
  if (match[2] === '%') speed = 1 + value / 100;
  else if (value === 0) speed = 1;
  else if (Math.abs(value) > SPEED_RANGE.max) speed = 1 + value / 100;
  else speed = value;
  return Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, speed));
}

/**
 * The tone of the plugin as the Yandex service wants it: a shift in Hz.
 *
 * The plugin's tone is an edge-tts literal (`+12Hz`), and the service's
 * `pitch_shift` is a plain number of hertz — the same unit, so the literal
 * only has to be unwrapped. A tone nobody configured produces no shift at
 * all, and the service's own default then decides.
 * @param pitch - The tone literal, or nothing.
 * @returns The shift in hertz, or `null` when there is no usable tone.
 */
export function yandexPitchShift(pitch) {
  const raw = String(pitch ?? '').trim();
  if (raw === '') return null;
  const hz = parsePitchHz(raw);
  if (hz === null) return null;
  return Math.min(PITCH_RANGE.max, Math.max(PITCH_RANGE.min, hz));
}

/**
 * The volume of the plugin as the Yandex service wants it: a multiplier.
 *
 * The plugin's volume is a percentage around 100% (`+10%`), and the service's
 * `volume` is a multiplier around 1 — so `+10%` becomes `1.1`. A volume
 * nobody configured produces no value at all.
 * @param volume - The volume literal, or nothing.
 * @returns The multiplier, or `null` when there is no usable volume.
 */
export function yandexVolume(volume) {
  const raw = String(volume ?? '').trim();
  if (raw === '') return null;
  const percent = parseRatePct(raw);
  if (percent === null) return null;
  return Math.min(VOLUME_RANGE.max, Math.max(VOLUME_RANGE.min, 1 + percent / 100));
}

/**
 * The reference pitch the plugin's Hz offset is read against.
 *
 * The plugin's tone is an offset in Hz (an edge-tts literal, `+12Hz`), and the
 * Google service takes semitones — a ratio, not an offset. A ratio needs a
 * base frequency, so the offset is read against this nominal one: a Russian
 * female voice sits near 200 Hz. The conversion is therefore an
 * approximation, and it is named as one instead of being passed off as exact.
 */
export const GOOGLE_PITCH_REFERENCE_HZ = 200;

/** The bounds the Google service accepts for its pitch parameter, in semitones. */
export const GOOGLE_PITCH_RANGE = Object.freeze({ min: -20, max: 20 });

/** The bounds the Google service accepts for its volume parameter, in dB. */
export const GOOGLE_VOLUME_RANGE = Object.freeze({ min: -96, max: 16 });

/**
 * The tone of the plugin as the Google service wants it: semitones.
 *
 * `+12Hz` on a nominal 200 Hz voice is `12 * log2(1 + 12/200)` ≈ 1.01
 * semitones — a small step up, which is what a small offset in Hz is. A tone
 * nobody configured produces no value at all.
 * @param pitch - The pitch literal, or nothing.
 * @returns The semitones, or `null` when there is no usable tone.
 */
export function googlePitchSemitones(pitch) {
  const raw = String(pitch ?? '').trim();
  if (raw === '') return null;
  const hz = parsePitchHz(raw);
  if (hz === null) return null;
  const ratio = 1 + hz / GOOGLE_PITCH_REFERENCE_HZ;
  if (!(ratio > 0)) return GOOGLE_PITCH_RANGE.min;
  const semitones = 12 * Math.log2(ratio);
  const clamped = Math.min(GOOGLE_PITCH_RANGE.max, Math.max(GOOGLE_PITCH_RANGE.min, semitones));
  return Math.round(clamped * 100) / 100;
}

/**
 * The volume of the plugin as the Google service wants it: decibels.
 *
 * The plugin's volume is a percentage of the amplitude (`+10%`), and the
 * service's `volumeGainDb` is a gain in dB, so `+10%` becomes
 * `20 * log10(1.1)` ≈ 0.83 dB. A volume nobody configured produces no value.
 * @param volume - The volume literal, or nothing.
 * @returns The decibels, or `null` when there is no usable volume.
 */
export function googleVolumeDb(volume) {
  const raw = String(volume ?? '').trim();
  if (raw === '') return null;
  const percent = parseRatePct(raw);
  if (percent === null) return null;
  const ratio = 1 + percent / 100;
  if (!(ratio > 0)) return GOOGLE_VOLUME_RANGE.min;
  const db = 20 * Math.log10(ratio);
  const clamped = Math.min(GOOGLE_VOLUME_RANGE.max, Math.max(GOOGLE_VOLUME_RANGE.min, db));
  return Math.round(clamped * 100) / 100;
}

/**
 * Build the request of the Google Cloud Text-to-Speech synthesis.
 *
 * The shape is the v1 REST one: `{ input, voice, audioConfig }`, and the key
 * rides in the query string — the documented way to authenticate a
 * server-side call by API key. The answer is JSON with the whole audio in
 * base64, not a stream, so the reply is read once and decoded whole.
 *
 * `languageCode` is fixed to `ru-RU`: the voices this build offers are the
 * Russian ones, and a voice name without its language would let the service
 * pick another.
 * @param options - `text`, `voice` (a `ru-RU-*` name), `rate`, `pitch`,
 *   `volume`, and `apiKey`.
 * @returns `{ url, headers, body }`, with `body` as an object.
 */
export function googleSpeechRequest(options) {
  const voice = normalizeGoogleVoice(options.voice);
  const audioConfig = { audioEncoding: 'MP3' };
  const speed = speedForRate(options.rate);
  if (speed !== null) audioConfig.speakingRate = speed;
  const pitch = googlePitchSemitones(options.pitch);
  if (pitch !== null) audioConfig.pitch = pitch;
  const volume = googleVolumeDb(options.volume);
  if (volume !== null) audioConfig.volumeGainDb = volume;
  const query = new URLSearchParams({ key: String(options.apiKey ?? '').trim() });
  return {
    url: `${GOOGLE_TTS_URL}?${query.toString()}`,
    headers: { 'content-type': 'application/json' },
    body: {
      input: { text: String(options.text ?? '') },
      voice: { languageCode: 'ru-RU', name: voice },
      audioConfig,
    },
  };
}

/**
 * Split a text into the pieces the free Google route accepts.
 *
 * The route takes the text in a query string and refuses a long one, so the
 * text is cut into pieces of at most `GOOGLE_FREE_MAX_CHARS`. The cut is made
 * at the last space that fits, so a word is never split in half — a half-word
 * is read as a half-word. A piece that is only spaces is dropped.
 * @param text - The text to split.
 * @param limit - The largest piece, in characters.
 * @returns The pieces, in reading order.
 */
export function googleFreePieces(text, limit = GOOGLE_FREE_MAX_CHARS) {
  const raw = String(text ?? '');
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : GOOGLE_FREE_MAX_CHARS;
  if (raw.trim() === '') return [];
  if (raw.length <= size) return [raw];
  const pieces = [];
  let rest = raw;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut <= 0) cut = size;
    const piece = rest.slice(0, cut).trim();
    if (piece !== '') pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/**
 * The URL of the free Google speech route for one piece.
 *
 * The parameters are the page's own: `ie` the encoding, `client` the client
 * flavour the route expects, `tl` the language, `q` the text.
 * @param text - One piece of the narration.
 * @param language - The language tag, `ru` by default.
 * @returns The URL.
 */
export function googleFreeUrl(text, language = 'ru') {
  const query = new URLSearchParams({
    ie: 'UTF-8',
    client: 'tw-ob',
    tl: language,
    q: String(text ?? ''),
  });
  return `${GOOGLE_FREE_TTS_URL}?${query.toString()}`;
}

/**
 * Build the request of the Yandex SpeechKit synthesis.
 *
 * The route is the one the service's own descriptor names: `POST
 * /tts/v3/utteranceSynthesis`, the http rule of the rpc `UtteranceSynthesis`
 * of `speechkit.tts.v3.Synthesizer`. The body is the v3 request — the text, a
 * `hints` ARRAY (the service rejects an object there) carrying the voice and
 * the tempo, and the wanted container format.
 *
 * The tempo of the plugin is an edge-tts literal (`+6%`); the service wants a
 * multiplier around 1, so `+6%` becomes `1.06` — see {@link yandexSpeedForRate}.
 *
 * The query keeps the parameters the older gateway understood (`voice`,
 * `format`, `sampleRate`, `speed`): the service tolerates them, and they keep
 * the request compatible with that gateway's behaviour. The folder the key
 * works in is a query parameter too, never a body field.
 *
 * The key travels in the `Authorization` header, and the logging of the
 * request is switched off with `X-DataLoggin-Enabled` — the spelling of that
 * header is the service's own.
 * @param options - `voice`, `text`, `rate`, `apiKey` and an optional
 *   `folderId`.
 * @returns `{ url, headers, body }`.
 */
export function yandexSpeechRequest(options) {
  const voice = normalizeYandexVoice(options.voice);
  const speed = yandexSpeedForRate(options.rate);
  const query = new URLSearchParams({
    voice,
    format: 'mp3',
    sampleRate: '48000',
  });
  if (speed !== null) query.set('speed', String(speed));
  const folderId = String(options.folderId ?? '').trim();
  if (folderId !== '') query.set('folderId', folderId);
  const hint = { voice };
  if (speed !== null) hint.speed = speed;
  // The tone and the volume are part of the same hint set. The service knows
  // both, and a slider that moves and changes nothing is a lie.
  const pitchShift = yandexPitchShift(options.pitch);
  if (pitchShift !== null) hint.pitchShift = pitchShift;
  const volume = yandexVolume(options.volume);
  if (volume !== null) hint.volume = volume;
  const body = {
    text: String(options.text ?? ''),
    hints: [hint],
    outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } },
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-DataLoggin-Enabled': 'false',
  };
  const apiKey = String(options.apiKey ?? '').trim();
  if (apiKey !== '') headers.Authorization = `Api-Key ${apiKey}`;
  return { url: `${YANDEX_SPEECH_URL}?${query.toString()}`, headers, body };
}

/**
 * Collect the base64 chunks of audio out of one parsed value.
 *
 * The chunk of the v3 stream is `{ "audioChunk": { "data": "<base64>" } }`; the
 * older v2 envelope keeps the same chunk under `result`. The walk is generic
 * on purpose: it finds the chunk wherever it sits in the envelope, and it
 * keeps the order of the stream — the chunks are pieces of one file.
 * @param value - A parsed value: an object, an array or a scalar.
 * @param out - The array the base64 chunks are appended to, in order.
 */
function collectAudioChunks(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectAudioChunks(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const chunk = value.audioChunk;
  if (chunk !== null && typeof chunk === 'object' && typeof chunk.data === 'string' && chunk.data !== '') {
    out.push(chunk.data);
  }
  for (const key of Object.keys(value)) {
    if (key === 'audioChunk') continue;
    collectAudioChunks(value[key], out);
  }
}

/**
 * Collect the audio of the `AudioContent` shape, the fallback of the last
 * resort.
 *
 * The proto of the response carries the bytes in `AudioContent.content`, so a
 * stream may answer `{"result":{"content":"<base64>"}}` instead of the chunk
 * envelope. It is only used when the chunk walk found nothing at all.
 * @param value - A parsed value: an object, an array or a scalar.
 * @param out - The array the base64 chunks are appended to, in order.
 */
function collectResultContent(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectResultContent(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const result = value.result;
  if (result !== null && typeof result === 'object' && typeof result.content === 'string' && result.content !== '') {
    out.push(result.content);
    return;
  }
  for (const key of Object.keys(value)) collectResultContent(value[key], out);
}

/**
 * Take the audio out of the Yandex answer.
 *
 * The rpc is server-streaming, so the answer is a stream of chunks and the
 * shape it arrives in is not fixed. Every one of these is understood:
 *
 *  * `{"audioChunk":{"data":"<base64>"}}` — one chunk;
 *  * `{"result":{"audioChunk":{"data":"<base64>"}}}` — the older v2 envelope;
 *  * `[{"audioChunk":…},{"audioChunk":…}]` — the stream as an array;
 *  * several JSON objects separated by newlines — the stream as NDJSON;
 *  * `{"audioChunk":{"data":…},"chunkType":…}` — a chunk with its type.
 *
 * The chunks are concatenated in the order they arrived, and the result is
 * one buffer of the whole file. An answer without audio in it is an error,
 * not an empty file: the caller says so rather than saving silence.
 * @param body - The response body, as text.
 * @returns The audio bytes.
 */
export function yandexAudioBytes(body) {
  const raw = String(body ?? '').trim();
  if (raw === '') throw new Error('the Yandex service answered with an empty body');
  const values = [];
  try {
    values.push(JSON.parse(raw));
  } catch {
    // The stream may arrive one object per line: every line is tried on its
    // own, and a body that is no JSON at all is reported as such.
    let parsed = 0;
    for (const line of raw.split(/\r?\n/)) {
      const piece = line.trim();
      if (piece === '') continue;
      try {
        values.push(JSON.parse(piece));
        parsed += 1;
      } catch {
        /* not a chunk line */
      }
    }
    if (parsed === 0) throw new Error('the Yandex service answered with a body that is not JSON');
  }
  const chunks = [];
  collectAudioChunks(values, chunks);
  if (chunks.length === 0) collectResultContent(values, chunks);
  if (chunks.length === 0) throw new Error('the Yandex service answered without audio');
  return Buffer.concat(chunks.map((data) => Buffer.from(data, 'base64')));
}

/**
 * Take the audio out of the Google answer.
 *
 * The v1 route answers one JSON object whose `audioContent` is the whole file,
 * base64-encoded. An answer without it is an error, not an empty file: the
 * caller says so rather than saving silence.
 * @param body - The response body, as text.
 * @returns The audio bytes.
 */
export function googleAudioBytes(body) {
  const raw = String(body ?? '').trim();
  if (raw === '') throw new Error('the Google service answered with an empty body');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the Google service answered with a body that is not JSON');
  }
  const content = String(parsed?.audioContent ?? '').trim();
  if (content === '') throw new Error('the Google service answered without audio');
  return Buffer.from(content, 'base64');
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
    yandexApiKey: options.yandexApiKey,
    yandexVoice: options.yandexVoice,
    googleApiKey: options.googleApiKey,
    googleVoice: options.googleVoice,
    // The folder the Yandex key works in. It is a query parameter of the
    // request, never a body field, and a deployment that leaves it empty
    // sends no folder at all.
    yandexFolderId: options.yandexFolderId,
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
      yandexApiKey: typeof current.yandexApiKey === 'string' ? current.yandexApiKey.trim() : '',
      yandexVoice: normalizeYandexVoice(current.yandexVoice),
      yandexFolderId: typeof current.yandexFolderId === 'string' ? current.yandexFolderId.trim() : '',
      googleApiKey: typeof current.googleApiKey === 'string' ? current.googleApiKey.trim() : '',
      googleVoice: normalizeGoogleVoice(current.googleVoice),
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

  /**
   * Whether one call speaks to the Yandex service instead of the local CLI.
   *
   * The Yandex provider is opt-in and needs two things: the provider itself
   * and a key. Anything less falls back to `edge-tts`, which is the default
   * and always works.
   * @param voice - The normalized voice of the call.
   * @returns True when the Yandex path is taken.
   */
  function usesYandex(voice) {
    return voice.ttsProvider === TTS_PROVIDER_YANDEX && voice.yandexApiKey !== '';
  }

  /**
   * Whether one call speaks to the Google service instead of the local CLI.
   *
   * Opt-in in the same way: the provider itself and a key. Anything less falls
   * back to `edge-tts`, which is the default and always works.
   * @param voice - The normalized voice of the call.
   * @returns True when the Google path is taken.
   */
  function usesGoogle(voice) {
    return voice.ttsProvider === TTS_PROVIDER_GOOGLE && voice.googleApiKey !== '';
  }

  /**
   * Whether one call speaks to the free Google route.
   *
   * This one needs nothing but the choice: no key, no billing, no settings.
   * The route has a single Russian voice and no tempo or tone, so the card
   * says what it cannot do instead of silently ignoring the sliders.
   * @param voice - The normalized voice of the call.
   * @returns True when the free Google path is taken.
   */
  function usesGoogleFree(voice) {
    return voice.ttsProvider === TTS_PROVIDER_GOOGLE_FREE;
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
   * Run the Yandex service once for `text`, publishing the result at `target`.
   *
   * The bytes land in the very same MP3 cache the local CLI fills, so the
   * `/speak` flow, the audio route and the client cannot tell the providers
   * apart.
   * @param text - Narration text for this chunk.
   * @param target - Final cache path.
   * @param voice - Normalized voice of this run, provider fields included.
   */
  async function runYandex(text, target, voice) {
    await mkdir(tempDir, { recursive: true });
    const mediaFile = join(tempDir, `${randomUUID()}.mp3`);
    try {
      const request = yandexSpeechRequest({
        voice: voice.yandexVoice,
        text,
        rate: voice.tempo,
        pitch: voice.pitch,
        volume: voice.volume,
        apiKey: voice.yandexApiKey,
        folderId: voice.yandexFolderId,
      });
      counters.launched += 1;
      const bytes = await fetchYandexAudio(request, voice.yandexApiKey);
      if (bytes.length === 0) {
        throw new Error('the Yandex service returned no audio');
      }
      await writeFile(mediaFile, bytes);
      await publishMedia(mediaFile, target);
    } catch (error) {
      counters.failed += 1;
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(
          `dsh-voice-v: synthesis failed: ${redact(String(error?.message ?? error), voice.yandexApiKey)}`,
        );
      }
      throw error;
    } finally {
      await rm(mediaFile, { force: true }).catch(() => {});
    }
  }

  /**
   * The Yandex service's own error text.
   *
   * The service answers a JSON envelope: the reason in `message`, the details
   * in `details[].message`. A body that is not JSON is used as it is, so the
   * plain-text "Not Found" of a wrong route still reaches the log.
   * @param response - The provider's failed response.
   * @returns A short detail, or an empty string.
   */
  async function readYandexErrorDetail(response) {
    let raw = '';
    try {
      if (typeof response.text === 'function') raw = String(await response.text());
    } catch {
      raw = '';
    }
    const text = raw.trim();
    if (text === '') return '';
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        const parts = [];
        if (typeof parsed.message === 'string' && parsed.message.trim() !== '') {
          parts.push(parsed.message.trim());
        }
        const details = Array.isArray(parsed.details) ? parsed.details : [];
        for (const item of details) {
          if (item !== null && typeof item === 'object' && typeof item.message === 'string' && item.message.trim() !== '') {
            parts.push(item.message.trim());
          }
        }
        if (parts.length > 0) detail = parts.join('; ');
      }
    } catch {
      /* not JSON: the raw body is the message */
    }
    return detail.slice(0, 400);
  }

  /**
   * Ask the Yandex service for the audio of one chunk.
   * @param request - `{ url, headers, body }` from {@link yandexSpeechRequest}.
   * @param secret - The API key, used to keep it out of every message.
   * @returns The bytes of the MP3.
   */
  async function fetchYandexAudio(request, secret) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('the Yandex service needs a fetch implementation, and none is available');
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
      throw new Error(`the Yandex service request failed: ${redact(reason, secret)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response === null || response === undefined) {
      throw new Error('the Yandex service answered nothing');
    }
    const ok =
      response.ok === undefined
        ? typeof response.status === 'number' && response.status >= 200 && response.status < 300
        : response.ok === true;
    if (!ok) {
      const status = typeof response.status === 'number' ? response.status : 0;
      const detail = redact(await readYandexErrorDetail(response), secret);
      if (status === 403 || /PermissionDenied/i.test(detail)) {
        // The key is valid and the request was read — the folder is the
        // thing that is closed to it.
        throw new Error(
          `the Yandex service answered ${status}: ключ не имеет прав на папку — выдайте ключу роль SpeechKit в этой папке${detail === '' ? '' : ` (${detail})`}`,
        );
      }
      throw new Error(`the Yandex service answered ${status}${detail === '' ? '' : `: ${detail}`}`);
    }
    let raw = '';
    try {
      if (typeof response.text === 'function') raw = String(await response.text());
    } catch {
      raw = '';
    }
    return yandexAudioBytes(raw);
  }

  /**
   * Run the Google service once for `text`, publishing the result at `target`.
   *
   * The bytes land in the very same MP3 cache the other providers fill, so the
   * `/speak` flow, the audio route and the client cannot tell them apart.
   * @param text - Narration text for this chunk.
   * @param target - Final cache path.
   * @param voice - Normalized voice of this run, provider fields included.
   */
  async function runGoogle(text, target, voice) {
    await mkdir(tempDir, { recursive: true });
    const mediaFile = join(tempDir, `${randomUUID()}.mp3`);
    try {
      const request = googleSpeechRequest({
        voice: voice.googleVoice,
        text,
        rate: voice.tempo,
        pitch: voice.pitch,
        volume: voice.volume,
        apiKey: voice.googleApiKey,
      });
      counters.launched += 1;
      const bytes = await fetchGoogleAudio(request, voice.googleApiKey);
      if (bytes.length === 0) {
        throw new Error('the Google service returned no audio');
      }
      await writeFile(mediaFile, bytes);
      await publishMedia(mediaFile, target);
    } catch (error) {
      counters.failed += 1;
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(
          `dsh-voice-v: synthesis failed: ${redact(String(error?.message ?? error), voice.googleApiKey)}`,
        );
      }
      throw error;
    } finally {
      await rm(mediaFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Ask the Google service for the audio of one chunk.
   *
   * The service answers JSON with the audio in `audioContent`, base64-encoded.
   * A 400 and a 403 are the two failures the user can fix — the key is wrong,
   * or the API is not enabled on its project — so they are reported in those
   * words instead of as a bare status.
   * @param request - `{ url, headers, body }` from {@link googleSpeechRequest}.
   * @param secret - The API key, used to keep it out of every message.
   * @returns The bytes of the MP3.
   */
  async function fetchGoogleAudio(request, secret) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('the Google service needs a fetch implementation, and none is available');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
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
      throw new Error(`the Google service request failed: ${redact(reason, secret)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response === null || response === undefined) {
      throw new Error('the Google service answered nothing');
    }
    const ok =
      response.ok === undefined
        ? typeof response.status === 'number' && response.status >= 200 && response.status < 300
        : response.ok === true;
    if (!ok) {
      const status = typeof response.status === 'number' ? response.status : 0;
      let raw = '';
      try {
        if (typeof response.text === 'function') raw = String(await response.text());
      } catch {
        raw = '';
      }
      const detail = redact(raw.trim(), secret);
      if (status === 400 || status === 403) {
        throw new Error(
          `the Google service answered ${status}: проверьте ключ и что Text-to-Speech включён в его проекте${detail === '' ? '' : ` (${detail})`}`,
        );
      }
      throw new Error(`the Google service answered ${status}${detail === '' ? '' : `: ${detail}`}`);
    }
    let raw = '';
    try {
      if (typeof response.text === 'function') raw = String(await response.text());
    } catch {
      raw = '';
    }
    return googleAudioBytes(raw);
  }

  /**
   * Run the free Google route once for `text`, publishing the result at
   * `target`.
   *
   * The route refuses a long text, so the narration is split and every piece
   * is asked for on its own; the MPEG frames are concatenated in reading
   * order, which is what a player reads as one file. The route has one voice
   * and no tempo or tone — the sliders do not shape it, and the card says so.
   * @param text - Narration text for this chunk.
   * @param target - Final cache path.
   * @param voice - Normalized voice of this run.
   */
  async function runGoogleFree(text, target, voice) {
    await mkdir(tempDir, { recursive: true });
    const mediaFile = join(tempDir, `${randomUUID()}.mp3`);
    try {
      const pieces = googleFreePieces(text);
      if (pieces.length === 0) throw new Error('the free Google route has nothing to speak');
      counters.launched += 1;
      const parts = [];
      for (const piece of pieces) {
        parts.push(await fetchGoogleFreeAudio(googleFreeUrl(piece)));
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length === 0) throw new Error('the free Google route returned no audio');
      await writeFile(mediaFile, bytes);
      await publishMedia(mediaFile, target);
    } catch (error) {
      counters.failed += 1;
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(`dsh-voice-v: synthesis failed: ${String(error?.message ?? error)}`);
      }
      throw error;
    } finally {
      await rm(mediaFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Ask the free Google route for the audio of one piece.
   * @param url - The route URL for one piece.
   * @returns The bytes of the MPEG audio.
   */
  async function fetchGoogleFreeAudio(url) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('the free Google route needs a fetch implementation, and none is available');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 (dsh-voice-v)' },
        ...(controller === null ? {} : { signal: controller.signal }),
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      const reason = aborted ? `timed out after ${timeoutMs} ms` : String(error?.message ?? error);
      throw new Error(`the free Google route request failed: ${reason}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response === null || response === undefined) {
      throw new Error('the free Google route answered nothing');
    }
    const ok =
      response.ok === undefined
        ? typeof response.status === 'number' && response.status >= 200 && response.status < 300
        : response.ok === true;
    if (!ok) {
      const status = typeof response.status === 'number' ? response.status : 0;
      throw new Error(`the free Google route answered ${status}`);
    }
    if (typeof response.arrayBuffer === 'function') {
      const buffer = await response.arrayBuffer();
      return Buffer.from(new Uint8Array(buffer));
    }
    if (typeof response.text === 'function') {
      // A route that answers text is not audio: say so instead of caching
      // silence.
      const raw = String(await response.text());
      throw new Error(`the free Google route answered text, not audio: ${raw.slice(0, 120)}`);
    }
    throw new Error('the free Google route answered in a shape this build does not read');
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
    const run = usesYandex(voice)
      ? runYandex
      : usesGoogle(voice)
        ? runGoogle
        : usesGoogleFree(voice)
          ? runGoogleFree
          : usesCustomEndpoint(voice)
            ? runCustomEndpoint
            : runEdgeTts;
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
