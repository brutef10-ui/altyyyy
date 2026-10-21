import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildWorld, FENCES, FENCE_COLORS, STOP } from './world.js';

const G = window.gsap;
G.ticker.lagSmoothing(0);   // never slow animations down on heavy frames; keep them on wall-clock time
const stage = document.getElementById('stage');
const canvas = document.getElementById('gl');
const fx = document.getElementById('fx');
const fxc = fx.getContext('2d');
const panels = [...stage.querySelectorAll('.panel')];
const simfield = document.getElementById('simfield');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ---------- renderer, sky, sun ---------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  document.getElementById('loaderText').textContent = 'Для презентации нужен браузер с WebGL';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc6d9e8, 450, 2600);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
scene.add(new THREE.HemisphereLight(0xd6e8ff, 0x5d6b45, 0.6));

// The sun never moves during the presentation: from the south-west, ~46° above the horizon.
const SUN_DIR = V(-0.45, 0.75, 0.55).normalize();
const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(5000, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { top: { value: new THREE.Color(0x3f86cf) }, horizon: { value: new THREE.Color(0xd2e5f2) }, sunDir: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0, 0.93, 0.8) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.18);
        if (vDir.y < 0.0) c = horizon * 0.96;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 7000);

/* ---------- sizing ---------- */
let SW = 1, SH = 1;
function resize() {
  const r = stage.getBoundingClientRect();
  SW = Math.max(1, r.width); SH = Math.max(1, r.height);
  renderer.setSize(SW, SH, false);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fx.width = Math.round(SW * dpr); fx.height = Math.round(SH * dpr);
  fxc.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.aspect = SW / SH;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

/* ---------- loader ---------- */
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loaderBar');
const loaderText = document.getElementById('loaderText');
const progress = (p, label) => { loaderBar.style.width = Math.round(p * 100) + '%'; if (label) loaderText.textContent = label + '…'; };

const world = await buildWorld(scene, progress);
world.root.updateMatrixWorld(true);

/* ---------- shots ---------- */
// Every shot: camera position, look target, horizontal shift of the subject (+ = subject right of centre,
// text panel on the left), field of view. Positions come from the built world so props and camera agree.
const wp = (o, local = V(0, 0, 0)) => o.localToWorld(local.clone());
const lensWorld = (cam) => {
  const p = wp(cam.lens);
  const d = V(0, 0, 1).applyQuaternion(cam.lens.getWorldQuaternion(new THREE.Quaternion())).normalize();
  return { p, d };
};
const poleS = world.poles.S, poleW = world.poles.W;
const starPos = wp(world.star.group);
const driverHead = wp(world.driver.group, V(0, 0.70, -0.1));
const workerPos = wp(world.worker.group);
const headS = poleS.signalHead ? wp(poleS.signalHead) : wp(poleS.group, V(-6.6, 5.4, 0));
const lensS = lensWorld(poleS.smartCam);
const lensW = lensWorld(poleW.smartCam);
const regS = wp(poleS.regulatorMount, V(0, 1.05, 0));
const edgeS = wp(poleS.edgeBox.group, V(0, 0.9, 0));
const officer = wp(world.finaleOfficer.group, V(0, 1.55, 0));

const SHOTS = [
  { id: 'title', pos: starPos.clone().add(V(9, -3, 27)), target: starPos.clone().add(V(1, 0.5, 0)), shift: .2 },
  { id: 'city', pos: V(-104, 150, 178), target: V(4, 0, -4), shift: .13, drift: { pos: V(-66, 98, 118), dur: 28 } },
  { id: 'driver', pos: driverHead.clone().add(V(-3.3, 0.18, 0.55)), target: driverHead.clone().add(V(0.2, -0.15, 0.05)), shift: .2, fov: 34 },
  { id: 'works', pos: workerPos.clone().add(V(-3.4, 1.65, 7.2)), target: workerPos.clone().add(V(0, 1.05, 0)), shift: .19 },
  { id: 'avenue', pos: V(388, 17, 168), target: V(405, 2, -60), shift: .16 },
  { id: 'campus', pos: V(-56, 5.5, 333), target: V(-32, 1.8, 309), shift: .2 },
  { id: 'signal', pos: headS.clone().add(V(-3.4, -0.6, 6.2)), target: headS.clone(), shift: .2, fov: 36 },
  { id: 'camera', pos: lensS.p.clone().add(V(-2.4, 0.45, 3.9)), target: lensS.p.clone(), shift: .2, fov: 38 },
  { id: 'regulator', pos: regS.clone().add(V(-5.6, -2.5, 8.8)), target: regS.clone().add(V(0, -0.3, 0)), shift: .17 },
  { id: 'pov', pos: lensS.p, target: null, pov: true, shift: -.12, fov: 34 },
  { id: 'seconds', pos: V(-4, 40, 44), target: V(-2, 0, 0), shift: -.17 },
  { id: 'benefits', pos: lensW.p.clone().add(V(-4.6, 0.7, -2.7)), target: lensW.p.clone(), shift: .2, fov: 38 },
  { id: 'edge', pos: V(9.4, 1.9, -4.4), target: edgeS.clone().add(V(0, 0.6, 0)), shift: -.2 },
  { id: 'sim', pos: V(0, 168, 9), target: V(0, 0, 0), shift: 0 },
  { id: 'final', pos: officer.clone().add(V(-6.2, 0.2, 5.9)), target: officer.clone().add(V(0.6, -0.15, 0)), shift: .2, fov: 36 },
];
// the camera's point of view: inside the west-facing SmartCross camera, looking down the west approach
{
  const pov = SHOTS[9];
  pov.pos = lensW.p.clone().addScaledVector(lensW.d, 0.3);
  // aim down the incoming (eastbound) lanes of the west approach, centred on the queue
  pov.target = V(-120, 0, 3.5);
  pov.fov = 34;
  pov.approach = lensW.d.clone().negate();   // fly in from behind the housing, through the lens
}

/* ---------- camera rig + flights ---------- */
// At rest the camera looks at rig.target; during a flight it is driven by rig.quat (slerped orientation).
const rig = { pos: SHOTS[0].pos.clone(), target: SHOTS[0].target.clone(), quat: null, shift: SHOTS[0].shift, fov: 40 };
const focus = rig.target.clone();
let drift = null;
function applyRig() {
  camera.position.copy(rig.pos);
  camera.up.set(0, 1, 0);
  if (rig.quat) camera.quaternion.copy(rig.quat); else camera.lookAt(rig.target);
  if (camera.fov !== rig.fov) camera.fov = rig.fov;
  camera.setViewOffset(SW, SH, -rig.shift * SW, 0, SW, SH);
  camera.updateProjectionMatrix();
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lookQuat = (from, to) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, to, V(0, 1, 0)));

