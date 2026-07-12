// Pure, DOM-free geography helpers for Nebo's location picker: coordinate
// clamping/wrapping/formatting and the parsing of Nominatim (OpenStreetMap)
// responses into a short place label. Imported by location-map.js and script.js
// and tested in tests/nebo-geo.test.mjs.

// Web Mercator (the map's projection) can't render past ~85.05 degrees, so a
// point chosen on the map lives inside that band. Astronomy is happy anywhere.
export function clampLat(lat) {
    return Math.max(-85.05, Math.min(85.05, lat));
}

// Fold any longitude into [-180, 180): a dragged world map wraps around.
export function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

// "46.06° N · 14.51° E" from a lat/lon and translated [N, S, E, W] cardinals.
export function formatCoords(lat, lon, cardinals = ['N', 'S', 'E', 'W']) {
    const ns = lat >= 0 ? cardinals[0] : cardinals[1];
    const ew = lon >= 0 ? cardinals[2] : cardinals[3];
    return `${Math.abs(lat).toFixed(2)}° ${ns} · ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

// Boil a Nominatim result down to a short "Locality, Country" chip. Prefers the
// most local named place in the address; falls back to slicing display_name.
export function placeLabel(result, fallback = null) {
    if (!result) return fallback;
    const a = result.address || {};
    const locality = a.city || a.town || a.village || a.municipality
        || a.hamlet || a.suburb || a.county || null;
    if (locality && a.country && locality !== a.country) return `${locality}, ${a.country}`;
    if (locality) return locality;
    if (a.state) return a.country ? `${a.state}, ${a.country}` : a.state;
    if (a.country) return a.country;
    if (typeof result.display_name === 'string') {
        const parts = result.display_name.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}, ${parts[parts.length - 1]}`;
        if (parts.length === 1) return parts[0];
    }
    return fallback;
}

// First usable hit from a Nominatim search array, as { lat, lon, label }.
export function parseSearchResult(list) {
    if (!Array.isArray(list)) return null;
    for (const item of list) {
        const lat = parseFloat(item.lat);
        const lon = parseFloat(item.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            return { lat, lon, label: placeLabel(item, item.display_name || null) };
        }
    }
    return null;
}
