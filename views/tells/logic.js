//? DOM-free logic for the Tells field guide (views/tells). Everything here is
//? pure and tested by tests/tells-logic.test.mjs; script.js only wires these
//? functions to the DOM and to localStorage.

export const SITES = ['argument', 'judgment'];
export const INTENTS = ['accident', 'deliberate', 'both'];

//? Families are the finer grouping inside a quadrant, and the label printed on
//? the plate. `heuristic` is deliberately not a quadrant: heuristics sit one
//? level above biases, so they hang off entries as `parent` instead.
export const FAMILIES = [
    'fallacy', 'bias', 'heuristic', 'rhetoric',
    'tactic', 'statistical', 'dark-pattern', 'manipulation',
];

//? The everyday settings an example can be staged in. An entry must span at
//? least two of them, which is the transfer requirement from the debiasing
//? literature written down as something a test can fail on: examples drawn
//? from one setting teach that setting, not the technique.
export const SCENES = [
    'standup', 'code-review', 'negotiation', 'ad', 'checkout',
    'politics', 'news', 'family', 'science',
];

/** The longest a gist can be and still read as one line on the grid. */
const GIST_MAX = 140;

//? Enough examples that a review can show an unseen one several times over,
//? spread over enough settings that what sticks is the technique.
const MIN_EXAMPLES = 3;
const MIN_SCENES = 2;

/** Every human-readable string on an entry, as [label, text] pairs. */
function prose(item) {
    const pairs = [];
    for (const field of ['name', 'gist', 'how', 'tell', 'play']) {
        if (typeof item[field] === 'string') pairs.push([field, item[field]]);
    }
    for (const [i, line] of (item.counter || []).entries()) {
        if (typeof line === 'string') pairs.push([`counter[${i}]`, line]);
    }
    for (const [i, ex] of (item.examples || []).entries()) {
        if (typeof ex?.text === 'string') pairs.push([`examples[${i}]`, ex.text]);
    }
    for (const [i, near] of (item.confusedWith || []).entries()) {
        for (const field of ['because', 'tell']) {
            if (typeof near?.[field] === 'string') pairs.push([`confusedWith[${i}].${field}`, near[field]]);
        }
    }
    return pairs;
}

//? The grid is the whole argument of this guide: a defect lives either in the
//? argument (on the page, checkable by any reader) or in the judgment (in a
//? head, invisible in the text), and it got there either by accident or on
//? purpose. Four cells, and a seam for the entries that honestly straddle.
export const QUADRANTS = {
    fallacy: {
        label: 'Fallacy',
        site: 'argument', intent: 'accident',
        blurb: 'A defect in the argument itself, made honestly. Point at it and anyone can check.',
    },
    rhetoric: {
        label: 'Rhetoric',
        site: 'argument', intent: 'deliberate',
        blurb: 'The same defects, selected because they work on an audience.',
    },
    bias: {
        label: 'Bias',
        site: 'judgment', intent: 'accident',
        blurb: 'A systematic tilt in your own judgment, running below awareness.',
    },
    exploit: {
        label: 'Exploit',
        site: 'judgment', intent: 'deliberate',
        blurb: 'Someone triggering that tilt on purpose. The bias is the vulnerability; this is the exploit.',
    },
    'seam-argument': {
        label: 'On the seam',
        site: 'argument', intent: 'both',
        blurb: 'Defects in an argument that look the same whether or not anyone meant them.',
    },
    'seam-judgment': {
        label: 'On the seam',
        site: 'judgment', intent: 'both',
        blurb: 'Distortions that arrive by accident as readily as by design.',
    },
};

/** Which cell of the grid an entry belongs in. */
export function quadrantOf(item) {
    const { site, intent } = item.axis || {};
    if (intent === 'both') return `seam-${site}`;
    if (site === 'argument') return intent === 'deliberate' ? 'rhetoric' : 'fallacy';
    return intent === 'deliberate' ? 'exploit' : 'bias';
}

