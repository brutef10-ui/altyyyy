/**
 * SmartCross devices: traffic-signal poles (mast arm, vehicle + pedestrian heads, regulator podium),
 * the SmartCross AI camera, edge-computer cabinet, finale camera post, road-works site with an animated
 * excavator, dust particles and honk sound-wave arcs.
 *
 * Draw-call strategy: almost every opaque part is merged into ONE mesh per object that uses a shared
 * MeshPhysicalMaterial driven by a procedural texture atlas (vertex colours for albedo, atlas cells for
 * roughness / metalness / clearcoat / emissive, atlas regions for labels and pictograms).
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const V3 = THREE.Vector3;
const PI = Math.PI, TAU = Math.PI * 2, DEG = Math.PI / 180;
const lerp = THREE.MathUtils.lerp;
const FONT = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =====================================================================================
   Texture atlas: 512² map + ORM (clearcoat, roughness, metalness) + emissive canvases
   ===================================================================================== */
const AT = 512, CELL = 32;
// [clearcoat, roughness, metalness, emissive css?]
const SURF = {
  plastic: [0, .55, 0], gloss: [1, .24, 0], satin: [.35, .38, .04], paint: [.12, .5, .12],
  galv: [0, .4, .78], steel: [0, .5, .82], chrome: [.2, .1, 1], anod: [.6, .25, .9],
  glass: [1, .04, .15], rubber: [0, .9, 0], concrete: [0, .93, 0], earth: [0, 1, 0],
  sheet: [.3, .32, 0], ypaint: [.55, .36, .06], dim: [0, .82, 0], wet: [.8, .08, 0],
  ledG: [.6, .2, 0, '#22ff7a'], ledA: [.6, .2, 0, '#ffa514'], ledB: [.6, .2, 0, '#2f8cff'],
  ledR: [.6, .2, 0, '#ff2a14'], ledW: [.6, .2, 0, '#fff1d6'],
};
const CELLS = {};
const REG = {
  WORD: [0, 64, 512, 64], EDGE: [0, 128, 256, 64], WORKS: [256, 128, 256, 64],
  TRI: [0, 192, 128, 128], PEDR: [128, 192, 128, 128], PEDG: [256, 192, 128, 128], LENS: [384, 192, 128, 128],
  STRIPE: [0, 320, 256, 64], HV: [256, 320, 64, 64], QR: [320, 320, 64, 64], LOGO: [384, 320, 128, 64],
  GRATE: [0, 384, 128, 128], VENT: [128, 384, 128, 128], CHEV: [256, 384, 256, 64],
  DIAL: [256, 448, 64, 64], PLATE: [320, 448, 192, 64],
};
let ATLAS = null;

function fitFont(ctx, text, maxW, size, weight = 700) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) { s = Math.floor(s * maxW / w); ctx.font = `${weight} ${s}px ${FONT}`; }
  return s;
}
function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function scIcon(ctx, cx, cy, R, ring = '#12a150', cross = '#12a150') {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = ring; ctx.lineWidth = R * .2; ctx.beginPath(); ctx.arc(cx, cy, R * .86, 0, TAU); ctx.stroke();
  ctx.strokeStyle = cross; ctx.lineWidth = R * .26;
  ctx.beginPath(); ctx.moveTo(cx - R * .5, cy); ctx.lineTo(cx + R * .5, cy); ctx.moveTo(cx, cy - R * .5); ctx.lineTo(cx, cy + R * .5); ctx.stroke();
  ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(cx, cy, R * .17, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawAtlas(m) {
  const R = REG;
  m.textBaseline = 'middle';
  // --- SmartCross wordmark on shell white
  {
    const [x, y, w, h] = R.WORD;
    m.fillStyle = '#eef0ef'; m.fillRect(x, y, w, h);
    let size = 54;
    m.font = `700 ${size}px ${FONT}`;
    let w1 = m.measureText('Smart').width, w2 = m.measureText('Cross').width;
    let icon = size * 1.0, gap = size * .25, tot = icon + gap + w1 + w2;
    if (tot > w - 30) { size *= (w - 30) / tot; m.font = `700 ${size}px ${FONT}`; w1 = m.measureText('Smart').width; w2 = m.measureText('Cross').width; icon = size; gap = size * .25; tot = icon + gap + w1 + w2; }
    const x0 = x + (w - tot) / 2, cy = y + h / 2;
    scIcon(m, x0 + icon / 2, cy, icon / 2);
    m.fillStyle = '#2a2e33'; m.fillText('Smart', x0 + icon + gap, cy + 2);
    m.fillStyle = '#12a150'; m.fillText('Cross', x0 + icon + gap + w1, cy + 2);
  }
  // --- Edge plate
  {
    const [x, y, w, h] = R.EDGE;
    m.fillStyle = '#c9ccca'; m.fillRect(x, y, w, h);
    m.fillStyle = '#1e2226'; rrPath(m, x + 2, y + 2, w - 4, h - 4, 10); m.fill();
    m.fillStyle = '#16c060'; m.fillRect(x + 12, y + 14, 4, h - 28);
    scIcon(m, x + 40, y + h / 2, 17, '#20d46e', '#ffffff');
    const s = fitFont(m, 'SmartCross EDGE', w - 80, 30, 700);
    m.fillStyle = '#f2f4f3'; m.fillText('SmartCross', x + 64, y + h / 2 + 1);
    const ww = m.measureText('SmartCross ').width;
    m.fillStyle = '#20d46e'; m.fillText('EDGE', x + 64 + ww, y + h / 2 + 1);
    void s;
  }
  // --- «ДОРОЖНЫЕ РАБОТЫ» plaque
  {
    const [x, y, w, h] = R.WORKS;
    m.fillStyle = '#111'; m.fillRect(x, y, w, h);
    m.fillStyle = '#ffd200'; m.fillRect(x + 5, y + 5, w - 10, h - 10);
    fitFont(m, 'ДОРОЖНЫЕ РАБОТЫ', w - 26, 30, 800);
    m.fillStyle = '#111'; m.textAlign = 'center'; m.fillText('ДОРОЖНЫЕ РАБОТЫ', x + w / 2, y + h / 2 + 1); m.textAlign = 'left';
  }
  // --- triangle warning sign "road works" (temporary: yellow field)
  {
    const [x, y] = R.TRI;
    m.fillStyle = '#ffd200'; m.fillRect(x, y, 128, 128);
    const tri = (s, cx, by, col) => { m.fillStyle = col; m.beginPath(); m.moveTo(cx, by - s * .866); m.lineTo(cx + s / 2, by); m.lineTo(cx - s / 2, by); m.closePath(); m.fill(); };
    m.lineJoin = 'round';
    tri(120, x + 64, y + 116, '#d7262b');
    tri(82, x + 64, y + 105, '#ffd200');
    m.fillStyle = '#111'; m.strokeStyle = '#111'; m.lineCap = 'round';
    m.beginPath(); m.arc(x + 58, y + 64, 5, 0, TAU); m.fill();
    m.lineWidth = 6; m.beginPath(); m.moveTo(x + 57, y + 71); m.lineTo(x + 63, y + 88); m.stroke();
    m.lineWidth = 4; m.beginPath(); m.moveTo(x + 63, y + 88); m.lineTo(x + 56, y + 101); m.moveTo(x + 63, y + 88); m.lineTo(x + 70, y + 100); m.stroke();
    m.beginPath(); m.moveTo(x + 58, y + 75); m.lineTo(x + 72, y + 80); m.stroke();
    m.lineWidth = 3; m.beginPath(); m.moveTo(x + 66, y + 70); m.lineTo(x + 78, y + 96); m.stroke();
    m.beginPath(); m.moveTo(x + 73, y + 101); m.lineTo(x + 86, y + 101); m.lineTo(x + 80, y + 92); m.closePath(); m.fill();
    m.beginPath(); m.moveTo(x + 42, y + 102); m.quadraticCurveTo(x + 50, y + 92, x + 56, y + 102); m.fill();
  }
  // --- pedestrian pictograms (white on black)
  {
    const [x, y] = R.PEDR;
    m.fillStyle = '#0c0c0c'; m.fillRect(x, y, 128, 128);
    m.fillStyle = '#fff';
    m.beginPath(); m.arc(x + 64, y + 24, 11, 0, TAU); m.fill();
    rrPath(m, x + 49, y + 39, 30, 46, 6); m.fill();
    rrPath(m, x + 40, y + 41, 9, 40, 4); m.fill(); rrPath(m, x + 79, y + 41, 9, 40, 4); m.fill();
    rrPath(m, x + 50, y + 80, 12, 40, 4); m.fill(); rrPath(m, x + 66, y + 80, 12, 40, 4); m.fill();
  }
  {
    const [x, y] = R.PEDG;
    m.fillStyle = '#0c0c0c'; m.fillRect(x, y, 128, 128);
    m.fillStyle = '#fff'; m.strokeStyle = '#fff'; m.lineCap = 'round'; m.lineJoin = 'round';
    m.beginPath(); m.arc(x + 70, y + 20, 11, 0, TAU); m.fill();
    m.lineWidth = 17; m.beginPath(); m.moveTo(x + 67, y + 40); m.lineTo(x + 61, y + 70); m.stroke();
    m.lineWidth = 11;
    m.beginPath(); m.moveTo(x + 61, y + 70); m.lineTo(x + 47, y + 94); m.lineTo(x + 38, y + 117); m.stroke();
    m.beginPath(); m.moveTo(x + 62, y + 72); m.lineTo(x + 77, y + 94); m.lineTo(x + 92, y + 112); m.stroke();
    m.lineWidth = 8;
    m.beginPath(); m.moveTo(x + 66, y + 42); m.lineTo(x + 51, y + 58); m.lineTo(x + 44, y + 75); m.stroke();
    m.beginPath(); m.moveTo(x + 67, y + 42); m.lineTo(x + 82, y + 56); m.lineTo(x + 94, y + 64); m.stroke();
  }
  // --- LED lens texture (radial falloff + LED dots + fresnel rings)
  {
    const [x, y] = R.LENS, cx = x + 64, cy = y + 64;
    m.fillStyle = '#6a6a6a'; m.fillRect(x, y, 128, 128);
    const g = m.createRadialGradient(cx, cy, 2, cx, cy, 64);
    g.addColorStop(0, '#d8d8d8'); g.addColorStop(.75, '#a8a8a8'); g.addColorStop(1, '#6e6e6e');
    m.fillStyle = g; m.beginPath(); m.arc(cx, cy, 64, 0, TAU); m.fill();
    for (let j = -7; j <= 7; j++) for (let i = -7; i <= 7; i++) {
      const px = cx + (i + (j & 1) * .5) * 8.4, py = cy + j * 7.3, d = Math.hypot(px - cx, py - cy);
      if (d > 56) continue;
      m.fillStyle = `rgba(255,255,255,${(.95 - d / 140).toFixed(3)})`;
      m.beginPath(); m.arc(px, py, 2.9, 0, TAU); m.fill();
    }
    m.strokeStyle = 'rgba(255,255,255,.18)'; m.lineWidth = 1.5;
    for (let r = 14; r < 62; r += 12) { m.beginPath(); m.arc(cx, cy, r, 0, TAU); m.stroke(); }
  }
  // --- red/white barrier stripes
  {
    const [x, y, w, h] = R.STRIPE;
    m.save(); m.beginPath(); m.rect(x, y, w, h); m.clip();
    m.fillStyle = '#f4f4f1'; m.fillRect(x, y, w, h);
    m.fillStyle = '#d4232a';
    for (let k = -2; k < 9; k++) { const sx = x + k * 42; m.beginPath(); m.moveTo(sx, y + h); m.lineTo(sx + 21, y + h); m.lineTo(sx + 21 + h, y); m.lineTo(sx + h, y); m.closePath(); m.fill(); }
    m.restore();
  }
  // --- high-voltage sticker
  {
    const [x, y] = R.HV;
    m.fillStyle = '#f5f5f2'; m.fillRect(x, y, 64, 64);
    m.fillStyle = '#111'; m.beginPath(); m.moveTo(x + 32, y + 4); m.lineTo(x + 61, y + 56); m.lineTo(x + 3, y + 56); m.closePath(); m.fill();
    m.fillStyle = '#ffd000'; m.beginPath(); m.moveTo(x + 32, y + 12); m.lineTo(x + 54, y + 52); m.lineTo(x + 10, y + 52); m.closePath(); m.fill();
    m.fillStyle = '#111'; m.beginPath(); m.moveTo(x + 35, y + 20); m.lineTo(x + 25, y + 37); m.lineTo(x + 32, y + 37); m.lineTo(x + 28, y + 50); m.lineTo(x + 40, y + 31); m.lineTo(x + 33, y + 31); m.closePath(); m.fill();
  }
  // --- QR-ish asset sticker
  {
    const [x, y] = R.QR, rnd = mulberry32(77);
    m.fillStyle = '#fff'; m.fillRect(x, y, 64, 64);
    m.fillStyle = '#111';
    for (let j = 0; j < 19; j++) for (let i = 0; i < 19; i++) if (rnd() < .45) m.fillRect(x + 4 + i * 3, y + 4 + j * 3, 3, 3);
    for (const [fx, fy] of [[4, 4], [43, 4], [4, 43]]) { m.fillStyle = '#111'; m.fillRect(x + fx, y + fy, 17, 17); m.fillStyle = '#fff'; m.fillRect(x + fx + 3, y + fy + 3, 11, 11); m.fillStyle = '#111'; m.fillRect(x + fx + 6, y + fy + 6, 5, 5); }
  }
  // --- logo badge
  {
    const [x, y, w, h] = R.LOGO;
    m.fillStyle = '#1e2226'; m.fillRect(x, y, w, h);
    scIcon(m, x + 32, y + 32, 24, '#20d46e', '#fff');
    fitFont(m, 'SC', 60, 34, 800); m.fillStyle = '#fff'; m.fillText('SC', x + 64, y + 34);
  }
  // --- steel grating
  {
    const [x, y] = R.GRATE;
    m.fillStyle = '#303336'; m.fillRect(x, y, 128, 128);
    m.fillStyle = '#6b7075';
    for (let i = 0; i < 128; i += 8) { m.fillRect(x + i, y, 2, 128); m.fillRect(x, y + i, 128, 2); }
  }
  // --- louvre vents
  {
    const [x, y] = R.VENT;
    m.fillStyle = '#16181a'; m.fillRect(x, y, 128, 128);
    for (let i = 0; i < 128; i += 9) { m.fillStyle = '#50555a'; m.fillRect(x, y + i, 128, 4); m.fillStyle = '#8a8f94'; m.fillRect(x, y + i, 128, 1); }
  }
  // --- chevron board
  {
    const [x, y, w, h] = R.CHEV;
    m.fillStyle = '#ffd200'; m.fillRect(x, y, w, h);
    m.fillStyle = '#111';
    for (let k = 0; k < 5; k++) { const sx = x + 18 + k * 48; m.beginPath(); m.moveTo(sx, y + 8); m.lineTo(sx + 18, y + 8); m.lineTo(sx + 40, y + 32); m.lineTo(sx + 18, y + 56); m.lineTo(sx, y + 56); m.lineTo(sx + 22, y + 32); m.closePath(); m.fill(); }
  }
  // --- pressure gauge dial
  {
    const [x, y] = R.DIAL, cx = x + 32, cy = y + 32;
    m.fillStyle = '#222'; m.fillRect(x, y, 64, 64);
    m.fillStyle = '#f4f4f0'; m.beginPath(); m.arc(cx, cy, 29, 0, TAU); m.fill();
    m.strokeStyle = '#222'; m.lineWidth = 2;
    for (let i = 0; i <= 10; i++) { const a = PI * .75 + i / 10 * PI * 1.5; m.beginPath(); m.moveTo(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22); m.lineTo(cx + Math.cos(a) * 27, cy + Math.sin(a) * 27); m.stroke(); }
    m.strokeStyle = '#d0201a'; m.lineWidth = 3; m.beginPath(); m.moveTo(cx, cy); m.lineTo(cx + 18, cy - 12); m.stroke();
  }
  // --- excavator model plate (on excavator yellow)
  {
    const [x, y, w, h] = R.PLATE;
    m.fillStyle = '#f0b000'; m.fillRect(x, y, w, h);
    fitFont(m, 'SC 210', w - 20, 50, 900); m.fillStyle = '#151515'; m.textAlign = 'center'; m.fillText('SC 210', x + w / 2, y + h / 2 + 2); m.textAlign = 'left';
  }
}

function getAtlas() {
  if (ATLAS) return ATLAS;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = AT; return c; };
  const cm = mk(), co = mk(), ce = mk();
  const m = cm.getContext('2d'), o = co.getContext('2d'), e = ce.getContext('2d');
  const orm = (s) => `rgb(${Math.round(s[0] * 255)},${Math.round(s[1] * 255)},${Math.round(s[2] * 255)})`;
  m.fillStyle = '#fff'; m.fillRect(0, 0, AT, AT);
  o.fillStyle = orm(SURF.plastic); o.fillRect(0, 0, AT, AT);
  e.fillStyle = '#000'; e.fillRect(0, 0, AT, AT);
  Object.keys(SURF).forEach((k, i) => {
    const x = (i % 16) * CELL, y = Math.floor(i / 16) * CELL;
    CELLS[k] = [(x + CELL / 2) / AT, 1 - (y + CELL / 2) / AT];
    o.fillStyle = orm(SURF[k]); o.fillRect(x, y, CELL, CELL);
    if (SURF[k][3]) { e.fillStyle = SURF[k][3]; e.fillRect(x, y, CELL, CELL); }
  });
  const regOrm = (r, s) => { o.fillStyle = orm(SURF[s]); o.fillRect(r[0], r[1], r[2], r[3]); };
  regOrm(REG.WORD, 'gloss'); regOrm(REG.EDGE, 'satin'); regOrm(REG.WORKS, 'sheet'); regOrm(REG.TRI, 'sheet');
  regOrm(REG.PEDR, 'glass'); regOrm(REG.PEDG, 'glass'); regOrm(REG.LENS, 'glass'); regOrm(REG.STRIPE, 'sheet');
  regOrm(REG.HV, 'plastic'); regOrm(REG.QR, 'plastic'); regOrm(REG.LOGO, 'satin'); regOrm(REG.GRATE, 'steel');
  regOrm(REG.VENT, 'satin'); regOrm(REG.CHEV, 'sheet'); regOrm(REG.DIAL, 'glass'); regOrm(REG.PLATE, 'ypaint');
  drawAtlas(m);
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  ATLAS = { map: tex(cm, true), orm: tex(co, false), emi: tex(ce, true) };
  return ATLAS;
}
function cellUV(s) { getAtlas(); const c = CELLS[s]; if (!c) throw new Error('devices.js: unknown surface ' + s); return c; }

/* =====================================================================================
   Materials (module-level cache)
   ===================================================================================== */
const MAT = {};
function atlasMat() {
  if (MAT.atlas) return MAT.atlas;
  const A = getAtlas();
  MAT.atlas = new THREE.MeshPhysicalMaterial({
    vertexColors: true, map: A.map, roughnessMap: A.orm, metalnessMap: A.orm, clearcoatMap: A.orm,
    roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: .08,
    emissiveMap: A.emi, emissive: 0xffffff, emissiveIntensity: 1.6,
  });
  return MAT.atlas;
}
function lensGlassMat() {
  return MAT.lensGlass || (MAT.lensGlass = new THREE.MeshPhysicalMaterial({
    color: 0x0c1118, metalness: .25, roughness: .04, transparent: true, opacity: .3, clearcoat: 1, clearcoatRoughness: .02, depthWrite: false,
  }));
}
function cabGlassMat() {
  return MAT.cabGlass || (MAT.cabGlass = new THREE.MeshPhysicalMaterial({
    color: 0x1f2c35, metalness: .2, roughness: .08, transparent: true, opacity: .5, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false,
  }));
}
/** Per-pole lens material: atlas map + vertex colours, emissive driven by uLamp[5] (red, yellow, green, ped red, ped green). */
function lensMat() {
  const m = new THREE.MeshStandardMaterial({ map: getAtlas().map, vertexColors: true, roughness: .16, metalness: .05 });
  const uLamp = { value: [0, 0, 0, 0, 0] };
  m.userData.uLamp = uLamp;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLamp = uLamp;
    sh.vertexShader = 'attribute float aLamp;\nattribute vec3 aGlow;\nuniform float uLamp[5];\nvarying vec3 vGlow;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow * uLamp[int(aLamp + 0.5)];');
    sh.fragmentShader = 'varying vec3 vGlow;\n' +
      sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vGlow * sampledDiffuseColor.rgb;');
  };
  m.customProgramCacheKey = () => 'smartcross-lens-v1';
  return m;
}

