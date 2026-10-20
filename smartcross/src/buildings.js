/**
 * buildings.js — procedural Bishkek building kit for the SmartCross presentation.
 *
 * Every building is generated into a handful of shared, merged-by-material meshes (walls, roofs, metal,
 * curtain-wall glass, signs) plus shared InstancedMeshes for the repeated parts (window frames + glass,
 * balconies, doors, AC units). Facades are real walls with openings (piers + spandrels + reveals), so
 * windows sit in proper recesses and catch the sun/shadow.
 *
 * Units: metres, Y up. Main facade of every building faces local +Z.
 */
import * as THREE from 'three';

/* =============================================================================================
 * small utilities
 * ============================================================================================= */
const TAU = Math.PI * 2;

/** Deterministic PRNG. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _col = new THREE.Color();
/** sRGB hex -> linear [r,g,b] (vertex / instance colours are linear). */
const lin = (hex) => { _col.setHex(hex); return [_col.r, _col.g, _col.b]; };
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const jit = (c, R, a) => {
  const k = 1 + (R() - 0.5) * a;
  return [c[0] * k * (1 + (R() - 0.5) * a * 0.35), c[1] * k * (1 + (R() - 0.5) * a * 0.35), c[2] * k * (1 + (R() - 0.5) * a * 0.35)];
};
const pick = (R, arr) => arr[Math.floor(R() * arr.length) % arr.length];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* =============================================================================================
 * geometry accumulator (one per material) — writes indexed, world-space triangles directly
 * ============================================================================================= */
class Acc {
  constructor(cap = 4096) {
    this.cap = cap; this.icap = cap * 2;
    this.P = new Float32Array(cap * 3); this.N = new Float32Array(cap * 3);
    this.T = new Float32Array(cap * 2); this.C = new Float32Array(cap * 3);
    this.I = new Uint32Array(this.icap); this.v = 0; this.i = 0;
  }
  ensure(nv, ni) {
    if (this.v + nv > this.cap) {
      let c = this.cap * 2; while (c < this.v + nv) c *= 2;
      const g = (a, k) => { const b = new Float32Array(c * k); b.set(a); return b; };
      this.P = g(this.P, 3); this.N = g(this.N, 3); this.T = g(this.T, 2); this.C = g(this.C, 3); this.cap = c;
    }
    if (this.i + ni > this.icap) {
      let c = this.icap * 2; while (c < this.i + ni) c *= 2;
      const b = new Uint32Array(c); b.set(this.I); this.I = b; this.icap = c;
    }
  }
  vert(x, y, z, nx, ny, nz, u, v, c) {
    const k = this.v * 3, t = this.v * 2;
    this.P[k] = x; this.P[k + 1] = y; this.P[k + 2] = z;
    this.N[k] = nx; this.N[k + 1] = ny; this.N[k + 2] = nz;
    this.T[t] = u; this.T[t + 1] = v;
    this.C[k] = c[0]; this.C[k + 1] = c[1]; this.C[k + 2] = c[2];
    return this.v++;
  }
  quadIdx(b) { const I = this.I, i = this.i; I[i] = b; I[i + 1] = b + 1; I[i + 2] = b + 2; I[i + 3] = b; I[i + 4] = b + 2; I[i + 5] = b + 3; this.i += 6; }
  triIdx(b) { const I = this.I, i = this.i; I[i] = b; I[i + 1] = b + 1; I[i + 2] = b + 2; this.i += 3; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, this.v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, this.v * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.T.slice(0, this.v * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.C.slice(0, this.v * 3), 3));
    g.setIndex(new THREE.BufferAttribute(this.I.slice(0, this.i), 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/*
 * A "frame" is a right-handed facade coordinate system in world space:
 *   u along the facade (to the viewer's right), y up, n outward (facade normal).
 *   world = (ox + ux*u + nx*n, y, oz + uz*u + nz*n)   with U = (nz, -nx) so that U x Y = N.
 */
const F0 = { ox: 0, oz: 0, nx: 0, nz: 1, ux: 1, uz: 0 }; // identity frame (for building instanced geometry)

// face types: 0:+N 1:-N 2:+U 3:-U 4:+Y 5:-Y ; corner order (a,b) giving CCW winding seen from outside
const ORD = [
  [0, 0, 1, 0, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 0, 1, 0, 1, 1, 0, 1],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 1, 0, 1],
];
const FR = 1, BK = 2, RT = 4, LF = 8, TP = 16, BT = 32, ALL = 63, NOBOT = 31;

/**
 * Axis-aligned quad in a frame.  t: face type; c: the fixed coordinate (n for ±N, u for ±U, y for ±Y);
 * (a0..a1, b0..b1): ranges of the two free coords — ±N: (u, y), ±U: (n, y), ±Y: (u, n).
 */
function face(A, F, t, c, a0, a1, b0, b1, col, su = 3, sv = 3, ou = 0, ov = 0) {
  A.ensure(4, 6);
  let nx, ny = 0, nz;
  switch (t) {
    case 0: nx = F.nx; nz = F.nz; break;
    case 1: nx = -F.nx; nz = -F.nz; break;
    case 2: nx = F.ux; nz = F.uz; break;
    case 3: nx = -F.ux; nz = -F.uz; break;
    case 4: nx = 0; ny = 1; nz = 0; break;
    default: nx = 0; ny = -1; nz = 0;
  }
  const o = ORD[t], base = A.v;
  for (let k = 0; k < 8; k += 2) {
    const a = o[k] ? a1 : a0, b = o[k + 1] ? b1 : b0;
    let u, y, n;
    if (t < 2) { u = a; y = b; n = c; } else if (t < 4) { u = c; n = a; y = b; } else { y = c; u = a; n = b; }
    A.vert(F.ox + F.ux * u + F.nx * n, y, F.oz + F.uz * u + F.nz * n, nx, ny, nz, (a + ou) / su, (b + ov) / sv, col);
  }
  A.quadIdx(base);
}

/** Box in a frame: u0..u1 × y0..y1 × n0..n1, with a face mask. */
function box(A, F, u0, u1, y0, y1, n0, n1, col, mask = ALL, su = 3, sv = 3) {
  if (mask & FR) face(A, F, 0, n1, u0, u1, y0, y1, col, su, sv);
  if (mask & BK) face(A, F, 1, n0, u0, u1, y0, y1, col, su, sv);
  if (mask & RT) face(A, F, 2, u1, n0, n1, y0, y1, col, su, sv);
  if (mask & LF) face(A, F, 3, u0, n0, n1, y0, y1, col, su, sv);
  if (mask & TP) face(A, F, 4, y1, u0, u1, n0, n1, col, su, sv);
  if (mask & BT) face(A, F, 5, y0, u0, u1, n0, n1, col, su, sv);
}

/** Polygon (tri or quad) from frame coords [[u,y,n],...]; winding auto-fixed to face `hint` (frame dir [hu,hy,hn]). */
function poly(A, F, pts, uvs, col, hint) {
  const W = pts.map(([u, y, n]) => [F.ox + F.ux * u + F.nx * n, y, F.oz + F.uz * u + F.nz * n]);
  const ax = W[1][0] - W[0][0], ay = W[1][1] - W[0][1], az = W[1][2] - W[0][2];
  const bx = W[2][0] - W[0][0], by = W[2][1] - W[0][1], bz = W[2][2] - W[0][2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const hx = F.ux * hint[0] + F.nx * hint[2], hy = hint[1], hz = F.uz * hint[0] + F.nz * hint[2];
  let order = pts.map((_, i) => i);
  if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; order = order.reverse(); }
  A.ensure(pts.length, pts.length === 4 ? 6 : 3);
  const base = A.v;
  for (const i of order) A.vert(W[i][0], W[i][1], W[i][2], nx, ny, nz, uvs[i][0], uvs[i][1], col);
  if (pts.length === 4) A.quadIdx(base); else A.triIdx(base);
}

/** Append a THREE.BufferGeometry (non-indexed or indexed) placed at frame coords (u,y,n), scaled. */
function geom(A, F, g, u, y, n, col, sx = 1, sy = 1, sz = 1) {
  const p = g.attributes.position, q = g.attributes.normal, t = g.attributes.uv;
  const cnt = p.count, idx = g.index;
  A.ensure(cnt, idx ? idx.count : cnt);
  const base = A.v;
  for (let i = 0; i < cnt; i++) {
    const lu = u + p.getX(i) * sx, ly = y + p.getY(i) * sy, ln = n + p.getZ(i) * sz;
    const qu = q.getX(i), qy = q.getY(i), qn = q.getZ(i);
    A.vert(F.ox + F.ux * lu + F.nx * ln, ly, F.oz + F.uz * lu + F.nz * ln,
      F.ux * qu + F.nx * qn, qy, F.uz * qu + F.nz * qn, t ? t.getX(i) : 0, t ? t.getY(i) : 0, col);
  }
  if (idx) { for (let i = 0; i < idx.count; i++) A.I[A.i++] = base + idx.getX(i); }
  else { for (let i = 0; i < cnt; i++) A.I[A.i++] = base + i; }
}

/* =============================================================================================
 * instance collector (matrices + colours) for one InstancedMesh
 * ============================================================================================= */
class Inst {
  constructor() { this.m = new Float32Array(16 * 512); this.c = new Float32Array(3 * 512); this.n = 0; }
  /** place the part at frame coords (u,y,n), local X→U, Y→Y, Z→N, scaled (sx,sy,sz). */
  add(F, u, y, n, sx, sy, sz, col) {
    if ((this.n + 1) * 16 > this.m.length) {
      const m = new Float32Array(this.m.length * 2); m.set(this.m); this.m = m;
      const c = new Float32Array(this.c.length * 2); c.set(this.c); this.c = c;
    }
    const m = this.m, o = this.n * 16;
    m[o] = F.ux * sx; m[o + 1] = 0; m[o + 2] = F.uz * sx; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = F.nx * sz; m[o + 9] = 0; m[o + 10] = F.nz * sz; m[o + 11] = 0;
    m[o + 12] = F.ox + F.ux * u + F.nx * n; m[o + 13] = y; m[o + 14] = F.oz + F.uz * u + F.nz * n; m[o + 15] = 1;
    const k = this.n * 3; this.c[k] = col[0]; this.c[k + 1] = col[1]; this.c[k + 2] = col[2];
    this.n++;
  }
}

/* =============================================================================================
 * procedural textures (CanvasTexture, ≤ 512 px)
 * ============================================================================================= */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function finishTex(cv, repeat = true) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
/** soft seamless blotch + grain noise into a 2D context (values around `base`). */
function noiseFill(g, s, R, base, blot, grain) {
  g.fillStyle = `rgb(${base},${base},${base})`; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 160; i++) {
    const x = R() * s, y = R() * s, r = 5 + R() * 26, v = (base + (R() - 0.5) * blot) | 0;
    g.fillStyle = `rgba(${v},${v},${v},0.22)`;
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) { g.beginPath(); g.arc(x + dx, y + dy, r, 0, TAU); g.fill(); }
  }
  const id = g.getImageData(0, 0, s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const k = (R() - 0.5) * grain; d[i] += k; d[i + 1] += k; d[i + 2] += k; }
  g.putImageData(id, 0, 0);
}
let TEX = null;
function textures() {
  if (TEX) return TEX;
  const R = mulberry32(1234);
  // plaster / concrete
  const cn = canvas(256, 256); noiseFill(cn.getContext('2d'), 256, R, 236, 30, 10);
  // panel: one panel per repeat; joints on the left (u=0) and bottom (v=0) edges, stain below the window
  const cp = canvas(256, 256), gp = cp.getContext('2d'); noiseFill(gp, 256, R, 238, 22, 8);
  let gr = gp.createLinearGradient(0, 180, 0, 250);
  gr.addColorStop(0, 'rgba(90,90,90,0.10)'); gr.addColorStop(1, 'rgba(90,90,90,0)');
  gp.fillStyle = gr; gp.fillRect(78, 182, 100, 68);
  gp.fillStyle = 'rgba(70,70,70,0.10)'; gp.fillRect(0, 0, 10, 256); gp.fillRect(0, 244, 256, 12);
  gp.fillStyle = '#7a7a78'; gp.fillRect(0, 0, 3, 256); gp.fillRect(0, 253, 256, 3);
  gp.fillStyle = 'rgba(255,255,255,0.35)'; gp.fillRect(3, 0, 1, 256); gp.fillRect(0, 252, 256, 1);
  // brick: repeat = 1.04 m × 1.0 m (4 bricks × 13 courses)
  const cb = canvas(256, 256), gb = cb.getContext('2d');
  gb.fillStyle = '#e6e3de'; gb.fillRect(0, 0, 256, 256);
  const ch = 256 / 13;
  for (let r = 0; r < 13; r++) {
    const off = (r % 2) * 32;
    for (let k = -1; k < 5; k++) {
      const v = 150 + R() * 70 | 0, x = k * 64 + off;
      gb.fillStyle = `rgb(${v},${v * 0.97 | 0},${v * 0.95 | 0})`;
      gb.fillRect(x + 1.5, r * ch + 1.5, 61, ch - 3);
    }
  }
  const bd = gb.getImageData(0, 0, 256, 256); for (let i = 0; i < bd.data.length; i += 4) { const k = (R() - 0.5) * 18; bd.data[i] += k; bd.data[i + 1] += k; bd.data[i + 2] += k; }
  gb.putImageData(bd, 0, 0);
  // profiled metal roof: 5 ribs per metre (u), along slope (v)
  const cr = canvas(128, 128), grr = cr.getContext('2d');
  for (let x = 0; x < 128; x++) {
    const p = (x % 25.6) / 25.6;
    const v = p < 0.12 ? 250 : p < 0.2 ? 165 : p < 0.55 ? 222 : p < 0.62 ? 236 : 215;
    grr.fillStyle = `rgb(${v},${v},${v})`; grr.fillRect(x, 0, 1, 128);
  }
  grr.fillStyle = 'rgba(0,0,0,0.05)'; for (let i = 0; i < 40; i++) grr.fillRect(R() * 128, R() * 128, 1 + R() * 3, 10 + R() * 40);
  TEX = { noise: finishTex(cn), panel: finishTex(cp), brick: finishTex(cb), rib: finishTex(cr), sign: signAtlas() };
  return TEX;
}

