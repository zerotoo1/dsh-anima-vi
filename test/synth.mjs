#!/usr/bin/env node
/**
 * dsh-voice-v test suite.
 *
 * Exercises exactly the functions the HTTP route calls, without starting a web
 * server and without binding a port:
 *
 *  1. text cleaning — Russian survives, code/tables/links/emoji go away, the
 *     pronunciation dictionary fires on whole words only;
 *  2. chunking — sentence-aligned and bounded;
 *  3. config — the `zhivoy` / `neytralnyy` presets and explicit overrides;
 *  4. synthesis — a real `edge-tts` run writes an MP3, and the second call of
 *     the same text is a cache hit that launches no process;
 *  5. the route handler — `/speak`, `/config`, `/health`, and `/audio/...`
 *     against mock request/response objects.
 *
 * Run: `node test/synth.mjs` (or `npm test`).
 *
 * @module dsh-voice-v/test
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

import { DEFAULT_EDGE_TTS_BIN, DEFAULT_PRESETS, DEFAULT_VOICE, normalizePitch, normalizeRate, resolveVoiceConfig } from '../lib/config.js';
import { createVoiceHandler } from '../lib/index.js';
import {
  cacheKeyFor,
  createSynthService,
  googleAudioBytes,
  googleFreePieces,
  googleFreeUrl,
  googlePitchSemitones,
  googleVolumeDb,
  yandexAudioBytes,
  yandexSpeechRequest,
} from '../lib/synth.js';
import { applyYoMode, cleanForSpeech, prepareForSpeech, spellYo, splitIntoChunks } from '../lib/text.js';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

/**
 * Run one named check, containing its failure so later checks still report.
 * @param label - Test name.
 * @param body - Async body performing the assertions.
 */
async function test(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n       ')}`);
  }
}

/** A mock HTTP request: a readable body carrying method, url, and headers. */
function mockRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => req.end();
  if (body !== '') req.write(Buffer.from(body, 'utf8'));
  process.nextTick(() => req.end());
  return req;
}

/** A mock HTTP response: records the head and collects the body. */
function mockResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.status = 0;
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers ?? {};
    res.headersSent = true;
    return res;
  };
  res.headersSent = false;
  res.collected = () => Buffer.concat(chunks);
  res.json = () => JSON.parse(res.collected().toString('utf8'));
  return res;
}

/** Drive one request through a handler and return the settled response. */
async function callRoute(handler, options) {
  const req = mockRequest(options);
  const res = mockResponse();
  const done = new Promise((resolveDone) => res.on('finish', resolveDone));
  await handler(req, res);
  await done;
  return res;
}

/**
 * Decode a stored session log. The artifact is a container of concatenated,
 * independently checksummed Zstandard frames, so it is split on the frame magic
 * and each frame is decoded on its own. Test-only: the plugin reads the same
 * events through `ctx.sessions` / `ctx.sessionPersistence` instead.
 * @param file - Path to a `session.vN.jsonl.zstd` artifact.
 * @returns The decoded session events in log order.
 */
