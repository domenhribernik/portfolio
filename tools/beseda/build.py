#!/usr/bin/env python3
"""Build the static content Beseda ships (views/beseda/data/*.json).

Developer tooling, run by hand like tools/seo/generate.js. Stdlib only, no
network at build time except the explicit --fetch step. Sources and re-run
rules are documented in tools/beseda/CLAUDE.md; the product rationale is in
views/beseda/PLAN.md.

Run: python3 tools/beseda/build.py
"""

import argparse
import json
import random
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).resolve().parent / "cache"
SEED = Path(__file__).resolve().parent / "seed"
OUT = ROOT / "views" / "beseda" / "data"

# Frozen at the first build. Moving it would re-date every published word.
EPOCH = "2026-08-01"
SCHEDULE_SEED = 20260801
SCHEDULE_DAYS = 730

# A sentence ships only if this share of its glossable tokens resolved.
MIN_COVERAGE = 0.8
MAX_SENTENCE_CHARS = 120

# Only content words earn a day of their own. A whitelist rather than a
# blocklist because it also excludes Wiktionary's "name" entries, which for
# Slovene are mostly toponyms and given names.
DAILY_POS = {"noun", "verb", "adj", "adv"}
DAILY_MAX_RANK = 12000

SOURCES = {
    "kaikki-Slovene.jsonl": "https://kaikki.org/dictionary/Slovene/kaikki.org-dictionary-Slovene.jsonl",
    "sl_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/sl/sl_50k.txt",
    "slv_sentences.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/slv/slv_sentences.tsv.bz2",
    "eng_sentences.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2",
    "slv-eng_links.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/slv/slv-eng_links.tsv.bz2",
}

LICENSE = (
    "Glosses and inflections from the English Wiktionary via wiktextract/kaikki.org "
    "(CC BY-SA 4.0). Sentences from Tatoeba (CC BY 2.0 FR). Frequency ranks from "
    "hermitdave/FrequencyWords over OpenSubtitles (CC BY-SA 4.0). "
    "Derived data published under CC BY-SA 4.0."
)

# Wiktionary writes Slovene citation forms in a pronunciation-flavored
# orthography: the masculine l-participle ends in l-with-stroke (bil is stored
# as "bIl") and a schwa stands in for the fill vowel (sel as "s@l"). Folding
# these to plain letters is what lets the corpus's past tense find the
# dictionary at all.
FOLD = {"ł": "l", "ə": "e"}

# Caron is a letter in Slovene (c, s, z), not a stress mark, so it survives the
# strip that removes acutes, graves, circumflexes and the dots.
CARON = "̌"


def defold(text):
    """Normalize a Slovene word to the plain lowercase spelling used for indexing."""
    decomposed = unicodedata.normalize("NFD", text)
    kept = "".join(
        FOLD.get(ch, ch)
        for ch in decomposed
        if not unicodedata.combining(ch) or ch == CARON
    )
    return unicodedata.normalize("NFC", kept).lower()


# Letters only, so digits and punctuation never become lookup keys. Unicode-aware
# so the caron letters stay inside their token.
TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def tokenize(text):
    """Split into (start, end, surface) spans that slice `text` back out exactly."""
    return [(m.start(), m.end(), m.group()) for m in TOKEN_RE.finditer(text)]


def word_key(row):
    """Identity of a word row: the folded lemma, matching the lexicon's keys.

    A headword keeps its accented dictionary spelling for display, so its own
    first column is not the key it was filed under.
    """
    return defold(row[0])


def merge_rows(previous, incoming, key_of=lambda row: row[0]):
    """Merge a rebuild into the committed rows without ever moving an index.

    Everything downstream (sentence spans, topic lists, the daily schedule)
    addresses words and sentences by position, so a position that changes
    meaning rewrites a learner's history. Existing rows are therefore refreshed
    in place, rows that vanished from the sources are kept, and genuinely new
    rows append in sorted order so the output does not depend on how the
    sources happened to iterate.
    """
    rows = [list(row) for row in previous]
    index = {key_of(row): i for i, row in enumerate(rows)}
    for key in sorted(incoming):
        row = list(incoming[key])
        if key in index:
            rows[index[key]] = row
        else:
            index[key] = len(rows)
            rows.append(row)
    return rows, index


# Letters, punctuation marks and the like have Wiktionary entries but are not
# words anyone learns.
NOT_VOCABULARY = {"character", "symbol", "punct"}
GENDERS = {"masculine": "m", "feminine": "f", "neuter": "n"}
MAX_SENSES = 2

