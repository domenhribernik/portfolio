// Tells (views/tells): DOM orchestration. Every decision (what a quadrant is,
// which options a question may offer, when a card is next due, what the ledger
// says) lives in logic.js and is tested. This file fetches, routes, renders and
// stores.

import {
    validateCatalog, indexCatalog, searchEntries,
    QUADRANTS,
    nextExample, buildSpotQuiz, buildDiscriminationDrill, buildCounterDrill, buildAdversaryDrill,
    CONFIDENCE, gradeFrom, overconfident,
    newCard, schedule, dueCards, calibration, tellOfTheDay,
    todayIso, validDays, addDay, streakStats,
} from './logic.js';

const STORE_KEY = 'tells:progress:v1';
/** Day zero for the daily card. Moving it re-dates every past day. */
const EPOCH = '2026-08-01';
/** How many concepts one review session serves before calling it a day. */
const SESSION_SIZE = 8;
/** Answers kept for the ledger. Enough for a real curve, bounded for storage. */
const LOG_CAP = 500;

const state = {
    index: null,
    progress: null,
    run: null,        // the drill in flight
};

const $ = (id) => document.getElementById(id);

//? ── Storage ─────────────────────────────────────────────────────────────────

const blank = () => ({ v: 1, deck: {}, log: [], days: [], wild: [] });

function readProgress() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return blank();
        return {
            v: 1,
            deck: raw.deck && typeof raw.deck === 'object' ? raw.deck : {},
            log: Array.isArray(raw.log) ? raw.log.slice(-LOG_CAP) : [],
            days: validDays(raw.days, todayIso()),
            wild: Array.isArray(raw.wild) ? raw.wild : [],
        };
    } catch {
        // Hand-edited storage, a stale schema, or private mode. Start clean
        // rather than refusing to open the guide.
        return blank();
    }
}

function writeProgress() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state.progress));
    } catch {
        // Storage full or blocked. The guide still works; progress will not
        // survive the reload, and the ledger says so.
    }
}

//? ── Rendering helpers ───────────────────────────────────────────────────────

const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const plateNo = (item) => String(item.no).padStart(2, '0');

/** The scene tag printed above an example. */
const sceneLabel = (scene) => scene.replace(/-/g, ' ');

function entryRow(item) {
    return `
        <a class="entry-row" href="#/t/${esc(item.id)}">
            <span class="plate-no">${plateNo(item)}</span>
            <span class="entry-name font-medium">${esc(item.name)}</span>
            <span class="leader"></span>
        </a>`;
}

//? ── The grid ────────────────────────────────────────────────────────────────

function renderGrid() {
    const { byQuadrant, counts } = state.index;

    // Column heads sit above the plate, row labels down the left, so the two
    // questions are readable as questions rather than as four labelled boxes.
    const INTENT_WORD = { accident: 'by accident', deliberate: 'on purpose', both: 'either' };
    const SITE_WORD = { argument: 'In the argument', judgment: 'In the head' };

    const cell = (key, rowClass, colClass) => {
        const q = QUADRANTS[key];
        const list = byQuadrant[key];
        return `
        <div class="cell ${rowClass} ${colClass} ${key.startsWith('seam') ? 'seam' : ''}">
            <p class="lg:hidden font-mono text-[0.72rem] tracking-[0.18em] uppercase text-faint mb-1">
                ${esc(SITE_WORD[q.site])} &middot; ${esc(INTENT_WORD[q.intent])}
            </p>
            <p class="cell-label ${key.startsWith('seam') ? 'text-cobalt' : ''}">${esc(q.label)}</p>
            <p class="mt-2 text-sm leading-snug text-stone">${esc(q.blurb)}</p>
            <p class="mt-3 font-mono text-[0.72rem] tracking-[0.18em] uppercase text-faint">${counts[key]} ${counts[key] === 1 ? 'plate' : 'plates'}</p>
            <div class="mt-2">${list.map(entryRow).join('') || '<p class="py-2 text-sm text-faint">Nothing here yet.</p>'}</div>
        </div>`;
    };

    // One outer grid so the column heads sit over the columns they name: the
    // row-label gutter has to offset them too, or they drift left of the plate.
    $('grid').innerHTML = `
        <div class="lg:grid lg:grid-cols-[7rem_minmax(0,1fr)] lg:gap-x-5">
            <div class="hidden lg:block"></div>
            <div class="hidden lg:grid grid-cols-[minmax(0,1fr)_12rem_minmax(0,1fr)] mb-2">
                <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone px-6">By accident</p>
                <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-cobalt text-center">Either</p>
                <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-clay px-6">On purpose</p>
            </div>

            <div class="hidden lg:grid grid-rows-2">
                <p class="flex items-center font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone leading-relaxed">In the<br>argument</p>
                <p class="flex items-center font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone leading-relaxed">In the<br>head</p>
            </div>

            <div class="plate-grid reveal reveal-1">
                ${cell('fallacy', 'row-1', 'col-1')}
                ${cell('seam-argument', 'row-1', 'col-2')}
                ${cell('rhetoric', 'row-1', 'col-3')}
                ${cell('bias', 'row-2', 'col-1')}
                ${cell('seam-judgment', 'row-2', 'col-2')}
                ${cell('exploit', 'row-2', 'col-3')}
            </div>
        </div>`;
}

