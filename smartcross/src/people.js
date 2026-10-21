/**
 * people.js — procedural jointed people for the SmartCross presentation.
 * Every figure is ONE THREE.SkinnedMesh (rigid/blended skinning on a Bone hierarchy: hips, spine, chest,
 * neck, head, jaw, clavicles, shoulders, elbows, wrists, hips, knees, ankles, tool) with vertex colours and
 * per-vertex roughness/metalness/emissive through one shared MeshStandardMaterial => 1 mesh, 1 draw call.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

/* ---------------- shared material ---------------- */
let _mat = null;
function peopleMaterial() {
  if (_mat) return _mat;
  _mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  _mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aPbr;\nvarying vec3 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = aPbr;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vPbr.z;');
  };
  _mat.customProgramCacheKey = () => 'smartcross-people-v1';
  return _mat;
}
const _cc = new Map();
function C(h) { if (h && h.isColor) return h; let c = _cc.get(h); if (!c) { c = new THREE.Color(h); _cc.set(h, c); } return c; }
const mixC = (a, b, t) => C(a).clone().lerp(C(b), t);
const mulC = (a, k) => C(a).clone().multiplyScalar(k);

/* ---------------- geometry helpers ---------------- */
/** loft along Y: rings [y, rx, rz, cx, cz]; zero radius ring => apex. p = superellipse exponent. */
function loft(rings, N = 16, p = 2) {
  const pos = [], idx = [], st = [], cnt = [], e = 2 / p;
  for (const r of rings) {
    const [h, rx, rz, cx = 0, cz = 0] = r;
    st.push(pos.length / 3);
    if (rx < 1e-6 && rz < 1e-6) { pos.push(cx, h, cz); cnt.push(1); continue; }
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU, s = Math.sin(a), c = Math.cos(a);
      pos.push(cx + rx * Math.sign(s) * Math.abs(s) ** e, h, cz + rz * Math.sign(c) * Math.abs(c) ** e);
    }
    cnt.push(N);
  }
  const asc = rings[rings.length - 1][0] >= rings[0][0];
  for (let k = 0; k < rings.length - 1; k++) {
    let lo = st[k], hi = st[k + 1], nl = cnt[k], nh = cnt[k + 1];
    if (!asc) { [lo, hi] = [hi, lo]; [nl, nh] = [nh, nl]; }
    if (nl === 1 && nh === 1) continue;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      if (nl === 1) idx.push(lo, hi + j, hi + i);
      else if (nh === 1) idx.push(lo + i, lo + j, hi);
      else idx.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** capsule-like limb rings from yTop (cap radius rTop) down to yBot; mid = [[y, r], ...] */
function limbRings(yTop, yBot, rTop, rBot, mid = [], sx = 1, sz = 1, cx = 0, cz = 0, steps = 4) {
  const R = [];
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI / 2; R.push([yTop + rTop * Math.cos(a), rTop * Math.sin(a) * sx, rTop * Math.sin(a) * sz, cx, cz]); }
  R.push([yTop, rTop * sx, rTop * sz, cx, cz]);
  for (const m of mid) R.push([m[0], m[1] * (m[2] ?? sx), m[1] * (m[3] ?? sz), cx, cz]);
  R.push([yBot, rBot * sx, rBot * sz, cx, cz]);
  for (let i = steps - 1; i >= 0; i--) { const a = (i / steps) * Math.PI / 2; R.push([yBot - rBot * Math.cos(a), rBot * Math.sin(a) * sx, rBot * Math.sin(a) * sz, cx, cz]); }
  return R;
}
const _UP = V(0, 1, 0);
function capAB(a, b, r, radial = 8, flat = 1) {
  const d = V().subVectors(b, a), len = d.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-4, len), 3, radial);
  if (flat !== 1) g.scale(1, 1, flat);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_UP, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
function sphereG(ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  return mergeVertices(g, 1e-6);
}
function ell(x, y, z, rx, ry, rz, ws = 12, hs = 8) {
  const g = sphereG(ws, hs); g.scale(rx, ry, rz); g.translate(x, y, z); g.computeVertexNormals(); return g;
}
function cyl(rt, rb, h, seg = 12, x = 0, y = 0, z = 0) { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y, z); return g; }
function rbox(w, h, d, r, x = 0, y = 0, z = 0) { const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)); g.translate(x, y, z); return g; }
function tube(pts, r, seg = 12, radial = 6, closed = false) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed), seg, r, radial, closed);
}
/** grid surface fn(u,v) -> Vector3 (u to the right seen from outside, v upward) */
function ribbon(fn, nu, nv) {
  const pos = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const p = fn(i / nu, j / nv); pos.push(p.x, p.y, p.z); }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1; idx.push(a, b, c, a, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** add an inward-facing copy so thin shells (skirts) render from inside */
function twoSided(g, inset = 0.003) {
  const b = g.clone(), P = b.attributes.position, N = b.attributes.normal;
  for (let i = 0; i < P.count; i++) { P.setXYZ(i, P.getX(i) - N.getX(i) * inset, P.getY(i) - N.getY(i) * inset, P.getZ(i) - N.getZ(i) * inset); N.setXYZ(i, -N.getX(i), -N.getY(i), -N.getZ(i)); }
  const ix = b.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  return mergeGeometries([g, b]);
}

/* ---------------- part collector -> skinned geometry ---------------- */
const _p = V(), _n = V();
class Parts {
  constructor(bi) { this.bi = bi; this.list = []; }
  /** o: { c: hex|Color|fn(p,n), b: boneName|fn(p)->[[name,w],..], r, m, e, mat } */
  add(geo, o) {
    let g = geo;
    if (o.mat) g.applyMatrix4(o.mat);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.index) { const a = []; for (let i = 0; i < g.attributes.position.count; i++) a.push(i); g.setIndex(a); }
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position, Nn = g.attributes.normal, n = P.count;
    const col = new Float32Array(n * 3), pbr = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const cf = typeof o.c === 'function' ? o.c : null, cc = cf ? null : C(o.c);
    const bf = typeof o.b === 'function' ? o.b : null, bfix = bf ? 0 : this.bi[o.b];
    if (!bf && bfix === undefined) throw new Error('bone ' + o.b);
    const r = o.r ?? 0.8, m = o.m ?? 0, e = o.e ?? 0;
    for (let i = 0; i < n; i++) {
      _p.fromBufferAttribute(P, i); _n.fromBufferAttribute(Nn, i);
      const c = cf ? C(cf(_p, _n)) : cc;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      pbr[i * 3] = r; pbr[i * 3 + 1] = m; pbr[i * 3 + 2] = e;
      if (bf) {
        const ws = bf(_p); let tot = 0;
        for (let k = 0; k < ws.length && k < 4; k++) tot += ws[k][1];
        if (tot <= 0) { si[i * 4] = this.bi[ws[0][0]]; sw[i * 4] = 1; continue; }
        for (let k = 0; k < ws.length && k < 4; k++) { si[i * 4 + k] = this.bi[ws[k][0]]; sw[i * 4 + k] = ws[k][1] / tot; }
      } else { si[i * 4] = bfix; sw[i * 4] = 1; }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', P.clone()); out.setAttribute('normal', Nn.clone());
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    out.setIndex(g.index.clone());
    this.list.push(out);
  }
  build() { return mergeGeometries(this.list); }
}
const W2 = (a, b, t) => (t <= 0.001 ? [[a, 1]] : t >= 0.999 ? [[b, 1]] : [[a, 1 - t], [b, t]]);

/* ---------------- proportions & skeleton ---------------- */
const MALE = { hipY: .93, spineY: 1.06, chestY: 1.24, neckY: 1.49, headY: 1.56, clavX: .03, clavY: 1.455, shX: .195, shY: 1.437, elY: 1.13, wrY: .87, hipX: .095, kneeY: .505, ankY: .085 };
const FEMALE = { hipY: .885, spineY: 1.0, chestY: 1.18, neckY: 1.415, headY: 1.482, clavX: .028, clavY: 1.385, shX: .172, shY: 1.372, elY: 1.088, wrY: .842, hipX: .09, kneeY: .48, ankY: .08 };
// torso rings [y, rx, rz, cz]
const MALE_TORSO = [[.835, 0, 0, 0], [.845, .08, .06, 0], [.87, .135, .092, -.005], [.92, .163, .105, -.005], [.98, .165, .103, 0], [1.04, .153, .098, .004], [1.11, .150, .100, .008], [1.19, .158, .108, .013], [1.27, .166, .114, .015], [1.34, .170, .110, .008], [1.40, .168, .098, 0], [1.445, .155, .088, -.005], [1.48, .122, .074, -.008], [1.505, .072, .06, -.008], [1.51, 0, 0, -.008]];
const FEMALE_TORSO = [[.80, 0, 0, 0], [.81, .08, .06, 0], [.835, .14, .095, -.008], [.88, .170, .108, -.01], [.94, .168, .102, -.005], [1.00, .140, .090, 0], [1.06, .128, .085, .004], [1.13, .138, .095, .012], [1.20, .146, .112, .024], [1.25, .148, .110, .018], [1.31, .150, .096, .005], [1.365, .142, .082, -.004], [1.40, .116, .068, -.008], [1.428, .064, .054, -.008], [1.433, 0, 0, -.008]];

function makeProps(f, height, build = 1) {
  const k = height / (f ? 1.70 : 1.78), B = f ? FEMALE : MALE, P = { k, f, build };
  for (const key in B) P[key] = B[key] * k;
  P.hs = (f ? 1.0 : 1.05) * Math.sqrt(k);
  P.Hc = V(0, P.headY + 0.085 * P.hs, 0.012 * P.hs);
  P.rings = (f ? FEMALE_TORSO : MALE_TORSO).map(([y, rx, rz, cz]) => [y * k, rx * k * build, rz * k * (0.5 + build * 0.5), 0, cz * k]);
  P.shX *= 0.6 + 0.4 * build; P.clavX *= 1;
  return P;
}
function interpRing(R, y) {
  const S = R.filter(r => r[1] > 1e-6);
  let i = 0; while (i < S.length - 2 && S[i + 1][0] < y) i++;
  const a = S[i], b = S[i + 1], t = clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
  return [y, lerp(a[1], b[1], t), lerp(a[2], b[2], t), 0, lerp(a[4], b[4], t)];
}
function insertRings(R, ys) {
  const out = R.slice();
  for (const y of ys) out.push(interpRing(R, y));
  return out.sort((a, b) => a[0] - b[0] || (a[1] - b[1]));
}
const TP = 2.4; // torso superellipse power
function torsoPoint(R, th, y, off = 0) {
  const [, rx, rz, , cz] = interpRing(R, y), s = Math.sin(th), c = Math.cos(th), e = 2 / TP;
  return V((rx + off) * Math.sign(s) * Math.abs(s) ** e, y, cz + (rz + off) * Math.sign(c) * Math.abs(c) ** e);
}

function makeBones(P) {
  const b = {}, list = [];
  const def = (name, parent, x, y, z) => {
    const bone = new THREE.Bone(); bone.name = name; bone.userData.rest = V(x, y, z);
    if (parent) { b[parent].add(bone); bone.position.set(x, y, z).sub(b[parent].userData.rest); } else bone.position.set(x, y, z);
    bone.userData.restLocal = bone.position.clone(); b[name] = bone; list.push(bone);
  };
  const k = P.k, z0 = -0.012 * k;
  def('root', null, 0, 0, 0);
  def('hips', 'root', 0, P.hipY, 0);
  def('spine', 'hips', 0, P.spineY, 0);
  def('chest', 'spine', 0, P.chestY, 0);
  def('neck', 'chest', 0, P.neckY, -0.01 * k);
  def('head', 'neck', 0, P.headY, 0);
  def('jaw', 'head', 0, P.Hc.y - 0.03 * P.hs, P.Hc.z - 0.012 * P.hs);
  for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
    def('clav' + S, 'chest', s * P.clavX, P.clavY, -0.01 * k);
    def('arm' + S, 'clav' + S, s * P.shX, P.shY, z0);
    def('fore' + S, 'arm' + S, s * P.shX, P.elY, z0);
    def('hand' + S, 'fore' + S, s * P.shX, P.wrY, z0);
  }
  for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
    def('thigh' + S, 'hips', s * P.hipX, P.hipY, 0);
    def('shin' + S, 'thigh' + S, s * P.hipX, P.kneeY, 0);
    def('foot' + S, 'shin' + S, s * P.hipX, P.ankY, 0);
  }
  def('tool', 'root', 0, 0, 0.55);
  const bi = {}; list.forEach((x, i) => (bi[x.name] = i));
  return { b, list, bi };
}

