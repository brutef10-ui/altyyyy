/**
 * nature.js — procedural vegetation kit (instanced trees / bushes, hedges, flower beds), lawns and the
 * snowy Ala-Too mountain backdrop for the SmartCross Bishkek presentation.
 *
 * Trees: one InstancedMesh per tree type (+1 for bushes, +1 merged mesh for hedges & flower beds).
 * Every type is generated in three shape variants with identical topology; the variants are stored as
 * morph targets and every instance gets its own blend of them (InstancedMesh.setMorphAt), so no two
 * trees look the same while the whole forest stays at a handful of draw calls.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ PRNG & noise */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash(i, j, k, s) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 1440662683) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** value noise in [-1, 1] */
function vnoise3(x, y, z, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const h = (a, b, c) => hash(xi + a, yi + b, zi + c, s);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
    l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v), w) * 2 - 1;
}
/** 2D gradient noise, roughly [-1, 1] */
function gnoise2(x, z, s = 0) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const g = (i, j, dx, dz) => { const a = hash(xi + i, zi + j, 7, s) * 6.283185307; return Math.cos(a) * dx + Math.sin(a) * dz; };
  const u = fade(xf), v = fade(zf);
  const a = g(0, 0, xf, zf), b = g(1, 0, xf - 1, zf), c = g(0, 1, xf, zf - 1), d = g(1, 1, xf - 1, zf - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}
function fbm2(x, z, oct, s) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * gnoise2(x * f, z * f, s + i * 17); norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}
function ridged2(x, z, oct, s) {
  let sum = 0, amp = 0.5, f = 1, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(gnoise2(x * f, z * f, s + i * 31));
    n *= n;
    sum += n * amp * (0.35 + 0.65 * prev); prev = n; norm += amp; amp *= 0.5; f *= 2.07;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ colours & materials */

const C3 = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

const MATS = {};
function vegMaterial() {
  return MATS.veg || (MATS.veg = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, name: 'vegetation' }));
}

/* ------------------------------------------------------------------ geometry builder */

class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.i = []; }
  get count() { return this.p.length / 3; }
  v(x, y, z, nx, ny, nz, col) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z); this.n.push(nx / l, ny / l, nz / l); this.c.push(col[0], col[1], col[2]);
    return this.count - 1;
  }
  t(a, b, c) { this.i.push(a, b, c); }
  /** triangle oriented so its face normal agrees with the averaged vertex normals */
  ta(a, b, c) {
    const P = this.p, N = this.n;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  /** append an indexed geometry with position/normal (and optional color or colour callback) */
  add(geo, colFn) {
    const base = this.count, pos = geo.attributes.position, nor = geo.attributes.normal, col = geo.attributes.color;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
      const c = colFn ? colFn(x, y, z, k) : col ? [col.getX(k), col.getY(k), col.getZ(k)] : [1, 1, 1];
      this.v(x, y, z, nor.getX(k), nor.getY(k), nor.getZ(k), c);
    }
    if (geo.index) for (let k = 0; k < geo.index.count; k++) this.i.push(base + geo.index.getX(k));
    else for (let k = 0; k < pos.count; k++) this.i.push(base + k);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const TPL = {};
/** unit icosphere as an indexed template (shared vertices -> smooth, cheap) */
function ico(detail) {
  if (!TPL[detail]) {
    let g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    g = mergeVertices(g);
    TPL[detail] = { pos: g.attributes.position.array, idx: g.index.array, n: g.attributes.position.count };
  }
  return TPL[detail];
}

/**
 * Leafy clump: a noise-displaced ellipsoidal icosphere whose normals are blended toward the normal of
 * the whole crown envelope (soft, volumetric crown shading). `col(x, y, z, nyLocal)` returns a colour.
 */
function blob(B, rng, o) {
  const t = ico(o.detail), base = B.count, ns = rng() * 50;
  const cr = Math.cos(o.rot || 0), sr = Math.sin(o.rot || 0), C = o.crown, blend = o.blend ?? 0.5;
  const fq = o.freq || 1.7;
  for (let k = 0; k < t.n; k++) {
    const px = t.pos[k * 3], py = t.pos[k * 3 + 1], pz = t.pos[k * 3 + 2];
    const d = 1 + o.disp * vnoise3(px * fq + ns, py * fq + ns * 0.7, pz * fq - ns, 3) + o.disp * 0.6 * (rng() - 0.5);
    const lx = px * d * o.rx, ly = py * d * o.ry + (o.sag ? -o.sag * (px * px + pz * pz) : 0), lz = pz * d * o.rz;
    const x = o.x + lx * cr - lz * sr, y = o.y + ly, z = o.z + lx * sr + lz * cr;
    let ex = px / o.rx, ey = py / o.ry, ez = pz / o.rz;
    let el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
    const rx = ex * cr - ez * sr, rz = ex * sr + ez * cr;
    let cx = (x - C.x) / (C.rx * C.rx), cy = (y - C.y) / (C.ry * C.ry), cz = (z - C.z) / (C.rz * C.rz);
    el = Math.hypot(cx, cy, cz) || 1; cx /= el; cy /= el; cz /= el;
    const nj = o.nj || 0;
    const nx = rx * (1 - blend) + cx * blend + nj * (rng() - 0.5), ny = ey * (1 - blend) + cy * blend + nj * (rng() - 0.5),
      nz = rz * (1 - blend) + cz * blend + nj * (rng() - 0.5);
    B.v(x, y, z, nx, ny, nz, o.col(x, y, z, ey, rng));
  }
  for (let k = 0; k < t.idx.length; k++) B.i.push(base + t.idx[k]);
}

/** tapered tube along a polyline of [x, y, z, r] points; col(y, ringIndex, k) */
function tube(B, pts, radial, col) {
  const base = B.count, n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    let l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(ty) > 0.92) { rx = 1; ry = 0; }
    let ux = ty * rz - tz * ry, uy = tz * rx - tx * rz, uz = tx * ry - ty * rx;
    l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    for (let k = 0; k < radial; k++) {
      const an = k / radial * Math.PI * 2, c = Math.cos(an), s = Math.sin(an);
      const dx = ux * c + vx * s, dy = uy * c + vy * s, dz = uz * c + vz * s;
      B.v(p[0] + dx * p[3], p[1] + dy * p[3], p[2] + dz * p[3], dx, dy, dz, col(p[1], i, k));
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < radial; k++) {
    const a = base + i * radial + k, b = base + i * radial + (k + 1) % radial, c = a + radial, d = b + radial;
    B.ta(a, b, c); B.ta(b, d, c);
  }
}

