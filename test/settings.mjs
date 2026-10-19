#!/usr/bin/env node
/**
 * dsh-voice-v settings-surface tests.
 *
 * These cover the layer the settings card talks to: presets as data and their
 * resolution order, the pronunciation dictionary, the code/table switch, the
 * projection between the settings document and the plugin row's config, the
 * `/preview` contract, and `/speak` reading the live settings on every request.
 *
 * No port is bound and no settings document is written: the route tests drive
 * the handler with mock `req`/`res` objects, and synthesis runs through a fake
 * `edge-tts` spawn so the checks stay deterministic. `test/synth.mjs` keeps the
 * one real round trip.
 *
 * @module dsh-voice-v/test/settings
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  DEFAULT_AUTO_PRESET,
  DEFAULT_PRESETS,
  DEFAULT_PREVIEW_TEXT,
  DEFAULT_SPECTRUM,
  DEFAULT_STRIP_CODE,
  DEFAULT_VOICE,
  PITCH_RANGE,
  RATE_RANGE,
  SETTINGS_FIELDS,
  SETTINGS_NAMESPACE,
  SPECTRUM_VARIANTS,
  TTS_PROVIDERS,
  buildSettingsSchema,
  clampToRange,
  describePresets,
  describeVoices,
  normalizeTtsProvider,
  parsePitchHz,
  parseRatePct,
  pickSettingsBase,
  pickSettingsSection,
  resolvePreviewOptions,
  resolveVoiceConfig,
} from '../lib/config.js';
import {
  candidateAnchors,
  createLiveSettings,
  loadSchemaFactory,
  resetPeerCache,
  resolvePeerPackage,
} from '../lib/host-settings.js';
import { createVoiceHandler } from '../lib/index.js';
import { createSynthService } from '../lib/synth.js';
import { DEFAULT_PRONUNCIATION, cleanForSpeech, applyDictionary, splitMarkdownSegments } from '../lib/text.js';
import { TONE_PRIORITY, TONE_RULES, analyzeTone, detectTone } from '../lib/tone.js';

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
 * A fake `edge-tts` process: it writes the `--write-media` target and exits 0,
 * so the synthesis path (argv, cache slot, publish) is exercised without a real
 * process or the network. The payload records the rate and pitch it was asked
 * for, which is how the checks prove which settings reached the child.
 * @param _bin - Executable path, ignored.
 * @param argv - The argv the service built.
 * @returns An EventEmitter shaped like a ChildProcess.
 */
function fakeEdgeTts(_bin, argv) {
  const child = new EventEmitter();
  child.kill = () => {};
  const media = argv[argv.indexOf('--write-media') + 1];
  const rate = argv[argv.indexOf('--rate') + 1];
  const pitch = argv[argv.indexOf('--pitch') + 1];
  const voice = argv[argv.indexOf('--voice') + 1];
  setImmediate(() => {
    try {
      writeFileSync(media, Buffer.from(`ID3${voice}|${rate}|${pitch}`.padEnd(1200, '.')));
      child.emit('close', 0);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
}

const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-voice-v-settings-'));

/**
 * A synthesis service on the fake spawn, with a live voice provider.
 * @param provider - `() => { voice, rate, pitch }`.
 * @returns The service.
 */
function makeSynth(provider) {
  return createSynthService({
    binPath: 'edge-tts',
    cacheDir,
    voiceOptions: provider,
    timeoutMs: 10000,
    spawnImpl: fakeEdgeTts,
  });
}

// ---------------------------------------------------------------------------
console.log('dsh-voice-v settings tests\n');
console.log('presets and resolution order');

await test('all five shipped presets resolve their documented tempo and tone', () => {
  assert.deepEqual(Object.keys(DEFAULT_PRESETS), ['zhivoy', 'neytralnyy', 'spokoiny', 'derzkiy', 'ustaly']);
  const expected = {
    zhivoy: ['+6%', '+12Hz'],
    neytralnyy: ['+0%', '+0Hz'],
    spokoiny: ['-6%', '-8Hz'],
    derzkiy: ['+10%', '+6Hz'],
    ustaly: ['-12%', '-15Hz'],
  };
  for (const [id, pair] of Object.entries(expected)) {
    const settings = resolveVoiceConfig({ preset: id });
    assert.equal(settings.preset, id);
    assert.equal(settings.presetKnown, true);
    assert.equal(settings.rate, pair[0], `${id} rate`);
    assert.equal(settings.pitch, pair[1], `${id} pitch`);
    assert.equal(settings.rateOverridden, false);
    assert.equal(settings.pitchOverridden, false);
  }
});

await test('an explicit rate/pitch beats every preset', () => {
  for (const id of Object.keys(DEFAULT_PRESETS)) {
    const settings = resolveVoiceConfig({ preset: id, rate: '+33%', pitch: '-21Hz' });
    assert.equal(settings.rate, '+33%', `${id} rate`);
    assert.equal(settings.pitch, '-21Hz', `${id} pitch`);
    assert.equal(settings.rateOverridden, true);
    assert.equal(settings.pitchOverridden, true);
  }
});

await test('the built-in defaults answer when neither a preset nor an override is given', () => {
  const settings = resolveVoiceConfig({});
  assert.equal(settings.preset, 'zhivoy');
  assert.equal(settings.rate, '+6%');
  assert.equal(settings.pitch, '+12Hz');
  assert.equal(settings.voice, DEFAULT_VOICE);
  assert.equal(settings.stripCode, DEFAULT_STRIP_CODE);
});

await test('a deployment preset joins the table and is labelled by its id', () => {
  const settings = resolveVoiceConfig({ preset: 'moy', presets: { moy: { rate: '+2%', pitch: '+3Hz' } } });
  const rows = describePresets(settings);
  assert.equal(rows.length, 6);
  const mine = rows.find((row) => row.id === 'moy');
  assert.deepEqual(mine, { id: 'moy', label: 'moy', hint: '+2% / +3Hz', rate: '+2%', pitch: '+3Hz' });
  const zhivoy = rows.find((row) => row.id === 'zhivoy');
  assert.equal(zhivoy.label, 'Живой');
});

await test('the voice catalogue is data: two Russian voices and five multilingual ones', () => {
  const rows = describeVoices(resolveVoiceConfig({}));
  assert.equal(rows.length, 7, 'the catalogue holds the seven voices the service serves');
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      'ru-RU-SvetlanaNeural',
      'ru-RU-DmitryNeural',
      'en-US-AvaMultilingualNeural',
      'en-US-EmmaMultilingualNeural',
      'de-DE-SeraphinaMultilingualNeural',
      'fr-FR-VivienneMultilingualNeural',
      'pt-BR-ThalitaMultilingualNeural',
    ],
  );
  assert.equal(rows[0].group, 'Русские');
  assert.equal(rows[2].group, 'Мультиязычные');
  // The label keeps the id visible: the id is what goes to edge-tts.
  assert.equal(rows[0].label, 'Светлана · ru-RU-SvetlanaNeural');
  assert.equal(rows[1].label, 'Дмитрий · ru-RU-DmitryNeural');
  // A retired Russian voice is not offered at all.
  assert.equal(rows.some((row) => row.id === 'ru-RU-DariyaNeural'), false);
});

await test('a deployment extends the voice catalogue, replaces an entry, or replaces it all', () => {
  // Extend: a new id joins the catalogue, a known id keeps its own label.
  const extended = describeVoices(
    resolveVoiceConfig({ voices: ['de-DE-KatjaNeural', { id: 'en-US-JennyNeural', label: 'Дженни' }] }),
  );
  assert.equal(extended.length, 9);
  const katja = extended.find((row) => row.id === 'de-DE-KatjaNeural');
  assert.equal(katja.label, 'de-DE-KatjaNeural', 'a voice named by id alone is labelled by its id');
  assert.equal(katja.group, 'Другие', 'a voice that names no group lands in the catch-all group');
  const jenny = extended.find((row) => row.id === 'en-US-JennyNeural');
  assert.equal(jenny.label, 'Дженни');
  assert.equal(jenny.group, 'Другие');
  assert.equal(extended.find((row) => row.id === 'ru-RU-SvetlanaNeural').label, 'Светлана · ru-RU-SvetlanaNeural');

  // Replace one entry: the deployment's label wins, the rest of the table stays.
  const renamed = describeVoices(
    resolveVoiceConfig({ voices: [{ id: 'ru-RU-SvetlanaNeural', label: 'Света' }] }),
  );
  assert.equal(renamed.length, 7);
  assert.equal(renamed[0].label, 'Света');
  assert.equal(renamed[0].group, 'Русские');

  // Replace the catalogue: the shipped voices are gone.
  const replaced = describeVoices(resolveVoiceConfig({ voices: { replace: ['ru-RU-DmitryNeural'] } }));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].id, 'ru-RU-DmitryNeural');
});

await test('the user layer never owns the voice catalogue', () => {
  const settings = resolveVoiceConfig({});
  assert.equal(settings.voices, null, 'no deployment catalogue means no catalogue of its own');
  // The user may set any voice, catalogue or not: the field is a plain string.
  const own = resolveVoiceConfig({ voice: 'xx-XX-CustomNeural' });
  assert.equal(own.voice, 'xx-XX-CustomNeural');
  assert.equal(describeVoices(own).length, 7, 'the catalogue is the deployment one, not the user one');
});

await test('a user preset joins the pool, keeps its own name, and is marked as one', () => {
  const settings = resolveVoiceConfig({
    preset: 'user-moy',
    userPresets: { 'user-moy': { label: 'Мой пресет', rate: '+5%', pitch: '+2Hz' } },
  });
  assert.equal(settings.preset, 'user-moy');
  assert.equal(settings.presetKnown, true);
  assert.equal(settings.presets['user-moy'].rate, '+5%');
  assert.equal(settings.presets['user-moy'].pitch, '+2Hz');
  assert.equal(settings.userPresets['user-moy'].label, 'Мой пресет');

  const rows = describePresets(settings);
  assert.equal(rows.length, 6, 'the five shipped presets plus the user one');
  const own = rows.find((row) => row.id === 'user-moy');
  assert.equal(own.user, true, 'the card must be able to tell a user row from a shipped one');
  assert.equal(own.label, 'Мой пресет', 'the name the user gave the preset is its label');
  assert.equal(own.hint, '+5% / +2Hz');
  assert.equal(own.rate, '+5%');
  assert.equal(own.pitch, '+2Hz');
  // The shipped rows are untouched: they carry no `user` key at all.
  const zhivoy = rows.find((row) => row.id === 'zhivoy');
  assert.equal(zhivoy.label, 'Живой');
  assert.equal('user' in zhivoy, false);
});

await test('a user preset lends its voice, unless the user set one of their own', () => {
  const userPresets = { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz', voice: 'ru-RU-DariyaNeural' } };
  const inherited = resolveVoiceConfig({ preset: 'user-moy', userPresets });
  assert.equal(inherited.rate, '+5%');
  assert.equal(inherited.pitch, '+2Hz');
  assert.equal(inherited.rateOverridden, false);
  assert.equal(inherited.pitchOverridden, false);
  assert.equal(inherited.voice, 'ru-RU-DariyaNeural', 'the preset voice applies while none was set');
  assert.equal(inherited.voiceOverridden, false);

  const explicit = resolveVoiceConfig({ preset: 'user-moy', voice: 'ru-RU-DmitryNeural', userPresets });
  assert.equal(explicit.voice, 'ru-RU-DmitryNeural', 'an explicit voice still wins');
  assert.equal(explicit.voiceOverridden, true);

  // A preset that says nothing about the voice inherits the default one.
  const plain = resolveVoiceConfig({
    preset: 'user-moy',
    userPresets: { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } },
  });
  assert.equal(plain.voice, DEFAULT_VOICE);
  assert.equal(plain.voiceOverridden, false);

  // The row the card renders carries the voice, so the card can show it.
  const row = describePresets(inherited).find((entry) => entry.id === 'user-moy');
  assert.equal(row.voice, 'ru-RU-DariyaNeural');
});

await test('a user preset is not a schema default: without one the pool is the five shipped presets', () => {
  const settings = resolveVoiceConfig({});
  assert.deepEqual(Object.keys(settings.presets), ['zhivoy', 'neytralnyy', 'spokoiny', 'derzkiy', 'ustaly']);
  assert.deepEqual(Object.keys(settings.userPresets), []);
  const rows = describePresets(settings);
  assert.equal(rows.length, 5);
  assert.equal(rows.some((row) => row.user === true), false);
});

await test('a user preset wins over a deployment preset with the same id', () => {
  const settings = resolveVoiceConfig({
    presets: { moy: { rate: '+1%', pitch: '+1Hz' } },
    userPresets: { moy: { label: 'Мой', rate: '+9%', pitch: '+8Hz' } },
  });
  assert.equal(settings.presets.moy.rate, '+9%');
  assert.equal(settings.presets.moy.pitch, '+8Hz');
  const row = describePresets(settings).find((entry) => entry.id === 'moy');
  assert.equal(row.user, true);
  assert.equal(row.label, 'Мой');
});

await test('rate and pitch literals round-trip through their slider numbers', () => {
  assert.equal(parseRatePct('+6%'), 6);
  assert.equal(parseRatePct('-12%'), -12);
  assert.equal(parseRatePct('0'), 0);
  assert.equal(parseRatePct('нет'), null);
  assert.equal(parsePitchHz('+12Hz'), 12);
  assert.equal(parsePitchHz('-8hz'), -8);
  assert.equal(parsePitchHz('нет'), null);
  assert.equal(clampToRange(999, RATE_RANGE), 40);
  assert.equal(clampToRange(-999, PITCH_RANGE), -40);
  assert.equal(clampToRange('7', RATE_RANGE), 7);
  assert.equal(clampToRange(Number.NaN, PITCH_RANGE), -40);
});

await test('the slider domains are the documented ones', () => {
  assert.deepEqual(RATE_RANGE, { min: -30, max: 40, step: 1 });
  assert.deepEqual(PITCH_RANGE, { min: -40, max: 40, step: 1 });
});

console.log('\npronunciation dictionary');

await test('matching ignores case and respects word boundaries', () => {
  const cleaned = cleanForSpeech('RedScript настраивает tweakdb и TweakDB, а content не трогаем.');
  assert.match(cleaned, /редскрипт/);
  assert.match(cleaned, /твик-ди-би/);
  assert.doesNotMatch(cleaned, /твик-ди-би-ди-би/);
  assert.match(cleaned, /content/);
  assert.doesNotMatch(cleaned, /энт/);
});

await test('the longest term wins over a shorter one it contains', () => {
  const cleaned = applyDictionary('смотри .anims и anims дальше', DEFAULT_PRONUNCIATION);
  assert.equal(cleaned, 'смотри анимации и анимации дальше');
});

await test('a user entry overrides one built-in term and leaves the rest alone', () => {
  // The route always cleans with the dictionary `resolveVoiceConfig` merged, so
  // that is what this drives: the built-in terms survive underneath the entry.
  const merged = resolveVoiceConfig({ dictionary: { redscript: 'ред-скрипт' } }).dictionary;
  assert.equal(merged.redscript, 'ред-скрипт');
  assert.equal(merged.TweakDB, DEFAULT_PRONUNCIATION.TweakDB);
  const cleaned = cleanForSpeech('redscript и TweakDB', { dictionary: merged });
  assert.match(cleaned, /ред-скрипт/);
  assert.match(cleaned, /твик-ди-би/);
});

await test('a new term of the project vocabulary is rewritten and leaves no Latin', () => {
  const cleaned = cleanForSpeech('Модель DeepSeek отвечает на вопрос.', { dictionary: DEFAULT_PRONUNCIATION });
  assert.match(cleaned, /дипсик/);
  assert.doesNotMatch(cleaned, /DeepSeek/i);
});

await test('a dotted term survives the symbol cleaning', () => {
  const cleaned = cleanForSpeech('Запусти Node.js на Windows.', { dictionary: DEFAULT_PRONUNCIATION });
  assert.match(cleaned, /нод-джаваскрипт/);
  assert.doesNotMatch(cleaned, /Node\.js/i);
  assert.match(cleaned, /виндоуз/);
});

await test('the whole-word rule still holds with the larger dictionary', () => {
  const cleaned = cleanForSpeech('content не трогаем, а endpoints и releases остаются.', {
    dictionary: DEFAULT_PRONUNCIATION,
  });
  assert.match(cleaned, /content/);
  assert.doesNotMatch(cleaned, /энт/);
  assert.match(cleaned, /endpoints/);
  assert.match(cleaned, /releases/);
  assert.doesNotMatch(cleaned, /эндпоинт/);
  assert.doesNotMatch(cleaned, /релиз/);
});

