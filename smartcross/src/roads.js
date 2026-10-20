// roads.js — procedural road network + street props for the SmartCross presentation (Three.js r169).
// Units: metres, Y up, North = −Z. Road surface y = 0.01, markings 0.012, sidewalk/curb top 0.15, paths 0.03.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ============================== constants ============================== */
const Y_ROAD = 0.01, Y_MARK = 0.012, Y_GRATE = 0.013, Y_WALK = 0.15, Y_PATH = 0.03;
const CURB_W = 0.25;          // curb stone width (top band)
const EDGE_W = 0.1;           // garden edging on the lawn side of sidewalks
const EDGE_Y = 0.17;          // edging top (2 cm proud of the paving)
const CORNER_R = 4;           // junction corner curb radius
const DASH = 3, DASH_P = 9;   // lane dash length / period (m)
const LINE_W = 0.12;          // lane line width

/* ============================== utils ============================== */
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash2(ix, iz, seed = 0) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z, cell, seed = 0) {
  const fx = x / cell, fz = z / cell, ix = Math.floor(fx), iz = Math.floor(fz);
  let tx = fx - ix, tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Subtracts the intervals `cuts` from [a, b]; returns remaining intervals longer than 1 cm. */
function subtractIntervals(a, b, cuts) {
  let res = [[a, b]];
  for (const [c0, c1] of cuts) {
    const next = [];
    for (const [x0, x1] of res) {
      if (c1 <= x0 || c0 >= x1) { next.push([x0, x1]); continue; }
      if (c0 > x0) next.push([x0, c0]);
      if (c1 < x1) next.push([c1, x1]);
    }
    res = next;
  }
  return res.filter(([x0, x1]) => x1 - x0 > 0.01);
}

/* ============================== geometry builder ============================== */
// Accumulates position / normal / uv / color + index; winding is auto-fixed to match the intended normal.
class GB {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
  v(x, y, z, nx, ny, nz, u, w, c = 1) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, w);
    if (typeof c === 'number') this.col.push(c, c, c); else this.col.push(c[0], c[1], c[2]);
    return this.n++;
  }
  t(a, b, c, nx, ny, nz) {
    const P = this.pos;
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const e1x = P[3 * b] - ax, e1y = P[3 * b + 1] - ay, e1z = P[3 * b + 2] - az;
    const e2x = P[3 * c] - ax, e2y = P[3 * c + 1] - ay, e2z = P[3 * c + 2] - az;
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cy * ny + cz * nz < 0) this.idx.push(a, c, b); else this.idx.push(a, b, c);
  }
  q(a, b, c, d, nx, ny, nz) { this.t(a, b, c, nx, ny, nz); this.t(a, c, d, nx, ny, nz); }
  /** Append any BufferGeometry transformed by matrix m. uvMode 'tri' = metric triplanar UVs (scale su, sv). */
  addGeo(geo, m, { uvMode = null, su = 1, sv = 1, color = 1 } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    const base = this.n;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      if (nrm) nv.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); else nv.set(0, 1, 0);
      let u = 0, w = 0;
      if (uvMode === 'tri') {
        const ax = Math.abs(nv.x), ay = Math.abs(nv.y), az = Math.abs(nv.z);
        if (ay >= ax && ay >= az) { u = v.x * su; w = v.z * su; }
        else if (ax >= az) { u = v.z * su; w = v.y * sv; }
        else { u = v.x * su; w = v.y * sv; }
      } else if (uv) { u = uv.getX(i); w = uv.getY(i); }
      this.v(v.x, v.y, v.z, nv.x, nv.y, nv.z, u, w, color);
    }
    for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    if (g !== geo) g.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  mesh(material, { cast = true, receive = true, name = '' } = {}) {
    if (!this.n) return null;
    const m = new THREE.Mesh(this.geometry(), material);
    m.castShadow = cast; m.receiveShadow = receive; m.name = name;
    return m;
  }
}

/** Horizontal polygon (points [[x,z],…]) at height y, normal up; uvf(x,z) → [u,v]; colf(x,z) → colour. */
function hpoly(gb, pts, y, uvf, colf) {
  const clean = [];
  for (const p of pts) {
    const l = clean[clean.length - 1];
    if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-5) clean.push(p);
  }
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-5) clean.pop();
  if (clean.length < 3) return;
  const tris = THREE.ShapeUtils.triangulateShape(clean.map(p => new THREE.Vector2(p[0], p[1])), []);
  const base = gb.n;
  for (const [x, z] of clean) { const [u, w] = uvf(x, z); gb.v(x, y, z, 0, 1, 0, u, w, colf ? colf(x, z) : 1); }
  for (const [a, b, c] of tris) gb.t(base + a, base + b, base + c, 0, 1, 0);
}

/** Sweeps a 2D profile [(o, y), …] along a polyline (world xz) with per-vertex offset directions N. */
function sweep(gb, pts, N, profile, { u0 = 0, uScale = 1, vScale = 1, color = 1 } = {}) {
  let acc = u0;
  const along = [acc];
  for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); along.push(acc); }
  let vacc = 0;
  for (let k = 0; k < profile.length - 1; k++) {
    const [o0, y0] = profile[k], [o1, y1] = profile[k + 1];
    const dO = o1 - o0, dY = y1 - y0, len = Math.hypot(dO, dY) || 1;
    const pnO = -dY / len, pnY = dO / len;      // profile-plane normal
    const row0 = [], row1 = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [nx, nz] = N[i];
      const nxw = nx * pnO, nyw = pnY, nzw = nz * pnO;
      row0.push(gb.v(x + nx * o0, y0, z + nz * o0, nxw, nyw, nzw, along[i] * uScale, vacc * vScale, color));
      row1.push(gb.v(x + nx * o1, y1, z + nz * o1, nxw, nyw, nzw, along[i] * uScale, (vacc + len) * vScale, color));
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const nx = (N[i][0] + N[i + 1][0]) * 0.5 * pnO, nz = (N[i][1] + N[i + 1][1]) * 0.5 * pnO;
      gb.q(row0[i], row0[i + 1], row1[i + 1], row1[i], nx, pnY, nz);
    }
    vacc += len;
  }
}
// Curb profile: road face, small chamfer, top band. o = offset toward the sidewalk side.
const PROF_CURB = [[0, 0], [0, 0.13], [0.025, Y_WALK], [CURB_W, Y_WALK]];
const PROF_CURB_SOLO = [[0, 0], [0, 0.13], [0.025, Y_WALK], [CURB_W - 0.025, Y_WALK], [CURB_W, 0.13], [CURB_W, 0]];
const PROF_EDGE = [[-EDGE_W, Y_WALK], [-EDGE_W, EDGE_Y], [0, EDGE_Y], [0, 0]];
const PROF_MEDIAN = [[0, 0], [0, 0.13], [0.025, Y_WALK], [CURB_W, Y_WALK], [CURB_W, 0.12]];

/** Vertical quad from (x0,z0) to (x1,z1), y0..y1, facing outward normal (nx,nz). */
function vquad(gb, x0, z0, x1, z1, y0, y1, nx, nz, u0 = 0, color = 1) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  const a = gb.v(x0, y0, z0, nx, 0, nz, u0, y0, color), b = gb.v(x1, y0, z1, nx, 0, nz, u0 + L, y0, color);
  const c = gb.v(x1, y1, z1, nx, 0, nz, u0 + L, y1, color), d = gb.v(x0, y1, z0, nx, 0, nz, u0, y1, color);
  gb.q(a, b, c, d, nx, 0, nz);
}