/* =====================================================================================
   Geometry kit: collects parts, bakes uv (atlas cell / region), vertex colour, transforms; merges.
   ===================================================================================== */
function flipGeo(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name], s = a.itemSize, arr = a.array;
    for (let i = 0; i + 2 < a.count; i += 3) for (let k = 0; k < s; k++) {
      const t = arr[(i + 1) * s + k]; arr[(i + 1) * s + k] = arr[(i + 2) * s + k]; arr[(i + 2) * s + k] = t;
    }
  }
  const n = g.attributes.normal.array; for (let i = 0; i < n.length; i++) n[i] = -n[i];
}
class Kit {
  constructor(lamp = false) { this.parts = []; this.lamp = lamp; }
  /**
   * o: { s: surface key, c: colour, top: colour for up-facing normals, m: Matrix4, pre: Matrix4 (before uv/colour),
   *      rect: atlas px rect, planar: [x0, y0, w, h] (uv from local x/y), flip, lamp: index, glow: [r, g, b] }
   */
  add(geo, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    g.morphAttributes = {};
    g.clearGroups();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (o.pre) g.applyMatrix4(o.pre);
    const P = g.attributes.position, N = g.attributes.normal, n = P.count;
    const uv = new Float32Array(n * 2);
    if (o.rect) {
      const [rx, ry, rw, rh] = o.rect, src = g.attributes.uv;
      for (let i = 0; i < n; i++) {
        let u, v;
        if (o.planar) { u = (P.getX(i) - o.planar[0]) / o.planar[2]; v = (P.getY(i) - o.planar[1]) / o.planar[3]; }
        else { u = src ? src.getX(i) : 0; v = src ? src.getY(i) : 0; }
        if (o.flipU) u = 1 - u;
        uv[2 * i] = (rx + u * rw) / AT;
        uv[2 * i + 1] = 1 - (ry + (1 - v) * rh) / AT;
      }
    } else {
      const c = cellUV(o.s || 'plastic');
      for (let i = 0; i < n; i++) { uv[2 * i] = c[0]; uv[2 * i + 1] = c[1]; }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const col = new Float32Array(n * 3), c1 = new THREE.Color(o.c ?? 0xffffff), c2 = o.top != null ? new THREE.Color(o.top) : null;
    for (let i = 0; i < n; i++) { const c = c2 && N.getY(i) > .55 ? c2 : c1; col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.lamp) {
      const la = new Float32Array(n).fill(o.lamp ?? 0), gl = new Float32Array(n * 3), gv = o.glow || [0, 0, 0];
      for (let i = 0; i < n; i++) { gl[3 * i] = gv[0]; gl[3 * i + 1] = gv[1]; gl[3 * i + 2] = gv[2]; }
      g.setAttribute('aLamp', new THREE.BufferAttribute(la, 1));
      g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 3));
    }
    if (o.flip) flipGeo(g);
    if (o.m) g.applyMatrix4(o.m);
    this.parts.push(g);
    return this;
  }
  mesh(mat, { cast = true, receive = true, name = '' } = {}) {
    const g = mergeGeometries(this.parts, false);
    g.computeBoundingSphere(); g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = cast; mesh.receiveShadow = receive; mesh.name = name;
    this.parts = [];
    return mesh;
  }
}

/* ---------- small geometry helpers ---------- */
const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) => {
  const sc = Array.isArray(s) ? new V3(s[0], s[1], s[2]) : new V3(s, s, s);
  return new THREE.Matrix4().compose(new V3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), sc);
};
const at = (P, L) => P.clone().multiply(L);
const rbox = (w, h, d, r = .02, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.max(1e-4, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 16, open = false, ts = 0, tl = TAU) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open, ts, tl);
const sph = (r, ws = 16, hs = 12, ps = 0, pl = TAU, ts = 0, tl = PI) => new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl);
function between(a, b) {
  const d = new V3().subVectors(b, a), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize());
  return { m: new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5), q, new V3(1, 1, 1)), len };
}
/** cylinder between two points (optionally tapered: r at a, r2 at b) */
function rod(k, a, b, r, o = {}, seg = 12, r2 = r) {
  const { m, len } = between(a, b);
  k.add(cyl(r2, r, len, seg), { ...o, m: o.P ? at(o.P, m) : m });
}
function rrShape(w, h, r, path = new THREE.Shape(), cx = 0, cy = 0) {
  const x = cx - w / 2, y = cy - h / 2;
  path.moveTo(x + r, y); path.lineTo(x + w - r, y); path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r); path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h); path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r); path.quadraticCurveTo(x, y, x + r, y);
  return path;
}
const circlePath = (r, cx = 0, cy = 0) => { const p = new THREE.Path(); p.absarc(cx, cy, r, 0, TAU, true); return p; };
const extrude = (shape, depth, bevel = 0, segs = 2, curve = 12) =>
  new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs, curveSegments: curve });
/** lathe around +Z (profile [r, z] pairs) */
function latheZ(pts, seg = 48) {
  const g = new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg);
  g.rotateX(PI / 2);
  return g;
}
/** spherical cap of base radius r and bulge h, base at z=0 bulging toward +Z */
function capZ(r, h, ws = 32, hs = 6) {
  const R = (r * r + h * h) / (2 * h), th = Math.asin(Math.min(1, r / R));
  const g = sph(R, ws, hs, 0, TAU, 0, th);
  g.rotateX(PI / 2); g.translate(0, 0, -(R - h));
  return g;
}

/* =====================================================================================
   Signal heads
   ===================================================================================== */
const COL = {
  galv: 0xa9afb4, galvDark: 0x80868b, housing: 0x1c1f22, door: 0x23272b, plate: 0x101113, border: 0xf3f3ef,
  white: 0xeef0ef, graphite: 0x2a2e33, graphite2: 0x181b1f, silver: 0xc5c9cd, yellow: 0xf0b000, black: 0x1c1d1f,
};
const LENS_OFF = [0x4c1611, 0x4f3a10, 0x0e3e30];
const LENS_GLOW = [[2.6, .045, .02], [3.0, 1.05, .02], [.012, 1.7, .62]];
const PED_OFF = 0x545250, PED_GLOW = [[2.8, .05, .02], [.015, 1.9, .75]];