/* Obstacles: buildings (boxes), tree crowns and poles (cylinders), and cars at their current spots.
   They are bucketed into a 16 m grid so a point test only looks at its own cell. */
const OB = world.obstacles;
for (const p of Object.values(world.poles)) {
  const a = wp(p.group), b = wp(p.group, V(-9.2, 0, 0));
  OB.boxes.push({ x0: Math.min(a.x, b.x) - .8, z0: Math.min(a.z, b.z) - .8, x1: Math.max(a.x, b.x) + .8, z1: Math.max(a.z, b.z) + .8, y0: 4.4, h: 7.2 });
  OB.trees.push({ x: a.x, z: a.z, r: .9, h: 10 });
}
const CAR_H = { bus: 3.5, minibus: 3, suv: 2.1, pickup: 2.1 };
const CELL = 16, MAXPAD = 5, PAD = 1.4;
const cellKey = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
function bucket(map, o, x0, z0, x1, z1) {
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
    const k = i * 100003 + j;
    let a = map.get(k);
    if (!a) map.set(k, a = []);
    a.push(o);
  }
}
const grid = new Map();
for (const b of OB.boxes) { b.box = true; bucket(grid, b, b.x0 - MAXPAD, b.z0 - MAXPAD, b.x1 + MAXPAD, b.z1 + MAXPAD); }
for (const t of OB.trees) bucket(grid, t, t.x - t.r - MAXPAD, t.z - t.r - MAXPAD, t.x + t.r + MAXPAD, t.z + t.r + MAXPAD);
let carGrid = new Map();
function snapshotCars() {
  carGrid = new Map();
  for (const c of world.records) {
    const o = { x: c.x, z: c.z, r: c.len * .5 + .3, h: CAR_H[c.type] || 1.9 };
    bucket(carGrid, o, o.x - o.r - 1, o.z - o.r - 1, o.x + o.r + 1, o.z + o.r + 1);
  }
}
const hit = (o, p, pad) => o.box
  ? p.y < o.h + pad && p.y > (o.y0 ?? -9) - pad && p.x > o.x0 - pad && p.x < o.x1 + pad && p.z > o.z0 - pad && p.z < o.z1 + pad
  : p.y < o.h + Math.min(pad, 1.5) && (p.x - o.x) ** 2 + (p.z - o.z) ** 2 < (o.r + pad) ** 2;
