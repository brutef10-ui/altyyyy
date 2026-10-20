import * as THREE from 'three';
import { g } from './common.js';
export function createStarLogo() { const group = g(); const m = new THREE.Mesh(new THREE.IcosahedronGeometry(3, 0), new THREE.MeshStandardMaterial({ color: 0xf4b740 })); group.add(m); return { group, update(t) { m.rotation.y = t; } }; }
