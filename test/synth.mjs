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
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

import { DEFAULT_EDGE_TTS_BIN, DEFAULT_PRESETS, DEFAULT_VOICE, normalizePitch, normalizeRate, resolveVoiceConfig } from '../lib/config.js';
import { createVoiceHandler } from '../lib/index.js';
import { cacheKeyFor, createSynthService } from '../lib/synth.js';
import { cleanForSpeech, prepareForSpeech, splitIntoChunks } from '../lib/text.js';

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
  assert.match(cleaned, /всё работает\./);
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
await rm(cacheDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