//? ── The index ───────────────────────────────────────────────────────────────

function renderIndex(query = '') {
    const hits = searchEntries(state.index, query);
    $('searchCount').textContent = query.trim()
        ? `${hits.length} of ${state.index.total}`
        : `${state.index.total} plates`;

    $('indexList').innerHTML = hits.length
        ? hits.map((item) => `
            <li class="border-b border-hairline py-3">
                <a class="entry-row" href="#/t/${esc(item.id)}">
                    <span class="plate-no">${plateNo(item)}</span>
                    <span class="entry-name font-medium">${esc(item.name)}</span>
                    <span class="leader"></span>
                    <span class="hidden sm:block font-mono text-[0.72rem] uppercase tracking-[0.14em] text-faint">${esc(QUADRANTS[item.quadrant].label)}</span>
                </a>
                <p class="mt-1 max-w-[68ch] text-sm text-stone">${esc(item.gist)}</p>
            </li>`).join('')
        : `<li class="py-8 text-stone">Nothing matches that. Try a shorter word, or browse <a class="underline decoration-clay underline-offset-2" href="#/">the grid</a>.</li>`;
}

//? ── One plate ───────────────────────────────────────────────────────────────

function renderPlate(id) {
    const item = state.index.byId.get(id);
    if (!item) { location.hash = '#/'; return; }

    const q = QUADRANTS[item.quadrant];
    const card = state.progress.deck[item.id];

    const examples = item.examples.map((ex) => `
        <li class="border-t border-hairline pt-3">
            <p class="font-mono text-[0.72rem] tracking-[0.18em] uppercase text-faint">${esc(sceneLabel(ex.scene))}</p>
            <p class="mt-1 max-w-[68ch]">${esc(ex.text)}</p>
        </li>`).join('');

    const near = item.near.map((n) => `
        <li class="border-t border-hairline pt-3">
            <p class="font-display text-lg font-extrabold">
                <a class="no-underline hover:text-clay" href="#/t/${esc(n.entry.id)}">${esc(n.entry.name)}</a>
            </p>
            <p class="mt-1 max-w-[68ch] text-stone"><span class="text-ink">Confusable because</span> ${esc(n.because)}</p>
            <p class="mt-1 max-w-[68ch] text-stone"><span class="text-ink">How to separate them</span> ${esc(n.tell)}</p>
        </li>`).join('');

    const relations = [];
    if (item.twin) {
        relations.push(`
            <p class="max-w-[68ch]">
                <span class="font-mono text-[0.72rem] tracking-[0.18em] uppercase text-clay">Exploit twin</span><br>
                ${item.axis.intent === 'accident'
                    ? `This is the vulnerability. <a class="underline decoration-clay underline-offset-2" href="#/t/${esc(item.twin.id)}">${esc(item.twin.name)}</a> is someone triggering it on purpose.`
                    : `This is the exploit. It works because of <a class="underline decoration-clay underline-offset-2" href="#/t/${esc(item.twin.id)}">${esc(item.twin.name)}</a>.`}
            </p>`);
    }
    if (item.parentEntry) {
        relations.push(`
            <p class="max-w-[68ch]">
                <span class="font-mono text-[0.72rem] tracking-[0.18em] uppercase text-stone">Failure mode of</span><br>
                <a class="underline decoration-clay underline-offset-2" href="#/t/${esc(item.parentEntry.id)}">${esc(item.parentEntry.name)}</a>, which is machinery rather than a defect.
            </p>`);
    }
    if (item.children.length) {
        relations.push(`
            <p class="max-w-[68ch]">
                <span class="font-mono text-[0.72rem] tracking-[0.18em] uppercase text-stone">Fails as</span><br>
                ${item.children.map((c) => `<a class="underline decoration-clay underline-offset-2" href="#/t/${esc(c.id)}">${esc(c.name)}</a>`).join(', ')}
            </p>`);
    }

    $('view-plate').innerHTML = `
        <article class="mt-7 reveal reveal-1">
            <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-faint">
                Plate ${plateNo(item)} &middot; <span class="${item.quadrant.startsWith('seam') ? 'text-cobalt' : item.axis.intent === 'deliberate' ? 'text-clay' : 'text-stone'}">${esc(q.label)}</span>${
                    // Four of the eight families share their quadrant's name,
                    // and "Bias / bias" reads as a stutter rather than a
                    // classification. Print the family only when it adds one.
                    item.family.toLowerCase() === q.label.toLowerCase()
                        ? ''
                        : ` &middot; ${esc(item.family.replace(/-/g, ' '))}`}
            </p>

            <h2 id="plateName" class="mt-3 font-display font-extrabold leading-[0.9] tracking-[-0.03em] text-[clamp(2.2rem,6.5vw,3.6rem)]">${esc(item.name)}</h2>
            ${item.aka?.length ? `<p class="mt-2 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-faint">also ${item.aka.map(esc).join(' &middot; ')}</p>` : ''}

            <p class="mt-4 max-w-[62ch] lede">${esc(item.gist)}</p>

            <div class="mt-8 rule-double max-w-[10rem]"></div>

            <div class="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
                <div>
                    <h3 class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">How it works</h3>
                    <p class="mt-2 max-w-[68ch] leading-relaxed">${esc(item.how)}</p>

                    <h3 class="mt-8 font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">Examples</h3>
                    <ul class="mt-3 space-y-3">${examples}</ul>

                    ${near ? `
                        <h3 class="mt-9 font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">Not to be confused with</h3>
                        <ul class="mt-3 space-y-4">${near}</ul>` : ''}
                </div>

                <aside class="space-y-8">
                    <div class="border border-hairline bg-card rounded-[3px] p-5 shadow-[0_10px_30px_rgba(28,26,23,0.06)]">
                        <h3 class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-clay">The tell</h3>
                        <p class="mt-2 leading-relaxed">${esc(item.tell)}</p>
                    </div>

                    <div>
                        <h3 class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">What to say</h3>
                        <ul class="mt-3 space-y-3">
                            ${item.counter.map((c) => `<li class="border-t border-hairline pt-3 leading-relaxed">${esc(c)}</li>`).join('')}
                        </ul>
                    </div>

                    ${item.play ? `
                        <div>
                            <h3 class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">What they want</h3>
                            <p class="mt-2 leading-relaxed text-stone">${esc(item.play)}</p>
                        </div>` : ''}

                    ${relations.length ? `<div class="space-y-4">${relations.join('')}</div>` : ''}

                    <div class="border-t border-hairline pt-4 font-mono text-[0.72rem] leading-relaxed text-faint">
                        ${item.source ? `<p>${esc(item.source)}</p>` : ''}
                        <p class="mt-1">${card
                            ? `Reviewed ${card.reps + card.lapses} ${card.reps + card.lapses === 1 ? 'time' : 'times'}, next due ${esc(card.dueIso)}`
                            : 'Not yet drilled'}</p>
                    </div>
                </aside>
            </div>

            <p class="mt-12"><a class="btn btn-quiet no-underline" href="#/">&larr; The grid</a></p>
        </article>`;

    $('view-plate').focus();
}