/* ------------------------------------------------------------------ tree species */

const WASH = C3(0xe8e6de);
const SPECIES = {
  poplar: {
    h: 21, r: 2.35, leaves: [0x41702d, 0x4f7f34, 0x385f28, 0x5d8a3c], inner: 0x1d3516,
    bark: 0x8b887c, wash: [1, 1, 0], tint: [0.08, 0.1, 0.07],
  },
  elm: {
    h: 10.5, trunkR: 0.27, fork: 3.0, cy: 6.9, rx: 4.1, ry: 3.4, limbs: 4, low: 2, core: 0.7, mid: 10, tufts: 36,
    clump: 0.34, tuft: 0.2, leaves: [0x46752d, 0x548234, 0x3d6828], inner: 0x1e3515,
    bark: 0x5f554b, wash: [1, 0, 1], tint: [0.08, 0.08, 0.07],
  },
  maple: {
    h: 12, trunkR: 0.28, fork: 2.8, cy: 7.6, rx: 4.4, ry: 4.2, limbs: 4, low: 2, core: 0.7, mid: 10, tufts: 36,
    clump: 0.34, tuft: 0.2, leaves: [0x568a33, 0x63963a, 0x4a7c2e], inner: 0x243f17,
    bark: 0x6d655c, wash: [0, 1, 0], tint: [0.1, 0.08, 0.07],
  },
  oak: {
    h: 14, trunkR: 0.46, fork: 3.2, cy: 8.8, rx: 6.0, ry: 4.6, limbs: 5, low: 2, core: 0.68, mid: 12, tufts: 36,
    clump: 0.34, tuft: 0.2, leaves: [0x3f6829, 0x4c7630, 0x365c24], inner: 0x1a2f12,
    bark: 0x584a3d, wash: [0, 0, 0], tint: [0.06, 0.07, 0.06],
  },
  birch: {
    h: 13.5, trunkR: 0.2, fork: 4.6, cy: 9.2, rx: 3.1, ry: 4.3, limbs: 4, low: 2, core: 0.58, mid: 10, tufts: 38,
    clump: 0.3, tuft: 0.17, leaves: [0x6f9c3e, 0x80aa47, 0x618f37], inner: 0x2e4a1b,
    bark: 0xe7e3d9, wash: [0, 0, 0], tint: [0.08, 0.06, 0.07], birch: true,
  },
  spruce: {
    h: 12.5, r: 2.4, needles: [0x2d4c35, 0x34573c], tips: [0x4b6f4e, 0x56795a], under: 0x16261a,
    bark: 0x5a4434, tint: [0.06, 0.06, 0.06],
  },
  bush: { leaves: [0x4a7830, 0x588636, 0x3f6b2a], inner: 0x1d3515, tint: [0.1, 0.08, 0.08] },
};
/** Tree type names accepted by addTree. */
export const TREE_TYPES = ['poplar', 'elm', 'maple', 'oak', 'spruce', 'birch'];

function barkFn(P, variant, rng) {
  const bark = C3(P.bark), dark = C3(0x2b2723), wash = P.wash && P.wash[variant];
  return (y) => {
    if (wash && y < 1.32) return mulc(WASH, 0.94 + 0.08 * rng());
    if (P.birch) {
      if (y < 0.9) return mulc(C3(0x6d655c), 0.8 + 0.3 * rng());
      return rng() < 0.3 ? mulc(dark, 0.8 + 0.5 * rng()) : mulc(bark, 0.88 + 0.14 * rng());
    }
    return mulc(bark, 0.82 + 0.3 * rng());
  };
}

function leafColFn(P, C, base, opts = {}) {
  const inner = C3(P.inner);
  const contrast = opts.contrast ?? 1;
  return (x, y, z, ny, rng) => {
    const dx = (x - C.x) / C.rx, dy = (y - C.y) / C.ry, dz = (z - C.z) / C.rz;
    const d = Math.min(1.15, Math.sqrt(dx * dx + dy * dy + dz * dz));
    let s = clamp(0.25 + 0.85 * d, 0, 1.05);
    let c = mixc(inner, base, Math.pow(s, contrast));
    let k = 0.86 + 0.22 * clamp(dy * 0.5 + 0.5);
    if (ny < 0) k *= 1 + 0.28 * ny;
    k *= 0.86 + 0.28 * rng();
    return mulc(c, k);
  };
}

