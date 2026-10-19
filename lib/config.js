/**
 * dsh-voice-v configuration: defaults, the named rate/pitch presets, and the
 * single resolver the host route hands every synthesis call.
 *
 * Every value here is overridable from the plugin row's `config` in
 * cordis.patch.yml (or the profile's own patch layer) — no code edit is needed
 * to change the voice, the tempo, or the pitch.
 *
 * @module dsh-voice-v/config
 */

import { DEFAULT_PRONUNCIATION } from './text.js';

/** Absolute path of the `edge-tts` CLI shipped with the local Python runtime. */
export const DEFAULT_EDGE_TTS_BIN =
  'C:\\Users\\ZEROTOOL\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\edge-tts.exe';

/** Female Russian neural voice used by default. */
export const DEFAULT_VOICE = 'ru-RU-SvetlanaNeural';

/**
 * The voice catalogue the settings card renders.
 *
 * The service itself is the authority here: for Russian it offers exactly two
 * voices — `ru-RU-SvetlanaNeural` and `ru-RU-DmitryNeural`. The older Russian
 * female voices (Dariya, Dasha, Polina, Zhanna, Masha) were retired and now
 * fail with `NoAudioReceived`, so they are not offered at all. The five
 * multilingual voices below read Russian correctly and accept the plugin's
 * `--rate` / `--pitch` / `--volume`, so they are the way to a different timbre
 * for the same text.
 *
 * The label keeps the id visible: the id is what goes to edge-tts, and a user
 * who has to type one by hand needs to see it. The catalogue is data, not
 * behaviour — a deployment extends or replaces it through `config.voices` (see
 * {@link describeVoices}), and the card never hard-codes it.
 *
 * The multilingual voices carry the note «с акцентом»: they read Russian
 * correctly, but with a foreign accent, and the user should know that before
 * choosing one. The native Russian voices have no such note.
 */
export const VOICE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'ru-RU-SvetlanaNeural',
    label: 'Светлана · ru-RU-SvetlanaNeural',
    group: 'Русские',
  }),
  Object.freeze({
    id: 'ru-RU-DmitryNeural',
    label: 'Дмитрий · ru-RU-DmitryNeural',
    group: 'Русские',
  }),
  Object.freeze({
    id: 'en-US-AvaMultilingualNeural',
    label: 'Ава · en-US-AvaMultilingualNeural · с акцентом',
    group: 'Мультиязычные',
  }),
  Object.freeze({
    id: 'en-US-EmmaMultilingualNeural',
    label: 'Эмма · en-US-EmmaMultilingualNeural · с акцентом',
    group: 'Мультиязычные',
  }),
  Object.freeze({
    id: 'de-DE-SeraphinaMultilingualNeural',
    label: 'Серафина · de-DE-SeraphinaMultilingualNeural · с акцентом',
    group: 'Мультиязычные',
  }),
  Object.freeze({
    id: 'fr-FR-VivienneMultilingualNeural',
    label: 'Вивьен · fr-FR-VivienneMultilingualNeural · с акцентом',
    group: 'Мультиязычные',
  }),
  Object.freeze({
    id: 'pt-BR-ThalitaMultilingualNeural',
    label: 'Талита · pt-BR-ThalitaMultilingualNeural · с акцентом',
    group: 'Мультиязычные',
  }),
]);

/** The group a deployment voice lands in when it names none of its own. */
export const VOICE_GROUP_OTHER = 'Другие';

/**
 * Named presets — pure data. `zhivoy` is the default: a small lift in tempo and
 * pitch that reads as a lively narrator without the syrupy quality a larger
 * lift produces. `neytralnyy` is the flat edge-tts baseline; the other three
 * are character directions. A preset may also be defined by the deployment
 * (see `presets` in `resolveVoiceConfig`), so the interface never hard-codes
 * this table: it reads {@link describePresets} off the live config route.
 */
export const DEFAULT_PRESETS = Object.freeze({
  zhivoy: Object.freeze({ rate: '+6%', pitch: '+12Hz' }),
  neytralnyy: Object.freeze({ rate: '0', pitch: '0' }),
  spokoiny: Object.freeze({ rate: '-6%', pitch: '-8Hz' }),
  derzkiy: Object.freeze({ rate: '+10%', pitch: '+6Hz' }),
  ustaly: Object.freeze({ rate: '-12%', pitch: '-15Hz' }),
});

