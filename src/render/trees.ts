// Tree models (instanced): five near variants and two cheap far impostors (broadleaf, conifer). Sizes in world
// units (1 = 10 m): broadleaf ~1.6 tall, conifers ~1.9 at scale 1.
//
// Near models: crowns of several jittered lobes with soft normals (radial from each lobe, bent towards the
// crown centre) and height shading (darker underneath and inside, lighter sunlit tops), trunks with a root
// flare and branch stubs; conifers as stacked jagged tiers with undersides. Far impostors: a grounded crown
// on a trunk (no floating diamonds), coloured like the near crowns.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { hash2 } from '../game/rng';

/** Variant ids: 0 oak (round), 1 birch, 2 poplar, 3 spruce, 4 pine. */
export const TREE_VARIANTS = 5;

const col = new THREE.Color();
const tmp = new THREE.Color();
/** sRGB components (0..1) of a hex colour */
const srgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

/** Unique unit-sphere vertices and faces of an icosphere (indexed, so lobes get smooth normals). */
function icosphere(detail: number): { v: number[]; f: number[] } {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  const v: number[] = [], f: number[] = [];
  const map = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let j = map.get(k);
    if (j === undefined) { j = v.length / 3; v.push(x, y, z); map.set(k, j); }
    f.push(j);
  }
  g.dispose();
  return { v, f };
}
const ICO0 = icosphere(0), ICO1 = icosphere(1);

interface Crown { cx: number; cy: number; cz: number; y0: number; y1: number }

/**
 * A crown lobe: a jittered ellipsoid (icosphere) centred at (x, y, z) with radii (rx, ry, rz). Normals are the
 * ellipsoid's, bent towards the direction from the crown centre (soft, round foliage shading); colours shade
 * from dark underneath to light at the crown top, with a little per-vertex variation.
 */
function lobe(gb: GeoBuilder, crown: Crown, x: number, y: number, z: number, rx: number, ry: number, rz: number, color: number, seed: number, detail = 0, jitter = 0.22) {
  const S = detail ? ICO1 : ICO0;
  const base = gb.vertexCount;
  const n = S.v.length / 3;
  const [r0, g0, b0] = srgb(color);
  for (let i = 0; i < n; i++) {
    const ux = S.v[i * 3], uy = S.v[i * 3 + 1], uz = S.v[i * 3 + 2];
    const h = hash2(i * 7 + 3, seed * 13 + 1, seed) - 0.5;
    const k = 1 + h * jitter * 2;
    const px = x + ux * rx * k, py = y + uy * ry * (1 + h * jitter), pz = z + uz * rz * k;
    // ellipsoid normal, bent towards the outward direction from the crown centre
    let nx = ux / rx, ny = uy / ry, nz = uz / rz;
    let l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    let ox = px - crown.cx, oy = (py - crown.cy) * 0.8, oz = pz - crown.cz;
    l = Math.hypot(ox, oy, oz) || 1; ox /= l; oy /= l; oz /= l;
    let sx = nx * 0.55 + ox * 0.45, sy = ny * 0.55 + oy * 0.45 + 0.12, sz = nz * 0.55 + oz * 0.45;
    l = Math.hypot(sx, sy, sz) || 1;
    // height shading inside the crown: dark underneath, sunlit top; inner side (facing the trunk) darker
    const t = Math.min(1, Math.max(0, (py - crown.y0) / Math.max(0.1, crown.y1 - crown.y0)));
    const inner = Math.max(0, -(ux * (x - crown.cx) + uz * (z - crown.cz)) / (Math.hypot(x - crown.cx, z - crown.cz) || 1));
    const shade = (0.6 + 0.5 * t) * (1 - 0.18 * inner) * (0.94 + 0.12 * (hash2(i * 3 + 1, seed * 5 + 2, 77) - 0.5) * 2);
    let cr = r0 * shade, cg = g0 * shade, cb = b0 * shade;
    // tips catch the light: slightly warmer and lighter at the very top
    if (t > 0.8) { const f = (t - 0.8) * 0.35; cr += (0.92 - cr) * f; cg += (0.95 - cg) * f; cb += (0.6 - cb) * f; }
    gb.colorRGB(Math.min(1, cr), Math.min(1, cg), Math.min(1, cb));
    gb.vertex(px, py, pz, sx / l, sy / l, sz / l);
  }
  // icosphere faces wind counter-clockwise seen from outside
  for (let i = 0; i < S.f.length; i += 3) gb.idx.push(base + S.f[i], base + S.f[i + 1], base + S.f[i + 2]);
}