function buildPoplar(variant, seed, laySeed) {
  const P = SPECIES.poplar, rng = mulberry32(seed), lay = mulberry32(laySeed), B = new Builder();
  const H = P.h * (0.96 + 0.08 * rng()) * [1.04, 0.95, 1][variant], R = P.r * (0.92 + 0.16 * rng()) * [0.9, 1.12, 1][variant];
  const y0 = 2.6 + rng() * 0.9, ch = H - y0;
  const lx = (rng() - 0.5) * 0.6, lz = (rng() - 0.5) * 0.6;
  const prof = t => R * (t < 0.28 ? 0.55 + 0.45 * Math.sin(t / 0.28 * Math.PI / 2) : 1 - Math.pow((t - 0.28) / 0.72, 1.5) * 0.93);
  const C = { x: lx * 0.42, y: y0 + ch * 0.42, z: lz * 0.42, rx: R * 1.1, ry: ch * 0.62, rz: R * 1.1 };
  const bark = barkFn(P, variant, rng);
  const tr = 0.3 + rng() * 0.05;
  tube(B, [
    [0, -0.4, 0, tr * 1.1], [0, 0.4, 0, tr * 1.04], [0, 1.28, 0, tr], [0, 1.36, 0, tr * 0.99],
    [lx * 0.05, y0, lz * 0.05, tr * 0.86], [lx * 0.4, y0 + ch * 0.4, lz * 0.4, tr * 0.55], [lx * 0.8, y0 + ch * 0.8, lz * 0.8, 0.06],
  ], 8, bark);
  // steep fastigiate branches, visible at the bottom of the crown
  for (let k = 0; k < 5; k++) {
    const a = k * 2.4 + lay() * 0.8, ys = y0 - 0.9 + k * 0.45 + rng() * 0.3;
    const out = 0.9 + rng() * 0.5, up = 3 + rng() * 2.5, ca = Math.cos(a), sa = Math.sin(a);
    tube(B, [[ca * 0.1, ys, sa * 0.1, 0.1], [ca * out * 0.7, ys + up * 0.45, sa * out * 0.7, 0.065], [ca * out, ys + up, sa * out, 0.02]], 5, bark);
  }
  const leaves = P.leaves.map(C3);
  // dense core column: a closed, noise-displaced spindle that unifies the crown
  const NR = 12, RAD = 9, cb = B.count, ns = rng() * 40, coreCol = leafColFn(P, C, mulc(leaves[2], 0.8));
  for (let i = 0; i <= NR; i++) {
    const ty = -0.03 + i / NR * 1.0;
    const r = i === 0 ? 0.28 : i === NR ? 0.05 : prof(clamp(ty)) * 0.74;
    const y = y0 + ty * ch - (i === 0 ? 0.35 : 0), ax = lx * ty, az = lz * ty;
    for (let k = 0; k < RAD; k++) {
      const a = k / RAD * 6.2832 + i * 0.4, ca = Math.cos(a), sa = Math.sin(a);
      const d = 1 + 0.2 * vnoise3(ca * 1.4 + ns, y * 0.5, sa * 1.4, 5);
      const x = ax + ca * r * d, z = az + sa * r * d;
      B.v(x, y, z, ca, i === 0 ? -1.5 : 0.2, sa, coreCol(x, y, z, i === 0 ? -1 : 0, rng));
    }
  }
  for (let i = 0; i < NR; i++) for (let k = 0; k < RAD; k++) {
    const a = cb + i * RAD + k, b = cb + i * RAD + (k + 1) % RAD;
    B.ta(a, b, a + RAD); B.ta(b, b + RAD, a + RAD);
  }
  // leafy tufts, vertically stretched (fastigiate branchlets) covering the column
  const NT = 46, rot0 = lay() * 6.28;
  for (let i = 0; i < NT; i++) {
    const t = Math.min(0.995, (i + 0.15 + lay() * 0.7) / NT), r = prof(t), a = rot0 + i * 2.39996 + (lay() - 0.5) * 0.6;
    const off = r * (0.6 + 0.22 * rng()), sz = 0.36 * r + 0.3;
    const base = mixc(leaves[(i + variant) % 4], leaves[(i * 3 + 1) % 4], rng());
    blob(B, rng, {
      detail: 0, x: lx * t + Math.cos(a) * off, y: y0 + t * ch, z: lz * t + Math.sin(a) * off,
      rx: sz * (0.85 + 0.3 * rng()), ry: sz * (1.45 + 0.6 * rng()), rz: sz * (0.85 + 0.3 * rng()), rot: lay() * 6.28,
      disp: 0.3, crown: C, blend: 0.62, nj: 0.4, col: leafColFn(P, C, base),
    });
  }
  return B;
}

function buildBroadleaf(type, variant, seed, laySeed) {
  const P = SPECIES[type], rng = mulberry32(seed), lay = mulberry32(laySeed), B = new Builder();
  const v = (a) => a * (0.9 + 0.2 * rng());
  const vx = [1, 1.12, 0.92][variant], vy = [1, 0.9, 1.08][variant];
  const C = { x: (rng() - 0.5) * 0.7, y: v(P.cy) * (0.5 + 0.5 * vy), z: (rng() - 0.5) * 0.7, rx: v(P.rx) * vx, ry: v(P.ry) * vy, rz: v(P.rx) * vx };
  const fork = v(P.fork), tr = v(P.trunkR);
  const bark = barkFn(P, variant, rng);
  const F = [C.x * 0.35 + (rng() - 0.5) * 0.3, fork, C.z * 0.35 + (rng() - 0.5) * 0.3];
  tube(B, [
    [0, -0.4, 0, tr * 1.18], [0, 0.35, 0, tr * 1.08], [0, 1.28, 0, tr], [0, 1.36, 0, tr * 0.99],
    [F[0] * 0.6, fork * 0.7, F[2] * 0.6, tr * 0.93], [F[0], F[1], F[2], tr * 0.82],
    [C.x, C.y, C.z, tr * 0.42], [C.x * 1.1, C.y + C.ry * (P.birch ? 0.8 : 0.5), C.z * 1.1, 0.05],
  ], P.birch ? 7 : 8, bark);
  const la = lay() * 6.28;
  for (let k = 0; k < P.limbs; k++) {
    const a = la + k / P.limbs * 6.28 + (lay() - 0.5) * 0.7, ca = Math.cos(a), sa = Math.sin(a);
    const ex = C.x + ca * C.rx * (0.55 + 0.2 * rng()), ey = C.y + C.ry * (-0.1 + 0.4 * rng()), ez = C.z + sa * C.rz * (0.55 + 0.2 * rng());
    tube(B, [
      [F[0], F[1] - 0.2, F[2], tr * 0.55],
      [F[0] + (ex - F[0]) * 0.45, F[1] + (ey - F[1]) * 0.62, F[2] + (ez - F[2]) * 0.45, tr * 0.36],
      [ex, ey, ez, 0.05],
    ], 5, bark);
  }
  const leaves = P.leaves.map(C3);
  // a couple of low, visible branches below the crown with a leafy tip
  for (let k = 0; k < P.low; k++) {
    const a = la + 1.1 + k * 3.3 + lay() * 0.8, ca = Math.cos(a), sa = Math.sin(a);
    const ys = fork * (0.62 + 0.18 * rng());
    const ex = ca * C.rx * 0.84, ez = sa * C.rz * 0.84, ey = C.y - C.ry * (0.55 + 0.15 * rng());
    tube(B, [[ca * 0.1, ys, sa * 0.1, tr * 0.32], [ex * 0.55, ys + (ey - ys) * 0.75, ez * 0.55, tr * 0.2], [ex, ey, ez, 0.03]], 5, bark);
    blob(B, rng, {
      detail: 0, x: ex, y: ey + 0.2, z: ez, rx: 0.8, ry: 0.55, rz: 0.8, rot: lay() * 6.28, disp: 0.3,
      crown: C, blend: 0.4, nj: 0.3, col: leafColFn(P, C, leaves[k % leaves.length]),
    });
  }
  const mr = (C.rx + C.ry) / 2, rot0 = lay() * 6.28;
  // inner core mass (darker) closes the crown
  blob(B, rng, {
    detail: 1, x: C.x, y: C.y - C.ry * 0.04, z: C.z, rx: C.rx * P.core, ry: C.ry * P.core * 0.92, rz: C.rz * P.core, rot: lay() * 6.28,
    disp: 0.22, crown: C, blend: 0.65, nj: 0.2, col: leafColFn(P, C, mulc(leaves[2], 0.85)),
  });
  // mid-layer clumps
  for (let i = 0; i < P.mid; i++) {
    const yN = 0.9 - (i + 0.5) / P.mid * 1.55, rr = Math.sqrt(Math.max(0, 1 - yN * yN)), a = rot0 + i * 2.39996 + (lay() - 0.5) * 0.5;
    const f = 0.56 + 0.1 * rng(), cs = P.clump * mr * (0.8 + 0.4 * rng());
    blob(B, rng, {
      detail: 0, x: C.x + Math.cos(a) * rr * f * C.rx, y: C.y + yN * f * C.ry, z: C.z + Math.sin(a) * rr * f * C.rz,
      rx: cs, ry: cs * 0.85, rz: cs * (0.85 + 0.3 * rng()), rot: lay() * 6.28, disp: 0.3, crown: C, blend: 0.6, nj: 0.3,
      col: leafColFn(P, C, mixc(leaves[i % 3], leaves[(i + 1) % 3], rng())),
    });
  }
  // outer leafy tufts on the envelope (silhouette and leafy texture)
  for (let i = 0; i < P.tufts; i++) {
    let yN = 1 - (i + 0.5) / P.tufts * 1.72;
    const rr = Math.sqrt(Math.max(0, 1 - yN * yN)), a = rot0 + 1.1 + i * 2.39996 + (lay() - 0.5) * 0.5;
    if (yN < -0.35) yN = -0.35 + (yN + 0.35) * 0.6;     // flatter underside
    const f = 0.84 + 0.16 * rng(), cs = P.tuft * mr * (0.75 + 0.5 * rng());
    const base = mulc(mixc(leaves[(i + variant) % 3], leaves[(i * 2 + 1) % 3], rng()), 1.04 + 0.1 * rng());
    blob(B, rng, {
      detail: 0, x: C.x + Math.cos(a) * rr * f * C.rx, y: C.y + yN * f * C.ry, z: C.z + Math.sin(a) * rr * f * C.rz,
      rx: cs * (0.85 + 0.3 * rng()), ry: cs * (P.birch ? 1.5 : 0.8), rz: cs * (0.85 + 0.3 * rng()), rot: lay() * 6.28,
      disp: 0.3, sag: P.birch ? 0.3 * cs : 0, crown: C, blend: 0.6, nj: 0.4, col: leafColFn(P, C, base),
    });
  }
  return B;
}

