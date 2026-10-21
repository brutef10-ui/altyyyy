/**
 * SmartCross — procedural vehicles (Three.js r169).
 *
 * Every vehicle type is ONE merged geometry whose per-vertex attributes carry the material
 * (vertex colour + `vmat` = roughness, metalness, paint-mask, emissive). A single patched
 * MeshStandardMaterial renders body paint (instanceColor), glass, trim, chrome, tyres and lamps,
 * so a fleet costs one InstancedMesh (= 1 draw call + 1 shadow call) per vehicle type present.
 * Brake lights are a per-instance attribute (`brake`) that boosts the tail-lamp emission.
 *
 * Conventions: metres, Y up, origin = footprint centre on the ground, front = +Z,
 * vehicle's LEFT / driver side = +X (left-hand drive).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** All vehicle types understood by createFleet(). */
export const VEHICLE_TYPES = ['sedan', 'hatch', 'suv', 'minibus', 'bus', 'pickup'];

/** Overall length (m) of every type, bumper to bumper incl. plates/steps (bus: body, its high mirrors
 *  reach 0.4 m further forward) — use for queue spacing. Each vehicle is centred on its origin. */
export const VEHICLE_LENGTH = { sedan: 4.93, hatch: 4.11, suv: 4.99, minibus: 7.15, bus: 12.07, pickup: 5.49 };

/* ------------------------------------------------------------------------------------------------
 * Palette: every key is a "material" baked into vertex attributes.
 *   c = sRGB hex, r = roughness, m = metalness, p = 1 → multiplied by the instance paint colour,
 *   e = emissive strength (× colour); e < 0 → brake lamp: |e| × (0.12 + 1.6 × brake)
 * ---------------------------------------------------------------------------------------------- */
const PAL = {
  paint: { c: 0xffffff, r: 0.34, m: 0.2, p: 1 },
  glass: { c: 0x111920, r: 0.07, m: 0.3 },
  black: { c: 0x0b0c0e, r: 0.3, m: 0.2 },
  plastic: { c: 0x1e1f21, r: 0.8, m: 0 },
  grey: { c: 0x4a4d52, r: 0.72, m: 0 },
  under: { c: 0x101112, r: 0.95, m: 0 },
  seam: { c: 0x060708, r: 0.9, m: 0 },
  chrome: { c: 0xe9ecef, r: 0.1, m: 1 },
  tyre: { c: 0x18191a, r: 0.92, m: 0 },
  rim: { c: 0xc9cdd2, r: 0.26, m: 0.9 },
  rimDark: { c: 0x2b2d31, r: 0.55, m: 0.4 },
  steel: { c: 0xb4b8bd, r: 0.4, m: 0.6 },
  head: { c: 0xeef3f7, r: 0.08, m: 0.3, e: 0.3 },
  drl: { c: 0xf2f6ff, r: 0.2, m: 0, e: 2.0 },
  tail: { c: 0xb4121c, r: 0.16, m: 0.1, e: -1 },
  amber: { c: 0xf0901e, r: 0.2, m: 0.1, e: 0.15 },
  plate: { c: 0xf3f3ef, r: 0.5, m: 0 },
  ink: { c: 0x141518, r: 0.6, m: 0 },
  flag: { c: 0xd0202a, r: 0.5, m: 0 },
  ledBg: { c: 0x0b0b0c, r: 0.4, m: 0.1 },
  led: { c: 0xffa320, r: 0.4, m: 0, e: 1.8 },
  white: { c: 0xf4f4f1, r: 0.36, m: 0.08 },
  green: { c: 0x16825a, r: 0.36, m: 0.12 },
  board: { c: 0xfbfbf6, r: 0.6, m: 0 },
  boardInk: { c: 0xc0141c, r: 0.6, m: 0 },
  bedliner: { c: 0x232426, r: 0.9, m: 0 },
  mirrorGlass: { c: 0x8f9aa3, r: 0.05, m: 1 },
  // hero interior
  seat: { c: 0xcbb999, r: 0.82, m: 0 },
  seatDark: { c: 0x3a3632, r: 0.8, m: 0 },
  dash: { c: 0x26272a, r: 0.75, m: 0 },
  trim: { c: 0x9a948a, r: 0.4, m: 0.5 },
  carpet: { c: 0x2f2d2b, r: 1, m: 0 },
  liner: { c: 0xd4cfc6, r: 0.95, m: 0 },
  doorCard: { c: 0xbfae90, r: 0.8, m: 0 },
  screen: { c: 0x0b1220, r: 0.12, m: 0.3 },
  screenGlow: { c: 0x3f78c8, r: 0.3, m: 0, e: 0.6 },
  dial: { c: 0xe8f4ff, r: 0.4, m: 0, e: 0.9 },
  leather: { c: 0x1c1c1e, r: 0.6, m: 0 },
  caliper: { c: 0xb3261e, r: 0.45, m: 0.2 },
  disc: { c: 0x76797e, r: 0.45, m: 0.85 },
};

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _q = new THREE.Quaternion(), _eu = new THREE.Euler();
function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_eu.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
}
const MX = new THREE.Matrix4().makeScale(-1, 1, 1);               // mirror across the centre plane
const mul = (a, b) => a.clone().multiply(b);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r, s = 1) => new RoundedBoxGeometry(w, h, d, s, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
const cyl = (rt, rb, h, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
const V2 = (a, b) => new THREE.Vector2(a, b);

/** Collects triangles per palette key; builds merged geometries with material attributes. */
class Parts {
  constructor() { this.b = new Map(); }
  bucket(key) {
    if (!PAL[key]) throw new Error('vehicles: unknown palette key ' + key);
    let b = this.b.get(key);
    if (!b) { b = { p: [], n: [] }; this.b.set(key, b); }
    return b;
  }
  tri(key, a, b, c, na, nb, nc) {
    const B = this.bucket(key);
    B.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    B.n.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
  }
  /** add a geometry (any) transformed by matrix m; mirrored matrices keep correct winding */
  add(geo, key, m) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position, nor = g.attributes.normal, B = this.bucket(key);
    const nm = new THREE.Matrix3();
    if (m) nm.getNormalMatrix(m);
    const flip = m && m.determinant() < 0;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const o = i + (flip ? [0, 2, 1][k] : k);
        v.fromBufferAttribute(pos, o); n.fromBufferAttribute(nor, o);
        if (m) { v.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
        B.p.push(v.x, v.y, v.z); B.n.push(n.x, n.y, n.z);
      }
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  }
  /** add geo at m and its mirror image across x = 0 */
  pair(geo, key, m) { this.add(geo.clone(), key, mul(MX, m)); this.add(geo, key, m); }
  keys() { return [...this.b.keys()]; }
  /** merged BufferGeometry of the given keys (all if omitted) with position, normal, color, vmat */
  build(keys) {
    const sel = (keys || this.keys()).filter(k => this.b.has(k));
    let total = 0;
    for (const k of sel) total += this.b.get(k).p.length;
    const pos = new Float32Array(total), nor = new Float32Array(total), col = new Float32Array(total), vm = new Float32Array((total / 3) * 4);
    let o = 0, o4 = 0;
    const c = new THREE.Color();
    for (const k of sel) {
      const B = this.b.get(k), P = PAL[k];
      c.setHex(P.c);
      pos.set(B.p, o); nor.set(B.n, o);
      for (let i = 0; i < B.p.length; i += 3) { col[o + i] = c.r; col[o + i + 1] = c.g; col[o + i + 2] = c.b; }
      for (let i = 0; i < B.p.length / 3; i++) { vm[o4++] = P.r; vm[o4++] = P.m; vm[o4++] = P.p || 0; vm[o4++] = P.e || 0; }
      o += B.p.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('vmat', new THREE.BufferAttribute(vm, 4));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Shared material (vertex-attribute driven PBR)
 * ---------------------------------------------------------------------------------------------- */
const MATS = {};
function vehicleMaterial(variant = 'fleet') {
  if (MATS[variant]) return MATS[variant];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, side: variant === 'hero' ? THREE.DoubleSide : THREE.FrontSide });
  const brake = variant === 'fleet';
  if (brake) mat.defines = { VEH_BRAKE: '' };
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 vmat;
varying vec4 vMat;
#ifdef VEH_BRAKE
attribute float brake;
varying float vBrake;
#endif`)
      .replace('#include <color_vertex>', `vColor = vec3( 1.0 );
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor *= mix( vec3( 1.0 ), instanceColor.xyz, vmat.z );
#endif
vMat = vmat;
#ifdef VEH_BRAKE
vBrake = brake;
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vMat;
#ifdef VEH_BRAKE
varying float vBrake;
#endif`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.y;')
      .replace('#include <emissivemap_fragment>', `{
  float vb = 0.0;
#ifdef VEH_BRAKE
  vb = vBrake;
#endif
  float em = vMat.w >= 0.0 ? vMat.w : -vMat.w * ( 0.12 + 1.6 * vb );
  totalEmissiveRadiance += vColor.rgb * em;
}`);
  };
  mat.customProgramCacheKey = () => 'smartcross-vehicle-' + variant;
  MATS[variant] = mat;
  return mat;
}

/* ------------------------------------------------------------------------------------------------
 * Body loft: cross-section rings swept along Z, materials assigned per quad (windows, pillars,
 * seams, lamps …) so there are no coplanar decals that could z-fight from far away.
 * ---------------------------------------------------------------------------------------------- */
const CARP = ['yb', 'ys', 'yt', 'wb', 'wg', 'wr', 'rr', 'cr'];
const BOXP = ['yb', 'ys', 'yw', 'yt', 'wb', 'wg', 'wr', 'rr', 'cr'];

/** car section (+X half, bottom centre → roof centre). segs: 0 under, 1 sill bevel, 2 lower side,
 *  3 upper side, 4 shoulder, 5 belt ledge, 6 side glass, 7 roof edge, 8 roof/hood/deck */
function carRing(q) {
  const { yb, ys, yt, wb, wg, wr, rr, cr } = q;
  const a = Math.abs(rr);
  return [[0, yb], [wb - 0.07, yb], [wb - 0.006, yb + 0.06], [wb, yb + 0.45 * (ys - yb)], [wb - 0.022, ys - 0.065],
    [wb - 0.07, ys], [wg, ys + 0.004], [wr, yt - rr], [wr - a * 0.75, yt], [0, yt + cr]];
}
/** box section (vans, buses). segs: 0 under, 1 bevel, 2 skirt, 3 lower side, 4 belt, 5 windows,
 *  6 upper band, 7/8 roof corner, 9 roof */
function boxRing(q) {
  let { yb, ys, yw, yt, wb, wg, wr, rr, cr } = q;
  yw = Math.min(yw, yt - rr - 0.004); ys = Math.min(ys, yw - 0.003);
  return [[0, yb], [wb - 0.06, yb], [wb, yb + 0.06], [wb, yb + 0.42 * (ys - yb)], [wb, ys - 0.025], [wg, ys], [wg, yw],
    [wr, yt - rr], [wr - rr * 0.3, yt - rr * 0.3], [wr - rr, yt], [0, yt + cr]];
}
function makeAt(S) {
  const names = S.family === 'box' ? BOXP : CARP, keys = S.keys;
  return (z) => {
    let v;
    if (z <= keys[0][0]) v = keys[0].slice(1);
    else if (z >= keys[keys.length - 1][0]) v = keys[keys.length - 1].slice(1);
    else {
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        if (z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); v = a.slice(1).map((x, k) => x + (b[k + 1] - x) * t); break; }
      }
    }
    const q = {};
    names.forEach((n, i) => { q[n] = v[i]; });
    for (const ax of S.axles) {
      const dz = z - ax.z;
      if (Math.abs(dz) <= ax.arch) q.yb = Math.max(q.yb, ax.r + Math.sqrt(Math.max(0, ax.arch * ax.arch - dz * dz)));
    }
    return q;
  };
}
function specBreaks(S) {
  const out = [];
  const push = (v) => { if (v == null) return; if (Array.isArray(v)) v.forEach(push); else out.push(v); };
  ['wind', 'rear', 'side', 'pillars', 'belt', 'bed', 'roofRange', 'band', 'extra'].forEach(k => push(S[k]));
  ['lowF', 'lowR', 'headWrap', 'tailWrap'].forEach(k => push(S[k]));
  if (S.panes) { push(S.panes[1]); push(S.panes[-1]); }
  if (S.doors) S.doors.forEach(d => { push([d.z0, d.z1, d.z0 + 0.05, d.z1 - 0.05]); if (d.split) { const c = (d.z0 + d.z1) / 2; push([c - 0.015, c + 0.015]); } });
  for (const s of [...(S.seams || []), ...(S.topSeams || [])]) push([s - 0.004, s + 0.004]);
  return out;
}
function makeStations(S, hero) {
  const L2 = S.L / 2, zs = [];
  S.keys.forEach(k => zs.push(k[0]));
  specBreaks(S).forEach(z => zs.push(z));
  if (hero && S.seals) S.seals.flat().forEach(z => zs.push(z));
  for (const ax of S.axles) {
    const N = hero ? 20 : 8;
    for (let i = 0; i <= N; i++) zs.push(ax.z + ax.arch * Math.cos((Math.PI * i) / N));
    zs.push(ax.z - ax.arch - 0.002, ax.z + ax.arch + 0.002);
  }
  zs.sort((a, b) => a - b);
  const out = [];
  for (const z of zs) {
    if (z < -L2 - 1e-6 || z > L2 + 1e-6) continue;
    if (out.length && z - out[out.length - 1] < 0.0015) continue;
    out.push(z);
  }
  return out;
}
/** sweep the rings and emit triangles (auto-smoothed normals with a crease angle) */
function loft(P, S, at, hero) {
  const zs = makeStations(S, hero), ringFn = S.family === 'box' ? boxRing : carRing;
  const mat = S.family === 'box' ? boxMat(S) : carMat(S, hero);
  const NS = zs.length, half = zs.map(z => ringFn(at(z))), n = half[0].length, m = 2 * n - 2;
  const V = half.map((h, k) => {
    const row = new Array(m);
    for (let j = 0; j < n; j++) row[j] = new THREE.Vector3(h[j][0], h[j][1], zs[k]);
    for (let j = n; j < m; j++) { const o = 2 * n - 2 - j; row[j] = new THREE.Vector3(-h[o][0], h[o][1], zs[k]); }
    return row;
  });
  const QN = [], QU = [], t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  for (let k = 0; k < NS - 1; k++) {
    const rn = [], ru = [];
    for (let j = 0; j < m; j++) {
      const a = V[k][j], b = V[k][(j + 1) % m], c = V[k + 1][(j + 1) % m], d = V[k + 1][j];
      const nn = new THREE.Vector3().crossVectors(t1.subVectors(c, a), t2.subVectors(d, b));
      rn.push(nn); ru.push(nn.clone().normalize());
    }
    QN.push(rn); QU.push(ru);
  }
  const cosT = Math.cos(THREE.MathUtils.degToRad(44));
  const vn = (k, j, qk, qj) => {
    const ref = QU[qk][qj], s = new THREE.Vector3();
    for (const [ak, aj] of [[k - 1, j - 1], [k - 1, j], [k, j - 1], [k, j]]) {
      if (ak < 0 || ak >= NS - 1) continue;
      const jj = (aj + m) % m;
      if (QU[ak][jj].dot(ref) >= cosT) s.add(QN[ak][jj]);
    }
    if (s.lengthSq() < 1e-16) s.copy(ref);
    return s.normalize();
  };
  for (let k = 0; k < NS - 1; k++) {
    const zm = (zs[k] + zs[k + 1]) / 2;
    for (let j = 0; j < m; j++) {
      if (QN[k][j].lengthSq() < 1e-13) continue;
      const j1 = (j + 1) % m;
      const seg = j < n - 1 ? j : 2 * n - 3 - j, side = j < n - 1 ? 1 : -1;
      const a = V[k][j], b = V[k][j1], c = V[k + 1][j1], d = V[k + 1][j];
      const key = mat(zm, seg, side, (a.y + b.y + c.y + d.y) / 4);
      if (!key) continue;
      const na = vn(k, j, k, j), nb = vn(k, j1, k, j), nc = vn(k + 1, j1, k, j), nd = vn(k + 1, j, k, j);
      P.tri(key, a, b, c, na, nb, nc); P.tri(key, a, c, d, na, nc, nd);
    }
  }
  const cap = (k, dir, key) => {
    const row = V[k], c = new THREE.Vector3();
    row.forEach(p => c.add(p)); c.divideScalar(m);
    const nn = new THREE.Vector3(0, 0, dir);
    for (let j = 0; j < m; j++) {
      const a = row[j], b = row[(j + 1) % m];
      if (dir > 0) P.tri(key, c, a, b, nn, nn, nn); else P.tri(key, c, b, a, nn, nn, nn);
    }
  };
  cap(0, -1, S.capR || 'paint');
  cap(NS - 1, 1, S.capF || 'paint');
}
const inR = (z, r) => r && z > r[0] && z < r[1];
const anyR = (z, list) => !!list && list.some(r => inR(z, r));
const nearSeam = (z, list) => !!list && list.some(s => Math.abs(z - s) < 0.0045);