function readStoredSessionEvents(file) {
  const buffer = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(magic, 0, 4, index, index + 4) === 0) starts.push(index);
  }
  const chunks = [];
  for (let index = 0; index < starts.length; index += 1) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)));
    } catch {
      // A magic sequence inside compressed data, or a torn final frame.
    }
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      if (record !== null && typeof record === 'object' && record.type !== 'session') events.push(record);
    } catch {
      // A partially recovered line.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
console.log('dsh-voice-v tests\n');
console.log('text cleaning');

await test('keeps Russian prose intact', () => {
  const source = 'Готово. Я обновил конфигурацию и проверил сборку — всё работает.';
  const cleaned = cleanForSpeech(source);
  assert.match(cleaned, /Готово\./);
  assert.match(cleaned, /обновил конфигурацию/);
  // The letter ё stays as it is written: the Russian voices read it, and the
  // user heard it and called it perfect.
  assert.match(cleaned, /всё работает\./);
  // The written-out spelling is still there, for a voice that needs it.
  const spelled = cleanForSpeech(source, { yoMode: 'spelled' });
  assert.match(spelled, /всьо работает\./);
});

await test('the letter ё is written out the way a Russian reader reads it', () => {
  // In the middle of a word, after a soft consonant: "йо".
  assert.equal(spellYo('приём'), 'прийом');
  assert.equal(spellYo('моё'), 'мойо');
  // At the beginning of a word, or after a hard consonant: "ьо".
  assert.equal(spellYo('всё'), 'всьо');
  assert.equal(spellYo('нёбо'), 'ньобо');
  assert.equal(spellYo('ушёл'), 'ушьол');
  // The hard sign is dropped, the way a reader drops it.
  assert.equal(spellYo('съёмка'), 'сьомка');
  // A "й" before the letter is not doubled.
  assert.equal(spellYo('мойё'), 'мойо');
  // A hard consonant takes the "ьо" spelling.
  assert.equal(spellYo('счёт'), 'счьот');
  // The rest of the text is untouched.
  assert.equal(spellYo('привет, всё'), 'привет, всьо');
});

await test('the way the letter ё is handled is the user\'s choice', () => {
  // As written: the letter stays, and the Edge voice reads it as "йе".
  assert.equal(applyYoMode('приём всё', 'as-is'), 'приём всё');
  // Without the dots: the word loses the letter, not the sound.
  assert.equal(applyYoMode('приём всё', 'plain'), 'прием все');
  // Written out: the phonetics, spelled.
  assert.equal(applyYoMode('приём всё', 'spelled'), 'прийом всьо');
  // An unknown mode changes nothing.
  assert.equal(applyYoMode('приём', 'nonsense'), 'приём');
});

await test('the mode reaches the text the voice reads', () => {
  const asIs = cleanForSpeech('Приём и всё.', { yoMode: 'as-is' });
  assert.match(asIs, /Приём и всё\./);
  const plain = cleanForSpeech('Приём и всё.', { yoMode: 'plain' });
  assert.match(plain, /Прием и все\./);
  const spelled = cleanForSpeech('Приём и всё.', { yoMode: 'spelled' });
  assert.match(spelled, /Прийом и всьо\./);
});

await test('replaces a fenced code block with «блок кода»', () => {
  const source = ['До кода.', '```js', 'const a = 1;', 'console.log(a);', '```', 'После кода.'].join('\n');
  const cleaned = cleanForSpeech(source);
  assert.match(cleaned, /блок кода/);
  assert.doesNotMatch(cleaned, /console\.log/);
  assert.doesNotMatch(cleaned, /const a/);
  assert.match(cleaned, /До кода\./);
  assert.match(cleaned, /После кода\./);
});

await test('drops a markdown table entirely', () => {
  const source = ['Итог:', '| Файл | Размер |', '| --- | ---: |', '| a.js | 12 |', '| b.js | 34 |', 'Конец.'].join('\n');
  const cleaned = cleanForSpeech(source);
  assert.doesNotMatch(cleaned, /\|/);
  assert.doesNotMatch(cleaned, /a\.js/);
  assert.doesNotMatch(cleaned, /12/);
  assert.match(cleaned, /Итог:/);
  assert.match(cleaned, /Конец\./);
});

await test('keeps link labels, drops URLs', () => {
  const cleaned = cleanForSpeech('См. [README](https://example.com/docs) и https://example.com/x.');
  assert.match(cleaned, /README/);
  assert.doesNotMatch(cleaned, /example\.com/);
  assert.doesNotMatch(cleaned, /https/);
});

await test('removes emoji and service symbols', () => {
  const cleaned = cleanForSpeech('## Заголовок 🚀 **важно** ~~нет~~ `inline` — > цитата');
  assert.doesNotMatch(cleaned, /🚀/u);
  assert.doesNotMatch(cleaned, /[*~`#>|]/);
  assert.match(cleaned, /Заголовок/);
  assert.match(cleaned, /важно/);
  assert.match(cleaned, /inline/);
});

await test('applies the pronunciation dictionary on whole words only', () => {
  const cleaned = cleanForSpeech(
    'Скрипт redscript и TweakDB правят HUD, ANIMA, CET и NCPD; рядом .anims и ent-файл.',
  );
  assert.match(cleaned, /редскрипт/);
  assert.match(cleaned, /твик-ди-би/);
  assert.match(cleaned, /хад/);
  assert.match(cleaned, /анима/);
  assert.match(cleaned, /си-и-ти/);
  assert.match(cleaned, /эн-си-пи-ди/);
  assert.match(cleaned, /анимации/);
  assert.match(cleaned, /энт/);
  assert.doesNotMatch(cleaned, /redscript/);
  assert.doesNotMatch(cleaned, /TweakDB/);
});

await test('does not corrupt words that merely contain a dictionary term', () => {
  const cleaned = cleanForSpeech('The content of the client is still available.');
  assert.match(cleaned, /content/);
  assert.match(cleaned, /client/);
  assert.doesNotMatch(cleaned, /энт/);
});

await test('collapses whitespace', () => {
  const cleaned = cleanForSpeech('  много    пробелов\n\n\nи   переносов  ');
  assert.equal(cleaned, 'много пробелов и переносов');
});

console.log('\nchunking');

await test('splits on sentence boundaries within the budget', () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  const chunks = splitIntoChunks(text, 30);
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
  for (const chunk of chunks) assert.ok(chunk.length <= 30, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);
});

await test('hard-splits one overlong sentence', () => {
  const text = 'слово '.repeat(40).trim() + '.';
  const chunks = splitIntoChunks(text, 50);
  assert.ok(chunks.length > 1, 'a 240-character sentence must not stay in one chunk');
  for (const chunk of chunks) assert.ok(chunk.length <= 50, `chunk too long: ${chunk.length}`);
});

await test('keeps a short answer as one chunk', () => {
  assert.deepEqual(splitIntoChunks('Короткий ответ.', 320), ['Короткий ответ.']);
});

await test('prepareForSpeech reports truncation', () => {
  const prepared = prepareForSpeech('а'.repeat(500), { maxTextChars: 100, maxChunkChars: 60 });
  assert.equal(prepared.truncated, true);
  assert.equal(prepared.cleaned.length, 100);
});

console.log('\ncode identifiers and dots');

await test('a member-access dot does not end a chunk', () => {
  const text = 'Он вызвал ctx.inject, потом ctx.get() и закрыл.';
  const chunks = splitIntoChunks(text, 320);
  assert.equal(chunks.length, 1, `expected one chunk, got ${JSON.stringify(chunks)}`);
  assert.match(chunks[0], /ctx\.inject/);
  assert.match(chunks[0], /ctx\.get\(\)/);
});

await test('a path with a dot in it stays in one chunk', () => {
  const chunks = splitIntoChunks('Открыл lib/client.js и проверил сборку.', 320);
  assert.equal(chunks.length, 1, `expected one chunk, got ${JSON.stringify(chunks)}`);
});

await test('a decimal number keeps its point and stays in one chunk', () => {
  const chunks = splitIntoChunks('Цена 3.14 и вес 0.5.', 320);
  assert.equal(chunks.length, 1, `expected one chunk, got ${JSON.stringify(chunks)}`);
  const prepared = prepareForSpeech('Цена 3.14 и вес 0.5.');
  assert.match(prepared.cleaned, /3\.14/);
  assert.match(prepared.cleaned, /0\.5/);
});

await test('a member-access dot is read as a space', () => {
  const prepared = prepareForSpeech('Вызов ctx.inject и ctx.get() прошёл.');
  assert.match(prepared.cleaned, /ctx inject/);
  assert.match(prepared.cleaned, /ctx get\(\)/);
  assert.doesNotMatch(prepared.cleaned, /ctx\./);
  assert.equal(prepared.chunks.length, 1);
});

await test('a nested identifier is read as separate words', () => {
  const prepared = prepareForSpeech('Путь foo.bar.baz проверен.');
  assert.match(prepared.cleaned, /foo bar baz/);
  assert.doesNotMatch(prepared.cleaned, /foo\./);
});

await test('ordinary prose keeps its sentence dots and its chunk boundary', () => {
  const prepared = prepareForSpeech('Привет. Как дела?', { maxChunkChars: 10 });
  assert.equal(prepared.chunks.length, 2);
  assert.equal(prepared.chunks[0], 'Привет.');
  assert.equal(prepared.chunks[1], 'Как дела?');
  assert.match(prepared.cleaned, /Привет\. Как дела\?/);
});

await test('the letter ё modes are untouched by the dot rule', () => {
  const asIs = prepareForSpeech('Всё в ctx.inject.', { yoMode: 'as-is' });
  assert.match(asIs.cleaned, /Всё в ctx inject\./);
  const plain = prepareForSpeech('Всё в ctx.inject.', { yoMode: 'plain' });
  assert.match(plain.cleaned, /Все в ctx inject\./);
  const spelled = prepareForSpeech('Всё в ctx.inject.', { yoMode: 'spelled' });
  assert.match(spelled.cleaned, /Всьо в ctx inject\./);
});

await test('the code and the table are read the way they are written', () => {
  const source = ['```js', 'console.log(a);', '```', '| Файл |', '| --- |', '| a.js |'].join('\n');
  const cleaned = cleanForSpeech(source, { stripCode: false });
  assert.match(cleaned, /console\.log/);
  assert.match(cleaned, /a\.js/);
});

console.log('\nvoice configuration');

await test('default preset is zhivoy with rate +6% and pitch +12Hz', () => {
  const settings = resolveVoiceConfig({});
  assert.equal(settings.preset, 'zhivoy');
  assert.equal(settings.voice, DEFAULT_VOICE);
  assert.equal(settings.rate, '+6%');
  assert.equal(settings.pitch, '+12Hz');
  assert.equal(settings.rateOverridden, false);
  assert.equal(settings.pitchOverridden, false);
});

await test('the rejected +12% / +25Hz values appear nowhere as defaults', () => {
  const settings = resolveVoiceConfig({});
  assert.notEqual(settings.rate, '+12%');
  assert.notEqual(settings.pitch, '+25Hz');
  assert.equal(DEFAULT_PRESETS.zhivoy.rate, '+6%');
  assert.equal(DEFAULT_PRESETS.zhivoy.pitch, '+12Hz');
});

await test('preset neytralnyy flattens rate and pitch', () => {
  const settings = resolveVoiceConfig({ preset: 'neytralnyy' });
  assert.equal(settings.preset, 'neytralnyy');
  assert.equal(settings.rate, '+0%');
  assert.equal(settings.pitch, '+0Hz');
});

await test('an explicit rate/pitch beats the preset', () => {
  const settings = resolveVoiceConfig({ preset: 'neytralnyy', rate: '+20%', pitch: '-5Hz' });
  assert.equal(settings.rate, '+20%');
  assert.equal(settings.pitch, '-5Hz');
  assert.equal(settings.rateOverridden, true);
  assert.equal(settings.pitchOverridden, true);
});

await test('an unknown preset falls back to the defaults', () => {
  const settings = resolveVoiceConfig({ preset: 'nope' });
  assert.equal(settings.presetKnown, false);
  assert.equal(settings.preset, 'zhivoy');
  assert.equal(settings.rate, '+6%');
  assert.equal(settings.pitch, '+12Hz');
});

await test('bare numbers normalize to edge-tts literals', () => {
  assert.equal(normalizeRate('0'), '+0%');
  assert.equal(normalizeRate('6'), '+6%');
  assert.equal(normalizeRate('-10%'), '-10%');
  assert.equal(normalizePitch('0'), '+0Hz');
  assert.equal(normalizePitch('12'), '+12Hz');
  assert.equal(normalizePitch('+12Hz'), '+12Hz');
});

await test('a custom preset and a custom voice are configurable', () => {
  const settings = resolveVoiceConfig({
    preset: 'moy',
    presets: { moy: { rate: '+15%', pitch: '+30Hz' } },
    voice: 'ru-RU-DariyaNeural',
  });
  assert.equal(settings.rate, '+15%');
  assert.equal(settings.pitch, '+30Hz');
  assert.equal(settings.voice, 'ru-RU-DariyaNeural');
});

await test('the dictionary merges over the built-in terms', () => {
  const settings = resolveVoiceConfig({ dictionary: { redscript: 'ред-скрипт' } });
  assert.equal(settings.dictionary.redscript, 'ред-скрипт');
  assert.equal(settings.dictionary.TweakDB, 'твик-ди-би');
});

console.log('\ncache keys');

await test('the key is a stable sha256 over text, voice, rate, and pitch', () => {
  const base = { text: 'привет', voice: 'ru-RU-SvetlanaNeural', rate: '+6%', pitch: '+12Hz' };
  const first = cacheKeyFor(base);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, cacheKeyFor({ ...base }));
  assert.notEqual(first, cacheKeyFor({ ...base, rate: '+0%' }));
  assert.notEqual(first, cacheKeyFor({ ...base, pitch: '+0Hz' }));
  assert.notEqual(first, cacheKeyFor({ ...base, voice: 'ru-RU-DariyaNeural' }));
  assert.notEqual(first, cacheKeyFor({ ...base, text: 'пока' }));
  // Normalization means `0` and `+0%` share one cache entry.
  assert.equal(cacheKeyFor({ ...base, rate: '6' }), cacheKeyFor({ ...base, rate: '+6%' }));
});

console.log('\nsynthesis and cache (real edge-tts)');

const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-voice-v-test-'));
let launches = 0;
const spawnCounting = (...args) => {
  launches += 1;
  return spawn(...args);
};

const synth = createSynthService({
  binPath: DEFAULT_EDGE_TTS_BIN,
  cacheDir,
  voice: DEFAULT_VOICE,
  rate: '+6%',
  pitch: '+12Hz',
  timeoutMs: 90000,
  spawnImpl: spawnCounting,
});

await test('edge-tts produces a non-empty MP3', async () => {
  launches = 0;
  const result = await synth.ensure('Проверка синтеза речи.');
  assert.equal(result.cached, false);
  assert.equal(launches, 1);
  assert.ok(existsSync(result.file), `missing cache file ${result.file}`);
  const info = await stat(result.file);
  assert.ok(info.size > 1000, `MP3 too small: ${info.size} bytes`);
  assert.match(result.key, /^[0-9a-f]{64}$/);
});

await test('the second call is a cache hit and launches no process', async () => {
  launches = 0;
  const result = await synth.ensure('Проверка синтеза речи.');
  assert.equal(result.cached, true);
  assert.equal(launches, 0, 'a cache hit must not spawn edge-tts');
  assert.ok(result.bytes > 1000);
});

await test('concurrent requests for one chunk share a single process', async () => {
  launches = 0;
  const text = 'Параллельный вызов, один процесс.';
  const results = await Promise.all([synth.ensure(text), synth.ensure(text), synth.ensure(text)]);
  assert.equal(launches, 1, `expected one launch, saw ${launches}`);
  for (const result of results) assert.ok(result.bytes > 1000);
});

await test('a different pitch changes the cache slot', async () => {
  const other = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir,
    voice: DEFAULT_VOICE,
    rate: '+6%',
    pitch: '+0Hz',
    timeoutMs: 90000,
    spawnImpl: spawnCounting,
  });
  const base = await synth.cached('Проверка синтеза речи.');
  const changed = await other.cached('Проверка синтеза речи.');
  assert.notEqual(base.key, changed.key);
});

console.log('\nedge-tts stays the default');

/**
 * A fake `edge-tts` process that records the argv it was given and writes the
 * media file the service asked for. It is how the local path is proved to be
 * unchanged without spawning anything.
 * @param _bin - Executable path, ignored.
 * @param argv - The argv the service built.
 * @returns An EventEmitter shaped like a ChildProcess.
 */
function argvRecordingEdgeTts(_bin, argv) {
  const child = new EventEmitter();
  child.kill = () => {};
  argvRecordingEdgeTts.calls.push(argv);
  const media = argv[argv.indexOf('--write-media') + 1];
  setImmediate(() => {
    try {
      writeFileSync(media, Buffer.from('ID3local'.padEnd(1200, '.')));
      child.emit('close', 0);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
}
argvRecordingEdgeTts.calls = [];

await test('without a custom endpoint the local CLI is spawned with the very same argv', async () => {
  argvRecordingEdgeTts.calls.length = 0;
  const local = createSynthService({
    binPath: 'edge-tts',
    cacheDir,
    voice: DEFAULT_VOICE,
    rate: '+6%',
    pitch: '+12Hz',
    timeoutMs: 10000,
    spawnImpl: argvRecordingEdgeTts,
  });
  await local.ensure('Аргументы остаются прежними.');
  assert.equal(argvRecordingEdgeTts.calls.length, 1, 'the local CLI must still be spawned');
  const argv = argvRecordingEdgeTts.calls[0];
  assert.deepEqual(argv.slice(0, 8), [
    '--voice',
    DEFAULT_VOICE,
    '--rate',
    '+6%',
    '--pitch',
    '+12Hz',
    '--volume',
    '+0%',
  ]);
  assert.equal(argv[8], '--no-progress');
  assert.equal(argv[9], '--write-media');
  assert.equal(argv[11], '--file');
});

await test('a provider of custom without a base URL and a model still uses the local CLI', async () => {
  argvRecordingEdgeTts.calls.length = 0;
  const halfConfigured = createSynthService({
    binPath: 'edge-tts',
    cacheDir,
    timeoutMs: 10000,
    spawnImpl: argvRecordingEdgeTts,
    voiceOptions: () => ({
      voice: DEFAULT_VOICE,
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'custom',
      customBaseUrl: 'https://api.openai.com/v1',
      customApiKey: 'sk-test-secret',
      customModel: '',
    }),
  });
  await halfConfigured.ensure('Недоопределённый провайдер.');
  assert.equal(argvRecordingEdgeTts.calls.length, 1, 'an incomplete endpoint falls back to edge-tts');
});

console.log('\ncustom TTS endpoint (OpenAI-compatible, fake fetch)');

const CUSTOM_API_KEY = 'sk-test-secret-42';
const customCacheDir = await mkdtemp(join(tmpdir(), 'dsh-voice-v-custom-'));

/**
 * A fake `fetch` for the custom endpoint: it records every request and
 * answers with what the handler returns.
 * @param handler - `(url, init, callNumber) => response`.
 * @returns The fake fetch, with a `calls` array on it.
 */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body === undefined ? null : JSON.parse(init.body),
    });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

/**
 * A successful answer carrying the given bytes.
 * @param bytes - The audio bytes the endpoint "returned".
 * @returns A Response-like object.
 */
function audioAnswer(bytes) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return new Uint8Array(bytes).buffer;
    },
  };
}

/**
 * A synthesis service on the custom endpoint.
 * @param options - `fetchImpl`, and the provider fields to report.
 * @returns The service.
 */
function customSynth(options = {}) {
  return createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl: options.fetchImpl,
    voiceOptions: () => ({
      voice: 'alloy',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'custom',
      customBaseUrl: 'https://api.openai.com/v1',
      customApiKey: CUSTOM_API_KEY,
      customModel: 'tts-1',
      ...(options.provider ?? {}),
    }),
  });
}

await test('the custom endpoint is asked the OpenAI way, and its bytes are cached', async () => {
  const audio = Buffer.from('ID3custom-endpoint-audio'.padEnd(2048, '.'));
  const fetchImpl = recordingFetch(async () => audioAnswer(audio));
  const service = customSynth({ fetchImpl });

  const result = await service.ensure('Проверка кастомного эндпоинта.');
  assert.equal(fetchImpl.calls.length, 1, 'the endpoint must be asked exactly once');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers.Authorization, `Bearer ${CUSTOM_API_KEY}`);
  assert.deepEqual(call.body, {
    model: 'tts-1',
    input: 'Проверка кастомного эндпоинта.',
    voice: 'alloy',
    response_format: 'mp3',
    speed: 1.06,
  });

  // The bytes landed in the plugin's own MP3 cache.
  assert.equal(result.cached, false);
  assert.ok(existsSync(result.file), `missing cache file ${result.file}`);
  assert.deepEqual(await readFile(result.file), audio);

  // And the second call is served from the cache: no second request.
  const again = await service.ensure('Проверка кастомного эндпоинта.');
  assert.equal(again.cached, true);
  assert.equal(fetchImpl.calls.length, 1, 'a cache hit must not ask the endpoint again');
});

await test('no configured tempo means no speed parameter', async () => {
  const fetchImpl = recordingFetch(async () => audioAnswer(Buffer.from('ID3no-speed'.padEnd(1024, '.'))));
  const service = customSynth({ fetchImpl, provider: { rate: '' } });
  await service.ensure('Без темпа.');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal('speed' in fetchImpl.calls[0].body, false, 'an unset tempo sends no speed');
  assert.deepEqual(fetchImpl.calls[0].body, {
    model: 'tts-1',
    input: 'Без темпа.',
    voice: 'alloy',
    response_format: 'mp3',
  });
});

await test('a base URL that already names the endpoint is not doubled', async () => {
  const fetchImpl = recordingFetch(async () => audioAnswer(Buffer.from('ID3full-url'.padEnd(1024, '.'))));
  const service = customSynth({
    fetchImpl,
    provider: { customBaseUrl: 'https://api.openai.com/v1/audio/speech' },
  });
  await service.ensure('Полный URL эндпоинта.');
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/audio/speech');
});

await test('a trailing slash in the base URL does not double the separator', async () => {
  const fetchImpl = recordingFetch(async () => audioAnswer(Buffer.from('ID3slash'.padEnd(1024, '.'))));
  const service = customSynth({
    fetchImpl,
    provider: { customBaseUrl: 'https://api.siliconflow.cn/v1/' },
  });
  await service.ensure('Base URL со слешем.');
  assert.equal(fetchImpl.calls[0].url, 'https://api.siliconflow.cn/v1/audio/speech');
});

await test('the two providers never share a cache slot', async () => {
  const text = 'Один и тот же текст у двух провайдеров.';
  const edgeKey = cacheKeyFor({ text, voice: 'alloy', rate: '+6%', pitch: '+12Hz', volume: '+0%' });
  const customKey = cacheKeyFor({
    text,
    voice: 'alloy',
    rate: '+6%',
    pitch: '+12Hz',
    volume: '+0%',
    ttsProvider: 'custom',
    customModel: 'tts-1',
    customBaseUrl: 'https://api.openai.com/v1',
  });
  assert.notEqual(edgeKey, customKey, 'the provider must be part of the cache key');

  // The key itself is never part of it.
  const otherKey = cacheKeyFor({
    text,
    voice: 'alloy',
    rate: '+6%',
    pitch: '+12Hz',
    volume: '+0%',
    ttsProvider: 'custom',
    customModel: 'tts-1',
    customBaseUrl: 'https://api.openai.com/v1',
    customApiKey: 'sk-a-completely-different-key',
  });
  assert.equal(customKey, otherKey, 'the API key must not reach the cache key');

  // The file the local CLI produced is not served for a custom request, and
  // the other way round.
  const local = createSynthService({
    binPath: 'edge-tts',
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    spawnImpl: argvRecordingEdgeTts,
    voiceOptions: () => ({
      voice: 'alloy',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'edge',
    }),
  });
  const localResult = await local.ensure(text);
  assert.equal(localResult.cached, false);

  const fetchImpl = recordingFetch(async () => audioAnswer(Buffer.from('ID3other-provider'.padEnd(1024, '.'))));
  const service = customSynth({ fetchImpl });
  const customResult = await service.ensure(text);
  assert.equal(customResult.cached, false, 'a custom request must not be served the edge-tts file');
  assert.equal(fetchImpl.calls.length, 1, 'the custom request must reach the endpoint');
  assert.notEqual(localResult.key, customResult.key);
});

await test('a failing endpoint names the status and the provider’s own error text', async () => {
  const fetchImpl = recordingFetch(async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ error: { message: 'Incorrect API key provided' } });
    },
  }));
  const service = customSynth({ fetchImpl });
  await assert.rejects(
    () => service.ensure('Ошибка авторизации.'),
    (error) => {
      assert.match(String(error?.message ?? error), /401/);
      assert.match(String(error?.message ?? error), /Incorrect API key provided/);
      assert.equal(String(error?.message ?? error).includes(CUSTOM_API_KEY), false, 'the key must not leak');
      return true;
    },
  );
});

await test('a network failure is reported the same way, and never with the key', async () => {
  const fetchImpl = recordingFetch(async () => {
    throw new Error(`connect ECONNREFUSED with ${CUSTOM_API_KEY}`);
  });
  const service = customSynth({ fetchImpl });
  await assert.rejects(
    () => service.ensure('Сеть недоступна.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /custom TTS endpoint request failed/);
      assert.equal(message.includes(CUSTOM_API_KEY), false, 'the key must not leak into an error');
      assert.match(message, /\*\*\*/, 'the key is redacted, not dropped silently');
      return true;
    },
  );
});

await test('a provider that echoes the key back does not get it into the message', async () => {
  const fetchImpl = recordingFetch(async () => ({
    ok: false,
    status: 500,
    async text() {
      return `internal error: token ${CUSTOM_API_KEY} rejected`;
    },
  }));
  const service = customSynth({ fetchImpl });
  await assert.rejects(
    () => service.ensure('Провайдер повторил ключ.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /500/);
      assert.equal(message.includes(CUSTOM_API_KEY), false, 'the key must not leak into an error');
      return true;
    },
  );
});

await test('a hanging endpoint is stopped by the plugin’s own timeout', async () => {
  const fetchImpl = recordingFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            const error = new Error('the request was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      }),
  );
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 60,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'alloy',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'custom',
      customBaseUrl: 'https://api.openai.com/v1',
      customApiKey: CUSTOM_API_KEY,
      customModel: 'tts-1',
    }),
  });
  await assert.rejects(
    () => service.ensure('Эндпоинт не отвечает.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /timed out after 60 ms/);
      assert.equal(message.includes(CUSTOM_API_KEY), false, 'the key must not leak into an error');
      return true;
    },
  );
});

await test('the local path is untouched by a failing endpoint', async () => {
  argvRecordingEdgeTts.calls.length = 0;
  const local = createSynthService({
    binPath: 'edge-tts',
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    spawnImpl: argvRecordingEdgeTts,
  });
  const result = await local.ensure('Локальный путь после сбоя.');
  assert.equal(result.cached, false);
  assert.equal(argvRecordingEdgeTts.calls.length, 1, 'the local CLI still works');
  assert.ok(existsSync(result.file));
});

console.log('\nroute handler (mock req/res, no port bound)');

const settings = resolveVoiceConfig({ cacheDir });
const routes = createVoiceHandler({
  ctx: { get: () => undefined, logger: { warn: () => {} } },
  settings,
  synth,
});

await test('GET /health reports the effective voice', async () => {
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/health' });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.voice, DEFAULT_VOICE);
  assert.equal(payload.rate, '+6%');
  assert.equal(payload.pitch, '+12Hz');
});

await test('GET /config reports the preset resolution', async () => {
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.preset, 'zhivoy');
  assert.equal(payload.rate, '+6%');
  assert.equal(payload.pitch, '+12Hz');
  assert.equal(payload.presets.neytralnyy.rate, '0');
});

await test('GET /speak with a text fallback returns ordered cached parts', async () => {
  const text = encodeURIComponent('Первое предложение. Второе предложение.');
  const res = await callRoute(routes, { method: 'GET', url: `/dsh-voice-v/speak?text=${text}` });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.source, 'text');
  assert.ok(payload.parts.length >= 1);
  assert.equal(payload.parts[0].cached, true);
  assert.match(payload.parts[0].url, /^\/dsh-voice-v\/audio\/[0-9a-f]{64}\.mp3$/);
});

await test('GET /speak without any text source is a coded 404', async () => {
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/speak' });
  assert.equal(res.status, 404);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'session-required');
});

await test('the returned part is downloadable as audio/mpeg with HEAD support', async () => {
  const text = encodeURIComponent('Проверка синтеза речи.');
  const speak = await callRoute(routes, { method: 'GET', url: `/dsh-voice-v/speak?text=${text}` });
  const url = speak.json().parts[0].url;

  const get = await callRoute(routes, { method: 'GET', url });
  assert.equal(get.status, 200);
  assert.equal(get.headers['Content-Type'], 'audio/mpeg');
  assert.equal(get.headers['Accept-Ranges'], 'bytes');
  assert.ok(get.collected().byteLength > 1000);

  const head = await callRoute(routes, { method: 'HEAD', url });
  assert.equal(head.status, 200);
  assert.equal(head.headers['Content-Type'], 'audio/mpeg');
  assert.equal(head.collected().byteLength, 0, 'HEAD must not carry a body');
  assert.equal(Number(head.headers['Content-Length']), get.collected().byteLength);

  const ranged = await callRoute(routes, { method: 'GET', url, headers: { range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.collected().byteLength, 100);
  assert.match(ranged.headers['Content-Range'], /^bytes 0-99\/\d+$/);
});

await test('a malformed audio key is a coded 400', async () => {
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/audio/nope.mp3' });
  assert.equal(res.status, 400);
  assert.equal(res.json().code, 'bad-key');
});

await test('an unknown but well-formed audio key is a coded 404', async () => {
  const res = await callRoute(routes, { method: 'GET', url: `/dsh-voice-v/audio/${'0'.repeat(64)}.mp3` });
  assert.equal(res.status, 404);
  assert.equal(res.json().code, 'not-synthesized');
});

await test('an unsupported method answers 405 with Allow', async () => {
  const res = await callRoute(routes, { method: 'DELETE', url: '/dsh-voice-v/speak' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD, POST');
});

await test('an unknown endpoint under the prefix is a coded 404', async () => {
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/whatever' });
  assert.equal(res.status, 404);
  assert.equal(res.json().code, 'not-found');
});

await test('POST /speak accepts a JSON body', async () => {
  const body = JSON.stringify({ text: 'Тело запроса тоже работает.' });
  const res = await callRoute(routes, {
    method: 'POST',
    url: '/dsh-voice-v/speak',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().source, 'text');
});

await test('a synthesis failure is a coded 502, not an unhandled throw', async () => {
  const broken = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    settings,
    synth: {
      ...synth,
      ensure: async () => {
        throw new Error('edge-tts exited with code 1');
      },
      cached: async (text) => synth.cached(text),
    },
  });
  const res = await callRoute(broken, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Этот синтез сломан.')}`,
  });
  assert.equal(res.status, 502);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'synthesis-failed');
  assert.match(payload.message, /edge-tts exited with code 1/);
});

