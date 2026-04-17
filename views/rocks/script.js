// Scene setup
const container = document.getElementById('canvas');
const scene = new THREE.Scene();

// Gradient background
const bgCanvas = document.createElement('canvas');
bgCanvas.width = 512;
bgCanvas.height = 512;
const bgCtx = bgCanvas.getContext('2d');
const gradient = bgCtx.createLinearGradient(0, 0, 0, 512);
gradient.addColorStop(0, '#e0c3fc');
gradient.addColorStop(0.5, '#8ec5fc');
gradient.addColorStop(1, '#4facfe');
bgCtx.fillStyle = gradient;
bgCtx.fillRect(0, 0, 512, 512);
scene.background = new THREE.CanvasTexture(bgCanvas);
scene.fog = new THREE.Fog(0x8ec5fc, 50, 150);

const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 25, 20);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(15, 30, 15);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 100;
directionalLight.shadow.camera.left = -30;
directionalLight.shadow.camera.right = 30;
directionalLight.shadow.camera.top = 30;
directionalLight.shadow.camera.bottom = -30;
scene.add(directionalLight);

// Ground
const groundGeometry = new THREE.CircleGeometry(45, 64);
const groundCanvas = document.createElement('canvas');
groundCanvas.width = 512;
groundCanvas.height = 512;
const groundCtx = groundCanvas.getContext('2d');
groundCtx.fillStyle = '#e8f5e9';
groundCtx.fillRect(0, 0, 512, 512);
groundCtx.strokeStyle = '#a5d6a7';
groundCtx.lineWidth = 2;
const gridSize = 64;
for (let i = 0; i <= 512; i += gridSize) {
    groundCtx.beginPath();
    groundCtx.moveTo(i, 0);
    groundCtx.lineTo(i, 512);
    groundCtx.stroke();
    groundCtx.beginPath();
    groundCtx.moveTo(0, i);
    groundCtx.lineTo(512, i);
    groundCtx.stroke();
}

const groundTexture = new THREE.CanvasTexture(groundCanvas);
groundTexture.wrapS = THREE.RepeatWrapping;
groundTexture.wrapT = THREE.RepeatWrapping;
groundTexture.repeat.set(4, 4);