function blocked(p, pad = PAD) {
  if (p.y < .7) return true;
  const k = cellKey(p.x, p.z);
  const a = grid.get(k);
  if (a) for (const o of a) if (hit(o, p, pad)) return true;
  const c = carGrid.get(k);
  if (c) for (const o of c) if (hit(o, p, Math.min(pad, .6))) return true;
  return false;
}
// a path is clear when every sample away from its two ends (fixed shot positions) is free
function clearAlong(fn, n, a, b, skipA = 3, skipB = 3, pad = PAD) {
  for (let i = 1; i < n; i++) {
    const p = fn(i / n);
    if (p.distanceTo(a) < skipA || p.distanceTo(b) < skipB) continue;
    if (blocked(p, pad)) return false;
  }
  return true;
}
const segClear = (a, b, skip = 3, pad = PAD) => clearAlong(k => a.clone().lerp(b, k), Math.max(4, Math.ceil(a.distanceTo(b) / .8)), a, b, skip, skip, pad);
const columnClear = (e, H, pad) => { for (let y = e.y; y <= H + 2; y += 1.5) if (blocked(V(e.x, y, e.z), pad)) return false; return true; };
function corridorTop(a, b) {
  // tallest obstacle near the straight line between a and b (in plan), so the cruise altitude clears it
  const ax = a.x, az = a.z, dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
  const near = (x, z, r) => { const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); return (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2 < r * r; };
  let top = 0;
  for (const o of OB.boxes) if (near((o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2, Math.max(o.x1 - o.x0, o.z1 - o.z0) / 2 + 30)) top = Math.max(top, o.h);
  for (const t of OB.trees) if (near(t.x, t.z, t.r + 30)) top = Math.max(top, t.h);
  return top;
}
// the nearest point a few metres up from a street-level shot whose vertical column to the cruise altitude
// stays well clear of facades and crowns; points behind the view are preferred (the camera pulls back)
function escape(p, view, H) {
  if (p.y >= H - 4) return p.clone();
  const back = V(-view.x, 0, -view.z);
  if (back.lengthSq() < 1e-4) back.set(0, 0, 1);
  back.normalize();
  let best = null, bestScore = Infinity;
  for (let r = 0; r <= 30; r += 2) {
    if (best && r >= bestScore) break;
    const steps = r === 0 ? 1 : Math.ceil(2 * Math.PI * r / 2.5);
    for (let s = 0; s < steps; s++) {
      const ang = s / steps * Math.PI * 2, dir = V(Math.cos(ang), 0, Math.sin(ang));
      for (const up of [4, 8]) {
        const score = r + (r ? (1 - dir.dot(back)) * 3 : 0) + up * .25;
        if (score >= bestScore) continue;
        const e = p.clone().addScaledVector(dir, r).add(V(0, up, 0));
        if (!columnClear(e, H, 3.2) || !segClear(p, e, 2.5)) continue;
        best = e; bestScore = score;
      }
    }
  }
  return best;
}

function planPath(p0, v0, p1, v1, approachIn, approachOut) {
  snapshotCars();
  const pts = (arr) => arr.filter((q, i) => i === 0 || q.distanceTo(arr[i - 1]) > .8);
  const build = (arr, type = 'centripetal') => new THREE.CatmullRomCurve3(pts(arr), false, type, .5);
  // flying into / out of the SmartCross lens passes through the housing on purpose
  const skipA = approachOut ? 8 : 3, skipB = approachIn ? 8 : 3;
  const ok = (c) => clearAlong(k => c.getPointAt(k), Math.max(320, Math.ceil(c.getLength() / .6)), p0, p1, skipA, skipB);
  const head = approachOut ? [p0, p0.clone().addScaledVector(approachOut, 7)] : [p0];
  const tail = approachIn ? [p1.clone().addScaledVector(approachIn, 7), p1] : [p1];
  const flat = Math.hypot(p1.x - p0.x, p1.z - p0.z), d = p0.distanceTo(p1);
  // 1. short or high hops: straight, then a gentle arc
  if (flat < 90 || Math.min(p0.y, p1.y) > 70) {
    const direct = build([...head, ...tail]);
    if (ok(direct)) return { curve: direct, cruise: false };
    const mid = p0.clone().lerp(p1, .5).add(V(0, THREE.MathUtils.clamp(d * .25, 3, 30), 0));
    const arc = build([...head, mid, ...tail]);
    if (ok(arc)) return { curve: arc, cruise: false };
  }
  // 2. pull back and climb, cruise above the rooftops, descend into the next street
  let H = Math.max(36, corridorTop(p0, p1) + 14, p0.y, p1.y);
  for (let attempt = 0; attempt < 5; attempt++, H += 12) {
    const e0 = approachOut ? head[1] : escape(p0, v0, H), e1 = approachIn ? tail[0] : escape(p1, v1, H);
    if (!e0 || !e1) continue;
    const toward = V(e1.x - e0.x, 0, e1.z - e0.z);
    const span = toward.length();
    toward.normalize();
    const lead = Math.min(50, span * .2);
    const m0 = V(e0.x, e0.y + (H - e0.y) * .55, e0.z), m1 = V(e1.x, e1.y + (H - e1.y) * .55, e1.z);
    let t0 = V(e0.x, H, e0.z).addScaledVector(toward, lead), t1 = V(e1.x, H, e1.z).addScaledVector(toward, -lead);
    if (!segClear(m0, t0, 0, 3)) t0 = V(e0.x, H, e0.z);
    if (!segClear(t1, m1, 0, 3)) t1 = V(e1.x, H, e1.z);
    const way = [...head, ...(approachOut ? [] : [e0]), m0, t0, t1, m1, ...(approachIn ? [] : [e1]), ...tail];
    for (const type of ['centripetal', 'chordal']) {
      const c = build(way, type);
      if (ok(c)) return { curve: c, cruise: true };
    }
  }
  // 3. last resort: straight up, across and down
  const H2 = Math.max(H, 90);
  return { curve: build([...head, V(head.at(-1).x, H2, head.at(-1).z), V(tail[0].x, H2, tail[0].z), ...tail], 'chordal'), cruise: true, fallback: true };
}

// velocity profile: smooth acceleration, a steady cruise, a long gentle braking; integrated into a 0..1 ease
const EASE = (() => {
  const N = 400, v = [], acc = [0];
  for (let i = 0; i <= N; i++) { const t = i / N; v.push(smooth(0, .24, t) * (1 - smooth(.62, 1, t)) + 1e-3); }
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + (v[i] + v[i - 1]) / 2);
  return (t) => { const x = Math.min(N, Math.max(0, t * N)), i = Math.floor(x), f = x - i; return (acc[i] + (acc[Math.min(N, i + 1)] - acc[i]) * f) / acc[N]; };
})();