console.log('\nhost message lookup');

await test('reads the assistant text out of a live session snapshot', async () => {
  const { readAssistantMessageText } = await import('../lib/session-text.js');
  const events = [
    { type: 'user/message', seq: 1, data: { role: 'user' } },
    {
      type: 'assistant/message',
      seq: 2,
      surfaceOp: 'append',
      data: { message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Первый ответ.' }] } },
    },
    {
      type: 'assistant/message',
      seq: 3,
      surfaceOp: 'append',
      data: {
        message: {
          id: 'msg-2',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'не читать' },
            { type: 'text', text: 'Второй ответ.' },
          ],
        },
      },
    },
  ];
  const ctx = { get: (name) => (name === 'sessions' ? { get: () => ({ snapshotEvents: () => events }) } : undefined) };
  assert.equal(await readAssistantMessageText(ctx, 's1', 'msg-1'), 'Первый ответ.');
  assert.equal(await readAssistantMessageText(ctx, 's1', 'msg-2'), 'Второй ответ.');
  assert.equal(await readAssistantMessageText(ctx, 's1', ''), 'Второй ответ.');
  assert.equal(await readAssistantMessageText(ctx, 's1', 'missing'), null);
});

await test('falls back to persistence for a non-live session, and closes the handle', async () => {
  const { readAssistantMessageText } = await import('../lib/session-text.js');
  let closed = false;
  const ctx = {
    get: (name) =>
      name === 'sessionPersistence'
        ? {
            open: async () => ({
              read: async () => ({
                events: [
                  {
                    type: 'assistant/message',
                    seq: 1,
                    surfaceOp: 'append',
                    data: { message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Из файла.' }] } },
                  },
                ],
              }),
              close: async () => {
                closed = true;
              },
            }),
          }
        : undefined,
  };
  assert.equal(await readAssistantMessageText(ctx, 'cold', 'm'), 'Из файла.');
  assert.equal(closed, true);
});

await test('an unknown session yields null rather than throwing', async () => {
  const { readAssistantMessageText } = await import('../lib/session-text.js');
  assert.equal(await readAssistantMessageText({ get: () => undefined }, 'nope', 'm'), null);
});

// Optional: run the id-addressed read against a genuine stored transcript.
//   DSH_VOICE_V_SESSION_FILE=C:\Users\...\.dsh\sessions\<project>\<id>\session.v4.jsonl.zstd
const realSessionFile = process.env.DSH_VOICE_V_SESSION_FILE;
if (realSessionFile !== undefined && realSessionFile !== '' && existsSync(realSessionFile)) {
  console.log('\nhost message lookup against a real stored transcript');

  await test(`reads every assistant message from ${realSessionFile}`, async () => {
    const { readAssistantMessageText } = await import('../lib/session-text.js');
    const events = readStoredSessionEvents(realSessionFile);
    assert.ok(events.length > 0, 'the stored log decoded to no events');
    const ctx = {
      get: (name) => (name === 'sessions' ? { get: () => ({ snapshotEvents: () => events }) } : undefined),
    };

    const assistantEvents = events.filter(
      (event) => event?.type === 'assistant/message' && event.surfaceOp === 'append',
    );
    assert.ok(assistantEvents.length > 0, 'the transcript has no append-origin assistant messages');

    for (const event of assistantEvents) {
      const message = event.data.message;
      const expected = message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (expected === '') continue;
      const actual = await readAssistantMessageText(ctx, 'any-session', message.id);
      assert.equal(actual, expected, `mismatch for message ${message.id}`);
      // Reasoning and tool-call blocks must never be narrated.
      for (const block of message.content) {
        if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 40) {
          assert.ok(!actual.includes(block.text), `reasoning leaked into message ${message.id}`);
        }
      }
    }
  });
} else {
  console.log(
    '\n(optional) set DSH_VOICE_V_SESSION_FILE=<session.v4.jsonl.zstd> to replay the lookup against a real transcript',
  );
}

