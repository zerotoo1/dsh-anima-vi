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
- **A live visualization while the voice plays** — five variants, from a real
  frequency analyser and an oscilloscope inside the button to a wide waveform
  drawn above the composer, plus two CSS-only ones; switchable, and switchable
  off, in the card.
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
  The form service is waited for in a fiber of its own, and the card is mounted
  through `configForms.whileServed` — so the card appears whenever the Host
  starts serving the namespace, and not only when the plugin happened to mount
  before the Host's settings document arrived.

## Requirements

| | |
|---|---|
| Node | `^22.19.0` or `>=24` (the harness runtime) |
| `edge-tts` | the CLI of the Python package [`edge-tts`](https://pypi.org/project/edge-tts/) (7.x) — the only external program the plugin runs |
| Network | `edge-tts` talks to the Microsoft speech service; the MP3 cache in `~/.dsh/cache/dsh-voice-v` spares the repeats |
| npm packages | **none** — the plugin declares no `dependencies`; the browser half needs only `react`, which the harness shell provides |

The `edge-tts` path is a deployment key: `binPath` in `cordis.patch.yml`. The
default is the bare name `edge-tts`, resolved through `PATH` — which is where a
plain `pip install edge-tts` puts it — so the repository carries no
machine-specific path. `DSH_VOICE_V_EDGE_TTS` overrides the default for a
one-off run, and a deployment that keeps the CLI somewhere else sets `binPath`.


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

* **Язык интерфейса / Interface language** — the card itself is bilingual. The
  dropdown offers `Русский` and `English`, the value is the `uiLanguage`
  setting (`ru` by default), and switching it re-labels the whole card, the
  speaker buttons under the messages and their tooltips at once — no reload.
  The choice is **staged like every other field**: the card speaks the staged
  language immediately, and *Сохранить* writes it, while *Отменить правки*
  brings back the host's. The narration is untouched: the voice reads the
  answer, not the interface. Host data is never translated — a voice id stays
  `ru-RU-SvetlanaNeural` in both languages.
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
* **Словарь произношения** — a collapsed block at the bottom of the card. It
  lists **only the terms the user owns**: the shipped table stays in the host
  (`dictionaryDefaults`) and is never rendered, so the block is a short list
  instead of a hundred and fifty rows. Two fields and a button: a pair is
  written to the settings the moment it is added — no trip back to the card's
  own Save, which stays unarmed. Editing a row's reading writes on blur, and
  **Удалить** drops the term from the user layer, so a built-in term falls back
  to its shipped reading. Each row has its own ▶ button that auditions that
  transcription.
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
* **Синтез речи** — the provider dropdown (`edge-tts` by default, an
  OpenAI-compatible endpoint, Yandex SpeechKit or Google Cloud TTS) and, while
  one of them is chosen, its own fields: the base URL, the model and the key
  for the endpoint, the voice and the key for Yandex and for Google. See
  "Custom TTS Providers" below.
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
| `ttsProvider` | `edge` (default), `custom`, `yandex`, `google` or `google-free` |
| `customBaseUrl` | the base URL, e.g. `https://api.openai.com/v1` |
| `customApiKey` | the provider's key — a secret |
| `customModel` | the model id, e.g. `tts-1` |
| `yandexApiKey` | the Yandex SpeechKit key — a secret |
| `yandexVoice` | the Yandex voice: `marina`, `ermil`, `pavel`, `male`, `jane` |
| `googleApiKey` | the Google Cloud API key — a secret |
| `googleVoice` | the Google voice: `ru-RU-Wavenet-A` … `ru-RU-Standard-B` |

The endpoint's own fields appear only while `custom` is selected, and the
Yandex ones only while `yandex` is selected, and the Google ones only while
`google` is selected. All of them are
ordinary settings: the **user layer owns them** and overrides the deployment
layer, exactly like every other setting. The deployment layer may prefill
them in the plugin row's `config` (`cordis.patch.yml`) — the key belongs in the
profile's user layer and **never in the repository**.

### The Yandex provider

Yandex SpeechKit is spoken of separately because it is not an
OpenAI-compatible endpoint: it has its own REST shape.

```
POST https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis?voice=<id>&format=mp3&sampleRate=48000&speed=<x>
Authorization: Api-Key <yandexApiKey>
X-DataLoggin-Enabled: false
{"text": "...", "hints": [{"voice": "<id>", "speed": 1.06, "pitchShift": 12, "volume": 1.1}], "outputAudioSpec": {"containerAudio": {"containerAudioType": "MP3"}}}
```

The route is the one the service's own descriptor names: the gRPC reflection of
the same host describes the service `speechkit.tts.v3.Synthesizer` and its rpc
`UtteranceSynthesis`, whose http rule is `POST /tts/v3/utteranceSynthesis` with
the body `*`. The older `/tts/v3/voiceSynthesis` route is not in that
descriptor and answers 404 with a plain-text "Not Found" — it was the v2 shape,
guessed.

* `hints` is an **array** — the service reads the body with Go's JSON decoder
  and rejects an object there ("cannot unmarshal object into Go value of type
  `[]json.RawMessage`");
* the tempo travels as a plain multiplier (`+6%` → `1.06`, `1.0` → `1`,
  `-5%` → `0.95`); a tempo nobody configured sends no speed at all;
* the tone and the volume travel in the same hint set — `pitchShift` in hertz
  (`+12Hz` → `12`) and `volume` as a multiplier (`+10%` → `1.1`). Both are
  named by the service's own descriptor, and both are clamped into the
  service's domain (the tone to ±40 Hz, the multiplier to 0.25–4);
* the folder the key works in is a query parameter (`folderId`), never a body
  field;
* the rpc is server-streaming, so the answer is a set of chunks and the parser
  takes the audio out of every shape it may arrive in — a single chunk
  (`audioChunk.data`), the older `result.audioChunk.data` envelope, an array of
  chunks, newline-delimited chunks, a chunk that carries its type —
  concatenating them in the order they arrived;
* the bytes are decoded into the same MP3 cache every other provider writes into, so
  `/speak`, the audio route and the card cannot tell the providers apart. With
  no key set, the provider is not used at all and the local CLI stays in charge.
* a non-2xx answer fails with a message naming the status and the service's own
  error text. A 403 (or a body mentioning `PermissionDenied`) says in plain
  words that **the key has no rights on the folder** and that the SpeechKit
  role has to be granted to it. **The key never appears in an error message** —
  it is redacted out of the service's own text as well.

### The Google provider

Google Cloud Text-to-Speech is spoken of separately for the same reason: it
has its own REST shape, and its own idea of what a voice and a tone are.

```
POST https://texttospeech.googleapis.com/v1/text:synthesize?key=<googleApiKey>
Content-Type: application/json
{"input": {"text": "..."}, "voice": {"languageCode": "ru-RU", "name": "ru-RU-Wavenet-A"}, "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1.06, "pitch": 1.01, "volumeGainDb": 0.83}}
```

The answer is one JSON object whose `audioContent` is the whole file in base64 —
not a stream, so it is read once and decoded whole. The key rides in the query
string, which is the shape the service documents for a server-side call
authenticated by an API key.

* the voice is the service's own id: `ru-RU-Wavenet-A` … `ru-RU-Wavenet-D` and
  `ru-RU-Standard-A` / `ru-RU-Standard-B`. A name the service does not know is
  never sent — the card offers only names that exist;
* `languageCode` is fixed to `ru-RU`: the voices offered are the Russian ones,
  and a voice name alone would let the service pick another language;
* the tempo travels as `speakingRate` (`+6%` → `1.06`), the same multiplier the
  other providers use;
* the tone travels in **semitones**, not in hertz, so the plugin's `+12Hz` is
  converted against a nominal 200 Hz reference: `12 * log2(1 + 12/200)` ≈ 1.01
  semitones. The reference is named in the code and the conversion is an
  approximation, not an exact inverse;
* the volume travels as `volumeGainDb`: `+10%` of amplitude is
  `20 * log10(1.1)` ≈ 0.83 dB;
* a 400 or a 403 fails with a message saying in plain words that the key has to
  be checked and that Text-to-Speech has to be enabled in its project. **The
  key never appears in an error message**;
* with no key set, the provider is not used at all and the local CLI stays in
  charge — the same rule the other providers follow.

### The free Google provider

The fifth provider needs **nothing**: no key, no billing, no settings. It speaks
to the route the translate page itself uses, and it answers MPEG audio:

```
GET https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ru&q=<text>
```

* it is **not a documented API** — it is the web page's own endpoint, and it may
  change or close without notice. The plugin says so rather than pretending the
  route is a contract;
* the route takes the text in a query string and refuses a long one, so the
  narration is cut into pieces of at most 200 characters, **on a word boundary**
  (a half-word is read as a half-word), and the pieces are concatenated in
  reading order. Verified live: a 262-character text became one 184 320-byte MP3;
* it has **one Russian voice** and no tempo or tone: the sliders do not shape
  it. The card says that in plain words instead of silently ignoring them;
* it sounds **worse** than the local CLI — it is the low-bitrate mono voice of
  the translate page, without the neural prosody of `edge-tts`. Its job is to
  be there when the local CLI is not: a machine with no `edge-tts` and no key
  still speaks. It is the last rung, not the daily choice;
* the bytes land in the same MP3 cache every other provider writes into.

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
**`voice`**, **`stripCode`**, **`autoPreset`**, **`yoMode`**, **`dictionary`**,
**`userPresets`**, **`spectrum`**, **`ttsProvider`**, **`customBaseUrl`**,
**`customApiKey`**, **`customModel`**, **`yandexApiKey`**, **`yandexVoice`**. A
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

## The letter `ё`, and the `yoMode` switch

The Russian voices of the Edge service read `ё` as `йе` — a palatal `е` with a
`й` in front of it — so `приём` comes out as `прийем` and the stress of the
word lands nowhere. The letter is therefore written out before the text
reaches the voice, and **how** it is written out is the user's choice:

| `yoMode` | What happens | What the voice says |
| --- | --- | --- |
| `as-is` (default) | the letter stays | `приём` → `приём`, and the Edge Russian voices read it as it is written |
| `plain` | the dots are dropped | `приём` → `прием` |
| `spelled` | the letter is written out phonetically | `приём` → `прийом`, `всё` → `всьо` |

The written-out spelling follows the Russian phonology: in the middle of a
word, after a soft consonant, the `ё` is `[jO]` (`приём` → `прийом`); at the
start of a word or after a hard consonant it is `[ʲO]` (`всё` → `всьо`, `нёбо`
→ `ньобо`, `ушёл` → `ушьол`); a `й` before the letter is not doubled (`моё` →
`мойо`), and the hard sign is dropped the way a reader drops it (`съёмка` →
`сьомка`).

`as-is` is the default because the Russian voices of the Edge service read the
letter correctly, and the user listened and called it perfect. The
written-out spelling is the mode for a voice that does not — and it changes
the words where the letter follows a hard consonant (`всё` → `всьо`, `ушёл` →
`ушьол`), which is why it is not the default. That trade-off is why the
switch exists at all: only an ear can settle it.

The Yandex provider needs none of this — its Russian voices read `ё` as `ё`.

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

## The visualization while the voice plays

`spectrum` (default **`bars`**, a card dropdown, also settable in the plugin
row) decides what the page shows **while that message's own voice plays**. The
allow-list lives in `lib/config.js` (`SPECTRUM_VARIANTS`) and the host reports
it on `GET /dsh-voice-v/config` as `spectrumVariants`; the card renders what the
host offers.

| id | card | what it is | where |
|---|---|---|---|
| `off` | Выключено | nothing is shown | — |
| `bars` | Спектр | a real frequency spectrum, drawn from the audio | across the composer |
| `wave` | Волна | a real oscilloscope, drawn from the audio | inside the button |
| `oscillo` | Осциллограмма | a live time-domain trace, drawn from the audio | across the composer |
| `pulse` | Пульс | a pulsing dot — pure CSS, no analysis | inside the button |
| `dots` | Точки | three bouncing dots — pure CSS, no analysis | inside the button |

Three of them are drawn from the audio itself, and where they live follows the
room they need. `wave`, `pulse` and `dots` live **inside the message's own
button**, in the place of the speaker glyph: the same 15 px box, the same colour
(`currentColor`, so it follows the button's own `data-phase` colour), no frame,
no shadow, no label. The box never changes size, so nothing around it moves
when the visualization comes or goes.

`bars` and `oscillo` need the width a 15 px box does not have, so they are
drawn on one wide strip that rides the top edge of the composer card, across
the full width of the field: the spectrum as a row of bars, `oscillo` as a
single live trace. The button keeps its stop glyph while they run, the strip
takes no pointer events, and it takes no room at all while nothing sounds.

Either way the button keeps its `data-phase` and its click-to-stop behaviour;
the visualization is gone the moment the sound ends, fails, is stopped, or is
taken away by another message.

The three analysed variants read the audio through the Web Audio API:
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
| `binPath` | `edge-tts` (resolved through `PATH`) | `edge-tts` executable |
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
node test/synth.mjs             # 95 checks: text, chunking, config, cache, routes, session lookup, and the Yandex, Google and custom providers
node test/settings.mjs          # 121 checks: presets, user presets, dictionary, yoMode, stripCode, /preview, live settings, the tone of the message, the voice catalogue, the visualization, the rendered card, the shared sound slot
node test/client.mjs            # 21 checks: both slots registered against a real Cordis context and a real SlotCore registry
npm test                        # all four
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

## Changelog

### 0.4.0

- **The interface is bilingual.** The card speaks Russian and English, and the
  language is a setting of its own (`uiLanguage`, `ru` by default), so both
  halves agree on it: the Host resolves it and reports it on `/config`, `/speak`
  and `/health`, and the card translates itself from one dictionary. A switch
  re-labels the card, the speaker buttons and their tooltips immediately, before
  Save. Host data — voice ids, provider names, a user's own preset label — is
  never translated.
- **`test/settings.mjs` covers the language**: normalization, the schema
  default, the resolver, the `/config` and `/speak` payloads, the English card,
  and the switch staging exactly one `uiLanguage` write while Russian stays
  byte-for-byte what it was.

### 0.3.0

- **Four synthesis providers next to `edge-tts`**: an OpenAI-compatible endpoint
  (any `/v1/audio/speech` server), **Yandex SpeechKit** v3, **Google Cloud TTS**
  and a keyless **free Google** route that keeps the plugin speaking on a machine
  with no `edge-tts` and no key. `edge-tts` stays the default and its argv, cache
  and errors are unchanged.
- **The letter `ё`** gained a switch (`yoMode`: `as-is` / `plain` / `spelled`),
  with the written-out spelling following Russian phonology.
- **The voice catalogue is data**, reported by the host as `voiceList`; the
  bundle hard-codes no voice and the dropdown grows a **«Свой голос…»** entry.
- **Both halves re-seated**: the card now lives in `plugins.bundle.config`
  (keyed on the package name) and is mounted through `configForms.whileServed`,
  so it appears whenever the Host starts serving the namespace — not only when
  the plugin mounted first — and it is withdrawn when the namespace stops.
- **`test/client.mjs`**: the browser half finally has tests. The bundle is
  evaluated the way the shell loads it, against a real Cordis context and a real
  `SlotCore` registry, so a slot that fails to register is a red test instead of
  two hours of staring at the GUI.
- **No machine-specific path in the repository**: `binPath` now defaults to the
  bare `edge-tts`, resolved through `PATH`; `DSH_VOICE_V_EDGE_TTS` overrides it.

### 0.2.0

- Custom TTS endpoint (base URL, key, model) with the OpenAI `/audio/speech`
  shape, the user's own presets (`userPresets`), the tone-of-message preset, and
  the visualization inside the message button and across the composer.

### 0.1.0

- Read-aloud speaker button under every assistant message, voiced by `edge-tts`,
  with the settings card: voices, presets, tempo, pitch, the pronunciation
  dictionary and the code-stripping switch.

## License

[MIT](LICENSE) © 2026 ZEROTOOL

