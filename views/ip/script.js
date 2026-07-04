let map;
let primaryMarker;
let compareMarkers = [];
let compareMarkerByApiId = {};
let compareMode = false;
let lastIP = '';
let lastSuccessApiId = null;

// Print-map palette: one distinct ink per source
const API_COLORS = [
    '#d4451f', // clay
    '#2f5b53', // pine
    '#b8860b', // ochre
    '#3d5a80', // slate blue
    '#7d4a66', // plum
    '#6a7f3a', // moss
    '#8c5433', // rust
    '#2a7f8c', // teal
    '#93353c', // burgundy
    '#4a4e8f', // indigo
];

// Every source is keyless, free, https and sends CORS headers, verified 2026-07.
// Dropped for being browser-hostile: ip-api.com (http only, mixed content),
// ip2location.io (no CORS header), ipwho.org (redirects without CORS),
// hackertarget.com (country-centroid coords, no city or ISP data).
const APIs = [
    {
        name: 'ipapi.co', id: 'ipapi',
        url: (ip) => ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/',
        transform: (data) => ({
            ip: data.ip, country: data.country_name, countryCode: data.country_code,
            region: data.region, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.org, timezone: data.timezone, success: !data.error
        })
    },
    {
        name: 'ipwho.is', id: 'ipwho',
        url: (ip) => `https://ipwho.is/${ip || ''}`,
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.region, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.connection?.isp || data.connection?.org, timezone: data.timezone?.id,
            success: data.success !== false
        })
    },
    {
        name: 'ipinfo.io', id: 'ipinfo',
        url: (ip) => ip ? `https://ipinfo.io/${ip}/json` : 'https://ipinfo.io/json',
        transform: (data) => {
            const [lat, lon] = (data.loc || '').split(',').map(Number);
            return {
                ip: data.ip, country: countryNameFromCode(data.country), countryCode: data.country,
                region: data.region, city: data.city, lat: lat || null, lon: lon || null,
                org: data.org, timezone: data.timezone, success: !!data.ip && !data.error
            };
        }
    },
    {
        name: 'geojs.io', id: 'geojs',
        url: (ip) => ip ? `https://get.geojs.io/v1/ip/geo/${ip}.json` : 'https://get.geojs.io/v1/ip/geo.json',
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.region, city: data.city,
            lat: parseFloat(data.latitude), lon: parseFloat(data.longitude),
            org: data.organization_name, timezone: data.timezone, success: !!data.ip
        })
    },
    {
        name: 'ipquery.io', id: 'ipquery',
        url: (ip) => ip ? `https://api.ipquery.io/${ip}` : 'https://api.ipquery.io/?format=json',
        transform: (data) => ({
            ip: data.ip, country: data.location?.country, countryCode: data.location?.country_code,
            region: data.location?.state, city: data.location?.city,
            lat: data.location?.latitude, lon: data.location?.longitude,
            org: data.isp?.isp || data.isp?.org, timezone: data.location?.timezone,
            success: !!data.ip && !!data.location
        })
    },
    {
        name: 'ip.sb', id: 'ipsb',
        url: (ip) => ip ? `https://api.ip.sb/geoip/${ip}` : 'https://api.ip.sb/geoip',
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.region, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.isp || data.organization, timezone: data.timezone, success: !!data.ip
        })
    },
    {
        name: 'seeip.org', id: 'seeip',
        url: (ip) => ip ? `https://api.seeip.org/geoip/${ip}` : 'https://api.seeip.org/geoip',
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.region, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.organization, timezone: data.timezone, success: !!data.ip
        })
    },
    {
        name: 'ipapi.is', id: 'ipapiis',
        url: (ip) => ip ? `https://api.ipapi.is/?q=${ip}` : 'https://api.ipapi.is/',
        transform: (data) => ({
            ip: data.ip, country: data.location?.country, countryCode: data.location?.country_code,
            region: data.location?.state, city: data.location?.city,
            lat: data.location?.latitude, lon: data.location?.longitude,
            org: data.company?.name || data.asn?.org, timezone: data.location?.timezone,
            success: !!data.ip && !!data.location
        })
    },
    {
        name: 'freeipapi.com', id: 'freeipapi',
        url: (ip) => `https://free.freeipapi.com/api/json/${ip || ''}`,
        transform: (data) => ({
            ip: data.ipAddress, country: data.countryName, countryCode: data.countryCode,
            region: data.regionName, city: data.cityName, lat: data.latitude, lon: data.longitude,
            org: data.asnOrganization, timezone: null, success: !!data.ipAddress
        })
    },
    {
        name: 'iplocate.io', id: 'iplocate',
        url: (ip) => `https://iplocate.io/api/lookup/${ip || ''}`,
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.subdivision, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.company?.name || data.asn?.name, timezone: data.time_zone,
            success: !!data.ip
        })
    },
];