function buildSpruce(variant, seed, laySeed) {
  const P = SPECIES.spruce, rng = mulberry32(seed), lay = mulberry32(laySeed), B = new Builder();
  const H = P.h * (0.92 + 0.16 * rng()), R0 = P.r * (0.88 + 0.24 * rng());
  const bark = barkFn(P, variant, rng);
  tube(B, [[0, -0.3, 0, 0.26], [0, 1.0, 0, 0.21], [0, H * 0.5, 0, 0.13], [0, H * 0.93, 0, 0.03]], 7, bark);
  const N = 13, K = 11;
  const needles = P.needles.map(C3), tips = P.tips.map(C3), under = C3(P.under);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const yb = 1.0 + t * (H - 2.4) + (rng() - 0.5) * 0.2;
    const hT = 2.3 * (1 - 0.5 * t) + 0.5;
    const r = R0 * Math.pow(1 - t, 0.9) * (0.9 + 0.2 * rng()) + 0.3;
    const apex = yb + hT, rot = lay() * 6.28;
    const ox = (rng() - 0.5) * 0.12, oz = (rng() - 0.5) * 0.12;
    const cn = mixc(needles[0], needles[1], rng()), ct = mixc(tips[0], tips[1], rng());
    const shade = 0.75 + 0.3 * t;
    const A = B.v(ox, apex, oz, 0, 1, 0, mulc(cn, shade * 1.05));
    const r1 = [], r2 = [], r3 = [];
    for (let k = 0; k < K; k++) {
      const a = rot + k / K * 6.2832 + (lay() - 0.5) * 0.25, ca = Math.cos(a), sa = Math.sin(a);
      const j = 0.85 + 0.3 * rng();
      r1.push(B.v(ox + ca * r * 0.5 * j, apex - hT * 0.5, oz + sa * r * 0.5 * j, ca, 0.9, sa, mulc(cn, shade * (0.85 + 0.2 * rng()))));
      const tip = k % 2 === 0 ? 1 : 0.8;
      r2.push(B.v(ox + ca * r * tip * j, yb - (k % 2 === 0 ? 0.32 : 0.1) * hT, oz + sa * r * tip * j, ca, 0.3, sa,
        mulc(ct, shade * (0.85 + 0.3 * rng()))));
      r3.push(B.v(ox + ca * r * 0.28, yb + hT * 0.28, oz + sa * r * 0.28, ca * 0.3, -1, sa * 0.3, mulc(under, 0.9 + 0.2 * rng())));
    }
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      B.ta(A, r1[k], r1[k2]);
      B.ta(r1[k], r2[k], r1[k2]); B.ta(r1[k2], r2[k], r2[k2]);
      B.ta(r2[k], r3[k], r2[k2]); B.ta(r2[k2], r3[k], r3[k2]);
    }
  }
  // leader spire
  const ct = C3(P.tips[0]);
  const A = B.v(0, H + 0.6, 0, 0, 1, 0, ct), ring = [];
  for (let k = 0; k < 5; k++) { const a = k / 5 * 6.28; ring.push(B.v(Math.cos(a) * 0.22, H - 0.9, Math.sin(a) * 0.22, Math.cos(a), 0.4, Math.sin(a), ct)); }
  for (let k = 0; k < 5; k++) B.ta(A, ring[k], ring[(k + 1) % 5]);
  return B;
}