/** A tapered n-sided trunk / branch from (x0,y0,z0) to (x1,y1,z1) with radii r0 -> r1, smooth normals, no caps. */
function limb(gb: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, color: number, n = 6, flare = 0) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const L = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / L, ay = dy / L, az = dz / L;
  // a frame perpendicular to the axis
  let px = -az, py = 0, pz = ax;
  if (Math.abs(ay) > 0.9 || Math.hypot(px, pz) < 1e-3) { px = 1; py = 0; pz = 0; }
  const l = Math.hypot(px, py, pz); px /= l; py /= l; pz /= l;
  const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;
  const base = gb.vertexCount;
  const rings = flare > 0 ? 3 : 2;
  for (let r = 0; r < rings; r++) {
    const t = flare > 0 ? [0, 0.12, 1][r] : r;
    const rad = flare > 0 && r === 0 ? r0 * (1 + flare) : r0 + (r1 - r0) * t;
    const cx = x0 + dx * t, cy = y0 + dy * t, cz = z0 + dz * t;
    const shade = 0.7 + 0.3 * t;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
      gb.color(color, shade);
      gb.vertex(cx + nx * rad, cy + ny * rad, cz + nz * rad, nx, ny, nz);
    }
  }
  for (let r = 0; r < rings - 1; r++) for (let k = 0; k < n; k++) {
    const a = base + r * n + k, b = base + r * n + ((k + 1) % n), c = a + n, d = b + n;
    gb.idx.push(a, b, d, a, d, c);
  }
}

/**
 * A conifer tier: a jagged cone (2n rim points alternating in and out, drooping tips) from the rim at y0 (radius
 * r) to the apex at y1, with a darker underside rising into the tier.
 */
function tier(gb: GeoBuilder, y0: number, y1: number, r: number, color: number, seed: number, n = 7, ytop: number, ybot: number) {
  const base = gb.vertexCount;
  const c0 = color;
  const shadeAt = (y: number) => 0.62 + 0.48 * Math.min(1, Math.max(0, (y - ybot) / (ytop - ybot)));
  // apex
  gb.color(c0, Math.min(1.1, shadeAt(y1) * 1.04));
  gb.vertex(0, y1, 0, 0, 1, 0);
  const m = 2 * n;
  const slope = r / (y1 - y0);
  for (let k = 0; k < m; k++) {
    const a = (k / m) * Math.PI * 2 + hash2(k, seed, 3) * 0.25;
    const out = k % 2 === 0;
    const rr = r * (out ? 1 + (hash2(k, seed, 5) - 0.5) * 0.25 : 0.68);
    const yy = y0 + (out ? -0.05 * r : 0.06 * r);
    const c = Math.cos(a), s = Math.sin(a);
    const nl = Math.hypot(1, slope);
    gb.color(c0, shadeAt(yy) * (out ? 1 : 0.85));
    gb.vertex(c * rr, yy, s * rr, c / nl, slope / nl * 1.4, s / nl);
  }
  for (let k = 0; k < m; k++) gb.idx.push(base, base + 1 + ((k + 1) % m), base + 1 + k);
  // underside: from the rim up into the tier (dark)
  const ub = gb.vertexCount;
  gb.color(c0, 0.42);
  gb.vertex(0, y0 + (y1 - y0) * 0.3, 0, 0, -1, 0);
  for (let k = 0; k < m; k++) {
    const o = base + 1 + k;
    const x = gb.pos[o * 3], y = gb.pos[o * 3 + 1], z = gb.pos[o * 3 + 2];
    gb.color(c0, 0.5);
    gb.vertex(x, y, z, x * 0.3, -1, z * 0.3);
  }
  for (let k = 0; k < m; k++) gb.idx.push(ub, ub + 1 + k, ub + 1 + ((k + 1) % m));
}