// Plans one hop and returns its duration and a pose function u → camera state (u = eased progress 0..1).
function makeFlight(to, from) {
  const p0 = rig.pos.clone(), t0 = rig.target.clone(), s0 = rig.shift, f0 = rig.fov;
  const p1 = to.pos.clone(), t1 = to.target.clone(), s1 = to.shift, f1 = to.fov || 40;
  const { curve, cruise } = planPath(p0, t0.clone().sub(p0), p1, t1.clone().sub(p1), to.approach, from?.approach);
  const L = curve.getLength();
  const q0 = rig.quat ? rig.quat.clone() : lookQuat(p0, t0), q1 = lookQuat(p1, t1);
  const qT = new THREE.Quaternion(), look = new THREE.Vector3(), tan = new THREE.Vector3();
  return {
    duration: THREE.MathUtils.clamp(1.9 + L / 70, 2.3, 7),
    apply(u) {
      rig.pos.copy(curve.getPointAt(u));
      const q = q0.clone().slerp(q1, smooth(.08, .92, u));
      if (cruise) {
        // while cruising, look ahead along the flight with the nose a little down, like a drone
        curve.getTangentAt(Math.min(1, u + .05), tan);
        tan.y = 0;
        if (tan.lengthSq() > 1e-5) {
          tan.normalize();
          look.copy(rig.pos).add(tan).add(V(0, -.42, 0));
          qT.copy(lookQuat(rig.pos, look));
          q.slerp(qT, smooth(.04, .3, u) * (1 - smooth(.62, .9, u)) * .8);
        }
      }
      rig.quat = q;
      rig.target.copy(t0).lerp(t1, smooth(.1, .9, u));
      rig.shift = s0 + (s1 - s0) * smooth(.25, 1, u);
      rig.fov = f0 + (f1 - f0) * smooth(0, 1, u);
    },
    end() { rig.quat = null; rig.pos.copy(p1); rig.target.copy(t1); },
  };
}
function flight(to, from) {
  const f = makeFlight(to, from), st = { k: 0 };
  return G.to(st, { k: 1, duration: f.duration, ease: 'none', onUpdate: () => f.apply(EASE(st.k)), onComplete: () => f.end() });
}

/* ---------- panels ---------- */
function showPanel(i) {
  const el = panels[i];
  el.classList.add('is-on');
  const items = el.querySelectorAll('[data-r]');
  if (reduce) { G.set(el, { opacity: 1 }); G.set(items, { opacity: 1, y: 0 }); return; }
  G.fromTo(el, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .55, ease: 'power3.out' });
  G.fromTo(items, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .6, stagger: .07, ease: 'power3.out', delay: .1 });
  const bars = el.querySelectorAll('.km .km-bar, .track .fill');
  if (bars.length) G.fromTo(bars, { scaleY: 0, scaleX: (i2, b) => b.classList.contains('fill') ? 0 : 1 }, { scaleY: 1, scaleX: 1, duration: 1, stagger: .15, ease: 'power3.out', delay: .4, transformOrigin: 'left bottom' });
}
function hidePanel(i) {
  const el = panels[i];
  G.to(el, { opacity: 0, y: -10, duration: .3, ease: 'power2.in', onComplete: () => el.classList.remove('is-on') });
}