function addSignalHead(kA, kL, P, { plateW = .56, plateH = 1.1, plate = true } = {}) {
  const W = .3, Hs = .3, D = .24, H = Hs * 3;
  kA.add(rbox(W, H, D, .035, 3), { s: 'paint', c: COL.housing, m: at(P, M(0, 0, 0)) });
  for (const y of [-Hs / 2, Hs / 2]) kA.add(box(W + .008, .014, D + .008), { s: 'dim', c: 0x0b0c0d, m: at(P, M(0, y, 0)) });
  // cap & cable gland on top
  kA.add(cyl(.03, .036, .03, 12), { s: 'paint', c: COL.housing, m: at(P, M(0, H / 2 + .012, -.02)) });
  // door frames + lenses + tunnel visors
  const door = new THREE.Shape(); rrShape(.282, .282, .03, door); door.holes.push(circlePath(.106));
  const doorG = extrude(door, .012, .004, 2, 20);
  const lensG = capZ(.1, .016, 28, 5);
  const vo = cyl(.124, .124, .22, 22, true, PI / 3, 4 * PI / 3); vo.rotateX(PI / 2);
  const vi = cyl(.12, .12, .22, 22, true, PI / 3, 4 * PI / 3); vi.rotateX(PI / 2);
  for (let i = 0; i < 3; i++) {
    const y = (1 - i) * Hs;
    kA.add(doorG, { s: 'satin', c: COL.door, m: at(P, M(0, y, D / 2 + .002)) });
    kL.add(lensG, { rect: REG.LENS, planar: [-.1, -.1, .2, .2], c: LENS_OFF[i], lamp: i, glow: LENS_GLOW[i], m: at(P, M(0, y, D / 2 + .004)) });
    const vm = at(P, M(0, y + .004, D / 2 + .02 + .11, -.05));
    kA.add(vo, { s: 'paint', c: COL.housing, m: vm });
    kA.add(vi, { s: 'dim', c: 0x060607, flip: true, m: vm });
  }
  if (plate) {
    const ps = rrShape(plateW, plateH, .06);
    kA.add(extrude(ps, .012, .003, 1, 6), { s: 'satin', c: COL.plate, m: at(P, M(0, 0, -.075)) });
    const bs = rrShape(plateW, plateH, .06); bs.holes.push(rrShape(plateW - .085, plateH - .085, .035, new THREE.Path()));
    kA.add(extrude(bs, .004, 0, 1, 6), { s: 'sheet', c: COL.border, m: at(P, M(0, 0, -.075 + .016)) });
  }
}
function addPedHead(kA, kL, P) {
  const W = .3, H = .62, D = .2;
  kA.add(rbox(W, H, D, .03, 3), { s: 'paint', c: COL.housing, m: at(P, M(0, 0, 0)) });
  kA.add(box(W + .008, .014, D + .008), { s: 'dim', c: 0x0b0c0d, m: at(P, M(0, 0, 0)) });
  const door = new THREE.Shape(); rrShape(.28, .28, .025, door); door.holes.push(rrShape(.22, .22, .02, new THREE.Path()));
  const doorG = extrude(door, .01, .003, 1, 8);
  const lens = new THREE.PlaneGeometry(.222, .222);
  for (let i = 0; i < 2; i++) {
    const y = i === 0 ? .155 : -.155;
    kA.add(doorG, { s: 'satin', c: COL.door, m: at(P, M(0, y, D / 2 + .002)) });
    kL.add(lens, { rect: i === 0 ? REG.PEDR : REG.PEDG, c: PED_OFF, lamp: 3 + i, glow: PED_GLOW[i], m: at(P, M(0, y, D / 2 + .006)) });
    // hood: top + sides
    kA.add(box(.29, .008, .16), { s: 'paint', c: COL.housing, m: at(P, M(0, y + .142, D / 2 + .09, .12)) });
    for (const sx of [-1, 1]) kA.add(box(.008, .2, .13), { s: 'paint', c: COL.housing, m: at(P, M(sx * .142, y + .05, D / 2 + .075)) });
  }
}

/* =====================================================================================
   SmartCross camera
   ===================================================================================== */
/**
 * The SmartCross AI traffic camera (front faces +Z, origin at the base of its mounting knuckle).
 * @returns {{group: THREE.Group, lens: THREE.Object3D, setActive: (on: boolean) => void, update: (t: number, dt?: number) => void}}
 *   `lens` sits at the centre of the front glass; its local +Z is the viewing direction.
 */
export function createSmartCam() {
  const group = new THREE.Group(); group.name = 'SmartCam';
  const k = new Kit(), kg = new Kit();
  const WH = COL.white, GR = COL.graphite, GR2 = COL.graphite2;
  const BY = .22, LZ = .326;           // body centre height, nose front plane
  // mounting knuckle
  k.add(cyl(.05, .056, .014, 28), { s: 'satin', c: GR, m: M(0, .007, 0) });
  k.add(cyl(.024, .03, .06, 20), { s: 'anod', c: 0xb4b9be, m: M(0, .044, 0) });
  k.add(sph(.034, 20, 14), { s: 'anod', c: 0xc8ccd0, m: M(0, .086, 0) });
  k.add(cyl(.04, .04, .012, 20), { s: 'satin', c: GR, m: M(0, .104, .0) });
  k.add(rbox(.12, .022, .2, .009), { s: 'satin', c: GR, m: M(0, .114, .02) });
  // body (white clear-coated shell)
  k.add(rbox(.26, .21, .46, .055, 4), { s: 'gloss', c: WH, m: M(0, BY, .01) });          // z -0.22 .. 0.24
  // graphite underbelly accent
  k.add(rbox(.2, .02, .36, .009), { s: 'satin', c: GR, m: M(0, BY - .104, .02) });
  // front nose with lens aperture
  const nose = rrShape(.244, .194, .05); nose.holes.push(circlePath(.082));
  k.add(extrude(nose, .07, .008, 3, 40), { s: 'gloss', c: GR2, m: M(0, BY, .248) });     // z .24 .. .326
  // LED light belt between body and nose
  const belt = rrShape(.274, .224, .06); belt.holes.push(rrShape(.25, .2, .05, new THREE.Path()));
  k.add(extrude(belt, .008, 0, 1, 10), { s: 'ledG', c: 0x7dffb2, m: M(0, BY, .237) });
  // bezel ring + barrel + rings + rear glass element (premium lens with depth)
  const lz = (pts) => latheZ(pts, 56);
  k.add(lz([[.091, -.006], [.091, .002], [.089, .008], [.084, .0115], [.076, .011], [.073, .007], [.072, 0]]), { s: 'anod', c: 0xc9cdd1, m: M(0, BY, LZ) });
  k.add(lz([[.072, 0], [.072, -.014]]), { s: 'dim', c: 0x0b0c0e, m: M(0, BY, LZ) });
  k.add(lz([[.072, -.014], [.061, -.014]]), { s: 'anod', c: 0x3b4048, m: M(0, BY, LZ) });
  k.add(lz([[.061, -.014], [.061, -.03]]), { s: 'dim', c: 0x0d0e10, m: M(0, BY, LZ) });
  k.add(lz([[.061, -.03], [.054, -.03]]), { s: 'anod', c: 0x2a4f9a, m: M(0, BY, LZ) });
  k.add(lz([[.054, -.03], [.0505, -.0305]]), { s: 'anod', c: 0xb9bec4, m: M(0, BY, LZ) });
  k.add(lz([[.0505, -.0305], [.05, -.046]]), { s: 'dim', c: 0x0a0b0d, m: M(0, BY, LZ) });
  k.add(lz([[.05, -.046], [.046, -.043], [.036, -.038], [.022, -.0345], [.0, -.033]]), { s: 'glass', c: 0x1b1f48, m: M(0, BY, LZ) });
  k.add(lz([[.012, -.0328], [.0, -.0326]]), { s: 'glass', c: 0x6a3d8a, m: M(0, BY, LZ + .0004) });
  // cover glass (transparent dome)
  kg.add(capZ(.0735, .009, 40, 5), { s: 'glass', c: 0xffffff, m: M(0, BY, LZ + .006) });
  // nose details: radar/IR sensor window + ambient sensor
  k.add(capZ(.013, .003, 20, 2), { s: 'glass', c: 0x0b0b10, m: M(.098, BY + .066, LZ + .001) });
  k.add(lz([[.017, -.002], [.017, .002], [.013, .002]]).translate(0, 0, 0), { s: 'anod', c: 0x9aa0a6, m: M(.098, BY + .066, LZ) });
  k.add(cyl(.0045, .0045, .004, 10), { s: 'ledW', c: 0xffffff, m: M(-.1, BY + .068, LZ + .001, PI / 2) });
  // sun shield (separate shell floating above the body, swept front edge)
  {
    const s = new THREE.Shape();
    s.moveTo(-.152, .2); s.lineTo(-.156, .292); s.quadraticCurveTo(-.158, .35, -.1, .354); s.quadraticCurveTo(0, .362, .1, .354);
    s.quadraticCurveTo(.158, .35, .156, .292); s.lineTo(.152, .2); s.lineTo(.145, .2); s.lineTo(.149, .292);
    s.quadraticCurveTo(.151, .343, .1, .347); s.quadraticCurveTo(0, .355, -.1, .347); s.quadraticCurveTo(-.151, .343, -.149, .292);
    s.lineTo(-.145, .2); s.closePath();
    const g = extrude(s, .63, .0025, 2, 10);
    g.translate(0, 0, -.225);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), z = p.getZ(i);
      if (z > .2) p.setZ(i, z - (.356 - y) * .95 * (z - .2) / .205);
      else if (z < -.1) p.setZ(i, z + (.356 - y) * .35);
    }
    g.computeVertexNormals();
    k.add(g, { s: 'gloss', c: WH, m: M(0, .0, 0) });
    for (const z of [-.12, .14]) k.add(rbox(.06, .03, .03, .008), { s: 'satin', c: GR, m: M(0, .336, z) });
  }
  // rear cap with heat-sink fins + cable gland
  k.add(rbox(.24, .19, .03, .022, 3), { s: 'satin', c: GR, m: M(0, BY, -.218) });
  for (let i = 0; i < 9; i++) k.add(box(.005, .14, .022), { s: 'satin', c: 0x34393f, m: M(-.088 + i * .022, BY, -.24) });
  k.add(cyl(.016, .016, .03, 16), { s: 'satin', c: GR2, m: M(.06, BY - .06, -.245, PI / 2) });
  k.add(cyl(.009, .009, .05, 10), { s: 'rubber', c: 0x111111, m: M(.06, BY - .06, -.28, PI / 2) });
  // side wordmarks (both sides, reading front-ward on the left, rear-ward mirrored correctly on the right)
  const wm = new THREE.PlaneGeometry(.24, .03);
  k.add(wm, { rect: REG.WORD, m: M(-.1579, .251, .03, 0, -PI / 2, 0) });
  k.add(wm, { rect: REG.WORD, m: M(.1579, .251, .03, 0, PI / 2, 0) });
  // side LED status line (thin, continues the belt along both flanks)
  for (const sx of [-1, 1]) k.add(box(.003, .006, .16), { s: 'ledG', c: 0x7dffb2, m: M(sx * .1302, BY - .052, .1) });

  const mat = atlasMat().clone();
  mat.emissiveIntensity = 2.2;
  const shell = k.mesh(mat, { name: 'SmartCamShell' });
  const glass = kg.mesh(lensGlassMat(), { cast: false, name: 'SmartCamGlass' });
  glass.renderOrder = 2;
  group.add(shell, glass);
  const lens = new THREE.Object3D(); lens.name = 'SmartCamLens';
  lens.position.set(0, BY, LZ + .012);
  group.add(lens);
  let active = true;
  const api = {
    group, lens,
    /** Turn the AI camera status LEDs on (pulsing) or off. */
    setActive(on) { active = !!on; mat.emissiveIntensity = active ? 2.2 : 0; },
    /** Pulses the status LED strip. */
    update(t) { mat.emissiveIntensity = active ? 1.3 + 1.6 * (.5 + .5 * Math.sin(t * TAU / 1.6)) : 0; },
  };
  return api;
}

/* =====================================================================================
   Signal pole
   ===================================================================================== */
/**
 * Galvanised signal pole with mast arm, arm-hung + pole-mounted 3-aspect heads, pedestrian head,
 * regulator podium on top and a SmartCross camera on a side bracket at ~7 m.
 * Origin at the pole base; heads face +Z; the arm reaches along local −X.
 * @param {{armLength?: number}} opts
 * @returns {{group: THREE.Group, setState: (s: 'red'|'yellow'|'green'|'redyellow'|'off') => void,
 *   setPedState: (s: 'red'|'green'|'off') => void, cameraMount: THREE.Object3D, regulatorMount: THREE.Object3D,
 *   smartCam: object, signalHead: THREE.Object3D, poleHead: THREE.Object3D, pedHead: THREE.Object3D, update: (t: number, dt: number) => void}}
 */
