// Tree models (instanced). Sizes in world units (1 = 10 m): deciduous ~1.6 tall, conifers ~1.9 at scale 1.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { hash2 } from '../game/rng';

function addThree(gb: GeoBuilder, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: number, jitter = 0, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(m);
  const p = g.getAttribute('position');
  // jitter vertices consistently by position for an organic look
  if (jitter > 0) {
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = hash2(Math.round(x * 300), Math.round(z * 300) + Math.round(y * 300) * 7, seed) - 0.5;
      p.setXYZ(i, x * (1 + k * jitter), y + k * jitter * 0.25, z * (1 + k * jitter));
    }
  }
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  gb.color(color);
  const base = gb.vertexCount;
  for (let i = 0; i < p.count; i++) {
    // soften normals towards "up/out" so crowns shade like foliage, not facets
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    const ox = p.getX(i), oz = p.getZ(i);
    const ol = Math.hypot(ox, oz) || 1;
    const sx = nx * 0.6 + (ox / ol) * 0.4, sy = ny * 0.6 + 0.4, sz = nz * 0.6 + (oz / ol) * 0.4;
    const sl = Math.hypot(sx, sy, sz) || 1;
    gb.vertex(p.getX(i), p.getY(i), p.getZ(i), sx / sl, sy / sl, sz / sl);
  }
  for (let i = 0; i < p.count; i++) gb.idx.push(base + i);
}

export function createTreeGeometries(): THREE.BufferGeometry[] {
  const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  // deciduous: trunk + three jittered blobs
  const d = new GeoBuilder();
  addThree(d, new THREE.CylinderGeometry(0.05, 0.09, 0.7, 5, 1, true), T(0, 0.35, 0), 0x5a4330);
  addThree(d, new THREE.IcosahedronGeometry(0.55, 0), T(0, 0.98, 0), 0x6f9a45, 0.28, 3);
  addThree(d, new THREE.IcosahedronGeometry(0.4, 0), T(0.24, 1.28, 0.1), 0x7aa64c, 0.28, 4);
  addThree(d, new THREE.IcosahedronGeometry(0.36, 0), T(-0.24, 0.8, -0.14), 0x648f3e, 0.28, 5);
  // conifer: trunk + stacked cones
  const c = new GeoBuilder();
  addThree(c, new THREE.CylinderGeometry(0.04, 0.07, 0.45, 5, 1, true), T(0, 0.22, 0), 0x4a3828);
  addThree(c, new THREE.ConeGeometry(0.5, 0.8, 7, 1, true), T(0, 0.75, 0), 0x2f5a35);
  addThree(c, new THREE.ConeGeometry(0.38, 0.7, 7, 1, true), T(0, 1.18, 0), 0x356540);
  addThree(c, new THREE.ConeGeometry(0.25, 0.6, 7, 1, true), T(0, 1.58, 0), 0x3b6e46);
  return [d.build(), c.build()];
}

export interface TreeInstance { type: number; x: number; y: number; z: number; s: number; rot: number; tint: number }

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const col = new THREE.Color();

export function makeTreeMeshes(list: TreeInstance[], geos: THREE.BufferGeometry[], mat: THREE.Material): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  for (let type = 0; type < geos.length; type++) {
    const items = list.filter((t) => t.type === type);
    if (!items.length) continue;
    const im = new THREE.InstancedMesh(geos[type], mat, items.length);
    items.forEach((it, i) => {
      q.setFromAxisAngle(up, it.rot);
      pos.set(it.x, it.y, it.z);
      scl.set(it.s, it.s * (0.9 + it.tint * 0.25), it.s);
      m4.compose(pos, q, scl);
      im.setMatrixAt(i, m4);
      const k = 0.82 + it.tint * 0.3;
      col.setRGB(k * (0.95 + it.tint * 0.1), k, k * (0.9 + (1 - it.tint) * 0.1));
      im.setColorAt(i, col);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    out.push(im);
  }
  return out;
}