function carMat(S, hero) {
  return (z, seg, side, y) => {
    if (seg === 0) return 'under';
    if (S.bed && inR(z, S.bed) && seg >= 6) return 'bedliner';
    if (seg <= 4) {
      if (S.archClad) for (const a of S.axles) if (Math.hypot(z - a.z, y - a.r) < a.arch + S.archClad) return 'plastic';
      if (seg === 1) return (z > S.lowF || z < S.lowR) ? 'plastic' : (S.sillKey || 'paint');
      if (nearSeam(z, S.seams)) return 'seam';
      if (S.cladY && y < S.cladY) return 'plastic';
      if (seg === 4 && z > S.headWrap) return 'head';
      if (seg === 4 && z < S.tailWrap) return 'tail';
      return 'paint';
    }
    if (hero && seg >= 6 && anyR(z, S.seals)) return 'black';
    if (seg === 5) return inR(z, S.belt) ? S.beltKey || 'black' : nearSeam(z, S.seams) ? 'seam' : 'paint';
    if (seg === 6) return anyR(z, S.side) ? 'glass' : anyR(z, S.pillars) ? 'black' : 'paint';
    if (seg === 7) return hero && inR(z, S.frame) ? 'black' : inR(z, S.roofRange) ? S.roofKey : 'paint';
    if (inR(z, S.wind) || inR(z, S.rear)) return 'glass';
    if (nearSeam(z, S.topSeams)) return 'seam';
    return inR(z, S.roofRange) ? S.roofKey : 'paint';
  };
}
function boxMat(S) {
  return (z, seg, side, y) => {
    if (seg === 0) return 'under';
    const d = S.doors && S.doors.find(o => o.side === side && z > o.z0 && z < o.z1);
    if (d && seg >= 1 && seg <= 5) {
      if (z < d.z0 + 0.05 || z > d.z1 - 0.05) return 'black';
      if (d.split && Math.abs(z - (d.z0 + d.z1) / 2) < 0.015) return 'black';
      return 'glass';
    }
    if (seg === 1) return S.bevelKey || 'plastic';
    if (seg <= 4) {
      if (nearSeam(z, S.seams)) return 'seam';
      if (seg === 2) return S.skirtKey || 'paint';
      if (seg === 4 && z > S.headWrap) return 'head';
      if (seg === 4 && z < S.tailWrap) return 'tail';
      return S.sideKey || 'paint';
    }
    if (seg === 5) {
      if (anyR(z, S.panes[side])) return 'glass';
      if (nearSeam(z, S.seams)) return 'seam';
      return inR(z, S.band) ? S.pillarKey || 'black' : 'paint';
    }
    if (seg === 6) return S.upperKey || 'paint';
    if (seg === 7 || seg === 8) return inR(z, S.wind) ? 'black' : 'paint';
    return inR(z, S.wind) ? 'glass' : 'paint';
  };
}
/** x of the body surface (+X side) at station z and height y */
function bodyX(S, at, z, y) {
  const r = (S.family === 'box' ? boxRing : carRing)(at(z));
  for (let j = 1; j < r.length - 1; j++) {
    const a = r[j], b = r[j + 1];
    if ((y >= a[1] && y <= b[1]) || (y <= a[1] && y >= b[1])) {
      const t = Math.abs(b[1] - a[1]) < 1e-6 ? 0 : (y - a[1]) / (b[1] - a[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return r[3][0];
}

/* ------------------------------------------------------------------------------------------------
 * Detail builders
 * ---------------------------------------------------------------------------------------------- */
/** a lamp/trim "ribbon" that follows the body outline in plan view (wraps around corners).
 *  pts: [{x, z, y0, y1}] ordered so that the outward normal = tangent × up. Built on +X side and mirrored. */
function ribbon(P, key, pts, out = 0.008, thick = 0.05) {
  const N = pts.length, pos = [], idx = [];
  const nrm = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    return [-tz / l, tx / l];
  });
  const O = (i, y) => [pts[i].x + nrm[i][0] * out, y, pts[i].z + nrm[i][1] * out];
  const I = (i, y) => [pts[i].x - nrm[i][0] * thick, y, pts[i].z - nrm[i][1] * thick];
  const strip = (A, B) => { // A(i), B(i) rows → quads (A_i, A_i+1, B_i+1, B_i)
    const base = pos.length / 3;
    for (let i = 0; i < N; i++) { pos.push(...A(i)); pos.push(...B(i)); }
    for (let i = 0; i < N - 1; i++) { const a = base + i * 2, b = a + 2; idx.push(a, b, b + 1, a, b + 1, a + 1); }
  };
  strip(i => O(i, pts[i].y0), i => O(i, pts[i].y1));                       // face
  strip(i => O(i, pts[i].y1), i => I(i, pts[i].y1));                       // top
  strip(i => I(i, pts[i].y0), i => O(i, pts[i].y0));                       // bottom
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  P.pair(g, key, new THREE.Matrix4());
}
/** lamp path around a body corner: flat part on the end cap from xIn, then back along the side */
function cornerPath(S, at, end, dir, xIn, zBack, y0a, y1a, y0b, y1b, steps = 5) {
  const ym = (y0a + y1a) / 2, pts = [];
  const xc = bodyX(S, at, end, ym) - 0.004;
  pts.push({ x: xIn, z: end, y0: y0a, y1: y1a });
  const zs = [];
  for (let i = 0; i <= steps; i++) { const t = i / steps; zs.push(end - dir * (zBack * t * t)); }
  zs.forEach((z, i) => {
    const t = i / steps;
    const x = i === 0 ? xc : bodyX(S, at, z, ym);
    pts.push({ x, z, y0: y0a + (y0b - y0a) * t, y1: y1a + (y1b - y1a) * t });
  });
  return dir > 0 ? pts : pts.reverse();
}

const SEG7 = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
/** seven-segment number in the local XY plane of matrix m (front = +Z) */
function digits(P, key, str, h, m, th = 0.004) {
  const w = h * 0.55, t = h * 0.15, adv = w + h * 0.32, x0 = -((str.length - 1) * adv) / 2;
  const L = { a: [0, h / 2 - t / 2, w, t], d: [0, -h / 2 + t / 2, w, t], g: [0, 0, w, t], b: [w / 2 - t / 2, h / 4, t, h / 2], c: [w / 2 - t / 2, -h / 4, t, h / 2], e: [-w / 2 + t / 2, -h / 4, t, h / 2], f: [-w / 2 + t / 2, h / 4, t, h / 2] };
  [...str].forEach((ch, i) => {
    for (const s of SEG7[ch] || '') { const [x, y, sw, sh] = L[s]; P.add(box(sw, sh, th), key, mul(m, M(x0 + i * adv + x, y, 0))); }
  });
}
/** Kyrgyz-style number plate (white, red flag block, dark characters); dir +1 front, −1 rear */
function plate(P, x, y, z, dir) {
  const m = M(x, y, z, 0, dir > 0 ? 0 : Math.PI, 0);
  P.add(box(0.52, 0.115, 0.012), 'plate', m);
  P.add(box(0.035, 0.024, 0.004), 'flag', mul(m, M(-0.225, 0.022, 0.007)));
  P.add(box(0.008, 0.095, 0.004), 'ink', mul(m, M(-0.19, 0, 0.007)));
  for (let i = 0; i < 6; i++) P.add(box(0.036, 0.066, 0.004), 'ink', mul(m, M(-0.13 + i * 0.062 + (i > 2 ? 0.02 : 0), -0.004, 0.007)));
}
/** wheel: tyre + rim; axle along X, outer face toward `side` (±1) */
function wheel(P, { x, y, z, r, w, seg, style = 'alloy', side, hero = false }) {
  const base = M(x, y, z, 0, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2);   // local +Y → outward
  const rimR = r * (style === 'steel' ? 0.6 : 0.66);
  const tp = hero
    ? [V2(rimR * 0.98, -w * 0.42), V2(r * 0.9, -w * 0.5), V2(r * 0.985, -w * 0.42), V2(r, -w * 0.3), V2(r, w * 0.3), V2(r * 0.985, w * 0.42), V2(r * 0.9, w * 0.5), V2(rimR * 0.98, w * 0.42)]
    : [V2(rimR * 0.98, -w * 0.42), V2(r * 0.93, -w * 0.5), V2(r, -w * 0.34), V2(r, w * 0.34), V2(r * 0.93, w * 0.5), V2(rimR * 0.98, w * 0.42)];
  P.add(new THREE.LatheGeometry(tp, seg), 'tyre', base);
  const lip = style === 'steel' ? 'steel' : 'rim';
  P.add(new THREE.LatheGeometry([V2(rimR + 0.006, w * 0.43), V2(rimR * 0.93, w * 0.39)], seg), lip, base);
  if (style === 'steel') {
    P.add(new THREE.LatheGeometry([V2(rimR * 0.93, w * 0.39), V2(rimR * 0.8, w * 0.22), V2(rimR * 0.5, w * 0.26), V2(rimR * 0.36, w * 0.36)], seg), 'steel', base);
    P.add(new THREE.LatheGeometry([V2(rimR * 0.36, w * 0.36), V2(rimR * 0.28, w * 0.42), V2(0.0005, w * 0.44)], seg), 'chrome', base);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      P.add(box(0.035, 0.012, 0.05), 'rimDark', mul(base, M(Math.cos(a) * rimR * 0.64, w * 0.245, Math.sin(a) * rimR * 0.64, 0, -a, 0)));
    }
    return;
  }
  P.add(new THREE.LatheGeometry([V2(rimR * 0.93, w * 0.39), V2(rimR * 0.86, w * 0.16), V2(rimR * 0.3, w * 0.2)], seg), 'rimDark', base);
  P.add(new THREE.LatheGeometry(hero ? [V2(rimR * 0.3, w * 0.2), V2(rimR * 0.24, w * 0.36), V2(0.0005, w * 0.37)] : [V2(rimR * 0.26, w * 0.36), V2(0.0005, w * 0.37)], seg), 'rim', base);
  const ns = 5;
  for (let i = 0; i < ns; i++) {
    const a = (i / ns) * Math.PI * 2 + 0.3;
    const sp = hero ? rbox(rimR * 0.74, w * 0.16, rimR * 0.2, 0.008, 1) : box(rimR * 0.74, w * 0.14, rimR * 0.2);
    P.add(sp, 'rim', mul(base, M(Math.cos(a) * rimR * 0.58, w * 0.31, Math.sin(a) * rimR * 0.58, 0, -a, 0)));
  }
  if (hero) {
    P.add(cyl(rimR * 0.82, rimR * 0.82, 0.022, 28), 'disc', mul(base, M(0, -w * 0.05, 0)));
    P.add(rbox(0.07, 0.07, 0.15, 0.015, 1), 'caliper', mul(base, M(rimR * 0.62, w * 0.05, 0, 0, 0, 0)));
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; P.add(cyl(0.011, 0.011, 0.02, 6), 'chrome', mul(base, M(Math.cos(a) * 0.05, w * 0.38, Math.sin(a) * 0.05))); }
  }
}
/** side mirrors (both sides): mounted at the body/glass surface x = xg, housing reaching outward */
function mirrors(P, xg, y, z, { key = 'paint', w = 0.17, h = 0.105, d = 0.09, reach = 0.17, van = false } = {}) {
  const cx = xg + reach, m = M(cx, y, z, 0, -0.1, 0), arm = reach - w / 2 + 0.05;
  P.pair(box(0.05, van ? 0.1 : 0.07, 0.12), 'plastic', M(xg + 0.005, y - (van ? 0.08 : 0.03), z + 0.02));
  P.pair(box(arm, 0.032, 0.05), van ? 'plastic' : key, M(xg + arm / 2, y - (van ? 0.08 : 0.025), z + 0.01, 0, -0.1, 0));
  if (van) P.pair(box(arm, 0.025, 0.04), 'plastic', M(xg + arm / 2, y + 0.08, z + 0.01, 0, -0.1, 0));
  P.pair(rbox(w, h, d, Math.min(0.035, h / 3), 1), key, m);
  P.pair(box(w * 0.86, h * 0.8, 0.01), 'mirrorGlass', mul(m, M(0, 0, -d / 2 - 0.002)));
  P.pair(box(w * 0.4, 0.012, 0.006), 'amber', mul(m, M(w * 0.18, -h * 0.28, d / 2 - 0.004, 0, 0.5, 0)));
}
/** cylinder rod between two points */
function rod(P, key, a, b, r, seg = 8) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  P.add(cyl(r, r, len, seg), key, new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
}
/** windshield wiper pair lying on a slope (base at y, z; slope angle a from horizontal) */
function wipers(P, xs, y, z, a, len) {
  for (const x of xs) P.add(box(len, 0.012, 0.02), 'black', M(x, y, z, a, 0, 0.12));
}