/* ============================== textures ============================== */
const TEX = {};
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
function heightToNormal(h, S, strength) {
  const c = makeCanvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = h[y * S + (x - 1 + S) % S], r = h[y * S + (x + 1) % S];
    const up = h[((y - 1 + S) % S) * S + x], dn = h[((y + 1) % S) * S + x];
    let nx = (l - r) * strength, ny = (dn - up) * strength, nz = 1;
    const il = 1 / Math.hypot(nx, ny, nz); nx *= il; ny *= il; nz *= il;
    const i = 4 * (y * S + x);
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, false);
}
function noiseFill(ctx, S, rnd, base, amp, extra) {
  const img = ctx.createImageData(S, S), d = img.data;
  for (let i = 0; i < S * S; i++) {
    let v = (rnd() - 0.5) * amp;
    if (extra) v += extra(rnd);
    d[4 * i] = clamp(base[0] + v, 0, 255); d[4 * i + 1] = clamp(base[1] + v, 0, 255); d[4 * i + 2] = clamp(base[2] + v, 0, 255); d[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function blobs(ctx, S, rnd, n, rMin, rMax, colors, alpha) {
  for (let k = 0; k < n; k++) {
    const x = rnd() * S, y = rnd() * S, r = rMin + rnd() * (rMax - rMin), col = colors[(rnd() * colors.length) | 0];
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgba(${col},${alpha})`); g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g; ctx.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
}
function texAsphalt(fresh) {
  const key = fresh ? 'asphaltFresh' : 'asphalt';
  if (TEX[key]) return TEX[key];
  const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(fresh ? 11 : 7);
  if (fresh) noiseFill(ctx, S, rnd, [44, 46, 49], 12, r => (r() < 0.012 ? 14 * r() : 0));
  else noiseFill(ctx, S, rnd, [78, 79, 81], 26, r => { const q = r(); return q < 0.035 ? 38 * r() : q > 0.985 ? -26 : 0; });
  blobs(ctx, S, rnd, fresh ? 20 : 46, 20, 90, fresh ? ['20,20,22', '70,70,72'] : ['30,30,32', '130,128,124', '60,58,55'], fresh ? 0.08 : 0.13);
  if (!fresh) {   // hairline cracks and a sealed crack
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      let x = 40 + rnd() * (S - 80), y = 40 + rnd() * (S - 80), a = rnd() * Math.PI * 2;
      ctx.strokeStyle = 'rgba(28,28,30,0.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 14; s++) { a += (rnd() - 0.5) * 0.9; x = clamp(x + Math.cos(a) * 9, 8, S - 8); y = clamp(y + Math.sin(a) * 9, 8, S - 8); ctx.lineTo(x, y); }
      ctx.stroke();
    }
  }
  return (TEX[key] = toTex(c));
}
function texMarking() {
  if (TEX.mark) return TEX.mark;
  const S = 256, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(5);
  noiseFill(ctx, S, rnd, [238, 238, 233], 14, r => (r() < 0.05 ? -60 * r() : 0));
  blobs(ctx, S, rnd, 16, 6, 26, ['120,120,118'], 0.22);
  return (TEX.mark = toTex(c));
}
/** Running-bond concrete pavers (2.56 m tile): returns { map, normal }. */
function texPaving() {
  if (TEX.paving) return TEX.paving;
  const S = 512, PW = 64, PH = 32, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(21);
  const h = new Float32Array(S * S);
  const img = ctx.createImageData(S, S), d = img.data;
  const cols = {};
  const colOf = (row, col) => {
    const k = row * 100 + col;
    if (!cols[k]) {
      const q = rnd(), v = (rnd() - 0.5) * 16;
      cols[k] = q < 0.045 ? [146 + v, 120 + v, 108 + v] : q < 0.12 ? [126 + v, 123 + v, 118 + v] : [156 + v, 152 + v, 145 + v];
    }
    return cols[k];
  };
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / PH), yr = y - row * PH, off = (row % 2) * PW / 2;
    for (let x = 0; x < S; x++) {
      const xs = (x - off + S) % S, col = Math.floor(xs / PW), xr = xs - col * PW;
      const e = Math.min(xr, PW - 1 - xr, yr, PH - 1 - yr);
      const grout = e < 1.2;
      const hh = grout ? 0 : Math.min(1, (e - 0.5) / 3.5);
      h[y * S + x] = hh;
      const base = grout ? [96, 93, 88] : colOf(row, col);
      const n = (rnd() - 0.5) * 18 - (1 - hh) * 14;
      const i = 4 * (y * S + x);
      d[i] = clamp(base[0] + n, 0, 255); d[i + 1] = clamp(base[1] + n, 0, 255); d[i + 2] = clamp(base[2] + n, 0, 255); d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  blobs(ctx, S, rnd, 18, 20, 70, ['90,85,78', '200,196,188'], 0.08);
  return (TEX.paving = { map: toTex(c), normal: heightToNormal(h, S, 1.6) });
}
/** Square flagstone path tiles (1.6 m tile). */
function texPath() {
  if (TEX.path) return TEX.path;
  const S = 512, T = 128, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(33);
  const h = new Float32Array(S * S), img = ctx.createImageData(S, S), d = img.data, cols = {};
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = Math.floor(x / T), cy = Math.floor(y / T), xr = x - cx * T, yr = y - cy * T;
    const e = Math.min(xr, T - 1 - xr, yr, T - 1 - yr), grout = e < 2;
    const k = cy * 8 + cx;
    if (!cols[k]) { const v = (rnd() - 0.5) * 14; cols[k] = [172 + v, 163 + v, 147 + v]; }
    const hh = grout ? 0 : Math.min(1, (e - 1.5) / 5);
    h[y * S + x] = hh;
    const base = grout ? [120, 114, 102] : cols[k], n = (rnd() - 0.5) * 16 - (1 - hh) * 12, i = 4 * (y * S + x);
    d[i] = clamp(base[0] + n, 0, 255); d[i + 1] = clamp(base[1] + n, 0, 255); d[i + 2] = clamp(base[2] + n, 0, 255); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  blobs(ctx, S, rnd, 14, 20, 60, ['110,104,92'], 0.1);
  return (TEX.path = { map: toTex(c), normal: heightToNormal(h, S, 1.2) });
}
/** Concrete curb stone with a joint every metre (u = metres along, v = metres / 0.5). */
function texCurb() {
  if (TEX.curb) return TEX.curb;
  const S = 256, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(44);
  noiseFill(ctx, S, rnd, [178, 175, 168], 18, r => (r() < 0.02 ? -40 * r() : 0));
  blobs(ctx, S, rnd, 10, 10, 50, ['120,116,108', '230,228,222'], 0.12);
  ctx.fillStyle = 'rgba(60,58,54,0.85)'; ctx.fillRect(0, 0, 3, S);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(3, 0, 1, S);
  return (TEX.curb = toTex(c));
}
function texGrass() {
  if (TEX.grass) return TEX.grass;
  const S = 256, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(55);
  noiseFill(ctx, S, rnd, [78, 98, 50], 46);
  blobs(ctx, S, rnd, 26, 10, 40, ['58,78,36', '120,122,66', '104,88,60'], 0.35);
  return (TEX.grass = toTex(c));
}
function texGround() {
  if (TEX.ground) return TEX.ground;
  const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(66);
  noiseFill(ctx, S, rnd, [150, 145, 100], 34, r => (r() < 0.04 ? -30 * r() : 0));
  blobs(ctx, S, rnd, 90, 14, 70, ['118,128,74', '170,152,110', '128,112,82', '160,160,104'], 0.2);
  ctx.globalAlpha = 0.22;
  for (let k = 0; k < 1400; k++) {   // dry grass tufts, random directions
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 2 + rnd() * 4;
    ctx.strokeStyle = rnd() < 0.5 ? '#c8bd84' : '#6f7744';
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return (TEX.ground = toTex(c));
}
function texDirt() {
  if (TEX.dirt) return TEX.dirt;
  const S = 256, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(77);
  noiseFill(ctx, S, rnd, [118, 98, 74], 40, r => (r() < 0.06 ? 50 * r() : 0));
  blobs(ctx, S, rnd, 20, 8, 30, ['80,64,46', '150,135,115'], 0.3);
  return (TEX.dirt = toTex(c));
}
/** Cast-iron covers: left half = round manhole, right half = storm-drain grate. */
function texGrate() {
  if (TEX.grate) return TEX.grate;
  const c = makeCanvas(256, 128), ctx = c.getContext('2d');
  ctx.fillStyle = '#4a4744'; ctx.fillRect(0, 0, 256, 128);
  // manhole
  ctx.save(); ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fillStyle = '#3c3a37'; ctx.fill();
  ctx.lineWidth = 5; ctx.strokeStyle = '#5c5853'; ctx.stroke(); ctx.clip();
  ctx.strokeStyle = '#2a2826'; ctx.lineWidth = 2;
  for (let i = -64; i <= 64; i += 9) { ctx.beginPath(); ctx.moveTo(64 + i, 0); ctx.lineTo(64 + i, 128); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, 64 + i); ctx.lineTo(128, 64 + i); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(64, 64, 22, 0, Math.PI * 2); ctx.fillStyle = '#4b4743'; ctx.fill();
  ctx.restore();
  // grate
  ctx.fillStyle = '#3a3836'; ctx.fillRect(132, 8, 120, 112);
  ctx.fillStyle = '#121212';
  for (let k = 0; k < 9; k++) ctx.fillRect(140 + k * 12.6, 16, 6, 96);
  ctx.strokeStyle = '#5b5751'; ctx.lineWidth = 4; ctx.strokeRect(132, 8, 120, 112);
  return (TEX.grate = toTex(c));
}
/** Red-brown brick (u = m / 1.0, v = m / 0.6): 4 bricks per row, 8 courses. */
function texBrick() {
  if (TEX.brick) return TEX.brick;
  const S = 512, BW = 128, BH = 64, c = makeCanvas(S, S), ctx = c.getContext('2d'), rnd = mulberry32(88);
  const h = new Float32Array(S * S), img = ctx.createImageData(S, S), d = img.data, cols = {};
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / BH), yr = y - row * BH, off = (row % 2) * BW / 2;
    for (let x = 0; x < S; x++) {
      const xs = (x - off + S) % S, col = Math.floor(xs / BW), xr = xs - col * BW;
      const e = Math.min(xr, BW - 1 - xr, yr, BH - 1 - yr), mortar = e < 5;
      const k = row * 10 + col;
      if (!cols[k]) { const q = rnd(), v = (rnd() - 0.5) * 22; cols[k] = q < 0.15 ? [118 + v, 52 + v * 0.5, 36] : q < 0.25 ? [168 + v, 92 + v, 64] : [146 + v, 66 + v * 0.6, 44 + v * 0.3]; }
      const hh = mortar ? 0.1 : Math.min(1, (e - 4) / 4);
      h[y * S + x] = hh;
      const base = mortar ? [196, 188, 172] : cols[k], n = (rnd() - 0.5) * 22, i = 4 * (y * S + x);
      d[i] = clamp(base[0] + n, 0, 255); d[i + 1] = clamp(base[1] + n, 0, 255); d[i + 2] = clamp(base[2] + n, 0, 255); d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return (TEX.brick = { map: toTex(c), normal: heightToNormal(h, S, 2.2) });
}
function texWood() {
  if (TEX.wood) return TEX.wood;
  const c = makeCanvas(256, 64), ctx = c.getContext('2d'), rnd = mulberry32(99);
  ctx.fillStyle = '#9a6a3f'; ctx.fillRect(0, 0, 256, 64);
  for (let k = 0; k < 40; k++) {
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(90,55,28,0.35)' : 'rgba(190,140,90,0.25)';
    ctx.lineWidth = 1 + rnd() * 2; const y = rnd() * 64;
    ctx.beginPath(); ctx.moveTo(0, y); for (let x = 0; x <= 256; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.03 + k) * 2); ctx.stroke();
  }
  return (TEX.wood = toTex(c));
}
function fitText(ctx, text, x, y, maxW, px, weight = 'bold') {
  let size = px;
  do { ctx.font = `${weight} ${size}px "DejaVu Sans", Arial, sans-serif`; size -= 1; } while (ctx.measureText(text).width > maxW && size > 8);
  ctx.fillText(text, x, y);
}
/** Bus-stop sign atlas (512²): fascia band, route sign, route numbers, advertising poster. */
function texSigns() {
  if (TEX.signs) return TEX.signs;
  const c = makeCanvas(512, 512), ctx = c.getContext('2d');
  // fascia 0..64
  ctx.fillStyle = '#1f4f9c'; ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 40px "DejaVu Sans", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('ОСТАНОВКА', 256, 34);
  ctx.fillStyle = '#ffd34d'; ctx.fillRect(0, 58, 512, 6);
  // route sign 0..256 x 64..320
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 64, 256, 256);
  ctx.fillStyle = '#1f5fbf'; ctx.fillRect(10, 74, 236, 236);
  ctx.fillStyle = '#ffffff';
  const bx = 48, by = 120;   // bus pictogram
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, 160, 110, 16) : ctx.rect(bx, by, 160, 110); ctx.fill();
  ctx.fillStyle = '#1f5fbf';
  ctx.fillRect(bx + 14, by + 14, 132, 46);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx + 78, by + 14, 4, 46);
  ctx.fillStyle = '#1f5fbf'; ctx.fillRect(bx + 18, by + 78, 26, 12); ctx.fillRect(bx + 116, by + 78, 26, 12);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx + 18, by + 110, 30, 22); ctx.fillRect(bx + 112, by + 110, 30, 22);
  ctx.font = 'bold 34px "DejaVu Sans", Arial, sans-serif'; ctx.fillText('A', 128, 280);
  // route plate 0..256 x 320..448
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 320, 256, 128);
  ctx.fillStyle = '#1f5fbf'; ctx.fillRect(6, 326, 244, 116);
  ctx.fillStyle = '#ffffff';
  fitText(ctx, '7  48  110', 128, 362, 220, 38);
  fitText(ctx, '263   5   38', 128, 410, 220, 34);
  // poster 256..512 x 64..512
  const g = ctx.createLinearGradient(256, 64, 512, 512);
  g.addColorStop(0, '#2fa36b'); g.addColorStop(0.55, '#7fd0a0'); g.addColorStop(1, '#f2e9b8');
  ctx.fillStyle = g; ctx.fillRect(256, 64, 256, 448);
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.beginPath(); ctx.arc(384, 230, 80, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a8a57'; ctx.beginPath(); ctx.ellipse(384, 230, 34, 60, 0.6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(350, 280); ctx.lineTo(414, 185); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px "DejaVu Sans", Arial, sans-serif';
  ctx.fillText('ЖАШЫЛ', 384, 370); ctx.fillText('ШААР', 384, 412);
  ctx.fillStyle = '#1d4d33'; ctx.font = '22px "DejaVu Sans", Arial, sans-serif'; ctx.fillText('Зелёный Бишкек', 384, 462);
  return (TEX.signs = toTex(c));
}

/* ============================== materials (module cache) ============================== */
const MAT = {};
function mat(key, make) { return MAT[key] || (MAT[key] = make()); }
const std = p => new THREE.MeshStandardMaterial(p);
const M = {
  asphalt: () => mat('asphalt', () => std({ map: texAsphalt(false), vertexColors: true, roughness: 0.93, metalness: 0 })),
  asphaltFresh: () => mat('asphaltFresh', () => std({ map: texAsphalt(true), vertexColors: true, roughness: 0.78, metalness: 0 })),
  marking: () => mat('marking', () => std({ map: texMarking(), roughness: 0.62, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  grate: () => mat('grate', () => std({ map: texGrate(), roughness: 0.55, metalness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 })),
  curb: () => mat('curb', () => std({ map: texCurb(), roughness: 0.86 })),
  paving: () => mat('paving', () => { const t = texPaving(); return std({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.9 }); }),
  median: () => mat('median', () => std({ map: texGrass(), color: 0xd8dcc8, roughness: 1 })),
  path: () => mat('path', () => { const t = texPath(); return std({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }); }),
  ground: () => mat('ground', () => std({ map: texGround(), vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 })),
  pole: () => mat('pole', () => std({ color: 0x9aa0a4, metalness: 0.65, roughness: 0.4 })),
  lens: () => mat('lens', () => std({ color: 0xf2f0e8, emissive: 0xfff0cc, emissiveIntensity: 0.25, roughness: 0.25, metalness: 0 })),
  concrete: () => mat('concrete', () => std({ map: texCurb(), color: 0xd8d4cc, roughness: 0.9 })),
  pad: () => mat('pad', () => std({ map: texCurb(), color: 0xc4c0b8, roughness: 0.9 })),
  wood: () => mat('wood', () => std({ map: texWood(), roughness: 0.72 })),
  iron: () => mat('iron', () => std({ color: 0x2b2e30, metalness: 0.55, roughness: 0.5 })),
  steel: () => mat('steel', () => std({ color: 0x3d4247, metalness: 0.6, roughness: 0.38 })),
  roof: () => mat('roof', () => std({ color: 0xe8eaec, metalness: 0.3, roughness: 0.45 })),
  glass: () => mat('glass', () => new THREE.MeshPhysicalMaterial({ color: 0x8fa7b2, metalness: 0.15, roughness: 0.08, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.8 })),
  signs: () => mat('signs', () => std({ map: texSigns(), emissiveMap: texSigns(), emissive: 0xffffff, emissiveIntensity: 0.28, roughness: 0.5 })),
  bin: () => mat('bin', () => std({ color: 0x2f5d3a, metalness: 0.4, roughness: 0.5 })),
  brick: () => mat('brick', () => { const t = texBrick(); return std({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(1, 1), roughness: 0.88 }); }),
  stone: () => mat('stone', () => std({ map: texCurb(), color: 0xeee2cc, roughness: 0.85 })),
  fenceMetal: () => mat('fenceMetal', () => std({ color: 0x1d2622, metalness: 0.55, roughness: 0.42 })),
  dirt: () => mat('dirt', () => std({ map: texDirt(), roughness: 1 })),
};

/* ============================== road frames ============================== */
/** Local frame of a straight strip: s along (ux,uz), l lateral along n = right-hand side of travel in +u. */
function frame(x1, z1, ux, uz) {
  const nx = -uz, nz = ux;
  const cs = (ux < -1e-6 || (Math.abs(ux) <= 1e-6 && uz < 0)) ? -1 : 1;   // canonical sign
  const w0 = cs * (x1 * ux + z1 * uz);
  return {
    x1, z1, ux, uz, nx, nz, cs, w0,
    P: (s, l) => [x1 + ux * s + nx * l, z1 + uz * s + nz * l],
    along: (x, z) => cs * (x * ux + z * uz),          // world-canonical along coordinate
    across: (x, z) => cs * (x * nx + z * nz),
    wAt: s => w0 + cs * s,                             // world-canonical along of strip s
    sAt: w => (w - w0) * cs,
  };
}

/** Lateral asphalt wear multiplier for distance d (≥ 0) from the centre/median edge. */
function wearProfile(d, med, lanes, lw) {
  const x = d - med;
  if (x < 0) return 0;
  const hw = lanes * lw;
  if (x > hw - 0.5) return 0.05 * (x - (hw - 0.5)) / 0.5;            // dusty gutter
  const lane = Math.min(lanes - 1, Math.floor(x / lw)), c = (lane + 0.5) * lw, o = Math.abs(x - c);
  if (o < 0.45) return -0.09 * (1 - o / 0.45);                        // oily lane centre
  if (o < 1.25) return 0.035 * (1 - Math.abs(o - 0.85) / 0.4);        // polished wheel paths
  return 0;
}
function asphaltColor(x, z, wear, fresh) {
  const n = fresh ? 0.97 + 0.05 * vnoise(x, z, 30, 9) : 0.9 + 0.17 * vnoise(x, z, 26, 7) + 0.06 * (vnoise(x, z, 7, 3) - 0.5);
  const v = clamp(n * (1 + wear), 0.6, 1.3);
  return [v, v, v * 1.01];
}

/* ============================== strip builders ============================== */
function buildStripAsphalt(B, st) {
  const F = st.F, gb = st.fresh ? B.asphaltFresh : B.asphalt;
  const lats = new Set();
  const half = [st.med];
  for (let k = 0; k < st.lanes; k++) { const c = st.med + (k + 0.5) * st.lw; half.push(c - 0.85, c - 0.45, c, c + 0.45, c + 0.85, st.med + (k + 1) * st.lw); }
  half.push(st.hw - 0.5, st.hw);
  for (const d of half) { if (d >= st.med - 1e-6 && d <= st.hw + 1e-6) { lats.add(+d.toFixed(4)); lats.add(+(-d).toFixed(4)); } }
  let L = [...lats].sort((a, b) => a - b);
  if (st.med > 0) L = L.filter(l => Math.abs(l) >= st.med - 1e-6);
  // along subdivisions every ~12 m, plus fade-in near a junction core
  const ss = new Set([st.s0, st.s1]);
  for (let s = Math.ceil(st.s0 / 12) * 12; s < st.s1; s += 12) ss.add(s);
  if (st.kind === 'arm') { ss.add(Math.min(st.s1, st.s0 + 4)); ss.add(Math.min(st.s1, st.s0 + 14)); }
  const S = [...ss].filter(s => s >= st.s0 && s <= st.s1).sort((a, b) => a - b);
  const fade = s => st.fresh ? 0 : st.kind === 'arm' ? clamp((s - st.s0 - 4) / 10, 0, 1) : 1;
  const bands = st.med > 0 ? [L.filter(l => l < 0), L.filter(l => l > 0)] : [L];
  for (const band of bands) {
    const grid = [];
    for (const s of S) {
      const row = [];
      for (const l of band) {
        const [x, z] = F.P(s, l);
        const w = wearProfile(Math.abs(l), st.med, st.lanes, st.lw) * fade(s);
        row.push(gb.v(x, Y_ROAD, z, 0, 1, 0, x / 6.5, z / 6.5, asphaltColor(x, z, w, st.fresh)));
      }
      grid.push(row);
    }
    for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < band.length - 1; j++)
      gb.q(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1], 0, 1, 0);
  }
}

function buildStripSides(B, st) {
  const F = st.F;
  const pavUV = (x, z) => [F.along(x, z) / 2.56, F.across(x, z) / 2.56];
  for (const sg of [1, -1]) {
    const intervals = subtractIntervals(st.s0, st.s1, st.cuts[sg]);
    const Nn = [F.nx * sg, F.nz * sg];
    for (const [a, b] of intervals) {
      const p0 = F.P(a, sg * st.hw), p1 = F.P(b, sg * st.hw);
      const u0 = Math.min(F.wAt(a), F.wAt(b));
      const pts = F.cs > 0 === (a < b) ? [p0, p1] : [p1, p0];
      const prof = st.sw > CURB_W + 0.05 ? PROF_CURB : PROF_CURB_SOLO;
      sweep(B.curb, pts, [Nn, Nn], prof, { u0, vScale: 2 });
      if (st.sw > CURB_W + 0.05) {
        const lo = sg * (st.hw + CURB_W), hi = sg * (st.hw + st.sw);
        hpoly(B.paving, [F.P(a, lo), F.P(b, lo), F.P(b, hi), F.P(a, hi)], Y_WALK, pavUV);
        const e0 = F.P(a, hi), e1 = F.P(b, hi);
        sweep(B.curb, F.cs > 0 === (a < b) ? [e0, e1] : [e1, e0], [Nn, Nn], PROF_EDGE, { u0, uScale: 2, vScale: 2 });
      }
    }
    // end caps (only at real, unjoined strip ends)
    for (const [s, dir, isEnd] of [[st.s0, -1, 0], [st.s1, 1, 1]]) {
      if (st.joined[isEnd] || (st.kind === 'arm' && !isEnd)) continue;
      if (!intervals.some(([a, b]) => Math.abs(a - s) < 1e-6 || Math.abs(b - s) < 1e-6)) continue;
      const out = Math.max(st.sw, CURB_W);
      const [x0, z0] = F.P(s, sg * st.hw), [x1, z1] = F.P(s, sg * (st.hw + out));
      vquad(B.curb, x0, z0, x1, z1, 0, Y_WALK, F.ux * dir, F.uz * dir);
    }
  }
  if (st.med > 0) {
    const m = st.med;
    for (const sg of [1, -1]) {
      const Nn = [-F.nx * sg, -F.nz * sg];
      const p0 = F.P(st.s0, sg * m), p1 = F.P(st.s1, sg * m);
      sweep(B.curb, [p0, p1], [Nn, Nn], PROF_MEDIAN, { u0: F.wAt(st.s0) * F.cs, vScale: 2 });
    }
    const gi = m - CURB_W;
    hpoly(B.median, [F.P(st.s0, -gi), F.P(st.s1, -gi), F.P(st.s1, gi), F.P(st.s0, gi)], 0.12, (x, z) => [F.along(x, z) / 3, F.across(x, z) / 3]);
    for (const [s, dir] of [[st.s0, -1], [st.s1, 1]]) {
      const [x0, z0] = F.P(s, -m), [x1, z1] = F.P(s, m);
      vquad(B.curb, x0, z0, x1, z1, 0, Y_WALK, F.ux * dir, F.uz * dir);
    }
  }
}

/* ---------------- markings ---------------- */
function markRect(gb, F, s0, s1, l0, l1) {
  if (s1 - s0 < 0.02 || l1 - l0 < 0.01) return;
  const pts = [F.P(s0, l0), F.P(s1, l0), F.P(s1, l1), F.P(s0, l1)];
  const base = gb.n;
  for (const [x, z] of pts) gb.v(x, Y_MARK, z, 0, 1, 0, x / 2.2, z / 2.2);
  gb.q(base, base + 1, base + 2, base + 3, 0, 1, 0);
}
function markPoly(gb, ptsXZ) { hpoly(gb, ptsXZ, Y_MARK, (x, z) => [x / 2.2, z / 2.2]); }
/** Dashed line at lateral l between s0..s1 with world-anchored phase (seamless across joined strips). */
function markDashed(gb, F, l, s0, s1, w = LINE_W) {
  if (s1 <= s0) return;
  const wa = F.wAt(s0), wb = F.wAt(s1), lo = Math.min(wa, wb), hi = Math.max(wa, wb);
  for (let k = Math.floor((lo - DASH) / DASH_P); k * DASH_P <= hi; k++) {
    const d0 = Math.max(lo, k * DASH_P), d1 = Math.min(hi, k * DASH_P + DASH);
    if (d1 - d0 < 0.25) continue;
    const sa = F.sAt(d0), sb = F.sAt(d1);
    markRect(gb, F, Math.min(sa, sb), Math.max(sa, sb), l - w / 2, l + w / 2);
  }
}
/** Lane arrow on the road: tail at strip s = sTail, pointing toward −u (dirSign −1) or +u (+1), lane centre lc. */
function markArrow(gb, F, sTail, lc, dirSign, kind) {
  // local (r, f): r to the traveller's right, f forward. world: s = sTail + dirSign*f ; l = lc + dirSign*r*(−1)…
  // travelling along dirSign*u, the traveller's right is −dirSign*n  → l = lc − dirSign * r
  const map = (r, f) => F.P(sTail + dirSign * f, lc - dirSign * r);
  const poly = pts => markPoly(gb, pts.map(([r, f]) => map(r, f)));
  const sw = 0.075;
  poly([[-sw, 0], [sw, 0], [sw, 3.5], [-sw, 3.5]]);
  poly([[-0.32, 3.4], [0.32, 3.4], [0, 5]]);
  for (const side of kind === 'SL' ? [-1] : kind === 'SR' ? [1] : []) {
    // branch: band from shaft (f≈1.2) curving to the side, then a head
    const pts = [[0, 1.2], [side * 0.25, 1.8], [side * 0.6, 2.25], [side * 0.95, 2.45]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [r0, f0] = pts[i], [r1, f1] = pts[i + 1], dr = r1 - r0, df = f1 - f0, L = Math.hypot(dr, df), pr = -df / L * sw, pf = dr / L * sw;
      poly([[r0 + pr, f0 + pf], [r1 + pr, f1 + pf], [r1 - pr, f1 - pf], [r0 - pr, f0 - pf]]);
    }
    const [hr, hf] = pts[pts.length - 1];
    poly([[hr, hf - 0.3], [hr, hf + 0.3], [hr + side * 0.75, hf + 0.12]]);
  }
}

function buildStripMarkings(B, st) {
  const F = st.F, gb = B.mark, hw = st.hw, m = st.med;
  const isArm = st.kind === 'arm';
  const stop = isArm ? st.hwCarriage + 6.5 : 0;
  let c0 = isArm ? stop : st.s0 + (st.joined[0] ? 1.6 : 0);
  let c1 = st.s1 - (st.joined[1] ? 1.6 : 0);
  if (c1 <= c0) return;
  if (m === 0) {   // double solid centre line
    markRect(gb, F, c0, c1, 0.07, 0.07 + LINE_W);
    markRect(gb, F, c0, c1, -0.07 - LINE_W, -0.07);
  } else {         // solid edge lines along the median
    for (const sg of [1, -1]) markRect(gb, F, st.s0, st.s1, sg > 0 ? m + 0.3 : -m - 0.3 - LINE_W, sg > 0 ? m + 0.3 + LINE_W : -m - 0.3);
  }
  for (const sg of [1, -1]) {
    for (let k = 1; k < st.lanes; k++) {
      const l = sg * (m + k * st.lw);
      if (isArm && sg < 0) {        // approach lanes: solid before the stop line, then dashed
        const solidEnd = Math.min(c1, stop + 22);
        markRect(gb, F, stop + 0.2, solidEnd, l - LINE_W / 2, l + LINE_W / 2);
        markDashed(gb, F, l, solidEnd, c1);
      } else markDashed(gb, F, l, Math.max(c0, isArm ? stop : c0), c1);
    }
  }
  if (isArm) {
    // zebra crosswalk
    const z0 = st.hwCarriage + 1.5, z1 = st.hwCarriage + 5.5, span = 2 * (hw - 0.3), SW = 0.5, GAP = 0.6;
    const n = Math.floor((span + GAP) / (SW + GAP)), tot = n * SW + (n - 1) * GAP;
    for (let i = 0; i < n; i++) { const l0 = -tot / 2 + i * (SW + GAP); markRect(gb, F, z0, z1, l0, l0 + SW); }
    // stop line on the inbound half (−n side)
    markRect(gb, F, stop - 0.2, stop + 0.2, -hw + 0.05, -0.07 - LINE_W);
    // lane arrows on inbound lanes (pointing toward the junction centre)
    if (st.s1 > stop + 16) for (let k = 0; k < st.lanes; k++) {
      const lc = -(m + (k + 0.5) * st.lw);
      const kind = st.lanes === 1 ? 'S' : k === 0 ? 'SL' : k === st.lanes - 1 ? 'SR' : 'S';
      markArrow(gb, F, stop + 12, lc, -1, kind);
    }
  }
  // stop lines where a road T-joins another road
  if (st.joined[1]) markRect(gb, F, st.s1 - 1.6, st.s1 - 1.2, 0.07 + LINE_W, hw - 0.05);
  if (st.joined[0]) markRect(gb, F, st.s0 + 1.2, st.s0 + 1.6, -hw + 0.05, -0.07 - LINE_W);
  // cast-iron details: storm drains along curbs, manholes in lanes
  const g = B.grate;
  const wa = F.wAt(st.s0), wb = F.wAt(st.s1), lo = Math.min(wa, wb), hi = Math.max(wa, wb);
  for (let k = Math.ceil(lo / 31); k * 31 < hi; k++) {
    const s = F.sAt(k * 31);
    if (s < st.s0 + 1 || s > st.s1 - 1 || (isArm && s < stop + 3)) continue;
    for (const sg of [1, -1]) {
      if (st.cuts[sg].some(([a, b]) => s > a - 2 && s < b + 2)) continue;
      const l0 = sg * (hw - 0.05), l1 = sg * (hw - 0.5);
      grateRect(g, F, s - 0.45, s + 0.45, Math.min(l0, l1), Math.max(l0, l1), 0.5, 1);
    }
  }
  for (let k = Math.ceil(lo / 47); k * 47 < hi; k++) {
    const s = F.sAt(k * 47 + 13 * (hash2(k, 3, 5) - 0.5));
    if (s < st.s0 + 2 || s > st.s1 - 2 || (isArm && s < stop + 20)) continue;
    const lane = Math.floor(hash2(k, 9, 2) * st.lanes), sg = hash2(k, 1, 4) < 0.5 ? 1 : -1;
    const [x, z] = F.P(s, sg * (m + (lane + 0.5) * st.lw + 0.4));
    manhole(g, x, z);
  }
}
function grateRect(g, F, s0, s1, l0, l1, u0, u1) {
  const pts = [F.P(s0, l0), F.P(s1, l0), F.P(s1, l1), F.P(s0, l1)], uvs = [[u0, 0.06], [u0, 0.94], [u1, 0.94], [u1, 0.06]];
  const base = g.n;
  pts.forEach(([x, z], i) => g.v(x, Y_GRATE, z, 0, 1, 0, uvs[i][0] + (i === 0 || i === 3 ? 0.03 : -0.03) * 0, uvs[i][1]));
  g.q(base, base + 1, base + 2, base + 3, 0, 1, 0);
}
function manhole(g, x, z, r = 0.36) {
  const c = g.v(x, Y_GRATE, z, 0, 1, 0, 0.25, 0.5), base = g.n, N = 16;
  for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2; g.v(x + Math.cos(a) * r, Y_GRATE, z + Math.sin(a) * r, 0, 1, 0, 0.25 + Math.cos(a) * 0.235, 0.5 + Math.sin(a) * 0.47); }
  for (let i = 0; i < N; i++) g.t(c, base + i, base + (i + 1) % N, 0, 1, 0);
}

/* ---------------- corner quadrants (junction cores and T-joins) ---------------- */
// Quadrant-local coords (a, b) ≥ 0. The road running along a has its curb at b = cx; the road running along b has
// its curb at a = cz. Extents ea × eb. mode: 'concave' (both roads), 'x' (only the a-road), 'z', 'convex' (none).
function buildQuadrant(B, Q) {
  const { map, cz, cx, ea, eb, mode } = Q, W = CURB_W, R = CORNER_R;
  const mp = pts => pts.map(([a, b]) => map(a, b));
  const dirW = ([na, nb]) => { const o = map(0, 0), p = map(na, nb); return [p[0] - o[0], p[1] - o[1]]; };
  const asphaltGB = Q.fresh ? B.asphaltFresh : B.asphalt;
  const aCol = (x, z) => asphaltColor(x, z, 0, Q.fresh);
  const aUV = (x, z) => [x / 6.5, z / 6.5];
  const pUV = (x, z) => [x / 2.56, z / 2.56];
  let curb, curbN, asphalt, walk;
  const exposed = [];
  if (mode === 'concave') {
    const ca = cz + R, cb = cx + R, arc = [], arcN = [], arcO = [];
    for (let i = 0; i <= 12; i++) {
      const th = Math.PI + (i / 12) * Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
      arc.push([ca + R * c, cb + R * s]); arcN.push([-c, -s]); arcO.push([ca + (R - W) * c, cb + (R - W) * s]);
    }
    curb = [[cz, eb], ...arc, [ea, cx]]; curbN = [[1, 0], ...arcN, [0, 1]];
    const rev = [...arc].reverse();
    asphalt = Q.full ? [[0, 0], [ea, 0], [ea, cx], ...rev, [cz, eb], [0, eb]] : [[0, cx], ...rev, [cz, eb], [0, eb]];
    walk = [[cz + W, eb], ...arcO, [ea, cx + W], [ea, eb]];
    if (Q.exposeFrom != null && Q.exposeFrom < ea) exposed.push([[Q.exposeFrom, eb], [ea, eb], [0, 1]]);
  } else if (mode === 'x') {
    curb = [[0, cx], [ea, cx]]; curbN = [[0, 1], [0, 1]];
    asphalt = [[0, 0], [ea, 0], [ea, cx], [0, cx]];
    walk = [[0, cx + W], [ea, cx + W], [ea, eb], [0, eb]];
    exposed.push([[0, eb], [ea, eb], [0, 1]]);
  } else if (mode === 'z') {
    curb = [[cz, eb], [cz, 0]]; curbN = [[1, 0], [1, 0]];
    asphalt = [[0, 0], [cz, 0], [cz, eb], [0, eb]];
    walk = [[cz + W, 0], [ea, 0], [ea, eb], [cz + W, eb]];
    exposed.push([[ea, 0], [ea, eb], [1, 0]]);
  } else {
    const r = 3, ca = cz - r, cb = cx - r, arc = [], arcN = [], arcO = [];
    for (let i = 0; i <= 8; i++) {
      const th = Math.PI / 2 - (i / 8) * Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
      arc.push([ca + r * c, cb + r * s]); arcN.push([c, s]); arcO.push([ca + (r + W) * c, cb + (r + W) * s]);
    }
    curb = [[0, cx], ...arc, [cz, 0]]; curbN = [[0, 1], ...arcN, [1, 0]];
    asphalt = [[0, 0], [cz, 0], ...[...arc].reverse(), [0, cx]];
    walk = [[0, cx + W], ...arcO, [cz + W, 0], [ea, 0], [ea, eb], [0, eb]];
    exposed.push([[0, eb], [ea, eb], [0, 1]], [[ea, 0], [ea, eb], [1, 0]]);
  }
  hpoly(asphaltGB, mp(asphalt), Y_ROAD, aUV, aCol);
  hpoly(B.paving, mp(walk), Y_WALK, pUV);
  sweep(B.curb, mp(curb), curbN.map(dirW), PROF_CURB, { vScale: 2 });
  for (const [p0, p1, n] of exposed) sweep(B.curb, mp([p0, p1]), [dirW(n), dirW(n)], PROF_EDGE, { uScale: 2, vScale: 2 });
}

/* ============================== public: road network ============================== */
/**
 * Creates a road-network builder. Everything is merged by material in finish().
 * @returns {{ addRoad(spec:object):void, addIntersection(spec:object):void, addPath(points:Array, width:number):void, finish():THREE.Group }}
 */
export function createRoadNetwork() {
  const strips = [], junctions = [], paths = [];

  /** Straight road along (x1,z1)→(x2,z2). */
  function addRoad({ x1, z1, x2, z2, lanesPerDir = 2, laneWidth = 3.5, sidewalk = 5, median = 0, fresh = false }) {
    const L = Math.hypot(x2 - x1, z2 - z1);
    if (L < 0.5) return;
    const F = frame(x1, z1, (x2 - x1) / L, (z2 - z1) / L);
    const med = Math.max(0, median) / 2;
    strips.push({ kind: 'road', F, s0: 0, s1: L, lanes: lanesPerDir, lw: laneWidth, med, hw: med + lanesPerDir * laneWidth, hwCarriage: lanesPerDir * laneWidth, sw: Math.max(0, sidewalk), fresh, cuts: { 1: [], '-1': [] }, joined: [false, false] });
  }

  /** 4-way junction centred at (x, z); arms = { n, s, e, w } lengths from the centre (0 = no arm). */
  function addIntersection({ x, z, lanesPerDir = 2, laneWidth = 3.5, sidewalk = 5, arms = {}, fresh = false }) {
    const hw = lanesPerDir * laneWidth, sw = Math.max(0, sidewalk), core = hw + Math.max(sw, CORNER_R);
    const J = { x, z, hw, sw, core, lanesPerDir, laneWidth, fresh, arms: { n: arms.n || 0, s: arms.s || 0, e: arms.e || 0, w: arms.w || 0 } };
    junctions.push(J);
    const dirs = { e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1] };
    for (const k of ['n', 's', 'e', 'w']) {
      const len = J.arms[k];
      if (len <= core + 0.5) continue;
      const [ux, uz] = dirs[k];
      strips.push({ kind: 'arm', junction: J, F: frame(x, z, ux, uz), s0: core, s1: len, lanes: lanesPerDir, lw: laneWidth, med: 0, hw, hwCarriage: hw, sw, fresh, cuts: { 1: [], '-1': [] }, joined: [false, false] });
    }
  }

  /** Paved footpath along a polyline of Vector2(x, z) / [x, z] / {x, z} points, flush with grass (y = 0.03). */
  function addPath(points, width = 2.5) {
    const pts = points.map(p => (p.isVector2 ? [p.x, p.y] : Array.isArray(p) ? [p[0], p[1]] : [p.x, p.z !== undefined ? p.z : p.y]));
    if (pts.length >= 2) paths.push({ pts, width });
  }

  /** Builds and merges everything; returns a THREE.Group (≈ 8 meshes). */
  function finish() {
    const B = { asphalt: new GB(), asphaltFresh: new GB(), mark: new GB(), curb: new GB(), paving: new GB(), median: new GB(), path: new GB(), grate: new GB() };
    const R = CORNER_R;
    // --- detect T-joins: a strip end touching another strip's outer sidewalk edge, perpendicular to it
    const tjoins = [];
    for (const A of strips) {
      for (const end of A.kind === 'arm' ? [1] : [0, 1]) {
        const s = end ? A.s1 : A.s0, [ex, ez] = A.F.P(s, 0);
        const dx = end ? A.F.ux : -A.F.ux, dz = end ? A.F.uz : -A.F.uz;
        for (const Bs of strips) {
          if (Bs === A || (Bs.junction && Bs.junction === A.junction)) continue;
          if (Math.abs(A.F.ux * Bs.F.ux + A.F.uz * Bs.F.uz) > 0.02) continue;
          const rx = ex - Bs.F.x1, rz = ez - Bs.F.z1;
          const lat = rx * Bs.F.nx + rz * Bs.F.nz, along = rx * Bs.F.ux + rz * Bs.F.uz;
          const outer = Bs.hw + Math.max(Bs.sw, CURB_W);
          if (Math.abs(Math.abs(lat) - outer) > 0.8) continue;
          const side = Math.sign(lat);
          if ((dx * Bs.F.nx + dz * Bs.F.nz) * side > -0.9) continue;
          const ea = A.hw + Math.max(A.sw, R + 0.5);
          if (along - ea < Bs.s0 - 1e-6 || along + ea > Bs.s1 + 1e-6) continue;
          Bs.cuts[side].push([along - ea, along + ea]);
          A.joined[end] = true;
          tjoins.push({ A, end, B: Bs, side, along, ea });
          break;
        }
      }
    }
    // --- strips
    for (const st of strips) { buildStripAsphalt(B, st); buildStripSides(B, st); buildStripMarkings(B, st); }
    // --- junction cores
    for (const J of junctions) {
      for (const sa of [1, -1]) for (const sb of [1, -1]) {
        const hasX = (sa > 0 ? J.arms.e : J.arms.w) > J.core + 0.5, hasZ = (sb > 0 ? J.arms.s : J.arms.n) > J.core + 0.5;
        buildQuadrant(B, {
          map: (a, b) => [J.x + sa * a, J.z + sb * b], cz: J.hw, cx: J.hw, ea: J.core, eb: J.core, full: true, fresh: J.fresh,
          mode: hasX && hasZ ? 'concave' : hasX ? 'x' : hasZ ? 'z' : 'convex',
        });
      }
      manhole(B.grate, J.x + 2.2, J.z - 1.6, 0.4);
    }
    // --- T-join corners
    for (const T of tjoins) {
      const Bf = T.B.F, [ox, oz] = Bf.P(T.along, 0), bx = Bf.nx * T.side, bz = Bf.nz * T.side;
      for (const sa of [1, -1]) {
        buildQuadrant(B, {
          map: (a, b) => [ox + Bf.ux * sa * a + bx * b, oz + Bf.uz * sa * a + bz * b],
          cz: T.A.hw, cx: T.B.hw, ea: T.ea, eb: T.B.hw + Math.max(T.B.sw, CURB_W), mode: 'concave', full: false, fresh: T.A.fresh,
          exposeFrom: T.A.hw + Math.max(T.A.sw, CURB_W),
        });
      }
    }
    // --- footpaths
    for (const p of paths) buildPath(B.path, p.pts, p.width);

    const grp = new THREE.Group();
    grp.name = 'roadNetwork';
    const add = (gb, m, o) => { const mesh = gb.mesh(m, o); if (mesh) grp.add(mesh); };
    add(B.asphalt, M.asphalt(), { cast: false, name: 'asphalt' });
    add(B.asphaltFresh, M.asphaltFresh(), { cast: false, name: 'asphaltFresh' });
    add(B.mark, M.marking(), { cast: false, name: 'markings' });
    add(B.grate, M.grate(), { cast: false, name: 'grates' });
    add(B.curb, M.curb(), { name: 'curbs' });
    add(B.paving, M.paving(), { name: 'sidewalks' });
    add(B.median, M.median(), { name: 'medianGrass' });
    add(B.path, M.path(), { cast: false, name: 'paths' });
    return grp;
  }

  return { addRoad, addIntersection, addPath, finish };
}

function buildPath(gb, pts, width) {
  const hw = width / 2, uv = (x, z) => [x / 1.6, z / 1.6];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1e-3) continue;
    const nx = -(z1 - z0) / L * hw, nz = (x1 - x0) / L * hw;
    hpoly(gb, [[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz]], Y_PATH, uv);
  }
  for (let i = 1; i < pts.length - 1; i++) {     // round joints
    const [x, z] = pts[i], ring = [];
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; ring.push([x + Math.cos(a) * hw, z + Math.sin(a) * hw]); }
    hpoly(gb, ring, Y_PATH, uv);
  }
}

/* ============================== props ============================== */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
function T(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}
function meshOf(gb, material, cast = true, receive = true) { return gb.mesh(material, { cast, receive }); }

/**
 * Street light: ~9.3 m galvanised pole with a curved outreach arm and an LED head toward local +Z.
 * Plain static group of 3 meshes (pole metal, concrete footing, lens) — safe to instance.
 * @returns {THREE.Group}
 */
export function createStreetlight() {
  const metal = new GB(), conc = new GB(), lens = new GB();
  conc.addGeo(new THREE.CylinderGeometry(0.26, 0.3, 0.2, 12), T(0, 0.02, 0), { uvMode: 'tri', vScale: 2 });
  metal.addGeo(new THREE.CylinderGeometry(0.15, 0.17, 0.95, 12), T(0, 0.6, 0));
  metal.addGeo(new THREE.CylinderGeometry(0.175, 0.175, 0.08, 12), T(0, 0.14, 0));
  metal.addGeo(new THREE.BoxGeometry(0.13, 0.36, 0.04), T(0, 0.62, -0.15));          // service door
  metal.addGeo(new THREE.CylinderGeometry(0.12, 0.14, 0.12, 12), T(0, 1.1, 0));       // collar
  metal.addGeo(new THREE.CylinderGeometry(0.068, 0.11, 7.9, 12, 1, true), T(0, 5.05, 0));
  metal.addGeo(new THREE.SphereGeometry(0.075, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), T(0, 9.0, 0));
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, 8.55, 0), new THREE.Vector3(0, 9.25, 0.05), new THREE.Vector3(0, 9.42, 0.9), new THREE.Vector3(0, 9.42, 2.05));
  metal.addGeo(new THREE.TubeGeometry(curve, 14, 0.048, 8, false), new THREE.Matrix4());
  // decorative lower brace
  const brace = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 8.1, 0.05), new THREE.Vector3(0, 8.85, 0.35), new THREE.Vector3(0, 9.36, 1.15));
  metal.addGeo(new THREE.TubeGeometry(brace, 8, 0.022, 6, false), new THREE.Matrix4());
  // LED head (slightly tilted up at the front)
  const head = T(0, 9.42, 2.0, -0.07);
  const hp = (geo, x, y, z) => geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(head, T(x, y, z)));
  metal.addGeo(hp(new RoundedBoxGeometry(0.2, 0.09, 0.26, 2, 0.03), 0, 0, 0), new THREE.Matrix4());          // clamp
  metal.addGeo(hp(new RoundedBoxGeometry(0.4, 0.1, 0.86, 3, 0.045), 0, 0.0, 0.52), new THREE.Matrix4());   // body
  for (let i = 0; i < 6; i++) metal.addGeo(hp(new THREE.BoxGeometry(0.012, 0.035, 0.6), -0.125 + i * 0.05, 0.065, 0.55), new THREE.Matrix4()); // cooling fins
  metal.addGeo(hp(new THREE.CylinderGeometry(0.03, 0.035, 0.04, 10), 0, 0.075, 0.12), new THREE.Matrix4()); // photocell
  lens.addGeo(hp(new THREE.BoxGeometry(0.3, 0.02, 0.64), 0, -0.052, 0.56), new THREE.Matrix4());
  const g = new THREE.Group();
  g.name = 'streetlight';
  g.add(meshOf(metal, M.pole()), meshOf(conc, M.concrete()), meshOf(lens, M.lens(), false, true));
  return g;
}

/**
 * Park bench, 1.8 m wide, front (seat edge) facing local +Z. 2 meshes (wood slats, cast-iron frames).
 * @returns {THREE.Group}
 */
export function createBench() {
  const wood = new GB(), iron = new GB();
  for (let i = 0; i < 5; i++) wood.addGeo(new RoundedBoxGeometry(1.8, 0.035, 0.075, 2, 0.012), T(0, 0.445, -0.17 + i * 0.088));
  for (let i = 0; i < 3; i++) {
    const y = 0.6 + i * 0.12, zb = -0.27 - (y - 0.5) * 0.28;
    wood.addGeo(new RoundedBoxGeometry(1.8, 0.09, 0.028, 2, 0.01), T(0, y, zb, -0.27));
  }
  for (const x of [-0.72, 0.72]) {
    iron.addGeo(new RoundedBoxGeometry(0.05, 0.43, 0.055, 2, 0.012), T(x, 0.215, 0.17, 0.08));
    iron.addGeo(new RoundedBoxGeometry(0.05, 0.43, 0.055, 2, 0.012), T(x, 0.215, -0.2, -0.12));
    iron.addGeo(new RoundedBoxGeometry(0.05, 0.05, 0.52, 2, 0.012), T(x, 0.405, -0.01));
    iron.addGeo(new RoundedBoxGeometry(0.05, 0.52, 0.05, 2, 0.012), T(x, 0.7, -0.33, -0.27));
    iron.addGeo(new RoundedBoxGeometry(0.06, 0.035, 0.46, 2, 0.012), T(x * 1.035, 0.66, -0.03, 0.06));
    iron.addGeo(new RoundedBoxGeometry(0.04, 0.24, 0.04, 2, 0.01), T(x * 1.035, 0.53, 0.17));
    iron.addGeo(new RoundedBoxGeometry(0.1, 0.03, 0.12, 2, 0.01), T(x, 0.015, 0.18));
    iron.addGeo(new RoundedBoxGeometry(0.1, 0.03, 0.12, 2, 0.01), T(x, 0.015, -0.22));
  }
  const g = new THREE.Group();
  g.name = 'bench';
  g.add(meshOf(wood, M.wood()), meshOf(iron, M.iron()));
  return g;
}

function planeUV(geo, u0, v0, u1, v1) {   // remap 0..1 plane UVs to an atlas region given in canvas pixels (512²)
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, (u0 + (u1 - u0) * u) / 512, 1 - (v1 - (v1 - v0) * v) / 512);
  }
  return geo;
}

/**
 * Glass bus shelter (4.4 m × 1.6 m, open front toward local +Z) with bench, roof fascia «ОСТАНОВКА»,
 * advertising light-box, route sign on a pole and a litter bin. Origin at footprint centre, y = 0.
 * @returns {THREE.Group}
 */
export function createBusStop() {
  const steel = new GB(), roof = new GB(), glass = new GB(), signs = new GB(), wood = new GB(), conc = new GB(), bin = new GB();
  conc.addGeo(new THREE.BoxGeometry(4.9, 0.03, 2.1), T(0, 0.015, 0.05), { uvMode: 'tri', vScale: 2 });
  const zb = -0.72, zf = 0.62, X = 2.15, H = 2.45;
  for (const x of [-X, X]) for (const z of [zb, zf]) steel.addGeo(new THREE.BoxGeometry(0.08, H, 0.08), T(x, H / 2 + 0.04, z));
  for (const x of [-0.72, 0.72]) steel.addGeo(new THREE.BoxGeometry(0.05, H - 0.1, 0.05), T(x, H / 2, zb));
  steel.addGeo(new THREE.BoxGeometry(2 * X, 0.06, 0.06), T(0, 0.22, zb));
  steel.addGeo(new THREE.BoxGeometry(2 * X, 0.08, 0.08), T(0, H, zb));
  steel.addGeo(new THREE.BoxGeometry(2 * X, 0.08, 0.08), T(0, H, zf));
  for (const x of [-X, X]) steel.addGeo(new THREE.BoxGeometry(0.08, 0.08, zf - zb), T(x, H, (zb + zf) / 2));
  steel.addGeo(new THREE.BoxGeometry(0.05, 0.05, zf - zb - 0.3), T(X, 0.22, (zb + zf) / 2 - 0.15));
  // roof: sloped canopy with a front fascia
  roof.addGeo(new RoundedBoxGeometry(4.75, 0.1, 2.05, 2, 0.03), T(0, H + 0.12, -0.02, -0.04));
  roof.addGeo(new THREE.BoxGeometry(4.75, 0.2, 0.06), T(0, H + 0.14, 1.0));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(4.6, 0.17), 0, 0, 512, 64), T(0, H + 0.14, 1.035));
  // glass: back (3 panes) + right side
  glass.addGeo(new THREE.BoxGeometry(2 * X - 0.1, H - 0.32, 0.012), T(0, 0.25 + (H - 0.32) / 2, zb));
  glass.addGeo(new THREE.BoxGeometry(0.012, H - 0.45, zf - zb - 0.35), T(X, 0.32 + (H - 0.45) / 2, (zb + zf) / 2 - 0.15));
  // advertising light-box on the left side
  steel.addGeo(new THREE.BoxGeometry(0.16, 1.95, 1.25), T(-X, 1.2, (zb + zf) / 2 - 0.05));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(1.12, 1.82), 256, 64, 512, 512), T(-X - 0.082, 1.2, (zb + zf) / 2 - 0.05, 0, -Math.PI / 2));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(1.12, 1.82), 256, 64, 512, 512), T(-X + 0.082, 1.2, (zb + zf) / 2 - 0.05, 0, Math.PI / 2));
  // bench
  for (let i = 0; i < 3; i++) wood.addGeo(new RoundedBoxGeometry(2.8, 0.035, 0.11, 2, 0.01), T(0.3, 0.47, zb + 0.2 + i * 0.13));
  for (const x of [-0.8, 0.3, 1.4]) steel.addGeo(new THREE.BoxGeometry(0.06, 0.45, 0.36), T(x, 0.25, zb + 0.32));
  // route sign pole
  steel.addGeo(new THREE.CylinderGeometry(0.04, 0.045, 3.0, 10), T(X + 0.6, 1.5, zf + 0.25));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(0.6, 0.6), 0, 64, 256, 320), T(X + 0.6, 2.62, zf + 0.29));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(0.6, 0.6), 0, 64, 256, 320), T(X + 0.6, 2.62, zf + 0.21, 0, Math.PI));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(0.6, 0.3), 0, 320, 256, 448), T(X + 0.6, 2.13, zf + 0.29));
  signs.addGeo(planeUV(new THREE.PlaneGeometry(0.6, 0.3), 0, 320, 256, 448), T(X + 0.6, 2.13, zf + 0.21, 0, Math.PI));
  steel.addGeo(new THREE.BoxGeometry(0.62, 0.92, 0.06), T(X + 0.6, 2.47, zf + 0.25));
  // litter bin
  bin.addGeo(new THREE.CylinderGeometry(0.21, 0.18, 0.72, 14), T(-X - 0.55, 0.38, zf + 0.15));
  bin.addGeo(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 14), T(-X - 0.55, 0.76, zf + 0.15));
  const g = new THREE.Group();
  g.name = 'busStop';
  g.add(meshOf(steel, M.steel()), meshOf(roof, M.roof()), meshOf(signs, M.signs(), false, true), meshOf(wood, M.wood()), meshOf(conc, M.pad()), meshOf(bin, M.bin()));
  const gm = meshOf(glass, M.glass(), false, true); gm.renderOrder = 2; g.add(gm);
  return g;
}

/** Irregular rock: icosahedron with position-hashed vertex jitter (keeps faces closed). */
function rockGeo(r, rnd, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail), p = g.attributes.position, seed = (rnd() * 1e6) | 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.72 + 0.5 * hash2(Math.round(x * 1000) + Math.round(z * 7000), Math.round(y * 1000), seed);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Decorative campus fence along local +X from 0 to `length`: brick pillars (~3 m spacing) on a stone plinth,
 * dark metal bars with spear tips, rails and medallions. `gaps` = [[from, to], …] are demolished sections:
 * no bars, broken pillar stubs, broken plinth, rubble, bricks, earth and a fallen panel on the ground
 * (the middle 40 % of a long gap is left clear so a new road can pass). Origin at the fence base (y = 0).
 * @returns {THREE.Group}
 */
export function createFence({ length = 30, height = 2.2, gaps = [] } = {}) {
  const rnd = mulberry32(Math.round(length * 131) + gaps.length * 7919 + 17);
  const brick = new GB(), stone = new GB(), metal = new GB(), dirt = new GB();
  const BT = { uvMode: 'tri', su: 1, sv: 1 / 0.6 }, ST = { uvMode: 'tri', su: 1, sv: 2 };
  const n = Math.max(1, Math.round(length / 3)), sp = length / n, PH = 0.24;
  const gapAt = x => gaps.find(([a, b]) => x > a && x < b);
  const clearZone = (x, g) => { const L = g[1] - g[0]; if (L < 8) return false; const f = (x - g[0]) / L; return f > 0.3 && f < 0.7; };
  const H = height, barTop = H - 0.12, PLY = 0.38;
  // pillars
  for (let i = 0; i <= n; i++) {
    const px = i * sp, g = gapAt(px);
    if (!g) {
      stone.addGeo(new THREE.BoxGeometry(0.56, 0.62, 0.56), T(px, -0.04, 0), ST);
      brick.addGeo(new THREE.BoxGeometry(0.48, H - 0.2, 0.48), T(px, 0.27 + (H - 0.2) / 2 - 0.02, 0), BT);
      stone.addGeo(new THREE.BoxGeometry(0.6, 0.08, 0.6), T(px, H + 0.09, 0), ST);
      stone.addGeo(new THREE.ConeGeometry(0.3, 0.2, 4, 1), T(px, H + 0.23, 0, 0, Math.PI / 4), ST);
    } else if (!clearZone(px, g)) {      // broken stub with jagged top
      const h = 0.35 + rnd() * 0.7;
      stone.addGeo(new THREE.BoxGeometry(0.56, 0.62, 0.56), T(px, -0.04, 0), ST);
      brick.addGeo(new THREE.BoxGeometry(0.48, h, 0.48), T(px, 0.25 + h / 2, 0), BT);
      for (let k = 0; k < 3; k++) {
        const w = 0.14 + rnd() * 0.18, hh = 0.1 + rnd() * 0.25;
        brick.addGeo(new THREE.BoxGeometry(w, hh, 0.16 + rnd() * 0.2), T(px + (rnd() - 0.5) * 0.3, 0.25 + h + hh / 2 - 0.03, (rnd() - 0.5) * 0.3, 0, rnd() * 0.3), BT);
      }
    }
  }
  // bays
  for (let i = 0; i < n; i++) {
    const x0 = i * sp + PH, x1 = (i + 1) * sp - PH;
    const segs = subtractIntervals(x0, x1, gaps);
    for (const [a, b] of segs) {
      const broke0 = a > x0 + 1e-6, broke1 = b < x1 - 1e-6;
      stone.addGeo(new THREE.BoxGeometry(b - a, PLY + 0.35, 0.3), T((a + b) / 2, (PLY - 0.35) / 2, 0), ST);
      stone.addGeo(new THREE.BoxGeometry(b - a, 0.05, 0.36), T((a + b) / 2, PLY + 0.02, 0), ST);
      for (const [edge, dir] of [[a, -1], [b, 1]]) {
        if (!(dir < 0 ? broke0 : broke1)) continue;
        for (let k = 0; k < 3; k++) stone.addGeo(new THREE.BoxGeometry(0.12 + rnd() * 0.15, 0.1 + rnd() * 0.25, 0.26), T(edge + dir * (0.03 + rnd() * 0.12), rnd() * 0.15, (rnd() - 0.5) * 0.05, rnd() * 0.3, 0, (rnd() - 0.5) * 0.6), ST);
      }
      for (const ry of [0.58, barTop - 0.32, barTop - 0.08]) metal.addGeo(new THREE.BoxGeometry(b - a, 0.045, 0.022), T((a + b) / 2, ry, 0));
      const nb = Math.max(1, Math.round((b - a) / 0.13));
      for (let k = 0; k < nb; k++) {
        const bx = a + (k + 0.5) * (b - a) / nb;
        const bent = (broke0 && bx - a < 0.35) || (broke1 && b - bx < 0.35);
        if (bent) { metal.addGeo(new THREE.BoxGeometry(0.02, barTop - PLY - 0.3, 0.02), T(bx, (barTop + PLY) / 2 - 0.25, 0.12, 0.35 + rnd() * 0.3, 0, (rnd() - 0.5) * 0.5)); continue; }
        bar(metal, bx, PLY, barTop);
      }
      if (b - a > 1.2 && !broke0 && !broke1) metal.addGeo(new THREE.TorusGeometry(0.11, 0.012, 4, 14), T((a + b) / 2, barTop - 0.2, 0));
    }
  }
  // rubble in each gap
  for (const g of gaps) {
    const L = g[1] - g[0];
    const zones = L >= 8 ? [[g[0], g[0] + 0.3 * L], [g[1] - 0.3 * L, g[1]]] : [[g[0], g[1]]];
    for (const [za, zb] of zones) {
      const zl = zb - za, cx = (za + zb) / 2;
      // denser near the standing fence end, thinning toward the cleared middle
      const nearEnd = za === g[0] ? za : zb;
      const rx = () => { const f = Math.pow(rnd(), 1.6); return nearEnd === za ? za + f * zl : zb - f * zl; };
      const rz = (w) => (rnd() - 0.5) * w * (0.4 + 0.6 * rnd());
      // low earth / crushed-mortar heaps
      for (let k = 0; k < Math.max(2, Math.round(zl / 1.6)); k++) {
        const r = 0.45 + rnd() * 0.45;
        dirt.addGeo(rockGeo(r, rnd, 1), T(rx(), -0.1, rz(2.4), 0, rnd() * 3, 0, 1.3, 0.2 + rnd() * 0.12, 1));
      }
      // concrete / stone chunks
      for (let k = 0; k < Math.round(zl * 3.5); k++) {
        stone.addGeo(rockGeo(0.05 + rnd() * 0.16, rnd), T(rx(), 0.0, rz(3.2), rnd() * 3, rnd() * 3, 0, 1, 0.7, 1), ST);
      }
      // loose bricks and brickwork chunks
      for (let k = 0; k < Math.round(zl * 6); k++) {
        const big = rnd() < 0.12;
        const geo = big ? new THREE.BoxGeometry(0.52, 0.2, 0.25) : new THREE.BoxGeometry(0.25, 0.065, 0.12);
        brick.addGeo(geo, T(rx(), big ? 0.04 : 0.03, rz(3.4), (rnd() - 0.5) * 0.7, rnd() * 6, (rnd() - 0.5) * 0.7), BT);
      }
      // bent bars lying around
      for (let k = 0; k < Math.round(zl * 1.1); k++) {
        metal.addGeo(new THREE.BoxGeometry(0.8 + rnd() * 1.4, 0.022, 0.022), T(rx(), 0.04, rz(3), 0, rnd() * 6, (rnd() - 0.5) * 0.2));
      }
      // a fallen panel (rails + bars) lying flat on the rubble
      const panel = new THREE.Group();
      const pw = Math.min(2.2, zl * 0.8);
      const pm = T(cx + (rnd() - 0.5) * zl * 0.3, 0.06, (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 0.6), -Math.PI / 2 + 0.12, rnd() * 0.8 - 0.4, 0);
      for (const ry of [0.2, 1.2]) metal.addGeo(new THREE.BoxGeometry(pw, 0.045, 0.022), new THREE.Matrix4().multiplyMatrices(pm, T(0, ry - 0.7, 0)));
      for (let k = 0; k < Math.floor(pw / 0.13); k++) metal.addGeo(new THREE.BoxGeometry(0.02, 1.5, 0.02), new THREE.Matrix4().multiplyMatrices(pm, T(-pw / 2 + 0.07 + k * 0.13, 0, 0, 0, 0, (rnd() - 0.5) * 0.15)));
      panel.clear();
    }
  }
  const grp = new THREE.Group();
  grp.name = 'fence';
  for (const [gb, m] of [[brick, M.brick()], [stone, M.stone()], [metal, M.fenceMetal()], [dirt, M.dirt()]]) { const mesh = meshOf(gb, m); if (mesh) grp.add(mesh); }
  return grp;
}
function bar(gb, x, y0, y1) {
  const h = 0.011, top = y1, tip = top + 0.1;
  const c = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i], [bx, bz] = c[(i + 1) % 4], nx = (ax + bx) / (2 * h), nz = (az + bz) / (2 * h);
    const v0 = gb.v(x + ax, y0, az, nx, 0, nz, 0, 0), v1 = gb.v(x + bx, y0, bz, nx, 0, nz, 1, 0);
    const v2 = gb.v(x + bx, top, bz, nx, 0, nz, 1, 1), v3 = gb.v(x + ax, top, az, nx, 0, nz, 0, 1);
    gb.q(v0, v1, v2, v3, nx, 0, nz);
    // spear tip (4-sided pyramid with a small bulb)
    const s = 0.024;
    const t0 = gb.v(x + ax / h * s, top, az / h * s, nx * 0.8, 0.6, nz * 0.8, 0, 0), t1 = gb.v(x + bx / h * s, top, bz / h * s, nx * 0.8, 0.6, nz * 0.8, 1, 0);
    const t2 = gb.v(x, tip, 0, nx * 0.8, 0.6, nz * 0.8, 0.5, 1);
    gb.t(t0, t1, t2, nx, 0.6, nz);
  }
}

/**
 * Base ground plane (top at y = 0): dry-grass / earth colour with large-scale procedural variation
 * (vertex colours) and a tiled detail texture. Polygon offset pushes it behind roads/lawns.
 * @returns {THREE.Mesh}
 */
export function createGround({ size = 6000 } = {}) {
  const seg = Math.min(96, Math.max(16, Math.round(size / 60)));
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, uv = geo.attributes.uv, col = new Float32Array(p.count * 3);
  const rep = size / 34;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * rep);
    const a = vnoise(x, z, 180, 1), b = vnoise(x, z, 55, 2), c = vnoise(x, z, 600, 3);
    const v = 0.82 + 0.22 * a + 0.12 * (b - 0.5);
    const green = 0.5 + 0.5 * (c - 0.5) * 1.6;
    col[3 * i] = v * (1.02 - 0.1 * green); col[3 * i + 1] = v * (0.98 + 0.06 * green); col[3 * i + 2] = v * (0.94 - 0.04 * green);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, M.ground());
  m.name = 'ground'; m.receiveShadow = true; m.castShadow = false;
  return m;
}

/* ============================== previews ============================== */
function place(obj, x, y, z, rotY = 0) { obj.position.set(x, y, z); obj.rotation.y = rotY; return obj; }

/**
 * Preview showcase: a junction with 60 m arms (east arm runs into a boulevard with a median → T-join),
 * a fresh 1+1 campus road T-joining the south arm, footpaths, street lights, benches, a bus stop and a
 * campus fence with a demolished gap.
 * @returns {THREE.Group}
 */
export function demo() {
  const root = new THREE.Group();
  root.add(createGround({ size: 600 }));
  const net = createRoadNetwork();
  net.addIntersection({ x: 0, z: 0, arms: { n: 60, s: 70, e: 78, w: 60 } });
  net.addRoad({ x1: 100, z1: -90, x2: 100, z2: 90, lanesPerDir: 4, laneWidth: 3.5, sidewalk: 6, median: 4 });
  net.addRoad({ x1: -12, z1: 45, x2: -90, z2: 45, lanesPerDir: 1, laneWidth: 3.5, sidewalk: 0, fresh: true });
  net.addPath([[-20, -22], [-45, -22], [-60, -40]], 3.2);
  net.addPath([[-45, -22], [-45, -10 - 2.6]], 2.5);
  root.add(net.finish());
  const sl = createStreetlight();
  for (const [x, z, r] of [[-30, -7.7, 0], [30, 7.7, Math.PI], [7.7, -30, -Math.PI / 2], [-7.7, 30, Math.PI / 2], [-55, 7.7, Math.PI], [55, -7.7, 0]]) root.add(place(sl.clone(), x, 0.15, z, r));
  const bench = createBench();
  for (const x of [-30, -36]) root.add(place(bench.clone(), x, 0.03, -24.4, Math.PI));
  root.add(place(createBusStop(), -40, 0.15, -9.6, 0));
  const fence = createFence({ length: 66, gaps: [[21, 44]] });
  root.add(place(fence, -12.8, 0.15, 12.6, -Math.PI / 2));
  return root;
}

/**
 * Preview stress test: the integrator's full road layout (9 junctions, boulevard, campus road, paths) + ground.
 * @returns {THREE.Group}
 */
export function demoGrid() {
  const root = new THREE.Group();
  root.add(createGround({ size: 6000 }));
  const XS = [-300, 0, 180], ZS = [-180, 0, 180], BLVD_X = 400, BLVD_EDGE = 22;
  const net = createRoadNetwork();
  for (const x of XS) for (const z of ZS) {
    const xi = XS.indexOf(x), zi = ZS.indexOf(z);
    let w = xi === 0 ? 220 : (XS[xi] - XS[xi - 1]) / 2;
    let e = xi === XS.length - 1 ? BLVD_X - BLVD_EDGE - x : (XS[xi + 1] - XS[xi]) / 2;
    const n = zi === 0 ? 240 : (ZS[zi] - ZS[zi - 1]) / 2, s = zi === ZS.length - 1 ? 240 : (ZS[zi + 1] - ZS[zi]) / 2;
    if (x === 0 && z === 0) w = 230;
    if (x === -300 && z === 0) e = 70;
    net.addIntersection({ x, z, lanesPerDir: 2, laneWidth: 3.5, sidewalk: 5, arms: { n, s, e, w } });
  }
  net.addRoad({ x1: BLVD_X, z1: -660, x2: BLVD_X, z2: 560, lanesPerDir: 4, laneWidth: 3.5, sidewalk: 6, median: 4 });
  net.addRoad({ x1: -288, z1: 310, x2: -12, z2: 310, lanesPerDir: 1, laneWidth: 3.5, sidewalk: 0, fresh: true });
  for (const p of [[[-276, 262], [-200, 262], [-120, 262], [-30, 262]], [[-160, 198], [-160, 262]], [[-60, 198], [-60, 262]], [[-276, 352], [-150, 352], [-30, 352]], [[-200, 318], [-200, 352], [-200, 408]], [[-90, 318], [-90, 352], [-90, 408]]])
    net.addPath(p.map(([x, z]) => new THREE.Vector2(x, z)), 3.2);
  root.add(net.finish());
  for (const f of [{ x: -12.8, z: 192, rotY: -Math.PI / 2, length: 228, gaps: [[104, 133]] }, { x: -287.2, z: 192, rotY: -Math.PI / 2, length: 228, gaps: [[108, 128]] }, { x: -288, z: 191.2, rotY: 0, length: 276, gaps: [] }])
    root.add(place(createFence({ length: f.length, height: 2.2, gaps: f.gaps }), f.x, 0.15, f.z, f.rotY));
  return root;
}
