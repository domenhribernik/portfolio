# views/narek

Two pages over one microphone. `index.html` is **Narek**, the dictation sheet;
`tolmac/index.html` is **Tolmač**, the English/Slovenian interpreter. The `.seg`
toggle in each masthead is the only link between them.

Private, single-owner tool. Listed in the root
[CLAUDE.md](../../CLAUDE.md) unlisted set, `noindex, nofollow`, absent from
`project-data.js` and the sitemap. Do not register it.

## The split

| File | Owns |
|---|---|
| `logic.js` | Every DOM-free decision: the voice gate, WAV encoding, transcript text rules, the correction diff, translation parsing. Tested by `tests/narek-logic.test.mjs` |
| `audio.js` | getUserMedia, AudioContext, the worklet. Nothing else |
| `pcm-worklet.js` | Batches render quanta and posts them. Deliberately does no analysis, so the gate stays testable in node |
| `deck.js` | Everything above the sheet, shared by both pages: access gate, transport key, chart trace, clock, banner, toast |
| `script.js` / `tolmac/script.js` | One sheet each, and the network call that fills it |

A third page would add a directory and its own `script.js`, nothing else. It
must ship the deck's markup ids (`recordKey`, `trace`, `stateLine`, `banner*`,
`gate*`, `tool`, `counters`, `countClock`, `toast`) or `createDeck` throws on a
null element.

## Gotchas

- **The worklet URL is resolved against the module, not the page.**
  `new URL('./pcm-worklet.js', import.meta.url)` in `audio.js`. A page-relative
  string works from `views/narek/` and silently 404s from `views/narek/tolmac/`,
  and the only symptom is a record key that does nothing.
- **`accountPath` is per page.** `createDeck` needs the relative path to
  `views/account/` because the depth differs (`../account/` vs `../../account/`).
  `loginUrl()` in `components/auth-gate.js` takes it as its second argument.
- **Both pages read the same `narek.vocab` key** in localStorage. That is
  deliberate: names worth biasing are worth biasing in both directions.
- **The correction pass is diff-gated on purpose.** `OVERREACH_RATIO` in
  `logic.js` is the share of the transcript a proofread may touch before the
  page warns instead of applying. Slovenian's cases and dual make a fluent
  rewrite look correct, so the marks exist to catch meaning drift, not typos.
- **The interpreter never has a direction switch.** The model reports `lang`
  under a response schema and `parseTranslation()` derives the target. If it
  answers prose instead of JSON, the text is kept and the direction is dropped
  rather than guessed.