export function createSignalPole({ armLength = 8 } = {}) {
  const group = new THREE.Group(); group.name = 'SignalPole';
  const kA = new Kit(), kL = new Kit(true);
  const H = 6.5, ARM_Y = 6.3, rAt = (y) => .14 - .045 * Math.min(y, H) / H;
  const G = { s: 'galv', c: COL.galv };
  // base plate, anchor bolts with hex nuts, collar
  kA.add(rbox(.48, .03, .48, .01), { s: 'galv', c: COL.galvDark, m: M(0, .015, 0) });
  for (const [x, z] of [[.18, .18], [-.18, .18], [.18, -.18], [-.18, -.18]]) {
    kA.add(cyl(.016, .016, .1, 8), { s: 'steel', c: 0x8c9196, m: M(x, .06, z) });
    kA.add(cyl(.032, .032, .006, 14), { s: 'steel', c: 0x9aa0a5, m: M(x, .033, z) });
    kA.add(cyl(.028, .028, .024, 6), { s: 'steel', c: 0x80858a, m: M(x, .048, z) });
  }
  kA.add(cyl(.165, .178, .3, 28), { ...G, m: M(0, .18, 0) });
  kA.add(cyl(.142, .165, .035, 28), { ...G, m: M(0, .347, 0) });
  kA.add(cyl(.095, .14, H, 28), { ...G, m: M(0, H / 2, 0) });
  // hand-hole cover with screws
  kA.add(rbox(.11, .26, .03, .014), { s: 'galv', c: COL.galvDark, m: M(0, .85, -rAt(.85) - .004) });
  for (const y of [.74, .96]) kA.add(cyl(.008, .008, .01, 8), { s: 'steel', c: 0x6e7378, m: M(0, y, -rAt(.85) - .02, PI / 2) });
  // reducer, top extension tube
  kA.add(cyl(.072, .098, .07, 24), { ...G, m: M(0, H + .035, 0) });
  kA.add(cyl(.068, .068, 7.3 - H, 24), { ...G, m: M(0, (H + 7.3) / 2, 0) });

  // --- mast arm (tapered), flange, clamps, brace, tip cap
  const L = armLength;
  kA.add(cyl(.055, .088, L, 20), { ...G, m: M(-L / 2, ARM_Y, 0, 0, 0, PI / 2) });
  kA.add(rbox(.04, .38, .32, .01), { s: 'galv', c: COL.galvDark, m: M(-rAt(ARM_Y) - .016, ARM_Y, 0) });
  kA.add(cyl(rAt(ARM_Y) + .014, rAt(ARM_Y) + .014, .07, 28), { s: 'galv', c: COL.galvDark, m: M(0, ARM_Y + .2, 0) });
  kA.add(cyl(rAt(ARM_Y) + .014, rAt(ARM_Y) + .014, .07, 28), { s: 'galv', c: COL.galvDark, m: M(0, ARM_Y - .2, 0) });
  for (const [y, z] of [[.15, .12], [.15, -.12], [-.15, .12], [-.15, -.12]]) kA.add(cyl(.016, .016, .05, 6), { s: 'steel', c: 0x7d8287, m: M(-rAt(ARM_Y) - .04, ARM_Y + y, z, 0, 0, PI / 2) });
  kA.add(sph(.055, 16, 8, 0, TAU, 0, PI / 2), { ...G, m: M(-L, ARM_Y, 0, 0, 0, PI / 2) });
  rod(kA, new V3(-rAt(5.25) + .01, 5.25, 0), new V3(-2.5, ARM_Y - .07, 0), .03, G, 12);
  kA.add(box(.12, .02, .09), { s: 'galv', c: COL.galvDark, m: M(-2.45, ARM_Y - .072, 0) });
  kA.add(rbox(.03, .14, .1, .008), { s: 'galv', c: COL.galvDark, m: M(-rAt(5.25) - .01, 5.25, 0) });
  // cable entry on arm top
  kA.add(cyl(.02, .02, .06, 10), { s: 'rubber', c: 0x161616, m: M(-.35, ARM_Y + .08, 0) });

  // --- arm-hung vehicle head
  const hx = -Math.min(L - .8, L * .7333);
  const HEAD_Y = 5.6;
  const rArm = .088 - .033 * (-hx / L);
  rod(kA, new V3(hx, HEAD_Y + .45, 0), new V3(hx, ARM_Y - rArm + .01, 0), .024, { s: 'galv', c: COL.galvDark }, 12);
  kA.add(cyl(.045, .05, .05, 16), { s: 'galv', c: COL.galvDark, m: M(hx, HEAD_Y + .47, 0) });
  for (const dx of [-.06, .06]) {
    const tor = new THREE.TorusGeometry(rArm + .012, .011, 8, 20, PI);
    kA.add(tor, { s: 'steel', c: 0x8b9095, m: M(hx + dx, ARM_Y, 0, 0, PI / 2, 0) });
  }
  kA.add(box(.18, .022, .15), { s: 'galv', c: COL.galvDark, m: M(hx, ARM_Y - rArm - .012, 0) });
  addSignalHead(kA, kL, M(hx, HEAD_Y, 0));
  const signalHead = new THREE.Object3D(); signalHead.name = 'signalHead';
  signalHead.position.set(hx, HEAD_Y, .14); group.add(signalHead);

  // --- pole-mounted vehicle head at ~3 m (faces +Z)
  const PH_Y = 3.0, phz = rAt(PH_Y) + .08 + .12;
  for (const y of [PH_Y - .3, PH_Y + .3]) {
    kA.add(cyl(rAt(y) + .012, rAt(y) + .012, .05, 24), { s: 'galv', c: COL.galvDark, m: M(0, y, 0) });
    rod(kA, new V3(0, y, rAt(y) - .01), new V3(0, y, phz - .11), .022, { s: 'galv', c: COL.galvDark }, 10);
  }
  addSignalHead(kA, kL, M(0, PH_Y, phz), { plateW: .5, plateH: 1.04 });
  const poleHead = new THREE.Object3D(); poleHead.position.set(0, PH_Y, phz + .14); group.add(poleHead);

  // --- pedestrian head at ~2.6 m facing −X, push-button box below
  const PD_Y = 2.6, pdx = -(rAt(PD_Y) + .07 + .1);
  for (const y of [PD_Y - .2, PD_Y + .2]) {
    kA.add(cyl(rAt(y) + .012, rAt(y) + .012, .045, 24), { s: 'galv', c: COL.galvDark, m: M(0, y, 0) });
    rod(kA, new V3(-rAt(y) + .01, y, 0), new V3(pdx + .09, y, 0), .02, { s: 'galv', c: COL.galvDark }, 10);
  }
  addPedHead(kA, kL, M(pdx, PD_Y, 0, 0, -PI / 2, 0));
  const pedHead = new THREE.Object3D(); pedHead.position.set(pdx - .11, PD_Y, 0); pedHead.rotation.y = -PI / 2; group.add(pedHead);
  const pbx = -rAt(1.15) - .035;
  kA.add(rbox(.07, .19, .12, .016), { s: 'paint', c: 0xf0b81c, m: M(pbx, 1.15, 0) });
  kA.add(cyl(.024, .024, .014, 20), { s: 'satin', c: 0x202224, m: M(pbx - .04, 1.12, 0, 0, 0, PI / 2) });
  kA.add(cyl(.016, .016, .02, 16), { s: 'chrome', c: 0xd8dadc, m: M(pbx - .045, 1.12, 0, 0, 0, PI / 2) });
  kA.add(cyl(.006, .006, .008, 10), { s: 'ledR', c: 0xff6040, m: M(pbx - .036, 1.21, 0, 0, 0, PI / 2) });

  // --- regulator podium on top (white drum with black/white striped rim, grating top)
  kA.add(cyl(.34, .07, .16, 32), { s: 'satin', c: COL.graphite, m: M(0, 7.39, 0) });
  kA.add(cyl(.47, .47, .12, 40), { s: 'gloss', c: 0xeceeed, m: M(0, 7.53, 0) });
  for (let i = 0; i < 36; i++) kA.add(cyl(.475, .475, .04, 2, true, i * TAU / 36, TAU / 36), { s: 'sheet', c: i % 2 ? 0x141414 : 0xf6f6f3, m: M(0, 7.545, 0) });
  kA.add(cyl(.474, .474, .012, 40, true), { s: 'ledG', c: 0xffffff, m: M(0, 7.487, 0) });
  kA.add(new THREE.CircleGeometry(.45, 40), { rect: REG.GRATE, planar: [-.45, -.45, .9, .9], m: M(0, 7.591, 0, -PI / 2) });
  kA.add(new THREE.TorusGeometry(.462, .012, 6, 48), { s: 'gloss', c: 0xeceeed, m: M(0, 7.59, 0, PI / 2) });
  const regulatorMount = new THREE.Object3D(); regulatorMount.name = 'regulatorMount';
  regulatorMount.position.set(0, 7.59, 0); group.add(regulatorMount);

  // --- SmartCross camera on a graphite side bracket at ~7.0 m (offset +X so the optical axis clears the pole)
  const CB_Y = 6.76, cbx = .36, cbz = .3;
  kA.add(cyl(.085, .085, .13, 28), { s: 'satin', c: COL.graphite, m: M(0, CB_Y, 0) });
  kA.add(cyl(.075, .075, .14, 28), { s: 'satin', c: 0x3a3f45, m: M(0, CB_Y, 0) });
  rod(kA, new V3(.06, CB_Y, .045), new V3(cbx, CB_Y, cbz), .03, { s: 'satin', c: COL.graphite }, 16);
  kA.add(sph(.03, 16, 10), { s: 'satin', c: COL.graphite, m: M(cbx, CB_Y, cbz) });
  kA.add(cyl(.05, .045, .03, 24), { s: 'satin', c: COL.graphite, m: M(cbx, CB_Y + .015, cbz) });
  const cameraMount = new THREE.Object3D(); cameraMount.name = 'cameraMount';
  cameraMount.position.set(cbx, CB_Y + .03, cbz); group.add(cameraMount);
  const smartCam = createSmartCam();
  smartCam.group.rotation.x = 12 * DEG;
  smartCam.group.scale.setScalar(1.3);
  cameraMount.add(smartCam.group);
  // cable from camera bracket into pole
  rod(kA, new V3(.05, CB_Y - .08, -.03), new V3(.05, CB_Y - .3, -.06), .012, { s: 'rubber', c: 0x141414 }, 8);

  group.add(kA.mesh(atlasMat(), { name: 'PoleBody' }));
  const lm = lensMat();
  group.add(kL.mesh(lm, { name: 'PoleLenses' }));
  const L5 = lm.userData.uLamp.value;
  const STATES = { red: [1, 0, 0], yellow: [0, 1, 0], green: [0, 0, 1], redyellow: [1, 1, 0], off: [0, 0, 0] };
  const api = {
    group, cameraMount, regulatorMount, smartCam, signalHead, poleHead, pedHead,
    /** Vehicle aspects: 'red' | 'yellow' | 'green' | 'redyellow' | 'off'. */
    setState(s) { const v = STATES[s] || STATES.off; L5[0] = v[0]; L5[1] = v[1]; L5[2] = v[2]; },
    /** Pedestrian aspects: 'red' | 'green' | 'off'. */
    setPedState(s) { L5[3] = s === 'red' ? 1 : 0; L5[4] = s === 'green' ? 1 : 0; },
    /** Animates the mounted camera's status LED. */
    update(t, dt) { smartCam.update(t, dt); },
  };
  api.setState('red'); api.setPedState('red');
  return api;
}

/* =====================================================================================
   Edge cabinet
   ===================================================================================== */
/**
 * Roadside SmartCross edge-computer cabinet (~1.45 m incl. concrete footing); front (door) faces +Z.
 * The back also carries vents and a label so it reads from either side.
 * @returns {{group: THREE.Group}}
 */
export function createEdgeBox() {
  const group = new THREE.Group(); group.name = 'EdgeBox';
  const k = new Kit();
  const GREY = 0xc9ccca, W = .8, Hc = 1.1, D = .46, y0 = .29;
  k.add(rbox(1.0, .2, .68, .025), { s: 'concrete', c: 0xaaa69d, m: M(0, .1, 0) });
  k.add(rbox(.84, .09, .5, .012), { s: 'paint', c: 0x50555a, m: M(0, .245, 0) });
  k.add(rbox(W, Hc, D, .028, 3), { s: 'paint', c: GREY, m: M(0, y0 + Hc / 2, 0) });
  // roof hood with overhang + drip lip
  k.add(rbox(W + .08, .045, D + .08, .016), { s: 'paint', c: 0xd5d8d6, m: M(0, y0 + Hc + .028, 0, .025) });
  k.add(rbox(W + .06, .02, .02, .006), { s: 'paint', c: 0xb9bcba, m: M(0, y0 + Hc + .002, D / 2 + .035) });
  // antenna puck + small fin
  k.add(cyl(.055, .068, .036, 24), { s: 'satin', c: COL.graphite, m: M(.24, y0 + Hc + .07, .04) });
  k.add(rbox(.012, .08, .05, .005), { s: 'satin', c: COL.graphite, m: M(-.26, y0 + Hc + .09, -.08) });
  const face = (sz) => {
    const R = (x, y, z, rx = 0) => M(x, y, sz * z, rx, sz > 0 ? 0 : PI, 0);
    const dz = D / 2;
    // door seam + door panel
    k.add(box(.712, 1.0, .004), { s: 'dim', c: 0x24272a, m: R(0, y0 + Hc / 2, dz + .001) });
    k.add(rbox(.7, .988, .016, .006), { s: 'paint', c: 0xced1cf, m: R(0, y0 + Hc / 2, dz + .007) });
    // louvres (lower + upper)
    for (const [yc, n] of [[y0 + .2, 7], [y0 + Hc - .14, 4]]) {
      k.add(box(.46, n * .03 + .02, .004), { s: 'dim', c: 0x1a1c1e, m: R(0, yc, dz + .016) });
      for (let i = 0; i < n; i++) k.add(box(.44, .012, .022), { s: 'paint', c: 0xc2c5c3, m: R(0, yc - (n - 1) * .015 + i * .03, dz + .022, -.55) });
    }
    if (sz > 0) {
      // hinges, handle with lock, label, LEDs, stickers
      for (const y of [y0 + .15, y0 + .55, y0 + .95]) k.add(cyl(.009, .009, .07, 10), { s: 'steel', c: 0x9da2a6, m: R(-.355, y, dz + .012) });
      k.add(rbox(.045, .16, .012, .005), { s: 'satin', c: 0x2b2e31, m: R(.29, y0 + .56, dz + .02) });
      k.add(rbox(.026, .12, .028, .008), { s: 'chrome', c: 0xc8cbce, m: R(.29, y0 + .54, dz + .036) });
      k.add(cyl(.011, .011, .014, 14), { s: 'chrome', c: 0xd8dadc, m: R(.29, y0 + .625, dz + .03, PI / 2) });
      k.add(new THREE.PlaneGeometry(.32, .08), { rect: REG.EDGE, m: R(0, y0 + .86, dz + .0162) });
      [['ledG', -.07], ['ledG', -.035], ['ledB', 0]].forEach(([s, x]) => {
        k.add(cyl(.009, .009, .006, 14), { s, c: 0xffffff, m: R(.13 + x, y0 + .76, dz + .017, PI / 2) });
        k.add(cyl(.013, .013, .003, 14), { s: 'satin', c: 0x1a1c1e, m: R(.13 + x, y0 + .76, dz + .0155, PI / 2) });
      });
      k.add(new THREE.PlaneGeometry(.085, .085), { rect: REG.HV, m: R(-.2, y0 + .74, dz + .0162) });
      k.add(new THREE.PlaneGeometry(.06, .06), { rect: REG.QR, m: R(.25, y0 + .38, dz + .0162) });
    } else {
      k.add(new THREE.PlaneGeometry(.26, .065), { rect: REG.EDGE, m: R(0, y0 + .7, dz + .0162) });
      k.add(new THREE.PlaneGeometry(.085, .085), { rect: REG.HV, m: R(.22, y0 + .7, dz + .0162) });
    }
  };
  face(1); face(-1);
  // side vents
  for (const sx of [-1, 1]) {
    k.add(box(.004, .14, .3), { s: 'dim', c: 0x1a1c1e, m: M(sx * (W / 2 + .001), y0 + Hc - .16, 0) });
    for (let i = 0; i < 4; i++) k.add(box(.02, .012, .28), { s: 'paint', c: 0xc2c5c3, m: M(sx * (W / 2 + .008), y0 + Hc - .21 + i * .033, 0, 0, 0, sx * .55) });
  }
  // conduit from back into footing
  const cv = new THREE.CatmullRomCurve3([new V3(-.25, y0 + .12, -D / 2), new V3(-.25, y0 + .02, -D / 2 - .07), new V3(-.25, .18, -D / 2 - .09)]);
  k.add(new THREE.TubeGeometry(cv, 10, .024, 10), { s: 'rubber', c: 0x3a3d40 });
  group.add(k.mesh(atlasMat(), { name: 'EdgeBox' }));
  return { group };
}