/**
 * Resolve a validated catalog into everything the page renders from:
 * `{ entries, byId, byQuadrant, byFamily, counts, total }`.
 *
 * Pointers are resolved here rather than at render time. An entry arrives at
 * script.js with `twin`, `parentEntry`, `children` and `near` already holding
 * objects, so a plate cannot half-render because an id went stale. Run
 * validateCatalog() first: this assumes the pointers resolve and quietly
 * yields null for any that do not.
 */
export function indexCatalog(doc) {
    const entries = (doc.entries || []).map((item) => ({ ...item, quadrant: quadrantOf(item) }));
    const byId = new Map(entries.map((e) => [e.id, e]));

    const byQuadrant = {};
    for (const key of Object.keys(QUADRANTS)) byQuadrant[key] = [];
    const byFamily = {};
    for (const key of FAMILIES) byFamily[key] = [];

    for (const item of entries) {
        item.twin = item.exploitOf ? byId.get(item.exploitOf) || null : null;
        item.parentEntry = item.parent ? byId.get(item.parent) || null : null;
        item.children = [];
        item.near = (item.confusedWith || [])
            .map((n) => ({ ...n, entry: byId.get(n.id) || null }))
            .filter((n) => n.entry);

        byQuadrant[item.quadrant]?.push(item);
        byFamily[item.family]?.push(item);
    }

    // A second pass, because a child can be listed before its parent.
    for (const item of entries) item.parentEntry?.children.push(item);

    const counts = {};
    for (const [key, list] of Object.entries(byQuadrant)) counts[key] = list.length;

    return { entries, byId, byQuadrant, byFamily, counts, total: entries.length };
}

/**
 * Fold a string down to what a search should compare: lowercase, unaccented,
 * and with anything that is not a letter or digit collapsed to one space.
 *
 * Hyphens go the same way as accents, so "cherry picking" finds
 * "Cherry-picking". Names in this guide are a mix of hyphenated, spaced and
 * possessive, and nobody remembers which is which.
 */