const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 0.8, metalness: 0.1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const ring = new THREE.Mesh(
    new THREE.RingGeometry(45, 47, 64),
    new THREE.MeshStandardMaterial({ color: 0x81c784, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.01;
ring.receiveShadow = true;
scene.add(ring);

// UI Elements
const shapeSelect = document.getElementById('shapeSelect');
const thicknessInput = document.getElementById('thicknessInput');
const sizeInput = document.getElementById('sizeInput');
const createBtn = document.getElementById('createBtn');
const clearBtn = document.getElementById('clearBtn');
const deleteBtn = document.getElementById('deleteBtn');
const rockCountEl = document.getElementById('rockCount');
const fpsCounter = document.getElementById('fpsCounter');
const rockText = document.getElementById('rockText');
const charCounter = document.getElementById('charCounter');

function calcMaxChars(size) {
    return Math.max(2, Math.floor(size * 4));
}

function updateTextLimit() {
    const max = calcMaxChars(parseFloat(sizeInput.value));
    rockText.maxLength = max;
    if (rockText.value.length > max) rockText.value = rockText.value.slice(0, max);
    charCounter.textContent = `${rockText.value.length}/${max}`;
}

rockText.addEventListener('input', () => {
    const max = calcMaxChars(parseFloat(sizeInput.value));
    charCounter.textContent = `${rockText.value.length}/${max}`;
});

sizeInput.addEventListener('input', () => { updateTextLimit(); });
updateTextLimit();

const STONE_COLORS = [
    // Cool grays — granite, basalt
    0x696969, 0x808080, 0x737373, 0x8B8B83,
    // Blue-grays — slate
    0x8B8680, 0xA9A9A9, 0x5A5A5A, 0x6E7070,
    // Warm pinkish-gray — some granites
    0x9C8E8E,
    // Warm tans — sandstone, limestone
    0x8B7355, 0x8C7853, 0x9E8B72,
    // Earth browns — mudstone, shale
    0x7D7355, 0x7B6651, 0x6B5B45,
];
let lastStoneColor = -1;

function getRandomStoneColor() {
    let idx;
    do { idx = Math.floor(Math.random() * STONE_COLORS.length); }
    while (idx === lastStoneColor);
    lastStoneColor = idx;
    return STONE_COLORS[idx];
}

const GRAVITY = 0.15;
const FRICTION = 0.96;
const BOUNCE = 0.6;
const GROUND_Y = 0;
const BOUNDARY = 43;

let rocks = [];
let nextRockId = 0;
let isPlacingRock = false;
let isDeletingRock = false;
let frameCount = 0;
let lastFpsTime = Date.now();

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// ── Shared extrude helpers ──

// extrudeFlat: used by random pebble — random bevelSize gives the organic taper.
// Top face local Y = thickness * 0.5 + thickness * 0.4 = thickness * 0.9
function extrudeFlat(shape, thickness, bevelSize) {
    const bevelThickness = thickness * 0.4;
    const bevelSegments  = Math.min(8, Math.max(5, Math.round(bevelSize * 12)));
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness,
        bevelSize,
        bevelSegments,
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    return geo;
}

// extrudeSharp: used by shaped rocks — no bevelSize so edges stay crisp.
// Only bevelThickness rounds the top/bottom face; the silhouette is untouched.
// Top face local Y = thickness * 0.5 + thickness * 0.4 = thickness * 0.9
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

// ── Random pebble — sphere-deformed ──
// Uses a SphereGeometry so the edge naturally tapers from equator to poles (the
// "fade in" the user wanted). The XZ profile is then perturbed with a few smooth
// spherical-harmonic bumps to keep each rock unique, but amplitudes are small
// enough that rocks still read as pebbles, not blobs.
function createRandomRockGeometry(size, thickness) {
    const elongation = 1.2 + Math.random() * 1.0; // x-stretch: 1.2 – 2.2

    // Two smooth harmonic components — less than the all-sphere version (which was
    // too round) but more than the pure CR-bezier (which had no vertical taper).
    const H = [
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
            y0 * (thickness / 2),   // squish Y — sphere curvature handles the taper
            z0 * size * rMod
        );
    }

    geo.computeVertexNormals();
    return { geo, elongation };
}

// ── Star (5-point) — slightly softened tips ──
// CR tension 1/8 barely curves the segments, just enough to take the absolute
// sharpness off the tips without making them look rounded.
function createStarGeometry(size, thickness) {
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

// ── Crescent moon ──
// Outer circle radius = size. Hole offset = 0.26×size right, radius = 0.72×size.
// Max reach of hole = 0.26 + 0.72 = 0.98×size — just inside the outer edge,
// so the tips meet cleanly without clipping through.
function createMoonGeometry(size, thickness) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, size, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(size * 0.26, 0, size * 0.72, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    return extrudeSharp(shape, thickness);
}

// ── Heart geometry ──
// Build the shape in X-Y, extrude along Z, then rotate so the flat
// face is parallel to the ground (X-Z plane). We rotate the geometry
// itself (not the mesh) so the mesh needs no extra rotation — it
// behaves exactly like cylinder / cube.
function createHeartGeometry(scale = 1, thickness = 0.5) {
    const shape = new THREE.Shape();
    const x = 0, y = 0;
    shape.moveTo(x + 25 * scale, y + 25 * scale);
    shape.bezierCurveTo(x + 25 * scale, y + 25 * scale, x + 20 * scale, y, x, y);
    shape.bezierCurveTo(x - 30 * scale, y, x - 30 * scale, y + 20 * scale, x - 30 * scale, y + 20 * scale);
    shape.bezierCurveTo(x - 30 * scale, y + 40 * scale, x - 10 * scale, y + 60 * scale, x + 25 * scale, y + 85 * scale);
    shape.bezierCurveTo(x + 60 * scale, y + 60 * scale, x + 80 * scale, y + 40 * scale, x + 80 * scale, y + 20 * scale);
    shape.bezierCurveTo(x + 80 * scale, y + 20 * scale, x + 80 * scale, y, x + 55 * scale, y);
    shape.bezierCurveTo(x + 35 * scale, y, x + 25 * scale, y + 25 * scale, x + 25 * scale, y + 25 * scale);

    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness: thickness * 0.4,
        bevelSize: 0,
        bevelSegments: 5,
    });

    // Center, then bake a -90° X rotation into the vertices so the
    // extrusion axis (local Z) becomes world Y. After this the geometry
    // is "flat" the same way CylinderGeometry is — no mesh rotation needed.
    geo.center();
    geo.rotateX(-Math.PI / 2);

    return geo;
}

// ── Collision helper ──
function getCollisionRadius(rock) {
    if (rock.shape === 'random') return rock.size * (rock.elongation + 1) / 2;
    if (rock.shape === 'heart')  return rock.size * 1.5;
    if (rock.shape === 'moon')   return rock.size * 0.75;
    if (rock.shape === 'star')   return rock.size * 0.75;
    return rock.size;
}

function resolveCollisions() {
    for (let i = 0; i < rocks.length; i++) {
        for (let j = i + 1; j < rocks.length; j++) {
            const a = rocks[i];
            const b = rocks[j];
            const dx = b.position.x - a.position.x;
            const dz = b.position.z - a.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const minDist = getCollisionRadius(a) + getCollisionRadius(b);

            if (dist < minDist && dist > 0.001) {
                // Push apart
                const nx = dx / dist;
                const nz = dz / dist;
                const overlap = minDist - dist;
                a.position.x -= nx * overlap * 0.5;
                a.position.z -= nz * overlap * 0.5;
                b.position.x += nx * overlap * 0.5;
                b.position.z += nz * overlap * 0.5;

                // Bounce velocities along collision normal
                const relVx = a.velocity.x - b.velocity.x;
                const relVz = a.velocity.z - b.velocity.z;
                const dot = relVx * nx + relVz * nz;
                if (dot > 0) {
                    const impulse = dot * BOUNCE;
                    a.velocity.x -= impulse * nx;
                    a.velocity.z -= impulse * nz;
                    b.velocity.x += impulse * nx;
                    b.velocity.z += impulse * nz;
                }
            }
        }
    }
}

class Rock {
    constructor(x, z, shape, thickness, size, text = '') {
        this.id = nextRockId++;
        this.shape = shape;
        this.thickness = thickness;
        this.size = size;
        this.text = text;
        this.elongation = 1; // overwritten for random shape
        this.color = getRandomStoneColor();

        this.position = new THREE.Vector3(x, 10, z);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.spinAngle = Math.random() * Math.PI * 2;
        this.spinSpeed = (Math.random() - 0.5) * 0.1;

        this.createMesh();
        if (text) this.createTextMesh(text);
        scene.add(this.mesh);
    }

    createMesh() {
        let geometry;

        if (this.shape === 'random') {
            // Sphere-based: taper comes from sphere curvature, no extrudeFlat bevel needed.
            this.bevelSize = 0;
            const result = createRandomRockGeometry(this.size, this.thickness);
            geometry = result.geo;
            this.elongation = result.elongation;
        } else {
            this.bevelSize = 0;
            if (this.shape === 'heart') {
                geometry = createHeartGeometry(this.size * 0.03, this.thickness);
            } else if (this.shape === 'star') {
                geometry = createStarGeometry(this.size, this.thickness);
            } else if (this.shape === 'moon') {
                geometry = createMoonGeometry(this.size, this.thickness);
            }
        }

        this.mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.7, metalness: 0.1 })
        );
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.mesh.userData.rock = this;

        this.applyRotation();
    }

    createTextMesh(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        // Per-shape canvas config: max text width (px out of 256) and font start size.
        // Heart needs a flip + tighter width due to its asymmetric centered geometry.
        // Moon uses narrow width since text sits in the crescent arc, not a full face.
        const shapeCfg = {
            heart:  { maxW: 160, startSize: 70, flip: true  },
            star:   { maxW: 190, startSize: 80, flip: false },
            moon:   { maxW: 155, startSize: 65, flip: false },
            random: { maxW: 220, startSize: 90, flip: false },
        };
        const cfg = shapeCfg[this.shape] || shapeCfg.random;

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

        // Subtle shadow for depth
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 2;

        // Warm off-white — readable on gray/brown rock tones
        ctx.fillStyle = '#ede8df';
        ctx.fillText(text, 128, 128);

        const texture = new THREE.CanvasTexture(canvas);

        // Extruded shapes: top face = thickness * 0.9 (depth/2 + bevelThickness*0.4).
        // Random (sphere): top face = thickness / 2 exactly — sphere poles are at ±thickness/2.
        let planeW, planeH, yOffset;
        if (this.shape === 'random') {
            planeW  = this.size * this.elongation * 2.1;
            planeH  = this.size * 2.1;
            yOffset = this.thickness / 2 + 0.05;
        } else if (this.shape === 'heart') {
            planeW  = this.size * 3.5;
            planeH  = this.size * 2.8;
            yOffset = this.thickness * 0.9 + 0.05;
        } else if (this.shape === 'moon') {
            planeW  = this.size * 1.3;
            planeH  = this.size * 2.0;
            yOffset = this.thickness * 0.9 + 0.05;
        } else {
            // Star
            planeW  = this.size * 1.7;
            planeH  = this.size * 1.7;
            yOffset = this.thickness * 0.9 + 0.05;
        }

        const geo = new THREE.PlaneGeometry(planeW, planeH);
        const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });

        const plane = new THREE.Mesh(geo, mat);
        plane.renderOrder = 1;
        plane.rotation.x = -Math.PI / 2;   // lay flat
        plane.position.y = yOffset;
        this.mesh.add(plane);
        this.textMesh = plane;
    }

    applyRotation() {
        // All shapes are already "flat" in geometry space.
        // Just spin around Y.
        this.mesh.rotation.set(0, this.spinAngle, 0);
    }

    dispose() {
        scene.remove(this.mesh);
        if (this.mesh.geometry) this.mesh.geometry.dispose();
        if (this.mesh.material) this.mesh.material.dispose();
        if (this.textMesh) {
            if (this.textMesh.geometry) this.textMesh.geometry.dispose();
            if (this.textMesh.material.map) this.textMesh.material.map.dispose();
            if (this.textMesh.material) this.textMesh.material.dispose();
        }
    }

    update() {
        this.velocity.y -= GRAVITY;
        this.velocity.x *= FRICTION;
        this.velocity.z *= FRICTION;
        this.velocity.y *= FRICTION;

        this.position.add(this.velocity);

        this.spinAngle += this.spinSpeed;
        this.spinSpeed *= 0.95;

        // Ground collision
        if (this.position.y < GROUND_Y + this.thickness / 2) {
            this.position.y = GROUND_Y + this.thickness / 2;
            this.velocity.y *= -BOUNCE;
            this.spinSpeed *= 0.8;
        }

        // Circular boundary
        const dist = Math.sqrt(this.position.x ** 2 + this.position.z ** 2);
        if (dist > BOUNDARY) {
            const angle = Math.atan2(this.position.z, this.position.x);
            this.position.x = Math.cos(angle) * BOUNDARY;
            this.position.z = Math.sin(angle) * BOUNDARY;
            this.velocity.x *= -BOUNCE;
            this.velocity.z *= -BOUNCE;
        }

        this.mesh.position.copy(this.position);
        this.applyRotation();
    }
}