/**
 * Human labels for the shipped presets: the settings card renders whatever the
 * live config route reports, so a deployment-defined preset still gets a card.
 * A preset absent here is labelled by its id.
 */
export const PRESET_LABELS = Object.freeze({
  zhivoy: Object.freeze({ label: 'Живой', hint: 'дефолт: бодрый темп и выше тон' }),
  neytralnyy: Object.freeze({ label: 'Нейтральный', hint: 'ровно, без подъёма' }),
  spokoiny: Object.freeze({ label: 'Спокойный', hint: 'медленнее и ниже' }),
  derzkiy: Object.freeze({ label: 'Дерзкий', hint: 'быстрее и чуть выше' }),
  ustaly: Object.freeze({ label: 'Усталый', hint: 'совсем медленно и низко' }),
});

/** Preset applied when the config names none. */
export const DEFAULT_PRESET = 'zhivoy';

/**
 * Slider domain for the tempo, in percent. The card renders these bounds and
 * `/preview` rejects nothing inside them; a deployment may still put any
 * literal it likes in the config layer.
 */
export const RATE_RANGE = Object.freeze({ min: -30, max: 40, step: 1 });

/** Slider domain for the pitch, in Hz. */
export const PITCH_RANGE = Object.freeze({ min: -40, max: 40, step: 1 });

/** Whether a fenced code block and a table are skipped by default. */
export const DEFAULT_STRIP_CODE = true;

/**
 * Whether the narration preset is picked from the tone of the message by
 * default. The user asked for the behaviour, so it is on until it is turned
 * off in the card.
 */
export const DEFAULT_AUTO_PRESET = true;

/** Text the settings card previews when the caller supplies none. */
export const DEFAULT_PREVIEW_TEXT =
  'Привет! Так звучит этот голос на текущих настройках. Проверка темпа и высоты тона.';

/**
 * Namespace this plugin owns in the Host settings surface. The namespace is the
 * Loader row id: `dsh-settings` derives it from each entry's own `options.id`
 * and reads the schema from this package's exported `Config`, so the Host half
 * declares it and the browser card reads it — both spell it from here so the two
 * halves cannot drift. The row must be mounted under this id; a row mounted
 * under another id serves no form for it (see `lib/host-settings.js`).
 */
export const SETTINGS_NAMESPACE = 'dsh-voice-v';

/**
 * The visualization variants the message button can show while a voice plays.
 *
 * The ids are the setting's value; the labels are what the settings card
 * offers. `off` switches the visualization off, `bars` and `wave` are the real
 * ones — a frequency spectrum and an oscilloscope, both driven by the audio
 * itself — and `pulse` and `dots` are pure CSS, so they keep working where
 * the Web Audio API is unavailable.
 */
export const SPECTRUM_VARIANTS = Object.freeze([
  Object.freeze({ id: 'off', label: 'Выключено' }),
  Object.freeze({ id: 'bars', label: 'Спектр' }),
  Object.freeze({ id: 'wave', label: 'Волна' }),
  Object.freeze({ id: 'pulse', label: 'Пульс' }),
  Object.freeze({ id: 'dots', label: 'Точки' }),
]);

/** The variant applied when the setting says nothing usable. */
export const DEFAULT_SPECTRUM = 'bars';

/** The variant that switches the visualization off. */
export const SPECTRUM_OFF = 'off';

/**
 * Fields the settings card owns. Every one of them is `.volatile()` in
 * {@link buildSettingsSchema} — that marker is what puts the field in the
 * derived settings form — and everything else stays in the plugin row's `config`
 * as a deployment-only key.
 */
export const SETTINGS_FIELDS = Object.freeze([
  'preset',
  'rate',
  'pitch',
  'voice',
  'stripCode',
  'autoPreset',
  'dictionary',
  'userPresets',
  'spectrum',
]);

/**
 * Prefix every user preset id carries.
 *
 * The prefix is what keeps a user's own preset from ever shadowing a built-in
 * one: the shipped ids are `zhivoy`, `neytralnyy`, `spokoiny`, `derzkiy` and
 * `ustaly`, and none of them starts with it. The card derives the id from the
 * name the user typed, so the same name always lands on the same preset.
 */
export const USER_PRESET_ID_PREFIX = 'user-';

/** Tempo used when neither the preset nor an explicit `rate` resolves one. */
export const DEFAULT_RATE = '+6%';