//? ── Drills ──────────────────────────────────────────────────────────────────

const MODES = [
    { key: 'spot', name: 'Spot it', blurb: 'An example with the label hidden. The core drill, and the one the research backs.' },
    { key: 'discriminate', name: 'Tell them apart', blurb: 'Two labels that get confused, one example. Where the category boundary actually is.' },
    { key: 'counter', name: 'What do you say', blurb: 'The label is given. Pick the response that actually defuses it.' },
    { key: 'adversary', name: 'Run the play', blurb: 'Inverted: here is what you want, which move gets it? Learn the playbook from the other end.' },
    { key: 'daily', name: "Today's tell", blurb: 'One plate, chosen by the date. No decision to make about what to study.' },
];

function renderDrillMenu() {
    const due = dueCards(state.progress.deck, state.index, todayIso(), SESSION_SIZE);
    const drilled = Object.keys(state.progress.deck).length;
    const streak = streakStats(state.progress.days, todayIso());

    $('modes').innerHTML = MODES.map((m) => `
        <button type="button" class="entry-row py-4" data-mode="${m.key}">
            <span class="min-w-0 flex-1">
                <span class="block font-display text-xl font-extrabold entry-name">${esc(m.name)}</span>
                <span class="mt-1 block max-w-[62ch] text-sm text-stone">${esc(m.blurb)}</span>
            </span>
            <span class="plate-no shrink-0">&rarr;</span>
        </button>`).join('');

    $('deckLine').textContent =
        `${due.length} due now &middot; ${drilled} of ${state.index.total} plates started &middot; `
        + `streak ${streak.current} ${streak.current === 1 ? 'day' : 'days'}`;

    $('drillMenu').classList.remove('hidden');
    $('drillRun').classList.add('hidden');
}