/* ---------------- IK ---------------- */
const _A = V(), _B = V(), _Cc = V(), _T = V(), _E = V(), _u = V(), _w = V(), _x = V(), _y = V(), _z = V(), _pv = V();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qp = new THREE.Quaternion();
function setWorldBasis(bone, X, Y, Z) {
  _m4.makeBasis(X, Y, Z); _q.setFromRotationMatrix(_m4);
  bone.parent.getWorldQuaternion(_qp);
  bone.quaternion.copy(_qp.invert().multiply(_q));
  bone.updateMatrixWorld(true);
}
/** two-bone IK in world space; bend = +1 (arm: flexes toward local +Z) or -1 (leg) */
function ik2(up, lo, end, target, pole, bend = 1) {
  up.getWorldPosition(_A); lo.getWorldPosition(_B); end.getWorldPosition(_Cc);
  const l1 = _A.distanceTo(_B), l2 = _B.distanceTo(_Cc);
  _T.copy(target).sub(_A); let d = _T.length(); _T.normalize();
  d = clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _pv.copy(pole).sub(_A); _pv.addScaledVector(_T, -_pv.dot(_T)).normalize();
  _E.copy(_A).addScaledVector(_T, a).addScaledVector(_pv, h);
  const tEnd = _Cc.copy(_A).addScaledVector(_T, d);
  _u.copy(_E).sub(_A).normalize();
  _w.copy(tEnd).sub(_E); _w.addScaledVector(_u, -_w.dot(_u));
  if (_w.lengthSq() < 1e-10) { _w.copy(_pv).negate(); _w.addScaledVector(_u, -_w.dot(_u)); }
  _w.normalize().multiplyScalar(bend);
  _y.copy(_u).negate(); _x.crossVectors(_y, _w);
  setWorldBasis(up, _x, _y, _w);
  _u.copy(tEnd).sub(_E).normalize(); _y.copy(_u).negate(); _z.crossVectors(_x, _y);
  setWorldBasis(lo, _x, _y, _z);
}
const _gX = V(), _gY = V(), _gZ = V(), _gt = V(), _gm = V(), _gf = V();
/** orient a hand so its fist grips a bar (axis t, palm->bar dir m) with fingers toward fHint; returns wrist target */
function gripSolve(fig, side, gripPt, t, m, fHint, out) {
  _gt.copy(t).normalize(); _gm.copy(m); _gm.addScaledVector(_gt, -_gm.dot(_gt)).normalize();
  _gf.crossVectors(_gt, _gm).multiplyScalar(side);
  if (_gf.dot(fHint) < 0) _gt.negate();
  _gX.copy(_gm).multiplyScalar(-side); _gZ.copy(_gt); _gY.crossVectors(_gZ, _gX);
  const g = fig.grip, s = fig.scale;
  out.copy(gripPt).addScaledVector(_gX, -g.x * side * s).addScaledVector(_gY, -g.y * s).addScaledVector(_gZ, -g.z * s);
  return out;
}
function applyGrip(fig, side) { const h = fig.b[side > 0 ? 'handL' : 'handR']; setWorldBasis(h, _gX.clone(), _gY.clone(), _gZ.clone()); }

/* ---------------- head & face ---------------- */
function makeHeadF(open) {
  return function F(x, y, z, out, op = open) {
    const low = smooth(-0.22, -1.0, y);
    const sx = 1 - 0.15 * low - 0.22 * low * low * low;
    let px = x * 0.0745 * sx, py = y * 0.108, pz = z * 0.095;
    if (z < 0) pz *= 1 + 0.07 * smooth(-0.7, 0.3, y) - 0.25 * smooth(-0.25, -0.95, y);
    else { pz *= 1 - 0.06 * smooth(-0.1, 0.8, y) * z; pz += 0.016 * smooth(-0.5, -0.92, y) * z * z; }
    if (y > 0.55) py -= 0.004 * smooth(0.55, 1, y);
    const cb = Math.exp(-(((py + 0.012) / 0.022) ** 2)) * smooth(0.25, 0.65, z) * smooth(0.45, 0.85, Math.abs(x));
    px += Math.sign(x) * 0.004 * cb;
    if (z > 0) {
      for (const s of [1, -1]) { const dx = (px - s * 0.0305) / 0.017, dy = (py - 0.003) / 0.0125; pz -= 0.0045 * Math.exp(-(dx * dx + dy * dy)); }
      pz += 0.0025 * Math.exp(-(((py - 0.022) / 0.009) ** 2)) * (1 - smooth(0.035, 0.06, Math.abs(px)));
      pz += 0.005 * Math.exp(-((px / 0.03) ** 2 + ((py + 0.055) / 0.026) ** 2));
      if (op) pz -= 0.018 * Math.exp(-((px / 0.021) ** 4 + ((py + 0.0615) / 0.0105) ** 4));
    }
    return out.set(px, py, pz);
  };
}
function surfZ(F, x, y, open = false) {
  let ux = x / 0.075, uy = y / 0.108, uz = 0; const o = V();
  for (let i = 0; i < 40; i++) {
    const r2 = ux * ux + uy * uy; if (r2 > 0.995) { const s = Math.sqrt(0.995 / r2); ux *= s; uy *= s; }
    uz = Math.sqrt(1 - ux * ux - uy * uy); F(ux, uy, uz, o, open);
    ux += ((x - o.x) / 0.075) * 0.7; uy += ((y - o.y) / 0.108) * 0.7;
  }
  return o.z;
}
function hairMask(u, st) {
  const ax = Math.abs(u.x);
  let thr = lerp(st.back, st.front, smooth(-0.5, 0.55, u.z));
  thr += (st.temple || 0) * Math.exp(-(((ax - 0.55) / 0.2) ** 2)) * smooth(0.1, 0.6, u.z);
  const ear = Math.exp(-(((u.y + 0.08) / 0.3) ** 2) - ((u.z + 0.02) / 0.4) ** 2) * smooth(0.7, 0.92, ax);
  thr = lerp(thr, Math.max(thr, 0.28), ear);
  return smooth(thr - 0.05, thr + 0.07, u.y);
}
const HAIRSTYLES = {
  short: { front: 0.42, back: -0.5, temple: 0.1, th: 0.007, top: 0.009 },
  crew: { front: 0.45, back: -0.45, temple: 0.12, th: 0.004, top: 0.004 },
  side: { front: 0.38, back: -0.5, temple: 0.08, th: 0.008, top: 0.012, quiff: 0.008 },
  long: { front: 0.36, back: -0.75, th: 0.009, top: 0.01, curtain: true },
  ponytail: { front: 0.38, back: -0.6, th: 0.006, top: 0.007, tail: true },
  bun: { front: 0.38, back: -0.6, th: 0.006, top: 0.007, bun: true },
};

