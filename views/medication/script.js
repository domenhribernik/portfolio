// Medication (views/medication): DOM wiring only. Every decision, date parse
// and count lives in logic.js, which is unit-tested by
// tests/medication-logic.test.mjs.

import { gatedFetch, loginUrl } from '../../components/auth-gate.js';
import {
    FORMS, formIcon, todayIso, shiftIso, fmtDate, toDateInput,
    buildDay, dayProgress, buildHistory, streak,
    takenSlots, nextSlotToTake, slotToUntake,
    validateMed, describeSchedule, MIN_DOSES, MAX_DOSES,
} from './logic.js';

const API = '../../app/controllers/medication-controller.php';
const WALL_DAYS = 14;

const $ = (id) => document.getElementById(id);

/** Everything the page draws from. `day` is the day being looked at, not always today. */
const state = {
    today: todayIso(),
    day: todayIso(),
    meds: [],
    taken: [],
    history: [],
    editing: null,   // the medication id being edited, or null for a new one
    form: 'tablet',
    doses: 1,
};

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
}

init();

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

async function init() {
    $('signinLink').href = loginUrl();
    $('retryBtn').addEventListener('click', () => { setPanel('loading'); load(); });
    wireTabs();
    wireDayStepper();
    wireForm();
    renderFormChips();
    await load();
}

async function load() {
    await gatedFetch(`${API}?resource=state&day=${state.day}&days=${WALL_DAYS}`, {}, {
        onSignedOut: () => setPanel('signin'),
        onForbidden: () => setPanel('noaccess'),
        onError: (msg) => { $('errorMsg').textContent = msg; setPanel('error'); },
        onOk: (data) => {
            adopt(data);
            setPanel('ready');
            renderAll();
        },
    });
}

function adopt(data) {
    state.meds = data.meds ?? [];
    state.taken = data.taken ?? [];
    state.history = data.history ?? [];
    state.day = data.day ?? state.day;
}

function setPanel(name) {
    document.body.className = document.body.className
        .replace(/\b(loading|signin|noaccess|error|ready)\b/g, '').trim() + ' ' + name;
}

