// Tests for views/nebo/zoom.js, the pure viewport transform behind the sky
// plate's pinch-to-zoom. The model: a screen point s maps from a world point w
// by s = w * zoom + pan, so hit-testing and drawing share one invertible view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, zoomAt, clampPan, screenToWorld, MIN_ZOOM, MAX_ZOOM } from '../views/nebo/zoom.js';

// the world point currently sitting under an element/screen point
const worldUnder = (view, sx, sy) => ({
    x: (sx - view.panX) / view.zoom,
    y: (sy - view.panY) / view.zoom,
});

test('clampZoom: holds the zoom within its bounds', () => {
    assert.equal(clampZoom(0.2), MIN_ZOOM);
    assert.equal(clampZoom(999), MAX_ZOOM);
    assert.equal(clampZoom(2), 2);
});

test('zoomAt: the star under your fingers stays under your fingers', () => {
    const view = { zoom: 1, panX: 0, panY: 0 };
    const fx = 120;
    const fy = 200;
    const before = worldUnder(view, fx, fy);

    const next = zoomAt(view, fx, fy, 1.8);

    assert.equal(next.zoom, 1.8);
    const after = worldUnder(next, fx, fy);
    assert.ok(Math.abs(after.x - before.x) < 1e-9, `x ${after.x} vs ${before.x}`);
    assert.ok(Math.abs(after.y - before.y) < 1e-9, `y ${after.y} vs ${before.y}`);
});

test('zoomAt: a runaway pinch is capped at MAX_ZOOM', () => {
    const next = zoomAt({ zoom: 3, panX: -50, panY: -50 }, 100, 100, 100);
    assert.equal(next.zoom, MAX_ZOOM);
});

test('clampPan: at rest zoom the dome snaps back to centred (no pan)', () => {
    const view = clampPan({ zoom: 1, panX: 90, panY: -40 }, 400);
    assert.equal(view.panX, 0);
    assert.equal(view.panY, 0);
});

test('clampPan: a zoomed dome can never be dragged off the plate', () => {
    const size = 400; // pan range at 2x is [-400, 0]
    assert.equal(clampPan({ zoom: 2, panX: 100, panY: 0 }, size).panX, 0);
    assert.equal(clampPan({ zoom: 2, panX: -999, panY: 0 }, size).panX, -size);
    assert.equal(clampPan({ zoom: 2, panX: -150, panY: -150 }, size).panX, -150);
});

test('screenToWorld: inverts the view so a tap maps to the object under it', () => {
    const view = { zoom: 2, panX: -60, panY: 30 };
    // an object drawn at world (140, 90) lands on screen at world*zoom + pan
    const sx = 140 * view.zoom + view.panX;
    const sy = 90 * view.zoom + view.panY;
    const world = screenToWorld(view, sx, sy);
    assert.ok(Math.abs(world.x - 140) < 1e-9, `x ${world.x}`);
    assert.ok(Math.abs(world.y - 90) < 1e-9, `y ${world.y}`);
});
