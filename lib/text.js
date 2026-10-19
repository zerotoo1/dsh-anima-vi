/**
 * dsh-voice-v text preparation: strip everything a narrator must not read out
 * loud (code, tables, links, markup, emoji, service symbols), rewrite
 * technical terms into spoken Russian, and cut the result into sentence-aligned
 * chunks so the first phrase can start playing before the last one exists.
 *
 * @module dsh-voice-v/text
 */

/**
 * Pronunciation dictionary: term → what the Russian voice should actually say.
 * Keys are matched case-insensitively; a key that starts with a letter or digit
 * is matched on whole-word boundaries only, so `ent` never rewrites `content`.
 * Longer keys win over shorter ones.
 *
 * The map started as the game-mod terms and grew into the vocabulary of this
 * project: the plugin and the harness it lives in, the AI stack, the web
 * platform, and the code words that turn up in every answer. It now holds
 * about 130 entries, grouped by where the terms come from.
 *
 * A reading must be what a Russian speaker would actually say, because it is
 * spoken out loud — a wrong reading is worse than no entry at all. A term the
 * Russian voice already reads correctly (`patch`, `token`) is therefore left
 * out on purpose instead of being added as noise.
 */
export const DEFAULT_PRONUNCIATION = Object.freeze({
  redscript: 'редскрипт',
  TweakDB: 'твик-ди-би',
  tweakdb: 'твик-ди-би',
  HUD: 'хад',
  ANIMA: 'анима',
  Cyberpunk: 'сайберпанк',
  cyberpunk: 'сайберпанк',
  CET: 'си-и-ти',
  NCPD: 'эн-си-пи-ди',
  ent: 'энт',
  '.anims': 'анимации',
  anims: 'анимации',
  wolvenkit: 'волвенкит',
  WolvenKit: 'волвенкит',
  archive: 'архив',
  REDmod: 'редмод',
  redmod: 'редмод',
  JSON: 'джейсон',
  API: 'эй-пи-ай',
  GUI: 'гуи',
  UI: 'ю-ай',
  CLI: 'си-эл-ай',
  DSH: 'ди-эс-эйч',
  TTS: 'ти-ти-эс',
  STT: 'ти-эс-ти',
  LLM: 'эл-эл-эм',
  GPU: 'джи-пи-ю',
  CPU: 'си-пи-ю',
  HTTP: 'эйч-ти-ти-пи',
  HTTPS: 'эйч-ти-ти-пи-эс',
  URL: 'ю-ар-эл',
  UUID: 'ю-ю-ай-ди',
  SSH: 'эс-эс-эйч',
  PDF: 'пи-ди-эф',
  CSV: 'си-эс-ви',
  SQL: 'эс-кью-эл',
  PNG: 'пи-эн-джи',
  SVG: 'эс-ви-джи',
  MP3: 'эм-пи-три',
  NPC: 'эн-пи-си',
  AI: 'эй-ай',
  OS: 'о-эс',
  ml: 'эм-эл',

  // The plugin and the harness it lives in.
  DeepSeek: 'дипсик',
  schemastery: 'схемастери',
  'schema-mastery': 'схемастери',
  cordis: 'кордис',
  cosmokit: 'космокит',
  configForms: 'конфиг-формы',
  'dsh-voice-v': 'ди-эс-эйч войс-в',
  volatile: 'волатайл',
  namespace: 'неймспейс',
  MCP: 'эм-си-пи',
  'edge-tts': 'эдж-ти-ти-эс',

  // Languages, runtimes, and the toolchain.
  'Node.js': 'нод-джаваскрипт',
  Node: 'нод',
  TypeScript: 'тайпскрипт',
  JavaScript: 'джаваскрипт',
  Python: 'пайтон',
  Git: 'гит',
  GitHub: 'гитхаб',
  npm: 'эн-пи-эм',
  pnpm: 'пи-эн-пи-эм',
  Docker: 'докер',
  Kubernetes: 'кубернетес',
  Linux: 'линукс',
  Windows: 'виндоуз',
  macOS: 'мак-ос',
  IDE: 'ай-ди-и',
  'VS Code': 'вэс-код',

  // DevOps, the web stack, and the protocols.
  DevOps: 'дев-опс',
  'CI/CD': 'си-ай-си-ди',
  PR: 'пи-ар',
  debug: 'дебаг',
  stacktrace: 'стектрейс',
  WebSocket: 'веб-сокет',
  webhook: 'вебхук',
  REST: 'рэст',
  GraphQL: 'граф-ку-эл',
  ORM: 'о-эр-эм',
  SSR: 'эс-эс-ар',
  MVP: 'эм-ви-пи',
  SaaS: 'са-а-с',
  CDN: 'си-ди-эн',
  SSL: 'эс-эс-эл',
  TLS: 'ти-эл-эс',
  OAuth: 'о-аут',
  JWT: 'джей-вэ-ти',
  RAM: 'рам',
  SSD: 'эс-эс-ди',
  FPS: 'эф-пи-эс',
  UX: 'ю-экс',

  // The code vocabulary.
  null: 'налл',
  undefined: 'андефайнд',
  boolean: 'булин',
  async: 'асинк',
  await: 'эвейт',
  callback: 'колбэк',
  lambda: 'лямбда',
  regex: 'регекс',
  TODO: 'ту-ду',
  FIXME: 'фикс-ми',

  // AI/ML, and the engineering around it.
  RAG: 'рэг',
  'fine-tuning': 'файн-тюнинг',
  checkpoint: 'чекпоинт',
  snapshot: 'снапшот',
  'vector DB': 'векторная база',
  embedding: 'эмбеддинг',
  inference: 'инференс',
  tokenizer: 'токенизатор',
  sampler: 'семплер',
  refactor: 'рефакторинг',
  deploy: 'деплой',
  release: 'релиз',
  hotfix: 'хатфикс',
  revert: 'реверт',
  workspace: 'воркспейс',
  endpoint: 'эндпоинт',
  route: 'роут',
  middleware: 'мидлвэр',
  repository: 'репозиторий',
  typecheck: 'тайпчек',
  prettier: 'претиер',
  eslint: 'эс-линт',
  backend: 'бэкенд',
  frontend: 'фронтенд',
  database: 'база данных',
  migration: 'миграция',
  orchestrator: 'оркестратор',
  pipeline: 'пайплайн',
  workflow: 'воркфлоу',
  'pull request': 'пул-реквест',
  'code review': 'код-ревью',

  // The words of the harness itself. A Russian voice reads these Latin
  // spellings differently every time — "commit" becomes "комит", "bundle"
  // becomes "бандл" with a hard "л" — so the reading is pinned here instead
  // of being left to the narrator.
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
});

