// DOM-free logic for Medication (views/medication), the private admin-only
// medication tracker. Unit-tested by tests/medication-logic.test.mjs
// (node --test tests/). The page's script.js imports this as an ES module and
// does nothing but wire it to the DOM.

const pad2 = (n) => String(n).padStart(2, '0');

/** Today as ISO yyyy-mm-dd in the viewer's own timezone, not UTC. */
export function todayIso(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * An ISO day shifted by whole days. Anchored in UTC on purpose: local-time
 * arithmetic lands back on the same date across a DST boundary.
 */
export function shiftIso(iso, deltaDays) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A typed date to ISO yyyy-mm-dd, or null when it isn't a real day.
 *
 * Course dates are plain text inputs, not <input type="date">, because a
 * native date field renders in the BROWSER's locale: a US-locale browser draws
 * mm/dd/yyyy and swaps day and month on the way in. Accepted here: dd.mm.yyyy
 * (also with / or - separators and stray spaces), a bare ddmmyyyy digit run for
 * numeric keypads, and ISO yyyy-mm-dd so a pasted machine date still lands.
 *
 * Ported from parseDateSl() in views/stocks/logic.js, the site's reference pair.
 */
export function parseDateInput(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return null;

    let y, m, d;
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const dmy = raw.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})\.?$/);
    const digits = raw.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (iso) [, y, m, d] = iso;
    else if (dmy) [, d, m, y] = dmy;
    else if (digits) [, d, m, y] = digits;
    else return null;

    [y, m, d] = [Number(y), Number(m), Number(d)];
    // Round-trip through UTC so 31.02. and friends are rejected, not rolled.
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** ISO yyyy-mm-dd to the dd.mm.yyyy string a date field carries; '' if unset. */
export function toDateInput(iso) {
    const m = String(iso ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** ISO yyyy-mm-dd as spaced, unpadded prose: '8. 9. 2026'. '' if unset. */
export function fmtDate(iso) {
    const m = String(iso ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : '';
}

/**
 * The closed set of shapes a medication can take. `key` is what the wire and
 * the `form` column carry; the PHP allowlist in medication-controller.php
 * mirrors this list and must be edited alongside it. The icon is a FontAwesome
 * class, and its only job is to make the shelf scannable at a glance.
 */
export const FORMS = [
    { key: 'tablet', label: 'Tablet', icon: 'fa-solid fa-tablets' },
    { key: 'capsule', label: 'Capsule', icon: 'fa-solid fa-capsules' },
    { key: 'drops', label: 'Drops', icon: 'fa-solid fa-droplet' },
    { key: 'spray', label: 'Spray', icon: 'fa-solid fa-spray-can' },
    { key: 'injection', label: 'Injection', icon: 'fa-solid fa-syringe' },
    { key: 'other', label: 'Other', icon: 'fa-solid fa-prescription-bottle-medical' },
];

const FALLBACK_FORM = FORMS[FORMS.length - 1];

/** The FORMS entry for a key, degrading to 'other' rather than blanking a row. */
export function formOf(key) {
    return FORMS.find((f) => f.key === key) ?? FALLBACK_FORM;
}

export function formLabel(key) {
    return formOf(key).label;
}

export function formIcon(key) {
    return formOf(key).icon;
}

/**
 * Is this medication part of the given day's schedule?
 *
 * The window runs from `starts_on` to `ends_on`, both inclusive and both
 * optional. When `starts_on` is unset it falls back to `created_on`, the day
 * the row was added: without that fallback the history strip reports missed
 * doses for every day before the medication existed, and a fresh shelf can
 * never build a streak.
 */
export function isActiveOn(med, dayIso) {
    const start = med.starts_on || med.created_on || null;
    if (start && dayIso < start) return false;
    if (med.ends_on && dayIso > med.ends_on) return false;
    return true;
}

/** The shelf narrowed to what is actually scheduled on a given day. */
export function activeMeds(meds, dayIso) {
    return meds.filter((med) => isActiveOn(med, dayIso));
}

// --- The notch counter -----------------------------------------------------
//
// A dose row exists in medication_doses iff that slot was taken, and slots are
// interchangeable ("three times a day, tick any"). So a medication's row on the
// Today view is a COUNTER with N notches, not N addressable checkboxes: notch i
// is lit iff i < the number of doses taken. Tapping an empty notch takes the
// lowest free slot and tapping a lit one releases the highest, which keeps the
// display gapless and quietly repairs a gap left by an edited schedule.

/** One medication's taken slot numbers on the loaded day, ascending. */
export function takenSlots(taken, medId) {
    return taken
        .filter((row) => Number(row.med_id) === Number(medId))
        .map((row) => Number(row.slot))
        .sort((a, b) => a - b);
}

/** The slot a tap should take: the lowest free one, or null at the cap. */
export function nextSlotToTake(slots, dosesPerDay) {
    for (let i = 0; i < dosesPerDay; i++) {
        if (!slots.includes(i)) return i;
    }
    return null;
}

/** The slot a tap should release: the highest taken one, or null if none. */
export function slotToUntake(slots) {
    return slots.length === 0 ? null : Math.max(...slots);
}

/** How many notches to draw lit, never more than the row has. */
export function filledNotches(slots, dosesPerDay) {
    return Math.min(slots.length, dosesPerDay);
}

/** The most recent taken_at for a medication on the loaded day, or null. */
export function lastTakenAt(taken, medId) {
    const stamps = taken
        .filter((row) => Number(row.med_id) === Number(medId))
        .map((row) => row.taken_at)
        .filter(Boolean)
        .sort();
    return stamps.length ? stamps[stamps.length - 1] : null;
}

/** A 'yyyy-mm-dd hh:mm:ss' stamp as the wall clock 'hh:mm'; '' if unset. */
export function fmtClock(stamp) {
    const m = String(stamp ?? '').match(/[T ](\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
}

/** 'Once a day' / 'Twice a day' / 'N times a day'. */
export function describeSchedule(n) {
    if (n === 1) return 'Once a day';
    if (n === 2) return 'Twice a day';
    return `${n} times a day`;
}

/**
 * How the day stands: doses taken over doses planned.
 *
 * Both sides are computed from the medications scheduled on that day, so a
 * finished course leaves the ledger entirely rather than showing as a permanent
 * miss, and a stray row belonging to one cannot inflate the numerator. Each
 * medication's contribution is capped at its own dose count, so cutting a
 * schedule from 2 to 1 can never read as 2 / 1.
 */
export function dayProgress(meds, taken, dayIso) {
    const scheduled = activeMeds(meds, dayIso);
    let planned = 0;
    let done = 0;
    for (const med of scheduled) {
        const per = Number(med.doses_per_day);
        planned += per;
        done += filledNotches(takenSlots(taken, med.id), per);
    }
    return { taken: done, planned, complete: planned > 0 && done >= planned };
}

/**
 * One render-ready row per medication scheduled on the given day. The view does
 * no deciding of its own: it draws `filled` lit notches out of `dosesPerDay`
 * and prints the strings already resolved here.
 */
export function buildDay(meds, taken, dayIso) {
    return activeMeds(meds, dayIso).map((med) => {
        const per = Number(med.doses_per_day);
        const slots = takenSlots(taken, med.id);
        const filled = filledNotches(slots, per);
        return {
            id: med.id,
            name: med.name,
            form: med.form,
            formLabel: formLabel(med.form),
            formIcon: formIcon(med.form),
            dosesPerDay: per,
            schedule: describeSchedule(per),
            slots,
            filled,
            done: filled >= per,
            lastAt: fmtClock(lastTakenAt(taken, med.id)),
        };
    });
}

/**
 * The last `days` days ending on `endDayIso`, oldest first, each scored against
 * what was actually scheduled then.
 *
 * `history` arrives from the server grouped as one row per day per medication
 * ({ day, med_id, taken }). The capping and the denominator are worked out here
 * rather than in SQL so the active-course rules live in one place: restating
 * isActiveOn() in a query is how the two quietly drift apart.
 */
export function buildHistory(meds, history, endDayIso, days) {
    const counts = new Map();
    for (const row of history) {
        counts.set(`${row.day}|${row.med_id}`, Number(row.taken));
    }

    const strip = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = shiftIso(endDayIso, -i);
        let planned = 0;
        let taken = 0;
        for (const med of activeMeds(meds, day)) {
            const per = Number(med.doses_per_day);
            planned += per;
            taken += Math.min(counts.get(`${day}|${med.id}`) ?? 0, per);
        }
        strip.push({ day, taken, planned, complete: planned > 0 && taken >= planned });
    }
    return strip;
}

/**
 * Consecutive complete days ending at today.
 *
 * Today is still open: an incomplete today is stepped over rather than counted,
 * so opening the app in the morning with the evening dose outstanding does not
 * read as a broken run. Any earlier incomplete day ends it. A day with nothing
 * scheduled (before the first medication, or between two courses) is neither
 * counted nor treated as a miss.
 */
export function streak(meds, history, todayIsoDay, window = 400) {
    const strip = buildHistory(meds, history, todayIsoDay, window);
    let run = 0;
    for (let i = strip.length - 1; i >= 0; i--) {
        const day = strip[i];
        if (day.planned === 0) continue;
        if (day.complete) {
            run++;
            continue;
        }
        if (day.day === todayIsoDay) continue;
        break;
    }
    return run;
}

export const MAX_NAME = 100;
export const MIN_DOSES = 1;
export const MAX_DOSES = 12;

/**
 * Check and normalise a medication straight off the form.
 *
 * `value` is the payload to send; `errors` is keyed by field so the form can
 * ink the offending input. validateMed() in medication-controller.php enforces
 * the same rules, because a client-side check is a courtesy and never a gate:
 * these two must be edited together.
 */
export function validateMed(input) {
    const errors = {};

    const name = String(input.name ?? '').trim();
    if (name === '') errors.name = 'Give it a name.';
    else if (name.length > MAX_NAME) errors.name = `Keep the name under ${MAX_NAME} characters.`;

    const form = input.form == null || input.form === '' ? 'tablet' : String(input.form);
    if (!FORMS.some((f) => f.key === form)) errors.form = 'Pick a form from the list.';

    const rawDoses = input.doses_per_day == null || input.doses_per_day === '' ? 1 : Number(input.doses_per_day);
    if (!Number.isInteger(rawDoses) || rawDoses < MIN_DOSES || rawDoses > MAX_DOSES) {
        errors.doses_per_day = `Doses a day has to be a whole number between ${MIN_DOSES} and ${MAX_DOSES}.`;
    }

    // An unreadable date is an error, never a silent null: dropping it would
    // read as "no end date" and keep a finished course on the list for ever.
    const dates = {};
    for (const field of ['starts_on', 'ends_on']) {
        const raw = String(input[field] ?? '').trim();
        if (raw === '') {
            dates[field] = null;
            continue;
        }
        const iso = parseDateInput(raw);
        if (iso === null) errors[field] = 'Use a date like 08.09.2026.';
        dates[field] = iso;
    }
    if (!errors.starts_on && !errors.ends_on && dates.starts_on && dates.ends_on && dates.ends_on < dates.starts_on) {
        errors.ends_on = 'The course cannot end before it starts.';
    }

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        value: { name, form, doses_per_day: rawDoses, starts_on: dates.starts_on, ends_on: dates.ends_on },
    };
}