await test('a longer key still wins over the shorter one nested in it', () => {
  // `Node` and `TTS` are whole words inside `Node.js` and `edge-tts`, so only
  // the longest-first order keeps them from being rewritten on their own.
  const cleaned = applyDictionary('Node.js, edge-tts и GitHub', DEFAULT_PRONUNCIATION);
  assert.equal(cleaned, 'нод-джаваскрипт, эдж-ти-ти-эс и гитхаб');
});

await test('the harness words are read the way a Russian speaker says them', () => {
  // These Latin spellings are read differently every time by a Russian voice
  // ("commit" becomes "комит"), so the dictionary pins the reading.
  const expected = {
    bundle: 'бандл',
    plugin: 'плагин',
    patch: 'патч',
    commit: 'коммит',
    prompt: 'промпт',
    token: 'токен',
    log: 'лог',
    lint: 'линт',
    mock: 'мок',
    stub: 'стаб',
    chunk: 'чанк',
    seed: 'сид',
    fork: 'форк',
    tool: 'тул',
    agent: 'агент',
    assistant: 'ассистент',
    chatbot: 'чат-бот',
  };
  for (const [term, spoken] of Object.entries(expected)) {
    assert.equal(DEFAULT_PRONUNCIATION[term], spoken, `the reading of "${term}" must be pinned`);
    const cleaned = applyDictionary(`Слово ${term} в тексте.`, DEFAULT_PRONUNCIATION);
    assert.ok(cleaned.includes(spoken), `"${term}" must be read as "${spoken}"; got: ${cleaned}`);
    assert.doesNotMatch(cleaned, new RegExp(term, 'i'), `"${term}" must not survive in the spoken text`);
  }
});

await test('the dictionary reaches the prose around a stripped code block', () => {
  const source = [
    'DeepSeek отвечает.',
    '```js',
    'const model = "DeepSeek";',
    '```',
    'Запущено на Node.js.',
  ].join('\n');
  const cleaned = cleanForSpeech(source, { stripCode: true, dictionary: DEFAULT_PRONUNCIATION });
  assert.match(cleaned, /блок кода, 1 строка/);
  assert.match(cleaned, /дипсик/);
  assert.match(cleaned, /нод-джаваскрипт/);
  assert.doesNotMatch(cleaned, /DeepSeek/i);
  assert.doesNotMatch(cleaned, /model/);
});

console.log('\ncode and table switch');

const CODE_AND_TABLE = [
  'Итог:',
  '```js',
  'const a = 1;',
  'console.log(a);',
  '```',
  '| Файл | Размер |',
  '| --- | ---: |',
  '| a.js | 12 |',
  '| b.js | 34 |',
  'Конец.',
].join('\n');

await test('stripCode on: code and tables become counted placeholders', () => {
  const cleaned = cleanForSpeech(CODE_AND_TABLE, { stripCode: true });
  assert.match(cleaned, /блок кода, 2 строки/);
  // The count is every line of the table except the alignment separator.
  assert.match(cleaned, /таблица, 3 строки/);
  assert.doesNotMatch(cleaned, /console\.log/);
  assert.doesNotMatch(cleaned, /a\.js/);
  assert.match(cleaned, /Итог:/);
  assert.match(cleaned, /Конец\./);
});

await test('stripCode on: the count agrees with the block it replaces', () => {
  const one = cleanForSpeech('```\nconst a = 1;\n```', { stripCode: true });
  assert.match(one, /блок кода, 1 строка/);
  const five = cleanForSpeech('```\n1\n2\n3\n4\n5\n```', { stripCode: true });
  assert.match(five, /блок кода, 5 строк/);
  const table = cleanForSpeech('| a |\n| --- |\n| 1 |\n| 2 |\n| 3 |\n| 4 |\n| 5 |', { stripCode: true });
  assert.match(table, /таблица, 6 строк/);
});

await test('stripCode off: the code text is read, minimally cleaned', () => {
  const cleaned = cleanForSpeech(CODE_AND_TABLE, { stripCode: false });
  assert.match(cleaned, /const a = 1/);
  assert.match(cleaned, /console\.log/);
  assert.doesNotMatch(cleaned, /блок кода/);
  assert.doesNotMatch(cleaned, /`/);
});

await test('stripCode off: table rows are read as their cells', () => {
  const cleaned = cleanForSpeech(CODE_AND_TABLE, { stripCode: false });
  assert.doesNotMatch(cleaned, /\|/);
  assert.doesNotMatch(cleaned, /таблица/);
  assert.match(cleaned, /Файл, Размер/);
  assert.match(cleaned, /a\.js, 12/);
});

await test('segmentation keeps fences and tables in one piece each', () => {
  const segments = splitMarkdownSegments(CODE_AND_TABLE);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['text', 'code', 'table', 'text'],
  );
  assert.equal(segments[1].lines, 2);
  assert.equal(segments[2].dataRows, 3);
});

await test('an unterminated fence still becomes one code segment', () => {
  const segments = splitMarkdownSegments('до\n```\nconst a = 1;');
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['text', 'code'],
  );
});

console.log('\nsettings document projection');

await test('the composition base carries only the namespace fields', () => {
  const base = pickSettingsBase({
    preset: 'derzkiy',
    rate: 10,
    voice: 'ru-RU-DariyaNeural',
    stripCode: false,
    dictionary: { redscript: 'ред скрипт', '': 'skip', bad: 5 },
    binPath: '/somewhere/edge-tts',
    cacheDir: 'C:/cache',
    maxChunkChars: 111,
    presets: { moy: { rate: '+1%' } },
    timeoutMs: 5000,
  });
  assert.deepEqual(base, {
    preset: 'derzkiy',
    rate: '+10%',
    voice: 'ru-RU-DariyaNeural',
    stripCode: false,
    dictionary: { redscript: 'ред скрипт' },
  });
  assert.equal('binPath' in base, false);
  assert.equal('presets' in base, false);
});

await test('the user section may only shadow the fields the namespace owns', () => {
  const picked = pickSettingsSection({
    preset: 'ustaly',
    rate: '-12%',
    dictionary: { DSH: 'ди-эс-эйч' },
    userPresets: { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } },
    binPath: '/tmp/evil',
    timeoutMs: 1,
    cacheDir: 'C:/evil',
  });
  assert.deepEqual(picked, {
    preset: 'ustaly',
    rate: '-12%',
    dictionary: { DSH: 'ди-эс-эйч' },
    userPresets: { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } },
  });
  assert.deepEqual(pickSettingsSection(null), {});
  assert.deepEqual(SETTINGS_FIELDS, [
    'preset',
    'rate',
    'pitch',
    'voice',
    'stripCode',
    'autoPreset',
    'dictionary',
    'userPresets',
    'spectrum',
    'ttsProvider',
    'customBaseUrl',
    'customApiKey',
    'customModel',
  ]);
});

await test('preview options use the body, then the preset, then the defaults', () => {
  const explicit = resolvePreviewOptions({ rate: '+20%', pitch: '-8Hz' });
  assert.equal(explicit.rate, '+20%');
  assert.equal(explicit.pitch, '-8Hz');

  const fromPreset = resolvePreviewOptions({ preset: 'ustaly' });
  assert.equal(fromPreset.rate, '-12%');
  assert.equal(fromPreset.pitch, '-15Hz');

  const fromNumbers = resolvePreviewOptions({ rate: 12, pitch: 5 });
  assert.equal(fromNumbers.rate, '+12%');
  assert.equal(fromNumbers.pitch, '+5Hz');

  const fallback = resolvePreviewOptions({ preset: 'нет-такого' });
  assert.equal(fallback.rate, '+6%');
  assert.equal(fallback.pitch, '+12Hz');

  const clamped = resolvePreviewOptions({ rate: 999, pitch: -999 });
  assert.equal(clamped.rate, '+40%');
  assert.equal(clamped.pitch, '-40Hz');
});

await test('the settings schema declares exactly the namespace fields', async () => {
  const loaded = loadSchemaFactory();
  if (typeof loaded.z?.object !== 'function') {
    // No resolvable schemastery in this deployment: the graceful path is the
    // only one available, and `createLiveSettings` is checked for it below.
    assert.ok(true);
    return;
  }
  const schema = buildSettingsSchema(loaded.z);
  const json = schema.toJSON();
  const declared = Object.keys(json.refs[json.uid].dict).sort();
  assert.deepEqual(declared, [...SETTINGS_FIELDS].sort());
  // `dsh-settings`' `volatileForm` keeps only the volatile children. A plain
  // field would therefore not merely hide itself — it would drop the whole
  // entry from the form, and the card would never mount.
  for (const field of SETTINGS_FIELDS) {
    assert.equal(schema.dict[field]?.meta?.volatile, true, `${field} must be volatile`);
  }
  const resolved = schema({ dictionary: { redscript: 'ред скрипт' } });
  assert.equal(resolved.preset, 'zhivoy');
  assert.equal(resolved.stripCode, true);
  assert.equal('rate' in resolved, false, 'an unset rate must stay absent so the preset answers');
  assert.deepEqual(resolved.dictionary, { redscript: 'ред скрипт' });
});

/**
 * A stand-in for the schemastery namespace: it records what the schema asks
 * for, so the shape of a field can be checked in a deployment where no
 * volatile-capable schemastery resolves at all.
 * @param options - `withoutConst` drops `z.const`, so the field that uses it
 *   has to fall back to a plain string.
 * @returns The fake namespace.
 */
function fakeSchemaFactory(options = {}) {
  const make = (type, extra) => {
    const schema = { type, meta: {}, ...extra };
    schema.default = (value) => {
      schema.meta.default = value;
      return schema;
    };
    schema.loose = (value) => {
      schema.meta.loose = value;
      return schema;
    };
    schema.description = (value) => {
      schema.meta.description = value;
      return schema;
    };
    schema.volatile = () => {
      schema.meta.volatile = true;
      return schema;
    };
    return schema;
  };
  const factory = {
    string: () => make('string'),
    number: () => make('number'),
    boolean: () => make('boolean'),
    any: () => make('any'),
    union: (list) => make('union', { list }),
    dict: (inner) => make('dict', { inner }),
    object: (dict) => make('object', { dict }),
  };
  // `z.const` is what the provider field's allow-list is built from. A copy
  // without it must not break the namespace.
  if (options.withoutConst !== true) factory.const = (value) => make('const', { value });
  return factory;
}

await test('the settings schema declares a volatile user-preset pool', () => {
  const schema = buildSettingsSchema(fakeSchemaFactory());
  const field = schema.dict.userPresets;
  assert.ok(field !== undefined, 'the schema must declare the user preset pool');
  // `volatileForm` keeps only the volatile children: a plain field would drop
  // the whole entry from the form, and the card would never mount.
  assert.equal(field.meta.volatile, true, 'the pool must be volatile so the Host accepts a write');
  assert.equal(field.type, 'dict', 'the pool is a record of presets');
  assert.equal(field.inner.type, 'object', 'one preset is an object');
  assert.deepEqual(Object.keys(field.inner.dict).sort(), ['label', 'pitch', 'rate', 'voice']);
  for (const name of SETTINGS_FIELDS) {
    assert.equal(schema.dict[name].meta.volatile, true, `${name} must be volatile`);
  }
});

await test('the settings schema accepts a user preset and the live reader sees it', () => {
  const harness = makeVolatileHarness();
  if (harness === null) {
    // No volatile-capable schemastery in this deployment: the graceful path is
    // the only one available, and the shape itself is checked above.
    assert.ok(true);
    return;
  }
  const { config, write } = harness;
  const loaded = loadSchemaFactory();
  const schema = buildSettingsSchema(loaded.z);
  const parsed = schema({ userPresets: { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } } });
  assert.deepEqual(parsed.userPresets, { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } });

  // The Loader commits a save into the reference, and the live reader sees it.
  write('userPresets', { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } });
  const live = createLiveSettings({}, config);
  assert.equal(live().userPresets['user-moy'].label, 'Мой');
  assert.equal(live().presets['user-moy'].rate, '+5%');
  assert.equal(live().presets['user-moy'].pitch, '+2Hz');
});

console.log('\ncustom TTS endpoint (the settings surface)');

await test('the schema declares the custom endpoint as four volatile fields', () => {
  const schema = buildSettingsSchema(fakeSchemaFactory());

  const provider = schema.dict.ttsProvider;
  assert.ok(provider !== undefined, 'the provider must be declared');
  // `volatileForm` keeps only the volatile children: a plain field would drop
  // the whole entry from the form, and the card would never mount.
  assert.equal(provider.meta.volatile, true, 'the provider must be volatile so the Host accepts a write');
  assert.equal(provider.meta.default, 'edge', 'edge-tts is the default provider');
  assert.equal(provider.meta.loose, true, 'an unknown provider must fall back, not fail the whole entry');
  assert.equal(provider.type, 'union');
  assert.deepEqual(
    provider.list.map((entry) => entry.value),
    ['edge', 'custom'],
  );

  for (const field of ['customBaseUrl', 'customApiKey', 'customModel']) {
    const declared = schema.dict[field];
    assert.ok(declared !== undefined, `${field} must be declared`);
    assert.equal(declared.meta.volatile, true, `${field} must be volatile`);
    assert.equal(declared.type, 'string');
  }

  // The real schemastery, when this deployment can resolve one.
  const loaded = loadSchemaFactory();
  if (typeof loaded.z?.object === 'function') {
    const real = buildSettingsSchema(loaded.z);
    assert.equal(real.dict.ttsProvider.meta.volatile, true);
    assert.equal(real.dict.ttsProvider.meta.default, 'edge');
    for (const field of ['customBaseUrl', 'customApiKey', 'customModel']) {
      assert.equal(real.dict[field].meta.volatile, true, `${field} must be volatile`);
    }
  }
});

await test('a schemastery copy without z.const degrades the provider field to a plain string', () => {
  // The runtime's schemastery is 3.18.x: it has `z.const` and `z.union`, and
  // no `z.literal`. A copy without them must not break the namespace — the
  // field falls back to a plain string, and the allow-list stays in
  // `normalizeTtsProvider`.
  const schema = buildSettingsSchema(fakeSchemaFactory({ withoutConst: true }));
  const provider = schema.dict.ttsProvider;
  assert.ok(provider !== undefined, 'the provider must still be declared');
  assert.equal(provider.type, 'string', 'without z.const the field is a plain string');
  assert.equal(provider.meta.volatile, true, 'and it is still volatile');
  assert.equal(provider.meta.default, 'edge', 'and it still defaults to edge-tts');
  assert.equal(normalizeTtsProvider('nope'), 'edge', 'the allow-list lives in the resolver');
});

await test('the schemastery the runtime resolves has the constructs the provider field uses', () => {
  const path = resolvePeerPackage('@deepseek-ai/schemastery', candidateAnchors());
  if (path === null) {
    // No peer package in this deployment: the graceful path is the only one
    // available, and the shape itself is checked above.
    assert.ok(true);
    return;
  }
  const z = createRequire(import.meta.url)(path);
  assert.equal(typeof z.const, 'function', 'z.const must exist: the allow-list is built from it');
  assert.equal(typeof z.union, 'function', 'z.union must exist: the allow-list is a union');
});

await test('an unknown provider falls back to edge-tts', () => {
  assert.equal(normalizeTtsProvider(undefined), 'edge');
  assert.equal(normalizeTtsProvider(''), 'edge');
  assert.equal(normalizeTtsProvider('нope'), 'edge');
  assert.equal(normalizeTtsProvider('CUSTOM-SOMETHING'), 'edge');
  assert.equal(normalizeTtsProvider('custom'), 'custom');
  assert.equal(normalizeTtsProvider(' edge '), 'edge');

  assert.equal(resolveVoiceConfig({}).ttsProvider, 'edge');
  assert.equal(resolveVoiceConfig({ ttsProvider: 'нет-такого' }).ttsProvider, 'edge');
  assert.equal(resolveVoiceConfig({ ttsProvider: 'custom' }).ttsProvider, 'custom');

  // The composition layer carries the field, and the user layer may shadow it.
  const base = pickSettingsBase({
    ttsProvider: 'custom',
    customBaseUrl: 'https://api.openai.com/v1',
    customApiKey: 'sk-secret',
    customModel: 'tts-1',
    binPath: '/nowhere',
  });
  assert.equal(base.ttsProvider, 'custom');
  assert.equal(base.customBaseUrl, 'https://api.openai.com/v1');
  assert.equal(base.customModel, 'tts-1');
  assert.equal('binPath' in base, false);
  assert.equal(pickSettingsSection({ ttsProvider: 'edge' }).ttsProvider, 'edge');
});

