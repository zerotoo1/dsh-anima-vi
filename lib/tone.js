/**
 * dsh-voice-v tone detection: the narration preset a message's own wording
 * suggests.
 *
 * The analysis is a plain rule table over Russian words — no model, no
 * network, no extra context, nothing that could stall a sentence. It is
 * deliberately cheap: one regular-expression pass per category over a bounded
 * sample of the text.
 *
 * ## What the analyser reads
 *
 * The RAW message text, before the speech cleaning (see `lib/text.js`): the
 * cleaning removes code blocks, emoji, and URLs, and the wording that carries
 * the mood is exactly what the cleaning would have thrown away. The sample is
 * capped at the first {@link TONE_MAX_CHARS} characters: the opening of an
 * answer carries its mood, and a long answer need not be scanned to the end.
 *
 * ## How a category wins
 *
 * 1. Every category counts the DISTINCT rule terms the sample contains. A
 *    word repeated ten times counts once: the signal is "this message talks
 *    about being tired", not "how often it says it".
 * 2. The category with the highest count wins.
 * 3. A tie is broken by the fixed priority {@link TONE_PRIORITY}. The order
 *    is documented, so the same text always yields the same preset — no
 *    randomness, no locale-dependent behaviour, no dependence on the order the
 *    rules happen to sit in the table.
 *
 * The priority reads "the most deliberate signal first": fatigue is spelled
 * out by the speaker, flirt is deliberate, warmth is common in ordinary chat
 * ("ура", "отлично"), and the technical category is the one whose words
 * ("запрос", "тест", "модуль") turn up in work talk that is not a complaint
 * at all.
 *
 * @module dsh-voice-v/tone
 */

/**
 * How much of the message the analyser looks at.
 *
 * The cap keeps the cost of the check flat for any message length: the first
 * few thousand characters are enough to hear the mood of an answer, and the
 * tail of a long answer does not change it.
 */
export const TONE_MAX_CHARS = 4000;

/**
 * The rule table: one preset id → the Russian words that point at it.
 *
 * The words are matched case-insensitively on word boundaries, so `устал`
 * never fires inside `усталивать`, and `api` never fires inside `капитан`.
 * Multi-word entries (`сил нет`, `база данных`) are matched as a phrase.
 *
 * The table is pure data, and it is the ONLY place the plugin knows what the
 * words mean: a deployment that wants a different word list replaces this
 * module, not the route.
 */
export const TONE_RULES = Object.freeze({
  /** Tired and exasperated: «блин», «устала», «выматывает», «сил нет». */
  ustaly: Object.freeze([
    'блин',
    'устал',
    'устала',
    'устали',
    'устало',
    'устать',
    'усталый',
    'усталая',
    'устают',
    'выматывает',
    'выматываю',
    'выматывают',
    'чёрт',
    'черт',
    'бесит',
    'бесишь',
    'бесил',
    'хреново',
    'тяжело',
    'сил нет',
    'выгорел',
    'выгорела',
    'выгорели',
    'выгореть',
    'задолбал',
    'задолбала',
    'задолбали',
    'достало',
    'надоел',
    'надоела',
    'приелось',
    'раздражает',
  ]),
  /** Warm and loving: «люблю», «скучаю», «рад», «здорово», «ура». */
  zhivoy: Object.freeze([
    'люблю',
    'любишь',
    'любим',
    'любовь',
    'скучаю',
    'скучал',
    'скучала',
    'скучаешь',
    'скучают',
    'рад',
    'рада',
    'рады',
    'радуюсь',
    'радость',
    'счастье',
    'здорово',
    'отлично',
    'ура',
    'обнимаю',
  ]),
  /** Work and technology: «код», «ошибка», «деплой», «коммит», «npm». */
  spokoiny: Object.freeze([
    'код',
    'кода',
    'коды',
    'кодом',
    'функция',
    'функции',
    'функцию',
    'функций',
    'ошибка',
    'ошибки',
    'ошибку',
    'компиляция',
    'компиляции',
    'тест',
    'тесты',
    'тестов',
    'теста',
    'деплой',
    'деплоя',
    'рефакторинг',
    'репозиторий',
    'репозитория',
    'коммит',
    'коммита',
    'патч',
    'лог',
    'логи',
    'логов',
    'стектрейс',
    'баг',
    'баги',
    'конфиг',
    'конфигурация',
    'сервер',
    'сервера',
    'база данных',
    'миграция',
    'миграции',
    'запрос',
    'запроса',
    'запросы',
    'модуль',
    'модуля',
    'переменная',
    'переменные',
    'скрипт',
    'нейросеть',
    'нейросети',
    'промпт',
    'токен',
    'токены',
    'api',
    'npm',
  ]),
  /** Flirt: «милая», «нравишься», «поцелуй», «смотришь на меня». */
  derzkiy: Object.freeze([
    'милый',
    'милая',
    'мило',
    'милаш',
    'милашки',
    'красавец',
    'красавица',
    'красотка',
    'красавчик',
    'нравишься',
    'нравлюсь',
    'понравился',
    'понравилась',
    'обнимаешь',
    'обнимаете',
    'поцелуй',
    'поцелую',
    'целую',
    'флирт',
    'флиртую',
    'глаза',
    'глазки',
    'смотришь на меня',
    'смотри на меня',
    'заинтересовать',
    'заинтересовал',
    'заинтересовала',
    'соблазн',
    'соблазнять',
  ]),
});

