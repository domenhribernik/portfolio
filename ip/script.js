let map;
let primaryMarker;
let compareMarkers = [];
let compareMarkerByApiId = {};
let compareMode = false;
let lastIP = '';

// Distinct colors for each API's map marker
const API_COLORS = [
    '#e53e3e', // red
    '#dd6b20', // orange
    '#d69e2e', // yellow
    '#38a169', // green
    '#3182ce', // blue
    '#805ad5', // purple
    '#d53f8c', // pink
];

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
        name: 'ipwho.org', id: 'ipwho',
        url: (ip) => ip ? `https://ipwho.org/ip/${ip}` : 'https://ipwho.org/me',
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: data.country_code,
            region: data.region, city: data.city, lat: data.latitude, lon: data.longitude,
            org: data.asn?.organization || data.org, timezone: data.timezone?.id,
            success: data.success !== false
        })
    },
    {
        name: 'ip-api.com', id: 'ip-api',
        url: (ip) => `http://ip-api.com/json/${ip || ''}`,
        transform: (data) => ({
            ip: data.query, country: data.country, countryCode: data.countryCode,
            region: data.regionName, city: data.city, lat: data.lat, lon: data.lon,
            org: data.isp, timezone: data.timezone, success: data.status === 'success'
        })
    },
    {
        name: 'freeipapi.com', id: 'freeipapi',
        url: (ip) => `https://freeipapi.com/api/json/${ip || ''}`,
        transform: (data) => ({
            ip: data.ipAddress, country: data.countryName, countryCode: data.countryCode,
            region: data.regionName, city: data.cityName, lat: data.latitude, lon: data.longitude,
            org: data.asn?.organization || data.org, timezone: data.timeZone,
            success: !!data.ipAddress
        })
    },
    {
        name: 'hackertarget', id: 'hackertarget',
        url: (ip) => `https://api.hackertarget.com/geoip/?q=${ip || ''}&output=json`,
        transform: (data) => ({
            ip: data.ip, country: data.country, countryCode: null,
            region: data.state, city: data.city,
            lat: parseFloat(data.latitude), lon: parseFloat(data.longitude),
            org: null, timezone: null, success: !!data.ip && !data.error
        })
    },
    {
        name: 'ip2location.io', id: 'ip2location',
        url: (ip) => `https://api.ip2location.io/?ip=${ip || ''}`,
        transform: (data) => ({
            ip: data.ip, country: data.country_name, countryCode: data.country_code,
            region: data.region_name, city: data.city_name,
            lat: data.latitude, lon: data.longitude,
            org: data.as, timezone: null, success: !!data.ip && !data.error
        })
    },
    {
        name: 'ipinfo.io', id: 'ipinfo',
        url: (ip) => `https://ipinfo.io/${ip || ''}/json`,
        transform: (data) => {
            const [lat, lon] = (data.loc || '').split(',').map(Number);
            return {
                ip: data.ip, country: data.country, countryCode: data.country,
                region: data.region, city: data.city, lat: lat || null, lon: lon || null,
                org: data.org, timezone: data.timezone, success: !!data.ip && !data.error
            };
        }
    }
];

function initMap() {
    map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
}

function setLoading(isLoading) {
    document.getElementById('loading').classList.toggle('active', isLoading);
    document.getElementById('infoContent').style.display = isLoading ? 'none' : 'block';
    document.getElementById('searchBtn').disabled = isLoading;
    document.getElementById('myIpBtn').disabled = isLoading;
}

function showError(message) {
    const el = document.getElementById('errorMsg');
    el.textContent = message;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 5000);
}

function showSuccess(message) {
    const el = document.getElementById('successMsg');
    el.textContent = message;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 3000);
}

function updateBadge(apiId, status) {
    const badge = document.getElementById(`badge-${apiId}`);
    badge.classList.remove('active', 'failed');
    if (status === 'active') badge.classList.add('active');
    if (status === 'failed') badge.classList.add('failed');
}

function resetBadges() {
    APIs.forEach(api => updateBadge(api.id, ''));
}

function focusBadge(apiId) {
    const entry = compareMarkerByApiId[apiId];
    if (!entry) return;
    map.setView([entry.lat, entry.lon], 13, { animate: true });
    entry.marker.openPopup();
    // Briefly highlight the badge
    const badge = document.getElementById(`badge-${apiId}`);
    badge.style.transform = 'scale(1.15)';
    badge.style.boxShadow = '0 0 0 3px rgba(255,255,255,0.6)';
    setTimeout(() => {
        badge.style.transform = '';
        badge.style.boxShadow = '';
    }, 600);
}

