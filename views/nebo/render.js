// Canvas renderer for the Nebo sky dome. All positional math lives in
// logic.js; this file only decides how the computed sky looks.
import {
    julianDay, schlyterD, lst, raDecToAltAz, project,
    sunPosition, moonPosition, moonPhase, moonTopocentricAlt,
    planetPositions, skyDarkness, twilightKind, magnitudeLimit, bvToColor,
} from './logic.js';

// Zenith/horizon palettes the dome interpolates through as the sun sinks.
const SKY_DAY = [[111, 143, 192], [206, 216, 230]];
const SKY_DUSK = [[35, 44, 84], [193, 108, 61]];
const SKY_NIGHT = [[8, 12, 30], [21, 30, 62]];

export const PLANET_STYLE = {
    mercury: { color: '#cbb49a', size: 3.2 },
    venus: { color: '#f2e7c4', size: 4.6 },
    mars: { color: '#e0663a', size: 3.8 },
    jupiter: { color: '#e9c98f', size: 4.4 },
    saturn: { color: '#d9c07a', size: 4.0 },
};

function lerp(a, b, t) { return a + (b - a) * t; }

function mixRgb(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function rgb([r, g, b], a = 1) {
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

// Sky gradient stops for a given darkness (0 day .. 1 astronomical night).
function skyColors(darkness) {
    const DUSK_AT = 0.4;
    if (darkness <= DUSK_AT) {
        const t = darkness / DUSK_AT;
        return [mixRgb(SKY_DAY[0], SKY_DUSK[0], t), mixRgb(SKY_DAY[1], SKY_DUSK[1], t)];
    }
    const t = (darkness - DUSK_AT) / (1 - DUSK_AT);
    return [mixRgb(SKY_DUSK[0], SKY_NIGHT[0], t), mixRgb(SKY_DUSK[1], SKY_NIGHT[1], t)];
}

// Chart furniture (graticule, ring, labels) blends from ink on the pale day
// sky to faint starlight on the night sky.
function furnitureColor(darkness, alpha) {
    return rgb(mixRgb([28, 26, 23], [223, 228, 245], darkness), alpha);
}

export function drawSky(ctx, opts) {
    const {
        size, date, lat, lon, stars, constellations,
        showLines = true, showLabels = true, showGraticule = true, hover = null,
        labels = {}, // translated canvas text: { moon, cardinals: [N,S,E,W], planets: {key: name} }
    } = opts;

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 26; // leave a margin for the cardinal letters

    const jd = julianDay(date);
    const d = schlyterD(jd);
    const lstDeg = lst(jd, lon);
    const toAltAz = (ra, dec) => raDecToAltAz(ra, dec, lstDeg, lat);

    const sun = sunPosition(d);
    const sunH = toAltAz(sun.ra, sun.dec);
    const darkness = skyDarkness(sunH.alt);
    const magLimit = magnitudeLimit(darkness, 5);

    const objects = []; // hit-test targets, filled as things are drawn

    ctx.clearRect(0, 0, size, size);

    // --- dome ---------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    const [zenith, horizon] = skyColors(darkness);
    const grad = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    grad.addColorStop(0, rgb(zenith));
    grad.addColorStop(1, rgb(horizon));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // warm glow hugging the horizon around the sun through golden hour
    if (sunH.alt > -14 && sunH.alt < 10) {
        const strength = 1 - Math.min(1, Math.abs(sunH.alt - 1) / 13);
        const p = project(Math.max(sunH.alt, 0), sunH.az, R);
        const glow = ctx.createRadialGradient(cx + p.x, cy + p.y, 0, cx + p.x, cy + p.y, R * 0.85);
        glow.addColorStop(0, `rgba(228, 138, 70, ${0.5 * strength})`);
        glow.addColorStop(1, 'rgba(228, 138, 70, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }

    // --- graticule + ecliptic -----------------------------------------------
    if (showGraticule) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = furnitureColor(darkness, 0.14);
        for (const alt of [30, 60]) {
            const rr = project(alt, 0, R).r;
            ctx.beginPath();
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.beginPath();
        for (const az of [0, 45, 90, 135]) {
            const a = project(0, az, R);
            const b = project(0, az + 180, R);
            ctx.moveTo(cx + a.x, cy + a.y);
            ctx.lineTo(cx + b.x, cy + b.y);
        }
        ctx.stroke();

        // the ecliptic, dashed, where the wanderers keep to the road
        ctx.strokeStyle = 'rgba(224, 138, 74, 0.35)';
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        let pen = false;
        for (let eclLon = 0; eclLon <= 360; eclLon += 4) {
            const cosE = Math.cos((23.4393) * Math.PI / 180);
            const sinE = Math.sin((23.4393) * Math.PI / 180);
            const x = Math.cos(eclLon * Math.PI / 180);
            const y = Math.sin(eclLon * Math.PI / 180) * cosE;
            const z = Math.sin(eclLon * Math.PI / 180) * sinE;
            const ra = Math.atan2(y, x) * 180 / Math.PI;
            const dec = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
            const h = toAltAz(ra, dec);
            if (h.alt < -1) { pen = false; continue; }
            const p = project(h.alt, h.az, R);
            if (pen) ctx.lineTo(cx + p.x, cy + p.y); else ctx.moveTo(cx + p.x, cy + p.y);
            pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // --- constellations -------------------------------------------------------
    if (showLines && darkness > 0.12) {
        const lineAlpha = 0.3 * Math.min(1, (darkness - 0.12) / 0.5);
        ctx.strokeStyle = `rgba(150, 168, 224, ${lineAlpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const con of constellations) {
            for (const line of con.lines) {
                let pen = false;
                for (const [ra, dec] of line) {
                    const h = toAltAz(ra, dec);
                    if (h.alt < -3) { pen = false; continue; }
                    const p = project(h.alt, h.az, R);
                    if (pen) ctx.lineTo(cx + p.x, cy + p.y); else ctx.moveTo(cx + p.x, cy + p.y);
                    pen = true;
                }
            }
        }
        ctx.stroke();

        if (showLabels) {
            ctx.fillStyle = `rgba(170, 185, 230, ${lineAlpha + 0.12})`;
            ctx.font = '10px "Space Mono", monospace';
            ctx.textAlign = 'center';
            for (const con of constellations) {
                if (!con.label || con.rank > 2) continue;
                const h = toAltAz(con.label[0], con.label[1]);
                if (h.alt < 12) continue;
                const p = project(h.alt, h.az, R);
                ctx.fillText(con.name.toUpperCase(), cx + p.x, cy + p.y);
            }
        }
    }

    // --- stars ----------------------------------------------------------------
    // catalog is sorted brightest-first, so bail once past the visibility limit
    for (const star of stars) {
        if (star.mag > magLimit) break;
        const h = toAltAz(star.ra, star.dec);
        if (h.alt < 0) continue;
        const p = project(h.alt, h.az, R);
        const px = cx + p.x;
        const py = cy + p.y;
        const size2 = Math.max(0.7, (5.4 - star.mag) * 0.52);
        const fade = Math.min(1, (magLimit - star.mag) / 1.5);
        const alpha = 0.35 + 0.65 * fade;

        if (star.mag < 0.8) { // a soft halo for the first-magnitude handful
            const halo = ctx.createRadialGradient(px, py, 0, px, py, size2 * 3.2);
            halo.addColorStop(0, `rgba(235, 240, 255, ${0.28 * alpha})`);
            halo.addColorStop(1, 'rgba(235, 240, 255, 0)');
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(px, py, size2 * 3.2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = bvToColor(star.bv);
        ctx.beginPath();
        ctx.arc(px, py, size2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        if (star.name || star.mag < 2.2) {
            objects.push({ type: 'star', x: px, y: py, hitR: Math.max(size2, 6), data: star });
        }
    }

    // --- planets ----------------------------------------------------------------
    const planets = planetPositions(d);
    ctx.font = '10px "Space Mono", monospace';
    ctx.textAlign = 'left';
    for (const planet of planets) {
        const h = toAltAz(planet.ra, planet.dec);
        if (h.alt < 0) continue;
        const p = project(h.alt, h.az, R);
        const style = PLANET_STYLE[planet.key];
        const px = cx + p.x;
        const py = cy + p.y;
        const halo = ctx.createRadialGradient(px, py, 0, px, py, style.size * 3);
        halo.addColorStop(0, 'rgba(233, 201, 143, 0.35)');
        halo.addColorStop(1, 'rgba(233, 201, 143, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(px, py, style.size * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(px, py, style.size, 0, Math.PI * 2);
        ctx.fill();
        if (planet.key === 'saturn') { // the ring, tilted, unmistakable
            ctx.strokeStyle = style.color;
            ctx.lineWidth = 1;
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(-0.45);
            ctx.beginPath();
            ctx.ellipse(0, 0, style.size * 2, style.size * 0.7, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
        ctx.fillStyle = furnitureColor(darkness, 0.75);
        ctx.fillText(labels.planets?.[planet.key] ?? planet.name, px + style.size + 5, py + 3);
        objects.push({ type: 'planet', x: px, y: py, hitR: style.size + 5, data: { ...planet, alt: h.alt, az: h.az } });
    }

    // --- the moon ----------------------------------------------------------------
    const moon = moonPosition(d);
    const moonH = toAltAz(moon.ra, moon.dec);
    const moonAlt = moonTopocentricAlt(moonH.alt, moon.rEarthRadii);
    const phase = moonPhase(d);
    if (moonAlt > -1) {
        const p = project(Math.max(moonAlt, 0), moonH.az, R);
        const px = cx + p.x;
        const py = cy + p.y;
        const mr = 8;
        // rotate the lit limb toward the sun's projected position
        const sp = project(sunH.alt, sunH.az, R);
        const angle = Math.atan2((cy + sp.y) - py, (cx + sp.x) - px);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle);
        ctx.fillStyle = 'rgba(36, 44, 78, 0.9)'; // earthlit shadow side
        ctx.beginPath();
        ctx.arc(0, 0, mr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#eae6d8';
        ctx.beginPath();
        ctx.arc(0, 0, mr, -Math.PI / 2, Math.PI / 2, false);
        ctx.ellipse(0, 0, Math.abs(2 * phase.illumination - 1) * mr, mr, 0, Math.PI / 2, Math.PI * 1.5, phase.illumination < 0.5);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = furnitureColor(darkness, 0.75);
        ctx.fillText(labels.moon ?? 'Moon', px + mr + 5, py + 3);
        objects.push({ type: 'moon', x: px, y: py, hitR: mr + 3, data: { ...phase, alt: moonAlt, az: moonH.az } });
    }

    // --- the sun ----------------------------------------------------------------
    if (sunH.alt > -0.9) {
        const p = project(Math.max(sunH.alt, 0), sunH.az, R);
        const px = cx + p.x;
        const py = cy + p.y;
        ctx.fillStyle = '#f5d9a0';
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(212, 69, 31, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 12.5, 0, Math.PI * 2);
        ctx.stroke();
        objects.push({ type: 'sun', x: px, y: py, hitR: 13, data: { alt: sunH.alt, az: sunH.az } });
    }

    // --- hover highlight ----------------------------------------------------------
    if (hover) {
        ctx.strokeStyle = 'rgba(224, 138, 74, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(hover.x, hover.y, hover.hitR + 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore(); // release the dome clip

    // --- horizon ring + cardinal letters --------------------------------------
    // drawn outside the dome, on the always-dark plate: fixed starlight ink
    ctx.strokeStyle = 'rgba(223, 228, 245, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(223, 228, 245, 0.16)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = '600 13px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(223, 228, 245, 0.85)';
    // planisphere: you look up, so east and west swap sides
    const [north, south, east, west] = labels.cardinals ?? ['N', 'S', 'E', 'W'];
    ctx.fillText(north, cx, cy - R - 15);
    ctx.fillText(south, cx, cy + R + 15);
    ctx.fillText(east, cx - R - 15, cy);
    ctx.fillText(west, cx + R + 15, cy);
    ctx.textBaseline = 'alphabetic';

    return {
        objects,
        sunAlt: sunH.alt,
        darkness,
        twilight: twilightKind(sunH.alt),
        phase,
        moonAlt,
    };
}
