// Tests for components/back-link.js, the view back arrow. It is a classic
// script (no exports, loaded with a bare <script src>), so the suite runs the
// real file in a vm context against stub globals rather than importing it.
//
// The contract worth protecting: the arrow leaves the page only when there is
// nothing left to go back to inside it. A hash-routed view is several screens
// in one document, and walking past them to the homepage is the bug this
// exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../components/back-link.js', import.meta.url), 'utf8');

const ORIGIN = 'https://domenhribernik.com';

function boot({ referrer = '', historyLength = 1, state = null, hasLink = true } = {}) {
    const clicks = [];
    const listeners = {};
    const link = { addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); } };

    const env = { state, backs: 0 };
    const context = {
        URL,
        history: {
            get length() { return historyLength; },
            get state() { return env.state; },
            replaceState(next) { env.state = next; },
            back() { env.backs += 1; },
        },
        location: { origin: ORIGIN },
        document: {
            readyState: 'complete',
            referrer,
            addEventListener() {},
            getElementById: (id) => (hasLink && id === 'back-link' ? link : null),
        },
        window: {
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        },
    };
    vm.createContext(context);
    vm.runInContext(SOURCE, context);

    const fire = (type) => (listeners[type] || []).forEach((fn) => fn());

    return {
        env,
        /** A screen the visitor just opened: the browser pushes null state. */
        openScreen() { env.state = null; fire('hashchange'); },
        /** The browser restoring an entry it already holds state for. */
        returnTo(state) { env.state = state; fire('hashchange'); },
        click() {
            const event = { prevented: false, preventDefault() { this.prevented = true; } };
            clicks.forEach((fn) => fn(event));
            return event;
        },
    };
}

test('a direct visit follows the href home', () => {
    const page = boot();
    const event = page.click();
    assert.equal(event.prevented, false, 'the href is the fallback, not history.back()');
    assert.equal(page.env.backs, 0);
});

test('a deep link opened cold is depth zero, so back still leaves the page', () => {
    // Someone shares .../tells/#/t/strawman. The plate is where the visit
    // started; there is no earlier screen of ours to return to.
    const page = boot();
    assert.equal(page.click().prevented, false);
});

test('an in-page screen is walked back before the page is left', () => {
    const page = boot();
    page.openScreen();
    const event = page.click();
    assert.equal(event.prevented, true);
    assert.equal(page.env.backs, 1);
});

test('screens stack, and each back click unwinds exactly one', () => {
    const page = boot();
    page.openScreen();           // grid -> index
    page.openScreen();           // index -> a plate
    assert.equal(page.click().prevented, true);

    page.returnTo({ __backLinkDepth: 1 });   // the browser restores the index
    assert.equal(page.click().prevented, true, 'still one screen deep');

    page.returnTo({ __backLinkDepth: 0 });   // and then the grid
    assert.equal(page.click().prevented, false, 'back at the root screen, so leave');
});

test('a screen reopened after going back deepens the trail again', () => {
    const page = boot();
    page.openScreen();
    page.returnTo({ __backLinkDepth: 0 });
    page.openScreen();
    assert.equal(page.env.state.__backLinkDepth, 1);
    assert.equal(page.click().prevented, true);
});

test('a same-origin arrival goes back to wherever it came from', () => {
    const page = boot({ referrer: `${ORIGIN}/views/dashboard/`, historyLength: 3 });
    assert.equal(page.click().prevented, true);
    assert.equal(page.env.backs, 1);
});

test('a cross-origin arrival follows the href home', () => {
    const page = boot({ referrer: 'https://news.ycombinator.com/', historyLength: 3 });
    assert.equal(page.click().prevented, false);
});

test('state a view already owns survives the depth stamp', () => {
    const page = boot({ state: { view: 'grid' } });
    assert.equal(page.env.state.view, 'grid');
    assert.equal(page.env.state.__backLinkDepth, 0);
});

test('a page without a back arrow wires nothing and throws nothing', () => {
    const page = boot({ hasLink: false });
    assert.equal(page.click().prevented, false);
});