/** Start a run of `mode`, drawing on what the deck says is due. */
function startRun(mode) {
    const today = todayIso();
    const seenByEntry = {};
    for (const [id, card] of Object.entries(state.progress.deck)) seenByEntry[id] = card.seen || [];

    let questions = [];
    if (mode === 'spot') {
        const due = dueCards(state.progress.deck, state.index, today, SESSION_SIZE);
        const dueIndex = { ...state.index, entries: due.map((id) => state.index.byId.get(id)) };
        questions = buildSpotQuiz(dueIndex, SESSION_SIZE, Math.random, seenByEntry);
    } else if (mode === 'daily') {
        const item = tellOfTheDay(state.index.entries, today, EPOCH);
        if (item) {
            const example = nextExample(item, seenByEntry[item.id] || []);
            const single = { ...state.index, entries: [item] };
            questions = buildSpotQuiz(single, 1, Math.random, seenByEntry);
            questions[0].example = example;
        }
    } else {
        const build = {
            discriminate: buildDiscriminationDrill,
            counter: buildCounterDrill,
            adversary: buildAdversaryDrill,
        }[mode];
        for (let i = 0; i < SESSION_SIZE; i += 1) {
            const q = build(state.index, Math.random);
            if (!q) break;
            // Near-miss pairs and plays are a small set; drawing the same one
            // twice in a round would feel broken even though it is legal.
            if (!questions.some((prev) => prev.entryId === q.entryId)) questions.push(q);
        }
    }

    if (!questions.length) {
        $('drillRun').innerHTML = `
            <p class="mt-8 font-display text-2xl font-extrabold">Nothing to drill here yet.</p>
            <p class="mt-2 max-w-[62ch] text-stone">This mode needs more plates than the guide currently holds. Try Spot it.</p>
            <p class="mt-6"><button type="button" class="btn btn-quiet" data-back>Back</button></p>`;
        $('drillMenu').classList.add('hidden');
        $('drillRun').classList.remove('hidden');
        return;
    }

    state.run = { mode, questions, at: 0, right: 0, picked: null };
    $('drillMenu').classList.add('hidden');
    $('drillRun').classList.remove('hidden');
    renderQuestion();
}

function optionLabel(q, id) {
    if (q.mode === 'counter') return id;
    return state.index.byId.get(id).name;
}

function prompt(q) {
    if (q.mode === 'adversary') {
        return `
            <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-clay">You want this</p>
            <p class="mt-2 max-w-[62ch] lede">${esc(q.goal)}</p>
            <p class="mt-3 max-w-[62ch] text-stone">Which move gets it?</p>`;
    }
    if (q.mode === 'counter') {
        const item = state.index.byId.get(q.entryId);
        return `
            <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">It is happening, and it is</p>
            <p class="mt-2 subject">${esc(item.name)}</p>
            <p class="mt-3 max-w-[62ch] text-stone">What do you actually say?</p>`;
    }
    return `
        <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-faint">${esc(sceneLabel(q.example.scene))}</p>
        <p class="mt-2 max-w-[62ch] lede">${esc(q.example.text)}</p>
        <p class="mt-3 max-w-[62ch] text-stone">${q.mode === 'discriminate' ? 'Which of these two is it?' : 'What is happening here?'}</p>`;
}