/** builds the head (skin, hair, face) into `parts` in model space. ex = expression */
function addHead(parts, P, look) {
  const hs = P.hs, Hc = P.Hc, ex = look.expr;
  const M = new THREE.Matrix4().makeTranslation(Hc.x, Hc.y, Hc.z).multiply(new THREE.Matrix4().makeScale(hs, hs, hs));
  const loc = V();
  const toL = (p) => loc.copy(p).sub(Hc).divideScalar(hs);
  const jawW = (p) => { const l = toL(p); const w = smooth(-0.056, -0.07, l.y) * smooth(-0.025, 0.02, l.z) * (1 - smooth(0.04, 0.066, Math.abs(l.x))); return W2('head', 'jaw', w); };
  const F = makeHeadF(!!ex.open);
  const skin = look.skin, skinD = mulC(skin, 0.86);
  const add = (g, o) => parts.add(g, { b: 'head', ...o, mat: M });
  // skull
  const head = sphereG(34, 26), hp = head.attributes.position, o = V();
  for (let i = 0; i < hp.count; i++) { F(hp.getX(i), hp.getY(i), hp.getZ(i), o); hp.setXYZ(i, o.x, o.y, o.z); }
  head.computeVertexNormals();
  const blush = ex.red || 0;
  add(head, { b: jawW, r: 0.62, c: (p) => {
    const l = toL(p);
    const ch = Math.exp(-(((Math.abs(l.x) - 0.042) / 0.018) ** 2) - (((l.y + 0.03) / 0.02) ** 2)) * smooth(0.02, 0.06, l.z);
    const fr = blush * smooth(0.0, 0.07, l.z) * (0.5 + 0.5 * smooth(-0.07, 0.06, l.y));
    return mixC(skin, 0xc8584a, Math.min(0.55, ch * (0.18 + blush * 0.4) + fr * 0.28));
  } });
  // ears
  for (const s of [1, -1]) {
    const e = ell(0, 0, 0, 0.0095, 0.028, 0.018, 10, 8); e.rotateY(s * 0.35); e.rotateX(-0.12); e.translate(s * 0.071, -0.01, -0.012);
    add(e, { c: mixC(skin, 0xc8584a, 0.08 + blush * 0.2), r: 0.65 });
    add(ell(s * 0.0752, -0.01, -0.008, 0.0035, 0.015, 0.009, 8, 6), { c: mulC(skin, 0.72) });
  }
  // eyes
  const re = 0.0122;
  for (const s of [1, -1]) {
    const xe = s * 0.0305, ye = 0.004, zs = surfZ(F, xe, ye), ze = zs - re + 0.0048;
    add(ell(xe, ye, ze, re, re, re, 14, 10), { c: 0xf0ece4, r: 0.22 });
    const gz = -s * 0.04, ix = xe + Math.sin(gz) * re, iz = ze + Math.cos(gz) * (re - 0.0012);
    add(ell(ix, ye, iz, 0.0068, 0.0068, 0.0024, 12, 8), { c: look.iris, r: 0.2 });
    add(ell(ix + Math.sin(gz) * 0.0016, ye, iz + 0.0016, 0.0032, 0.0032, 0.0012, 10, 6), { c: 0x050404, r: 0.15 });
    add(ell(ix + 0.0026, ye + 0.0028, iz + 0.0026, 0.0012, 0.0012, 0.0006, 6, 4), { c: 0xffffff, r: 0.1, e: 1.2 });
    // lids
    const lidA = ex.lid ?? 1.05, tilt = (ex.lidTilt || 0) * s;
    const up = new THREE.SphereGeometry(re + 0.0012, 16, 6, 0, TAU, 0, lidA); up.rotateX(0.12); up.rotateZ(tilt); up.translate(xe, ye, ze);
    add(up, { c: mulC(skin, 0.93), r: 0.6 });
    const lash = new THREE.SphereGeometry(re + 0.0017, 16, 2, 0, TAU, lidA - 0.14, 0.15); lash.rotateX(0.12); lash.rotateZ(tilt); lash.translate(xe, ye, ze);
    add(lash, { c: 0x1a1210, r: 0.7 });
    const lo = new THREE.SphereGeometry(re + 0.0008, 16, 4, 0, TAU, Math.PI - 0.95, 0.95); lo.rotateX(-0.1); lo.translate(xe, ye, ze);
    add(lo, { c: mulC(skin, 0.95), r: 0.6 });
    // brows
    const B = ex.brow || [[0.011, 0.022], [0.028, 0.0275], [0.046, 0.0245]];
    const bt = ex.browT || [0.0042, 0.0038, 0.0024];
    for (let i = 0; i < 2; i++) {
      const a = V(s * B[i][0], B[i][1], 0), b = V(s * B[i + 1][0], B[i + 1][1], 0);
      a.z = surfZ(F, a.x, a.y) + 0.0016; b.z = surfZ(F, b.x, b.y) + 0.0014;
      add(capAB(a, b, (bt[i] + bt[i + 1]) / 2, 6, 0.55), { c: look.brow, r: 0.9 });
    }
    if (ex.frown) {
      const a = V(s * 0.006, 0.004, 0), b = V(s * 0.0045, 0.017, 0);
      a.z = surfZ(F, a.x, a.y) + 0.0004; b.z = surfZ(F, b.x, b.y) + 0.0004;
      add(capAB(a, b, 0.0011, 4), { c: mulC(skin, 0.68) });
      // nasolabial folds
      const pts = [V(s * 0.016, -0.034), V(s * 0.024, -0.05), V(s * 0.027, -0.066)].map(p => (p.z = surfZ(F, p.x, p.y) + 0.0005, p));
      add(tube(pts, 0.0012, 6, 4), { c: mulC(skin, 0.72) });
    }
  }
  // nose
  const nz = (x, y) => surfZ(F, x, y);
  add(capAB(V(0, 0.012, nz(0, 0.012) + 0.0015), V(0, -0.02, nz(0, -0.02) + 0.008), 0.0058, 8, 0.9), { c: skin, r: 0.55 });
  add(capAB(V(0, -0.016, nz(0, -0.016) + 0.007), V(0, -0.03, nz(0, -0.03) + 0.0125), 0.0078, 8), { c: skin, r: 0.55 });
  add(ell(0, -0.0325, nz(0, -0.0325) + 0.0128, 0.0098, 0.0092, 0.0095, 10, 8), { c: mixC(skin, 0xc8584a, 0.06 + blush * 0.2), r: 0.5 });
  for (const s of [1, -1]) {
    add(ell(s * 0.0108, -0.0355, nz(s * 0.0108, -0.0355) + 0.0045, 0.0072, 0.0062, 0.0068, 8, 6), { c: skin, r: 0.55 });
    add(ell(s * 0.0056, -0.0408, nz(0, -0.0408) + 0.0075, 0.0034, 0.0016, 0.0026, 6, 4), { c: 0x3a2018, r: 0.8 });
  }
  // mouth
  const lip = mixC(skin, look.f ? 0xb04654 : 0xa0504a, look.f ? 0.55 : 0.4);
  if (!ex.open) {
    const sm = ex.smile || 0;
    const L = (pts, r) => tube(pts.map(([x, y]) => V(x, y, surfZ(F, x, y) + 0.0006)), r, 10, 6);
    add(L([[-0.022, -0.0577 + sm], [-0.011, -0.0556], [0, -0.0561], [0.011, -0.0556], [0.022, -0.0577 + sm]], 0.0033), { c: lip, r: 0.45 });
    add(L([[-0.019, -0.0606 + sm * 0.7], [0, -0.0636], [0.019, -0.0606 + sm * 0.7]], 0.0042), { b: jawW, c: lip, r: 0.4 });
    add(tube([[-0.0235, -0.0588 + sm], [0, -0.0587], [0.0235, -0.0588 + sm]].map(([x, y]) => V(x, y, surfZ(F, x, y) + 0.0028)), 0.0011, 10, 4), { b: jawW, c: mulC(lip, 0.45) });
  } else {
    const cy = -0.0615, z0 = surfZ(F, 0, cy, false);
    const mw = (p) => { const l = toL(p); return W2('head', 'jaw', smooth(cy + 0.004, cy - 0.004, l.y)); };
    add(ell(0, cy - 0.001, z0 - 0.009, 0.021, 0.013, 0.011, 14, 10), { b: mw, c: 0x3a1214, r: 0.7 });
    add(rbox(0.031, 0.0068, 0.009, 0.0025, 0, cy + 0.0062, z0 - 0.006), { c: 0xece5d6, r: 0.3 });
    add(rbox(0.027, 0.0058, 0.008, 0.0022, 0, cy - 0.0068, z0 - 0.007), { b: 'jaw', c: 0xe6dfcf, r: 0.3 });
    add(ell(0, cy - 0.008, z0 - 0.011, 0.013, 0.004, 0.008, 10, 6), { b: 'jaw', c: 0xa84848, r: 0.5 });
    const ring = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * TAU, c = Math.cos(a), s = Math.sin(a);
      const x = 0.0235 * Math.sign(c) * Math.abs(c) ** 0.7, y = cy + 0.011 * Math.sign(s) * Math.abs(s) ** 0.75 - 0.003 * (x / 0.0235) ** 2;
      ring.push(V(x, y, surfZ(F, x, y, false) - 0.0005));
    }
    add(tube(ring, 0.0034, 40, 6, true), { b: mw, c: lip, r: 0.45 });
  }
  // hair
  const st = HAIRSTYLES[look.hair] || HAIRSTYLES.short;
  const hair = sphereG(34, 26), hpp = hair.attributes.position, u = V();
  for (let i = 0; i < hpp.count; i++) {
    u.set(hpp.getX(i), hpp.getY(i), hpp.getZ(i));
    const m = hairMask(u, st);
    let th = st.th + st.top * smooth(0.2, 1, u.y) + (st.quiff || 0) * smooth(0.3, 0.8, u.z) * smooth(0.3, 0.7, u.y);
    th = m > 0.01 ? th * Math.min(1, m * 1.3) : 0;
    F(u.x, u.y, u.z, o, false);
    const d = th - (1 - m) * 0.004;
    o.addScaledVector(u, d + 0.0012);
    hpp.setXYZ(i, o.x, o.y, o.z);
  }
  hair.computeVertexNormals();
  const hc = look.hairC, hcL = mixC(hc, 0x8a7060, 0.12);
  add(hair, { c: (p, n) => mixC(hc, hcL, clamp(n.y, 0, 1) * 0.6), r: 0.55 });
  if (st.curtain) add(loft([[0.03, 0, 0, 0, -0.045], [0.02, 0.07, 0.04, 0, -0.045], [-0.05, 0.083, 0.05, 0, -0.048], [-0.15, 0.085, 0.045, 0, -0.055], [-0.2, 0.075, 0.035, 0, -0.06], [-0.215, 0, 0, 0, -0.06]], 18), { c: hc, r: 0.6 });
  if (st.tail) {
    add(ell(0, 0.035, -0.1, 0.022, 0.02, 0.02, 10, 8), { c: hc, r: 0.6 });
    add(capAB(V(0, 0.025, -0.115), V(0, -0.1, -0.125), 0.02, 10), { c: hc, r: 0.6 });
    add(cyl(0.017, 0.017, 0.012, 10, 0, 0.022, -0.112), { c: look.accent || 0xc03050 });
  }
  if (st.bun) add(ell(0, 0.075, -0.075, 0.034, 0.03, 0.032, 12, 10), { c: hc, r: 0.6 });
  if (look.glasses) {
    for (const s of [1, -1]) {
      const r = new THREE.TorusGeometry(0.0165, 0.0015, 5, 20); r.scale(1.15, 0.82, 1); r.translate(s * 0.031, 0.003, surfZ(F, s * 0.031, 0.003) + 0.011);
      add(r, { c: look.glasses, r: 0.3, m: 0.3 });
      add(capAB(V(s * 0.05, 0.007, surfZ(F, s * 0.05, 0.007) + 0.009), V(s * 0.072, 0.005, -0.02), 0.0013, 4), { c: look.glasses, r: 0.3 });
    }
    add(capAB(V(-0.012, 0.006, surfZ(F, 0, 0.006) + 0.01), V(0.012, 0.006, surfZ(F, 0, 0.006) + 0.01), 0.0014, 4), { c: look.glasses, r: 0.3 });
  }
  return { M, F };
}

/* ---------------- hands ---------------- */
const CURL = { relaxed: [0.32, 0.5, 0.3], grip: [1.0, 1.4, 0.9], open: [0.05, 0.08, 0.05] };
/** hand geometry in hand-local space (wrist at origin, fingers along -Y, palm facing -side*X) */
function handGeos(side, kind, s) {
  const out = [], sd = side;
  out.push(rbox(0.030, 0.092, 0.080, 0.012, 0, -0.052, 0.002));
  out.push(ell(-sd * 0.011, -0.045, 0.024, 0.012, 0.026, 0.017, 8, 6));
  const fz = [0.027, 0.009, -0.009, -0.026], fl = [0.96, 1, 0.95, 0.78], fr = [0.0085, 0.0088, 0.0083, 0.0072], cu = CURL[kind];
  for (let i = 0; i < 4; i++) {
    let p = V(sd * 0.002, -0.093, fz[i]), ang = 0;
    const lens = [0.044, 0.027, 0.021].map(l => l * fl[i]);
    const spread = (i - 1.5) * (kind === 'open' ? 0.09 : 0.02);
    for (let j = 0; j < 3; j++) {
      ang += cu[j] * (kind === 'relaxed' ? 0.8 + 0.12 * i : 1);
      const d = V(-sd * Math.sin(ang), -Math.cos(ang), Math.sin(spread)).normalize();
      const q = p.clone().addScaledVector(d, lens[j]);
      out.push(capAB(p, q, fr[i] * (1 - j * 0.08), 5)); p = q;
    }
  }
  const T = kind === 'grip' ? [[0.01, -0.03, 0.03], [0.03, -0.058, 0.046], [0.044, -0.082, 0.038], [0.05, -0.097, 0.022]]
    : kind === 'open' ? [[0.008, -0.025, 0.035], [0.012, -0.05, 0.065], [0.012, -0.072, 0.08], [0.01, -0.09, 0.088]]
      : [[0.008, -0.025, 0.032], [0.017, -0.055, 0.05], [0.02, -0.077, 0.052], [0.019, -0.094, 0.046]];
  const tp = T.map(([x, y, z]) => V(-sd * x, y, z));
  for (let j = 0; j < 3; j++) out.push(capAB(tp[j], tp[j + 1], 0.0105 - j * 0.0008, 6));
  for (const g of out) g.scale(s, s, s);
  return out;
}
const GRIP = V(-0.034, -0.1, 0); // grip bar centre in hand-local (x multiplied by side)