# Glosses that describe the glyph instead of the word. Several spellings carry
# both ("a" is the letter, the interjection "oh" and the conjunction "but"), and
# without this the alphabet entry wins and teaches nothing.
METALINGUISTIC = (
    "name of the latin script letter",
    "letter of the slovene alphabet",
    "name of the phoneme",
    "phonetic transcription of",
)


def entry_to_word(entry):
    """Turn one kaikki.org entry into (key, row), or None if it teaches nothing.

    row is [lemma, gloss, pos, gender, frequency rank], with rank filled in
    later from the frequency list and 0 when the word is not on it.
    """
    lemma = entry.get("word")
    pos = entry.get("pos")
    if not lemma or pos in NOT_VOCABULARY:
        return None

    glosses = []
    for sense in entry.get("senses", []):
        # "third-person singular present of bIti" teaches nobody anything;
        # form_parent() sends these to the headword's real meaning instead.
        if "form-of" in (sense.get("tags") or []):
            continue
        for gloss in sense.get("glosses") or []:
            lowered = gloss.lower()
            if any(marker in lowered for marker in METALINGUISTIC):
                continue
            if gloss not in glosses:
                glosses.append(gloss)
    if not glosses:
        return None

    gender = 0
    for form in entry.get("forms", []):
        tags = form.get("tags", [])
        if "canonical" in tags:
            gender = next((GENDERS[t] for t in tags if t in GENDERS), 0)
            break

    return defold(lemma), [lemma, ", ".join(glosses[:MAX_SENSES]), pos, gender, 0]


def is_usable_sentence(text):
    """Whether a corpus sentence is worth showing a learner.

    An odd number of double quotes means the export caught half of a quoted
    passage, which reads as a typo on the page.
    """
    return len(text) <= MAX_SENTENCE_CHARS and text.count('"') % 2 == 0


def form_parent(entry):
    """The headword an inflected-form entry belongs to, or None.

    Wiktionary gives common inflections their own entries ("je" is glossed as
    "third-person singular present of biti"). Pointing them at the parent is
    what lets a hover on "je" say "to be".
    """
    for sense in entry.get("senses", []):
        if "form-of" in (sense.get("tags") or []):
            for parent in sense.get("form_of") or []:
                word = parent.get("word")
                if word:
                    return defold(word)
    return None


def write_json(path, payload):
    """Write a data file that only changes when its content does.

    No timestamps and no dict-order surprises, so `git diff` after a rebuild
    shows the words that actually moved instead of the whole file.
    """
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    Path(path).write_text(text + "\n", encoding="utf-8")