/* ------------------------------------------------------------------------------------------------
 * Vehicle specs
 * ---------------------------------------------------------------------------------------------- */
const SEDAN = {
  family: 'car', L: 4.85,
  // z, yb, ys, yt, wb, wg, wr, rr, cr
  keys: [
    [-2.425, 0.34, 0.865, 0.885, 0.74, 0.64, 0.6, 0.01, 0.01],
    [-2.395, 0.27, 0.95, 0.975, 0.86, 0.75, 0.71, 0.01, 0.015],
    [-2.3, 0.235, 0.99, 1.015, 0.9, 0.785, 0.745, 0.01, 0.02],
    [-2.05, 0.215, 1.005, 1.035, 0.915, 0.8, 0.76, 0.01, 0.02],
    [-1.62, 0.2, 1.005, 1.045, 0.92, 0.8, 0.76, 0.015, 0.02],
    [-0.95, 0.19, 0.985, 1.41, 0.92, 0.8, 0.68, 0.07, 0.03],
    [-0.72, 0.19, 0.978, 1.44, 0.92, 0.8, 0.675, 0.07, 0.03],
    [0.18, 0.19, 0.963, 1.45, 0.92, 0.8, 0.675, 0.07, 0.03],
    [0.42, 0.19, 0.958, 1.425, 0.92, 0.8, 0.685, 0.07, 0.03],
    [1.32, 0.19, 0.942, 0.966, 0.915, 0.8, 0.775, 0.015, 0.03],
    [1.8, 0.2, 0.905, 0.928, 0.91, 0.79, 0.755, 0.01, 0.04],
    [2.18, 0.22, 0.855, 0.875, 0.895, 0.775, 0.735, 0.01, 0.035],
    [2.34, 0.245, 0.8, 0.82, 0.86, 0.745, 0.705, 0.01, 0.03],
    [2.4, 0.275, 0.765, 0.785, 0.815, 0.7, 0.66, 0.01, 0.02],
    [2.425, 0.31, 0.72, 0.74, 0.74, 0.62, 0.58, 0.01, 0.01],
  ],
  axles: [{ z: 1.4, r: 0.335, w: 0.215, arch: 0.385, x: 0.785 }, { z: -1.42, r: 0.335, w: 0.215, arch: 0.385, x: 0.785 }],
  wind: [0.42, 1.32], rear: [-1.62, -0.95],
  side: [[-1.1, -0.43], [-0.31, 1.33]], pillars: [[-0.43, -0.31]], frame: [-1.16, 1.33],
  seals: [[0.42, 0.45], [1.285, 1.32], [-1.62, -1.585], [-0.985, -0.95], [-1.1, -1.075]],
  belt: [-1.1, 1.3], beltKey: 'chrome',
  seams: [0.97, -0.36, -1.15], topSeams: [2.28, -1.68],
  lowF: 2.2, lowR: -2.24, headWrap: 2.3, tailWrap: -2.3,
  details(P, at, hero) {
    const F = 2.425, R = -2.425;
    ribbon(P, 'head', cornerPath(this, at, F, 1, 0.34, 0.2, 0.62, 0.7, 0.68, 0.74), 0.01, 0.06);
    ribbon(P, 'drl', cornerPath(this, at, F, 1, 0.36, 0.17, 0.603, 0.617, 0.665, 0.676), 0.013, 0.05);
    ribbon(P, 'tail', cornerPath(this, at, R, -1, 0.36, 0.2, 0.79, 0.865, 0.83, 0.9), 0.01, 0.06);
    P.add(box(0.6, 0.05, 0.03), 'black', M(0, 0.665, F));                           // upper grille
    P.add(box(1.04, 0.23, 0.06), 'plastic', M(0, 0.43, F - 0.015));            // lower grille
    for (let i = 0; i < 3; i++) P.add(box(0.98, 0.014, 0.02), 'black', M(0, 0.36 + i * 0.07, F + 0.02));
    P.add(cyl(0.05, 0.05, 0.012, 16), 'chrome', M(0, 0.665, F + 0.016, Math.PI / 2, 0, 0));
    plate(P, 0, 0.45, F + 0.03, 1);
    P.add(box(0.6, 0.03, 0.02), 'chrome', M(0, 0.83, R - 0.003));                     // trunk chrome strip
    plate(P, 0, 0.62, R - 0.012, -1);
    P.add(box(0.7, 0.06, 0.04), 'plastic', M(0, 0.38, R));                          // rear diffuser
    P.pair(cyl(0.035, 0.035, 0.08, 10), 'chrome', M(0.45, 0.3, R - 0.0, Math.PI / 2, 0, 0));
    P.pair(box(0.1, 0.03, 0.02), 'tail', M(0.66, 0.46, R + 0.02));                    // reflectors
    mirrors(P, 0.79, 1.0, 1.12, { key: 'paint' });
    for (const z of [-0.18, -0.98]) P.pair(box(0.026, 0.03, 0.15), 'chrome', M(0.92, 0.875, z));
    wipers(P, [0.32, -0.12], 0.985, 1.26, -0.47, 0.55);
    P.add(box(0.05, 0.05, 0.15), 'black', M(0, 1.47, -0.75));            // shark fin
    P.pair(box(0.012, 0.03, 0.08), 'amber', M(0.905, 0.79, 1.92));                    // side repeater
    if (hero) P.add(box(0.02, 0.04, 0.012), 'chrome', M(0.6, 0.98, -1.72));          // fuel cap hinge hint
  },
};