/* ---------------- shoe ---------------- */
function shoeGeos(boot) {
  const R = [[-0.066, 0, 0, 0, -0.045], [-0.06, 0.03, 0.035, 0, -0.045], [-0.045, 0.042, 0.045, 0, -0.048], [-0.01, 0.047, 0.052, 0, -0.055], [0.04, 0.049, 0.042, 0, -0.045], [0.09, 0.05, 0.033, 0, -0.036], [0.14, 0.047, 0.028, 0, -0.03], [0.18, 0.04, 0.024, 0, -0.026], [0.2, 0.03, 0.018, 0, -0.024], [0.21, 0, 0, 0, -0.022]];
  const up = loft(R, 16, 2.5); up.rotateX(Math.PI / 2);
  const sole = loft([[-0.07, 0, 0, 0, -0.012], [-0.066, 0.034, 0.012, 0, -0.012], [-0.05, 0.047, 0.012, 0, -0.012], [0.09, 0.054, 0.012, 0, -0.012], [0.18, 0.045, 0.012, 0, -0.012], [0.205, 0.032, 0.012, 0, -0.012], [0.215, 0, 0, 0, -0.012]], 16, 3);
  sole.rotateX(Math.PI / 2);
  const res = { up, sole };
  if (boot) res.shaft = loft(limbRings(0.2, 0.03, 0.05, 0.05, [], 1, 1.1, 0, -0.01, 2), 14);
  return res;
}

/* ---------------- figure assembly ---------------- */
/**
 * cfg: { f, height, build, look:{skin,hair,hairC,brow,iris,expr,glasses,f}, o:{top,topHem,sleeves,collar,zip,buttons,vneck,tie,
 *  belt,legs,skirt,shoes,sole,boot,gloves,hood,pocket,stripes,legStripe}, hands:{L,R}, extras(parts,P,fig) }
 */
function buildFigure(cfg) {
  const f = !!cfg.f, P = makeProps(f, cfg.height, cfg.build || 1), k = P.k;
  const { b, list, bi } = makeBones(P);
  const parts = new Parts(bi), o = cfg.o, L = cfg.look, skin = L.skin;
  const fig = { P, b, list, parts, scale: 1, grip: GRIP.clone().multiplyScalar(f ? 0.92 : 1) };
  const topHem = o.topHem ?? (P.hipY + 0.07 * k);
  // ---- torso
  const R = insertRings(P.rings, [topHem - 0.002, topHem + 0.002]);
  P.R = P.rings;
  const torsoW = (p) => {
    const y = p.y, ax = Math.abs(p.x);
    const wh = 1 - smooth(P.hipY + 0.04 * k, P.spineY + 0.04 * k, y);
    let wc = smooth(P.spineY + 0.04 * k, P.chestY, y);
    const wcl = smooth(0.09 * k, 0.16 * k, ax) * smooth(P.shY - 0.07 * k, P.shY + 0.01 * k, y) * 0.75;
    const ws = Math.max(0, 1 - wh - wc); wc *= 1 - wcl;
    return [['hips', wh], ['spine', ws], ['chest', wc], [p.x > 0 ? 'clavL' : 'clavR', wcl]].filter(w => w[1] > 1e-3);
  };
  parts.add(loft(R, 20, TP), { b: torsoW, c: (p) => (p.y >= topHem ? o.top : o.legs), r: o.topR ?? 0.85, e: o.topE || 0 });
  const tp = (th, y, off) => torsoPoint(P.rings, th, y, off);
  const band = (y0, y1, off, c, extra = {}) => parts.add(ribbon((u, v) => tp(u * TAU - Math.PI, lerp(y0, y1, v), off), 40, 2), { b: torsoW, c, r: 0.8, ...extra });
  const patch = (th0, th1, y0, y1, off, c, extra = {}, wfn) => parts.add(ribbon((u, v) => { const y = lerp(y0, y1, v); const w = wfn ? wfn(v) : 1; return tp(lerp(th0, th1, u) * w, y, off); }, 8, 8), { b: torsoW, c, r: 0.8, ...extra });
  fig.band = band; fig.patch = patch; fig.tp = tp; fig.torsoW = torsoW;
  if (o.hemBand !== false && topHem > P.hipY - 0.05 * k) band(topHem - 0.012 * k, topHem + 0.006 * k, 0.004, mulC(o.top, 0.85));
  if (o.belt) { band(P.hipY + 0.06 * k, P.hipY + 0.095 * k, 0.004, o.belt, { r: 0.45 }); const fp = tp(0, P.hipY + 0.0775 * k, 0.006); parts.add(rbox(0.05, 0.034, 0.01, 0.004, fp.x, fp.y, fp.z), { b: 'hips', c: 0xb8b4a8, r: 0.3, m: 0.9 }); }
  if (o.zip) patch(-0.035, 0.035, topHem + 0.01, P.clavY + 0.01 * k, 0.003, o.zip, { r: 0.35, m: 0.6 });
  if (o.vneck) patch(-0.32, 0.32, P.shY - 0.13 * k, P.clavY + 0.035 * k, 0.002, o.vneck, {}, (v) => 0.12 + v * 0.88);
  if (o.tie) {
    const pts = [tp(0, P.clavY + 0.01 * k, 0.012), tp(0, P.shY - 0.1 * k, 0.012), tp(0, P.chestY - 0.06 * k, 0.012), tp(0, P.spineY + 0.03 * k, 0.014)];
    parts.add(tube(pts, 0.016 * k, 10, 6), { b: 'chest', c: o.tie, r: 0.5 });
  }
  if (o.buttons) for (let y = P.shY - 0.07 * k; y > topHem + 0.04; y -= 0.075 * k) { const q = tp(0, y, 0.004); parts.add(ell(q.x, q.y, q.z, 0.0055, 0.0055, 0.003, 6, 4), { b: torsoW, c: o.buttons, r: 0.4 }); }
  if (o.pocket) patch(-0.5, 0.5, topHem + 0.03 * k, topHem + 0.16 * k, 0.005, o.pocket);
  // collar
  if (o.collar) {
    const cr = loft([[P.clavY + 0.005 * k, 0.062 * k, 0.07 * k, 0, 0.0], [P.clavY + 0.045 * k, 0.058 * k, 0.064 * k, 0, 0.004]], 18);
    parts.add(twoSided(cr, 0.004), { b: 'chest', c: o.collar, r: 0.8 });
  }
  if (o.hood) {
    const h = new THREE.TorusGeometry(0.085 * k, 0.03 * k, 8, 18, Math.PI * 1.2); h.rotateX(Math.PI / 2); h.rotateZ(0); h.rotateY(Math.PI / 2 + 0.6 * Math.PI / 2 - Math.PI * 0.3 + Math.PI);
    h.rotateY(-Math.PI * 0.4); h.scale(1, 0.9, 0.9); h.translate(0, P.clavY + 0.01 * k, -0.035 * k);
    parts.add(h, { b: 'chest', c: mulC(o.top, 0.95) });
    for (const s of [1, -1]) parts.add(capAB(tp(s * 0.15, P.clavY - 0.01 * k, 0.008), tp(s * 0.17, P.shY - 0.14 * k, 0.012), 0.003, 4), { b: 'chest', c: 0xeeeeee });
  }
  // neck
  parts.add(loft(limbRings(P.headY + 0.05 * k, P.clavY - 0.03 * k, 0.05 * k, 0.058 * k, [], 1, 1.1, 0, -0.008), 14), { b: (p) => W2('neck', 'head', smooth(P.headY - 0.01 * k, P.headY + 0.04 * k, p.y)), c: skin, r: 0.65 });
  // head
  fig.head = addHead(parts, P, { ...L, f });
  // ---- arms
  const sleeveC = o.sleeveC ?? o.top, longS = o.sleeves !== 'short';
  for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
    const x = s * P.shX, z0 = -0.012 * k, so = longS ? 0.006 : 0.004;
    const hem = longS ? P.wrY + 0.035 * k : P.shY - 0.13 * k;
    const ua = limbRings(P.shY, P.elY, 0.052 * k, 0.04 * k, [[P.shY - 0.06 * k, 0.05 * k], [P.shY - 0.15 * k, 0.046 * k]], 1, 1.05, x, z0);
    const fa = limbRings(P.elY, P.wrY, 0.039 * k, 0.026 * k, [[P.elY - 0.07 * k, 0.04 * k], [P.wrY + 0.05 * k, 0.03 * k]], 0.92, 1.22, x, z0);
    const grow = (Rr) => Rr.map(r => (r[0] > hem ? [r[0], r[1] + (r[1] > 1e-6 ? so : 0), r[2] + (r[2] > 1e-6 ? so : 0), r[3], r[4]] : r));
    const colA = (p) => (p.y > hem ? sleeveC : skin);
    const ins = (Rr) => { const out = Rr.slice(); const ys = Rr.map(r => r[0]); if (hem < Math.max(...ys) && hem > Math.min(...ys)) { const i = out.findIndex((r, j) => j > 0 && r[0] < hem && out[j - 1][0] >= hem); if (i > 0) { const a = out[i - 1], bb = out[i], t = (hem - a[0]) / (bb[0] - a[0]); const m = [hem, lerp(a[1], bb[1], t), lerp(a[2], bb[2], t), x, z0]; out.splice(i, 0, [hem + 0.002, m[1] + so, m[2] + so, x, z0], [hem - 0.002, m[1], m[2], x, z0]); } } return out; };
    parts.add(loft(ins(grow(ua)), 16), { b: 'arm' + S, c: colA, r: 0.82, e: o.sleeveE || 0 });
    parts.add(loft(ins(grow(fa)), 14), { b: 'fore' + S, c: colA, r: 0.82, e: o.sleeveE || 0 });
    if (o.armStripes) for (const yy of o.armStripes) { const bone = yy > P.elY ? 'arm' : 'fore'; parts.add(loft([[yy * k + 0.012, 0.049 * k, 0.052 * k, x, z0], [yy * k - 0.012, 0.047 * k, 0.05 * k, x, z0]], 16), { b: bone + S, c: 0xd9dee2, r: 0.3, e: 0.25 }); }
    // hand
    const hk = (cfg.hands && cfg.hands[S]) || 'relaxed', hc = o.gloves || skin;
    const mt = new THREE.Matrix4().makeTranslation(x, P.wrY, z0);
    for (const g of handGeos(s, hk, f ? 0.92 : 1)) parts.add(g, { b: 'hand' + S, c: hc, r: o.gloves ? 0.75 : 0.6, mat: mt });
    if (o.gloves) parts.add(loft([[0.005, 0.034, 0.042], [-0.025, 0.031, 0.04]], 12).applyMatrix4(mt), { b: 'hand' + S, c: mulC(hc, 0.9) });
  }
  // ---- legs
  const legC = o.skirt ? (o.tights ?? skin) : o.legs;
  for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
    const x = s * P.hipX;
    parts.add(loft(limbRings(P.hipY + 0.005 * k, P.kneeY, 0.07 * k * (f ? 1.04 : 1), 0.056 * k, [[P.hipY - 0.08 * k, 0.08 * k], [P.hipY - 0.25 * k, 0.072 * k], [P.kneeY + 0.06 * k, 0.058 * k]], 1, 1.05, x, 0), 16), { b: 'thigh' + S, c: legC, r: 0.85 });
    const bare = !!o.skirt;
    const shinR = bare ? limbRings(P.kneeY, P.ankY + 0.01, 0.052 * k, 0.03 * k, [[P.kneeY - 0.12 * k, 0.054 * k], [P.ankY + 0.12 * k, 0.038 * k]], 1, 1.05, x, 0)
      : limbRings(P.kneeY, P.ankY - 0.025 * k, 0.055 * k, 0.058 * k, [[P.kneeY - 0.12 * k, 0.058 * k], [P.ankY + 0.1 * k, 0.056 * k]], 1, 1.08, x, 0, 3);
    parts.add(loft(shinR, 16), { b: 'shin' + S, c: (p) => (o.legStripe && !bare && p.y < P.ankY + 0.17 * k && p.y > P.ankY + 0.12 * k ? 0xd9dee2 : legC), r: 0.85 });
    if (o.piping) { parts.add(capAB(V(x + s * 0.087 * k, P.hipY - 0.03 * k, 0), V(x + s * 0.058 * k, P.kneeY, 0), 0.0035, 4), { b: 'thigh' + S, c: o.piping }); parts.add(capAB(V(x + s * 0.058 * k, P.kneeY, 0), V(x + s * 0.06 * k, P.ankY + 0.02, 0), 0.0035, 4), { b: 'shin' + S, c: o.piping }); }
    const sh = shoeGeos(o.boot), mt = new THREE.Matrix4().makeTranslation(x, 0, 0).multiply(new THREE.Matrix4().makeRotationY(s * 0.07));
    const fw = (p) => W2('foot' + S, 'shin' + S, 0);
    parts.add(sh.up.applyMatrix4(mt), { b: fw, c: o.shoes, r: o.shoeR ?? 0.45 });
    parts.add(sh.sole.applyMatrix4(mt), { b: fw, c: o.sole ?? 0x2a2522, r: 0.8 });
    if (sh.shaft) parts.add(sh.shaft.applyMatrix4(mt), { b: (p) => W2('foot' + S, 'shin' + S, smooth(0.09, 0.18, p.y)), c: o.shoes, r: 0.5 });
  }
  if (o.skirt) {
    const top = P.hipY + 0.13 * k, Rk = [[top, 0.135 * k, 0.09 * k, 0, 0], [P.hipY + 0.06 * k, 0.17 * k, 0.11 * k, 0, -0.005], [P.hipY - 0.05 * k, 0.19 * k, 0.13 * k, 0, -0.005], [o.skirtLen ?? P.kneeY + 0.02, 0.215 * k, 0.155 * k, 0, 0]];
    const sw = (p) => { const t = smooth(P.hipY, P.kneeY, p.y) * 0.7; const side = p.x > 0 ? 'thighL' : 'thighR'; return [['hips', 1 - t], [side, t]]; };
    parts.add(twoSided(loft(Rk, 24), 0.004), { b: sw, c: o.skirt, r: 0.8 });
  }
  if (cfg.extras) cfg.extras(parts, P, fig);
  // ---- skinned mesh
  const geo = parts.build();
  const mesh = new THREE.SkinnedMesh(geo, peopleMaterial());
  mesh.add(b.root); mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.boundingSphere = new THREE.Sphere(V(0, 1.0, 0.1), 1.5);
  mesh.name = 'person';
  const body = new THREE.Group(); body.add(mesh);
  const group = new THREE.Group(); group.add(body);
  Object.assign(fig, { group, body, mesh });
  fig.reset = () => { for (const x of list) { x.quaternion.identity(); x.position.copy(x.userData.restLocal); } };
  return fig;
}