await test('the key never leaves the host: the config payload reports only whether one is set', async () => {
  const settings = resolveVoiceConfig({
    ttsProvider: 'custom',
    customBaseUrl: 'https://api.openai.com/v1',
    customApiKey: 'sk-super-secret-value',
    customModel: 'tts-1',
  });
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    settings,
    synth: makeSynth(() => ({ voice: 'alloy', rate: '+6%', pitch: '+12Hz', volume: '+0%' })),
  });

  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ttsProvider, 'custom');
  assert.equal(payload.customBaseUrl, 'https://api.openai.com/v1');
  assert.equal(payload.customModel, 'tts-1');
  assert.equal(payload.customApiKeySet, true, 'the payload says that a key is set');
  assert.equal('customApiKey' in payload, false, 'the key itself is not in the payload');
  const raw = res.collected().toString('utf8');
  assert.equal(raw.includes('sk-super-secret-value'), false, 'the key must not appear in the payload at all');

  // And the same for the health route.
  const health = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/health' });
  assert.equal(health.collected().toString('utf8').includes('sk-super-secret-value'), false);

  // A namespace without a key says so.
  const plain = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    settings: resolveVoiceConfig({}),
    synth: makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' })),
  });
  const plainRes = await callRoute(plain, { method: 'GET', url: '/dsh-voice-v/config' });
  assert.equal(plainRes.json().customApiKeySet, false);
});

await test('the custom provider travels with the per-request override', async () => {
  const synth = toneRecordingSynth();
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () =>
      resolveVoiceConfig({
        ttsProvider: 'custom',
        customBaseUrl: 'https://api.openai.com/v1',
        customApiKey: 'sk-super-secret-value',
        customModel: 'tts-1',
      }),
    synth,
  });

  const res = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала.')}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().ttsProvider, 'custom');
  assert.equal(synth.calls[0].override.ttsProvider, 'custom');
  assert.equal(synth.calls[0].override.customBaseUrl, 'https://api.openai.com/v1');
  assert.equal(synth.calls[0].override.customModel, 'tts-1');
  assert.equal(synth.calls[0].override.customApiKey, 'sk-super-secret-value');
});

await test('the edge-tts override is left exactly as it was', async () => {
  const synth = toneRecordingSynth();
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ preset: 'ustaly' }),
    synth,
  });

  await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала.')}`,
  });
  assert.deepEqual(Object.keys(synth.calls[0].override).sort(), ['pitch', 'rate', 'voice', 'volume']);
});

console.log('\nlive settings');

/**
 * Build a plugin row config the way the Loader hands it to the fiber: the six
 * card-owned fields are `cosmokit` references — the Loader commits a save into
 * them in place, so the next sentence reads the new value without a remount —
 * and the deployment keys sit beside them as plain values.
 * @returns `{ config, write }`, or null when no volatile-capable schemastery
 *   resolves in this deployment.
 */
function makeVolatileHarness() {
  const loaded = loadSchemaFactory();
  if (typeof loaded.z?.object !== 'function') return null;
  const schema = buildSettingsSchema(loaded.z);
  const config = schema({});
  const write = (field, value) => {
    const ref = config[field];
    if (ref === undefined || typeof ref.get !== 'function') {
      throw new Error(`field ${field} is not a volatile reference`);
    }
    ref[Symbol.for('cosmokit.volatile.write')](value);
  };
  return { config, write };
}

await test('the live reader reads the volatile fields the Loader committed', async () => {
  const harness = makeVolatileHarness();
  if (harness === null) {
    assert.ok(true);
    return;
  }
  const { config, write } = harness;
  const live = createLiveSettings({}, config);
  assert.equal(live.settingsRegistered(), true);
  assert.equal(live().rate, '+0%', 'the built-in default answers first');
  assert.equal(live().pitch, '+0Hz');
  assert.equal(live().stripCode, true);

  write('rate', '-20%');
  assert.equal(live().rate, '-20%', 'a committed write is visible on the next read');
  assert.equal(live().pitch, '+0Hz', 'the untouched pitch still follows the preset');

  write('rate', undefined);
  write('preset', 'ustaly');
  assert.equal(live().rate, '-12%', 'a cleared field falls back to the preset');
  assert.equal(live().pitch, '-15Hz');

  write('preset', 'derzkiy');
  write('rate', '-20%');
  write('pitch', '+30Hz');
  assert.equal(live().rate, '-20%');
  assert.equal(live().pitch, '+30Hz');

  write('stripCode', false);
  assert.equal(live().stripCode, false);

  write('spectrum', 'wave');
  assert.equal(live().spectrum, 'wave', 'the committed variant is visible on the next read');

  write('dictionary', { redscript: 'ред скрипт' });
  assert.equal(live().dictionary.redscript, 'ред скрипт');
  assert.equal(live().dictionary.TweakDB, 'твик-ди-би');
});

await test('a deployment key is read as it is, and the card never owns it', async () => {
  const harness = makeVolatileHarness();
  if (harness === null) {
    assert.ok(true);
    return;
  }
  const { config } = harness;
  config.binPath = 'C:/real/edge-tts';
  config.cacheDir = 'C:/cache';
  config.timeoutMs = 1234;
  const live = createLiveSettings({}, config);
  assert.equal(live().binPath, 'C:/real/edge-tts');
  assert.equal(live().cacheDir, 'C:/cache');
  assert.equal(live().timeoutMs, 1234);
  assert.equal(SETTINGS_FIELDS.includes('binPath'), false, 'a deployment key is not a card field');
  assert.equal(SETTINGS_FIELDS.includes('cacheDir'), false);
  assert.equal(SETTINGS_FIELDS.includes('timeoutMs'), false);
});

await test('the namespace is served only under the row id it declares', async () => {
  const harness = makeVolatileHarness();
  if (harness === null) {
    assert.ok(true);
    return;
  }
  const { config } = harness;
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  const right = createLiveSettings({ fiber: { entry: { options: { id: SETTINGS_NAMESPACE } } } }, config, { logger });
  assert.equal(right.settingsRegistered(), true);
  assert.equal(warnings.length, 0, 'the right row id warns about nothing');

  // A row the Host keys under another id does not serve this namespace.
  const wrong = createLiveSettings({ fiber: { entry: { options: { id: 'voice-v' } } } }, config, { logger });
  assert.equal(wrong.settingsRegistered(), false, 'a row under another id does not serve the namespace');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dsh-voice-v/);
});

await test('a nested row is judged by the id the Host keys the namespace by', async () => {
  const harness = makeVolatileHarness();
  if (harness === null) {
    assert.ok(true);
    return;
  }
  const { config } = harness;
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  // Every profile row lives in the root include entry's subtree, so the
  // loader's `entry.id` is the composed path (`include:dsh-voice-v`) while the
  // Host keys the settings namespace by `entry.options.id` — the raw row id.
  // Reading the composed path would report a mismatch for a row the Host does
  // serve, so the raw id is the one that counts.
  const nested = createLiveSettings(
    { fiber: { entry: { id: 'include:' + SETTINGS_NAMESPACE, options: { id: SETTINGS_NAMESPACE } } } },
    config,
    { logger },
  );
  assert.equal(nested.settingsRegistered(), true, 'a nested row still serves its own namespace');
  assert.equal(warnings.length, 0, 'a nested row warns about nothing');
});

await test('the schema loader resolves through the DSH home or reports what is missing', async () => {
  const anchors = candidateAnchors();
  assert.ok(anchors.length > 0);
  assert.ok(anchors.every((anchor) => anchor.endsWith('x.js')));
  const loaded = loadSchemaFactory();
  if (loaded.missing !== undefined) {
    assert.ok(loaded.missing.length > 0);
    assert.ok(Array.isArray(loaded.reasons));
    return;
  }
  assert.equal(typeof loaded.z.object, 'function');
  assert.equal(
    typeof loaded.z.string().volatile,
    'function',
    'the resolved copy must be able to mark fields volatile',
  );
  assert.equal(resolvePeerPackage('@deepseek-ai/definitely-not-a-package', candidateAnchors()), null);
});

await test('a copy of schemastery that cannot mark fields volatile is rejected, not used', async () => {
  // A resolvable-but-wrong copy must not be accepted: without `volatile()` the
  // Loader would commit a card write as an ordinary restart, and
  // `dsh-settings` would describe no form at all.
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-v-schema-'));
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'schemastery');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0', main: './index.cjs' }),
  );
  await writeFile(
    join(packageDir, 'index.cjs'),
    [
      'function FakeSchema() {}',
      'const plain = () => ({});',
      'FakeSchema.object = plain;',
      'FakeSchema.string = plain;',
      'FakeSchema.dict = plain;',
      'FakeSchema.any = plain;',
      'FakeSchema.union = plain;',
      'module.exports = FakeSchema;',
    ].join('\n'),
  );
  const anchor = join(root, 'x.js');
  await writeFile(anchor, '');

  const resolvedWrong = resolvePeerPackage('@deepseek-ai/schemastery', [anchor]);
  assert.notEqual(resolvedWrong, null, 'the fixture must be resolvable, or the test proves nothing');

  resetPeerCache();
  const rejected = loadSchemaFactory({ anchors: [anchor] });
  assert.equal(rejected.z, undefined, 'a copy without volatile() must not be accepted');
  assert.deepEqual(rejected.missing, ['@deepseek-ai/schemastery']);
  assert.match(rejected.reasons.join(' '), /cannot mark fields volatile/);

  // Whatever this deployment offers, the real anchors must not be poisoned by
  // the rejected copy above.
  resetPeerCache();
  const real = loadSchemaFactory();
  assert.notEqual(real.path, resolvedWrong);

  await rm(root, { recursive: true, force: true });
});

await test('a copy that can mark fields volatile is accepted', async () => {
  // The mirror of the rejection above: the profile's own interception layer may
  // hold an older schemastery, and the host's installation a newer one. The
  // probe must take the copy that can actually mark fields volatile.
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-v-volatile-'));
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'schemastery');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '3.18.5', main: './index.cjs' }),
  );
  await writeFile(
    join(packageDir, 'index.cjs'),
    [
      'function FakeSchema() {}',
      'const plain = () => {',
      '  const node = {};',
      '  node.volatile = function volatile() { return node; };',
      '  return node;',
      '};',
      'FakeSchema.object = plain;',
      'FakeSchema.string = plain;',
      'FakeSchema.number = plain;',
      'FakeSchema.dict = plain;',
      'FakeSchema.any = plain;',
      'FakeSchema.union = plain;',
      'module.exports = FakeSchema;',
    ].join('\n'),
  );
  const anchor = join(root, 'x.js');
  await writeFile(anchor, '');

  resetPeerCache();
  const loaded = loadSchemaFactory({ anchors: [anchor] });
  assert.equal(loaded.missing, undefined, 'a volatile-capable copy must be accepted');
  assert.equal(typeof loaded.z.string().volatile, 'function');

  resetPeerCache();
  await rm(root, { recursive: true, force: true });
});

await test('the anchor set reaches the running host\'s own installation', () => {
  // A plugin installed as a `link:` lives outside the profile, so nothing
  // beside it can see the installation's `node_modules`. The host's own entry
  // script can, and that copy is the one the running tree was built against.
  const original = process.argv[1];
  try {
    process.argv[1] = join('C:', 'host-install', 'bin', 'cli.js');
    const anchors = candidateAnchors();
    assert.ok(
      anchors.includes(join('C:', 'host-install', 'bin', 'x.js')),
      'the running host\'s entry script must contribute an anchor',
    );
  } finally {
    process.argv[1] = original;
  }
});

console.log('\nsynthesis with live settings');

await test('the synth service reads its voice through the provider on every call', async () => {
  let current = { voice: 'voice-a', rate: '+1%', pitch: '+1Hz', volume: '+0%' };
  const synth = makeSynth(() => current);
  const first = await synth.ensure('Проверка живых настроек.');
  assert.equal(first.voice.voice, 'voice-a');
  assert.equal(first.voice.rate, '+1%');

  current = { voice: 'voice-b', rate: '+25%', pitch: '-10Hz', volume: '+0%' };
  const second = await synth.ensure('Проверка живых настроек.');
  assert.equal(second.voice.voice, 'voice-b');
  assert.equal(second.voice.rate, '+25%');
  assert.notEqual(first.key, second.key, 'a changed setting must land in its own cache slot');
  const body = await readFile(second.file, 'utf8');
  assert.match(body, /voice-b\|\+25%\|-10Hz/);
});

await test('a per-call override beats the provider, which is how preview works', async () => {
  const synth = makeSynth(() => ({ voice: 'voice-a', rate: '+1%', pitch: '+1Hz', volume: '+0%' }));
  const plain = await synth.ensure('Один и тот же текст.');
  const overridden = await synth.ensure('Один и тот же текст.', { voice: 'voice-z', rate: '+30%', pitch: '+20Hz' });
  assert.equal(overridden.voice.voice, 'voice-z');
  assert.notEqual(plain.key, overridden.key);
  assert.match(await readFile(overridden.file, 'utf8'), /voice-z\|\+30%\|\+20Hz/);
  // The override is per call: the provider still answers the next one.
  assert.equal(synth.voiceOptions.voice, 'voice-a');
  assert.equal(synth.keyFor('x'), synth.cacheKeyFor({ text: 'x', ...synth.voiceOptions }));
});

console.log('\n/preview contract');

/** A recording synthesis service, so the route contract is checked in isolation. */
function recordingSynth() {
  const calls = [];
  return {
    calls,
    cacheDir,
    counters: { launched: 0, served: 0, failed: 0 },
    async ensure(text, override) {
      calls.push({ text, override });
      const key = createHash('sha256').update(`${text}\u0000${JSON.stringify(override ?? null)}`).digest('hex');
      const file = join(cacheDir, `${key}.mp3`);
      await writeFile(file, Buffer.alloc(1200, 7));
      return { key, file, bytes: 1200, cached: false, voice: override ?? {} };
    },
    async cached(text, override) {
      return { key: createHash('sha256').update(`${text}\u0000${JSON.stringify(override ?? null)}`).digest('hex'), cached: false };
    },
    pathFor(key) {
      return join(cacheDir, `${key}.mp3`);
    },
  };
}

const settingsSpy = { calls: 0 };
const previewSynth = recordingSynth();
const previewRoutes = createVoiceHandler({
  ctx: {
    get() {
      throw new Error('preview must not read any host service');
    },
    logger: { warn: () => {} },
  },
  liveSettings: () => {
    settingsSpy.calls += 1;
    throw new Error('preview must not read the settings');
  },
  synth: previewSynth,
});

await test('POST /preview answers audio/mpeg from the body alone', async () => {
  previewSynth.calls.length = 0;
  settingsSpy.calls = 0;
  const res = await callRoute(previewRoutes, {
    method: 'POST',
    url: '/dsh-voice-v/preview',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Проверка предпрослушивания.', rate: '+20%', pitch: '-8Hz' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Cache-Control'], 'no-store', 'unsaved values must not be cached as immutable');
  assert.ok(res.collected().byteLength > 1000);
  assert.equal(settingsSpy.calls, 0, 'preview never consults the live settings');
  assert.equal(previewSynth.calls.length, 1);
  assert.deepEqual(previewSynth.calls[0].override, {
    voice: DEFAULT_VOICE,
    rate: '+20%',
    pitch: '-8Hz',
    volume: '+0%',
  });
  assert.equal(previewSynth.calls[0].text, 'Проверка предпрослушивания.');
});

await test('POST /preview accepts a preset-only body and clamps out-of-range values', async () => {
  previewSynth.calls.length = 0;
  await callRoute(previewRoutes, {
    method: 'POST',
    url: '/dsh-voice-v/preview',
    body: JSON.stringify({ text: 'Пресет.', preset: 'ustaly' }),
  });
  assert.equal(previewSynth.calls[0].override.rate, '-12%');
  assert.equal(previewSynth.calls[0].override.pitch, '-15Hz');

  previewSynth.calls.length = 0;
  await callRoute(previewRoutes, {
    method: 'POST',
    url: '/dsh-voice-v/preview',
    body: JSON.stringify({ text: 'Границы.', rate: 999, pitch: -999, voice: 'ru-RU-DariyaNeural' }),
  });
  assert.equal(previewSynth.calls[0].override.rate, '+40%');
  assert.equal(previewSynth.calls[0].override.pitch, '-40Hz');
  assert.equal(previewSynth.calls[0].override.voice, 'ru-RU-DariyaNeural');
});

