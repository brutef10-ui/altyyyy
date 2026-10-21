import * as THREE from 'three';
import { createFleet, createHeroCar, VEHICLE_LENGTH } from './vehicles.js';
import { createBuildingKit } from './buildings.js';
import { createVegetationKit, createLawn, createMountains } from './nature.js';
import { createPerson, createDriver, createWorker, createOfficer } from './people.js';
import { createRoadNetwork, createStreetlight, createBench, createBusStop, createFence, createGround } from './roads.js';
import { createSignalPole, createEdgeBox, createCameraPost, createRoadWorks, createDust, createHonkWaves } from './devices.js';
import { createStarLogo } from './logo.js';

/* City layout (metres; North = −Z, East = +X).
   A grid of 2+2-lane streets at XS × ZS with a 4-way junction at every crossing.
   M = the hero intersection at the origin; its west arm is long enough for the 200 m virtual fence.
   A 4+4-lane boulevard runs N–S at BLVD_X; the KTU "Manas" campus fills the block south-west of M,
   cut through by the new street at z = CAMPUS_ROAD_Z; road works sit on the north street. */
export const XS = [-300, 0, 180];
export const ZS = [-180, 0, 180];
export const BLVD_X = 400;
export const CAMPUS_ROAD_Z = 310;
export const STOP = 13.5;          // stop line distance from a junction centre
export const LANE = 3.5;
export const FENCES = [30, 60, 120, 200];
export const FENCE_COLORS = [0x19a75a, 0x9acb3c, 0xf2a516, 0xe2483d];
const ROAD_EDGE = 12;              // carriageway half-width 7 + sidewalk 5
const BLVD_EDGE = 22;

export function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const yieldFrame = () => new Promise(r => setTimeout(r, 0));

/** Turns a static template Object3D into InstancedMeshes placed at `placements` ({x, y, z, rotY, s}). */
export function instanceize(template, placements, { shadows = true } = {}) {
  const group = new THREE.Group();
  template.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const place = new THREE.Matrix4(), local = new THREE.Matrix4(), m = new THREE.Matrix4();
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  template.traverse(o => {
    if (!o.isMesh) return;
    local.multiplyMatrices(inv, o.matrixWorld);
    const im = new THREE.InstancedMesh(o.geometry, o.material, placements.length);
    placements.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rotY || 0);
      place.compose(new THREE.Vector3(p.x, p.y || 0, p.z), q, new THREE.Vector3().setScalar(p.s || 1));
      m.multiplyMatrices(place, local);
      im.setMatrixAt(i, m);
    });
    im.castShadow = shadows && o.castShadow !== false;
    im.receiveShadow = o.receiveShadow !== false;
    im.computeBoundingSphere();
    group.add(im);
  });
  return group;
}