function updateRockCount() {
    rockCountEl.textContent = rocks.length;
}

// ── Delete mode ──
function enterDeleteMode() {
    isDeletingRock = true;
    isPlacingRock = false;
    createBtn.style.opacity = '1';
    createBtn.textContent = 'Create Rock';
    deleteBtn.style.opacity = '0.6';
    deleteBtn.textContent = 'Tap rock to delete...';
    renderer.domElement.style.cursor = 'crosshair';
}

function exitDeleteMode() {
    isDeletingRock = false;
    deleteBtn.style.opacity = '1';
    deleteBtn.textContent = 'Delete Rock';
    renderer.domElement.style.cursor = '';
}

function deleteRockAt(clientX, clientY) {
    const rock = tryPickRock(clientX, clientY);
    if (rock) {
        rock.dispose();
        rocks = rocks.filter(r => r !== rock);
        updateRockCount();
    }
    exitDeleteMode();
}

deleteBtn.addEventListener('click', () => {
    if (isDeletingRock) {
        exitDeleteMode();
    } else {
        enterDeleteMode();
    }
});

// ── Rock placement ──
createBtn.addEventListener('click', () => {
    exitDeleteMode();
    isPlacingRock = true;
    createBtn.style.opacity = '0.6';
    createBtn.textContent = 'Click canvas to place...';
});