// ---------------------------------------------------------------------------
// The Yandex provider
// ---------------------------------------------------------------------------
console.log('\nYandex provider');

const YANDEX_KEY = 'yandex-secret-key';

await test('the Yandex request carries the voice, the text and the key', () => {
  const request = yandexSpeechRequest({
    voice: 'ermil',
    text: 'Проверка Яндекса.',
    rate: '+6%',
    apiKey: YANDEX_KEY,
  });
  assert.ok(request.url.startsWith('https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis?'), request.url);
  assert.ok(request.url.includes('voice=ermil'), 'the voice travels in the query');
  assert.ok(request.url.includes('format=mp3'), 'the format travels in the query');
  assert.ok(request.url.includes('speed=1.06'), 'the tempo becomes a multiplier');
  assert.equal(request.headers.Authorization, `Api-Key ${YANDEX_KEY}`);
  assert.equal(request.headers['X-DataLoggin-Enabled'], 'false');
  // The v3 body: the text, the hints as an ARRAY and the wanted container.
  assert.deepEqual(request.body, {
    text: 'Проверка Яндекса.',
    hints: [{ voice: 'ermil', speed: 1.06 }],
    outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } },
  });
});

await test('the Yandex request without a tempo sends no speed at all', () => {
  const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', rate: '', apiKey: YANDEX_KEY });
  assert.ok(!request.url.includes('speed='), 'an unset tempo is not sent');
});