function fold(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

//? What a hit in each field is worth. A name beats an alias beats the prose,
//? so typing a name you already know never buries it under entries that merely
//? mention it.
const FIELD_WEIGHT = { name: 100, aka: 60, gist: 20, tell: 10 };

/**
 * Entries matching `query`, best first. An empty query is the whole guide in
 * plate order, which is what the index page wants before anyone types.
 */
export function searchEntries(index, query) {
    const needle = fold(query);
    if (!needle) return [...index.entries];

    const scored = [];
    for (const item of index.entries) {
        const fields = [
            ['name', fold(item.name)],
            ...(item.aka || []).map((a) => ['aka', fold(a)]),
            ['gist', fold(item.gist)],
            ['tell', fold(item.tell)],
        ];

        let score = 0;
        for (const [field, hay] of fields) {
            if (!hay.includes(needle)) continue;
            // An exact match beats a prefix beats a mention, and a hit in a
            // short field is worth more than the same hit buried in a sentence.
            const proximity = hay === needle ? 3 : hay.startsWith(needle) ? 2 : 1;
            score = Math.max(score, FIELD_WEIGHT[field] * proximity - hay.length * 0.01);
        }
        if (score > 0) scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score || a.item.no - b.item.no);
    return scored.map((s) => s.item);
}

//? Schema validation for data/catalog.json. Returns a list of human-readable
//? problems; empty means valid. tests/tells-catalog.test.mjs runs this against
//? the real committed file, so a bad hand-edit fails the test run rather than
//? shipping a drill with two right answers.
export function validateCatalog(doc) {
    const errors = [];
    if (!doc || typeof doc !== 'object') return ['catalog is not an object'];
    if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
        return ['entries must be a non-empty array'];
    }

    const ids = new Set();
    const numbers = new Set();

    for (const item of doc.entries) {
        const id = item.id || '(missing id)';
        if (!item.id || typeof item.id !== 'string') errors.push('entry missing id');
        else if (ids.has(item.id)) errors.push(`duplicate id: ${item.id}`);
        else ids.add(item.id);

        if (!Number.isInteger(item.no) || item.no < 1) errors.push(`${id}: plate number must be a positive integer`);
        else if (numbers.has(item.no)) errors.push(`duplicate plate number: ${item.no}`);
        else numbers.add(item.no);

        if (!SITES.includes(item.axis?.site)) errors.push(`${id}: bad axis.site: ${item.axis?.site}`);
        if (!INTENTS.includes(item.axis?.intent)) errors.push(`${id}: bad axis.intent: ${item.axis?.intent}`);
        if (!FAMILIES.includes(item.family)) errors.push(`${id}: bad family: ${item.family}`);

        for (const field of ['name', 'gist', 'how', 'tell']) {
            if (!item[field] || typeof item[field] !== 'string') errors.push(`${id}: missing ${field}`);
        }
        if (typeof item.gist === 'string' && item.gist.length > GIST_MAX) {
            errors.push(`${id}: gist is ${item.gist.length} chars, max ${GIST_MAX}`);
        }

        if (!Array.isArray(item.counter) || item.counter.length === 0) {
            errors.push(`${id}: needs at least one counter`);
        }

        // The adversary drill runs the play from the other side, so anything
        // deliberate has to say what the person doing it is after. An accident
        // has no objective, and claiming one mislabels it.
        if (item.axis?.intent === 'deliberate' && !item.play) {
            errors.push(`${id}: is deliberate, so it needs a play`);
        }
        if (item.axis?.intent === 'accident' && item.play) {
            errors.push(`${id}: an accident cannot have a play`);
        }

        const examples = Array.isArray(item.examples) ? item.examples : [];
        if (examples.length < MIN_EXAMPLES) {
            errors.push(`${id}: needs at least ${MIN_EXAMPLES} examples, has ${examples.length}`);
        }
        const scenes = new Set();
        for (const ex of examples) {
            if (!ex?.text) errors.push(`${id}: an example has no text`);
            if (!SCENES.includes(ex?.scene)) errors.push(`${id}: bad scene: ${ex?.scene}`);
            else scenes.add(ex.scene);
        }
        if (examples.length >= MIN_EXAMPLES && scenes.size < MIN_SCENES) {
            errors.push(`${id}: examples must cover at least ${MIN_SCENES} scenes, they cover ${scenes.size}`);
        }

        for (const [field, text] of prose(item)) {
            if (text.includes('—')) errors.push(`${id}: em dash in ${field}`);
        }
    }

    //? Second pass: everything that needs the whole catalog to check. Cross
    //? references are where a hand-authored file rots, because nothing on the
    //? page ever shows you the pointer that stopped resolving.
    const byId = new Map(doc.entries.filter((e) => e.id).map((e) => [e.id, e]));

    for (const item of doc.entries) {
        const id = item.id || '(missing id)';

        for (const near of item.confusedWith || []) {
            const other = byId.get(near?.id);
            if (!other) {
                errors.push(`${id}: unknown confusedWith: ${near?.id}`);
                continue;
            }
            if (!near.because || !near.tell) errors.push(`${id}: confusedWith ${near.id} needs a because and a tell`);
            const back = (other.confusedWith || []).some((n) => n?.id === id);
            if (!back) errors.push(`${id}: confusedWith ${near.id}, but ${near.id} does not point back`);
        }

        if (item.exploitOf) {
            const twin = byId.get(item.exploitOf);
            if (!twin) errors.push(`${id}: unknown exploitOf: ${item.exploitOf}`);
            else {
                if (twin.exploitOf !== id) errors.push(`${id}: exploitOf ${item.exploitOf}, but ${item.exploitOf} does not point back`);
                // The pairing says "this is the accident, that is the exploit".
                // Two entries on the same side of the axis are not a pair, they
                // are one of them mislabelled.
                if (twin.axis?.intent === item.axis?.intent) {
                    errors.push(`${id} and ${item.exploitOf} are exploit twins but share the same intent: ${item.axis?.intent}`);
                }
            }
        }

        if (item.parent) {
            const parent = byId.get(item.parent);
            if (!parent) errors.push(`${id}: unknown parent: ${item.parent}`);
            else if (parent.family !== 'heuristic') {
                errors.push(`${id}: parent ${item.parent} is a ${parent.family}, and only a heuristic can be a parent`);
            }
        }

        for (const ex of item.examples || []) {
            for (const alsoId of ex?.also || []) {
                if (alsoId === id) errors.push(`${id}: an example's also lists its own entry`);
                else if (!byId.has(alsoId)) errors.push(`${id}: unknown also: ${alsoId}`);
            }
        }
    }

    return errors;
}