function renderQuestion() {
    const run = state.run;
    const q = run.questions[run.at];

    $('drillRun').innerHTML = `
        <div class="mt-7">
            <div class="flex items-baseline justify-between gap-4">
                <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">${esc(MODES.find((m) => m.key === run.mode).name)}</p>
                <p class="font-mono text-[0.72rem] tracking-[0.14em] text-faint">${run.at + 1} / ${run.questions.length}</p>
            </div>
            <div class="mt-3 h-[3px] bg-paper-2">
                <div class="h-full bg-ink" style="width: ${(run.at / run.questions.length) * 100}%"></div>
            </div>

            <div class="mt-8 reveal">${prompt(q)}</div>

            <div id="options" class="mt-7 grid gap-2 max-w-[46rem]">
                ${q.options.map((id, i) => `
                    <button type="button" class="option" data-pick="${esc(id)}">
                        <span class="key">${i + 1}</span>${esc(optionLabel(q, id))}
                    </button>`).join('')}
            </div>

            <div id="confidence" class="mt-7 hidden">
                <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">Before you see the answer, how sure are you?</p>
                <div class="mt-3 flex flex-wrap gap-2">
                    ${CONFIDENCE.map((c, i) => `
                        <button type="button" class="btn btn-quiet" data-confidence="${c.key}">
                            <span class="key">${i + 1}</span> ${esc(c.label)}
                        </button>`).join('')}
                </div>
            </div>

            <div id="verdict" class="mt-8" aria-live="polite" tabindex="-1"></div>
        </div>`;

    $('options').addEventListener('click', (e) => {
        const button = e.target.closest('[data-pick]');
        if (button) pick(button.dataset.pick);
    });
    $('confidence').addEventListener('click', (e) => {
        const button = e.target.closest('[data-confidence]');
        if (button) reveal(button.dataset.confidence);
    });
}

/** An option is chosen, but nothing is revealed until confidence is claimed. */
function pick(id) {
    if (state.run.picked) return;
    state.run.picked = id;

    for (const button of $('options').querySelectorAll('.option')) {
        button.disabled = true;
        if (button.dataset.pick !== id) button.classList.add('is-muted');
    }
    $('confidence').classList.remove('hidden');
    $('confidence').querySelector('button').focus();
}

function reveal(confidence) {
    const run = state.run;
    const q = run.questions[run.at];
    const correct = run.picked === q.answer;
    const sureAndWrong = overconfident(correct, confidence);
    if (correct) run.right += 1;

    for (const button of $('options').querySelectorAll('.option')) {
        button.classList.remove('is-muted');
        if (button.dataset.pick === q.answer) button.classList.add('is-right');
        else if (button.dataset.pick === run.picked) button.classList.add('is-wrong');
        else button.classList.add('is-muted');
    }
    $('confidence').classList.add('hidden');

    record(q, correct, confidence);

    const item = state.index.byId.get(q.entryId);
    const chosen = q.mode === 'counter' ? null : state.index.byId.get(run.picked);

    // The feedback that earns the drill: not "wrong", but why this one and not
    // the one you reached for. Where the pair is a declared near-miss, the
    // entry already carries the sentence that separates them.
    let why = '';
    if (q.mode === 'discriminate' && q.tell) {
        why = q.tell;
    } else if (!correct && chosen) {
        const declared = item.near.find((n) => n.entry.id === chosen.id);
        why = declared
            ? declared.tell
            : `${item.tell} That is what makes it ${item.name} rather than ${chosen.name}.`;
    } else {
        why = item.tell;
    }

    $('verdict').innerHTML = `
        <div class="verdict ${correct ? '' : 'is-wrong'} ${sureAndWrong ? 'is-overconfident' : ''} reveal">
            ${sureAndWrong ? '<p class="mb-3"><span class="stamp">Sure, and wrong</span></p>' : ''}
            <p class="font-display text-2xl font-extrabold">
                ${correct ? 'Yes.' : 'No.'}
                <a class="underline decoration-clay underline-offset-4" href="#/t/${esc(item.id)}">${esc(item.name)}</a>
            </p>
            ${sureAndWrong ? `
                <p class="mt-2 max-w-[62ch] text-stone">
                    You were certain and you were wrong, which is the whole lesson in one move. Nothing
                    about being sure tracks being right, and this is the only place you get to watch that
                    happen to you rather than read about it.
                </p>` : ''}
            <p class="mt-2 max-w-[62ch] leading-relaxed">${esc(why)}</p>
            ${q.mode !== 'counter' ? `
                <p class="mt-4 max-w-[62ch]">
                    <span class="font-mono text-[0.72rem] tracking-[0.18em] uppercase text-stone">What to say</span><br>
                    ${esc(item.counter[0])}
                </p>` : ''}
            <p class="mt-6">
                <button type="button" class="btn" data-next>
                    ${run.at + 1 < run.questions.length ? 'Next' : 'Finish'}
                </button>
            </p>
        </div>`;

    $('verdict').querySelector('[data-next]').addEventListener('click', next);
    $('verdict').focus();
}

