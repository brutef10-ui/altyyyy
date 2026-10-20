import * as THREE from 'three';
import { box, g, mat } from './common.js';
export function createVegetationKit() {
  const pts = [];
  return { addTree(x, z, o) { pts.push([x, z, o.type === 'poplar' ? 18 : 10]); }, addBush(x, z) { pts.push([x, z, 1.5]); }, addHedge() {}, addFlowerBed() {},
    finish() { const geo = new THREE.ConeGeometry(2, 1, 6); geo.translate(0, .5, 0); const im = new THREE.InstancedMesh(geo, mat(0x3f7a35), pts.length); const m = new THREE.Matrix4();
      pts.forEach(([x, z, h], i) => { m.makeScale(h / 6, h, h / 6); m.setPosition(x, 0, z); im.setMatrixAt(i, m); }); im.castShadow = true; const gg = g(); gg.add(im); return gg; } };
}
export function createLawn(w, d) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x6f9a4a)); m.rotation.x = -Math.PI / 2; m.position.y = .02; m.receiveShadow = true; return m; }
export function createMountains() { const gg = g(); for (let i = 0; i < 9; i++) { const m = new THREE.Mesh(new THREE.ConeGeometry(500, 600, 5), mat(0x8fa3c0)); m.position.set(-2400 + i * 600, 300, 2100); gg.add(m); } return gg; }