//? ── Drills ──────────────────────────────────────────────────────────────────

/** A shuffled copy, Fisher-Yates over the injected rng. */
function shuffled(items, rng) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * An example of `item` that `seen` does not already contain, or any example
 * once they have all been used.
 *
 * This is the mechanism that makes scheduling the concept mean anything. The
 * deck tracks "anchoring", not "the anchoring card", so every review has to
 * arrive wearing a different example. Otherwise the thing that gets memorised
 * is the sentence, which is the "learned trick" outcome rather than a skill
 * that survives contact with a sentence nobody wrote for a quiz.
 */
export function nextExample(item, seen = [], rng = Math.random) {
    const pool = item.examples.filter((ex) => !seen.includes(ex.text));
    const from = pool.length ? pool : item.examples;
    return from[Math.floor(rng() * from.length)];
}

/**
 * Ids to offer beside the answer: never the answer, never anything in
 * `forbidden`, and never the same entry twice.
 *
 * `forbidden` is the example's `also` list, the labels that genuinely apply to
 * this example too. Offering one of those is the failure that matters most in
 * a guide like this, because the learner picks a defensible answer, is told it
 * is wrong, and stops trusting a distinction they had right.
 *
 * Preference order is deliberate: the entries this one is declared confusable
 * with come first, then its own quadrant, then everyone else. A wrong answer
 * from the far side of the grid teaches nothing; the near-miss is where the
 * category boundary actually is.
 */
export function pickDistractors(index, answerId, forbidden = [], count = 3, rng = Math.random) {
    const answer = index.byId.get(answerId);
    const blocked = new Set([answerId, ...forbidden]);
    const taken = [];

    const drain = (candidates) => {
        for (const id of shuffled(candidates, rng)) {
            if (taken.length >= count) return;
            if (blocked.has(id)) continue;
            blocked.add(id);
            taken.push(id);
        }
    };

    drain((answer?.near || []).map((n) => n.entry.id));
    drain((index.byQuadrant[answer?.quadrant] || []).map((e) => e.id));
    drain(index.entries.map((e) => e.id));
    return taken;
}

/** How many options a multiple-choice question offers. */
const OPTIONS = 4;

/**
 * A spot-it round: `count` questions, each an example with the label hidden.
 *
 * `seenByEntry` maps an entry id to the example texts already asked about, so
 * a round drawn during a review session shows examples the deck has not used.
 */
export function buildSpotQuiz(index, count, rng = Math.random, seenByEntry = {}) {
    const chosen = shuffled(index.entries, rng).slice(0, Math.min(count, index.entries.length));

    return chosen.map((item) => {
        const example = nextExample(item, seenByEntry[item.id] || [], rng);
        const distractors = pickDistractors(index, item.id, example.also || [], OPTIONS - 1, rng);
        return {
            mode: 'spot',
            entryId: item.id,
            answer: item.id,
            example,
            options: shuffled([item.id, ...distractors], rng),
        };
    });
}

/**
 * One question forcing a declared near-miss apart: this example, these two
 * labels, which is it?
 *
 * Two options rather than four on purpose. The question is the distinction,
 * and filler options would let it be won by elimination instead. Category
 * learning is contrast learning, which makes this the highest yield drill in
 * the guide per question asked.
 */
export function buildDiscriminationDrill(index, rng = Math.random) {
    const pairs = [];
    for (const item of index.entries) {
        for (const near of item.near) pairs.push({ item, near });
    }

    for (const { item, near } of shuffled(pairs, rng)) {
        // An example the other label also fits cannot separate them.
        const usable = item.examples.filter((ex) => !(ex.also || []).includes(near.entry.id));
        if (!usable.length) continue;
        return {
            mode: 'discriminate',
            entryId: item.id,
            answer: item.id,
            example: usable[Math.floor(rng() * usable.length)],
            options: shuffled([item.id, near.entry.id], rng),
            because: near.because,
            tell: near.tell,
        };
    }
    return null;
}