function buildBush(variant, seed, laySeed) {
  const P = SPECIES.bush, rng = mulberry32(seed), lay = mulberry32(laySeed), B = new Builder();
  const C = { x: 0, y: 0.55, z: 0, rx: 0.95 + 0.15 * rng(), ry: 0.72, rz: 0.85 + 0.15 * rng() };
  const leaves = P.leaves.map(C3);
  blob(B, rng, { detail: 1, x: 0, y: 0.42, z: 0, rx: C.rx * 0.8, ry: 0.55, rz: C.rz * 0.8, disp: 0.25, crown: C, blend: 0.6, nj: 0.2, col: leafColFn(P, C, mulc(leaves[2], 0.85)) });
  const NT = 18, rot0 = lay() * 6.28;
  for (let i = 0; i < NT; i++) {
    const yN = 0.95 - (i + 0.5) / NT * 1.25, rr = Math.sqrt(Math.max(0, 1 - yN * yN)), a = rot0 + i * 2.39996 + (lay() - 0.5) * 0.5;
    const f = 0.8 + 0.2 * rng(), cs = 0.3 + 0.12 * rng();
    blob(B, rng, {
      detail: 0, x: Math.cos(a) * rr * f * C.rx, y: C.y + yN * f * C.ry * 0.95, z: Math.sin(a) * rr * f * C.rz,
      rx: cs, ry: cs * 0.85, rz: cs, rot: lay() * 6.28, disp: 0.3, crown: C, blend: 0.55, nj: 0.35,
      col: leafColFn(P, C, mulc(mixc(leaves[i % 3], leaves[(i + 1) % 3], rng()), 1.05)),
    });
  }
  return B;
}

const GEO = {};
const VARIANT_SEEDS = [1013, 2027, 3061];
/** geometry for a vegetation type: variant A as base, B and C as absolute morph targets */
function typeGeometry(type) {
  if (GEO[type]) return GEO[type];
  const build = (v) => {
    // shape seed differs per variant; layout seed (angles, rotations) is shared so that blending the
    // variants per instance never pulls clumps across the crown
    const s = VARIANT_SEEDS[v] + type.length * 101, ls = 4243 + type.charCodeAt(0) * 37 + type.length;
    if (type === 'poplar') return buildPoplar(v, s, ls);
    if (type === 'spruce') return buildSpruce(v, s, ls);
    if (type === 'bush') return buildBush(v, s, ls);
    return buildBroadleaf(type, v, s, ls);
  };
  const vs = [0, 1, 2].map(build);
  const g = vs[0].geometry();
  const okTopo = vs.every(b => b.count === vs[0].count);
  if (okTopo) {
    g.morphAttributes.position = vs.slice(1).map(b => new THREE.Float32BufferAttribute(b.p, 3));
    g.morphAttributes.normal = vs.slice(1).map(b => new THREE.Float32BufferAttribute(b.n, 3));
    g.morphAttributes.color = vs.slice(1).map(b => new THREE.Float32BufferAttribute(b.c, 3));
    g.morphTargetsRelative = false;
    // bounding volumes must enclose every variant
    const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
    for (const b of vs.slice(1)) box.union(new THREE.Box3().setFromBufferAttribute(new THREE.Float32BufferAttribute(b.p, 3)));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  }
  g.userData.morph = okTopo;
  GEO[type] = g;
  return g;
}

/* ------------------------------------------------------------------ hedges & flower beds */

function buildHedge(B, x1, z1, x2, z2, h, seed) {
  const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
  if (len < 0.1) return;
  const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
  const W = 0.95, bev = Math.min(0.24, h * 0.25);
  // cross-section profile: [across, up, normal across, normal up]
  const prof = [
    [-W / 2 - 0.02, -0.05, -1, -0.1], [-W / 2, h * 0.3, -1, 0], [-W / 2 + 0.005, h * 0.6, -1, 0.05], [-W / 2 + 0.01, h - bev, -1, 0.25],
    [-W / 2 + bev * 0.3, h - bev * 0.3, -0.7, 0.7], [-W / 2 + bev, h, -0.15, 1], [-W / 4, h + 0.015, 0, 1], [0, h + 0.02, 0, 1],
  ];
  for (let i = prof.length - 1; i >= 0; i--) { const p = prof[i]; if (p[0] !== 0) prof.push([-p[0], p[1], -p[2], p[3]]); }
  const steps = Math.max(2, Math.ceil(len / 0.2)), np = prof.length;
  const g1 = C3(0x4a7a2f), g2 = C3(0x3c6826), g3 = C3(0x5f8d38), dark = C3(0x1f3a16);
  const geo = new THREE.BufferGeometry(), P = [], Cc = [], I = [];
  const vert = (s, t, bulge) => {
    const p = prof[s], px = x1 + ux * t + nx * p[0], pz = z1 + uz * t + nz * p[0];
    let wx = nx * p[2], wz = nz * p[2], wy = p[3];
    const l = Math.hypot(wx, wy, wz); wx /= l; wy /= l; wz /= l;
    const n1 = vnoise3(px * 2.3, p[1] * 2.3, pz * 2.3, seed), n2 = vnoise3(px * 6.1, p[1] * 6.1, pz * 6.1, seed + 1);
    const n4 = vnoise3(px * 12.5, p[1] * 12.5, pz * 12.5, seed + 3);
    const d = (p[1] < 0 ? 0 : 0.06 * n1 + 0.035 * n2 + 0.022 * n4) - bulge;
    P.push(px + wx * d, p[1] + wy * d, pz + wz * d);
    const n3 = vnoise3(px * 0.8, p[1], pz * 0.8, seed + 2) * 0.5 + 0.5;
    let c = mixc(mixc(g2, g1, n3), g3, clamp(n2 * 0.6 + 0.3 + (p[3] > 0.5 ? 0.35 : 0)));
    c = mixc(dark, c, 0.45 + 0.55 * smooth(-0.05, h * 0.55, p[1]));
    c = mulc(c, (0.86 + 0.2 * (n1 * 0.5 + 0.5)) * (0.84 + 0.3 * (n4 * 0.5 + 0.5)));
    Cc.push(c[0], c[1], c[2]);
  };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * len;
    const endb = Math.max(0, 0.12 - Math.min(t, len - t)) * 0.8; // rounded-off ends
    for (let s = 0; s < np; s++) vert(s, t, endb);
  }
  for (let i = 0; i < steps; i++) for (let s = 0; s < np - 1; s++) {
    const a = i * np + s, b = a + 1, c = a + np, d = c + 1;
    I.push(a, c, b, b, c, d);
  }
  // end caps
  for (const [t, flip] of [[0, false], [len, true]]) {
    const base = P.length / 3, cx = x1 + ux * t, cz = z1 + uz * t;
    P.push(cx, h * 0.5, cz); const c = mulc(g2, 0.9); Cc.push(c[0], c[1], c[2]);
    const ring = t === 0 ? 0 : steps * np;
    for (let s = 0; s < np - 1; s++) { if (flip) I.push(base, ring + s, ring + s + 1); else I.push(base, ring + s + 1, ring + s); }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  // orientation sanity: the side faces must point outward; if the computed normal at the first side vertex
  // points inward, flip all triangles
  const nAttr = geo.attributes.normal;
  if (nAttr.getX(1) * nx + nAttr.getZ(1) * nz > 0) {
    const idx = geo.index.array; for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    geo.computeVertexNormals();
  }
  B.add(geo);
}

