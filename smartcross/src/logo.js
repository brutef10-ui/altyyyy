// "Lone Stars" team logo — a puffy, balloon-like golden five-pointed star that floats in the sky.
// Geometry: an implicit surface (exponential smooth union of five flattened round cones that share one
// centre sphere) meshed by casting rays from the centre; rows/columns are distributed by curvature-weighted
// arc length and normals come from the analytic field gradient, so the surface has no facets or creases.
import * as THREE from 'three';

/* ------------------------------------------------------------------ shape parameters (metres) */
const ARMS = 5;
let TIP = 2.9;       // centre -> tip-sphere centre
let R_IN = 1.38;     // centre sphere radius (round-cone base)
let R_TIP = 0.42;    // tip rounding radius
let FLAT = 0.6;      // depth flattening (z scale of the cones)
let BLEND = 0.18;    // smooth-union radius (fillets the inner corners, inflates the centre)

const AX = [], AY = [];
for (let i = 0; i < ARMS; i++) { const a = Math.PI / 2 + i * 2 * Math.PI / ARMS; AX.push(Math.cos(a)); AY.push(Math.sin(a)); }

let L2, RR, A2, IL2;
function setShape(o = {}) {
  ({ TIP = TIP, R_IN = R_IN, R_TIP = R_TIP, FLAT = FLAT, BLEND = BLEND } = o);
  L2 = TIP * TIP; RR = R_IN - R_TIP; A2 = L2 - RR * RR; IL2 = 1 / L2;
}
setShape();
// exact SDF of a round cone from the origin (radius R_IN) to TIP*(ux,uy,0) (radius R_TIP) — after Inigo Quilez
function roundCone(px, py, pz, ux, uy) {
  const bx = TIP * ux, by = TIP * uy;
  const y = px * bx + py * by;
  const z = y - L2;
  const qx = px * L2 - bx * y, qy = py * L2 - by * y, qz = pz * L2;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * L2, z2 = z * z * L2;
  const k = RR * RR * x2; // RR > 0
  if (Math.sign(z) * A2 * z2 > k) return Math.sqrt(x2 + z2) * IL2 - R_TIP;
  if (Math.sign(y) * A2 * y2 < k) return Math.sqrt(x2 + y2) * IL2 - R_IN;
  return (Math.sqrt(x2 * A2 * IL2) + y * RR) * IL2 - R_IN;
}
function field(x, y, z) {
  const zs = z / FLAT;
  let s = 0;
  for (let i = 0; i < ARMS; i++) s += Math.exp(-roundCone(x, y, zs, AX[i], AY[i]) / BLEND);
  return -BLEND * Math.log(s);
}
// distance along the unit ray (dx,dy,dz) from the centre to the surface (shape is star-shaped w.r.t. origin)
function rayHit(dx, dy, dz) {
  let a = 0, fa = field(0, 0, 0), b = 4.5, fb = field(b * dx, b * dy, b * dz), t = 0, side = 0;
  for (let it = 0; it < 80; it++) {
    t = (a * fb - b * fa) / (fb - fa);
    const ft = field(t * dx, t * dy, t * dz);
    if (Math.abs(ft) < 1e-10 || b - a < 1e-10) break;
    if (ft * fb > 0) { b = t; fb = ft; if (side === -1) fa *= 0.5; side = -1; }
    else { a = t; fa = ft; if (side === 1) fb *= 0.5; side = 1; }
  }
  return t;
}
function gradN(x, y, z, out) {
  const e = 1e-4;
  const nx = field(x + e, y, z) - field(x - e, y, z);
  const ny = field(x, y + e, z) - field(x, y - e, z);
  const nz = field(x, y, z + e) - field(x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
}
// resample a dense polyline (param values ps, points pts) uniformly by arc length + turning (curvature weight)
function resample(ps, pts, n, beta, includeEnd) {
  const m = [0];
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k], q = pts[k - 1];
    const ds = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    let turn = 0;
    if (k >= 2) {
      const r = pts[k - 2];
      const ax = q[0] - r[0], ay = q[1] - r[1], az = q[2] - r[2];
      const bx = p[0] - q[0], by = p[1] - q[1], bz = p[2] - q[2];
      const c = (ax * bx + ay * by + az * bz) / ((Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)) || 1);
      turn = Math.acos(Math.min(1, Math.max(-1, c)));
    }
    m.push(m[k - 1] + ds + beta * turn);
  }
  const total = m[m.length - 1], out = [];
  const steps = includeEnd ? n - 1 : n;
  let k = 0;
  for (let j = 0; j < n; j++) {
    const target = total * j / steps;
    while (k < m.length - 2 && m[k + 1] < target) k++;
    const f = (target - m[k]) / ((m[k + 1] - m[k]) || 1);
    out.push(ps[k] + (ps[k + 1] - ps[k]) * Math.min(1, Math.max(0, f)));
  }
  return out;
}