/** Pitch used when neither the preset nor an explicit `pitch` resolves one. */
export const DEFAULT_PITCH = '+12Hz';

/** Volume passed to edge-tts. */
export const DEFAULT_VOLUME = '+0%';

/** Longest single synthesis chunk; longer answers are trimmed at sentence edges. */
export const DEFAULT_MAX_CHUNK_CHARS = 320;

/** Longest accepted message text, a guard against a pathological request. */
export const DEFAULT_MAX_TEXT_CHARS = 24000;

/** Per-invocation edge-tts timeout. */
export const DEFAULT_TIMEOUT_MS = 60000;

/** Concurrent background warm-ups of not-yet-synthesized chunks. */
export const DEFAULT_WARM_CONCURRENCY = 2;

/**
 * Normalize an edge-tts rate literal: a bare number gains a sign and `%`
 * (`0` → `+0%`, `6` → `+6%`), an already-shaped literal is kept verbatim.
 * @param value - Raw rate from config or a preset.
 * @returns The literal edge-tts expects on `--rate`.
 */
export function normalizeRate(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '+0%';
  const match = /^([+-]?)(\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  if (match === null) return raw;
  return `${match[1] === '-' ? '-' : '+'}${match[2]}%`;
}

/**
 * Normalize an edge-tts pitch literal: a bare number gains a sign and `Hz`
 * (`0` → `+0Hz`, `12` → `+12Hz`), an already-shaped literal is kept verbatim.
 * @param value - Raw pitch from config or a preset.
 * @returns The literal edge-tts expects on `--pitch`.
 */
export function normalizePitch(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '+0Hz';
  const match = /^([+-]?)(\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(raw);
  if (match === null) return raw;
  return `${match[1] === '-' ? '-' : '+'}${match[2]}Hz`;
}

/**
 * Normalize an edge-tts volume literal.
 * @param value - Raw volume from config.
 * @returns The literal edge-tts expects on `--volume`.
 */
export function normalizeVolume(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return DEFAULT_VOLUME;
  const match = /^([+-]?)(\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  if (match === null) return raw;
  return `${match[1] === '-' ? '-' : '+'}${match[2]}%`;
}

/**
 * Read a rate literal as a signed percent number, the unit the slider speaks.
 * @param value - `'+6%'`, `'-12%'`, `6`, `'0'`, or anything else.
 * @returns The number, or `null` when the value carries no usable number.
 */
export function parseRatePct(value) {
  const match = /^([+-]?\d+(?:\.\d+)?)\s*%?$/.exec(String(value ?? '').trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Read a pitch literal as a signed Hz number.
 * @param value - `'+12Hz'`, `'-8Hz'`, `12`, or anything else.
 * @returns The number, or `null` when the value carries no usable number.
 */
export function parsePitchHz(value) {
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(String(value ?? '').trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Clamp a number into a slider domain, leaving unusable input at the low bound.
 * @param value - Candidate number.
 * @param range - `{ min, max }` domain.
 * @returns The clamped number.
 */
export function clampToRange(value, range) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return range.min;
  return Math.min(range.max, Math.max(range.min, numeric));
}

/**
 * Read the visualization variant: one of the shipped ids, or the default.
 *
 * A value nobody knows — a hand-edited settings file, a deployment that
 * names a variant this build does not have — falls back to the default
 * instead of breaking the plugin: the visualization is an aesthetic, never a
 * reason for the voice to stop working.
 * @param value - Raw value from the config or the settings section.
 * @returns The variant id.
 */
export function normalizeSpectrum(value) {
  if (!isGiven(value)) return DEFAULT_SPECTRUM;
  const raw = String(value).trim();
  for (const variant of SPECTRUM_VARIANTS) {
    if (variant.id === raw) return raw;
  }
  return DEFAULT_SPECTRUM;
}

/**
 * Read a boolean setting, accepting the strings YAML and HTML produce.
 * @param value - Candidate value.
 * @param fallback - Result when the value is absent or unrecognised.
 * @returns The boolean.
 */
function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  }
  return fallback;
}

/**
 * Whether a value carries a usable setting: a non-blank string or a finite number.
 * @param value - Candidate value from config.
 * @returns True when the value should override its fallback.
 */
function isGiven(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '';
  return false;
}

/**
 * Read a positive integer setting, falling back when absent or unusable.
 * @param value - Candidate value from config.
 * @param fallback - Value used when `value` is not a positive integer.
 * @returns The resolved integer.
 */
function positiveInt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read one preset definition — a built-in, a deployment's, or a user's own.
 *
 * A missing tempo or tone falls back to the built-in defaults, and a voice is
 * kept only when the definition carries one: the key is absent otherwise, so
 * "this preset says nothing about the voice" stays distinguishable from "this
 * preset says the default voice".
 * @param value - Raw preset definition.
 * @returns `{ rate, pitch }` plus `voice` when the definition names one, or
 *   `null` when the value is not a preset definition at all.
 */
function readPresetEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = {
    rate: isGiven(value.rate) ? value.rate : DEFAULT_RATE,
    pitch: isGiven(value.pitch) ? value.pitch : DEFAULT_PITCH,
  };
  if (isGiven(value.voice)) entry.voice = String(value.voice).trim();
  return entry;
}

/**
 * Read one voice entry of a deployment's `voices` list.
 *
 * A list may name voices by id alone (`'ru-RU-DmitryNeural'`) or describe
 * them (`{ id, label, group }`); a label or a group the entry does not carry
 * stays absent, so the merge below can tell "the deployment says nothing about
 * this" from "the deployment says exactly this".
 * @param value - Raw list entry.
 * @returns `{ id }` plus `label` / `group` when the entry named them, or
 *   `null` when the entry names no usable voice.
 */
function readVoiceEntry(value) {
  if (typeof value === 'string') {
    const id = value.trim();
    return id === '' ? null : { id };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isGiven(value.id)) return null;
  const entry = { id: String(value.id).trim() };
  if (isGiven(value.label)) entry.label = String(value.label).trim();
  if (isGiven(value.group)) entry.group = String(value.group).trim();
  return entry;
}

/**
 * Resolve the effective voice settings: preset first, then an explicitly given
 * `rate` / `pitch` / `voice`, which always win over the preset.
 *
 * The preset pool has three layers, and the upper one wins: the user's own
 * presets (`userPresets`, the volatile field the settings card writes), then
 * the deployment's table (`presets`), then the shipped {@link DEFAULT_PRESETS}.
 * A user preset is selectable exactly like a built-in one, and a preset that
 * names a voice lends it to the synthesis unless the user set a voice of their
 * own — the same "absent means inherit" contract the tempo and the tone keep.
 * @param raw - The plugin row's `config` object, or anything else.
 * @returns The frozen effective settings plus the provenance of rate, pitch
 *   and voice.
 */
export function resolveVoiceConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const configuredPresets =
    input.presets !== null && typeof input.presets === 'object' && !Array.isArray(input.presets)
      ? input.presets
      : {};
  const presets = { ...DEFAULT_PRESETS };
  for (const [presetName, presetValue] of Object.entries(configuredPresets)) {
    const entry = readPresetEntry(presetValue);
    if (entry === null) continue;
    presets[presetName] = entry;
  }

  // The user's own presets: the topmost layer of the pool. They are read from
  // the volatile `userPresets` field, so a preset the card saved is a preset
  // the next sentence can use.
  const userPresets = {};
  if (input.userPresets !== null && typeof input.userPresets === 'object' && !Array.isArray(input.userPresets)) {
    for (const [presetId, presetValue] of Object.entries(input.userPresets)) {
      const entry = readPresetEntry(presetValue);
      if (entry === null) continue;
      const label = isGiven(presetValue.label) ? String(presetValue.label).trim() : presetId;
      const own = { label, rate: entry.rate, pitch: entry.pitch };
      if (entry.voice !== undefined) own.voice = entry.voice;
      userPresets[presetId] = own;
      const merged = { rate: entry.rate, pitch: entry.pitch };
      if (entry.voice !== undefined) merged.voice = entry.voice;
      presets[presetId] = merged;
    }
  }

  const requestedPreset = isGiven(input.preset) ? String(input.preset).trim() : DEFAULT_PRESET;
  const presetKnown = Object.prototype.hasOwnProperty.call(presets, requestedPreset);
  const preset = presetKnown ? presets[requestedPreset] : { rate: DEFAULT_RATE, pitch: DEFAULT_PITCH };

  const rateOverridden = isGiven(input.rate);
  const pitchOverridden = isGiven(input.pitch);
  const voiceOverridden = isGiven(input.voice);

  // User dictionary entries override the built-in terms key by key.
  const dictionary = { ...DEFAULT_PRONUNCIATION };
  if (input.dictionary !== null && typeof input.dictionary === 'object' && !Array.isArray(input.dictionary)) {
    for (const [term, spoken] of Object.entries(input.dictionary)) {
      if (typeof term !== 'string' || term === '' || typeof spoken !== 'string' || spoken === '') continue;
      dictionary[term] = spoken;
    }
  }

  return Object.freeze({
    preset: presetKnown ? requestedPreset : DEFAULT_PRESET,
    requestedPreset,
    presetKnown,
    presets: Object.freeze(
      Object.fromEntries(Object.entries(presets).map(([key, value]) => [key, Object.freeze({ ...value })])),
    ),
    userPresets: Object.freeze(
      Object.fromEntries(Object.entries(userPresets).map(([key, value]) => [key, Object.freeze({ ...value })])),
    ),
    voice: voiceOverridden
      ? String(input.voice).trim()
      : isGiven(preset.voice)
        ? String(preset.voice).trim()
        : DEFAULT_VOICE,
    // The deployment's own voice catalogue: the card renders whatever
    // {@link describeVoices} makes of it, the user layer never owns it.
    voices: input.voices === undefined ? null : input.voices,
    rate: normalizeRate(rateOverridden ? input.rate : preset.rate),
    pitch: normalizePitch(pitchOverridden ? input.pitch : preset.pitch),
    volume: normalizeVolume(isGiven(input.volume) ? input.volume : DEFAULT_VOLUME),
    rateOverridden,
    pitchOverridden,
    voiceOverridden,
    binPath: isGiven(input.binPath) ? String(input.binPath).trim() : DEFAULT_EDGE_TTS_BIN,
    cacheDir: isGiven(input.cacheDir) ? String(input.cacheDir).trim() : null,
    dictionary: Object.freeze(dictionary),
    maxChunkChars: positiveInt(input.maxChunkChars, DEFAULT_MAX_CHUNK_CHARS),
    maxTextChars: positiveInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    timeoutMs: positiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    warmConcurrency: positiveInt(input.warmConcurrency, DEFAULT_WARM_CONCURRENCY),
    stripCode: toBoolean(input.stripCode, DEFAULT_STRIP_CODE),
    autoPreset: toBoolean(input.autoPreset, DEFAULT_AUTO_PRESET),
    spectrum: normalizeSpectrum(input.spectrum),
  });
}

/**
 * Project the preset table into the ordered rows the settings card renders, so
 * the interface never hard-codes a preset. A preset the deployment added under
 * `config.presets` appears here too, labelled by its id unless it is one of the
 * shipped five. A preset the user made appears as well, marked `user: true` and
 * labelled with the name the user gave it, so the card can tell its own rows
 * from the shipped ones and offer the delete control on them alone.
 * @param settings - A resolved voice configuration.
 * @returns Ordered `{ id, label, hint, rate, pitch }` rows; a user row carries
 *   `user: true` and, when its preset names one, `voice`.
 */
export function describePresets(settings) {
  const presets = settings?.presets ?? DEFAULT_PRESETS;
  const userPresets = settings?.userPresets ?? {};
  return Object.entries(presets).map(([id, value]) => {
    const rate = normalizeRate(value.rate);
    const pitch = normalizePitch(value.pitch);
    if (Object.prototype.hasOwnProperty.call(userPresets, id)) {
      const own = userPresets[id];
      const row = {
        id,
        label: isGiven(own?.label) ? String(own.label).trim() : id,
        hint: `${rate} / ${pitch}`,
        rate,
        pitch,
        user: true,
      };
      if (isGiven(value.voice)) row.voice = String(value.voice).trim();
      return row;
    }
    const meta = Object.prototype.hasOwnProperty.call(PRESET_LABELS, id) ? PRESET_LABELS[id] : null;
    return {
      id,
      label: meta === null ? id : meta.label,
      hint: meta === null ? `${value.rate} / ${value.pitch}` : meta.hint,
      rate,
      pitch,
    };
  });
}

/**
 * Project the voice catalogue into the ordered rows the settings card renders,
 * so the interface never hard-codes a voice.
 *
 * The shipped {@link VOICE_OPTIONS} are the base; a deployment extends or
 * replaces them through the plugin row's `config.voices`, the same pattern the
 * `presets` key uses:
 *
 *  * `voices: ['id', …]` or `voices: [{ id, label?, group? }, …]` — a list.
 *    An entry whose id the catalogue already knows REPLACES that entry (its
 *    label and its group), an entry with a new id EXTENDS the catalogue and
 *    lands in the group it names, or in {@link VOICE_GROUP_OTHER};
 *  * `voices: { replace: [ … ] }` — the catalogue is exactly that list, and
 *    the shipped voices are gone.
 *
 * The user layer never owns the catalogue: only the `voice` field itself is a
 * user setting, and a voice outside the catalogue is still honoured.
 * @param settings - A resolved voice configuration.
 * @returns Ordered frozen `{ id, label, group }` rows.
 */
export function describeVoices(settings) {
  const raw = settings !== null && typeof settings === 'object' ? settings.voices : undefined;
  const replacing =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.replace);
  const list = replacing ? raw.replace : Array.isArray(raw) ? raw : [];
  const entries = replacing
    ? []
    : VOICE_OPTIONS.map((entry) => ({ id: entry.id, label: entry.label, group: entry.group }));

  for (const value of list) {
    const entry = readVoiceEntry(value);
    if (entry === null) continue;
    const known = entries.find((row) => row.id === entry.id);
    if (known === undefined) {
      entries.push({
        id: entry.id,
        label: entry.label === undefined ? entry.id : entry.label,
        group: entry.group === undefined ? VOICE_GROUP_OTHER : entry.group,
      });
      continue;
    }
    if (entry.label !== undefined) known.label = entry.label;
    if (entry.group !== undefined) known.group = entry.group;
  }

  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/**
 * The composition layer of the settings namespace: only the keys the namespace
 * schema declares, taken from the plugin row's `config`. Everything else in
 * that config (paths, limits, extra presets) stays outside the settings
 * document, where a user has no business editing it.
 * @param config - The plugin row's raw `config` object.
 * @returns A plain object holding just the settings-ownable keys.
 */
export function pickSettingsBase(config) {
  const input = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const base = {};
  if (isGiven(input.preset)) base.preset = String(input.preset).trim();
  if (isGiven(input.rate)) base.rate = normalizeRate(input.rate);
  if (isGiven(input.pitch)) base.pitch = normalizePitch(input.pitch);
  if (isGiven(input.voice)) base.voice = String(input.voice).trim();
  if (input.stripCode !== undefined) base.stripCode = toBoolean(input.stripCode, DEFAULT_STRIP_CODE);
  if (input.autoPreset !== undefined) base.autoPreset = toBoolean(input.autoPreset, DEFAULT_AUTO_PRESET);
  if (isGiven(input.spectrum)) base.spectrum = normalizeSpectrum(input.spectrum);
  if (input.dictionary !== null && typeof input.dictionary === 'object' && !Array.isArray(input.dictionary)) {
    const dictionary = {};
    for (const [term, spoken] of Object.entries(input.dictionary)) {
      if (typeof term !== 'string' || term === '' || typeof spoken !== 'string' || spoken === '') continue;
      dictionary[term] = spoken;
    }
    if (Object.keys(dictionary).length > 0) base.dictionary = dictionary;
  }
  if (input.userPresets !== null && typeof input.userPresets === 'object' && !Array.isArray(input.userPresets)) {
    const userPresets = {};
    for (const [presetId, preset] of Object.entries(input.userPresets)) {
      if (typeof presetId !== 'string' || presetId === '') continue;
      if (preset === null || typeof preset !== 'object' || Array.isArray(preset)) continue;
      const entry = {};
      if (isGiven(preset.label)) entry.label = String(preset.label).trim();
      if (isGiven(preset.rate)) entry.rate = preset.rate;
      if (isGiven(preset.pitch)) entry.pitch = preset.pitch;
      if (isGiven(preset.voice)) entry.voice = String(preset.voice).trim();
      userPresets[presetId] = entry;
    }
    if (Object.keys(userPresets).length > 0) base.userPresets = userPresets;
  }
  return base;
}

/**
 * Project a resolved settings section down to the fields this namespace owns.
 *
 * The namespace schema passes unknown keys through (schemastery `object` is
 * lenient), and an existing `settings.yaml` may hold keys a user typed by hand.
 * Only the declared fields may override the composition layer, so anything else
 * in the section is dropped here rather than shadowing the plugin row's config.
 * @param section - The resolved section from `settings.get(namespace)`.
 * @returns A plain object holding only {@link SETTINGS_FIELDS}.
 */
export function pickSettingsSection(section) {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {};
  const picked = {};
  for (const field of SETTINGS_FIELDS) {
    if (section[field] !== undefined) picked[field] = section[field];
  }
  return picked;
}

/**
 * Build the schema of the visualization field: the shipped variants and
 * nothing else.
 *
 * The schemastery this plugin resolves at runtime offers `const` and `union`,
 * and the field uses them: the allow-list is then the schema itself. A copy
 * that predates them must not break the whole namespace, though, so the field
 * falls back to a plain string — and {@link normalizeSpectrum} keeps the
 * allow-list either way.
 *
 * `loose` is what makes an unknown value harmless: the schema hands the
 * default back instead of failing the entry, so a hand-edited settings file
 * with a variant this build does not know costs the user nothing but the
 * visualization they asked for.
 * @param z - The schemastery namespace (`import('@deepseek-ai/schemastery')`).
 * @returns The field schema.
 */
function buildSpectrumSchema(z) {
  const ids = SPECTRUM_VARIANTS.map((variant) => variant.id);
  const base =
    typeof z.const === 'function' && typeof z.union === 'function'
      ? z.union(ids.map((id) => z.const(id)))
      : z.string();
  return base
    .default(DEFAULT_SPECTRUM)
    .loose(true)
    .description('Визуализация озвучки в сообщении: off, bars, wave, pulse, dots.')
    .volatile();
}

/**
 * Build the schemastery schema for the settings namespace. The schema factory
 * is passed in because the Host half loads schemastery from the profile it runs
 * inside (see `lib/host-settings.js`) rather than importing it at module load.
 *
 * Every field is volatile: the settings card edits exactly these, and a field
 * without `.volatile()` is invisible to `dsh-settings`' `volatileForm`, so the
 * entry would be described with no form at all. `rate` and `pitch` stay
 * undeclared-by-default on purpose — an absent value must leave the preset
 * answering — and `.loose(true)` keeps a value typed by hand (a numeric rate, a
 * `yes`/`off` switch) from failing the whole entry's validation.
 *
 * `rate` and `pitch` are edge-tts literals, not numbers: the config layer and
 * an existing profile patch may already hold `'+6%'` / `'-8Hz'`, and the
 * sliders convert to the same literals before writing, so both layers share one
 * representation and one cache key.
 *
 * `userPresets` is the user's own preset pool: a record of preset id → `{ label,
 * rate, pitch, voice? }`. The shape is `z.dict(z.object({...}))` rather than
 * `z.record(...)` because the schemastery this plugin resolves at runtime
 * (`@deepseek-ai/schemastery`, loaded by `lib/host-settings.js`) has no
 * `record` — `dict` is its record type, and `object` types one entry. The
 * entry's `voice` is optional on purpose: a preset that says nothing about the
 * voice inherits the deployment's.
 * @param z - The schemastery namespace (`import('@deepseek-ai/schemastery')`).
 * @returns The namespace schema.
 */
export function buildSettingsSchema(z) {
  return z.object({
    preset: z
      .string()
      .default(DEFAULT_PRESET)
      .loose(true)
      .description('Имя пресета темпа и тона.')
      .volatile(),
    rate: z.string().loose(true).description('Темп, литерал edge-tts; отсутствует — берётся из пресета.').volatile(),
    pitch: z.string().loose(true).description('Тон, литерал edge-tts; отсутствует — берётся из пресета.').volatile(),
    voice: z.string().loose(true).description('Голос edge-tts.').volatile(),
    stripCode: z
      .boolean()
      .default(DEFAULT_STRIP_CODE)
      .loose(true)
      .description('Вырезать код и таблицы из озвучки.')
      .volatile(),
    autoPreset: z
      .boolean()
      .default(DEFAULT_AUTO_PRESET)
      .loose(true)
      .description('Подбирать пресет темпа и тона по тону сообщения.')
      .volatile(),
    dictionary: z
      .dict(z.any())
      .default({})
      .loose(true)
      .description('Произношение: термин → как читать.')
      .volatile(),
    userPresets: z
      .dict(
        z.object({
          label: z.string().loose(true).description('Название пресета, как его назвал пользователь.'),
          rate: z.union([z.string(), z.number()]).loose(true).description('Темп пресета.'),
          pitch: z.union([z.string(), z.number()]).loose(true).description('Тон пресета.'),
          voice: z.string().loose(true).description('Голос пресета; отсутствует — берётся из настроек.'),
        }),
      )
      .default({})
      .loose(true)
      .description('Свои пресеты: id → { label, rate, pitch, voice? }.')
      .volatile(),
    spectrum: buildSpectrumSchema(z),
  });
}

/**
 * Build the plugin row's full `Config` schema: the fields the settings card
 * owns (volatile, so `dsh-settings` describes this entry and a save reaches the
 * running fiber without a remount) plus the deployment-only keys the card never
 * touches. Those stay non-volatile on purpose — they are read once at mount, so
 * editing one is an ordinary Loader restart, and `volatileForm` keeps them out
 * of the form.
 *
 * The deployment keys are typed loosely (`z.any()` for the free-form preset
 * table, string-or-number for the limits) because a deployment may hand-write a
 * near-miss value; the schema documents the row and validates the fields a user
 * edits, and `resolveVoiceConfig` remains the authority on what a value means.
 * @param z - The schemastery namespace (`import('@deepseek-ai/schemastery')`).
 * @returns The plugin's `Config` schema.
 */
export function buildVoiceConfigSchema(z) {
  return z.object({
    ...buildSettingsSchema(z).dict,
    binPath: z.string().loose(true).description('Путь к edge-tts. Только для развёртывания.'),
    cacheDir: z.string().loose(true).description('Каталог кэша. Только для развёртывания.'),
    volume: z.union([z.string(), z.number()]).loose(true).description('Громкость. Только для развёртывания.'),
    presets: z.any().description('Своя таблица пресетов { rate, pitch }. Только для развёртывания.'),
    voices: z
      .any()
      .description(
        'Каталог голосов: список id или { id, label, group }; { replace: [...] } заменяет каталог целиком. Только для развёртывания.',
      ),
    maxChunkChars: z
      .union([z.number(), z.string()])
      .loose(true)
      .description('Предел одного куска озвучки. Только для развёртывания.'),
    maxTextChars: z
      .union([z.number(), z.string()])
      .loose(true)
      .description('Предел всего текста сообщения. Только для развёртывания.'),
    timeoutMs: z.union([z.number(), z.string()]).loose(true).description('Таймаут edge-tts. Только для развёртывания.'),
    warmConcurrency: z
      .union([z.number(), z.string()])
      .loose(true)
      .description('Параллельные прогревы кусков. Только для развёртывания.'),
  });
}

/**
 * Resolve a one-off preview request: only the values the caller passed, then
 * the named preset, then the built-in defaults. Settings are never consulted,
 * which is what makes `/preview` usable while the document is unwritable or the
 * settings service is not composed at all.
 * @param body - Parsed `/preview` request body.
 * @returns Resolved settings for this one synthesis.
 */
export function resolvePreviewOptions(body) {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const rate = parseRatePct(input.rate);
  const pitch = parsePitchHz(input.pitch);
  return resolveVoiceConfig({
    preset: isGiven(input.preset) ? input.preset : DEFAULT_PRESET,
    ...(rate === null ? {} : { rate: clampToRange(rate, RATE_RANGE) }),
    ...(pitch === null ? {} : { pitch: clampToRange(pitch, PITCH_RANGE) }),
    ...(isGiven(input.voice) ? { voice: input.voice } : {}),
    ...(input.stripCode === undefined ? {} : { stripCode: input.stripCode }),
    ...(input.dictionary !== null && typeof input.dictionary === 'object' && !Array.isArray(input.dictionary)
      ? { dictionary: input.dictionary }
      : {}),
  });
}

/**
 * Build the edge-tts argv. The text never travels through this array: it is
 * written to a UTF-8 temp file and read with `--file`, so no caller text can
 * reach the process through argument parsing.
 * @param options - Voice settings and the two file paths.
 * @returns The argv passed to `spawn(binPath, argv, { shell: false })`.
 */
export function buildEdgeTtsArgs(options) {
  return [
    '--voice',
    options.voice,
    '--rate',
    options.rate,
    '--pitch',
    options.pitch,
    '--volume',
    options.volume,
    '--no-progress',
    '--write-media',
    options.mediaFile,
    '--file',
    options.textFile,
  ];
}