/* ---------- shot-specific state ---------- */
const fenceRows = () => [...panels[9].querySelectorAll('tr[data-fence]')];
let povAlpha = 0;
const fenceState = FENCES.map(() => ({ a: 0 }));
function enterShot(i) {
  const id = SHOTS[i].id;
  if (id === 'regulator') {
    world.regulators.forEach((o, k) => {
      o.group.visible = true;
      G.fromTo(o.group.scale, { x: .001, y: .001, z: .001 }, { x: 1, y: 1, z: 1, duration: .9, ease: 'back.out(1.6)', delay: k * .12 });
    });
  }
  if (id === 'pov') {
    world.fenceGroup.visible = true;
    fenceState.forEach((f, k) => G.to(f, { a: 1, duration: .5, delay: .4 + k * .45, onUpdate: syncFences }));
    G.to(povState, { a: 1, duration: .6 });
    fenceRows().forEach((r, k) => G.fromTo(r, { backgroundColor: 'rgba(242,165,22,0)' }, { backgroundColor: 'rgba(242,165,22,.18)', duration: .3, delay: .4 + k * .45, yoyo: true, repeat: 1 }));
  }
  if (id === 'seconds') G.to(scoreState, { a: 1, duration: 1.4, delay: .2 });
  if (id === 'sim') { simfield.classList.add('is-on'); G.fromTo(simfield, { opacity: 0, scale: .96 }, { opacity: 1, scale: 1, duration: .7, ease: 'power3.out', delay: .2 }); }
}
function leaveShot(i) {
  const id = SHOTS[i].id;
  if (id === 'regulator') {
    world.regulators.forEach(o => G.to(o.group.scale, { x: .001, y: .001, z: .001, duration: .35, ease: 'power2.in', onComplete: () => { o.group.visible = false; } }));
  }
  if (id === 'pov') {
    fenceState.forEach(f => G.to(f, { a: 0, duration: .35, onUpdate: syncFences, onComplete: () => { if (fenceState.every(s => s.a === 0)) world.fenceGroup.visible = false; } }));
    G.to(povState, { a: 0, duration: .3 });
  }
  if (id === 'seconds') G.to(scoreState, { a: 0, duration: .3 });
  if (id === 'sim') G.to(simfield, { opacity: 0, duration: .3, onComplete: () => simfield.classList.remove('is-on') });
}
const povState = { a: 0 };
const scoreState = { a: 0 };
const SCORES = [
  { pos: V(-19, 4, 3.5), title: 'Запад', value: '59', color: '#e2483d' },
  { pos: V(16, 4, -3.5), title: 'Восток', value: '27', color: '#f2a516' },
  { pos: V(-3.5, 4, -24), title: 'Север', value: '11', color: '#19a75a' },
  { pos: V(3.5, 4, 22), title: 'Юг', value: '3', color: '#19a75a' },
];
function drawScores() {
  const a = scoreState.a;
  if (a <= .01) return;
  fxc.save();
  SCORES.forEach((sc, k) => {
    const p = project(sc.pos);
    if (p.z > 1) return;
    const ka = Math.min(1, Math.max(0, a * 4 - k * .6));
    if (ka <= 0) return;
    fxc.globalAlpha = ka;
    const fs = Math.max(10, SW * .0105), big = Math.max(14, SW * .02);
    fxc.font = `600 ${fs}px "JetBrains Mono", monospace`;
    const t1 = sc.title.toUpperCase();
    const w1 = fxc.measureText(t1).width;
    fxc.font = `800 ${big}px "Manrope", sans-serif`;
    const w2 = fxc.measureText(sc.value).width;
    const pad = SW * .008, w = w1 + w2 + pad * 3.4, h = big * 1.45;
    const x = p.x - w / 2, y = p.y - h;
    fxc.fillStyle = 'rgba(255,255,255,.9)';
    roundRect(x, y, w, h, h / 2); fxc.fill();
    fxc.fillStyle = sc.color;
    fxc.beginPath(); fxc.arc(x + pad + fs * .35, y + h / 2, fs * .35, 0, Math.PI * 2); fxc.fill();
    fxc.fillStyle = '#435468';
    fxc.font = `600 ${fs}px "JetBrains Mono", monospace`;
    fxc.fillText(t1, x + pad * 1.4 + fs * .7, y + h / 2 + fs * .35);
    fxc.fillStyle = '#0f1d2a';
    fxc.font = `800 ${big}px "Manrope", sans-serif`;
    fxc.fillText(sc.value, x + pad * 2.2 + fs * .7 + w1, y + h / 2 + big * .36);
    fxc.strokeStyle = 'rgba(255,255,255,.9)'; fxc.lineWidth = Math.max(1, SW * .001);
    fxc.beginPath(); fxc.moveTo(p.x, y + h); fxc.lineTo(p.x, p.y + SW * .03); fxc.stroke();
  });
  fxc.restore();
}
function syncFences() {
  world.fenceMats.forEach((m, k) => { m.curtain.opacity = fenceState[k].a * .28; m.line.opacity = fenceState[k].a * .95; });
}