/** Builds the smooth puffy star BufferGeometry (centre at origin, faces +Z, ~6 m across). */
function buildStarGeometry({ perArm = 100, rows = 44 } = {}) {
  const sector = 2 * Math.PI / ARMS;
  const th0 = Math.PI / 2 - sector / 2; // inner corner left of the top arm
  // 1) outline columns for one arm sector (z = 0 plane), curvature weighted
  const ND = 1400, thetas = [], opts = [];
  for (let k = 0; k <= ND; k++) {
    const th = th0 + sector * k / ND, c = Math.cos(th), s = Math.sin(th);
    const r = rayHit(c, s, 0);
    thetas.push(th); opts.push([r * c, r * s, 0]);
  }
  const colTheta = resample(thetas, opts, perArm, 0.16, false);
  // 2) per column: profile from front pole (elevation 90°) down to the rim (0°), curvature weighted rows
  const NE = 180;
  const front = []; // [col][row] -> {p, n}
  const n3 = [0, 0, 0];
  for (const th of colTheta) {
    const c = Math.cos(th), s = Math.sin(th);
    const es = [], pts = [];
    for (let k = 0; k < NE; k++) {
      const u = 1 - k / (NE - 1);
      const e = Math.PI / 2 * u * u * (0.35 + 0.65 * u); // dense near the rim
      const ce = Math.cos(e), se = Math.sin(e);
      const t = rayHit(ce * c, ce * s, se);
      es.push(e); pts.push([t * ce * c, t * ce * s, t * se]);
    }
    const rowE = resample(es, pts, rows + 1, 0.22, true);
    rowE[0] = Math.PI / 2; rowE[rows] = 0;
    const col = [];
    for (const e of rowE) {
      const ce = Math.cos(e), se = Math.sin(e);
      const dx = ce * c, dy = ce * s, dz = se;
      const t = rayHit(dx, dy, dz);
      const p = [t * dx, t * dy, t * dz];
      gradN(p[0], p[1], p[2], n3);
      col.push({ p, n: [n3[0], n3[1], n3[2]] });
    }
    front.push(col);
  }
  // 3) assemble: 5 rotated sectors, front rows 0..rows, back rows mirrored
  const C = perArm * ARMS, R = rows * 2 + 1;
  const pos = new Float32Array(C * R * 3), nor = new Float32Array(C * R * 3);
  for (let sct = 0; sct < ARMS; sct++) {
    const ca = Math.cos(sct * sector), sa = Math.sin(sct * sector);
    for (let j = 0; j < perArm; j++) {
      const cIdx = sct * perArm + j;
      for (let r = 0; r < R; r++) {
        const fr = r <= rows ? r : 2 * rows - r, zs = r <= rows ? 1 : -1;
        const { p, n } = front[j][fr];
        const i3 = (r * C + cIdx) * 3;
        pos[i3] = p[0] * ca - p[1] * sa; pos[i3 + 1] = p[0] * sa + p[1] * ca; pos[i3 + 2] = p[2] * zs;
        nor[i3] = n[0] * ca - n[1] * sa; nor[i3 + 1] = n[0] * sa + n[1] * ca; nor[i3 + 2] = n[2] * zs;
      }
    }
  }
  const idx = [];
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C; c++) {
      const c1 = (c + 1) % C;
      const a = r * C + c, b = (r + 1) * C + c, d = (r + 1) * C + c1, e = r * C + c1;
      if (r !== R - 2) idx.push(a, b, d); // degenerate at the back pole (b == d)
      if (r !== 0) idx.push(a, d, e);     // degenerate at the front pole (a == e)
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/* ------------------------------------------------------------------ procedural textures */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const SUN_DIR = new THREE.Vector3(-0.45, 0.75, 0.55).normalize();

// Equirectangular sky reflection map (512x256): blue zenith, bright warm horizon, soft clouds, green city below.
const ENV = {
  zenith: [0.32, 0.39, 0.52], sky: [0.68, 0.69, 0.72], hband: [0.32, 0.28, 0.20], hbandK: 9,
  groundNear: [0.78, 0.64, 0.46], groundFar: [0.14, 0.09, 0.05], groundPow: 0.55,
  sunBroad: 0.35, sunMid: 0.5, clouds: 18,
  // a big soft sunlit cloud high behind the viewer (south) -> long soft highlights along the arms
  boxes: [{ dir: [0, 0.6, 0.8], az: Math.PI / 2, el: 0.72, w: 1.1, h: 0.26, a: 0.55 }],
};
// Equirectangular sky reflection map (512x256): zenith, bright warm horizon, soft clouds, sun glow, warm ground.
function makeSkyEnv(o = ENV) {
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  const rnd = mulberry32(7741);
  const clouds = [];
  for (let i = 0; i < o.clouds; i++) clouds.push({ az: rnd() * Math.PI * 2, el: 0.04 + Math.pow(rnd(), 1.6) * 0.45, w: 0.12 + rnd() * 0.3, h: 0.03 + rnd() * 0.06, a: 0.35 + rnd() * 0.5 });
  const sx = SUN_DIR.x, sy = SUN_DIR.y, sz = SUN_DIR.z;
  const lerp = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < H; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI, cel = Math.cos(el), sel = Math.sin(el);
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      const dx = cel * Math.cos(az), dz = cel * Math.sin(az), dy = sel;
      let r, g, b;
      if (el >= 0) {
        const h = Math.pow(sel, 0.5), hb = Math.exp(-sel * o.hbandK);
        r = lerp(o.sky[0], o.zenith[0], h) + o.hband[0] * hb;
        g = lerp(o.sky[1], o.zenith[1], h) + o.hband[1] * hb;
        b = lerp(o.sky[2], o.zenith[2], h) + o.hband[2] * hb;
        let cl = 0;
        for (const c of clouds) {
          let da = Math.abs(az - c.az); if (da > Math.PI) da = 2 * Math.PI - da;
          const q = (da / c.w) ** 2 + ((el - c.el) / c.h) ** 2;
          if (q < 9) cl += c.a * Math.exp(-q);
        }
        cl = Math.min(1, cl);
        r += (1 - r) * cl; g += (1 - g) * cl; b += (1 - b) * cl;
      } else {
        const h = Math.pow(-sel, o.groundPow);
        r = lerp(o.groundNear[0], o.groundFar[0], h); g = lerp(o.groundNear[1], o.groundFar[1], h); b = lerp(o.groundNear[2], o.groundFar[2], h);
      }
      // soft "softbox" panels: { dir: [x,y,z], w, h, a } — bright elongated patches (big sunlit clouds)
      for (const bx of o.boxes) {
        const c = dx * bx.dir[0] + dy * bx.dir[1] + dz * bx.dir[2];
        if (c > 0) {
          const ex = (el - bx.el) / bx.h; let da = Math.abs(az - bx.az); if (da > Math.PI) da = 2 * Math.PI - da;
          const q = Math.pow(Math.abs(ex), 4) + Math.pow(da / bx.w, 4);
          const a = bx.a * Math.exp(-q);
          r += (1 - r) * a; g += (0.98 - g) * a; b += (0.93 - b) * a;
        }
      }
      const s = Math.max(0, dx * sx + dy * sy + dz * sz);
      const sun = Math.pow(s, 900) * 1.0 + Math.pow(s, 40) * o.sunMid + Math.pow(s, 6) * o.sunBroad;
      r += sun; g += sun * 0.95; b += sun * 0.82;
      const k = (y * W + x) * 4;
      d[k] = Math.min(255, r * 255); d[k + 1] = Math.min(255, g * 255); d[k + 2] = Math.min(255, b * 255); d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeGlowTex() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const gr = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0.0, 'rgba(255,232,180,0.9)');
  gr.addColorStop(0.22, 'rgba(255,220,150,0.5)');
  gr.addColorStop(0.5, 'rgba(255,206,130,0.14)');
  gr.addColorStop(0.75, 'rgba(255,214,140,0.04)');
  gr.addColorStop(1.0, 'rgba(255,214,140,0)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ materials (module cache) */
const cache = {};
function starMaterial() {
  if (cache.star) return cache.star;
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffbd3f, metalness: 0.95, roughness: 0.17,
    clearcoat: 0.8, clearcoatRoughness: 0.04,
    iridescence: 0.2, iridescenceIOR: 1.35, iridescenceThicknessRange: [180, 420],
    envMap: makeSkyEnv(), envMapIntensity: 2.0,
  });
  const rim = { value: new THREE.Color(0xffc56b).multiplyScalar(0.7) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = rim;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float fr = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
          totalEmissiveRadiance += uRim * pow(fr, 3.0); }`);
  };
  m.customProgramCacheKey = () => 'lonestar-rim';
  return (cache.star = m);
}
function glowMaterial() {
  if (cache.glow) return cache.glow;
  return (cache.glow = new THREE.SpriteMaterial({
    map: makeGlowTex(), color: 0xffffff, transparent: true, opacity: 0.38,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  }));
}
function sparkleMaterial() {
  if (cache.sparkle) return cache.sparkle;
  return (cache.sparkle = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 400 }, uColor: { value: new THREE.Color(0xffd27a) }, uCore: { value: new THREE.Color(0xfffaf0) } },
    vertexShader: `
      attribute float aSize; attribute float aAlpha; attribute float aFlare; attribute float aRot;
      uniform float uPx;
      varying float vAlpha; varying float vFlare; varying float vRot;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.0, aSize * uPx * projectionMatrix[1][1] / -mv.z);
        vAlpha = aAlpha; vFlare = aFlare; vRot = aRot;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uCore;
      varying float vAlpha; varying float vFlare; varying float vRot;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float c = cos(vRot), s = sin(vRot);
        p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        float r2 = dot(p, p);
        float core = exp(-r2 * 70.0);
        float halo = exp(-r2 * 10.0);
        float rays = exp(-abs(p.x) * 30.0) * pow(max(1.0 - abs(p.y), 0.0), 3.0)
                   + exp(-abs(p.y) * 30.0) * pow(max(1.0 - abs(p.x), 0.0), 3.0);
        vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.70710678;
        float rays2 = exp(-abs(q.x) * 45.0) * pow(max(1.0 - abs(q.y) * 1.7, 0.0), 3.0)
                    + exp(-abs(q.y) * 45.0) * pow(max(1.0 - abs(q.x) * 1.7, 0.0), 3.0);
        float flare = core + 0.32 * halo + 0.75 * rays + 0.28 * rays2;
        float dotA = exp(-r2 * 5.0) * 0.8 + exp(-r2 * 40.0) * 0.5;
        float a = mix(dotA, flare, vFlare) * vAlpha * (1.0 - smoothstep(0.85, 1.0, sqrt(r2)));
        vec3 col = mix(uColor, uCore, clamp(core * 1.4 + 0.1 * (1.0 - vFlare), 0.0, 1.0));
        gl_FragColor = vec4(col * a, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true, toneMapped: false,
  }));
}