/** A plain fetch for everything after the gate has already been passed. */
async function api(path, options = {}) {
    const res = await fetch(API + path, {
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
}

// ------------------------------------------------------------------
//  Chrome
// ------------------------------------------------------------------

function wireTabs() {
    for (const btn of document.querySelectorAll('[data-tab]')) {
        btn.addEventListener('click', () => showTab(btn.dataset.tab));
    }
    for (const btn of document.querySelectorAll('[data-goto]')) {
        btn.addEventListener('click', () => { showTab(btn.dataset.goto); openForm(null); });
    }
}

function showTab(name) {
    for (const btn of document.querySelectorAll('[data-tab]')) {
        btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    }
    $('tab-today').classList.toggle('active', name === 'today');
    $('tab-shelf').classList.toggle('active', name === 'shelf');
}

function wireDayStepper() {
    $('dayPrev').addEventListener('click', () => goToDay(shiftIso(state.day, -1)));
    $('dayNext').addEventListener('click', () => goToDay(shiftIso(state.day, 1)));
}

async function goToDay(day) {
    if (day > state.today) return;
    state.day = day;
    try {
        adopt(await api(`?resource=state&day=${day}&days=${WALL_DAYS}`));
        renderAll();
    } catch (e) {
        say(e.message, true);
    }
}

// ------------------------------------------------------------------
//  Render
// ------------------------------------------------------------------

function renderAll() {
    renderHeader();
    renderToday();
    renderWall();
    renderShelf();
}

function renderHeader() {
    $('todayStamp').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()
        + ' ' + toDateInput(state.today);
    $('streakBlock').hidden = state.meds.length === 0;
    $('streakNum').textContent = String(streak(state.meds, state.history, state.today));
}

function renderToday() {
    const isToday = state.day === state.today;
    $('dayLabel').textContent = isToday ? 'Today'
        : state.day === shiftIso(state.today, -1) ? 'Yesterday' : 'Earlier';
    $('dayDate').textContent = fmtDate(state.day);
    $('dayNext').disabled = isToday;

    const rows = buildDay(state.meds, state.taken, state.day);
    const { taken, planned, complete } = dayProgress(state.meds, state.taken, state.day);

    $('progressCount').textContent = planned ? `${taken} / ${planned}` : '';
    $('progressText').textContent = !planned ? 'Nothing scheduled'
        : complete ? 'All taken' : `${planned - taken} left to take`;
    $('progressFill').style.transform = `scaleX(${planned ? taken / planned : 0})`;
    $('progressBar').setAttribute('aria-valuenow', String(planned ? Math.round((taken / planned) * 100) : 0));

    const list = $('doseList');
    list.replaceChildren();
    for (const row of rows) list.append(doseRow(row));

    $('dayBlock').hidden = state.meds.length === 0;
    $('todayEmpty').classList.toggle('hidden', state.meds.length > 0);
    $('todayNone').classList.toggle('hidden', state.meds.length === 0 || rows.length > 0);
    $('wallBlock').classList.toggle('hidden', state.meds.length === 0);
}

function doseRow(row) {
    const el = document.createElement('div');
    el.className = 'dose-row' + (row.done ? ' done' : '');

    const glyph = document.createElement('i');
    glyph.className = `glyph ${row.formIcon}`;
    glyph.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'min-w-0';

    const name = document.createElement('p');
    name.className = 'dose-name font-semibold text-[1.05rem] leading-tight';
    name.textContent = row.name;

    const meta = document.createElement('p');
    meta.className = 'font-mono text-[0.66rem] text-stone mt-1';
    meta.textContent = [row.formLabel, row.schedule.toLowerCase(), row.lastAt && `last ${row.lastAt}`]
        .filter(Boolean).join(' · ');

    const notches = document.createElement('div');
    notches.className = 'notches';
    for (let i = 0; i < row.dosesPerDay; i++) {
        notches.append(notch(row, i));
    }

    body.append(name, meta, notches);
    el.append(glyph, body);
    return el;
}

function notch(row, index) {
    const lit = index < row.filled;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notch' + (lit ? ' on' : '');
    btn.dataset.medId = String(row.id);
    btn.setAttribute('aria-pressed', String(lit));
    btn.setAttribute('aria-label',
        `${row.name}, dose ${index + 1} of ${row.dosesPerDay}${lit ? ', taken' : ', not taken yet'}`);
    // Both states carry a check; the empty one is ghosted, so the notch says
    // what tapping it does instead of printing an ordinal nobody needs (the
    // slots are interchangeable, so numbering them would be a lie).
    btn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
    btn.addEventListener('click', () => toggleDose(row, lit, btn));
    return btn;
}

function renderWall() {
    const strip = buildHistory(state.meds, state.history, state.today, WALL_DAYS);
    const wall = $('wall');
    wall.replaceChildren();
    for (const day of strip) {
        const cell = document.createElement('span');
        const tone = day.planned === 0 ? 'none' : day.complete ? 'full' : day.taken > 0 ? 'part' : 'none';
        cell.className = `wall-cell ${tone}` + (day.day === state.today ? ' today' : '');
        cell.title = day.planned === 0
            ? `${fmtDate(day.day)} · nothing scheduled`
            : `${fmtDate(day.day)} · ${day.taken} of ${day.planned}`;
        wall.append(cell);
    }
}

function renderShelf() {
    const list = $('shelfList');
    list.replaceChildren();
    for (const med of state.meds) list.append(shelfRow(med));

    $('shelfEmpty').classList.toggle('hidden', state.meds.length > 0);
    $('shelfCount').textContent = state.meds.length
        ? `${state.meds.length} on the shelf` : '';
}

function shelfRow(med) {
    const ended = Boolean(med.ends_on && med.ends_on < state.today);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shelf-row' + (ended ? ' ended' : '');
    btn.setAttribute('aria-label', `Edit ${med.name}`);

    const glyph = document.createElement('i');
    glyph.className = `glyph ${formIcon(med.form)}`;
    glyph.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'min-w-0';

    const name = document.createElement('p');
    name.className = 'shelf-name font-semibold text-[1.02rem] leading-tight';
    name.textContent = med.name;

    const meta = document.createElement('p');
    meta.className = 'font-mono text-[0.64rem] text-stone mt-1';
    meta.textContent = [
        describeSchedule(med.doses_per_day).toLowerCase(),
        med.starts_on && `from ${toDateInput(med.starts_on)}`,
        med.ends_on && `${ended ? 'ended' : 'until'} ${toDateInput(med.ends_on)}`,
    ].filter(Boolean).join(' · ');

    const caret = document.createElement('i');
    caret.className = 'caret fa-solid fa-chevron-right text-xs';
    caret.setAttribute('aria-hidden', 'true');

    body.append(name, meta);
    btn.append(glyph, body, caret);
    btn.addEventListener('click', () => openForm(med));
    return btn;
}

// ------------------------------------------------------------------
//  Taking a dose
// ------------------------------------------------------------------

/**
 * Optimistic: the notch flips before the request goes out, because the whole
 * point of the page is that one tap is instant. The PUT is idempotent, so a
 * retry cannot double-count, and a failure rolls the notch back and says why.
 */
async function toggleDose(row, lit, btn) {
    const slots = takenSlots(state.taken, row.id);
    const slot = lit ? slotToUntake(slots) : nextSlotToTake(slots, row.dosesPerDay);
    if (slot === null) return;

    const before = state.taken;
    state.taken = lit
        ? state.taken.filter((r) => !(Number(r.med_id) === row.id && Number(r.slot) === slot))
        : [...state.taken, { med_id: row.id, slot, taken_at: stampNow() }];
    renderToday();

    if (!lit) {
        // Re-find the notch after the re-render and stamp the one just taken.
        const fresh = document.querySelectorAll(`.notch[data-med-id="${row.id}"]`);
        fresh[Math.min(row.filled, fresh.length - 1)]?.classList.add('stamp');
    }

    try {
        await api('?resource=dose', {
            method: 'PUT',
            body: JSON.stringify({ med_id: row.id, day: state.day, slot, taken: !lit }),
        });
        await refreshHistory();
    } catch (e) {
        state.taken = before;
        renderToday();
        say(`Couldn't save that dose. ${e.message}`, true);
    }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** A local 'yyyy-mm-dd hh:mm:ss' stamp, matching what the server will store. */
function stampNow(now = new Date()) {
    return `${state.day} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * The wall and the streak read from the server's grouped counts, so re-pull
 * them once the dose has landed. Deliberately does NOT re-render the dose list:
 * that would replace the notch mid-stamp, and the optimistic view already
 * matches what just came back.
 */
async function refreshHistory() {
    try {
        adopt(await api(`?resource=state&day=${state.day}&days=${WALL_DAYS}`));
        renderHeader();
        renderWall();
    } catch { /* the optimistic view is already correct; leave it */ }
}

// ------------------------------------------------------------------
//  The add / edit form
// ------------------------------------------------------------------

function renderFormChips() {
    const box = $('fForm');
    box.replaceChildren();
    for (const f of FORMS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(f.key === state.form));
        chip.dataset.form = f.key;
        chip.innerHTML = `<i class="${f.icon}" aria-hidden="true"></i>${f.label}`;
        chip.addEventListener('click', () => { state.form = f.key; renderFormChips(); });
        box.append(chip);
    }
}

function renderDoses() {
    $('dosesOut').textContent = String(state.doses);
    $('dosesHint').textContent = describeSchedule(state.doses);
    $('dosesDown').disabled = state.doses <= MIN_DOSES;
    $('dosesUp').disabled = state.doses >= MAX_DOSES;
}

function wireForm() {
    $('addBtn').addEventListener('click', () => openForm(null));
    $('cancelBtn').addEventListener('click', closeForm);
    $('dosesDown').addEventListener('click', () => { state.doses = Math.max(MIN_DOSES, state.doses - 1); renderDoses(); });
    $('dosesUp').addEventListener('click', () => { state.doses = Math.min(MAX_DOSES, state.doses + 1); renderDoses(); });
    $('medForm').addEventListener('submit', submitForm);
    $('deleteBtn').addEventListener('click', deleteMed);
    $('endBtn').addEventListener('click', endCourse);

    // Normalise a typed date back through the formatter on the way out of the
    // field, so what stays on screen is exactly what gets stored.
    for (const id of ['fStart', 'fEnd']) {
        $(id).addEventListener('change', () => {
            const iso = validateMed({ name: 'x', [id === 'fStart' ? 'starts_on' : 'ends_on']: $(id).value })
                .value[id === 'fStart' ? 'starts_on' : 'ends_on'];
            if (iso) $(id).value = toDateInput(iso);
        });
    }
}

function openForm(med) {
    state.editing = med ? med.id : null;
    state.form = med ? med.form : 'tablet';
    state.doses = med ? med.doses_per_day : 1;

    $('formTitle').textContent = med ? 'Edit medication' : 'New medication';
    $('fName').value = med ? med.name : '';
    $('fStart').value = med ? toDateInput(med.starts_on) : '';
    $('fEnd').value = med ? toDateInput(med.ends_on) : '';
    $('deleteBtn').hidden = !med;
    $('endBtn').hidden = !med || Boolean(med.ends_on);
    $('addBtn').hidden = true;

    clearErrors();
    renderFormChips();
    renderDoses();
    $('medForm').classList.remove('hidden');
    $('fName').focus();
    $('medForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeForm() {
    $('medForm').classList.add('hidden');
    $('addBtn').hidden = false;
    state.editing = null;
    clearErrors();
}

const FIELD_ERRORS = { name: 'eName', form: 'eForm', doses_per_day: 'eDoses', starts_on: 'eStart', ends_on: 'eEnd' };
const FIELD_INPUTS = { name: 'fName', starts_on: 'fStart', ends_on: 'fEnd' };

function clearErrors() {
    for (const id of Object.values(FIELD_ERRORS)) { $(id).hidden = true; $(id).textContent = ''; }
    for (const id of Object.values(FIELD_INPUTS)) $(id).removeAttribute('aria-invalid');
}

function showErrors(errors) {
    clearErrors();
    for (const [field, message] of Object.entries(errors)) {
        const box = $(FIELD_ERRORS[field]);
        if (box) { box.textContent = message; box.hidden = false; }
        if (FIELD_INPUTS[field]) $(FIELD_INPUTS[field]).setAttribute('aria-invalid', 'true');
    }
    const first = Object.keys(errors).find((f) => FIELD_INPUTS[f]);
    if (first) $(FIELD_INPUTS[first]).focus();
}

async function submitForm(event) {
    event.preventDefault();

    const check = validateMed({
        name: $('fName').value,
        form: state.form,
        doses_per_day: state.doses,
        starts_on: $('fStart').value,
        ends_on: $('fEnd').value,
    });
    if (!check.ok) { showErrors(check.errors); return; }

    const editing = state.editing;
    await busy($('saveBtn'), async () => {
        await api(editing ? `?resource=med&id=${editing}` : '?resource=med', {
            method: editing ? 'PUT' : 'POST',
            body: JSON.stringify(check.value),
        });
        closeForm();
        await load();
        say(editing ? 'Saved.' : `${check.value.name} added.`);
    });
}

async function deleteMed() {
    const med = state.meds.find((m) => m.id === state.editing);
    if (!med) return;
    if (!confirm(`Delete ${med.name}? Its history goes too. To stop a course but keep the record, set an end date instead.`)) return;

    await busy($('deleteBtn'), async () => {
        await api(`?resource=med&id=${med.id}`, { method: 'DELETE' });
        closeForm();
        await load();
        say(`${med.name} deleted.`);
    });
}

/** Finish a course today: it drops off the Today view and keeps its history. */
async function endCourse() {
    const med = state.meds.find((m) => m.id === state.editing);
    if (!med) return;

    await busy($('endBtn'), async () => {
        await api(`?resource=med&id=${med.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: med.name,
                form: med.form,
                doses_per_day: med.doses_per_day,
                starts_on: med.starts_on,
                ends_on: state.today,
            }),
        });
        closeForm();
        await load();
        say(`${med.name} ends today.`);
    });
}

/** Run an action with the button visibly out of service, and surface failures. */
async function busy(btn, action) {
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
        await action();
    } catch (e) {
        say(e.message, true);
    } finally {
        btn.disabled = false;
        btn.classList.remove('is-busy');
    }
}

// ------------------------------------------------------------------
//  Status line
// ------------------------------------------------------------------

let sayTimer = null;

function say(message, bad = false) {
    const el = $('status');
    el.textContent = message;
    el.classList.toggle('bad', bad);
    el.classList.add('show');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => el.classList.remove('show'), bad ? 6000 : 2600);
}