/* ---------- POV overlay: detections and fence labels ---------- */
const DIM = { sedan: [1.85, 1.5], hatch: [1.78, 1.5], suv: [1.95, 1.8], minibus: [2.05, 2.6], bus: [2.55, 3.1], pickup: [1.95, 1.85] };
const corner = new THREE.Vector3();
function project(v) {
  corner.copy(v).project(camera);
  return { x: (corner.x * .5 + .5) * SW, y: (-corner.y * .5 + .5) * SH, z: corner.z };
}
function drawPOV(t) {
  fxc.clearRect(0, 0, SW, SH);
  const a = povState.a;
  if (a <= 0.01) return;
  fxc.save();
  fxc.globalAlpha = a;
  // camera chrome
  const m = SW * .025, L = SW * .04;
  fxc.strokeStyle = 'rgba(255,255,255,.9)'; fxc.lineWidth = Math.max(1.5, SW * .0016);
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [SW - m, m, -1, 1], [m, SH - m, 1, -1], [SW - m, SH - m, -1, -1]]) {
    fxc.beginPath(); fxc.moveTo(x, y + sy * L); fxc.lineTo(x, y); fxc.lineTo(x + sx * L, y); fxc.stroke();
  }
  fxc.font = `600 ${Math.max(10, SW * .0095)}px "JetBrains Mono", monospace`;
  fxc.fillStyle = '#ff4b3e';
  if (Math.floor(t * 1.6) % 2 === 0) { fxc.beginPath(); fxc.arc(m + SW * .012, m + SW * .03, SW * .0045, 0, Math.PI * 2); fxc.fill(); }
  fxc.fillStyle = '#fff';
  fxc.fillText('SMARTCROSS · CAM W · ПОДХОД С ЗАПАДА', m + SW * .022, m + SW * .034);
  // detections
  let count = 0;
  for (const c of world.westIn) {
    const dist = -c.x - STOP;
    if (dist > 215 || dist < -2) continue;
    const [wd, ht] = DIM[c.type] || [1.9, 1.6];
    const hl = c.len / 2, hw = wd / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
    for (const dx of [-hl, hl]) for (const dy of [0, ht]) for (const dz of [-hw, hw]) {
      const p = project(V(c.x + dx, dy, c.z + dz));
      if (p.z > 1) behind = true;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (behind || x1 < 0 || x0 > SW || y1 < 0 || y0 > SH) continue;
    count++;
    const level = FENCES.findIndex(f => dist < f);
    const col = '#' + new THREE.Color(FENCE_COLORS[level < 0 ? 3 : level]).getHexString();
    fxc.strokeStyle = col; fxc.lineWidth = Math.max(1, SW * .0011);
    fxc.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (x1 - x0 > SW * .035) {
      const label = `car ${(0.86 + ((c.i * 37) % 13) / 100).toFixed(2)}`;
      fxc.font = `600 ${Math.max(9, SW * .0075)}px "JetBrains Mono", monospace`;
      const tw = fxc.measureText(label).width + 6;
      fxc.fillStyle = col; fxc.fillRect(x0, y0 - SW * .011, tw, SW * .011);
      fxc.fillStyle = '#0b1420'; fxc.fillText(label, x0 + 3, y0 - SW * .0025);
    }
  }
  // fence labels
  FENCES.forEach((d, k) => {
    const fa = fenceState[k].a;
    if (fa < .02) return;
    const p = project(V(-STOP - d, 2.1, 7.4));
    if (p.z > 1) return;
    const label = `${k + 1} · ${d} м`;
    fxc.globalAlpha = a * fa;
    fxc.font = `700 ${Math.max(10, SW * .0105)}px "Manrope", sans-serif`;
    const tw = fxc.measureText(label).width + SW * .012;
    const col = '#' + new THREE.Color(FENCE_COLORS[k]).getHexString();
    fxc.fillStyle = col;
    roundRect(p.x - tw / 2, p.y - SW * .016, tw, SW * .02, SW * .004); fxc.fill();
    fxc.fillStyle = '#fff';
    fxc.fillText(label, p.x - tw / 2 + SW * .006, p.y - SW * .0012);
  });
  fxc.globalAlpha = a;
  fxc.font = `600 ${Math.max(10, SW * .0095)}px "JetBrains Mono", monospace`;
  fxc.fillStyle = '#fff';
  fxc.fillText(`В КАДРЕ: ${count} МАШ. · ХВОСТ > 120 М`, m + SW * .022, SH - m - SW * .012);
  fxc.restore();
}
function roundRect(x, y, w, h, r) {
  fxc.beginPath(); fxc.moveTo(x + r, y); fxc.arcTo(x + w, y, x + w, y + h, r); fxc.arcTo(x + w, y + h, x, y + h, r);
  fxc.arcTo(x, y + h, x, y, r); fxc.arcTo(x, y, x + w, y, r); fxc.closePath();
}

