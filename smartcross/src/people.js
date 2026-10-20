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
const MALE = { hipY: .93, spineY: 1.06, chestY: 1.24, neckY: 1.50, headY: 1.585, clavX: .03, clavY: 1.455, shX: .195, shY: 1.437, elY: 1.13, wrY: .87, hipX: .095, kneeY: .505, ankY: .085 };
const FEMALE = { hipY: .885, spineY: 1.0, chestY: 1.18, neckY: 1.425, headY: 1.505, clavX: .028, clavY: 1.385, shX: .172, shY: 1.372, elY: 1.088, wrY: .842, hipX: .09, kneeY: .48, ankY: .08 };
// torso rings [y, rx, rz, cz]
const MALE_TORSO = [[.835, 0, 0, 0], [.845, .08, .06, 0], [.87, .135, .092, -.005], [.92, .163, .105, -.005], [.98, .165, .103, 0], [1.04, .153, .098, .004], [1.11, .150, .100, .008], [1.19, .158, .108, .013], [1.27, .166, .114, .015], [1.34, .170, .110, .008], [1.40, .168, .098, 0], [1.44, .150, .085, -.005], [1.47, .110, .068, -.008], [1.49, .065, .055, -.008], [1.495, 0, 0, -.008]];
const FEMALE_TORSO = [[.80, 0, 0, 0], [.81, .08, .06, 0], [.835, .14, .095, -.008], [.88, .170, .108, -.01], [.94, .168, .102, -.005], [1.00, .140, .090, 0], [1.06, .128, .085, .004], [1.13, .138, .095, .012], [1.20, .146, .112, .024], [1.25, .148, .110, .018], [1.31, .150, .096, .005], [1.36, .142, .082, -.004], [1.39, .115, .066, -.008], [1.415, .062, .050, -.008], [1.42, 0, 0, -.008]];

function makeProps(f, height, build = 1) {
  const k = height / (f ? 1.70 : 1.78), B = f ? FEMALE : MALE, P = { k, f, build };
  for (const key in B) P[key] = B[key] * k;
  P.hs = (f ? 0.95 : 1) * Math.sqrt(k);
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
