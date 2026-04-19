// <rocks-showcase> — embeddable, self-contained rotating view of the saved rocks.
// Pulls from the same rocks controller the editor writes to; renders with the
// shared rock-builder. No physics, no interactivity — just a slow camera orbit.
//
// Usage:
//   <script type="module" src=".../components/rocks/rocks-showcase.js"></script>
//   <rocks-showcase height="400px" speed="0.15"></rocks-showcase>
//
// Attributes:
//   height  — CSS height (default "300px")
//   speed   — camera orbit rad/sec (default 0.15; 0 to disable)
//   tilt    — camera elevation 0-1 (default 0.55; 0=horizon, 1=top-down)
//   src     — API URL override (default resolves to /app/controllers/rocks-controller.php)

import { buildRockMesh, disposeRockMesh } from './rock-builder.js';

const DEFAULT_API = new URL('../../app/controllers/rocks-controller.php', import.meta.url).href;
const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

let threeLoadPromise = null;
function ensureThree() {
    if (window.THREE) return Promise.resolve();
    if (threeLoadPromise) return threeLoadPromise;
    threeLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = THREE_CDN;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load three.js'));
        document.head.appendChild(s);
    });
    return threeLoadPromise;
}

const BOUNDARY = 43;

class RocksShowcase extends HTMLElement {
    constructor() {
        super();
        this._rockMeshes = [];
        this._running = false;
        this._lastTime = 0;
        this._cameraAngle = 0;
    }

    async connectedCallback() {
        this.style.display = 'block';
        this.style.width = this.style.width || '100%';
        this.style.height = this.getAttribute('height') || '300px';
        this.style.overflow = 'hidden';
        this.style.borderRadius = this.style.borderRadius || '12px';

        await ensureThree();
        this._initScene();
        this._loadRocks();
        this._resizeObserver = new ResizeObserver(() => this._handleResize());
        this._resizeObserver.observe(this);
        this._start();
    }

    disconnectedCallback() {
        this._stop();
        this._resizeObserver?.disconnect();
        this._rockMeshes.forEach(m => disposeRockMesh(m));
        this._rockMeshes = [];
        if (this._renderer) {
            this._renderer.dispose();
            if (this._renderer.domElement.parentNode === this) {
                this.removeChild(this._renderer.domElement);
            }
        }
    }

    _getCameraRadius() {
        return (this.clientWidth || 300) <= 600 ? 45 : 28;
    }

    _getDefaultTilt() {
        return (this.clientWidth || 300) <= 600 ? 0.38 : 0.60;
    }

    _initScene() {
        const width = this.clientWidth || 300;
        const height = this.clientHeight || 300;

        this._scene = new THREE.Scene();

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
        this._scene.background = new THREE.CanvasTexture(bgCanvas);
        this._scene.fog = new THREE.Fog(0xffd6e0, 50, 150);

        this._camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        this._updateCameraPosition(0);

        this._renderer = new THREE.WebGLRenderer({ antialias: true });
        this._renderer.setSize(width, height);
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.shadowMap.enabled = true;
        this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.appendChild(this._renderer.domElement);
        this._renderer.domElement.style.display = 'block';

        this._scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(15, 30, 15);
        dir.castShadow = true;
        dir.shadow.mapSize.width = 1024;
        dir.shadow.mapSize.height = 1024;
        dir.shadow.camera.near = 0.5;
        dir.shadow.camera.far = 100;
        dir.shadow.camera.left = -30;
        dir.shadow.camera.right = 30;
        dir.shadow.camera.top = 30;
        dir.shadow.camera.bottom = -30;
        this._scene.add(dir);

        const groundCanvas = document.createElement('canvas');
        groundCanvas.width = 512;
        groundCanvas.height = 512;
        const gCtx = groundCanvas.getContext('2d');
        gCtx.fillStyle = '#e8f5e9';
        gCtx.fillRect(0, 0, 512, 512);
        gCtx.strokeStyle = '#a5d6a7';
        gCtx.lineWidth = 2;
        for (let i = 0; i <= 512; i += 64) {
            gCtx.beginPath(); gCtx.moveTo(i, 0); gCtx.lineTo(i, 512); gCtx.stroke();
            gCtx.beginPath(); gCtx.moveTo(0, i); gCtx.lineTo(512, i); gCtx.stroke();
        }
        const groundTex = new THREE.CanvasTexture(groundCanvas);
        groundTex.wrapS = THREE.RepeatWrapping;
        groundTex.wrapT = THREE.RepeatWrapping;
        groundTex.repeat.set(4, 4);

        const ground = new THREE.Mesh(
            new THREE.CircleGeometry(45, 64),
            new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.8, metalness: 0.1 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this._scene.add(ground);

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(45, 47, 64),
            new THREE.MeshStandardMaterial({ color: 0x81c784, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.01;
        ring.receiveShadow = true;
        this._scene.add(ring);
    }

    _updateCameraPosition(angle) {
        const tiltAttr = this.getAttribute('tilt');
        const tilt = tiltAttr !== null ? parseFloat(tiltAttr) : this._getDefaultTilt();
        const clampedTilt = Math.max(0.05, Math.min(0.95, tilt));
        const phi = (1 - clampedTilt) * (Math.PI / 2);
        const r = this._getCameraRadius();
        this._camera.position.x = r * Math.sin(phi) * Math.cos(angle);
        this._camera.position.y = r * Math.cos(phi);
        this._camera.position.z = r * Math.sin(phi) * Math.sin(angle);
        this._camera.lookAt(0, 2, 0);
    }

    async _loadRocks() {
        const src = this.getAttribute('src') || DEFAULT_API;
        try {
            const res = await fetch(src);
            const data = await res.json();
            if (!Array.isArray(data)) return;
            for (const r of data) {
                const { mesh } = buildRockMesh(r);
                mesh.position.set(r.x, r.thickness / 2, r.z);
                this._scene.add(mesh);
                this._rockMeshes.push(mesh);
            }
        } catch (e) {
            console.warn('[rocks-showcase] failed to load rocks', e);
        }
    }

    _handleResize() {
        if (!this._renderer) return;
        const w = this.clientWidth;
        const h = this.clientHeight;
        if (w === 0 || h === 0) return;
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h);
        this._updateCameraPosition(this._cameraAngle);
    }

    _start() {
        this._running = true;
        this._lastTime = performance.now();
        const tick = (t) => {
            if (!this._running) return;
            const dt = (t - this._lastTime) / 1000;
            this._lastTime = t;
            const speed = parseFloat(this.getAttribute('speed') ?? '0.15');
            this._cameraAngle += speed * dt;
            this._updateCameraPosition(this._cameraAngle);
            this._renderer.render(this._scene, this._camera);
            this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stop() {
        this._running = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
    }
}

customElements.define('rocks-showcase', RocksShowcase);