/* ---------------- palettes & looks ---------------- */
const SKIN = [0xe8c4a2, 0xdeb491, 0xd6a882, 0xcb9a74, 0xc08d68, 0xefcfb2];
const HAIRC = [0x16110e, 0x1f1712, 0x2b1e16, 0x3b2a1f, 0x120f0e, 0x4a3628];
const IRIS = [0x3a2416, 0x2b1a10, 0x4a3020, 0x2f2218];
function baseLook(r, f, extra = {}) {
  const hairC = r() < 0.08 && !f ? 0x8a8580 : pick(r, HAIRC);
  return { skin: pick(r, SKIN), hairC, brow: mulC(hairC, 0.9), iris: pick(r, IRIS), hair: f ? pick(r, ['long', 'ponytail', 'bun', 'long']) : pick(r, ['short', 'side', 'crew']), expr: { smile: 0.001 + r() * 0.002 }, ...extra };
}
const _tw = V(), _tw2 = V();

/* ---------------- walk / idle ---------------- */
function walkPose(fig, ph, amp = 1, armAmp = 1) {
  const { b, P } = fig, s = Math.sin(ph);
  const Lt = P.hipY - P.kneeY, Ls = P.kneeY - P.ankY;
  const legs = [];
  for (const [side, S, off] of [[1, 'L', 0], [-1, 'R', Math.PI]]) {
    const p = ph + off, sp = Math.sin(p), cp = Math.cos(p);
    const th = (-0.32 * sp - 0.04) * amp;
    const kn = (0.08 + 1.0 * Math.max(0, Math.cos(p + 0.35)) ** 2 + 0.16 * Math.max(0, Math.cos(p - 1.9)) ** 4) * amp;
    b['thigh' + S].rotation.set(th, 0, side * 0.02);
    b['shin' + S].rotation.x = kn;
    const toe = 0.45 * Math.max(0, Math.cos(p + 2.2)) ** 3 - 0.2 * Math.max(0, Math.cos(p - 1.3)) ** 3;
    b['foot' + S].rotation.x = (-(th + kn) * (1 - smooth(-0.2, 0.6, cp) * 0.6) + toe) * 1;
    legs.push(Lt * Math.cos(th) + Ls * Math.cos(th + kn));
    const a = 0.3 * sp * armAmp;
    b['arm' + S].rotation.set(a, 0, side * 0.1);
    b['fore' + S].rotation.x = -(0.22 + 0.32 * Math.max(0, -sp)) * armAmp - 0.05;
    b['hand' + S].rotation.set(0, 0, side * -0.05);
  }
  b.hips.position.y = Math.max(legs[0], legs[1]) + P.ankY + 0.005;
  b.hips.position.x = 0.012 * Math.sin(ph) * amp;
  b.hips.rotation.set(0.02, -0.09 * s * amp, 0.03 * Math.cos(ph) * amp);
  b.spine.rotation.set(0.04, 0.07 * s * amp, -0.02 * Math.cos(ph) * amp);
  b.chest.rotation.set(0.0, 0.06 * s * amp, 0);
  b.head.rotation.set(-0.02, -0.04 * s * amp, 0);
}
function idlePose(fig, t, r0) {
  const { b } = fig;
  const br = Math.sin(t * 1.6 + r0) * 0.012, sh = Math.sin(t * 0.35 + r0);
  b.hips.position.x = 0.012 * sh; b.hips.rotation.z = -0.025 * sh;
  b.thighL.rotation.set(-0.03, 0, 0.03 + 0.02 * sh); b.thighR.rotation.set(0.02, 0, -0.03 + 0.02 * sh);
  b.shinL.rotation.x = 0.05 + 0.04 * Math.max(0, -sh); b.shinR.rotation.x = 0.05 + 0.04 * Math.max(0, sh);
  b.footL.rotation.x = -0.02; b.footR.rotation.x = -0.07;
  b.spine.rotation.set(br, 0, 0.02 * sh); b.chest.rotation.x = br;
  for (const [s, S] of [[1, 'L'], [-1, 'R']]) { b['arm' + S].rotation.set(0.05, 0, s * (0.09 + br)); b['fore' + S].rotation.x = -0.22; }
  b.head.rotation.set(0.03, 0.35 * Math.sin(t * 0.23 + r0) * smooth(0.3, 0.9, Math.abs(Math.sin(t * 0.23 + r0))), 0);
}

/** Pedestrian / student: walk cycle in place (integrator moves & turns the group). */
export function createPerson({ seed = 1, kind = 'pedestrian', gender, walking = true } = {}) {
  const r = mulberry32(seed * 7919 + 17);
  const f = gender ? /^f/i.test(gender) : r() < 0.5;
  const student = kind === 'student';
  const height = f ? 1.72 + r() * 0.05 : 1.76 + r() * 0.09;
  const look = baseLook(r, f, { glasses: r() < (student ? 0.3 : 0.15) ? pick(r, [0x1a1a1a, 0x5a3a22, 0x9a9aa0]) : 0 });
  const shoes = pick(r, student ? [0xf0f0ee, 0x222222, 0x3a5a8a, 0xf0f0ee] : [0x1c1a18, 0x4a2e1c, 0x2a2420, 0xe8e6e0]);
  let o;
  const jeans = pick(r, [0x2c3e5c, 0x34496e, 0x1f2a3e, 0x4a5a78]);
  if (student) {
    const top = pick(r, [0xc23b3b, 0x2f6fb5, 0x3f8f5f, 0xe0a030, 0x6a4c9c, 0x8a8f96, 0xe86a50, 0x2a9a9a]);
    o = r() < 0.6 ? { top, topHem: null, hood: true, pocket: mulC(top, 0.9), legs: jeans, shoes, sole: 0xf2f2f0 }
      : { top, sleeves: r() < 0.5 ? 'short' : 'long', legs: f && r() < 0.4 ? 0x2a2a2e : jeans, shoes, sole: 0xf2f2f0, collar: null, zip: r() < 0.5 ? 0x9a9aa0 : 0, hemBand: true };
    if (f && r() < 0.3) { o.skirt = pick(r, [0x2a2a3a, 0x7a2a3a, 0x3a4a6a]); o.tights = 0x2a2626; }
  } else if (f) {
    const v = r();
    if (v < 0.4) o = { top: pick(r, [0xb83a3a, 0x3a5a8a, 0xc8b49a, 0x2e2e33, 0x6a7a5a]), topHem: 0.62, legs: pick(r, [0x222226, 0x3a3a42, 0x2c3e5c]), shoes, belt: 0, collar: null, buttons: 0x222222 };
    else if (v < 0.75) o = { top: pick(r, [0xf2ede4, 0xe8a0a0, 0xa8c4e0, 0xd8c8f0, 0xf0d890]), topHem: 0.98, sleeves: r() < 0.5 ? 'short' : 'long', skirt: pick(r, [0x1e2233, 0x6a2232, 0x3a3a3a, 0xb09070]), tights: r() < 0.5 ? 0x2a2626 : null, shoes, vneck: null };
    else o = { top: pick(r, [0x3a6a6a, 0xd06040, 0x5a4a8a]), legs: pick(r, [0x222226, 0x2c3e5c, 0xc8b49a]), shoes, sleeves: 'long' };
  } else {
    const v = r();
    if (v < 0.4) o = { top: pick(r, [0x2a3442, 0x3a3a3e, 0x4a5a3a, 0x6a3a2a, 0x8a7a5e, 0x1e2a3a]), zip: 0x8a8a90, collar: 'same', legs: pick(r, [0x2a2a2e, 0x2c3e5c, 0x3a3a40, 0x5a5040]), shoes };
    else if (v < 0.75) o = { top: pick(r, [0xe8eef4, 0xa8c4e0, 0xf2ede4, 0xd8d8d8, 0x8aa0b8]), topHem: 0.98, sleeves: r() < 0.5 ? 'short' : 'long', buttons: 0xf0f0f0, collar: 'same', belt: 0x2a1e16, legs: pick(r, [0x2a2a2e, 0x3a3a40, 0x5a5040, 0x2c3e5c]), shoes };
    else o = { top: pick(r, [0x26282e, 0x3a3e48, 0x2a3040]), vneck: 0xeef0f2, tie: pick(r, [0x7a1e28, 0x1e3a6a, 0x3a3a3a]), buttons: 0x1a1a1a, legs: null, shoes: 0x141210, collar: null };
    if (!o.legs) o.legs = o.top;
  }
  if (o.collar === 'same') o.collar = mulC(o.top, 0.9);
  if (o.topHem === undefined) o.topHem = undefined;
  if (o.topHem === null) delete o.topHem;
  if (o.topHem === 0.62) o.topHem = 0.84; // coat: long top colour down to the crotch, plus a coat skirt
  const coat = !student && f && o.buttons === 0x222222;
  const fig = buildFigure({
    f, height, build: f ? 0.95 + r() * 0.08 : 0.95 + r() * 0.12, look, o,
    extras: (parts, P) => {
      const k = P.k;
      if (coat) {
        const Rk = [[P.hipY + 0.12 * k, 0.15 * k, 0.1 * k, 0, 0], [P.hipY - 0.02 * k, 0.185 * k, 0.122 * k, 0, -0.005], [0.62, 0.2 * k, 0.135 * k, 0, 0]];
        parts.add(twoSided(loft(Rk, 24), 0.004), { b: (p) => { const t = smooth(P.hipY, 0.6, p.y) * 0.6; return [['hips', 1 - t], [p.x > 0 ? 'thighL' : 'thighR', t]]; }, c: o.top });
      }
      if (student) addBackpack(parts, P, r);
    },
  });
  const ph0 = r() * TAU, T = 1.06 + r() * 0.1;
  const update = (t) => {
    fig.reset();
    if (walking) walkPose(fig, (t / T) * TAU + ph0, 1, student ? 0.8 : 1);
    else idlePose(fig, t, ph0);
  };
  update(0);
  return { group: fig.group, update, joints: fig.b };
}
function addBackpack(parts, P, r) {
  const k = P.k, c = pick(r, [0x1e2a44, 0xb83030, 0x222222, 0xd8a028, 0x2a7a7a, 0x5a5a62]), cz = -0.105 * k - 0.075;
  const y0 = P.chestY - 0.04 * k;
  parts.add(rbox(0.29 * k, 0.4 * k, 0.15, 0.045, 0, y0, cz), { b: 'chest', c, r: 0.7 });
  parts.add(rbox(0.22 * k, 0.16 * k, 0.05, 0.02, 0, y0 - 0.09 * k, cz - 0.085), { b: 'chest', c: mulC(c, 0.85), r: 0.7 });
  parts.add(rbox(0.2 * k, 0.012, 0.012, 0.004, 0, y0 - 0.01 * k, cz - 0.11), { b: 'chest', c: 0x999999, r: 0.4, m: 0.5 });
  const top = new THREE.TorusGeometry(0.03, 0.007, 5, 10, Math.PI); top.translate(0, y0 + 0.2 * k, cz);
  parts.add(top, { b: 'chest', c: mulC(c, 0.7) });
  for (const s of [1, -1]) {
    const pts = [V(s * 0.08 * k, y0 + 0.17 * k, -0.11 * k), V(s * 0.095 * k, P.clavY + 0.012 * k, -0.02 * k), torsoPoint(P.rings, s * 0.38, P.shY - 0.06 * k, 0.012), torsoPoint(P.rings, s * 0.75, P.chestY - 0.03 * k, 0.012), torsoPoint(P.rings, s * 1.45, P.spineY + 0.02 * k, 0.012), V(s * 0.12 * k, y0 - 0.17 * k, -0.12 * k)];
    parts.add(tube(pts, 0.009, 20, 5), { b: 'chest', c: mulC(c, 0.6), r: 0.8 });
  }
}