await test('an unknown Yandex voice falls back to the one that always exists', () => {
  const request = yandexSpeechRequest({ voice: 'nope', text: 'Тихо.', rate: '', apiKey: YANDEX_KEY });
  assert.ok(request.url.includes('voice=marina'), request.url);
});

await test('the audio is taken out of the Yandex envelope', () => {
  const audio = Buffer.from('yandex-audio');
  const bytes = yandexAudioBytes(JSON.stringify({ result: { audioChunk: { data: audio.toString('base64') } } }));
  assert.deepEqual(bytes, audio);
});

await test('a Yandex answer without audio is an error, not an empty file', () => {
  assert.throws(() => yandexAudioBytes('{"result":{}}'), /without audio/);
  assert.throws(() => yandexAudioBytes('not json at all'), /not JSON/);
});

await test('the Yandex provider synthesizes and caches the same way', async () => {
  const audio = Buffer.from('ID3yandex-audio'.padEnd(2048, '.'));
  const fetchImpl = recordingFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ result: { audioChunk: { data: audio.toString('base64') } } }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'yandex',
      yandexApiKey: YANDEX_KEY,
      yandexVoice: 'marina',
    }),
  });

  const result = await service.ensure('Проверка Яндекса.');
  assert.equal(fetchImpl.calls.length, 1, 'the service must be asked exactly once');
  assert.ok(existsSync(result.file), `missing cache file ${result.file}`);
  assert.deepEqual(await readFile(result.file), audio);

  const again = await service.ensure('Проверка Яндекса.');
  assert.equal(again.cached, true, 'the second call must be a cache hit');
  assert.equal(fetchImpl.calls.length, 1, 'a cache hit must not ask the service again');
});

