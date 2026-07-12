// Pure, DOM-free viewport transform for the Nebo sky plate. Imported by the
// page (script.js) and by tests/nebo-zoom.test.mjs.
//
// The plate is drawn in "world" coordinates (0..size on each axis, the same
// space render.js draws and stores hit-test targets in). A view {zoom, panX,
// panY} maps a world point to a screen/element point by
//     screen = world * zoom + pan
// which is what pinch-to-zoom needs: one invertible transform shared by the
// canvas draw and the pointer hit-test.

export const MIN_ZOOM = 1;   // 1 = the whole dome fits the plate, the resting state
export const MAX_ZOOM = 4;   // deep enough to split crowded constellations

export function clampZoom(z, min = MIN_ZOOM, max = MAX_ZOOM) {
    return Math.max(min, Math.min(max, z));
}

// Invert screen = world * zoom + pan, so a pointer/tap in element coordinates
// can be tested against objects stored in world coordinates.
export function screenToWorld(view, sx, sy) {
    return {
        x: (sx - view.panX) / view.zoom,
        y: (sy - view.panY) / view.zoom,
    };
}

// Keep the zoomed content covering the square plate: the world span [0, size]
// maps to the screen span [pan, pan + size*zoom], which must still bracket the
// visible [0, size]. That pins pan into [size*(1-zoom), 0] on each axis, so at
// zoom 1 the only legal pan is 0 and the dome snaps back to centred.
export function clampPan(view, size) {
    const min = size * (1 - view.zoom);
    const clamp = (p) => Math.max(min, Math.min(0, p));
    return { zoom: view.zoom, panX: clamp(view.panX), panY: clamp(view.panY) };
}

// Scale the view by `factor` about the element point (fx, fy), keeping whatever
// world point sits under (fx, fy) pinned there. Solving fx = worldX*newZoom +
// newPanX for newPanX, with worldX fixed = (fx - panX)/zoom.
export function zoomAt(view, fx, fy, factor) {
    const newZoom = clampZoom(view.zoom * factor);
    return {
        zoom: newZoom,
        panX: fx - (fx - view.panX) * newZoom / view.zoom,
        panY: fy - (fy - view.panY) * newZoom / view.zoom,
    };
}
