/**
 * Beseda page wiring.
 *
 * All content is static JSON in data/, so the page works with no backend and
 * no account. The controller is touched only to sync a streak once someone
 * signs in. Decision logic lives in the two imported logic modules, which node
 * tests directly; this file is DOM plumbing.
 */
import { loginUrl } from '../../components/auth-gate.js';
import {
    todayIso, wordOfTheDay, glossSegments, streakStats, addDay, mergeDays, validDays,
} from '../../components/beseda/logic.js';
import { buildQuiz, buildCloze } from './logic.js';

const API = '../../app/controllers/beseda-controller.php';
const STORE_KEY = 'beseda-streak';
const DAILY_QUESTIONS = 3;
const TOPIC_QUESTIONS = 10;
/** How far back the daily quiz draws on, so it reviews rather than only tests today. */
const REVIEW_WINDOW_DAYS = 14;

const $ = (id) => document.getElementById(id);

const state = {
    words: [],
    sentences: [],
    topics: [],
    daily: null,
    days: [],
    signedIn: false,
    quiz: null,
};

// ------------------------------------------------------------------
//  Streak storage. localStorage is the source of truth for rendering, so
//  the page still shows the right number when the network or the session
//  is gone.
// ------------------------------------------------------------------

function readLocalDays() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        return validDays(parsed.days, todayIso());
    } catch {
        return [];
    }
}

function writeLocalDays(days) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ days }));
    } catch {
        // Private mode, or storage full. The streak is a nicety, not the product.
    }
}