/**
 * One question asking what to actually do about it, with the label given.
 *
 * The wrong answers are other entries' counters, so every option is a real
 * move that works somewhere. Knowing the name of the thing being done to you
 * and having nothing to say is the state this drill exists to fix.
 */
export function buildCounterDrill(index, rng = Math.random) {
    const withCounters = index.entries.filter((e) => e.counter?.length);
    if (!withCounters.length) return null;

    const item = withCounters[Math.floor(rng() * withCounters.length)];
    const answer = item.counter[Math.floor(rng() * item.counter.length)];

    const taken = new Set([answer]);
    const distractors = [];
    for (const other of shuffled(withCounters, rng)) {
        if (distractors.length >= OPTIONS - 1) break;
        if (other.id === item.id) continue;
        for (const line of other.counter) {
            // Two options that read the same is no question, whoever wrote them.
            if (taken.has(line)) continue;
            taken.add(line);
            distractors.push(line);
            break;
        }
    }

    return {
        mode: 'counter',
        entryId: item.id,
        answer,
        options: shuffled([answer, ...distractors], rng),
    };
}

/**
 * One question run from the other side: here is what you want, which move
 * gets it?
 *
 * Inverting the task is what the inoculation literature credits for
 * resistance: seeing the playbook from the manipulator's end is what makes it
 * legible from the receiving end. Only deliberate entries can be the answer,
 * because an accident is not a play anyone can choose to run.
 */
export function buildAdversaryDrill(index, rng = Math.random) {
    const plays = index.entries.filter((e) => e.axis.intent === 'deliberate' && e.play);
    if (!plays.length) return null;

    const item = plays[Math.floor(rng() * plays.length)];
    const others = plays.filter((e) => e.id !== item.id).map((e) => e.id);
    const distractors = shuffled(others, rng).slice(0, OPTIONS - 1);

    return {
        mode: 'adversary',
        entryId: item.id,
        answer: item.id,
        goal: item.play,
        options: shuffled([item.id, ...distractors], rng),
    };
}

//? ── Memory ──────────────────────────────────────────────────────────────────

//? The day and streak maths is shared with views/beseda through
//? components/beseda/logic.js: one implementation, already tested, already
//? careful about the two things that bite here (local time rather than UTC, so
//? an early morning answer is not filed under yesterday, and a streak that
//? survives until the day is actually lost). Re-exported so script.js has a
//? single import.
export { todayIso, dayNumber, validDays, addDay, mergeDays, streakStats } from '../../components/beseda/logic.js';
import { dayNumber } from '../../components/beseda/logic.js';

/** ISO yyyy-mm-dd `days` after `iso`. Anchored in UTC so DST cannot eat one. */
export function addDays(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d + days));
    const pad = (n) => String(n).padStart(2, '0');
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * How sure you were, asked before the answer is revealed.
 *
 * Three levels rather than a percentage slider: enough resolution to draw a
 * calibration curve, few enough that claiming one costs a single tap and does
 * not become the slow part of a drill. `claimed` is what each level is taken
 * to be asserting when the ledger scores it.
 */
export const CONFIDENCE = [
    { key: 'sure', label: 'Sure', claimed: 0.9 },
    { key: 'think-so', label: 'Fairly sure', claimed: 0.7 },
    { key: 'guess', label: 'Guessing', claimed: 0.4 },
];

/**
 * The SM-2 grade for an answer, 0 to 5, from whether it was right and how sure
 * you were.
 *
 * Correctness on its own cannot separate a solid answer from a lucky one, and
 * a lucky guess scheduled as solid does not come back until it is long gone.
 * Being sure and wrong is the bottom of the scale, which is both correct as
 * scheduling and correct as a lesson.
 */
export function gradeFrom(correct, confidence) {
    const rank = { sure: 2, 'think-so': 1, guess: 0 }[confidence] ?? 0;
    return correct ? 3 + rank : 2 - rank;
}

/** Sure, and wrong. The one answer worth stopping the session over. */
export function overconfident(correct, confidence) {
    return !correct && confidence === 'sure';
}