/* ---------------- driver ---------------- */
const WHEEL_C = V(0, 0.40, 0.45), WHEEL_R = 0.19, WHEEL_TILT = THREE.MathUtils.degToRad(25);
const W_UP = V(0, Math.cos(WHEEL_TILT), -Math.sin(WHEEL_TILT)), W_N = V(0, Math.sin(WHEEL_TILT), Math.cos(WHEEL_TILT));
/**
 * Seated driver. Origin = H-point, faces +Z, hands on a wheel centred (0,0.40,0.45), r 0.19, tilted 25°.
 * angry: furious face (brows down, open shouting mouth, red face); update = head shakes, horn pounding, fist shake.
 */
export function createDriver({ angry = true, seed = 7 } = {}) {
  const r = mulberry32(seed * 131 + 5);
  const look = baseLook(r, false, { hair: 'short' });
  look.skin = angry ? 0xd9a07e : look.skin;
  look.expr = angry ? { open: true, red: 1, frown: true, lid: 1.2, lidTilt: 0.32, brow: [[0.008, 0.011], [0.026, 0.021], [0.047, 0.029]], browT: [0.0062, 0.005, 0.003] } : { smile: 0.002 };
  const o = { top: 0x3a3f4a, topHem: 0.84, vneck: 0xe8eef6, tie: 0x8a1e24, collar: 0xe8eef6, legs: 0x2a2c32, shoes: 0x161412, buttons: 0x1a1a1a };
  const fig = buildFigure({ f: false, height: 1.78, look, o, hands: { L: 'grip', R: 'grip' },
    extras: (parts, P, fg) => { // seat belt across the chest (from the +X shoulder to the -X hip)
      const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(torsoPoint(P.rings, lerp(0.95, -1.0, t), lerp(P.clavY + 0.005, P.hipY + 0.06, t), 0.014)); }
      parts.add(ribbon((u, v) => { const i = u * 10, a = pts[Math.floor(Math.min(i, 9.999))], b2 = pts[Math.min(10, Math.floor(Math.min(i, 9.999)) + 1)]; const p = a.clone().lerp(b2, i - Math.floor(Math.min(i, 9.999))); p.y += (v - 0.5) * 0.045; return p; }, 30, 1), { b: fg.torsoW, c: 0x2a2a2c, r: 0.7 });
    } });
  fig.body.position.y = -fig.P.hipY;
  const { b } = fig, g = fig.group, tgt = V(), pole = V(), gp = V(), tw = V(), mw = V(), fh = V();
  const al = Math.asin(0.085 / WHEEL_R), ca = Math.cos(al), sa = Math.sin(al);
  const rim = (s) => WHEEL_C.clone().addScaledVector(V(1, 0, 0), s * WHEEL_R * ca).addScaledVector(W_UP, WHEEL_R * sa);
  const rimL = rim(1), rimR = rim(-1);
  const horn = WHEEL_C.clone().addScaledVector(W_N, -0.06).addScaledVector(W_UP, 0.01);
  const lift = WHEEL_C.clone().add(V(-0.05, 0.13, -0.1));
  const shake = V(-0.13, 0.66, 0.28);
  const ph = r() * 3;
  const L = 6.4;
  const update = (t) => {
    fig.reset();
    const tt = (t + ph) % L;
    const inB = tt >= 2.0 && tt < 3.6, inC = tt >= 3.6 && tt < 4.9;
    const tremble = Math.sin(t * 37) * 0.004 + Math.sin(t * 23) * 0.003;
    // torso
    const lean = angry ? 0.08 + (inB ? 0.06 * Math.max(0, Math.sin((tt - 2.0) * 7.0)) : 0) + (inC ? 0.08 : 0) : 0;
    b.hips.rotation.x = -0.3;
    b.spine.rotation.x = 0.05 + lean * 0.5;
    b.chest.rotation.x = 0.05 + lean * 0.5 + tremble;
    b.neck.rotation.x = 0.16 - lean * 0.3;
    if (angry) {
      b.clavL.rotation.z = 0.09 + tremble * 3; b.clavR.rotation.z = -0.09 - tremble * 3;
      let hy = 0, hx = 0.06, hz = 0, jaw = 0.07;
      if (tt < 2.0) { hy = 0.17 * Math.sin(tt * TAU * 2.1) * smooth(0, 0.3, tt); jaw = 0.16 + 0.2 * Math.abs(Math.sin(tt * TAU * 1.6)); hx = 0.02; }
      else if (inB) { jaw = 0.12 + 0.28 * Math.max(0, Math.sin((tt - 2.0) * 7.0)); hx = 0.1; hy = -0.1; }
      else if (inC) { jaw = 0.22 + 0.12 * Math.abs(Math.sin(tt * TAU * 2.4)); hx = -0.04; hy = 0.12; hz = 0.06; }
      else { hy = 0.25 * Math.sin((tt - 4.9) * TAU * 1.1) * smooth(4.9, 5.2, tt) * (1 - smooth(6.1, 6.4, tt)); jaw = 0.06; hx = -0.04; }
      b.head.rotation.set(hx + tremble, hy, hz);
      b.jaw.rotation.x = jaw;
    } else { b.head.rotation.set(0.04, 0.1 * Math.sin(t * 0.4), 0); }
    g.updateWorldMatrix(true, false); fig.mesh.updateMatrixWorld(true);
    // legs
    for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
      ik2(b['thigh' + S], b['shin' + S], b['foot' + S], g.localToWorld(tgt.set(s * 0.14, -0.24, 0.66)), g.localToWorld(pole.set(s * 0.2, 0.8, 0.9)), -1);
      b['foot' + S].rotation.x = -0.15; b['foot' + S].updateMatrixWorld(true);
    }
    // arms
    for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
      let p = s > 0 ? rimL : rimR;
      if (s < 0 && angry) {
        if (inB) {
          const u = (tt - 2.0) % 0.53 / 0.53, k1 = smooth(0, 0.55, u), k2 = smooth(0.6, 0.72, u);
          p = (tt < 2.15) ? rimR.clone().lerp(lift, smooth(2.0, 2.15, tt)) : lift.clone().lerp(horn, k2 * (1 - smooth(0.85, 1.0, u)) + (1 - k1) * 0);
          if (tt > 3.4) p = p.clone().lerp(rimR, smooth(3.4, 3.6, tt));
        } else if (inC) {
          p = shake.clone().add(V(Math.sin(tt * TAU * 5) * 0.025, Math.sin(tt * TAU * 5 + 1) * 0.03, 0));
          p.lerp(rimR, 1 - smooth(3.6, 3.85, tt) + smooth(4.65, 4.9, tt));
        }
      }
      const gl = g.localToWorld(gp.copy(p));
      const off = p !== rimL && p !== rimR && s < 0;
      const tL = g.localToWorld(tw.copy(WHEEL_C).addScaledVector(W_UP, s * ca).addScaledVector(V(1, 0, 0), -sa * 1)).sub(g.localToWorld(V().copy(WHEEL_C)));
      const radial = V(s * ca, 0, 0).addScaledVector(W_UP, sa);
      const mL = g.localToWorld(mw.copy(WHEEL_C).addScaledVector(radial, -0.75).addScaledVector(W_N, 0.65)).sub(g.localToWorld(V().copy(WHEEL_C)));
      const fL = g.localToWorld(fh.copy(WHEEL_C).addScaledVector(W_N, 1).addScaledVector(W_UP, 0.4)).sub(g.localToWorld(V().copy(WHEEL_C)));
      if (off) { tL.copy(g.localToWorld(V(1, 0.3, 0)).sub(g.localToWorld(V()))); mL.copy(g.localToWorld(V(0, -0.3, 1)).sub(g.localToWorld(V()))); fL.copy(g.localToWorld(V(0, 1, 0.3)).sub(g.localToWorld(V()))); }
      const wrist = gripSolve(fig, s, gl, tL, mL, fL, V());
      ik2(b['arm' + S], b['fore' + S], b['hand' + S], wrist, g.localToWorld(pole.set(s * 0.45, -0.1, -0.2)), 1);
      applyGrip(fig, s);
    }
  };
  update(0);
  return { group: g, update, joints: b };
}

