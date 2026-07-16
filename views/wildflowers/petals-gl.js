/* petals-gl.js : grows the bouquet and the meadow out of three.js meshes.
   All the math comes from logic.js (which itself imports the flower DNA from
   ../flowers/logic.js); this file only turns pure specs into GPU work.

   The rendering strategy, and why it is cheap where the CSS version is dear:

   - Every repeated part (petal, bud, core, stamen, stalk, grass blade) is an
     InstancedMesh: one draw call carries every copy of that part on stage,
     whether there are twelve or twelve thousand.
   - A petal instance's matrix places it CLOSED. Its opening angle rides in a
     per-instance attribute (aOpen) and the actual opening happens in the
     vertex shader, scaled by the uBloom uniform: the bloom slider animates a
     hundred thousand petals by writing ONE float per frame. Wind works the
     same way (aWind = phase, base height, top height per instance; stalks
     shear by height, heads follow their stalk tips, petals flutter).
   - The graft below rewrites three.js's own material shaders (begin_vertex /
     project_vertex chunks), so lighting, shadows, and fog all keep working.

   Sign conventions: petal geometry grows +y from its hinge at the origin and
   shows its "sky" face toward +z; a positive rotation about +x opens it
   outward. The CSS scene's y-down numbers cross over as worldY = CSS_GROUND_Y
   - cssY (ground at 0). */

import * as THREE from 'three';
import {
  PETAL_SHAPES, petalGeometryData, petalVertexColors,
  SPECIES, bouquetPlan, stemPlan, meadowField, grassField,
  WRAP, wrapPoint, CSS_GROUND_Y, cssPlaneEquivalent,
  rampHex, jitter, lerp, clamp,
} from './logic.js';

const D2R = Math.PI / 180;

/* ==========================================================================
   Shared uniforms: the whole garden animates off these three floats.
   ========================================================================== */

export const uniforms = {
  uTime: { value: 0 },
  uWind: { value: 0 },
  uBloom: { value: 1 },
};

/* Graft the bloom/wind pipeline into any built-in material's vertex shader.
   Works for the lit materials (which have beginnormal_vertex) and for
   MeshDepthMaterial (which does not), so shadows bloom and sway too. */
