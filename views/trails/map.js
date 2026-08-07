// The chart surface. Leaflet is carried locally under lib/leaflet rather than
// pulled from a CDN, because the entire point of this view is working with no
// connection at all. The folder is `lib`, not `vendor`: `vendor` is ignored by
// .gitignore and skipped by the deploy, so a folder of that name here would
// never reach the server.
//
// There are deliberately NO raster tiles. An earlier build layered CARTO on
// top of the vector chart and it was the wrong call twice over: Leaflet's
// overlay pane always draws above the tile pane, so the vector chart covered
// the tiles anyway, and a tile server means the map looks like one thing on
// the ground and another at altitude. Everything here is drawn from the
// Natural Earth data bundled with the view, so online and offline are the
// same chart. At 11 km, coastlines, borders and city names are the whole of
// what is useful; street geometry is not.

const DATA = { countries: null, lakes: null };
let places = [];

let chartDataPromise = null;
function loadChartData() {
    if (!chartDataPromise) {
        chartDataPromise = Promise.all([
            fetch('data/countries.geojson').then((r) => r.json()).catch(() => null),
            fetch('data/lakes.geojson').then((r) => r.json()).catch(() => null),
        ]).then(([countries, lakes]) => {
            DATA.countries = countries;
            DATA.lakes = lakes;
            return DATA;
        });
    }
    return chartDataPromise;
}

/**
 * Hand the module the inflated place list, so every chart can label itself.
 * Sorted biggest first, which the label-collision pass below relies on to
 * keep the city and drop its suburbs rather than the other way round.
 */
export function setPlaces(list) {
    places = Array.isArray(list) ? [...list].sort((a, b) => b.pop - a.pop) : [];
}

const LAND = { color: '#33566a', weight: 0.8, fillColor: '#162834', fillOpacity: 1, interactive: false };
const WATER = { color: '#27455a', weight: 0.6, fillColor: '#0c1a24', fillOpacity: 1, interactive: false };

/** How big a place has to be to earn a dot at a given zoom. */
function popFloor(zoom) {
    if (zoom <= 3) return 5_000_000;
    if (zoom <= 4) return 2_000_000;
    if (zoom <= 5) return 1_000_000;
    if (zoom <= 6) return 700_000;
    if (zoom <= 7) return 400_000;
    return 0;
}

/**
 * Build a chart in `container`.
 *
 * Returns a small controller rather than the Leaflet map, so screens can only
 * do the handful of things a flight chart needs and the follow-mode rule
 * (auto-centring stops the moment you pan by hand) lives in one place.
 */