export function createTreeGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const BARK = 0x5a4330;
  // 0 oak: stout trunk with two branch stubs, a broad crown of six lobes
  let b = new GeoBuilder();
  {
    const crown: Crown = { cx: 0, cy: 1.05, cz: 0, y0: 0.55, y1: 1.62 };
    limb(b, 0, 0, 0, 0, 0.78, 0, 0.085, 0.055, BARK, 6, 0.6);
    limb(b, 0, 0.6, 0, 0.26, 0.98, 0.1, 0.035, 0.018, BARK, 4);
    limb(b, 0, 0.66, 0, -0.24, 0.92, -0.16, 0.032, 0.016, BARK, 4);
    lobe(b, crown, 0, 1.0, 0, 0.5, 0.42, 0.5, 0x6a9442, 3);
    lobe(b, crown, 0.3, 1.18, 0.1, 0.36, 0.32, 0.36, 0x74a04a, 4);
    lobe(b, crown, -0.28, 0.95, -0.18, 0.34, 0.3, 0.34, 0x638d3d, 5);
    lobe(b, crown, -0.08, 1.36, 0.2, 0.32, 0.26, 0.32, 0x7aa64e, 6);
    lobe(b, crown, 0.14, 0.86, -0.3, 0.3, 0.26, 0.3, 0x5f8a3b, 7);
    lobe(b, crown, -0.3, 1.25, 0.18, 0.26, 0.24, 0.26, 0x70994a, 8);
  }
  out.push(b.build());
  // 1 birch: slender pale trunk, light airy crown of narrow lobes
  b = new GeoBuilder();
  {
    const crown: Crown = { cx: 0, cy: 1.25, cz: 0, y0: 0.75, y1: 1.8 };
    limb(b, 0, 0, 0, 0.02, 1.25, 0.01, 0.045, 0.028, 0xd8d4c8, 6, 0.3);
    limb(b, 0.01, 0.95, 0, 0.18, 1.3, -0.06, 0.018, 0.01, 0xcfcabd, 4);
    lobe(b, crown, 0, 1.15, 0, 0.3, 0.42, 0.3, 0x8ab258, 11);
    lobe(b, crown, 0.14, 1.48, -0.06, 0.24, 0.34, 0.24, 0x97bd62, 12);
    lobe(b, crown, -0.15, 1.32, 0.1, 0.22, 0.32, 0.22, 0x86ad55, 13);
    lobe(b, crown, 0.05, 1.68, 0.08, 0.17, 0.2, 0.17, 0x9fc46a, 14);
  }
  out.push(b.build());
  // 2 poplar: tall columnar crown of stacked lobes
  b = new GeoBuilder();
  {
    const crown: Crown = { cx: 0, cy: 1.2, cz: 0, y0: 0.4, y1: 2.05 };
    limb(b, 0, 0, 0, 0, 0.6, 0, 0.055, 0.035, 0x55432f, 6, 0.4);
    lobe(b, crown, 0, 0.82, 0, 0.27, 0.48, 0.27, 0x56803a, 21);
    lobe(b, crown, 0.03, 1.32, -0.02, 0.25, 0.48, 0.25, 0x5c8a3e, 22);
    lobe(b, crown, -0.02, 1.76, 0.03, 0.18, 0.34, 0.18, 0x649444, 23);
  }
  out.push(b.build());
  // 3 spruce: short trunk, four jagged tiers
  b = new GeoBuilder();
  {
    limb(b, 0, 0, 0, 0, 0.5, 0, 0.06, 0.04, 0x4a3828, 5, 0.3);
    const yb = 0.25, yt = 2.0;
    tier(b, 0.28, 1.05, 0.52, 0x2e5a36, 31, 7, yt, yb);
    tier(b, 0.66, 1.42, 0.42, 0x33623d, 32, 7, yt, yb);
    tier(b, 1.02, 1.74, 0.31, 0x386a42, 33, 6, yt, yb);
    tier(b, 1.36, 2.0, 0.19, 0x3e7247, 34, 5, yt, yb);
  }
  out.push(b.build());
  // 4 pine: tall bare trunk with branch stubs, flat umbrella crown
  b = new GeoBuilder();
  {
    const crown: Crown = { cx: 0, cy: 1.55, cz: 0, y0: 1.32, y1: 1.85 };
    limb(b, 0, 0, 0, 0.04, 1.45, 0.02, 0.06, 0.035, 0x6b4a32, 6, 0.35);
    limb(b, 0.03, 1.2, 0.01, 0.3, 1.5, 0.08, 0.022, 0.012, 0x6b4a32, 4);
    limb(b, 0.03, 1.26, 0.01, -0.24, 1.52, -0.12, 0.02, 0.012, 0x6b4a32, 4);
    lobe(b, crown, 0, 1.55, 0, 0.42, 0.2, 0.42, 0x3d6a3a, 41);
    lobe(b, crown, 0.28, 1.56, 0.08, 0.28, 0.16, 0.28, 0x44743f, 42);
    lobe(b, crown, -0.25, 1.52, -0.12, 0.27, 0.15, 0.27, 0x3a6537, 43);
    lobe(b, crown, 0.02, 1.72, -0.04, 0.24, 0.13, 0.24, 0x4a7a44, 44);
  }
  out.push(b.build());
  return out;
}