await test('POST /preview without text previews the shipped sample sentence', async () => {
  previewSynth.calls.length = 0;
  const res = await callRoute(previewRoutes, { method: 'POST', url: '/dsh-voice-v/preview', body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(previewSynth.calls[0].text, DEFAULT_PREVIEW_TEXT);
});

await test('GET /preview reads the same values from the query string', async () => {
  previewSynth.calls.length = 0;
  const url = `/dsh-voice-v/preview?text=${encodeURIComponent('Из строки запроса.')}&rate=${encodeURIComponent('+11%')}&pitch=${encodeURIComponent('+3Hz')}&stripCode=false`;
  const res = await callRoute(previewRoutes, { method: 'GET', url });
  assert.equal(res.status, 200);
  assert.equal(previewSynth.calls[0].override.rate, '+11%');
  assert.equal(previewSynth.calls[0].override.pitch, '+3Hz');
});

await test('GET /preview with stripCode=off keeps the code in the text', async () => {
  previewSynth.calls.length = 0;
  const text = encodeURIComponent('Вот код:\n```\nconst a = 1;\n```');
  await callRoute(previewRoutes, { method: 'GET', url: `/dsh-voice-v/preview?text=${text}&stripCode=false` });
  assert.match(previewSynth.calls[0].text, /const a = 1/);
});

await test('an unsupported method on /preview is a 405 with Allow', async () => {
  const res = await callRoute(previewRoutes, { method: 'DELETE', url: '/dsh-voice-v/preview' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
});

await test('a preview with nothing speakable is a coded 422', async () => {
  const res = await callRoute(previewRoutes, {
    method: 'POST',
    url: '/dsh-voice-v/preview',
    body: JSON.stringify({ text: '🚀🚀' }),
  });
  assert.equal(res.status, 422);
  assert.equal(res.json().code, 'nothing-to-say');
});

await test('a preview whose synthesis fails is a coded 502', async () => {
  const broken = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({}),
    synth: {
      ...previewSynth,
      ensure: async () => {
        throw new Error('edge-tts exited with code 1');
      },
    },
  });
  const res = await callRoute(broken, { method: 'POST', url: '/dsh-voice-v/preview', body: JSON.stringify({ text: 'Раз.' }) });
  assert.equal(res.status, 502);
  assert.equal(res.json().code, 'synthesis-failed');
});

await test('a preview body that is not JSON is a coded 400', async () => {
  const res = await callRoute(previewRoutes, { method: 'POST', url: '/dsh-voice-v/preview', body: '{' });
  assert.equal(res.status, 400);
  assert.equal(res.json().code, 'bad-body');
});

console.log('\nautomatic preset (the tone of the message)');

await test('the tone rules cover the four categories the user asked for', () => {
  // The examples from the request, one per category.
  assert.equal(detectTone('Блин, устала уже, сил нет.'), 'ustaly');
  assert.equal(detectTone('Люблю тебя, скучаю!'), 'zhivoy');
  assert.equal(detectTone('Почини функцию: ошибка компиляции, гоняй тесты и деплой.'), 'spokoiny');
  assert.equal(detectTone('Ты милая, нравишься мне.'), 'derzkiy');

  // Every word of the requirement is in the table, under the right category.
  const expected = {
    ustaly: ['блин', 'устал', 'устала', 'устали', 'выматывает', 'чёрт', 'черт', 'бесит', 'хреново', 'тяжело', 'сил нет', 'выгорел'],
    zhivoy: ['люблю', 'скучаю', 'скучал', 'рад', 'рада', 'здорово', 'отлично', 'ура', 'обнимаю'],
    spokoiny: [
      'код',
      'функция',
      'ошибка',
      'компиляция',
      'тест',
      'деплой',
      'рефакторинг',
      'репозиторий',
      'коммит',
      'патч',
      'лог',
      'стектрейс',
      'баг',
      'конфиг',
      'сервер',
      'база данных',
      'миграция',
      'запрос',
      'модуль',
      'переменная',
      'скрипт',
      'нейросеть',
      'промпт',
      'токен',
      'api',
      'npm',
    ],
    derzkiy: [
      'милый',
      'милая',
      'милаш',
      'красавец',
      'красавица',
      'нравишься',
      'обнимаешь',
      'поцелуй',
      'флирт',
      'глаза',
      'смотришь на меня',
      'заинтересовать',
      'соблазн',
    ],
  };
  for (const [preset, terms] of Object.entries(expected)) {
    for (const term of terms) {
      assert.ok(TONE_RULES[preset].includes(term), `${term} must be a ${preset} rule`);
    }
  }
});

await test('a neutral text carries no tone at all', () => {
  assert.equal(detectTone('Сегодня вторник, погода хорошая.'), null);
  assert.equal(detectTone(''), null);
  assert.equal(detectTone('   '), null);
  const analysis = analyzeTone('Сегодня вторник, погода хорошая.');
  assert.equal(analysis.preset, null);
  assert.deepEqual(analysis.matched, []);
  assert.equal(analysis.score, 0);
  assert.deepEqual(analysis.candidates, []);
});

await test('a text that matches two categories goes to the documented winner', () => {
  // One tired word and one flirt word: the counts tie, and the fixed priority
  // decides — the fatigue comes first.
  assert.deepEqual(TONE_PRIORITY, ['ustaly', 'derzkiy', 'zhivoy', 'spokoiny']);
  const analysis = analyzeTone('Блин, ты милая.');
  assert.equal(analysis.preset, 'ustaly');
  assert.equal(analysis.score, 1);
  assert.deepEqual(analysis.matched, ['блин']);
  assert.deepEqual(
    analysis.candidates.map((entry) => entry.preset),
    ['ustaly', 'derzkiy'],
  );
  // The same tie, the other way round: the priority does not depend on the
  // order the words appear in.
  assert.equal(detectTone('Ты милая, блин.'), 'ustaly');
});

await test('the tone detection is case-insensitive and matches whole words only', () => {
  assert.equal(detectTone('УСТАЛ'), 'ustaly');
  assert.equal(detectTone('ЛюБлю'), 'zhivoy');
  assert.equal(detectTone('БЛИН'), 'ustaly');
  assert.deepEqual(analyzeTone('УСТАЛ').matched, ['устал']);
  // A rule term never fires inside a longer word.
  assert.equal(detectTone('Усталивать я не стану.'), null);
  assert.equal(detectTone('Он капитан.'), null);
});

await test('the tone analysis explains the choice it made', () => {
  const analysis = analyzeTone('Блин, устала уже, сил нет.');
  assert.equal(analysis.preset, 'ustaly');
  assert.equal(analysis.score, 3);
  assert.deepEqual(analysis.matched, ['блин', 'устала', 'сил нет']);
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0].preset, 'ustaly');
  assert.equal(analysis.candidates[0].score, 3);
});

await test('the schema declares autoPreset as a volatile boolean that defaults to on', () => {
  const schema = buildSettingsSchema(fakeSchemaFactory());
  const field = schema.dict.autoPreset;
  assert.ok(field !== undefined, 'the schema must declare the automatic preset');
  assert.equal(field.type, 'boolean');
  assert.equal(field.meta.volatile, true, 'the switch must be volatile so the Host accepts a write');
  assert.equal(field.meta.default, true);
  assert.equal(DEFAULT_AUTO_PRESET, true);

  // The live resolver reads it, and an absent field means "on".
  assert.equal(resolveVoiceConfig({}).autoPreset, true);
  assert.equal(resolveVoiceConfig({ autoPreset: true }).autoPreset, true);
  assert.equal(resolveVoiceConfig({ autoPreset: false }).autoPreset, false);
  assert.equal(resolveVoiceConfig({ autoPreset: 'off' }).autoPreset, false);

  const loaded = loadSchemaFactory();
  if (typeof loaded.z?.object === 'function') {
    const real = buildSettingsSchema(loaded.z);
    assert.equal(real({}).autoPreset, true);
    assert.equal(real({ autoPreset: false }).autoPreset, false);
  }
});

await test('the schema declares the visualization variant as a volatile field with the documented default', () => {
  const schema = buildSettingsSchema(fakeSchemaFactory());
  const field = schema.dict.spectrum;
  assert.ok(field !== undefined, 'the schema must declare the visualization variant');
  // `volatileForm` keeps only the volatile children: a plain field would drop
  // the whole entry from the form, and the card would never mount.
  assert.equal(field.meta.volatile, true, 'the variant must be volatile so the Host accepts a write');
  assert.equal(field.meta.default, DEFAULT_SPECTRUM, 'the default variant is the one the schema offers');
  assert.equal(DEFAULT_SPECTRUM, 'bars');
  assert.equal(field.meta.loose, true, 'an unknown variant must fall back, not fail the whole entry');

  // The allow-list is the schema itself: the shipped variants and nothing else.
  assert.equal(field.type, 'union');
  assert.deepEqual(
    field.list.map((entry) => entry.value),
    SPECTRUM_VARIANTS.map((variant) => variant.id),
  );
  assert.deepEqual(
    SPECTRUM_VARIANTS.map((variant) => variant.label),
    ['Выключено', 'Спектр', 'Волна', 'Пульс', 'Точки'],
  );

  // The live resolver: an unknown value falls back to the default instead of
  // breaking anything.
  assert.equal(resolveVoiceConfig({}).spectrum, 'bars');
  assert.equal(resolveVoiceConfig({ spectrum: 'wave' }).spectrum, 'wave');
  assert.equal(resolveVoiceConfig({ spectrum: 'off' }).spectrum, 'off');
  assert.equal(resolveVoiceConfig({ spectrum: 'нет-такого' }).spectrum, 'bars');
  assert.equal(resolveVoiceConfig({ spectrum: '' }).spectrum, 'bars');

  // The composition layer carries the field, and only the field.
  const base = pickSettingsBase({ spectrum: 'dots', binPath: '/nowhere' });
  assert.equal(base.spectrum, 'dots');
  assert.equal('binPath' in base, false);
  assert.equal(pickSettingsSection({ spectrum: 'pulse' }).spectrum, 'pulse');

  const loaded = loadSchemaFactory();
  if (typeof loaded.z?.object === 'function') {
    const real = buildSettingsSchema(loaded.z);
    assert.equal(real.dict.spectrum.meta.volatile, true);
    assert.equal(real.dict.spectrum.meta.default, DEFAULT_SPECTRUM);
    assert.equal(real.dict.spectrum.meta.loose, true);
  }
});

/**
 * A synthesis service that records every call and its override, so a check can
 * see which voice triple each chunk was asked for.
 * @returns The recording service.
 */
function toneRecordingSynth() {
  const calls = [];
  const cachedCalls = [];
  return {
    calls,
    cachedCalls,
    cacheDir,
    counters: { launched: 0, served: 0, failed: 0 },
    async ensure(text, override) {
      calls.push({ text, override });
      const key = createHash('sha256').update(`${text}\u0000${JSON.stringify(override ?? null)}`).digest('hex');
      const file = join(cacheDir, `${key}.mp3`);
      await writeFile(file, Buffer.alloc(1200, 7));
      return { key, file, bytes: 1200, cached: false, voice: override ?? {} };
    },
    async cached(text, override) {
      cachedCalls.push({ text, override });
      return {
        key: createHash('sha256').update(`${text}\u0000${JSON.stringify(override ?? null)}`).digest('hex'),
        cached: false,
      };
    },
    pathFor(key) {
      return join(cacheDir, `${key}.mp3`);
    },
  };
}