const HATCH = {
  family: 'car', L: 4.05,
  keys: [
    [-2.025, 0.36, 0.86, 0.9, 0.74, 0.62, 0.58, 0.02, 0.01],
    [-2.0, 0.3, 0.93, 0.97, 0.82, 0.7, 0.66, 0.02, 0.015],
    [-1.95, 0.26, 0.965, 1.02, 0.845, 0.73, 0.69, 0.03, 0.02],
    [-1.9, 0.24, 0.97, 1.1, 0.85, 0.735, 0.68, 0.04, 0.02],
    [-1.72, 0.21, 0.965, 1.47, 0.855, 0.735, 0.64, 0.06, 0.025],
    [-1.58, 0.2, 0.96, 1.505, 0.855, 0.735, 0.635, 0.065, 0.03],
    [0.3, 0.2, 0.93, 1.52, 0.855, 0.74, 0.635, 0.065, 0.03],
    [0.52, 0.2, 0.925, 1.495, 0.855, 0.745, 0.645, 0.065, 0.03],
    [1.42, 0.2, 0.9, 0.925, 0.85, 0.75, 0.715, 0.015, 0.03],
    [1.8, 0.215, 0.855, 0.875, 0.84, 0.735, 0.7, 0.01, 0.035],
    [1.96, 0.25, 0.8, 0.82, 0.805, 0.69, 0.65, 0.01, 0.025],
    [2.0, 0.28, 0.76, 0.78, 0.76, 0.645, 0.605, 0.01, 0.02],
    [2.025, 0.31, 0.71, 0.73, 0.69, 0.59, 0.55, 0.01, 0.01],
  ],
  axles: [{ z: 1.2, r: 0.31, w: 0.195, arch: 0.36, x: 0.725 }, { z: -1.3, r: 0.31, w: 0.195, arch: 0.36, x: 0.725 }],
  wind: [0.52, 1.42], rear: [-1.9, -1.74], roofRange: [-1.74, -1.6], roofKey: 'black',
  side: [[-1.1, -0.34], [-0.26, 1.42], [-1.52, -1.18]], pillars: [[-0.34, -0.26], [-1.18, -1.1]],
  belt: [-1.52, 1.4], beltKey: 'black',
  seams: [0.86, -0.3, -1.12], topSeams: [1.9],
  lowF: 1.84, lowR: -1.86, headWrap: 1.88, tailWrap: -1.88,
  details(P, at) {
    const F = 2.025, R = -2.025;
    ribbon(P, 'head', cornerPath(this, at, F, 1, 0.3, 0.24, 0.6, 0.69, 0.67, 0.75), 0.01, 0.06);
    ribbon(P, 'tail', cornerPath(this, at, R, -1, 0.5, 0.16, 0.78, 0.96, 0.82, 1.06), 0.01, 0.05);
    P.add(box(0.5, 0.06, 0.03), 'black', M(0, 0.655, F));
    P.add(box(0.86, 0.2, 0.06), 'plastic', M(0, 0.42, F - 0.015));
    for (let i = 0; i < 2; i++) P.add(box(0.8, 0.014, 0.02), 'black', M(0, 0.39 + i * 0.07, F + 0.02));
    plate(P, 0, 0.44, F + 0.03, 1);
    plate(P, 0, 0.66, R - 0.012, -1);
    P.add(box(0.8, 0.05, 0.04), 'plastic', M(0, 0.4, R));
    P.add(rbox(1.18, 0.05, 0.16, 0.02), 'black', M(0, 1.52, -1.66));                 // roof spoiler
    mirrors(P, 0.74, 0.96, 1.22, { key: 'black', w: 0.16, h: 0.1, reach: 0.16 });
    for (const z of [-0.12, -0.92]) P.pair(box(0.026, 0.03, 0.14), 'paint', M(0.855, 0.85, z));
    wipers(P, [0.3, -0.12], 0.945, 1.36, -0.5, 0.5);
  },
};