/* ------------------------------------------------------------------ sparkles */
const ORBITS = [
  { rx: 4.7, rz: 4.1, tx: 0.30, tz: 0.48, w: 0.55, ph: 0.3, size: 1.0 },
  { rx: 5.1, rz: 3.7, tx: -0.22, tz: -0.62, w: -0.43, ph: 2.6, size: 0.85 },
  { rx: 4.2, rz: 4.3, tx: 1.05, tz: 0.12, w: 0.68, ph: 4.4, size: 0.75 },
];
const TRAIL = 44, TRAIL_STEP = 0.016, AMBIENT = 9;

function createSparkles() {
  const n = ORBITS.length * (1 + TRAIL) + AMBIENT;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n), flare = new Float32Array(n), rot = new Float32Array(n);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aFlare', new THREE.BufferAttribute(flare, 1));
  geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 1).setUsage(THREE.DynamicDrawUsage));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);
  const mats = ORBITS.map(o => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.tx, 0, o.tz)));
  const rnd = mulberry32(90210);
  const amb = [];
  for (let i = 0; i < AMBIENT; i++) {
    const a = rnd() * Math.PI * 2, rr = 3.9 + rnd() * 2.2;
    amb.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr * 0.85, z: (rnd() - 0.3) * 3.0, s: 0.35 + rnd() * 0.4, T: 2.4 + rnd() * 2.2, ph: rnd(), rot: rnd() });
  }
  const v = new THREE.Vector3();
  const points = new THREE.Points(geo, sparkleMaterial());
  points.frustumCulled = false;
  points.renderOrder = 2;
  const sv = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(sv);
    points.material.uniforms.uPx.value = sv.y * 0.5 * points.matrixWorld.getMaxScaleOnAxis();
  };
  function update(t) {
    let i = 0;
    ORBITS.forEach((o, k) => {
      const a0 = o.w * t + o.ph;
      for (let j = 0; j <= TRAIL; j++) {
        const a = a0 - Math.sign(o.w) * j * TRAIL_STEP;
        v.set(o.rx * Math.cos(a), 0, o.rz * Math.sin(a)).applyMatrix4(mats[k]);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        if (j === 0) {
          const tw = 0.78 + 0.22 * Math.sin(t * 9.0 + k * 2.1) * Math.sin(t * 5.3 + k);
          size[i] = o.size * (0.9 + 0.12 * Math.sin(t * 3.1 + k)); alpha[i] = tw; flare[i] = 1; rot[i] = t * 0.6 + k;
        } else {
          const f = 1 - j / (TRAIL + 1);
          size[i] = 0.42 * o.size * (0.25 + 0.75 * f); alpha[i] = 0.2 * f * f * (0.6 + 0.4 * f); flare[i] = 0; rot[i] = 0;
        }
        i++;
      }
    });
    for (const p of amb) {
      const ph = ((t / p.T + p.ph) % 1 + 1) % 1;
      const life = Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 3);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y + 0.15 * Math.sin(t * 0.7 + p.rot * 6); pos[i * 3 + 2] = p.z;
      size[i] = p.s * (0.4 + 0.6 * life); alpha[i] = life * 0.9; flare[i] = 1; rot[i] = p.rot * 3 + t * 0.4;
      i++;
    }
    for (const name of ['position', 'aSize', 'aAlpha', 'aRot']) geo.attributes[name].needsUpdate = true;
  }
  update(0);
  return { points, update };
}