/** Far impostor kinds: 0 broadleaf, 1 conifer. */
export const IMPOSTOR_KINDS = 2;
export function impostorKind(variant: number): number { return variant >= 3 ? 1 : 0; }

/**
 * Far impostors: 0 a rounded crown (5-sided antiprism band, domed top, flat underside) on a trunk (24
 * triangles), 1 two stacked cones (16 triangles, the lower tier reaches down to the ground). Soft outward
 * normals; the crowns shade dark underneath like the near models.
 */
export function createImpostorGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // broadleaf
  let b = new GeoBuilder();
  limb(b, 0, 0, 0, 0, 0.62, 0, 0.07, 0.05, 0x5a4330, 3);
  {
    const N = 5, rings: [number, number, number, number][] = [[0.55, 0.48, 0.6, 0], [1.12, 0.54, 0.95, Math.PI / N]];
    const base = b.vertexCount;
    for (const [y, r, sh, a0] of rings) for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2 + a0;
      const c = Math.cos(a), s = Math.sin(a);
      const ny = (y - 0.95) * 1.4, l = Math.hypot(c, ny, s);
      b.color(0xffffff, sh); b.vertex(c * r, y, s * r, c / l, ny / l, s / l);
    }
    b.color(0xffffff, 1.12); b.vertex(0, 1.62, 0, 0, 1, 0);
    const top = b.vertexCount - 1;
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      const a = base + k, bb = base + k1, c = base + N + k, d = base + N + k1;
      // antiprism band (the upper ring is turned half a step)
      b.idx.push(a, c, bb, bb, c, d);
      b.idx.push(c, top, d);
    }
    // flat underside (3 triangles)
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 4);
  }
  out.push(b.build());
  // conifer
  b = new GeoBuilder();
  for (const [y0, y1, r, sh0, sh1, a0] of [[0.1, 1.25, 0.5, 0.6, 0.9, 0], [0.95, 2.0, 0.34, 0.85, 1.12, 0.63]] as [number, number, number, number, number, number][]) {
    const N = 5, base = b.vertexCount;
    b.color(0xffffff, sh1); b.vertex(0, y1, 0, 0, 1, 0);
    const slope = r / (y1 - y0);
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2 + a0;
      const c = Math.cos(a), s = Math.sin(a), l = Math.hypot(1, slope);
      b.color(0xffffff, sh0); b.vertex(c * r, y0, s * r, c / l, slope / l * 1.3, s / l);
    }
    for (let k = 0; k < N; k++) b.idx.push(base, base + 1 + ((k + 1) % N), base + 1 + k);
    // underside (3 triangles, own dark vertices facing down)
    const ub = b.vertexCount;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2 + a0;
      b.color(0xffffff, sh0 * 0.7); b.vertex(Math.cos(a) * r, y0, Math.sin(a) * r, 0, -1, 0);
    }
    b.idx.push(ub, ub + 1, ub + 2, ub, ub + 2, ub + 3, ub, ub + 3, ub + 4);
  }
  out.push(b.build());
  return out;
}

/** Average crown colour of a near variant (linear rgb of the vertex colours above the trunk), for its impostor tint. */
const crownAvg: THREE.Color[] = [];
function crownColour(geos: THREE.BufferGeometry[], v: number): THREE.Color {
  if (crownAvg[v]) return crownAvg[v];
  const g = geos[v], p = g.getAttribute('position'), c = g.getAttribute('color');
  let r = 0, gg = 0, bb = 0, n = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.45 && Math.hypot(p.getX(i), p.getZ(i)) < 0.12) continue; // trunk
    r += c.getX(i); gg += c.getY(i); bb += c.getZ(i); n++;
  }
  crownAvg[v] = new THREE.Color(r / n, gg / n, bb / n);
  return crownAvg[v];
}

