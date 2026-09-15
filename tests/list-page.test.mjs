// Browser tests for views/list: the real page, in headless Chrome, at phone size.
//
// logic.js decides; this suite holds what only a rendered page can get wrong:
// that tapping a list in the picker actually switches to it, that a field never
// makes iOS Safari zoom in, and that rows line up.
//
// No database and no PHP. A small Node server serves the repo and answers the
// two controllers the page calls from in-memory fixtures, so nothing here can
// ever reach the production database that app/.env points at.
//
// Needs Chrome and Node 22+ (for the global WebSocket the DevTools protocol runs
// over), plus the Tailwind CDN the page loads. Without any of those the suite
// skips and says why, which is what happens in CI on Node 20.
//
// Run: node --test tests/list-page.test.mjs   (CHROME_BIN=... to pick a browser)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------
//  Can this machine run it at all?
// ------------------------------------------------------------------

const CHROME = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));

async function cdnReachable() {
    try {
        const res = await fetch('https://cdn.tailwindcss.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) });
        return res.ok;
    } catch {
        return false;
    }
}

const SKIP = !CHROME ? 'no Chrome found (set CHROME_BIN)'
    : typeof WebSocket !== 'function' ? 'needs Node 22+ for the global WebSocket'
    : !(await cdnReachable()) ? 'the Tailwind CDN is unreachable'
    : false;

// ------------------------------------------------------------------
//  Fixtures, shaped exactly as list-controller.php sends them
// ------------------------------------------------------------------

const ME = { id: 1, display_name: 'Domen Hribernik', email: 'domen@example.com', is_admin: false };

const LABELS = [
    { id: 1, kind: 'section', name: 'zelenjava', sort_order: 1 },
    { id: 2, kind: 'section', name: 'mlečni izdelki', sort_order: 3 },
    { id: 10, kind: 'shop', name: 'Hofer', sort_order: 0 },
    { id: 11, kind: 'shop', name: 'Lidl', sort_order: 1 },
];
const label = (id) => {
    const { kind, ...rest } = LABELS.find((l) => l.id === id);
    return rest;
};

let nextId = 100;
function row(name, { section = null, shops = [], by = ME, checkedBy = null } = {}) {
    const id = nextId++;
    return {
        id,
        name,
        checked: checkedBy ? 1 : 0,
        checked_at: checkedBy ? '2026-09-15 09:12:00.000' : null,
        checked_by: checkedBy ? checkedBy.display_name : null,
        checked_by_user_id: checkedBy ? checkedBy.id : null,
        added_by: by.display_name,
        added_by_user_id: by.id,
        section: section ? label(section) : null,
        shops: shops.map(label),
        created_at: `2026-09-15 08:${String(id % 60).padStart(2, '0')}:00.000`,
        updated_at: '2026-09-15 08:00:00.000',
    };
}

const ILIANA = { id: 2, display_name: 'Iliana Novak', email: 'iliana@example.com' };

function fixtures() {
    nextId = 100;
    return {
        doma: { labels: [], items: [row('baterije'), row('žarnice E27')] },
        trgovina: {
            labels: LABELS,
            items: [
                row('paradižnik', { section: 1 }),
                row('mleko', { section: 2, shops: [11] }),
                row('sol'),
                row('grški jogurt', { section: 2, by: ILIANA }),
                row('toaletni papir, tisti mehki s tremi sloji, velika embalaža po dvanajst'),
                row('kruh', { checkedBy: ILIANA }),
            ],
        },
    };
}

// ------------------------------------------------------------------
//  The stub server: static files plus the two controllers
// ------------------------------------------------------------------

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

let db = fixtures();

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function listController(req, res, url) {
    const q = url.searchParams;
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'the stub is read-only' });
    if (q.has('collections')) return sendJson(res, 200, { collections: Object.keys(db) });
    const collection = db[q.get('collection')];
    if (!collection) return sendJson(res, 403, { error: 'Ni dostopa' });
    if (q.has('history')) return sendJson(res, 200, { purchases: [], frequent: [], has_more: false });
    const version = `${collection.items.length}|v1`;
    if (q.get('since') === version) return sendJson(res, 200, { changed: false, version });
    return sendJson(res, 200, { items: collection.items, labels: collection.labels, version });
}

