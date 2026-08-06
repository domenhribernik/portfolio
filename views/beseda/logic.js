/**
 * DOM-free drill logic for the Beseda page: multiple-choice questions and
 * cloze gaps built from the committed vocabulary.
 *
 * Kept out of script.js so node can test it (tests/beseda-quiz.test.mjs). The
 * random source is injected everywhere so a question set is reproducible.
 *
 * The rule the whole file exists to hold: a question must have exactly one
 * defensible answer. Slovene vocabulary has plenty of near-synonyms, and
 * offering two options that both mean "dog" teaches a learner to distrust
 * something they knew.
 */

const OPTIONS_PER_QUESTION = 4;

/** Fisher-Yates against an injected random source. */
function shuffled(items, rng) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Wrong answers for `answer`: `count` word indices that are neither the answer
 * nor a synonym of it nor of each other.
 *
 * Preference is for words from the same topic, because "cat / horse / cow"
 * tests the word while "cat / bureaucracy / Thursday" tests nothing. When the
 * topic cannot fill the slots, the rest of the vocabulary is drawn on rather
 * than shipping a two-option question.
 */
export function pickDistractors(answer, pool, words, count, rng) {
    const taken = new Set([words[answer][1]]);
    const chosen = [];

    const consider = (index) => {
        if (chosen.length >= count || index === answer) return;
        const gloss = words[index][1];
        if (!gloss || taken.has(gloss)) return;
        taken.add(gloss);
        chosen.push(index);
    };

    shuffled(pool, rng).forEach(consider);
    if (chosen.length < count) {
        shuffled(words.map((_, i) => i), rng).forEach(consider);
    }
    return chosen;
}

/**
 * A quiz over `topicWords`: up to `count` questions, each asking one word in
 * one direction, no word repeated.
 */
export function buildQuiz(topicWords, words, count, rng) {
    const askable = topicWords.filter((i) => words[i] && words[i][1]);
    return shuffled(askable, rng).slice(0, count).map((answer, position) => {
        const distractors = pickDistractors(answer, topicWords, words, OPTIONS_PER_QUESTION - 1, rng);
        // Alternating rather than random keeps both directions present in even
        // a three-question daily drill.
        const direction = position % 2 === 0 ? 'slToEn' : 'enToSl';
        return {
            direction,
            answer,
            prompt: direction === 'slToEn' ? words[answer][0] : words[answer][1],
            options: shuffled([answer, ...distractors], rng),
        };
    });
}

/**
 * Turn a sentence into a fill-the-gap question, or null if none of its words
 * are known well enough to blank one out.
 */
export function buildCloze(sentence, pool, words, rng) {
    const [text, english, spans = []] = sentence;
    const glossed = spans.filter(([, , index]) => index !== -1 && words[index] && words[index][1]);
    if (!glossed.length) return null;

    const target = glossed[Math.floor(rng() * glossed.length)];
    const answer = target[2];
    const segments = [];
    let cursor = 0;
    for (const [start, end, index] of spans) {
        if (start > cursor) segments.push({ text: text.slice(cursor, start), blank: false });
        segments.push(
            index === answer && start === target[0]
                ? { text: text.slice(start, end), blank: true }
                : { text: text.slice(start, end), blank: false },
        );
        cursor = end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), blank: false });

    return {
        segments,
        english,
        answer,
        options: shuffled(
            [answer, ...pickDistractors(answer, pool, words, OPTIONS_PER_QUESTION - 1, rng)],
            rng,
        ),
    };
}