function getFlagEmoji(countryCode) {
    if (!countryCode) return '🏳️';
    const codePoints = countryCode.toUpperCase().split('').map(c => 127397 + c.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

// Create a colored circle marker for a given API index
function createColoredMarker(lat, lon, color, apiName, locationLabel) {
    const icon = L.divIcon({
        className: '',
        html: `<div style="
                    width: 16px; height: 16px;
                    background: ${color};
                    border: 2.5px solid white;
                    border-radius: 50%;
                    box-shadow: 0 1px 5px rgba(0,0,0,0.4);
                "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
        popupAnchor: [0, -10]
    });
    return L.marker([lat, lon], { icon })
        .bindPopup(`<b>${apiName}</b><br>${locationLabel}`);
}

function clearCompareMarkers() {
    compareMarkers.forEach(m => map.removeLayer(m));
    compareMarkers = [];
    compareMarkerByApiId = {};
    document.getElementById('mapLegend').classList.remove('visible');
    document.getElementById('legendItems').innerHTML = '';
}

function updateUI(data, sourceName) {
    document.getElementById('ip').textContent = data.ip || '-';
    document.getElementById('country').textContent = data.country || '-';
    document.getElementById('flag').textContent = getFlagEmoji(data.countryCode);
    document.getElementById('region').textContent = data.region || '-';
    document.getElementById('city').textContent = data.city || '-';
    document.getElementById('coords').textContent =
        data.lat && data.lon ? `${data.lat.toFixed(4)}, ${data.lon.toFixed(4)}` : '-';
    document.getElementById('org').textContent = data.org || '-';
    document.getElementById('timezone').textContent = data.timezone || '-';

    const sourceTag = document.getElementById('sourceTag');
    sourceTag.textContent = `via ${sourceName}`;
    sourceTag.style.display = 'inline-block';

    if (data.lat && data.lon) {
        map.setView([data.lat, data.lon], 13);
        if (primaryMarker) map.removeLayer(primaryMarker);
        primaryMarker = L.marker([data.lat, data.lon])
            .addTo(map)
            .bindPopup(`<b>${data.city || 'Unknown'}</b><br>${data.country || ''}`)
            .openPopup();
    }
}

// Plot all compare results on the map
function plotCompareMarkers(results) {
    clearCompareMarkers();
    if (primaryMarker) { map.removeLayer(primaryMarker); primaryMarker = null; }

    const bounds = [];
    const legendItems = document.getElementById('legendItems');

    results.forEach((result, i) => {
        const color = API_COLORS[i % API_COLORS.length];
        const apiName = APIs[i].name;

        // Build legend entry
        const item = document.createElement('div');
        item.className = 'legend-item' + (result.success ? '' : ' failed');
        item.innerHTML = `<span class="legend-dot" style="background:${color}"></span>${apiName}`;
        legendItems.appendChild(item);

        if (!result.success) return;
        const { lat, lon, city, country } = result.data;
        if (!lat || !lon || isNaN(lat) || isNaN(lon)) return;

        const label = [city, country].filter(Boolean).join(', ') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        const marker = createColoredMarker(lat, lon, color, apiName, label);
        marker.addTo(map);
        compareMarkers.push(marker);
        compareMarkerByApiId[APIs[i].id] = { marker, lat, lon };
        bounds.push([lat, lon]);
    });

    if (bounds.length > 0) {
        if (bounds.length === 1) {
            map.setView(bounds[0], 10);
        } else {
            map.fitBounds(bounds, { padding: [40, 40] });
        }
        document.getElementById('mapLegend').classList.add('visible');
    }
}

async function tryAPI(api, ip) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
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
    setLoading(true);
    resetBadges();
    clearCompareMarkers();

    if (compareMode) {
        document.getElementById('compareGrid').innerHTML = '';
        await runComparison(ip);
        setLoading(false);
        return;
    }

    let lastError = '';
    for (const api of APIs) {
        updateBadge(api.id, 'active');
        const result = await tryAPI(api, ip);
        if (result.success) {
            updateUI(result.data, result.api);
            updateBadge(api.id, 'active');
            showSuccess(`Successfully located using ${result.api}!`);
            setLoading(false);
            return;
        } else {
            updateBadge(api.id, 'failed');
            lastError = `${api.name}: ${result.error}`;
            console.warn(`API ${api.name} failed:`, result.error);
        }
    }

    setLoading(false);
    showError(`All APIs failed. Last error: ${lastError}. Please check your connection or try again later.`);
}

async function toggleCompare() {
    compareMode = !compareMode;
    const section = document.getElementById('compareSection');
    const btn = document.getElementById('compareBtn');

    if (compareMode) {
        section.classList.remove('hidden');
        btn.textContent = 'Close';
        btn.style.background = '#e53e3e';
        const ip = lastIP || document.getElementById('ipInput').value.trim();
        if (ip !== undefined) await runComparison(ip);
    } else {
        section.classList.add('hidden');
        btn.textContent = 'Compare';
        btn.style.background = '#0f0f14';
        clearCompareMarkers();
    }
}

async function runComparison(ip) {
    const grid = document.getElementById('compareGrid');
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#666">Querying all APIs simultaneously…</p>';

    const results = await Promise.all(APIs.map(async (api, i) => {
        const result = await tryAPI(api, ip);
        updateBadge(api.id, result.success ? 'active' : 'failed');
        return { ...result, api };
    }));

    // Plot all results on map
    plotCompareMarkers(results);

    // Render comparison cards
    grid.innerHTML = results.map((result, i) => {
        const color = API_COLORS[i % API_COLORS.length];
        if (!result.success) {
            return `
                        <div class="compare-card" style="border-left-color:${color};opacity:0.6">
                            <h4><span class="color-swatch" style="background:${color}"></span>${result.api.name}</h4>
                            <p style="color:#e53e3e">Failed</p>
                            <p style="font-size:0.75rem;color:#999">${result.error}</p>
                        </div>`;
        }
        const d = result.data;
        const hasCoords = d.lat && d.lon && !isNaN(d.lat) && !isNaN(d.lon);
        return `
                    <div class="compare-card" style="border-left-color:${color}">
                        <h4><span class="color-swatch" style="background:${color}"></span>${result.api.name}</h4>
                        <p><strong>${d.city || 'Unknown'}</strong>, ${d.country || 'Unknown'} ${getFlagEmoji(d.countryCode)}</p>
                        <p style="font-size:0.8rem;color:#666">
                            ${hasCoords ? `📍 ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}` : 'No coordinates'}
                        </p>
                        <p style="font-size:0.75rem;color:#999;margin-top:8px">${d.org || 'No ISP data'}</p>
                    </div>`;
    }).join('');
}

function getMyIP() {
    document.getElementById('ipInput').value = '';
    lookupIP();
}

initMap();
window.addEventListener('load', getMyIP);
document.getElementById('ipInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') lookupIP();
});