function placeRock(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    mouse.x = (clientX - rect.left) / container.clientWidth * 2 - 1;
    mouse.y = -(clientY - rect.top) / container.clientHeight * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(ground);
    if (!intersects.length) return;

    const point = intersects[0].point;
    const dist = Math.sqrt(point.x ** 2 + point.z ** 2);
    if (dist > BOUNDARY) return;

    const selectedShape = shapeSelect.value; // 'random' is its own shape type now
    const rock = new Rock(
        point.x, point.z,
        selectedShape,
        parseFloat(thicknessInput.value),
        parseFloat(sizeInput.value),
        rockText.value.trim()
    );
    rocks.push(rock);

    isPlacingRock = false;
    createBtn.style.opacity = '1';
    createBtn.textContent = 'Create Rock';
    rockText.value = '';
    updateTextLimit();
    updateRockCount();
}

renderer.domElement.addEventListener('click', (e) => {
    if (isDeletingRock) {
        deleteRockAt(e.clientX, e.clientY);
        return;
    }
    if (!isPlacingRock) return;
    placeRock(e.clientX, e.clientY);
});

clearBtn.addEventListener('click', () => {
    rocks.forEach(rock => rock.dispose());
    rocks = [];
    isPlacingRock = false;
    exitDeleteMode();
    createBtn.style.opacity = '1';
    createBtn.textContent = 'Create Rock';
    updateRockCount();
});