const COUNT_WORDS = { 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };

function countryNameFromCode(code) {
    if (!code || code.length !== 2) return code;
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code;
    } catch { return code; }
}

function initMap() {
    map = L.map('map', { zoomControl: true }).setView([25, 10], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
}

function renderLedger() {
    const ledger = document.getElementById('sourceLedger');
    APIs.forEach((api, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'src-chip';
        chip.id = `chip-${api.id}`;
        chip.innerHTML =
            `<span class="num">${String(i + 1).padStart(2, '0')}</span>` +
            `<span class="name">${api.name}</span>` +
            `<span class="glyph"></span>`;
        chip.addEventListener('click', () => focusSource(api.id));
        ledger.appendChild(chip);
    });
    document.getElementById('sourceCount').textContent = COUNT_WORDS[APIs.length] || APIs.length;
}

function setChipState(apiId, state) {
    const chip = document.getElementById(`chip-${apiId}`);
    chip.classList.remove('querying', 'ok', 'failed');
    const glyphs = { querying: '⋯', ok: '✓', failed: '✗' };
    chip.querySelector('.glyph').textContent = glyphs[state] || '';
    if (state) chip.classList.add(state);
}

function resetChips() {
    APIs.forEach(api => setChipState(api.id, ''));
}

function focusSource(apiId) {
    const entry = compareMarkerByApiId[apiId];
    if (entry) {
        map.setView([entry.lat, entry.lon], 12, { animate: true });
        entry.marker.openPopup();
    } else if (apiId === lastSuccessApiId && primaryMarker) {
        map.setView(primaryMarker.getLatLng(), 12, { animate: true });
        primaryMarker.openPopup();
    }
}

function setLoading(isLoading) {
    document.getElementById('loading').classList.toggle('hidden', !isLoading);
    document.getElementById('infoContent').classList.toggle('hidden', isLoading);
    ['searchBtn', 'myIpBtn', 'compareBtn'].forEach(id => {
        document.getElementById(id).disabled = isLoading;
    });
}

function showNotice(id, message, ms) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

const showError = (msg) => showNotice('errorMsg', msg, 6000);
const showSuccess = (msg) => showNotice('successMsg', msg, 3000);

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '';
    const codePoints = countryCode.toUpperCase().split('').map(c => 127397 + c.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

function toDMS(lat, lon) {
    const part = (v, pos, neg) => {
        const abs = Math.abs(v);
        const d = Math.floor(abs);
        const m = Math.floor((abs - d) * 60);
        const s = Math.round(((abs - d) * 60 - m) * 60);
        return `${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″${v >= 0 ? pos : neg}`;
    };
    return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

function haversineKm(a, b) {
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function setFigCaption(text) {
    document.getElementById('figCaption').innerHTML = `Fig. 1 &middot; ${text}`;
}

function makeNumberMarker(lat, lon, color, num, apiName, locationLabel) {
    const icon = L.divIcon({
        className: '',
        html: `<div class="atlas-marker" style="background:${color}">${num}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -14]
    });
    return L.marker([lat, lon], { icon })
        .bindPopup(`<b>${apiName}</b><br>${locationLabel}`);
}

function makePrimaryMarker(lat, lon) {
    const icon = L.divIcon({
        className: '',
        html: '<div class="atlas-pin"><div class="ring"></div><div class="dot"></div></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -12]
    });
    return L.marker([lat, lon], { icon });
}

function clearCompareMarkers() {
    compareMarkers.forEach(m => map.removeLayer(m));
    compareMarkers = [];
    compareMarkerByApiId = {};
    document.getElementById('mapLegend').classList.add('hidden');
    document.getElementById('legendItems').innerHTML = '';
}

function updateUI(data, sourceName) {
    document.getElementById('ip').textContent = data.ip || '–';
    document.getElementById('country').textContent = data.country || '–';
    document.getElementById('flag').textContent = getFlagEmoji(data.countryCode);
    document.getElementById('region').textContent = data.region || '–';
    document.getElementById('city').textContent = data.city || '–';

    const hasCoords = data.lat && data.lon && !isNaN(data.lat) && !isNaN(data.lon);
    document.getElementById('coords').textContent =
        hasCoords ? `${data.lat.toFixed(4)}, ${data.lon.toFixed(4)}` : '–';
    document.getElementById('dms').textContent = hasCoords ? toDMS(data.lat, data.lon) : '';

    document.getElementById('org').textContent = data.org || '–';
    document.getElementById('timezone').textContent = data.timezone || '–';

    const sourceTag = document.getElementById('sourceTag');
    sourceTag.textContent = `via ${sourceName}`;
    sourceTag.classList.remove('hidden', 'stamped');
    void sourceTag.offsetWidth; // restart the stamp animation
    sourceTag.classList.add('stamped');

    if (hasCoords) {
        map.setView([data.lat, data.lon], 12);
        if (primaryMarker) map.removeLayer(primaryMarker);
        primaryMarker = makePrimaryMarker(data.lat, data.lon)
            .addTo(map)
            .bindPopup(`<b>${data.city || 'Unknown'}</b><br>${data.country || ''}`)
            .openPopup();
        setFigCaption(`Reported position of ${data.ip}`);
    }
}

// Plot every compare result on the plate, then summarize the spread
function plotCompareMarkers(results) {
    clearCompareMarkers();
    if (primaryMarker) { map.removeLayer(primaryMarker); primaryMarker = null; }

    const points = [];
    const legendItems = document.getElementById('legendItems');

    results.forEach((result, i) => {
        const color = API_COLORS[i % API_COLORS.length];
        const apiName = APIs[i].name;

        const item = document.createElement('div');
        item.className = 'legend-item' + (result.success ? '' : ' failed');
        item.innerHTML = `<span class="legend-dot" style="background:${color}"></span><span class="lname">${apiName}</span>`;
        legendItems.appendChild(item);

        if (!result.success) return;
        const { lat, lon, city, country } = result.data;
        if (!lat || !lon || isNaN(lat) || isNaN(lon)) return;

        const label = [city, country].filter(Boolean).join(', ') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        const marker = makeNumberMarker(lat, lon, color, i + 1, apiName, label);
        marker.addTo(map);
        compareMarkers.push(marker);
        compareMarkerByApiId[APIs[i].id] = { marker, lat, lon };
        points.push({ coords: [lat, lon], name: apiName });
    });

    if (points.length > 0) {
        const bounds = points.map(p => p.coords);
        if (bounds.length === 1) {
            map.setView(bounds[0], 10);
        } else {
            map.fitBounds(bounds, { padding: [40, 40] });
        }
        document.getElementById('mapLegend').classList.remove('hidden');
    }

    // Greatest disagreement between any two sources
    const note = document.getElementById('spreadNote');
    if (points.length >= 2) {
        let maxKm = 0, pair = null;
        for (let a = 0; a < points.length; a++) {
            for (let b = a + 1; b < points.length; b++) {
                const km = haversineKm(points[a].coords, points[b].coords);
                if (km > maxKm) { maxKm = km; pair = [points[a].name, points[b].name]; }
            }
        }
        note.textContent = maxKm < 1
            ? `All ${points.length} plotted sources agree to within a kilometre.`
            : `The sources disagree by as much as ${Math.round(maxKm)} km (${pair[0]} vs ${pair[1]}).`;
        note.classList.remove('hidden');
    } else {
        note.classList.add('hidden');
    }
}

async function tryAPI(api, ip) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(api.url(ip), {
            signal: controller.signal, headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const transformed = api.transform(data);
        if (!transformed.success) throw new Error('Invalid data');
        return { success: true, data: transformed, api: api.name };
    } catch (error) {
        return { success: false, error: error.message, api: api.name };
    }
}

async function lookupIP() {
    const ip = document.getElementById('ipInput').value.trim();
    lastIP = ip;
    lastSuccessApiId = null;
    setLoading(true);
    resetChips();
    clearCompareMarkers();

    if (compareMode) {
        document.getElementById('compareGrid').innerHTML = '';
        await runComparison(ip);
        setLoading(false);
        return;
    }

    let lastError = '';
    for (const api of APIs) {
        setChipState(api.id, 'querying');
        const result = await tryAPI(api, ip);
        if (result.success) {
            updateUI(result.data, result.api);
            setChipState(api.id, 'ok');
            lastSuccessApiId = api.id;
            showSuccess(`Located by ${result.api}.`);
            setLoading(false);
            return;
        } else {
            setChipState(api.id, 'failed');
            lastError = `${api.name}: ${result.error}`;
            console.warn(`API ${api.name} failed:`, result.error);
        }
    }

    setLoading(false);
    showError(`Every source came back empty. Last error, ${lastError}. Check your connection and try again.`);
}

async function toggleCompare() {
    compareMode = !compareMode;
    const section = document.getElementById('compareSection');
    const btn = document.getElementById('compareBtn');

    if (compareMode) {
        section.classList.remove('hidden');
        btn.textContent = 'Close';
        btn.classList.add('compare-active');
        setLoading(true);
        await runComparison(lastIP || document.getElementById('ipInput').value.trim());
        setLoading(false);
    } else {
        section.classList.add('hidden');
        btn.textContent = 'Compare all';
        btn.classList.remove('compare-active');
        clearCompareMarkers();
        document.getElementById('spreadNote').classList.add('hidden');
    }
}

async function runComparison(ip) {
    const grid = document.getElementById('compareGrid');
    grid.innerHTML = '<p class="col-span-full text-center text-stone font-display italic py-6">Querying all sources at once&hellip;</p>';
    APIs.forEach(api => setChipState(api.id, 'querying'));

    const results = await Promise.all(APIs.map(async (api) => {
        const result = await tryAPI(api, ip);
        setChipState(api.id, result.success ? 'ok' : 'failed');
        return result;
    }));

    plotCompareMarkers(results);
    setFigCaption(`${ip || 'Your address'} according to ${results.filter(r => r.success).length} of ${APIs.length} sources`);

    const cardBase = 'bg-card border border-hairline rounded-[3px] p-4 shadow-[0_6px_18px_rgba(28,26,23,0.05)] border-l-[3px]';
    grid.innerHTML = results.map((result, i) => {
        const color = API_COLORS[i % API_COLORS.length];
        const head = `
            <h3 class="flex items-center gap-2 font-mono font-bold text-[0.75rem] uppercase tracking-wider mb-2">
                <span class="atlas-marker atlas-marker--sm" style="background:${color}">${i + 1}</span>${APIs[i].name}
            </h3>`;
        if (!result.success) {
            return `
                <article class="${cardBase} opacity-60" style="border-left-color:${color}">
                    ${head}
                    <p class="font-display italic text-claydk">No reading</p>
                    <p class="font-mono text-[0.68rem] text-stone mt-1">${result.error}</p>
                </article>`;
        }
        const d = result.data;
        const hasCoords = d.lat && d.lon && !isNaN(d.lat) && !isNaN(d.lon);
        return `
            <article class="${cardBase}" style="border-left-color:${color}">
                ${head}
                <p class="text-[0.92rem]"><strong>${d.city || 'Unknown'}</strong>, ${d.country || 'Unknown'} ${getFlagEmoji(d.countryCode)}</p>
                <p class="font-mono text-[0.72rem] text-stone mt-1">${hasCoords ? toDMS(d.lat, d.lon) : 'No coordinates'}</p>
                <p class="font-mono text-[0.68rem] text-stone/80 mt-2 break-words">${d.org || 'No ISP data'}</p>
            </article>`;
    }).join('');
}

function getMyIP() {
    document.getElementById('ipInput').value = '';
    lookupIP();
}

initMap();
renderLedger();
document.getElementById('searchBtn').addEventListener('click', lookupIP);
document.getElementById('myIpBtn').addEventListener('click', getMyIP);
document.getElementById('compareBtn').addEventListener('click', toggleCompare);
document.getElementById('ipInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') lookupIP();
});
window.addEventListener('load', getMyIP);