const SUV = {
  family: 'car', L: 4.9,
  keys: [
    [-2.45, 0.44, 1.0, 1.03, 0.8, 0.7, 0.66, 0.02, 0.01],
    [-2.42, 0.36, 1.07, 1.11, 0.89, 0.775, 0.735, 0.02, 0.015],
    [-2.36, 0.31, 1.1, 1.22, 0.925, 0.8, 0.76, 0.03, 0.02],
    [-2.3, 0.29, 1.1, 1.33, 0.935, 0.81, 0.755, 0.04, 0.02],
    [-2.1, 0.27, 1.095, 1.73, 0.94, 0.815, 0.705, 0.07, 0.025],
    [-1.92, 0.265, 1.09, 1.775, 0.94, 0.815, 0.7, 0.075, 0.03],
    [0.3, 0.26, 1.06, 1.8, 0.945, 0.82, 0.7, 0.075, 0.03],
    [0.58, 0.26, 1.06, 1.77, 0.945, 0.825, 0.71, 0.075, 0.03],
    [1.4, 0.27, 1.065, 1.1, 0.94, 0.83, 0.79, 0.02, 0.03],
    [2.05, 0.29, 1.03, 1.055, 0.935, 0.815, 0.775, 0.01, 0.04],
    [2.32, 0.33, 0.97, 0.99, 0.9, 0.78, 0.74, 0.01, 0.03],
    [2.415, 0.38, 0.91, 0.93, 0.84, 0.72, 0.68, 0.01, 0.02],
    [2.45, 0.43, 0.85, 0.87, 0.76, 0.65, 0.61, 0.01, 0.01],
  ],
  axles: [{ z: 1.43, r: 0.37, w: 0.235, arch: 0.43, x: 0.8 }, { z: -1.42, r: 0.37, w: 0.235, arch: 0.43, x: 0.8 }],
  wind: [0.58, 1.4], rear: [-2.32, -2.12],
  side: [[-1.1, -0.3], [-0.22, 1.41], [-1.9, -1.18]], pillars: [[-0.3, -0.22], [-1.18, -1.1]],
  belt: [-1.9, 1.38], beltKey: 'chrome',
  seams: [1.02, -0.26, -1.14], topSeams: [2.2],
  lowF: 2.25, lowR: -2.3, headWrap: 2.3, tailWrap: -2.3,
  archClad: 0.07, cladY: 0.42,
  details(P, at) {
    const F = 2.45, R = -2.45;
    ribbon(P, 'head', cornerPath(this, at, F, 1, 0.36, 0.22, 0.76, 0.85, 0.8, 0.9), 0.012, 0.06);
    ribbon(P, 'drl', cornerPath(this, at, F, 1, 0.38, 0.18, 0.74, 0.755, 0.785, 0.798), 0.015, 0.05);
    ribbon(P, 'tail', cornerPath(this, at, R, -1, 0.4, 0.26, 0.92, 1.02, 0.98, 1.08), 0.01, 0.06);
    P.add(rbox(0.82, 0.32, 0.06, 0.04), 'black', M(0, 0.68, F - 0.012));            // big spindle-ish grille
    for (let i = 0; i < 4; i++) P.add(box(0.76, 0.016, 0.02), 'chrome', M(0, 0.57 + i * 0.075, F + 0.02));
    P.add(rbox(1.3, 0.12, 0.08, 0.03), 'plastic', M(0, 0.47, F - 0.02));            // lower bumper
    P.add(box(0.9, 0.03, 0.05), 'grey', M(0, 0.45, F + 0.02));                      // skid plate
    plate(P, 0, 0.54, F + 0.035, 1);
    P.add(box(0.62, 0.035, 0.02), 'chrome', M(0, 1.06, R - 0.003));
    plate(P, 0, 0.78, R - 0.012, -1);
    P.add(rbox(1.4, 0.16, 0.1, 0.04), 'plastic', M(0, 0.52, R + 0.02));
    P.pair(box(0.12, 0.03, 0.02), 'tail', M(0.7, 0.55, R - 0.035));
    for (const s of [1, -1]) {                                                          // roof rails
      P.add(box(0.04, 0.04, 2.5), 'black', M(s * 0.6, 1.86, -0.55));
      for (const z of [-1.7, 0.6]) P.add(box(0.05, 0.06, 0.12), 'black', M(s * 0.6, 1.82, z));
    }
    mirrors(P, 0.82, 1.13, 1.2, { key: 'paint', w: 0.2, h: 0.125, reach: 0.18 });
    for (const z of [-0.12, -1.0]) P.pair(box(0.026, 0.03, 0.15), 'chrome', M(0.94, 0.97, z));
    P.pair(box(0.05, 0.05, 1.5), 'plastic', M(0.9, 0.3, -0.03));             // side steps
    wipers(P, [0.34, -0.12], 1.12, 1.33, -0.6, 0.55);
    P.add(box(0.05, 0.05, 0.15), 'black', M(0, 1.84, -1.85));
  },
};

const PICKUP = {
  family: 'car', L: 5.33,
  keys: [
    [-2.665, 0.52, 1.1, 1.12, 0.86, 0.78, 0.76, 0.01, 0.0],
    [-2.64, 0.47, 1.155, 1.175, 0.9, 0.82, 0.8, 0.01, 0.0],
    [-2.615, 0.46, 1.165, 1.18, 0.905, 0.82, 0.8, 0.01, 0.0],
    [-2.6, 0.46, 1.165, 0.86, 0.905, 0.8, 0.78, -0.03, 0.0],
    [-0.975, 0.36, 1.175, 0.86, 0.91, 0.8, 0.78, -0.03, 0.0],
    [-0.955, 0.34, 1.17, 1.78, 0.915, 0.83, 0.72, 0.08, 0.02],
    [-0.8, 0.33, 1.165, 1.815, 0.915, 0.83, 0.715, 0.08, 0.03],
    [0.4, 0.32, 1.15, 1.825, 0.915, 0.83, 0.715, 0.08, 0.03],
    [0.64, 0.32, 1.148, 1.795, 0.915, 0.835, 0.725, 0.08, 0.03],
    [1.48, 0.33, 1.13, 1.16, 0.91, 0.84, 0.8, 0.02, 0.03],
    [2.25, 0.35, 1.07, 1.095, 0.905, 0.81, 0.77, 0.01, 0.05],
    [2.55, 0.4, 1.01, 1.03, 0.88, 0.78, 0.74, 0.01, 0.035],
    [2.635, 0.46, 0.95, 0.97, 0.82, 0.72, 0.68, 0.01, 0.02],
    [2.665, 0.5, 0.89, 0.91, 0.74, 0.64, 0.6, 0.01, 0.01],
  ],
  axles: [{ z: 1.6, r: 0.38, w: 0.245, arch: 0.44, x: 0.79 }, { z: -1.48, r: 0.38, w: 0.245, arch: 0.44, x: 0.79 }],
  wind: [0.64, 1.48], rear: null, bed: [-2.6, -0.975],
  side: [[-0.86, -0.16], [-0.08, 1.49]], pillars: [[-0.16, -0.08], [-0.955, -0.86]],
  belt: [-0.86, 1.47], beltKey: 'black',
  seams: [1.12, -0.12, -0.9, -0.99], topSeams: [2.4],
  lowF: 2.45, lowR: -2.55, headWrap: 2.5, tailWrap: -2.5,
  archClad: 0.08,
  details(P, at) {
    const F = 2.665, R = -2.665;
    ribbon(P, 'head', cornerPath(this, at, F, 1, 0.5, 0.22, 0.78, 0.86, 0.82, 0.92), 0.012, 0.06);
    ribbon(P, 'tail', cornerPath(this, at, R, -1, 0.74, 0.1, 0.78, 1.08, 0.78, 1.08, 3), 0.012, 0.05);
    P.add(rbox(0.96, 0.3, 0.06, 0.03), 'chrome', M(0, 0.76, F - 0.012));             // big chrome grille
    P.add(rbox(0.88, 0.24, 0.04, 0.02), 'black', M(0, 0.76, F + 0.006));
    for (let i = 0; i < 3; i++) P.add(box(0.86, 0.02, 0.02), 'chrome', M(0, 0.68 + i * 0.08, F + 0.02));
    P.add(rbox(1.6, 0.16, 0.12, 0.04), 'plastic', M(0, 0.5, F - 0.03));
    plate(P, 0, 0.5, F + 0.04, 1);
    P.add(rbox(1.7, 0.14, 0.16, 0.03), 'chrome', M(0, 0.52, R - 0.03));              // rear step bumper
    plate(P, 0, 0.78, R - 0.012, -1);
    P.add(box(1.5, 0.03, 0.02), 'black', M(0, 1.06, R - 0.003));                     // tailgate handle line
    P.add(box(0.2, 0.05, 0.02), 'chrome', M(0, 1.0, R - 0.005));
    P.add(box(1.36, 0.42, 0.03), 'glass', M(0, 1.5, -0.955));                         // cab rear window
    P.pair(box(0.06, 0.035, 1.65), 'plastic', M(0.875, 1.19, -1.79));                // bed rail caps
    mirrors(P, 0.83, 1.21, 1.32, { key: 'black', w: 0.21, h: 0.14, reach: 0.18 });
    for (const z of [0.0, -0.78]) P.pair(box(0.026, 0.035, 0.15), 'chrome', M(0.93, 1.06, z));
    P.pair(box(0.12, 0.05, 2.0), 'plastic', M(0.88, 0.36, 0.06));              // running boards
    wipers(P, [0.34, -0.12], 1.18, 1.42, -0.6, 0.55);
  },
};

