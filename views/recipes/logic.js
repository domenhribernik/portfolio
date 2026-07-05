// DOM-free decision logic for the recipes view, unit-tested by
// tests/recipes-logic.test.mjs (run: node --test tests/).
//
// Step bodies may contain {ing:K} tokens, where K is a per-recipe ingredient
// key assigned by the editor (recipe_ingredients.ing_key). Keys are stable
// across saves, unlike DB row ids, which the atomic save rewrites.

const TOKEN_RE = /\{ing:(\d+)\}/g;

/**
 * Split a step body into text and ingredient-token parts.
 * Malformed tokens ({ing:}, {ing:9x}) stay plain text.
 * @returns {Array<{type:'text',text:string}|{type:'ing',key:number}>}
 */
export function parseTokens(body) {
    const parts = [];
    const s = String(body ?? '');
    let last = 0;
    for (const match of s.matchAll(TOKEN_RE)) {
        if (match.index > last) parts.push({ type: 'text', text: s.slice(last, match.index) });
        parts.push({ type: 'ing', key: Number(match[1]) });
        last = match.index + match[0].length;
    }
    if (last < s.length) parts.push({ type: 'text', text: s.slice(last) });
    return parts;
}

/** Keys of every ingredient referenced by any step body. */
export function usedIngredientKeys(steps) {
    const used = new Set();
    for (const step of steps ?? []) {
        for (const part of parseTokens(step.body)) {
            if (part.type === 'ing') used.add(part.key);
        }
    }
    return used;
}

/** Next free ingredient key: one past the highest key ever used in this draft. */
export function nextIngKey(ingredients) {
    let max = 0;
    for (const ing of ingredients ?? []) {
        if (Number.isFinite(ing.key) && ing.key > max) max = ing.key;
    }
    return max + 1;
}

/** Replace an ingredient's tokens with its plain name (used when deleting it). */
export function replaceTokenWithText(body, key, name) {
    return String(body ?? '').replaceAll(`{ing:${key}}`, String(name ?? ''));
}

/** Remove tokens whose key is not in validKeys (mirror of the PHP function). */
export function stripDanglingTokens(body, validKeys) {
    return String(body ?? '').replace(TOKEN_RE, (token, key) =>
        validKeys.has(Number(key)) ? token : ''
    );
}

/**
 * Validate an editor draft: {title, description, ingredients:[{key,name,quantity}],
 * steps:[{body, minutes}]}. Returns a list of human-readable problems (empty = valid).
 */
export function validateDraft(draft) {
    const errors = [];
    const title = String(draft.title ?? '').trim();
    if (title === '') errors.push('Give the recipe a title');
    else if (title.length > 150) errors.push('Title must be 150 characters or less');
    if (String(draft.description ?? '').trim().length > 1000) {
        errors.push('Description must be 1000 characters or less');
    }

    const ingredients = (draft.ingredients ?? []).filter(i => String(i.name ?? '').trim() !== '');
    if (ingredients.length === 0) errors.push('Add at least one ingredient');
    if (ingredients.length > 100) errors.push('Too many ingredients (max 100)');
    for (const ing of ingredients) {
        if (String(ing.name).trim().length > 100) { errors.push('Ingredient names must be 100 characters or less'); break; }
    }
    for (const ing of ingredients) {
        if (String(ing.quantity ?? '').trim().length > 50) { errors.push('Ingredient quantities must be 50 characters or less'); break; }
    }

    const steps = (draft.steps ?? []).filter(s => String(s.body ?? '').trim() !== '');
    if (steps.length === 0) errors.push('Add at least one step');
    if (steps.length > 100) errors.push('Too many steps (max 100)');
    for (const step of steps) {
        if (String(step.body).trim().length > 2000) { errors.push('Steps must be 2000 characters or less'); break; }
    }
    for (const step of steps) {
        const m = parseMinutes(step.minutes);
        if (m !== null && (m <= 0 || m > 1440)) { errors.push('Step durations must be between 1 minute and 24 hours'); break; }
    }
    return errors;
}

/** A minutes input's value as a number, or null when blank/absent. */
function parseMinutes(value) {
    const s = String(value ?? '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * Turn a valid draft into the request payload the controller expects.
 * Skips blank ingredient/step rows, converts minutes to duration_seconds,
 * and strips tokens that point at skipped (blank) ingredients.
 */
export function buildPayload(draft) {
    const ingredients = (draft.ingredients ?? [])
        .filter(i => String(i.name ?? '').trim() !== '')
        .map(i => ({
            key: i.key,
            name: String(i.name).trim(),
            quantity: String(i.quantity ?? '').trim(),
        }));
    const validKeys = new Set(ingredients.map(i => i.key));
    const steps = (draft.steps ?? [])
        .filter(s => String(s.body ?? '').trim() !== '')
        .map(s => {
            const minutes = parseMinutes(s.minutes);
            return {
                body: stripDanglingTokens(String(s.body).trim(), validKeys),
                duration_seconds: minutes === null ? null : Math.round(minutes * 60),
            };
        });
    return {
        title: String(draft.title ?? '').trim(),
        description: String(draft.description ?? '').trim(),
        ingredients,
        steps,
    };
}

/** Seconds as MM:SS (floors, clamps below at 0). Over an hour: H:MM:SS. */
export function fmtTimer(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mmss = `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
    return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Remaining whole seconds until endAt, and whether the timer is done. */
export function timerState(endAt, now) {
    const remaining = Math.max(0, Math.ceil((endAt - now) / 1000));
    return { remaining, done: remaining === 0 };
}

// --- Cooking session (pure index math; timer endAt lives in the caller) ---

export function createCookSession(steps) {
    return { total: (steps ?? []).length, index: 0 };
}

export function advance(session) {
    return { ...session, index: Math.min(session.index + 1, session.total - 1) };
}

export function back(session) {
    return { ...session, index: Math.max(session.index - 1, 0) };
}

export function isLastStep(session) {
    return session.total === 0 || session.index >= session.total - 1;
}

// --- Star display ---

/** Five-slot fill pattern for an average, rounded to the nearest half star. */
export function starFill(avg) {
    const halves = Math.round(Math.min(5, Math.max(0, Number(avg) || 0)) * 2);
    return Array.from({ length: 5 }, (_, i) => {
        if (halves >= (i + 1) * 2) return 'full';
        if (halves === i * 2 + 1) return 'half';
        return 'empty';
    });
}

/** Compact rating label for cards and headers. */
export function avgLabel(avg, count) {
    if (!count) return 'No ratings yet';
    const n = Number(avg) || 0;
    const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `${shown} (${count})`;
}
