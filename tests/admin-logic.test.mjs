// Unit tests for the admin dashboard's decision logic (views/admin/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTab, filterProjects, filterHubApps, filterLeads, buildHubPayload, swapPlan, hslToHex, randomGradient, accentFromGradient } from '../views/admin/logic.js';

// Perceived brightness (0..255) of a #rrggbb string, for the legibility guard.
function brightness(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

test('resolveTab maps location hashes to tab ids, defaulting to users', () => {
    assert.equal(resolveTab('#users'), 'users');
    assert.equal(resolveTab('#projects'), 'projects');
    assert.equal(resolveTab('#hub'), 'hub');
    assert.equal(resolveTab('#leads'), 'leads');
    assert.equal(resolveTab(''), 'users');
    assert.equal(resolveTab('#nonsense'), 'users');
    assert.equal(resolveTab(undefined), 'users');
});

test('filterLeads matches name, email, package, message, or special requests, case-insensitively', () => {
    const quotes = [
        { contact_name: 'Ana Novak', contact_email: 'ana@shop.si', suggested_package: 'PLUS', message: 'Need it by June', special_requests: '' },
        { contact_name: null, contact_email: null, suggested_package: 'BASIC', message: null, special_requests: 'forest green branding' },
        { contact_name: 'Jan Kos', contact_email: 'jan@example.com', suggested_package: 'CUSTOM', message: null, special_requests: null },
    ];
    assert.deepEqual(filterLeads(quotes, 'ANA'), [quotes[0]]);
    assert.deepEqual(filterLeads(quotes, 'shop.si'), [quotes[0]]);
    assert.deepEqual(filterLeads(quotes, 'basic'), [quotes[1]]);
    assert.deepEqual(filterLeads(quotes, 'forest green'), [quotes[1]]);
    assert.deepEqual(filterLeads(quotes, 'june'), [quotes[0]]);
    assert.deepEqual(filterLeads(quotes, ''), quotes);
    assert.deepEqual(filterLeads(quotes, 'zzz'), []);
});

test('filterProjects matches key or name, case-insensitively', () => {
    const projects = [
        { project_key: 'botaniq', name: 'Botaniq' },
        { project_key: 'list', name: 'Lists' },
        { project_key: 'vrata', name: 'Vrata' },
    ];
    assert.deepEqual(filterProjects(projects, 'BOTA'), [projects[0]]);
    assert.deepEqual(filterProjects(projects, 'list'), [projects[1]]);
    assert.deepEqual(filterProjects(projects, '  vrata '), [projects[2]]);
    assert.deepEqual(filterProjects(projects, ''), projects);
    assert.deepEqual(filterProjects(projects, 'zzz'), []);
});

test('filterHubApps matches name, url, and project key', () => {
    const apps = [
        { name: 'Botaniq', url: '/views/botaniq/', project_key: 'botaniq' },
        { name: 'Lists', url: '/views/list/', project_key: 'list' },
        { name: 'Public thing', url: '/views/rocks/', project_key: null },
    ];
    assert.deepEqual(filterHubApps(apps, 'lists'), [apps[1]]);
    assert.deepEqual(filterHubApps(apps, 'views/list'), [apps[1]]);
    assert.deepEqual(filterHubApps(apps, 'rocks'), [apps[2]]);
    assert.deepEqual(filterHubApps(apps, ''), apps);
});

test('a tile with no project matches the word "everyone", as rendered', () => {
    const apps = [
        { name: 'Botaniq', url: '/views/botaniq/', project_key: 'botaniq' },
        { name: 'Public thing', url: '/views/rocks/', project_key: null },
    ];
    assert.deepEqual(filterHubApps(apps, 'everyone'), [apps[1]]);
});

test('buildHubPayload trims fields and resolves the project select value', () => {
    assert.deepEqual(
        buildHubPayload({
            name: ' Botaniq ', url: ' /views/botaniq/ ',
            icon: 'fa-solid fa-leaf', gradient: 'linear-gradient(45deg, #000 0%, #fff 100%)',
            project: '5', sort: '20', isDefault: true,
        }),
        {
            name: 'Botaniq', url: '/views/botaniq/',
            icon: 'fa-solid fa-leaf', gradient: 'linear-gradient(45deg, #000 0%, #fff 100%)',
            project_id: 5, sort_order: 20, is_default: true,
        }
    );
});

test('buildHubPayload omits blank icon/gradient and maps empty project to null', () => {
    assert.deepEqual(
        buildHubPayload({ name: 'X', url: '/views/x/', icon: '  ', gradient: '', project: '', sort: '' }),
        { name: 'X', url: '/views/x/', project_id: null, sort_order: 0, is_default: false }
    );
});

test('buildHubPayload carries the default-for-new-users flag as a boolean', () => {
    const base = { name: 'X', url: '/views/x/', icon: '', gradient: '', project: '', sort: '0' };
    assert.equal(buildHubPayload({ ...base, isDefault: true }).is_default, true);
    assert.equal(buildHubPayload({ ...base, isDefault: false }).is_default, false);
    assert.equal(buildHubPayload(base).is_default, false);
});

test('hslToHex converts the primary/secondary corners exactly', () => {
    assert.equal(hslToHex(0, 0, 0), '#000000');
    assert.equal(hslToHex(0, 0, 100), '#ffffff');
    assert.equal(hslToHex(0, 100, 50), '#ff0000');
    assert.equal(hslToHex(120, 100, 50), '#00ff00');
    assert.equal(hslToHex(240, 100, 50), '#0000ff');
    // Hue wraps past 360 (randomGradient's second stop uses hue + 35).
    assert.equal(hslToHex(370, 100, 50), hslToHex(10, 100, 50));
});

test('randomGradient emits a fixed-angle, fixed-stop gradient (deterministic rng)', () => {
    assert.equal(
        randomGradient(() => 0),
        `linear-gradient(45deg, ${hslToHex(0, 65, 42)} 0%, ${hslToHex(35, 70, 62)} 100%)`
    );
    // rng just under 1 -> hue 359, still well-formed.
    assert.match(
        randomGradient(() => 0.999),
        /^linear-gradient\(45deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/
    );
});

test('randomGradient keeps a dark, legible first stop across many samples', () => {
    for (let i = 0; i < 500; i++) {
        const g = randomGradient();
        assert.match(g, /^linear-gradient\(45deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/);
        const firstStop = g.slice(g.indexOf('#'), g.indexOf('#') + 7);
        // The l=42 band must never drift bright enough to wash out on paper.
        assert.ok(brightness(firstStop) < 175, `first stop too bright: ${firstStop}`);
    }
});

test('accentFromGradient grabs the first hex, falling back to ink', () => {
    assert.equal(accentFromGradient('linear-gradient(45deg, #2d6a4f 0%, #74c69d 100%)'), '#2d6a4f');
    assert.equal(accentFromGradient('linear-gradient(45deg, #abc 0%, #def 100%)'), '#abc');
    assert.equal(accentFromGradient('#1f35e0'), '#1f35e0');
    assert.equal(accentFromGradient('hotpink'), '#1c1a17');
    assert.equal(accentFromGradient(''), '#1c1a17');
    assert.equal(accentFromGradient(null), '#1c1a17');
    // A random gradient's accent is always its first stop.
    const g = randomGradient(() => 0.4);
    assert.equal(accentFromGradient(g), g.slice(g.indexOf('#'), g.indexOf('#') + 7));
});

test('swapPlan exchanges the sort orders of two neighboring tiles', () => {
    assert.deepEqual(
        swapPlan({ id: 1, sort_order: 10 }, { id: 2, sort_order: 20 }, 1),
        [{ id: 1, sort_order: 20 }, { id: 2, sort_order: 10 }]
    );
});

test('swapPlan nudges past the neighbor when sort orders are equal', () => {
    assert.deepEqual(
        swapPlan({ id: 1, sort_order: 10 }, { id: 2, sort_order: 10 }, 1),
        [{ id: 1, sort_order: 11 }]
    );
    assert.deepEqual(
        swapPlan({ id: 2, sort_order: 10 }, { id: 1, sort_order: 10 }, -1),
        [{ id: 2, sort_order: 9 }]
    );
});