/* sign atlas: 10 rows of 51.2 px; shop text drawn inside the central half so signs can be cropped to 5:1 */
const SIGNS = [
  { t: 'АПТЕКА', bg: '#17834a', fg: '#ffffff', cross: true },
  { t: 'ПРОДУКТЫ', bg: '#c3272b', fg: '#ffffff' },
  { t: 'КАФЕ', bg: '#4a2f24', fg: '#ffd98a' },
  { t: 'БАНК', bg: '#0c3a78', fg: '#ffffff' },
  { t: 'ОПТИКА', bg: '#f4f6f8', fg: '#0b4f94' },
  { t: 'ЦВЕТЫ', bg: '#d0336f', fg: '#ffffff' },
  { t: 'МАГАЗИН', bg: '#f0b400', fg: '#1d1d1d' },
  { t: 'ХЛЕБ', bg: '#ead6a6', fg: '#7a3a12' },
  { t: 'БИЗНЕС-ЦЕНТР', bg: '#22313a', fg: '#e8f4f6' },
  { t: 'MANAS', bg: null, fg: '#ffffff', stroke: '#16509e' },
];
const SIGN_ROWS = 10, SHOP_SIGNS = 8, SIGN_BC = 8, SIGN_MANAS = 9;
function signAtlas() {
  const W = 512, cv = canvas(W, 512), g = cv.getContext('2d'), rh = 512 / SIGN_ROWS;
  g.clearRect(0, 0, W, 512);
  SIGNS.forEach((s, i) => {
    const y0 = i * rh;
    g.save();
    g.beginPath(); g.rect(0, y0, W, rh); g.clip();
    if (s.bg) {
      g.fillStyle = s.bg; g.fillRect(0, y0, W, rh);
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2; g.strokeRect(6, y0 + 6, W - 12, rh - 12);
    }
    const fs = rh * (s.bg ? 0.56 : 0.8);
    g.font = `bold ${fs}px "DejaVu Sans", "Arial", "Helvetica", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let tw = g.measureText(s.t).width;
    const maxW = s.bg ? W * 0.46 : W * 0.92;
    const cx = W / 2, cy = y0 + rh / 2 + 1;
    g.translate(cx, cy);
    if (!s.bg) {
      // wide rooftop lettering: spread the letters over the whole row
      const n = s.t.length, step = maxW / n;
      g.lineWidth = 5; g.strokeStyle = s.stroke; g.fillStyle = s.fg; g.lineJoin = 'round';
      for (let k = 0; k < n; k++) {
        const x = -maxW / 2 + step * (k + 0.5);
        g.save(); g.translate(x, 0); g.scale(1.6, 1); g.strokeText(s.t[k], 0, 0); g.fillText(s.t[k], 0, 0); g.restore();
      }
    } else {
      const sc = Math.min(1, maxW / tw);
      g.scale(sc, 1);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillText(s.t, 1.5, 1.5);
      g.fillStyle = s.fg; g.fillText(s.t, 0, 0);
      if (s.cross) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        const x = W * 0.5 - (tw * sc) / 2 - rh * 0.7, y = cy, a = rh * 0.3, b = rh * 0.1;
        g.fillStyle = '#ffffff'; g.fillRect(x - a, y - b, 2 * a, 2 * b); g.fillRect(x - b, y - a, 2 * b, 2 * a);
      }
    }
    g.restore();
  });
  const t = finishTex(cv, false);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
/** UV rect [u0,v0,u1,v1] for sign row `i` cropped to aspect `asp` (w/h). */
function signUV(i, asp) {
  const rowAsp = 10, h = 1 / SIGN_ROWS, pad = 0.12 * h;
  const half = Math.min(0.5, (asp / rowAsp) / 2);
  const v1 = 1 - i * h - pad, v0 = 1 - (i + 1) * h + pad;
  return [0.5 - half + 0.004, v0, 0.5 + half - 0.004, v1];
}

/* =============================================================================================
 * materials (module-level cache)
 * ============================================================================================= */
let MAT = null;
function materials() {
  if (MAT) return MAT;
  const T = textures();
  const S = (o) => new THREE.MeshStandardMaterial(o);
  MAT = {
    plaster: S({ vertexColors: true, map: T.noise, roughness: 0.9, metalness: 0 }),
    panel: S({ vertexColors: true, map: T.panel, roughness: 0.88, metalness: 0 }),
    brick: S({ vertexColors: true, map: T.brick, roughness: 0.93, metalness: 0 }),
    roof: S({ vertexColors: true, map: T.rib, roughness: 0.5, metalness: 0.35 }),
    metal: S({ vertexColors: true, roughness: 0.45, metalness: 0.45 }),
    glass: S({ vertexColors: true, color: 0x8fa3b4, roughness: 0.08, metalness: 0.3, envMapIntensity: 1.6 }),
    sign: S({ map: T.sign, alphaTest: 0.45, roughness: 0.55, metalness: 0, emissive: 0xffffff, emissiveMap: T.sign, emissiveIntensity: 0.22 }),
    frame: S({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
    winGlass: S({ vertexColors: true, color: 0x6e8296, roughness: 0.07, metalness: 0.3, envMapIntensity: 1.6 }),
    balc: S({ vertexColors: true, map: T.noise, roughness: 0.82, metalness: 0.02 }),
    door: S({ vertexColors: true, roughness: 0.5, metalness: 0.35 }),
    ac: S({ vertexColors: true, roughness: 0.45, metalness: 0.1 }),
  };
  return MAT;
}

/* =============================================================================================
 * instanced part geometries (built once, shared)
 * ============================================================================================= */
const WA = { w: 1.5, h: 1.5, dep: 0.16 };   // classic window (panel, brick, house)
const WB = { w: 2.4, h: 2.2, dep: 0.14 };   // wide modern window (campus, shop upper floor, office back)
const DOOR = { w: 1.1, h: 2.2, dep: 0.14 };
let GEO = null;
function windowFrameGeo(W, H, dep, kind) {
  const A = new Acc(256), F = F0, w = W / 2, h = H / 2;
  const ft = kind === 'A' ? 0.065 : 0.07, zf = -dep + 0.07, zg = -dep + 0.035;
  const white = [1, 1, 1], shade = [0.8, 0.8, 0.8], sill = kind === 'A' ? [0.66, 0.67, 0.69] : [0.55, 0.56, 0.58];
  // ring (front faces + inner edges)
  face(A, F, 0, zf, -w, w, h - ft, h, white);
  face(A, F, 0, zf, -w, w, -h, -h + ft, white);
  face(A, F, 0, zf, -w, -w + ft, -h + ft, h - ft, white);
  face(A, F, 0, zf, w - ft, w, -h + ft, h - ft, white);
  face(A, F, 5, h - ft, -w + ft, w - ft, zg, zf, shade);
  face(A, F, 4, -h + ft, -w + ft, w - ft, zg, zf, shade);
  face(A, F, 2, -w + ft, zg, zf, -h + ft, h - ft, shade);
  face(A, F, 3, w - ft, zg, zf, -h + ft, h - ft, shade);
  if (kind === 'A') {
    const mx = 0.1, ty = h - 0.48;
    box(A, F, mx - 0.035, mx + 0.035, -h + ft, h - ft, zg, zf, white, FR | LF | RT);
    box(A, F, -w + ft, mx - 0.035, ty - 0.03, ty + 0.03, zg, zf, white, FR | TP | BT);
    // sash edge lines (thin raised strips) for a double-frame look
    box(A, F, -w + ft, mx - 0.035, -h + ft, -h + ft + 0.03, zf, zf + 0.012, shade, FR | TP);
    box(A, F, mx + 0.035, w - ft, -h + ft, -h + ft + 0.03, zf, zf + 0.012, shade, FR | TP);
  } else {
    const m1 = -w / 3, m2 = w / 3, ty = h - 0.55;
    for (const mx of [m1, m2]) box(A, F, mx - 0.035, mx + 0.035, -h + ft, h - ft, zg, zf, white, FR | LF | RT);
    box(A, F, -w + ft, w - ft, ty - 0.035, ty + 0.035, zg, zf - 0.01, white, FR | TP | BT);
  }
  // sill (outside)
  box(A, F, -w - 0.05, w + 0.05, -h - 0.035, -h + 0.012, zf, 0.065, sill, FR | TP | BT | LF | RT);
  return A.geometry();
}
function windowGlassGeo(W, H, dep, kind) {
  const A = new Acc(16), F = F0, w = W / 2, h = H / 2, ft = kind === 'A' ? 0.065 : 0.07, zg = -dep + 0.035;
  const top = [1.12, 1.14, 1.18], bot = [0.72, 0.74, 0.76];
  const b = A.v;
  A.ensure(4, 6);
  A.vert(-w + ft, -h + ft, zg, 0, 0, 1, 0, 0, bot); A.vert(w - ft, -h + ft, zg, 0, 0, 1, 1, 0, bot);
  A.vert(w - ft, h - ft, zg, 0, 0, 1, 1, 1, top); A.vert(-w + ft, h - ft, zg, 0, 0, 1, 0, 1, top);
  A.quadIdx(b);
  return A.geometry();
}
function doorGeo() {
  const A = new Acc(128), F = F0, w = DOOR.w / 2, h = DOOR.h / 2, ft = 0.07, zf = -DOOR.dep + 0.07, zl = zf - 0.035;
  const fr = [0.55, 0.55, 0.55], leaf = [1, 1, 1], pan = [0.86, 0.86, 0.86], dark = [0.12, 0.12, 0.12];
  face(A, F, 0, zf, -w, w, h - ft, h, fr);
  face(A, F, 0, zf, -w, -w + ft, -h, h - ft, fr);
  face(A, F, 0, zf, w - ft, w, -h, h - ft, fr);
  face(A, F, 5, h - ft, -w + ft, w - ft, zl, zf, fr);
  face(A, F, 2, -w + ft, zl, zf, -h, h - ft, fr);
  face(A, F, 3, w - ft, zl, zf, -h, h - ft, fr);
  face(A, F, 0, zl, -w + ft, w - ft, -h, h - ft, leaf);
  box(A, F, -w + 0.16, w - 0.16, 0.12, h - 0.2, zl, zl + 0.015, pan, FR | TP | BT | LF | RT);
  box(A, F, -w + 0.16, w - 0.16, -h + 0.18, -0.12, zl, zl + 0.015, pan, FR | TP | BT | LF | RT);
  box(A, F, w - 0.2, w - 0.14, -0.06, 0.06, zl, zl + 0.06, dark, FR | TP | BT | LF | RT);
  return A.geometry();
}
// balcony module (panel buildings): width 3.0 (x −1.5..1.5), depth 1.2, slab bottom at y = 0, next slab at y = 3
function balcBodyGeo() {
  const A = new Acc(128), F = F0, conc = [0.7, 0.7, 0.68], par = [1, 1, 1], parIn = [0.82, 0.82, 0.82];
  box(A, F, -1.5, 1.5, 0, 0.16, 0, 1.2, conc, FR | RT | LF | TP | BT);
  box(A, F, -1.5, 1.5, 0.16, 1.12, 1.12, 1.2, par, FR | RT | LF | TP);
  face(A, F, 1, 1.12, -1.42, 1.42, 0.16, 1.12, parIn);
  box(A, F, -1.5, -1.42, 0.16, 1.12, 0, 1.12, par, LF | TP);
  face(A, F, 2, -1.42, 0, 1.12, 0.16, 1.12, parIn);
  box(A, F, 1.42, 1.5, 0.16, 1.12, 0, 1.12, par, RT | TP);
  face(A, F, 3, 1.42, 0, 1.12, 0.16, 1.12, parIn);
  // horizontal drip line on the parapet front (ribbed sheet look)
  box(A, F, -1.5, 1.5, 0.5, 0.53, 1.2, 1.215, mul(par, 0.92), FR | TP | BT);
  box(A, F, -1.5, 1.5, 0.82, 0.85, 1.2, 1.215, mul(par, 0.92), FR | TP | BT);
  return A.geometry();
}
function balcFrameGeo() {
  const A = new Acc(256), F = F0, c = [1, 1, 1], z0 = 1.13, z1 = 1.2, y0 = 1.12, y1 = 2.98;
  box(A, F, -1.5, 1.5, y1 - 0.08, y1, z0, z1, c, FR | BT | RT | LF);
  box(A, F, -1.5, 1.5, y0, y0 + 0.07, z0, z1, c, FR | TP | RT | LF);
  for (const x of [-1.46, -0.73, 0, 0.73, 1.46]) box(A, F, x - 0.035, x + 0.035, y0 + 0.07, y1 - 0.08, z0, z1, c, FR | LF | RT);
  box(A, F, -1.43, 1.43, 2.4, 2.46, z0, z1 - 0.01, c, FR | TP | BT);
  for (const x of [-1.5, 1.43]) {
    box(A, F, x, x + 0.07, y0, y1, 0, 0.07, c, LF | RT | FR);
    box(A, F, x, x + 0.07, y1 - 0.08, y1, 0.07, z0, c, LF | RT | BT);
  }
  return A.geometry();
}
function balcGlassGeo() {
  const A = new Acc(32), top = [1.15, 1.17, 1.2], bot = [0.8, 0.82, 0.85];
  let b = A.v; A.ensure(12, 18);
  A.vert(-1.46, 1.19, 1.16, 0, 0, 1, 0, 0, bot); A.vert(1.46, 1.19, 1.16, 0, 0, 1, 1, 0, bot);
  A.vert(1.46, 2.9, 1.16, 0, 0, 1, 1, 1, top); A.vert(-1.46, 2.9, 1.16, 0, 0, 1, 0, 1, top); A.quadIdx(b);
  b = A.v; // left side (normal −X)
  A.vert(-1.465, 1.19, 0.07, -1, 0, 0, 0, 0, bot); A.vert(-1.465, 1.19, 1.13, -1, 0, 0, 1, 0, bot);
  A.vert(-1.465, 2.9, 1.13, -1, 0, 0, 1, 1, top); A.vert(-1.465, 2.9, 0.07, -1, 0, 0, 0, 1, top); A.quadIdx(b);
  b = A.v; // right side (normal +X)
  A.vert(1.465, 1.19, 1.13, 1, 0, 0, 0, 0, bot); A.vert(1.465, 1.19, 0.07, 1, 0, 0, 1, 0, bot);
  A.vert(1.465, 2.9, 0.07, 1, 0, 0, 1, 1, top); A.vert(1.465, 2.9, 1.13, 1, 0, 0, 0, 1, top); A.quadIdx(b);
  return A.geometry();
}
// small open balcony with railing (brick khrushchevka): width 2.4, depth 0.9
function balcRailGeo() {
  const A = new Acc(512), F = F0, conc = [0.68, 0.68, 0.66], met = [0.1, 0.1, 0.11];
  box(A, F, -1.2, 1.2, 0, 0.14, 0, 0.9, conc, FR | RT | LF | TP | BT);
  box(A, F, -1.22, 1.22, 1.0, 1.045, 0.86, 0.92, met, FR | BK | TP | BT | LF | RT);
  box(A, F, -1.22, -1.16, 1.0, 1.045, 0, 0.86, met, LF | RT | TP | BT);
  box(A, F, 1.16, 1.22, 1.0, 1.045, 0, 0.86, met, LF | RT | TP | BT);
  box(A, F, -1.2, 1.2, 0.2, 0.23, 0.875, 0.9, met, FR | BK | TP);
  for (let x = -1.14; x <= 1.15; x += 0.127) box(A, F, x - 0.011, x + 0.011, 0.14, 1.0, 0.877, 0.899, met, FR | BK | LF | RT);
  for (const sx of [-1.19, 1.19]) for (let z = 0.1; z < 0.86; z += 0.127) box(A, F, sx - 0.011, sx + 0.011, 0.14, 1.0, z - 0.011, z + 0.011, met, LF | RT | FR | BK);
  return A.geometry();
}
// split AC outdoor unit; back at the wall plane (z = 0), bottom at y = 0
function acGeo() {
  const A = new Acc(256), F = F0, body = [0.95, 0.95, 0.93], dark = [0.16, 0.17, 0.18], br = [0.35, 0.35, 0.36];
  box(A, F, -0.4, 0.4, 0, 0.56, 0.04, 0.32, body, FR | TP | BT | LF | RT);
  // fan grille: octagon disc + hub
  const cx = -0.1, cy = 0.28, r = 0.2, z = 0.322, k = 8, base = A.v;
  A.ensure(k + 1, k * 3);
  A.vert(cx, cy, z, 0, 0, 1, 0, 0, dark);
  for (let i = 0; i < k; i++) { const a = (i / k) * TAU + TAU / 16; A.vert(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z, 0, 0, 1, 0, 0, dark); }
  for (let i = 0; i < k; i++) { A.I[A.i++] = base; A.I[A.i++] = base + 1 + i; A.I[A.i++] = base + 1 + ((i + 1) % k); }
  box(A, F, cx - 0.05, cx + 0.05, cy - 0.05, cy + 0.05, z, z + 0.02, body, FR | TP | BT | LF | RT);
  for (let i = -1; i <= 1; i++) box(A, F, cx - r, cx + r, cy + i * 0.09 - 0.008, cy + i * 0.09 + 0.008, z + 0.001, z + 0.012, mul(body, 0.8), FR | TP | BT);
  // side louvres
  for (let i = 0; i < 5; i++) box(A, F, 0.2, 0.36, 0.1 + i * 0.08, 0.13 + i * 0.08, 0.32, 0.326, mul(body, 0.75), FR | TP);
  // brackets
  for (const x of [-0.3, 0.3]) box(A, F, x - 0.02, x + 0.02, -0.06, 0, 0, 0.36, br, FR | LF | RT | BT | TP);
  return A.geometry();
}
function geos() {
  if (GEO) return GEO;
  GEO = {
    winA: windowFrameGeo(WA.w, WA.h, WA.dep, 'A'), winAG: windowGlassGeo(WA.w, WA.h, WA.dep, 'A'),
    winB: windowFrameGeo(WB.w, WB.h, WB.dep, 'B'), winBG: windowGlassGeo(WB.w, WB.h, WB.dep, 'B'),
    door: doorGeo(), balc: balcBodyGeo(), balcF: balcFrameGeo(), balcG: balcGlassGeo(), rail: balcRailGeo(), ac: acGeo(),
  };
  return GEO;
}

/* =============================================================================================
 * palettes
 * ============================================================================================= */
const PANEL_PAL = [0xe9ddc6, 0xf1ece2, 0xdccaa8, 0xd2dadb, 0xe8d3c3, 0xdfe2c8, 0xeee3cf, 0xcfd6cf, 0xe5d8bb];
const PLINTH_PAL = [0x8a857c, 0x7c7973, 0x958c7e, 0x6f6e6a];
const BALC_PAL = [0xf3f1ec, 0xf3f1ec, 0xe9e4d8, 0xc9d9e6, 0xd8c8a8, 0xb9c9b2, 0x9fb7cf, 0xe3c9a6, 0xcf9a7c];
const BRICK_PAL = [0xa65a3f, 0xb36c4a, 0x9a4f38, 0xc49a6c, 0xcfc8ba, 0xb8b0a2];
const ROOF_PAL = [0x8d3b2c, 0x3e6a4a, 0x3a5c8a, 0x7e8287, 0xa63d2e, 0x5b4033, 0x6f7f5a];
const HOUSE_PAL = [0xf2efe6, 0xece0c0, 0xe9d8a2, 0xcadbe6, 0xe9d0c4, 0xd7e2c6, 0xf5f2ea, 0xe2cfae];
const SHOP_PAL = [0xe7e1d6, 0xd9cbb2, 0xf0ebe3, 0xc9c3b8, 0xd8d0c4, 0xb9b3a9];
const AWNING_PAL = [0xb8312f, 0x2e6e4f, 0x1f4f8a, 0xd38a1e, 0x7a2f5a, 0x2a6f7a];
const OFFICE_GLASS = [0x46708f, 0x3f7a78, 0x5d7488, 0x6a5e4c, 0x3d5a7a];
const WHITE_F = lin(0xf2f2ef);
const FRAME_ALT = [lin(0x6b4a33), lin(0x9a9c9e), lin(0xe8e0cc), lin(0x5a3a26)];
function glassCol(R) {
  const r = R();
  if (r < 0.13) return jit([1.55, 1.42, 1.25], R, 0.2);   // curtains / tulle
  if (r < 0.25) return [0.5, 0.53, 0.57];                  // dark room
  const k = 0.82 + R() * 0.32; return [k * (0.94 + R() * 0.08), k, k * (1 + R() * 0.14)];
}

/* =============================================================================================
 * building context & facade helpers
 * ============================================================================================= */
function frameL(B, lx, lz, lnx, lnz) {
  const nx = lnx * B.c + lnz * B.s, nz = -lnx * B.s + lnz * B.c;
  return { ox: B.x + lx * B.c + lz * B.s, oz: B.z - lx * B.s + lz * B.c, nx, nz, ux: nz, uz: -nx };
}
function context(spec) {
  const r = spec.rotY || 0;
  const B = { x: spec.x || 0, z: spec.z || 0, c: Math.cos(r), s: Math.sin(r), w: Math.max(4, spec.w || 10), d: Math.max(4, spec.d || 10), floors: Math.max(1, Math.round(spec.floors || 1)), color: spec.color };
  const w = B.w, d = B.d;
  B.C = frameL(B, 0, 0, 0, 1);
  B.front = frameL(B, -w / 2, d / 2, 0, 1);
  B.back = frameL(B, w / 2, -d / 2, 0, -1);
  B.right = frameL(B, w / 2, d / 2, 1, 0);
  B.left = frameL(B, -w / 2, -d / 2, -1, 0);
  B.sides = [[B.front, w, 'front'], [B.right, d, 'right'], [B.back, w, 'back'], [B.left, d, 'left']];
  return B;
}
/** wall zone (horizontal band with its own material/colour/uv mapping). */
const Z = (acc, y0, y1, col, su = 4, sv = 4, ou = 0, ov = 0) => ({ acc, y0, y1, col, su, sv, ou, ov });

/**
 * Facade wall of length L with rectangular openings. Only outward faces + reveals are emitted
 * (piers/spandrels via horizontal banding). ops: [{a, b, lo, hi, dep}].
 */
function wall(F, L, zones, ops, revealK = 0.8) {
  ops.sort((p, q) => p.a - q.a);
  for (const z of zones) {
    const ys = [z.y0, z.y1];
    for (const o of ops) {
      if (o.lo > z.y0 && o.lo < z.y1) ys.push(o.lo);
      if (o.hi > z.y0 && o.hi < z.y1) ys.push(o.hi);
    }
    ys.sort((p, q) => p - q);
    for (let k = 0; k < ys.length - 1; k++) {
      const ya = ys[k], yb = ys[k + 1];
      if (yb - ya < 1e-4) continue;
      let cur = 0;
      for (const o of ops) {
        if (o.lo <= ya + 1e-4 && o.hi >= yb - 1e-4) {
          if (o.a > cur + 1e-4) face(z.acc, F, 0, 0, cur, o.a, ya, yb, z.col, z.su, z.sv, z.ou, z.ov);
          cur = Math.max(cur, o.b);
        }
      }
      if (L > cur + 1e-4) face(z.acc, F, 0, 0, cur, L, ya, yb, z.col, z.su, z.sv, z.ou, z.ov);
    }
    const rc = mul(z.col, revealK), rs = z.su, ro = z.su * 0.5;
    for (const o of ops) {
      const lo = Math.max(o.lo, z.y0), hi = Math.min(o.hi, z.y1);
      if (hi - lo < 1e-4) continue;
      face(z.acc, F, 2, o.a, -o.dep, 0, lo, hi, rc, rs, z.sv, ro, z.ov);
      face(z.acc, F, 3, o.b, -o.dep, 0, lo, hi, rc, rs, z.sv, ro, z.ov);
      if (o.hi <= z.y1 + 1e-4 && o.hi > z.y0) face(z.acc, F, 5, o.hi, o.a, o.b, -o.dep, 0, mul(rc, 0.85), z.su, rs, z.ou, ro);
      if (o.lo >= z.y0 - 1e-4 && o.lo < z.y1) face(z.acc, F, 4, o.lo, o.a, o.b, -o.dep, 0, rc, z.su, rs, z.ou, ro);
    }
  }
}

/* kit-level adders */
function winA(K, F, ops, u, lo, w, h, frame, R) {
  ops.push({ a: u - w / 2, b: u + w / 2, lo, hi: lo + h, dep: WA.dep });
  K.I.winA.add(F, u, lo + h / 2, 0, w / WA.w, h / WA.h, 1, frame);
  K.I.winAG.add(F, u, lo + h / 2, 0, w / WA.w, h / WA.h, 1, glassCol(R));
}
function winB(K, F, ops, u, lo, w, h, frame, R, tint) {
  ops.push({ a: u - w / 2, b: u + w / 2, lo, hi: lo + h, dep: WB.dep });
  K.I.winB.add(F, u, lo + h / 2, 0, w / WB.w, h / WB.h, 1, frame);
  const g = glassCol(R);
  K.I.winBG.add(F, u, lo + h / 2, 0, w / WB.w, h / WB.h, 1, tint ? [g[0] * tint[0], g[1] * tint[1], g[2] * tint[2]] : g);
}
function door(K, F, ops, u, lo, w, h, col) {
  ops.push({ a: u - w / 2, b: u + w / 2, lo, hi: lo + h, dep: DOOR.dep });
  K.I.door.add(F, u, lo + h / 2, 0, w / DOOR.w, h / DOOR.h, 1, col);
}
const DOOR_PAL = [lin(0x5a3b28), lin(0x3b4d5c), lin(0x6e2f24), lin(0x47533c), lin(0x6f6f6f), lin(0x2f3438)];

/** Flat roof with parapet: roof membrane, inner parapet faces and metal coping. */
function flatRoof(K, B, H, ph, inCol, roofCol, capCol, t = 0.3) {
  const { w, d } = B, C = B.C, P = K.A.plaster, M = K.A.metal;
  face(P, C, 4, H, -w / 2 + t, w / 2 - t, -d / 2 + t, d / 2 - t, roofCol, 6, 6);
  face(P, C, 1, d / 2 - t, -w / 2 + t, w / 2 - t, H, H + ph, inCol);
  face(P, C, 0, -d / 2 + t, -w / 2 + t, w / 2 - t, H, H + ph, inCol);
  face(P, C, 3, w / 2 - t, -d / 2 + t, d / 2 - t, H, H + ph, inCol);
  face(P, C, 2, -w / 2 + t, -d / 2 + t, d / 2 - t, H, H + ph, inCol);
  const o = 0.05, y0 = H + ph, y1 = y0 + 0.08;
  box(M, C, -w / 2 - o, w / 2 + o, y0, y1, d / 2 - t - 0.02, d / 2 + o, capCol, ALL);
  box(M, C, -w / 2 - o, w / 2 + o, y0, y1, -d / 2 - o, -d / 2 + t + 0.02, capCol, ALL);
  box(M, C, w / 2 - t - 0.02, w / 2 + o, y0, y1, -d / 2 + t + 0.02, d / 2 - t - 0.02, capCol, NOBOT);
  box(M, C, -w / 2 - o, -w / 2 + t + 0.02, y0, y1, -d / 2 + t + 0.02, d / 2 - t - 0.02, capCol, NOBOT);
}
/** roof-top box (stair exit, machine room, vent), optional door on its +Z face. */
function roofBox(K, B, x, z, bw, bd, y0, h, col, withDoor, R) {
  const C = B.C, P = K.A.plaster;
  box(P, C, x - bw / 2, x + bw / 2, y0, y0 + h, z - bd / 2, z + bd / 2, col, withDoor ? BK | LF | RT : BK | LF | RT | FR);
  if (withDoor) {
    const F = frameL(B, x - bw / 2, z + bd / 2, 0, 1), ops = [];
    door(K, F, ops, bw / 2, y0 + 0.05, 0.9, 2.0, pick(R, DOOR_PAL));
    wall(F, bw, [Z(P, y0, y0 + h, col)], ops);
  }
  box(K.A.metal, C, x - bw / 2 - 0.06, x + bw / 2 + 0.06, y0 + h, y0 + h + 0.1, z - bd / 2 - 0.06, z + bd / 2 + 0.06, lin(0x8e8f8c), NOBOT | BT);
}
function antenna(K, B, x, z, y0, R) {
  const C = B.C, M = K.A.metal, col = lin(0x77797b), h = 2.4 + R() * 2.2;
  box(M, C, x - 0.03, x + 0.03, y0, y0 + h, z - 0.03, z + 0.03, col, NOBOT);
  const n = 2 + (R() * 3 | 0);
  for (let k = 0; k < n; k++) {
    const y = y0 + h - 0.15 - k * 0.38, L = 1.5 - k * 0.25;
    box(M, C, x - L / 2, x + L / 2, y - 0.012, y + 0.012, z - 0.012, z + 0.012, col, ALL);
    for (let j = -2; j <= 2; j++) box(M, C, x + j * L / 5 - 0.008, x + j * L / 5 + 0.008, y - 0.012, y + 0.012, z - 0.28, z + 0.28, col, TP | BT | LF | RT);
  }
  // tripod base
  box(M, C, x - 0.25, x + 0.25, y0, y0 + 0.06, z - 0.25, z + 0.25, mul(col, 0.8), NOBOT);
}
function dish(K, B, x, z, y0) {
  const C = B.C, M = K.A.metal;
  const g = dishGeo();
  geom(M, C, g, x, y0 + 0.9, z, lin(0xe9e9e6));
  box(M, C, x - 0.025, x + 0.025, y0, y0 + 0.75, z - 0.025, z + 0.025, lin(0x777777), NOBOT);
}
let _dish = null;
function dishGeo() {
  if (_dish) return _dish;
  const pts = []; for (let i = 0; i <= 5; i++) { const r = i / 5 * 0.4; pts.push(new THREE.Vector2(r, r * r * 0.5)); }
  const g = new THREE.LatheGeometry(pts, 12); g.rotateX(-1.1); g.rotateY(0.6);
  _dish = g; return g;
}

/**
 * Pitched roof (hip or gable) over local footprint x0..x1 × z0..z1 (incl. overhang), eave height ye.
 * Gable ends are closed with wall triangles (wallAcc/wallCol) at the wall line (inset by `ov`).
 */
function pitchedRoof(K, B, x0, x1, z0, z1, ye, pitch, col, soffitCol, gable, ov, wallAcc, wallCol) {
  const C = B.C, Rf = K.A.roof, P = K.A.plaster, M = K.A.metal, tp = Math.tan(pitch);
  const alongX = x1 - x0 >= z1 - z0;
  // map (a, y, b) -> frame coords (u = x, y, n = z); ridge runs along a
  const pt = alongX ? (a, y, b) => [a, y, b] : (a, y, b) => [b, y, a];
  const hint = alongX ? (ha, hy, hb) => [ha, hy, hb] : (ha, hy, hb) => [hb, hy, ha];
  const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1, b0 = alongX ? z0 : x0, b1 = alongX ? z1 : x1;
  const hs = (b1 - b0) / 2, bc = (b0 + b1) / 2, yr = ye + hs * tp;
  const ra0 = gable ? a0 : a0 + hs, ra1 = gable ? a1 : a1 - hs;
  const sl = hs / Math.cos(pitch), th = 0.13;
  const rib = 1.0;
  // the two long slopes
  for (const sgn of [1, -1]) {
    const be = sgn > 0 ? b1 : b0;
    const pts = [pt(a0, ye, be), pt(a1, ye, be), pt(ra1, yr, bc), pt(ra0, yr, bc)];
    const uvs = [[a0 / rib, 0], [a1 / rib, 0], [ra1 / rib, sl], [ra0 / rib, sl]];
    poly(Rf, C, pts, uvs, col, hint(0, 1, sgn));
    const sp = pts.map(([u, y, n]) => [u, y - th, n]);
    poly(P, C, sp, uvs, soffitCol, hint(0, -1, 0));
    // fascia along the eave
    const fp = [pt(a0, ye, be), pt(a1, ye, be), pt(a1, ye - th - 0.06, be), pt(a0, ye - th - 0.06, be)];
    poly(M, C, fp, [[0, 0], [1, 0], [1, 1], [0, 1]], mul(col, 0.8), hint(0, 0, sgn));
  }
  if (!gable) {
    for (const sgn of [1, -1]) {
      const ae = sgn > 0 ? a1 : a0, ra = sgn > 0 ? ra1 : ra0;
      const pts = [pt(ae, ye, b0), pt(ae, ye, b1), pt(ra, yr, bc)];
      const uvs = [[b0 / rib, 0], [b1 / rib, 0], [bc / rib, sl]];
      poly(Rf, C, pts, uvs, col, hint(sgn, 1, 0));
      poly(P, C, pts.map(([u, y, n]) => [u, y - th, n]), uvs, soffitCol, hint(0, -1, 0));
      poly(M, C, [pt(ae, ye, b0), pt(ae, ye, b1), pt(ae, ye - th - 0.06, b1), pt(ae, ye - th - 0.06, b0)], [[0, 0], [1, 0], [1, 1], [0, 1]], mul(col, 0.8), hint(sgn, 0, 0));
    }
  } else {
    // gable walls at the wall line, rake boards along the slopes
    const yw = ye + ov * tp - 0.0, bw0 = b0 + ov, bw1 = b1 - ov;
    for (const sgn of [1, -1]) {
      const aw = sgn > 0 ? a1 - ov : a0 + ov, ae = sgn > 0 ? a1 : a0;
      const apex = yw + (hs - ov) * tp;
      poly(wallAcc, C, [pt(aw, yw - th, bw0), pt(aw, yw - th, bw1), pt(aw, apex - th, bc)], [[bw0 / 3, (yw - th) / 3], [bw1 / 3, (yw - th) / 3], [bc / 3, (apex - th) / 3]], wallCol, hint(sgn, 0, 0));
      // end faces of the roof slab (rake)
      for (const s2 of [1, -1]) {
        const be = s2 > 0 ? b1 : b0;
        poly(M, C, [pt(ae, ye, be), pt(ae, yr, bc), pt(ae, yr - th - 0.06, bc), pt(ae, ye - th - 0.06, be)], [[0, 0], [1, 0], [1, 1], [0, 1]], mul(col, 0.8), hint(sgn, 0, 0));
      }
    }
  }
  // ridge cap
  const rc = mul(col, 0.85);
  if (alongX) box(M, C, ra0 - 0.05, ra1 + 0.05, yr - 0.02, yr + 0.07, bc - 0.12, bc + 0.12, rc, NOBOT);
  else box(M, C, bc - 0.12, bc + 0.12, yr - 0.02, yr + 0.07, ra0 - 0.05, ra1 + 0.05, rc, NOBOT);
  return { yr, alongX, a0, a1, b0, b1, bc, ra0, ra1, tp };
}

/** generic shopfront / lobby glazing (glass + aluminium frames) inside an opening, glass at depth n. */
function glazing(K, F, a, b, lo, hi, n, frameCol, R, opt = {}) {
  const G = K.A.glass, M = K.A.metal, step = opt.step || 1.6, fw = opt.fw || 0.07, fd = 0.06;
  const W = b - a, np = Math.max(1, Math.round(W / step)), s = W / np;
  const tint = opt.tint || [0.62, 0.7, 0.78];
  const tr = opt.transom === undefined ? lo + (hi - lo) * 0.8 : opt.transom;
  for (let k = 0; k < np; k++) {
    const g = jit(tint, R, 0.12);
    if (tr) { face(G, F, 0, n, a + k * s, a + (k + 1) * s, lo, tr, g); face(G, F, 0, n, a + k * s, a + (k + 1) * s, tr, hi, mul(g, 1.1)); }
    else face(G, F, 0, n, a + k * s, a + (k + 1) * s, lo, hi, g);
  }
  box(M, F, a, b, lo, lo + fw * 1.6, n, n + fd, frameCol, FR | TP);
  box(M, F, a, b, hi - fw, hi, n, n + fd, frameCol, FR | BT);
  for (let k = 0; k <= np; k++) {
    const u = a + k * s, u0 = k === 0 ? a : u - fw / 2, u1 = k === np ? b : u + fw / 2;
    box(M, F, u0, u1, lo + fw * 1.6, hi - fw, n, n + fd, frameCol, FR | LF | RT);
  }
  if (tr) box(M, F, a + fw, b - fw, tr - fw / 2, tr + fw / 2, n, n + fd * 0.7, frameCol, FR | TP | BT);
  if (opt.door) {
    // door: the middle pane gets a door leaf frame + pull handle
    const k = Math.floor(np / 2), u0 = a + k * s, u1 = u0 + s, dh = Math.min(2.2, (tr || hi) - lo - 0.1);
    box(M, F, u0 + fw / 2, u1 - fw / 2, lo + dh, lo + dh + fw, n, n + fd + 0.01, frameCol, FR | TP | BT);
    box(M, F, u0 + fw / 2, u0 + fw / 2 + 0.06, lo, lo + dh, n, n + fd + 0.01, frameCol, FR | LF | RT);
    box(M, F, u1 - fw / 2 - 0.06, u1 - fw / 2, lo, lo + dh, n, n + fd + 0.01, frameCol, FR | LF | RT);
    const hx = u1 - fw / 2 - 0.16;
    box(M, F, hx - 0.02, hx + 0.02, lo + 0.75, lo + 1.45, n + fd + 0.06, n + fd + 0.1, lin(0xc9cdd0), ALL);
  }
}
/** shop sign: box with an atlas face on its front. */
function sign(K, F, uc, y0, sw, sh, n, idx, backCol) {
  const M = K.A.metal, S = K.A.sign, depth = 0.16;
  box(M, F, uc - sw / 2, uc + sw / 2, y0, y0 + sh, n, n + depth, backCol, TP | BT | LF | RT);
  const [u0, v0, u1, v1] = signUV(idx, sw / sh);
  const A = S; A.ensure(4, 6);
  const b = A.v, nn = n + depth, P = (u, y) => [F.ox + F.ux * u + F.nx * nn, y, F.oz + F.uz * u + F.nz * nn];
  const c = [1, 1, 1];
  let p = P(uc - sw / 2, y0); A.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u0, v0, c);
  p = P(uc + sw / 2, y0); A.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u1, v0, c);
  p = P(uc + sw / 2, y0 + sh); A.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u1, v1, c);
  p = P(uc - sw / 2, y0 + sh); A.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u0, v1, c);
  A.quadIdx(b);
}
/** sloped fabric awning projecting from the wall over u0..u1. */
function awning(K, F, u0, u1, yTop, proj, drop, col) {
  const P = K.A.plaster, yb = yTop - drop;
  poly(P, F, [[u0, yTop, 0], [u1, yTop, 0], [u1, yb, proj], [u0, yb, proj]], [[0, 0], [1, 0], [1, 1], [0, 1]], col, [0, 1, 1]);
  poly(P, F, [[u0, yTop - 0.02, 0], [u1, yTop - 0.02, 0], [u1, yb - 0.02, proj], [u0, yb - 0.02, proj]], [[0, 0], [1, 0], [1, 1], [0, 1]], mul(col, 0.55), [0, -1, 0]);
  box(P, F, u0, u1, yb - 0.28, yb, proj - 0.02, proj, mul(col, 0.92), FR | BT | BK | LF | RT);
  poly(P, F, [[u0, yTop, 0], [u0, yb, proj], [u0, yb, 0]], [[0, 0], [1, 0], [1, 1]], mul(col, 0.8), [-1, 0, 0]);
  poly(P, F, [[u1, yTop, 0], [u1, yb, proj], [u1, yb, 0]], [[0, 0], [1, 0], [1, 1]], mul(col, 0.8), [1, 0, 0]);
}

/* =============================================================================================
 * style generators
 * ============================================================================================= */
function genPanel(K, B, R) {
  const { w, d } = B, floors = B.floors, fh = 3, base = 0.9, H = base + floors * fh, ph = 0.8;
  const wallCol = B.color != null ? lin(B.color) : jit(lin(pick(R, PANEL_PAL)), R, 0.05);
  const plinthCol = jit(lin(pick(R, PLINTH_PAL)), R, 0.06);
  const P = K.A.plaster, PN = K.A.panel;
  const fcol = () => (R() < 0.8 ? jit(WHITE_F, R, 0.04) : pick(R, FRAME_ALT));
  const ncol = Math.max(2, Math.round(w / 3.2)), bay = w / ncol;
  const alt = R() < 0.6 && bay > 2.9;
  const winW = (i) => Math.min(bay - 0.9, alt ? (i % 2 ? 1.25 : 1.8) : 1.5);
  const pats = [(i) => i % 3 === 1, (i) => i % 4 === 1 || i % 4 === 2, (i) => i % 2 === 1, (i) => i % 6 === 1 || i % 6 === 4];
  const bpat = pick(R, pats);
  const stackCol = {}; // per-column base parapet colour (some stacks share a colour)
  const hasBal = (i, f) => f >= 1 && i > 0 && i < ncol - 1 && bpat(i);
  const glazedMap = {};
  const zonesFor = (bayW) => [Z(P, 0, base, plinthCol, 3, 3), Z(PN, base, H + ph, wallCol, bayW, fh, 0, -base)];

  // ---- front (main) facade: windows + balcony stacks
  {
    const F = B.front, ops = [];
    for (let i = 0; i < ncol; i++) stackCol[i] = R() < 0.55 ? lin(0xf3f1ec) : jit(lin(pick(R, BALC_PAL)), R, 0.05);
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < ncol; i++) {
        const uc = (i + 0.5) * bay, ww = winW(i);
        let glazed = false;
        if (hasBal(i, f)) {
          glazed = R() < 0.74;
          glazedMap[i + ',' + f] = glazed;
          const bw = Math.min(bay - 0.25, 3.6), sx = bw / 3;
          const pc = R() < 0.75 ? stackCol[i] : jit(lin(pick(R, BALC_PAL)), R, 0.05);
          K.I.balc.add(F, uc, yF - 0.16, 0, sx, 1, 1, pc);
          if (glazed) {
            K.I.balcF.add(F, uc, yF - 0.16, 0, sx, 1, 1, R() < 0.8 ? WHITE_F : pick(R, FRAME_ALT));
            K.I.balcG.add(F, uc, yF - 0.16, 0, sx, 1, 1, glassCol(R));
            if (f === floors - 1 || !hasBal(i, f + 1)) box(K.A.metal, F, uc - bw / 2 - 0.06, uc + bw / 2 + 0.06, yF - 0.16 + 2.98, yF - 0.16 + 3.05, 0, 1.3, lin(pick(R, [0x8a8d90, 0x9b5a3c, 0x6f8a6a, 0xa0a4a8])), ALL);
          }
        }
        if (!glazed) winA(K, F, ops, uc, yF + 0.85, ww, 1.5, fcol(), R);
        if (!hasBal(i, f) && !hasBal(i + 1, f) && i < ncol - 1 && bay - ww > 1.35 && R() < 0.09)
          K.I.ac.add(F, uc + ww / 2 + 0.58, yF + 0.95, 0, 1, 1, 1, jit([0.95, 0.95, 0.93], R, 0.05));
      }
    }
    wall(F, w, zonesFor(bay), ops);
  }
  // ---- back facade: entrances, stair windows
  const nsec = Math.max(1, Math.round(w / 20));
  const stairs = [];
  for (let s = 0; s < nsec; s++) stairs.push(Math.min(ncol - 1, Math.floor((s + 0.5) * ncol / nsec)));
  {
    const F = B.back, ops = [];
    const dcol = pick(R, DOOR_PAL);
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < ncol; i++) {
        const uc = (i + 0.5) * bay;
        if (stairs.includes(i)) {
          if (f === 0) {
            door(K, F, ops, uc, 0.15, 1.2, 2.2, dcol);
            box(P, F, uc - 1.25, uc + 1.25, 2.62, 2.78, 0, 1.6, lin(0xb9b6ae), ALL & ~BK);
            box(P, F, uc - 1.0, uc + 1.0, 0, 0.15, 0, 1.3, lin(0xa8a59e), NOBOT & ~BK);
            box(K.A.metal, F, uc - 1.2, uc - 1.15, 0.15, 2.62, 1.45, 1.5, lin(0x555a5e), FR | LF | RT | BK);
            box(K.A.metal, F, uc + 1.15, uc + 1.2, 0.15, 2.62, 1.45, 1.5, lin(0x555a5e), FR | LF | RT | BK);
          } else {
            winA(K, F, ops, uc, yF - 0.55, 1.2, 1.15, WHITE_F, R);
          }
          continue;
        }
        const ww = winW(i);
        winA(K, F, ops, uc, yF + 0.85, ww, 1.5, fcol(), R);
        if (R() < 0.1 && i < ncol - 1 && !stairs.includes(i + 1) && bay - ww > 1.35)
          K.I.ac.add(F, uc + ww / 2 + 0.58, yF + 0.95, 0, 1, 1, 1, jit([0.95, 0.95, 0.93], R, 0.05));
      }
    }
    wall(F, w, zonesFor(bay), ops);
  }
  // ---- ends
  const ncE = Math.max(1, Math.round(d / 3.2)), bayE = d / ncE, endWin = R() < 0.5;
  for (const F of [B.right, B.left]) {
    const ops = [];
    if (endWin && ncE >= 3) {
      for (let f = 0; f < floors; f++) for (const i of [1, ncE - 2]) winA(K, F, ops, (i + 0.5) * bayE, base + f * fh + 0.85, 1.2, 1.5, WHITE_F, R);
    }
    wall(F, d, zonesFor(bayE), ops);
  }
  // ---- roof
  flatRoof(K, B, H, ph, mul(wallCol, 0.85), lin(0x55575a), lin(0x9a9b98));
  const rcol = mul(wallCol, 0.95);
  for (const i of stairs) {
    const x = w / 2 - (i + 0.5) * bay;
    roofBox(K, B, x, -d / 2 + 3.2, 2.8, 3.2, H, 2.6, rcol, true, R);
    const mx = x + (x > 0 ? -3.0 : 3.0);
    roofBox(K, B, mx, -d / 2 + 3.4, 2.6, 3.0, H, 2.1, rcol, false, R);
  }
  const nv = 2 + (R() * 4 | 0);
  for (let k = 0; k < nv; k++) {
    const x = (R() - 0.5) * (w - 4), z = (R() - 0.5) * 3 + 1.5;
    box(P, B.C, x - 0.4, x + 0.4, H, H + 0.9, z - 0.4, z + 0.4, lin(0x9b9890), NOBOT);
    box(K.A.metal, B.C, x - 0.5, x + 0.5, H + 0.95, H + 1.0, z - 0.5, z + 0.5, lin(0x7d7f80), ALL);
    box(K.A.metal, B.C, x - 0.08, x + 0.08, H + 0.9, H + 0.95, z - 0.08, z + 0.08, lin(0x7d7f80), LF | RT | FR | BK);
  }
  for (let k = 0; k < nsec; k++) if (R() < 0.75) antenna(K, B, (R() - 0.5) * (w - 6), (R() - 0.2) * (d - 6) * 0.5, H, R);
  if (R() < 0.5) dish(K, B, (R() - 0.5) * (w - 6), d / 2 - 2, H);
  return H + ph;
}

function genBrick(K, B, R) {
  const { w, d } = B, floors = B.floors, fh = 3, base = 0.8, H = base + floors * fh;
  const brickCol = B.color != null ? lin(B.color) : jit(lin(pick(R, BRICK_PAL)), R, 0.06);
  const plinthCol = jit(lin(pick(R, PLINTH_PAL)), R, 0.06);
  const P = K.A.plaster, BR = K.A.brick;
  const flat = R() < 0.3, ph = flat ? 0.6 : 0;
  const fcol = () => (R() < 0.55 ? jit(WHITE_F, R, 0.05) : R() < 0.6 ? pick(R, FRAME_ALT) : jit(lin(0xd8d2c4), R, 0.05));
  const ncol = Math.max(2, Math.round(w / 3.0)), bay = w / ncol;
  const zonesFor = () => [Z(P, 0, base, plinthCol, 3, 3), Z(BR, base, H + ph, brickCol, 1.04, 1.0)];
  const bpat = pick(R, [(i) => i % 3 === 1, (i) => i % 4 === 1, (i) => i % 2 === 1 && i % 6 !== 5]);
  const hasBal = (i, f) => f >= 1 && i > 0 && i < ncol - 1 && bpat(i);
  // front
  {
    const F = B.front, ops = [];
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < ncol; i++) {
        const uc = (i + 0.5) * bay;
        let glazed = false;
        if (hasBal(i, f)) {
          if (R() < 0.4) {
            glazed = true;
            const sx = 2.5 / 3, sz = 0.95 / 1.2;
            K.I.balc.add(F, uc, yF - 0.14, 0, sx, 1, sz, jit(lin(pick(R, BALC_PAL)), R, 0.05));
            K.I.balcF.add(F, uc, yF - 0.14, 0, sx, 1, sz, R() < 0.5 ? WHITE_F : pick(R, FRAME_ALT));
            K.I.balcG.add(F, uc, yF - 0.14, 0, sx, 1, sz, glassCol(R));
            box(K.A.metal, F, uc - 1.3, uc + 1.3, yF - 0.14 + 2.98, yF - 0.14 + 3.04, 0, 1.05, lin(0x8a8d90), ALL);
          } else {
            K.I.rail.add(F, uc, yF - 0.14, 0, 1, 1, 1, [1, 1, 1]);
          }
        }
        if (hasBal(i, f) && !glazed) {
          // balcony door + window
          door(K, F, ops, uc - 0.55, yF + 0.0, 0.8, 2.3, lin(0xe8e4dc));
          winA(K, F, ops, uc + 0.45, yF + 0.8, 1.0, 1.5, fcol(), R);
        } else if (!glazed) {
          winA(K, F, ops, uc, yF + 0.8, 1.35, 1.5, fcol(), R);
        }
        if (!hasBal(i, f) && !hasBal(i + 1, f) && i < ncol - 1 && R() < 0.07)
          K.I.ac.add(F, uc + 1.35 / 2 + 0.56, yF + 0.9, 0, 1, 1, 1, jit([0.95, 0.95, 0.93], R, 0.05));
      }
    }
    wall(F, w, zonesFor(), ops);
  }
  // back with entrances
  const nsec = Math.max(1, Math.round(w / 16)), stairs = [];
  for (let s = 0; s < nsec; s++) stairs.push(Math.min(ncol - 1, Math.floor((s + 0.5) * ncol / nsec)));
  {
    const F = B.back, ops = [], dcol = pick(R, DOOR_PAL);
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < ncol; i++) {
        const uc = (i + 0.5) * bay;
        if (stairs.includes(i)) {
          if (f === 0) {
            door(K, F, ops, uc, 0.15, 1.1, 2.15, dcol);
            box(P, F, uc - 1.1, uc + 1.1, 2.55, 2.7, 0, 1.3, lin(0xb5b2aa), ALL & ~BK);
            box(P, F, uc - 0.9, uc + 0.9, 0, 0.15, 0, 1.1, lin(0xa8a59e), NOBOT & ~BK);
          } else winA(K, F, ops, uc, yF - 0.5, 1.1, 1.1, jit(WHITE_F, R, 0.05), R);
          continue;
        }
        winA(K, F, ops, uc, yF + 0.8, 1.35, 1.5, fcol(), R);
        if (R() < 0.08 && i < ncol - 1 && !stairs.includes(i + 1)) K.I.ac.add(F, uc + 1.35 / 2 + 0.56, yF + 0.9, 0, 1, 1, 1, jit([0.95, 0.95, 0.93], R, 0.05));
      }
    }
    wall(F, w, zonesFor(), ops);
  }
  // ends: a column of small windows or blank
  const ew = R() < 0.6;
  for (const F of [B.right, B.left]) {
    const ops = [];
    if (ew) for (let f = 0; f < floors; f++) winA(K, F, ops, d / 2, base + f * fh + 0.8, 0.9, 1.3, WHITE_F, R);
    wall(F, d, zonesFor(), ops);
  }
  // cornice band (corbelled brick)
  const cc = mul(brickCol, 0.92);
  const top = H + ph;
  for (const [F, L] of B.sides) {
    box(BR, F, 0, L + 0.18, top - 0.45, top - 0.3, 0, 0.1, cc, FR | TP | BT | RT, 1.04, 1.0);
    box(BR, F, 0, L + 0.22, top - 0.3, top - 0.15, 0, 0.18, cc, FR | TP | BT | RT, 1.04, 1.0);
  }
  if (flat) {
    flatRoof(K, B, H, ph, mul(brickCol, 0.85), lin(0x58595b), lin(0x8f908d));
    for (let k = 0; k < nsec; k++) if (R() < 0.8) antenna(K, B, (R() - 0.5) * (w - 6), (R() - 0.5) * (d - 6), H, R);
  } else {
    const ov = 0.45, pitch = (15 + R() * 6) * Math.PI / 180, rc = jit(lin(pick(R, [0x7e8287, 0x6d7275, 0x3e6a4a, 0x8d3b2c, 0x9a9a95])), R, 0.05);
    const tp = Math.tan(pitch), ye = H + 0.13 - ov * tp;
    // close the top of the walls under the roof (attic floor)
    face(P, B.C, 4, H, -w / 2, w / 2, -d / 2, d / 2, lin(0x6a6a68), 6, 6);
    const r = pitchedRoof(K, B, -w / 2 - ov, w / 2 + ov, -d / 2 - ov, d / 2 + ov, ye, pitch, rc, lin(0xd9d4c8), false, ov, BR, brickCol);
    // chimneys / vent stacks through the roof
    for (let k = 0; k < nsec; k++) {
      const x = -w / 2 + (k + 0.5) * w / nsec + (R() - 0.5) * 3, z = (R() - 0.5) * 2;
      const yb = r.yr - Math.abs(z) * tp - 0.3;
      box(BR, B.C, x - 0.45, x + 0.45, yb, r.yr + 0.9, z - 0.3, z + 0.3, mul(brickCol, 0.9), NOBOT, 1.04, 1.0);
      box(P, B.C, x - 0.55, x + 0.55, r.yr + 0.9, r.yr + 0.98, z - 0.4, z + 0.4, lin(0x9a9893), ALL);
      if (R() < 0.6) antenna(K, B, x + 0.9, z + 0.4, r.yr - 0.4, R);
    }
  }
  return top;
}

function genOffice(K, B, R) {
  const { w, d } = B, floors = B.floors, lobby = 4.5, fh = 3.3, H = lobby + (floors - 1) * fh, crown = 1.3;
  const variant = pick(R, ['grid', 'fins', 'bands']);
  const gl = lin(pick(R, OFFICE_GLASS)), glass = mul(gl, 1.6);
  const mullCol = jit(lin(pick(R, [0xb9bec2, 0x3a3f44, 0xd5d7d6, 0x8c939a])), R, 0.03);
  const stone = jit(lin(pick(R, [0xe6e1d6, 0xcfc9bd, 0xd9d6cf, 0x9fa3a6])), R, 0.03);
  const spand = variant === 'bands' ? stone : mul(gl, 0.7);
  const granite = lin(0x4a4a4c);
  const P = K.A.plaster, M = K.A.metal, G = K.A.glass;
  for (const [F, L, side] of B.sides) {
    // podium (lobby floor): granite base, glazing, stone band
    const ops = [{ a: 0.6, b: L - 0.6, lo: 0.45, hi: lobby - 0.5, dep: 0.35 }];
    wall(F, L, [Z(P, 0, 0.45, granite, 2, 2), Z(P, 0.45, lobby, stone, 3, 3)], ops);
    glazing(K, F, 0.6, L - 0.6, 0.45, lobby - 0.5, -0.3, lin(0x30353a), R, { step: 2.0, transom: 0.45 + 2.7, door: side === 'front', tint: mul(glass, 0.8) });
    // tower
    const nb = Math.max(2, Math.round(L / (variant === 'fins' ? 3 : 1.5))), bw = L / nb;
    for (let f = 1; f < floors; f++) {
      const y0 = lobby + (f - 1) * fh, sp = variant === 'grid' ? 0.9 : variant === 'fins' ? 0.45 : 1.1;
      if (variant === 'bands') {
        box(P, F, 0, L + 0.12, y0, y0 + sp, 0, 0.12, stone, FR | TP | BT | RT);
      } else face(M, F, 0, 0, 0, L, y0, y0 + sp, spand);
      for (let k = 0; k < nb; k++) face(G, F, 0, variant === 'bands' ? -0.15 : 0, k * bw, (k + 1) * bw, y0 + sp, y0 + fh, jit(glass, R, 0.14));
      if (variant === 'bands') {
        // reveal of the ribbon window (top/bottom), mullions
        face(P, F, 4, y0 + sp, 0, L, -0.15, 0, mul(stone, 0.8));
        face(P, F, 5, y0 + fh, 0, L, -0.15, 0, mul(stone, 0.7));
        for (let k = 1; k < nb; k++) box(M, F, k * bw - 0.03, k * bw + 0.03, y0 + sp, y0 + fh, -0.15, -0.08, mullCol, FR | LF | RT);
      } else {
        box(M, F, 0, L, y0 - 0.05, y0 + 0.05, 0, 0.1, mullCol, FR | TP | BT);
        box(M, F, 0, L, y0 + sp - 0.04, y0 + sp + 0.04, 0, 0.08, mullCol, FR | TP | BT);
      }
    }
    if (variant === 'bands') {
      // corner reveal faces for the recessed ribbon glass
      for (let f = 1; f < floors; f++) {
        const y0 = lobby + (f - 1) * fh;
        face(P, F, 2, 0, -0.15, 0, y0 + 1.1, y0 + fh, mul(stone, 0.85));
      }
      // fill the corner notch of the ribbon at u = L
      for (let f = 1; f < floors; f++) {
        const y0 = lobby + (f - 1) * fh;
        face(P, F, 3, L, -0.15, 0, y0 + 1.1, y0 + fh, mul(stone, 0.85));
      }
    } else {
      for (let k = 0; k < nb; k++) {
        const u = k * bw;
        if (variant === 'fins') {
          if (k === 0) box(P, F, -0.25, 0.25, lobby, H + crown, 0, 0.6, stone, FR | LF | RT | TP);
          else box(P, F, u - 0.2, u + 0.2, lobby, H, 0, 0.55, stone, FR | LF | RT | TP | BT);
          box(M, F, u + bw / 2 - 0.03, u + bw / 2 + 0.03, lobby, H, 0, 0.1, mullCol, FR | LF | RT);
        } else {
          if (k === 0) box(M, F, -0.14, 0.05, lobby, H, 0, 0.14, mullCol, FR | LF | RT);
          else box(M, F, u - 0.04, u + 0.04, lobby, H, 0, 0.14, mullCol, FR | LF | RT);
        }
      }
    }
    // crown band
    face(M, F, 0, 0, 0, L, H, H + crown, mul(mullCol, 0.95));
    box(M, F, 0, L + 0.08, H - 0.1, H, 0, 0.08, mullCol, FR | TP | BT | RT);
  }
  flatRoof(K, B, H, crown, lin(0x9a9c9c), lin(0x5f6164), lin(0xa9abab), 0.25);
  // entrance canopy + sign on the main facade
  {
    const F = B.front, uc = w / 2, cw = Math.min(9, w * 0.4);
    box(P, F, uc - cw / 2, uc + cw / 2, lobby - 0.95, lobby - 0.65, 0, 3.2, lin(0xd8dadb), ALL & ~BK);
    for (const s of [-1, 1]) box(M, F, uc + s * (cw / 2 - 0.5) - 0.08, uc + s * (cw / 2 - 0.5) + 0.08, 0, lobby - 0.95, 2.8, 2.96, mullCol, FR | BK | LF | RT);
    const sw = Math.min(cw - 1, 6);
    sign(K, F, uc, lobby - 0.62, sw, sw / 10, 3.0, SIGN_BC, lin(0x22313a));
    box(P, F, uc - cw / 2 + 0.2, uc + cw / 2 - 0.2, 0, 0.12, 0, 2.9, lin(0x8e8c88), NOBOT & ~BK);
  }
  // roof plant
  const C = B.C, pw = w * 0.42, pd = d * 0.42;
  box(P, C, -pw / 2, pw / 2, H, H + 3.4, -pd / 2, pd / 2, mul(stone, 0.95), NOBOT);
  for (let k = 0; k < 4; k++) box(M, C, -pw / 2 - 0.05, pw / 2 + 0.05, H + 0.8 + k * 0.55, H + 0.9 + k * 0.55, -pd / 2 - 0.05, pd / 2 + 0.05, lin(0x8a8f93), FR | BK | LF | RT | TP);
  box(M, C, -pw / 2 - 0.1, pw / 2 + 0.1, H + 3.4, H + 3.5, -pd / 2 - 0.1, pd / 2 + 0.1, lin(0x7d8285), ALL);
  const RF = frameL(B, 0, 0, 0, 1);
  for (let k = 0; k < 3; k++) {
    const x = -w / 2 + 2.5 + k * 2.6;
    if (x > -pw / 2 - 2) break;
    K.I.ac.add({ ...RF, ox: RF.ox, oz: RF.oz }, x, H + 0.1, -d / 2 + 2.0, 2.4, 2.2, 2.6, [0.85, 0.87, 0.88]);
  }
  if (R() < 0.7) {
    const x = pw / 2 - 1, z = -pd / 2 + 1, y = H + 3.5, h = 6 + R() * 4;
    box(M, C, x - 0.08, x + 0.08, y, y + h, z - 0.08, z + 0.08, lin(0x9aa0a4), NOBOT);
    for (let k = 0; k < 3; k++) {
      const a = k * TAU / 3, px = x + Math.cos(a) * 0.3, pz = z + Math.sin(a) * 0.3;
      box(M, C, px - 0.12, px + 0.12, y + h - 1.6, y + h - 0.2, pz - 0.05, pz + 0.05, lin(0xe2e4e5), ALL);
    }
  }
  return H + crown;
}

function genShop(K, B, R) {
  const { w, d } = B, floors = Math.min(2, B.floors), gh = 4.0, uh = 3.2, H = gh + (floors - 1) * uh, ph = 0.7;
  const wallCol = B.color != null ? lin(B.color) : jit(lin(pick(R, SHOP_PAL)), R, 0.05);
  const gfCol = R() < 0.5 ? wallCol : jit(lin(pick(R, [0x9b8f80, 0x6f6a64, 0xbfb3a0, 0x8c7a68, 0x5d6670])), R, 0.05);
  const P = K.A.plaster, M = K.A.metal;
  const frameC = lin(pick(R, [0x2e3236, 0x8f969c, 0x2e3236, 0x5b4636]));
  const units = clamp(Math.round(w / 8.5), 1, 4), uw = w / units;
  // front
  {
    const F = B.front, ops = [];
    const signs = [];
    for (let k = 0; k < units; k++) {
      const a = k * uw + 0.55, b = (k + 1) * uw - 0.55;
      ops.push({ a, b, lo: 0.35, hi: 3.05, dep: 0.3 });
      glazing(K, F, a, b, 0.35, 3.05, -0.25, frameC, R, { step: 1.5, transom: 2.55, door: true });
      const sw = Math.min(b - a - 0.2, 7.0), sh = 0.7;
      signs.push([(a + b) / 2, sw]);
      if (R() < 0.55) awning(K, F, a - 0.1, b + 0.1, 3.08, 1.3, 0.55, jit(lin(pick(R, AWNING_PAL)), R, 0.05));
      box(P, F, a - 0.2, b + 0.2, 0, 0.12, 0, 0.6, lin(0x8f8d88), NOBOT & ~BK);
    }
    if (floors > 1) {
      const n = Math.max(2, Math.round(w / 3.2)), bw = w / n;
      for (let i = 0; i < n; i++) winB(K, F, ops, (i + 0.5) * bw, gh + 0.85, Math.min(1.9, bw - 1.0), 1.65, R() < 0.6 ? lin(0xeeeeec) : frameC, R);
    }
    wall(F, w, [Z(P, 0, gh, gfCol, 3, 3), Z(P, gh, H + ph, wallCol, 4, 4)], ops);
    // sign band (fascia) and signs
    box(P, F, 0, w, 3.12, 3.18, 0, 0.12, mul(gfCol, 0.85), FR | TP | BT);
    const used = new Set();
    for (const [uc, sw] of signs) {
      let idx = (R() * SHOP_SIGNS) | 0; let tries = 0;
      while (used.has(idx) && tries++ < 8) idx = (idx + 1) % SHOP_SIGNS;
      used.add(idx);
      sign(K, F, uc, 3.22, sw, 0.72, 0.02, idx, lin(0x2a2c2e));
    }
  }
  // sides and back
  for (const [F, L, side] of B.sides) {
    if (side === 'front') continue;
    const ops = [];
    if (side === 'back') {
      door(K, F, ops, L * 0.25, 0.1, 1.1, 2.2, pick(R, DOOR_PAL));
      winA(K, F, ops, L * 0.6, 1.4, 1.2, 1.2, WHITE_F, R);
      if (L > 14) winA(K, F, ops, L * 0.8, 1.4, 1.2, 1.2, WHITE_F, R);
      K.I.ac.add(F, L * 0.42, 2.2, 0, 1, 1, 1, [0.95, 0.95, 0.93]);
      if (floors > 1) for (let i = 0; i < Math.round(L / 4); i++) winB(K, F, ops, (i + 0.5) * L / Math.round(L / 4), gh + 0.85, 1.6, 1.5, lin(0xeeeeec), R);
    } else if (floors > 1 && L > 10) {
      winB(K, F, ops, L / 2, gh + 0.85, 1.6, 1.5, lin(0xeeeeec), R);
    }
    wall(F, L, [Z(P, 0, gh, gfCol, 3, 3), Z(P, gh, H + ph, wallCol, 4, 4)], ops);
  }
  flatRoof(K, B, H, ph, mul(wallCol, 0.85), lin(0x5b5c5e), lin(0x9b9c9a));
  const RF = B.C;
  const na = 1 + (R() * 3 | 0);
  for (let k = 0; k < na; k++) K.I.ac.add(RF, (R() - 0.5) * (w - 4), H + 0.1, -d / 2 + 2 + R() * (d - 5), 1, 1, 1, [0.95, 0.95, 0.93]);
  box(P, RF, -1, 1, H, H + 1.1, -1, 1, lin(0x9c9a94), NOBOT);
  return H + ph;
}

let _col16 = null;
function columnGeo() { if (!_col16) _col16 = new THREE.CylinderGeometry(0.38, 0.42, 1, 18, 1, true).translate(0, 0.5, 0); return _col16; }

function genCampus(K, B, R) {
  const { w, d } = B, floors = B.floors, fh = 3.6, base = 0.6, H = base + floors * fh, ph = 1.0;
  const wallCol = B.color != null ? lin(B.color) : jit(lin(pick(R, [0xeee6d6, 0xe8dfcc, 0xf2eee6, 0xe4dccb])), R, 0.02);
  const accent = lin(pick(R, [0xb5643c, 0xa9553a, 0xb87a4b]));
  const plinth = lin(0x8b8478), frameC = lin(0x3a3f45), tint = [0.8, 0.95, 1.2];
  const P = K.A.plaster;
  const portW = clamp(w * 0.28, 10, 20);
  for (const [F, L, side] of B.sides) {
    const ops = [];
    const nb = Math.max(1, Math.round(L / 3.6)), bay = L / nb;
    const front = side === 'front', pa = L / 2 - portW / 2, pb = L / 2 + portW / 2;
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < nb; i++) {
        const uc = (i + 0.5) * bay;
        if (front && f < 2 && uc > pa - 0.5 && uc < pb + 0.5) continue;
        if (side === 'back' && f === 0 && i === Math.floor(nb / 2)) { door(K, F, ops, uc, base, 1.6, 2.4, lin(0x3b4650)); continue; }
        winB(K, F, ops, uc, yF + 0.75, Math.min(2.4, bay - 1.1), 2.3, frameC, R, tint);
      }
      // pilasters between bays
    }
    if (front) {
      ops.push({ a: pa + 0.4, b: pb - 0.4, lo: base, hi: base + 2 * fh - 0.7, dep: 0.4 });
      glazing(K, F, pa + 0.4, pb - 0.4, base, base + 2 * fh - 0.7, -0.35, frameC, R, { step: 1.8, transom: base + 3.0, door: true, tint: [0.55, 0.7, 0.85] });
    }
    wall(F, L, [Z(P, 0, base, plinth, 3, 3), Z(P, base, H + ph, wallCol, 4, 4)], ops);
    for (let i = 1; i < nb; i++) {
      const u = i * bay;
      const y0 = front && u > pa - 0.6 && u < pb + 0.6 ? base + 2 * fh + 0.6 : base;
      box(P, F, u - 0.32, u + 0.32, y0, H, 0, 0.3, mul(wallCol, 1.03), FR | LF | RT | (y0 > base ? BT : 0));
    }
    // corner pilasters (left end of each facade covers the corner)
    box(P, F, -0.3, 0.5, base, H, 0, 0.3, mul(wallCol, 1.03), FR | LF | RT);
    // cornice in accent colour
    box(P, F, 0, L + 0.4, H, H + ph, 0, 0.4, accent, FR | TP | BT | RT);
    box(P, F, 0, L + 0.3, H - 0.25, H, 0, 0.3, mul(accent, 0.85), FR | BT | RT);
    // plinth ledge
    box(P, F, 0, L + 0.08, base - 0.08, base, 0, 0.08, lin(0x9c968a), FR | TP | RT);
  }
  flatRoof(K, B, H + ph - 0.01, 0.01, mul(wallCol, 0.9), lin(0x5d5f61), lin(0xa0a19e), 0.4);
  // portico with columns
  {
    const F = B.front, uc = w / 2, pd = 5.2, ch = 2 * fh, top = base + ch;
    const ncols = portW > 15 ? 6 : 4, cg = columnGeo();
    for (let k = 0; k < ncols; k++) {
      const u = uc - portW / 2 + 0.8 + k * (portW - 1.6) / (ncols - 1);
      geom(P, F, cg, u, base + 0.35, pd - 0.7, mul(wallCol, 1.06), 1, ch - 0.65, 1);
      box(P, F, u - 0.55, u + 0.55, base, base + 0.35, pd - 1.25, pd - 0.15, lin(0xcfc8ba), NOBOT);
      box(P, F, u - 0.55, u + 0.55, top - 0.3, top, pd - 1.25, pd - 0.15, lin(0xcfc8ba), NOBOT | BT);
    }
    box(P, F, uc - portW / 2 - 0.4, uc + portW / 2 + 0.4, top, top + 1.1, 0, pd + 0.2, accent, ALL & ~BK);
    box(P, F, uc - portW / 2 - 0.5, uc + portW / 2 + 0.5, top + 1.1, top + 1.25, 0, pd + 0.3, mul(wallCol, 0.95), ALL & ~BK);
    // podium + steps
    box(P, F, uc - portW / 2 - 0.4, uc + portW / 2 + 0.4, 0, base, 0, pd + 0.2, lin(0xc9c3b6), NOBOT & ~BK);
    for (let s = 0; s < 3; s++) box(P, F, uc - portW / 2 + 0.5 + s * 0.3, uc + portW / 2 - 0.5 - s * 0.3, 0, base - (s + 1) * base / 3.5 + 0.0, pd + 0.2, pd + 0.2 + (3 - s) * 0.35, lin(0xbdb7aa), NOBOT & ~BK);
  }
  // roof: plant + rooftop sign
  const C = B.C, top = H + ph;
  box(P, C, -w * 0.15, w * 0.1, top, top + 2.6, -d / 2 + 2, -d / 2 + 2 + d * 0.35, lin(0xc9c6bf), NOBOT);
  K.I.ac.add(C, w * 0.25, top, -d / 2 + 2.5, 2.2, 2, 2.4, [0.85, 0.87, 0.88]);
  if (w >= 36) {
    const F = B.front, sw = clamp(w * 0.32, 10, 22), sh = sw / 10 * 1.0, n = -1.6, y0 = top + 0.5;
    const M = K.A.metal, mc = lin(0x5b6066);
    box(M, F, w / 2 - sw / 2, w / 2 + sw / 2, y0 + sh * 0.25, y0 + sh * 0.25 + 0.1, n - 0.25, n - 0.15, mc, ALL);
    box(M, F, w / 2 - sw / 2, w / 2 + sw / 2, y0 + sh * 0.75, y0 + sh * 0.75 + 0.1, n - 0.25, n - 0.15, mc, ALL);
    for (let k = 0; k <= 4; k++) {
      const u = w / 2 - sw / 2 + k * sw / 4;
      box(M, F, u - 0.06, u + 0.06, top, y0 + sh, n - 0.3, n - 0.15, mc, NOBOT);
      box(M, F, u - 0.05, u + 0.05, top, top + 0.08, n - 1.6, n - 0.15, mc, NOBOT);
    }
    const S = K.A.sign, [u0, v0, u1, v1] = signUV(SIGN_MANAS, 10);
    S.ensure(4, 6);
    const b = S.v, Pp = (u, y) => [F.ox + F.ux * u + F.nx * n, y, F.oz + F.uz * u + F.nz * n], c = [1, 1, 1];
    let p = Pp(w / 2 - sw / 2, y0); S.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u0, v0, c);
    p = Pp(w / 2 + sw / 2, y0); S.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u1, v0, c);
    p = Pp(w / 2 + sw / 2, y0 + sh); S.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u1, v1, c);
    p = Pp(w / 2 - sw / 2, y0 + sh); S.vert(p[0], p[1], p[2], F.nx, 0, F.nz, u0, v1, c);
    S.quadIdx(b);
  }
  return top;
}

function genHouse(K, B, R) {
  const { w, d } = B, floors = Math.min(2, B.floors), fh = 2.9, base = 0.5, Hw = base + floors * fh;
  const wallCol = B.color != null ? lin(B.color) : jit(lin(pick(R, HOUSE_PAL)), R, 0.04);
  const plinth = jit(lin(pick(R, [0x8d8a83, 0x7a6f66, 0x9b958c, 0x6c6c6c])), R, 0.05);
  const blueish = R() < 0.45;
  const frameC = blueish ? jit(lin(pick(R, [0x2f63a8, 0x3a7bbf, 0x2d6e5e])), R, 0.05) : jit(WHITE_F, R, 0.03);
  const surr = blueish ? frameC : R() < 0.5 ? jit(WHITE_F, R, 0.02) : mul(wallCol, 0.9);
  const roofCol = jit(lin(pick(R, ROOF_PAL)), R, 0.06);
  const P = K.A.plaster, M = K.A.metal;
  const ww = 1.25, wh = 1.4;
  const addSurround = (F, u, lo) => {
    const a = u - ww / 2, b = u + ww / 2, hi = lo + wh;
    box(P, F, a - 0.13, b + 0.13, hi, hi + 0.14, 0, 0.05, surr, FR | TP | BT | LF | RT);
    box(P, F, a - 0.2, b + 0.2, hi + 0.14, hi + 0.2, 0, 0.08, surr, FR | TP | BT | LF | RT);
    box(P, F, a - 0.13, a, lo - 0.02, hi, 0, 0.04, surr, FR | LF);
    box(P, F, b, b + 0.13, lo - 0.02, hi, 0, 0.04, surr, FR | RT);
  };
  for (const [F, L, side] of B.sides) {
    const ops = [], n = Math.max(1, Math.round(L / 3.4)), bay = L / n;
    const doorSlot = side === 'front' ? (n >= 3 ? (R() < 0.5 ? 1 : n - 2) : 0) : side === 'back' && R() < 0.5 ? n - 1 : -1;
    for (let f = 0; f < floors; f++) {
      const yF = base + f * fh;
      for (let i = 0; i < n; i++) {
        const uc = (i + 0.5) * bay;
        if (f === 0 && i === doorSlot) {
          door(K, F, ops, uc, base, 1.0, 2.1, pick(R, DOOR_PAL));
          box(P, F, uc - 1.0, uc + 1.0, 0, base, 0, 1.3, lin(0xa9a49a), NOBOT & ~BK);
          box(P, F, uc - 1.1, uc + 1.1, base + 2.45, base + 2.55, 0, 1.4, roofCol, ALL & ~BK);
          for (const s of [-1, 1]) box(M, F, uc + s * 0.95 - 0.04, uc + s * 0.95 + 0.04, base, base + 2.45, 1.25, 1.33, lin(0x3a3a3a), FR | BK | LF | RT);
          continue;
        }
        if (side !== 'front' && R() < 0.25) continue;
        const lo = yF + 0.8;
        winA(K, F, ops, uc, lo, ww, wh, frameC, R);
        addSurround(F, uc, lo);
      }
    }
    wall(F, L, [Z(P, 0, base, plinth, 2, 2), Z(P, base, Hw, wallCol, 4, 4)], ops);
    // drainpipe at the left corner
    box(M, F, 0.12, 0.22, 0, Hw, 0.05, 0.15, mul(roofCol, 0.9), FR | LF | RT);
  }
  // roof
  const gable = R() < 0.45, ov = 0.5, pitch = (24 + R() * 9) * Math.PI / 180, tp = Math.tan(pitch);
  const ye = Hw + 0.13 - ov * tp;
  face(P, B.C, 4, Hw, -w / 2, w / 2, -d / 2, d / 2, lin(0x6a6a68), 6, 6);
  const r = pitchedRoof(K, B, -w / 2 - ov, w / 2 + ov, -d / 2 - ov, d / 2 + ov, ye, pitch, roofCol, lin(0xe9e4d8), gable, ov, P, wallCol);
  // chimney
  {
    const along = r.alongX, a = (r.ra0 + r.ra1) / 2 + (R() - 0.5) * Math.max(0, r.ra1 - r.ra0) * 0.6, off = 0.6 + R() * 0.6;
    const x = along ? a : r.bc + off, z = along ? r.bc + off : a;
    const yb = r.yr - off * tp - 0.4;
    box(K.A.brick, B.C, x - 0.3, x + 0.3, yb, r.yr + 0.8, z - 0.3, z + 0.3, lin(0x9e5b42), NOBOT, 1.04, 1.0);
    box(P, B.C, x - 0.38, x + 0.38, r.yr + 0.8, r.yr + 0.88, z - 0.38, z + 0.38, lin(0x8a8783), ALL);
  }
  if (R() < 0.35) dish(K, B, w / 2 - 0.6, d / 2 - 0.2, Hw - 1.4);
  return r.yr;
}

const GEN = { panel: genPanel, brick: genBrick, office: genOffice, shop: genShop, campus: genCampus, house: genHouse };

/* =============================================================================================
 * public API
 * ============================================================================================= */
/**
 * Create a building kit. Call `add(spec)` for each building, then `finish()` once.
 * spec = { x, z, rotY = 0, w, d, floors, style, color?, seed } — footprint w (local X) × d (local Z) centred
 * at (x, z); main facade faces local +Z rotated by rotY. Styles: panel | brick | office | shop | campus | house.
 * @returns {{ add(spec: object): void, finish(): THREE.Group, count: number }}
 */
export function createBuildingKit() {
  const specs = [];
  let done = null;
  return {
    get count() { return specs.length; },
    add(spec) { if (!done && spec) specs.push({ ...spec }); },
    /**
     * Build everything: returns a Group of merged-by-material meshes + shared InstancedMeshes.
     * group.userData.heights[i] = roof height of the i-th added building.
     */
    finish() {
      if (done) return done;
      const mats = materials(), G = geos();
      const K = {
        A: { plaster: new Acc(1 << 16), panel: new Acc(1 << 16), brick: new Acc(1 << 15), roof: new Acc(1 << 12), metal: new Acc(1 << 15), glass: new Acc(1 << 14), sign: new Acc(256) },
        I: { winA: new Inst(), winAG: new Inst(), winB: new Inst(), winBG: new Inst(), door: new Inst(), balc: new Inst(), balcF: new Inst(), balcG: new Inst(), rail: new Inst(), ac: new Inst() },
      };
      const heights = [];
      for (const s of specs) {
        const gen = GEN[s.style] || genPanel;
        const R = mulberry32(((s.seed ?? 1) * 2654435761) ^ 0x5bd1e995);
        R(); R();
        heights.push(gen(K, context(s), R));
      }
      const group = new THREE.Group();
      group.name = 'buildings';
      const accMat = { plaster: mats.plaster, panel: mats.panel, brick: mats.brick, roof: mats.roof, metal: mats.metal, glass: mats.glass, sign: mats.sign };
      for (const k in K.A) {
        const A = K.A[k];
        if (!A.v) continue;
        const m = new THREE.Mesh(A.geometry(), accMat[k]);
        m.name = 'bld-' + k;
        // building glass is opaque (it closes the hollow shell), so it casts shadows too; signs do not
        m.castShadow = k !== 'sign'; m.receiveShadow = true;
        m.matrixAutoUpdate = false; m.updateMatrix();
        group.add(m);
      }
      const instMat = { winA: mats.frame, winAG: mats.winGlass, winB: mats.frame, winBG: mats.winGlass, door: mats.door, balc: mats.balc, balcF: mats.frame, balcG: mats.winGlass, rail: mats.balc, ac: mats.ac };
      for (const k in K.I) {
        const I = K.I[k];
        if (!I.n) continue;
        const im = new THREE.InstancedMesh(G[k], instMat[k], I.n);
        im.instanceMatrix = new THREE.InstancedBufferAttribute(I.m.slice(0, I.n * 16), 16);
        im.instanceColor = new THREE.InstancedBufferAttribute(I.c.slice(0, I.n * 3), 3);
        im.name = 'bld-' + k;
        im.castShadow = true; im.receiveShadow = true;
        im.matrixAutoUpdate = false;
        im.computeBoundingSphere();
        group.add(im);
      }
      group.userData.heights = heights;
      done = group;
      return group;
    },
  };
}

/* =============================================================================================
 * demo
 * ============================================================================================= */
/** Showcase: one building of each style in a row (fronts facing +Z) plus a dense mini-block behind. */
export function demo() {
  const kit = createBuildingKit();
  let x = -150;
  const row = [
    { style: 'panel', w: 48, d: 13, floors: 9 },
    { style: 'brick', w: 36, d: 12, floors: 5 },
    { style: 'office', w: 28, d: 20, floors: 12 },
    { style: 'shop', w: 24, d: 14, floors: 2 },
    { style: 'campus', w: 64, d: 22, floors: 4 },
    { style: 'house', w: 11, d: 9, floors: 2 },
  ];
  let seed = 11;
  for (const r of row) { kit.add({ ...r, x: x + r.w / 2, z: 0, rotY: 0, seed: seed++ }); x += r.w + 14; }
  // mini-block (courtyard) behind the row
  const bz = -90;
  kit.add({ style: 'panel', x: -60, z: bz + 30, w: 60, d: 13, floors: 9, rotY: 0, seed: 31 });
  kit.add({ style: 'panel', x: -60, z: bz - 30, w: 52, d: 13, floors: 9, rotY: Math.PI, seed: 32 });
  kit.add({ style: 'brick', x: -100, z: bz, w: 40, d: 12, floors: 5, rotY: -Math.PI / 2, seed: 33 });
  kit.add({ style: 'shop', x: -22, z: bz + 6, w: 20, d: 13, floors: 1, rotY: Math.PI / 2, seed: 34 });
  kit.add({ style: 'office', x: -20, z: bz - 18, w: 24, d: 20, floors: 16, rotY: Math.PI / 2, seed: 35 });
  for (let i = 0; i < 4; i++) kit.add({ style: 'house', x: 30 + i * 18, z: bz + 10, w: 10 + (i % 2) * 2, d: 9, floors: 1 + (i % 2), rotY: 0, seed: 40 + i });
  for (let i = 0; i < 4; i++) kit.add({ style: 'house', x: 30 + i * 18, z: bz - 14, w: 11, d: 8.5 + (i % 2), floors: 1 + ((i + 1) % 2), rotY: Math.PI, seed: 50 + i });
  return kit.finish();
}

/** Stress test (preview only): ~250 buildings laid out like the integrator's city; logs timing. */
export function demoStress() {
  const R0 = mulberry32(99), Rr = (a, b) => a + (b - a) * R0(), RI = (a, b) => Math.floor(Rr(a, b + 1)), pk = (a) => a[Math.floor(R0() * a.length)];
  const t0 = performance.now();
  const kit = createBuildingKit();
  const xInt = [[-520, -312], [-288, -12], [12, 168], [192, 378], [422, 640]];
  const zInt = [[-420, -192], [-168, -12], [12, 168], [192, 420]];
  let seed = 1, n = 0;
  const STY = {
    panel: () => ({ style: 'panel', w: Rr(42, 72), d: Rr(12, 14), floors: 9 }),
    brick: () => ({ style: 'brick', w: Rr(30, 56), d: Rr(11, 13), floors: RI(4, 5) }),
    office: () => ({ style: 'office', w: Rr(24, 36), d: Rr(18, 24), floors: RI(8, 16) }),
    shop: () => ({ style: 'shop', w: Rr(18, 30), d: Rr(12, 16), floors: RI(1, 2) }),
    tallpanel: () => ({ style: 'panel', w: Rr(30, 44), d: Rr(14, 16), floors: RI(12, 14) }),
  };
  const zoneStyle = { center: ['shop', 'shop', 'panel', 'panel', 'office', 'brick'], residential: ['panel', 'panel', 'brick', 'brick', 'tallpanel'], business: ['office', 'office', 'office', 'tallpanel', 'panel'] };
  const add = (b) => { kit.add({ ...b, seed: seed++ }); n++; };
  for (const [x0, x1] of xInt) for (const [z0, z1] of zInt) {
    if (x0 === -288 && z0 === 192) continue;
    if (x0 === -520) {
      for (let x = x0 + 14; x < x1 - 10; x += 26) for (let z = z0 + 14; z < z1 - 10; z += 30)
        add({ style: 'house', w: Rr(9, 13), d: Rr(8, 11), floors: RI(1, 2), x: x + Rr(-2, 2), z: z + Rr(-2, 2), rotY: R0() < 0.5 ? 0 : Math.PI });
      continue;
    }
    const zone = x0 >= 192 ? 'business' : (z0 === -168 || z0 === 12) && x0 > -300 && x1 < 200 ? 'center' : 'residential';
    const sides = [
      { along: 'x', from: x0, to: x1, edge: z1, out: 1, rotY: 0 }, { along: 'x', from: x0, to: x1, edge: z0, out: -1, rotY: Math.PI },
      { along: 'z', from: z0, to: z1, edge: x1, out: 1, rotY: Math.PI / 2 }, { along: 'z', from: z0, to: z1, edge: x0, out: -1, rotY: -Math.PI / 2 },
    ];
    for (const sd of sides) {
      const margin = sd.along === 'z' ? 23 : 3;
      let s = sd.from + margin + Rr(0, 6);
      const end = sd.to - margin;
      const onAvenue = zone === 'center' && sd.along === 'x' && Math.abs(sd.edge) < 20;
      while (s < end - 12) {
        const key = onAvenue && R0() < 0.55 ? 'shop' : pk(zoneStyle[zone]);
        const st = STY[key]();
        const w = Math.min(st.w, end - s);
        if (w < 12) break;
        const along = s + w / 2, inward = 3.5 + st.d / 2;
        add({ ...st, w, x: sd.along === 'x' ? along : sd.edge - sd.out * inward, z: sd.along === 'x' ? sd.edge - sd.out * inward : along, rotY: sd.rotY });
        s += w + Rr(8, 22);
      }
    }
  }
  add({ style: 'campus', x: -205, z: 226, w: 96, d: 24, floors: 4, rotY: 0 });
  add({ style: 'campus', x: -78, z: 228, w: 64, d: 22, floors: 5, rotY: 0 });
  add({ style: 'campus', x: -250, z: 386, w: 52, d: 20, floors: 3, rotY: Math.PI });
  add({ style: 'panel', x: -130, z: 398, w: 56, d: 13, floors: 5, rotY: Math.PI });
  add({ style: 'campus', x: -40, z: 392, w: 40, d: 20, floors: 4, rotY: Math.PI });
  const t1 = performance.now();
  const g = kit.finish();
  const t2 = performance.now();
  let tris = 0, inst = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    const t = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    tris += o.isInstancedMesh ? t * o.count : t;
    if (o.isInstancedMesh) inst += o.count;
  });
  console.warn(`[buildings] n=${n} add=${(t1 - t0).toFixed(0)}ms finish=${(t2 - t1).toFixed(0)}ms meshes=${g.children.length} instances=${inst} tris=${(tris / 1e6).toFixed(2)}M`);
  return g;
}
