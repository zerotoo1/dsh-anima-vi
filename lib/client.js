// dsh-voice-v browser half.
//
// Hand-written in the lazy-CJS bundle protocol the DSH shell installs as
// `window.__ModuleLoader__` (the same protocol the installed third-party
// plugins ship; `@liustack/modsearch` documents writing it by hand). The module
// id is the package name, and the bundle's only external is `react`, which is a
// platform seed word. `dsh.client.inject` in package.json is therefore not about
// this bundle's own requires: it names the two package rows whose client halves
// the card consumes (`dsh-client-runtime` provides the slot registry,
// `dsh-client-ui-settings` provides the settings scope binder), so those rows
// arrive before this one materializes.
//
// Two registrations:
//
//  * `conversation.chat.assistant-actions` — the speaker button under a
//    finalized assistant message, in the same action strip the Like/Dislike
//    buttons live in. The slot owner props supply `messageId`; the
//    session-scoped `inject(sessionId)` factory supplies `sessionId`. Nothing
//    else is needed, because the host resolves the message text from the
//    session log.
//
//  * `settings.plugin.item` — the settings card in the Configurable tab of the
//    Plugins settings page. That slot is declared by the Plugins settings
//    surface as a KEYED slot whose key domain is the settings namespace, which
//    the page dispatches as `renderSlot('settings.plugin.item', {}, { entryKey:
//    ns })` for every namespace the Host serves. It is deliberately not
//    `plugins.item`: that list is the Official group.
//    The card's values come from the bound scope of the namespace `dsh-voice-v`
//    that the host half registers with the settings service:
//    `getSnapshot()` for reads, `set()` / `unset()` for writes. Nothing is
//    hard-coded in this bundle that the host does not report through
//    `/dsh-voice-v/config` — the preset table, the dictionary defaults, and the
//    slider domains all arrive from there.
//
// Service posture: the speaker button needs only `slots`, so `slots` is the one
// top-level requirement. The settings card asks for `slots` in a NESTED
// `ctx.inject` fiber instead of the top-level list. A service declared at top
// level but missing on the host keeps the whole client entry suspended ("1 entry
// did not activate"), which would take the read-aloud button down over a
// settings-only dependency; the nested fiber confines that wait to the card, so
// a host without the slot registry still gets the button and simply shows no
// card. The settings binder is read with `ctx.get`, which answers `undefined`
// instead of throwing, so its absence costs the card and nothing else. The
// nested fiber must re-declare every service it reads (`slots` included),
// because a strict context proxy throws on undeclared reads.
//
// Playback is strict HTMLAudioElement sequencing: the host returns one cached
// MP3 per sentence-aligned chunk, and the parts play back to back. Clicking
// while speaking stops immediately.
window.__ModuleLoader__.load({
  id: 'dsh-voice-v',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');

    /** Host route that turns a message id into a list of cached audio parts. */
    var SPEAK_PATH = '/dsh-voice-v/speak';

    /** Host route carrying the live preset table, dictionary defaults, and bounds. */
    var CONFIG_PATH = '/dsh-voice-v/config';

    /** Host route that synthesizes with caller-supplied values, bypassing settings. */
    var PREVIEW_PATH = '/dsh-voice-v/preview';

    /** Settings namespace the host half registers; also this card's slot key. */
    var SETTINGS_NAMESPACE = 'dsh-voice-v';

    /**
     * The keys the plugin's own page dispatches the configuration by: the
     * bundle's package name, and the row's `bundle#rowId`.
     */
    var BUNDLE_KEY = 'dsh-voice-v';
    var ROW_CONFIG_KEY = 'dsh-voice-v#dsh-voice-v';

    /**
     * Read an optional service from a plugin context.
     *
     * A cordis context resolves a service by property access, and throws
     * when the service is not visible from this fiber; the 0.2.x runtime
     * answers `get` instead. Both are asked, and a service that neither host
     * provides comes back as undefined — the card then simply does not
     * appear, and the speaker button keeps working.
     * @param {object} ctx - The browser plugin context.
     * @param {string} name - The service name.
     * @returns {unknown} The service, or undefined when this host has none.
     */
    function readService(ctx, name) {
      try {
        if (typeof ctx.get === 'function') {
          var viaGet = ctx.get(name);
          if (viaGet !== undefined && viaGet !== null) return viaGet;
        }
      } catch (error) {
        /* this host has no `get`, or it refused the lookup */
      }
      try {
        return ctx[name];
      } catch (error) {
        return undefined;
      }
    }

    /** CSS injected once, styled like the sibling Like/Dislike action buttons. */
    var CSS = [
      '.dvv-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
      '.dvv-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dvv-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dvv-action:disabled{cursor:default;opacity:.4}',
      '.dvv-action[data-phase="playing"]{color:var(--dsw-alias-state-business-primary)}',
      '.dvv-action[data-phase="error"]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-tertiary))}',
      '.dvv-spin{animation:dvv-spin 1s linear infinite;transform-origin:50% 50%}',
      '@keyframes dvv-spin{to{transform:rotate(360deg)}}',
      // The visualization that takes the glyph's place inside the button:
      // the very same box, the very same colour, no frame and no shadow.
      '.dvv-vis{display:inline-flex;align-items:center;justify-content:center;width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));color:inherit;overflow:hidden}',
      '.dvv-vis>canvas{width:100%;height:100%;display:block}',
      // The wide trace rides the input card's own top edge: the dock is the
      // full-width seat right above the composer, the stack leaves a gap under
      // it, and the negative bottom margin swallows that gap and a few pixels
      // of the card's padding too, so the wave touches the field instead of
      // floating above it. It paints over the card's border and padding only —
      // never over the text being typed.
      '.dvv-osc{position:relative;z-index:1;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto -8px;pointer-events:none;color:var(--dsw-alias-label-secondary);opacity:.9}',
      '.dvv-osc>canvas{width:100%;height:100%;display:block}',
      '.dvv-vis-dots{gap:2px}',
      '.dvv-vis-dots>i{width:2.5px;height:2.5px;border-radius:50%;background:currentColor;animation:dvv-dot .9s ease-in-out infinite}',
      '.dvv-vis-dots>i:nth-child(2){animation-delay:.15s}',
      '.dvv-vis-dots>i:nth-child(3){animation-delay:.3s}',
      '@keyframes dvv-dot{0%,100%{transform:translateY(1px);opacity:.45}50%{transform:translateY(-2px);opacity:1}}',
      '.dvv-vis-pulse{position:relative}',
      '.dvv-vis-pulse::before{content:"";position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:currentColor;animation:dvv-pulse 1.15s ease-in-out infinite}',
      '@keyframes dvv-pulse{0%,100%{transform:scale(.65);opacity:.4}50%{transform:scale(1.15);opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dvv-spin{animation-duration:2.4s}.dvv-vis-dots>i,.dvv-vis-pulse::before{animation-duration:2.4s}}',
      '.dvv-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);max-width:100%}',
      '.dvv-head{display:flex;flex-direction:column;gap:3px}',
      '.dvv-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dvv-desc{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dvv-group{display:flex;flex-direction:column;gap:6px}',
      '.dvv-group-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dvv-presets{display:flex;flex-wrap:wrap;gap:8px}',
      '.dvv-preset-row{display:flex;gap:6px;align-items:stretch}',
      '.dvv-preset{display:flex;flex-direction:column;gap:1px;align-items:flex-start;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 10px;font:inherit;font-size:12px;text-align:left}',
      '.dvv-preset[data-active="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dvv-preset:disabled{cursor:default;opacity:.5}',
      '.dvv-preset-name{font-size:13px;font-weight:600}',
      '.dvv-preset-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dvv-preset-own{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dvv-preset-own .dvv-input{flex:1 1 180px;min-width:140px}',
      '.dvv-slider{display:grid;grid-template-columns:minmax(52px,84px) minmax(0,1fr) 56px;align-items:center;gap:10px}',
      '.dvv-slider-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center}',
      '.dvv-slider input[type=range]{width:100%;margin:0;min-width:0}',
      '.dvv-value{font-size:12px;font-variant-numeric:tabular-nums;text-align:right;color:var(--dsw-alias-label-primary)}',
      '.dvv-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dvv-btn{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 10px;font-size:12px;font-family:inherit}',
      '.dvv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dvv-btn:disabled{cursor:default;opacity:.5}',
      '.dvv-btn-primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dvv-btn-danger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}',
      '.dvv-btn.dvv-preset-delete{margin-left:4px;padding:6px 9px;border-color:transparent;background:transparent;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-tertiary))}',
      '.dvv-btn.dvv-preset-delete:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dvv-switch{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dvv-input{width:100%;box-sizing:border-box;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 6px;font-size:12px;font-family:inherit}',
      '.dvv-select{width:100%;box-sizing:border-box;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 6px;font-size:12px;font-family:inherit;min-width:0;text-overflow:ellipsis}',
      '.dvv-voice{display:flex;align-items:center;gap:8px}',
      '.dvv-voice>.dvv-select,.dvv-voice>.dvv-input{flex:1 1 auto;min-width:0}',
      '.dvv-endpoint{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.dvv-endpoint .dvv-btn{align-self:flex-start}',
      '.dvv-voice-back{flex:0 0 auto;padding:4px 8px;font-size:11px}',
      '.dvv-voice-back[data-off="true"]{visibility:hidden}',
      '.dvv-dict{display:flex;flex-direction:column;gap:6px}',
      '.dvv-dict-head,.dvv-dict-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto auto;gap:6px;align-items:center}',
      '.dvv-dict-head{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dvv-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dvv-badge{font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dvv-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dvv-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}',
      '.dvv-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}',
      '.dvv-dirty{font-size:11px;color:var(--dsw-alias-state-business-primary)}',
      '.dvv-details{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dvv-details-summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dvv-details-summary::-webkit-details-marker{display:none}',
      '.dvv-details-summary::before{content:"\\25B8";font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.dvv-details[open]>.dvv-details-summary::before{content:"\\25BE"}',
      '.dvv-details-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dvv-details-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dvv-details-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}',
      '.dvv-footer{margin-top:0;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
    ].join('');

    if (typeof document !== 'undefined') {
      var STYLE_ID = 'dsh-voice-v/voice-button.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
        var styleTag = document.createElement('style');
        styleTag.dataset.plugin = 'dsh-voice-v';
        styleTag.dataset.pluginCss = STYLE_ID;
        styleTag.textContent = CSS;
        document.head.appendChild(styleTag);
      }
    }

    var rawH = react.createElement;

    // ---------------------------------------------------------------------
    // The interface language
    // ---------------------------------------------------------------------
    //
    // The card speaks Russian and English, and the choice is a setting of its
    // own (`uiLanguage` in the host namespace), so the host knows it too and
    // the two halves cannot disagree. The translation runs at render time over
    // the literals this half already writes: every UI string lives in one
    // dictionary, and `h` — the single function every element goes through —
    // asks that dictionary for the language in force. A string the dictionary
    // does not know passes through untouched, so host-reported data (voice ids,
    // provider names, a user's own preset label) is never mangled.

    /** The languages the card offers, and its own name in each. */
    var UI_LANGUAGES = [
      { id: 'ru', label: 'Русский' },
      { id: 'en', label: 'English' },
    ];

    /** The language the card speaks when nothing says otherwise. */
    var DEFAULT_UI_LANGUAGE = 'ru';

    /**
     * Read a language id: `ru`, `en`, `en-US`, `EN` — or the default.
     * @param value - The raw value.
     * @returns `'ru'` or `'en'`.
     */
    function normalizeUiLanguage(value) {
      var raw = String(value === undefined || value === null ? '' : value)
        .trim()
        .toLowerCase()
        .slice(0, 2);
      for (var index = 0; index < UI_LANGUAGES.length; index += 1) {
        if (UI_LANGUAGES[index].id === raw) return raw;
      }
      return DEFAULT_UI_LANGUAGE;
    }

    /** The language in force, and the readers waiting for it to move. */
    var language = {
      value: DEFAULT_UI_LANGUAGE,
      listeners: [],
    };

    /** Put a new language in force and tell every reader. */
    function setUiLanguage(next) {
      var normalized = normalizeUiLanguage(next);
      if (normalized === language.value) return normalized;
      language.value = normalized;
      var readers = language.listeners.slice();
      for (var index = 0; index < readers.length; index += 1) {
        try {
          readers[index](normalized);
        } catch (error) {
          /* a reader that is already gone */
        }
      }
      return normalized;
    }

    /**
     * Watch the language. The reader is called at once, so a component that
     * mounts after a switch still sees the current one.
     * @param listener - Called with the language id.
     * @returns The unsubscribe function.
     */
    function subscribeUiLanguage(listener) {
      if (typeof listener !== 'function') return function () {};
      language.listeners.push(listener);
      try {
        listener(language.value);
      } catch (error) {
        /* a reader that is already gone */
      }
      return function () {
        var at = language.listeners.indexOf(listener);
        if (at !== -1) language.listeners.splice(at, 1);
      };
    }

    /** The language, as React state: a switch re-renders the caller. */
    function useUiLanguage() {
      var state = react.useState(language.value);
      react.useEffect(function () {
        return subscribeUiLanguage(function (next) {
          state[1](next);
        });
      }, []);
      return state[0];
    }

    /**
     * Russian to English, for every literal this half writes.
     *
     * The keys are the Russian strings themselves: a render site keeps writing
     * its own words, and the dictionary — applied by substring, longest first —
     * turns them into English. That keeps composed strings ("Saved." vs "Not
     * saved: …") in one place instead of scattering a key per fragment.
     */
    var EN = {
      'Озвучить ответ': 'Read the answer aloud',
      'Синтез речи…': 'Synthesizing…',
      'Остановить озвучивание': 'Stop reading',
      'Не удалось озвучить ответ': 'Could not read the answer',
      Выключено: 'Off',
      Спектр: 'Spectrum',
      Волна: 'Wave',
      Осциллограмма: 'Oscilloscope',
      Пульс: 'Pulse',
      Точки: 'Dots',
      Живой: 'Lively',
      Нейтральный: 'Neutral',
      Спокойный: 'Calm',
      Дерзкий: 'Bold',
      Усталый: 'Tired',
      дефолт: 'default',
      ровно: 'even',
      'дефолт: бодрый темп и выше тон': 'default: a brisk tempo and a higher tone',
      'ровно, без подъёма': 'even, no lift',
      'медленнее и ниже': 'slower and lower',
      'быстрее и чуть выше': 'faster and a little higher',
      'совсем медленно и низко': 'very slow and low',
      терминов: 'terms',
      термина: 'terms',
      термин: 'term',
      'edge-tts (по умолчанию)': 'edge-tts (default)',
      'OpenAI-совместимый': 'OpenAI-compatible',
      'Яндекс SpeechKit': 'Yandex SpeechKit',
      'Google (без ключа)': 'Google (no key)',
      'Google Cloud TTS': 'Google Cloud TTS',
      Марина: 'Marina',
      Ермиль: 'Ermil',
      Павел: 'Pavel',
      Мужской: 'Male',
      Джейн: 'Jane',
      Другие: 'Other',
      'Свой голос…': 'Custom voice…',
      'Проверка озвучки.': 'Voice test.',
      Сохранено: 'Saved',
      'Хост не принял часть значений — правки оставлены.': 'The host rejected some values — your edits are kept.',
      'Не сохранилось: ': 'Not saved: ',
      'Хост не принял ключ.': 'The host rejected the key.',
      'Ключ сохранён.': 'Key saved.',
      'Прослушать не вышло: ': 'Could not play: ',
      'Хост не принял словарь.': 'The host rejected the dictionary.',
      'Словарь сохранён.': 'Dictionary saved.',
      'Озвучка ответов: голос, темп, тон и словарь произношения.':
        'Read aloud: voice, tempo, tone and the pronunciation dictionary.',
      'Озвучка ответов (dsh-voice-v)': 'Read aloud (dsh-voice-v)',
      'Служба настроек недоступна — карточка не смонтирована.': 'The settings service is unavailable — the card is not mounted.',
      'Голос, темп, тон, словарь.': 'Voice, tempo, tone, dictionary.',
      'Эта страница не на loopback: правки живут только в памяти процесса и не переживут перезагрузку.':
        'This page is not on loopback: edits live only in process memory and will not survive a reload.',
      'Пространство настроек «': 'The settings namespace “',
      '» не опубликовано этим хостом: работает только config из cordis.patch.yml.':
        '” is not published by this host: only the config from cordis.patch.yml applies.',
      'Настройки загружаются…': 'Loading settings…',
      ' · вне каталога': ' · not in the catalogue',
      изменено: 'changed',
      'не задана': 'not set',
      'не задан': 'not set',
      'Голос, темп, тон, словарь произношения, вырезание кода и подбор пресета по тону ответа. Всё хранится в настройках хоста (':
        'Voice, tempo, tone, the pronunciation dictionary, code stripping and a preset picked by the tone of the answer. Everything is stored in the host settings (',
      ') и применяется к следующей озвучке без перезапуска.': ') and applies to the next narration without a restart.',
      'Язык интерфейса': 'Interface language',
      Русский: 'Russian',
      Пресет: 'Preset',
      'Удалить пресет ': 'Delete preset ',
      'Удалить пресет': 'Delete preset',
      'название пресета': 'preset name',
      'Название пресета': 'Preset name',
      'Сохранить как пресет': 'Save as preset',
      'Свой пресет запоминает текущие темп, тон и голос. Свои пресеты помечены крестиком — их можно удалить.':
        'Your own preset remembers the current tempo, tone and voice. Your presets carry a ✕ — they can be deleted.',
      'Темп и тон': 'Tempo and tone',
      'Темп в процентах': 'Tempo in percent',
      Темп: 'Tempo',
      'Тон в герцах': 'Tone in hertz',
      Тон: 'Tone',
      'Синтез…': 'Synthesizing…',
      Прослушать: 'Listen',
      'Сбросить к пресету': 'Reset to the preset',
      Содержимое: 'Content',
      'Вырезать код из озвучки': 'Strip code from the narration',
      'Блоки кода и markdown-таблицы не читаются: вместо них «блок кода, N строк» и «таблица, N строк».':
        'Code blocks and markdown tables are skipped: the narrator says “code block, N lines” and “table, N lines” instead.',
      'Код и таблицы читаются как есть: код — минимально очищенным, таблица — по строкам через запятую.':
        'Code and tables are read as they are: code minimally cleaned, a table row by row with commas between cells.',
      'Тон сообщения': 'Tone of the message',
      'Пресет по тону сообщения': 'Preset by the tone of the message',
      'Хост подбирает темп и тон по словам ответа: усталость — «Усталый», тепло — «Живой», работа — «Спокойный», флирт — «Дерзкий». Темп и тон, заданные вручную, всегда важнее.':
        'The host picks tempo and tone from the words of the answer: tired — “Tired”, warm — “Lively”, work — “Calm”, flirt — “Bold”. A tempo or tone set by hand always wins.',
      'Пресет выбирается вручную: темп и тон берутся из выбранного пресета, слова ответа на них не влияют.':
        'The preset is chosen by hand: tempo and tone come from the chosen preset, and the words of the answer do not affect them.',
      'Буква «ё»': 'The letter “ё”',
      'Как читать букву ё': 'How to read the letter ё',
      'Как написано — Edge читает «ё» как «йе»': 'As written — Edge reads “ё” as “ye”',
      'Без точек — «приём» станет «прием»': 'Without the dots — “приём” becomes “прием”',
      'Выписать звуком — «приём» станет «прийом»': 'Spelled out — “приём” becomes “прийом”',
      'Голоса Edge читают «ё» как «йе». Выписанный звуком — единственный способ услышать её правильно, но в словах после твёрдых согласных он меняет слово. Яндекс читает «ё» сам — там режим не нужен.':
        'The Edge voices read “ё” as “ye”. Spelling it out is the one way to hear it right, but after a hard consonant it changes the word. Yandex reads “ё” by itself — no mode needed there.',
      Голос: 'Voice',
      'например, ru-RU-SvetlanaNeural': 'for example, ru-RU-SvetlanaNeural',
      'Голос edge-tts': 'edge-tts voice',
      'К списку': 'Back to the list',
      'Для своего эндпоинта укажите id голоса провайдера: «Свой голос…» — ручной ввод. У edge-tts остаётся его каталог.':
        'For your own endpoint, type the provider voice id: “Custom voice…” is the manual entry. edge-tts keeps its own catalogue.',
      'Свой голос вводится вручную: в edge-tts уходит именно этот идентификатор.':
        'A custom voice is typed by hand: this very id goes to edge-tts.',
      'Синтез речи': 'Speech synthesis',
      'Провайдер синтеза': 'Synthesis provider',
      'Base URL эндпоинта': 'Endpoint base URL',
      'Model ID эндпоинта': 'Endpoint model ID',
      'API Key эндпоинта': 'Endpoint API key',
      'ключ сохранён — введите, чтобы заменить': 'key saved — type to replace',
      'Сохранить ключ сейчас': 'Save the key now',
      'Сохранить ключ': 'Save key',
      'Убрать сохранённый ключ': 'Remove the saved key',
      'Сбросить ключ': 'Reset key',
      'Голос Яндекса': 'Yandex voice',
      'Ключ API Яндекс SpeechKit': 'Yandex SpeechKit API key',
      'Голос Google': 'Google voice',
      'Ключ API Google Cloud TTS': 'Google Cloud TTS API key',
      'Свой эндпоинт необязателен: edge-tts остаётся дефолтом и работает без ключей. Google без ключа — страховка на случай, когда локального CLI нет: один голос, без темпа и тона, и звучит заметно хуже нейронных. Ключ хранится в пользовательском слое профиля и в браузер не отправляется.':
        'Your own endpoint is optional: edge-tts stays the default and works with no keys. The keyless Google route is the fallback for a machine without the local CLI: one voice, no tempo or tone, and clearly worse than the neural ones. A key lives in the profile’s user layer and is never sent to the browser.',
      Визуализация: 'Visualization',
      'Визуализация озвучки': 'Narration visualization',
      'Показывает движение звука. «Спектр» и «Осциллограмма» — живая полоса над полем ввода, пока звучит мой голос: частоты и волна по всей ширине карточки. «Волна» живёт в кнопке озвучки, «Пульс» и «Точки» — простая анимация.':
        'Shows the movement of the sound. “Spectrum” and “Oscilloscope” are a live strip above the input while the voice plays: frequencies and a wave across the whole width. “Wave” lives in the speaker button, “Pulse” and “Dots” are a plain animation.',
      Сохранить: 'Save',
      'Отменить правки': 'Discard edits',
      'есть несохранённые правки': 'unsaved edits',
      'только чтение (memory mode)': 'read-only (memory mode)',
      'Хост пока не отдал значения по пространству настроек.': 'The host has not reported any values for the settings namespace yet.',
      'Сейчас хост отдаёт: ': 'The host currently reports: ',
      'голос не выбран': 'no voice chosen',
      'темп не задан': 'tempo not set',
      'высота не задана': 'pitch not set',
      ', пресет по тону ': ', tone preset ',
      ', пресет ': ', preset ',
      выключен: 'off',
      включён: 'on',
      ', визуализация ': ', visualization ',
      ' · пространство настроек не зарегистрировано: правки пишутся в config плагина, а не в настройки хоста':
        ' · the settings namespace is not registered: edits go to the plugin config, not the host settings',
      'Словарь произношения': 'Pronunciation dictionary',
      'Два поля и кнопка: термин уходит в настройки сразу, без общей кнопки «Сохранить». В списке только твои термины — встроенный словарь хоста остаётся как есть, а «Удалить» возвращает встроенное чтение.':
        'Two fields and a button: a term is written to the settings at once, without the card’s own Save. The list holds only your own terms — the host’s built-in dictionary stays as it is, and “Delete” brings the built-in reading back.',
      'как читать': 'how to read',
      'Новый термин': 'New term',
      'Транскрипция нового термина': 'Reading of the new term',
      Добавить: 'Add',
      'Своих терминов пока нет: всё читается так, как задал хост.': 'No terms of your own yet: everything is read the way the host set it.',
      Термин: 'Term',
      Транскрипция: 'Reading',
      'Транскрипция для ': 'Reading for ',
      'Прослушать транскрипцию': 'Listen to the reading',
      'Убрать свой термин': 'Remove your term',
      Удалить: 'Delete',
      ' · с акцентом': ' · with an accent',
      Русские: 'Russian',
      Мультиязычные: 'Multilingual',
      Светлана: 'Svetlana',
      Дмитрий: 'Dmitry',
      Ава: 'Ava',
      Эмма: 'Emma',
      Серафина: 'Seraphina',
      Вивьен: 'Vivienne',
      Талита: 'Thalita',
      'Свои пресеты': 'Your presets',
      Пресеты: 'Presets',
      'Язык самой карточки: русский или английский. Озвучка не меняется — голос читает текст ответа, а не интерфейс.':
        'The language of the card itself: Russian or English. The narration does not change — the voice reads the text of the answer, not the interface.',
    };

    /** The dictionary, longest key first, so a phrase wins over its own words. */
    var EN_RULES = Object.keys(EN).sort(function (left, right) {
      return right.length - left.length;
    });

    /**
     * Turn one string into the language in force.
     * @param text - The Russian literal.
     * @returns The same text in Russian or in English.
     */
    function translateText(text) {
      if (language.value !== 'en') return text;
      var out = text;
      for (var index = 0; index < EN_RULES.length; index += 1) {
        var russian = EN_RULES[index];
        if (out.indexOf(russian) !== -1) out = out.split(russian).join(EN[russian]);
      }
      return out;
    }

    /**
     * Translate one child of an element: a string becomes the language in
     * force, an array is walked, and an element is left alone — it went
     * through `h` itself and is already translated.
     * @param child - The child the render site passed.
     * @returns The child in the language in force.
     */
    function translateChild(child) {
      if (typeof child === 'string') return translateText(child);
      if (Array.isArray(child)) {
        var out = new Array(child.length);
        for (var index = 0; index < child.length; index += 1) out[index] = translateChild(child[index]);
        return out;
      }
      return child;
    }

    /** The props whose text a reader hears or reads. */
    var TRANSLATED_PROPS = { 'aria-label': true, title: true, placeholder: true, alt: true };

    /**
     * Create an element, translating its own text when the card speaks English.
     *
     * Every element of this half goes through here, so the card needs no
     * per-string edit and a new literal costs one dictionary entry. A string
     * outside the dictionary is left exactly as it is.
     */
    function h(type, props) {
      var args = Array.prototype.slice.call(arguments);
      if (language.value === 'en') {
        if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
          var copy = null;
          for (var key in props) {
            if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
            if (!Object.prototype.hasOwnProperty.call(TRANSLATED_PROPS, key)) continue;
            if (typeof props[key] !== 'string') continue;
            if (copy === null) {
              copy = {};
              for (var name in props) {
                if (Object.prototype.hasOwnProperty.call(props, name)) copy[name] = props[name];
              }
            }
            copy[key] = translateText(props[key]);
          }
          if (copy !== null) args[1] = copy;
        }
        for (var position = 2; position < args.length; position += 1) {
          args[position] = translateChild(args[position]);
        }
      }
      return rawH.apply(null, args);
    }

    /** Speaker with sound waves: the idle glyph. */
    function SpeakerGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8.6 1.9a.75.75 0 0 1 .4.66v10.88a.75.75 0 0 1-1.2.6L4.9 11.5H2.75A.75.75 0 0 1 2 10.75v-5.5a.75.75 0 0 1 .75-.75H4.9l2.9-2.54a.75.75 0 0 1 .8-.06Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M11.3 5.2a.75.75 0 0 1 1.05.15 4.2 4.2 0 0 1 0 5.3.75.75 0 1 1-1.2-.9 2.7 2.7 0 0 0 0-3.5.75.75 0 0 1 .15-1.05Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M13.55 3.05a.75.75 0 0 1 1.05.12 7.3 7.3 0 0 1 0 9.66.75.75 0 1 1-1.17-.94 5.8 5.8 0 0 0 0-7.78.75.75 0 0 1 .12-1.06Z',
          fill: 'currentColor',
        }),
      );
    }

    /** Open ring that spins while a part is being synthesized. */
    function SpinnerGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', className: 'dvv-spin' },
        h('circle', {
          cx: '8',
          cy: '8',
          r: '5.75',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeDasharray: '26 10',
        }),
      );
    }

    /** Filled square: the stop glyph shown while audio is playing. */
    function StopGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: '4', y: '4', width: '8', height: '8', rx: '1.5', fill: 'currentColor' }),
      );
    }

    /** Warn triangle: a quiet failure marker. */
    function ErrorGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 2.3 14.3 13H1.7L8 2.3Z',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 6.2v3', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
        h('circle', { cx: '8', cy: '11.2', r: '.8', fill: 'currentColor' }),
      );
    }

    var LABELS = {
      idle: 'Озвучить ответ',
      loading: 'Синтез речи…',
      playing: 'Остановить озвучивание',
      error: 'Не удалось озвучить ответ',
    };

    // ---------------------------------------------------------------------
    // One sound at a time
    // ---------------------------------------------------------------------
    //
    // Two things can make a sound: the speaker button under a message and the
    // settings card's audition button. They share the one slot below, so a
    // new start silences the old one: at most one sound at a time, across the
    // whole page, whichever button or card asked for it.
    //
    // `generation` is the race guard. Every claim and every stop raises it,
    // and a part that arrives late — its element finished loading after
    // somebody else took the slot — compares the generation it was created
    // under with the current one and refuses to play: the newer start wins.

    /**
     * The page's single sound slot.
     * @returns The player: the claim/stop/release calls and the element hooks.
     */
    function createAudioPlayer() {
      /** The element that is sounding, if any. */
      var element = null;
      /** The owner of the slot: the tag the claimant passed in. */
      var owner = null;
      /** What is sounding: `message:<id>` or `preview`. */
      var label = '';
      /** Raised by every claim and every stop: the race guard. */
      var generation = 0;
      /** Told when somebody else takes the slot away. */
      var onStop = null;
      /** Settles the part that is still waiting for its element. */
      var cancel = null;
      /** What the pages read while a voice sounds: `{ variant, analyser }`, or null. */
      var visual = null;
      /** Told when the visual source appears or goes. */
      var visualListeners = [];
      /** How an element is made; the browser-half tests replace it. */
      var createElement = function (url) {
        return new Audio(url);
      };

      /**
       * Silence the current sound and invalidate everything waiting for it.
       * @returns The new generation.
       */
      function stop() {
        generation += 1;
        var current = element;
        var waiter = cancel;
        var notify = onStop;
        element = null;
        cancel = null;
        onStop = null;
        owner = null;
        label = '';
        publishVisual(null);
        if (current !== null) {
          try {
            current.onended = null;
            current.onerror = null;
          } catch (error) {
            /* the element is detached */
          }
          try {
            current.pause();
          } catch (error) {
            /* it never started */
          }
          try {
            current.removeAttribute('src');
          } catch (error) {
            /* detached */
          }
        }
        if (typeof waiter === 'function') {
          try {
            waiter();
          } catch (error) {
            /* the owner is gone */
          }
        }
        if (typeof notify === 'function') {
          try {
            notify();
          } catch (error) {
            /* the owner is gone */
          }
        }
        return generation;
      }

      /**
       * Take the slot: whatever was playing stops, and the caller owns it.
       * @param nextOwner - The tag that identifies the new owner.
       * @param nextLabel - What is now sounding, for diagnostics.
       * @param nextOnStop - Told when somebody else takes the slot.
       * @returns The generation this playback must quote.
       */
      function claim(nextOwner, nextLabel, nextOnStop) {
        stop();
        owner = nextOwner;
        label = nextLabel;
        onStop = nextOnStop;
        return generation;
      }

      /**
       * Give the slot back when a playback ends on its own.
       * @param currentOwner - The tag of the owner handing the slot back.
       */
      function release(currentOwner) {
        if (owner !== currentOwner) return;
        element = null;
        cancel = null;
        onStop = null;
        owner = null;
        label = '';
        publishVisual(null);
      }

      /**
       * Hand the slot an element and the waiter that settles its part.
       * @param next - The element that is about to sound.
       * @param waiter - Called when the slot is taken away.
       */
      function begin(next, waiter) {
        element = next;
        cancel = waiter;
      }

      /**
       * Drop an element that finished or failed.
       * @param finished - The element that is done.
       */
      function clearElement(finished) {
        if (element === finished) element = null;
      }

      /**
       * Tell every reader what the pages can draw right now.
       *
       * The message button and the composer's wide trace both read this: one
       * voice sounds at a time, so there is one thing to draw at a time.
       * @param next - `{ variant, analyser }`, or null when nothing sounds.
       */
      function publishVisual(next) {
        visual = next;
        var listeners = visualListeners.slice();
        for (var index = 0; index < listeners.length; index += 1) {
          try {
            listeners[index](next);
          } catch (error) {
            /* a reader that is already gone */
          }
        }
      }

      /**
       * Forget the visual that belonged to one analyser — and only that one.
       * A button that unmounts must not silence a voice somebody else holds.
       * @param analyser - The analyser of the voice that stopped.
       */
      function clearVisual(analyser) {
        if (visual === null) return;
        if (analyser === null || analyser === undefined) return;
        if (visual.analyser !== analyser) return;
        publishVisual(null);
      }

      /**
       * Watch what the pages can draw.
       *
       * The reader is called at once with the current value, so an overlay
       * that mounts in the middle of a voice still sees that voice.
       * @param listener - Called with `{ variant, analyser }` or null.
       * @returns The unsubscribe function.
       */
      function subscribeVisual(listener) {
        if (typeof listener !== 'function') return function () {};
        visualListeners.push(listener);
        try {
          listener(visual);
        } catch (error) {
          /* a reader that is already gone */
        }
        return function () {
          var at = visualListeners.indexOf(listener);
          if (at !== -1) visualListeners.splice(at, 1);
        };
      }

      return {
        claim: claim,
        stop: stop,
        release: release,
        begin: begin,
        clearElement: clearElement,
        /** What the pages can draw right now, if anything. */
        visual: function () {
          return visual;
        },
        /** Say what the pages can draw now. */
        publish: publishVisual,
        /** Drop the visual of one analyser, when that is the published one. */
        clearVisual: clearVisual,
        /** Follow the visual source; the reader is called at once. */
        subscribe: subscribeVisual,
        /** Make one element; the tests replace the factory. */
        create: function (url) {
          return createElement(url);
        },
        /** The generation the current sound was claimed under. */
        generation: function () {
          return generation;
        },
        /** What is sounding right now, if anything. */
        label: function () {
          return label;
        },
        /** The owner of the slot right now, if any. */
        owner: function () {
          return owner;
        },
        /** Whether the slot belongs to this owner. */
        isOwner: function (tag) {
          return owner === tag;
        },
        /** Replace the element factory (the browser-half tests use it). */
        setCreateElement: function (factory) {
          createElement = factory;
        },
      };
    }

    /** The one sound slot the whole page shares. */
    var audioPlayer = createAudioPlayer();

    // ---------------------------------------------------------------------
    // The visualization inside the message button
    // ---------------------------------------------------------------------
    //
    // While a message's own voice plays, a small visualization takes the
    // place of the speaker glyph inside the very same button: the same box,
    // the same colour, the same weight. It is a part of the message's own
    // interface, not a widget laid over it — no frame, no shadow, no label,
    // and no layout jump, because the box it takes is the glyph's own box.
    //
    // Two of the variants are real: `bars` and `wave` read the audio through
    // the Web Audio API — a frequency spectrum and an oscilloscope. The other
    // two (`pulse`, `dots`) are pure CSS, so they keep working where the
    // analysis is unavailable.
    //
    // The sound always comes first. The analysis context is created inside
    // the click, where the browser still allows it to start, and the element
    // is only re-routed when that context is running: a context that stayed
    // suspended, or one that could not be created at all, leaves the element
    // exactly as it was, and the voice plays as it always did.

    /** The variant that switches the visualization off. */
    var SPECTRUM_OFF = 'off';

    /** The variant that draws the live trace across the composer. */
    var SPECTRUM_OSCILLO = 'oscillo';

    /** The variant that draws the wide frequency bars across the composer. */
    var SPECTRUM_BARS = 'bars';

    /** Every variant id the bundle knows. */
    var SPECTRUM_IDS = ['off', 'bars', 'wave', 'oscillo', 'pulse', 'dots'];

    /** The variants that read the audio itself. */
    var SPECTRUM_ANALYSED = ['bars', 'wave', 'oscillo'];

    /** The variants that draw inside the message button. */
    var SPECTRUM_INLINE = ['wave', 'pulse', 'dots'];

    /** The variants that draw the wide strip over the composer. */
    var SPECTRUM_COMPOSER = ['bars', 'oscillo'];

    /** The variant the card shows when the host reports none. */
    var DEFAULT_SPECTRUM_VARIANT = 'bars';

    /** The variants the settings card offers when the host reports none. */
    var FALLBACK_SPECTRUM_VARIANTS = [
      { id: 'off', label: 'Выключено' },
      { id: 'bars', label: 'Спектр' },
      { id: 'wave', label: 'Волна' },
      { id: 'oscillo', label: 'Осциллограмма' },
      { id: 'pulse', label: 'Пульс' },
      { id: 'dots', label: 'Точки' },
    ];

    /** The visualization's box, in CSS pixels: the glyph's own size. */
    var SPECTRUM_SIZE = 15;

    /**
     * Whether a variant reads the audio through the Web Audio API.
     * @param {string} variant - The variant id.
     * @returns {boolean} True for the analysed variants.
     */
    function spectrumNeedsAnalysis(variant) {
      return SPECTRUM_ANALYSED.indexOf(variant) !== -1;
    }

    /**
     * A known variant id, or the default one.
     * @param {string|undefined|null} value - A reported variant.
     * @returns {string} The variant id.
     */
    function knownSpectrumVariant(value) {
      if (typeof value !== 'string') return DEFAULT_SPECTRUM_VARIANT;
      for (var index = 0; index < SPECTRUM_IDS.length; index += 1) {
        if (SPECTRUM_IDS[index] === value) return value;
      }
      return DEFAULT_SPECTRUM_VARIANT;
    }

    /**
     * The variant a `/speak` manifest asks for, or `off` when it names none.
     *
     * A manifest that says nothing leaves the button as it was: the
     * visualization is an addition, never something the sound depends on.
     * @param {object|null} payload - The manifest.
     * @returns {string} The variant id.
     */
    function spectrumVariantOf(payload) {
      if (payload === null || payload === undefined) return SPECTRUM_OFF;
      var value = payload.spectrum;
      if (typeof value !== 'string') return SPECTRUM_OFF;
      for (var index = 0; index < SPECTRUM_IDS.length; index += 1) {
        if (SPECTRUM_IDS[index] === value) return value;
      }
      return SPECTRUM_OFF;
    }

    /**
     * The audio context the analysis reads from, if the browser has one.
     *
     * Nothing here throws: a browser without the Web Audio API, or one that
     * refuses to create a context, simply has no context — and no context
     * means no visualization, never a broken sound.
     * @returns {object|null} The context, or null.
     */
    function createSpectrumContext() {
      var Ctor = null;
      try {
        if (typeof AudioContext !== 'undefined') Ctor = AudioContext;
        else if (typeof webkitAudioContext !== 'undefined') Ctor = webkitAudioContext;
      } catch (error) {
        return null;
      }
      if (Ctor === null) return null;
      try {
        var context = new Ctor();
        if (context === null || typeof context !== 'object') return null;
        // The context is created inside the click, so the browser lets it
        // start. Its promise is not awaited: the voice must never wait for
        // the analysis.
        var resumed = context.resume();
        if (resumed !== undefined && resumed !== null && typeof resumed.catch === 'function') {
          resumed.catch(function () {
            /* the context stays suspended: no visualization, no harm */
          });
        }
        return context;
      } catch (error) {
        return null;
      }
    }

    /**
     * Close the analysis context; a context that cannot be closed is ignored.
     * @param {object|null} context - The context to close.
     */
    function closeSpectrumContext(context) {
      if (context === null || context === undefined) return;
      try {
        if (typeof context.close === 'function') {
          var closed = context.close();
          if (closed !== undefined && closed !== null && typeof closed.catch === 'function') {
            closed.catch(function () {
              /* it is already closed */
            });
          }
        }
      } catch (error) {
        /* it is already gone */
      }
    }

    /**
     * Whether the media element plays from the page's own origin: only then
     * may its cross-origin mode be switched on, because only then the CORS
     * check is a formality. Media from another origin keeps the mode it has —
     * the visualization then simply does not appear, and the sound is never
     * put at risk for it.
     * @param {object} element - The media element.
     * @returns {boolean} True when the media is same-origin.
     */
    function isSameOriginMedia(element) {
      try {
        if (typeof location === 'undefined' || location === null || typeof location.href !== 'string') return false;
        if (typeof element.src !== 'string' || element.src === '') return false;
        var here = new URL(location.href);
        var there = new URL(element.src, location.href);
        return here.origin === there.origin;
      } catch (error) {
        return false;
      }
    }

    /**
     * One more try at the source node, for a browser that refuses to route a
     * media element that is not in an anonymous cross-origin mode.
     * @param {object} context - The analysis context.
     * @param {object} element - The media element.
     * @returns {object|null} The source node, or null.
     */
    function retrySpectrumSource(context, element) {
      try {
        if (!isSameOriginMedia(element)) return null;
        if (element.crossOrigin !== 'anonymous') element.crossOrigin = 'anonymous';
        return context.createMediaElementSource(element);
      } catch (error) {
        return null;
      }
    }

    /**
     * Route one playing element through an analyser.
     *
     * The element is only touched when everything is in place: a running
     * context, a destination, and the two factory methods. Re-routing the
     * element sends its sound through the graph, and a graph that is not
     * running would swallow the voice — so a context that did not start
     * leaves the element alone. Should the graph still fail after the source
     * was created, the source is connected straight to the destination, so
     * the sound comes out either way.
     * @param {object} element - The element that is about to play.
     * @param {object|null} context - The analysis context.
     * @returns {object|null} `{ analyser, source, context }`, or null.
     */
    function attachSpectrumAnalysis(element, context) {
      if (element === null || element === undefined) return null;
      if (context === null || context === undefined) return null;
      if (context.state !== 'running') return null;
      if (typeof context.createMediaElementSource !== 'function') return null;
      if (typeof context.createAnalyser !== 'function') return null;
      if (!context.destination) return null;
      var source = null;
      try {
        source = context.createMediaElementSource(element);
      } catch (error) {
        // The element was not touched: the sound plays exactly as it would
        // without the visualization.
        source = retrySpectrumSource(context, element);
        if (source === null) return null;
      }
      if (source === null || source === undefined) return null;
      var analyser = null;
      try {
        analyser = context.createAnalyser();
      } catch (error) {
        try {
          source.connect(context.destination);
        } catch (inner) {
          /* nothing else can be done here */
        }
        return null;
      }
      // Wide enough for the composer's trace, which stretches the same data
      // across a whole card: sixty-four samples there read as a jagged star
      // and not as a wave. The button's own glyph simply draws more points.
      try {
        analyser.fftSize = 512;
      } catch (error) {
        /* the analyser keeps its own size */
      }
      try {
        analyser.smoothingTimeConstant = 0.72;
      } catch (error) {
        /* the analyser keeps its own smoothing */
      }
      try {
        source.connect(analyser);
        analyser.connect(context.destination);
      } catch (error) {
        // The element already sounds through the graph: keep the sound by
        // connecting the source straight to the destination.
        try {
          source.connect(context.destination);
        } catch (inner) {
          /* nothing else can be done here */
        }
        return null;
      }
      return { analyser: analyser, source: source, context: context };
    }

    /**
     * Disconnect one analysis from the graph.
     * @param {object|null} analysis - The analysis handle.
     */
    function disconnectSpectrumAnalysis(analysis) {
      if (analysis === null || analysis === undefined) return;
      try {
        if (analysis.source !== null && analysis.source !== undefined && typeof analysis.source.disconnect === 'function') {
          analysis.source.disconnect();
        }
      } catch (error) {
        /* it is already disconnected */
      }
      try {
        if (
          analysis.analyser !== null &&
          analysis.analyser !== undefined &&
          typeof analysis.analyser.disconnect === 'function'
        ) {
          analysis.analyser.disconnect();
        }
      } catch (error) {
        /* it is already disconnected */
      }
    }

    /**
     * The canvas the analysed variants draw on.
     *
     * The canvas is made by hand rather than by React: the drawing needs the
     * real element, and a browser without canvas support simply has none.
     * @returns {object|null} `{ element, context }`, or null.
     */
    function createSpectrumCanvas() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
      var element = null;
      try {
        element = document.createElement('canvas');
      } catch (error) {
        return null;
      }
      if (element === null || element === undefined || typeof element.getContext !== 'function') return null;
      var context = null;
      try {
        context = element.getContext('2d');
      } catch (error) {
        return null;
      }
      if (context === null || context === undefined) return null;
      return { element: element, context: context };
    }

    /**
     * Prepare the canvas for the device it draws on.
     * @param {object} canvas - The `{ element, context }` pair.
     * @param {object|null} host - The element the canvas lives in.
     * @returns {object} `{ width, height }` in CSS pixels.
     */
    function sizeSpectrumCanvas(canvas, host) {
      var width = SPECTRUM_SIZE;
      var height = SPECTRUM_SIZE;
      try {
        if (host !== null && host !== undefined && typeof host.clientWidth === 'number' && host.clientWidth > 0) {
          width = host.clientWidth;
          height = typeof host.clientHeight === 'number' && host.clientHeight > 0 ? host.clientHeight : width;
        }
      } catch (error) {
        /* the host is not laid out yet */
      }
      var ratio = 1;
      try {
        if (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ratio = devicePixelRatio;
      } catch (error) {
        ratio = 1;
      }
      try {
        canvas.element.width = Math.max(1, Math.round(width * ratio));
        canvas.element.height = Math.max(1, Math.round(height * ratio));
      } catch (error) {
        /* the canvas refuses to be resized */
      }
      try {
        if (typeof canvas.context.setTransform === 'function') {
          canvas.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
      } catch (error) {
        /* the context draws in device pixels then */
      }
      return { width: width, height: height };
    }

    /**
     * The colour the visualization draws in: the button's own colour.
     * @param {object|null} host - The element the canvas lives in.
     * @returns {string} A CSS colour.
     */
    function spectrumColor(host) {
      try {
        if (typeof getComputedStyle === 'function' && host !== null && host !== undefined) {
          var style = getComputedStyle(host);
          if (style !== null && style !== undefined && typeof style.color === 'string' && style.color !== '') {
            return style.color;
          }
        }
      } catch (error) {
        /* the host is not in the document */
      }
      return 'currentColor';
    }

    /**
     * A byte array the analyser can fill.
     * @param {number} length - How many bytes.
     * @returns {object} The array.
     */
    function spectrumByteArray(length) {
      var size = length > 0 ? Math.floor(length) : 1;
      try {
        if (typeof Uint8Array === 'function') return new Uint8Array(size);
      } catch (error) {
        /* fall through to the plain array */
      }
      var array = [];
      for (var index = 0; index < size; index += 1) array.push(0);
      return array;
    }

    /**
     * Draw one frame of the frequency spectrum: a row of bars.
     * @param {object} context2d - The 2D context of the canvas.
     * @param {object} analyser - The analyser of the playing element.
     * @param {number} width - The canvas width in CSS pixels.
     * @param {number} height - The canvas height in CSS pixels.
     * @param {string} color - The colour to draw in.
     */
    function drawSpectrumBars(context2d, analyser, width, height, color) {
      var bins = 32;
      try {
        if (typeof analyser.frequencyBinCount === 'number' && analyser.frequencyBinCount > 0) {
          bins = analyser.frequencyBinCount;
        }
      } catch (error) {
        bins = 32;
      }
      var data = spectrumByteArray(bins);
      if (typeof analyser.getByteFrequencyData === 'function') analyser.getByteFrequencyData(data);
      var count = 5;
      var gap = 1;
      var barWidth = (width - gap * (count - 1)) / count;
      context2d.clearRect(0, 0, width, height);
      context2d.fillStyle = color;
      for (var index = 0; index < count; index += 1) {
        var from = Math.floor((index * bins) / count);
        var to = Math.max(from + 1, Math.floor(((index + 1) * bins) / count));
        var peak = 0;
        for (var bin = from; bin < to && bin < bins; bin += 1) {
          if (data[bin] > peak) peak = data[bin];
        }
        var barHeight = (peak / 255) * height;
        if (barHeight < 1) barHeight = 1;
        context2d.fillRect(index * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
    }

    /**
     * Draw one frame of the oscilloscope: the time-domain waveform.
     * @param {object} context2d - The 2D context of the canvas.
     * @param {object} analyser - The analyser of the playing element.
     * @param {number} width - The canvas width in CSS pixels.
     * @param {number} height - The canvas height in CSS pixels.
     * @param {string} color - The colour to draw in.
     */
    function drawSpectrumWave(context2d, analyser, width, height, color) {
      var size = 64;
      try {
        if (typeof analyser.fftSize === 'number' && analyser.fftSize > 0) size = analyser.fftSize;
      } catch (error) {
        size = 64;
      }
      var data = spectrumByteArray(size);
      if (typeof analyser.getByteTimeDomainData === 'function') analyser.getByteTimeDomainData(data);
      context2d.clearRect(0, 0, width, height);
      context2d.strokeStyle = color;
      context2d.lineWidth = 1.2;
      context2d.beginPath();
      for (var index = 0; index < data.length; index += 1) {
        var x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
        var y = height / 2 + ((data[index] - 128) / 128) * (height / 2 - 1);
        if (index === 0) context2d.moveTo(x, y);
        else context2d.lineTo(x, y);
      }
      context2d.stroke();
    }

    /** The composer strip's height, in CSS pixels. */
    var COMPOSER_HEIGHT = 24;

    /**
     * Draw one frame of the composer's oscillogram: a single live trace, the
     * pulsar profile the Unknown Pleasures cover made famous, thin and
     * monochrome, drawn behind the input.
     * @param {object} context2d - The 2D context of the canvas.
     * @param {object} analyser - The analyser of the voice that sounds.
     * @param {number} width - The canvas width in CSS pixels.
     * @param {number} height - The canvas height in CSS pixels.
     * @param {string} color - The colour to draw in.
     */
    function drawOscilloTrace(context2d, analyser, width, height, color) {
      var size = 512;
      try {
        if (typeof analyser.fftSize === 'number' && analyser.fftSize > 0) size = analyser.fftSize;
      } catch (error) {
        size = 512;
      }
      var data = spectrumByteArray(size);
      if (typeof analyser.getByteTimeDomainData === 'function') analyser.getByteTimeDomainData(data);
      context2d.clearRect(0, 0, width, height);
      context2d.strokeStyle = color;
      context2d.lineWidth = 1.2;
      context2d.beginPath();
      var count = data.length;
      // Speech rarely fills the byte range, so the raw trace hugs the middle
      // and reads as a flat thread. The gain makes the line breathe like the
      // pulsar plot instead; the clamp keeps a loud syllable inside the strip
      // instead of folding it over the top.
      var reach = Math.max(1, height / 2 - 1);
      var gain = 2.2;
      for (var index = 0; index < count; index += 1) {
        var x = count > 1 ? (index / (count - 1)) * width : width / 2;
        var offset = ((data[index] - 128) / 128) * reach * gain;
        if (offset > reach) offset = reach;
        if (offset < -reach) offset = -reach;
        var y = height / 2 + offset;
        if (index === 0) context2d.moveTo(x, y);
        else context2d.lineTo(x, y);
      }
      context2d.stroke();
    }

    /**
     * Draw one frame of the composer's wide spectrum: a row of bars across
     * the whole width of the input card.
     *
     * The button's own spectrum draws five bars because it has fifteen
     * pixels; here the strip has the card, so the count follows the width and
     * the bars stay thin enough to read as a spectrum instead of a histogram.
     * @param {object} context2d - The 2D context of the canvas.
     * @param {object} analyser - The analyser of the voice that sounds.
     * @param {number} width - The canvas width in CSS pixels.
     * @param {number} height - The canvas height in CSS pixels.
     * @param {string} color - The colour to draw in.
     */
    function drawComposerBars(context2d, analyser, width, height, color) {
      var bins = 32;
      try {
        if (typeof analyser.frequencyBinCount === 'number' && analyser.frequencyBinCount > 0) {
          bins = analyser.frequencyBinCount;
        }
      } catch (error) {
        bins = 32;
      }
      var data = spectrumByteArray(bins);
      if (typeof analyser.getByteFrequencyData === 'function') analyser.getByteFrequencyData(data);
      // Where the bins sit on the frequency axis: the analyser spans everything
      // up to Nyquist, and almost all of a voice lives in the bottom tenth of
      // that. Laid out linearly the strip lights its left edge and is already
      // dead by the middle — which is exactly what "only half reacts" looks
      // like. The bars are spaced by pitch instead of by bin count: each one
      // owns an equal slice of the octaves between 90 Hz and 9 kHz, so the
      // right half carries the sibilants instead of the silence above them.
      var rate = 48000;
      try {
        if (analyser.context && typeof analyser.context.sampleRate === 'number' && analyser.context.sampleRate > 0) {
          rate = analyser.context.sampleRate;
        }
      } catch (error) {
        rate = 48000;
      }
      var top = Math.max(0, bins - 1);
      var low = 90;
      var high = Math.min(rate / 2, 9000);
      if (high <= low * 2) high = low * 2;
      var count = Math.max(8, Math.min(64, Math.floor(width / 7)));
      var gap = 2;
      var barWidth = Math.max(1, (width - gap * (count - 1)) / count);
      context2d.clearRect(0, 0, width, height);
      context2d.fillStyle = color;
      for (var index = 0; index < count; index += 1) {
        var fromHz = low * Math.pow(high / low, index / count);
        var toHz = low * Math.pow(high / low, (index + 1) / count);
        var from = Math.min(top, Math.floor((fromHz / (rate / 2)) * top));
        var to = Math.min(top, Math.floor((toHz / (rate / 2)) * top));
        if (to < from) to = from;
        var peak = 0;
        for (var bin = from; bin <= to && bin < bins; bin += 1) {
          if (data[bin] > peak) peak = data[bin];
        }
        // A voice is quieter up high by nature, so the right half needs a tilt
        // to stay awake — but only a gentle one. Pushed far enough it levels
        // every bar to the same height and the strip reads as a picket fence
        // instead of a spectrum; kept light, the natural fall of the voice
        // stays visible from left to right and still breathes at the far edge.
        var tilt = 0.85 + 0.55 * (index / Math.max(1, count - 1));
        var level = Math.min(255, peak * tilt);
        var barHeight = Math.pow(level / 255, 0.95) * height;
        if (barHeight < 1.5) barHeight = 1.5;
        context2d.fillRect(index * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
    }

    /**
     * The live strip over the composer: the wide spectrum and the wide trace.
     *
     * It reads the page's one sound slot, not a sound of its own: while a
     * voice with a composer variant (`bars` or `oscillo`) plays, the same
     * analyser the message button built feeds this canvas, and the strip
     * appears above the composer card. When the voice ends the slot withdraws
     * the source and the strip disappears with it. Nothing here can start or
     * stop a sound.
     */
    function ComposerOverlay() {
      var visualState = react.useState(null);
      var visual = visualState[0];
      var setVisual = visualState[1];
      var lastRef = react.useRef(null);
      var hostRef = react.useRef(null);
      var canvasRef = react.useRef(null);
      var frameRef = react.useRef(null);
      var loopRef = react.useRef(0);

      // The slot calls the reader at once, so a composer that mounts in the
      // middle of a voice still sees that voice.
      react.useEffect(() => {
        return audioPlayer.subscribe((next) => {
          if (lastRef.current === next) return;
          lastRef.current = next;
          setVisual(next === undefined ? null : next);
        });
      }, []);

      var analyser = visual === null || visual === undefined ? null : visual.analyser;
      var variant = visual === null || visual === undefined ? null : visual.variant;
      var active =
        variant !== null &&
        variant !== undefined &&
        SPECTRUM_COMPOSER.indexOf(variant) !== -1 &&
        analyser !== null &&
        analyser !== undefined;

      react.useEffect(() => {
        if (!active) return undefined;
        var created = createSpectrumCanvas();
        if (created === null) return undefined;
        var host = hostRef.current;
        if (host !== null && host !== undefined && typeof host.appendChild === 'function') {
          try {
            host.appendChild(created.element);
          } catch (error) {
            /* the host is not in the document */
          }
        }
        created.size = sizeSpectrumCanvas(created, host);
        created.color = spectrumColor(host);
        canvasRef.current = created;
        return function () {
          canvasRef.current = null;
          if (host !== null && host !== undefined && typeof host.removeChild === 'function') {
            try {
              host.removeChild(created.element);
            } catch (error) {
              /* it is already gone */
            }
          }
        };
      }, [active]);

      react.useEffect(() => {
        if (!active) return undefined;
        var created = canvasRef.current;
        if (created === null || created === undefined) return undefined;
        var loop = loopRef.current + 1;
        loopRef.current = loop;
        var stopped = false;
        var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
        var draw = function () {
          if (stopped || loopRef.current !== loop) return;
          // The first frame is the first moment the strip has a width: the
          // effect that built the canvas runs before the browser laid it out,
          // so a canvas still sitting at its default box is measured again
          // here, once, instead of drawing a 15 px trace stretched across the
          // composer.
          if (created.size.width <= SPECTRUM_SIZE) {
            var remeasured = sizeSpectrumCanvas(created, hostRef.current);
            if (remeasured.width > SPECTRUM_SIZE) created.size = remeasured;
          }
          try {
            if (variant === SPECTRUM_BARS) {
              drawComposerBars(created.context, analyser, created.size.width, created.size.height, created.color);
            } else {
              drawOscilloTrace(created.context, analyser, created.size.width, created.size.height, created.color);
            }
          } catch (error) {
            // A canvas that cannot draw must not spin.
            stopped = true;
            return;
          }
          if (raf !== null) frameRef.current = raf(draw);
        };
        draw();
        return function () {
          stopped = true;
          if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
            try {
              cancelAnimationFrame(frameRef.current);
            } catch (error) {
              /* the frame is already gone */
            }
          }
          frameRef.current = null;
        };
      }, [active, analyser, variant]);

      if (!active) return null;
      return h('div', {
        className: 'dvv-osc',
        'data-variant': variant,
        'aria-hidden': 'true',
        style: { height: COMPOSER_HEIGHT + 'px' },
        ref: hostRef,
      });
    }

    /**
     * The speaker button under one assistant message.
     *
     * @param props - `messageId` from the slot owner and `sessionId` from the
     *   plugin's scoped injection.
     */
    function VoiceButton(props) {
      var messageId = props.messageId;
      var sessionId = props.sessionId;

      // The label of this button is the card's language too. Subscribing here
      // is the whole point: a switch in the settings card re-renders every
      // button of the page, so the message rows speak the new language without
      // a reload. The value itself is not read.
      useUiLanguage();

      var phaseState = react.useState('idle');
      var phase = phaseState[0];
      var setPhase = phaseState[1];

      var failureState = react.useState(null);
      var failure = failureState[0];
      var setFailure = failureState[1];

      // The visualization variant the host asked for, and the analysis of the
      // element that is sounding. Both are empty when nothing plays.
      var spectrumState = react.useState(SPECTRUM_OFF);
      var spectrum = spectrumState[0];
      var setSpectrum = spectrumState[1];

      var analysisState = react.useState(null);
      var analysis = analysisState[0];
      var setAnalysis = analysisState[1];

      var controllerRef = react.useRef(null);
      var tokenRef = react.useRef(0);
      var resetTimerRef = react.useRef(null);
      var mountedRef = react.useRef(true);
      // The analysis context of this playback, and the analysis itself.
      var contextRef = react.useRef(null);
      var analysisRef = react.useRef(null);
      // The variant the manifest reported for this playback. The part that
      // starts the sound cannot read the state (it is created once), so the
      // value lives in a ref the part can see.
      var variantRef = react.useRef(SPECTRUM_OFF);
      // The visualization's own DOM: the box it lives in, the canvas inside
      // it, the frame that is scheduled, and the number of the running loop.
      var visRef = react.useRef(null);
      var canvasRef = react.useRef(null);
      var frameRef = react.useRef(null);
      var loopRef = react.useRef(0);
      // This button's identity in the shared sound slot: two buttons are two
      // different owners, so each can tell whether the sound is its own.
      var ownerRef = react.useRef(null);
      if (ownerRef.current === null) ownerRef.current = {};

      var clearResetTimer = react.useCallback(() => {
        if (resetTimerRef.current !== null) {
          clearTimeout(resetTimerRef.current);
          resetTimerRef.current = null;
        }
      }, []);

      /**
       * Forget the analysis of the element that was sounding: the graph is
       * disconnected and the visualization loses its source of data.
       */
      var dropAnalysis = react.useCallback(() => {
        var current = analysisRef.current;
        analysisRef.current = null;
        // The composer's trace reads the very same analyser: once it is gone,
        // the trace must go too, even when the slot was already handed back.
        if (current !== null && current !== undefined) audioPlayer.clearVisual(current.analyser);
        disconnectSpectrumAnalysis(current);
        if (mountedRef.current) setAnalysis(null);
      }, []);

      /** Close the analysis context of this playback. */
      var dropContext = react.useCallback(() => {
        var current = contextRef.current;
        contextRef.current = null;
        closeSpectrumContext(current);
      }, []);

      /** Quiet, self-clearing failure: the row never breaks, it just reports. */
      var reportFailure = react.useCallback(
        (message) => {
          if (!mountedRef.current) return;
          // A failed voice sounds no more: the slot goes back to the page.
          audioPlayer.release(ownerRef.current);
          // And the visualization of that voice goes with it.
          dropAnalysis();
          dropContext();
          setFailure(message);
          setPhase('error');
          setSpectrum(SPECTRUM_OFF);
          clearResetTimer();
          resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = null;
            if (!mountedRef.current) return;
            setFailure(null);
            setPhase('idle');
          }, 4000);
        },
        [clearResetTimer, dropAnalysis, dropContext],
      );

      /** Abort the synthesis request, if one is in flight. */
      var abortRequest = react.useCallback(() => {
        if (controllerRef.current !== null) {
          try {
            controllerRef.current.abort();
          } catch (error) {
            /* already finished */
          }
          controllerRef.current = null;
        }
      }, []);

      /**
       * Reset this button alone: the pending request dies and the phase goes
       * back to idle. It never touches the shared slot, so the shared player
       * may call it when somebody else took the sound away.
       */
      var resetSelf = react.useCallback(() => {
        tokenRef.current += 1;
        clearResetTimer();
        abortRequest();
        // The sound is gone: so is the visualization that belonged to it.
        dropAnalysis();
        dropContext();
        if (mountedRef.current) {
          setFailure(null);
          setPhase('idle');
          setSpectrum(SPECTRUM_OFF);
        }
      }, [abortRequest, clearResetTimer, dropAnalysis, dropContext]);

      /**
       * Stop the voice. The button cuts the sound only when the sound is its
       * own: a voice somebody else started is not this button's to stop.
       */
      var stop = react.useCallback(() => {
        if (audioPlayer.isOwner(ownerRef.current)) {
          // The slot's own stop: it silences the element, invalidates the
          // pending part, and tells the owner (this button) to reset itself.
          audioPlayer.stop();
          return;
        }
        resetSelf();
      }, [resetSelf]);

      react.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          stop();
        };
      }, [stop]);

      /**
       * Play one part to completion, refusing to start when the world moved
       * on: a part that arrives after somebody else took the sound must not
       * steal the output.
       */
      var playPart = react.useCallback((url, generation) => {
        return new Promise((resolve, reject) => {
          if (audioPlayer.generation() !== generation) {
            resolve(false);
            return;
          }
          var element = audioPlayer.create(url);
          element.preload = 'auto';
          // The analysis is attached before the first sound: an element that
          // is re-routed while it plays is the one thing that could break the
          // voice, so the element is only touched when the context runs.
          var partAnalysis = attachSpectrumAnalysis(element, contextRef.current);
          if (partAnalysis !== null) {
            var previous = analysisRef.current;
            analysisRef.current = partAnalysis;
            if (previous !== null) disconnectSpectrumAnalysis(previous);
            if (mountedRef.current) setAnalysis(partAnalysis);
            // One voice sounds at a time, so there is one thing to draw: the
            // composer's wide trace reads exactly this analyser, and it learns
            // about the part the moment that part starts.
            if (SPECTRUM_COMPOSER.indexOf(variantRef.current) !== -1) {
              audioPlayer.publish({ variant: variantRef.current, analyser: partAnalysis.analyser });
            }
          }
          var settled = false;
          var settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          var fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          // The shared player settles this part when somebody else takes the
          // slot: the wait ends, the part does not play.
          audioPlayer.begin(element, () => settle(false));
          element.onended = () => {
            audioPlayer.clearElement(element);
            settle(true);
          };
          element.onerror = () => {
            audioPlayer.clearElement(element);
            fail(new Error('audio playback failed'));
          };
          var started = element.play();
          if (started !== undefined && typeof started.then === 'function') {
            started.then(
              () => {
                // The element may only have finished loading after somebody
                // else took the sound: a late start must stay silent.
                if (audioPlayer.generation() !== generation) {
                  try {
                    element.pause();
                  } catch (error) {
                    /* never started */
                  }
                  settle(false);
                }
              },
              (error) => {
                if (audioPlayer.generation() !== generation) {
                  settle(false);
                  return;
                }
                fail(error);
              },
            );
          }
        });
      }, []);

      var speak = react.useCallback(async () => {
        // Take the page's single sound slot first: whatever was playing —
        // another message, the card's audition — stops right now, and this
        // run owns the output.
        var generation = audioPlayer.claim(
          ownerRef.current,
          'message:' + String(messageId === undefined || messageId === null ? '' : messageId),
          resetSelf,
        );
        var token = tokenRef.current + 1;
        tokenRef.current = token;
        clearResetTimer();
        setFailure(null);
        setPhase('loading');

        // The analysis context is created inside the click, where the browser
        // still lets it start: a context created later would stay suspended,
        // and a suspended context would swallow the voice instead of showing
        // it. Nothing waits for it — the voice does not depend on it.
        var context = createSpectrumContext();
        contextRef.current = context;

        var controller = new AbortController();
        controllerRef.current = controller;

        try {
          var query =
            'sessionId=' +
            encodeURIComponent(sessionId || '') +
            (messageId === undefined || messageId === null || messageId === ''
              ? ''
              : '&messageId=' + encodeURIComponent(messageId));
          var response = await fetch(SPEAK_PATH + '?' + query, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          var payload = await response.json().catch(() => null);
          if (tokenRef.current !== token || audioPlayer.generation() !== generation) return;
          if (controllerRef.current === controller) controllerRef.current = null;
          if (!response.ok || payload === null || payload.ok !== true) {
            reportFailure((payload && payload.code) || 'request failed');
            return;
          }
          var parts = Array.isArray(payload.parts) ? payload.parts : [];
          if (parts.length === 0) {
            reportFailure('nothing-to-say');
            return;
          }
          // The manifest carries the variant the host resolved, so the button
          // learns it from the request it already makes.
          var variant = spectrumVariantOf(payload);
          // The part that starts the sound reads the ref, not the state.
          variantRef.current = variant;
          setSpectrum(variant);
          if (!spectrumNeedsAnalysis(variant)) {
            // This variant needs no audio at all: the context goes away.
            dropContext();
          }
          setPhase('playing');
          for (var index = 0; index < parts.length; index += 1) {
            if (tokenRef.current !== token || audioPlayer.generation() !== generation) return;
            var played = await playPart(parts[index].url, generation);
            if (!played || tokenRef.current !== token || audioPlayer.generation() !== generation) return;
          }
          if (tokenRef.current === token && audioPlayer.generation() === generation && mountedRef.current) {
            audioPlayer.release(ownerRef.current);
            setPhase('idle');
            setSpectrum(SPECTRUM_OFF);
            dropAnalysis();
            dropContext();
          }
        } catch (error) {
          if (tokenRef.current !== token || audioPlayer.generation() !== generation) return;
          if (error && error.name === 'AbortError') return;
          reportFailure((error && error.message) || 'synthesis failed');
        } finally {
          if (controllerRef.current === controller) controllerRef.current = null;
          // The playback is over, one way or another: the analysis context has
          // no reason to live any longer.
          dropContext();
        }
      }, [
        clearResetTimer,
        dropAnalysis,
        dropContext,
        messageId,
        playPart,
        reportFailure,
        resetSelf,
        sessionId,
      ]);

      var onClick = react.useCallback(() => {
        if (phase === 'loading' || phase === 'playing') {
          stop();
          return;
        }
        speak();
      }, [phase, speak, stop]);

      // The visualization inside this button belongs to the variants that fit
      // in it: the wide trace of `oscillo` lives in the composer instead, and
      // the button keeps its stop glyph while that one runs.
      var inline = SPECTRUM_INLINE.indexOf(spectrum) !== -1;
      var analysed = inline && spectrumNeedsAnalysis(spectrum);
      var visible = phase === 'playing' && inline && (!analysed || analysis !== null);

      // The canvas of the analysed variants: it lives as long as the variant
      // does, and it is removed again when the variant changes or the button
      // goes away.
      react.useEffect(() => {
        if (!visible || !analysed) return undefined;
        var created = createSpectrumCanvas();
        if (created === null) return undefined;
        var host = visRef.current;
        if (host !== null && host !== undefined && typeof host.appendChild === 'function') {
          try {
            host.appendChild(created.element);
          } catch (error) {
            /* the host is not in the document */
          }
        }
        var size = sizeSpectrumCanvas(created, host);
        created.size = size;
        created.color = spectrumColor(host);
        canvasRef.current = created;
        return function () {
          canvasRef.current = null;
          if (host !== null && host !== undefined && typeof host.removeChild === 'function') {
            try {
              host.removeChild(created.element);
            } catch (error) {
              /* it is already gone */
            }
          }
        };
      }, [visible, analysed, spectrum]);

      // The drawing loop: it follows the element that is sounding, and it
      // stops the moment the sound does.
      react.useEffect(() => {
        if (!visible || !analysed) return undefined;
        var created = canvasRef.current;
        if (created === null || created === undefined) return undefined;
        var node = analysis === null ? null : analysis.analyser;
        if (node === null || node === undefined) return undefined;
        var loop = loopRef.current + 1;
        loopRef.current = loop;
        var stopped = false;
        var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
        var draw = function () {
          if (stopped || loopRef.current !== loop) return;
          try {
            if (spectrum === 'wave') {
              drawSpectrumWave(created.context, node, created.size.width, created.size.height, created.color);
            } else {
              drawSpectrumBars(created.context, node, created.size.width, created.size.height, created.color);
            }
          } catch (error) {
            // A canvas that cannot draw must not spin.
            stopped = true;
            return;
          }
          if (raf !== null) frameRef.current = raf(draw);
        };
        draw();
        return function () {
          stopped = true;
          if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
            try {
              cancelAnimationFrame(frameRef.current);
            } catch (error) {
              /* the frame is already gone */
            }
          }
          frameRef.current = null;
        };
      }, [visible, analysed, spectrum, analysis]);

      var label = failure === null ? LABELS[phase] : LABELS.error + ': ' + failure;
      var glyph = visible
        ? h(
            'span',
            {
              className: 'dvv-vis dvv-vis-' + spectrum,
              'data-variant': spectrum,
              'aria-hidden': 'true',
              ref: visRef,
            },
            spectrum === 'dots'
              ? [h('i', { key: 'a' }), h('i', { key: 'b' }), h('i', { key: 'c' })]
              : null,
          )
        : phase === 'loading'
          ? h(SpinnerGlyph)
          : phase === 'playing'
            ? h(StopGlyph)
            : phase === 'error'
              ? h(ErrorGlyph)
              : h(SpeakerGlyph);

      return h(
        'button',
        {
          type: 'button',
          className: 'dvv-action',
          'aria-label': label,
          title: label,
          'data-phase': phase,
          'data-voice-v': messageId === undefined ? undefined : messageId,
          onClick: onClick,
        },
        glyph,
      );
    }

    // ---------------------------------------------------------------------
    // Settings card
    // ---------------------------------------------------------------------

    /**
     * Read a signed percent out of an edge-tts rate literal.
     * @param value - `'+6%'`, `'-12%'`, `6`, or anything else.
     * @returns The number, or null when the literal carries none.
     */
    function parseRatePct(value) {
      var match = /^([+-]?\d+(?:\.\d+)?)\s*%?$/.exec(String(value === undefined ? '' : value).trim());
      return match === null ? null : Number(match[1]);
    }

    /**
     * Read a signed Hz out of an edge-tts pitch literal.
     * @param value - `'+12Hz'`, `'-8Hz'`, `12`, or anything else.
     * @returns The number, or null when the literal carries none.
     */
    function parsePitchHz(value) {
      var match = /^([+-]?\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(String(value === undefined ? '' : value).trim());
      return match === null ? null : Number(match[1]);
    }

    /** Render a signed percent the way edge-tts spells it. */
    function formatRate(pct) {
      return (pct >= 0 ? '+' : '') + String(pct) + '%';
    }

    /** Render a signed Hz the way edge-tts spells it. */
    function formatPitch(hz) {
      return (hz >= 0 ? '+' : '') + String(hz) + 'Hz';
    }

    /** Clamp a number into a slider domain. */
    function clampTo(value, range, fallback) {
      var numeric = Number(value);
      if (!isFinite(numeric)) return fallback;
      return Math.min(range.max, Math.max(range.min, Math.round(numeric)));
    }

    /** The shipped slider domains, used until `/config` answers. */
    var FALLBACK_RANGES = {
      rate: { min: -30, max: 40, step: 1 },
      pitch: { min: -40, max: 40, step: 1 },
    };

    /** Fallback preset table, replaced by whatever the host reports. */
    var FALLBACK_PRESETS = [
      { id: 'zhivoy', label: 'Живой', hint: 'дефолт', rate: '+6%', pitch: '+12Hz' },
      { id: 'neytralnyy', label: 'Нейтральный', hint: 'ровно', rate: '0', pitch: '0' },
    ];

    /**
     * Cyrillic letters in Latin, so a Russian name becomes a readable id.
     * The id is internal: the name the user typed stays the label.
     */
    var CYRILLIC_LETTERS = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'sch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };

    /** Prefix every user preset id carries, so it never shadows a built-in. */
    var USER_PRESET_ID_PREFIX = 'user-';

    /**
     * The id of a user preset: the same name always lands on the same preset,
     * and the id never collides with a built-in one.
     * @param label - The name the user typed.
     * @param reservedIds - Ids the deployment's own presets already use.
     * @returns The preset id.
     */
    function presetIdFor(label, reservedIds) {
      var text = String(label === undefined || label === null ? '' : label).toLowerCase();
      var slug = '';
      for (var index = 0; index < text.length; index += 1) {
        var letter = text.charAt(index);
        slug += Object.prototype.hasOwnProperty.call(CYRILLIC_LETTERS, letter) ? CYRILLIC_LETTERS[letter] : letter;
      }
      slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug === '') slug = 'preset';
      var id = USER_PRESET_ID_PREFIX + slug;
      // A deployment preset may already own that name: the user's own preset
      // gets a suffix instead of shadowing it.
      var suffix = 2;
      while (
        reservedIds !== null &&
        typeof reservedIds === 'object' &&
        Object.prototype.hasOwnProperty.call(reservedIds, id)
      ) {
        id = USER_PRESET_ID_PREFIX + slug + '-' + String(suffix);
        suffix += 1;
      }
      return id;
    }

    /**
     * One row for a user preset: the name the user gave it is the label.
     * @param id - The preset id.
     * @param entry - The stored preset: `{ label, rate, pitch, voice? }`.
     * @returns The row the card renders.
     */
    function userPresetRow(id, entry) {
      var value = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      var ratePct = parseRatePct(value.rate);
      var pitchHz = parsePitchHz(value.pitch);
      var rate =
        ratePct === null
          ? String(value.rate === undefined || value.rate === null ? '' : value.rate)
          : formatRate(ratePct);
      var pitch =
        pitchHz === null
          ? String(value.pitch === undefined || value.pitch === null ? '' : value.pitch)
          : formatPitch(pitchHz);
      var row = {
        id: id,
        label:
          typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : String(id),
        hint: rate + ' / ' + pitch,
        rate: rate,
        pitch: pitch,
        user: true,
      };
      if (typeof value.voice === 'string' && value.voice.trim() !== '') row.voice = value.voice.trim();
      return row;
    }

    /**
     * The preset rows the card renders: the built-in and deployment rows the
     * host reported, plus the user's own presets — the staged ones when the
     * user just edited the pool, the host's rows otherwise.
     * @param hostRows - The rows `GET /dsh-voice-v/config` reported.
     * @param stagedUserPresets - The staged `userPresets` write, or null.
     * @returns The ordered rows.
     */
    function mergePresetRows(hostRows, stagedUserPresets) {
      var rows = [];
      var seen = {};
      var index;
      for (index = 0; index < hostRows.length; index += 1) {
        var row = hostRows[index];
        if (row === null || typeof row !== 'object') continue;
        // The user's own rows are rebuilt from the pool below, so the card
        // shows the pool as the user just edited it.
        if (row.user === true) continue;
        if (Object.prototype.hasOwnProperty.call(seen, row.id)) continue;
        seen[row.id] = true;
        rows.push(row);
      }
      if (stagedUserPresets !== null) {
        for (var id in stagedUserPresets) {
          if (!Object.prototype.hasOwnProperty.call(stagedUserPresets, id)) continue;
          rows.push(userPresetRow(id, stagedUserPresets[id]));
        }
        return rows;
      }
      for (index = 0; index < hostRows.length; index += 1) {
        var own = hostRows[index];
        if (own === null || typeof own !== 'object' || own.user !== true) continue;
        if (Object.prototype.hasOwnProperty.call(seen, own.id)) continue;
        seen[own.id] = true;
        rows.push(own);
      }
      return rows;
    }

    /**
     * The line under a preset's name: what the host says about it, plus the
     * tempo and the tone it stands for. A row that says nothing but its values
     * shows them once.
     * @param preset - The preset row.
     * @returns The hint line.
     */
    function presetHint(preset) {
      var values = preset.rate + ' / ' + preset.pitch;
      if (typeof preset.hint !== 'string' || preset.hint === '' || preset.hint === values) return values;
      return preset.hint + ' · ' + values;
    }

    /**
     * The user's own presets as the map the next write carries: every visible
     * user row, with its label, tempo, tone, and voice when it has one.
     * @param rows - The visible preset rows.
     * @returns The `userPresets` map.
     */
    function userPresetMap(rows) {
      var map = {};
      for (var index = 0; index < rows.length; index += 1) {
        var row = rows[index];
        if (row === null || typeof row !== 'object' || row.user !== true) continue;
        var entry = { label: row.label, rate: row.rate, pitch: row.pitch };
        if (typeof row.voice === 'string' && row.voice !== '') entry.voice = row.voice;
        map[row.id] = entry;
      }
      return map;
    }

    /**
     * Merge the built-in terms with the user's overrides into display rows.
     * @param defaults - Built-in term → spoken map, as reported by the host.
     * @param overrides - The user's own term → spoken map.
     * @returns Ordered `{ term, spoken, isDefault }` rows.
     */
    function buildDictionaryRows(defaults, overrides) {
      var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
      var mine = overrides !== null && typeof overrides === 'object' ? overrides : {};
      var rows = [];
      var seen = {};
      for (var term in builtIn) {
        if (!Object.prototype.hasOwnProperty.call(builtIn, term)) continue;
        seen[term] = true;
        rows.push({
          term: term,
          spoken: Object.prototype.hasOwnProperty.call(mine, term) ? mine[term] : builtIn[term],
          isDefault: true,
        });
      }
      for (var extra in mine) {
        if (!Object.prototype.hasOwnProperty.call(mine, extra) || seen[extra]) continue;
        rows.push({ term: extra, spoken: mine[extra], isDefault: false });
      }
      return rows;
    }

    /**
     * Project edited rows back into the user layer: only terms that differ from
     * the built-in reading are stored, so clearing a row re-inherits the default.
     * @param rows - Edited rows.
     * @param defaults - Built-in term → spoken map.
     * @returns The term → spoken map to write.
     */
    function dictionaryOverrideFromRows(rows, defaults) {
      var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
      var overrides = {};
      for (var index = 0; index < rows.length; index += 1) {
        var row = rows[index];
        var term = String(row.term || '').trim();
        var spoken = String(row.spoken || '').trim();
        if (term === '' || spoken === '') continue;
        if (Object.prototype.hasOwnProperty.call(builtIn, term) && builtIn[term] === spoken) continue;
        overrides[term] = spoken;
      }
      return overrides;
    }

    /**
     * The Russian word for a count of terms: 1 термин, 2 термина, 5 терминов.
     * @param count - How many terms.
     * @returns The word in the right form.
     */
    function termsWord(count) {
      var hundreds = Math.abs(count) % 100;
      var units = hundreds % 10;
      if (hundreds > 10 && hundreds < 20) return 'терминов';
      if (units > 1 && units < 5) return 'термина';
      if (units === 1) return 'термин';
      return 'терминов';
    }

    // ---------------------------------------------------------------------
    // The synthesis provider
    // ---------------------------------------------------------------------
    //
    // `edge-tts` is the default and stays the default: the local CLI needs no
    // key and no network. The custom endpoint is an opt-in for a deployment
    // that has keys of its own — the ids below mirror the host half's
    // (`TTS_PROVIDER_EDGE` / `TTS_PROVIDER_CUSTOM` in `lib/config.js`), and
    // the card renders the provider the host reports.

    /** The local `edge-tts` CLI: the default provider. */
    var TTS_PROVIDER_EDGE = 'edge';

    /** The OpenAI-compatible HTTP endpoint. */
    var TTS_PROVIDER_CUSTOM = 'custom';

    /** The Yandex SpeechKit service. */
    var TTS_PROVIDER_YANDEX = 'yandex';

    /** The Google Cloud Text-to-Speech service. */
    var TTS_PROVIDER_GOOGLE = 'google';

    /** The free Google route: no key, one voice, no tempo or tone. */
    var TTS_PROVIDER_GOOGLE_FREE = 'google-free';

    /** The providers the card offers, in the order it offers them. */
    var TTS_PROVIDER_OPTIONS = [
      { id: TTS_PROVIDER_EDGE, label: 'edge-tts (по умолчанию)' },
      { id: TTS_PROVIDER_CUSTOM, label: 'OpenAI-совместимый' },
      { id: TTS_PROVIDER_YANDEX, label: 'Яндекс SpeechKit' },
      { id: TTS_PROVIDER_GOOGLE, label: 'Google Cloud TTS' },
      { id: TTS_PROVIDER_GOOGLE_FREE, label: 'Google (без ключа)' },
    ];

    /** The voices the Yandex service knows. */
    var YANDEX_VOICE_OPTIONS = [
      { id: 'marina', label: 'Марина' },
      { id: 'ermil', label: 'Ермиль' },
      { id: 'pavel', label: 'Павел' },
      { id: 'male', label: 'Мужской' },
      { id: 'jane', label: 'Джейн' },
    ];

    /**
     * The Russian voices of the Google service, in the order the card offers
     * them. The names are the service's own; the list mirrors the host half's
     * `GOOGLE_VOICES`.
     */
    var GOOGLE_VOICE_OPTIONS = [
      { id: 'ru-RU-Wavenet-A', label: 'ru-RU-Wavenet-A' },
      { id: 'ru-RU-Wavenet-B', label: 'ru-RU-Wavenet-B' },
      { id: 'ru-RU-Wavenet-C', label: 'ru-RU-Wavenet-C' },
      { id: 'ru-RU-Wavenet-D', label: 'ru-RU-Wavenet-D' },
      { id: 'ru-RU-Standard-A', label: 'ru-RU-Standard-A' },
      { id: 'ru-RU-Standard-B', label: 'ru-RU-Standard-B' },
    ];
    // ---------------------------------------------------------------------
    // The voice catalogue
    // ---------------------------------------------------------------------
    //
    // The catalogue itself lives in the host half (`VOICE_OPTIONS` in
    // `lib/config.js`) and reaches the card through `GET /dsh-voice-v/config`.
    // The bundle keeps no voice list of its own: what the host reports is what
    // the select offers, and a voice the host does not know is still shown.

    /** The voice the card falls back to when the user clears the custom field. */
    var FALLBACK_VOICE = 'ru-RU-SvetlanaNeural';

    /** The value the «Свой голос…» option carries inside the select. */
    var CUSTOM_VOICE_OPTION = '__dsh-voice-v-custom__';

    /** The group a voice outside the catalogue is shown in. */
    var VOICE_OTHER_GROUP = 'Другие';

    /**
     * Group the voice catalogue the host reported into the option groups the
     * select renders. The order of the groups is the order the host listed
     * them in.
     * @param list - The `voiceList` the host reported.
     * @returns `[{ name, entries: [{ id, label }] }]`.
     */
    function groupVoices(list) {
      var groups = [];
      var index = {};
      if (!Array.isArray(list)) return groups;
      for (var position = 0; position < list.length; position += 1) {
        var entry = list[position];
        if (entry === null || typeof entry !== 'object') continue;
        var id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (id === '') continue;
        var label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : id;
        var name = typeof entry.group === 'string' && entry.group.trim() !== '' ? entry.group.trim() : VOICE_OTHER_GROUP;
        if (!Object.prototype.hasOwnProperty.call(index, name)) {
          index[name] = groups.length;
          groups.push({ name: name, entries: [] });
        }
        groups[index[name]].entries.push({ id: id, label: label });
      }
      return groups;
    }

    /**
     * The catalogue entry of one voice id, if the catalogue knows it.
     * @param groups - The grouped catalogue.
     * @param id - The voice id.
     * @returns The entry, or null.
     */
    function findVoice(groups, id) {
      for (var index = 0; index < groups.length; index += 1) {
        var entries = groups[index].entries;
        for (var position = 0; position < entries.length; position += 1) {
          if (entries[position].id === id) return entries[position];
        }
      }
      return null;
    }

    /**
     * The catalogue as the select renders it, with a voice outside the
     * catalogue added as an extra option: the select must show the truth, so
     * a stored voice the host does not know is still on screen.
     * @param groups - The grouped catalogue.
     * @param extra - The voice to add, or null when the catalogue knows it.
     * @returns The groups the select renders.
     */
    function voiceOptionGroups(groups, extra) {
      if (extra === null) return groups;
      var out = [];
      for (var index = 0; index < groups.length; index += 1) {
        out.push({ name: groups[index].name, entries: groups[index].entries.slice() });
      }
      for (var position = 0; position < out.length; position += 1) {
        if (out[position].name === VOICE_OTHER_GROUP) {
          out[position].entries.push(extra);
          return out;
        }
      }
      out.push({ name: VOICE_OTHER_GROUP, entries: [extra] });
      return out;
    }

    /**
     * The children of the voice select: one optgroup per catalogue group, and
     * the final «Свой голос…» option that swaps the select for a text field.
     * @param groups - The grouped catalogue.
     * @returns The select's children.
     */
    function voiceOptionChildren(groups) {
      var children = [];
      for (var index = 0; index < groups.length; index += 1) {
        var group = groups[index];
        var options = [];
        for (var position = 0; position < group.entries.length; position += 1) {
          var entry = group.entries[position];
          options.push(h('option', { key: entry.id, value: entry.id }, entry.label));
        }
        children.push(h('optgroup', { key: group.name, label: group.name }, options));
      }
      children.push(h('option', { key: 'custom', value: CUSTOM_VOICE_OPTION }, 'Свой голос…'));
      return children;
    }

    /**
     * The settings card: presets, live sliders, the pronunciation dictionary,
     * the code switch, and a Listen button that auditions unsaved values.
     *
     * Every value on screen is either the host's resolved setting or a local
     * edit waiting for Save. Nothing is written until Save: the card stages the
     * fields the user touched and sends one `scope.set` / `scope.unset` per
     * field, so a reset is a genuine clear (the field re-inherits the plugin
     * row's config) rather than a copy of the current value.
     *
     * @param props - `scope`, the bound settings scope over the `dsh-voice-v`
     *   settings namespace injected by the registration. The name `scope` is
     *   kept rather than `form` on purpose: the slot owner already passes its
     *   own `form` face, and two different `form` faces on one props object
     *   would collide.
     */
    function VoiceSettingsCard(props) {
      var scope = props.scope;

      var snapshotState = react.useState(scope ? scope.getSnapshot() : null);
      var snapshot = snapshotState[0];
      var setSnapshot = snapshotState[1];

      var configState = react.useState(null);
      var config = configState[0];
      var setConfig = configState[1];

      var draftState = react.useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];

      var pendingState = react.useState({});
      var pending = pendingState[0];
      var setPending = pendingState[1];

      var noteState = react.useState(null);
      var note = noteState[0];
      var setNote = noteState[1];

      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var newTermState = react.useState('');
      var newTerm = newTermState[0];
      var setNewTerm = newTermState[1];

      var newSpokenState = react.useState('');
      var newSpoken = newSpokenState[0];
      var setNewSpoken = newSpokenState[1];

      // The name of the preset the user is about to make out of the sliders.
      var presetNameState = react.useState('');
      var presetName = presetNameState[0];
      var setPresetName = presetNameState[1];

      // Whether the voice is picked from the catalogue or typed by hand. The
      // select is the default view; «Свой голос…» swaps it for the text field.
      var customVoiceState = react.useState(false);
      var customVoice = customVoiceState[0];
      var setCustomVoice = customVoiceState[1];

      // The text the user typed into the hand-written voice field. It lives on
      // its own, apart from the draft: the draft is rebuilt from the host, and
      // that rebuild would wipe the text in the middle of a word.
      var customVoiceInputState = react.useState('');
      var customVoiceInput = customVoiceInputState[0];
      var setCustomVoiceInput = customVoiceInputState[1];

      // What the user typed into the API key field. The key itself never
      // reaches the browser: the field starts empty, and the host reports only
      // whether a key is set. The state holds the new text until it is saved.
      var apiKeyState = react.useState('');
      var apiKeyInput = apiKeyState[0];
      var setApiKeyInput = apiKeyState[1];

      // The same for the Yandex key: a secret the browser never sees.
      var yandexKeyState = react.useState('');
      var yandexKeyInput = yandexKeyState[0];
      var setYandexKeyInput = yandexKeyState[1];

      // And the same for the Google key.
      var googleKeyState = react.useState('');
      var googleKeyInput = googleKeyState[0];
      var setGoogleKeyInput = googleKeyState[1];

      var mountedRef = react.useRef(true);
      // The card's identity in the shared sound slot: the audition takes the
      // same slot a message voice takes, so the two never overlap.
      var ownerRef = react.useRef(null);
      if (ownerRef.current === null) ownerRef.current = {};

      react.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          // The card goes away with its audition: the slot goes back to the
          // page, and the message voices keep the right to be heard.
          if (audioPlayer.isOwner(ownerRef.current)) audioPlayer.stop();
        };
      }, []);

      react.useEffect(() => {
        if (!scope) return undefined;
        setSnapshot(scope.getSnapshot());
        return scope.subscribe(() => {
          if (mountedRef.current) setSnapshot(scope.getSnapshot());
        });
      }, [scope]);

      // The host payload is re-read whenever the form's snapshot changes: the
      // host may re-mount the plugin, re-serve the namespace, or refuse a
      // write at any time, and a footer frozen at the first fetch would keep
      // claiming a state the host left long ago.
      react.useEffect(() => {
        var alive = true;
        fetch(CONFIG_PATH, { headers: { Accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (alive && payload !== null && payload !== undefined && payload.ok === true) setConfig(payload);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [snapshot]);

      var ready = snapshot !== null && snapshot.status === 'ready';
      var effective = ready && snapshot.value ? snapshot.value : null;
      var userLayer = ready && snapshot.user && typeof snapshot.user === 'object' ? snapshot.user : {};
      var writable = ready && snapshot.writable === true;

      var hostPresets =
        config !== null && Array.isArray(config.presetList) && config.presetList.length > 0
          ? config.presetList
          : FALLBACK_PRESETS;
      // The user's own presets: the staged write when there is one — the card
      // shows the pool as the user just edited it — and the host's rows
      // otherwise.
      var stagedUserPresets =
        pending.userPresets !== undefined &&
        pending.userPresets !== null &&
        pending.userPresets.op === 'set' &&
        pending.userPresets.value !== null &&
        typeof pending.userPresets.value === 'object'
          ? pending.userPresets.value
          : null;
      var presets = mergePresetRows(hostPresets, stagedUserPresets);
      var rateRange = (config !== null && config.rateRange) || FALLBACK_RANGES.rate;
      var pitchRange = (config !== null && config.pitchRange) || FALLBACK_RANGES.pitch;
      var defaults = config !== null && config.dictionaryDefaults ? config.dictionaryDefaults : null;
      var previewText =
        config !== null && typeof config.defaultPreviewText === 'string'
          ? config.defaultPreviewText
          : 'Проверка озвучки.';
      // The voice the card falls back to when nothing else says: the host's own
      // default, mirrored by the bundle so the two halves cannot drift.
      var defaultVoice =
        config !== null && typeof config.defaultVoice === 'string' && config.defaultVoice.trim() !== ''
          ? config.defaultVoice.trim()
          : FALLBACK_VOICE;

      // Two hosts, two shapes of the same truth.
      //
      //   * The form (`effective`) is the Host's own live value: the field the
      //     user just saved is in it, and it is fresh the moment the write
      //     lands.
      //   * The payload (`config`) is the host's resolved view: the tempo and
      //     the tone a preset hands down when nobody overrode them, the
      //     voice catalogue, the key flags.
      //
      // The form wins where it speaks. The payload only fills the gaps — the
      // fields the form leaves out because nobody set them and the preset
      // decides. The other way round the card undoes the user's own choice
      // the moment the host answers, because the payload is a second, slower
      // copy of the same row.
      var resolved = react.useMemo(
        function () {
          var out = {};
          if (effective !== null) {
            for (var key in effective) {
              if (Object.prototype.hasOwnProperty.call(effective, key)) out[key] = effective[key];
            }
          }
          if (config !== null) {
            var carried = [
              'preset',
              'rate',
              'pitch',
              'voice',
              'stripCode',
              'autoPreset',
              'spectrum',
              'dictionary',
              'ttsProvider',
              'customBaseUrl',
              'customModel',
              'yandexVoice',
              'uiLanguage',
            ];
            for (var index = 0; index < carried.length; index += 1) {
              var name = carried[index];
              // The form already answered for this field: keep its answer.
              if (out[name] !== undefined && out[name] !== null) continue;
              if (config[name] !== undefined && config[name] !== null) out[name] = config[name];
            }
          }
          // The key is a secret: the card shows a password field that starts
          // empty, so the value is dropped here and never reaches the screen.
          delete out.customApiKey;
          delete out.yandexApiKey;
          return out;
        },
        [effective, config],
      );

      // The language of the interface. It lives outside the draft on purpose:
      // the draft is rebuilt from the host, and every staged edit rewrites the
      // whole object, so a field of its own would be dropped by one or the
      // other. The store is what both halves read, and switching it re-renders
      // every component that subscribes to it.
      var uiLanguage = useUiLanguage();
      var languageOptions =
        config !== null && Array.isArray(config.uiLanguages) && config.uiLanguages.length > 0
          ? config.uiLanguages.filter(
              (entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string',
            )
          : UI_LANGUAGES;
      var stagedLanguage =
        pending.uiLanguage !== undefined && pending.uiLanguage !== null && pending.uiLanguage.op === 'set'
          ? pending.uiLanguage.value
          : null;
      // What the card should speak: the staged choice first, then the host's,
      // then the default. A hand-edited value the card does not know costs the
      // user nothing — it falls back to Russian.
      var wantedLanguage = normalizeUiLanguage(stagedLanguage !== null ? stagedLanguage : resolved.uiLanguage);
      react.useEffect(() => {
        setUiLanguage(wantedLanguage);
      }, [wantedLanguage]);

      // Rebuild the draft from the host value whenever the card holds no edits.
      var pendingCount = Object.keys(pending).length;
      react.useEffect(() => {
        if (effective === null && config === null) return;
        if (pendingCount > 0) return;
        var userDictionary = userLayer.dictionary && typeof userLayer.dictionary === 'object' ? userLayer.dictionary : null;
        setDraft({
          preset: resolved.preset,
          ratePct: parseRatePct(resolved.rate),
          pitchHz: parsePitchHz(resolved.pitch),
          stripCode: resolved.stripCode !== false,
          autoPreset: resolved.autoPreset !== false,
          yoMode: typeof resolved.yoMode === 'string' ? resolved.yoMode : 'as-is',
          voice: resolved.voice,
          spectrum: knownSpectrumVariant(resolved.spectrum),
          ttsProvider:
            resolved.ttsProvider === TTS_PROVIDER_CUSTOM
              ? TTS_PROVIDER_CUSTOM
              : resolved.ttsProvider === TTS_PROVIDER_YANDEX
                ? TTS_PROVIDER_YANDEX
                : TTS_PROVIDER_EDGE,
          customBaseUrl: typeof resolved.customBaseUrl === 'string' ? resolved.customBaseUrl : '',
          customModel: typeof resolved.customModel === 'string' ? resolved.customModel : '',
          yandexVoice: typeof resolved.yandexVoice === 'string' ? resolved.yandexVoice : 'marina',
          rows: buildDictionaryRows(
            defaults,
            userDictionary !== null ? userDictionary : resolved.dictionary,
          ),
        });
      }, [resolved, defaults, pendingCount, userLayer]);

      /** Stage one field write. */
      var stage = react.useCallback((field, value) => {
        setPending((current) => {
          var next = {};
          for (var key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
          }
          next[field] = { op: 'set', value: value };
          return next;
        });
      }, []);

      /** Stage one field clear, so it re-inherits the plugin row's config. */
      var stageClear = react.useCallback((field) => {
        setPending((current) => {
          var next = {};
          for (var key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
          }
          next[field] = { op: 'unset' };
          return next;
        });
      }, []);

      /** Drop every staged edit and go back to what the host reports. */
      var discard = react.useCallback(() => {
        setPending({});
        setNote(null);
      }, []);

      var save = react.useCallback(async () => {
        if (!scope || !writable) return;
        var fields = Object.keys(pending);
        if (fields.length === 0) return;
        setBusy(true);
        setNote(null);
        try {
          // `ConfigForm.set` / `unset` resolve false when the Host refused the
          // write, so a rejected field keeps its staged edit for the user to
          // correct instead of being reported as saved.
          var accepted = true;
          for (var index = 0; index < fields.length; index += 1) {
            var field = fields[index];
            var entry = pending[field];
            var wrote = entry.op === 'unset' ? await scope.unset(field) : await scope.set(field, entry.value);
            if (wrote === false) accepted = false;
          }
          if (mountedRef.current && accepted) {
            setPending({});
            setNote({ tone: 'ok', text: 'Сохранено.' });
          } else if (mountedRef.current) {
            setNote({ tone: 'error', text: 'Хост не принял часть значений — правки оставлены.' });
          }
        } catch (error) {
          if (mountedRef.current) {
            setNote({ tone: 'error', text: 'Не сохранилось: ' + String((error && error.message) || error) });
          }
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, [pending, scope, writable]);

      /**
       * Write one secret field to the host right now, without waiting for the
       * card's own Save. The key is a secret: it goes to the host and nowhere
       * else, and the field goes blank again when the host took it.
       * @param field - The settings field to write.
       * @param value - The text the user typed.
       * @param clearInput - The setter that empties the field.
       */
      var saveSecret = react.useCallback(
        async (field, value, clearInput) => {
          if (!scope || !writable) return;
          var text = value === undefined || value === null ? '' : String(value).trim();
          if (text === '') return;
          setBusy(true);
          setNote(null);
          try {
            var wrote = await scope.set(field, text);
            if (!mountedRef.current) return;
            if (wrote === false) {
              setNote({ tone: 'error', text: 'Хост не принял ключ.' });
              return;
            }
            setPending((current) => {
              var next = {};
              for (var key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
              }
              delete next[field];
              return next;
            });
            clearInput();
            setNote({ tone: 'ok', text: 'Ключ сохранён.' });
          } catch (error) {
            if (mountedRef.current) {
              setNote({ tone: 'error', text: 'Не сохранилось: ' + String((error && error.message) || error) });
            }
          } finally {
            if (mountedRef.current) setBusy(false);
          }
        },
        [scope, writable],
      );

      /** The audition lost the sound slot: the card goes back to idle. */
      var resetPreview = react.useCallback(() => {
        if (mountedRef.current) setBusy(false);
      }, []);

      /** Play one preview request, cancelling whatever was playing. */
      var playPreview = react.useCallback(async (text, options) => {
        // The page allows one sound at a time: the audition takes the same
        // slot a message voice takes, so a message that is still being read
        // stops right now — and the other way round.
        var generation = audioPlayer.claim(ownerRef.current, 'preview', resetPreview);
        setBusy(true);
        setNote(null);
        try {
          var response = await fetch(PREVIEW_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify(options),
          });
          // A host that gates non-GET plugin requests answers 401/403/405; the
          // route accepts the same values as query parameters, so retry there
          // instead of leaving the button dead.
          if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 405)) {
            var query = [];
            for (var key in options) {
              if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
              if (options[key] === undefined || options[key] === null) continue;
              query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(options[key])));
            }
            response = await fetch(PREVIEW_PATH + '?' + query.join('&'), {
              method: 'GET',
              headers: { Accept: 'audio/mpeg' },
            });
          }
          if (!response.ok) {
            var detail = await response.json().catch(() => null);
            throw new Error((detail && detail.code) || 'preview ' + String(response.status));
          }
          var blob = await response.blob();
          // A message voice may have taken the slot while the MP3 was on its
          // way: the late preview must stay silent.
          if (!mountedRef.current || audioPlayer.generation() !== generation) return;
          var url = URL.createObjectURL(blob);
          var element = audioPlayer.create(url);
          // The slot hands the object URL back when somebody else takes the
          // sound: a stopped preview must not leak its blob.
          audioPlayer.begin(element, () => {
            URL.revokeObjectURL(url);
          });
          element.onended = () => {
            audioPlayer.clearElement(element);
            audioPlayer.release(ownerRef.current);
            URL.revokeObjectURL(url);
          };
          element.onerror = () => {
            audioPlayer.clearElement(element);
            audioPlayer.release(ownerRef.current);
            URL.revokeObjectURL(url);
          };
          await element.play();
        } catch (error) {
          if (mountedRef.current && audioPlayer.generation() === generation) {
            setNote({ tone: 'error', text: 'Прослушать не вышло: ' + String((error && error.message) || error) });
          }
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, [resetPreview]);

      /** The values Listen auditions: exactly what the sliders show right now. */
      var previewOptions = react.useCallback(
        (text) => ({
          text: text,
          preset: draft ? draft.preset : undefined,
          rate: draft && draft.ratePct !== null ? formatRate(draft.ratePct) : undefined,
          pitch: draft && draft.pitchHz !== null ? formatPitch(draft.pitchHz) : undefined,
          // The voice the control shows: an empty field means the default.
          voice: draft
            ? typeof draft.voice === 'string' && draft.voice !== ''
              ? draft.voice
              : defaultVoice
            : undefined,
          stripCode: draft ? draft.stripCode : undefined,
          yoMode: draft ? draft.yoMode : undefined,
        }),
        [draft, defaultVoice],
      );

      // The settings surface may ask the card for a one-liner summary as well
      // as the full form, so answer it rather than rendering a full form into
      // a one-liner. Every hook above has already run by now, so React sees the
      // same hook order in both views.
      if (props.view === 'summary') {
        // A one-liner the settings surface shows in place of the form. It is the
        // card's own words, so it follows the card's language: the dictionary
        // is asked here because the string never goes through `h`.
        return translateText('Озвучка ответов: голос, темп, тон и словарь произношения.');
      }

      if (!scope) {
        return h(
          'div',
          { className: 'dvv-card' },
          h('p', { className: 'dvv-title' }, 'Озвучка ответов (dsh-voice-v)'),
          h('p', { className: 'dvv-hint' }, 'Служба настроек недоступна — карточка не смонтирована.'),
        );
      }

      if (!ready) {
        return h(
          'div',
          { className: 'dvv-card' },
          h('div', { className: 'dvv-head' }, [
            h('p', { key: 't', className: 'dvv-title' }, 'Озвучка ответов (dsh-voice-v)'),
            h('p', { key: 'd', className: 'dvv-desc' }, 'Голос, темп, тон, словарь.'),
          ]),
          h(
            'p',
            { className: 'dvv-hint' },
            snapshot !== null && snapshot.mode === 'memory'
              ? 'Эта страница не на loopback: правки живут только в памяти процесса и не переживут перезагрузку.'
              : snapshot !== null && snapshot.status === 'unavailable'
                ? 'Пространство настроек «' +
                  SETTINGS_NAMESPACE +
                  '» не опубликовано этим хостом: работает только config из cordis.patch.yml.'
                : 'Настройки загружаются…',
          ),
        );
      }

      if (draft === null) {
        return h(
          'div',
          { className: 'dvv-card' },
          h('p', { className: 'dvv-title' }, 'Озвучка ответов (dsh-voice-v)'),
          h('p', { className: 'dvv-hint' }, 'Настройки загружаются…'),
        );
      }

      var dirty = pendingCount > 0;
      var disabled = busy || !writable;

      // The voice catalogue the host reported, and the voice in use. A voice
      // the catalogue does not know is still shown: it is added as an extra
      // option, so the select never hides what is really in use.
      var voiceCatalogue = groupVoices(config !== null && Array.isArray(config.voiceList) ? config.voiceList : null);
      var currentVoice = typeof draft.voice === 'string' && draft.voice !== '' ? draft.voice : defaultVoice;
      var knownVoice = findVoice(voiceCatalogue, currentVoice);
      var extraVoice =
        knownVoice === null ? { id: currentVoice, label: currentVoice + ' · вне каталога' } : null;
      var voiceGroups = voiceOptionGroups(voiceCatalogue, extraVoice);

      // The provider in use, and whether the endpoint's own fields belong on
      // the screen. The key is a secret: the host reports only whether one is
      // set, and the field itself starts empty.
      var customProvider = draft.ttsProvider === TTS_PROVIDER_CUSTOM;
      var yandexProvider = draft.ttsProvider === TTS_PROVIDER_YANDEX;
      var googleProvider = draft.ttsProvider === TTS_PROVIDER_GOOGLE;
      var apiKeySet = config !== null && config.customApiKeySet === true;
      var yandexKeySet = config !== null && config.yandexApiKeySet === true;
      var googleKeySet = config !== null && config.googleApiKeySet === true;
      // The host reports the chosen Google voice; the card shows that and
      // stages the write. A provider the user never opens costs the draft
      // nothing.
      var googleVoice =
        config !== null && typeof config.googleVoice === 'string' && config.googleVoice !== ''
          ? config.googleVoice
          : 'ru-RU-Wavenet-A';

      // The providers the host reported; the bundle keeps a copy of its own
      // for a host that reports none.
      var providerOptions =
        config !== null && Array.isArray(config.ttsProviders) && config.ttsProviders.length > 0
          ? config.ttsProviders.filter(
              (provider) => provider !== null && typeof provider === 'object' && typeof provider.id === 'string',
            )
          : TTS_PROVIDER_OPTIONS;

      // The variants the host reported: the card renders what the host offers
      // and keeps a copy of its own for a host that reports none.
      var spectrumOptions =
        config !== null && Array.isArray(config.spectrumVariants) && config.spectrumVariants.length > 0
          ? config.spectrumVariants.filter(
              (variant) => variant !== null && typeof variant === 'object' && typeof variant.id === 'string',
            )
          : FALLBACK_SPECTRUM_VARIANTS;

      /** Put one voice into the draft and stage it as the single `voice` write. */
      var onVoice = (value) => {
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: value,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        stage('voice', value);
      };

      /** The select changed: a catalogue voice, or the hand-written field. */
      var onVoiceChoice = (value) => {
        if (value === CUSTOM_VOICE_OPTION) {
          // The hand-written field opens empty: the id is typed from scratch,
          // and an empty field is not a voice yet.
          setCustomVoice(true);
          setCustomVoiceInput('');
          return;
        }
        setCustomVoice(false);
        setCustomVoiceInput('');
        onVoice(value);
      };

      /**
       * The hand-written field changed. The text lives on its own state; an
       * empty field means "not typed yet" and writes nothing at all.
       */
      var onCustomVoice = (value) => {
        var text = value === undefined || value === null ? '' : String(value);
        setCustomVoiceInput(text);
        var trimmed = text.trim();
        if (trimmed === '') return;
        onVoice(trimmed);
      };

      /**
       * Put the chosen provider into the draft and stage it as the single
       * `ttsProvider` write.
       *
       * The allow-list is the list the card itself renders: a provider the
       * host reports is selectable, and anything else falls back to the local
       * CLI, which is the default. A hard-coded pair here is what made every
       * later provider look present in the dropdown and snap back to `edge`
       * the moment it was chosen.
       * @param value - The provider id the select reported.
       */
      var onProvider = (value) => {
        var known = providerOptions.some((option) => option.id === value);
        var provider = known ? value : TTS_PROVIDER_EDGE;
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: current.spectrum,
          ttsProvider: provider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        stage('ttsProvider', provider);
      };

      /**
       * Stage one endpoint field. An emptied field is a genuine clear: the
       * card's own unset path, so the field re-inherits the deployment's value
       * instead of holding an empty string.
       * @param field - `customBaseUrl` or `customModel`.
       * @param value - What the field now holds.
       */
      var onEndpointField = (field, value) => {
        var text = value === undefined || value === null ? '' : String(value);
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: field === 'customBaseUrl' ? text : current.customBaseUrl,
          customModel: field === 'customModel' ? text : current.customModel,
          yandexVoice: field === 'yandexVoice' ? text : current.yandexVoice,
          rows: current.rows,
        }));
        if (text.trim() === '') stageClear(field);
        else stage(field, text);
      };

      /**
       * The key field changed. The typed text is staged as one
       * `customApiKey` write; an emptied field stages the unset instead — the
       * key is only ever written when something was actually typed.
       * @param value - What the field now holds.
       */
      var onApiKey = (value) => {
        var text = value === undefined || value === null ? '' : String(value);
        setApiKeyInput(text);
        if (text.trim() === '') stageClear('customApiKey');
        else stage('customApiKey', text);
      };

      /**
       * The Yandex key field changed. The typed text is staged as one
       * `yandexApiKey` write; an emptied field stages the unset.
       * @param value - What the field now holds.
       */
      var onYandexKey = (value) => {
        var text = value === undefined || value === null ? '' : String(value);
        setYandexKeyInput(text);
        if (text.trim() === '') stageClear('yandexApiKey');
        else stage('yandexApiKey', text);
      };

      /** The reset control for the Yandex key. */
      var onResetYandexKey = () => {
        setYandexKeyInput('');
        stageClear('yandexApiKey');
      };

      /** The reset control: the key goes away, and the field goes blank. */
      var onResetApiKey = () => {
        setApiKeyInput('');
        stageClear('customApiKey');
      };

      /** Put the chosen variant into the draft and stage it as one write. */
      var onSpectrum = (value) => {
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: value,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        stage('spectrum', value);
      };

      var onPreset = (id) => {
        var chosen = null;
        for (var index = 0; index < presets.length; index += 1) {
          if (presets[index].id === id) chosen = presets[index];
        }
        var rate = chosen === null ? null : parseRatePct(chosen.rate);
        var pitch = chosen === null ? null : parsePitchHz(chosen.pitch);
        // A user preset may carry a voice of its own. The host lends that
        // voice to the synthesis unless the user set one explicitly, so the
        // field follows the preset only in that case.
        var ownVoice = chosen !== null && typeof chosen.voice === 'string' && chosen.voice !== '' ? chosen.voice : null;
        var voiceTaken = Object.prototype.hasOwnProperty.call(userLayer, 'voice');
        setDraft((current) => ({
          preset: id,
          ratePct: rate === null ? current.ratePct : rate,
          pitchHz: pitch === null ? current.pitchHz : pitch,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: ownVoice !== null && !voiceTaken ? ownVoice : current.voice,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        setPending((current) => {
          var next = {};
          for (var key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
          }
          next.preset = { op: 'set', value: id };
          // Choosing a preset clears any explicit tempo/tone override, so the
          // preset's own values take effect instead of the previous manual ones.
          delete next.rate;
          delete next.pitch;
          return next;
        });
      };

      /**
       * Make a preset out of what the sliders show right now: one write that
       * carries the whole pool — the presets that were already there plus this
       * one. The other staged edits are untouched.
       */
      var onSavePreset = () => {
        var label = presetName.trim();
        if (label === '') return;
        var reserved = {};
        for (var index = 0; index < presets.length; index += 1) {
          if (presets[index].user === true) continue;
          reserved[presets[index].id] = true;
        }
        var id = presetIdFor(label, reserved);
        var next = userPresetMap(presets);
        next[id] = {
          label: label,
          rate: formatRate(draft.ratePct === null ? 0 : draft.ratePct),
          pitch: formatPitch(draft.pitchHz === null ? 0 : draft.pitchHz),
        };
        if (typeof draft.voice === 'string' && draft.voice.trim() !== '') {
          next[id].voice = draft.voice.trim();
        }
        stage('userPresets', next);
        setPresetName('');
      };

      /** Drop one of the user's own presets: one write without it. */
      var onDeletePreset = (id) => {
        var next = userPresetMap(presets);
        if (!Object.prototype.hasOwnProperty.call(next, id)) return;
        delete next[id];
        stage('userPresets', next);
      };

      var onResetToPreset = () => {
        var chosen = null;
        for (var index = 0; index < presets.length; index += 1) {
          if (presets[index].id === draft.preset) chosen = presets[index];
        }
        var rate = chosen === null ? null : parseRatePct(chosen.rate);
        var pitch = chosen === null ? null : parsePitchHz(chosen.pitch);
        // The preset's own voice comes back with the rest of it, unless the
        // user set a voice of their own.
        var ownVoice = chosen !== null && typeof chosen.voice === 'string' && chosen.voice !== '' ? chosen.voice : null;
        var voiceTaken = Object.prototype.hasOwnProperty.call(userLayer, 'voice');
        setDraft((current) => ({
          preset: current.preset,
          ratePct: rate === null ? current.ratePct : rate,
          pitchHz: pitch === null ? current.pitchHz : pitch,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: ownVoice !== null && !voiceTaken ? ownVoice : current.voice,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        setPending((current) => {
          var next = {};
          for (var key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
          }
          next.rate = { op: 'unset' };
          next.pitch = { op: 'unset' };
          return next;
        });
      };

      var onRate = (event) => {
        var value = clampTo(event.target.value, rateRange, draft.ratePct === null ? 0 : draft.ratePct);
        setDraft((current) => ({
          preset: current.preset,
          ratePct: value,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        stage('rate', formatRate(value));
      };

      var onPitch = (event) => {
        var value = clampTo(event.target.value, pitchRange, draft.pitchHz === null ? 0 : draft.pitchHz);
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: value,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: current.spectrum,
          ttsProvider: current.ttsProvider,
          customBaseUrl: current.customBaseUrl,
          customModel: current.customModel,
          yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
          rows: current.rows,
        }));
        stage('pitch', formatPitch(value));
      };

      /** Put a freshly computed row list into the draft, staging no write. */
      var setRows = (rows) => {
        setDraft((current) => {
          var next = {};
          for (var key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
          }
          next.rows = rows;
          return next;
        });
      };

      /**
       * Write the dictionary to the host right now, without the card's own Save.
       *
       * This sits BELOW the card's early returns, so it must never be a hook.
       * It was `react.useCallback` for one build: that hook ran only on the
       * renders that got past the loading guard, React saw a different hook
       * count on the next render and tore the whole settings card down — the
       * card vanished from the page. A plain closure keeps the hook order
       * identical in every view.
       *
       * Only the user's own layer travels — the map holds the terms whose
       * reading differs from the built-in one — and an empty map unsets the
       * field, so the plugin row's own dictionary comes back.
       * @param rows - The row list to project into the user layer.
       */
      var saveDictionary = async (rows) => {
        if (!scope || !writable) return;
        var map = dictionaryOverrideFromRows(rows, defaults);
        setBusy(true);
        setNote(null);
        try {
          var wrote =
            Object.keys(map).length === 0 ? await scope.unset('dictionary') : await scope.set('dictionary', map);
          if (!mountedRef.current) return;
          if (wrote === false) {
            setNote({ tone: 'error', text: 'Хост не принял словарь.' });
            return;
          }
          setNote({ tone: 'ok', text: 'Словарь сохранён.' });
        } catch (error) {
          if (mountedRef.current) {
            setNote({ tone: 'error', text: 'Не сохранилось: ' + String((error && error.message) || error) });
          }
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };

      var onRowAdd = () => {
        var term = newTerm.trim();
        var spoken = newSpoken.trim();
        if (term === '' || spoken === '') return;
        var rows = draft.rows.slice();
        var replaced = false;
        for (var index = 0; index < rows.length; index += 1) {
          if (rows[index].term.toLowerCase() === term.toLowerCase()) {
            rows[index] = { term: rows[index].term, spoken: spoken, isDefault: rows[index].isDefault };
            replaced = true;
          }
        }
        if (!replaced) rows.push({ term: term, spoken: spoken, isDefault: false });
        setRows(rows);
        setNewTerm('');
        setNewSpoken('');
        saveDictionary(rows);
      };

      /** Type into a row the user already owns; the write waits for blur. */
      var onOwnRowSpoken = (term, value) => {
        setRows(
          draft.rows.map((row) => (row.term === term ? { term: row.term, spoken: value, isDefault: row.isDefault } : row)),
        );
      };

      /**
       * Leave the field of a row the user already owns: write the reading, and
       * write nothing when it did not move, so a stray focus does not turn into
       * a save notice.
       * @param term - The term exactly as the row writes it.
       * @param value - The reading in the field.
       */
      var onOwnRowSave = (term, value) => {
        var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
        var custom = userLayer.dictionary !== null && typeof userLayer.dictionary === 'object' ? userLayer.dictionary : {};
        var before = Object.prototype.hasOwnProperty.call(custom, term)
          ? custom[term]
          : Object.prototype.hasOwnProperty.call(builtIn, term)
            ? builtIn[term]
            : '';
        if (String(before) === String(value)) return;
        saveDictionary(draft.rows);
      };

      /**
       * Take one term out of the user's layer. A built-in term goes back to its
       * own reading; a term the user added disappears. The write is immediate,
       * like the add.
       * @param term - The term exactly as the row writes it.
       */
      var onOwnRowDelete = (term) => {
        var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
        var rows = draft.rows.slice();
        if (Object.prototype.hasOwnProperty.call(builtIn, term)) {
          for (var index = 0; index < rows.length; index += 1) {
            if (rows[index].term === term) rows[index] = { term: term, spoken: builtIn[term], isDefault: true };
          }
        } else {
          rows = rows.filter((row) => row.term !== term);
        }
        setRows(rows);
        saveDictionary(rows);
      };

      var overriddenBadge = (field) =>
        Object.prototype.hasOwnProperty.call(userLayer, field)
          ? h('span', { className: 'dvv-badge' }, 'изменено')
          : null;

      var ratePct = draft.ratePct === null ? 0 : draft.ratePct;
      var pitchHz = draft.pitchHz === null ? 0 : draft.pitchHz;
      // What the dictionary block shows and what its summary reports: the rows
      // the user owns, never the built-in table. A built-in term is the user's
      // own exactly when its reading differs from the shipped one — the same
      // rule `dictionaryOverrideFromRows` writes by, so screen and host agree.
      var builtInReadings = defaults !== null && typeof defaults === 'object' ? defaults : {};
      var ownRows = draft.rows.filter((row) => {
        if (!Object.prototype.hasOwnProperty.call(builtInReadings, row.term)) return true;
        return String(row.spoken) !== String(builtInReadings[row.term]);
      });
      var ownTerms = ownRows.length;

      // The name of the variant in use, for the footer line.
      var spectrumName =
        resolved.spectrum === undefined || resolved.spectrum === null ? 'не задана' : String(resolved.spectrum);
      for (var variantIndex = 0; variantIndex < spectrumOptions.length; variantIndex += 1) {
        if (spectrumOptions[variantIndex].id === spectrumName) {
          spectrumName = spectrumOptions[variantIndex].label;
          break;
        }
      }

      return h('div', { className: 'dvv-card', 'data-voice-v-card': SETTINGS_NAMESPACE }, [
        h('div', { key: 'head', className: 'dvv-head' }, [
          h('p', { key: 'title', className: 'dvv-title' }, 'Озвучка ответов (dsh-voice-v)'),
          h(
            'p',
            { key: 'desc', className: 'dvv-desc' },
            'Голос, темп, тон, словарь произношения, вырезание кода и подбор пресета по тону ответа. Всё хранится в настройках хоста (' +
              SETTINGS_NAMESPACE +
              ') и применяется к следующей озвучке без перезапуска.',
          ),
        ]),

        // The interface language. It stages like every other field, and the
        // card speaks the staged choice at once, so the switch is visible
        // before Save: "Отменить правки" brings the host's language back.
        h('div', { key: 'language', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, [
            'Язык интерфейса',
            overriddenBadge('uiLanguage'),
          ]),
          h(
            'select',
            {
              key: 'select',
              className: 'dvv-select',
              value: wantedLanguage,
              disabled: disabled,
              'aria-label': 'Язык интерфейса',
              onChange: (event) => stage('uiLanguage', event.target.value),
            },
            languageOptions.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
          ),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Язык самой карточки: русский или английский. Озвучка не меняется — голос читает текст ответа, а не интерфейс.',
          ),
        ]),

        h('div', { key: 'presets', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, 'Пресет'),
          h(
            'div',
            { key: 'list', className: 'dvv-presets' },
            presets.map((preset) =>
              h('div', { key: preset.id, className: 'dvv-preset-row' }, [
                h(
                  'button',
                  {
                    key: 'pick',
                    type: 'button',
                    className: 'dvv-preset',
                    'data-active': preset.id === draft.preset ? 'true' : 'false',
                    disabled: disabled,
                    onClick: () => onPreset(preset.id),
                  },
                  h('span', { className: 'dvv-preset-name' }, preset.label),
                  h('span', { className: 'dvv-preset-hint' }, presetHint(preset)),
                ),
                // The delete control belongs to the user's own presets alone.
                preset.user === true
                  ? h(
                      'button',
                      {
                        key: 'delete',
                        type: 'button',
                        className: 'dvv-btn dvv-btn-danger dvv-preset-delete',
                        'aria-label': 'Удалить пресет ' + preset.label,
                        title: 'Удалить пресет',
                        disabled: disabled,
                        onClick: () => onDeletePreset(preset.id),
                      },
                      '✕',
                    )
                  : null,
              ]),
            ),
          ),
          h('div', { key: 'own', className: 'dvv-preset-own' }, [
            h('input', {
              key: 'name',
              className: 'dvv-input',
              type: 'text',
              value: presetName,
              disabled: disabled,
              placeholder: 'название пресета',
              'aria-label': 'Название пресета',
              onChange: (event) => setPresetName(event.target.value),
            }),
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                className: 'dvv-btn dvv-btn-primary',
                disabled: disabled || presetName.trim() === '',
                onClick: onSavePreset,
              },
              'Сохранить как пресет',
            ),
          ]),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Свой пресет запоминает текущие темп, тон и голос. Свои пресеты помечены крестиком — их можно удалить.',
          ),
        ]),

        h('div', { key: 'sliders', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, 'Темп и тон'),
          h('div', { key: 'rate', className: 'dvv-slider' }, [
            h('span', { key: 'l', className: 'dvv-slider-label' }, ['Темп', overriddenBadge('rate')]),
            h('input', {
              key: 'i',
              type: 'range',
              min: rateRange.min,
              max: rateRange.max,
              step: rateRange.step || 1,
              value: ratePct,
              disabled: disabled,
              'aria-label': 'Темп в процентах',
              onChange: onRate,
            }),
            h('span', { key: 'v', className: 'dvv-value' }, formatRate(ratePct)),
          ]),
          h('div', { key: 'pitch', className: 'dvv-slider' }, [
            h('span', { key: 'l', className: 'dvv-slider-label' }, ['Тон', overriddenBadge('pitch')]),
            h('input', {
              key: 'i',
              type: 'range',
              min: pitchRange.min,
              max: pitchRange.max,
              step: pitchRange.step || 1,
              value: pitchHz,
              disabled: disabled,
              'aria-label': 'Тон в герцах',
              onChange: onPitch,
            }),
            h('span', { key: 'v', className: 'dvv-value' }, formatPitch(pitchHz)),
          ]),
          h('div', { key: 'actions', className: 'dvv-actions' }, [
            h(
              'button',
              {
                key: 'listen',
                type: 'button',
                className: 'dvv-btn dvv-btn-primary',
                disabled: busy,
                onClick: () => playPreview(previewText, previewOptions(previewText)),
              },
              busy ? 'Синтез…' : 'Прослушать',
            ),
            h(
              'button',
              {
                key: 'reset',
                type: 'button',
                className: 'dvv-btn',
                disabled: disabled,
                onClick: onResetToPreset,
              },
              'Сбросить к пресету',
            ),
          ]),
        ]),

        h('div', { key: 'strip', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, 'Содержимое'),
          h(
            'label',
            { key: 'row', className: 'dvv-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.stripCode,
              disabled: disabled,
              onChange: (event) => {
                var value = event.target.checked === true;
                setDraft((current) => ({
                  preset: current.preset,
                  ratePct: current.ratePct,
                  pitchHz: current.pitchHz,
                  stripCode: value,
                  autoPreset: current.autoPreset,
                  voice: current.voice,
                  spectrum: current.spectrum,
                  ttsProvider: current.ttsProvider,
                  customBaseUrl: current.customBaseUrl,
                  customModel: current.customModel,
                  yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
                  rows: current.rows,
                }));
                stage('stripCode', value);
              },
            }),
            'Вырезать код из озвучки',
            overriddenBadge('stripCode'),
          ),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            draft.stripCode
              ? 'Блоки кода и markdown-таблицы не читаются: вместо них «блок кода, N строк» и «таблица, N строк».'
              : 'Код и таблицы читаются как есть: код — минимально очищенным, таблица — по строкам через запятую.',
          ),
        ]),

        h('div', { key: 'auto', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, 'Тон сообщения'),
          h(
            'label',
            { key: 'row', className: 'dvv-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.autoPreset,
              disabled: disabled,
              'aria-label': 'Пресет по тону сообщения',
              onChange: (event) => {
                var value = event.target.checked === true;
                setDraft((current) => ({
                  preset: current.preset,
                  ratePct: current.ratePct,
                  pitchHz: current.pitchHz,
                  stripCode: current.stripCode,
                  autoPreset: value,
                  voice: current.voice,
                  spectrum: current.spectrum,
                  ttsProvider: current.ttsProvider,
                  customBaseUrl: current.customBaseUrl,
                  customModel: current.customModel,
                  yandexVoice: current.yandexVoice,
                  yoMode: current.yoMode,
                  rows: current.rows,
                }));
                stage('autoPreset', value);
              },
            }),
            'Пресет по тону сообщения',
            overriddenBadge('autoPreset'),
          ),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            draft.autoPreset
              ? 'Хост подбирает темп и тон по словам ответа: усталость — «Усталый», тепло — «Живой», работа — «Спокойный», флирт — «Дерзкий». Темп и тон, заданные вручную, всегда важнее.'
              : 'Пресет выбирается вручную: темп и тон берутся из выбранного пресета, слова ответа на них не влияют.',
          ),
        ]),

        h('div', { key: 'yo', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, ['Буква «ё»', overriddenBadge('yoMode')]),
          h(
            'select',
            {
              key: 'select',
              className: 'dvv-select',
              value: draft.yoMode,
              disabled: disabled,
              'aria-label': 'Как читать букву ё',
              onChange: (event) => {
                var value = event.target.value;
                setDraft((current) => ({
                  preset: current.preset,
                  ratePct: current.ratePct,
                  pitchHz: current.pitchHz,
                  stripCode: current.stripCode,
                  autoPreset: current.autoPreset,
                  voice: current.voice,
                  spectrum: current.spectrum,
                  ttsProvider: current.ttsProvider,
                  customBaseUrl: current.customBaseUrl,
                  customModel: current.customModel,
                  yandexVoice: current.yandexVoice,
                  yoMode: value,
                  rows: current.rows,
                }));
                stage('yoMode', value);
              },
            },
            h('option', { key: 'asis', value: 'as-is' }, 'Как написано — Edge читает «ё» как «йе»'),
            h('option', { key: 'plain', value: 'plain' }, 'Без точек — «приём» станет «прием»'),
            h('option', { key: 'spelled', value: 'spelled' }, 'Выписать звуком — «приём» станет «прийом»'),
          ),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Голоса Edge читают «ё» как «йе». Выписанный звуком — единственный способ услышать её правильно, но в словах после твёрдых согласных он меняет слово. Яндекс читает «ё» сам — там режим не нужен.',
          ),
        ]),

        h('div', { key: 'voice', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, ['Голос', overriddenBadge('voice')]),
          h('div', { key: 'row', className: 'dvv-voice' }, [
            customVoice
              ? h('input', {
                  key: 'custom',
                  className: 'dvv-input',
                  type: 'text',
                  value: customVoiceInput,
                  disabled: disabled,
                  'aria-label': 'Голос edge-tts',
                  placeholder: 'например, ru-RU-SvetlanaNeural',
                  onChange: (event) => onCustomVoice(event.target.value),
                })
              : h(
                  'select',
                  {
                    key: 'select',
                    className: 'dvv-select',
                    value: currentVoice,
                    disabled: disabled,
                    'aria-label': 'Голос edge-tts',
                    onChange: (event) => onVoiceChoice(event.target.value),
                  },
                  voiceOptionChildren(voiceGroups),
                ),
            // The way back to the list. The space it takes is reserved either
            // way, so the swap of the control never moves the layout.
            h(
              'button',
              {
                key: 'back',
                type: 'button',
                className: 'dvv-btn dvv-voice-back',
                'data-off': customVoice ? 'false' : 'true',
                disabled: disabled || !customVoice,
                tabIndex: customVoice ? 0 : -1,
                'aria-hidden': customVoice ? undefined : 'true',
                onClick: () => setCustomVoice(false),
              },
              'К списку',
            ),
          ]),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            customProvider
              ? 'Для своего эндпоинта укажите id голоса провайдера: «Свой голос…» — ручной ввод. У edge-tts остаётся его каталог.'
              : 'Свой голос вводится вручную: в edge-tts уходит именно этот идентификатор.',
          ),
        ]),

        h('div', { key: 'synth', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, ['Синтез речи', overriddenBadge('ttsProvider')]),
          h(
            'select',
            {
              key: 'provider',
              className: 'dvv-select',
              value: draft.ttsProvider,
              disabled: disabled,
              'aria-label': 'Провайдер синтеза',
              onChange: (event) => onProvider(event.target.value),
            },
            providerOptions.map((provider) =>
              h('option', { key: provider.id, value: provider.id }, provider.label),
            ),
          ),
          // The endpoint's own fields exist only when the endpoint is chosen:
          // the card does not show what the plugin would not use.
          customProvider
            ? h('div', { key: 'endpoint', className: 'dvv-endpoint' }, [
                h('input', {
                  key: 'base',
                  className: 'dvv-input',
                  type: 'text',
                  value: draft.customBaseUrl,
                  disabled: disabled,
                  'aria-label': 'Base URL эндпоинта',
                  placeholder: 'https://api.openai.com/v1',
                  onChange: (event) => onEndpointField('customBaseUrl', event.target.value),
                }),
                h('input', {
                  key: 'model',
                  className: 'dvv-input',
                  type: 'text',
                  value: draft.customModel,
                  disabled: disabled,
                  'aria-label': 'Model ID эндпоинта',
                  placeholder: 'tts-1',
                  onChange: (event) => onEndpointField('customModel', event.target.value),
                }),
                h('input', {
                  key: 'key',
                  className: 'dvv-input',
                  type: 'password',
                  value: apiKeyInput,
                  disabled: disabled,
                  'aria-label': 'API Key эндпоинта',
                  placeholder: apiKeySet ? 'ключ сохранён — введите, чтобы заменить' : 'не задан',
                  onChange: (event) => onApiKey(event.target.value),
                }),
                h(
                  'button',
                  {
                    key: 'save-key',
                    type: 'button',
                    className: 'dvv-btn',
                    disabled: disabled || apiKeyInput.trim() === '',
                    title: 'Сохранить ключ сейчас',
                    onClick: () => saveSecret('customApiKey', apiKeyInput, () => setApiKeyInput('')),
                  },
                  'Сохранить ключ',
                ),
                h(
                  'button',
                  {
                    key: 'reset-key',
                    type: 'button',
                    className: 'dvv-btn',
                    // The control drops the stored key — and it also clears a
                    // key the user just typed but has not saved yet.
                    disabled: disabled || (!apiKeySet && apiKeyInput.trim() === ''),
                    title: 'Убрать сохранённый ключ',
                    onClick: onResetApiKey,
                  },
                  'Сбросить ключ',
                ),
              ])
            : null,
          // The Yandex provider owns two fields of its own: the voice the
          // service speaks with, and the key it answers to.
          yandexProvider
            ? h('div', { key: 'yandex', className: 'dvv-endpoint' }, [
                h(
                  'select',
                  {
                    key: 'voice',
                    className: 'dvv-select',
                    value: draft.yandexVoice,
                    disabled: disabled,
                    'aria-label': 'Голос Яндекса',
                    onChange: (event) => onEndpointField('yandexVoice', event.target.value),
                  },
                  YANDEX_VOICE_OPTIONS.map((voice) =>
                    h('option', { key: voice.id, value: voice.id }, voice.label),
                  ),
                ),
                h('input', {
                  key: 'yandex-key',
                  className: 'dvv-input',
                  type: 'password',
                  value: yandexKeyInput,
                  disabled: disabled,
                  'aria-label': 'Ключ API Яндекс SpeechKit',
                  placeholder: yandexKeySet ? 'ключ сохранён — введите, чтобы заменить' : 'не задан',
                  onChange: (event) => onYandexKey(event.target.value),
                }),
                h(
                  'button',
                  {
                    key: 'save-yandex-key',
                    type: 'button',
                    className: 'dvv-btn',
                    disabled: disabled || yandexKeyInput.trim() === '',
                    title: 'Сохранить ключ сейчас',
                    onClick: () => saveSecret('yandexApiKey', yandexKeyInput, () => setYandexKeyInput('')),
                  },
                  'Сохранить ключ',
                ),
                h(
                  'button',
                  {
                    key: 'reset-yandex-key',
                    type: 'button',
                    className: 'dvv-btn',
                    disabled: disabled || (!yandexKeySet && yandexKeyInput.trim() === ''),
                    title: 'Убрать сохранённый ключ',
                    onClick: onResetYandexKey,
                  },
                  'Сбросить ключ',
                ),
              ])
            : null,
          // The Google provider owns the same two fields: the voice the
          // service speaks with, and the key it answers to. The host reports
          // both, and the card stages the write, so the value shown is the
          // one the plugin will actually use.
          googleProvider
            ? h('div', { key: 'google', className: 'dvv-endpoint' }, [
                h(
                  'select',
                  {
                    key: 'voice',
                    className: 'dvv-select',
                    value: googleVoice,
                    disabled: disabled,
                    'aria-label': 'Голос Google',
                    onChange: (event) => stage('googleVoice', event.target.value),
                  },
                  GOOGLE_VOICE_OPTIONS.map((voice) =>
                    h('option', { key: voice.id, value: voice.id }, voice.label),
                  ),
                ),
                h('input', {
                  key: 'google-key',
                  className: 'dvv-input',
                  type: 'password',
                  value: googleKeyInput,
                  disabled: disabled,
                  'aria-label': 'Ключ API Google Cloud TTS',
                  placeholder: googleKeySet ? 'ключ сохранён — введите, чтобы заменить' : 'не задан',
                  onChange: (event) => setGoogleKeyInput(event.target.value),
                }),
                h(
                  'button',
                  {
                    key: 'save-google-key',
                    type: 'button',
                    className: 'dvv-btn',
                    disabled: disabled || googleKeyInput.trim() === '',
                    title: 'Сохранить ключ сейчас',
                    onClick: () => saveSecret('googleApiKey', googleKeyInput, () => setGoogleKeyInput('')),
                  },
                  'Сохранить ключ',
                ),
                h(
                  'button',
                  {
                    key: 'reset-google-key',
                    type: 'button',
                    className: 'dvv-btn',
                    disabled: disabled || (!googleKeySet && googleKeyInput.trim() === ''),
                    title: 'Убрать сохранённый ключ',
                    onClick: () => stageClear('googleApiKey'),
                  },
                  'Сбросить ключ',
                ),
              ])
            : null,
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Свой эндпоинт необязателен: edge-tts остаётся дефолтом и работает без ключей. Google без ключа — страховка на случай, когда локального CLI нет: один голос, без темпа и тона, и звучит заметно хуже нейронных. Ключ хранится в пользовательском слое профиля и в браузер не отправляется.',
          ),
        ]),

        h('div', { key: 'spectrum', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, ['Визуализация', overriddenBadge('spectrum')]),
          h(
            'select',
            {
              key: 'select',
              className: 'dvv-select',
              value: draft.spectrum,
              disabled: disabled,
              'aria-label': 'Визуализация озвучки',
              onChange: (event) => onSpectrum(event.target.value),
            },
            spectrumOptions.map((variant) => h('option', { key: variant.id, value: variant.id }, variant.label)),
          ),
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Показывает движение звука. «Спектр» и «Осциллограмма» — живая полоса над полем ввода, пока звучит мой голос: частоты и волна по всей ширине карточки. «Волна» живёт в кнопке озвучки, «Пульс» и «Точки» — простая анимация.',
          ),
        ]),

        h('div', { key: 'save', className: 'dvv-actions' }, [
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'dvv-btn dvv-btn-primary',
              disabled: disabled || !dirty,
              onClick: save,
            },
            'Сохранить',
          ),
          h(
            'button',
            { key: 'discard', type: 'button', className: 'dvv-btn', disabled: busy || !dirty, onClick: discard },
            'Отменить правки',
          ),
          dirty ? h('span', { key: 'dirty', className: 'dvv-dirty' }, 'есть несохранённые правки') : null,
          !writable
            ? h('span', { key: 'ro', className: 'dvv-badge' }, 'только чтение (memory mode)')
            : null,
        ]),

        note !== null ? h('p', { key: 'note', className: 'dvv-note', 'data-tone': note.tone }, note.text) : null,
        h(
          'p',
          { key: 'effective', className: 'dvv-hint dvv-footer' },
          effective === null && config === null
            ? 'Хост пока не отдал значения по пространству настроек.'
            : 'Сейчас хост отдаёт: ' +
                (resolved.voice === undefined || resolved.voice === null || resolved.voice === ''
                  ? 'голос не выбран'
                  : resolved.voice) +
                ', ' +
                (resolved.rate === undefined || resolved.rate === null || resolved.rate === ''
                  ? 'темп не задан'
                  : resolved.rate) +
                ' / ' +
                (resolved.pitch === undefined || resolved.pitch === null || resolved.pitch === ''
                  ? 'высота не задана'
                  : resolved.pitch) +
                ', пресет ' +
                resolved.preset +
                ', пресет по тону ' +
                (resolved.autoPreset === false ? 'выключен' : 'включён') +
                ', визуализация ' +
                spectrumName +
                (config !== null && config.settingsRegistered === false
                  ? ' · пространство настроек не зарегистрировано: правки пишутся в config плагина, а не в настройки хоста'
                  : ''),
        ),

        // The dictionary is the last thing on the card: a hundred and fifty
        // rows of built-in terms do not belong in the middle of a settings
        // list. The block is a native <details>, collapsed by default — the
        // browser owns the open state, so the element needs no `open` prop and
        // no React state, and the summary only has to report the counts.
        h('details', { key: 'dict', className: 'dvv-details' }, [
          h('summary', { key: 'summary', className: 'dvv-details-summary' }, [
            h('span', { key: 't', className: 'dvv-details-title' }, 'Словарь произношения'),
            h('span', { key: 'c', className: 'dvv-details-count' }, ownTerms + ' ' + termsWord(ownTerms)),
          ]),
          h('div', { key: 'body', className: 'dvv-details-body' }, [
            h(
              'p',
              { key: 'hint', className: 'dvv-hint' },
              'Два поля и кнопка: термин уходит в настройки сразу, без общей кнопки «Сохранить». В списке только твои термины — встроенный словарь хоста остаётся как есть, а «Удалить» возвращает встроенное чтение.',
            ),
            h('div', { key: 'add', className: 'dvv-dict-row' }, [
              h('input', {
                key: 'term',
                className: 'dvv-input',
                type: 'text',
                value: newTerm,
                disabled: disabled,
                placeholder: 'термин',
                'aria-label': 'Новый термин',
                onChange: (event) => setNewTerm(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') onRowAdd();
                },
              }),
              h('input', {
                key: 'spoken',
                className: 'dvv-input',
                type: 'text',
                value: newSpoken,
                disabled: disabled,
                placeholder: 'как читать',
                'aria-label': 'Транскрипция нового термина',
                onChange: (event) => setNewSpoken(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') onRowAdd();
                },
              }),
              h(
                'button',
                {
                  key: 'add',
                  type: 'button',
                  className: 'dvv-btn dvv-btn-primary',
                  disabled: disabled || newTerm.trim() === '' || newSpoken.trim() === '',
                  onClick: onRowAdd,
                },
                'Добавить',
              ),
              h('span', { key: 'pad' }, ''),
            ]),
            ownRows.length === 0
              ? h(
                  'p',
                  { key: 'empty', className: 'dvv-hint' },
                  'Своих терминов пока нет: всё читается так, как задал хост.',
                )
              : [
                  h('div', { key: 'head', className: 'dvv-dict-head' }, [
                    h('span', { key: 'a' }, 'Термин'),
                    h('span', { key: 'b' }, 'Транскрипция'),
                    h('span', { key: 'c' }, ''),
                    h('span', { key: 'd' }, ''),
                  ]),
                  h(
                    'div',
                    { key: 'rows', className: 'dvv-dict' },
                    ownRows.map((row) =>
                      h('div', { key: row.term, className: 'dvv-dict-row' }, [
                        h('span', { key: 'term', className: 'dvv-value', style: { textAlign: 'left' } }, row.term),
                        h('input', {
                          key: 'spoken',
                          className: 'dvv-input',
                          type: 'text',
                          value: row.spoken,
                          disabled: disabled,
                          'aria-label': 'Транскрипция для ' + row.term,
                          onChange: (event) => onOwnRowSpoken(row.term, event.target.value),
                          onBlur: (event) => onOwnRowSave(row.term, event.target.value),
                        }),
                        h(
                          'button',
                          {
                            key: 'listen',
                            type: 'button',
                            className: 'dvv-btn',
                            disabled: busy,
                            title: 'Прослушать транскрипцию',
                            onClick: () => playPreview(row.spoken, previewOptions(row.spoken)),
                          },
                          '▶',
                        ),
                        h(
                          'button',
                          {
                            key: 'delete',
                            type: 'button',
                            className: 'dvv-btn dvv-btn-danger',
                            disabled: disabled,
                            title: 'Убрать свой термин',
                            onClick: () => onOwnRowDelete(row.term),
                          },
                          'Удалить',
                        ),
                      ]),
                    ),
                  ),
                ],
          ]),
        ]),
      ]);
    }

    /**
     * The one service the whole half cannot work without. The settings binder
     * is deliberately absent — see the note at the top of this file: it is read
     * with `ctx.get` inside `apply`, so its absence cannot suspend the speaker
     * button.
     */
    var inject = ['slots'];

    /**
     * Register the speaker action into the assistant action strip, and the
     * settings card into this bundle's configuration seat on the Plugins page.
     *
     * @param ctx - Browser plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'voice-v',
            order: 20,
            inject: (sessionId) => ({ sessionId: sessionId }),
          },
          VoiceButton,
        ),
      );

      // The wide strip above the composer card: the spectrum and the trace,
      // the two variants the button cannot hold. `conversation.input.dock` is
      // the full-width seat that sits right on top of the input, so the strip
      // reads as part of the field and never covers the text being typed. The
      // component draws nothing at all unless a voice with one of those
      // variants is sounding, so it takes no room while it is idle.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'voice-v-composer',
            order: 50,
          },
          ComposerOverlay,
        ),
      );

      // The settings card waits for `slots` in its own fiber, so a host that
      // never provides it leaves the button above untouched. The settings
      // scope binder is read with `ctx.get`, which answers `undefined`
      // instead of throwing, so its absence costs the card and nothing else.
      ctx.inject(['slots'], (scope) => {
        // Two hosts, two shapes of the same job. Both hand the card a scope
        // with the same face — `getSnapshot`, `subscribe`, `set`, `unset` —
        // and both put it in a slot of the Plugins settings surface; only the
        // way the scope is obtained and the slot's shape differ.
        //
        // The declarative host (the studio): one shared form per namespace,
        // taken from the form service, and the card page is a TAB of the
        // Plugins section. The tab's id is the namespace.
        //
        // The form service is WAITED FOR in a fiber of its own, never read
        // once. It comes up with the Host's remote link, which can be later
        // than this fiber, and a fiber that NAMES a service is parked until
        // that service's provider appears and is live. A one-shot read sees
        // nothing, skips the studio branch, and the card is lost without a
        // word — which is exactly what a restart after a cold start did.
        if (typeof scope.inject === 'function') {
          scope.inject(['configForms'], (formsScope) => {
            const forms = readService(formsScope, 'configForms');
            if (forms === null || forms === undefined || typeof forms.get !== 'function') return;

            // The three seats the card occupies, all of them sharing one form
            // of one namespace.
            const registerSeats = () => {
              const shared = forms.get(SETTINGS_NAMESPACE);
              return [
                scope.slots.inject('settings.plugins.tab', () =>
                  scope.slots.register(
                    {
                      // List slot: the id IS the namespace, and the page
                      // dispatches the tab by it. It must match the Loader row
                      // id exactly.
                      name: 'settings.plugins.tab',
                      id: SETTINGS_NAMESPACE,
                      order: 10,
                      label: 'Голос',
                      inject: () => ({ scope: shared }),
                    },
                    VoiceSettingsCard,
                  ),
                ),
                // The plugin's own page: the studio shows a plugin's
                // configuration there, in the section the page fills from
                // these two slots. The bundle's section is keyed by the
                // bundle's package name, the row's by `bundle#rowId` — the
                // same card, the same scope, and the page dispatches by the
                // key, so the key must be exact.
                scope.slots.inject('plugins.bundle.config', () =>
                  scope.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: BUNDLE_KEY,
                      inject: () => ({ scope: shared }),
                    },
                    VoiceSettingsCard,
                  ),
                ),
                scope.slots.inject('plugins.row.config', () =>
                  scope.slots.register(
                    {
                      name: 'plugins.row.config',
                      key: ROW_CONFIG_KEY,
                      inject: () => ({ scope: shared }),
                    },
                    VoiceSettingsCard,
                  ),
                ),
              ];
            };

            // A page that edits a namespace the Host serves registers
            // through `whileServed`: it runs the registration when the
            // namespace is in the Host's mirror and withdraws it when the
            // Host stops serving it. The mirror only learns the namespace
            // when the Host's settings document arrives, so this is also the
            // late-arrival path — the card lands whenever the Host starts
            // serving the namespace, not whenever this fiber happened to run.
            if (typeof forms.whileServed !== 'function') {
              registerSeats();
              return;
            }
            scope.effect(() =>
              forms.whileServed([SETTINGS_NAMESPACE], () => {
                const disposers = registerSeats();
                return () => {
                  for (const dispose of disposers) dispose();
                };
              }),
            );
          });
        }

        // The imperative host: a bound scope per namespace, taken from the
        // scope binder, and a KEYED card slot whose key is the namespace.
        const binder = readService(ctx, 'settingsScope');
        if (binder === null || binder === undefined || typeof binder.bind !== 'function') return;
        const form = binder.bind({ namespace: SETTINGS_NAMESPACE });

        // `settings.plugin.item` is declared by the Plugins settings surface,
        // which may mount after this plugin: `slots.inject` waits for the
        // declaration instead of assuming an order between packages.
        scope.slots.inject('settings.plugin.item', () =>
          scope.slots.register(
            {
              // Keyed slot: the key is the settings namespace, and the page
              // dispatches by it. It must match the namespace the host half
              // registered exactly.
              name: 'settings.plugin.item',
              key: SETTINGS_NAMESPACE,
              inject: () => ({ scope: form }),
            },
            VoiceSettingsCard,
          ),
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    /**
     * The page's shared sound slot, exposed for the browser-half tests: they
     * need to see who owns the sound and to hand the bundle a fake `<audio>`
     * instead of a real element. Nothing in the plugin reads it.
     */
    exports.__audio = audioPlayer;
    return module.exports;
  },
});