await test('the Yandex provider without a key stays on the local CLI', async () => {
  const fetchImpl = recordingFetch(async () => {
    throw new Error('the service must not be asked');
  });
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsProvider: 'yandex',
      yandexApiKey: '',
      yandexVoice: 'marina',
    }),
  });
  const result = await service.ensure('Проверка локального пути.');
  assert.equal(fetchImpl.calls.length, 0, 'the service must not be asked without a key');
  assert.ok(existsSync(result.file), 'the local CLI must have written the file');
});

// ---------------------------------------------------------------------------
// The Yandex provider, the v3 route of the service
// ---------------------------------------------------------------------------
console.log('\nYandex provider (the v3 route of the service)');

const YANDEX_CHUNK_ONE = Buffer.from('chunk-one');
const YANDEX_CHUNK_TWO = Buffer.from('chunk-two');
const YANDEX_ONE_B64 = YANDEX_CHUNK_ONE.toString('base64');
const YANDEX_TWO_B64 = YANDEX_CHUNK_TWO.toString('base64');

/** The query of a request, read the way a server would read it. */
function queryOf(request) {
  return new URL(request.url).searchParams;
}

await test('the request speaks the utteranceSynthesis route of the service', () => {
  const request = yandexSpeechRequest({
    voice: 'ermil',
    text: 'Проверка Яндекса.',
    rate: '+6%',
    apiKey: YANDEX_KEY,
  });
  assert.ok(
    request.url.startsWith('https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis?'),
    request.url,
  );
  assert.ok(!request.url.includes('/tts/v3/voiceSynthesis'), 'the old v2 route must be gone');
  assert.equal(request.body.text, 'Проверка Яндекса.');
  assert.ok(Array.isArray(request.body.hints), 'the service rejects a hints object: it must be an array');
  assert.equal(request.body.hints.length, 1);
  assert.equal(request.body.hints[0].voice, 'ermil');
  assert.equal(request.body.outputAudioSpec.containerAudio.containerAudioType, 'MP3');
  assert.equal(request.headers.Authorization, `Api-Key ${YANDEX_KEY}`);
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.headers['X-DataLoggin-Enabled'], 'false');
});