/** Emoji, pictographs, dingbats, arrows, and regional-indicator flag pairs. */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Markdown table row (`| a | b |`) or its alignment separator (`|---|:--:|`). */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/** Opening fence of a fenced code block, ``` or ~~~, with an optional info string. */
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** Four-space / tab indented block lines. */
const INDENTED_CODE_RE = /^(?: {4,}|\t+)\S.*$/gm;

/** Symbols a narrator must not attempt even inside read-aloud code. */
const CODE_NOISE_RE = /[`~^|\\]/g;

/**
 * Russian plural form for a count.
 * @param count - A non-negative integer.
 * @param forms - `[one, few, many]`, e.g. `['строка', 'строки', 'строк']`.
 * @returns The form that agrees with the count.
 */
function pluralRu(count, forms) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/**
 * Split the row of a markdown table into its cells.
 * @param row - One `| a | b |` line.
 * @returns The trimmed cell texts.
 */
function splitTableRow(row) {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

/**
 * Whether one table row is the alignment separator rather than data.
 * @param row - One `| --- | :--: |` line.
 * @returns True for a separator row.
 */
function isTableSeparator(row) {
  const cells = splitTableRow(row);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Split a markdown answer into straight text, fenced code blocks, and tables.
 *
 * The split happens before any cleaning so that the code/table decision is made
 * on the original answer: a fenced block is one segment, a contiguous run of
 * table rows is one segment, and everything between them is text.
 * @param raw - The assistant message text as stored.
 * @returns Ordered segments: `{ kind: 'text', body }`, `{ kind: 'code', body, lines }`,
 *   or `{ kind: 'table', rows, dataRows }`.
 */
export function splitMarkdownSegments(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const segments = [];
  let text = [];

  const flushText = () => {
    if (text.length === 0) return;
    segments.push({ kind: 'text', body: text.join('\n') });
    text = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence !== null) {
      flushText();
      const marker = fence[1][0];
      const width = fence[1].length;
      const closing = new RegExp(`^\\s{0,3}\\${marker}{${width},}\\s*$`);
      const body = [];
      let cursor = index + 1;
      while (cursor < lines.length && !closing.test(lines[cursor])) {
        body.push(lines[cursor]);
        cursor += 1;
      }
      // An unterminated fence runs to the end of the answer.
      index = cursor < lines.length ? cursor : lines.length - 1;
      segments.push({ kind: 'code', body: body.join('\n'), lines: body.length });
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      flushText();
      const rows = [];
      let cursor = index;
      while (cursor < lines.length && TABLE_ROW_RE.test(lines[cursor])) {
        rows.push(lines[cursor]);
        cursor += 1;
      }
      const dataRows = rows.filter((row) => !isTableSeparator(row));
      segments.push({ kind: 'table', rows: dataRows, dataRows: dataRows.length });
      index = cursor - 1;
      continue;
    }
    text.push(line);
  }

  flushText();
  return segments;
}

/**
 * Minimal cleaning for read-aloud code: keep the code itself, drop the symbols
 * a narrator cannot say, and collapse runs of blanks.
 * @param body - The fenced block's body, fences already removed.
 * @returns One speakable line per code line.
 */
function cleanCodeSegment(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(CODE_NOISE_RE, ' ').replace(EMOJI_RE, ' ').replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('. ');
}

/**
 * Escape a literal for embedding in a regular expression.
 * @param value - Literal text.
 * @returns The escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite technical terms into their spoken Russian form.
 *
 * Matching ignores case, so one entry covers `redscript`, `RedScript`, and
 * `REDSCRIPT` alike. A key beginning with a letter or digit is matched only at
 * whole-word boundaries; any other key (`.anims`) is matched as a plain
 * literal. Keys are applied longest-first so a specific term beats a shorter
 * one nested in it.
 * @param text - Text after code, table, and link removal.
 * @param dictionary - Term → spoken form map.
 * @returns The rewritten text.
 */
export function applyDictionary(text, dictionary) {
  const entries = Object.entries(dictionary ?? {})
    .filter(([term, spoken]) => typeof term === 'string' && term !== '' && typeof spoken === 'string' && spoken !== '')
    .sort((left, right) => right[0].length - left[0].length);
  let result = text;
  for (const [term, spoken] of entries) {
    const body = escapeRegExp(term);
    const bounded = /^[\p{L}\p{N}]/u.test(term);
    const pattern = bounded
      ? new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu')
      : new RegExp(body, 'giu');
    result = result.replace(pattern, spoken);
  }
  return result;
}

/**
 * Clean one straight-text segment: everything a narrator must not read out
 * loud, plus the pronunciation dictionary.
 * @param body - Segment body, code blocks and tables already removed.
 * @param options - `dictionary`, `linkLabel`, and whether code is being stripped.
 * @returns Narration-ready text for this segment.
 */
function cleanTextSegment(body, options) {
  const dictionary = options.dictionary;
  const linkLabel = options.linkLabel ?? 'ссылка';
  let text = body;

  // 1. Indented code blocks are structure, not prose, when code is stripped.
  if (options.stripCode) text = text.replace(INDENTED_CODE_RE, ' ');

  // 2. Raw HTML and autolinks.
  text = text.replace(/<https?:\/\/[^>\s]*>/gi, ` ${linkLabel} `);
  text = text.replace(/<\/?[A-Za-z][^>\n]*>/g, ' ');

  // 3. Images and links keep only their human-readable label.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, ' $1 ');
  text = text.replace(/\bhttps?:\/\/\S+/gi, ` ${linkLabel} `);
  text = text.replace(/\bwww\.\S+/gi, ` ${linkLabel} `);

  // 4. Block-level markdown furniture.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, '');
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ');

  // 5. Inline emphasis and inline code fences.
  text = text.replace(/(\*\*|__)(.*?)\1/gs, ' $2 ');
  text = text.replace(/~~(.*?)~~/gs, ' $1 ');
  text = text.replace(/\*([^*\n]+)\*/g, ' $1 ');
  text = text.replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, ' $1 ');
  text = text.replace(/`([^`\n]*)`/g, ' $1 ');

  // 6. Pronunciation dictionary, before symbol stripping so dotted terms survive.
  text = applyDictionary(text, dictionary);

  // 7. Emoji and pictographs.
  text = text.replace(EMOJI_RE, ' ');

  // 8. Markdown/service symbols that carry no spoken meaning.
  text = text.replace(/[|`~^<>{}[\]\\#*_]/g, ' ');

  // 9. A slash between words is a list separator, not a spoken character.
  text = text.replace(/(?<=\S)\s*\/\s*(?=\S)/gu, ', ');
  text = text.replace(/\//g, ' ');

  // 10. Keep letters, digits, and speakable punctuation only.
  text = text.replace(/[^\p{L}\p{N}\s.,;:!?()«»"'’\-–—%+°№]/gu, ' ');

  // 11. Collapse whitespace.
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, ' ');
  text = text.replace(/ {2,}/g, ' ');
  return text.trim();
}

/**
 * Turn one markdown answer into plain narration text.
 *
 * The `stripCode` switch decides what happens to a fenced code block and a
 * markdown table:
 *
 * - **on** (the default) they are not read at all; the narrator says
 *   `блок кода, 12 строк` / `таблица, 3 строки` so the listener knows something
 *   was there;
 * - **off** they are read as they are, minimally cleaned: the code keeps its
 *   text and loses only the symbols a voice cannot pronounce, and each table row
 *   is read as its cells separated by commas.
 *
 * @param raw - The assistant message text as stored.
 * @param options - `dictionary`, `stripCode`, `codeLabel`, `tableLabel`, `linkLabel`.
 * @returns Narration-ready text with collapsed whitespace.
 */
export function cleanForSpeech(raw, options = {}) {
  const dictionary = options.dictionary ?? DEFAULT_PRONUNCIATION;
  const codeLabel = options.codeLabel ?? 'блок кода';
  const tableLabel = options.tableLabel ?? 'таблица';
  const stripCode = options.stripCode !== false;
  const lineWord = ['строка', 'строки', 'строк'];

  const parts = [];
  for (const segment of splitMarkdownSegments(raw)) {
    if (segment.kind === 'code') {
      parts.push(
        stripCode
          ? `${codeLabel}, ${segment.lines} ${pluralRu(segment.lines, lineWord)}`
          : cleanCodeSegment(segment.body),
      );
      continue;
    }
    if (segment.kind === 'table') {
      if (stripCode) {
        parts.push(`${tableLabel}, ${segment.dataRows} ${pluralRu(segment.dataRows, lineWord)}`);
      } else {
        parts.push(
          cleanTextSegment(segment.rows.map((row) => `${splitTableRow(row).join(', ')}.`).join('\n'), {
            dictionary,
            linkLabel: options.linkLabel,
            stripCode,
          }),
        );
      }
      continue;
    }
    parts.push(
      cleanTextSegment(segment.body, { dictionary, linkLabel: options.linkLabel, stripCode }),
    );
  }

  return parts
    .filter((part) => part !== '')
    .join(' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Hard-split one overlong sentence at the last comfortable boundary inside the
 * window: a comma, then a space, then the character cut.
 * @param sentence - A sentence longer than the chunk budget.
 * @param maxChars - Maximum chunk length.
 * @returns Consecutive pieces, each at most `maxChars` characters.
 */
function hardSplit(sentence, maxChars) {
  const pieces = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut = window.lastIndexOf(', ');
    if (cut < Math.floor(maxChars * 0.5)) cut = window.lastIndexOf(' ');
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    else cut += 1;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces.filter((piece) => piece !== '');
}

/**
 * Cut narration text into sentence-aligned chunks, greedily packing sentences
 * up to the chunk budget so short answers stay one request and long answers
 * still start playing after the first sentence.
 * @param text - Cleaned narration text.
 * @param maxChars - Maximum characters per chunk.
 * @returns Ordered chunks; empty when the text has nothing to say.
 */
export function splitIntoChunks(text, maxChars = 320) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (clean === '') return [];
  const budget = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 320;

  const sentences = clean.match(/[^.!?…]+[.!?…]+[)\]}»"']*\s*|[^.!?…]+$/gu) ?? [clean];
  const chunks = [];
  let current = '';

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (sentence === '') continue;
    if (sentence.length > budget) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      for (const piece of hardSplit(sentence, budget)) chunks.push(piece);
      continue;
    }
    if (current === '') {
      current = sentence;
      continue;
    }
    if (current.length + 1 + sentence.length <= budget) {
      current = `${current} ${sentence}`;
      continue;
    }
    chunks.push(current);
    current = sentence;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Full preparation pass: clean, then chunk. Truncates at sentence boundaries
 * when the caller's text exceeds `maxChars`.
 * @param raw - The assistant message text.
 * @param options - `dictionary`, `stripCode`, `maxChunkChars`, `maxTextChars` overrides.
 * @returns `{ cleaned, chunks, truncated }`.
 */
export function prepareForSpeech(raw, options = {}) {
  const maxChunkChars = options.maxChunkChars ?? 320;
  const maxTextChars = options.maxTextChars ?? 24000;
  const cleaned = cleanForSpeech(raw, options);
  const truncated = cleaned.length > maxTextChars;
  const bounded = truncated ? cleaned.slice(0, maxTextChars) : cleaned;
  return {
    cleaned: bounded,
    chunks: splitIntoChunks(bounded, maxChunkChars),
    truncated,
  };
}
