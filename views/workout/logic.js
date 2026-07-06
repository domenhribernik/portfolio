// DOM-free decision logic for the workout view, unit-tested by
// tests/workout-logic.test.mjs (node --test). Keep this file free of any
// browser globals so node can import it directly.

// Which metric fields each exercise type uses. Field names match the DB
// columns minus the target_/actual_ prefix.
export const TYPE_FIELDS = {
    reps: ['reps'],
    weighted: ['reps', 'weight_kg'],
    time: ['seconds'],
    distance: ['distance_m', 'pace_s_per_km'],
};

export const TYPE_LABELS = {
    reps: 'Reps',
    weighted: 'Weighted',
    time: 'Time',
    distance: 'Distance',
};

// Stepper increments and bounds per field, mirrored by the server's
// normalizeMetrics() validation in workout-controller.php.
const FIELD_STEPS = {
    reps: { step: 1, min: 1, max: 1000 },
    weight_kg: { step: 2.5, min: 0, max: 9999.9 },
    seconds: { step: 5, min: 5, max: 86400 },
    distance_m: { step: 50, min: 50, max: 1000000 },
    pace_s_per_km: { step: 5, min: 120, max: 3600 },
};

// --- Formatting ---

/** 'm:ss' or 'mm:ss' pace string to whole seconds per km, or null. */
export function parsePace(text) {
    if (typeof text !== 'string') return null;
    const match = text.trim().match(/^(\d{1,3}):([0-5]\d)$/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/** Seconds per km to 'm:ss', or '' for null/invalid. */
export function formatPace(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Seconds to a compact clock label: 45 -> '0:45', 3900 -> '1:05:00'. */
export function formatSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + rest;
    return m + ':' + rest;
}

/** Meters to '500 m' or '1.2 km'. */
export function formatDistance(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return '';
    if (meters < 1000) return meters + ' m';
    const km = meters / 1000;
    return (Number.isInteger(km) ? km : km.toFixed(1)) + ' km';
}

/** Kilograms without trailing '.0': 30 -> '30', 32.5 -> '32.5'. */
export function formatWeight(kg) {
    if (!Number.isFinite(kg) || kg < 0) return '';
    return Number.isInteger(kg) ? String(kg) : String(Math.round(kg * 10) / 10);
}

/**
 * One-line target description of a workout item (or of an actuals object with
 * the same field names): '10 reps', '10 x 30 kg', '0:45', '500 m @ 4:35/km'.
 */
export function metricLabel(type, values, prefix = 'target_') {
    const v = (field) => values[prefix + field];
    switch (type) {
        case 'reps':
            return v('reps') + ' reps';
        case 'weighted':
            return v('reps') + ' x ' + formatWeight(v('weight_kg')) + ' kg';
        case 'time':
            return formatSeconds(v('seconds'));
        case 'distance': {
            const pace = v('pace_s_per_km');
            return formatDistance(v('distance_m')) + (pace ? ' @ ' + formatPace(pace) + '/km' : '');
        }
        default:
            return '';
    }
}

export function targetLabel(item) {
    return metricLabel(item.type, item, 'target_');
}

// --- Player state ---

/** Key for one set (exercise X in round N) in the player state object. */
export function setKey(exerciseId, round) {
    return exerciseId + ':' + round;
}

/** Stepper: next value for a field, clamped to its bounds. dir is +1 or -1. */
export function stepValue(field, value, dir) {
    const spec = FIELD_STEPS[field];
    if (!spec) return value;
    const base = Number.isFinite(value) ? value : spec.min;
    const next = Math.round((base + dir * spec.step) * 10) / 10;
    return Math.min(spec.max, Math.max(spec.min, next));
}

/** Starting actuals for one item, prefilled from its targets. */
export function defaultActuals(item) {
    const actuals = {};
    for (const field of TYPE_FIELDS[item.type] || []) {
        const target = item['target_' + field];
        if (field === 'pace_s_per_km') {
            actuals[field] = target ?? null; // pace stays optional
        } else {
            actuals[field] = target ?? FIELD_STEPS[field].min;
        }
    }
    return actuals;
}

/** Fresh player state: every (item, round) gets default actuals, not done. */
export function initState(items, rounds) {
    const state = {};
    for (const item of items) {
        for (let round = 1; round <= rounds; round++) {
            state[setKey(item.exercise_id, round)] = {
                done: false,
                actuals: defaultActuals(item),
            };
        }
    }
    return state;
}

/**
 * Player state restored from an open session payload ({rounds, sets}): logged
 * sets come back done with their saved actuals, the rest stay defaults.
 */
export function restoreState(openSession, items) {
    const state = initState(items, openSession.rounds);
    for (const set of openSession.sets || []) {
        const key = setKey(set.exercise_id, set.round_number);
        if (!state[key]) continue; // exercise no longer in the workout
        const actuals = {};
        for (const field of TYPE_FIELDS[set.type] || []) {
            actuals[field] = set['actual_' + field];
        }
        state[key] = { done: true, actuals };
    }
    return state;
}

/** {done, total, pct} across the whole player state. */
export function progress(state, items, rounds) {
    const total = items.length * rounds;
    let done = 0;
    for (const item of items) {
        for (let round = 1; round <= rounds; round++) {
            if (state[setKey(item.exercise_id, round)]?.done) done++;
        }
    }
    return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** True when every round of one exercise is done. */
export function exerciseDone(state, exerciseId, rounds) {
    for (let round = 1; round <= rounds; round++) {
        if (!state[setKey(exerciseId, round)]?.done) return false;
    }
    return true;
}

/** Body for POST sessions&action=log: only the fields the type uses. */
export function buildSetPayload(item, round, actuals) {
    const payload = { exercise_id: item.exercise_id, round_number: round };
    for (const field of TYPE_FIELDS[item.type] || []) {
        const value = actuals[field];
        if (value !== null && value !== undefined) payload['actual_' + field] = value;
    }
    return payload;
}

/** Done-banner summary: one line per exercise with its per-round actuals. */
export function summaryLines(items, state, rounds) {
    return items.map((item) => {
        const parts = [];
        for (let round = 1; round <= rounds; round++) {
            const entry = state[setKey(item.exercise_id, round)];
            if (entry?.done) parts.push(metricLabel(item.type, entry.actuals, ''));
        }
        return { name: item.name, detail: parts.join(' / ') || 'skipped' };
    });
}

/** Whole seconds left on a countdown started at startedMs from fromSeconds. */
export function countdownRemaining(startedMs, fromSeconds, nowMs) {
    const elapsed = Math.floor((nowMs - startedMs) / 1000);
    return Math.max(0, fromSeconds - elapsed);
}

// --- Draft validation (mirrors workout-controller.php rules) ---

function metricErrors(type, values, prefix, errors) {
    const v = (field) => values[prefix + field];
    if (type === 'reps' || type === 'weighted') {
        const reps = v('reps');
        if (!Number.isInteger(reps) || reps < 1 || reps > 1000) errors.push('Reps must be between 1 and 1000');
        if (type === 'weighted') {
            const weight = v('weight_kg');
            if (!Number.isFinite(weight) || weight < 0 || weight > 9999.9) errors.push('Weight must be between 0 and 9999.9 kg');
        }
    } else if (type === 'time') {
        const seconds = v('seconds');
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) errors.push('Duration must be between 1 second and 24 hours');
    } else if (type === 'distance') {
        const distance = v('distance_m');
        if (!Number.isInteger(distance) || distance < 1 || distance > 1000000) errors.push('Distance must be between 1 m and 1000 km');
        const pace = v('pace_s_per_km');
        if (pace !== null && pace !== undefined && (!Number.isInteger(pace) || pace < 60 || pace > 3600)) {
            errors.push('Pace must be between 1:00 and 60:00 per km');
        }
    } else {
        errors.push('Unknown exercise type');
    }
}

/**
 * Validate a workout draft {name, rounds, items:[{exercise_id, type, target_*}]}
 * before sending it. Returns a list of error strings, empty when valid.
 */
export function validateWorkoutDraft(draft) {
    const errors = [];
    const name = (draft.name || '').trim();
    if (name === '') errors.push('Name is required');
    if (name.length > 100) errors.push('Name must be 100 characters or less');
    if ((draft.description || '').trim().length > 500) errors.push('Description must be 500 characters or less');
    if (!Number.isInteger(draft.rounds) || draft.rounds < 1 || draft.rounds > 10) {
        errors.push('Rounds must be between 1 and 10');
    }

    const items = draft.items || [];
    if (items.length < 1) errors.push('Add at least one exercise');
    if (items.length > 30) errors.push('A workout can have at most 30 exercises');

    const seen = new Set();
    items.forEach((item, index) => {
        if (seen.has(item.exercise_id)) {
            errors.push(item.name + ' appears more than once');
            return;
        }
        seen.add(item.exercise_id);
        const before = errors.length;
        metricErrors(item.type, item, 'target_', errors);
        for (let i = before; i < errors.length; i++) {
            errors[i] = (item.name || 'Exercise ' + (index + 1)) + ': ' + errors[i];
        }
    });
    return errors;
}

/** Validate an exercise draft {name, type, icon, note}. Empty list = valid. */
export function validateExerciseDraft(draft) {
    const errors = [];
    const name = (draft.name || '').trim();
    if (name === '') errors.push('Name is required');
    if (name.length > 100) errors.push('Name must be 100 characters or less');
    if (!TYPE_FIELDS[draft.type]) errors.push('Pick a type');
    const icon = (draft.icon || '').trim();
    if (icon !== '' && !/^[a-z0-9 \-]{1,50}$/i.test(icon)) errors.push('Icon must be FontAwesome classes');
    if ((draft.note || '').trim().length > 500) errors.push('Note must be 500 characters or less');
    return errors;
}
