//? Pure computation for the SEO checklist (views/seo). No DOM: script.js
//? renders what these functions decide. Tested by tests/seo-logic.test.mjs,
//? which also validates the committed checklist.json against this schema.

export const STATUS_VALUES = ['done', 'partial', 'todo', 'na', 'unknown'];
export const TIER_VALUES = ['flagship', 'public', 'private'];

//? Flagship pages matter three times as much as ordinary public pages when
//? ranking what to fix next; private tools barely matter (their rows exist
//? to assert the noindex state, not to be optimized).
export const TIER_WEIGHT = { flagship: 3, public: 1, private: 0.5 };

//? How much of the credit each status earns toward a page's score.
const STATUS_SCORE = { done: 1, partial: 0.5, todo: 0, unknown: 0 };

//? Cycle order for the click-to-edit cells in the UI.
export function nextStatus(status) {
    const order = ['todo', 'partial', 'done', 'na', 'unknown'];
    return order[(order.indexOf(status) + 1) % order.length];
}

//? Weighted completion of one page, 0..1, ignoring `na` cells.
//? Returns null when every requirement is `na` (nothing to score).
export function pageScore(page, requirements) {
    let earned = 0;
    let possible = 0;
    for (const req of requirements) {
        const status = page.status[req.id];
        if (status === undefined || status === 'na') continue;
        possible += req.weight;
        earned += req.weight * (STATUS_SCORE[status] ?? 0);
    }
    return possible === 0 ? null : earned / possible;
}

//? Weighted completion across a set of pages (tier-weighted, na excluded).
export function overallScore(pages, requirements) {
    let earned = 0;
    let possible = 0;
    for (const page of pages) {
        const tierWeight = TIER_WEIGHT[page.tier] ?? 1;
        for (const req of requirements) {
            const status = page.status[req.id];
            if (status === undefined || status === 'na') continue;
            possible += req.weight * tierWeight;
            earned += req.weight * tierWeight * (STATUS_SCORE[status] ?? 0);
        }
    }
    return possible === 0 ? null : earned / possible;
}

//? How one requirement stands across all pages.
export function requirementCoverage(reqId, pages) {
    const counts = { done: 0, partial: 0, todo: 0, na: 0, unknown: 0, missing: 0 };
    for (const page of pages) {
        const status = page.status[reqId];
        if (status === undefined) counts.missing++;
        else counts[status]++;
    }
    counts.owed = counts.partial + counts.todo + counts.unknown;
    return counts;
}

//? Ranked list of the most valuable next fixes. Urgency is tier weight times
//? requirement weight; `partial` and `unknown` cells count at half urgency
//? (partially done, or merely unmeasured, beats untouched).
export function nextActions(pages, requirements, n = 10) {
    const actions = [];
    for (const page of pages) {
        const tierWeight = TIER_WEIGHT[page.tier] ?? 1;
        for (const req of requirements) {
            const status = page.status[req.id];
            if (status !== 'todo' && status !== 'partial' && status !== 'unknown') continue;
            const damp = status === 'todo' ? 1 : 0.5;
            actions.push({
                path: page.path,
                name: page.name,
                requirement: req.id,
                label: req.label,
                status,
                note: page.notes?.[req.id] || '',
                urgency: tierWeight * req.weight * damp,
            });
        }
    }
    actions.sort((a, b) => b.urgency - a.urgency || a.path.localeCompare(b.path));
    return actions.slice(0, n);
}

//? Filter for the UI pills. Every criterion is optional; `requirement` alone
//? keeps pages that still owe that requirement.
export function filterPages(pages, { tier, status, requirement } = {}) {
    return pages.filter((page) => {
        if (tier && page.tier !== tier) return false;
        if (requirement && status) return page.status[requirement] === status;
        if (requirement) {
            const s = page.status[requirement];
            return s === 'todo' || s === 'partial' || s === 'unknown';
        }
        if (status) return Object.values(page.status).includes(status);
        return true;
    });
}

//? Schema validation for checklist.json. Returns a list of human-readable
//? problems; empty means valid. The test suite runs this against the real
//? committed file so it can never drift invalid.
export function validateChecklist(doc) {
    const errors = [];
    if (!doc || typeof doc !== 'object') return ['checklist is not an object'];
    if (!Array.isArray(doc.requirements) || doc.requirements.length === 0) {
        errors.push('requirements must be a non-empty array');
        return errors;
    }
    const reqIds = new Set();
    for (const req of doc.requirements) {
        if (!req.id || typeof req.id !== 'string') errors.push('requirement missing id');
        else if (reqIds.has(req.id)) errors.push(`duplicate requirement id: ${req.id}`);
        else reqIds.add(req.id);
        if (!req.label) errors.push(`requirement ${req.id}: missing label`);
        if (typeof req.weight !== 'number' || req.weight <= 0) {
            errors.push(`requirement ${req.id}: weight must be a positive number`);
        }
    }
    if (!Array.isArray(doc.pages) || doc.pages.length === 0) {
        errors.push('pages must be a non-empty array');
        return errors;
    }
    const paths = new Set();
    for (const page of doc.pages) {
        const id = page.path || '(missing path)';
        if (!page.path) errors.push('page missing path');
        else if (paths.has(page.path)) errors.push(`duplicate page path: ${page.path}`);
        else paths.add(page.path);
        if (!page.name) errors.push(`${id}: missing name`);
        if (!TIER_VALUES.includes(page.tier)) errors.push(`${id}: bad tier: ${page.tier}`);
        if (!page.status || typeof page.status !== 'object') {
            errors.push(`${id}: missing status map`);
            continue;
        }
        for (const [key, value] of Object.entries(page.status)) {
            if (!reqIds.has(key)) errors.push(`${id}: status for unknown requirement: ${key}`);
            if (!STATUS_VALUES.includes(value)) errors.push(`${id}: bad status ${key}=${value}`);
        }
        for (const key of Object.keys(page.notes || {})) {
            if (!reqIds.has(key)) errors.push(`${id}: note for unknown requirement: ${key}`);
        }
    }
    return errors;
}
