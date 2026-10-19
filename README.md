# dsh-voice-v

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-dsh--voice--v-red.svg)](https://www.npmjs.com/package/dsh-voice-v)

A speaker button under every assistant message in the DeepSeek Harness web GUI,
plus a **settings card in Settings → Plugins**. Clicking the button narrates the
message with `edge-tts`; the card configures the voices, the presets, the tempo,
the pitch, the pronunciation dictionary, the visualization inside the button, and
whether code is read aloud — all without touching `package.json` or
`cordis.patch.yml`.

- **Seven voices** — two native Russian (`ru-RU-SvetlanaNeural`,
  `ru-RU-DmitryNeural`) and five multilingual ones that read Russian with a
  slight accent. A deployment extends the catalogue through `config.voices`.
- **The preset follows the tone of the message** — «блин, устала» is read as
  *Усталый*, «люблю, скучаю» as *Живой*, a technical answer as *Спокойный*,
  flirt as *Дерзкий* (`lib/tone.js`, plain rules, no model, no extra context).
- **A spectrum inside the button** while the voice plays — four variants, from a
  real frequency analyser to a CSS-only pulse, switchable and switchable off in
  the card.
- **Your own presets** — save the sliders as a preset, keep it next to the
  shipped ones, delete it when it is not needed.

Repository: <https://github.com/zerotoo1/dsh-anima-vi>

- **Host half** (`lib/index.js`) registers a `/dsh-voice-v` prefix route on the
  injected `webServer` Cordis service, synthesizes speech with the `edge-tts`
  CLI, and registers the `dsh-voice-v` settings namespace
  (`lib/host-settings.js`). The preset of a message can be picked from the tone
  of its wording (`lib/tone.js`).
- **Browser half** (`lib/client.js`) registers two slots: the speaker button in
  `conversation.chat.assistant-actions` (the strip the Like/Dislike buttons live
  in) and the settings card in `plugins.bundle.config`, keyed on the bundle's
  package name. The card reads and writes the `dsh-voice-v` namespace through
  the `configForms` service, and only while the Host serves that namespace.

## Requirements

| | |
|---|---|
| Node | `^22.19.0` or `>=24` (the harness runtime) |
| `edge-tts` | the CLI of the Python package [`edge-tts`](https://pypi.org/project/edge-tts/) (7.x) — the only external program the plugin runs |
| Network | `edge-tts` talks to the Microsoft speech service; the MP3 cache in `~/.dsh/cache/dsh-voice-v` spares the repeats |
| npm packages | **none** — the plugin declares no `dependencies`; the browser half needs only `react`, which the harness shell provides |

The `edge-tts` path is a deployment key: `binPath` in `cordis.patch.yml`
(default: the `edge-tts.exe` of the local Python runtime).


## Where the settings live

| Layer | Where | Who edits it |
|---|---|---|
| built-in defaults | `lib/config.js` (`DEFAULT_PRESETS`, `DEFAULT_RATE`, …) | nobody |
| composition layer | the plugin row's `config` in `cordis.patch.yml` | the deployment |
| **user layer** | the user-settings document, namespace `dsh-voice-v` | **the settings card** |

Resolution order is **user section → plugin row `config` → built-in defaults**,
and within a layer **explicit `rate` / `pitch` → named `preset` → the layer's
own defaults**.

The namespace is registered on the Host with a schemastery schema and the plugin
row's `config` (projected down to the namespace fields) as its `base`, so
that is the documented DSH semantics: a field the user clears re-inherits the
composition layer rather than a copy of the current value.

### Names the two halves share

| Thing | Value |
|---|---|
| settings namespace | `dsh-voice-v` |
| settings-card slot | `plugins.bundle.config` (keyed by the package name `dsh-voice-v`) |
| client services injected | `slots`, `configForms` |
| Host service | `ctx.settings` (`SettingsForms`); the host half publishes a volatile schemastery `Config` |

Namespaces can only be registered by a Host plugin, and the settings card only
renders for a namespace the Host actually serves — which is why both halves and
this table spell the same string.

## The settings card

Settings → Plugins → **Plugin configuration** → *Озвучка ответов (dsh-voice-v)*.

* **Presets** — five shipped ones, as data (`lib/config.js`), rendered from
  whatever the host reports on `GET /dsh-voice-v/config`:

  | id | rate | pitch |
  |---|---|---|
  | `zhivoy` (default) | `+6%` | `+12Hz` |
  | `neytralnyy` | `0` | `0` |
  | `spokoiny` | `−6%` | `−8Hz` |
  | `derzkiy` | `+10%` | `+6Hz` |
  | `ustaly` | `−12%` | `−15Hz` |

  Choosing a preset moves the sliders immediately and clears any explicit
  tempo/tone override. A deployment may add its own preset under
  `config.presets`; it appears in the card labelled by its id.

  * **Свои пресеты** — a name field and *Сохранить как пресет* make a preset
  out of what the sliders show right now (tempo, tone, and the voice the card
  holds). The name the user typed is the label; the id behind it is derived
  from that name (`user-…`), so the same name always means the same preset and
  it can never shadow one of the five shipped ones. A user preset sits in the
  list next to the shipped ones and carries a ✕ button — the delete control
  that only user presets have. Both actions stage **one** `userPresets` write
  that carries the whole pool, and the other staged edits stay untouched.

  A user preset may name a voice of its own. It is used when the user has not
  set a voice explicitly; an explicit `voice` still wins, exactly like an
  explicit `rate` / `pitch` beats the preset.

* **Sliders** — tempo `−30% … +40%`, pitch `−40 … +40 Hz`, step 1, with the
  numeric value beside them. The domains come from the host (`rateRange` /
  `pitchRange`), not from the bundle.
* **Сбросить к пресету** — stages an *unset* of `rate` and `pitch`, so the named
  preset answers again once saved.
* **Прослушать** — synthesizes with exactly what the sliders show, saved or not,
  through `POST /dsh-voice-v/preview`, and plays the MP3 immediately. The
  preview never reads and never writes the settings document.
* **Словарь произношения** — a collapsed block at the bottom of the card: the
  summary line reports how many terms the dictionary holds (`150 терминов`) and
  how many of them the user owns (`· 3 изменено`). Open it to edit the
  transcription of a term, reset a built-in row back to its default, delete an
  added row, or add a new pair. Each row has its own ▶ button that auditions
  that transcription.
* **Вырезать код из озвучки** — see below.
* **Пресет по тону сообщения** — see "The preset by the tone of the message"
  below. On by default.
* **Голос** — a dropdown over the catalogue the host reports (`voiceList`): the
  two Russian voices edge-tts serves for Russian, and the five multilingual
  voices that read Russian correctly. The last option, **«Свой голос…»**,
  swaps the dropdown for a text field, so any id can still be typed by hand.
  A voice outside the catalogue is shown as an option of its own: the dropdown
  never hides the voice in use.
* **Визуализация** — see "The visualization inside the message button" below.
  On by default.
* **Синтез речи** — the provider dropdown (`edge-tts` by default, or an
  OpenAI-compatible endpoint) and, while the endpoint is chosen, its base URL,
  its model id and its key. See "Custom TTS Providers" below.
* **Сохранить / Отменить правки** — nothing is written until Save: the card
  stages the fields the user touched and sends one `scope.set` (or
  `scope.unset`) per field. A header note marks unsaved edits, and a namespace
  in read-only memory mode disables the controls.

### The voice catalogue

The catalogue is **data in the host half** (`VOICE_OPTIONS` in
`lib/config.js`), reported to the card as `voiceList` by
`GET /dsh-voice-v/config`. The bundle hard-codes no voice of its own: what the
host reports is what the dropdown offers.

| group | id | note |
|---|---|---|
| Русские | `ru-RU-SvetlanaNeural` | the default |
| Русские | `ru-RU-DmitryNeural` | the only other Russian voice the service serves |
| Мультиязычные | `en-US-AvaMultilingualNeural` | reads Russian correctly |
| Мультиязычные | `en-US-EmmaMultilingualNeural` | reads Russian correctly |
| Мультиязычные | `de-DE-SeraphinaMultilingualNeural` | reads Russian correctly |
| Мультиязычные | `fr-FR-VivienneMultilingualNeural` | reads Russian correctly |
| Мультиязычные | `pt-BR-ThalitaMultilingualNeural` | reads Russian correctly |

The old Russian female voices (Dariya, Dasha, Polina, Zhanna, Masha) were retired
by the service and now fail with `NoAudioReceived`, so they are not offered.

A deployment extends or replaces the catalogue through the plugin row's
`config.voices` — the same pattern the `presets` key uses:

```yaml
- insert:
    - id: dsh-voice-v
      name: 'dsh-voice-v'
      config:
        voices:
          - de-DE-KatjaNeural                     # a new voice joins the catalogue
          - { id: en-US-JennyNeural, label: 'Дженни' }
          - { id: ru-RU-SvetlanaNeural, label: 'Света' }   # replaces one entry
        # voices: { replace: [ru-RU-DmitryNeural] }       # replaces the catalogue
```

The **user layer never owns the catalogue**: only the `voice` field itself is a
user setting, and a voice the catalogue does not know is still honoured.

## Custom TTS Providers

`edge-tts` is the default and stays the default. The plugin speaks to a local
CLI, needs no key and no network, and a deployment that configures nothing
gets exactly the behaviour it had before this section existed — the same
process, the same arguments, the same cache.

A deployment that has keys of its own can point the plugin at an
**OpenAI-compatible endpoint** instead. The card grows a group **«Синтез
речи»** with four fields:

| field | meaning |
|---|---|
| `ttsProvider` | `edge` (default) or `custom` |
| `customBaseUrl` | the base URL, e.g. `https://api.openai.com/v1` |
| `customApiKey` | the provider's key — a secret |
| `customModel` | the model id, e.g. `tts-1` |

The endpoint's own fields appear only while `custom` is selected. All four are
ordinary settings: the **user layer owns them** and overrides the deployment
layer, exactly like every other setting. The deployment layer may prefill
them in the plugin row's `config` (`cordis.patch.yml`) — the key belongs in the
profile's user layer and **never in the repository**.

### The request

```
POST <base>/audio/speech
Content-Type: application/json
Authorization: Bearer <customApiKey>      ← only when a key is set

{ "model": "<customModel>", "input": "<text>", "voice": "<voice>", "response_format": "mp3", "speed": 1.06 }
```

* the URL is the base URL with its trailing `/` trimmed; a base that already
  ends with `/audio/speech` is used as it is, so a full endpoint URL is never
  doubled;
* `speed` is the tempo the plugin already had: `1 + rate/100` (`+6%` → `1.06`),
  clamped to OpenAI's `[0.25, 4.0]`. A tempo nobody configured sends no
  `speed` at all;
* the answer's bytes are the MP3, and they land in the plugin's own cache — the
  `/speak` flow, the audio route and the client cannot tell the two providers
  apart;
* a non-2xx answer fails with a message naming the status and the provider's
  own error text. A network error or a timeout fails the same way. **The key
  never appears in a log line, an error message, the cache key, or the
  `/config` payload** — the payload reports `customApiKeySet: true|false` and
  nothing more, and the card's password field starts empty.

**`pitch` has no equivalent in the OpenAI API** and is ignored by the custom
provider: the tone slider only shapes the edge-tts reading.

The **voice id** is the provider's own id, not an edge-tts voice: pick **«Свой
голос…»** in the voice dropdown and type it. The card says so while the custom
provider is selected.

### Providers that work

| provider | base URL | model | voice id |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `tts-1` (also `tts-1-hd`, `gpt-4o-mini-tts`) | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`, `marin`, `cedar` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` | `FunAudioLLM/CosyVoice2-0.5B:anna` |
| MiniMax | `https://api.minimax.io/v1` | `speech-02-hd` (also `speech-2.8-turbo`) | `English_expressive_narrator`, `female-shaonv` |

All three speak the OpenAI `POST /v1/audio/speech` shape with `{ model, input,
voice, response_format, speed }`.

## Playback: one voice at a time

The browser half owns **one** sound slot for the whole page
(`createAudioPlayer()` in `lib/client.js`), and both sound producers take it
before they make a sound:

* the speaker button under a message — `/dsh-voice-v/speak` answers with one
  cached MP3 per sentence-aligned chunk, and the chunks play back to back;
* the card's audition — `Прослушать` and the per-row ▶ buttons.

So a new start silences the old one: clicking the button of message B stops
the voice still playing from message A, and starting an audition in the card
stops whatever is being read — and the other way round. At most one voice
sounds at a time.

The slot carries a **generation counter**. Every claim and every stop raises
it, and a part that arrives late — its `<audio>` element finished loading
after somebody else took the slot — compares the generation it was created
under with the current one and stays silent instead of stealing the output.
The newer start always wins.

The button still toggles: a second click on the same button stops the voice it
started. A component that goes away (the card leaves the Plugins page) hands
the slot back.

## What the card writes

Only fields the namespace declares (`SETTINGS_FIELDS` in `lib/config.js`) can
shadow the plugin row's config: **`preset`**, **`rate`**, **`pitch`**,
**`voice`**, **`stripCode`**, **`autoPreset`**, **`dictionary`**,
**`userPresets`**, **`spectrum`**, **`ttsProvider`**, **`customBaseUrl`**,
**`customApiKey`**, **`customModel`**. A
hand-written key outside that set in the settings document is ignored, so the
document cannot be used to smuggle a `binPath` or `cacheDir` override past the
composition layer.

`userPresets` is a record of preset id → `{ label, rate, pitch, voice? }`. It
is volatile like every other card field, so the Host keeps it in the profile's
user layer: a preset the user made survives a Host restart, and no file of the
plugin's own is involved.

`rate`/`pitch` are stored as edge-tts literals (`'+6%'`, `'-8Hz'`), the same
representation the plugin row uses, so both layers share one cache key. The
dictionary stores only terms whose reading differs from the built-in table;
resetting a row removes the override, which is what brings the default back.

## Code, tables, and the `stripCode` switch

`stripCode` (default **on**, also settable in the plugin row) decides what
happens to a fenced code block and a markdown table:

* **on** — neither is read. The narrator says `блок кода, 12 строк` /
  `таблица, 3 строки` (proper Russian plural forms, and the table count is every
  line except the alignment separator) so the listener knows something was there.
* **off** — both are read as they are, minimally cleaned: the code keeps its
  text, its indentation, and its operators and loses only the symbols a voice
  cannot pronounce (`` ` ~ ^ | \ ``); a table is read row by row with its cells
  separated by commas, and the alignment separator row is dropped.

Indented code blocks are stripped only in the **on** state.

## The preset by the tone of the message

`autoPreset` (default **on**, a card switch, also settable in the plugin row)
lets the wording of an answer pick the preset for **that message**:

| Category | Preset | Words that point at it |
|---|---|---|
| tired / exasperated | `ustaly` | блин, устал, устала, устали, выматывает, чёрт, черт, бесит, хреново, тяжело, сил нет, выгорел, задолбал, достало |
| warm / loving | `zhivoy` | люблю, скучаю, скучал, рад, рада, здорово, отлично, ура, обнимаю, счастье |
| work / technology | `spokoiny` | код, функция, ошибка, компиляция, тест, деплой, рефакторинг, репозиторий, коммит, патч, лог, стектрейс, баг, конфиг, сервер, база данных, миграция, запрос, модуль, переменная, скрипт, нейросеть, промпт, токен, api, npm |
| flirt | `derzkiy` | милый, милая, милаш, красавец, красавица, нравишься, обнимаешь, поцелуй, флирт, глаза, смотришь на меня, заинтересовать, соблазн |

The analysis is a plain rule table over Russian words — **no model, no network,
no extra context** (`lib/tone.js`). The words are matched case-insensitively on
word boundaries, so `устал` never fires inside `усталивать`.

* The analysis runs on the **raw** message text, before the speech cleaning:
  the wording that carries the mood is exactly what the cleaning would have
  thrown away. The sample is capped at the first **4000 characters** — the
  opening of an answer carries its mood, and the tail of a long answer does
  not change it.
* A category counts the **distinct** rule terms it matched: a word repeated
  ten times counts once.
* The category with the most matches wins. A **tie** is broken by the fixed
  priority `ustaly` → `derzkiy` → `zhivoy` → `spokoiny` — the most deliberate
  signal first. The same text always gets the same preset.
* A text that matches nothing keeps the configured preset.

The choice is a **per-request override**: it never changes what is stored, it
never changes the voice, and a tempo or a tone the user pinned explicitly still
wins over it (field by field). The background warming of the remaining chunks
carries the same override, so the whole message is spoken with one voice.

## The visualization inside the message button

`spectrum` (default **`bars`**, a card dropdown, also settable in the plugin
row) decides what the speaker button shows **while that message's own voice
plays**. The allow-list lives in `lib/config.js` (`SPECTRUM_VARIANTS`) and the
host reports it on `GET /dsh-voice-v/config` as `spectrumVariants`; the card
renders what the host offers.

| id | card | what it is |
|---|---|---|
| `off` | Выключено | nothing is shown |
| `bars` | Спектр | a real frequency spectrum, drawn from the audio |
| `wave` | Волна | a real oscilloscope, drawn from the audio |
| `pulse` | Пульс | a pulsing dot — pure CSS, no analysis |
| `dots` | Точки | three bouncing dots — pure CSS, no analysis |

The visualization lives **inside the message's own button**, in the place of
the speaker glyph: the same 15 px box, the same colour (`currentColor`, so it
follows the button's own `data-phase` colour), no frame, no shadow, no label.
The box never changes size, so nothing around it moves when the visualization
comes or goes. The button keeps its `data-phase` and its click-to-stop
behaviour; the visualization is gone the moment the sound ends, fails, is
stopped, or is taken away by another message.

The two analysed variants read the audio through the Web Audio API:
`AudioContext` → `createMediaElementSource` → `createAnalyser` →
`destination`. **The sound always comes first.** The context is created inside
the click, where the browser still lets it start, and the element is re-routed
only when that context is actually `running` — a context that stayed suspended
(or one that could not be created at all) leaves the element exactly as it
was, and the voice plays as it always did. Should the graph fail after the
source node was made, the source is connected straight to the destination, so
the sound comes out either way. A browser without the Web Audio API, without
canvas, or with a blocked context simply shows no visualization.

The card's own audition (*Прослушать*) shows no visualization: the
visualization belongs to the message's interface, and the card is a settings
panel.

## HTTP endpoints

All six live under the `/dsh-voice-v` prefix registered on `ctx.webServer`.

| Route | Behaviour |
|---|---|
| `GET /dsh-voice-v/health` | liveness, effective voice settings, and the `stripCode` state. No synthesis. |
| `GET /dsh-voice-v/config` | resolved preset / voice / rate / pitch, the preset table (`presets`, the user's own `userPresets`, and the ordered `presetList`), the built-in `dictionaryDefaults`, the effective `dictionary`, the slider domains, the `stripCode` and `autoPreset` switches, the visualization (`spectrum` and the `spectrumVariants` the card renders), the synthesis provider (`ttsProvider`, `customBaseUrl`, `customModel` and `customApiKeySet` — the key itself is never sent), `settingsNamespace`, `settingsFields`, and `settingsRegistered`. No synthesis. |
| `GET\|POST /dsh-voice-v/speak` | resolves the message text, cleans it, chunks it, synthesizes the **first** chunk, and returns the ordered part list. Reads the live settings. |
| `GET\|POST /dsh-voice-v/preview` | synthesizes with the caller's own `text`/`preset`/`rate`/`pitch`/`voice`/`stripCode` and answers `audio/mpeg`. Reads no settings. |
| `GET\|HEAD /dsh-voice-v/audio/<sha256>.mp3` | the cached MP3 for one part, with `Accept-Ranges` and single-range `206` support. |

`/speak` query parameters (or the same keys in a JSON `POST` body): `sessionId`,
`messageId`, and a `text` fallback used only when the session read yields
nothing. The browser half never sends `text`; it exists so the route is usable
from a shell.

Response shape:

```json
{
  "ok": true,
  "voice": "ru-RU-SvetlanaNeural",
  "rate": "+6%",
  "pitch": "+12Hz",
  "volume": "+0%",
  "preset": "zhivoy",
  "configuredPreset": "zhivoy",
  "autoPreset": false,
  "autoPresetEnabled": true,
  "tone": null,
  "stripCode": true,
  "spectrum": "bars",
  "sessionId": "…", "messageId": "…",
  "source": "session",
  "chars": 1842,
  "truncated": false,
  "parts": [
    { "key": "<sha256>", "url": "/dsh-voice-v/audio/<sha256>.mp3", "chars": 312, "cached": true }
  ]
}
```

`rate`, `pitch`, and `preset` are the values the message was really spoken
with. `configuredPreset` is the stored preset, `autoPreset` says whether the
automatic choice was applied to this message, and `tone` explains it
(`{ preset, matched, score, candidates }`) when one was.

`spectrum` is the visualization variant the button shows while this voice
plays: the manifest is the one request the button already makes, so the
variant travels with it.

### `/preview`

`POST /dsh-voice-v/preview` with `{ text?, preset?, rate?, pitch?, voice?, stripCode? }`
(the same keys are accepted as query parameters on `GET`). Missing `text` falls
back to the shipped sample sentence. An out-of-range rate/pitch is clamped to the
slider domain, an unknown preset falls back to the built-in defaults, and the
response carries `Content-Type: audio/mpeg` with `Cache-Control: no-store` —
those bytes depend on values that were never saved, so they must not be cached
as immutable. The MP3 itself lands in the ordinary per-chunk cache (the cache key
already carries the voice triple) and is reused if the same combination is heard
again, including by `/speak` after Save.

## How the host half reaches the settings API

The host half does not call a registration helper. It **publishes** the schema and
lets the Host read it from the plugin's own module:

```js
// lib/index.js
export { Config } from './host-settings.js';   // a volatile schemastery schema
```

The Host's `dsh-settings` service reads `entry.fiber.runtime.Config` for every
live Loader row, keeps only the fields the schema marks `.volatile()`, and
publishes the row under the namespace `entry.options.id` — `dsh-voice-v` here.
The card then finds that namespace through `configForms`, and a write lands in
the Host's user layer, where the Loader commits it back into the very same
volatile references the plugin already holds. That is why a saved value applies
**without a Host restart**.

`@deepseek-ai/schemastery` is **resolved at runtime**, not imported statically.
A plugin installed inside the profile resolves it normally, but this package is
typically installed as a `link:` to a directory outside it, and Node resolves a
bare specifier from the importing file's real path — a static import would fail
with `ERR_MODULE_NOT_FOUND` before the plugin mounted. `loadSchemaFactory`
therefore anchors a `createRequire` at the plugin itself, at
`DSH_PROFILE_DIR`/`DSH_HOME`, at `<dsh home>/profiles` (the fallback directory
the harness installs), at each profile under it, and at the running Host's own
installation — the directory of `process.argv[1]` — and imports the first
resolution that answers. Only a copy that can mark fields volatile is accepted:
a schemastery without `.volatile()` cannot express this namespace at all.

Nothing in that path throws. A deployment that cannot resolve the peer keeps
working off the plugin row's `config`, logs one warning, and the card reports
`settingsRegistered: false` instead of offering a save that could not land.

## Other configurable keys (plugin row only)

These never appear in the settings card:

| Key | Default | Meaning |
|---|---|---|
| `binPath` | local `edge-tts.exe` | `edge-tts` executable |
| `cacheDir` | `~/.dsh/cache/dsh-voice-v` | MP3 cache folder |
| `volume` | `+0%` | passed to `--volume` |
| `maxChunkChars` | `320` | characters per synthesized chunk |
| `maxTextChars` | `24000` | longest accepted answer; longer text is trimmed |
| `timeoutMs` | `60000` | per-invocation `edge-tts` timeout |
| `warmConcurrency` | `2` | background warm-ups of not-yet-cached chunks |
| `presets` | the five built-ins | extra/replacement preset table |
| `voices` | the seven built-in voices | extra/replacement voice catalogue |

The built-in pronunciation dictionary is `DEFAULT_PRONUNCIATION` in
[`lib/text.js`](lib/text.js) and is reported to the card as
`dictionaryDefaults`. Keys are matched **case-insensitively** and, when they
begin with a letter or digit, on whole-word boundaries only, so `ent` never
rewrites `content`; keys are applied longest-first, so `.anims` wins over
`anims`.

## How the host gets the message text

The client sends only `sessionId` + `messageId`, and the host resolves the text
in [`lib/session-text.js`](lib/session-text.js):

1. `ctx.sessions.get(sessionId)` → the live session, read through
   `snapshotEvents()`;
2. otherwise `ctx.sessionPersistence.open(sessionId, 'read')` → the durable log,
   closed again in a `finally`.

The message is taken from an `assistant/message` surface event's
`event.data.message`, joining only its `text` blocks — `reasoning` and
`tool-call` blocks are never narrated. Append-origin events
(`surfaceOp === 'append'`) are preferred over surface replacements.

No `@deepseek-ai/*` package is imported for this, so the read cannot break on a
service identity or version mismatch; the event shape is read structurally and
any failure returns `null` instead of throwing.

## Caching and chunking

- The cache key is `sha256(text + "\0" + voice + "\0" + rate + "\0" + pitch + "\0" + volume)`.
  One MP3 per chunk; a hit is served straight from disk. Because the voice triple
  is part of the key, a changed setting lands in its own slot instead of reusing
  the previous reading.
- The custom endpoint adds its own material to the key — the provider, the
  model and the base URL — so an `edge-tts` file is never served for a custom
  request, and the other way round. The API key is deliberately **not** part of
  the key: a secret must never reach a file name, and replacing a key must not
  re-synthesize everything.
- Concurrent requests for the same chunk share one `edge-tts` process.
- The answer is cleaned, then cut into sentence-aligned chunks of at most
  `maxChunkChars`. `/speak` synthesizes chunk 1 synchronously and warms the rest
  in the background.
- A long single sentence with no sentence boundary is hard-split at a comma or
  space.

## Process safety

`edge-tts` is launched with `spawn(binPath, argv, { shell: false })`. The text
**never** appears in `argv`: it is written to a UTF-8 temp file and read by
`--file`. Every other argument is a plugin-owned literal, so no caller text can
reach argument parsing. stdout is ignored and stderr goes to a real file
descriptor (not a pipe), which also keeps the module working where
`child_process` cannot open named pipes. Temp files live in `<cacheDir>/.tmp` and
are removed in a `finally`.

## Install into a profile

From the repository:

```bash
git clone https://github.com/zerotoo1/dsh-anima-vi.git
```

or take the release archive `dsh-voice-v-<version>.zip` and unpack it
anywhere. The plugin is a plain folder — it is never installed into
`node_modules` by a package manager, it is linked.

`~/.dsh/profiles/web`:

1. **`package.json` → `dependencies`** — add
   `"dsh-voice-v": "link:path/to/your/plugin"`
   (or `"file:…"`, or the path of your clone), then let the profile's package
   manager materialise the link.
2. **`package.json` → `dsh.profile.bundles`** — append `"dsh-voice-v"`.
3. **`cordis.patch.yml`** — no new block is required: the package ships its own
   [`cordis.patch.yml`](cordis.patch.yml) and DSH applies each bundle's
   `dsh.bundle.patch` overlay. Add a block to the profile patch **only** to
   change the deployment defaults.
4. Restart the web server / reload the page. After that, everything the card
   edits applies to the next narration with **no restart**.

The same folder can be published to npm:

```bash
npm publish --access public
```

## Development

```bash
node scripts/build-client.mjs   # client bundle gate
node test/synth.mjs             # 39 checks: text, chunking, config, cache, routes, session lookup
node test/settings.mjs          # 102 checks: presets, user presets, dictionary, stripCode, /preview, live settings, the tone of the message, the voice catalogue, the visualization, the rendered card, the shared sound slot
npm test                        # both
```

`lib/client.js` is hand-written directly in the lazy-CJS bundle protocol
(`window.__ModuleLoader__.load({ id, factory })`) rather than compiled into it,
so `scripts/build-client.mjs` is a verifier, not a bundler. It syntax-checks the
bundle, evaluates it against a stub loader, calls `apply()` against a stub client
context, and asserts: the registration id equals the package name; every
`require()` specifier is one of the shell's seven seed words (`react`,
`react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`) or a
declared external; `apply`/`inject` are exported; both slots are injected into;
the card registers under `plugins.bundle.config` keyed on the bundle's package
name — the seat the plugin manager renders on the bundle's own detail page — and
the card receives a scope with
`getSnapshot`/`subscribe`/`set`/`unset`.

`test/settings.mjs` also renders the card without a browser: it evaluates the
bundle the way the shell does, mounts the plugin against a stub slot registry,
and drives the component with a minimal hook runtime — so a card that throws
while rendering, a preset that does not move the sliders, or a Save that writes
on the wrong trigger fails the suite. The same harness drives the speaker
button with a fake `<audio>` element, so a second message that does not stop
the first one, a preview that overlaps a voice, or a late part that steals the
output fails the suite too.

To replay the id-addressed message lookup against a genuine transcript:

```powershell
$env:DSH_VOICE_V_SESSION_FILE = "$HOME/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd"
node test/synth.mjs
```

## License

[MIT](LICENSE) © 2026 ZEROTOOL

