import * as THREE from 'three';
export const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: .7 });
export const box = (w, h, d, c, x = 0, y = h / 2, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c)); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; return m; };
export const g = () => new THREE.Group();