/* ---------------- hats ---------------- */
function hardHat(parts, P) {
  const M = new THREE.Matrix4().makeTranslation(P.Hc.x, P.Hc.y, P.Hc.z).multiply(new THREE.Matrix4().makeScale(P.hs, P.hs, P.hs));
  const add = (g, c, o = {}) => parts.add(g, { b: 'head', c, r: 0.32, ...o, mat: M });
  const dome = new THREE.SphereGeometry(1, 28, 12, 0, TAU, 0, Math.PI / 2); dome.scale(0.093, 0.09, 0.112); dome.translate(0, 0.035, 0.0);
  add(dome, 0xf4f3ee);
  const brim = loft([[0.034, 0.108, 0.13, 0, 0.012], [0.03, 0.112, 0.135, 0, 0.014], [0.026, 0.109, 0.131, 0, 0.012]], 28);
  add(brim, 0xeceae3);
  const ridge = new THREE.TorusGeometry(0.088, 0.009, 6, 20, Math.PI); ridge.rotateY(Math.PI / 2); ridge.scale(1, 1.02, 1.25); ridge.translate(0, 0.035, 0); add(ridge, 0xf4f3ee);
  add(cyl(0.094, 0.096, 0.012, 24, 0, 0.042, 0.0).scale(1, 1, 1.2), 0x3a3a3a, { r: 0.8 });
}
function policeCap(parts, P) {
  const M = new THREE.Matrix4().makeTranslation(P.Hc.x, P.Hc.y, P.Hc.z).multiply(new THREE.Matrix4().makeRotationX(-0.08)).multiply(new THREE.Matrix4().makeScale(P.hs, P.hs, P.hs));
  const add = (g, c, o = {}) => parts.add(g, { b: 'head', c, r: 0.6, ...o, mat: M });
  add(loft([[0.035, 0.079, 0.094, 0, 0.004], [0.075, 0.08, 0.097, 0, 0.006]], 28), 0xb3202a);
  add(loft([[0.074, 0.079, 0.096, 0, 0.006], [0.1, 0.098, 0.118, 0, 0.012], [0.13, 0.112, 0.132, 0, 0.012], [0.142, 0.105, 0.124, 0, 0.01], [0.146, 0, 0, 0, 0.01]], 28), 0x1c2a4a);
  const vis = new THREE.CylinderGeometry(1, 1, 0.005, 24, 1, false, -Math.PI / 2, Math.PI); vis.scale(0.078, 1, 0.075); vis.rotateX(0.38); vis.translate(0, 0.036, 0.075);
  add(vis, 0x0c0c0e, { r: 0.18 });
  add(ell(0, 0.105, 0.124, 0.014, 0.017, 0.006, 10, 8), 0xd8b040, { r: 0.3, m: 0.9 });
  add(ell(0, 0.105, 0.128, 0.007, 0.008, 0.003, 8, 6), 0xb3202a);
  const strap = new THREE.TorusGeometry(0.095, 0.0025, 4, 20, Math.PI * 0.6); strap.rotateX(Math.PI / 2); strap.rotateY(Math.PI * 0.2 - Math.PI / 2 + Math.PI / 2); strap.scale(0.84, 1, 1.01); strap.rotateY(0); strap.translate(0, 0.045, 0.0);
  add(strap, 0xd8b040, { r: 0.3, m: 0.9 });
}

/* ---------------- worker ---------------- */
/**
 * Road worker with a pneumatic jackhammer. Chisel tip rests on the ground at local (0,0,0.55);
 * returns toolTip (Object3D on the tip, follows the tool). update = hammering + periodic repositioning.
 */
export function createWorker({ seed = 3 } = {}) {
  const r = mulberry32(seed * 977 + 3);
  const look = baseLook(r, false, { hair: 'crew', expr: { smile: -0.002, brow: [[0.011, 0.018], [0.028, 0.024], [0.046, 0.024]], lid: 1.12, lidTilt: 0.12 } });
  const o = { top: 0x34465e, topHem: 0.98, sleeves: 'long', legs: 0x2e3440, belt: 0x1a1a1a, shoes: 0x3a2a1e, boot: true, sole: 0x1a1616, gloves: 0xc9a85a, legStripe: true, collar: 0x2c3b50 };
  const fig = buildFigure({ f: false, height: 1.79, build: 1.06, look, o, hands: { L: 'grip', R: 'grip' },
    extras: (parts, P, fg) => {
      const k = P.k, y0 = P.hipY + 0.05 * k, y1 = P.clavY + 0.005 * k;
      fg.band(y0, y1, 0.009, 0xff6a12, { e: 0.1, r: 0.85 });
      fg.band(y0, y0 + 0.012, 0.011, 0xe0560c);
      for (const y of [P.spineY + 0.01 * k, P.spineY + 0.11 * k]) fg.band(y, y + 0.032, 0.012, 0xdfe3e6, { r: 0.3, e: 0.3 });
      for (const s of [1, -1]) for (const bk of [0, 1]) { const th = bk ? s * (Math.PI - 0.42) : s * 0.42; fg.patch(th - 0.1, th + 0.1, P.spineY + 0.14 * k, y1 - 0.01, 0.0125, 0xdfe3e6, { r: 0.3, e: 0.3 }); }
      fg.patch(-0.03, 0.03, y0, y1 - 0.02, 0.012, 0x9a4a10);
      hardHat(parts, P);
      addJackhammer(parts);
    } });
  const { b } = fig, g = fig.group, tip = new THREE.Object3D(); tip.name = 'toolTip';
  b.tool.add(tip);
  const tw = V(), pole = V(), gp = V(), tX = V(), mV = V(), fV = V();
  const spots = [0, 0.05, -0.04, 0.02], CY = 5.6;
  const update = (t) => {
    fig.reset();
    const cyc = Math.floor(t / CY), u = t - cyc * CY;
    const hammer = u < 4.2, lift = hammer ? 0 : Math.sin(((u - 4.2) / 1.4) * Math.PI);
    const x0 = spots[cyc % 4], x1 = spots[(cyc + 1) % 4], tx = hammer ? x0 : lerp(x0, x1, smooth(4.4, 5.3, u));
    const vib = hammer ? (Math.abs(Math.sin(t * TAU * 21)) * 0.012 + Math.sin(t * TAU * 13.7) * 0.003) * smooth(0, 0.2, u) : 0;
    b.tool.position.set(tx, vib + lift * 0.16, 0.55);
    b.tool.rotation.set(-0.12 - lift * 0.1, 0, Math.sin(t * TAU * 9) * 0.006 * (hammer ? 1 : 0) + (hammer ? 0 : 0.05 * lift));
    const sh = hammer ? vib * 0.9 : 0;
    b.hips.position.set(0, fig.P.hipY - 0.04 + sh * 0.3 + lift * 0.02, -0.04);
    b.hips.rotation.x = 0.1 - lift * 0.05;
    b.spine.rotation.x = 0.14 - lift * 0.06 + sh * 0.8;
    b.chest.rotation.x = 0.12 + sh * 1.2;
    b.neck.rotation.x = 0.12; b.head.rotation.set(0.22 + sh * 1.5, 0.05 * Math.sin(t * 0.7), 0);
    b.clavL.rotation.z = 0.04 + sh; b.clavR.rotation.z = -0.04 - sh;
    g.updateWorldMatrix(true, false); fig.mesh.updateMatrixWorld(true);
    for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
      ik2(b['thigh' + S], b['shin' + S], b['foot' + S], g.localToWorld(tw.set(s * 0.15, fig.P.ankY, s > 0 ? 0.08 : -0.1)), g.localToWorld(pole.set(s * 0.2, 0.5, 1.5)), -1);
      b['foot' + S].rotation.set(0, -s * 0.15, 0); b['foot' + S].updateMatrixWorld(true);
      // keep feet flat: counter the shin pitch in world
      const q = new THREE.Quaternion(); b['shin' + S].getWorldQuaternion(q); const qg = new THREE.Quaternion(); g.getWorldQuaternion(qg);
      b['foot' + S].quaternion.copy(q.invert().multiply(qg).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s * 0.25, 0)))); b['foot' + S].updateMatrixWorld(true);
    }
    for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
      b.tool.localToWorld(gp.set(s * 0.2, 0.92, 0));
      b.tool.localToWorld(tX.set(1, 0.92, 0)).sub(b.tool.localToWorld(V(0, 0.92, 0)));
      g.localToWorld(mV.set(0, -1, 0.3)).sub(g.localToWorld(V()));
      g.localToWorld(fV.set(0, 0, 1)).sub(g.localToWorld(V()));
      const wr = gripSolve(fig, s, gp, tX, mV, fV, V());
      ik2(b['arm' + S], b['fore' + S], b['hand' + S], wr, g.localToWorld(pole.set(s * 0.7, 0.9, -0.3)), 1);
      applyGrip(fig, s);
    }
  };
  update(0);
  return { group: g, update, toolTip: tip, joints: b };
}
function addJackhammer(parts) {
  const T = new THREE.Matrix4().makeTranslation(0, 0, 0.55);
  const add = (g, c, o = {}) => parts.add(g, { b: 'tool', c, r: 0.45, m: 0.6, ...o, mat: T });
  add(cyl(0.002, 0.012, 0.04, 6, 0, 0.02, 0), 0x9a9ca0, { m: 0.9, r: 0.35 });
  add(cyl(0.013, 0.013, 0.27, 6, 0, 0.175, 0), 0x8a8c90, { m: 0.9, r: 0.35 });
  add(cyl(0.034, 0.03, 0.06, 14, 0, 0.33, 0), 0x2a2a2c);
  add(cyl(0.05, 0.05, 0.1, 18, 0, 0.41, 0), 0x3a3c40);
  add(cyl(0.062, 0.062, 0.32, 20, 0, 0.62, 0), 0x2a2b2e, { r: 0.5 });
  for (let y = 0.5; y < 0.76; y += 0.032) add(cyl(0.071, 0.071, 0.012, 20, 0, y, 0), 0x3c3e42, { r: 0.4 });
  add(rbox(0.17, 0.11, 0.13, 0.03, 0, 0.83, 0), 0xd4282b, { m: 0.1, r: 0.35 });
  add(rbox(0.12, 0.012, 0.135, 0.004, 0, 0.8, 0), 0xf0c020, { m: 0.1, r: 0.4 });
  const bar = cyl(0.016, 0.016, 0.5, 10); bar.rotateZ(Math.PI / 2); bar.translate(0, 0.92, 0); add(bar, 0x8a8c90, { m: 0.9, r: 0.3 });
  add(cyl(0.02, 0.025, 0.06, 10, 0, 0.885, 0), 0x3a3c40);
  for (const s of [1, -1]) { const gr = cyl(0.023, 0.023, 0.13, 12); gr.rotateZ(Math.PI / 2); gr.translate(s * 0.19, 0.92, 0); add(gr, 0x141414, { m: 0, r: 0.85 }); }
  add(rbox(0.06, 0.012, 0.025, 0.005, -0.17, 0.895, 0.012), 0xd4282b, { m: 0.1 });
  // hose: fitting on the side, then down to the ground and away (blends from tool to root)
  add(cyl(0.02, 0.02, 0.05, 10, 0.075, 0.76, -0.02).rotateZ(0), 0xb8a040, { m: 0.8 });
  const pts = [V(0.085, 0.74, -0.02), V(0.17, 0.62, -0.06), V(0.24, 0.3, -0.14), V(0.3, 0.05, -0.3), V(0.42, 0.02, -0.7), V(0.7, 0.02, -1.3), V(1.2, 0.02, -1.9)].map(p => p.add(V(0, 0, 0.55)));
  parts.add(tube(pts, 0.014, 50, 7), { b: (p) => W2('tool', 'root', smooth(0.45, 0.06, p.y)), c: 0x1e1e1e, r: 0.6 });
  const pts2 = pts.map(p => p.clone().add(V(0, 0.0, 0)));
  parts.add(tube(pts2.slice(0, 4), 0.0145, 20, 7).scale(1, 1, 1), { b: (p) => W2('tool', 'root', smooth(0.45, 0.06, p.y)), c: 0xe0b020, r: 0.6 });
}