export async function buildWorld(scene, progress = () => {}) {
  const rnd = mulberry32(2026);
  const R = (a, b) => a + (b - a) * rnd();
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pick = arr => arr[(rnd() * arr.length) | 0];
  const animated = [];   // { update(t, dt), group, radius }
  const world = { animated };
  const root = new THREE.Group();
  scene.add(root);
  const CHUNK = 320;
  const chunkOf = (x, z) => Math.floor((x + 640) / CHUNK) + '_' + Math.floor((z + 480) / CHUNK);
  const chunks = [];    // { group, x, z } — hidden when the camera is far away
  const addChunk = (key, group) => {
    const [i, j] = key.split('_').map(Number);
    chunks.push({ group, x: i * CHUNK - 640 + CHUNK / 2, z: j * CHUNK - 480 + CHUNK / 2 });
    root.add(group);
  };

  /* ---------- ground, mountains ---------- */
  root.add(createGround({ size: 6000 }));
  const mountains = createMountains();
  mountains.traverse(o => { if (o.material) { o.material.fog = false; } o.castShadow = false; });
  root.add(mountains);
  progress(.05, 'Рельеф');
  await yieldFrame();

  /* ---------- roads ---------- */
  const net = createRoadNetwork();
  const armsFor = (x, z) => {
    const xi = XS.indexOf(x), zi = ZS.indexOf(z);
    let w = xi === 0 ? 220 : (XS[xi] - XS[xi - 1]) / 2;
    let e = xi === XS.length - 1 ? BLVD_X - BLVD_EDGE - x : (XS[xi + 1] - XS[xi]) / 2;
    const n = zi === 0 ? 240 : (ZS[zi] - ZS[zi - 1]) / 2;
    const s = zi === ZS.length - 1 ? 240 : (ZS[zi + 1] - ZS[zi]) / 2;
    if (x === 0 && z === 0) w = 230;
    if (x === -300 && z === 0) e = 70;
    return { n, s, e, w };
  };
  const junctions = [];
  for (const x of XS) for (const z of ZS) {
    const arms = armsFor(x, z);
    net.addIntersection({ x, z, lanesPerDir: 2, laneWidth: LANE, sidewalk: 5, arms });
    junctions.push({ x, z, arms });
  }
  net.addRoad({ x1: BLVD_X, z1: -660, x2: BLVD_X, z2: 560, lanesPerDir: 4, laneWidth: LANE, sidewalk: 6, median: 4 });
  net.addRoad({ x1: -288, z1: CAMPUS_ROAD_Z, x2: -12, z2: CAMPUS_ROAD_Z, lanesPerDir: 1, laneWidth: LANE, sidewalk: 0, fresh: true });
  // campus footpaths
  const campusPaths = [
    [[-276, 262], [-200, 262], [-120, 262], [-30, 262]],
    [[-160, 198], [-160, 262]],
    [[-60, 198], [-60, 262]],
    [[-276, 352], [-150, 352], [-30, 352]],
    [[-200, 318], [-200, 352], [-200, 408]],
    [[-90, 318], [-90, 352], [-90, 408]],
  ];
  campusPaths.forEach(p => net.addPath(p.map(([x, z]) => new THREE.Vector2(x, z)), 3.2));
  const roadGroup = net.finish();
  // lawns are pulled forward (−1, −2) against the ground; campus footpaths lie 1 cm above lawns, so pull them further
  roadGroup.traverse(o => {
    if (!o.isMesh || o.name !== 'paths') return;
    o.material = o.material.clone();
    o.material.polygonOffsetFactor = -3;
    o.material.polygonOffsetUnits = -8;
  });
  root.add(roadGroup);
  progress(.15, 'Дороги');
  await yieldFrame();

  /* ---------- blocks: lawns, buildings, trees ---------- */
  // The city is split into CHUNK × CHUNK m chunks, each with its own building / vegetation / traffic batches,
  // so frustum culling, distance culling and the shadow pass only touch what is near the camera.
  const kits = new Map(), vegKits = new Map();
  const kitAt = (x, z) => { const k = chunkOf(x, z); if (!kits.has(k)) kits.set(k, createBuildingKit()); return kits.get(k); };
  const vegAt = (x, z) => { const k = chunkOf(x, z); if (!vegKits.has(k)) vegKits.set(k, createVegetationKit()); return vegKits.get(k); };
  const veg = {
    addTree: (x, z, o) => vegAt(x, z).addTree(x, z, o),
    addBush: (x, z, o) => vegAt(x, z).addBush(x, z, o),
    addHedge: (x1, z1, x2, z2, o) => vegAt(x1, z1).addHedge(x1, z1, x2, z2, o),
    addFlowerBed: (x, z, w, d) => vegAt(x, z).addFlowerBed(x, z, w, d),
  };
  const xInt = [[-520, -312], [-288, -12], [12, 168], [192, 378], [422, 640]];
  const zInt = [[-420, -192], [-168, -12], [12, 168], [192, 420]];
  const footprints = [];   // [x0, z0, x1, z1] for tree avoidance
  const free = (x, z, pad = 2) => !footprints.some(f => x > f[0] - pad && x < f[2] + pad && z > f[1] - pad && z < f[3] + pad);
  let seed = 1;

  const STYLES = {
    panel: () => ({ style: 'panel', w: R(42, 72), d: R(12, 14), floors: 9 }),
    brick: () => ({ style: 'brick', w: R(30, 56), d: R(11, 13), floors: RI(4, 5) }),
    office: () => ({ style: 'office', w: R(24, 36), d: R(18, 24), floors: RI(8, 16) }),
    shop: () => ({ style: 'shop', w: R(18, 30), d: R(12, 16), floors: RI(1, 2) }),
    tallpanel: () => ({ style: 'panel', w: R(30, 44), d: R(14, 16), floors: RI(12, 14) }),
  };
  const zoneStyle = {
    center: ['shop', 'shop', 'panel', 'panel', 'office', 'brick'],
    residential: ['panel', 'panel', 'brick', 'brick', 'tallpanel'],
    business: ['office', 'office', 'office', 'tallpanel', 'panel'],
  };

  const addBuilding = (b) => {
    kitAt(b.x, b.z).add({ ...b, seed: seed++ });
    const c = Math.cos(b.rotY), s = Math.abs(Math.sin(b.rotY));
    const hw = (Math.abs(c) * b.w + s * b.d) / 2, hd = (s * b.w + Math.abs(c) * b.d) / 2;
    footprints.push([b.x - hw, b.z - hd, b.x + hw, b.z + hd]);
  };

  const perimeter = (bl, zone) => {
    const sides = [
      { along: 'x', from: bl.x0, to: bl.x1, edge: bl.z1, out: 1, rotY: 0 },
      { along: 'x', from: bl.x0, to: bl.x1, edge: bl.z0, out: -1, rotY: Math.PI },
      { along: 'z', from: bl.z0, to: bl.z1, edge: bl.x1, out: 1, rotY: Math.PI / 2 },
      { along: 'z', from: bl.z0, to: bl.z1, edge: bl.x0, out: -1, rotY: -Math.PI / 2 },
    ];
    for (const sd of sides) {
      const margin = sd.along === 'z' ? 23 : 3;
      let s = sd.from + margin + R(0, 6);
      const end = sd.to - margin;
      // frontage on the main avenue (z = 0) in the centre gets shops
      const onAvenue = zone === 'center' && sd.along === 'x' && Math.abs(sd.edge) < 20;
      while (s < end - 12) {
        // keep the hero junction open to the sky: only low shops within 75 m of M on its two streets
        const nearM = zone === 'center' && Math.abs(sd.edge) < 20 && Math.abs(s + 10) < 75;
        const key = nearM ? 'shop' : onAvenue && rnd() < .55 ? 'shop' : pick(zoneStyle[zone]);
        const st = STYLES[key]();
        const w = Math.min(st.w, end - s);
        if (w < 12) break;
        const along = s + w / 2, inward = 3.5 + st.d / 2;
        const x = sd.along === 'x' ? along : sd.edge - sd.out * inward;
        const z = sd.along === 'x' ? sd.edge - sd.out * inward : along;
        addBuilding({ ...st, w, x, z, rotY: sd.rotY });
        s += w + R(8, 22);
      }
    }
    // inner yard: trees, bushes
    const area = (bl.x1 - bl.x0 - 50) * (bl.z1 - bl.z0 - 50);
    const n = Math.max(0, Math.round(area / 420));
    for (let i = 0; i < n; i++) {
      const x = R(bl.x0 + 26, bl.x1 - 26), z = R(bl.z0 + 26, bl.z1 - 26);
      if (!free(x, z, 4)) continue;
      if (rnd() < .78) veg.addTree(x, z, { type: pick(['elm', 'elm', 'maple', 'oak', 'birch', 'poplar']), scale: R(.85, 1.15), seed: seed++ });
      else veg.addBush(x, z, { scale: R(.8, 1.4) });
    }
  };

  const privateSector = (bl) => {
    for (let x = bl.x0 + 14; x < bl.x1 - 10; x += 26) {
      for (let z = bl.z0 + 14; z < bl.z1 - 10; z += 30) {
        const b = { style: 'house', w: R(9, 13), d: R(8, 11), floors: RI(1, 2), x: x + R(-2, 2), z: z + R(-2, 2), rotY: rnd() < .5 ? 0 : Math.PI };
        addBuilding(b);
        for (let k = 0; k < 2; k++) {
          const tx = x + R(-11, 11), tz = z + R(-13, 13);
          if (free(tx, tz, 2)) veg.addTree(tx, tz, { type: pick(['elm', 'maple', 'birch', 'oak']), scale: R(.7, 1), seed: seed++ });
        }
      }
    }
  };

  for (const [x0, x1] of xInt) for (const [z0, z1] of zInt) {
    const bl = { x0, x1, z0, z1 };
    // the campus lawn is split around the new street so the asphalt (y = 0.01) is not covered
    const bands = x0 === -288 && z0 === 192 ? [[z0, CAMPUS_ROAD_Z - 3.75], [CAMPUS_ROAD_Z + 3.75, z1]] : [[z0, z1]];
    for (const [a, b] of bands) {
      const lawn = createLawn(x1 - x0, b - a, { seed: seed++ });
      lawn.position.set((x0 + x1) / 2, 0, (a + b) / 2);
      root.add(lawn);
    }
    if (x0 === -288 && z0 === 192) continue;             // campus, built below
    if (x0 === -520) { privateSector(bl); continue; }
    const zone = x0 >= 192 ? 'business' : (z0 === -168 || z0 === 12) && x0 > -300 && x1 < 200 ? 'center' : 'residential';
    perimeter(bl, zone);
  }
  progress(.3, 'Кварталы');
  await yieldFrame();

  /* ---------- KTU "Manas" campus ---------- */
  const campus = { x0: -288, x1: -12, z0: 192, z1: 420 };
  addBuilding({ style: 'campus', x: -205, z: 226, w: 96, d: 24, floors: 4, rotY: 0 });
  addBuilding({ style: 'campus', x: -78, z: 228, w: 64, d: 22, floors: 5, rotY: 0 });
  addBuilding({ style: 'campus', x: -250, z: 386, w: 52, d: 20, floors: 3, rotY: Math.PI });
  addBuilding({ style: 'panel', x: -130, z: 398, w: 56, d: 13, floors: 5, rotY: Math.PI });
  addBuilding({ style: 'campus', x: -40, z: 392, w: 40, d: 20, floors: 4, rotY: Math.PI });
  // sports pitch
  const pitch = new THREE.Group();
  const pitchMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: .95 });
  const trackMat = new THREE.MeshStandardMaterial({ color: 0xb4513b, roughness: .9 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf4f4ef, roughness: .8 });
  const track = new THREE.Mesh(new THREE.PlaneGeometry(84, 52), trackMat);
  const field = new THREE.Mesh(new THREE.PlaneGeometry(70, 40), pitchMat);
  track.rotation.x = field.rotation.x = -Math.PI / 2;
  track.position.y = .03; field.position.y = .04;
  pitch.add(track, field);
  const line = (w, d, x, z) => { const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat); l.rotation.x = -Math.PI / 2; l.position.set(x, .05, z); pitch.add(l); };
  line(70, .15, 0, -20); line(70, .15, 0, 20); line(.15, 40, -35, 0); line(.15, 40, 35, 0); line(.15, 40, 0, 0);
  pitch.traverse(o => { o.receiveShadow = true; });
  pitch.position.set(-175, 0, 380);
  root.add(pitch);
  footprints.push([-217, 354, -133, 406]);
  // campus trees: spruces, birches, maples — dense and green, away from buildings and the road
  for (let i = 0; i < 420; i++) {
    const x = R(campus.x0 + 4, campus.x1 - 4), z = R(campus.z0 + 4, campus.z1 - 4);
    if (Math.abs(z - CAMPUS_ROAD_Z) < 9) continue;
    if (!free(x, z, 4)) continue;
    if (x > -66 && x < -26 && z > 312 && z < 344) continue;     // keep the campus shot clear
    if (rnd() < .2) { veg.addBush(x, z, { scale: R(.8, 1.3) }); continue; }
    veg.addTree(x, z, { type: pick(['spruce', 'spruce', 'birch', 'maple', 'elm', 'poplar']), scale: R(.8, 1.2), seed: seed++ });
  }
  // the new road gets a hedge line on the north side (what is left of the campus green)
  veg.addHedge(-270, CAMPUS_ROAD_Z - 8, -150, CAMPUS_ROAD_Z - 8, { height: 1.1 });
  veg.addFlowerBed(-205, 248, 30, 6);
  veg.addFlowerBed(-78, 249, 24, 6);
  // campus fence with demolished gaps where the road cuts through
  const fences = [
    { x: -12.8, z: 192, rotY: -Math.PI / 2, length: 228, gaps: [[104, 133]] },   // east side, going south
    { x: -287.2, z: 192, rotY: -Math.PI / 2, length: 228, gaps: [[108, 128]] },  // west side
    { x: -288, z: 191.2, rotY: 0, length: 276, gaps: [] },                         // north side along the street
  ];
  for (const f of fences) {
    const fence = createFence({ length: f.length, height: 2.2, gaps: f.gaps });
    fence.position.set(f.x, .02, f.z); fence.rotation.y = f.rotY;
    root.add(fence);
  }
  progress(.42, 'Кампус');
  await yieldFrame();

  /* ---------- street trees and lights ---------- */
  const lights = [];
  const streetSides = (x1, z1, x2, z2, edge, skipNear) => {
    const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
    for (const side of [-1, 1]) {
      for (let s = 8; s < len - 8; s += 11) {
        const x = x1 + ux * s + nx * side * (edge - 1.1), z = z1 + uz * s + nz * side * (edge - 1.1);
        if (skipNear(x, z)) continue;
        if (!free(x, z, 1.5)) continue;
        veg.addTree(x, z, { type: rnd() < .8 ? 'poplar' : 'elm', scale: R(.85, 1.1), seed: seed++ });
      }
      for (let s = 16; s < len - 10; s += 34) {
        const x = x1 + ux * s + nx * side * (edge - 4.3), z = z1 + uz * s + nz * side * (edge - 4.3);
        if (skipNear(x, z)) continue;
        lights.push({ x, y: .15, z, rotY: Math.atan2(-nx * side, -nz * side) });
      }
    }
  };
  const nearJunction = (x, z) => junctions.some(j => Math.abs(x - j.x) < 24 && Math.abs(z - j.z) < 24);
  for (const j of junctions) {
    const a = j.arms;
    if (a.e) streetSides(j.x, j.z, j.x + a.e, j.z, ROAD_EDGE, nearJunction);
    if (a.w) streetSides(j.x - a.w, j.z, j.x, j.z, ROAD_EDGE, nearJunction);
    if (a.n) streetSides(j.x, j.z - a.n, j.x, j.z, ROAD_EDGE, nearJunction);
    if (a.s) streetSides(j.x, j.z, j.x, j.z + a.s, ROAD_EDGE, nearJunction);
  }
  streetSides(BLVD_X, -650, BLVD_X, 550, BLVD_EDGE, () => false);
  for (let z = -640; z < 550; z += 12) veg.addBush(BLVD_X, z, { scale: R(.9, 1.2) });
  root.add(instanceize(createStreetlight(), lights));
  // bus stops on the hero avenue
  for (const b of [{ x: -86, z: -9.6, rotY: 0 }, { x: 92, z: 9.6, rotY: Math.PI }]) {
    const bs = createBusStop(); bs.position.set(b.x, .15, b.z); bs.rotation.y = b.rotY; root.add(bs);
  }
  // benches along campus paths
  const benches = [];
  for (const [x, z] of [[-180, 266], [-140, 266], [-100, 266], [-60, 266], [-180, 356], [-120, 356], [-60, 356]]) benches.push({ x, y: .03, z, rotY: Math.PI });
  root.add(instanceize(createBench(), benches));
  progress(.5, 'Деревья');
  await yieldFrame();

  for (const [k, kt] of kits) addChunk(k, kt.finish());
  progress(.62, 'Здания');
  await yieldFrame();
  for (const [k, kt] of vegKits) addChunk(k, kt.finish());
  progress(.72, 'Зелень');
  await yieldFrame();

  /* ---------- signals at M ---------- */
  // P_W serves traffic arriving from the west (eastbound), etc. Each pole faces its approach (+Z local),
  // its mast arm (local −X) reaches over that approach's lanes.
  const poleDefs = {
    W: { x: 11, z: 11, rotY: -Math.PI / 2, edge: [13.6, 11.4, 0] },
    E: { x: -11, z: -11, rotY: Math.PI / 2, edge: [-13.6, -11.4, Math.PI] },
    N: { x: -11, z: 11, rotY: Math.PI, edge: [-11.4, 13.6, -Math.PI / 2] },
    S: { x: 11, z: -11, rotY: 0, edge: [11.4, -13.6, 0] },
  };
  const poles = {};
  for (const [k, d] of Object.entries(poleDefs)) {
    const p = createSignalPole({ armLength: 9 });
    p.group.position.set(d.x, .15, d.z); p.group.rotation.y = d.rotY;
    root.add(p.group);
    p.smartCam?.setActive?.(true);
    const box = createEdgeBox();
    box.group.position.set(d.edge[0], .15, d.edge[1]); box.group.rotation.y = d.edge[2];
    root.add(box.group);
    poles[k] = { ...p, edgeBox: box };
    animated.push({ update: (t, dt) => p.update?.(t, dt), group: p.group, radius: 400 });
  }
  root.updateMatrixWorld(true);

  // symbolic regulators on top of every pole (hidden until the "regulator" shot)
  const regulators = Object.values(poles).map((p, i) => {
    const o = createOfficer({ seed: 40 + i, pose: 'regulate' });
    p.regulatorMount.add(o.group);
    o.group.scale.setScalar(.001);
    o.group.visible = false;
    animated.push({ update: o.update, group: o.group, radius: 300 });
    return o;
  });

  /* ---------- traffic ---------- */
  const TYPES = ['sedan', 'sedan', 'sedan', 'sedan', 'suv', 'suv', 'hatch', 'hatch', 'minibus', 'pickup', 'sedan', 'suv', 'bus'];
  const COLORS = [0xf2f2f0, 0xf2f2f0, 0xc8ccd0, 0xc8ccd0, 0x1d1f22, 0x1d1f22, 0x6b7077, 0x22334f, 0x8e1b1b, 0xd8cfb8, 0x2f4f3a, 0x3a5e8c, 0x7a1f2b];
  const lenOf = t => (VEHICLE_LENGTH && VEHICLE_LENGTH[t]) || { sedan: 4.8, hatch: 4.1, suv: 4.9, minibus: 6.9, bus: 12, pickup: 5.3 }[t];
  const groups = {};                     // fleet name → placements
  const records = [];                    // every car: { fleet, i, type, len, x, z, rotY, lane }
  const addCar = (fleet, rec) => {
    if (fleet !== 'M') fleet = fleet + '@' + chunkOf(rec.x, rec.z);
    (groups[fleet] ||= []).push(rec);
    rec.fleet = fleet; rec.i = groups[fleet].length - 1;
    records.push(rec);
    return rec;
  };
  // a queue: front bumper of car 0 at (fx, fz); `ux, uz` points upstream (away from the stop line)
  const queue = (fleet, { fx, fz, ux, uz, count, lane, gapMin = 1.3, gapMax = 2.2, skip = null, types = TYPES, brake = true }) => {
    let acc = 0;
    const out = [];
    for (let k = 0; k < count; k++) {
      if (skip && skip.at === k) { skip.place(fx + ux * (acc + skip.len / 2), fz + uz * (acc + skip.len / 2)); acc += skip.len + R(gapMin, gapMax); continue; }
      const type = k === 0 && types === TYPES ? pick(['sedan', 'suv']) : pick(types);
      const len = lenOf(type);
      const x = fx + ux * (acc + len / 2), z = fz + uz * (acc + len / 2);
      const rotY = Math.atan2(-ux, -uz);
      out.push(addCar(fleet, { type, color: pick(COLORS), x, z, rotY, brake, len, lane, rank: out.length }));
      acc += len + R(gapMin, gapMax);
    }
    return out;
  };
  // sparse moving-looking traffic on a lane between two distances
  const sparse = (fleet, { x1, z1, x2, z2, lane }) => {
    const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
    for (let s = R(4, 20); s < len - 6; s += R(16, 48)) {
      const type = pick(TYPES);
      addCar(fleet, { type, color: pick(COLORS), x: x1 + ux * s, z: z1 + uz * s, rotY: Math.atan2(ux, uz), brake: rnd() < .3, len: lenOf(type), lane });
    }
  };

  // --- M: every approach jammed
  let heroPos = null;
  const westIn = [
    ...queue('M', { fx: -STOP - .4, fz: 1.75, ux: -1, uz: 0, count: 32, lane: 'W1' }),
    ...queue('M', { fx: -STOP - .4, fz: 5.25, ux: -1, uz: 0, count: 27, lane: 'W2' }),
  ];
  const eastIn = [
    ...queue('M', { fx: STOP + .4, fz: -1.75, ux: 1, uz: 0, count: 20, lane: 'E1', skip: { at: 4, len: 4.9, place: (x, z) => { heroPos = new THREE.Vector3(x, 0, z); } } }),
    ...queue('M', { fx: STOP + .4, fz: -5.25, ux: 1, uz: 0, count: 19, lane: 'E2', types: ['sedan', 'sedan', 'suv', 'hatch', 'sedan', 'pickup'] }),
  ];
  queue('M', { fx: -1.75, fz: -STOP - .4, ux: 0, uz: -1, count: 21, lane: 'N1' });
  queue('M', { fx: -5.25, fz: -STOP - .4, ux: 0, uz: -1, count: 19, lane: 'N2' });
  queue('M', { fx: 1.75, fz: STOP + .4, ux: 0, uz: 1, count: 21, lane: 'S1' });
  queue('M', { fx: 5.25, fz: STOP + .4, ux: 0, uz: 1, count: 19, lane: 'S2' });
  // departing lanes: clear near the junction (the W–E release drives into them), some cars further out
  sparse('M', { x1: 75, z1: 1.75, x2: 168, z2: 1.75 }); sparse('M', { x1: 75, z1: 5.25, x2: 168, z2: 5.25 });
  sparse('M', { x1: -75, z1: -1.75, x2: -228, z2: -1.75 }); sparse('M', { x1: -75, z1: -5.25, x2: -228, z2: -5.25 });
  sparse('M', { x1: 1.75, z1: -30, x2: 1.75, z2: -168 }); sparse('M', { x1: 5.25, z1: -30, x2: 5.25, z2: -168 });
  sparse('M', { x1: -1.75, z1: 30, x2: -1.75, z2: 168 }); sparse('M', { x1: -5.25, z1: 30, x2: -5.25, z2: 168 });

  // --- other city streets: light traffic
  const cityLanes = (x1, z1, x2, z2, fleet) => {
    // lanes for travel in +dir are on the right: for +X travel that is +Z, for +Z travel that is −X
    const dx = Math.sign(x2 - x1), dz = Math.sign(z2 - z1);
    const rightX = -dz, rightZ = dx;
    for (const off of [1.75, 5.25]) {
      sparse(fleet, { x1: x1 + rightX * off, z1: z1 + rightZ * off, x2: x2 + rightX * off, z2: z2 + rightZ * off });
      sparse(fleet, { x1: x2 - rightX * off, z1: z2 - rightZ * off, x2: x1 - rightX * off, z2: z1 - rightZ * off });
    }
  };
  for (const j of junctions) {
    if (j.x === 0 && j.z === 0) continue;
    const a = j.arms;
    if (a.e && !(j.x === -300 && j.z === 0)) cityLanes(j.x + 16, j.z, j.x + a.e - 4, j.z, 'city');
    if (a.n && !(j.x === 0 && j.z === 180)) cityLanes(j.x, j.z - 16, j.x, j.z - a.n + 4, 'city');
    if (a.w === 220) cityLanes(j.x - 16, j.z, j.x - a.w + 4, j.z, 'city');
    if (a.s === 240) cityLanes(j.x, j.z + 16, j.x, j.z + a.s - 4, 'city');
  }

  // --- road works on the north street: the outer eastbound lane is closed
  const works = createRoadWorks({ length: 26, width: 5 });
  works.group.position.set(-163, 0, -175.4);
  root.add(works.group);
  animated.push({ update: works.update, group: works.group, radius: 260 });
  queue('works', { fx: -166, fz: -178.25, ux: -1, uz: 0, count: 14, lane: 'K1' });
  queue('works', { fx: -166, fz: -174.75, ux: -1, uz: 0, count: 9, lane: 'K2' });
  queue('works', { fx: -128, fz: -178.25, ux: -1, uz: 0, count: 0, lane: 'K0' });
  queue('works', { fx: -194, fz: -181.75, ux: 1, uz: 0, count: 12, lane: 'K3', gapMin: 2, gapMax: 5 });
  queue('works', { fx: -194, fz: -185.25, ux: 1, uz: 0, count: 10, lane: 'K4', gapMin: 2, gapMax: 5 });
  sparse('works', { x1: -120, z1: -178.25, x2: -20, z2: -178.25 });

  // --- the boulevard: 4 + 4 lanes, jammed both ways along the stretch the camera sees
  for (let k = 0; k < 4; k++) {
    queue('blvd', { fx: BLVD_X - 2 - 1.75 - k * LANE, fz: 150 + R(0, 6), ux: 0, uz: -1, count: 40, lane: 'B' + k, gapMin: 1.4, gapMax: 3 });
    queue('blvd', { fx: BLVD_X + 2 + 1.75 + k * LANE, fz: -320 + R(0, 6), ux: 0, uz: 1, count: 42, lane: 'C' + k, gapMin: 1.4, gapMax: 3 });
  }

  // --- the campus street: jammed and honking
  const campusE = queue('campus', { fx: -16, fz: CAMPUS_ROAD_Z + 1.75, ux: -1, uz: 0, count: 40, lane: 'U1', gapMin: 1.2, gapMax: 2 });
  const campusW = queue('campus', { fx: -284, fz: CAMPUS_ROAD_Z - 1.75, ux: 1, uz: 0, count: 40, lane: 'U2', gapMin: 1.2, gapMax: 2 });

  const fleets = {};
  for (const [name, list] of Object.entries(groups)) {
    const f = createFleet(list.map(r => ({ type: r.type, color: r.color, x: r.x, z: r.z, rotY: r.rotY, brake: r.brake })));
    f.commit?.();
    f.group.traverse(o => { if (o.isInstancedMesh) o.computeBoundingSphere(); });
    fleets[name] = f;
    if (name.includes('@')) addChunk(name.split('@')[1], f.group); else root.add(f.group);
  }
  progress(.82, 'Машины');
  await yieldFrame();

  /* ---------- the angry driver's car (east arm, westbound inner lane) ---------- */
  const hero = createHeroCar({ color: 0xb8bcc2 });
  hero.group.position.copy(heroPos);
  hero.group.rotation.y = -Math.PI / 2;           // front faces west, driver (+X local) on the sunny south side
  root.add(hero.group);
  const driver = createDriver({ angry: true, seed: 7 });
  hero.driverSeat.add(driver.group);
  animated.push({ update: (t, dt) => { hero.update?.(t, dt); driver.update(t, dt); }, group: hero.group, radius: 160 });
  const heroHonk = createHonkWaves({ color: 0xffd34d });
  heroHonk.group.position.set(0, 1.25, 2.6);
  hero.group.add(heroHonk.group);
  animated.push({ update: (t) => heroHonk.update(t), group: heroHonk.group, radius: 120 });
  const heroRec = { fleet: 'hero', type: 'sedan', len: 4.9, x: heroPos.x, z: heroPos.z, rotY: -Math.PI / 2, lane: 'E1', rank: 4, hero: true };
  eastIn.push(heroRec);

  /* ---------- road worker ---------- */
  const worker = createWorker({ seed: 3 });
  works.workerSpot.add(worker.group);
  const dust = createDust();
  root.add(dust.group);
  let dustClock = 0;
  const tipPos = new THREE.Vector3();
  animated.push({
    update: (t, dt) => {
      worker.update(t, dt);
      dust.update(dt);
      dustClock += dt;
      if (dustClock > .09) {
        dustClock = 0;
        (worker.toolTip || works.dustOrigin).getWorldPosition(tipPos);
        dust.burst(tipPos, 2);
      }
    }, group: works.group, radius: 200,
  });

  /* ---------- honking on the campus street ---------- */
  const honkers = [campusE[3], campusE[7], campusW[30], campusE[12], campusW[24], campusE[5]].filter(Boolean);
  honkers.forEach((c, i) => {
    const hw = createHonkWaves({ color: 0xffd34d });
    hw.group.position.set(c.x + Math.sin(c.rotY) * c.len * .45, 1.45, c.z + Math.cos(c.rotY) * c.len * .45);
    hw.group.rotation.y = c.rotY;
    root.add(hw.group);
    const off = i * .37;
    animated.push({ update: (t) => hw.update(t + off), group: hw.group, radius: 220, hideFar: true });
  });

  /* ---------- people ---------- */
  const walkers = [];
  const addWalker = (factory, a, b, speed) => {
    const p = factory();
    root.add(p.group);
    const rec = { p, a: new THREE.Vector3(a[0], a[1], a[2]), b: new THREE.Vector3(b[0], b[1], b[2]), speed, phase: rnd() };
    walkers.push(rec);
    animated.push({
      update: (t, dt) => {
        const L = rec.a.distanceTo(rec.b), period = 2 * L / speed;
        const u = ((t / period + rec.phase) % 1);
        const fwd = u < .5, k = fwd ? u * 2 : 2 - u * 2;
        p.group.position.lerpVectors(rec.a, rec.b, k);
        const dir = fwd ? rec.b.clone().sub(rec.a) : rec.a.clone().sub(rec.b);
        p.group.rotation.y = Math.atan2(dir.x, dir.z);
        p.update(t, dt);
      }, group: p.group, radius: 180, hideFar: true,
    });
  };
  const sw = [   // pedestrians on M's sidewalks: [from], [to]
    [[-20, .15, -9.8], [-62, .15, -9.8]], [[-26, .15, 9.6], [-70, .15, 9.6]], [[22, .15, -10.2], [66, .15, -10.2]],
    [[18, .15, 9.8], [58, .15, 9.8]], [[-9.6, .15, -20], [-9.6, .15, -62]], [[10, .15, 22], [10, .15, 70]],
    [[9.6, .15, -24], [9.6, .15, -60]], [[-10, .15, 18], [-10, .15, 64]], [[-40, .15, -10.6], [-90, .15, -10.6]],
    [[40, .15, 10.6], [100, .15, 10.6]], [[-10.4, .15, -40], [-10.4, .15, -90]], [[10.6, .15, 40], [10.6, .15, 96]],
  ];
  sw.forEach((s, i) => addWalker(() => createPerson({ seed: 100 + i, kind: 'pedestrian', gender: i % 2 ? 'f' : 'm', walking: true }), s[0], s[1], R(1.1, 1.5)));
  const st = [
    [[-250, .03, 262], [-140, .03, 262]], [[-120, .03, 262], [-30, .03, 262]], [[-160, .03, 200], [-160, .03, 258]],
    [[-60, .03, 200], [-60, .03, 258]], [[-260, .03, 352], [-150, .03, 352]], [[-140, .03, 352], [-40, .03, 352]],
    [[-200, .03, 320], [-200, .03, 400]], [[-90, .03, 322], [-90, .03, 400]], [[-230, .03, 263], [-170, .03, 263]],
    [[-100, .03, 351], [-50, .03, 351]],
  ];
  st.forEach((s, i) => addWalker(() => createPerson({ seed: 200 + i, kind: 'student', gender: i % 2 ? 'm' : 'f', walking: true }), s[0], s[1], R(1.0, 1.4)));
  // the officer and a SmartCross post on the pavement by the crosswalk (finale)
  const finaleOfficer = createOfficer({ seed: 77, pose: 'stand' });
  // on the north arm's east pavement, next to the zebra; the departing northbound lanes in front stay clear
  finaleOfficer.group.position.set(9.9, .15, -15.6);
  finaleOfficer.group.rotation.y = -0.72;   // faces the camera on the crossing
  root.add(finaleOfficer.group);
  animated.push({ update: finaleOfficer.update, group: finaleOfficer.group, radius: 120 });
  const post = createCameraPost();
  post.group.position.set(10.9, .15, -17.7);
  post.group.rotation.y = -0.9;    // looks toward the junction
  root.add(post.group);
  animated.push({ update: (t, dt) => post.smartCam?.update?.(t, dt), group: post.group, radius: 120 });
  progress(.9, 'Люди');
  await yieldFrame();

  /* ---------- virtual fences for the camera's point of view ---------- */
  const fenceGroup = new THREE.Group();
  const fenceMats = [];
  FENCES.forEach((d, i) => {
    const x = -STOP - d;
    const mat = new THREE.MeshBasicMaterial({ color: FENCE_COLORS[i], transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.6), mat);
    curtain.position.set(x, .8, 3.5);
    curtain.rotation.y = Math.PI / 2;
    const lineMat = new THREE.MeshBasicMaterial({ color: FENCE_COLORS[i], transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(.5, 7.2), lineMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(x, .03, 3.5);
    const posts = [0.05, 6.95].map(z => {
      const pm = new THREE.Mesh(new THREE.BoxGeometry(.14, 1.7, .14), lineMat);
      pm.position.set(x, .85, z);
      return pm;
    });
    fenceGroup.add(curtain, strip, ...posts);
    fenceMats.push({ curtain: mat, line: lineMat });
  });
  fenceGroup.visible = false;
  root.add(fenceGroup);

  /* ---------- the Lone Stars logo, high above the city ---------- */
  const star = createStarLogo();
  star.group.position.set(0, 305, 0);
  star.group.scale.setScalar(1.25);
  root.add(star.group);

  /* ---------- the W–E release on the "seconds" shot ---------- */
  const fleetM = fleets.M;
  const movers = [...westIn, ...eastIn];
  const byLane = {};
  for (const c of movers) (byLane[c.lane] ||= []).push(c);
  for (const lane of Object.values(byLane)) lane.sort((a, b) => Math.abs(a.x) - Math.abs(b.x)).forEach((c, k) => { c.rank = k; });
  const ACC = 2.3, VMAX = 11.5, TV = VMAX / ACC;
  const travelled = (tau, rank) => {
    const s = Math.max(0, tau - rank * .72);
    return s < TV ? .5 * ACC * s * s : .5 * ACC * TV * TV + VMAX * (s - TV);
  };
  for (const c of movers) { c.x0 = c.x; c.z0 = c.z; c.dir = c.lane[0] === 'W' ? 1 : -1; }
  let tau = -1;
  const setRelease = (value) => {
    if (value === tau) return;
    tau = value;
    for (const c of movers) {
      const d = travelled(tau, c.rank);
      c.x = c.x0 + c.dir * d;
      if (c.hero) hero.group.position.x = c.x;
      else { fleetM.setPose(c.i, c.x, 0, c.z0, c.rotY); fleetM.setBrake?.(c.i, d < .05); }
    }
    fleetM.commit?.();
  };
  setRelease(0);

  /* ---------- signal timing ---------- */
  // While jammed, a fixed-time controller cycles; once the release starts, W–E is held green.
  const states = { NS: 'red', EW: 'red' };
  const setSignals = (ns, ew) => {
    if (states.NS !== ns) { poles.N.setState(ns); poles.S.setState(ns); poles.N.setPedState?.(ew === 'red' && ns === 'red' ? 'green' : ew === 'green' ? 'green' : 'red'); states.NS = ns; }
    if (states.EW !== ew) { poles.W.setState(ew); poles.E.setState(ew); poles.W.setPedState?.(ns === 'green' ? 'green' : 'red'); states.EW = ew; }
  };
  const fixedTime = (t) => {
    const c = t % 24;
    if (c < 9) return ['green', 'red'];
    if (c < 11) return ['yellow', 'red'];
    if (c < 12) return ['red', 'redyellow'];
    if (c < 21) return ['red', 'green'];
    if (c < 23) return ['red', 'yellow'];
    return ['redyellow', 'red'];
  };
  ['N', 'S', 'W', 'E'].forEach(k => poles[k].setState('red'));
  states.NS = states.EW = 'red';

  /* ---------- per-frame ---------- */
  const tmp = new THREE.Vector3();
  const CULL = 760;
  world.update = (t, dt, camera) => {
    for (const c of chunks) {
      const dx = camera.position.x - c.x, dz = camera.position.z - c.z;
      c.group.visible = dx * dx + dz * dz < (CULL + CHUNK * .7) ** 2;
    }
    if (tau > 0) setSignals('red', 'green'); else { const [ns, ew] = fixedTime(t); setSignals(ns, ew); }
    // animate only what is near the camera; far people are also hidden to save draw calls
    for (const a of animated) {
      a.group.getWorldPosition(tmp);
      const near = tmp.distanceToSquared(camera.position) < a.radius * a.radius;
      if (a.hideFar) a.group.visible = near;
      if (near) a.update(t, dt);
    }
    if (star.group.visible) star.update(t, dt);
  };

  Object.assign(world, {
    root, poles, regulators, hero, driver, worker, works, star, fenceGroup, fenceMats, post, finaleOfficer,
    records, fleets, westIn, setRelease, heroPos,
    getRelease: () => tau,
    anchors: {
      M: new THREE.Vector3(0, 0, 0),
      campus: new THREE.Vector3(-40, 0, CAMPUS_ROAD_Z),
      avenue: new THREE.Vector3(BLVD_X, 0, -60),
    },
  });
  progress(1, 'Готово');
  return world;
}
