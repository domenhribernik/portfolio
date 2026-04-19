// Pure rock geometry + mesh builder. No scene, no physics, no DOM events.
// Shared between the rocks editor (views/rocks) and any showcase view.
// Relies on THREE being globally available (loaded via <script src=".../three.min.js">).

export const STONE_COLORS = [
    0x696969, 0x808080, 0x737373, 0x8B8B83,
    0x8B8680, 0xA9A9A9, 0x5A5A5A, 0x6E7070,
    0x9C8E8E,
    0x8B7355, 0x8C7853, 0x9E8B72,
    0x7D7355, 0x7B6651, 0x6B5B45,
];

let lastStoneColor = -1;
export function getRandomStoneColor() {
    let idx;
    do { idx = Math.floor(Math.random() * STONE_COLORS.length); }
    while (idx === lastStoneColor);
    lastStoneColor = idx;
    return STONE_COLORS[idx];
}

// extrudeSharp: used by shaped rocks — bevelSize=0 keeps the silhouette crisp,
// only bevelThickness rounds the top/bottom. Top face local Y = thickness * 0.9.
function extrudeSharp(shape, thickness) {
    const bevelThickness = thickness * 0.4;
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness,
        bevelSize: 0,
        bevelSegments: 5,
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    return geo;
}

// Sphere-deformed pebble. Taper comes from sphere curvature; two smooth harmonic
// bumps keep each rock unique. Seed lets rehydration reproduce the exact shape.
export function createRandomRockGeometry(size, thickness, seed = {}) {
    const elongation = seed.elongation ?? (1.2 + Math.random() * 1.0);

    const H = seed.harmonics ?? [
        { kt: 2, kp: 1, phase: Math.random() * Math.PI * 2, amp: 0.07 + Math.random() * 0.05 },
        { kt: 3, kp: 2, phase: Math.random() * Math.PI * 2, amp: 0.04 + Math.random() * 0.04 },
    ];

    const geo = new THREE.SphereGeometry(1, 48, 24);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
        const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
        const theta = Math.atan2(z0, x0);
        const phi   = Math.acos(Math.max(-1, Math.min(1, y0)));

        let rMod = 1;
        for (const h of H) {
            rMod += h.amp * Math.sin(h.kt * theta + h.phase) * Math.sin(h.kp * phi);
        }
        rMod = Math.max(0.78, rMod);

        pos.setXYZ(
            i,
            x0 * size * elongation * rMod,
            y0 * (thickness / 2),
            z0 * size * rMod
        );
    }

    geo.computeVertexNormals();
    return { geo, elongation, harmonics: H };
}

// 5-point star with softened tips (CR tension 1/8).
export function createStarGeometry(size, thickness) {
    const outerR = size, innerR = size * 0.42;
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const n = pts.length;
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
        const p2 = pts[(i + 1) % n],     p3 = pts[(i + 2) % n];
        shape.bezierCurveTo(
            p1.x + (p2.x - p0.x) / 8,  p1.y + (p2.y - p0.y) / 8,
            p2.x - (p3.x - p1.x) / 8,  p2.y - (p3.y - p1.y) / 8,
            p2.x, p2.y
        );
    }
    return extrudeSharp(shape, thickness);
}

// Heart shape built in X-Y, extruded along Z, then rotated so the flat
// face lies in the X-Z plane (same orientation as cylinder/cube).
export function createHeartGeometry(scale = 1, thickness = 0.5) {
    const shape = new THREE.Shape();
    const x = 0, y = 0;
    shape.moveTo(x + 25 * scale, y + 25 * scale);
    shape.bezierCurveTo(x + 25 * scale, y + 25 * scale, x + 20 * scale, y, x, y);
    shape.bezierCurveTo(x - 30 * scale, y, x - 30 * scale, y + 20 * scale, x - 30 * scale, y + 20 * scale);
    shape.bezierCurveTo(x - 30 * scale, y + 40 * scale, x - 10 * scale, y + 60 * scale, x + 25 * scale, y + 85 * scale);
    shape.bezierCurveTo(x + 60 * scale, y + 60 * scale, x + 80 * scale, y + 20 * scale, x + 80 * scale, y + 20 * scale);
    shape.bezierCurveTo(x + 80 * scale, y + 20 * scale, x + 80 * scale, y, x + 55 * scale, y);
    shape.bezierCurveTo(x + 35 * scale, y, x + 25 * scale, y + 25 * scale, x + 25 * scale, y + 25 * scale);

    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness: thickness * 0.4,
        bevelSize: 0,
        bevelSegments: 5,
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    return geo;
}

// Text decal laid flat on top of the rock's top face.
function createRockTextMesh({ shape, size, elongation, thickness, text }) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const shapeCfg = {
        heart:  { maxW: 160, startSize: 70, flip: true  },
        star:   { maxW: 190, startSize: 80, flip: false },
        random: { maxW: 220, startSize: 90, flip: false },
    };
    const cfg = shapeCfg[shape] || shapeCfg.random;

    let fontSize = cfg.startSize;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    while (ctx.measureText(text).width > cfg.maxW && fontSize > 10) {
        fontSize -= 2;
        ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    }

    ctx.clearRect(0, 0, 256, 256);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (cfg.flip) {
        ctx.translate(128, 128);
        ctx.rotate(Math.PI);
        ctx.translate(-128, -128);
    }

    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ede8df';
    ctx.fillText(text, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);

    // Top face Y: sphere poles at ±thickness/2 for random; extruded shapes at thickness*0.9.
    let planeW, planeH, yOffset;
    if (shape === 'random') {
        planeW  = size * elongation * 2.1;
        planeH  = size * 2.1;
        yOffset = thickness / 2 + 0.05;
    } else if (shape === 'heart') {
        planeW  = size * 3.5;
        planeH  = size * 2.8;
        yOffset = thickness * 0.9 + 0.05;
    } else {
        planeW  = size * 1.7;
        planeH  = size * 1.7;
        yOffset = thickness * 0.9 + 0.05;
    }

    const geo = new THREE.PlaneGeometry(planeW, planeH);
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const plane = new THREE.Mesh(geo, mat);
    plane.renderOrder = 1;
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = yOffset;
    return plane;
}

// Build a complete rock mesh (body + optional text decal child) from a rock record.
// rockData: { shape, size, thickness, text, color, elongation, harmonics, rotation }
// Returns: { mesh, textMesh, elongation, harmonics } — caller positions the mesh.
export function buildRockMesh(rockData) {
    const { shape, size, thickness, text } = rockData;
    const color = rockData.color ?? getRandomStoneColor();

    let geometry, elongation = 1, harmonics = null;

    if (shape === 'random') {
        const result = createRandomRockGeometry(size, thickness, {
            elongation: rockData.elongation,
            harmonics: rockData.harmonics,
        });
        geometry = result.geo;
        elongation = result.elongation;
        harmonics = result.harmonics;
    } else if (shape === 'heart') {
        geometry = createHeartGeometry(size * 0.03, thickness);
    } else if (shape === 'star') {
        geometry = createStarGeometry(size, thickness);
    }

    const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.set(0, rockData.rotation ?? 0, 0);

    let textMesh = null;
    if (text) {
        textMesh = createRockTextMesh({ shape, size, elongation, thickness, text });
        mesh.add(textMesh);
    }

    return { mesh, textMesh, elongation, harmonics, color };
}

// Dispose a mesh returned by buildRockMesh — releases geometry, material, and text texture.
export function disposeRockMesh(mesh) {
    if (!mesh) return;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
    mesh.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material?.map) child.material.map.dispose();
        if (child.material) child.material.dispose();
    });
}