function boxInto(B, cx, cy, cz, sx, sy, sz, col, rng) {
  const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(cx, cy, cz);
  B.add(g, () => mulc(col, 0.92 + 0.12 * rng()));
}

function buildFlowerBed(B, x, z, w, d, seed) {
  const rng = mulberry32(seed);
  const curb = C3(0xc9c4b8), soil = C3(0x3b2a1e), H = 0.26, T = 0.14;
  boxInto(B, x, H / 2 - 0.05, z - d / 2 + T / 2, w, H + 0.1, T, curb, rng);
  boxInto(B, x, H / 2 - 0.05, z + d / 2 - T / 2, w, H + 0.1, T, curb, rng);
  boxInto(B, x - w / 2 + T / 2, H / 2 - 0.05, z, T, H + 0.1, d - 2 * T, curb, rng);
  boxInto(B, x + w / 2 - T / 2, H / 2 - 0.05, z, T, H + 0.1, d - 2 * T, curb, rng);
  boxInto(B, x, 0.08, z, w - 2 * T, 0.2, d - 2 * T, soil, rng);
  const silver = C3(0xaab5a6), leaf = C3(0x3d6a29), orange = C3(0xf08a12), yellow = C3(0xf4c21f);
  const red = C3(0xd3251c), purple = C3(0x8e3aa8), pink = C3(0xe36aa6), white = C3(0xf1ece6);
  const sp = 0.36, iw = w - 2 * T - 0.1, id = d - 2 * T - 0.1;
  const nx = Math.max(1, Math.floor(iw / sp)), nz = Math.max(1, Math.floor(id / sp));
  const tpl = ico(0);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const u = (i + 0.5) / nx, v = (j + 0.5) / nz;
    const lx = (u - 0.5) * iw + (rng() - 0.5) * 0.12, lz = (v - 0.5) * id + (rng() - 0.5) * 0.12;
    const e = Math.min(u * iw, (1 - u) * iw, v * id, (1 - v) * id);
    let bloom, foliage = leaf, r = 0.19 + rng() * 0.05;
    if (e < 0.45) { bloom = null; foliage = silver; r *= 0.95; }
    else if (e < 0.95) bloom = vnoise3(lx * 0.8, 0, lz * 0.8, seed) > 0 ? orange : yellow;
    else {
      const wv = Math.sin(lx * 0.75 + Math.sin(lz * 1.1) * 1.6);
      bloom = wv > 0.3 ? red : wv < -0.3 ? purple : (vnoise3(lx * 2, 1, lz * 2, seed) > 0 ? white : pink);
    }
    const cx = x + lx, cz = z + lz, cy = 0.27 + rng() * 0.05, base = B.count;
    for (let k = 0; k < tpl.n; k++) {
      const px = tpl.pos[k * 3], py = tpl.pos[k * 3 + 1], pz = tpl.pos[k * 3 + 2];
      const dd = 1 + 0.25 * (rng() - 0.5);
      let c = bloom && py > -0.1 ? mulc(bloom, 0.85 + 0.25 * rng()) : mulc(foliage, (py < 0 ? 0.7 : 1) * (0.85 + 0.25 * rng()));
      B.v(cx + px * r * dd, cy + py * r * 0.7 * dd, cz + pz * r * dd, px, py + 0.5, pz, c);
    }
    for (let k = 0; k < tpl.idx.length; k++) B.i.push(base + tpl.idx[k]);
  }
}

/* ------------------------------------------------------------------ the kit */

/**
 * Vegetation kit. Collect placements, then call finish() once.
 * @returns {{ addTree(x:number, z:number, o:{type:string, scale?:number, seed?:number}):void,
 *   addBush(x:number, z:number, o?:{scale?:number}):void,
 *   addHedge(x1:number, z1:number, x2:number, z2:number, o?:{height?:number}):void,
 *   addFlowerBed(x:number, z:number, w:number, d:number):void,
 *   finish():THREE.Group }}
 */