/* =====================================================================================
   Camera post (finale)
   ===================================================================================== */
/**
 * Slim ~2.4 m graphite post on a small base with a SmartCross camera on top (faces +Z).
 * @returns {{group: THREE.Group, smartCam: object}}
 */
export function createCameraPost() {
  const group = new THREE.Group(); group.name = 'CameraPost';
  const k = new Kit();
  k.add(cyl(.2, .21, .025, 32), { s: 'galv', c: COL.galvDark, m: M(0, .0125, 0) });
  for (let i = 0; i < 4; i++) { const a = i * PI / 2 + PI / 4; k.add(cyl(.02, .02, .022, 6), { s: 'steel', c: 0x80858a, m: M(Math.cos(a) * .15, .035, Math.sin(a) * .15) }); }
  k.add(cyl(.07, .125, .17, 32), { s: 'satin', c: COL.graphite, m: M(0, .11, 0) });
  k.add(cyl(.046, .05, 2.2, 24), { s: 'satin', c: COL.graphite, m: M(0, 1.29, 0) });
  k.add(cyl(.0475, .0475, .02, 24), { s: 'ledG', c: 0xffffff, m: M(0, 2.12, 0) });
  k.add(cyl(.0475, .0475, .02, 24), { s: 'ledG', c: 0xffffff, m: M(0, .26, 0) });
  k.add(cyl(.056, .046, .06, 24), { s: 'gloss', c: COL.white, m: M(0, 2.42, 0) });
  // small hatch near base
  k.add(rbox(.05, .16, .012, .006), { s: 'satin', c: 0x3a3f45, m: M(0, .55, -.048) });
  group.add(k.mesh(atlasMat(), { name: 'CameraPost' }));
  const smartCam = createSmartCam();
  smartCam.group.position.set(0, 2.45, 0);
  smartCam.group.rotation.x = 8 * DEG;
  group.add(smartCam.group);
  return { group, smartCam };
}

/* =====================================================================================
   Excavator (internal)
   ===================================================================================== */
function makeHydCyl(rb, rr) {
  const k = new Kit();
  const Z = (g) => { g.rotateX(PI / 2); return g; };
  k.add(Z(cyl(rb, rb, .6, 16)), { s: 'ypaint', c: COL.yellow, m: M(0, 0, .3) });
  k.add(Z(cyl(rb + .01, rb + .01, .05, 16)), { s: 'steel', c: 0x2a2b2d, m: M(0, 0, .6) });
  k.add(Z(cyl(rb + .006, rb + .006, .04, 16)), { s: 'steel', c: 0x2a2b2d, m: M(0, 0, .03) });
  k.add(Z(cyl(rr, rr, .42, 14)), { s: 'chrome', c: 0xe6e8ea, m: M(0, 0, .82) });
  k.add(cyl(.05, .05, .1, 14), { s: 'steel', c: 0x55585c, m: M(0, 0, 0, 0, 0, PI / 2) });
  k.add(cyl(.045, .045, .09, 14), { s: 'steel', c: 0x55585c, m: M(0, 0, 1, 0, 0, PI / 2) });
  k.add(Z(cyl(.012, .012, .45, 6)), { s: 'rubber', c: 0x111111, m: M(0, rb + .012, .3) });
  return k.mesh(atlasMat(), { name: 'HydCyl' });
}

function createExcavator() {
  const group = new THREE.Group(); group.name = 'Excavator';
  const mat = atlasMat();
  const Y = COL.yellow, BK = 0x1e1f21, DG = 0x2f3134;
  /* ---- undercarriage ---- */
  const kU = new Kit();
  {
    const R = .3, HL = 1.32, per = 4 * HL + TAU * R, NL = 48, pitch = per / NL;
    const pathAt = (s) => {
      s = ((s % per) + per) % per;
      if (s < 2 * HL) return [-HL + s, R, 0];
      s -= 2 * HL;
      if (s < PI * R) { const a = s / R; return [HL + R * Math.sin(a), R * Math.cos(a), a]; }
      s -= PI * R;
      if (s < 2 * HL) return [HL - s, -R, PI];
      s -= 2 * HL; const a = s / R; return [-HL - R * Math.sin(a), -R * Math.cos(a), PI + a];
    };
    const link = mergeGeometries([box(.5, .045, pitch * .9).toNonIndexed(), box(.5, .035, .03).translate(0, .035, 0).toNonIndexed()]);
    for (const sx of [-1, 1]) {
      const x = sx * .92;
      for (let i = 0; i < NL; i++) { const [z, y, a] = pathAt(i * pitch); k2(kU, link, x, .33 + y, z, a); }
      kU.add(rbox(.36, .34, 2.5, .07), { s: 'paint', c: DG, m: M(x, .36, 0) });
      kU.add(cyl(.26, .26, .34, 12), { s: 'steel', c: 0x3a3b3d, m: M(x, .33, -1.32, 0, 0, PI / 2) });
      kU.add(cyl(.12, .12, .4, 16), { s: 'steel', c: 0x4a4c4f, m: M(x, .33, -1.32, 0, 0, PI / 2) });
      kU.add(cyl(.25, .25, .3, 20), { s: 'steel', c: 0x3a3b3d, m: M(x, .33, 1.32, 0, 0, PI / 2) });
      for (const z of [-.75, -.25, .25, .75]) kU.add(cyl(.1, .1, .3, 12), { s: 'steel', c: 0x3a3b3d, m: M(x, .14, z, 0, 0, PI / 2) });
      for (const z of [-.5, .5]) kU.add(cyl(.07, .07, .2, 12), { s: 'steel', c: 0x3a3b3d, m: M(x, .57, z, 0, 0, PI / 2) });
    }
    kU.add(rbox(1.3, .36, 1.7, .05), { s: 'paint', c: DG, m: M(0, .5, 0) });
    kU.add(cyl(.64, .64, .1, 40), { s: 'steel', c: 0x2a2b2d, m: M(0, .73, 0) });
    // dozer blade
    kU.add(rbox(2.32, .48, .08, .025), { s: 'ypaint', c: Y, m: M(0, .32, 1.86, -.12) });
    kU.add(box(2.32, .05, .06), { s: 'steel', c: 0x55585c, m: M(0, .08, 1.84) });
    for (const sx of [-1, 1]) kU.add(rbox(.14, .14, .9, .03), { s: 'ypaint', c: Y, m: M(sx * .55, .36, 1.35, .15) });
  }
  group.add(kU.mesh(mat, { name: 'ExcUnder' }));

  /* ---- upper structure ---- */
  const upper = new THREE.Group(); upper.position.y = .78; group.add(upper);
  const kP = new Kit(), kG = new Kit();
  {
    kP.add(rbox(2.3, .16, 2.55, .04), { s: 'ypaint', c: Y, m: M(0, .08, -.1) });
    kP.add(rbox(2.34, .78, .64, .22, 3), { s: 'ypaint', c: Y, m: M(0, .5, -1.08) });
    kP.add(rbox(2.36, .07, .5, .03), { s: 'satin', c: BK, m: M(0, .2, -1.12) });
    for (const sx of [-1, 1]) kP.add(rbox(.12, .06, .02, .01), { s: 'ledR', c: 0xffffff, m: M(sx * .85, .55, -1.405) });
    // engine hood + grille + exhaust + intake
    kP.add(rbox(2.2, .5, .78, .08), { s: 'ypaint', c: Y, m: M(-.04, .4, -.52) });
    kP.add(new THREE.PlaneGeometry(.8, .4), { rect: REG.VENT, m: M(-.45, .651, -.52, -PI / 2) });
    kP.add(new THREE.PlaneGeometry(.5, .28), { rect: REG.VENT, m: M(-1.141, .4, -.5, 0, -PI / 2, 0) });
    rod(kP, new V3(-.75, .62, -.7), new V3(-.75, 1.15, -.7), .045, { s: 'steel', c: 0x1a1a1a }, 12);
    kP.add(cyl(.06, .05, .05, 12), { s: 'steel', c: 0x222222, m: M(-.75, 1.17, -.7) });
    kP.add(cyl(.09, .09, .18, 16), { s: 'satin', c: BK, m: M(-.3, .74, -.6) });
    // tank / toolbox on right front + handrail
    kP.add(rbox(.76, .62, 1.22, .06), { s: 'ypaint', c: Y, m: M(-.74, .47, .52) });
    kP.add(box(.6, .02, .5), { s: 'steel', c: 0x4a4c4f, m: M(-.74, .79, .45) });
    rod(kP, new V3(-1.08, .78, .05), new V3(-1.08, 1.12, .05), .018, { s: 'ypaint', c: Y });
    rod(kP, new V3(-1.08, .78, 1.0), new V3(-1.08, 1.12, 1.0), .018, { s: 'ypaint', c: Y });
    rod(kP, new V3(-1.08, 1.12, .05), new V3(-1.08, 1.12, 1.0), .018, { s: 'ypaint', c: Y });
    kP.add(box(.3, .03, .2), { s: 'steel', c: 0x3a3b3d, m: M(-.95, .2, 1.2) });
    // boom foot lugs + cylinder base block
    for (const sx of [-1, 1]) kP.add(box(.06, .42, .5), { s: 'ypaint', c: Y, m: M(-.08 + sx * .21, .32, .98) });
    kP.add(rbox(.34, .22, .3, .03), { s: 'ypaint', c: Y, m: M(-.08, .12, 1.22) });
    kP.add(cyl(.06, .06, .5, 14), { s: 'steel', c: 0x55585c, m: M(-.08, .45, 1.05, 0, 0, PI / 2) });
    // cab
    const cx = .69, cz = .48;
    kP.add(rbox(.92, .1, 1.28, .02), { s: 'ypaint', c: Y, m: M(cx, .2, cz) });
    kP.add(rbox(.92, .46, .78, .03), { s: 'ypaint', c: Y, m: M(cx, .4, cz - .26) });
    kP.add(rbox(.92, 1.36, .06, .02), { s: 'ypaint', c: Y, m: M(cx, 1.3, -.13) });
    kP.add(rbox(.98, .09, 1.36, .035), { s: 'ypaint', c: Y, m: M(cx, 2.01, cz) });
    kP.add(rbox(.99, .03, 1.37, .01), { s: 'satin', c: BK, m: M(cx, 1.955, cz) });
    const posts = [[.25, -.1, .25, -.1], [1.13, -.1, 1.13, -.1], [.25, 1.12, .25, 1.02], [1.13, 1.12, 1.13, 1.02], [1.13, .5, 1.13, .5]];
    for (const [x0, z0, x1, z1] of posts) rod(kP, new V3(x0, .2, z0), new V3(x1, 1.97, z1), .03, { s: 'satin', c: BK }, 8);
    for (const y of [.62, 1.97]) {
      rod(kP, new V3(.25, y, 1.1), new V3(1.13, y, 1.1), .02, { s: 'satin', c: BK }, 6);
      rod(kP, new V3(1.13, y, -.1), new V3(1.13, y, 1.1), .02, { s: 'satin', c: BK }, 6);
      rod(kP, new V3(.25, y, -.1), new V3(.25, y, 1.1), .02, { s: 'satin', c: BK }, 6);
    }
    kP.add(rbox(.03, .14, .03, .01), { s: 'chrome', c: 0xd0d2d4, m: M(1.15, 1.05, .56) });
    rod(kP, new V3(1.18, .5, .0), new V3(1.18, 1.7, .0), .016, { s: 'ypaint', c: Y });
    // mirror
    rod(kP, new V3(1.13, 1.9, 1.08), new V3(1.32, 2.06, 1.2), .012, { s: 'satin', c: BK });
    kP.add(rbox(.04, .2, .14, .015), { s: 'satin', c: BK, m: M(1.33, 1.98, 1.2) });
    // beacon + work light
    kP.add(cyl(.07, .075, .04, 16), { s: 'satin', c: BK, m: M(.95, 2.075, .05) });
    kP.add(cyl(.055, .065, .1, 16), { s: 'ledA', c: 0xffffff, m: M(.95, 2.14, .05) });
    kP.add(rbox(.14, .1, .07, .02), { s: 'satin', c: BK, m: M(.45, 2.1, 1.08) });
    kP.add(box(.11, .07, .01), { s: 'ledW', c: 0xffffff, m: M(.45, 2.1, 1.116) });
    // interior: seat, consoles, joysticks, display, operator
    kP.add(rbox(.42, .1, .42, .04), { s: 'plastic', c: 0x2c2d30, m: M(cx, .62, .33) });
    kP.add(rbox(.42, .55, .1, .04), { s: 'plastic', c: 0x2c2d30, m: M(cx, .93, .1, -.15) });
    for (const sx of [-1, 1]) {
      kP.add(rbox(.13, .3, .42, .03), { s: 'plastic', c: 0x3a3b3e, m: M(cx + sx * .27, .58, .42) });
      rod(kP, new V3(cx + sx * .27, .73, .55), new V3(cx + sx * .27, .86, .58), .012, { s: 'satin', c: BK });
      kP.add(sph(.03, 10, 8), { s: 'plastic', c: 0x111111, m: M(cx + sx * .27, .88, .585) });
    }
    kP.add(rbox(.18, .12, .03, .01), { s: 'glass', c: 0x0c1520, m: M(1.0, 1.05, .98, -.4) });
    // operator (hi-vis shirt, hard hat)
    kP.add(rbox(.36, .48, .22, .08), { s: 'plastic', c: 0xff7a1a, m: M(cx, 1.05, .34) });
    kP.add(sph(.095, 14, 10), { s: 'plastic', c: 0xc58a64, m: M(cx, 1.42, .38) });
    kP.add(sph(.11, 14, 8, 0, TAU, 0, PI / 2), { s: 'gloss', c: 0xf4f4f0, m: M(cx, 1.45, .38) });
    for (const sx of [-1, 1]) {
      rod(kP, new V3(cx + sx * .17, 1.22, .36), new V3(cx + sx * .24, .95, .5), .045, { s: 'plastic', c: 0xff7a1a });
      rod(kP, new V3(cx + sx * .24, .95, .5), new V3(cx + sx * .27, .9, .58), .035, { s: 'plastic', c: 0xc58a64 });
      rod(kP, new V3(cx + sx * .1, .7, .42), new V3(cx + sx * .1, .6, .82), .065, { s: 'plastic', c: 0x2a3550 });
    }
    // glass panes
    kG.add(box(.84, 1.3, .01), { s: 'glass', m: M(cx, 1.3, 1.07, -.05) });
    kG.add(box(.01, 1.32, .58), { s: 'glass', m: M(1.13, 1.3, .79) });
    kG.add(box(.01, 1.32, .56), { s: 'glass', m: M(1.13, 1.3, .2) });
    kG.add(box(.01, 1.32, 1.16), { s: 'glass', m: M(.25, 1.3, .5) });
    kG.add(box(.7, .55, .01), { s: 'glass', m: M(cx, 1.5, -.165) });
    // model plate on the counterweight side
    kP.add(new THREE.PlaneGeometry(.5, .167), { rect: REG.PLATE, m: M(1.171, .55, -1.0, 0, PI / 2, 0) });
  }
  upper.add(kP.mesh(mat, { name: 'ExcUpper' }));
  upper.add(kG.mesh(cabGlassMat(), { cast: false, name: 'ExcGlass' }));

  /* ---- boom ---- */
  const LB = 3.3, LS = 1.9;
  const boomPivot = new THREE.Group(); boomPivot.position.set(-.08, .45, 1.05); upper.add(boomPivot);
  const kB = new Kit();
  const toLink = (thick) => new THREE.Matrix4().makeTranslation(thick / 2, 0, 0).multiply(new THREE.Matrix4().makeRotationY(-PI / 2));
  let boomTop = [], boomBot = [];
  {
    const P1 = [LB * .38, .95], N = 14, s = new THREE.Shape();
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const x = 2 * u * t * P1[0] + t * t * LB, y = 2 * u * t * P1[1];
      const dx = 2 * u * P1[0] + 2 * t * (LB - P1[0]), dy = 2 * u * P1[1] - 2 * t * P1[1];
      const l = Math.hypot(dx, dy), nx = -dy / l, ny = dx / l;
      const h = (t < .4 ? lerp(.46, .56, t / .4) : lerp(.56, .3, (t - .4) / .6)) / 2;
      boomTop.push([x + nx * h, y + ny * h]); boomBot.push([x - nx * h, y - ny * h]);
    }
    s.moveTo(...boomBot[0]); boomBot.forEach(p => s.lineTo(...p));
    for (let i = N; i >= 0; i--) s.lineTo(...boomTop[i]);
    s.closePath();
    kB.add(extrude(s, .34, .025, 2, 4), { s: 'ypaint', c: Y, pre: toLink(.34 + .05) });
    kB.add(cyl(.2, .2, .4, 20), { s: 'ypaint', c: Y, m: M(0, 0, 0, 0, 0, PI / 2) });
    kB.add(cyl(.15, .15, .36, 20), { s: 'ypaint', c: Y, m: M(0, 0, LB, 0, 0, PI / 2) });
    kB.add(cyl(.05, .05, .46, 12), { s: 'steel', c: 0x55585c, m: M(0, 0, LB, 0, 0, PI / 2) });
    // cylinder lugs
    kB.add(box(.26, .14, .22), { s: 'ypaint', c: Y, m: M(0, .2, 1.07) });
    kB.add(box(.22, .16, .24), { s: 'ypaint', c: Y, m: M(0, .72, 1.29) });
    // hydraulic hoses along top
    for (const sx of [-1, 1]) {
      const pts = boomTop.filter((_, i) => i % 2 === 0).map(([x, y]) => new V3(sx * .06, y + .04, x));
      kB.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, .02, 6), { s: 'rubber', c: 0x121212 });
    }
    kB.add(new THREE.PlaneGeometry(.75, .25), { rect: REG.PLATE, m: M(.197, .55, 1.4, 0, PI / 2, 0) });
    kB.add(new THREE.PlaneGeometry(.75, .25), { rect: REG.PLATE, m: M(-.197, .55, 1.4, 0, -PI / 2, 0) });
  }
  boomPivot.add(kB.mesh(mat, { name: 'ExcBoom' }));

  /* ---- stick ---- */
  const stickPivot = new THREE.Group(); stickPivot.position.set(0, 0, LB); boomPivot.add(stickPivot);
  const kS = new Kit();
  {
    const s = new THREE.Shape(), pts = [[-.42, .4], [-.25, .52], [.3, .32], [LS - .1, .12], [LS + .06, .03], [LS + .04, -.11], [LS - .2, -.14], [.3, -.2], [-.12, -.16], [-.46, .18]];
    s.moveTo(...pts[0]); pts.slice(1).forEach(p => s.lineTo(...p)); s.closePath();
    kS.add(extrude(s, .26, .02, 2, 2), { s: 'ypaint', c: Y, pre: toLink(.26 + .04) });
    kS.add(cyl(.13, .13, .32, 18), { s: 'ypaint', c: Y, m: M(0, 0, 0, 0, 0, PI / 2) });
    kS.add(cyl(.1, .1, .3, 16), { s: 'ypaint', c: Y, m: M(0, 0, LS, 0, 0, PI / 2) });
    kS.add(cyl(.045, .045, .4, 12), { s: 'steel', c: 0x55585c, m: M(0, 0, LS, 0, 0, PI / 2) });
    kS.add(box(.2, .12, .2), { s: 'ypaint', c: Y, m: M(0, .33, .35) });
    kS.add(cyl(.07, .07, .3, 14), { s: 'ypaint', c: Y, m: M(0, .48, -.33, 0, 0, PI / 2) });
  }
  stickPivot.add(kS.mesh(mat, { name: 'ExcStick' }));

  /* ---- bucket ---- */
  const bucketPivot = new THREE.Group(); bucketPivot.position.set(0, 0, LS); stickPivot.add(bucketPivot);
  const kK = new Kit();
  {
    const C = [[-.02, .14], [.22, .27], [.5, .25], [.72, .12], [.84, -.1], [.84, -.32], [.78, -.5]];
    const cen = [.42, -.08];
    const inner = C.map(([x, y]) => { const dx = cen[0] - x, dy = cen[1] - y, l = Math.hypot(dx, dy); return [x + dx / l * .03, y + dy / l * .03]; });
    const shell = new THREE.Shape(); shell.moveTo(...C[0]); C.slice(1).forEach(p => shell.lineTo(...p));
    for (let i = inner.length - 1; i >= 0; i--) shell.lineTo(...inner[i]); shell.closePath();
    kK.add(extrude(shell, .74, .01, 1, 2), { s: 'steel', c: 0x3b3c3e, pre: toLink(.74 + .02) });
    const side = new THREE.Shape(); side.moveTo(...C[0]); C.slice(1).forEach(p => side.lineTo(...p)); side.lineTo(.05, -.12); side.closePath();
    for (const sx of [-1, 1]) kK.add(extrude(side, .02, 0, 1, 2), { s: 'steel', c: 0x3b3c3e, pre: new THREE.Matrix4().makeTranslation(sx * .37 + .01, 0, 0).multiply(new THREE.Matrix4().makeRotationY(-PI / 2)) });
    kK.add(box(.78, .03, .07), { s: 'steel', c: 0x8a8d90, m: M(0, -.5, .78, .3) });
    const dz = -.06, dy = -.18, l = Math.hypot(dz, dy), th = Math.atan2(-dy / l, dz / l);
    for (let i = 0; i < 5; i++) {
      const tx = -.3 + i * .15;
      kK.add(box(.06, .035, .16), { s: 'steel', c: 0x9a9c9e, m: M(tx, -.5 + dy / l * .07, .78 + dz / l * .07, th) });
    }
    kK.add(box(.28, .18, .2), { s: 'steel', c: 0x3b3c3e, m: M(0, .12, .0) });
    kK.add(cyl(.05, .05, .3, 12), { s: 'steel', c: 0x55585c, m: M(0, .26, -.06, 0, 0, PI / 2) });
    const dirt = new THREE.IcosahedronGeometry(.28, 1); dirt.scale(1.2, .55, .9);
    kK.add(dirt, { s: 'earth', c: 0x5a412c, m: M(0, -.12, .42) });
  }
  bucketPivot.add(kK.mesh(mat, { name: 'ExcBucket' }));

  /* ---- hydraulic cylinders ---- */
  const cB = makeHydCyl(.075, .045), cS = makeHydCyl(.065, .04), cK = makeHydCyl(.055, .035);
  upper.add(cB); boomPivot.add(cS); stickPivot.add(cK);
  const aB = new V3(-.08, .14, 1.26), rB = new V3(0, .2, 1.07);
  const aS = new V3(0, .74, 1.29), rS = new V3(0, .48, -.33);
  const aK = new V3(0, .33, .35), rK = new V3(0, .26, -.06);
  const Zax = new V3(0, 0, 1), tmp = new V3(), dir = new V3();
  const place = (mesh, A, pivot, Rloc) => {
    tmp.copy(Rloc).applyMatrix4(pivot.matrix);
    dir.subVectors(tmp, A); const len = dir.length();
    mesh.position.copy(A); mesh.quaternion.setFromUnitVectors(Zax, dir.divideScalar(len)); mesh.scale.set(1, 1, len);
  };
  // dig cycle keyframes: [u, swing, boom, stick, bucket] (deg)
  const K = [[0, 0, 24, 78, 40], [.16, 0, 13, 98, 55], [.34, 0, 13, 128, 115], [.48, 0, 40, 122, 135],
    [.62, -19, 50, 125, 132], [.72, -19, 46, 102, 15], [.86, 0, 30, 82, 30], [1, 0, 24, 78, 40]];
  const ease = (x) => x * x * (3 - 2 * x);
  const pose = (t) => {
    const T = 11, u = ((t % T) + T) % T / T;
    let i = 0; while (i < K.length - 2 && u > K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1], f = ease(THREE.MathUtils.clamp((u - a[0]) / (b[0] - a[0]), 0, 1));
    upper.rotation.y = lerp(a[1], b[1], f) * DEG;
    upper.position.y = .78 + Math.sin(t * 47) * .002;
    boomPivot.rotation.x = -lerp(a[2], b[2], f) * DEG;
    stickPivot.rotation.x = lerp(a[3], b[3], f) * DEG;
    bucketPivot.rotation.x = lerp(a[4], b[4], f) * DEG;
    boomPivot.updateMatrix(); stickPivot.updateMatrix(); bucketPivot.updateMatrix();
    place(cB, aB, boomPivot, rB);
    place(cS, aS, stickPivot, rS);
    place(cK, aK, bucketPivot, rK);
  };
  pose(0);
  return { group, update: pose };
}
function k2(k, g, x, y, z, a) { k.add(g, { s: 'steel', c: 0x2a2a2a, m: M(x, y, z, a) }); }

