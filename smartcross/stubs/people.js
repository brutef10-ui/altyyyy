import * as THREE from 'three';
import { box, g } from './common.js';
const person = (c) => { const group = g(); group.add(box(.45, 1.75, .3, c)); return { group, update() {} }; };
export const createPerson = () => person(0x4466aa);
export const createDriver = () => { const p = person(0xaa3333); p.group.children[0].scale.y = .5; return p; };
export const createWorker = () => { const p = person(0xff7a1a); p.toolTip = new THREE.Object3D(); p.toolTip.position.set(0, 0, .55); p.group.add(p.toolTip); return p; };
export const createOfficer = () => person(0xc8e04a);