const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (url.pathname === '/app/controllers/auth-controller.php') return sendJson(res, 200, { user: ME });
    if (url.pathname === '/app/controllers/list-controller.php') return listController(req, res, url);

    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) return sendJson(res, 403, {});
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!existsSync(path)) return sendJson(res, 404, {});
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
});

// ------------------------------------------------------------------
//  Chrome over the DevTools protocol, no dependencies
// ------------------------------------------------------------------

let chrome;
let profile;
let devtools;
let origin;

before(async () => {
    if (SKIP) return;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    profile = mkdtempSync(join(tmpdir(), 'list-page-'));
    chrome = spawn(CHROME, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    devtools = await new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error('Chrome did not start:\n' + log)), 15000);
        chrome.stderr.on('data', (chunk) => {
            log += chunk;
            const m = log.match(/DevTools listening on ws:\/\/([^/]+)\//);
            if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); }
        });
    });
});

after(async () => {
    if (SKIP) return;
    chrome?.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ }
});

/** A fresh tab on the list at iPhone size, signed in, with the items painted. */
async function openList({ width = 390, height = 844, hash = '' } = {}) {
    db = fixtures();
    const target = await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let seq = 0;
    const waiting = new Map();
    const errors = [];
    ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.id && waiting.has(msg.id)) {
            const { resolve, reject } = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const page = {
        errors,
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
        },
        async waitFor(expression, what, timeout = 10000) {
            const start = Date.now();
            for (;;) {
                const value = await page.eval(expression).catch(() => null);
                if (value) return value;
                if (Date.now() - start > timeout) {
                    // A page script that failed to load is the usual cause, so say so.
                    throw new Error(`timed out waiting for ${what}` + (errors.length ? `; page errors: ${errors.join(' | ')}` : ''));
                }
                await new Promise((r) => setTimeout(r, 50));
            }
        },
        settle: (ms = 600) => new Promise((r) => setTimeout(r, ms)),
        async close() {
            ws.close();
            await fetch(`${devtools}/json/close/${target.id}`).catch(() => {});
        },
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: `${origin}/views/list/${hash}` });
    await page.waitFor(`document.readyState === 'complete' && document.querySelectorAll('#items-active li').length > 0`, 'the first list to paint');
    await page.eval('document.fonts.ready.then(() => true)');
    return page;
}

const currentList = `document.getElementById('current-list').textContent`;

// ------------------------------------------------------------------
//  Switching lists
// ------------------------------------------------------------------

test('picking another list in the picker switches to it and stays there', { skip: SKIP }, async () => {
    const page = await openList();
    try {
        assert.equal(await page.eval(currentList), 'doma');

        await page.eval(`document.getElementById('picker-open').click()`);
        await page.waitFor(`!document.getElementById('picker-sheet').classList.contains('hidden')`, 'the picker');
        await page.eval(`[...document.querySelectorAll('#picker-list button')].find((b) => b.textContent === 'trgovina').click()`);

        // The sheet's history entry pops asynchronously. The bug was that pop
        // landing after the switch and switching straight back, so wait it out.
        await page.settle(800);
        assert.equal(await page.eval(currentList), 'trgovina');
        assert.equal(await page.eval('location.hash'), '#trgovina');
        assert.ok(await page.eval(`[...document.querySelectorAll('#items-active .item-name')].some((n) => n.textContent === 'mleko')`),
            'the picked list\'s items are on screen');
        assert.deepEqual(page.errors, []);
    } finally {
        await page.close();
    }
});

// ------------------------------------------------------------------
//  iOS focus zoom
// ------------------------------------------------------------------

test('no field is under 16px, so iOS Safari never zooms in on focus', { skip: SKIP }, async () => {
    // iOS zooms the page when a focused field's text is smaller than 16px. The
    // fix is the size, not a viewport that forbids zooming: that would also
    // take pinch zoom away from anyone who needs it.
    const page = await openList({ hash: '#trgovina' });
    try {
        const small = await page.eval(`
            [...document.querySelectorAll('input:not([type=checkbox]), select, textarea')]
                .map((el) => [el.id || el.className, parseFloat(getComputedStyle(el).fontSize)])
                .filter(([, size]) => size < 16)
        `);
        assert.deepEqual(small, [], 'fields under 16px');

        const viewport = await page.eval(`document.querySelector('meta[name=viewport]').content`);
        assert.doesNotMatch(viewport, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/,
            'the viewport must not switch off zoom');
    } finally {
        await page.close();
    }
});