// ── Rock dragging (mouse) ──
let draggedRock = null;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPoint = new THREE.Vector3();

function getMouseNDC(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    mouse.x = (clientX - rect.left) / container.clientWidth * 2 - 1;
    mouse.y = -(clientY - rect.top) / container.clientHeight * 2 + 1;
}

function tryPickRock(clientX, clientY) {
    getMouseNDC(clientX, clientY);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(rocks.map(r => r.mesh));
    if (!hits.length) return null;
    return hits[0].object.userData.rock;
}

function moveDraggedRock(clientX, clientY) {
    getMouseNDC(clientX, clientY);
    raycaster.setFromCamera(mouse, camera);
    // Use a horizontal drag plane at the rock's current Y
    const hPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -draggedRock.position.y);
    raycaster.ray.intersectPlane(hPlane, dragPoint);

    if (!dragPoint) return;

    // Clamp to boundary
    const dist = Math.sqrt(dragPoint.x ** 2 + dragPoint.z ** 2);
    if (dist > BOUNDARY) {
        const angle = Math.atan2(dragPoint.z, dragPoint.x);
        dragPoint.x = Math.cos(angle) * BOUNDARY;
        dragPoint.z = Math.sin(angle) * BOUNDARY;
    }
    draggedRock.position.x = dragPoint.x;
    draggedRock.position.z = dragPoint.z;
}

renderer.domElement.addEventListener('mousedown', (e) => {
    if (isPlacingRock || isDeletingRock || e.button !== 0) return;
    const rock = tryPickRock(e.clientX, e.clientY);
    if (rock) {
        draggedRock = rock;
        draggedRock.velocity.set(0, 0, 0);
        draggedRock.spinSpeed = 0;
    }
});