function record(q, correct, confidence) {
    const today = todayIso();
    const item = state.index.byId.get(q.entryId);
    const card = state.progress.deck[q.entryId] || newCard();

    state.progress.deck[q.entryId] = schedule(
        card,
        gradeFrom(correct, confidence),
        today,
        q.example?.text || null,
        item.examples.length,
    );

    state.progress.log.push({ iso: today, id: q.entryId, mode: q.mode, confidence, correct });
    if (state.progress.log.length > LOG_CAP) state.progress.log = state.progress.log.slice(-LOG_CAP);
    state.progress.days = addDay(state.progress.days, today);
    writeProgress();
}

function next() {
    const run = state.run;
    run.at += 1;
    run.picked = null;
    if (run.at < run.questions.length) { renderQuestion(); return; }

    const streak = streakStats(state.progress.days, todayIso());
    $('drillRun').innerHTML = `
        <div class="mt-10 reveal">
            <p class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">Round finished</p>
            <p class="mt-3 font-display text-[clamp(2.4rem,7vw,4rem)] font-extrabold leading-none">${run.right} / ${run.questions.length}</p>
            <p class="mt-4 max-w-[62ch] text-stone">
                ${run.right === run.questions.length
                    ? 'All of them. The next time these come round the examples will be ones you have not seen.'
                    : 'The ones you missed are due again sooner. Every review draws a different example, so what sticks is the pattern rather than the sentence.'}
            </p>
            <p class="mt-3 font-mono text-[0.72rem] text-faint">Streak ${streak.current} ${streak.current === 1 ? 'day' : 'days'} &middot; longest ${streak.longest}</p>
            <p class="mt-7 flex flex-wrap gap-2">
                <button type="button" class="btn" data-again>Another round</button>
                <a class="btn btn-quiet no-underline" href="#/ledger">See the ledger</a>
                <button type="button" class="btn btn-quiet" data-back>Back to the drills</button>
            </p>
        </div>`;

    $('drillRun').querySelector('[data-again]').addEventListener('click', () => startRun(run.mode));
}

//? ── The ledger ──────────────────────────────────────────────────────────────

function renderLedger() {
    const rows = calibration(state.progress.log);
    const streak = streakStats(state.progress.days, todayIso());
    const drilled = Object.keys(state.progress.deck).length;
    const answers = state.progress.log.length;

    const curve = rows.length
        ? rows.map((row) => `
            <li class="border-t border-hairline py-4">
                <div class="flex items-baseline justify-between gap-3">
                    <p class="font-display text-lg font-extrabold">&ldquo;${esc(row.label)}&rdquo;</p>
                    <p class="font-mono text-[0.72rem] text-faint">${row.n} ${row.n === 1 ? 'answer' : 'answers'}</p>
                </div>
                <div class="mt-2 bar-track">
                    <div class="bar-fill ${row.gap < -0.1 ? 'is-short' : ''}" data-fill="${row.actual}"></div>
                    <div class="bar-claim" style="left: ${Math.round(row.claimed * 100)}%" title="what this level claims"></div>
                </div>
                <p class="mt-2 max-w-[62ch] text-sm text-stone">
                    Claimed about ${Math.round(row.claimed * 100)}%, actually right ${Math.round(row.actual * 100)}%.
                    ${row.gap < -0.1 ? 'That gap is overconfidence, measured on you rather than described at you.'
                        : row.gap > 0.1 ? 'You are better than you are giving yourself credit for.'
                        : 'Well calibrated.'}
                </p>
            </li>`).join('')
        : `<li class="py-6 text-stone">Nothing yet. Answer a round and the curve appears here.</li>`;

    $('view-ledger').innerHTML = `
        <h2 id="ledgerHeading" class="mt-7 font-display text-3xl font-extrabold tracking-[-0.02em]">Ledger</h2>
        <p class="mt-3 max-w-[62ch] text-stone">
            Every answer records how sure you said you were. This compares the claim against what
            happened. The blue notch is what each level is claiming; the bar is how often it was right.
        </p>

        <ol class="mt-7 max-w-[46rem]">${curve}</ol>

        <div class="mt-10 grid gap-6 sm:grid-cols-3 max-w-[46rem]">
            ${[['Answers', answers], ['Plates started', `${drilled} / ${state.index.total}`], ['Streak', `${streak.current}d`]].map(([label, value]) => `
                <div class="border-t-2 border-ink pt-3">
                    <p class="font-mono text-[0.72rem] tracking-[0.2em] uppercase text-stone">${label}</p>
                    <p class="mt-1 font-display text-3xl font-extrabold">${esc(value)}</p>
                </div>`).join('')}
        </div>

        <div class="mt-12 border-t border-hairline pt-6">
            <h3 class="font-mono text-[0.72rem] tracking-[0.22em] uppercase text-stone">Your progress</h3>
            <p class="mt-2 max-w-[62ch] text-sm text-stone">
                Kept in this browser only. Export it if you want it to survive a cleared cache or move to another machine.
            </p>
            <p class="mt-4 flex flex-wrap gap-2">
                <button type="button" class="btn btn-quiet" data-export>Export</button>
                <button type="button" class="btn btn-quiet" data-import>Import</button>
                <button type="button" class="btn btn-quiet" data-reset>Erase</button>
            </p>
            <p id="ledgerNote" class="mt-3 font-mono text-[0.72rem] text-faint"></p>
            <input id="importFile" type="file" accept="application/json" class="hidden">
        </div>`;

    // The bars are inserted at zero and grown on the next frame. Setting the
    // final value inline would paint them already full, which is the one thing
    // this chart exists to show happening.
    requestAnimationFrame(() => {
        for (const bar of $('view-ledger').querySelectorAll('[data-fill]')) {
            bar.style.transform = `scaleX(${bar.dataset.fill})`;
        }
    });

    $('view-ledger').querySelector('[data-export]').addEventListener('click', exportProgress);
    $('view-ledger').querySelector('[data-import]').addEventListener('click', () => $('importFile').click());
    $('view-ledger').querySelector('[data-reset]').addEventListener('click', resetProgress);
    $('importFile').addEventListener('change', importProgress);
}

