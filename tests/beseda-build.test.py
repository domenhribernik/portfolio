#!/usr/bin/env python3
"""Unit tests for tools/beseda/build.py, the Beseda content pipeline.

The pipeline turns open data (Wiktionary via kaikki.org, Tatoeba, an
OpenSubtitles frequency list) into the static JSON the site ships. Two classes
of behavior here are load-bearing enough to pin:

  * The orthography fold. Wiktionary stores Slovene citation forms in a
    pronunciation spelling ("bIl" with l-with-stroke, "s@l" with a schwa). Fold
    it wrong and every past participle in the corpus silently loses its gloss.
  * The append-only merges. A learner's word of the day must not change
    retroactively, which holds only if word, sentence and schedule indices are
    permanent across rebuilds.

Stdlib unittest, no network and no large fixtures: every test builds its own
tiny inputs.

Run: python3 tests/beseda-build.test.py
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("beseda_build", ROOT / "tools" / "beseda" / "build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class Orthography(unittest.TestCase):
    def test_participle_spelling_folds_to_standard_orthography(self):
        # Wiktionary writes the l-participle with l-with-stroke and a schwa;
        # the corpus writes plain letters. They have to meet.
        self.assertEqual(build.defold("bȋł"), "bil")
        self.assertEqual(build.defold("prišə̏ł"), "prišel")

    def test_caron_survives_because_it_is_a_letter_not_a_stress_mark(self):
        # Stripping the caron would merge c/s/z with c/s/z and wreck the index.
        self.assertEqual(build.defold("čšž"), "čšž")
        self.assertEqual(build.defold("RēČI"), "reči")


class Tokenizing(unittest.TestCase):
    def test_spans_slice_the_original_string_back_out(self):
        # The page renders by slicing the sentence with these offsets, so a span
        # that does not round-trip is a visibly broken word on screen.
        text = "Danes je lep dan."
        spans = build.tokenize(text)
        self.assertEqual([text[s:e] for s, e, _ in spans], ["Danes", "je", "lep", "dan"])

    def test_diacritics_stay_inside_one_token(self):
        text = "Rečeš mi, da si žejen?"
        self.assertEqual([w for _, _, w in build.tokenize(text)],
                         ["Rečeš", "mi", "da", "si", "žejen"])

    def test_digits_are_not_words(self):
        self.assertEqual([w for _, _, w in build.tokenize("Imam 3 mačke")], ["Imam", "mačke"])


class GlossingASentence(unittest.TestCase):
    # A tiny stand-in dictionary: surface form -> index into the word list.
    LOOKUP = {"danes": 0, "je": 1, "lep": 2, "dan": 3}

    def gloss(self, text):
        return build.gloss_sentence(text, self.LOOKUP.get)

    def test_every_token_keeps_a_span_even_when_it_has_no_gloss(self):
        # Unresolved words still have to render, just without a tooltip, so the
        # sentence is never missing a word on screen.
        spans, coverage = self.gloss("Danes je lep xyzzy.")
        self.assertEqual([i for _, _, i in spans], [0, 1, 2, -1])
        self.assertAlmostEqual(coverage, 0.75)

    def test_a_name_mid_sentence_is_not_counted_as_a_miss(self):
        # Tatoeba is full of Tom and Mary. An English speaker does not need
        # "Mary" glossed, so it must not drag the sentence below the bar.
        spans, coverage = self.gloss("Danes je Mary lep dan.")
        self.assertEqual(coverage, 1.0)
        self.assertEqual([i for _, _, i in spans], [0, 1, -1, 2, 3])

    def test_an_unknown_first_word_still_counts_against_coverage(self):
        # Sentence-initial capitalisation says nothing about whether it is a
        # name, so it cannot buy an exemption.
        _, coverage = self.gloss("Xyzzy je lep dan.")
        self.assertAlmostEqual(coverage, 0.75)

    def test_a_sentence_of_only_names_is_not_scored_as_perfect(self):
        _, coverage = self.gloss("Tom Mary")
        self.assertEqual(coverage, 0.0)


class AppendOnlyMerge(unittest.TestCase):
    """Indices are permanent: everything downstream addresses words by position."""

    def test_an_existing_entry_keeps_its_index_when_earlier_words_appear(self):
        previous = [["dan", "day", "noun", "m", 57]]
        incoming = {"abeceda": ["abeceda", "alphabet", "noun", "f", 900],
                    "dan": ["dan", "day", "noun", "m", 57]}
        rows, index = build.merge_rows(previous, incoming)
        self.assertEqual(index["dan"], 0, "an alphabetically earlier new word must not shift dan")
        self.assertEqual(index["abeceda"], 1)

    def test_refreshed_data_lands_in_place(self):
        previous = [["dan", "day", "noun", "m", 0]]
        incoming = {"dan": ["dan", "day, daytime", "noun", "m", 57]}
        rows, index = build.merge_rows(previous, incoming)
        self.assertEqual(rows[0], ["dan", "day, daytime", "noun", "m", 57])
        self.assertEqual(len(rows), 1)

    def test_a_word_that_drops_out_of_the_sources_is_kept(self):
        # Losing a row would renumber every later index and rewrite history.
        previous = [["dan", "day", "noun", "m", 57], ["noč", "night", "noun", "f", 400]]
        rows, index = build.merge_rows(previous, {"dan": ["dan", "day", "noun", "m", 57]})
        self.assertEqual(len(rows), 2)
        self.assertEqual(index["noč"], 1)

    def test_a_word_whose_spelling_differs_from_its_key_is_not_duplicated(self):
        # Headwords keep their accented dictionary spelling ("biti" is stored
        # as "bIti") while the index is keyed on the folded form. If the merge
        # compares the wrong one, every rebuild appends the word again and
        # every index after it shifts.
        incoming = {"biti": ["bíti", "to be", "verb", 0, 1]}
        first, _ = build.merge_rows([], incoming, key_of=build.word_key)
        second, index = build.merge_rows(first, incoming, key_of=build.word_key)
        self.assertEqual(first, second)
        self.assertEqual(index["biti"], 0)

    def test_new_words_append_in_a_stable_order(self):
        rows_a, _ = build.merge_rows([], {"b": ["b"], "a": ["a"], "c": ["c"]})
        rows_b, _ = build.merge_rows([], {"c": ["c"], "a": ["a"], "b": ["b"]})
        self.assertEqual(rows_a, rows_b, "iteration order of the sources must not leak into output")


class Schedule(unittest.TestCase):
    CANDIDATES = [(i, [i * 10]) for i in range(5)]

    def test_days_already_published_are_copied_verbatim(self):
        # Tuesday's word has to still be Tuesday's word after a rebuild.
        previous = [[3, [30]], [1, [10]]]
        days = build.extend_schedule(previous, self.CANDIDATES, 6, seed=1)
        self.assertEqual(days[:2], previous)
        self.assertEqual(len(days), 6)

    def test_the_same_seed_rebuilds_the_same_future(self):
        a = build.extend_schedule([], self.CANDIDATES, 12, seed=42)
        b = build.extend_schedule([], self.CANDIDATES, 12, seed=42)
        self.assertEqual(a, b)

    def test_a_shorter_target_never_truncates_published_days(self):
        previous = [[0, [0]], [1, [10]], [2, [20]]]
        days = build.extend_schedule(previous, self.CANDIDATES, 1, seed=1)
        self.assertEqual(days, previous)

    def test_every_word_is_used_before_any_repeats(self):
        days = build.extend_schedule([], self.CANDIDATES, 5, seed=7)
        self.assertEqual(sorted(d[0] for d in days), [0, 1, 2, 3, 4])

    def test_a_scheduled_day_always_carries_a_sentence(self):
        days = build.extend_schedule([], self.CANDIDATES, 12, seed=3)
        self.assertTrue(all(d[1] for d in days))


class SentenceQuality(unittest.TestCase):
    def test_quoted_speech_is_fine(self):
        self.assertTrue(build.is_usable_sentence('"Kaj?" je rekel Tom.'))
        self.assertTrue(build.is_usable_sentence("Danes je lep dan."))

    def test_a_dangling_quote_means_a_truncated_sentence(self):
        self.assertFalse(build.is_usable_sentence('"Ptica je imela zlomljen krilo.'))

    def test_a_sentence_too_long_to_read_at_a_glance_is_skipped(self):
        self.assertFalse(build.is_usable_sentence("a" * (build.MAX_SENTENCE_CHARS + 1)))


class LookupPrecedence(unittest.TestCase):
    """Which meaning wins when one spelling is several words.

    Slovene is full of collisions: "krilo" is a skirt, and also a cell in the
    conjugation table of "kriti" (to cover). Getting this order wrong shows
    learners confidently wrong translations.
    """

    @staticmethod
    def lexicon(entries):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lex.jsonl"
            path.write_text("\n".join(json.dumps(e) for e in entries), encoding="utf-8")
            return build.load_lexicon(path)

    def test_a_word_in_its_own_right_beats_another_words_inflection(self):
        krilo = {"word": "krilo", "pos": "noun", "senses": [{"glosses": ["skirt, wing"]}]}
        kriti = {"word": "kriti", "pos": "verb", "senses": [{"glosses": ["to cover"]}],
                 "forms": [{"form": "krilo", "tags": ["participle"]}]}
        for order in ([krilo, kriti], [kriti, krilo]):
            _, forms = self.lexicon(order)
            self.assertEqual(forms["krilo"], "krilo",
                             "a headword must win regardless of file order")

    def test_a_dedicated_inflection_entry_beats_a_paradigm_cell(self):
        # "je" is the copula in nearly every sentence that contains it, and
        # Wiktionary says so with its own entry. A pronoun's declension cell
        # claiming the same spelling must not outrank that.
        biti = {"word": "biti", "pos": "verb", "senses": [{"glosses": ["to be"]}]}
        je = {"word": "je", "pos": "verb", "senses": [
            {"tags": ["form-of"], "form_of": [{"word": "biti"}],
             "glosses": ["third-person singular present of biti"]}]}
        ona = {"word": "ona", "pos": "pron", "senses": [{"glosses": ["she"]}],
               "forms": [{"form": "je", "tags": ["accusative"]}]}
        _, forms = self.lexicon([ona, je, biti])
        self.assertEqual(forms["je"], "biti")


class Output(unittest.TestCase):
    def test_rebuilding_unchanged_data_produces_an_identical_file(self):
        # A build that rewrites bytes on every run makes the git history
        # useless for spotting when the content actually moved.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "words.json"
            payload = {"version": 1, "words": [["dan", "day"]]}
            build.write_json(path, payload)
            first = path.read_bytes()
            build.write_json(path, payload)
            self.assertEqual(first, path.read_bytes())

    def test_slovene_letters_are_written_as_letters(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "words.json"
            build.write_json(path, {"words": [["noč", "night"]]})
            self.assertIn("noč", path.read_text(encoding="utf-8"))


class ReadingADictionaryEntry(unittest.TestCase):
    @staticmethod
    def entry(**over):
        base = {"word": "dan", "pos": "noun",
                "forms": [{"form": "dȃn", "tags": ["canonical", "inanimate", "masculine"]}],
                "senses": [{"glosses": ["day"]}]}
        base.update(over)
        return base

    def test_a_noun_yields_its_lemma_gloss_part_of_speech_and_gender(self):
        key, row = build.entry_to_word(self.entry())
        self.assertEqual(key, "dan")
        self.assertEqual(row, ["dan", "day", "noun", "m", 0])

    def test_the_first_two_senses_become_the_gloss(self):
        # One sense is often too thin to disambiguate, four is a wall of text.
        _, row = build.entry_to_word(self.entry(
            senses=[{"glosses": ["day"]}, {"glosses": ["daytime"]}, {"glosses": ["era"]}]))
        self.assertEqual(row[1], "day, daytime")

    def test_an_entry_with_no_gloss_is_useless_to_a_learner(self):
        self.assertIsNone(build.entry_to_word(self.entry(senses=[{"tags": ["obsolete"]}])))

    def test_punctuation_and_letters_are_not_vocabulary(self):
        self.assertIsNone(build.entry_to_word(self.entry(pos="character")))
        self.assertIsNone(build.entry_to_word(self.entry(pos="symbol")))

    def test_an_inflected_form_is_not_a_headword(self):
        # Wiktionary gives "je" its own entry glossed "third-person singular
        # present of biti". Shown to a learner that is noise; it has to resolve
        # to the parent verb's actual meaning instead.
        inflected = self.entry(word="je", senses=[{
            "tags": ["form-of", "present", "singular", "third-person"],
            "form_of": [{"word": "bíti"}],
            "glosses": ["third-person singular present of bíti"]}])
        self.assertIsNone(build.entry_to_word(inflected))
        self.assertEqual(build.form_parent(inflected), "biti")

    def test_a_word_that_is_both_a_form_and_a_word_keeps_its_own_meaning(self):
        # "sem" is both "hither" and "I am"; the real sense must survive.
        both = self.entry(word="sem", pos="adv", senses=[
            {"glosses": ["hither, over here"]},
            {"tags": ["form-of"], "form_of": [{"word": "bíti"}],
             "glosses": ["first-person singular present of bíti"]}])
        _, row = build.entry_to_word(both)
        self.assertEqual(row[1], "hither, over here")

    def test_an_ordinary_word_has_no_parent(self):
        self.assertIsNone(build.form_parent(self.entry()))

    def test_glosses_about_the_letter_rather_than_the_word_are_dropped(self):
        # Wiktionary has several entries per spelling. For "a" one of them is
        # the noun "The name of the Latin script letter A/a", which would
        # otherwise beat the conjunction "but" that a learner actually needs.
        self.assertIsNone(build.entry_to_word(self.entry(
            word="a", pos="noun",
            senses=[{"glosses": ["The name of the Latin script letter A/a."]}])))
        self.assertIsNone(build.entry_to_word(self.entry(
            word="a", pos="noun",
            senses=[{"glosses": ["The first letter of the Slovene alphabet."]}])))
        _, row = build.entry_to_word(self.entry(word="a", pos="conj",
                                                senses=[{"glosses": ["but"]}]))
        self.assertEqual(row[1], "but")


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[sys.argv[0]])
