# tools/beseda

Builds the static content for [views/beseda](../../views/beseda/): the word-of-the-day
schedule, the sentence pool with its per-token glosses, and the topic vocabulary. Developer
tooling, run by hand like `tools/seo`. Stdlib-only Python 3, no dependencies.

```bash
python3 tools/beseda/build.py --fetch   # download sources into cache/ (first run only)
python3 tools/beseda/build.py           # rebuild views/beseda/data/*.json
python3 tests/beseda-build.test.py      # unit tests
```

`cache/` is gitignored and holds ~60 MB of raw datasets. `seed/` is hand-edited and
committed. Everything in `views/beseda/data/` is generated: never hand-edit it, rebuild.

## The three invariants

The whole feature rests on these. `build.py` enforces them by reading its own previous
output before writing, and `tests/beseda-data.test.mjs` fails CI if one is broken.

1. **Word indices are permanent.** Sentence spans, topic lists and the daily schedule all
   address words by position.
2. **Sentence indices are permanent**, for the same reason.
3. **Schedule positions are permanent.** `daily.json` `days[i]` is the word for `epoch + i`,
   indexed directly by the client. A build may only append.

So a rebuild refreshes rows in place, keeps rows whose source disappeared, and appends new
ones in sorted order. **`EPOCH` is frozen**; changing it re-dates every published word.

A rebuild with unchanged sources must produce byte-identical files. Verify with:

```bash
md5sum views/beseda/data/*.json > /tmp/b.md5 && python3 tools/beseda/build.py && md5sum -c /tmp/b.md5
```

## Sources

| `cache/` file | Source | License |
|---|---|---|
| `kaikki-Slovene.jsonl` | [kaikki.org](https://kaikki.org/dictionary/Slovene/) wiktextract extract of the English Wiktionary, 28 MB | CC BY-SA 4.0 |
| `sl_50k.txt` | [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) over OpenSubtitles | CC BY-SA 4.0 |
| `slv_sentences.tsv`, `eng_sentences.tsv`, `slv-eng_links.tsv` | [Tatoeba](https://downloads.tatoeba.org/exports/per_language/) per-language exports | CC BY 2.0 FR |

All share-alike. Every generated file carries a `_license` string and the page carries a
credits footer; both are an obligation, not decoration.

**Sloleks and sloWNet were evaluated and rejected.** Sloleks 3.0 was in the original design
purely to map inflected forms to lemmas, at the cost of a 240 MB CLARIN.SI download behind a
click-through. kaikki's own `forms[]` arrays already carry ~144k inflected forms, which give
84% token coverage on the corpus. Do not add either back without a coverage number showing
it helps.

## Gotchas

**The orthography fold is load-bearing.** Wiktionary writes Slovene citation forms in a
pronunciation spelling: the masculine l-participle ends in `ł` (U+0142) and a schwa `ə`
(U+0259) stands in for the fill vowel, so `bil` is stored as `bȋł` and `šel` as `šə̏ł`.
`defold()` folds those to plain letters, strips stress diacritics, and **keeps the caron**,
because č/š/ž are letters rather than accented c/s/z. Break this and every past participle in
the corpus silently loses its gloss.

**Lookup precedence is not file order.** One spelling is often several words: `krilo` is a
skirt and also a cell in the conjugation of `kriti` (to cover). Resolution order is
headword, then a spelling Wiktionary gave its own "form of X" entry, then a generated
paradigm cell. Getting this wrong produces confidently wrong translations, which is worse
than a missing one.

**Inflected entries resolve to their parent's meaning.** Wiktionary glosses `je` as
"third-person singular present of bíti", which teaches nobody anything, so `form_parent()`
points it at `biti` and the learner sees "to be".

**Coverage excludes proper nouns.** Tatoeba is mostly Tom and Mary. A capitalised token away
from the sentence start that the dictionary does not know is treated as a name and left out
of the coverage denominator rather than counted as a miss.

## seed/

`topics.json` is the curated topic vocabulary, themed after the Slovene Learning Online 1
syllabus. It is the one place with human judgement in it. Every lemma must resolve or the
build fails and names the offender.

`overrides.json` is hand-written glosses for what the English Wiktionary's Slovene section
lacks, mostly very common function words (`kar`, `naj`, `res`, `treba`) whose absence drags
sentence coverage down badly. Fix a missing or wrong topic word here rather than deleting it
from `topics.json`. Keep the file small: it is the escape hatch, not a dictionary.

## Current output

1,051 words, 1,686 sentences (93.6% of their tokens glossed), 14 topics, 586 daily-word
candidates over a 730-day schedule, 245 KB total. `words.json` holds only the words actually
referenced by a sentence, topic or scheduled day, not the whole 5,700-lemma lexicon.