function exportProgress() {
    const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tells-progress-${todayIso()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    $('ledgerNote').textContent = 'Exported.';
}

async function importProgress(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const raw = JSON.parse(await file.text());
        if (!raw || typeof raw !== 'object' || !raw.deck) throw new Error('not a progress file');
        localStorage.setItem(STORE_KEY, JSON.stringify(raw));
        state.progress = readProgress();
        renderLedger();
        $('ledgerNote').textContent = 'Imported.';
    } catch (err) {
        $('ledgerNote').textContent = `That file could not be read: ${err.message}`;
    }
}

function resetProgress() {
    if (!confirm('Erase every answer, the deck and the streak? This cannot be undone.')) return;
    state.progress = blank();
    writeProgress();
    renderLedger();
    $('ledgerNote').textContent = 'Erased.';
}

//? ── In the wild ─────────────────────────────────────────────────────────────

function renderWild() {
    const options = [...state.index.entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');

    const entries = state.progress.wild.length
        ? [...state.progress.wild].reverse().map((w, i) => `
            <li class="border-t border-hairline py-4">
                <div class="flex items-baseline justify-between gap-3">
                    <p class="font-mono text-[0.72rem] tracking-[0.16em] uppercase text-clay">${esc(state.index.byId.get(w.id)?.name || w.id)}</p>
                    <p class="font-mono text-[0.72rem] text-faint">${esc(w.iso)}</p>
                </div>
                <p class="mt-1 max-w-[68ch]">${esc(w.note)}</p>
                <button type="button" class="mt-2 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-faint hover:text-clay" data-forget="${state.progress.wild.length - 1 - i}">Remove</button>
            </li>`).join('')
        : `<li class="py-6 text-stone">Nothing logged yet. The first one is usually a week away, and then you start seeing them everywhere.</li>`;

    $('view-wild').innerHTML = `
        <h2 id="wildHeading" class="mt-7 font-display text-3xl font-extrabold tracking-[-0.02em]">In the wild</h2>
        <p class="mt-3 max-w-[62ch] text-stone">
            The gap between passing a quiz and noticing something in a real conversation is the whole
            difficulty, and the research is honest that training rarely closes it on its own. Writing
            down the ones you actually catch is the bridge. It also gives you examples nobody wrote for a quiz.
        </p>

        <form id="wildForm" class="mt-7 max-w-[46rem] space-y-3">
            <label class="block">
                <span class="font-mono text-[0.72rem] tracking-[0.2em] uppercase text-stone">What did you spot?</span>
                <select id="wildId" class="field mt-2 w-full">${options}</select>
            </label>
            <label class="block">
                <span class="font-mono text-[0.72rem] tracking-[0.2em] uppercase text-stone">Where, and what happened?</span>
                <textarea id="wildNote" rows="3" maxlength="400" class="field mt-2 w-full" placeholder="Sales call, they opened at a number nobody could defend and then looked generous."></textarea>
            </label>
            <p><button type="submit" class="btn">Log it</button></p>
        </form>

        <ol class="mt-10 max-w-[46rem]">${entries}</ol>`;

    $('wildForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const note = $('wildNote').value.trim();
        if (!note) return;
        state.progress.wild.push({ iso: todayIso(), id: $('wildId').value, note });
        writeProgress();
        renderWild();
    });

    for (const button of $('view-wild').querySelectorAll('[data-forget]')) {
        button.addEventListener('click', () => {
            state.progress.wild.splice(Number(button.dataset.forget), 1);
            writeProgress();
            renderWild();
        });
    }
}