/**
 * Wait for a condition to hold — the background warming is asynchronous.
 * @param predicate - The condition.
 * @param timeoutMs - How long to wait before giving up.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (predicate() !== true) {
    if (Date.now() - started > timeoutMs) throw new Error('the condition did not hold in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

await test('/speak narrates a tired message in the tired preset', async () => {
  const synth = toneRecordingSynth();
  const live = () => resolveVoiceConfig({ preset: 'zhivoy' });
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: live,
    synth,
  });

  const res = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала. Сил нет.')}`,
  });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.autoPreset, true, 'the automatic choice was applied');
  assert.equal(payload.autoPresetEnabled, true);
  assert.equal(payload.preset, 'ustaly', 'the message is narrated in the tired preset');
  assert.equal(payload.rate, '-12%');
  assert.equal(payload.pitch, '-15Hz');
  assert.equal(payload.configuredPreset, 'zhivoy', 'the stored preset is not the one that was used');
  assert.equal(payload.tone.preset, 'ustaly');
  assert.ok(payload.tone.matched.includes('устала'), 'the answer says why the preset was chosen');

  // The synthesis really ran with those values.
  assert.deepEqual(synth.calls[0].override, {
    voice: DEFAULT_VOICE,
    rate: '-12%',
    pitch: '-15Hz',
    volume: '+0%',
  });

  // And the stored configuration is untouched: the choice was per request.
  assert.equal(live().preset, 'zhivoy');
  assert.equal(live().rate, '+6%');
  assert.equal(live().pitch, '+12Hz');
});

await test('/speak keeps the configured preset when the automatic choice is off', async () => {
  const synth = toneRecordingSynth();
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ preset: 'zhivoy', autoPreset: false }),
    synth,
  });

  const res = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала.')}`,
  });
  const payload = res.json();
  assert.equal(payload.autoPreset, false);
  assert.equal(payload.autoPresetEnabled, false);
  assert.equal(payload.preset, 'zhivoy');
  assert.equal(payload.rate, '+6%');
  assert.equal(payload.pitch, '+12Hz');
  assert.equal(payload.tone, null, 'nothing is detected while the switch is off');
  assert.equal(synth.calls[0].override, undefined, 'no override reaches the synthesis');
});

await test('/speak keeps a tempo the user pinned, and takes the rest from the tone', async () => {
  const synth = toneRecordingSynth();
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ preset: 'zhivoy', rate: '+33%' }),
    synth,
  });

  const res = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала.')}`,
  });
  const payload = res.json();
  assert.equal(payload.rate, '+33%', 'the explicit tempo survives the automatic choice');
  assert.equal(payload.pitch, '-15Hz', 'the tone follows the detected preset');
  assert.equal(payload.preset, 'ustaly');
  assert.equal(payload.autoPreset, true);
  assert.deepEqual(synth.calls[0].override, {
    voice: DEFAULT_VOICE,
    rate: '+33%',
    pitch: '-15Hz',
    volume: '+0%',
  });

  // With both values pinned there is nothing left for the automatic choice to
  // change, so it reports that it did not apply.
  const pinned = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ preset: 'zhivoy', rate: '+33%', pitch: '+3Hz' }),
    synth: toneRecordingSynth(),
  });
  const pinnedRes = await callRoute(pinned, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала.')}`,
  });
  const pinnedPayload = pinnedRes.json();
  assert.equal(pinnedPayload.autoPreset, false);
  assert.equal(pinnedPayload.preset, 'zhivoy');
  assert.equal(pinnedPayload.rate, '+33%');
  assert.equal(pinnedPayload.pitch, '+3Hz');
});

await test('the automatic override reaches the background warming too', async () => {
  const synth = toneRecordingSynth();
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ preset: 'zhivoy', maxChunkChars: 30 }),
    synth,
  });

  const res = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Блин, я совсем устала. Сил нет. Надо отдохнуть. Хочу домой. Позвонить маме.')}`,
  });
  const payload = res.json();
  assert.ok(payload.parts.length >= 3, 'the message must be split into several chunks');

  // The warming runs in the background: wait for it before reading the calls.
  await waitFor(() => synth.calls.length >= payload.parts.length);
  assert.equal(synth.calls.length, payload.parts.length, 'every chunk is synthesized exactly once');
  assert.equal(synth.cachedCalls.length, payload.parts.length);

  const expected = { voice: DEFAULT_VOICE, rate: '-12%', pitch: '-15Hz', volume: '+0%' };
  for (const call of synth.calls) {
    assert.deepEqual(call.override, expected, 'the warmed chunk must use the override of the first one');
  }
  for (const call of synth.cachedCalls) {
    assert.deepEqual(call.override, expected, 'the manifest must be built with the same override');
  }
});

console.log('\n/speak with live settings');

await test('/speak reports and synthesizes with whatever the settings say now', async () => {
  const state = { rate: '+6%', pitch: '+12Hz', preset: 'zhivoy' };
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: state.rate, pitch: state.pitch, volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () =>
      resolveVoiceConfig({
        preset: state.preset,
        rate: state.rate,
        pitch: state.pitch,
        stripCode: state.stripCode !== false,
      }),
    synth,
  });

  const first = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Первое чтение.')}`,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json().rate, '+6%');
  const firstKey = first.json().parts[0].key;

  // The user moves the sliders in the card; nothing is restarted.
  state.rate = '+25%';
  state.pitch = '-10Hz';
  state.preset = 'derzkiy';

  const second = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Первое чтение.')}`,
  });
  assert.equal(second.json().rate, '+25%');
  assert.equal(second.json().pitch, '-10Hz');
  assert.equal(second.json().preset, 'derzkiy');
  assert.notEqual(second.json().parts[0].key, firstKey, 'the live setting reaches the cache key');
  assert.match(await readFile(join(cacheDir, `${second.json().parts[0].key}.mp3`), 'utf8'), /\+25%\|-10Hz/);
});

await test('/speak honours the code switch from the live settings', async () => {
  const state = { stripCode: true };
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    // The automatic preset is off here: this check is about the code switch,
    // and the text of a code sample would otherwise be read as work talk.
    liveSettings: () => ({ ...resolveVoiceConfig({}), stripCode: state.stripCode, autoPreset: false }),
    synth,
  });
  const text = encodeURIComponent('Код:\n```\nconst secret = 1;\n```');

  const withCodeStripped = await callRoute(routes, { method: 'GET', url: `/dsh-voice-v/speak?text=${text}` });
  assert.match(await readFile(join(cacheDir, `${withCodeStripped.json().parts[0].key}.mp3`), 'utf8'), /\|\+6%\|/);
  const strippedKey = withCodeStripped.json().parts[0].key;

  state.stripCode = false;
  const readAsIs = await callRoute(routes, { method: 'GET', url: `/dsh-voice-v/speak?text=${text}` });
  assert.notEqual(readAsIs.json().parts[0].key, strippedKey, 'the switch changes the narration and so the key');
  assert.equal(readAsIs.json().stripCode, false);
});

await test('GET /config reports the preset table, the defaults, and the domains', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({}),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.settingsNamespace, SETTINGS_NAMESPACE);
  assert.deepEqual(payload.rateRange, RATE_RANGE);
  assert.deepEqual(payload.pitchRange, PITCH_RANGE);
  assert.equal(payload.presetList.length, 5);
  assert.equal(payload.presetList[0].id, 'zhivoy');
  assert.equal(payload.dictionary.redscript, DEFAULT_PRONUNCIATION.redscript);
  assert.equal(payload.dictionaryDefaults.redscript, DEFAULT_PRONUNCIATION.redscript);
  assert.equal(payload.defaultPreviewText, DEFAULT_PREVIEW_TEXT);
  assert.equal(payload.settingsRegistered, false, 'no liveSettings probe was supplied');
});

await test('GET /config reports the voice catalogue the card renders', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({}),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  const payload = res.json();
  assert.equal(payload.voiceList.length, 7, 'the card must be offered the whole catalogue');
  assert.equal(payload.voiceList[0].id, 'ru-RU-SvetlanaNeural');
  assert.equal(payload.voiceList[0].group, 'Русские');
  assert.equal(payload.voiceList[0].label, 'Светлана · ru-RU-SvetlanaNeural');
  assert.equal(payload.voiceList[2].group, 'Мультиязычные');
  assert.equal(payload.defaultVoice, DEFAULT_VOICE, 'the card needs the fallback voice for an empty field');
});

await test('the catalogue says which voices read Russian with an accent', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    liveSettings: () => resolveVoiceConfig({}),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  const payload = res.json();
  const russian = payload.voiceList.filter((entry) => entry.group === 'Русские');
  const multilingual = payload.voiceList.filter((entry) => entry.group === 'Мультиязычные');
  assert.ok(russian.length > 0 && multilingual.length > 0, 'the catalogue has both groups');
  for (const entry of russian) {
    assert.doesNotMatch(entry.label, /акцент/, `the native voice "${entry.id}" has no accent`);
  }
  for (const entry of multilingual) {
    assert.match(entry.label, /с акцентом/, `the multilingual voice "${entry.id}" must say it has an accent`);
  }
});

await test('GET /config reports the visualization variants, and the manifest carries the one in use', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ spectrum: 'dots' }),
    synth,
  });

  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  const payload = res.json();
  assert.equal(payload.spectrum, 'dots', 'the card must know the variant in use');
  assert.deepEqual(
    payload.spectrumVariants.map((variant) => variant.id),
    SPECTRUM_VARIANTS.map((variant) => variant.id),
    'the card renders the variants the host reports',
  );
  assert.deepEqual(
    payload.spectrumVariants.map((variant) => variant.label),
    ['Выключено', 'Спектр', 'Волна', 'Пульс', 'Точки'],
  );

  // The manifest is what the message button reads: the variant travels with
  // the one request the button already makes.
  const manifest = await callRoute(routes, {
    method: 'GET',
    url: `/dsh-voice-v/speak?text=${encodeURIComponent('Первое чтение.')}`,
  });
  assert.equal(manifest.json().spectrum, 'dots');
});

await test('GET /config reports the catalogue the deployment asked for', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => resolveVoiceConfig({ voices: ['de-DE-KatjaNeural'] }),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  const payload = res.json();
  assert.equal(payload.voiceList.length, 8);
  assert.equal(payload.voiceList[7].id, 'de-DE-KatjaNeural');
});

await test('GET /config reports the user preset pool and marks its rows', async () => {
  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () =>
      resolveVoiceConfig({
        preset: 'user-moy',
        userPresets: { 'user-moy': { label: 'Мой', rate: '+5%', pitch: '+2Hz' } },
      }),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/config' });
  const payload = res.json();
  assert.equal(payload.preset, 'user-moy');
  assert.equal(payload.voiceOverridden, false);
  assert.equal(payload.userPresets['user-moy'].label, 'Мой');
  assert.equal(payload.presetList.length, 6);
  const own = payload.presetList.find((row) => row.id === 'user-moy');
  assert.equal(own.user, true);
  assert.equal(own.label, 'Мой');
});

await test('GET /health reports the live switch as well', async () => {  const synth = makeSynth(() => ({ voice: DEFAULT_VOICE, rate: '+6%', pitch: '+12Hz', volume: '+0%' }));
  const routes = createVoiceHandler({
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    liveSettings: () => ({ ...resolveVoiceConfig({}), stripCode: false }),
    synth,
  });
  const res = await callRoute(routes, { method: 'GET', url: '/dsh-voice-v/health' });
  assert.equal(res.json().stripCode, false);
  assert.equal(res.json().settingsNamespace, SETTINGS_NAMESPACE);
});

console.log('\nplugin mount');

await test('apply() registers the route and reads the volatile fields it was handed', async () => {
  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    effect(fn, _label) {
      fn();
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };

  // The row config the Loader hands over: the card-owned fields are volatile
  // references, the deployment keys are plain values.
  const loaded = loadSchemaFactory();
  const harness = typeof loaded.z?.object === 'function' ? makeVolatileHarness() : null;
  const config = harness === null ? { preset: 'spokoiny' } : harness.config;
  config.cacheDir = cacheDir;
  config.timeoutMs = 5000;

  const { apply } = await import('../lib/index.js');
  apply(ctx, config);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/dsh-voice-v');

  const res = await callRoute(routes[0].handler, { method: 'GET', url: '/dsh-voice-v/config' });
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.settingsNamespace, SETTINGS_NAMESPACE);
  assert.equal(payload.settingsRegistered, harness !== null, 'the namespace is served only with a published Config');
  assert.equal(payload.preset, 'spokoiny');

  if (harness !== null) {
    // A card write lands in the very reference the route reads, so the next
    // request answers with the new value and no remount.
    harness.write('preset', 'ustaly');
    const after = await callRoute(routes[0].handler, { method: 'GET', url: '/dsh-voice-v/config' });
    assert.equal(after.json().preset, 'ustaly', 'a committed write is visible on the next request');
    assert.equal(after.json().rate, '-12%');
  }
});

await rm(cacheDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('settings card (rendered, no browser)');

/**
 * A minimal function component renderer: enough of React's hook contract to
 * run the shipped card, drive its handlers, and read the resulting element
 * tree. It is not a React implementation — no reconciliation, no keys — but it
 * does catch the failure that matters here, a card that throws while rendering.
 *
 * Every mounted component gets its own hook store, so two components — two
 * message buttons, or a button and the card — can sit side by side, the way
 * two rows of a chat do.
 * @returns The stub React namespace plus the render bookkeeping.
 */
function createMiniReact() {
  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  /** One component's hook store. */
  const createStore = () => ({ hooks: [], cursor: 0, dirty: false });

  const stores = [createStore()];
  let active = stores[0];

  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      const merged = Object.assign({}, props ?? {});
      const children = Array.prototype.slice.call(arguments, 2);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged, key: merged.key === undefined ? null : merged.key };
    },
    useState(initial) {
      const store = active;
      const index = store.cursor;
      store.cursor += 1;
      if (store.hooks[index] === undefined) {
        store.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      }
      const cell = store.hooks[index];
      return [
        cell.value,
        (next) => {
          const value = typeof next === 'function' ? next(cell.value) : next;
          if (!Object.is(value, cell.value)) {
            cell.value = value;
            store.dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const store = active;
      const index = store.cursor;
      store.cursor += 1;
      if (store.hooks[index] === undefined) store.hooks[index] = { kind: 'ref', current: initial };
      return store.hooks[index];
    },
    useCallback(fn, deps) {
      const store = active;
      const index = store.cursor;
      store.cursor += 1;
      if (store.hooks[index] === undefined || !sameDeps(store.hooks[index].deps, deps)) {
        store.hooks[index] = { kind: 'callback', fn, deps };
      }
      return store.hooks[index].fn;
    },
    useEffect(fn, deps) {
      const store = active;
      const index = store.cursor;
      store.cursor += 1;
      if (store.hooks[index] === undefined || !sameDeps(store.hooks[index].deps, deps)) {
        store.hooks[index] = { kind: 'effect', deps, fn, run: false };
      }
    },
    useMemo(fn, deps) {
      const store = active;
      const index = store.cursor;
      store.cursor += 1;
      if (store.hooks[index] === undefined || (deps !== undefined && !sameDeps(store.hooks[index].deps, deps))) {
        store.hooks[index] = { kind: 'memo', deps, value: fn() };
      }
      return store.hooks[index].value;
    },
  };

  return {
    react,
    begin() {
      active = stores[0];
      active.cursor = 0;
    },
    pendingEffects() {
      return stores[0].hooks.filter((hook) => hook !== undefined && hook.kind === 'effect' && hook.run !== true);
    },
    isDirty() {
      return stores[0].dirty;
    },
    /**
     * The cleanups of the effects that ran: running them is how a component
     * leaves the page.
     * @returns The cleanup functions.
     */
    cleanups() {
      return stores[0].hooks
        .filter((hook) => hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function')
        .map((hook) => hook.cleanup);
    },
    /**
     * A second component instance, with its own hook store. The bundle's
     * sound slot is module-level, so two buttons mounted this way still share
     * one sound.
     * @returns The instance handle: `begin`, `pendingEffects`, `isDirty`.
     */
    instance() {
      const store = createStore();
      stores.push(store);
      return {
        begin() {
          active = store;
          store.cursor = 0;
        },
        pendingEffects() {
          return store.hooks.filter((hook) => hook !== undefined && hook.kind === 'effect' && hook.run !== true);
        },
        isDirty() {
          return store.dirty;
        },
        cleanups() {
          return store.hooks
            .filter((hook) => hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function')
            .map((hook) => hook.cleanup);
        },
      };
    },
  };
}

/**
 * Walk a rendered tree depth-first.
 * @param node - Element, array, or text.
 * @param visit - Called for every element node.
 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.props === undefined ? undefined : node.props.children, visit);
}

/** Every text node in a rendered tree, joined. */
function textOf(tree) {
  const parts = [];
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (typeof node !== 'object') {
      parts.push(String(node));
      return;
    }
    collect(node.props === undefined ? undefined : node.props.children);
  };
  collect(tree);
  return parts.join(' ');
}

/** Every element in a rendered tree. */
function elementsOf(tree) {
  const found = [];
  walk(tree, (node) => found.push(node));
  return found;
}

/**
 * Load the shipped components out of `lib/client.js` by evaluating the bundle
 * the way the shell does, then mounting this plugin against a stub slot
 * registry.
 * @param react - The stub React namespace the factory must receive.
 * @param globals - Extra globals for the bundle's sandbox (the browser gives it
 *   `fetch`, `document`, and the rest).
 * @returns `{ card, button, audio }`: the registered components and the shared
 *   sound slot the bundle exposes for the tests.
 */
function loadClientComponents(react, globals = {}) {
  const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));
  const source = readFileSync(clientPath, 'utf8');
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: clientPath });
  assert.equal(registrations.length, 1);

  const scopeStub = { getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, set: async () => {}, unset: async () => {} };
  const mounted = [];
  const clientExports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return react;
    throw new Error(`unexpected require(${specifier})`);
  });
  // The post-refactor browser contract: the card binds through the `configForms`
  // service and registers into the plugin manager's `plugins.bundle.config`
  // seat, which exists only while the Host serves the namespace.
  const ctx = {
    slots: {
      inject(_name, factory) {
        const produced = factory();
        if (produced !== null && produced !== undefined && typeof produced.next === 'function') produced.next();
        return () => {};
      },
      register(options, component) {
        mounted.push({ options, component });
        return () => {};
      },
    },
    configForms: {
      get: () => scopeStub,
      whileServed(namespaces, register) {
        return register(new Set(namespaces));
      },
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject(_services, callback) {
      callback(ctx);
    },
  };
  clientExports.apply(ctx);
  const card = mounted.find((entry) => entry.options.name === 'plugins.bundle.config');
  const button = mounted.find((entry) => entry.options.name === 'conversation.chat.assistant-actions');
  assert.ok(card !== undefined, 'the settings card must register');
  assert.ok(button !== undefined, 'the speaker button must register');
  return { card: card.component, button: button.component, audio: clientExports.__audio };
}

/**
 * The settings card component out of the shipped bundle.
 * @param react - The stub React namespace the factory must receive.
 * @param globals - Extra globals for the bundle's sandbox.
 * @returns The registered settings-card component.
 */
function loadCardComponent(react, globals = {}) {
  return loadClientComponents(react, globals).card;
}

/**
 * Mount a component and render it to a settled tree, running effects between
 * passes the way a browser would after each state change.
 * @param props - Props the registration injects.
 * @param harness - The harness returned by {@link createMiniReact}, or one of
 *   its `instance()` handles.
 * @returns `{ component, tree, rerender }`.
 */
async function mountComponent(component, props, harness) {
  const state = { tree: null };
  const rerender = async () => {
    let tree = null;
    for (let pass = 0; pass < 12; pass += 1) {
      harness.begin();
      tree = component(props);
      const pending = harness.pendingEffects();
      for (const hook of pending) {
        hook.run = true;
        hook.cleanup = hook.fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pending.length === 0 && !harness.isDirty()) break;
    }
    state.tree = tree;
    return tree;
  };
  await rerender();
  return {
    /** The most recently rendered tree. */
    get tree() {
      return state.tree;
    },
    rerender,
  };
}

/**
 * Mount the card and render it to a settled tree.
 * @param component - The card component.
 * @param props - Props the registration injects.
 * @param mini - The harness returned by {@link createMiniReact}.
 * @returns `{ component, tree, rerender }`.
 */
async function mountCard(component, props, mini) {
  return mountComponent(component, props, mini);
}

