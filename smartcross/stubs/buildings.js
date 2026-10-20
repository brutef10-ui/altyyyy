import * as THREE from 'three';
import { box, g } from './common.js';
export function createBuildingKit() {
  const grp = g();
  return { add(s) { const h = s.floors * 3; const b = box(s.w, h, s.d, s.style === 'office' ? 0x8fb0c8 : s.style === 'campus' ? 0xe8e2d4 : 0xd9cbb0); const o = g(); o.add(b); o.position.set(s.x, 0, s.z); o.rotation.y = s.rotY || 0; grp.add(o); }, finish() { return grp; } };
}