function graft(shader) {
  shader.uniforms.uTime = uniforms.uTime;
  shader.uniforms.uWind = uniforms.uWind;
  shader.uniforms.uBloom = uniforms.uBloom;
  let vs = shader.vertexShader;
  vs = vs.replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWind;
uniform float uBloom;
attribute float aOpen;
attribute vec3 aWind;`);
  /* Each patch declares its own cos/sin: in MeshDepthMaterial the
     beginnormal chunk only exists inside an #ifdef, so the two injection
     sites cannot share declarations. */
  const decl = (tag) => `
  float wfA${tag} = aOpen * uBloom + sin(uTime * 2.1 + aWind.x * 5.0) * uWind * 0.045;
  float wfC${tag} = cos(wfA${tag});
  float wfS${tag} = sin(wfA${tag});`;
  const spin = (v, tag) =>
    `vec3(${v}.x, wfC${tag} * ${v}.y - wfS${tag} * ${v}.z, wfS${tag} * ${v}.y + wfC${tag} * ${v}.z)`;
  vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>${decl('N')}
  objectNormal = ${spin('objectNormal', 'N')};`);
  vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>${decl('P')}
  transformed = ${spin('transformed', 'P')};`);
  vs = vs.replace('#include <project_vertex>', `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  float wfK = clamp((mvPosition.y - aWind.y) / max(aWind.z, 1.0), 0.0, 1.0);
  wfK *= wfK;
  mvPosition.x += (sin(uTime * 1.35 + aWind.x) + sin(uTime * 0.47 + aWind.x * 1.7) * 0.6) * uWind * wfK * 9.0;
  mvPosition.z += cos(uTime * 1.13 + aWind.x * 1.3) * uWind * wfK * 4.5;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`);
  shader.vertexShader = vs;
}

function grafted(mat) {
  mat.onBeforeCompile = graft;
  return mat;
}

function makeDepthMaterial() {
  return grafted(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
}

/* ==========================================================================
   Geometry helpers
   ========================================================================== */

const scratchColor = new THREE.Color();

/* Vertex color arrays are authored in sRGB hexes (the same ones style.css
   paints with); convert them into the renderer's linear working space. */
function linearColors(srgb) {
  const out = new Float32Array(srgb.length);
  for (let i = 0; i < srgb.length; i += 3) {
    scratchColor.setRGB(srgb[i], srgb[i + 1], srgb[i + 2], THREE.SRGBColorSpace);
    out[i] = scratchColor.r;
    out[i + 1] = scratchColor.g;
    out[i + 2] = scratchColor.b;
  }
  return out;
}

function petalGeometry(shapeKey, tones, lod) {
  const [segU, segV] = lod === 'low' ? [4, 6] : [8, 11];
  const data = petalGeometryData(PETAL_SHAPES[shapeKey], segU, segV);
  const geo = new THREE.BufferGeometry();
  geo.setIndex(data.indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(
    linearColors(petalVertexColors(data.rows, data.cols, tones)), 3));
  geo.computeVertexNormals();
  return geo;
}

/* Color a geometry along its height: stops are [fraction of maxY, hex]. */
function colorByHeight(geo, stops, maxY) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getY(i) / maxY, 0, 1);
    let hex = stops[0][1];
    for (const [until, h] of stops) {
      hex = h;
      if (t <= until) break;
    }
    scratchColor.set(hex);
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/* Smooth two-tone gradient along height (for tubes and blades). */
function gradientByHeight(geo, hexA, hexB, maxY) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getY(i) / maxY, 0, 1);
    scratchColor.set(rampHex([hexA, hexA, hexB], 0.5 + t * 0.5));
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/* A new geometry that SHARES the base's vertex data but carries its own
   per-instance attributes (each bucket needs its own aOpen/aWind). */
function shareGeometry(base) {
  const g = new THREE.BufferGeometry();
  g.index = base.index;
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.attributes[name]);
  }
  return g;
}

/* Merge a list of geometries that all carry the same attributes. Used for
   the bouquet's stem tubes: up to ~20 curved tubes become ONE mesh. */
function mergeGeometries(geos, attrNames) {
  const merged = new THREE.BufferGeometry();
  const indices = [];
  const arrays = Object.fromEntries(attrNames.map((n) => [n, []]));
  let offset = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    for (const n of attrNames) {
      arrays[n].push(...g.attributes[n].array);
    }
    for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + offset);
    offset += count;
    g.dispose();
  }
  for (const n of attrNames) {
    const itemSize = n === 'aOpen' ? 1 : 3;
    merged.setAttribute(n, new THREE.Float32BufferAttribute(arrays[n], itemSize));
  }
  merged.setIndex(indices);
  return merged;
}

/* ==========================================================================
   Procedural textures (no image files anywhere on this site's 3D pages).
   ========================================================================== */

let seedTex = null;
function seedTexture() {
  if (seedTex) return seedTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2c1a07';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 340; i++) {
    const r = Math.sqrt(i / 340) * 62;
    const a = i * 2.39996;
    ctx.fillStyle = i % 3 ? '#4a2c0e' : '#7a5218';
    ctx.beginPath();
    ctx.arc(64 + r * Math.cos(a), 64 + r * Math.sin(a), 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  seedTex = new THREE.CanvasTexture(c);
  seedTex.colorSpace = THREE.SRGBColorSpace;
  seedTex.wrapS = seedTex.wrapT = THREE.RepeatWrapping;
  return seedTex;
}

let groundTex = null;
function groundTexture() {
  if (groundTex) return groundTex;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 256);
  g.addColorStop(0, '#1c2820');
  g.addColorStop(0.45, '#111812');
  g.addColorStop(1, '#0a100b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  groundTex = new THREE.CanvasTexture(c);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  return groundTex;
}

/* ==========================================================================
   Buckets: everything repeated accumulates records per (part, colorway),
   then builds into one InstancedMesh each. This is the whole trick.
   ========================================================================== */

class Buckets {
  constructor(lod = 'high') {
    this.lod = lod;
    this.map = new Map();
  }

  get(key, factory) {
    let b = this.map.get(key);
    if (!b) {
      b = Object.assign({ matrices: [], opens: [], winds: [], castShadow: true }, factory());
      this.map.set(key, b);
    }
    return b;
  }

  petal(shapeKey, tones, opts = {}) {
    return this.get(`petal:${shapeKey}:${tones[0]}`, () => ({
      geo: petalGeometry(shapeKey, tones, this.lod),
      /* The soft emissive floor is the poor botanist's subsurface scattering:
         a petal's shaded back glows its own body tone instead of going black
         under the night lighting. */
      mat: grafted(new THREE.MeshStandardMaterial({
        vertexColors: true, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
        emissive: new THREE.Color(tones[1]), emissiveIntensity: 0.16,
        ...opts.material,
      })),
      castShadow: opts.castShadow ?? true,
    }));
  }

  solid(key, makeGeo, matOpts = {}, opts = {}) {
    return this.get(key, () => {
      const params = { roughness: 0.7, metalness: 0, ...matOpts };
      if (params.color && !params.map) {
        params.emissive = new THREE.Color(params.color);
        params.emissiveIntensity = 0.1;
      }
      return {
        geo: makeGeo(),
        mat: grafted(new THREE.MeshStandardMaterial(params)),
        castShadow: opts.castShadow ?? true,
      };
    });
  }

  add(bucket, matrix, open, wind) {
    bucket.matrices.push(matrix);
    bucket.opens.push(open);
    bucket.winds.push(wind[0], wind[1], wind[2]);
  }

  buildInto(group) {
    let total = 0;
    for (const b of this.map.values()) {
      const n = b.matrices.length;
      if (!n) { b.geo.dispose(); b.mat.dispose(); continue; }
      total += n;
      const geo = shareGeometry(b.geo);
      geo.setAttribute('aOpen', new THREE.InstancedBufferAttribute(new Float32Array(b.opens), 1));
      geo.setAttribute('aWind', new THREE.InstancedBufferAttribute(new Float32Array(b.winds), 3));
      const mesh = new THREE.InstancedMesh(geo, b.mat, n);
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, b.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false; // instances span the scene; the geometry's own bounds lie
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = false;
      mesh.customDepthMaterial = makeDepthMaterial();
      group.add(mesh);
    }
    return total;
  }
}

/* ==========================================================================
   Planting: one flower head into the buckets.
   ========================================================================== */

const _m = new THREE.Matrix4();

function rotY(m, deg) { return m.multiply(_m.makeRotationY(deg * D2R)); }
function rotX(m, deg) { return m.multiply(_m.makeRotationX(deg * D2R)); }
function rotZ(m, deg) { return m.multiply(_m.makeRotationZ(deg * D2R)); }
function move(m, x, y, z) { return m.multiply(_m.makeTranslation(x, y, z)); }
function size(m, s) { return m.multiply(_m.makeScale(s, s, s)); }

/* A dome seat (CSS frame) as a world matrix: azimuth, out to radius, up to
   height, leaned outward, scaled. Mirrors the CSS seat node exactly. */
function seatMatrix(seat) {
  const m = new THREE.Matrix4().makeRotationY(seat.a * D2R);
  move(m, 0, CSS_GROUND_Y - seat.y, seat.r);
  rotX(m, seat.tilt ?? 0);
  return size(m, seat.s ?? 1);
}

/* A bare vertical spine: unit-height cylinder scaled to length per instance.
   The species that carry their own visible stalk above the seat (lavender,
   eucalyptus, baby's breath) hang their parts on one of these, exactly like
   the CSS builders' stemCross. */
function spine(buckets, baseM, h, wind) {
  const bucket = buckets.solid('spine', () => {
    const geo = new THREE.CylinderGeometry(0.9, 1.3, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    return geo;
  }, { color: '#48663c', roughness: 0.9 }, { castShadow: false });
  const m = baseM.clone();
  m.multiply(_m.makeScale(1, h, 1));
  buckets.add(bucket, m, 0, wind);
}

function plantHead(buckets, si, vi, seed, tier, headM, wind, opts = {}) {
  const def = SPECIES[si];
  const tones = def.variants[vi].tones;

  if (def.kind === 'spike') {
    /* Lavender: whorls of buds up an implied spine. In the bouquet the seat
       already sits sunk (seatAdjust); in the meadow spikeDrop pulls the first
       whorl down onto the stalk tip. */
    const drop = opts.spikeDrop ?? 0;
    spine(buckets, headM, 88 - drop, wind);
    const bucket = buckets.petal(def.shape, tones);
    for (const w of def.specs(seed, tier)) {
      const m = headM.clone();
      rotY(m, w.azimuth + jitter(seed, 8));
      move(m, 0, -w.y - drop, 0); // w.y is CSS-negative-up
      move(m, 0, 0, def.push);
      if (w.size !== 1) size(m, w.size);
      buckets.add(bucket, m, 40 * D2R, wind);
    }
    const tip = move(headM.clone(), 0, 90 - drop, 0);
    buckets.add(bucket, tip, 0, wind);
    return;
  }

  const bucket = buckets.petal(def.shape, tones);
  for (const spec of def.specs(seed, tier)) {
    const m = headM.clone();
    rotY(m, spec.azimuth);
    if (spec.lift) move(m, 0, -spec.lift, 0);
    if (spec.twist) rotZ(m, spec.twist);
    move(m, 0, 0, def.push ?? 2);
    const s = spec.size ?? 1;
    if (s !== 1) size(m, s);
    buckets.add(bucket, m, Math.max(0, spec.open) * D2R, wind);
  }

  if (def.core) {
    const { kind, r, squash = 1, color, dotted } = def.core;
    const bucket = buckets.solid(`core:${def.key}`, () => {
      const geo = kind === 'button'
        ? new THREE.SphereGeometry(r, 20, 12)
        : new THREE.IcosahedronGeometry(r, 2);
      return geo;
    }, dotted ? { map: seedTexture(), color: '#ffffff' } : { color });
    const m = headM.clone();
    move(m, 0, kind === 'button' ? 3 : 4, 0);
    if (squash !== 1) m.multiply(_m.makeScale(1, squash, 1));
    buckets.add(bucket, m, 0, wind);
  }

  if (def.stamens) {
    const st = def.stamens;
    const bucket = buckets.solid(`stamen:${def.key}`, () => {
      const pts = [
        new THREE.Vector2(0.55, 0),
        new THREE.Vector2(0.4, st.len * 0.72),
        new THREE.Vector2(1.7, st.len * 0.85),
        new THREE.Vector2(1.3, st.len * 0.96),
        new THREE.Vector2(0.05, st.len),
      ];
      const geo = new THREE.LatheGeometry(pts, 7);
      colorByHeight(geo, [[0.7, st.color], [1, st.anther]], st.len);
      return geo;
    }, { vertexColors: true }, { castShadow: false });
    for (let i = 0; i < st.count; i++) {
      const m = headM.clone();
      rotY(m, (i * 360) / st.count + jitter(i, 6));
      move(m, 0, -1, 1.5);
      buckets.add(bucket, m, (st.open + jitter(i, 5, 3)) * D2R, wind);
    }
  }
}

/* ==========================================================================
   The world: ground, moonlight, stars. Created once and kept.
   ========================================================================== */

export function createWorld(scene) {
  scene.fog = new THREE.Fog(new THREE.Color('#0b100c'), 1300, 3400);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(3400, 72).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1, metalness: 0 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const hemi = new THREE.HemisphereLight(new THREE.Color('#3c4c42'), new THREE.Color('#131810'), 0.95);
  scene.add(hemi);

  const moon = new THREE.DirectionalLight(new THREE.Color('#f2e4c4'), 2.2);
  moon.position.set(-380, 640, 320);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 1.6;
  moon.shadow.radius = 5;
  moon.shadow.camera.near = 10;
  moon.shadow.camera.far = 2400;
  scene.add(moon, moon.target);

  const fill = new THREE.DirectionalLight(new THREE.Color('#8fa7f2'), 0.7);
  fill.position.set(420, 220, -380);
  scene.add(fill);

  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(420 * 3);
  for (let i = 0; i < 420; i++) {
    const a = (i * 2.39996) + jitter(i, 0.6, 3);
    const y = 250 + Math.abs(jitter(i, 1, 5)) * 2100;
    const r = Math.sqrt(Math.max(0, 2900 * 2900 - y * y));
    starPos[i * 3] = r * Math.cos(a);
    starPos[i * 3 + 1] = y;
    starPos[i * 3 + 2] = r * Math.sin(a);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: new THREE.Color('#cfdaf0'), size: 1.8, sizeAttenuation: false,
    transparent: true, opacity: 0.7, depthWrite: false, fog: false,
  }));
  scene.add(stars);

  const setShadowRange = (range) => {
    const cam = moon.shadow.camera;
    cam.left = -range; cam.right = range; cam.top = range; cam.bottom = -range;
    cam.updateProjectionMatrix();
  };
  setShadowRange(340);

  return { moon, setShadowRange };
}

/* ==========================================================================
   The bouquet: wrap, tissue, curved stems, dome-seated heads and greens.
   Everything spatial comes from the SAME functions the CSS version calls.
   ========================================================================== */

const STEM_LIGHT = '#6f9457';
const STEM_DARK = '#35522e';

function stemTube(seat, { seed, footY = 0, dark = false }, wind) {
  const pts = stemPlan(seat, { samples: 14, seed, footY }).map((p) =>
    new THREE.Vector3(0, CSS_GROUND_Y - p.y, p.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), seat.a * D2R));
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 1.35, 5, false);
  /* Per-vertex ring index -> gradient along the stalk (head end light). */
  const count = geo.attributes.position.count;
  const rows = 15; // tubularSegments + 1
  const perRow = count / rows;
  const colors = new Float32Array(count * 3);
  const winds = new Float32Array(count * 3);
  const opens = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = Math.floor(i / perRow) / (rows - 1); // 0 at head, 1 at bind
    scratchColor.set(rampHex([dark ? STEM_DARK : STEM_LIGHT, '#4d6b40', STEM_DARK], t));
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
    winds[i * 3] = wind[0];
    winds[i * 3 + 1] = wind[1];
    winds[i * 3 + 2] = wind[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aWind', new THREE.BufferAttribute(winds, 3));
  geo.setAttribute('aOpen', new THREE.BufferAttribute(opens, 1));
  geo.deleteAttribute('uv');
  return geo;
}

function wrapSurface(spec, phase, tones) {
  const T = 96;
  const V = 8;
  const positions = [];
  const colors = [];
  for (let j = 0; j <= V; j++) {
    for (let i = 0; i < T; i++) {
      const { r, y } = wrapPoint(i / T, j / V, spec, phase);
      positions.push(r * Math.sin((i / T) * Math.PI * 2), y, r * Math.cos((i / T) * Math.PI * 2));
      scratchColor.set(rampHex(tones, j / V));
      colors.push(scratchColor.r, scratchColor.g, scratchColor.b);
    }
  }
  const indices = [];
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < T; i++) {
      const a = j * T + i;
      const b = j * T + ((i + 1) % T);
      const c = (j + 1) * T + i;
      const d = (j + 1) * T + ((i + 1) % T);
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function paperMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
    emissive: new THREE.Color('#8a6136'), emissiveIntensity: 0.12,
  });
}

function wrapMeshes(group) {
  const outer = new THREE.Mesh(wrapSurface(WRAP, 0, ['#8a5c2e', '#c79a63', '#d8b184']), paperMaterial());
  outer.castShadow = true;
  const liner = new THREE.Mesh(wrapSurface(
    { ...WRAP, rTop: WRAP.rTop - 5, rBottom: WRAP.rBottom - 4, height: WRAP.height - 6 },
    0.5, ['#5a3c1e', '#6e4a26', '#8a6136'],
  ), paperMaterial());
  group.add(outer, liner);

  /* Ribbon band at the CSS band height, radius read off the cone slope. */
  const bandY = 90;
  const rBand = WRAP.rBottom + (WRAP.rTop - WRAP.rBottom) * (bandY / WRAP.height);
  const satin = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#b25672'), roughness: 0.38, metalness: 0.12, side: THREE.DoubleSide,
    emissive: new THREE.Color('#b25672'), emissiveIntensity: 0.1,
  });
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(rBand + 2.2, rBand + 4.6, 16, 64, 1, true), satin);
  ribbon.position.y = bandY;
  ribbon.castShadow = true;
  const knot = new THREE.Mesh(new THREE.IcosahedronGeometry(6.5, 1), satin);
  knot.position.set(0, bandY, rBand + 5.5);
  knot.scale.set(1.15, 0.8, 0.65);
  group.add(ribbon, knot);
}

function greens(buckets, stemGeos, n, tier) {
  if (!n) return;
  const ring = (count, offset, fn) => {
    for (let i = 0; i < count; i++) fn(i, offset + (i * 360) / count);
  };

  /* Baby's breath: a stem that ends in a cloud of tiny puffs. */
  ring(clamp(Math.round(n / 3), 1, 3), 34, (i, a) => {
    const seat = { a: a + jitter(i, 14), r: 68, y: -40, tilt: 28, s: 1 };
    const wind = [3.1 * i + 11, 8, CSS_GROUND_Y - seat.y + 60];
    stemGeos.push(stemTube(seat, { seed: 30 + i, footY: 60, dark: true }, wind));
    const m0 = seatMatrix(seat);
    spine(buckets, m0, 74, wind);
    const bucket = buckets.solid('puff', () => new THREE.IcosahedronGeometry(4.6, 1),
      { color: '#f2eeda', roughness: 0.9 }, { castShadow: false });
    for (let k = 0; k < 7; k++) {
      const m = m0.clone();
      move(m, jitter(k + i * 4 + 1, 19), 48 + k * 9 + jitter(k + i * 4 + 1, 7, 3), jitter(k + i * 4 + 1, 19, 5));
      size(m, 0.8 + Math.abs(jitter(k, 0.45, 7)));
      buckets.add(bucket, m, 0, wind);
    }
  });

  /* Eucalyptus: pairs of round leaves up a dark stalk. */
  ring(clamp(Math.round(n / 4), 1, 3), 92, (i, a) => {
    const seat = { a: a + jitter(i, 16, 3), r: 66, y: -38, tilt: 34, s: 1 };
    const wind = [4.7 * i + 23, 8, CSS_GROUND_Y - seat.y + 70];
    stemGeos.push(stemTube(seat, { seed: 40 + i, footY: 66, dark: true }, wind));
    const m0 = seatMatrix(seat);
    spine(buckets, m0, 106, wind);
    const bucket = buckets.petal('leafRound', ['#41603a', '#7fa268', '#a8c48d']);
    for (let k = 0; k < 7; k++) {
      const m = m0.clone();
      rotY(m, (k % 2 ? 100 : 262) + jitter(k + i * 4 + 2, 18));
      move(m, 0, 16 + k * 14, 1.5);
      buckets.add(bucket, m, (58 + jitter(k + i * 4 + 2, 10, 3)) * D2R, wind);
    }
  });

  /* Big single leaves tucked between the heads. */
  ring(clamp(Math.round(n / 4), 1, 3), 152, (i, a) => {
    const seat = { a: a + jitter(i, 18, 5), r: 64, y: -48, tilt: 30, s: 1.1 };
    const wind = [6.3 * i + 31, 8, CSS_GROUND_Y - seat.y + 60];
    stemGeos.push(stemTube(seat, { seed: 50 + i, footY: 44, dark: true }, wind));
    const bucket = buckets.petal('leafBlade', ['#33502c', '#5c8047', '#8fb573']);
    const m = seatMatrix(seat);
    rotY(m, jitter(i, 14, 5));
    rotZ(m, jitter(i, 10, 9));
    buckets.add(bucket, m, (52 + jitter(i, 6, 7)) * D2R, wind);
  });
}

function tissueRing(buckets) {
  const bucket = buckets.petal('tissue', ['#c98b9b', '#e4a8b4', '#f6d6dc'], {
    castShadow: false,
    material: { roughness: 0.95 },
  });
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Matrix4().makeRotationY((11 + i * 40 + jitter(i, 8)) * D2R);
    move(m, 0, CSS_GROUND_Y - 8, 62);
    rotZ(m, jitter(i, 9, 5));
    buckets.add(bucket, m, (26 + jitter(i, 7, 3)) * D2R, [i * 2.3, 8, 190]);
  }
}

function fallenPetals(buckets, tones) {
  const bucket = buckets.petal('rose', tones, { castShadow: false });
  const spots = [
    { x: -128, z: 52, ry: 24 },
    { x: 118, z: -30, ry: -50 },
    { x: 74, z: 116, ry: 130 },
  ];
  spots.forEach((sp, i) => {
    const m = new THREE.Matrix4().makeTranslation(sp.x, 1.4, sp.z);
    rotY(m, sp.ry);
    rotX(m, -86 + jitter(i, 6));
    size(m, 0.62);
    buckets.add(bucket, m, 0, [0, 0, 1]);
  });
}

export function buildBouquet(order, { tier = 'full' } = {}) {
  const group = new THREE.Group();
  const buckets = new Buckets('high');
  const plan = bouquetPlan(order);
  const stemGeos = [];

  for (const rec of plan) {
    const def = SPECIES[rec.species];
    const headM = seatMatrix(rec.seat);
    const headY = CSS_GROUND_Y - rec.seat.y;
    const wind = [1.7 * rec.seed + 0.9, 8, Math.max(40, headY - 8)];
    plantHead(buckets, rec.species, rec.variant, rec.seed, tier, headM, wind);
    stemGeos.push(stemTube(rec.seat, {
      seed: rec.seed + 1,
      footY: def.stemFoot ?? 0,
      dark: def.stemFoot != null,
    }, wind));
  }

  greens(buckets, stemGeos, plan.length, tier);
  tissueRing(buckets);
  fallenPetals(buckets, SPECIES[plan[0]?.species ?? 0].variants[plan[0]?.variant ?? 0].tones);
  wrapMeshes(group);

  if (stemGeos.length) {
    const stems = new THREE.Mesh(
      mergeGeometries(stemGeos, ['position', 'normal', 'color', 'aWind', 'aOpen']),
      grafted(new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.85,
        emissive: new THREE.Color('#4a6b3e'), emissiveIntensity: 0.12,
      })),
    );
    stems.castShadow = true;
    stems.customDepthMaterial = makeDepthMaterial();
    group.add(stems);
  }

  const instances = buckets.buildInto(group);
  return {
    group,
    stats: {
      stems: plan.length,
      instances,
      cssPlanes: cssPlaneEquivalent(plan) + 96, // + wrap facets, ribbon, tissue, stems
    },
  };
}

/* ==========================================================================
   The meadow: the part the wrap could never hold. One gently-bent unit
   stalk, instanced and scaled per flower; heads planted on the transformed
   tips; grass blades to knit the ground together.
   ========================================================================== */

const STALK_TIP = new THREE.Vector3(6.5, 100, 1.8);

function stalkGeometry() {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1.4, 36, 0.5),
    new THREE.Vector3(3.6, 70, 1.1),
    STALK_TIP.clone(),
  ]);
  const geo = new THREE.TubeGeometry(curve, 7, 1.5, 5, false);
  gradientByHeight(geo, '#24391e', '#5c7a49', 100);
  geo.deleteAttribute('uv');
  return geo;
}

export function buildMeadow(count, { tier = 'lite' } = {}) {
  const group = new THREE.Group();
  const buckets = new Buckets('low');
  /* The camera orbits at ~1140 from the axis: keep the field inside that
     ring or rim flowers slide past the lens as giant petal walls. */
  const field = meadowField(count, { rMin: 130, rMax: 980 });

  const stalkBucket = buckets.solid('stalk', stalkGeometry, { vertexColors: true, roughness: 0.9 });
  const leafBucket = buckets.petal('leafRound', ['#2c4426', '#557a43', '#7fa268'], { castShadow: false });

  field.forEach((f, i) => {
    const def = SPECIES[f.species];
    const stalkM = new THREE.Matrix4().makeTranslation(f.x, 0, f.z);
    rotY(stalkM, f.leanDir);
    stalkM.multiply(_m.makeScale(f.s, f.height / 100, f.s));
    const tip = STALK_TIP.clone().applyMatrix4(stalkM);
    const wind = [f.phase, 0, Math.max(30, tip.y)];
    buckets.add(stalkBucket, stalkM, 0, wind);

    const headM = new THREE.Matrix4().makeTranslation(tip.x, tip.y, tip.z);
    rotY(headM, f.ry);
    rotX(headM, f.lean);
    size(headM, f.s);
    plantHead(buckets, f.species, f.variant, i, tier, headM, wind,
      def.kind === 'spike' ? { spikeDrop: 30 } : undefined);

    if (i % 2 === 0) {
      const mid = new THREE.Vector3(2.9, 45, 0.8).applyMatrix4(stalkM);
      const lm = new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z);
      rotY(lm, (i * 91) % 360);
      size(lm, f.s * 0.9);
      buckets.add(leafBucket, lm, 55 * D2R, wind);
    }
  });

  const grassBucket = buckets.petal('blade', ['#16250f', '#3d5a33', '#7f9a6a'], { castShadow: false });
  for (const b of grassField(Math.min(6500, count * 2 + 400), { rMax: 1060 })) {
    const m = new THREE.Matrix4().makeTranslation(b.x, 0, b.z);
    rotY(m, b.ry);
    rotX(m, b.lean);
    size(m, b.s);
    buckets.add(grassBucket, m, 0, [b.phase, 0, 30 * b.s]);
  }

  const instances = buckets.buildInto(group);
  return {
    group,
    stats: {
      stems: field.length,
      instances,
      cssPlanes: cssPlaneEquivalent(field),
    },
  };
}

/* ==========================================================================
   Housekeeping
   ========================================================================== */

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.customDepthMaterial) o.customDepthMaterial.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
  });
}

export function setWireframe(group, on) {
  group.traverse((o) => {
    if (o.material && !o.isPoints) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if ('wireframe' in m) m.wireframe = on;
      }
    }
  });
}
