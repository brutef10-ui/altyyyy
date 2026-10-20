import * as THREE from 'three';
import { box, g } from './common.js';
export const VEHICLE_TYPES = ['sedan','hatch','suv','minibus','bus','pickup'];
export const VEHICLE_LENGTH = { sedan: 4.8, hatch: 4.1, suv: 4.9, minibus: 6.9, bus: 12, pickup: 5.3 };
export function createFleet(pl) {
  const group = g();
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, .5, 0);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff }), pl.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const dims = (t) => ({ bus: [2.5, 3, 12], minibus: [2, 2.6, 6.9] }[t] || [1.85, 1.5, VEHICLE_LENGTH[t]]);
  const setPose = (i, x, y, z, r) => { const [w, h, l] = dims(pl[i].type); q.setFromAxisAngle(up, r); m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(w, h, l)); im.setMatrixAt(i, m); };
  pl.forEach((p, i) => { setPose(i, p.x, 0, p.z, p.rotY); im.setColorAt(i, new THREE.Color(p.color)); });
  im.castShadow = im.receiveShadow = true; group.add(im);
  return { group, count: pl.length, setPose, setBrake() {}, commit() { im.instanceMatrix.needsUpdate = true; } };
}
export function createHeroCar({ color }) {
  const group = g(); group.add(box(1.85, 1.45, 4.8, color));
  const driverSeat = new THREE.Object3D(); driverSeat.position.set(.38, .45, -.3); group.add(driverSeat);
  const steeringWheel = new THREE.Object3D(); driverSeat.add(steeringWheel);
  return { group, driverSeat, steeringWheel, update() {} };
}