const MINIBUS = {
  family: 'box', L: 6.95,
  // z, yb, ys, yw, yt, wb, wg, wr, rr, cr
  keys: [
    [-3.475, 0.5, 1.1, 1.95, 2.56, 0.9, 0.89, 0.88, 0.14, 0.0],
    [-3.45, 0.43, 1.16, 2.02, 2.66, 0.97, 0.955, 0.945, 0.17, 0.015],
    [-3.36, 0.41, 1.17, 2.05, 2.71, 0.99, 0.97, 0.955, 0.18, 0.025],
    [1.38, 0.41, 1.17, 2.05, 2.72, 0.99, 0.97, 0.955, 0.18, 0.025],
    [1.8, 0.41, 1.18, 2.06, 2.16, 0.99, 0.97, 0.955, 0.1, 0.02],
    [2.62, 0.43, 1.18, 1.22, 1.26, 0.985, 0.965, 0.94, 0.03, 0.02],
    [3.15, 0.46, 1.08, 1.1, 1.12, 0.965, 0.94, 0.91, 0.02, 0.03],
    [3.4, 0.5, 1.0, 1.02, 1.04, 0.925, 0.89, 0.86, 0.02, 0.02],
    [3.475, 0.54, 0.92, 0.94, 0.96, 0.85, 0.81, 0.78, 0.02, 0.01],
  ],
  axles: [{ z: 2.45, r: 0.36, w: 0.215, arch: 0.42, x: 0.83 }, { z: -1.85, r: 0.36, w: 0.36, arch: 0.42, x: 0.76 }],
  wind: [1.8, 2.62], band: [-3.32, 2.66], pillarKey: 'black',
  panes: {
    1: [[-3.22, -2.18], [-2.1, -0.98], [-0.9, 0.4], [0.48, 1.52], [1.66, 2.64]],
    [-1]: [[-3.22, -2.18], [-2.1, -0.98], [-0.9, 0.3], [0.5, 1.46], [1.66, 2.64]],
  },
  seams: [2.66, 1.6], extra: [0.42, 1.54], bevelKey: 'grey', skirtKey: 'paint',
  headWrap: 3.3, tailWrap: -3.36,
  details(P, at) {
    const F = 3.475, R = -3.475;
    // sliding door seams (right side only)
    for (const z of [0.42, 1.54]) P.add(box(0.006, 1.58, 0.008), 'seam', M(-0.992, 1.2, z));
    P.add(box(0.012, 0.035, 0.16), 'black', M(-0.995, 1.1, 0.62));
    ribbon(P, 'head', cornerPath(this, at, F, 1, 0.42, 0.26, 0.78, 0.92, 0.86, 1.0), 0.012, 0.07);
    P.add(rbox(0.74, 0.22, 0.05, 0.03), 'black', M(0, 0.84, F - 0.01));
    for (let i = 0; i < 3; i++) P.add(box(0.68, 0.02, 0.02), 'chrome', M(0, 0.77 + i * 0.065, F + 0.02));
    P.add(rbox(1.84, 0.3, 0.2, 0.05), 'grey', M(0, 0.5, F - 0.04));                   // bumper
    P.pair(rbox(0.12, 0.06, 0.03, 0.02), 'head', M(0.66, 0.5, F + 0.065));
    plate(P, 0, 0.5, F + 0.07, 1);
    mirrors(P, 0.96, 1.5, 2.5, { key: 'black', w: 0.13, h: 0.3, d: 0.08, reach: 0.2, van: true });
    wipers(P, [0.42, -0.1], 1.3, 2.55, -0.82, 0.62);
    // rear: doors, windows, lamps
    P.add(box(0.012, 1.95, 0.01), 'seam', M(0, 1.48, R - 0.002));
    P.pair(box(0.74, 0.62, 0.03), 'glass', M(0.42, 1.7, R));
    P.pair(rbox(0.13, 0.62, 0.05, 0.02), 'tail', M(0.81, 0.98, R + 0.01));
    P.add(box(0.3, 0.05, 0.03), 'tail', M(0, 2.5, R));
    P.add(rbox(1.84, 0.22, 0.16, 0.04), 'grey', M(0, 0.5, R + 0.03));
    P.add(box(0.5, 0.05, 0.16), 'plastic', M(0, 0.42, R - 0.04));                      // rear step
    plate(P, 0, 0.8, R - 0.012, -1);
    P.add(box(0.04, 0.12, 0.02), 'chrome', M(0.1, 1.2, R - 0.01));
    // roof vent hatch
    P.add(rbox(0.6, 0.08, 0.6, 0.03), 'grey', M(0, 2.76, -1.2));
    // marshrutka route board behind the windshield (lower right) + side board
    const wsA = Math.atan2(2.16 - 1.26, 2.62 - 1.8), zb = 2.4, yb = 2.16 - (zb - 1.8) * Math.tan(wsA);
    const bm = M(-0.42, yb + 0.02, zb + 0.022, -(Math.PI / 2 - wsA), 0, 0);
    P.add(box(0.42, 0.24, 0.008), 'board', bm);
    digits(P, 'boardInk', '110', 0.15, mul(bm, M(0, 0, 0.005)));
    const sm = M(-0.985, 1.72, 1.0, 0, -Math.PI / 2, 0);
    P.add(box(0.5, 0.26, 0.008), 'board', sm);
    digits(P, 'boardInk', '110', 0.16, mul(sm, M(0, 0, 0.005)));
  },
};

function panesOf(z0, z1, n, gap) {
  const out = [], len = (z1 - z0 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) { const a = z0 + i * (len + gap); out.push([a, a + len]); }
  return out;
}
const BUS = {
  family: 'box', L: 12,
  keys: [
    [-6.0, 0.44, 1.05, 2.4, 2.98, 1.19, 1.185, 1.18, 0.16, 0.0],
    [-5.965, 0.36, 1.1, 2.44, 3.09, 1.255, 1.25, 1.24, 0.22, 0.02],
    [-5.86, 0.33, 1.12, 2.46, 3.13, 1.275, 1.27, 1.26, 0.25, 0.03],
    [5.86, 0.33, 1.12, 2.46, 3.13, 1.275, 1.27, 1.26, 0.25, 0.03],
    [5.965, 0.34, 1.1, 2.44, 3.09, 1.255, 1.25, 1.24, 0.22, 0.02],
    [6.0, 0.4, 1.05, 2.4, 2.98, 1.19, 1.185, 1.18, 0.16, 0.0],
  ],
  axles: [{ z: 3.35, r: 0.5, w: 0.3, arch: 0.58, x: 1.02 }, { z: -2.55, r: 0.5, w: 0.56, arch: 0.58, x: 0.92 }],
  band: [-5.78, 5.82],
  panes: {
    1: [...panesOf(-5.72, 4.5, 7, 0.1), [4.6, 5.8]],
    [-1]: [...panesOf(-5.72, -4.45, 1, 0.1), ...panesOf(-3.05, 0.15, 2, 0.1), ...panesOf(1.65, 4.45, 2, 0.1)],
  },
  doors: [{ side: -1, z0: 4.55, z1: 5.75, split: true }, { side: -1, z0: 0.25, z1: 1.55, split: true }, { side: -1, z0: -4.35, z1: -3.15, split: true }],
  bevelKey: 'plastic', skirtKey: 'green', pillarKey: 'black',
  details(P, at) {
    const F = 6.0, R = -6.0;
    // front: windshield, LED destination board, lamps, bumper
    P.add(box(2.36, 1.8, 0.03), 'black', M(0, 1.85, F + 0.005));
    P.add(box(2.24, 1.64, 0.03), 'glass', M(0, 1.83, F + 0.02));
    P.add(box(0.03, 1.62, 0.02), 'black', M(0, 1.83, F + 0.03));
    P.add(box(1.96, 0.26, 0.04), 'ledBg', M(0, 2.83, F + 0.01));
    digits(P, 'led', '7', 0.18, M(-0.72, 2.83, F + 0.033));
    for (let i = 0; i < 9; i++) P.add(box(0.1 + (i % 3) * 0.03, 0.03, 0.006), 'led', M(-0.48 + i * 0.13, 2.84 + ((i * 7) % 3 - 1) * 0.045, F + 0.033));
    P.add(rbox(2.5, 0.42, 0.14, 0.05), 'plastic', M(0, 0.6, F - 0.02));
    for (const s of [1, -1]) {
      P.add(rbox(0.3, 0.12, 0.04, 0.02), 'head', M(s * 0.88, 0.88, F + 0.02));
      P.add(box(0.26, 0.02, 0.02), 'drl', M(s * 0.88, 0.8, F + 0.03));
      P.add(box(0.12, 0.08, 0.03), 'amber', M(s * 1.1, 0.88, F + 0.02));
    }
    plate(P, 0, 0.62, F + 0.06, 1);
    wipers(P, [0.5, -0.5], 1.08, F + 0.04, -1.45, 0.9);
    for (const s of [1, -1]) {                                                         // rabbit-ear mirrors
      rod(P, 'plastic', [s * 1.1, 2.95, F - 0.06], [s * 1.28, 2.86, F + 0.26], 0.022);
      rod(P, 'plastic', [s * 1.28, 2.86, F + 0.26], [s * 1.36, 2.42, F + 0.36], 0.022);
      P.add(rbox(0.16, 0.38, 0.07, 0.03), 'plastic', M(s * 1.37, 2.22, F + 0.37, 0, s * 0.25, 0));
      P.add(box(0.13, 0.33, 0.01), 'mirrorGlass', mul(M(s * 1.37, 2.22, F + 0.37, 0, s * 0.25, 0), M(0, 0, -0.04)));
    }
    // side LED route board (door side) and corner lamps
    P.add(box(0.012, 0.22, 0.95), 'ledBg', M(-1.272, 2.18, 3.8));
    digits(P, 'led', '7', 0.14, M(-1.28, 2.18, 3.55, 0, -Math.PI / 2, 0));
    for (let i = 0; i < 4; i++) P.add(box(0.004, 0.025, 0.1), 'led', M(-1.28, 2.18 + (i % 2 ? 0.04 : -0.04), 3.75 + i * 0.12));
    P.pair(box(0.01, 0.05, 0.1), 'amber', M(1.278, 0.75, 5.4));
    // rear
    P.add(box(2.0, 0.66, 0.03), 'glass', M(0, 2.36, R));
    P.add(box(1.7, 0.66, 0.03), 'black', M(0, 1.05, R));
    for (let i = 0; i < 6; i++) P.add(box(1.6, 0.03, 0.02), 'grey', M(0, 0.8 + i * 0.1, R - 0.02));
    P.pair(rbox(0.16, 0.8, 0.05, 0.02), 'tail', M(1.06, 1.2, R - 0.005));
    P.add(box(1.2, 0.2, 0.03), 'ledBg', M(0, 2.85, R));
    digits(P, 'led', '7', 0.14, M(0, 2.85, R - 0.016, 0, Math.PI, 0));
    P.add(rbox(2.52, 0.32, 0.14, 0.05), 'plastic', M(0, 0.55, R + 0.02));
    plate(P, 0, 0.6, R - 0.06, -1);
    // roof: CNG tank housing, A/C unit, hatches
    P.add(rbox(1.9, 0.34, 4.2, 0.12, 2), 'paint', M(0, 3.28, 1.5));
    P.add(rbox(1.7, 0.28, 2.3, 0.1, 1), 'paint', M(0, 3.26, -3.3));
    for (let i = 0; i < 3; i++) P.add(box(1.2, 0.01, 0.5), 'grey', M(0, 3.405, -4.0 + i * 0.7));
    P.add(rbox(0.7, 0.07, 0.7, 0.03), 'grey', M(0, 3.18, -0.6));
  },
};