export function createVegetationKit() {
  const lists = {}; // type -> [{x, z, s, seed}]
  const hedges = [], beds = [];
  let auto = 1;
  const push = (type, x, z, s, seed) => (lists[type] || (lists[type] = [])).push({ x, z, s, seed });
  return {
    /** add a tree at (x, z); type ∈ TREE_TYPES */
    addTree(x, z, { type = 'elm', scale = 1, seed } = {}) {
      if (!SPECIES[type] || type === 'bush') type = 'elm';
      push(type, x, z, scale, seed ?? (auto++ * 7919));
    },
    /** add a bush at (x, z) */
    addBush(x, z, { scale = 1, seed } = {}) {
      push('bush', x, z, scale, seed ?? ((Math.round(x * 13.7) * 92821) ^ (Math.round(z * 7.3) * 68917) ^ auto++));
    },
    /** trimmed hedge from (x1, z1) to (x2, z2) */
    addHedge(x1, z1, x2, z2, { height = 1.1 } = {}) { hedges.push([x1, z1, x2, z2, height]); },
    /** raised flower bed centred at (x, z), w along X, d along Z */
    addFlowerBed(x, z, w, d) { beds.push([x, z, w, d]); },
    /** build all instanced / merged meshes */
    finish() {
      const group = new THREE.Group();
      group.name = 'Vegetation';
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const col = new THREE.Color(), morph = { morphTargetInfluences: [0, 0] };
      for (const type of Object.keys(lists)) {
        const list = lists[type], P = SPECIES[type], geo = typeGeometry(type);
        const mesh = new THREE.InstancedMesh(geo, vegMaterial(), list.length);
        mesh.name = 'veg-' + type;
        list.forEach((it, i) => {
          const rng = mulberry32(it.seed * 31 + type.length);
          const sy = it.s * (0.9 + 0.2 * rng()), sxz = it.s * (0.88 + 0.24 * rng());
          const tilt = type === 'poplar' || type === 'spruce' ? 0.02 : 0.045;
          e.set((rng() - 0.5) * tilt, rng() * Math.PI * 2, (rng() - 0.5) * tilt, 'YXZ');
          q.setFromEuler(e); p.set(it.x, 0, it.z); s.set(sxz, sy, sxz * (0.92 + 0.16 * rng()));
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
          const [th, ts, tl] = P.tint;
          col.setRGB(1, 1, 1);
          const hs = (rng() - 0.5) * 2 * th, ls = 1 + (rng() - 0.5) * 2 * tl;
          col.setRGB(ls * (1 + hs * 0.9), ls * (1 + (rng() - 0.5) * ts * 0.5), ls * (1 - hs * 0.6));
          mesh.setColorAt(i, col);
          if (geo.userData.morph) {
            let a = rng(), b = rng();
            if (a + b > 1) { a = 1 - a; b = 1 - b; }
            morph.morphTargetInfluences[0] = a; morph.morphTargetInfluences[1] = b;
            mesh.setMorphAt(i, morph);
          }
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (mesh.morphTexture) mesh.morphTexture.needsUpdate = true;
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      if (hedges.length || beds.length) {
        const B = new Builder();
        hedges.forEach((hd, i) => buildHedge(B, hd[0], hd[1], hd[2], hd[3], hd[4], 50 + i));
        beds.forEach((b, i) => buildFlowerBed(B, b[0], b[1], b[2], b[3], 900 + i));
        const mesh = new THREE.Mesh(B.geometry(), vegMaterial());
        mesh.name = 'veg-hedges-flowerbeds';
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
      }
      return group;
    },
  };
}

/* ------------------------------------------------------------------ lawn */

function lawnTexture() {
  if (MATS.lawnTex) return MATS.lawnTex;
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d'), rng = mulberry32(77);
  g.fillStyle = 'rgb(214,218,206)'; g.fillRect(0, 0, S, S);
  // soft blotches
  for (let i = 0; i < 260; i++) {
    const x = rng() * S, y = rng() * S, r = 6 + rng() * 26, l = 190 + rng() * 60;
    g.fillStyle = `rgba(${l | 0},${(l + 8) | 0},${(l - 20) | 0},0.18)`;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.beginPath(); g.arc(x + ox, y + oy, r, 0, 6.283); g.fill(); }
  }
  // blades
  g.lineCap = 'round';
  for (let i = 0; i < 14000; i++) {
    const x = rng() * S, y = rng() * S, a = rng() * 6.283, len = 2 + rng() * 5;
    const l = rng();
    g.strokeStyle = l < 0.45 ? `rgba(120,140,100,${0.25 + rng() * 0.3})` : l < 0.9 ? `rgba(250,255,225,${0.2 + rng() * 0.35})` : `rgba(150,120,80,0.35)`;
    g.lineWidth = 0.8 + rng() * 1.2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  MATS.lawnTex = tex;
  return tex;
}

/**
 * Grass ground patch centred at the origin, top at y = 0.02, with subtle procedural colour variation.
 * @param {number} w size along X (m)
 * @param {number} d size along Z (m)
 * @param {{seed?:number}} [o]
 * @returns {THREE.Mesh}
 */
export function createLawn(w, d, { seed = 1 } = {}) {
  const sx = Math.max(1, Math.ceil(w / 6)), sz = Math.max(1, Math.ceil(d / 6));
  const geo = new THREE.PlaneGeometry(w, d, sx, sz);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.02, 0);
  const pos = geo.attributes.position, uv = geo.attributes.uv, cols = new Float32Array(pos.count * 3);
  const lush = C3(0x5b873a), mid = C3(0x6b8a42), dry = C3(0x8f8b56), deep = C3(0x47702f);
  const so = (seed * 37.17) % 1000;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    uv.setXY(i, x / 4.5, z / 4.5);
    const n1 = fbm2(x / 38 + so, z / 38, 3, 5), n2 = fbm2(x / 11 + so, z / 11, 2, 9), n3 = fbm2(x / 70 - so, z / 70, 2, 13);
    let c = mixc(lush, mid, clamp(0.5 + n1 * 0.9));
    c = mixc(c, deep, clamp(n2 * 1.1));
    c = mixc(c, dry, smooth(0.15, 0.55, n3) * 0.7);
    const edge = Math.min(w / 2 - Math.abs(x), d / 2 - Math.abs(z));
    c = mulc(c, 1 - 0.1 * (1 - smooth(0, 3, edge)));
    cols.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const mat = MATS.lawn || (MATS.lawn = new THREE.MeshStandardMaterial({ map: lawnTexture(), vertexColors: true, roughness: 0.96, metalness: 0, name: 'lawn' }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'lawn';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ mountains */

/**
 * Snowy Ala-Too range on the far southern horizon, already in world coordinates
 * (z ≈ +1750 … +2800, x ≈ −3400 … +3400, peaks 350–700 m). Lighting and aerial perspective are baked into
 * vertex colours (unlit, fog-free, not tone-mapped) so the range reads crisp and bright against the sky.
 * @returns {THREE.Group}
 */
export function createMountains() {
  const X0 = -3400, X1 = 3400, Z0 = 1720, Z1 = 2800, DX = 16, DZ = 15;
  const nx = Math.round((X1 - X0) / DX), nz = Math.round((Z1 - Z0) / DZ);
  const W = nx + 1, Hn = nz + 1;
  const hts = new Float32Array(W * Hn), env = new Float32Array(W * Hn);
  const height = (x, z) => {
    const crestZ = 2230 + 120 * gnoise2(x / 1100, 0.3, 11) + 45 * gnoise2(x / 380, 1.7, 12);
    const crestH = 330 + 330 * clamp(0.5 + 0.7 * gnoise2(x / 1250, 0.5, 13) + 0.3 * gnoise2(x / 430, 2.1, 14));
    const dz = z - crestZ;
    const prof = Math.exp(-Math.pow(Math.abs(dz) / (dz < 0 ? 320 : 420), 1.7));
    const r = ridged2(x / 330 + 0.5 * fbm2(x / 900, z / 900, 2, 3), z / 520, 5, 21);
    const main = crestH * prof * (0.42 + 0.75 * r);
    const fz = 1930 + 50 * gnoise2(x / 700, 3.3, 15);
    const fH = 110 + 90 * (0.5 + 0.5 * gnoise2(x / 600, 4.4, 16));
    const front = fH * Math.exp(-Math.pow((z - fz) / 140, 2)) * (0.55 + 0.6 * ridged2(x / 260, z / 260, 4, 31));
    const bz = 2560 + 70 * gnoise2(x / 900, 5.5, 17);
    const bH = 430 + 270 * clamp(0.5 + 0.8 * gnoise2(x / 1000, 6.6, 18));
    const back = bH * Math.exp(-Math.pow((z - bz) / 230, 2)) * (0.45 + 0.7 * ridged2(x / 380, z / 560, 5, 41));
    let h = main, e = crestH;
    if (back > h) { h = back; e = bH; }
    if (front > h) { h = front; e = fH * 2; }
    const ends = 0.25 + 0.75 * smooth(3450, 2600, Math.abs(x));
    const base = smooth(1725, 1880, z) * smooth(2800, 2700, z);
    return [h * ends * base, e * ends];
  };
  let maxH = 0;
  for (let j = 0; j < Hn; j++) for (let i = 0; i < W; i++) {
    const [h, e] = height(X0 + i * DX, Z0 + j * DZ);
    hts[j * W + i] = h; env[j * W + i] = e; if (h > maxH) maxH = h;
  }
  const k = 700 / maxH;
  for (let i = 0; i < hts.length; i++) { hts[i] *= k; env[i] *= k; }
  const pos = new Float32Array(W * Hn * 3), cols = new Float32Array(W * Hn * 3);
  const sRGB = (r, g, b) => { const c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };
  const rockLit = sRGB(150, 138, 128), rockShade = sRGB(70, 80, 104), grassLit = sRGB(132, 136, 92), grassShade = sRGB(66, 82, 92);
  const snowLit = sRGB(252, 252, 255), snowShade = sRGB(176, 192, 222), haze = sRGB(184, 206, 229);
  const L = new THREE.Vector3(-0.55, 0.62, 0.3).normalize();
  const H = (i, j) => hts[clamp(j, 0, Hn - 1) * W + clamp(i, 0, W - 1)];
  for (let j = 0; j < Hn; j++) for (let i = 0; i < W; i++) {
    const x = X0 + i * DX, z = Z0 + j * DZ, h = H(i, j), id = j * W + i;
    pos[id * 3] = x; pos[id * 3 + 1] = h - 2; pos[id * 3 + 2] = z;
    const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * DX), gz = (H(i, j + 1) - H(i, j - 1)) / (2 * DZ);
    let nx_ = -gx, ny_ = 1, nz_ = -gz; const nl = Math.hypot(nx_, ny_, nz_); nx_ /= nl; ny_ /= nl; nz_ /= nl;
    const dif = Math.max(0, nx_ * L.x + ny_ * L.y + nz_ * L.z);
    const lit = clamp(0.18 + 1.05 * dif);
    // rock vs grassy foothills
    const grassy = 1 - smooth(90, 260, h + 40 * gnoise2(x / 150, z / 150, 61));
    let c = mixc(mixc(rockShade, rockLit, lit), mixc(grassShade, grassLit, lit), grassy);
    c = mulc(c, 0.9 + 0.2 * (0.5 + 0.5 * gnoise2(x / 60, z / 60, 62)));
    // snow above ~60 % of the local range height, less on steep faces, ragged edge
    const e = env[id];
    const line = e * 0.58 + e * 0.07 * gnoise2(x / 120, z / 120, 63) + 18 * gnoise2(x / 30, z / 30, 64) + (1 - ny_) * e * 0.35;
    const snow = smooth(line - 10, line + 22, h);
    if (snow > 0) c = mixc(c, mixc(snowShade, snowLit, clamp(0.25 + 1.1 * dif)), snow);
    // aerial perspective: farther and lower = hazier
    const dist = Math.hypot(x * 0.6, z);
    let f = clamp(0.2 + (dist - 1750) / 1100 * 0.32 + (1 - h / 700) * 0.18, 0, 0.85);
    f *= 1 - 0.35 * snow;
    c = mixc(c, haze, f);
    cols.set(c, id * 3);
  }
  const idx = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = MATS.mountain || (MATS.mountain = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false, name: 'mountains' }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ala-too';
  mesh.castShadow = false; mesh.receiveShadow = false;
  const group = new THREE.Group();
  group.name = 'Mountains';
  group.add(mesh);
  return group;
}

/* ------------------------------------------------------------------ demo */

/** Preview showcase: a small grove with every tree type, bushes, a hedge and a flower bed on a lawn. */
export function demo() {
  const group = new THREE.Group();
  group.add(createLawn(76, 50, { seed: 3 }));
  const kit = createVegetationKit();
  let s = 1;
  for (let i = 0; i < 7; i++) kit.addTree(-27 + i * 9, -18, { type: 'poplar', seed: s++ });
  kit.addTree(-22, -4, { type: 'elm', seed: s++ });
  kit.addTree(-9, -2, { type: 'maple', seed: s++ });
  kit.addTree(6, -4, { type: 'oak', seed: s++ });
  kit.addTree(20, 0, { type: 'birch', seed: s++ });
  kit.addTree(25, -7, { type: 'birch', seed: s++, scale: 0.9 });
  kit.addTree(-31, 8, { type: 'spruce', seed: s++ });
  kit.addTree(-26, 13, { type: 'spruce', seed: s++, scale: 0.85 });
  kit.addTree(-33, 16, { type: 'spruce', seed: s++, scale: 1.1 });
  for (const [x, z] of [[-14, 9], [-11, 11], [-1, 8], [2, 10], [11, 7], [30, 9], [-19, 14]]) kit.addBush(x, z, { scale: 1 });
  kit.addHedge(-22, 20, 12, 20, { height: 1.1 });
  kit.addFlowerBed(22, 16, 12, 5);
  group.add(kit.finish());
  return group;
}
