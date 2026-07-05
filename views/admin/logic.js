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