await test('the tempo becomes a plain multiplier in the hints', () => {
  const cases = [
    ['+6%', 1.06],
    ['1.0', 1],
    ['-5%', 0.95],
  ];
  for (const [rate, speed] of cases) {
    const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', rate, apiKey: YANDEX_KEY });
    assert.equal(request.body.hints[0].speed, speed, `the speed of ${rate}`);
    assert.equal(queryOf(request).get('speed'), String(speed), `the query speed of ${rate}`);
  }
});

await test('the hint carries no speed when no tempo is configured', () => {
  const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', rate: '', apiKey: YANDEX_KEY });
  assert.deepEqual(request.body.hints[0], { voice: 'marina' });
  assert.equal(queryOf(request).get('speed'), null);
});

await test('the request keeps the query the older gateway understood', () => {
  const request = yandexSpeechRequest({ voice: 'pavel', text: 'Тихо.', rate: '+6%', apiKey: YANDEX_KEY });
  const query = queryOf(request);
  assert.equal(query.get('voice'), 'pavel');
  assert.equal(query.get('format'), 'mp3');
  assert.equal(query.get('sampleRate'), '48000');
  assert.equal(query.get('speed'), '1.06');
});

await test('the tone becomes a shift in hertz in the hints', () => {
  const cases = [
    ['+12Hz', 12],
    ['-8Hz', -8],
    ['0', 0],
  ];
  for (const [pitch, shift] of cases) {
    const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', pitch, apiKey: YANDEX_KEY });
    assert.equal(request.body.hints[0].pitchShift, shift, `the shift of ${pitch}`);
  }
});

await test('the tone leaves the hint alone when none is configured', () => {
  const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', pitch: '', apiKey: YANDEX_KEY });
  assert.equal(request.body.hints[0].pitchShift, undefined);
});

await test('the volume becomes a multiplier in the hints', () => {
  const cases = [
    ['+10%', 1.1],
    ['-20%', 0.8],
    ['+0%', 1],
  ];
  for (const [volume, multiplier] of cases) {
    const request = yandexSpeechRequest({ voice: 'marina', text: 'Тихо.', volume, apiKey: YANDEX_KEY });
    assert.equal(request.body.hints[0].volume, multiplier, `the volume of ${volume}`);
  }
});

await test('the tone and the volume are clamped into the service domain', () => {
  const request = yandexSpeechRequest({
    voice: 'marina',
    text: 'Тихо.',
    pitch: '+900Hz',
    volume: '+900%',
    apiKey: YANDEX_KEY,
  });
  assert.equal(request.body.hints[0].pitchShift, 40);
  assert.equal(request.body.hints[0].volume, 4);
});

await test('the folder of the key travels in the query, never in the body', () => {
  const request = yandexSpeechRequest({
    voice: 'marina',
    text: 'Тихо.',
    rate: '',
    apiKey: YANDEX_KEY,
    folderId: 'b1gtestfolder0000000000',
  });
  assert.equal(queryOf(request).get('folderId'), 'b1gtestfolder0000000000');
  assert.equal('folderId' in request.body, false, 'the folder is not a body field');
});

await test('one chunk of the v3 stream is read out of the envelope', () => {
  const bytes = yandexAudioBytes(JSON.stringify({ audioChunk: { data: YANDEX_ONE_B64 } }));
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length);
  assert.deepEqual(bytes, YANDEX_CHUNK_ONE);
});

await test('the older v2 envelope is read out too', () => {
  const bytes = yandexAudioBytes(JSON.stringify({ result: { audioChunk: { data: YANDEX_ONE_B64 } } }));
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length);
  assert.deepEqual(bytes, YANDEX_CHUNK_ONE);
});

await test('a stream that arrives as an array is concatenated in order', () => {
  const body = JSON.stringify([
    { audioChunk: { data: YANDEX_ONE_B64 } },
    { audioChunk: { data: YANDEX_TWO_B64 } },
  ]);
  const bytes = yandexAudioBytes(body);
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length + YANDEX_CHUNK_TWO.length);
  assert.deepEqual(bytes, Buffer.concat([YANDEX_CHUNK_ONE, YANDEX_CHUNK_TWO]));
});

await test('a stream that arrives as NDJSON is concatenated in order', () => {
  const body = `${JSON.stringify({ audioChunk: { data: YANDEX_ONE_B64 } })}\n${JSON.stringify({ audioChunk: { data: YANDEX_TWO_B64 } })}\n`;
  const bytes = yandexAudioBytes(body);
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length + YANDEX_CHUNK_TWO.length);
  assert.deepEqual(bytes, Buffer.concat([YANDEX_CHUNK_ONE, YANDEX_CHUNK_TWO]));
});

await test('a chunk that carries its type is read out', () => {
  const body = JSON.stringify({ audioChunk: { data: YANDEX_ONE_B64 }, chunkType: 'AUDIO' });
  const bytes = yandexAudioBytes(body);
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length);
  assert.deepEqual(bytes, YANDEX_CHUNK_ONE);
});

await test('the bytes of the AudioContent shape are read out as well', () => {
  const bytes = yandexAudioBytes(JSON.stringify({ result: { content: YANDEX_ONE_B64 } }));
  assert.equal(bytes.length, YANDEX_CHUNK_ONE.length);
  assert.deepEqual(bytes, YANDEX_CHUNK_ONE);
});

await test('an answer without audio is an error, not an empty file', () => {
  assert.throws(() => yandexAudioBytes('{"result":{}}'), /without audio/);
  assert.throws(() => yandexAudioBytes('{"audioChunk":{"data":""}}'), /without audio/);
  assert.throws(() => yandexAudioBytes('not json at all'), /not JSON/);
  assert.throws(() => yandexAudioBytes(''), /empty body/);
});