/* ------------------------------------------------------------------ public API */
/**
 * "Lone Stars" team logo: a puffy golden five-pointed star (~6.3 m tip-to-tip, ~1.7 m thick), centre at the
 * origin, front facing +Z, with a soft glow halo and orbiting sparkles. ≤ 4 draw calls (star, its shadow, glow, sparkles).
 * @returns {{ group: THREE.Group, update: (t: number, dt?: number) => void }}
 *   `update(t)` is a pure function of time: floating bob, gentle turn/tilt, breathing scale, sparkle orbits.
 */
export function createStarLogo() {
  if (!cache.geo) cache.geo = buildStarGeometry();
  const group = new THREE.Group(); group.name = 'LoneStarsLogo';
  const float = new THREE.Group(); group.add(float);
  const spin = new THREE.Group(); float.add(spin);
  const star = new THREE.Mesh(cache.geo, starMaterial());
  star.castShadow = true; star.receiveShadow = true; star.name = 'star';
  spin.add(star);
  const glow = new THREE.Sprite(glowMaterial());
  glow.scale.set(14, 14, 1); glow.renderOrder = 1;
  float.add(glow);
  // keep the halo centred behind the star as seen from whatever camera renders it (no parallax offset)
  const camL = new THREE.Vector3();
  glow.onBeforeRender = (renderer, scene, camera) => {
    camL.setFromMatrixPosition(camera.matrixWorld);
    float.worldToLocal(camL);
    const l = camL.length() || 1;
    glow.position.copy(camL).multiplyScalar(-2.4 / l);
    glow.updateMatrix();
    glow.matrixWorld.multiplyMatrices(float.matrixWorld, glow.matrix);
    glow.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, glow.matrixWorld);
  };
  const sparkles = createSparkles();
  float.add(sparkles.points);

  function update(t) {
    const TAU = Math.PI * 2;
    float.position.y = 0.22 * Math.sin(TAU * t / 6.5);
    spin.rotation.set(
      0.07 * Math.sin(TAU * t / 7.3 + 1.1),
      0.26 * Math.sin(TAU * t / 9.0) + 0.04 * Math.sin(TAU * t / 3.9 + 0.5),
      0.05 * Math.sin(TAU * t / 11.0 + 0.4),
    );
    spin.scale.setScalar(1 + 0.018 * Math.sin(TAU * t / 4.5));
    glow.material.opacity = 0.34 + 0.05 * Math.sin(TAU * t / 4.5);
    sparkles.update(t);
  }
  update(0);
  return { group, update: (t, dt) => update(t, dt) };
}

/** Preview showcase: the logo. */
export function demo() {
  return createStarLogo();
}

// TEMP: shape exploration
export function __variants() {
  const g = new THREE.Group();
  const shapes = [
    { TIP: 2.86, R_IN: 1.3, R_TIP: 0.45, FLAT: 0.62, BLEND: 0.12 },
    { TIP: 2.86, R_IN: 1.42, R_TIP: 0.45, FLAT: 0.57, BLEND: 0.15 },
    { TIP: 2.82, R_IN: 1.5, R_TIP: 0.5, FLAT: 0.55, BLEND: 0.18 },
    { TIP: 2.9, R_IN: 1.38, R_TIP: 0.4, FLAT: 0.6, BLEND: 0.2 },
  ];
  shapes.forEach((sh, i) => { setShape(sh); const s = new THREE.Mesh(buildStarGeometry(), starMaterial()); s.position.x = i * 40; s.castShadow = s.receiveShadow = true; g.add(s); });
  setShape({ TIP: 2.86, R_IN: 1.3, R_TIP: 0.45, FLAT: 0.62, BLEND: 0.12 });
  return g;
}