await test('the card renders and shows every control it owns', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const snapshot = {
    status: 'ready',
    value: { ...settings, dictionary: { ...settings.dictionary } },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: 'host',
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  };

  {
    const mounted = await mountCard(component, { scope }, mini);
    const text = textOf(mounted.tree);

    for (const expected of [
      'Озвучка ответов (dsh-voice-v)',
      'Живой',
      'Нейтральный',
      'Спокойный',
      'Дерзкий',
      'Усталый',
      'Прослушать',
      'Сбросить к пресету',
      'Вырезать код из озвучки',
      'Пресет по тону сообщения',
      'Словарь произношения',
      'Сохранить',
      'Отменить правки',
    ]) {
      assert.ok(text.includes(expected), `the card must render ${JSON.stringify(expected)}; got: ${text.slice(0, 400)}`);
    }
    assert.ok(text.includes('+6%') && text.includes('+12Hz'), 'the sliders must show the resolved tempo and tone');

    /** The tempo slider of the latest render. */
    const rateSlider = () =>
      elementsOf(mounted.tree).find(
        (node) => node.props !== undefined && node.props['aria-label'] === 'Темп в процентах',
      );
    /** The tone slider of the latest render. */
    const pitchSlider = () =>
      elementsOf(mounted.tree).find(
        (node) => node.props !== undefined && node.props['aria-label'] === 'Тон в герцах',
      );
    assert.equal(rateSlider().props.value, 6);
    assert.equal(pitchSlider().props.value, 12);
    assert.equal(rateSlider().props.min, RATE_RANGE.min);
    assert.equal(rateSlider().props.max, RATE_RANGE.max);
    assert.equal(pitchSlider().props.min, PITCH_RANGE.min);
    assert.equal(pitchSlider().props.max, PITCH_RANGE.max);

    // The dictionary rows show the built-in readings the host reported.
    const redscript = elementsOf(mounted.tree).find(
      (node) => node.props !== undefined && node.props['aria-label'] === 'Транскрипция для redscript',
    );
    assert.ok(redscript !== undefined, 'the built-in terms must be listed');
    assert.equal(redscript.props.value, DEFAULT_PRONUNCIATION.redscript);
    const dictRows = elementsOf(mounted.tree).filter(
      (node) => node.props !== undefined && node.props.className === 'dvv-dict-row',
    );
    assert.ok(dictRows.length > Object.keys(DEFAULT_PRONUNCIATION).length, 'every built-in term plus the add row');

    // Choosing a preset moves the sliders immediately, before any save.
    const ustaly = elementsOf(mounted.tree).find(
      (node) => node.type === 'button' && textOf(node).includes('Усталый'),
    );
    assert.ok(ustaly !== undefined, 'the Усталый preset button must exist');
    ustaly.props.onClick();
    const afterPreset = textOf(await mounted.rerender());
    assert.equal(rateSlider().props.value, -12, 'the tempo slider must follow the preset');
    assert.equal(pitchSlider().props.value, -15, 'the tone slider must follow the preset');
    assert.ok(afterPreset.includes('есть несохранённые правки'), 'the card must mark the staged edit');

    // Reset-to-preset stages a clear, and the switches keep working.
    const reset = elementsOf(mounted.tree).find(
      (node) => node.type === 'button' && textOf(node).includes('Сбросить к пресету'),
    );
    reset.props.onClick();
    const strip = elementsOf(mounted.tree).find(
      (node) => node.type === 'input' && node.props.type === 'checkbox',
    );
    assert.equal(strip.props.checked, true, 'code stripping is on by default');
    strip.props.onChange({ target: { checked: false } });
    const afterStrip = textOf(await mounted.rerender());
    assert.ok(afterStrip.includes('читаются как есть'), 'the hint must follow the switch');
  }
});

await test('the card shows the values the host resolved, not the raw form value', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
      // What the Host resolved out of the preset for the fields the row never
      // set: the form cannot carry them, because the schema has no defaults
      // for them.
      preset: settings.preset,
      rate: settings.rate,
      pitch: settings.pitch,
      voice: settings.voice,
      stripCode: settings.stripCode,
      dictionary: settings.dictionary,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  // The raw row config: the preset is stored, the rest is absent.
  const snapshot = {
    status: 'ready',
    value: { preset: settings.preset, stripCode: true, dictionary: { ...settings.dictionary } },
    base: {},
    user: {},
    revision: 4,
    writable: true,
    mode: 'host',
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  };

  const mounted = await mountCard(component, { scope }, mini);
  const text = textOf(mounted.tree);

  const rateSlider = elementsOf(mounted.tree).find(
    (node) => node.props !== undefined && node.props['aria-label'] === 'Темп в процентах',
  );
  const pitchSlider = elementsOf(mounted.tree).find(
    (node) => node.props !== undefined && node.props['aria-label'] === 'Тон в герцах',
  );
  assert.equal(rateSlider.props.value, 6, 'the tempo slider must show the resolved tempo');
  assert.equal(pitchSlider.props.value, 12, 'the tone slider must show the resolved tone');
  assert.ok(text.includes(settings.voice), 'the footer must name the resolved voice');
  assert.ok(text.includes('+6%') && text.includes('+12Hz'), 'the footer must show the resolved tempo and tone');
  // The built-in dictionary lists a term named `undefined` itself, so the
  // guard counts the word instead of looking for it: only the term may print it.
  assert.equal(
    (text.match(/undefined/g) ?? []).length,
    1,
    'the card must not print undefined for a value the host resolved',
  );
});

await test('the card owns the automatic-preset switch', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
      autoPreset: settings.autoPreset,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 5,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };

  const mounted = await mountCard(component, { scope }, mini);
  const auto = elementsOf(mounted.tree).find(
    (node) =>
      node.type === 'input' &&
      node.props !== undefined &&
      node.props.type === 'checkbox' &&
      node.props['aria-label'] === 'Пресет по тону сообщения',
  );
  assert.ok(auto !== undefined, 'the card must own the automatic-preset switch');
  assert.equal(auto.props.checked, true, 'the switch is on by default');
  assert.ok(textOf(mounted.tree).includes('Тон сообщения'), 'the switch must have a group of its own');

  // The hint follows the switch.
  auto.props.onChange({ target: { checked: false } });
  const afterOff = textOf(await mounted.rerender());
  assert.ok(afterOff.includes('Пресет выбирается вручную'), 'the hint must follow the switch');

  // Saving writes the field once.
  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once something is staged');
  await save.props.onClick();
  await mounted.rerender();
  assert.deepEqual(writes, [['set', 'autoPreset', false]]);
});

await test('the card saves one scope write per touched field and unsets a cleared one', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const snapshot = {
    status: 'ready',
    value: { ...settings },
    base: {},
    user: {},
    revision: 7,
    writable: true,
    mode: 'host',
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };

  {
    const mounted = await mountCard(component, { scope }, mini);
    const rate = elementsOf(mounted.tree).find(
      (node) => node.type === 'input' && node.props.type === 'range' && node.props['aria-label'] === 'Темп в процентах',
    );
    assert.ok(rate !== undefined);
    rate.props.onChange({ target: { value: '25' } });
    const preset = elementsOf(mounted.tree).find((node) => node.type === 'button' && textOf(node).includes('Усталый'));
    preset.props.onClick();
    await mounted.rerender();

    const save = elementsOf(mounted.tree).find(
      (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
    );
    assert.ok(save !== undefined, 'Save must become available once something is staged');
    await save.props.onClick();
    await mounted.rerender();

    assert.deepEqual(writes, [['set', 'preset', 'ustaly']], 'choosing a preset clears the manual tempo/tone instead of writing them');

    writes.length = 0;
    const mounted2 = await mountCard(component, { scope }, mini);
    const strip = elementsOf(mounted2.tree).find((node) => node.type === 'input' && node.props.type === 'checkbox');
    strip.props.onChange({ target: { checked: false } });
    await mounted2.rerender();
    const save2 = elementsOf(mounted2.tree).find(
      (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
    );
    await save2.props.onClick();
    assert.deepEqual(writes, [['set', 'stripCode', false]]);
  }
});

await test('the card reports an unwritable namespace instead of offering a save', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const component = loadCardComponent(mini.react, {
    fetch: async () => ({ ok: false, status: 500, json: async () => null }),
  });
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 1,
      writable: false,
      mode: 'memory',
    }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  };
  {
    const mounted = await mountCard(component, { scope }, mini);
    const text = textOf(mounted.tree);
    assert.ok(text.includes('только чтение (memory mode)'));
    const save = elementsOf(mounted.tree).find((node) => node.type === 'button' && textOf(node) === 'Сохранить');
    assert.equal(save.props.disabled, true);
  }
});

await test('the card makes a preset out of the sliders and shows it in the list', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const snapshot = {
    status: 'ready',
    value: { ...settings },
    base: {},
    user: {},
    revision: 2,
    writable: true,
    mode: 'host',
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };

  const mounted = await mountCard(component, { scope }, mini);

  // The tempo slider is moved: the draft says +25% from now on.
  const rate = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props.type === 'range' && node.props['aria-label'] === 'Темп в процентах',
  );
  assert.ok(rate !== undefined, 'the card must own the tempo slider');
  rate.props.onChange({ target: { value: '25' } });
  await mounted.rerender();

  // The name of the new preset.
  const name = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Название пресета',
  );
  assert.ok(name !== undefined, 'the card must own a name field');
  name.props.onChange({ target: { value: 'Мой пресет' } });
  await mounted.rerender();

  const make = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить как пресет',
  );
  assert.ok(make !== undefined, 'the card must own the save-as-preset action');
  assert.equal(make.props.disabled, false, 'the action waits for a name');
  make.props.onClick();
  await mounted.rerender();

  // The new preset sits in the list next to the shipped ones, under the name
  // the user gave it.
  assert.ok(textOf(mounted.tree).includes('Мой пресет'), 'the new preset must show in the list');
  const own = elementsOf(mounted.tree).find(
    (node) =>
      node.type === 'button' && node.props.className === 'dvv-preset' && textOf(node).includes('Мой пресет'),
  );
  assert.ok(own !== undefined, 'the new preset must be a row of its own');
  const rows = elementsOf(mounted.tree).filter(
    (node) => node.props !== undefined && node.props.className === 'dvv-preset-row',
  );
  assert.equal(rows.length, 6, 'the five shipped presets plus the new one');

  // Save: the pool is written once, carrying the draft's tempo and tone.
  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once something is staged');
  await save.props.onClick();
  await mounted.rerender();

  const poolWrites = writes.filter((write) => write[1] === 'userPresets');
  assert.equal(poolWrites.length, 1, 'the pool must be written exactly once');
  const pool = poolWrites[0][2];
  const ids = Object.keys(pool);
  assert.equal(ids.length, 1, 'the pool must hold exactly the new preset');
  const id = ids[0];
  assert.equal(id.startsWith('user-'), true, 'a user preset must not shadow a shipped id');
  assert.equal(pool[id].label, 'Мой пресет');
  assert.equal(pool[id].rate, '+25%', 'the preset must carry the draft tempo');
  assert.equal(pool[id].pitch, '+12Hz', 'the preset must carry the draft tone');
  // Staging the pool lost nothing: the other staged edit is still on its way.
  assert.deepEqual(
    writes.filter((write) => write[1] === 'rate'),
    [['set', 'rate', '+25%']],
  );
});

await test('the card deletes a user preset, and only a user row carries the delete control', async () => {  const mini = createMiniReact();
  const settings = resolveVoiceConfig({
    userPresets: { 'user-moy': { label: 'Мой пресет', rate: '+5%', pitch: '+2Hz' } },
  });
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 3,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };

  const mounted = await mountCard(component, { scope }, mini);

  const rows = elementsOf(mounted.tree).filter(
    (node) => node.props !== undefined && node.props.className === 'dvv-preset-row',
  );
  assert.equal(rows.length, 6, 'five shipped presets plus the user one');
  const deletes = elementsOf(mounted.tree).filter(
    (node) => node.type === 'button' && node.props.className === 'dvv-btn dvv-btn-danger dvv-preset-delete',
  );
  assert.equal(deletes.length, 1, 'exactly one row may be deleted');
  for (const row of rows) {
    const buttons = elementsOf(row).filter((node) => node.type === 'button');
    const own = textOf(row).includes('Мой пресет');
    assert.equal(buttons.length, own ? 2 : 1, 'only a user row carries the delete control');
  }

  deletes[0].props.onClick();
  await mounted.rerender();

  // The row leaves the list right away: the card shows the pool it just staged.
  assert.ok(!textOf(mounted.tree).includes('Мой пресет'), 'the deleted preset must leave the list');

  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once something is staged');
  await save.props.onClick();
  await mounted.rerender();

  const poolWrites = writes.filter((write) => write[1] === 'userPresets');
  assert.equal(poolWrites.length, 1, 'the pool must be written exactly once');
  // The map comes from the bundle's own realm, so its keys are compared
  // rather than its prototype.
  assert.deepEqual(Object.keys(poolWrites[0][2]), [], 'the write must carry the pool without the deleted id');
});

await test('the card can drop a staged preset write again', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      presetList: describePresets(settings),
      rateRange: RATE_RANGE,
      pitchRange: PITCH_RANGE,
      dictionaryDefaults: DEFAULT_PRONUNCIATION,
      defaultPreviewText: DEFAULT_PREVIEW_TEXT,
      settingsRegistered: true,
    }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 4,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };

  const mounted = await mountCard(component, { scope }, mini);

  const name = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Название пресета',
  );
  name.props.onChange({ target: { value: 'Мой пресет' } });
  await mounted.rerender();
  const make = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить как пресет',
  );
  make.props.onClick();
  await mounted.rerender();
  assert.ok(textOf(mounted.tree).includes('Мой пресет'), 'the staged preset shows in the list');

  // The edits are dropped: the pool the host reports answers again.
  const discard = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Отменить правки' && node.props.disabled === false,
  );
  assert.ok(discard !== undefined, 'the discard action must be available while edits are staged');
  discard.props.onClick();
  await mounted.rerender();

  assert.ok(!textOf(mounted.tree).includes('Мой пресет'), 'the dropped preset must leave the list');
  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить',
  );
  assert.equal(save.props.disabled, true, 'nothing is left to save');
  assert.deepEqual(writes, [], 'a discarded edit is never written');
});

/**
 * The host payload the card tests read: the same shape `GET /dsh-voice-v/config`
 * answers with, built from a resolved configuration.
 * @param settings - The resolved voice configuration.
 * @param extra - Additional keys for the payload.
 * @returns The payload object.
 */
function configPayload(settings, extra = {}) {
  return {
    ok: true,
    presetList: describePresets(settings),
    voiceList: describeVoices(settings),
    defaultVoice: DEFAULT_VOICE,
    rateRange: RATE_RANGE,
    pitchRange: PITCH_RANGE,
    dictionaryDefaults: DEFAULT_PRONUNCIATION,
    defaultPreviewText: DEFAULT_PREVIEW_TEXT,
    ttsProviders: TTS_PROVIDERS,
    settingsRegistered: true,
    ...extra,
  };
}

/**
 * A scope the card can read and write, with the writes it saw recorded.
 * @param snapshot - The snapshot the scope reports.
 * @param writes - The array the writes are recorded into.
 * @returns The scope stub.
 */
function recordingScope(snapshot, writes) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push(['set', field, value]);
    },
    unset: async (field) => {
      writes.push(['unset', field]);
    },
  };
}

await test('the card offers the voice catalogue the host reported, grouped', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 11,
      writable: true,
      mode: 'host',
    },
    [],
  );

  const mounted = await mountCard(component, { scope }, mini);

  // The voice is a select, not a free-text field.
  const select = elementsOf(mounted.tree).find((node) => node.type === 'select');
  assert.ok(select !== undefined, 'the card must offer the voice as a dropdown');
  assert.equal(select.props['aria-label'], 'Голос edge-tts');
  assert.equal(select.props.value, DEFAULT_VOICE, 'the select shows the voice in use');

  // One optgroup per group, in the order the host listed them.
  const groups = elementsOf(select).filter((node) => node.type === 'optgroup');
  assert.deepEqual(
    groups.map((group) => group.props.label),
    ['Русские', 'Мультиязычные'],
  );
  assert.equal(groups[0].props.children.length, 2, 'the two Russian voices');
  assert.equal(groups[1].props.children.length, 5, 'the five multilingual voices');

  // Every voice of the catalogue is an option, with its id visible in the label.
  const options = elementsOf(select).filter((node) => node.type === 'option');
  const values = options.map((option) => option.props.value);
  for (const id of [
    'ru-RU-SvetlanaNeural',
    'ru-RU-DmitryNeural',
    'en-US-AvaMultilingualNeural',
    'en-US-EmmaMultilingualNeural',
    'de-DE-SeraphinaMultilingualNeural',
    'fr-FR-VivienneMultilingualNeural',
    'pt-BR-ThalitaMultilingualNeural',
  ]) {
    assert.ok(values.includes(id), `the dropdown must offer ${id}`);
  }
  const svetlana = options.find((option) => option.props.value === 'ru-RU-SvetlanaNeural');
  assert.ok(textOf(svetlana).includes('Светлана'), 'the voice is named the way a user knows it');
  assert.ok(textOf(svetlana).includes('ru-RU-SvetlanaNeural'), 'the id stays visible in the label');

  // The last option is the hand-written voice.
  const last = options[options.length - 1];
  assert.ok(textOf(last).includes('Свой голос'), 'the dropdown must offer a hand-written voice');
});