/**
 * The tie-break order, most deliberate signal first.
 *
 * A text that matches two categories equally is narrated as the category
 * listed earlier here. The order is fixed and documented, so the same text
 * always gets the same preset.
 */
export const TONE_PRIORITY = Object.freeze(['ustaly', 'derzkiy', 'zhivoy', 'spokoiny']);

/**
 * Escape a rule term for use inside a regular expression.
 * @param term - The literal rule term.
 * @returns The term, safe to embed in a pattern.
 */
function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matcher for one category.
 *
 * The boundary is written out instead of using `\b`: `\b` is defined against
 * `[A-Za-z0-9_]`, so it never fires next to a Cyrillic letter and every
 * Russian rule would be dead. The look-around instead refuses a match that
 * touches another letter or digit.
 * @param terms - The rule terms of the category.
 * @returns A global, case-insensitive matcher whose first group is the term.
 */
function buildMatcher(terms) {
  const alternatives = terms.map(escapeTerm).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])((?:${alternatives}))(?![\\p{L}\\p{N}_])`, 'giu');
}

/** The compiled matcher per category, built once at module load. */
const MATCHERS = new Map(
  Object.entries(TONE_RULES).map(([preset, terms]) => [preset, buildMatcher(terms)]),
);

/**
 * Every distinct rule term of one category the text contains.
 * @param text - The text to scan.
 * @param preset - The category id.
 * @returns The matched terms, lowercased, in the order they appear.
 */
export function matchToneTerms(text, preset) {
  const matcher = MATCHERS.get(preset);
  if (matcher === undefined) return [];
  const source = typeof text === 'string' ? text : '';
  if (source === '') return [];
  const found = [];
  const seen = new Set();
  matcher.lastIndex = 0;
  let match = matcher.exec(source);
  while (match !== null) {
    const term = match[1].toLowerCase();
    if (seen.has(term) === false) {
      seen.add(term);
      found.push(term);
    }
    if (match[0].length === 0) matcher.lastIndex += 1;
    match = matcher.exec(source);
  }
  return found;
}

/**
 * Analyse a text and explain the verdict.
 *
 * The result carries everything the host needs to say WHY a preset was
 * chosen: the winning category, the rule terms that fired, how many of them
 * there were, and every other category that matched with its own count (the
 * list is ordered by the same rule the winner was picked with, so a tie is
 * visible in the answer).
 * @param text - The raw message text.
 * @returns `{ preset, matched, score, candidates }`; `preset` is `null` when
 *   the text carries no clear tone.
 */
export function analyzeTone(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return { preset: null, matched: [], score: 0, candidates: [] };
  const sample = source.slice(0, TONE_MAX_CHARS);

  const candidates = [];
  for (const preset of TONE_PRIORITY) {
    const matched = matchToneTerms(sample, preset);
    if (matched.length > 0) candidates.push({ preset, score: matched.length, matched });
  }
  if (candidates.length === 0) return { preset: null, matched: [], score: 0, candidates: [] };

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return TONE_PRIORITY.indexOf(left.preset) - TONE_PRIORITY.indexOf(right.preset);
  });

  const best = candidates[0];
  return { preset: best.preset, matched: best.matched, score: best.score, candidates };
}

/**
 * The narration preset a text suggests.
 *
 * The cheap form of {@link analyzeTone}: the preset id, or `null` when the
 * text carries no clear tone and the configured preset must answer.
 * @param text - The raw message text.
 * @returns A preset id, or `null`.
 */
export function detectTone(text) {
  return analyzeTone(text).preset;
}