renderer.domElement.addEventListener('mousemove', (e) => {
    if (draggedRock) moveDraggedRock(e.clientX, e.clientY);
});

renderer.domElement.addEventListener('mouseup', () => { draggedRock = null; });

// ── Camera rotation (mouse, right-click) ──
let isDraggingCamera = false;
let prevPointer = { x: 0, y: 0 };

function rotateCamera(dx, dy) {
    const radius = camera.position.length();
    const theta = Math.atan2(camera.position.z, camera.position.x) - dx * 0.005;
    const phi = Math.acos(Math.max(-1, Math.min(1, camera.position.y / radius))) + dy * 0.005;
    const clampedPhi = Math.max(0.2, Math.min(Math.PI / 2 - 0.1, phi));

    camera.position.x = radius * Math.sin(clampedPhi) * Math.cos(theta);
    camera.position.y = radius * Math.cos(clampedPhi);
    camera.position.z = radius * Math.sin(clampedPhi) * Math.sin(theta);
    camera.lookAt(0, 0, 0);
}

renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
        isDraggingCamera = true;
        prevPointer = { x: e.clientX, y: e.clientY };
    }
});

renderer.domElement.addEventListener('mousemove', (e) => {
    if (!isDraggingCamera || e.buttons !== 2) return;
    rotateCamera(e.clientX - prevPointer.x, e.clientY - prevPointer.y);
    prevPointer = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('mouseup', () => { isDraggingCamera = false; });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Touch support ──
let touchCameraActive = false;
let touchStartTime = 0;
let touchStartPos = { x: 0, y: 0 };
let touchMoved = false;
const TAP_THRESHOLD = 10; // px

renderer.domElement.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    touchStartTime = Date.now();
    touchStartPos = { x: touch.clientX, y: touch.clientY };
    touchMoved = false;

    if (isPlacingRock) {
        placeRock(touch.clientX, touch.clientY);
        return;
    }

    if (isDeletingRock) {
        // Handle on touchend so we can distinguish tap vs drag
        return;
    }

    const rock = tryPickRock(touch.clientX, touch.clientY);
    if (rock) {
        draggedRock = rock;
        draggedRock.velocity.set(0, 0, 0);
        draggedRock.spinSpeed = 0;
        touchCameraActive = false;
    } else {
        prevPointer = { x: touch.clientX, y: touch.clientY };
        touchCameraActive = true;
    }
}, { passive: false });

renderer.domElement.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];

    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_THRESHOLD) touchMoved = true;

    if (draggedRock) {
        moveDraggedRock(touch.clientX, touch.clientY);
    } else if (touchCameraActive) {
        rotateCamera(touch.clientX - prevPointer.x, touch.clientY - prevPointer.y);
        prevPointer = { x: touch.clientX, y: touch.clientY };
    }
}, { passive: false });

renderer.domElement.addEventListener('touchend', (e) => {
    e.preventDefault();

    if (isDeletingRock && !touchMoved) {
        deleteRockAt(touchStartPos.x, touchStartPos.y);
    }

    draggedRock = null;
    touchCameraActive = false;
}, { passive: false });

// ── Resize ──
function handleWindowResize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}
window.addEventListener('resize', handleWindowResize);

// Also handle orientation change on mobile
window.addEventListener('orientationchange', () => {
    setTimeout(handleWindowResize, 200);
});

// ── FPS counter ──
function updateFPS() {
    const now = Date.now();
    if (now - lastFpsTime >= 1000) {
        fpsCounter.textContent = frameCount;
        frameCount = 0;
        lastFpsTime = now;
    }
}

// ── Animation loop ──
function animate() {
    requestAnimationFrame(animate);
    rocks.forEach(rock => rock.update());
    resolveCollisions();
    frameCount++;
    updateFPS();
    renderer.render(scene, camera);
}

animate();
updateRockCount();