const SPECS = { sedan: SEDAN, hatch: HATCH, suv: SUV, pickup: PICKUP, minibus: MINIBUS, bus: BUS };

/** build all parts of one vehicle type into P */
function buildVehicle(P, type, { hero = false, wheels = true } = {}) {
  const S = SPECS[type];
  const at = makeAt(S);
  loft(P, S, at, hero);
  if (wheels) {
    for (const a of S.axles) for (const s of [1, -1]) {
      wheel(P, { x: s * a.x, y: a.r, z: a.z, r: a.r, w: a.w, seg: hero ? 30 : 12, style: S.family === 'box' ? 'steel' : 'alloy', side: s, hero });
    }
  }
  S.details(P, at, hero);
  return { S, at };
}

const GEO = {};
function vehicleGeometry(type) {
  if (!GEO[type]) { const P = new Parts(); buildVehicle(P, type); GEO[type] = P.build(); }
  return GEO[type];
}

/* ------------------------------------------------------------------------------------------------
 * Fleet
 * ---------------------------------------------------------------------------------------------- */
const LIVERY = { bus: [0xffffff], minibus: [0xf6f6f3, 0xf2f1ea, 0xfafafa, 0xeeeeea] };

/**
 * Instanced fleet. placements: [{ type, color, x, z, rotY, brake }]
 * Returns { group, count, setPose(i, x, y, z, rotY), setBrake(i, on), commit() }.
 * One InstancedMesh per vehicle type present (1 draw + 1 shadow call each). Bus/minibus use their livery.
 */
export function createFleet(placements = []) {
  const group = new THREE.Group();
  group.name = 'fleet';
  const mat = vehicleMaterial('fleet');
  const byType = {}, slot = new Array(placements.length);
  placements.forEach((p, i) => {
    const t = SPECS[p.type] ? p.type : 'sedan';
    (byType[t] ||= []).push(i);
    slot[i] = [t, byType[t].length - 1];
  });
  const meshes = {}, dirty = new Set(), dirtyBrake = new Set();
  const col = new THREE.Color();
  for (const t of VEHICLE_TYPES) {
    const list = byType[t];
    if (!list) continue;
    const base = vehicleGeometry(t), n = list.length;
    const geo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'color', 'vmat']) geo.setAttribute(k, base.attributes[k]);
    geo.boundingBox = base.boundingBox.clone(); geo.boundingSphere = base.boundingSphere.clone();
    const brake = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    brake.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('brake', brake);
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.name = 'fleet-' + t;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = im.receiveShadow = true;
    list.forEach((pi, k) => {
      const p = placements[pi];
      const liv = LIVERY[t];
      col.setHex(liv ? liv[k % liv.length] : (p.color ?? 0xd0d3d6));
      im.setColorAt(k, col);
      brake.array[k] = p.brake ? 1 : 0;
    });
    meshes[t] = im;
    group.add(im);
  }
  const setPose = (i, x, y, z, rotY) => {
    const s = slot[i];
    if (!s) return;
    const im = meshes[s[0]], a = im.instanceMatrix.array, o = s[1] * 16, c = Math.cos(rotY), sn = Math.sin(rotY);
    a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    dirty.add(im);
  };
  const setBrake = (i, on) => {
    const s = slot[i];
    if (!s) return;
    const im = meshes[s[0]], b = im.geometry.attributes.brake, v = on ? 1 : 0;
    if (b.array[s[1]] !== v) { b.array[s[1]] = v; dirtyBrake.add(im); }
  };
  const commit = () => {
    for (const im of dirty) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    for (const im of dirtyBrake) im.geometry.attributes.brake.needsUpdate = true;
    dirty.clear(); dirtyBrake.clear();
  };
  placements.forEach((p, i) => setPose(i, p.x || 0, 0, p.z || 0, p.rotY || 0));
  for (const im of Object.values(meshes)) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  commit();
  return { group, count: placements.length, setPose, setBrake, commit };
}

/* ------------------------------------------------------------------------------------------------
 * Hero car (detailed sedan with interior)
 * ---------------------------------------------------------------------------------------------- */
const H = { x: 0.37, y: 0.5, z: 0.12 };                // driver H-point in car coordinates

function heroInterior(P) {
  // floor, firewall, tunnel
  P.add(box(1.64, 0.04, 2.0), 'carpet', M(0, 0.27, 0.0));
  P.add(box(1.6, 0.42, 0.04), 'dash', M(0, 0.5, 1.12));
  // dashboard (extruded side profile across the cabin)
  const sh = new THREE.Shape();
  [[1.3, 0.935], [0.9, 0.985], [0.82, 0.975], [0.79, 0.93], [0.78, 0.8], [0.82, 0.66], [0.98, 0.6], [1.26, 0.56]].forEach(([u, v], i) => (i ? sh.lineTo(u, v) : sh.moveTo(u, v)));
  sh.closePath();
  const dg = new THREE.ExtrudeGeometry(sh, { depth: 1.62, bevelEnabled: false, curveSegments: 1 });
  const dm = new THREE.Matrix4().set(0, 0, 1, -0.81, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  P.add(dg, 'dash', dm);
  P.add(box(1.5, 0.022, 0.012), 'trim', M(0, 0.86, 0.783));                           // trim strip
  for (const x of [-0.62, -0.18, 0.18, 0.62]) P.add(box(0.14, 0.045, 0.01), 'black', M(x, 0.9, 0.787));
  // instrument binnacle + dials (in front of the driver)
  P.add(rbox(0.36, 0.075, 0.15, 0.035, 2), 'dash', M(H.x, 1.0, 0.85, 0.12, 0, 0));
  for (const dx of [-0.08, 0.08]) {
    P.add(cyl(0.055, 0.055, 0.01, 20), 'black', M(H.x + dx, 0.985, 0.8, Math.PI / 2 + 0.35, 0, 0));
    P.add(new THREE.TorusGeometry(0.05, 0.004, 4, 24), 'dial', M(H.x + dx, 0.986, 0.795, 0.35, 0, 0));
  }
  // centre screen, console, gear lever
  P.add(rbox(0.26, 0.15, 0.025, 0.01), 'black', M(0, 1.06, 0.86, -0.25, 0, 0));
  P.add(box(0.235, 0.125, 0.004), 'screenGlow', M(0, 1.06, 0.846, -0.25, 0, 0));
  P.add(rbox(0.24, 0.3, 1.0, 0.04), 'dash', M(0, 0.44, 0.32));
  P.add(rbox(0.22, 0.08, 0.36, 0.03), 'seatDark', M(0, 0.6, -0.08));                  // armrest
  P.add(cyl(0.012, 0.012, 0.1, 8), 'chrome', M(0, 0.63, 0.5));
  P.add(new THREE.SphereGeometry(0.026, 10, 8), 'leather', M(0, 0.69, 0.5));
  // seats
  const seat = (x, wide = 0.5) => {
    P.add(rbox(wide, 0.13, 0.52, 0.05, 2), 'seat', M(x, 0.375, H.z + 0.13, -0.1, 0, 0));
    for (const s of [1, -1]) P.add(rbox(0.07, 0.08, 0.46, 0.03, 1), 'seat', M(x + s * (wide / 2 - 0.03), 0.45, H.z + 0.12, -0.1, 0, 0));
    const r = 0.36, by = 0.42, bz = H.z - 0.15;
    P.add(rbox(wide, 0.66, 0.13, 0.05, 2), 'seat', M(x, by + 0.33 * Math.cos(r), bz - 0.33 * Math.sin(r), -r, 0, 0));
    for (const s of [1, -1]) P.add(rbox(0.07, 0.5, 0.1, 0.03, 1), 'seat', M(x + s * (wide / 2 - 0.02), by + 0.3 * Math.cos(r), bz + 0.04 - 0.3 * Math.sin(r), -r, 0, 0));
    P.add(rbox(0.26, 0.19, 0.1, 0.04, 2), 'seat', M(x, by + 0.77 * Math.cos(r), bz - 0.77 * Math.sin(r), -r, 0, 0));
    P.add(box(0.4, 0.1, 0.42), 'plastic', M(x, 0.28, H.z + 0.08));
  };
  seat(H.x); seat(-H.x);
  // rear bench
  P.add(rbox(1.34, 0.14, 0.5, 0.05, 2), 'seat', M(0, 0.39, -0.72, -0.08, 0, 0));
  P.add(rbox(1.34, 0.56, 0.14, 0.05, 2), 'seat', M(0, 0.7, -1.06, -0.36, 0, 0));
  for (const x of [-0.42, 0.42]) P.add(rbox(0.24, 0.15, 0.09, 0.035, 1), 'seat', M(x, 1.03, -1.2, -0.36, 0, 0));
  P.add(box(1.5, 0.02, 0.36), 'seatDark', M(0, 1.0, -1.42));                         // parcel shelf
  // door cards (both sides)
  for (const s of [1, -1]) {
    P.add(box(0.04, 0.5, 2.05), 'doorCard', M(s * 0.845, 0.71, -0.07));
    P.add(box(0.05, 0.2, 2.05), 'seatDark', M(s * 0.84, 0.36, -0.07));
    P.add(box(0.08, 0.04, 0.5), 'seatDark', M(s * 0.8, 0.68, 0.2));
    P.add(box(0.08, 0.04, 0.4), 'seatDark', M(s * 0.8, 0.68, -0.75));
  }
  // headliner, visors, rear-view mirror
  P.add(box(1.24, 0.016, 1.3), 'liner', M(0, 1.392, -0.27));
  for (const x of [H.x, -H.x]) P.add(rbox(0.32, 0.016, 0.15, 0.006), 'liner', M(x, 1.378, 0.33));
  P.add(cyl(0.008, 0.008, 0.07, 6), 'black', M(0, 1.37, 0.45));
  P.add(rbox(0.24, 0.07, 0.035, 0.015), 'black', M(0, 1.325, 0.46, -0.1, 0, 0));
  P.add(box(0.22, 0.055, 0.004), 'mirrorGlass', M(0, 1.325, 0.441, -0.1, 0, 0));
  // pedals
  P.add(box(0.05, 0.1, 0.02), 'plastic', M(H.x - 0.1, 0.38, 0.98, -0.4, 0, 0));
  P.add(box(0.09, 0.07, 0.02), 'plastic', M(H.x + 0.05, 0.38, 0.98, -0.4, 0, 0));
}

/** steering wheel in its own frame: rim in local XY (radius 0.19), driver-facing side = local −Z */
function steeringWheelGeometry() {
  const P = new Parts();
  P.add(new THREE.TorusGeometry(0.19, 0.016, 10, 40), 'leather', new THREE.Matrix4());
  P.add(cyl(0.065, 0.075, 0.06, 20), 'leather', M(0, 0, 0.035, Math.PI / 2, 0, 0));
  P.add(rbox(0.15, 0.11, 0.04, 0.02, 2), 'leather', M(0, 0, 0.0));
  P.add(cyl(0.022, 0.022, 0.006, 16), 'chrome', M(0, 0.005, -0.021, Math.PI / 2, 0, 0));
  for (const s of [1, -1]) {
    P.add(box(0.12, 0.035, 0.022), 'leather', M(s * 0.125, -0.01, 0.012));
    P.add(box(0.05, 0.012, 0.004), 'trim', M(s * 0.11, -0.01, -0.001));
  }
  P.add(box(0.035, 0.12, 0.022), 'leather', M(0, -0.115, 0.018));
  P.add(cyl(0.035, 0.04, 0.3, 12), 'plastic', M(0, 0, 0.2, Math.PI / 2, 0, 0));       // column (local +Z = toward dash)
  P.add(rbox(0.12, 0.1, 0.16, 0.03), 'dash', M(0, -0.02, 0.24));                      // column shroud
  P.add(box(0.12, 0.012, 0.012), 'black', M(0.1, 0.0, 0.16));                         // stalks
  P.add(box(0.12, 0.012, 0.012), 'black', M(-0.1, 0.0, 0.16));
  return P.build();
}

/** see-through tinted glass that still reads as glass: base opacity 0.46, alpha rises with Fresnel at
 *  grazing angles, and specular/env reflections plus a sky sheen are not attenuated by alpha (env boosted ×2.6). */
function heroGlassMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x0e171d, metalness: 0, roughness: 0.035, specularIntensity: 1, ior: 1.52, transparent: true, opacity: 0.46, depthWrite: false });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;',
        'vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular * 2.6;')
      .replace('#include <opaque_fragment>', `
  float gFr = pow( 1.0 - saturate( abs( dot( normal, geometryViewDir ) ) ), 3.0 );
  float gA = clamp( diffuseColor.a + gFr * 0.5, 0.0, 0.96 );
  vec3 gR = inverseTransformDirection( reflect( - geometryViewDir, normal ), viewMatrix );
  float gSky = smoothstep( -0.25, 0.7, gR.y );
  vec3 gSheen = vec3( 0.6, 0.7, 0.8 ) * ( 0.07 + 0.6 * gFr ) * ( 0.3 + 0.7 * gSky );
  gl_FragColor = vec4( outgoingLight + ( totalSpecular + gSheen ) * ( 1.0 / gA - 1.0 ) + gSheen, gA );`);
  };
  m.customProgramCacheKey = () => 'smartcross-hero-glass';
  return m;
}