await test('a stored voice outside the catalogue is still shown, not silently dropped', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({ voice: 'xx-XX-CustomNeural' });
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: { voice: 'xx-XX-CustomNeural' },
      revision: 12,
      writable: true,
      mode: 'host',
    },
    [],
  );

  const mounted = await mountCard(component, { scope }, mini);

  const select = elementsOf(mounted.tree).find((node) => node.type === 'select');
  assert.ok(select !== undefined, 'the card must offer the voice as a dropdown');
  assert.equal(select.props.value, 'xx-XX-CustomNeural', 'the select must show the voice in use');
  const option = elementsOf(select).find(
    (node) => node.type === 'option' && node.props.value === 'xx-XX-CustomNeural',
  );
  assert.ok(option !== undefined, 'a voice outside the catalogue is an option of its own');
  assert.ok(textOf(option).includes('xx-XX-CustomNeural'), 'the id stays visible');
});

await test('choosing a voice in the dropdown stages exactly one voice write', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 13,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);

  const select = elementsOf(mounted.tree).find((node) => node.type === 'select');
  select.props.onChange({ target: { value: 'ru-RU-DmitryNeural' } });
  await mounted.rerender();

  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once a voice is chosen');
  await save.props.onClick();
  await mounted.rerender();

  assert.deepEqual(writes, [['set', 'voice', 'ru-RU-DmitryNeural']], 'one write, carrying the chosen id');
});

await test('the hand-written voice keeps the value and falls back to the default when cleared', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 14,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);

  // «Свой голос…» swaps the select for the text field, which opens on the
  // voice in use: nothing is lost in the swap.
  const select = elementsOf(mounted.tree).find((node) => node.type === 'select');
  const custom = elementsOf(select).find(
    (node) => node.type === 'option' && textOf(node).includes('Свой голос'),
  );
  assert.ok(custom !== undefined, 'the dropdown must offer a hand-written voice');
  select.props.onChange({ target: { value: custom.props.value } });
  await mounted.rerender();

  const field = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Голос edge-tts',
  );
  assert.ok(field !== undefined, 'the hand-written field must replace the dropdown');
  assert.equal(field.props.value, DEFAULT_VOICE, 'the field opens on the voice in use');

  // A typed voice is staged like the old free-text field wrote it.
  field.props.onChange({ target: { value: 'de-DE-KatjaNeural' } });
  await mounted.rerender();
  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  await save.props.onClick();
  await mounted.rerender();
  assert.deepEqual(writes, [['set', 'voice', 'de-DE-KatjaNeural']], 'the typed id is what goes to edge-tts');

  // An emptied field falls back to the default voice, never to nothing.
  const emptied = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Голос edge-tts',
  );
  emptied.props.onChange({ target: { value: '' } });
  await mounted.rerender();
  const saveAgain = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  await saveAgain.props.onClick();
  await mounted.rerender();
  assert.deepEqual(
    writes,
    [
      ['set', 'voice', 'de-DE-KatjaNeural'],
      ['set', 'voice', DEFAULT_VOICE],
    ],
    'an emptied field falls back to the default voice',
  );
});

await test('the dictionary is collapsed and its summary reports the counts', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      // Three terms the user owns: three built-in ones the user re-read.
      user: { dictionary: { redscript: 'ред скрипт', TweakDB: 'твик дб', Cyberpunk: 'киберпанк' } },
      revision: 15,
      writable: true,
      mode: 'host',
    },
    [],
  );

  const mounted = await mountCard(component, { scope }, mini);

  const details = elementsOf(mounted.tree).find((node) => node.type === 'details');
  assert.ok(details !== undefined, 'the dictionary must be a native details block');
  assert.equal(details.props.open, undefined, 'the block is collapsed by default: the browser owns the state');

  const summary = elementsOf(details).find((node) => node.type === 'summary');
  assert.ok(summary !== undefined, 'the block must have a summary');
  const text = textOf(summary);
  assert.ok(text.includes('Словарь произношения'), 'the summary names the block');
  assert.ok(text.includes('150 терминов'), `the summary reports the term count; got: ${text}`);
  assert.ok(text.includes('· 3 изменено'), `the summary reports the user's own entries; got: ${text}`);

  // The editing UI is untouched inside the panel.
  const redscript = elementsOf(details).find(
    (node) => node.props !== undefined && node.props['aria-label'] === 'Транскрипция для redscript',
  );
  assert.ok(redscript !== undefined, 'the built-in terms are still editable');
  assert.equal(redscript.props.value, 'ред скрипт', 'the user reading is the one on screen');
  const add = elementsOf(details).find((node) => node.props !== undefined && node.props['aria-label'] === 'Новый термин');
  assert.ok(add !== undefined, 'a new term can still be added');

  // The dictionary is the last thing on the card.
  const card = elementsOf(mounted.tree).find(
    (node) => node.props !== undefined && node.props['data-voice-v-card'] === SETTINGS_NAMESPACE,
  );
  const children = card.props.children;
  assert.equal(children[children.length - 1].type, 'details', 'the card ends with the dictionary');

  // A user who changed nothing owns nothing: the marker is not shown.
  const clean = await mountCard(
    component,
    {
      scope: recordingScope(
        {
          status: 'ready',
          value: { ...settings },
          base: {},
          user: {},
          revision: 17,
          writable: true,
          mode: 'host',
        },
        [],
      ),
    },
    mini.instance(),
  );
  const cleanDetails = elementsOf(clean.tree).find((node) => node.type === 'details');
  const cleanSummary = textOf(elementsOf(cleanDetails).find((node) => node.type === 'summary'));
  assert.ok(cleanSummary.includes('150 терминов'), `the summary reports the term count; got: ${cleanSummary}`);
  assert.equal(cleanSummary.includes('изменено'), false, 'a user who changed nothing owns no entries');
});

await test('the card still exposes every setting it owned before', async () => {
  // The gate that lists the field names must not lose any.
  assert.deepEqual(SETTINGS_FIELDS, [
    'preset',
    'rate',
    'pitch',
    'voice',
    'stripCode',
    'autoPreset',
    'dictionary',
    'userPresets',
    'spectrum',
    'ttsProvider',
    'customBaseUrl',
    'customApiKey',
    'customModel',
  ]);

  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({ ok: true, json: async () => configPayload(settings) });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 16,
      writable: true,
      mode: 'host',
    },
    [],
  );

  const mounted = await mountCard(component, { scope }, mini);
  const nodes = elementsOf(mounted.tree);
  const has = (predicate) => nodes.some(predicate);

  assert.ok(
    has((node) => node.type === 'button' && node.props.className === 'dvv-preset'),
    'the preset must still be a row of buttons',
  );
  assert.ok(
    has((node) => node.type === 'input' && node.props['aria-label'] === 'Темп в процентах'),
    'the tempo must still be a slider',
  );
  assert.ok(
    has((node) => node.type === 'input' && node.props['aria-label'] === 'Тон в герцах'),
    'the tone must still be a slider',
  );
  assert.ok(
    has((node) => node.type === 'select' && node.props['aria-label'] === 'Голос edge-tts'),
    'the voice must still be a control of its own',
  );
  assert.ok(
    has((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] !== 'Пресет по тону сообщения'),
    'the code switch must still be there',
  );
  assert.ok(
    has((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'Пресет по тону сообщения'),
    'the automatic-preset switch must still be there',
  );
  assert.ok(has((node) => node.type === 'details'), 'the dictionary must still be there');
  assert.ok(
    has((node) => node.type === 'input' && node.props['aria-label'] === 'Название пресета'),
    'the user preset pool must still be editable',
  );
  assert.ok(
    has((node) => node.type === 'select' && node.props['aria-label'] === 'Визуализация озвучки'),
    'the visualization variant must be a control of its own',
  );
});

await test('the card offers the variants the host reported and stages one write for the chosen one', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () =>
      configPayload(settings, {
        spectrum: settings.spectrum,
        spectrumVariants: SPECTRUM_VARIANTS,
      }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 18,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);

  // The control is a dropdown of the variants the host reported.
  const select = elementsOf(mounted.tree).find(
    (node) => node.type === 'select' && node.props['aria-label'] === 'Визуализация озвучки',
  );
  assert.ok(select !== undefined, 'the card must offer the visualization as a dropdown');
  const options = elementsOf(select).filter((node) => node.type === 'option');
  assert.deepEqual(
    options.map((option) => option.props.value),
    ['off', 'bars', 'wave', 'pulse', 'dots'],
  );
  assert.ok(textOf(options[1]).includes('Спектр'), 'the variants are named the way a user knows them');
  assert.equal(select.props.value, 'bars', 'the dropdown shows the variant in use');
  assert.ok(
    textOf(mounted.tree).includes('Показывает движение звука'),
    'the card explains what the control does',
  );

  // Choosing a variant stages exactly one write.
  select.props.onChange({ target: { value: 'wave' } });
  await mounted.rerender();

  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once a variant is chosen');
  await save.props.onClick();
  await mounted.rerender();

  assert.deepEqual(writes, [['set', 'spectrum', 'wave']], 'one write, carrying the chosen variant');
});

await test('the card offers the synthesis provider and hides the endpoint fields by default', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => configPayload(settings, { ttsProvider: 'edge', customApiKeySet: false }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 20,
      writable: true,
      mode: 'host',
    },
    [],
  );

  const mounted = await mountCard(component, { scope }, mini);
  const text = textOf(mounted.tree);
  assert.ok(text.includes('Синтез речи'), 'the card must have a group of its own for the provider');
  assert.ok(text.includes('edge-tts остаётся дефолтом'), 'the card explains that edge-tts is the default');

  // The provider is a dropdown of the two providers.
  const select = elementsOf(mounted.tree).find(
    (node) => node.type === 'select' && node.props['aria-label'] === 'Провайдер синтеза',
  );
  assert.ok(select !== undefined, 'the card must offer the provider as a dropdown');
  const options = elementsOf(select).filter((node) => node.type === 'option');
  assert.deepEqual(
    options.map((option) => option.props.value),
    ['edge', 'custom'],
  );
  assert.ok(textOf(options[0]).includes('edge-tts'));
  assert.ok(textOf(options[1]).includes('OpenAI'));
  assert.equal(select.props.value, 'edge', 'the dropdown shows the provider in use');

  // The endpoint's own fields belong to the endpoint only.
  for (const label of ['Base URL эндпоинта', 'Model ID эндпоинта', 'API Key эндпоинта']) {
    assert.equal(
      elementsOf(mounted.tree).some((node) => node.type === 'input' && node.props['aria-label'] === label),
      false,
      `${label} must stay hidden while edge-tts is in use`,
    );
  }
});

await test('choosing the custom provider shows the endpoint and stages one write per field', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => configPayload(settings, { ttsProvider: 'edge', customApiKeySet: true }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 21,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);

  const provider = elementsOf(mounted.tree).find(
    (node) => node.type === 'select' && node.props['aria-label'] === 'Провайдер синтеза',
  );
  provider.props.onChange({ target: { value: 'custom' } });
  await mounted.rerender();

  // The endpoint's fields are on screen now.
  const base = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Base URL эндпоинта',
  );
  const model = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'Model ID эндпоинта',
  );
  const key = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'API Key эндпоинта',
  );
  assert.ok(base !== undefined && model !== undefined && key !== undefined);
  assert.equal(key.props.type, 'password', 'the key field must be a password field');
  assert.equal(key.props.value, '', 'the key field starts empty: the key is never sent to the browser');
  assert.match(key.props.placeholder, /ключ сохранён/, 'the field says that a key is already stored');

  // The voice hint follows the provider.
  assert.ok(
    textOf(mounted.tree).includes('id голоса провайдера'),
    'the voice control explains that the id belongs to the provider',
  );

  base.props.onChange({ target: { value: 'https://api.openai.com/v1' } });
  model.props.onChange({ target: { value: 'tts-1' } });
  key.props.onChange({ target: { value: 'sk-typed-by-the-user' } });
  await mounted.rerender();

  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined, 'Save must become available once something is staged');
  await save.props.onClick();
  await mounted.rerender();

  assert.deepEqual(
    writes,
    [
      ['set', 'ttsProvider', 'custom'],
      ['set', 'customBaseUrl', 'https://api.openai.com/v1'],
      ['set', 'customModel', 'tts-1'],
      ['set', 'customApiKey', 'sk-typed-by-the-user'],
    ],
    'one write per field, and the key is written because something was typed',
  );
});

await test('the key is written only when something was typed, and the reset stages an unset', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => configPayload(settings, { ttsProvider: 'custom', customApiKeySet: true }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings, ttsProvider: 'custom' },
      base: {},
      user: {},
      revision: 22,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);
  const key = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'API Key эндпоинта',
  );
  assert.ok(key !== undefined, 'the key field must be on screen for the custom provider');
  assert.equal(key.props.value, '', 'the field starts empty even when a key is stored');

  // The reset control stages the unset, and nothing else.
  const reset = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сбросить ключ',
  );
  assert.ok(reset !== undefined, 'the card must offer a way to drop the stored key');
  reset.props.onClick();
  await mounted.rerender();

  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить' && node.props.disabled === false,
  );
  assert.ok(save !== undefined);
  await save.props.onClick();
  await mounted.rerender();

  assert.deepEqual(writes, [['unset', 'customApiKey']], 'the key is unset, never written empty');
});

await test('a card that never typed a key writes no key at all', async () => {
  const mini = createMiniReact();
  const settings = resolveVoiceConfig({});
  const stubFetch = async () => ({
    ok: true,
    json: async () => configPayload(settings, { ttsProvider: 'custom', customApiKeySet: false }),
  });
  const component = loadCardComponent(mini.react, { fetch: stubFetch });

  const writes = [];
  const scope = recordingScope(
    {
      status: 'ready',
      value: { ...settings, ttsProvider: 'custom' },
      base: {},
      user: {},
      revision: 23,
      writable: true,
      mode: 'host',
    },
    writes,
  );

  const mounted = await mountCard(component, { scope }, mini);
  const key = elementsOf(mounted.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'API Key эндпоинта',
  );
  assert.ok(key !== undefined);
  assert.match(key.props.placeholder, /не задан/, 'the field says that no key is stored');

  // Nothing was touched, so nothing is written.
  const save = elementsOf(mounted.tree).find(
    (node) => node.type === 'button' && textOf(node) === 'Сохранить',
  );
  assert.equal(save.props.disabled, true, 'Save stays disabled while nothing is staged');
  assert.deepEqual(writes, []);
});

// ---------------------------------------------------------------------------
console.log('\nvoice playback (rendered, no browser)');

/**
 * A promise the test resolves by hand.
 * @returns `{ promise, resolve, reject }`.
 */
function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake `<audio>` element: enough of HTMLMediaElement for the bundle, with a
 * `play()` the test resolves by hand — so a part can be made to arrive late.
 * @param url - The source the bundle asked for.
 * @returns The fake element.
 */
function createFakeAudio(url) {
  const audio = {
    url,
    src: url,
    crossOrigin: '',
    preload: '',
    paused: true,
    playing: false,
    plays: 0,
    pauses: 0,
    srcRemoved: false,
    onended: null,
    onerror: null,
    /** When set, `play()` waits for this deferred instead of resolving. */
    deferred: null,
    play() {
      audio.plays += 1;
      if (audio.deferred === null) {
        audio.playing = true;
        audio.paused = false;
        return Promise.resolve();
      }
      // The element really starts sounding once the deferred resolves — even
      // if it was stopped meanwhile. Only the bundle can silence it again.
      return audio.deferred.promise.then(() => {
        audio.playing = true;
        audio.paused = false;
      });
    },
    pause() {
      audio.pauses += 1;
      audio.playing = false;
      audio.paused = true;
    },
    removeAttribute(name) {
      if (name === 'src') audio.srcRemoved = true;
    },
  };
  return audio;
}

/**
 * The host the browser half talks to: `/speak` answers with a part list,
 * `/preview` with an MP3, `/config` with the preset table the card renders.
 * @param parts - The parts `/speak` answers with.
 * @param manifest - Extra keys for the `/speak` manifest (the visualization
 *   variant travels with it).
 * @returns `{ fetchStub, calls }`: the stub and the calls it saw.
 */
function makeHostFetch(parts, manifest = {}) {
  const settings = resolveVoiceConfig({});
  const calls = [];
  const fetchStub = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.startsWith('/dsh-voice-v/speak')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, parts, ...manifest }) };
    }
    if (target.startsWith('/dsh-voice-v/preview')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        blob: async () => ({ size: 4, type: 'audio/mpeg' }),
      };
    }
    if (target.startsWith('/dsh-voice-v/config')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          presetList: describePresets(settings),
          rateRange: RATE_RANGE,
          pitchRange: PITCH_RANGE,
          dictionaryDefaults: DEFAULT_PRONUNCIATION,
          defaultPreviewText: DEFAULT_PREVIEW_TEXT,
          settingsRegistered: true,
        }),
      };
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  return { fetchStub, calls };
}

