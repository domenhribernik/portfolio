// Decision logic for the admin dashboard, kept DOM-free so it can be
// unit-tested with `node --test tests/` (no dependencies, no build step).
// script.js imports this as an ES module.

const TABS = ['users', 'projects', 'hub'];

export function resolveTab(hash) {
    const id = (hash || '').replace(/^#/, '');
    return TABS.includes(id) ? id : 'users';
}

export function filterProjects(projects, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
        p.project_key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
}

export function filterHubApps(apps, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(a =>
        a.name.toLowerCase().includes(q)
        || a.url.toLowerCase().includes(q)
        || (a.project_key || 'everyone').toLowerCase().includes(q));
}

// Returns the sort_order updates that move tile `a` past its neighbor `b`.
// Equal values would swap into a no-op, so `a` nudges past `b` instead.
export function swapPlan(a, b, dir) {
    if (a.sort_order === b.sort_order) {
        return [{ id: a.id, sort_order: b.sort_order + dir }];
    }
    return [
        { id: a.id, sort_order: b.sort_order },
        { id: b.id, sort_order: a.sort_order },
    ];
}

// Converts an HSL triple to a #rrggbb hex string.
// h in [0,360), s and l in [0,100]. Used by randomGradient below and kept
// pure so it can be unit-tested exactly.
export function hslToHex(h, s, l) {
    const sN = s / 100;
    const lN = l / 100;
    const c = (1 - Math.abs(2 * lN - 1)) * sN;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = lN - c / 2;
    let r = 0, g = 0, b = 0;
    if (hp < 1)      { r = c; g = x; b = 0; }
    else if (hp < 2) { r = x; g = c; b = 0; }
    else if (hp < 3) { r = 0; g = c; b = x; }
    else if (hp < 4) { r = 0; g = x; b = c; }
    else if (hp < 5) { r = x; g = 0; b = c; }
    else             { r = c; g = 0; b = x; }
    const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Builds a random on-theme gradient with a FIXED angle and 0%/100% stops, so
// every generated gradient has "the same distance". The first stop is locked
// to a dark, saturated band (l≈42) so it always works as the hub's legible
// border/icon accent on the paper background; the second stop is a lighter,
// hue-shifted companion. `rng` is injectable for deterministic tests.
export function randomGradient(rng = Math.random) {
    const hue = Math.floor(rng() * 360);
    const c1 = hslToHex(hue, 65, 42);
    const c2 = hslToHex(hue + 35, 70, 62);
    return `linear-gradient(45deg, ${c1} 0%, ${c2} 100%)`;
}

// Extracts the first hex color from a stored gradient string to use as the
// flat accent (border/icon) on the hub and in the admin tile list. Falls back
// to ink when the gradient has no hex color. Mirrors the same one-liner the
// hub view uses inline; kept here so it can be unit-tested.
export function accentFromGradient(gradient) {
    const m = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(gradient || '');
    return m ? m[0] : '#1c1a17';
}

// Blank icon/gradient are omitted so the controller's defaults apply.
export function buildHubPayload({ name, url, icon, gradient, project, sort }) {
    const body = {
        name: name.trim(),
        url: url.trim(),
        project_id: project === '' ? null : Number(project),
        sort_order: Number(sort) || 0,
    };
    if (icon.trim()) body.icon = icon.trim();
    if (gradient.trim()) body.gradient = gradient.trim();
    return body;
}