// ------------------------------------------------------------------
//  Rows: signed, and on one grid
// ------------------------------------------------------------------

/** Every painted row, measured. The checkbox square is ::before, centred in its button. */
const MEASURE_ROWS = `
    [...document.querySelectorAll('#items-active li, #items-checked li')].map((li) => {
        const check = li.querySelector('.item-check');
        const name = li.querySelector('.item-name');
        const meta = li.querySelector('.item-meta');
        const who = li.querySelector('.item-meta__who');
        const c = check.getBoundingClientRect();
        const box = parseFloat(getComputedStyle(check, '::before').width);
        const glyph = document.createRange();
        glyph.setStart(name.firstChild, 0);
        glyph.setEnd(name.firstChild, 1);
        const first = glyph.getBoundingClientRect();
        const n = name.getBoundingClientRect();
        return {
            name: name.textContent,
            boxLeft: c.left + (c.width - box) / 2,
            boxCenter: c.top + c.height / 2,
            firstLineCenter: first.top + first.height / 2,
            lines: Math.round(n.height / parseFloat(getComputedStyle(name).lineHeight)),
            nameLeft: n.left,
            metaLeft: meta ? meta.getBoundingClientRect().left : null,
            who: who ? who.textContent : null,
            whoRight: who ? who.getBoundingClientRect().right : null,
        };
    })
`;

const near = (actual, expected, what, tolerance = 1) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual.toFixed(1)} is not within ${tolerance}px of ${expected.toFixed(1)}`);

test('every row is signed with a first name, your own rows included', { skip: SKIP }, async () => {
    const page = await openList({ hash: '#trgovina' });
    try {
        const signed = Object.fromEntries((await page.eval(MEASURE_ROWS)).map((r) => [r.name, r.who]));
        assert.equal(signed.mleko, 'Domen', 'an item I added');
        assert.equal(signed.sol, 'Domen', 'an item I added with no labels');
        assert.equal(signed['grški jogurt'], 'Iliana', 'an item somebody else added');
        assert.equal(signed.kruh, 'Iliana', 'a bought item names the buyer');
    } finally {
        await page.close();
    }
});

test('the checkbox sits on the first line of the name, on every row', { skip: SKIP }, async () => {
    // A row with labels used to be two lines and a row without them one, and
    // the one-line names rode visibly higher than their checkboxes. Holding
    // the box to the first line keeps that true for wrapped names too.
    const page = await openList({ hash: '#trgovina' });
    try {
        const rows = await page.eval(MEASURE_ROWS);
        assert.ok(rows.some((r) => r.lines > 1), 'the fixture needs a name long enough to wrap');
        for (const r of rows) near(r.boxCenter, r.firstLineCenter, `"${r.name}" checkbox against its first line`);
    } finally {
        await page.close();
    }
});

test('rows share one grid with the chrome above them', { skip: SKIP }, async () => {
    const page = await openList({ hash: '#trgovina' });
    try {
        const edges = await page.eval(`({
            field: document.getElementById('add-input').getBoundingClientRect().left,
            title: document.getElementById('current-list').getBoundingClientRect().left,
            right: document.getElementById('add-button').getBoundingClientRect().right,
        })`);
        for (const r of await page.eval(MEASURE_ROWS)) {
            near(r.boxLeft, edges.field, `"${r.name}" checkbox left edge against the add field`);
            near(r.nameLeft, edges.title, `"${r.name}" name against the list title`);
            near(r.metaLeft, r.nameLeft, `"${r.name}" second line against its name`);
            near(r.whoRight, edges.right, `"${r.name}" signature against the add button's right edge`);
        }
    } finally {
        await page.close();
    }
});

test('nothing scrolls sideways on a 320px phone', { skip: SKIP }, async () => {
    const page = await openList({ width: 320, height: 640, hash: '#trgovina' });
    try {
        const wide = await page.eval(`
            [...document.querySelectorAll('header, #add-bar, #main, #main li, #main li *')]
                .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
                .map((el) => el.className || el.tagName)
        `);
        assert.deepEqual(wide, []);
        assert.ok(await page.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
    } finally {
        await page.close();
    }
});
