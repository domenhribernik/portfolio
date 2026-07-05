// Unit tests for the admin dashboard's decision logic (views/admin/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTab, filterProjects, filterHubApps, buildHubPayload, swapPlan } from '../views/admin/logic.js';

test('resolveTab maps location hashes to tab ids, defaulting to users', () => {
    assert.equal(resolveTab('#users'), 'users');
    assert.equal(resolveTab('#projects'), 'projects');
    assert.equal(resolveTab('#hub'), 'hub');
    assert.equal(resolveTab(''), 'users');
    assert.equal(resolveTab('#nonsense'), 'users');
    assert.equal(resolveTab(undefined), 'users');
});

test('filterProjects matches key or name, case-insensitively', () => {
    const projects = [
        { project_key: 'botaniq', name: 'Botaniq' },
        { project_key: 'shopping', name: 'Shopping List' },
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
        { name: 'Todo', url: '/views/shopping/', project_key: 'shopping' },
        { name: 'Public thing', url: '/views/rocks/', project_key: null },
    ];
    assert.deepEqual(filterHubApps(apps, 'todo'), [apps[1]]);
    assert.deepEqual(filterHubApps(apps, 'shopping'), [apps[1]]);
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
            project: '5', sort: '20',
        }),
        {
            name: 'Botaniq', url: '/views/botaniq/',
            icon: 'fa-solid fa-leaf', gradient: 'linear-gradient(45deg, #000 0%, #fff 100%)',
            project_id: 5, sort_order: 20,
        }
    );
});

test('buildHubPayload omits blank icon/gradient and maps empty project to null', () => {
    assert.deepEqual(
        buildHubPayload({ name: 'X', url: '/views/x/', icon: '  ', gradient: '', project: '', sort: '' }),
        { name: 'X', url: '/views/x/', project_id: null, sort_order: 0 }
    );
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