/* ---------- navigation ---------- */
const num = document.getElementById('num');
const nameEl = document.getElementById('name');
const bar = document.getElementById('bar');
const prev = document.getElementById('prev');
const next = document.getElementById('next');
const notes = document.getElementById('notes');
const notesText = document.getElementById('notesText');
const notesBtn = document.getElementById('notesBtn');
let cur = 0, busy = false, tl = null;
const RELEASE_AT = SHOTS.findIndex(s => s.id === 'seconds');
const RELEASE_END = 6.6;

function hud() {
  num.textContent = String(cur + 1).padStart(2, '0');
  nameEl.textContent = panels[cur].dataset.name || '';
  prev.disabled = cur === 0;
  next.disabled = cur === SHOTS.length - 1;
  bar.style.transform = `scaleX(${(cur + 1) / SHOTS.length})`;
  notesText.textContent = panels[cur].dataset.note || 'Для этого слайда заметок нет.';
}

function go(n) {
  if (busy || n === cur || n < 0 || n >= SHOTS.length) return;
  const from = cur;
  cur = n; hud();
  drift?.kill(); drift = null;
  hidePanel(from);
  leaveShot(from);
  if (SHOTS[n].id === 'title' || SHOTS[from].id === 'title') world.star.group.visible = true;
  const relFrom = world.getRelease(), relTo = n >= RELEASE_AT ? RELEASE_END : 0;
  if (reduce) {
    Object.assign(rig, { pos: SHOTS[n].pos.clone(), target: SHOTS[n].target.clone(), quat: null, shift: SHOTS[n].shift, fov: SHOTS[n].fov || 40 });
    world.setRelease(relTo);
    arrive(n);
    return;
  }
  busy = true;
  const rel = { v: relFrom };
  tl = G.timeline({ onComplete: () => { busy = false; arrive(n); } });
  tl.add(flight(SHOTS[n], SHOTS[from]), 0);
  if (relFrom !== relTo) {
    // on the "seconds" shot the W–E platoon starts with the flight and freezes as the camera lands
    tl.to(rel, { v: relTo, duration: tl.duration(), ease: relTo > relFrom ? 'power1.out' : 'power2.inOut', onUpdate: () => world.setRelease(rel.v) }, 0);
  }
  tl.call(() => showPanel(n), null, Math.max(0, tl.duration() - .45));
}
function arrive(n) {
  if (reduce) showPanel(n);
  if (SHOTS[n].id !== 'title') world.star.group.visible = false;
  enterShot(n);
  const d = SHOTS[n].drift;
  if (d && !reduce) {
    const p0 = rig.pos.clone();
    const st = { k: 0 };
    drift = G.to(st, { k: 1, duration: d.dur, ease: 'sine.inOut', onUpdate: () => rig.pos.lerpVectors(p0, d.pos, st.k) });
  }
}

prev.addEventListener('click', () => go(cur - 1));
next.addEventListener('click', () => go(cur + 1));
notesBtn.addEventListener('click', toggleNotes);
function toggleNotes() {
  notes.hidden = !notes.hidden;
  notesBtn.setAttribute('aria-pressed', String(!notes.hidden));
}
document.addEventListener('keydown', e => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button')) return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') { e.preventDefault(); go(cur + 1); }
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); go(cur - 1); }
  else if (k === 'Home') { e.preventDefault(); go(0); }
  else if (k === 'End') { e.preventDefault(); go(SHOTS.length - 1); }
  else if (k === 'n' || k === 'N' || k === 'т' || k === 'Т') toggleNotes();
});
let wheelLock = 0;
stage.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) < 14) return;
  const now = performance.now();
  if (now < wheelLock) return;
  wheelLock = now + 1500;
  go(cur + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });
let tx = 0, ty = 0;
stage.addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
stage.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(cur + (dx < 0 ? 1 : -1));
}, { passive: true });
const fsBtn = document.getElementById('fs');
if (!document.fullscreenEnabled) fsBtn.hidden = true;
fsBtn.addEventListener('click', () => {
  try { Promise.resolve(document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen()).catch(() => {}); } catch (_) { /* unavailable in this view */ }
});

/* ---------- loop ---------- */
const clock = new THREE.Clock();
let frames = 0, slowFrames = 0, tuned = false;
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;
  applyRig();
  // shadows follow what the camera looks at; the light's direction never changes
  focus.lerp(rig.target, .2);
  const span = THREE.MathUtils.clamp(camera.position.distanceTo(rig.target) * .9, 45, 230);
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(SUN_DIR, 600);
  const sc = sun.shadow.camera;
  if (Math.abs(sc.right - span) > 1) { sc.left = sc.bottom = -span; sc.right = sc.top = span; sc.near = 50; sc.far = 1400; sc.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
  world.update(t, dt, camera);
  renderer.render(scene, camera);
  if (povState.a > 0 || scoreState.a > 0) { drawPOV(t); drawScores(); }
  else if (frames % 30 === 0) fxc.clearRect(0, 0, SW, SH);
  // adapt quality once on slow machines
  frames++;
  if (!tuned && frames > 20) { if (dt > 1 / 28) slowFrames++; if (frames > 140) { tuned = true; if (slowFrames > 60) { renderer.setPixelRatio(1); sun.shadow.mapSize.set(2048, 2048); sun.shadow.map?.dispose(); sun.shadow.map = null; resize(); } } }
  requestAnimationFrame(frame);
}

/* ---------- start ---------- */
hud();
applyRig();
renderer.compile(scene, camera);
requestAnimationFrame(frame);
G.to(loader, { opacity: 0, duration: .8, delay: .3, onComplete: () => { loader.hidden = true; } });
if (!reduce) {
  rig.pos.add(V(0, -6, 18));
  const p1 = SHOTS[0].pos.clone();
  G.to(rig.pos, { x: p1.x, y: p1.y, z: p1.z, duration: 3.2, ease: 'power3.out', delay: .3 });
}
setTimeout(() => showPanel(0), reduce ? 0 : 1400);

// test hook: jump straight to a shot without flying (used by the screenshot harness)
window.__sc = {
  jump(n) {
    drift?.kill(); drift = null;
    panels.forEach((p, i) => { if (i !== n) { p.classList.remove('is-on'); p.style.opacity = 0; } });
    leaveShot(cur);
    const s = SHOTS[n];
    Object.assign(rig, { pos: s.pos.clone(), target: s.target.clone(), quat: null, shift: s.shift, fov: s.fov || 40 });
    world.setRelease(n >= RELEASE_AT ? RELEASE_END : 0);
    world.star.group.visible = s.id === 'title';
    cur = n; hud(); showPanel(n); enterShot(n);
  },
  // checks every planned hop (both directions) for samples inside obstacles
  // poses the camera mid-flight between shots i and j at eased progress u (for screenshots)
  pose(i, j, u) {
    const s = SHOTS[i];
    Object.assign(rig, { pos: s.pos.clone(), target: s.target.clone(), quat: null, shift: s.shift, fov: s.fov || 40 });
    panels.forEach(p => { p.classList.remove('is-on'); p.style.opacity = 0; });
    world.star.group.visible = true;
    const f = makeFlight(SHOTS[j], s);
    f.apply(u);
    return rig.pos.toArray().map(v => +v.toFixed(1));
  },
  planTest() {
    const out = [];
    const t0 = performance.now();
    for (let i = 0; i < SHOTS.length - 1; i++) for (const [a, b] of [[SHOTS[i], SHOTS[i + 1]], [SHOTS[i + 1], SHOTS[i]]]) {
      const r = planPath(a.pos, a.target.clone().sub(a.pos), b.pos, b.target.clone().sub(b.pos), b.approach, a.approach);
      let bad = 0, top = 0;
      for (let k = 1; k < 600; k++) {
        const p = r.curve.getPointAt(k / 600);
        top = Math.max(top, p.y);
        if (p.distanceTo(a.pos) > (a.approach ? 8 : 3) && p.distanceTo(b.pos) > (b.approach ? 8 : 3) && blocked(p)) bad++;
      }
      out.push(`${a.id}→${b.id}: L=${r.curve.getLength().toFixed(0)} top=${top.toFixed(0)} cruise=${r.cruise}${r.fallback ? ' FALLBACK' : ''} pts=${r.curve.points.length} bad=${bad}`);
    }
    out.push('ms=' + (performance.now() - t0).toFixed(0));
    return out;
  },
  go, state: () => ({ cur, busy, frames, t: clock.elapsedTime, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }), shots: SHOTS.map(s => s.id),
};