/* =====================================================================================
   Road works
   ===================================================================================== */
function noise3(x, y, z) {
  return Math.sin(x * 3.1 + y * 1.7) * .5 + Math.sin(y * 4.3 - z * 2.9) * .3 + Math.sin(z * 5.7 + x * 2.3) * .2;
}
function moundGeo(rx, h, rz, seed, detail = 3) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, s = seed * .37;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + .13 * noise3(x * 1.7 + s, y * 1.7, z * 1.7 - s) + .05 * noise3(x * 5 - s, y * 5, z * 5 + s);
    x *= n; y *= n; z *= n;
    p.setXYZ(i, x * rx, Math.max(0, y) * h, z * rz);
  }
  g.computeVertexNormals();
  return g;
}
function slabGeo(len, wid, th, rnd) {
  const s = new THREE.Shape(), n = 6, pts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + rnd() * .5;
    pts.push([Math.cos(a) * len / 2 * (.8 + rnd() * .25), Math.sin(a) * wid / 2 * (.8 + rnd() * .25)]);
  }
  s.moveTo(...pts[0]); pts.slice(1).forEach(p => s.lineTo(...p)); s.closePath();
  const g = extrude(s, th, 0, 1, 1); g.rotateX(-PI / 2);
  return g;
}

/**
 * Road-repair site along local +X (0..length) × local Z (−width/2..width/2): water-filled barriers,
 * cones, «ДОРОЖНЫЕ РАБОТЫ» signs, broken asphalt, a shallow dug pit with an exposed pipe, spoil and gravel
 * piles, a towed compressor with hose and an animated excavator digging and dumping.
 * @param {{length?: number, width?: number}} opts
 * @returns {{group: THREE.Group, workerSpot: THREE.Object3D, dustOrigin: THREE.Object3D, excavator: object, update: (t: number, dt?: number) => void}}
 */