async function postDays(days) {
    const response = await fetch(`${API}?resource=streak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
    });
    if (!response.ok) throw new Error(`sync failed (${response.status})`);
    const data = await response.json();
    return validDays(data.days, todayIso());
}

/**
 * Merge the browser's history with the account's, once, on load.
 *
 * Runs after the first render on purpose: the streak is already on screen from
 * localStorage, and a slow or failed round trip must never delay it.
 */
async function syncStreak() {
    let session;
    try {
        session = await (await fetch(`${API}?resource=session`)).json();
    } catch {
        return; // Offline, or the endpoint is not deployed. Stay local.
    }
    if (!session || session.demo) {
        renderAuth(null);
        return;
    }
    state.signedIn = true;
    renderAuth(session.viewer);
    try {
        state.days = mergeDays(state.days, await postDays(state.days));
        writeLocalDays(state.days);
        renderStreak();
    } catch {
        // Keep the local streak; it will merge on the next visit.
    }
}

function markToday() {
    const today = todayIso();
    if (state.days.includes(today)) return;
    state.days = addDay(state.days, today);
    writeLocalDays(state.days);
    renderStreak();
    if (state.signedIn) {
        postDays([today]).catch(() => {
            // Already stored locally; the next sync picks it up.
        });
    }
}

// ------------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------------

function renderAuth(viewer) {
    const chip = $('accountChip');
    const note = $('syncNote');
    if (viewer) {
        $('accountName').textContent = viewer.display_name || 'Signed in';
        if (viewer.avatar_url) $('accountAvatar').src = viewer.avatar_url;
        chip.classList.remove('hidden');
        chip.classList.add('flex');
        note.classList.add('hidden');
    } else {
        $('signinLink').href = loginUrl();
        chip.classList.add('hidden');
        note.classList.remove('hidden');
    }
}

function renderStreak() {
    const today = todayIso();
    const stats = streakStats(state.days, today);
    $('streakCount').textContent = String(stats.current);
    $('longestLabel').textContent = stats.longest
        ? `Longest ${stats.longest} day${stats.longest === 1 ? '' : 's'}`
        : '';

    const done = new Set(state.days);
    const dots = $('weekDots');
    dots.replaceChildren();
    for (let back = 6; back >= 0; back -= 1) {
        const date = new Date();
        date.setDate(date.getDate() - back);
        const iso = todayIso(date);
        const li = document.createElement('li');
        const cell = document.createElement('div');
        cell.className = 'day-dot';
        if (done.has(iso)) cell.classList.add('is-done');
        if (iso === today) cell.classList.add('is-today');
        cell.textContent = date.toLocaleDateString('en-GB', { weekday: 'short' })[0];
        cell.title = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        li.append(cell);
        dots.append(li);
    }

    const isDone = stats.activeToday;
    $('markDone').disabled = isDone;
    $('markDone').textContent = isDone ? 'Learned today' : 'Mark as learned';
    $('doneNote').classList.toggle('hidden', !isDone);
}

/** Build a sentence as DOM nodes, with a hover gloss on every word we know. */
function renderSentence(sentence, container) {
    for (const segment of glossSegments(sentence)) {
        if (segment.wordIndex === null || !state.words[segment.wordIndex]) {
            container.append(document.createTextNode(segment.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = 'gloss';
        span.textContent = segment.text;
        span.tabIndex = 0;
        span.dataset.word = String(segment.wordIndex);
        // Screen readers get the meaning without needing the hover.
        span.setAttribute('aria-label', `${segment.text}: ${state.words[segment.wordIndex][1]}`);
        container.append(span);
    }
}

function wordMetaText(word) {
    const [, , pos, gender, rank] = word;
    const bits = [gender ? `${pos}, ${gender}.` : pos];
    if (rank) bits.push(`#${rank} most common`);
    return bits.join('  ·  ');
}

function renderWordOfTheDay() {
    const today = todayIso();
    const pick = wordOfTheDay(state.daily, today);
    if (!pick) throw new Error('no word scheduled for today');

    const word = state.words[pick.wordIndex];
    $('theWord').textContent = word[0];
    $('wordMeta').textContent = wordMetaText(word);
    $('wordGloss').textContent = word[1];
    $('todayLabel').textContent = new Date().toLocaleDateString('en-GB',
        { weekday: 'long', day: 'numeric', month: 'long' });

    const list = $('examples');
    list.replaceChildren();
    for (const index of pick.sentences.slice(0, 3)) {
        const sentence = state.sentences[index];
        if (!sentence) continue;

        const li = document.createElement('li');
        li.className = 'example';

        const slovene = document.createElement('p');
        slovene.className = 'example-sl';
        renderSentence(sentence, slovene);

        const english = document.createElement('p');
        english.className = 'example-en mt-2 text-stone';
        english.textContent = sentence[1];

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'example-toggle mt-2';
        toggle.textContent = 'Show translation';
        toggle.addEventListener('click', () => {
            const revealed = li.classList.toggle('is-revealed');
            toggle.textContent = revealed ? 'Hide translation' : 'Show translation';
        });

        li.append(slovene, toggle, english);
        list.append(li);
    }
}

function renderTopics() {
    const list = $('topicList');
    list.replaceChildren();
    state.topics.forEach((topic, i) => {
        const li = document.createElement('li');
        const row = document.createElement('a');
        row.className = 'topic-row no-underline text-ink';
        row.href = `#topic/${topic.id}`;

        const num = document.createElement('span');
        num.className = 'topic-num';
        num.textContent = String(i + 1).padStart(2, '0');

        const name = document.createElement('span');
        name.className = 'topic-name';
        name.textContent = topic.title;

        const count = document.createElement('span');
        count.className = 'topic-count';
        count.textContent = `${topic.words.length} words`;

        row.append(num, name, count);
        li.append(row);
        list.append(li);
    });
}

function renderTopic(topic) {
    $('topicTitle').textContent = topic.title;

    const list = $('topicWords');
    list.replaceChildren();
    for (const index of topic.words) {
        const word = state.words[index];
        if (!word) continue;
        const li = document.createElement('li');
        const sl = document.createElement('span');
        sl.className = 'wt-sl';
        sl.textContent = word[0];
        const en = document.createElement('span');
        en.className = 'wt-en';
        en.textContent = word[1];
        const meta = document.createElement('span');
        meta.className = 'wt-meta';
        meta.textContent = word[3] ? `${word[2]} ${word[3]}.` : word[2];
        li.append(sl, en, meta);
        list.append(li);
    }

    const examples = $('topicExamples');
    examples.replaceChildren();
    if (topic.sentences.length) {
        const heading = document.createElement('p');
        heading.className = 'font-mono text-[0.72rem] tracking-[0.2em] uppercase text-stone mb-4';
        heading.textContent = 'Seen in the wild';
        examples.append(heading);

        const ol = document.createElement('ol');
        ol.className = 'space-y-5';
        for (const index of topic.sentences.slice(0, 5)) {
            const sentence = state.sentences[index];
            if (!sentence) continue;
            const li = document.createElement('li');
            const sl = document.createElement('p');
            sl.className = 'example-sl';
            renderSentence(sentence, sl);
            const en = document.createElement('p');
            en.className = 'text-stone text-sm mt-1';
            en.textContent = sentence[1];
            li.append(sl, en);
            ol.append(li);
        }
        examples.append(ol);
    }
}

// ------------------------------------------------------------------
//  Tooltip. One shared node, positioned so it cannot clip off-screen.
// ------------------------------------------------------------------

function setupTooltip() {
    const tip = $('tooltip');
    let open = null;

    function show(target) {
        const word = state.words[Number(target.dataset.word)];
        if (!word) return;
        tip.replaceChildren();
        const lemma = document.createElement('span');
        lemma.className = 'tip-lemma';
        lemma.textContent = word[3] ? `${word[0]} · ${word[2]}, ${word[3]}.` : `${word[0]} · ${word[2]}`;
        tip.append(lemma, document.createTextNode(word[1]));
        tip.classList.add('is-open');
        tip.setAttribute('aria-hidden', 'false');

        const rect = target.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const margin = 8;
        let left = rect.left + window.scrollX + rect.width / 2 - tipRect.width / 2;
        left = Math.max(margin + window.scrollX,
                        Math.min(left, window.scrollX + document.documentElement.clientWidth - tipRect.width - margin));
        // Above by default, below when there is no room up there.
        const above = rect.top - tipRect.height - margin;
        const top = above > 0 ? above + window.scrollY : rect.bottom + margin + window.scrollY;
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        open = target;
    }

    function hide() {
        tip.classList.remove('is-open');
        tip.setAttribute('aria-hidden', 'true');
        open = null;
    }

    document.addEventListener('pointerover', (e) => {
        const target = e.target.closest('.gloss');
        if (target) show(target);
        else if (open && !tip.contains(e.target)) hide();
    });
    document.addEventListener('focusin', (e) => {
        const target = e.target.closest('.gloss');
        if (target) show(target);
        else hide();
    });
    // Touch: a tap opens, a tap elsewhere closes.
    document.addEventListener('click', (e) => {
        const target = e.target.closest('.gloss');
        if (target) {
            if (open === target) hide();
            else show(target);
        } else if (open) {
            hide();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hide();
    });
    window.addEventListener('scroll', () => { if (open) hide(); }, { passive: true });
}

// ------------------------------------------------------------------
//  Quiz
// ------------------------------------------------------------------

/** Words from the last fortnight of the schedule, so the drill reviews. */
function reviewPool() {
    const today = todayIso();
    const pool = [];
    for (let back = 0; back < REVIEW_WINDOW_DAYS; back += 1) {
        const date = new Date();
        date.setDate(date.getDate() - back);
        const pick = wordOfTheDay(state.daily, todayIso(date));
        if (pick && !pool.includes(pick.wordIndex)) pool.push(pick.wordIndex);
    }
    return pool;
}

function startQuiz(pool, count, title) {
    const questions = buildQuiz(pool, state.words, count, Math.random);
    if (!questions.length) return;
    state.quiz = { questions, at: 0, right: 0, answered: false };
    $('quizTitle').textContent = title;
    openQuizPanel();
    renderQuestion();
    $('quizPanel').focus({ preventScroll: true });
}

/** Give the drill the page to itself: the index behind it is only a distraction. */
function openQuizPanel() {
    $('quizPanel').classList.remove('hidden');
    $('quizBody').classList.remove('hidden');
    $('quizResult').classList.add('hidden');
    $('topicsSection').classList.add('hidden');
    $('quizPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderQuestion() {
    const { questions, at } = state.quiz;
    const question = questions[at];
    state.quiz.answered = false;

    $('quizProgress').textContent = `${at + 1} / ${questions.length}`;
    $('quizPrompt').textContent = question.prompt;
    $('quizHint').textContent = question.direction === 'slToEn'
        ? 'What does this mean?'
        : 'Which word is this?';

    const list = $('quizOptions');
    list.replaceChildren();
    question.options.forEach((index, position) => {
        const word = state.words[index];
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option';
        const key = document.createElement('span');
        key.className = 'option-key';
        key.textContent = String(position + 1);
        const label = document.createElement('span');
        label.textContent = question.direction === 'slToEn' ? word[1] : word[0];
        button.append(key, label);
        button.addEventListener('click', () => answer(index, button));
        li.append(button);
        list.append(li);
    });
}

function answer(chosen, button) {
    if (state.quiz.answered) return;
    state.quiz.answered = true;

    const question = state.quiz.questions[state.quiz.at];
    const right = chosen === question.answer;
    if (right) state.quiz.right += 1;

    for (const el of $('quizOptions').querySelectorAll('.option')) el.disabled = true;
    button.classList.add(right ? 'is-right' : 'is-wrong');
    if (!right) {
        // Always show the right answer, or a wrong guess teaches nothing.
        const options = [...$('quizOptions').querySelectorAll('.option')];
        const correctAt = question.options.indexOf(question.answer);
        options[correctAt]?.classList.add('is-right');
    }

    setTimeout(() => {
        state.quiz.at += 1;
        if (state.quiz.at < state.quiz.questions.length) renderQuestion();
        else finishQuiz();
    }, right ? 550 : 1400);
}

function finishQuiz() {
    const { right, questions } = state.quiz;
    $('quizBody').classList.add('hidden');
    $('quizResult').classList.remove('hidden');
    $('quizScore').textContent = `${right} / ${questions.length}`;
    $('quizVerdict').textContent = right === questions.length
        ? 'Every one. Come back tomorrow for a new word.'
        : right >= questions.length / 2
            ? 'Good going. The ones you missed will come round again.'
            : 'Worth another run: the words repeat until they stick.';
    markToday();
}

function startCloze(topic) {
    const pool = topic ? topic.words : reviewPool();
    const candidates = (topic ? topic.sentences : []).length
        ? topic.sentences
        : state.sentences.map((_, i) => i);

    for (let attempt = 0; attempt < 12; attempt += 1) {
        const index = candidates[Math.floor(Math.random() * candidates.length)];
        const cloze = buildCloze(state.sentences[index], pool, state.words, Math.random);
        if (cloze) {
            renderCloze(cloze);
            return;
        }
    }
}

function renderCloze(cloze) {
    state.quiz = { cloze, answered: false };
    $('quizTitle').textContent = 'Fill the gap';
    $('quizProgress').textContent = 'Press 1 to 4';
    openQuizPanel();

    const prompt = $('quizPrompt');
    prompt.replaceChildren();
    prompt.className = 'example-sl mb-2';
    for (const segment of cloze.segments) {
        if (segment.blank) {
            const gap = document.createElement('span');
            gap.className = 'cloze-gap';
            gap.textContent = ' ';
            prompt.append(gap);
        } else {
            prompt.append(document.createTextNode(segment.text));
        }
    }
    $('quizHint').textContent = cloze.english;

    const list = $('quizOptions');
    list.replaceChildren();
    cloze.options.forEach((index, position) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option';
        const key = document.createElement('span');
        key.className = 'option-key';
        key.textContent = String(position + 1);
        const label = document.createElement('span');
        label.textContent = state.words[index][0];
        button.append(key, label);
        button.addEventListener('click', () => {
            if (state.quiz.answered) return;
            state.quiz.answered = true;
            const right = index === cloze.answer;
            for (const el of list.querySelectorAll('.option')) el.disabled = true;
            button.classList.add(right ? 'is-right' : 'is-wrong');
            prompt.querySelector('.cloze-gap').textContent = state.words[cloze.answer][0];
            if (right) markToday();
            setTimeout(() => startCloze(currentTopic()), 1500);
        });
        li.append(button);
        list.append(li);
    });
}

function closeQuiz() {
    $('quizPanel').classList.add('hidden');
    $('topicsSection').classList.remove('hidden');
    $('quizPrompt').className =
        'font-display font-extrabold text-[clamp(1.8rem,6vw,3.2rem)] leading-[0.95] tracking-[-0.03em] mb-2';
    state.quiz = null;
}

/**
 * The options are numbered on screen, so the number keys have to work.
 * A visible key that does nothing is a worse affordance than no key at all.
 */
function answerByKeyboard(event) {
    if (!state.quiz || $('quizPanel').classList.contains('hidden')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const position = Number(event.key) - 1;
    if (!Number.isInteger(position) || position < 0 || position > 3) return;
    const button = $('quizOptions').querySelectorAll('.option')[position];
    if (button && !button.disabled) {
        event.preventDefault();
        button.click();
    }
}

// ------------------------------------------------------------------
//  Routing
// ------------------------------------------------------------------

function currentTopic() {
    const match = /^#topic\/(.+)$/.exec(location.hash);
    return match ? state.topics.find((t) => t.id === match[1]) : null;
}

function route() {
    const topic = currentTopic();
    const panel = $('topicPanel');
    if (topic) {
        renderTopic(topic);
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        panel.classList.add('hidden');
        closeQuiz();
    }
}

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

async function loadData() {
    const [words, sentences, topics, daily] = await Promise.all(
        ['words', 'sentences', 'topics', 'daily'].map(async (name) => {
            const response = await fetch(`data/${name}.json`);
            if (!response.ok) throw new Error(`${name}.json failed (${response.status})`);
            return response.json();
        }),
    );
    state.words = words.words;
    state.sentences = sentences.sentences;
    state.topics = topics.topics;
    state.daily = daily;
}

function showError(message) {
    $('loading').classList.add('hidden');
    $('error').classList.remove('hidden');
    $('errorText').textContent = message;
}

async function init() {
    setupTooltip();

    try {
        await loadData();
    } catch (err) {
        showError(`The word list didn't load (${err.message}). Refresh to try again.`);
        return;
    }

    state.days = readLocalDays();

    try {
        renderWordOfTheDay();
    } catch {
        showError('There is no word scheduled for today. The word list needs rebuilding.');
        return;
    }
    renderTopics();
    renderStreak();
    renderAuth(null);

    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');

    $('markDone').addEventListener('click', markToday);
    $('startDaily').addEventListener('click', () =>
        startQuiz(reviewPool(), DAILY_QUESTIONS, 'Quick quiz'));
    $('startTopicQuiz').addEventListener('click', () => {
        const topic = currentTopic();
        if (topic) startQuiz(topic.words, TOPIC_QUESTIONS, topic.title);
    });
    $('startCloze').addEventListener('click', () => startCloze(currentTopic()));
    $('quizAgain').addEventListener('click', () => {
        const topic = currentTopic();
        if (topic) startQuiz(topic.words, TOPIC_QUESTIONS, topic.title);
        else startQuiz(reviewPool(), DAILY_QUESTIONS, 'Quick quiz');
    });
    $('quizClose').addEventListener('click', closeQuiz);
    $('closeTopic').addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState(null, '', location.pathname);
        route();
    });
    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', answerByKeyboard);

    // Another tab (or the iliana widget) practised: pick it up.
    window.addEventListener('storage', (e) => {
        if (e.key !== STORE_KEY) return;
        state.days = readLocalDays();
        renderStreak();
    });

    route();
    syncStreak();
}

init();
