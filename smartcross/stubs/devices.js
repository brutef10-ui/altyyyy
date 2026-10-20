import * as THREE from 'three';
import { box, g } from './common.js';
export function createSmartCam() { const group = g(); group.add(box(.3, .3, .6, 0xeeeeee)); const lens = new THREE.Object3D(); lens.position.z = .32; group.add(lens); return { group, lens, setActive() {}, update() {} }; }
export function createSignalPole({ armLength = 8 }) {
  const group = g(); group.add(box(.25, 6.5, .25, 0x999999)); group.add(box(armLength, .2, .2, 0x999999, -armLength / 2, 6));
  const head = box(.4, 1.1, .3, 0x222222, -armLength + 1.5, 5.4); group.add(head);
  const cameraMount = new THREE.Object3D(); cameraMount.position.set(0, 7, .2); group.add(cameraMount);
  const smartCam = createSmartCam(); smartCam.group.rotation.x = .2; cameraMount.add(smartCam.group);
  const regulatorMount = new THREE.Object3D(); regulatorMount.position.set(0, 7.6, 0); group.add(regulatorMount);
  return { group, setState(s) { head.material.color.set(s === 'green' ? 0x22aa44 : s === 'red' ? 0xaa2222 : 0xaaaa22); }, setPedState() {}, cameraMount, regulatorMount, smartCam, update() {} };
}
export const createEdgeBox = () => { const group = g(); group.add(box(.8, 1.4, .5, 0x9aa0a6)); return { group }; };
export const createCameraPost = () => { const group = g(); group.add(box(.12, 2.4, .12, 0x888888)); const smartCam = createSmartCam(); smartCam.group.position.y = 2.5; group.add(smartCam.group); return { group, smartCam }; };
export function createRoadWorks({ length = 24, width = 7 }) { const group = g(); group.add(box(length, .8, width, 0xcc4444, length / 2)); const workerSpot = new THREE.Object3D(); workerSpot.position.set(length / 2, 0, width / 2 - 1); group.add(workerSpot); const dustOrigin = new THREE.Object3D(); group.add(dustOrigin); return { group, workerSpot, dustOrigin, update() {} }; }
export const createDust = () => ({ group: g(), burst() {}, update() {} });
export const createHonkWaves = () => { const group = g(); group.add(box(.3, .3, .3, 0xffd34d)); return { group, update() {} }; };