export function createRoadWorks({ length = 24, width = 7 } = {}) {
  const group = new THREE.Group(); group.name = 'RoadWorks';
  const k = new Kit(), rnd = mulberry32(2024);
  const hw = width / 2, Lx = length;
  const sc = (x) => x * Lx / 26;   // layout designed for 26 m, stretched to `length`
  const ez = Math.min(hw - .22, 2.3);
  const WX = sc(10.8), WZ = Math.min(1.6, ez - .7);
  /* --- barriers: alternating red/white water-filled blocks --- */
  const blk = new THREE.Shape();
  [[-.2, 0], [.2, 0], [.2, .1], [.12, .3], [.1, .66], [.06, .78], [-.06, .78], [-.1, .66], [-.12, .3], [-.2, .1]].forEach((p, i) => i ? blk.lineTo(...p) : blk.moveTo(...p));
  blk.closePath();
  const blkG = extrude(blk, 1.08, .03, 2, 1); blkG.translate(0, 0, -.54); blkG.rotateY(PI / 2);
  let bi = 0;
  const block = (x, z, ry = 0) => {
    const red = (bi++ % 2) === 0;
    k.add(blkG, { s: 'plastic', c: red ? 0xd42a2a : 0xf1f1ec, m: M(x, 0, z, 0, ry, 0) });
    k.add(cyl(.05, .05, .02, 12), { s: 'plastic', c: red ? 0xb02020 : 0xdadad4, m: M(x, .815, z) });
  };
  const gapA = WX - 1.9, gapB = WX + 1.9;
  for (let x = .8; x < Lx - .6; x += 1.2) {
    if (!(x > gapA && x < gapB)) block(x, ez);
    block(x, -ez);
  }
  /* --- end fences: striped boards on A-frames + lamps --- */
  for (const ex of [.25, Lx - .25]) {
    for (const zc of [-hw * .45, hw * .45]) {
      const bw = Math.min(2.1, hw * .85);
      for (const y of [1.0, .55]) k.add(box(.03, .25, bw), { rect: REG.STRIPE, m: M(ex, y, zc, 0, PI / 2, 0) });
      for (const zz of [-bw / 2 + .1, bw / 2 - .1]) {
        rod(k, new V3(ex, 1.15, zc + zz), new V3(ex - .25, 0, zc + zz), .018, { s: 'galv', c: 0x9aa0a5 });
        rod(k, new V3(ex, 1.15, zc + zz), new V3(ex + .25, 0, zc + zz), .018, { s: 'galv', c: 0x9aa0a5 });
        k.add(rbox(.6, .05, .12, .02), { s: 'rubber', c: 0x1b1b1b, m: M(ex, .025, zc + zz) });
      }
      k.add(cyl(.065, .07, .1, 16), { s: 'ledA', c: 0xffffff, m: M(ex, 1.22, zc) });
      k.add(cyl(.07, .07, .03, 16), { s: 'satin', c: 0x111111, m: M(ex, 1.155, zc) });
    }
  }
  /* --- cones --- */
  const cone = (x, z) => {
    k.add(rbox(.38, .035, .38, .012), { s: 'rubber', c: 0x161616, m: M(x, .0175, z) });
    k.add(cyl(.028, .15, .66, 20, true), { s: 'plastic', c: 0xff5414, m: M(x, .035 + .33, z) });
    const r = (y) => .15 - .122 * (y - .035) / .66;
    for (const [y0, y1] of [[.3, .41], [.48, .55]]) k.add(cyl(r(y1) + .003, r(y0) + .003, y1 - y0, 20, true), { s: 'sheet', c: 0xf4f4f2, m: M(x, (y0 + y1) / 2, z) });
    k.add(cyl(.03, .03, .012, 12), { s: 'plastic', c: 0xff5414, m: M(x, .7, z) });
  };
  cone(gapA + .15, ez); cone(gapB - .15, ez); cone(WX - .9, ez + .02); cone(.6, ez - .9); cone(1.2, ez - 1.6);
  cone(sc(24.6), ez - .9); cone(sc(15.0), hw - .3);
  /* --- sign stands (triangle + plaque) --- */
  const signStand = (x, z, ry) => {
    const P = M(x, 0, z, 0, ry, 0);
    rod(k, new V3(0, 0, -.02), new V3(0, 1.62, -.02), .022, { s: 'galv', c: 0x9aa0a5, P });
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3 + PI / 2, fx = Math.cos(a) * .5, fz = Math.sin(a) * .5 - .02;
      rod(k, new V3(0, .4, -.02), new V3(fx, .02, fz), .016, { s: 'galv', c: 0x9aa0a5, P });
      k.add(rbox(.3, .1, .18, .04), { s: 'plastic', c: 0x6d6a3e, m: at(P, M(fx, .05, fz, 0, a, 0)) });
    }
    const S = .9, tri = new THREE.Shape(); tri.moveTo(-S / 2, 0); tri.lineTo(S / 2, 0); tri.lineTo(0, S * .866); tri.closePath();
    k.add(new THREE.ShapeGeometry(tri), { rect: REG.TRI, planar: [-S / 2 - S / 30, -.1 * S, S * 1.0667, S * 1.0667], m: at(P, M(0, 1.0, .02)) });
    const trb = new THREE.Shape(); trb.moveTo(-S / 2 - .02, -.012); trb.lineTo(S / 2 + .02, -.012); trb.lineTo(0, S * .866 + .025); trb.closePath();
    k.add(extrude(trb, .012, 0, 1, 1), { s: 'galv', c: 0x8f959a, m: at(P, M(0, 1.0, .004)) });
    k.add(new THREE.PlaneGeometry(.9, .225), { rect: REG.WORKS, m: at(P, M(0, .8, .02)) });
    k.add(box(.92, .24, .012), { s: 'galv', c: 0x8f959a, m: at(P, M(0, .8, .008)) });
    k.add(cyl(.06, .065, .09, 16), { s: 'ledA', c: 0xffffff, m: at(P, M(0, 1.92, .0)) });
  };
  signStand(sc(1.6), Math.min(1.2, hw - .9), -.55);
  signStand(sc(24.6), Math.min(1.0, hw - .9), .55);
  /* --- saw-cut outline + pit floor + rim of broken slabs + exposed pipe --- */
  const PX = WX, PZ = WZ - 1.75, ax = 2.0, az = Math.min(1.05, hw - .9);
  const poly = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * TAU, c = Math.cos(a), s = Math.sin(a);
    const sx = Math.sign(c) * Math.pow(Math.abs(c), .55), sz = Math.sign(s) * Math.pow(Math.abs(s), .55);
    const j = .93 + rnd() * .1;
    poly.push([PX + sx * ax * j, PZ + sz * az * j]);
  }
  const floor = new THREE.Shape(); poly.forEach(([x, z], i) => i ? floor.lineTo(x, -z) : floor.moveTo(x, -z)); floor.closePath();
  k.add(new THREE.ShapeGeometry(floor), { s: 'earth', c: 0x3f2e20, m: M(0, .016, 0, -PI / 2) });
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, ex = x1 - x0, ezz = z1 - z0, el = Math.hypot(ex, ezz);
    let nx = ezz / el, nz = -ex / el;
    if ((mx - PX) * nx + (mz - PZ) * nz < 0) { nx = -nx; nz = -nz; }
    const wid = .34 + rnd() * .14, th = .1 + rnd() * .05;
    const ry = Math.atan2(-ezz, ex);
    const g = slabGeo(el * 1.15, wid, th, rnd);
    // tilt toward the pit (rotate about the edge direction)
    const tilt = (5 + rnd() * 9) * DEG;
    const q = new THREE.Quaternion().setFromAxisAngle(new V3(ex / el, 0, ezz / el), 0);
    void q;
    const mtx = new THREE.Matrix4().makeTranslation(mx + nx * (wid / 2 - .04), .0, mz + nz * (wid / 2 - .04))
      .multiply(new THREE.Matrix4().makeRotationY(ry))
      .multiply(new THREE.Matrix4().makeRotationX(-tilt * Math.sign(1)));
    k.add(g, { s: 'concrete', c: 0x77706a, top: 0x2b2c2e, m: mtx });
  }
  // exposed pipe with coupling + stones + puddle
  k.add(cyl(.11, .11, ax * 2.3, 20), { s: 'plastic', c: 0x2c5f95, m: M(PX, .1, PZ - .1, 0, 0, PI / 2) });
  k.add(cyl(.135, .135, .22, 20), { s: 'plastic', c: 0x1c1c1c, m: M(PX + .3, .1, PZ - .1, 0, 0, PI / 2) });
  k.add(new THREE.CircleGeometry(.45, 20), { s: 'wet', c: 0x231d17, m: M(PX - .9, .019, PZ + .35, -PI / 2, 0, 0, [1.4, .8, 1]) });
  const stone = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 26; i++) {
    const x = PX + (rnd() - .5) * ax * 1.7, z = PZ + (rnd() - .5) * az * 1.6, r = .03 + rnd() * .06;
    k.add(stone, { s: 'earth', c: [0x6f6a63, 0x5b4936, 0x8a847b][i % 3], m: M(x, r * .6, z, rnd() * 3, rnd() * 3, 0, [r, r * .8, r]) });
  }
  // saw-cut lines
  for (const [x0, z0, x1, z1] of [[PX - ax - .4, PZ - az - .45, PX + ax + .4, PZ - az - .45], [PX - ax - .4, PZ + az + .45, PX + ax + .4, PZ + az + .45],
    [PX - ax - .4, PZ - az - .45, PX - ax - .4, PZ + az + .45], [PX + ax + .4, PZ - az - .45, PX + ax + .4, PZ + az + .45]]) {
    const l = Math.hypot(x1 - x0, z1 - z0);
    k.add(box(l, .004, .012), { s: 'dim', c: 0x0e0e0e, m: M((x0 + x1) / 2, .021, (z0 + z1) / 2, 0, -Math.atan2(z1 - z0, x1 - x0), 0) });
  }
  /* --- jackhammer zone in front of the worker: cracks + loosened fragments --- */
  const CX = WX, CZ = WZ + .55;
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU, l = .3 + rnd() * .6;
    k.add(box(l, .004, .014), { s: 'dim', c: 0x0c0c0c, m: M(CX + Math.cos(a) * l / 2, .022, CZ + Math.sin(a) * l / 2 * .6, 0, -a, 0) });
  }
  for (let i = 0; i < 6; i++) {
    const a = rnd() * TAU, d = .25 + rnd() * .45;
    k.add(slabGeo(.25 + rnd() * .2, .2 + rnd() * .12, .06, rnd), { s: 'concrete', c: 0x6f6862, top: 0x2d2e30, m: M(CX + Math.cos(a) * d, .005, CZ + Math.sin(a) * d * .5 - .15, (rnd() - .5) * .3, rnd() * 3, (rnd() - .5) * .3) });
  }
  // dust stains
  for (let i = 0; i < 5; i++) {
    const r = .3 + rnd() * .5;
    k.add(new THREE.CircleGeometry(1, 10), { s: 'earth', c: 0x8d7c66, m: M(PX + (rnd() - .5) * 6, .02 + i * .0004, PZ + (rnd() - .2) * 1.6, -PI / 2, 0, rnd() * 3, [r * 1.6, r, 1]) });
  }
  /* --- spoil pile (excavator dumps here), gravel pile, slab heap --- */
  const SPX = sc(13.9), SPZ = Math.max(PZ - .45, -hw + 1.0);
  k.add(moundGeo(.95, .62, .75, 3), { s: 'earth', c: 0x5e4430, m: M(SPX, 0, SPZ) });
  k.add(moundGeo(1.15, .75, .95, 7), { s: 'earth', c: 0x8b8781, m: M(sc(21.4), 0, Math.min(1.0, hw - 1.2)) });
  for (let i = 0; i < 40; i++) {
    const a = rnd() * TAU, d = .9 + rnd() * .5, r = .025 + rnd() * .035;
    k.add(stone, { s: 'earth', c: 0x8f8a83, m: M(sc(21.4) + Math.cos(a) * d * 1.1, r * .5, Math.min(1.0, hw - 1.2) + Math.sin(a) * d * .85, rnd() * 3, rnd() * 3, 0, [r, r * .7, r]) });
  }
  for (let i = 0; i < 7; i++) {
    k.add(slabGeo(.6 + rnd() * .3, .45 + rnd() * .2, .1, rnd), { s: 'concrete', c: 0x736c66, top: 0x2b2c2e, m: M(sc(7.3) + (rnd() - .5) * .7, .02 + i * .07, -hw + 1.2 + (rnd() - .5) * .5, (rnd() - .5) * .35, rnd() * 3, (rnd() - .5) * .35) });
  }
  // shovel stuck in the gravel pile
  {
    const gx = sc(21.4) - .5, gz = Math.min(1.0, hw - 1.2) + .3;
    rod(k, new V3(gx, .45, gz), new V3(gx - .25, 1.45, gz + .12), .018, { s: 'plastic', c: 0x8a5a2b });
    k.add(rbox(.24, .3, .02, .03), { s: 'steel', c: 0x55585c, m: M(gx + .03, .38, gz - .01, -.15, 0, -.25) });
  }
  // pallet with cement bags
  {
    const px = sc(23.2), pz = -hw + 1.15;
    k.add(rbox(1.2, .14, 1.0, .01), { s: 'plastic', c: 0x9b7b53, m: M(px, .07, pz) });
    for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) k.add(rbox(.36, .14, .58, .06), { s: 'plastic', c: j ? 0xd8d0c0 : 0xcfc6b4, m: M(px - .38 + i * .38, .21 + j * .14, pz + (j ? .05 : -.02), 0, (rnd() - .5) * .15, 0) });
  }
  /* --- towed air compressor + hose to the worker --- */
  {
    const P = M(sc(5.3), 0, -Math.min(.95, hw - 1.1), 0, PI, 0), OR = 0xe8731c;
    k.add(rbox(1.55, .82, .95, .1, 3), { s: 'ypaint', c: OR, m: at(P, M(0, .8, 0)) });
    k.add(rbox(1.5, .04, .9, .02), { s: 'satin', c: 0x2b2b2b, m: at(P, M(0, 1.0, 0)) });
    for (const sz of [-1, 1]) k.add(new THREE.PlaneGeometry(.55, .32), { rect: REG.VENT, m: at(P, M(-.35, .8, sz * .477, 0, sz > 0 ? 0 : PI, 0)) });
    k.add(rbox(.04, .3, .5, .02), { s: 'satin', c: 0x1e1e1e, m: at(P, M(-.79, .85, 0)) });
    k.add(new THREE.CircleGeometry(.05, 20), { rect: REG.DIAL, planar: [-.05, -.05, .1, .1], m: at(P, M(-.812, .92, -.12, 0, -PI / 2, 0)) });
    k.add(new THREE.CircleGeometry(.05, 20), { rect: REG.DIAL, planar: [-.05, -.05, .1, .1], m: at(P, M(-.812, .92, .1, 0, -PI / 2, 0)) });
    for (const z of [-.15, .15]) k.add(cyl(.03, .03, .1, 10), { s: 'steel', c: 0x9a9da0, m: at(P, M(-.83, .7, z, 0, 0, PI / 2)) });
    rod(k, new V3(-.5, .38, -.48), new V3(-.5, .38, .48), .03, { s: 'steel', c: 0x333333, P });
    for (const sz of [-1, 1]) {
      k.add(cyl(.27, .27, .17, 22), { s: 'rubber', c: 0x1a1a1a, m: at(P, M(0, .27, sz * .58, PI / 2)) });
      k.add(cyl(.15, .15, .18, 18), { s: 'steel', c: 0xb0b3b6, m: at(P, M(0, .27, sz * .58, PI / 2)) });
      k.add(rbox(.6, .05, .25, .03), { s: 'ypaint', c: OR, m: at(P, M(0, .57, sz * .56)) });
    }
    rod(k, new V3(.7, .45, -.3), new V3(1.65, .42, 0), .03, { s: 'steel', c: 0x333333, P });
    rod(k, new V3(.7, .45, .3), new V3(1.65, .42, 0), .03, { s: 'steel', c: 0x333333, P });
    k.add(new THREE.TorusGeometry(.05, .014, 8, 16), { s: 'steel', c: 0x333333, m: at(P, M(1.72, .42, 0)) });
    rod(k, new V3(1.4, .42, 0), new V3(1.4, .06, 0), .025, { s: 'steel', c: 0x333333, P });
    k.add(cyl(.06, .06, .05, 14), { s: 'rubber', c: 0x111111, m: at(P, M(1.4, .06, 0, PI / 2)) });
    for (const sz of [-1, 1]) k.add(box(.03, .05, .1), { s: 'ledR', c: 0xffffff, m: at(P, M(-.79, .5, sz * .38)) });
    const h0 = new V3(-.88, .7, .15).applyMatrix4(P);
    const pts = [h0, h0.clone().add(new V3(.25, -.4, .05)), new V3(sc(7.3), .03, -.2), new V3(sc(8.3), .03, .9), new V3(sc(9.4), .03, WZ + .15), new V3(WX - .35, .03, WZ - .1)];
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, .026, 8), { s: 'rubber', c: 0x161616 });
  }
  const staticMesh = k.mesh(atlasMat(), { name: 'RoadWorksStatic' });
  group.add(staticMesh);
  /* --- excavator --- */
  const exc = createExcavator();
  exc.group.position.set(sc(16.9), 0, Math.max(-.2, -hw + 1.25));
  exc.group.rotation.y = -PI / 2;
  group.add(exc.group);
  /* --- anchors --- */
  const workerSpot = new THREE.Object3D(); workerSpot.name = 'workerSpot';
  workerSpot.position.set(WX, 0, WZ); group.add(workerSpot);
  const dustOrigin = new THREE.Object3D(); dustOrigin.name = 'dustOrigin';
  dustOrigin.position.set(CX, .05, CZ); group.add(dustOrigin);
  return {
    group, workerSpot, dustOrigin, excavator: exc,
    /** Animates the excavator's dig / swing / dump cycle (≈11 s loop). */
    update(t) { exc.update(t); },
  };
}