export function createChart(container, { interactive = true } = {}) {
    const L = window.L;
    if (!L || !container) return null;

    const map = L.map(container, {
        zoomControl: interactive,
        attributionControl: true,
        preferCanvas: true,          // a 12 000-point track kills the SVG renderer
        worldCopyJump: true,
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        touchZoom: interactive,
        keyboard: interactive,
        maxZoom: 12,
        minZoom: 2,
    }).setView([46.05, 14.51], 5);

    map.attributionControl.setPrefix('').addAttribution('chart: Natural Earth');

    // Panes, bottom to top: graticule under the land it rules, then the
    // coastlines, then the place names, then the track on Leaflet's overlay.
    map.createPane('grid').style.zIndex = 260;
    map.createPane('chart').style.zIndex = 280;
    map.createPane('names').style.zIndex = 380;

    const gridRenderer = L.canvas({ pane: 'grid' });
    const chartRenderer = L.canvas({ pane: 'chart' });

    // The graticule: a real chart is ruled, and it is the only thing that
    // gives scale over an ocean with no coastline in frame.
    for (let lat = -80; lat <= 80; lat += 10) {
        L.polyline([[lat, -180], [lat, 180]], {
            renderer: gridRenderer, color: '#35d6f0', weight: 0.5, opacity: 0.16, interactive: false,
        }).addTo(map);
    }
    for (let lon = -180; lon <= 180; lon += 10) {
        L.polyline([[-85, lon], [85, lon]], {
            renderer: gridRenderer, color: '#35d6f0', weight: 0.5, opacity: 0.16, interactive: false,
        }).addTo(map);
    }

    loadChartData().then(({ countries, lakes }) => {
        if (!map._container) return;      // torn down while loading
        if (countries) L.geoJSON(countries, { style: { ...LAND, renderer: chartRenderer }, pane: 'chart' }).addTo(map);
        if (lakes) L.geoJSON(lakes, { style: { ...WATER, renderer: chartRenderer }, pane: 'chart' }).addTo(map);
    });

    const townLayer = L.layerGroup().addTo(map);
    const trackLayer = L.layerGroup().addTo(map);
    const labelLayer = L.layerGroup().addTo(map);
    let horizonRing = null;
    let aircraft = null;
    let follow = true;

    /**
     * Redraw the settlements that deserve to be named at this zoom.
     *
     * `places` is sorted by population, so walking it in order and refusing
     * any name whose label box would touch one already placed keeps the
     * biggest city in a cluster and drops its suburbs. Without this the Ruhr
     * and the Randstad print as an unreadable pile of overlapping names.
     */
    function drawTowns() {
        townLayer.clearLayers();
        if (!places.length) return;
        const floor = popFloor(map.getZoom());
        const bounds = map.getBounds().pad(0.15);
        const placed = [];
        let drawn = 0;

        for (const p of places) {
            if (p.pop < floor) continue;
            if (!bounds.contains([p.lat, p.lon])) continue;

            const pt = map.latLngToContainerPoint([p.lat, p.lon]);
            const w = 12 + p.name.length * 6;      // roughly the label's ink
            const box = { x1: pt.x - 4, y1: pt.y - 9, x2: pt.x + w, y2: pt.y + 5 };
            if (placed.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)) continue;
            placed.push(box);

            if (++drawn > 90) break;               // a chart is not a phone book
            L.marker([p.lat, p.lon], {
                interactive: false, keyboard: false, pane: 'names',
                icon: L.divIcon({
                    className: 'town',
                    html: `<i></i><b>${escapeHtml(p.name)}</b>`,
                    iconSize: [0, 0], iconAnchor: [0, 0],
                }),
            }).addTo(townLayer);
        }
    }
    map.on('zoomend moveend', drawTowns);

    // Any hand pan drops follow-mode: nothing is more annoying than a map
    // that yanks itself back while you are looking at where you have been.
    map.on('dragstart', () => { follow = false; });

    const controller = {
        map,

        invalidate() { map.invalidateSize({ animate: false }); drawTowns(); },

        get follow() { return follow; },
        set follow(v) { follow = !!v; },

        /** Draw the whole track: solid where recorded, dashed across the gaps. */
        setTrack({ segments, gaps }) {
            trackLayer.clearLayers();
            for (const seg of segments) {
                if (seg.length < 2) continue;
                L.polyline(seg.map((p) => [p.lat, p.lon]), {
                    color: '#ff2d78', weight: 3, opacity: 0.95,
                    lineJoin: 'round', lineCap: 'round', interactive: false,
                }).addTo(trackLayer);
            }
            for (const [a, b] of gaps) {
                L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
                    color: '#ffb020', weight: 2, opacity: 0.8,
                    dashArray: '3 7', interactive: false,
                }).addTo(trackLayer);
            }
        },

        /** Put the aircraft at a position, turned to its heading. */
        setPosition(lat, lon, headingDeg = 0) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const icon = L.divIcon({
                className: 'plane',
                html: `<svg viewBox="0 0 24 24" style="transform:rotate(${headingDeg}deg)">
                         <path d="M12 2 14.2 11.2 22 14.4v1.8l-7.9-2.3-.5 4.9 2.6 1.9v1.3L12 21l-4.2 1v-1.3l2.6-1.9-.5-4.9L2 16.2v-1.8l7.8-3.2z"/>
                       </svg>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13],
            });
            if (aircraft) aircraft.setLatLng([lat, lon]).setIcon(icon);
            else aircraft = L.marker([lat, lon], { icon, interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(map);
            if (follow) map.panTo([lat, lon], { animate: true, duration: 0.6 });
        },

        /** The circle of everything currently over the horizon. */
        setHorizon(lat, lon, km) {
            if (!km || !Number.isFinite(lat)) {
                if (horizonRing) { map.removeLayer(horizonRing); horizonRing = null; }
                return;
            }
            if (horizonRing) { horizonRing.setLatLng([lat, lon]); horizonRing.setRadius(km * 1000); return; }
            horizonRing = L.circle([lat, lon], {
                radius: km * 1000,
                color: '#35d6f0', weight: 1.4, opacity: 0.7, dashArray: '5 6',
                fillColor: '#35d6f0', fillOpacity: 0.05, interactive: false,
            }).addTo(map);
        },

        /** Mark the places currently in sight more brightly than the base names. */
        setLabels(list) {
            labelLayer.clearLayers();
            for (const p of list) {
                if (!Number.isFinite(p.lat)) continue;
                L.marker([p.lat, p.lon], {
                    interactive: false, keyboard: false, pane: 'names',
                    icon: L.divIcon({
                        className: 'placemark',
                        html: `<i></i><b>${escapeHtml(p.name)}</b>`,
                        iconSize: [0, 0], iconAnchor: [0, 0],
                    }),
                }).addTo(labelLayer);
            }
        },

        /** Frame the whole flight. */
        fitTrack(points, padding = 46) {
            if (!points || points.length === 0) return;
            if (points.length === 1) map.setView([points[0].lat, points[0].lon], 7);
            else map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon])),
                { padding: [padding, padding], maxZoom: 10 });
            follow = false;
        },

        centreOn(lat, lon, zoom) {
            if (!Number.isFinite(lat)) return;
            map.setView([lat, lon], zoom ?? map.getZoom());
        },

        /** Metres across one screen pixel, for the scale bar. */
        metresPerPixel() {
            const c = map.getCenter();
            return 40075016.686 * Math.abs(Math.cos(c.lat * Math.PI / 180)) / Math.pow(2, map.getZoom() + 8);
        },

        redrawTowns: drawTowns,
        destroy() { map.remove(); },
    };

    drawTowns();
    return controller;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
