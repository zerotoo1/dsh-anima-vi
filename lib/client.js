// dsh-voice-v browser half.
//
// Hand-written in the lazy-CJS bundle protocol the DSH shell installs as
// `window.__ModuleLoader__` (the same protocol the installed third-party
// plugins ship; `@liustack/modsearch` documents writing it by hand). The module
// id is the package name, and the bundle's only external is `react`, which is a
// platform seed word. `dsh.client.inject` in package.json is therefore not about
// this bundle's own requires: it names the two package rows whose client halves
// the card consumes (`dsh-client-ui-settings` provides `configForms`,
// `dsh-client-ui-plugin-manager` declares the `plugins.bundle.config` seat), so
// those rows arrive before this one materializes.
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
//  * `plugins.bundle.config` — the settings card on this bundle's own page in
//    the Plugins tab. That slot is declared by
//    `@deepseek-ai/dsh-client-ui-plugin-manager` as a KEYED slot whose key
//    domain is the npm package name, which the page dispatches as
//    `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`.
//    It is deliberately not `plugins.item`: that list is the Official group,
//    and the harness contract routes a bundle's configuration here instead.
//    The card is registered only while the Host serves the settings namespace
//    `dsh-voice-v` that the host half registers — through
//    `configForms.whileServed` — so a deployment that never composed the host
//    half shows no trace of it. The card's values come from
//    `configForms.get(SETTINGS_NAMESPACE)`, the shared form over that namespace
//    (its entry id is the Host Loader row id, which this plugin keeps equal to
//    the namespace): `getSnapshot()` for reads, `set()` / `unset()` for writes.
//    Nothing is hard-coded in this bundle that the host does not report through
//    `/dsh-voice-v/config` — the preset table, the dictionary defaults, and the
//    slider domains all arrive from there.
//
// Service posture: the speaker button needs only `slots`, so `slots` is the one
// top-level requirement. The settings card additionally needs `configForms`, and
// asks for it in a NESTED `ctx.inject` fiber instead of the top-level list. A
// service declared at top level but missing on the host keeps the whole client
// entry suspended ("1 entry did not activate"), which would take the read-aloud
// button down over a settings-only dependency; the nested fiber confines that
// wait to the card, so a host without `configForms` still gets the button and
// simply shows no card. The nested fiber must re-declare every service it reads
// (`slots` included), because a strict context proxy throws on undeclared reads.
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

    var h = react.createElement;

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

      return {
        claim: claim,
        stop: stop,
        release: release,
        begin: begin,
        clearElement: clearElement,
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

    /** Every variant id the bundle knows. */
    var SPECTRUM_IDS = ['off', 'bars', 'wave', 'pulse', 'dots'];

    /** The variants that read the audio itself. */
    var SPECTRUM_ANALYSED = ['bars', 'wave'];

    /** The variant the card shows when the host reports none. */
    var DEFAULT_SPECTRUM_VARIANT = 'bars';

    /** The variants the settings card offers when the host reports none. */
    var FALLBACK_SPECTRUM_VARIANTS = [
      { id: 'off', label: 'Выключено' },
      { id: 'bars', label: 'Спектр' },
      { id: 'wave', label: 'Волна' },
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
      try {
        analyser.fftSize = 64;
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

    /**
     * The speaker button under one assistant message.
     *
     * @param props - `messageId` from the slot owner and `sessionId` from the
     *   plugin's scoped injection.
     */
    function VoiceButton(props) {
      var messageId = props.messageId;
      var sessionId = props.sessionId;

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

      // The visualization lives inside this button and nowhere else: it is
      // shown while THIS message's own voice plays, and it takes the glyph's
      // place, so the box the button occupies never changes.
      var analysed = spectrumNeedsAnalysis(spectrum);
      var visible = phase === 'playing' && spectrum !== SPECTRUM_OFF && (!analysed || analysis !== null);

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
     * How many terms the user owns: the ones in the user's own layer plus the
     * ones staged in this session, counted when their reading differs from the
     * built-in one — or when the term is not built-in at all.
     *
     * The count comes from the user's layer, not from the rows on screen: the
     * rows also carry the terms the deployment added, and those are not the
     * user's own.
     * @param userDictionary - The user's own dictionary layer, or null.
     * @param staged - The staged `dictionary` write, or null.
     * @param defaults - Built-in term → spoken map.
     * @returns The number of the user's own entries.
     */
    function countOwnDictionaryEntries(userDictionary, staged, defaults) {
      var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
      var seen = {};
      var count = 0;
      var sources = [userDictionary, staged];
      for (var source = 0; source < sources.length; source += 1) {
        var entries = sources[source];
        if (entries === null || typeof entries !== 'object') continue;
        for (var term in entries) {
          if (!Object.prototype.hasOwnProperty.call(entries, term)) continue;
          if (seen[term] === true) continue;
          seen[term] = true;
          var spoken = String(entries[term] === undefined || entries[term] === null ? '' : entries[term]).trim();
          if (spoken === '') continue;
          if (!Object.prototype.hasOwnProperty.call(builtIn, term)) {
            count += 1;
            continue;
          }
          if (builtIn[term] !== spoken) count += 1;
        }
      }
      return count;
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

    /** The providers the card offers, in the order it offers them. */
    var TTS_PROVIDER_OPTIONS = [
      { id: TTS_PROVIDER_EDGE, label: 'edge-tts (по умолчанию)' },
      { id: TTS_PROVIDER_CUSTOM, label: 'OpenAI-совместимый' },
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
     * @param props - `view`, which view the Plugins page asks the entry for
     *   (`plugins.bundle.config` renders `page`), and `scope`, the shared
     *   `ConfigForm` over the `dsh-voice-v` settings namespace injected by the
     *   registration. The name `scope` is kept rather than `form` on purpose:
     *   the slot owner already passes its own `form` (`ConfigPageForm`), and two
     *   different `form` faces on one props object would collide.
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

      // What the user typed into the API key field. The key itself never
      // reaches the browser: the field starts empty, and the host reports only
      // whether a key is set. The state holds the new text until it is saved.
      var apiKeyState = react.useState('');
      var apiKeyInput = apiKeyState[0];
      var setApiKeyInput = apiKeyState[1];

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

      // The form carries the raw row config, where a field nobody set is
      // simply absent: its effective value is the one the host resolved out of
      // the preset. The host's own payload carries that resolved value, so the
      // display reads it from there and keeps the form for what the payload
      // does not know.
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
            ];
            for (var index = 0; index < carried.length; index += 1) {
              var name = carried[index];
              if (config[name] !== undefined && config[name] !== null) out[name] = config[name];
            }
          }
          // The key is a secret: the card shows a password field that starts
          // empty, so the value is dropped here and never reaches the screen.
          delete out.customApiKey;
          return out;
        },
        [effective, config],
      );

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
          voice: resolved.voice,
          spectrum: knownSpectrumVariant(resolved.spectrum),
          ttsProvider: resolved.ttsProvider === TTS_PROVIDER_CUSTOM ? TTS_PROVIDER_CUSTOM : TTS_PROVIDER_EDGE,
          customBaseUrl: typeof resolved.customBaseUrl === 'string' ? resolved.customBaseUrl : '',
          customModel: typeof resolved.customModel === 'string' ? resolved.customModel : '',
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
        }),
        [draft, defaultVoice],
      );

      // `plugins.bundle.config` renders only the `page` view, but the owner props
      // also carry `summary` and a `page`-only seat may still be asked for one,
      // so answer it rather than rendering a full form into a one-liner. Every
      // hook above has already run by now, so React sees the same hook order in
      // both views.
      if (props.view === 'summary') {
        return 'Озвучка ответов: голос, темп, тон и словарь произношения.';
      }

      if (!scope) {
        return h(
          'div',
          { className: 'dvv-card' },
          h('p', { className: 'dvv-title' }, 'Озвучка ответов (dsh-voice-v)'),
          h('p', { className: 'dvv-hint' }, 'Служба configForms недоступна — карточка не смонтирована.'),
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
      var apiKeySet = config !== null && config.customApiKeySet === true;

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
          rows: current.rows,
        }));
        stage('voice', value);
      };

      /** The select changed: a catalogue voice, or the hand-written field. */
      var onVoiceChoice = (value) => {
        if (value === CUSTOM_VOICE_OPTION) {
          // The swap keeps the value: the field opens on the voice in use.
          setCustomVoice(true);
          return;
        }
        setCustomVoice(false);
        onVoice(value);
      };

      /** The hand-written field changed: an empty field falls back to the default. */
      var onCustomVoice = (value) => {
        var text = value === undefined || value === null ? '' : String(value);
        onVoice(text.trim() === '' ? defaultVoice : text);
      };

      /**
       * Put the chosen provider into the draft and stage it as the single
       * `ttsProvider` write. Anything but `custom` means the local CLI, which
       * is the default.
       * @param value - The provider id the select reported.
       */
      var onProvider = (value) => {
        var provider = value === TTS_PROVIDER_CUSTOM ? TTS_PROVIDER_CUSTOM : TTS_PROVIDER_EDGE;
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
          rows: current.rows,
        }));
        stage('pitch', formatPitch(value));
      };

      var replaceRows = (rows) => {
        setDraft((current) => ({
          preset: current.preset,
          ratePct: current.ratePct,
          pitchHz: current.pitchHz,
          stripCode: current.stripCode,
          autoPreset: current.autoPreset,
          voice: current.voice,
          spectrum: current.spectrum,
          rows: rows,
        }));
        stage('dictionary', dictionaryOverrideFromRows(rows, defaults));
      };

      var onRowSpoken = (index, value) => {
        var rows = draft.rows.slice();
        rows[index] = { term: rows[index].term, spoken: value, isDefault: rows[index].isDefault };
        replaceRows(rows);
      };

      var onRowReset = (index) => {
        var row = draft.rows[index];
        var builtIn = defaults !== null && typeof defaults === 'object' ? defaults : {};
        if (row.isDefault && Object.prototype.hasOwnProperty.call(builtIn, row.term)) {
          var rows = draft.rows.slice();
          rows[index] = { term: row.term, spoken: builtIn[row.term], isDefault: true };
          replaceRows(rows);
          return;
        }
        replaceRows(draft.rows.filter((_, position) => position !== index));
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
        replaceRows(rows);
        setNewTerm('');
        setNewSpoken('');
      };

      var overriddenBadge = (field) =>
        Object.prototype.hasOwnProperty.call(userLayer, field)
          ? h('span', { className: 'dvv-badge' }, 'изменено')
          : null;

      var ratePct = draft.ratePct === null ? 0 : draft.ratePct;
      var pitchHz = draft.pitchHz === null ? 0 : draft.pitchHz;
      // What the dictionary summary reports: how many terms the dictionary
      // holds, and how many of them the user owns.
      var termCount = draft.rows.length;
      var stagedDictionary =
        pending.dictionary !== undefined &&
        pending.dictionary !== null &&
        pending.dictionary.op === 'set' &&
        pending.dictionary.value !== null &&
        typeof pending.dictionary.value === 'object'
          ? pending.dictionary.value
          : null;
      var ownTerms = countOwnDictionaryEntries(userLayer.dictionary, stagedDictionary, defaults);

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

        h('div', { key: 'voice', className: 'dvv-group' }, [
          h('p', { key: 't', className: 'dvv-group-title' }, ['Голос', overriddenBadge('voice')]),
          h('div', { key: 'row', className: 'dvv-voice' }, [
            customVoice
              ? h('input', {
                  key: 'custom',
                  className: 'dvv-input',
                  type: 'text',
                  value: currentVoice,
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
          h(
            'p',
            { key: 'hint', className: 'dvv-hint' },
            'Свой эндпоинт необязателен: edge-tts остаётся дефолтом и работает без ключей. Ключ хранится в пользовательском слое профиля и в браузер не отправляется.',
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
            'Показывает движение звука рядом с кнопкой озвучки в сообщении. «Спектр» и «Волна» смотрят в сам звук, «Пульс» и «Точки» — простая анимация.',
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
            h('span', { key: 'c', className: 'dvv-details-count' }, termCount + ' ' + termsWord(termCount)),
            ownTerms > 0
              ? h('span', { key: 'o', className: 'dvv-details-count' }, '· ' + ownTerms + ' изменено')
              : null,
          ]),
          h('div', { key: 'body', className: 'dvv-details-body' }, [
            h(
              'p',
              { key: 'hint', className: 'dvv-hint' },
              'Сопоставление без учёта регистра, по границам слов, длинные термины раньше коротких. «Сброс» у встроенного термина возвращает дефолт, у своего — удаляет строку.',
            ),
            h('div', { key: 'head', className: 'dvv-dict-head' }, [
              h('span', { key: 'a' }, 'Термин'),
              h('span', { key: 'b' }, 'Транскрипция'),
              h('span', { key: 'c' }, ''),
              h('span', { key: 'd' }, ''),
            ]),
            h(
              'div',
              { key: 'rows', className: 'dvv-dict' },
              draft.rows.map((row, index) =>
                h('div', { key: row.term + ':' + String(index), className: 'dvv-dict-row' }, [
                  h('span', { key: 'term', className: 'dvv-value', style: { textAlign: 'left' } }, row.term),
                  h('input', {
                    key: 'spoken',
                    className: 'dvv-input',
                    type: 'text',
                    value: row.spoken,
                    disabled: disabled,
                    'aria-label': 'Транскрипция для ' + row.term,
                    onChange: (event) => onRowSpoken(index, event.target.value),
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
                      key: 'reset',
                      type: 'button',
                      className: 'dvv-btn dvv-btn-danger',
                      disabled: disabled,
                      title: row.isDefault ? 'Вернуть дефолт' : 'Удалить строку',
                      onClick: () => onRowReset(index),
                    },
                    row.isDefault ? 'Сброс' : 'Удалить',
                  ),
                ]),
              ),
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
              }),
              h(
                'button',
                { key: 'add', type: 'button', className: 'dvv-btn', disabled: disabled, onClick: onRowAdd },
                'Добавить',
              ),
              h('span', { key: 'pad' }, ''),
            ]),
          ]),
        ]),
      ]);
    }

    /**
     * The one service the whole half cannot work without. `configForms` is
     * deliberately absent — see the note at the top of this file: it is waited
     * for inside `apply`, so its absence cannot suspend the speaker button.
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

      // The settings card waits for `configForms` in its own fiber, so a host
      // that never provides it leaves the button above untouched. `slots` is
      // re-declared here because this scope reads it too.
      ctx.inject(['slots', 'configForms'], (scope) => {
        // One shared form per plugin entry, taken on the card's fiber; the card
        // reads and writes it through its injected props. The entry id is the
        // Host Loader row id, which this plugin keeps equal to the namespace,
        // and the settings provider owns the form's disposal.
        var form = scope.configForms.get(SETTINGS_NAMESPACE);

        // `plugins.bundle.config` is declared by ui-plugin-manager, which may
        // mount after this plugin: `slots.inject` waits for the declaration
        // instead of assuming an order between packages. `whileServed` keeps the
        // card — and therefore the wait — alive only while the Host serves the
        // namespace, and the effect owns the disposer it returns, so unloading
        // this fiber removes the watch and any live registration with it.
        scope.effect(
          () =>
            scope.configForms.whileServed([SETTINGS_NAMESPACE], () =>
              scope.slots.inject('plugins.bundle.config', () =>
                scope.slots.register(
                  {
                    // Keyed slot: the key is the npm package name, not the row
                    // id. The page looks the entry up by `pkg.name` and only
                    // renders the section when this key is present, so the two
                    // must match exactly.
                    name: 'plugins.bundle.config',
                    key: SETTINGS_NAMESPACE,
                    inject: () => ({ scope: form }),
                  },
                  VoiceSettingsCard,
                ),
              ),
            ),
          'dsh-voice-v: settings page',
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