/** Average linear vertex colour of each impostor shape (its shading), divided out of the instance colour. */
const impAvg: number[] = [];
function impostorShade(geos: THREE.BufferGeometry[], kd: number): number {
  if (impAvg[kd] !== undefined) return impAvg[kd];
  const c = geos[kd].getAttribute('color');
  let s = 0;
  for (let i = 0; i < c.count; i++) s += (c.getX(i) + c.getY(i) + c.getZ(i)) / 3;
  return (impAvg[kd] = s / Math.max(1, c.count));
}

/** Impostor scale per variant (x, y, z) relative to the impostor shapes. */
const IMP_SCALE: [number, number, number][] = [[1.05, 1.0, 1.05], [0.72, 1.12, 0.72], [0.55, 1.28, 0.55], [1.0, 1.0, 1.0], [0.95, 0.92, 0.95]];

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

/** Per-instance tint: brightness and a little hue variation (some yellower, some bluer). */
function tintOf(t: number, out: THREE.Color) {
  const k = 0.8 + t * 0.32;
  const warm = Math.sin(t * 37.1) * 0.5 + 0.5;
  out.setRGB(k * (0.93 + warm * 0.12), k, k * (0.92 + (1 - warm) * 0.1));
}

/** Near tree instance data per variant (matrices, linear colours). */
export function nearTreeData(list: TreeInstance[], variants: number): { m: Float32Array[]; c: Float32Array[] } {
  const counts = new Array(variants).fill(0);
  for (const t of list) counts[t.type < variants ? t.type : 0]++;
  const m = counts.map((k) => new Float32Array(k * 16)), c = counts.map((k) => new Float32Array(k * 3));
  const o = new Array(variants).fill(0);
  for (const it of list) {
    const v = it.type < variants ? it.type : 0, i = o[v]++;
    q.setFromAxisAngle(up, it.rot);
    pos.set(it.x, it.y, it.z);
    scl.set(it.s, it.s * (0.9 + it.tint * 0.25), it.s);
    m4.compose(pos, q, scl);
    m4.toArray(m[v], i * 16);
    tintOf(it.tint, col);
    c[v][i * 3] = col.r; c[v][i * 3 + 1] = col.g; c[v][i * 3 + 2] = col.b;
  }
  return { m, c };
}

/** Instanced near-tree mesh of one variant with a given capacity (instances are written by the caller). */
export function makeTreeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
  im.count = 0;
  im.castShadow = true;
  im.receiveShadow = true;
  im.matrixAutoUpdate = false;
  return im;
}

/**
 * Far impostor instance data per kind (matrices, linear colours: the near variant's average crown colour
 * times the instance tint, so the switch at uTreeDist does not change the colour).
 */
export function impostorData(list: TreeInstance[], geos: THREE.BufferGeometry[], imps: THREE.BufferGeometry[]): { m: Float32Array[]; c: Float32Array[] } {
  const counts = new Array(IMPOSTOR_KINDS).fill(0);
  for (const t of list) counts[impostorKind(t.type)]++;
  const m = counts.map((k) => new Float32Array(k * 16)), c = counts.map((k) => new Float32Array(k * 3));
  const o = new Array(IMPOSTOR_KINDS).fill(0);
  for (const it of list) {
    const kd = impostorKind(it.type), i = o[kd]++;
    const sc = IMP_SCALE[it.type] ?? IMP_SCALE[0];
    q.setFromAxisAngle(up, it.rot);
    pos.set(it.x, it.y, it.z);
    scl.set(it.s * sc[0], it.s * sc[1] * (0.9 + it.tint * 0.25), it.s * sc[2]);
    m4.compose(pos, q, scl);
    m4.toArray(m[kd], i * 16);
    tintOf(it.tint, tmp);
    const cc = crownColour(geos, it.type < geos.length ? it.type : 0), k = 1 / impostorShade(imps, kd);
    c[kd][i * 3] = cc.r * tmp.r * k; c[kd][i * 3 + 1] = cc.g * tmp.g * k; c[kd][i * 3 + 2] = cc.b * tmp.b * k;
  }
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
