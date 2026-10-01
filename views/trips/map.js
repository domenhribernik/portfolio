// The map, as a small controller over Leaflet (window.L, loaded as a classic
// script before this module). script.js never touches Leaflet directly: it
// hands this file trips, places and photos and gets taps back.
//
// Drawing follows the network-diagram grammar: a trip is a thick line in its
// own colour on a pale casing, a place is a station circle on it, the
// selected station is the interchange ring (white fill, thick ink).

import { lineColour, clusterPoints, labelsThatFit, tripInitials, INK, PAPER } from './logic.js';

// OpenStreetMap's own tiles. CARTO's free basemaps (used by views/ip and
// views/nebo) started answering every request with an "API key required"
// watermark in 2026. The OSM style is loud, so style.css washes it down to a
// pale diagram ground (.tiles-base). Light use only, per the OSM tile policy:
// no prefetching, and the service worker caches only tiles someone viewed.
const TILE_BASE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Somewhere sensible to look at before there is anything to show.
const HOME = { center: [46.1, 14.8], zoom: 5 };

export function createMap(el) {
    const L = window.L;
    const map = L.map(el, {
        zoomControl: false,
        attributionControl: true,
        worldCopyJump: true,
        minZoom: 2,
        maxZoom: 19,
        // Whole zoom levels only: a fractional zoom scales every tile onto
        // sub-pixel edges, which shows as hairline seams and soft map text.
        zoomSnap: 1,
    }).setView(HOME.center, HOME.zoom);

    L.control.zoom({ position: 'topright' }).addTo(map);
    // crossOrigin so the service worker caches readable tiles, not opaque
    // ones that cost several MB of quota each.
    L.tileLayer(TILE_BASE, { maxZoom: 19, crossOrigin: true, attribution: ATTRIBUTION, className: 'tiles-base' }).addTo(map);

    map.createPane('lines').style.zIndex = 410;
    // Stations above photo pins: a pin must never hide the station it belongs to.
    map.createPane('photos').style.zIndex = 620;
    map.createPane('stations').style.zIndex = 640;

    // Close in, the topographic detail crowds the photos; the ground recedes.
    const markZoom = () => el.classList.toggle('map--close', map.getZoom() >= 12);
    map.on('zoomend', markZoom);
    markZoom();

    let drawn = L.layerGroup().addTo(map);
    let photoLayer = L.layerGroup().addTo(map);
    let photoState = null;   // {photos, src, onPhoto, line}
    let tapHandler = null;
    let labelled = [];        // station markers carrying a name: [{marker, selected}]

    map.on('click', (e) => {
        if (tapHandler) tapHandler({ lat: e.latlng.lat, lon: e.latlng.lng });
    });

    function clear() {
        drawn.remove();
        drawn = L.layerGroup().addTo(map);
        labelled = [];
        clearPhotos();
    }

    // Station names that would print over each other give way: the selected
    // station first, then in order along the line (logic.js labelsThatFit).
    function declutter() {
        if (!labelled.length) return;
        const items = [...labelled].sort((a, b) => Number(b.selected) - Number(a.selected));
        const labels = items.map(({ marker }) => marker.getElement()?.querySelector('.stn__label'));
        const boxes = items.map(({ marker }, i) => {
            const el = labels[i];
            if (!el) return { x: -1e6, y: -1e6, w: 0, h: 0 };
            const p = map.latLngToContainerPoint(marker.getLatLng());
            return { x: p.x + 12, y: p.y - el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight };
        });
        labelsThatFit(boxes).forEach((show, i) => labels[i]?.classList.toggle('stn__label--hidden', !show));
    }

    map.on('zoomend moveend', declutter);

    function clearPhotos() {
        photoLayer.remove();
        photoLayer = L.layerGroup().addTo(map);
        photoState = null;
    }

    // Photos pinned where they were taken, re-clustered at every zoom so a
    // pile of shots from one viewpoint reads as one pin with a count.
    function drawPhotos() {
        photoLayer.clearLayers();
        if (!photoState) return;
        const { photos, src, onPhoto, onCluster, line } = photoState;
        const c = lineColour(line);
        for (const cluster of clusterPoints(photos, map.getZoom())) {
            const first = cluster.members[0];
            const n = cluster.members.length;
            const pending = cluster.members.some((p) => p.pending);
            const icon = L.divIcon({
                className: `ph-pin${pending ? ' ph-pin--pending' : ''}`,
                html: `<span class="ph-pin__frame" style="--c:${c.hex}"><img class="ph-pin__img" alt="" src="${src(first)}"></span>`
                    + (n > 1 ? `<span class="ph-pin__count" style="--c:${c.hex};--t:${c.text}">${n}</span>` : ''),
                iconSize: [44, 44],
                iconAnchor: [22, 22],
            });
            const label = n > 1 ? `${n} photos here` : 'Photo';
            const m = L.marker([cluster.lat, cluster.lon], { icon, pane: 'photos', title: label, keyboard: true, riseOnHover: true });
            m.on('click', () => {
                if (n === 1 || map.getZoom() >= map.getMaxZoom() - 1) onPhoto(first.uuid, cluster.members);
                else onCluster ? onCluster(cluster) : map.flyToBounds(L.latLngBounds(cluster.members.map((p) => [p.lat, p.lon])), { padding: [60, 60], maxZoom: 19 });
            });
            m.addTo(photoLayer);
        }
    }

    map.on('zoomend', drawPhotos);

    function drawLine(latlngs, key, group, { weight = 7 } = {}) {
        const c = lineColour(key);
        if (latlngs.length < 2) return;
        L.polyline(latlngs, { pane: 'lines', color: PAPER, weight: weight + 5, opacity: 1, lineJoin: 'round', lineCap: 'butt', interactive: false }).addTo(group);
        // A yellow line reads at 1.6:1 on the pale ground, so it gets an ink
        // edge the way real maps edge their pale lines.
        if (c.text === INK) {
            L.polyline(latlngs, { pane: 'lines', color: INK, weight: weight + 2, opacity: 1, lineJoin: 'round', lineCap: 'butt', interactive: false }).addTo(group);
        }
        L.polyline(latlngs, { pane: 'lines', color: c.hex, weight, opacity: 1, lineJoin: 'round', lineCap: 'butt', interactive: false }).addTo(group);
    }

    /**
     * The angle of a tick at a station: at right angles to the line through
     * it, pointing to the side its name is printed on. Mercator is conformal,
     * so an angle measured at one zoom holds at every zoom.
     */
    function tickAngle(prev, here, next) {
        const a = map.project(prev ?? here, 0);
        const b = map.project(next ?? here, 0);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx === 0 && dy === 0) return null;
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        // Point right, towards the name.
        if (Math.cos((deg * Math.PI) / 180) < 0) deg += 180;
        return deg;
    }

    function station(latlng, key, group, { selected = false, pending = false, label = null, onClick = null, title = '', badge = 0, tick = null, terminus = false } = {}) {
        const c = lineColour(key);
        const cls = ['stn'];
        // A station is a tick on the line; only the selected one is the
        // interchange ring, and one not created yet is a dashed ring.
        const asTick = !selected && !pending && tick !== null;
        if (selected) cls.push('stn--here');
        if (pending) cls.push('stn--pending');
        if (asTick) cls.push(terminus ? 'stn--terminus' : 'stn--tick');
        const mark = asTick
            ? `<span class="stn__tick" style="--c:${c.hex};--a:${tick.toFixed(1)}deg"></span>`
            : `<span class="stn__dot" style="--c:${c.hex}"></span>`;
        const icon = L.divIcon({
            className: cls.join(' '),
            html: mark + (label ? `<span class="stn__label">${label}</span>` : '')
                + (badge ? `<span class="stn__badge" title="Photos with no location of their own, shown at this stop">${badge}<span class="sr-only"> photos at this stop</span></span>` : ''),
            iconSize: selected ? [26, 26] : [22, 22],
            iconAnchor: selected ? [13, 13] : [11, 11],
        });
        const m = L.marker(latlng, { icon, pane: 'stations', keyboard: !!onClick, title, riseOnHover: true, zIndexOffset: selected ? 1000 : 0 });
        if (onClick) m.on('click', onClick);
        m.addTo(group);
        if (label) labelled.push({ marker: m, selected });
        return m;
    }

    function fitTo(latlngs, { maxZoom = 13, padding = 48, padBottom = 0 } = {}) {
        // Leaflet caches the container size; the box changes height between
        // screens, and a fit against the stale size frames far too wide.
        map.invalidateSize({ pan: false });
        if (latlngs.length === 0) {
            map.setView(HOME.center, HOME.zoom);
            if (padBottom) map.panBy([0, padBottom / 2], { animate: false });
        } else if (latlngs.length === 1) {
            map.setView(latlngs[0], Math.min(maxZoom, 12));
            if (padBottom) map.panBy([0, padBottom / 2], { animate: false });
        } else {
            map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [padding, padding], paddingBottomRight: [padding + 40, padding + 28 + padBottom], maxZoom });
        }
    }

    return {
        /** Every trip as its own line; tapping a station opens its trip. */
        setNetwork(trips, { onTrip, padBottom = 0 } = {}) {
            clear();
            const all = [];
            for (const t of trips) {
                const pts = (t.places ?? []).map(p => [p.lat, p.lon]);
                all.push(...pts);
                drawLine(pts, t.line, drawn);
                pts.forEach((pt, i) => station(pt, t.line, drawn, {
                    title: `${t.name}: ${t.places[i].name}`,
                    label: escapeHtml(t.places[i].name),
                    pending: !!t.places[i].pending,
                    tick: pts.length > 1 ? tickAngle(pts[i - 1], pt, pts[i + 1]) : null,
                    terminus: i === 0 || i === pts.length - 1,
                    onClick: onTrip ? () => onTrip(t.uuid) : null,
                }));
                // The line's bullet at its first station, the way a network
                // map marks where each line starts.
                if (pts.length) {
                    const c = lineColour(t.line);
                    const bullet = L.marker(pts[0], {
                        pane: 'stations',
                        title: t.name,
                        keyboard: false,
                        icon: L.divIcon({
                            className: 'term',
                            html: `<span class="term__bullet" style="--c:${c.hex};--t:${c.text}">${escapeHtml(tripInitials(t.name))}</span>`,
                            iconSize: [30, 30],
                            iconAnchor: [38, 15],
                        }),
                    });
                    if (onTrip) bullet.on('click', () => onTrip(t.uuid));
                    bullet.addTo(drawn);
                }
            }
            fitTo(all, { maxZoom: 9, padBottom });
            requestAnimationFrame(declutter);
        },

        /** One trip's line with labelled stations; the selected one is the ring. */
        setTrip(trip, places, { selected = null, onPlace, fit = true, badge = 0 } = {}) {
            clear();
            const pts = places.map(p => [p.lat, p.lon]);
            drawLine(pts, trip.line, drawn, { weight: 8 });
            places.forEach((p, i) => station([p.lat, p.lon], trip.line, drawn, {
                selected: p.uuid === selected,
                badge: p.uuid === selected ? badge : 0,
                pending: !!p.pending,
                tick: pts.length > 1 ? tickAngle(pts[i - 1], pts[i], pts[i + 1]) : null,
                terminus: i === 0 || i === pts.length - 1,
                label: escapeHtml(p.name),
                title: p.name,
                onClick: onPlace ? () => onPlace(p.uuid) : null,
            }));
            if (fit) fitTo(pts, { maxZoom: 13 });
            requestAnimationFrame(declutter);
        },

        /** Photos at their own positions. src(photo) gives the thumbnail URL. */
        setPhotos(photos, { src, onPhoto, onCluster, line }) {
            photoState = { photos, src, onPhoto, onCluster, line };
            drawPhotos();
        },

        /** Frame a station and its photos. */
        frame(points, { maxZoom = 17 } = {}) {
            fitTo(points.map((p) => [p.lat, p.lon]), { maxZoom });
        },

        flyTo(lat, lon, zoom = 14) {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduce) map.setView([lat, lon], zoom);
            else map.flyTo([lat, lon], zoom, { duration: 0.6 });
        },

        /** While set, a tap on the map reports its coordinates instead. */
        onTap(handler) {
            tapHandler = handler;
            el.classList.toggle('map--picking', !!handler);
        },

        invalidate() { map.invalidateSize(); },
        leaflet: map,
    };
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