await test('the service sends the v3 body to the route of the service', async () => {
  const audio = Buffer.from('ID3yandex-v3'.padEnd(2048, '.'));
  const fetchImpl = recordingFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ audioChunk: { data: audio.toString('base64') } }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'yandex',
      yandexApiKey: YANDEX_KEY,
      yandexVoice: 'marina',
    }),
  });

  const result = await service.ensure('Проверка тела v3.');
  assert.equal(fetchImpl.calls.length, 1, 'the service must be asked exactly once');
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes('/tts/v3/utteranceSynthesis'), call.url);
  assert.ok(Array.isArray(call.body.hints), 'hints must be an array on the wire too');
  assert.equal(call.body.hints[0].voice, 'marina');
  assert.equal(call.body.hints[0].speed, 1.06);
  assert.equal(call.body.outputAudioSpec.containerAudio.containerAudioType, 'MP3');
  assert.equal(call.headers.Authorization, `Api-Key ${YANDEX_KEY}`);
  assert.deepEqual(await readFile(result.file), audio);
});

await test('a 403 answer says that the key has no rights on the folder', async () => {
  const fetchImpl = recordingFetch(async () => ({
    ok: false,
    status: 403,
    text: async () =>
      JSON.stringify({ code: 16, message: `PermissionDenied: key ${YANDEX_KEY} has no rights on the folder` }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsProvider: 'yandex',
      yandexApiKey: YANDEX_KEY,
      yandexVoice: 'marina',
    }),
  });

  await assert.rejects(
    () => service.ensure('Проверка прав на папку.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /не имеет прав на папку/, message);
      assert.match(message, /SpeechKit/, message);
      assert.ok(!message.includes(YANDEX_KEY), `the key must never reach an error message: ${message}`);
      return true;
    },
  );
});

await test('a 400 answer shows the message of the service itself', async () => {
  const fetchImpl = recordingFetch(async () => ({
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({
        code: 3,
        message: 'cannot unmarshal object into Go value of type []json.RawMessage',
      }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsProvider: 'yandex',
      yandexApiKey: YANDEX_KEY,
      yandexVoice: 'marina',
    }),
  });

  await assert.rejects(
    () => service.ensure('Проверка формы тела.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /cannot unmarshal object into Go value/, message);
      assert.ok(!message.includes(YANDEX_KEY), `the key must never reach an error message: ${message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
await test('the Google provider sends the v1 body to the documented route', async () => {
  const audio = Buffer.from('ID3google-v1'.padEnd(2048, '.'));
  const fetchImpl = recordingFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ audioContent: audio.toString('base64') }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+6%',
      pitch: '+12Hz',
      volume: '+0%',
      ttsProvider: 'google',
      googleApiKey: 'AIza-test-key',
      googleVoice: 'ru-RU-Wavenet-B',
    }),
  });

  const result = await service.ensure('Проверка тела Google.');
  assert.equal(fetchImpl.calls.length, 1, 'the service must be asked exactly once');
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes('/v1/text:synthesize'), call.url);
  assert.ok(call.url.includes('key=AIza-test-key'), 'the key rides in the query, as the service documents');
  assert.equal(call.body.input.text, 'Проверка тела Google.');
  assert.equal(call.body.voice.languageCode, 'ru-RU');
  assert.equal(call.body.voice.name, 'ru-RU-Wavenet-B');
  assert.equal(call.body.audioConfig.audioEncoding, 'MP3');
  assert.equal(call.body.audioConfig.speakingRate, 1.06);
  assert.deepEqual(await readFile(result.file), audio);
});

await test('a Google key failure names the key and the API, and never echoes the secret', async () => {
  const fetchImpl = recordingFetch(async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { message: 'Text-to-Speech API has not been used in project' } }),
  }));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsProvider: 'google',
      googleApiKey: 'AIza-secret',
      googleVoice: 'ru-RU-Wavenet-A',
    }),
  });

  await assert.rejects(
    () => service.ensure('Проверка ключа Google.'),
    (error) => {
      const message = String(error?.message ?? error);
      assert.match(message, /Text-to-Speech/, message);
      assert.ok(!message.includes('AIza-secret'), `the key must never reach an error message: ${message}`);
      return true;
    },
  );
});

await test('a Google answer without audio is an error, not silence', () => {
  assert.throws(() => googleAudioBytes(JSON.stringify({})), /without audio/);
  assert.throws(() => googleAudioBytes(''), /empty body/);
  assert.throws(() => googleAudioBytes('not json'), /not JSON/);
});

await test('the tone and the volume are read against the documented reference', () => {
  // +12 Hz on a nominal 200 Hz voice: 12 * log2(1 + 12/200) ≈ 1.01 semitones.
  assert.equal(googlePitchSemitones('+12Hz'), 1.01);
  assert.equal(googlePitchSemitones('+0Hz'), 0);
  assert.equal(googlePitchSemitones(''), null);
  // +10% of amplitude: 20 * log10(1.1) ≈ 0.83 dB.
  assert.equal(googleVolumeDb('+10%'), 0.83);
  assert.equal(googleVolumeDb('+0%'), 0);
  assert.equal(googleVolumeDb(''), null);
});

// ---------------------------------------------------------------------------
await test('the free Google route asks for small pieces, cut on word boundaries', () => {
  const long = 'слово '.repeat(60);
  const pieces = googleFreePieces(long);
  assert.ok(pieces.length > 1, 'a long text must be cut');
  for (const piece of pieces) {
    assert.ok(piece.length <= 200, `a piece must fit the route: ${piece.length}`);
    assert.ok(!piece.startsWith(' '), 'a piece must not start with a space');
  }
  assert.equal(
    pieces.join(' ').replace(/\s+/g, ' ').trim(),
    long.replace(/\s+/g, ' ').trim(),
    'the pieces must carry the whole text, in order',
  );
  assert.deepEqual(googleFreePieces(''), []);
  assert.deepEqual(googleFreePieces('    '), []);
});

await test('the free Google URL is the page route with the text in it', () => {
  const url = googleFreeUrl('Привет, Ви.');
  assert.ok(url.includes('translate.google.com/translate_tts'), url);
  assert.ok(url.includes('tl=ru'), url);
  assert.ok(url.includes('client=tw-ob'), url);
  assert.ok(url.includes('q=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82'), url);
});

await test('the free Google route speaks without a key', async () => {
  const audio = Buffer.from('ID3google-free'.padEnd(1024, '.'));
  const fetchImpl = recordingFetch(async () => audioAnswer(audio));
  const service = createSynthService({
    binPath: DEFAULT_EDGE_TTS_BIN,
    cacheDir: customCacheDir,
    timeoutMs: 10000,
    fetchImpl,
    voiceOptions: () => ({
      voice: 'ru-RU-SvetlanaNeural',
      rate: '+6%',
      pitch: '+0Hz',
      volume: '+0%',
      ttsProvider: 'google-free',
    }),
  });

  const result = await service.ensure('Проверка бесплатного гугла.');
  assert.equal(fetchImpl.calls.length, 1, 'the route must be asked exactly once for a short text');
  assert.ok(fetchImpl.calls[0].url.includes('tl=ru'));
  assert.deepEqual(await readFile(result.file), audio);
});

// ---------------------------------------------------------------------------
await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
await rm(customCacheDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