def build_all(cache=CACHE, seed_dir=SEED, out=OUT):
    """Run every stage and write the four data files. Returns a report dict."""
    words, forms = load_lexicon(cache / "kaikki-Slovene.jsonl")
    overrides = read_json(seed_dir / "overrides.json", {}).get("words", {})
    words, forms = apply_overrides(words, forms, overrides)

    ranks = load_frequency(cache / "sl_50k.txt")
    for key, row in words.items():
        row[4] = ranks.get(key, 0)

    # Pass one resolves tokens to lemma keys, because the numeric indices those
    # spans must carry are only known after the merge below.
    kept = []
    for slovene, english in load_pairs(cache):
        if not is_usable_sentence(slovene):
            continue
        spans, coverage = gloss_sentence(slovene, forms.get)
        if coverage >= MIN_COVERAGE:
            kept.append((slovene, english, spans))

    topic_seed = read_json(seed_dir / "topics.json", {"topics": []})["topics"]
    used = {key for _, _, spans in kept for _, _, key in spans if key != -1}
    missing_topic_words = []
    for topic in topic_seed:
        for lemma in topic["lemmas"]:
            key = defold(lemma)
            if key in words:
                used.add(key)
            else:
                missing_topic_words.append((topic["id"], lemma))
    if missing_topic_words:
        listing = "\n".join(f"  {topic}: {lemma}" for topic, lemma in missing_topic_words)
        raise SystemExit(
            "These seeded topic words are not in the dictionary. Add a gloss to "
            f"seed/overrides.json or drop them from seed/topics.json:\n{listing}"
        )

    previous_words = read_json(out / "words.json", {"words": []})["words"]
    word_rows, word_index = merge_rows(
        previous_words, {k: words[k] for k in sorted(used)}, key_of=word_key)

    # Pass two: swap lemma keys for their permanent indices.
    incoming_sentences = {}
    for slovene, english, spans in kept:
        numbered = [[s, e, word_index.get(k, -1) if k != -1 else -1] for s, e, k in spans]
        incoming_sentences[slovene] = [slovene, english, numbered]
    previous_sentences = read_json(out / "sentences.json", {"sentences": []})["sentences"]
    sentence_rows, sentence_index = merge_rows(previous_sentences, incoming_sentences)

    # Which sentences can illustrate each word.
    examples = {}
    for position, row in enumerate(sentence_rows):
        for _, _, index in row[2]:
            if index != -1:
                examples.setdefault(index, []).append(position)

    topics = []
    for topic in topic_seed:
        indices = [word_index[defold(lemma)] for lemma in topic["lemmas"]]
        topics.append({
            "id": topic["id"],
            "title": topic["title"],
            "icon": topic["icon"],
            "words": indices,
            "sentences": sorted({s for i in indices for s in examples.get(i, [])})[:12],
        })

    # A word only earns a day if it has a real example to show and is common
    # enough to be worth a learner's minute.
    candidates = []
    for index, row in enumerate(word_rows):
        rank = row[4]
        if row[2] not in DAILY_POS or not rank or rank > DAILY_MAX_RANK:
            continue
        if index in examples:
            candidates.append((rank, index, examples[index][:3]))
    candidates.sort()
    ordered = [(index, sentences) for _, index, sentences in candidates]

    previous_days = read_json(out / "daily.json", {"days": []})["days"]
    days = extend_schedule(previous_days, ordered, SCHEDULE_DAYS, SCHEDULE_SEED)

    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "words.json", {
        "_license": LICENSE,
        "_fields": ["lemma", "english", "part of speech", "gender (0 if none)", "frequency rank (0 if unranked)"],
        "version": 1,
        "words": word_rows,
    })
    write_json(out / "sentences.json", {
        "_license": LICENSE,
        "_fields": {"sentence": ["slovene", "english", "spans"],
                    "span": ["start", "end", "word index (-1 if unglossed)"]},
        "version": 1,
        "sentences": sentence_rows,
    })
    write_json(out / "topics.json", {
        "_license": LICENSE,
        "version": 1,
        "topics": topics,
    })
    write_json(out / "daily.json", {
        "_license": LICENSE,
        "_fields": {"day": ["word index", "sentence indices"]},
        "epoch": EPOCH,
        "version": 1,
        "days": days,
    })

    return {
        "lexicon": len(words),
        "forms": len(forms),
        "words": len(word_rows),
        "sentences": len(sentence_rows),
        "topics": len(topics),
        "candidates": len(ordered),
        "days": len(days),
    }


def fetch_sources(cache=CACHE):
    """Download the raw datasets. Separate from the build so builds stay offline."""
    import bz2
    import urllib.request

    cache.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        target = cache / name
        if not target.exists():
            print(f"fetching {name} ...")
            urllib.request.urlretrieve(url, target)
        if name.endswith(".bz2"):
            plain = cache / name[: -len(".bz2")]
            if not plain.exists():
                plain.write_bytes(bz2.decompress(target.read_bytes()))
    print("sources ready in", cache)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the Beseda content files.")
    parser.add_argument("--fetch", action="store_true", help="download the raw datasets first")
    args = parser.parse_args(argv)

    if args.fetch:
        fetch_sources()

    missing = [n for n in SOURCES if not (CACHE / n.replace(".bz2", "")).exists()]
    if missing:
        print("missing sources:", ", ".join(missing), file=sys.stderr)
        print("run: python3 tools/beseda/build.py --fetch", file=sys.stderr)
        return 1

    report = build_all()
    print("\n".join(f"{k:>12}: {v}" for k, v in report.items()))
    print(f"\nwrote {OUT}")
    return 0