/* =====================================================================================
   Dust particles
   ===================================================================================== */
function softTex() {
  if (MAT.soft) return MAT.soft;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), rnd = mulberry32(5);
  for (let i = 0; i < 7; i++) {
    const px = 32 + (rnd() - .5) * 18, py = 32 + (rnd() - .5) * 18, r = 14 + rnd() * 14;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(.5, 'rgba(255,255,255,.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  return (MAT.soft = t);
}
/**
 * Soft dust / debris particle system (camera-facing instanced quads + small rock chunks).
 * Positions passed to `burst` are WORLD coordinates.
 * @returns {{group: THREE.Group, burst: (position: THREE.Vector3, amount?: number) => void, update: (dt: number) => void}}
 */
export function createDust() {
  const group = new THREE.Group(); group.name = 'Dust';
  const N = 180, rnd = mulberry32(99);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const off = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const dat = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  off.setUsage(THREE.DynamicDrawUsage); dat.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aOff', off); geo.setAttribute('aData', dat);
  geo.instanceCount = N;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: softTex() }, uColor: { value: new THREE.Color(0xd2c3a6) } },
    vertexShader: `attribute vec3 aOff; attribute vec4 aData; varying vec2 vUv; varying float vA; varying float vS;
      void main(){
        vUv = position.xy + 0.5;
        float c = cos(aData.z), s = sin(aData.z);
        vec2 p = mat2(c, s, -s, c) * position.xy * aData.x;
        vec4 mv = modelViewMatrix * vec4(aOff, 1.0);
        mv.xy += p;
        vA = aData.y; vS = aData.w;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 uColor; varying vec2 vUv; varying float vA; varying float vS;
      void main(){
        float a = texture2D(map, vUv).a * vA;
        if (a < 0.003) discard;
        vec3 col = uColor * (0.78 + 0.3 * vUv.y) * vS;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 3;
  group.add(mesh);
  // rock chunks
  const NC = 40;
  const chunkMat = MAT.chunk || (MAT.chunk = new THREE.MeshStandardMaterial({ color: 0x5c534a, roughness: .95 }));
  const chunks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), chunkMat, NC);
  chunks.frustumCulled = false; chunks.castShadow = false; chunks.receiveShadow = true;
  group.add(chunks);
  const P = Array.from({ length: N }, () => ({ p: new V3(), v: new V3(), age: 1, life: 0, s0: 0, s1: 0, rot: 0, vr: 0, sh: 1 }));
  const C = Array.from({ length: NC }, () => ({ p: new V3(), v: new V3(), age: 1, life: 0, r: 0, ground: 0, rx: 0, ry: 0 }));
  let pi = 0, ci = 0;
  const tmp = new V3(), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new V3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < NC; i++) chunks.setMatrixAt(i, zero);
  const api = {
    group,
    /** Spawn `amount` dust puffs (and occasionally a rock chunk) at a world position. */
    burst(position, amount = 2) {
      tmp.copy(position); group.updateWorldMatrix(true, false); group.worldToLocal(tmp);
      for (let n = 0; n < amount; n++) {
        const d = P[pi]; pi = (pi + 1) % N;
        const a = rnd() * TAU, h = .15 + rnd() * .45;
        d.p.set(tmp.x + (rnd() - .5) * .08, tmp.y + .03, tmp.z + (rnd() - .5) * .08);
        d.v.set(Math.cos(a) * h, .35 + rnd() * .6, Math.sin(a) * h);
        d.age = 0; d.life = 1.3 + rnd() * 1.3; d.s0 = .1 + rnd() * .15; d.s1 = .7 + rnd() * .7;
        d.rot = rnd() * TAU; d.vr = (rnd() - .5) * 1.2; d.sh = .85 + rnd() * .25;
        if (rnd() < .22) {
          const c = C[ci]; ci = (ci + 1) % NC;
          const b = rnd() * TAU, hs = .4 + rnd() * .8;
          c.p.copy(tmp); c.p.y += .04; c.v.set(Math.cos(b) * hs, 1.2 + rnd() * 1.6, Math.sin(b) * hs);
          c.age = 0; c.life = 1.4 + rnd(); c.r = .012 + rnd() * .025; c.ground = tmp.y + .01; c.rx = rnd() * 3; c.ry = rnd() * 3;
        }
      }
    },
    /** Integrate particles (call every frame with the frame delta in seconds). */
    update(dt) {
      dt = Math.min(Math.max(dt || 0, 0), .1);
      const o = off.array, da = dat.array;
      for (let i = 0; i < N; i++) {
        const d = P[i];
        d.age += dt;
        const k = d.life > 0 ? d.age / d.life : 1;
        if (k >= 1) { da[i * 4 + 1] = 0; da[i * 4] = 0; continue; }
        d.v.multiplyScalar(Math.exp(-1.6 * dt)); d.v.y += .05 * dt; d.v.x += .12 * dt;
        d.p.addScaledVector(d.v, dt);
        d.rot += d.vr * dt;
        o[i * 3] = d.p.x; o[i * 3 + 1] = d.p.y; o[i * 3 + 2] = d.p.z;
        da[i * 4] = lerp(d.s0, d.s1, 1 - Math.pow(1 - k, 2));
        da[i * 4 + 1] = Math.min(1, k * 8) * Math.pow(1 - k, 1.4) * .62;
        da[i * 4 + 2] = d.rot; da[i * 4 + 3] = d.sh;
      }
      off.needsUpdate = true; dat.needsUpdate = true;
      for (let i = 0; i < NC; i++) {
        const c = C[i];
        if (c.life <= 0) continue;
        c.age += dt;
        if (c.age >= c.life) { c.life = 0; chunks.setMatrixAt(i, zero); continue; }
        c.v.y -= 9.8 * dt; c.p.addScaledVector(c.v, dt);
        if (c.p.y < c.ground) { c.p.y = c.ground; c.v.y = Math.abs(c.v.y) * .3; c.v.x *= .5; c.v.z *= .5; }
        c.rx += dt * 6; c.ry += dt * 4;
        const f = 1 - Math.max(0, (c.age - c.life + .3) / .3);
        sc.setScalar(c.r * f);
        chunks.setMatrixAt(i, mtx.compose(c.p, q.setFromEuler(e.set(c.rx, c.ry, 0)), sc));
      }
      chunks.instanceMatrix.needsUpdate = true;
    },
  };
  return api;
}

/* =====================================================================================
   Honk waves
   ===================================================================================== */
function honkTex() {
  if (MAT.honk) return MAT.honk;
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 128);
  x.fillStyle = '#fff'; x.fillRect(236, 0, 20, 128);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  fitFont(x, 'БИП!', 196, 92, 900);
  x.lineJoin = 'round'; x.lineWidth = 14; x.strokeStyle = '#2b1d00'; x.strokeText('БИП!', 108, 68);
  x.fillStyle = '#ffffff'; x.fillText('БИП!', 108, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return (MAT.honk = t);
}
/**
 * Animated car-horn sound waves: 4 nested partial rings expanding toward local +Z (and slightly up), fading,
 * looping every 1.2 s, plus a popping «БИП!» billboard. One draw call, unlit, transparent, no shadows.
 * @param {{color?: number}} opts
 * @returns {{group: THREE.Group, update: (t: number) => void}}
 */
export function createHonkWaves({ color = 0xffd34d } = {}) {
  const group = new THREE.Group(); group.name = 'HonkWaves';
  const parts = [];
  const ringUV = [244 / 256, .5];
  for (let r = 0; r < 4; r++) {
    const g = new THREE.TorusGeometry(1, .085, 6, 28, 1.9);
    g.rotateZ(-.95); g.rotateX(PI / 2); g.rotateY(-PI / 2); g.rotateX(-.22);
    const n = g.toNonIndexed(); n.deleteAttribute('normal');
    const uv = n.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, ringUV[0], ringUV[1]);
    n.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(uv.count).fill(r), 1));
    parts.push(n);
  }
  const q = new THREE.PlaneGeometry(2.3, 1.15).toNonIndexed(); q.deleteAttribute('normal');
  const quv = q.attributes.uv; for (let i = 0; i < quv.count; i++) quv.setX(i, quv.getX(i) * 216 / 256);
  q.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(quv.count).fill(4), 1));
  parts.push(q);
  const geo = mergeGeometries(parts);
  geo.boundingSphere = new THREE.Sphere(new V3(0, 1, 1.5), 4);
  const uniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, map: { value: honkTex() }, uAnchor: { value: new V3(0, 1.05, .9) } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    vertexShader: `attribute float aRing; uniform float uTime; uniform vec3 uAnchor; varying vec2 vUv; varying float vA;
      void main(){
        vUv = uv;
        float base = uTime / 1.2;
        if (aRing < 3.5) {
          float ph = fract(base - aRing * 0.25);
          float s = mix(0.35, 2.6, ph);
          vec3 p = position * vec3(s, s, s);
          p.y += ph * 0.35;
          vA = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.5, 1.0, ph));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        } else {
          float ph = fract(base);
          float pop = ph < 0.14 ? ph / 0.14 * 1.22 : mix(1.22, 1.0, smoothstep(0.14, 0.32, ph));
          vA = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.72, 0.96, ph));
          vec4 mv = modelViewMatrix * vec4(uAnchor + vec3(0.0, ph * 0.25, 0.0), 1.0);
          mv.xy += position.xy * pop;
          gl_Position = projectionMatrix * mv;
        }
      }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 uColor; varying vec2 vUv; varying float vA;
      void main(){
        vec4 t = texture2D(map, vUv);
        float a = t.a * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * t.rgb, a);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5; mesh.castShadow = false; mesh.receiveShadow = false;
  group.add(mesh);
  return {
    group,
    /** Set the loop time (seconds); waves repeat every 1.2 s. */
    update(t) { uniforms.uTime.value = t; },
  };
}

/* =====================================================================================
   Demo
   ===================================================================================== */
function mannequin() {
  const k = new Kit();
  k.add(rbox(.36, .55, .22, .08), { s: 'plastic', c: 0xff7a14, m: M(0, 1.25, 0) });
  k.add(sph(.11, 14, 10), { s: 'plastic', c: 0xc58a64, m: M(0, 1.62, 0) });
  k.add(sph(.125, 14, 8, 0, TAU, 0, PI / 2), { s: 'gloss', c: 0xf4f4f0, m: M(0, 1.66, 0) });
  for (const sx of [-1, 1]) {
    rod(k, new V3(sx * .1, .95, 0), new V3(sx * .11, .05, .02), .07, { s: 'plastic', c: 0x2a3550 });
    rod(k, new V3(sx * .2, 1.48, 0), new V3(sx * .16, 1.0, .3), .05, { s: 'plastic', c: 0xff7a14 });
  }
  rod(k, new V3(0, 1.05, .38), new V3(0, .02, .55), .04, { s: 'steel', c: 0x333333 });
  return k.mesh(atlasMat());
}
/**
 * Preview showcase: a pole set to green with its SmartCross camera, edge box, camera post,
 * a road-works site (with a stand-in worker mannequin) with dust and honk waves.
 * @returns {{group: THREE.Group, update: (t: number, dt: number) => void}}
 */
export function demo() {
  const group = new THREE.Group();
  const pole = createSignalPole({ armLength: 9 });
  pole.setState('green'); pole.setPedState('red');
  group.add(pole.group);
  const edge = createEdgeBox(); edge.group.position.set(2.4, 0, .9); edge.group.rotation.y = -.3; group.add(edge.group);
  const post = createCameraPost(); post.group.position.set(5.5, 0, 3); post.group.rotation.y = -.4; group.add(post.group);
  const works = createRoadWorks({ length: 26, width: 5 }); works.group.position.set(8, 0, -14); group.add(works.group);
  works.workerSpot.add(mannequin());
  const dust = createDust(); group.add(dust.group);
  const honk = createHonkWaves(); honk.group.position.set(-6, 1.45, 9); group.add(honk.group);
  let clock = 0; const tip = new V3();
  return {
    group,
    update(t, dt) {
      pole.update(t, dt); post.smartCam.update(t, dt); works.update(t, dt); honk.update(t);
      dust.update(dt);
      clock += dt;
      if (clock > .09) { clock = 0; works.dustOrigin.getWorldPosition(tip); dust.burst(tip, 2); }
    },
  };
}
