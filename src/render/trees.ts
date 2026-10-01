// Tree models (instanced).
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
      const k = hash2(Math.round(x * 1000), Math.round(z * 1000) + Math.round(y * 1000) * 7, seed) - 0.5;
      p.setXYZ(i, x * (1 + k * jitter), y + k * jitter * 0.05, z * (1 + k * jitter));
    }
  }
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  gb.color(color);
  const base = gb.vertexCount;
  for (let i = 0; i < p.count; i++) gb.vertex(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i));
  for (let i = 0; i < p.count; i++) gb.idx.push(base + i);
}

export function createTreeGeometries(): THREE.BufferGeometry[] {
  // deciduous
  const d = new GeoBuilder();
  addThree(d, new THREE.CylinderGeometry(0.012, 0.02, 0.12, 6), new THREE.Matrix4().makeTranslation(0, 0.06, 0), 0x5a4330);
  addThree(d, new THREE.IcosahedronGeometry(0.11, 1), new THREE.Matrix4().makeTranslation(0, 0.19, 0), 0x6f9a45, 0.25, 3);
  addThree(d, new THREE.IcosahedronGeometry(0.075, 1), new THREE.Matrix4().makeTranslation(0.05, 0.26, 0.02), 0x7aa64c, 0.25, 4);
  addThree(d, new THREE.IcosahedronGeometry(0.07, 1), new THREE.Matrix4().makeTranslation(-0.05, 0.15, -0.03), 0x648f3e, 0.25, 5);
  // conifer
  const c = new GeoBuilder();
  addThree(c, new THREE.CylinderGeometry(0.01, 0.016, 0.08, 5), new THREE.Matrix4().makeTranslation(0, 0.04, 0), 0x4a3828);
  addThree(c, new THREE.ConeGeometry(0.1, 0.16, 7), new THREE.Matrix4().makeTranslation(0, 0.13, 0), 0x2f5a35);
  addThree(c, new THREE.ConeGeometry(0.08, 0.14, 7), new THREE.Matrix4().makeTranslation(0, 0.21, 0), 0x356540);
  addThree(c, new THREE.ConeGeometry(0.055, 0.12, 7), new THREE.Matrix4().makeTranslation(0, 0.29, 0), 0x3b6e46);
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
