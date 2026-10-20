import * as THREE from 'three';
import { box, g, mat } from './common.js';
export function createRoadNetwork() {
  const grp = g(); const asphalt = mat(0x3a3d42);
  const strip = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), asphalt); m.rotation.x = -Math.PI / 2; m.position.set(x, .01, z); m.receiveShadow = true; grp.add(m); };
  return {
    addRoad(s) { const hw = s.lanesPerDir * (s.laneWidth || 3.5) + (s.median || 0) / 2; if (s.x1 === s.x2) strip(s.x1, (s.z1 + s.z2) / 2, hw * 2, Math.abs(s.z2 - s.z1)); else strip((s.x1 + s.x2) / 2, s.z1, Math.abs(s.x2 - s.x1), hw * 2); },
    addIntersection(s) { const a = s.arms; strip(s.x + (a.e - a.w) / 2, s.z, a.e + a.w, 14); strip(s.x, s.z + (a.s - a.n) / 2, 14, a.n + a.s); },
    addPath() {}, finish() { return grp; } };
}
export const createStreetlight = () => { const gg = g(); gg.add(box(.2, 9, .2, 0x888888)); return gg; };
export const createBench = () => { const gg = g(); gg.add(box(1.8, .5, .5, 0x8a5a3a)); return gg; };
export const createBusStop = () => { const gg = g(); gg.add(box(4, 2.5, 1.5, 0x99aabb)); return gg; };
export const createFence = ({ length }) => { const gg = g(); const b = box(length, 2.2, .1, 0x555555, length / 2); gg.add(b); return gg; };
export const createGround = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), mat(0xa7a27a)); m.rotation.x = -Math.PI / 2; m.receiveShadow = true; return m; };