/**
 * Extra-detailed sedan for close-ups. Returns { group, driverSeat, steeringWheel, update(t, dt) }.
 * driverSeat = driver's H-point (+X side, facing +Z); steering wheel centre at driverSeat-local
 * (0, 0.40, 0.45), rim radius 0.19, rim plane tilted 25° from vertical (wheel face toward the driver).
 * update() idles the body (tiny vibration) and spins the wheels when the group is moved.
 */
export function createHeroCar({ color = 0xb8bcc2 } = {}) {
  const group = new THREE.Group();
  group.name = 'heroCar';
  const body = new THREE.Group();
  group.add(body);
  const P = new Parts();
  buildVehicle(P, 'sedan', { hero: true, wheels: false });
  heroInterior(P);
  const paintMat = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.07, side: THREE.DoubleSide });
  const glassMat = heroGlassMaterial();
  const misc = vehicleMaterial('hero');
  const paint = new THREE.Mesh(P.build(['paint']), paintMat);
  const glass = new THREE.Mesh(P.build(['glass']), glassMat);
  const rest = new THREE.Mesh(P.build(P.keys().filter(k => k !== 'paint' && k !== 'glass')), misc);
  paint.castShadow = paint.receiveShadow = rest.castShadow = rest.receiveShadow = true;
  glass.receiveShadow = true; glass.castShadow = false;
  glass.renderOrder = 2;
  body.add(paint, rest, glass);
  // wheels: one InstancedMesh (4), spun from the group's travel
  const WP = new Parts(), A = SEDAN.axles[0];
  wheel(WP, { x: 0, y: 0, z: 0, r: A.r, w: A.w, seg: 30, side: 1, hero: true });
  const wheels = new THREE.InstancedMesh(WP.build(), misc, 4);
  wheels.castShadow = wheels.receiveShadow = true;
  group.add(wheels);
  const wpos = SEDAN.axles.flatMap(a => [[a.x, a.r, a.z, 1], [-a.x, a.r, a.z, -1]]);
  const wm = new THREE.Matrix4(), wr = new THREE.Matrix4(), wy = new THREE.Matrix4();
  let spin = 0;
  const placeWheels = () => {
    wpos.forEach(([x, y, z, s], i) => {
      wy.makeRotationY(s > 0 ? 0 : Math.PI);
      wr.makeRotationX(s > 0 ? spin : -spin);
      wm.makeTranslation(x, y, z).multiply(wy).multiply(wr);
      wheels.setMatrixAt(i, wm);
    });
    wheels.instanceMatrix.needsUpdate = true;
  };
  placeWheels();
  // driver seat + steering wheel
  const driverSeat = new THREE.Object3D();
  driverSeat.name = 'driverSeat';
  driverSeat.position.set(H.x, H.y, H.z);
  body.add(driverSeat);
  const steeringWheel = new THREE.Object3D();
  steeringWheel.name = 'steeringWheel';
  steeringWheel.position.set(0, 0.4, 0.45);
  steeringWheel.rotation.x = THREE.MathUtils.degToRad(25);
  const sw = new THREE.Mesh(steeringWheelGeometry(), misc);
  sw.castShadow = sw.receiveShadow = true;
  steeringWheel.add(sw);
  driverSeat.add(steeringWheel);

  const last = new THREE.Vector3(), now = new THREE.Vector3(), fwd = new THREE.Vector3();
  let has = false;
  const update = (t, dt) => {
    body.position.y = 0.0011 * Math.sin(t * 2 * Math.PI * 23) + 0.0004 * Math.sin(t * 2 * Math.PI * 7.3);
    body.rotation.z = 0.0006 * Math.sin(t * 2 * Math.PI * 11.7);
    group.getWorldPosition(now);
    if (has) {
      const d = now.distanceTo(last);
      if (d > 1e-5 && d < 5) {
        fwd.set(0, 0, 1).transformDirection(group.matrixWorld);
        const sgn = Math.sign(fwd.dot(now.clone().sub(last))) || 1;
        spin += (sgn * d) / A.r;
        placeWheels();
      }
    }
    last.copy(now); has = true;
  };
  return { group, driverSeat, steeringWheel, update };
}

/* ------------------------------------------------------------------------------------------------
 * Demo
 * ---------------------------------------------------------------------------------------------- */
/** Showcase: every type in several colours (fronts toward +Z), one car driving a loop, and the hero car. */
export function demo() {
  const group = new THREE.Group();
  const colors = [0xf2f2f0, 0x1d1f22, 0x8e1b1b, 0xc8ccd0, 0x22334f];
  const types = ['sedan', 'hatch', 'suv', 'pickup'];
  const pl = [];
  types.forEach((t, ti) => colors.slice(0, 3).forEach((c, ci) => pl.push({ type: t, color: colors[(ti + ci) % colors.length], x: -9 + ti * 3.2, z: -ci * 7, rotY: 0, brake: ci === 1 })));
  pl.push({ type: 'minibus', color: 0xffffff, x: 4.6, z: -1, rotY: 0, brake: true });
  pl.push({ type: 'bus', color: 0xffffff, x: 8.6, z: -4, rotY: 0, brake: false });
  pl.push({ type: 'minibus', color: 0xffffff, x: 4.6, z: -10, rotY: 0, brake: false });
  pl.push({ type: 'sedan', color: 0x3a5e8c, x: 0, z: 0, rotY: 0, brake: false });   // mover
  const fleet = createFleet(pl);
  group.add(fleet.group);
  const hero = createHeroCar({ color: 0xb8bcc2 });
  hero.group.position.set(-1.5, 0, 7.5);
  group.add(hero.group);
  // preview-only stand-in for the people.js driver (torso + head + arms to the rim)
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27e, roughness: 0.7 }), shirt = new THREE.MeshStandardMaterial({ color: 0x3b6ea8, roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.36, 4, 12), shirt);
  torso.position.set(0, 0.36, -0.1); torso.rotation.x = -0.32;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), skin);
  head.position.set(0, 0.76, -0.24);
  hero.driverSeat.add(torso, head);
  for (const sx of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.42, 4, 8), shirt);
    arm.position.set(sx * 0.19, 0.45, 0.2); arm.rotation.set(1.2, 0, 0);
    hero.driverSeat.add(arm);
  }
  const mover = pl.length - 1;
  const update = (t, dt) => {
    const a = t * 0.25;
    fleet.setPose(mover, 14 + Math.cos(a) * 3, 0, -16 + Math.sin(a) * 3, -a);
    fleet.setBrake(mover, Math.sin(t * 2) > 0);
    fleet.commit();
    hero.update(t, dt);
  };
  update(0, 0);
  return { group, update, fleet, hero };
}