//? ── Routing ─────────────────────────────────────────────────────────────────

const VIEWS = ['grid', 'index', 'plate', 'drill', 'ledger', 'wild'];

function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [head, arg] = hash.split('/');

    let view = 'grid';
    if (head === 't' && arg) view = 'plate';
    else if (VIEWS.includes(head)) view = head;

    // The `hidden` attribute rather than Tailwind's .hidden class: Tailwind
    // arrives as a script, so before it runs (and for a crawler, which never
    // runs it) the class means nothing and every section paints at once.
    for (const key of VIEWS) $(`view-${key}`).hidden = key !== view;
    for (const link of document.querySelectorAll('[data-nav]')) {
        const active = link.dataset.nav === view || (view === 'plate' && link.dataset.nav === 'grid');
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }

    if (view === 'plate') renderPlate(arg);
    else if (view === 'index') renderIndex($('search').value);
    else if (view === 'drill') renderDrillMenu();
    else if (view === 'ledger') renderLedger();
    else if (view === 'wild') renderWild();
}

//? ── Keyboard ────────────────────────────────────────────────────────────────

// 1-4 answers, then 1-3 claims confidence. The number is on every option, so
// a round can be run without ever reaching for the mouse.
document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (!/^[1-4]$/.test(e.key)) return;

    const confidence = $('confidence');
    if (confidence && !confidence.classList.contains('hidden')) {
        confidence.querySelectorAll('[data-confidence]')[Number(e.key) - 1]?.click();
        e.preventDefault();
        return;
    }
    const options = $('options');
    if (options && !state.run?.picked) {
        options.querySelectorAll('[data-pick]')[Number(e.key) - 1]?.click();
        e.preventDefault();
    }
});

//? ── Boot ────────────────────────────────────────────────────────────────────

function showError(message) {
    // The prerendered plate list is still on screen at this point, and it is
    // real content, so leave it there and put the error above it.
    $('errorDetail').textContent = message;
    $('error').hidden = false;
}

async function init() {
    let doc;
    try {
        const response = await fetch('data/catalog.json');
        if (!response.ok) throw new Error(`catalog.json returned ${response.status}`);
        doc = await response.json();
    } catch (err) {
        showError(`${err.message}. If you are opening this from a file:// path, it needs a web server.`);
        return;
    }

    const problems = validateCatalog(doc);
    if (problems.length) {
        // The suite catches this before it ships, so reaching here means an
        // edited file. Say which rule broke rather than rendering half a guide.
        showError(`The catalog is not valid: ${problems.slice(0, 3).join('; ')}`);
        return;
    }

    state.index = indexCatalog(doc);
    state.progress = readProgress();

    $('plateCount').textContent = state.index.total;
    renderGrid();   // replaces the prerendered fallback with the live grid

    document.addEventListener('click', (e) => {
        const mode = e.target.closest('[data-mode]');
        if (mode) { startRun(mode.dataset.mode); return; }
        if (e.target.closest('[data-back]')) renderDrillMenu();
    });
    $('search').addEventListener('input', () => renderIndex($('search').value));
    window.addEventListener('hashchange', route);

    // Clicking the tab you are already on has to work too. Mid-drill the hash
    // is already #/drill, so the Drill tab fires no hashchange and would look
    // dead exactly when someone is trying to abandon a round.
    for (const link of document.querySelectorAll('[data-nav]')) {
        link.addEventListener('click', () => {
            const here = location.hash.replace(/^#\/?/, '');
            const there = link.getAttribute('href').replace(/^#\/?/, '');
            if (here === there) route();
        });
    }

    // Another tab may have answered a round. Re-read rather than overwrite.
    window.addEventListener('storage', (e) => {
        if (e.key !== STORE_KEY) return;
        state.progress = readProgress();
        if (!location.hash.startsWith('#/drill')) route();
    });

    route();
}

init();
