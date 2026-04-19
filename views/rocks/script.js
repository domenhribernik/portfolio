import { buildRockMesh, disposeRockMesh, getRandomStoneColor } from '../../components/rocks/rock-builder.js';

// Scene setup
const container = document.getElementById('canvas');
const scene = new THREE.Scene();

// Gradient background
const bgCanvas = document.createElement('canvas');
bgCanvas.width = 512;
bgCanvas.height = 512;
const bgCtx = bgCanvas.getContext('2d');
const gradient = bgCtx.createLinearGradient(0, 0, 0, 512);
gradient.addColorStop(0, '#ffecd2');
gradient.addColorStop(0.5, '#ffd6e0');
gradient.addColorStop(1, '#ffb3c6');
bgCtx.fillStyle = gradient;
bgCtx.fillRect(0, 0, 512, 512);
scene.background = new THREE.CanvasTexture(bgCanvas);
scene.fog = new THREE.Fog(0xffd6e0, 50, 150);

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

// ── Collision helper ──
function getCollisionRadius(rock) {
    if (rock.shape === 'random') return rock.size * (rock.elongation + 1) / 2;
    if (rock.shape === 'heart')  return rock.size * 1.5;
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
    constructor(x, z, shape, thickness, size, text = '', seed = null) {
        // seed = { id, color, elongation, harmonics, settled } — passed when rehydrating from server.
        this.serverId = seed?.id ?? null;        // server-assigned, null until POST returns
        this.id = nextRockId++;                   // local-only id for this session
        this.shape = shape;
        this.thickness = thickness;
        this.size = size;
        this.text = text;
        this.elongation = 1; // overwritten for random shape
        this.harmonics = null;
        this.color = seed?.color ?? getRandomStoneColor();
        this._seed = seed;

        // Settled rocks spawn on the ground (loaded from server); new rocks drop from the sky.
        const startY = seed?.settled ? GROUND_Y + thickness / 2 : 10;
        this.position = new THREE.Vector3(x, startY, z);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.spinAngle = seed?.rotation ?? Math.random() * Math.PI * 2;
        // Settled rocks sit still at the saved rotation; new rocks get a brief settling spin.
        this.spinSpeed = seed?.settled ? 0 : (Math.random() - 0.5) * 0.1;

        this.createMesh();
        scene.add(this.mesh);
    }

    createMesh() {
        const result = buildRockMesh({
            shape: this.shape,
            size: this.size,
            thickness: this.thickness,
            text: this.text,
            color: this.color,
            elongation: this._seed?.elongation,
            harmonics: this._seed?.harmonics,
            rotation: this.spinAngle,
        });
        this.mesh = result.mesh;
        this.textMesh = result.textMesh;
        this.elongation = result.elongation;
        this.harmonics = result.harmonics;
        this.mesh.userData.rock = this;
    }

    applyRotation() {
        // All shapes are already "flat" in geometry space.
        // Just spin around Y.
        this.mesh.rotation.set(0, this.spinAngle, 0);
    }

    dispose() {
        scene.remove(this.mesh);
        disposeRockMesh(this.mesh);
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

// ── Persistence ──
const ROCKS_API = '../../app/controllers/rocks-controller.php';

function rockToPayload(rock) {
    return {
        shape: rock.shape,
        x: rock.position.x,
        z: rock.position.z,
        size: rock.size,
        thickness: rock.thickness,
        text: rock.text,
        color: rock.color,
        elongation: rock.elongation,
        harmonics: rock.harmonics,
        rotation: rock.spinAngle,
    };
}

async function persistAdd(rock) {
    try {
        const res = await fetch(ROCKS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add', rock: rockToPayload(rock) }),
        });
        const data = await res.json();
        if (data?.ok && data.rock?.id) rock.serverId = data.rock.id;
    } catch (e) { console.warn('persistAdd failed', e); }
}

async function persistMove(rock) {
    if (!rock.serverId) return;
    try {
        await fetch(ROCKS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update', id: rock.serverId, x: rock.position.x, z: rock.position.z, rotation: rock.spinAngle }),
        });
    } catch (e) { console.warn('persistMove failed', e); }
}

async function persistDelete(rock) {
    if (!rock.serverId) return;
    try {
        await fetch(ROCKS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id: rock.serverId }),
        });
    } catch (e) { console.warn('persistDelete failed', e); }
}

async function persistClear() {
    try {
        await fetch(ROCKS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear' }),
        });
    } catch (e) { console.warn('persistClear failed', e); }
}

async function loadRocks() {
    try {
        const res = await fetch(ROCKS_API);
        const data = await res.json();
        if (!Array.isArray(data)) return;
        for (const r of data) {
            const rock = new Rock(r.x, r.z, r.shape, r.thickness, r.size, r.text || '', {
                id: r.id,
                color: r.color,
                elongation: r.elongation,
                harmonics: r.harmonics,
                rotation: r.rotation,
                settled: true,
            });
            rocks.push(rock);
        }
        updateRockCount();
    } catch (e) { console.warn('loadRocks failed', e); }
}

// ── Delete mode ──
function enterDeleteMode() {
    isDeletingRock = true;
    isPlacingRock = false;
    createBtn.style.opacity = '1';
    createBtn.textContent = '+ Place Rock';
    deleteBtn.style.opacity = '0.6';
    deleteBtn.textContent = 'Tap to remove...';
    renderer.domElement.style.cursor = 'crosshair';
}

function exitDeleteMode() {
    isDeletingRock = false;
    deleteBtn.style.opacity = '1';
    deleteBtn.textContent = '− Remove Rock';
    renderer.domElement.style.cursor = '';
}

function deleteRockAt(clientX, clientY) {
    const rock = tryPickRock(clientX, clientY);
    if (rock) {
        persistDelete(rock);
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
    createBtn.textContent = 'Tap canvas...';
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
    persistAdd(rock);

    isPlacingRock = false;
    createBtn.style.opacity = '1';
    createBtn.textContent = '+ Place Rock';
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

const clearDialog = document.getElementById('clearDialog');
const clearCancelBtn = document.getElementById('clearCancelBtn');
const clearConfirmBtn = document.getElementById('clearConfirmBtn');

clearBtn.addEventListener('click', () => {
    clearDialog.style.display = 'flex';
});

clearDialog.addEventListener('click', (e) => {
    if (e.target === clearDialog) clearDialog.style.display = 'none';
});

clearCancelBtn.addEventListener('click', () => {
    clearDialog.style.display = 'none';
});

clearConfirmBtn.addEventListener('click', () => {
    clearDialog.style.display = 'none';
    persistClear();
    rocks.forEach(rock => rock.dispose());
    rocks = [];
    isPlacingRock = false;
    exitDeleteMode();
    createBtn.style.opacity = '1';
    createBtn.textContent = '+ Place Rock';
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

renderer.domElement.addEventListener('mouseup', () => {
    if (draggedRock) persistMove(draggedRock);
    draggedRock = null;
});

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

    if (draggedRock && touchMoved) persistMove(draggedRock);
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
loadRocks();