def read_json(path, default):
    """Load a previously committed output, or `default` on the first build."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def load_lexicon(path):
    """Read the kaikki extract into (words by key, inflected form -> lemma key).

    The forms index is why Sloleks is not needed: Wiktionary already ships the
    declension and conjugation tables, ~144k form rows, which is what maps a
    word in a sentence back to a dictionary entry.
    """
    words = {}
    explicit = {}   # spellings Wiktionary gave their own "form of X" entry
    paradigm = {}   # spellings that only appear as a cell in some inflection table
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            entry = json.loads(line)
            result = entry_to_word(entry)
            if result is None:
                parent = form_parent(entry)
                if parent and entry.get("word"):
                    explicit.setdefault(defold(entry["word"]), parent)
                continue
            key, row = result
            words.setdefault(key, row)
            for form in entry.get("forms", []):
                tags = form.get("tags", [])
                if "table-tags" in tags or "inflection-template" in tags:
                    continue
                value = form.get("form", "")
                # "-" marks a gap in a paradigm table; multiword forms are
                # phrases, not something a single token can hit.
                if not value or value in {"-", "—"} or " " in value:
                    continue
                paradigm.setdefault(defold(value), key)

    # Slovene spellings collide constantly, so resolve by how good the evidence
    # is rather than by which line came first in the file. A word in its own
    # right outranks an inflection of something else, and an inflection
    # Wiktionary bothered to write an entry for outranks a generated table cell.
    forms = {key: key for key in words}
    for source in (explicit, paradigm):
        for form, parent in source.items():
            if parent in words:
                forms.setdefault(form, parent)
    return words, forms


def load_frequency(path):
    """Read the OpenSubtitles list into {form: rank}, rank 1 being commonest."""
    ranks = {}
    with open(path, encoding="utf-8") as handle:
        for position, line in enumerate(handle, start=1):
            word = line.split(" ")[0].strip()
            if word:
                ranks.setdefault(defold(word), position)
    return ranks


def load_pairs(cache):
    """Join the Tatoeba exports into (slovene, english) pairs, one per sentence."""
    def read_sentences(name):
        text = {}
        with open(cache / name, encoding="utf-8") as handle:
            for line in handle:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 3:
                    text[parts[0]] = parts[2]
        return text

    slovene = read_sentences("slv_sentences.tsv")
    english = read_sentences("eng_sentences.tsv")
    pairs = []
    seen = set()
    with open(cache / "slv-eng_links.tsv", encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            source, target = parts[0], parts[1]
            if source in seen or source not in slovene or target not in english:
                continue
            seen.add(source)
            pairs.append((slovene[source], english[target]))
    # Sorted so the sentence order does not depend on the export's row order.
    return sorted(pairs)


def apply_overrides(words, forms, overrides):
    """Fold hand-written entries in, for what Wiktionary's Slovene is missing.

    Mostly function words (kar, naj, res, treba) which are both very common in
    the corpus and poorly covered upstream, so a handful of lines here lifts a
    lot of sentences over the coverage bar.
    """
    for lemma, spec in overrides.items():
        key = defold(lemma)
        words[key] = [lemma, spec["en"], spec.get("pos", "other"), spec.get("gender", 0), 0]
        forms[key] = key
        for form in spec.get("forms", []):
            forms[defold(form)] = key
    return words, forms


def extend_schedule(previous, candidates, length, seed):
    """Grow the word-of-the-day schedule without touching any published day.

    days[i] is the word for epoch + i, indexed directly by the client, so this
    may only ever append. Candidates are dealt out in reshuffled passes, which
    uses the whole pool before anything repeats and keeps the order
    reproducible from `seed` alone.
    """
    days = [list(day) for day in previous]
    if not candidates:
        return days
    rng = random.Random(seed)
    pool = []
    while len(days) < length:
        if not pool:
            pool = list(candidates)
            rng.shuffle(pool)
        word_index, sentence_indices = pool.pop()
        days.append([word_index, list(sentence_indices)])
    return days


def gloss_sentence(text, lookup):
    """Resolve every token against the lexicon.

    Returns (spans, coverage) where spans is [(start, end, word_index)] with -1
    for anything unresolved, and coverage is the share of *glossable* tokens
    that resolved. A capitalised token away from the sentence start that the
    dictionary does not know is read as a proper noun and left out of the
    denominator: Tatoeba is largely Tom and Mary, and an English speaker does
    not need those glossed.
    """
    spans = []
    resolved = 0
    glossable = 0
    for start, end, surface in tokenize(text):
        index = lookup(defold(surface))
        if index is None:
            spans.append((start, end, -1))
            is_name = start > 0 and surface[:1].isupper()
            if not is_name:
                glossable += 1
        else:
            spans.append((start, end, index))
            glossable += 1
            resolved += 1
    coverage = resolved / glossable if glossable else 0.0
    return spans, coverage


if __name__ == "__main__":
    raise SystemExit(main())
