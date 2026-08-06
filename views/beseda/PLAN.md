# Beseda: a free Slovenian learning tool

Slovenian is a hole in the language-learning market. Duolingo does not offer it, Clozemaster
cannot (its engine needs a big sentence corpus and Slovenian has almost none), and the paid
apps that do exist are unreliable. Beseda fills the gap for English speakers: a word of the
day with real example sentences where every Slovenian word explains itself on hover, topic
vocabulary drills, and a streak worth keeping.

Written 2026-08-06, using the `tdd` and `impeccable` skills in `.claude/skills/`.
Not deployed: this file is in the `exclude` list of `.github/workflows/deploy.yml`.

## 1. Why this shape

The hard constraint is **no manual content maintenance and no LLM in the loop**. Everything
a learner reads is derived mechanically from open data by `tools/beseda/build.py` and
committed as static JSON. The site never calls a content API at runtime; the page is four
`fetch()` calls to files in `data/`.

That constraint is what makes the hover gloss possible at all. Instead of translating
sentences on demand, the build resolves every token offline (inflected form to dictionary
lemma to English gloss) and bakes the answer into the JSON as character spans. Rendering is
then pure string slicing, and the page works with no backend.

The second constraint is **the daily word must never change retroactively**. A learner who
saw `dan` on Tuesday must still see `dan` on Tuesday after any rebuild, or the streak means
nothing. Section 4 is how that is guaranteed.

## 2. Data sources

| Source | Role | License |
|---|---|---|
| [kaikki.org](https://kaikki.org/dictionary/Slovene/) wiktextract Slovene extract (28 MB JSONL) | Lemma to English gloss, POS, gender, **and full inflection tables** | CC BY-SA |
| [Tatoeba](https://tatoeba.org) `slv_sentences` + `eng_sentences` + `slv-eng_links` | Example sentence pool | CC BY 2.0 FR |
| [FrequencyWords](https://github.com/hermitdave/FrequencyWords) `sl_50k.txt` (OpenSubtitles) | Frequency ranks, used to order and tier words | CC BY-SA |
| `seed/overrides.json` | Hand-written glosses for what Wiktionary lacks | ours |

**Sloleks 3.0 and sloWNet were designed in and then dropped.** The original plan used
Sloleks (a 240 MB CLARIN.SI morphological lexicon behind a click-through) purely to map
inflected forms back to lemmas. Measurement showed kaikki's own `forms[]` arrays already
carry 143,950 inflected forms across 6,429 entries, which is enough: they yield 84% token
coverage on the Tatoeba corpus. Dropping both removed a manual download, a 240 MB parse, and
an entire failure mode, at no measured cost. Do not add them back without a coverage number
that justifies it.

**The orthography gotcha that makes or breaks coverage.** Wiktionary writes Slovene citation
forms in a pronunciation-flavored spelling: the masculine l-participle ends in `ł`
(U+0142, l-with-stroke) and a schwa `ə` (U+0259) stands in for the fill vowel. So `bil` is
stored as `bȋł` and `šel` as `šə̏ł`. Fold `ł` to `l` and `ə` to `e`, strip the stress
diacritics but **keep the caron** (č/š/ž are real letters, not stress marks), and the entire
past-tense system resolves. Skip that fold and every past participle in the corpus silently
misses the dictionary. This is `defold()` in `build.py`.

## 3. Pipeline

`python3 tools/beseda/build.py`. Stdlib only. Raw downloads live in the gitignored
`tools/beseda/cache/` (`build.py --fetch` retrieves them); outputs are the committed JSON in
`views/beseda/data/`. See [tools/beseda/CLAUDE.md](../../tools/beseda/CLAUDE.md) for the
per-file detail and the re-run rules.

As built: 43,377 indexed word forms, 2,457 joined sentence pairs, of which 1,686 clear the
80% gloss-coverage bar and ship. 93.6% of the tokens in those shipped sentences carry a
gloss. 1,051 words, 14 topics, 586 daily-word candidates over a 730-day schedule, 245 KB
of JSON in total.

Two rules keep the sentence pool honest:
- A sentence ships only if at least 80% of its glossable tokens resolve. Tokens that do not
  resolve still render, just without a tooltip, so a learner never sees a broken word.
- A capitalized token in a non-initial position that is absent from the dictionary is treated
  as a proper noun (Tatoeba is full of Tom and Mary) and excluded from the coverage
  denominator rather than counted as a miss. An English speaker does not need "Mary" glossed.

## 4. The daily word cannot drift

`data/daily.json` is a precomputed schedule, not a runtime shuffle. `days[i]` is the word for
`epoch + i` days, and clients index it directly. Three invariants, enforced by `build.py`
reading its own previous output before writing:

1. **Word indices are permanent.** An existing lemma keeps its index forever; data may be
   refreshed in place; new lemmas append.
2. **Sentence indices are permanent**, same rule.
3. **Schedule positions are permanent.** Existing `days[i]` entries are copied verbatim; a
   build may only append future positions.

`epoch` is frozen at first build and asserted by `tests/beseda-data.test.mjs`. Direct
indexing is the point: a modulo over a growing list would reshuffle *today* every time the
list grew.

Clients derive the day from **local** time (`todayIso()`), never `toISOString().slice(0,10)`,
which is a day behind for the first hours of every CET morning and would corrupt streaks.
Two learners in different timezones can see different words near midnight; that is accepted,
same as Wordle.

## 5. Streak

Anyone can build a streak without an account: days are kept in `localStorage` under
`beseda-streak`. Signing in with the site's existing Google auth merges the local days up to
the server and hands back the union, so a learner who used the widget signed out keeps their
history. The server stores days and nothing else; current and longest streaks are computed
client-side in `components/beseda/logic.js`, so the page and the widget can never disagree
about the number.

Because both surfaces read the same `localStorage` key and the same computation, the iliana
widget and the main page stay in sync with no coordination.

## 6. Surfaces

- **`views/beseda`** is the product: hero word of the day with hover-glossed sentences, the
  streak strip, the topic grid, per-topic browse and quiz, and cloze practice.
- **`components/beseda/beseda-widget.js`** is a `<beseda-widget>` custom element following
  the `rocks-showcase` precedent (no shadow DOM, attribute-configured, resolves its own URLs
  via `import.meta.url` so it works from any host depth). It is embedded on
  [views/iliana](../iliana/), styled to belong to that page rather than to Beseda.

## 7. Attribution

Every generated JSON carries a `_license` field and the page carries a visible credits
footer. The sources are CC BY-SA and CC BY; the derived data is published CC BY-SA 4.0.
This is a licensing obligation, not a nicety: do not remove the footer or the `_license`
fields.

## 8. Not in v1

Audio via `speechSynthesis` (sl-SI voice availability is inconsistent and needs real
detection), a bigger sentence pool mined from ParaCrawl or OpenSubtitles, a spaced-repetition
review queue, and per-topic progress syncing to the account.