/**
 * The browser globals the bundle expects. A `vm` context has none of them, so
 * the host's abort controller, object-URL factory, timers, and fetch stub are
 * handed over here. The timers never fire on their own: the tests do not
 * wait four seconds for a failure note to fade.
 * @param fetchStub - The host stub.
 * @returns The globals for the bundle's sandbox.
 */
function browserGlobals(fetchStub) {
  const timers = [];
  return {
    fetch: fetchStub,
    AbortController,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: (id) => {
      if (typeof id === 'number') timers[id - 1] = null;
    },
    URL: {
      createObjectURL: () => 'blob:dsh-voice-v/preview',
      revokeObjectURL: () => {},
    },
  };
}

/**
 * Mount the speaker button under one message and drive it.
 * @param button - The button component.
 * @param messageId - The message the button speaks.
 * @param harness - The harness instance for this component.
 * @returns `{ mounted, click, phase }`.
 */
async function mountVoiceButton(button, messageId, harness) {
  const mounted = await mountComponent(button, { messageId, sessionId: 'session-1' }, harness);
  const node = () => elementsOf(mounted.tree).find((entry) => entry.type === 'button');
  return {
    mounted,
    /** Click the button and let the effects settle. */
    click: async () => {
      const target = node();
      assert.ok(target !== undefined, 'the speaker button must render');
      target.props.onClick();
      await mounted.rerender();
    },
    /** The phase the button shows right now. */
    phase: () => node().props['data-phase'],
  };
}

await test('the voice of a new message stops the voice still playing on another', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3', chars: 12, cached: true }]);
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const first = await mountVoiceButton(button, 'm1', mini);
  const second = await mountVoiceButton(button, 'm2', mini.instance());

  await first.click();
  assert.equal(first.phase(), 'playing', 'the first voice must start');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].playing, true, 'the first element must be the only sound');

  await second.click();
  await first.mounted.rerender();

  assert.equal(elements[0].paused, true, 'the voice of the first message must stop');
  assert.equal(elements[0].playing, false);
  assert.equal(elements[0].srcRemoved, true, 'the stopped element must be reset');
  assert.equal(first.phase(), 'idle', 'the first button must fall back to idle');
  assert.equal(second.phase(), 'playing', 'the second button must own the sound');
  assert.equal(audio.label(), 'message:m2', 'the shared player must report the new voice as the active one');
  assert.equal(elements.length, 2);
  assert.equal(elements[1].playing, true, 'the new voice must be the only sound');
});

await test('two clicks on the same message button play and stop the voice', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }]);
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);

  await only.click();
  assert.equal(only.phase(), 'playing', 'the first click must start the voice');
  assert.equal(audio.label(), 'message:m1');
  assert.equal(elements[0].playing, true);

  await only.click();
  assert.equal(only.phase(), 'idle', 'the second click must stop the voice');
  assert.equal(elements[0].paused, true);
  assert.equal(elements[0].srcRemoved, true);
  assert.equal(audio.label(), '', 'the shared slot must be free again');
  assert.equal(audio.owner(), null, 'no owner may keep the slot');
});

await test('the card preview and a message voice take turns, never both', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }]);
  const { card, button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const settings = resolveVoiceConfig({});
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...settings },
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  };
  const mountedCard = await mountCard(card, { scope }, mini);
  const message = await mountVoiceButton(button, 'm1', mini.instance());

  await message.click();
  assert.equal(elements[0].playing, true, 'the message voice must start');

  const listen = elementsOf(mountedCard.tree).find(
    (node) => node.type === 'button' && textOf(node).includes('Прослушать'),
  );
  assert.ok(listen !== undefined, 'the card must own the audition button');
  listen.props.onClick();
  await mountedCard.rerender();
  await message.mounted.rerender();

  assert.equal(elements[0].paused, true, 'the message voice must stop for the preview');
  assert.equal(elements[0].playing, false);
  assert.equal(message.phase(), 'idle');
  assert.equal(audio.label(), 'preview', 'the shared player must report the preview as the active sound');
  assert.equal(elements.length, 2);
  assert.equal(elements[1].playing, true, 'the preview must be the only sound');

  await message.click();
  await mountedCard.rerender();

  assert.equal(elements[1].paused, true, 'the preview must stop for the message voice');
  assert.equal(elements[1].playing, false);
  assert.equal(audio.label(), 'message:m1', 'the message voice must be the active sound');
  assert.equal(elements.length, 3);
  assert.equal(elements[2].playing, true);
});

await test('a voice that arrives late does not steal the output from the newer one', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }]);
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  const late = deferred();
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    // The first voice only finishes loading after the second one started.
    if (elements.length === 0) element.deferred = late;
    elements.push(element);
    return element;
  });

  const first = await mountVoiceButton(button, 'm1', mini);
  const second = await mountVoiceButton(button, 'm2', mini.instance());

  await first.click();
  assert.equal(first.phase(), 'playing', 'the first voice is loading');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].playing, false, 'the first element is still loading');

  await second.click();
  await first.mounted.rerender();
  assert.equal(elements[0].paused, true, 'the loading voice must be stopped');
  assert.equal(second.phase(), 'playing');
  assert.equal(audio.label(), 'message:m2');

  // The late arrival: the first element finishes loading now.
  late.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await first.mounted.rerender();

  assert.equal(elements[0].playing, false, 'the late voice must not start playing');
  assert.equal(elements[0].pauses >= 2, true, 'the late voice must be silenced again');
  assert.equal(elements[1].playing, true, 'the newer voice keeps the output');
  assert.equal(audio.label(), 'message:m2', 'the newer start stays the active one');
  assert.equal(second.phase(), 'playing');
});

await test('a button that goes away stops the voice it started', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }]);
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();
  assert.equal(elements[0].playing, true, 'the voice must start');

  // The row leaves the chat: the effect cleanups run.
  for (const cleanup of mini.cleanups()) cleanup();

  assert.equal(elements[0].paused, true, 'the voice must stop with the button');
  assert.equal(elements[0].playing, false);
  assert.equal(audio.label(), '', 'the shared slot must be free again');
  assert.equal(audio.owner(), null);
});

// ---------------------------------------------------------------------------
console.log('\nthe visualization (rendered, no browser)');

/**
 * A fake audio context: enough of the Web Audio API for the analysis path,
 * with a ledger of what was connected to what.
 * @param options - `staysSuspended` keeps the context from ever starting.
 * @returns `{ context, ledger }`.
 */
function createFakeAudioContext(options = {}) {
  const ledger = {
    state: 'suspended',
    elements: [],
    analysers: [],
    connections: [],
    disconnections: 0,
    resumed: 0,
    closed: 0,
  };
  const context = {
    get state() {
      return ledger.state;
    },
    destination: { id: 'destination' },
    createMediaElementSource(element) {
      // A strict browser refuses a media element that is not in an anonymous
      // cross-origin mode.
      if (options.strictCrossOrigin === true && element.crossOrigin !== 'anonymous') {
        throw new Error('the media element must be anonymous');
      }
      ledger.elements.push(element);
      return {
        connect(node) {
          ledger.connections.push(['source', node]);
        },
        disconnect() {
          ledger.disconnections += 1;
        },
      };
    },
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        frequencyBinCount: 32,
        connect(node) {
          ledger.connections.push(['analyser', node]);
        },
        disconnect() {
          ledger.disconnections += 1;
        },
        getByteFrequencyData(data) {
          for (let index = 0; index < data.length; index += 1) data[index] = (index * 9) % 256;
        },
        getByteTimeDomainData(data) {
          for (let index = 0; index < data.length; index += 1) {
            data[index] = 128 + Math.round(40 * Math.sin(index / 3));
          }
        },
      };
      ledger.analysers.push(analyser);
      return analyser;
    },
    resume() {
      ledger.resumed += 1;
      if (options.staysSuspended !== true) ledger.state = 'running';
      return Promise.resolve();
    },
    close() {
      ledger.closed += 1;
      ledger.state = 'closed';
      return Promise.resolve();
    },
  };
  return { context, ledger };
}

/**
 * A fake document: the bundle injects its stylesheet through it, and the
 * visualization makes its canvas through it.
 * @returns `{ document, ledger }` — the ledger counts the canvas work.
 */
function createFakeDocument() {
  const ledger = { canvases: [], draws: 0, styles: 0 };
  const makeContext = () => ({
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setTransform() {},
    clearRect() {
      ledger.draws += 1;
    },
    fillRect() {
      ledger.draws += 1;
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      ledger.draws += 1;
    },
  });
  const document = {
    querySelector: () => null,
    head: {
      appendChild: () => {
        ledger.styles += 1;
      },
    },
    createElement: (tag) => {
      if (tag === 'canvas') {
        const canvas = { width: 0, height: 0, getContext: () => makeContext() };
        ledger.canvases.push(canvas);
        return canvas;
      }
      return { dataset: {}, textContent: '' };
    },
  };
  return { document, ledger };
}

/**
 * A fake animation frame queue: the test drives the frames by hand.
 * @returns `{ globals, frames }`.
 */
function createFakeFrames() {
  const frames = [];
  return {
    frames,
    globals: {
      requestAnimationFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: (id) => {
        if (typeof id === 'number') frames[id - 1] = null;
      },
    },
  };
}

/**
 * The visualization element inside a rendered tree.
 * @param tree - The rendered tree.
 * @returns The element, or undefined.
 */
function visualizationOf(tree) {
  return elementsOf(tree).find(
    (node) => node.props !== undefined && typeof node.props.className === 'string' && node.props.className.startsWith('dvv-vis'),
  );
}

await test('with the visualization off, a playing message shows no visualization', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'off' });
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(elements[0].playing, true, 'the voice must sound');
  assert.equal(visualizationOf(only.mounted.tree), undefined, 'the button must show no visualization');
});

await test('a chosen variant shows the visualization inside the message button, and it goes with the sound', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'dots' });
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();
  assert.equal(only.phase(), 'playing');

  // The visualization lives inside the button, and it takes the glyph's place.
  const buttonNode = elementsOf(only.mounted.tree).find((node) => node.type === 'button');
  const visualization = visualizationOf(only.mounted.tree);
  assert.ok(visualization !== undefined, 'the button must show the visualization while the voice plays');
  assert.equal(visualization.props['data-variant'], 'dots');
  assert.ok(elementsOf(buttonNode).includes(visualization), 'the visualization must be inside the button');
  assert.equal(buttonNode.props['data-phase'], 'playing', 'the button keeps its own state');
  assert.equal(
    elementsOf(buttonNode).some((node) => node.type === 'svg'),
    false,
    'the visualization takes the glyph\'s place',
  );

  // The voice stops: the visualization goes with it.
  await only.click();
  assert.equal(only.phase(), 'idle');
  assert.equal(visualizationOf(only.mounted.tree), undefined, 'the visualization must go when the voice stops');
});

await test('a voice taken away by another message switches its visualization off', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'pulse' });
  const { button, audio } = loadClientComponents(mini.react, browserGlobals(fetchStub));
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const first = await mountVoiceButton(button, 'm1', mini);
  const second = await mountVoiceButton(button, 'm2', mini.instance());

  await first.click();
  assert.ok(visualizationOf(first.mounted.tree) !== undefined, 'the first message shows its visualization');

  await second.click();
  await first.mounted.rerender();

  assert.equal(visualizationOf(first.mounted.tree), undefined, 'the taken visualization must switch off');
  assert.ok(visualizationOf(second.mounted.tree) !== undefined, 'the new voice shows its own visualization');
});

await test('the analysed variant routes the playing element through the analyser and draws', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'bars' });
  const { context, ledger } = createFakeAudioContext();
  const { document: fakeDocument, ledger: documentLedger } = createFakeDocument();
  const frames = createFakeFrames();
  const { button, audio } = loadClientComponents(
    mini.react,
    {
      ...browserGlobals(fetchStub),
      AudioContext: function AudioContextStub() {
        return context;
      },
      document: fakeDocument,
      ...frames.globals,
    },
  );
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(ledger.resumed, 1, 'the context must be started inside the click');
  assert.equal(ledger.elements.length, 1, 'the analyser must be attached to the element the player created');
  assert.equal(ledger.elements[0], elements[0], 'the element is the one the player made');
  assert.ok(
    ledger.connections.some(([from]) => from === 'source'),
    'the source must be connected to the analyser',
  );
  assert.ok(
    ledger.connections.some(([from, to]) => from === 'analyser' && to === context.destination),
    'the analyser must reach the destination, or the sound would stop',
  );
  assert.equal(documentLedger.canvases.length, 1, 'the visualization must own a canvas');
  assert.ok(documentLedger.draws > 0, 'the visualization must draw');
  assert.ok(frames.frames.length > 0, 'the drawing must be animated');

  // The visualization is inside the button, and it is the analysed one.
  const buttonNode = elementsOf(only.mounted.tree).find((node) => node.type === 'button');
  const visualization = visualizationOf(only.mounted.tree);
  assert.ok(visualization !== undefined, 'the button must show the visualization');
  assert.equal(visualization.props['data-variant'], 'bars');
  assert.ok(elementsOf(buttonNode).includes(visualization), 'the visualization must be inside the button');
});

await test('a context that never starts leaves the element alone and the voice plays', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'bars' });
  const { context, ledger } = createFakeAudioContext({ staysSuspended: true });
  const { document: fakeDocument, ledger: documentLedger } = createFakeDocument();
  const { button, audio } = loadClientComponents(
    mini.react,
    {
      ...browserGlobals(fetchStub),
      AudioContext: function AudioContextStub() {
        return context;
      },
      document: fakeDocument,
    },
  );
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(elements[0].playing, true, 'the sound must play');
  assert.equal(ledger.elements.length, 0, 'the element must not be re-routed');
  assert.equal(ledger.analysers.length, 0, 'no analyser may be created');
  assert.equal(documentLedger.canvases.length, 0, 'there is nothing to draw');
  assert.equal(visualizationOf(only.mounted.tree), undefined, 'the button shows no visualization');
});

await test('a browser without the Web Audio API plays the voice and shows no visualization', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'wave' });
  const { document: fakeDocument, ledger: documentLedger } = createFakeDocument();
  const { button, audio } = loadClientComponents(mini.react, {
    ...browserGlobals(fetchStub),
    document: fakeDocument,
  });
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(elements[0].playing, true, 'the sound must play');
  assert.equal(documentLedger.canvases.length, 0, 'there is nothing to draw');
  assert.equal(visualizationOf(only.mounted.tree), undefined, 'the button shows no visualization');
});

await test('a context that cannot be created leaves the element alone and the voice plays', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'bars' });
  const { button, audio } = loadClientComponents(mini.react, {
    ...browserGlobals(fetchStub),
    AudioContext: function AudioContextStub() {
      throw new Error('no audio here');
    },
  });
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(elements[0].playing, true, 'the sound must play');
  assert.equal(visualizationOf(only.mounted.tree), undefined, 'the button shows no visualization');
});

await test('a browser that demands an anonymous cross-origin mode still gets the sound', async () => {
  const mini = createMiniReact();
  const { fetchStub } = makeHostFetch([{ url: '/dsh-voice-v/audio/part-1.mp3' }], { spectrum: 'bars' });
  const { context, ledger } = createFakeAudioContext({ strictCrossOrigin: true });
  const { document: fakeDocument, ledger: documentLedger } = createFakeDocument();
  const { button, audio } = loadClientComponents(
    mini.react,
    {
      ...browserGlobals(fetchStub),
      URL,
      location: { href: 'http://127.0.0.1/dsh/chat' },
      AudioContext: function AudioContextStub() {
        return context;
      },
      document: fakeDocument,
    },
  );
  const elements = [];
  audio.setCreateElement((url) => {
    const element = createFakeAudio(url);
    elements.push(element);
    return element;
  });

  const only = await mountVoiceButton(button, 'm1', mini);
  await only.click();

  assert.equal(only.phase(), 'playing', 'the voice must start');
  assert.equal(elements[0].playing, true, 'the sound must play');
  assert.equal(ledger.elements.length, 1, 'the element must end up in the graph');
  assert.equal(elements[0].crossOrigin, 'anonymous', 'the element must be made anonymous for the retry');
  assert.ok(documentLedger.draws > 0, 'the visualization must draw');
});

console.log('');
if (failed > 0) {
  console.error(`dsh-voice-v settings tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`dsh-voice-v settings tests: ${passed} passed, 0 failed`);
