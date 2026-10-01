// Tree models (instanced): five near variants and one cheap far impostor. Sizes in world units
// (1 = 10 m): broadleaf ~1.6 tall, conifers ~1.9 at scale 1.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { hash2 } from '../game/rng';

function addThree(gb: GeoBuilder, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: number, jitter = 0, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(m);
  const p = g.getAttribute('position');
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

const T = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));

/** Variant ids: 0 oak (round), 1 birch, 2 poplar, 3 spruce, 4 pine. */
export const TREE_VARIANTS = 5;

export function createTreeGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // oak: trunk + three jittered blobs
  let b = new GeoBuilder();
  addThree(b, new THREE.CylinderGeometry(0.05, 0.09, 0.7, 5, 1, true), T(0, 0.35, 0), 0x5a4330);
  addThree(b, new THREE.IcosahedronGeometry(0.55, 0), T(0, 0.98, 0), 0x6f9a45, 0.28, 3);
  addThree(b, new THREE.IcosahedronGeometry(0.4, 0), T(0.24, 1.28, 0.1), 0x7aa64c, 0.28, 4);
  addThree(b, new THREE.IcosahedronGeometry(0.36, 0), T(-0.24, 0.8, -0.14), 0x648f3e, 0.28, 5);
  out.push(b.build());
  // birch: slender pale trunk, light airy crown
  b = new GeoBuilder();
  addThree(b, new THREE.CylinderGeometry(0.03, 0.05, 0.95, 5, 1, true), T(0, 0.47, 0), 0xd8d4c8);
  addThree(b, new THREE.IcosahedronGeometry(0.34, 0), T(0, 1.18, 0, 0.9, 1.35, 0.9), 0x8db35a, 0.3, 6);
  addThree(b, new THREE.IcosahedronGeometry(0.26, 0), T(0.1, 1.55, -0.06, 0.9, 1.2, 0.9), 0x9cc064, 0.3, 7);
  out.push(b.build());
  // poplar: tall columnar crown
  b = new GeoBuilder();
  addThree(b, new THREE.CylinderGeometry(0.035, 0.06, 0.5, 5, 1, true), T(0, 0.25, 0), 0x55432f);
  addThree(b, new THREE.IcosahedronGeometry(0.3, 0), T(0, 1.15, 0, 1, 2.6, 1), 0x587e3a, 0.18, 8);
  out.push(b.build());
  // spruce: trunk + stacked cones
  b = new GeoBuilder();
  addThree(b, new THREE.CylinderGeometry(0.04, 0.07, 0.45, 5, 1, true), T(0, 0.22, 0), 0x4a3828);
  addThree(b, new THREE.ConeGeometry(0.5, 0.8, 7, 1, true), T(0, 0.75, 0), 0x2f5a35);
  addThree(b, new THREE.ConeGeometry(0.38, 0.7, 7, 1, true), T(0, 1.18, 0), 0x356540);
  addThree(b, new THREE.ConeGeometry(0.25, 0.6, 7, 1, true), T(0, 1.58, 0), 0x3b6e46);
  out.push(b.build());
  // pine: tall bare trunk, flat umbrella crown
  b = new GeoBuilder();
  addThree(b, new THREE.CylinderGeometry(0.035, 0.065, 1.35, 5, 1, true), T(0, 0.67, 0), 0x6b4a32);
  addThree(b, new THREE.IcosahedronGeometry(0.42, 0), T(0, 1.5, 0, 1.15, 0.55, 1.15), 0x3e6a3a, 0.3, 9);
  addThree(b, new THREE.IcosahedronGeometry(0.28, 0), T(0.18, 1.72, 0.06, 1.1, 0.5, 1.1), 0x467442, 0.3, 10);
  out.push(b.build());
  return out;
}

/** Far impostor: a five-sided bicone crown on the ground (10 triangles). */
export function createImpostorGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const N = 5, r = 0.52, ym = 0.95;
  const top = [0, 1.7, 0], bot = [0, 0.15, 0];
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, ym, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, ym, Math.sin(a1) * r];
    pos.push(...p0, ...top, ...p1);
    pos.push(...p0, ...p1, ...bot);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  addThree(b, g, new THREE.Matrix4(), 0xffffff);
  return b.build();
}

/** Instance tint of the impostor per variant (approximate crown colour). */
const IMP_COLOR = [new THREE.Color(0x6c9443), new THREE.Color(0x86ab58), new THREE.Color(0x557b39), new THREE.Color(0x325c39), new THREE.Color(0x3e6a3b)];
const IMP_SCALE: [number, number, number][] = [[1.05, 0.95, 1.05], [0.75, 1.0, 0.75], [0.55, 1.12, 0.55], [0.85, 1.12, 0.85], [0.9, 1.05, 0.9]];

export interface TreeInstance { type: number; x: number; y: number; z: number; s: number; rot: number; tint: number }

/** Map a world tree (type 0 broadleaf / 1 conifer) to a model variant. */
export function treeVariant(type: number, h: number): number {
  if (type === 1) return h < 0.7 ? 3 : 4;
  return h < 0.6 ? 0 : h < 0.85 ? 1 : 2;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const col = new THREE.Color();

/** Near trees: one instanced mesh per variant present. `type` of the instances is the variant id. */
export function makeTreeMeshes(list: TreeInstance[], geos: THREE.BufferGeometry[], mat: THREE.Material): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  const buckets: TreeInstance[][] = geos.map(() => []);
  for (const t of list) (buckets[t.type] ?? buckets[0]).push(t);
  for (let type = 0; type < geos.length; type++) {
    const items = buckets[type];
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

/** Far impostor instance data (matrices, colours) for a list of trees. */
export function impostorData(list: TreeInstance[]): { m: Float32Array; c: Float32Array } {
  const m = new Float32Array(list.length * 16), c = new Float32Array(list.length * 3);
  list.forEach((it, i) => {
    const sc = IMP_SCALE[it.type] ?? IMP_SCALE[0];
    q.setFromAxisAngle(up, it.rot);
    pos.set(it.x, it.y, it.z);
    scl.set(it.s * sc[0], it.s * sc[1] * (0.9 + it.tint * 0.25), it.s * sc[2]);
    m4.compose(pos, q, scl);
    m4.toArray(m, i * 16);
    const k = 0.82 + it.tint * 0.3;
    const cc = IMP_COLOR[it.type] ?? IMP_COLOR[0];
    c[i * 3] = cc.r * k; c[i * 3 + 1] = cc.g * k; c[i * 3 + 2] = cc.b * k;
  });
  return { m, c };
}

/** Instanced impostor mesh with a given capacity (instances are written by the caller). */
export function makeImpostorMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
  im.count = 0;
  im.castShadow = false;
  im.receiveShadow = true;
  im.matrixAutoUpdate = false;
  return im;
}