//? Ease may not fall below this, or a card you keep failing collapses to a
//? one day interval forever and the session becomes that card.
const MIN_EASE = 1.3;
const START_EASE = 2.5;
/** Below this an answer counts as a lapse rather than a pass. */
const PASS = 3;

/** A concept you have never been asked about. */
export function newCard() {
    return { ease: START_EASE, interval: 0, reps: 0, lapses: 0, dueIso: null, seen: [] };
}

/**
 * The card after an answer: SM-2's ladder, with the example rotation attached.
 *
 * The scheduled unit is the concept, never a particular card face, so `seen`
 * rides along holding the example texts already used. It resets once the
 * rotation has been all the way round, both to stay small and because a list
 * kept forever would pin the rotation permanently.
 */
export function schedule(card, grade, todayIso, exampleText = null, exampleCount = Infinity) {
    const next = { ...card, seen: [...(card.seen || [])] };

    if (grade < PASS) {
        next.reps = 0;
        next.lapses += 1;
        next.interval = 1;
    } else {
        next.reps += 1;
        next.interval = next.reps === 1 ? 1 : next.reps === 2 ? 6 : Math.round(card.interval * card.ease);
    }

    // SM-2's ease adjustment: a 5 nudges it up, a 3 already costs you, and a 0
    // takes a large bite. The floor is what stops a hard card compounding down.
    const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
    next.ease = Math.max(MIN_EASE, card.ease + delta);
    next.dueIso = addDays(todayIso, next.interval);

    if (exampleText) {
        next.seen.push(exampleText);
        if (next.seen.length >= exampleCount) next.seen = [];
    }
    return next;
}

/**
 * The ids to review now: most overdue first, then concepts never seen, capped.
 *
 * The cap is the point. Coming back after a month should open onto a session
 * you will finish, not a backlog you will close the tab on.
 */
export function dueCards(deck, index, todayIso, limit = 12) {
    const due = [];
    const fresh = [];

    for (const item of index.entries) {
        const card = deck[item.id];
        if (!card || !card.dueIso) fresh.push(item.id);
        else if (card.dueIso <= todayIso) due.push(item.id);
    }

    due.sort((a, b) => deck[a].dueIso.localeCompare(deck[b].dueIso));
    return [...due, ...fresh].slice(0, limit);
}

/**
 * The calibration curve: for each confidence level actually used, what you
 * claimed against how often you were right.
 *
 * This is the one thing in the guide that is demonstrated rather than
 * described. Reading the definition of overconfidence does very little; being
 * shown that "sure" has been running at 61% does the work instead. A negative
 * `gap` is overconfidence, a positive one is the opposite.
 */
export function calibration(log) {
    return CONFIDENCE
        .map((level) => {
            const rows = log.filter((r) => r.confidence === level.key);
            if (!rows.length) return null;
            const actual = rows.filter((r) => r.correct).length / rows.length;
            return {
                key: level.key,
                label: level.label,
                claimed: level.claimed,
                actual,
                gap: actual - level.claimed,
                n: rows.length,
            };
        })
        .filter(Boolean);
}

/**
 * The entry for a given day, the same on every device and not rerollable.
 *
 * Indexed by day number rather than randomised, so "what did you get today"
 * has one answer, and wrapping once the guide runs out beats showing nothing.
 */
export function tellOfTheDay(entries, iso, epochIso) {
    if (!entries.length) return null;
    const n = dayNumber(iso, epochIso);
    if (!Number.isFinite(n) || n < 0) return null;
    return entries[(n * stride(entries.length)) % entries.length];
}

/**
 * A step size coprime with `length`, so walking the guide by it visits every
 * entry before repeating any.
 *
 * Stepping by a fixed 7 would have been fine today and quietly broken at 49
 * entries, where it would cycle through seven of them forever. The catalog is
 * meant to keep growing, so the stride has to be derived from its size rather
 * than picked once.
 */
function stride(length) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    let step = Math.max(1, Math.floor(length / 3));
    while (step < length && gcd(step, length) !== 1) step += 1;
    return step < length ? step : 1;
}
