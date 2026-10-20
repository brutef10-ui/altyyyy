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
const driverHead = wp(world.driver.group, V(0, 0.72, 0));
const workerPos = wp(world.worker.group);
const headS = poleS.signalHead ? wp(poleS.signalHead) : wp(poleS.group, V(-6.6, 5.4, 0));
const lensS = lensWorld(poleS.smartCam);
const lensW = lensWorld(poleW.smartCam);
const regS = wp(poleS.regulatorMount, V(0, 1.05, 0));
const edgeS = wp(poleS.edgeBox.group, V(0, 0.9, 0));
const officer = wp(world.finaleOfficer.group, V(0, 1.55, 0));

const SHOTS = [
  { id: 'title', pos: starPos.clone().add(V(9, -3, 27)), target: starPos.clone().add(V(1, 0.5, 0)), shift: .2 },
  { id: 'city', pos: V(-150, 118, 236), target: V(4, 0, -6), shift: .12, drift: { pos: V(-104, 78, 166), dur: 28 } },
  { id: 'driver', pos: driverHead.clone().add(V(-4.3, 0.28, 2.5)), target: driverHead.clone().add(V(0, -0.1, 0)), shift: .2, fov: 38 },
  { id: 'works', pos: workerPos.clone().add(V(-3.4, 1.65, 7.2)), target: workerPos.clone().add(V(0, 1.05, 0)), shift: .19 },
  { id: 'avenue', pos: V(388, 17, 168), target: V(405, 2, -60), shift: .16 },
  { id: 'campus', pos: V(-64, 7.5, 342), target: V(-34, 1.4, 309), shift: .2 },
  { id: 'signal', pos: headS.clone().add(V(-5.2, -0.7, 9.4)), target: headS.clone(), shift: .2 },
  { id: 'camera', pos: lensS.p.clone().add(V(-2.4, 0.45, 3.9)), target: lensS.p.clone(), shift: .2, fov: 38 },
  { id: 'regulator', pos: regS.clone().add(V(-8.6, -3.1, 13.5)), target: regS.clone(), shift: .17 },
  { id: 'pov', pos: lensS.p, target: null, pov: true, shift: -.12, fov: 50 },
  { id: 'seconds', pos: V(-3, 27, 31), target: V(0, 0, -1), shift: -.19 },
  { id: 'benefits', pos: lensW.p.clone().add(V(-4.6, 0.7, -2.7)), target: lensW.p.clone(), shift: .2, fov: 38 },
  { id: 'edge', pos: V(9.4, 1.9, -4.4), target: edgeS.clone().add(V(0, 0.6, 0)), shift: -.2 },
  { id: 'sim', pos: V(0, 168, 9), target: V(0, 0, 0), shift: 0 },
  { id: 'final', pos: officer.clone().add(V(-4.4, 0.15, 7.6)), target: officer.clone().add(V(0.7, -0.05, 0)), shift: .2 },
];
// the camera's point of view: inside the west-facing SmartCross camera, looking down the west approach
{
  const pov = SHOTS[9];
  pov.pos = lensW.p.clone().addScaledVector(lensW.d, 0.3);
  // aim down the incoming (eastbound) lanes of the west approach, centred on the queue
  pov.target = V(-150, 0, 3.5);
  pov.approach = lensW.d.clone().negate();   // fly in from behind the housing, through the lens
}

/* ---------- camera rig + flights ---------- */
const rig = { pos: SHOTS[0].pos.clone(), target: SHOTS[0].target.clone(), shift: SHOTS[0].shift, fov: 40 };
const focus = rig.target.clone();
let drift = null;
function applyRig() {
  camera.position.copy(rig.pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(rig.target);
  if (camera.fov !== rig.fov) camera.fov = rig.fov;
  camera.setViewOffset(SW, SH, -rig.shift * SW, 0, SW, SH);
  camera.updateProjectionMatrix();
}
const bez = (a, b, c, d, t) => {
  const u = 1 - t;
  return a.clone().multiplyScalar(u * u * u).addScaledVector(b, 3 * u * u * t).addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function flight(to, onUpdate) {
  const p0 = rig.pos.clone(), t0 = rig.target.clone(), s0 = rig.shift, f0 = rig.fov;
  const p1 = to.pos.clone(), t1 = to.target.clone(), s1 = to.shift, f1 = to.fov || 40;
  const d = p0.distanceTo(p1);
  // long hops between street-level shots arc up over the rooftops; high shots don't need the climb
  const lift = d > 35 ? THREE.MathUtils.clamp(d * .32 - Math.min(p0.y, p1.y) * .5, 0, 150) : 0;
  const c0 = p0.clone().lerp(p1, .18).add(V(0, lift, 0));
  const c1 = to.approach ? p1.clone().addScaledVector(to.approach, Math.min(14, d * .4)) : p0.clone().lerp(p1, .82).add(V(0, lift, 0));
  // look a little ahead of the travel while cruising so long jumps read as flying, not panning
  const ahead = (k) => bez(p0, c0, c1, p1, Math.min(1, k + .12));
  const st = { k: 0 };
  return G.to(st, {
    k: 1, duration: Math.min(4.6, 1.5 + d / 170), ease: 'power2.inOut',
    onUpdate() {
      const k = st.k;
      rig.pos.copy(bez(p0, c0, c1, p1, k));
      const look = t0.clone().lerp(t1, smooth(.1, .9, k));
      if (d > 120) look.lerp(ahead(k), Math.sin(Math.PI * k) * .55);
      rig.target.copy(look);
      rig.shift = s0 + (s1 - s0) * smooth(.2, 1, k);
      rig.fov = f0 + (f1 - f0) * k;
      onUpdate?.(k);
    },
  });
}

/* ---------- panels ---------- */
function showPanel(i) {
  const el = panels[i];
  el.classList.add('is-on');
  const items = el.querySelectorAll('[data-r]');
  if (reduce) { G.set(el, { opacity: 1 }); G.set(items, { opacity: 1, y: 0 }); return; }
  G.fromTo(el, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .55, ease: 'power3.out' });
  G.fromTo(items, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .6, stagger: .07, ease: 'power3.out', delay: .1 });
  const bars = el.querySelectorAll('.km .bar, .track .fill');
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
  { pos: V(-34, 5, 3.5), title: 'Запад', value: '59', color: '#e2483d' },
  { pos: V(34, 5, -3.5), title: 'Восток', value: '27', color: '#f2a516' },
  { pos: V(-3.5, 5, -34), title: 'Север', value: '11', color: '#19a75a' },
  { pos: V(3.5, 5, 34), title: 'Юг', value: '3', color: '#19a75a' },
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
    Object.assign(rig, { pos: SHOTS[n].pos.clone(), target: SHOTS[n].target.clone(), shift: SHOTS[n].shift, fov: SHOTS[n].fov || 40 });
    world.setRelease(relTo);
    arrive(n);
    return;
  }
  busy = true;
  const rel = { v: relFrom };
  tl = G.timeline({ onComplete: () => { busy = false; arrive(n); } });
  tl.add(flight(SHOTS[n]), 0);
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
    Object.assign(rig, { pos: s.pos.clone(), target: s.target.clone(), shift: s.shift, fov: s.fov || 40 });
    world.setRelease(n >= RELEASE_AT ? RELEASE_END : 0);
    world.star.group.visible = s.id === 'title';
    cur = n; hud(); showPanel(n); enterShot(n);
  },
  go, state: () => ({ cur, busy }), shots: SHOTS.map(s => s.id),
};