/* ---------------- traffic officer ---------------- */
// regulate key poses: hand targets in hips-local space [x, y, z]; hf = right wrist flex; yaw = body turn
const REG_POSES = [
  { d: 3.0, R: [-0.2, 1.17, 0.06], Lh: [0.22, -0.04, 0.03], hf: 0.9, yaw: 0, look: [0.15, 0] },
  { d: 3.0, R: [-0.84, 0.5, 0.02], Lh: [0.84, 0.5, 0.02], hf: 0.9, yaw: 0, look: [0, 0] },
  { d: 3.2, R: [-0.3, 0.45, 0.6], Lh: [0.22, -0.04, 0.03], hf: 0.4, yaw: 0.7, wave: 1, look: [0.02, -0.2] },
  { d: 2.8, R: [-0.12, 0.5, 0.66], Lh: [0.22, -0.04, 0.03], hf: 0.5, yaw: -0.5, look: [0, 0] },
];
/**
 * Kyrgyz traffic police officer: lime hi-vis jacket over dark-blue uniform, peaked cap, white gloves & belt,
 * striped baton. pose 'regulate' loops traffic gestures; 'stand' idles with occasional baton pointing.
 */
export function createOfficer({ seed = 40, pose = 'regulate' } = {}) {
  const r = mulberry32(seed * 313 + 9);
  const look = baseLook(r, false, { hair: 'crew', expr: { smile: 0.0025, brow: [[0.011, 0.02], [0.028, 0.026], [0.046, 0.024]] } });
  const o = { top: 0xc8ee2c, topE: 0.12, sleeveE: 0.12, topHem: 0.9, sleeves: 'long', zip: 0x9a9a90, collar: 0x1c2a4a, legs: 0x1c2640, piping: 0xb3202a, shoes: 0x0e0e10, shoeR: 0.25, gloves: 0xf4f4f0, armStripes: [1.0, 1.24], belt: 0xf2f2ee };
  const fig = buildFigure({ f: false, height: 1.8, build: 1.04, look, o, hands: { L: 'relaxed', R: 'grip' },
    extras: (parts, P, fg) => {
      const k = P.k;
      for (const y of [P.spineY - 0.04 * k, P.spineY + 0.06 * k]) fg.band(y, y + 0.03, 0.005, 0xdfe3e6, { r: 0.3, e: 0.3 });
      
      for (const s of [1, -1]) {
        const ep = rbox(0.11 * k, 0.012, 0.055, 0.005, s * 0.12 * k, P.clavY + 0.0, -0.01); ep.rotateZ(0); parts.add(ep, { b: s > 0 ? 'clavL' : 'clavR', c: 0x1c2a4a, r: 0.7 });
        parts.add(ell(s * 0.13 * k, P.clavY + 0.008, -0.01, 0.006, 0.003, 0.006, 6, 4), { b: s > 0 ? 'clavL' : 'clavR', c: 0xd8b040, m: 0.9, r: 0.3 });
      }
      const bp = torsoPoint(P.rings, 0.42, P.shY - 0.1 * k, 0.008);
      parts.add(ell(bp.x, bp.y, bp.z, 0.022, 0.026, 0.006, 10, 8), { b: 'chest', c: 0xd8b040, m: 0.9, r: 0.3 });
      const rp = torsoPoint(P.rings, -0.45, P.shY - 0.08 * k, 0.02);
      parts.add(rbox(0.045, 0.07, 0.03, 0.008, rp.x, rp.y, rp.z), { b: 'chest', c: 0x151515, r: 0.5 });
      parts.add(cyl(0.004, 0.004, 0.06, 6, rp.x - 0.01, rp.y + 0.06, rp.z), { b: 'chest', c: 0x151515 });
      const hp = torsoPoint(P.rings, -1.4, P.hipY + 0.03 * k, 0.03);
      parts.add(rbox(0.05, 0.13, 0.07, 0.015, hp.x, hp.y, hp.z), { b: 'hips', c: 0x161616, r: 0.4 });
      policeCap(parts, P);
      // baton in the right fist, along hand-local Z through the grip centre
      const gx = -P.shX + 0.034, gy = P.wrY - 0.1, gz = -0.012 * k;
      for (let i = 0; i < 9; i++) {
        const z0 = -0.05 + i * 0.054, s = cyl(0.0135, 0.0135, 0.054, 12); s.rotateX(Math.PI / 2); s.translate(gx, gy, gz + z0 + 0.027);
        parts.add(s, { b: 'handR', c: i % 2 ? 0x111111 : 0xf6f6f2, r: 0.35, e: i % 2 ? 0 : 0.08 });
      }
      parts.add(ell(gx, gy, gz + 0.436, 0.0138, 0.0138, 0.01, 10, 6), { b: 'handR', c: 0xf6f6f2, r: 0.3 });
    } });
  const { b, P } = fig, g = fig.group, tw = V(), pole = V(), cur = { R: V(), Lh: V() };
  const total = REG_POSES.reduce((a, p) => a + p.d, 0), ph = r() * 2;
  const tmpA = V(), tmpB = V();
  const blend = (t) => {
    let u = ((t + ph) % total), i = 0;
    while (u > REG_POSES[i].d) { u -= REG_POSES[i].d; i++; }
    const A = REG_POSES[i], B = REG_POSES[(i + 1) % REG_POSES.length], k = smooth(A.d - 0.7, A.d, u);
    const res = {};
    for (const key of ['R', 'Lh']) res[key] = tmpA.fromArray(A[key]).lerp(tmpB.fromArray(B[key]), k).toArray();
    for (const key of ['hf', 'yaw']) res[key] = lerp(A[key], B[key], k);
    res.look = [lerp(A.look[0], B.look[0], k), lerp(A.look[1], B.look[1], k)];
    res.wave = lerp(A.wave || 0, B.wave || 0, k); res.u = u;
    return res;
  };
  const update = (t) => {
    fig.reset();
    let pz;
    if (pose === 'regulate') pz = blend(t);
    else {
      const c = (t + ph) % 9, a = smooth(5, 5.6, c) * (1 - smooth(7.4, 8.0, c));
      pz = { R: [lerp(-0.25, -0.35, a), lerp(-0.07, 0.42, a), lerp(0.1, 0.55, a)], Lh: [0.2, 0.0, 0.1], hf: lerp(-0.6, 0.4, a), yaw: 0, look: [0, 0.3 * Math.sin(t * 0.3) + a * -0.2], wave: 0 };
    }
    const br = Math.sin(t * 1.5) * 0.01;
    b.root.rotation.y = pz.yaw;
    const step = Math.abs(Math.sin(pz.yaw * 6)) * 0;
    b.hips.position.y = P.hipY - 0.005 + step;
    b.spine.rotation.set(br - 0.02, 0, 0); b.chest.rotation.set(br, pz.look[1] * 0.3, 0);
    b.head.rotation.set(pz.look[0], pz.look[1] * 0.7, 0);
    b.thighL.rotation.set(-0.02, 0, 0.05); b.thighR.rotation.set(0.0, 0, -0.05);
    b.footL.rotation.set(0.02, -0.1, -0.05); b.footR.rotation.set(0.0, 0.1, 0.05);
    g.updateWorldMatrix(true, false); fig.mesh.updateMatrixWorld(true);
    const R = V().fromArray(pz.R);
    if (pz.wave) { const w = Math.sin(t * TAU * 1.2) * pz.wave; R.x += w * 0.18; R.z -= Math.abs(w) * 0.05; }
    for (const [s, S, T] of [[1, 'L', pz.Lh], [-1, 'R', R.toArray()]]) {
      b.hips.localToWorld(cur[S === 'L' ? 'Lh' : 'R'].fromArray(T).add(V(0, 0, 0)));
      const target = cur[S === 'L' ? 'Lh' : 'R'];
      const hi = T[1] > 0.3;
      b.hips.localToWorld(pole.set(s * 0.6, hi ? 0.2 : 0.2, hi ? -0.4 : -0.5));
      ik2(b['arm' + S], b['fore' + S], b['hand' + S], target, pole, 1);
      b['hand' + S].rotation.x = s < 0 ? pz.hf : 0.1;
      if (s < 0 && pz.wave) b.handR.rotation.x += Math.sin(t * TAU * 1.2 + 0.6) * 0.3;
      b['hand' + S].updateMatrixWorld(true);
    }
  };
  update(0);
  return { group: g, update, joints: b };
}

/* ---------------- demo ---------------- */
/** Preview line-up: pedestrians, students, worker, seated driver (stool + dummy wheel), officers. */
export function demo() {
  const group = new THREE.Group(), ups = [];
  const put = (p, x, z = 0, ry = 0) => { p.group.position.set(x, 0, z); p.group.rotation.y = ry; group.add(p.group); ups.push(p.update); return p; };
  put(createPerson({ seed: 1, kind: 'pedestrian', gender: 'm' }), -4.4);
  put(createPerson({ seed: 2, kind: 'pedestrian', gender: 'f' }), -3.5);
  put(createPerson({ seed: 3, kind: 'student', gender: 'm' }), -2.6);
  put(createPerson({ seed: 4, kind: 'student', gender: 'f' }), -1.7);
  put(createWorker({ seed: 3 }), -0.4);
  const d = createDriver({ angry: true, seed: 7 });
  const seat = new THREE.Group(); seat.position.set(1.3, 0.34, 0); group.add(seat); seat.add(d.group); ups.push(d.update);
  const mat = new THREE.MeshStandardMaterial({ color: 0x333338, roughness: 0.5 });
  const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 20), mat); stool.position.y = -0.2; seat.add(stool);
  const wheel = new THREE.Group(); wheel.position.copy(WHEEL_C); wheel.rotation.x = -WHEEL_TILT; seat.add(wheel);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R, 0.016, 10, 40), mat));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 20), mat); hub.rotation.x = Math.PI / 2; wheel.add(hub);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 10), mat); col.rotation.x = Math.PI / 2; col.position.z = 0.27; wheel.add(col);
  for (const m of [stool, ...wheel.children]) m.castShadow = m.receiveShadow = true;
  put(createOfficer({ seed: 40, pose: 'regulate' }), 2.6);
  put(createOfficer({ seed: 77, pose: 'stand' }), 3.6);
  put(createPerson({ seed: 9, kind: 'pedestrian', walking: false }), 4.5);
  return { group, update: (t, dt) => ups.forEach(u => u(t, dt)) };
}
