// Instanced trees, 1 unit = 10 m. Five near species (150–400 triangles) and two cheap far shapes.
// Shrubs reuse the broadleaf bucket with squat transforms: no extra materials, groups or draw calls.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { hash2 } from '../game/rng';
import { WATER_Y } from '../game/constants';
import { pointInRect } from '../game/world';
import type { World } from '../game/world';

/** Variant ids: 0 oak/beech, 1 birch, 2 poplar, 3 spruce, 4 pine. */
export const TREE_VARIANTS = 5;
export const IMPOSTOR_KINDS = 2;

const srgb = (c: number): [number, number, number] => [
  ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255,
];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Weld the icosphere so foliage normals interpolate across faces, including the seam. */
function icosphere(detail: number): { v: number[]; f: number[] } {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  const v: number[] = [], f: number[] = [];
  const map = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = Math.round(x * 1e5) + ':' + Math.round(y * 1e5) + ':' + Math.round(z * 1e5);
    let j = map.get(key);
    if (j === undefined) { j = v.length / 3; v.push(x, y, z); map.set(key, j); }
    f.push(j);
  }
  g.dispose();
  return { v, f };
}
const ICO0 = icosphere(0), ICO1 = icosphere(1);

interface Crown { cx: number; cy: number; cz: number; y0: number; y1: number }

/** Surface flags keep bark separate from foliage tint, even though they share one material and mesh. */
function surface(gb: GeoBuilder, foliage: number, birch = 0) {
  gb.attr('aTreeSurface', 2, foliage, birch);
}

/** Overlapping, asymmetric ellipsoids with gently blended normals and baked crown occlusion. */
function lobe(gb: GeoBuilder, crown: Crown, x: number, y: number, z: number,
  rx: number, ry: number, rz: number, color: number, seed: number, detail = 0) {
  const sphere = detail ? ICO1 : ICO0, base = gb.vertexCount;
  const [r0, g0, b0] = srgb(color);
  const jitter = detail ? 0.10 : 0.15;
  for (let i = 0; i < sphere.v.length / 3; i++) {
    const ux = sphere.v[i * 3], uy = sphere.v[i * 3 + 1], uz = sphere.v[i * 3 + 2];
    const h = hash2(i * 7 + 3, seed * 13 + 1, seed) - 0.5;
    const k = 1 + h * jitter * 2;
    const px = x + ux * rx * k + uy * ry * 0.055;
    const py = y + uy * ry * (1 + h * jitter);
    const pz = z + uz * rz * k;
    let nx = ux / rx, ny = uy / ry, nz = uz / rz;
    let len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    let ox = px - crown.cx, oy = (py - crown.cy) * 0.8, oz = pz - crown.cz;
    len = Math.hypot(ox, oy, oz) || 1; ox /= len; oy /= len; oz /= len;
    let sx = nx * 0.72 + ox * 0.28, sy = ny * 0.72 + oy * 0.28, sz = nz * 0.72 + oz * 0.28;
    len = Math.hypot(sx, sy, sz) || 1;
    const t = clamp01((py - crown.y0) / (crown.y1 - crown.y0));
    const inner = Math.max(0, -(ux * (x - crown.cx) + uz * (z - crown.cz)) /
      (Math.hypot(x - crown.cx, z - crown.cz) || 1));
    const shade = (0.79 + 0.21 * t) * (1 - 0.10 * inner) *
      (0.97 + 0.06 * hash2(i * 3, seed, 77));
    const tip = Math.max(0, t - 0.8) * 0.08;
    gb.colorRGB(r0 * shade + tip, g0 * shade + tip * 0.8, b0 * shade + tip * 0.3);
    surface(gb, 1);
    gb.vertex(px, py, pz, sx / len, sy / len, sz / len);
  }
  for (let i = 0; i < sphere.f.length; i += 3)
    gb.idx.push(base + sphere.f[i], base + sphere.f[i + 1], base + sphere.f[i + 2]);
}

/** Tapered trunk / branch, smooth perpendicular frame, root flare and a flat ground contact. */
function limb(gb: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  r0: number, r1: number, color: number, n = 6, flare = 0, birch = false) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, length = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / length, ay = dy / length, az = dz / length;
  let px = ay, py = -ax, pz = 0;
  if (Math.abs(az) > 0.9) { px = 0; py = az; pz = -ay; }
  const plen = Math.hypot(px, py, pz) || 1; px /= plen; py /= plen; pz /= plen;
  const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;
  const base = gb.vertexCount, rings = flare > 0 ? 3 : 2, taper = (r0 - r1) / length;
  for (let ring = 0; ring < rings; ring++) {
    const t = flare > 0 ? [0, 0.1, 1][ring] : ring;
    const radius = flare > 0 && ring === 0 ? r0 * (1 + flare) : r0 + (r1 - r0) * t;
    for (let k = 0; k < n; k++) {
      const angle = k / n * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
      const rx = px * c + qx * s, ry = py * c + qy * s, rz = pz * c + qz * s;
      const nx = rx + ax * taper, ny = ry + ay * taper, nz = rz + az * taper;
      const len = Math.hypot(nx, ny, nz);
      gb.color(color, (birch ? 0.91 : 0.82) + 0.12 * t + 0.03 * Math.sin(angle * 2));
      surface(gb, 0, birch ? 1 : 0);
      gb.vertex(x0 + dx * t + rx * radius, flare > 0 && ring === 0 ? y0 : y0 + dy * t + ry * radius,
        z0 + dz * t + rz * radius, nx / len, ny / len, nz / len);
    }
  }
  for (let ring = 0; ring < rings - 1; ring++) for (let k = 0; k < n; k++) {
    const a = base + ring * n + k, b = base + ring * n + (k + 1) % n;
    gb.idx.push(a, b, b + n, a, b + n, a + n);
  }
}

/** A shouldered conifer tier, with alternating drooping branch tips and a shaded underside (8n tris). */
function tier(gb: GeoBuilder, y0: number, y1: number, radius: number, color: number,
  seed: number, n: number, top: number, bottom: number) {
  const base = gb.vertexCount, m = n * 2, height = y1 - y0;
  const cx = (hash2(seed, 1) - 0.5) * 0.06, cz = (hash2(seed, 2) - 0.5) * 0.06;
  const shadeAt = (y: number) => 0.77 + 0.23 * clamp01((y - bottom) / (top - bottom));
  for (let ring = 0; ring < 2; ring++) for (let k = 0; k < m; k++) {
    const angle = k / m * Math.PI * 2 + seed * 0.37, out = k % 2 === 0;
    const rr = radius * (ring ? 0.66 : 1) * (out ? 0.95 + hash2(k, seed, 5) * 0.12 : 0.79);
    const y = y0 + (ring ? height * 0.38 : (out ? -0.07 : 0.03) * radius);
    const c = Math.cos(angle), s = Math.sin(angle), slope = radius / height;
    const len = Math.hypot(1, slope);
    gb.color(color, shadeAt(y) * (out ? 1 : 0.94));
    surface(gb, 1);
    gb.vertex(cx + c * rr, y, cz + s * rr, c / len, slope / len, s / len);
  }
  gb.color(color, shadeAt(y1)); surface(gb, 1);
  const apex = gb.vertex(cx, y1, cz, 0, 1, 0);
  for (let k = 0; k < m; k++) {
    const a = base + k, b = base + (k + 1) % m, c = a + m, d = b + m;
    gb.idx.push(a, c, b, b, c, d, c, apex, d);
  }
  gb.color(color, 0.72); surface(gb, 1);
  const under = gb.vertex(cx, y0 + height * 0.1, cz, 0, -1, 0);
  const rim = gb.vertexCount;
  for (let k = 0; k < m; k++) {
    const a = (base + k) * 3;
    gb.color(color, 0.73); surface(gb, 1);
    const nx = gb.pos[a] - cx, nz = gb.pos[a + 2] - cz, len = Math.hypot(nx, 1, nz);
    gb.vertex(gb.pos[a], gb.pos[a + 1], gb.pos[a + 2], nx / len, -1 / len, nz / len);
  }
  for (let k = 0; k < m; k++) gb.idx.push(under, rim + k, rim + (k + 1) % m);
}

export function createTreeGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [], bark = 0x665547;
  let b = new GeoBuilder();
  // Oak / beech: branching scaffold and seven lobes, with detail concentrated on the silhouette.
  {
    const crown = { cx: 0, cy: 1.1, cz: 0, y0: 0.53, y1: 1.7 };
    limb(b, 0, 0, 0, 0.025, 1.02, -0.02, 0.085, 0.035, bark, 7, 0.55);
    limb(b, 0.01, 0.48, 0, 0.32, 0.98, 0.15, 0.035, 0.013, bark, 4);
    limb(b, 0.02, 0.61, -0.01, -0.31, 1.13, -0.18, 0.032, 0.012, bark, 4);
    limb(b, 0.02, 0.77, -0.01, -0.13, 1.4, 0.18, 0.025, 0.009, bark, 4);
    limb(b, 0.01, 0.68, -0.02, 0.12, 1.02, -0.36, 0.024, 0.009, bark, 4);
    lobe(b, crown, 0.02, 1.07, 0, 0.47, 0.42, 0.45, 0x73855d, 3, 1);
    lobe(b, crown, 0.32, 1.17, 0.12, 0.34, 0.31, 0.35, 0x7a8c63, 4, 1);
    lobe(b, crown, -0.29, 1.09, -0.18, 0.33, 0.32, 0.33, 0x6d8056, 5, 1);
    lobe(b, crown, -0.1, 1.43, 0.16, 0.29, 0.26, 0.28, 0x819269, 6);
    lobe(b, crown, 0.14, 0.85, -0.31, 0.28, 0.25, 0.29, 0x6b7e55, 7);
    lobe(b, crown, -0.32, 1.3, 0.17, 0.25, 0.24, 0.25, 0x788961, 8);
    lobe(b, crown, 0.29, 1.36, -0.16, 0.24, 0.23, 0.25, 0x7c8e65, 9);
  }
  out.push(b.build());
  // Birch: pale, slender trunk with forks visible through an airy, uneven crown.
  b = new GeoBuilder();
  {
    const crown = { cx: 0.025, cy: 1.4, cz: 0, y0: 0.76, y1: 1.97 };
    limb(b, 0, 0, 0, 0.045, 1.64, 0.015, 0.041, 0.013, 0xd4d1c5, 7, 0.22, true);
    limb(b, 0.025, 0.92, 0.01, 0.23, 1.46, -0.09, 0.018, 0.007, 0xb5b5a7, 4, 0, true);
    limb(b, 0.03, 1.12, 0.01, -0.21, 1.56, 0.12, 0.016, 0.006, 0xc6c5b7, 4, 0, true);
    limb(b, 0.015, 0.78, 0, -0.17, 1.17, -0.08, 0.017, 0.006, 0xb8b8aa, 4, 0, true);
    lobe(b, crown, 0.035, 1.25, 0, 0.25, 0.37, 0.25, 0x879a6b, 11, 1);
    lobe(b, crown, 0.19, 1.5, -0.09, 0.22, 0.3, 0.21, 0x92a576, 12, 1);
    lobe(b, crown, -0.19, 1.4, 0.12, 0.2, 0.31, 0.2, 0x839768, 13);
    lobe(b, crown, 0.07, 1.77, 0.07, 0.16, 0.21, 0.17, 0x96a97a, 14);
    lobe(b, crown, -0.16, 1.03, -0.07, 0.19, 0.25, 0.18, 0x819465, 15);
  }
  out.push(b.build());
  // Poplar: narrow, upright overlapping lobes, tapering to an irregular tip.
  b = new GeoBuilder();
  {
    const crown = { cx: 0, cy: 1.25, cz: 0, y0: 0.36, y1: 2.15 };
    limb(b, 0, 0, 0, -0.015, 1.38, 0.015, 0.055, 0.018, 0x655748, 6, 0.35);
    limb(b, 0, 0.44, 0, 0.11, 0.94, 0.08, 0.022, 0.009, bark, 4);
    limb(b, -0.01, 0.78, 0.01, -0.13, 1.35, -0.08, 0.017, 0.007, bark, 4);
    lobe(b, crown, 0, 0.83, 0, 0.25, 0.46, 0.24, 0x6b8058, 21, 1);
    lobe(b, crown, 0.02, 1.32, -0.02, 0.235, 0.46, 0.23, 0x71865d, 22, 1);
    lobe(b, crown, -0.035, 1.75, 0.02, 0.17, 0.32, 0.18, 0x788e64, 23);
    lobe(b, crown, 0.015, 1.99, -0.015, 0.10, 0.16, 0.11, 0x7b9168, 24);
  }
  out.push(b.build());
  // Spruce: five shouldered tiers with drooping tips, soft side normals and branch hints below.
  b = new GeoBuilder();
  {
    limb(b, 0, 0, 0, 0, 0.85, 0, 0.06, 0.028, 0x594c3e, 6, 0.32);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.3;
      limb(b, 0, 0.47, 0, Math.cos(a) * 0.39, 0.32, Math.sin(a) * 0.39,
        0.015, 0.006, 0x594c3e, 3);
    }
    tier(b, 0.34, 1.02, 0.53, 0x4c6957, 31, 8, 2.04, 0.3);
    tier(b, 0.69, 1.36, 0.44, 0x506e5b, 32, 7, 2.04, 0.3);
    tier(b, 1.03, 1.66, 0.34, 0x557460, 33, 6, 2.04, 0.3);
    tier(b, 1.34, 1.88, 0.24, 0x5a7964, 34, 5, 2.04, 0.3);
    tier(b, 1.64, 2.04, 0.13, 0x617f69, 35, 4, 2.04, 0.3);
  }
  out.push(b.build());
  // Pine: open trunk and radiating boughs, with broken foliage arranged in three ascending tiers.
  b = new GeoBuilder();
  {
    const crown = { cx: 0.02, cy: 1.36, cz: 0, y0: 0.72, y1: 1.99 };
    limb(b, 0, 0, 0, 0.035, 1.56, 0.015, 0.06, 0.021, 0x796049, 7, 0.3);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4;
      limb(b, 0.025, 0.83 + k * 0.105, 0.01,
        Math.cos(a) * 0.35, 1.05 + k * 0.11, Math.sin(a) * 0.35,
        0.023, 0.009, 0x796049, 4);
    }
    lobe(b, crown, 0.015, 1.23, 0, 0.42, 0.31, 0.4, 0x60785e, 41, 1);
    lobe(b, crown, -0.025, 1.57, 0.015, 0.29, 0.29, 0.28, 0x678066, 42, 1);
    lobe(b, crown, 0.31, 1.07, 0.11, 0.24, 0.22, 0.24, 0x587255, 43);
    lobe(b, crown, -0.29, 1.12, -0.14, 0.24, 0.23, 0.23, 0x5d765a, 44);
    lobe(b, crown, -0.13, 1.42, 0.24, 0.21, 0.2, 0.22, 0x617b5f, 45);
    lobe(b, crown, 0.19, 1.5, -0.14, 0.2, 0.22, 0.2, 0x658063, 46);
    lobe(b, crown, 0.01, 1.81, 0.025, 0.17, 0.18, 0.16, 0x6c856a, 47);
  }
  out.push(b.build());
  for (let v = 0; v < out.length; v++) out[v].name = ['oak', 'birch', 'poplar', 'spruce', 'pine'][v];
  return out;
}

export function impostorKind(variant: number): number { return variant === 3 || variant === 4 ? 1 : 0; }

/** Far crown: a broad, flat underside, straight sides and a domed top. Never a bicone / diamond. */
export function createImpostorGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  let b = new GeoBuilder();
  limb(b, 0, 0, 0, 0, 0.85, 0, 0.072, 0.035, 0x665547, 3);
  const n = 6, base = b.vertexCount;
  for (let ring = 0; ring < 2; ring++) for (let k = 0; k < n; k++) {
    const angle = k / n * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
    const y = ring ? 1.2 : 0.56, radius = ring ? 0.55 : 0.44;
    const ny = ring ? 0.3 : -0.22, len = Math.hypot(1, ny);
    b.color(0xffffff, ring ? 0.98 : 0.81); surface(b, 1);
    b.vertex(c * radius, y, s * radius, c / len, ny / len, s / len);
  }
  b.color(0xffffff); surface(b, 1);
  const apex = b.vertex(-0.035, 1.65, 0.02, 0, 1, 0);
  for (let k = 0; k < n; k++) {
    const a = base + k, next = base + (k + 1) % n;
    b.idx.push(a, a + n, next, next, a + n, next + n, a + n, apex, next + n);
  }
  const bottom = b.vertexCount;
  for (let k = 0; k < n; k++) {
    const p = (base + k) * 3;
    b.color(0xffffff, 0.75); surface(b, 1);
    b.vertex(b.pos[p], b.pos[p + 1], b.pos[p + 2], 0, -1, 0);
  }
  for (let k = 1; k < n - 1; k++) b.idx.push(bottom, bottom + k, bottom + k + 1);
  out.push(b.build()); // 6 trunk + 12 sides + 6 top + 4 underside = 28.
  b = new GeoBuilder();
  limb(b, 0, 0, 0, 0, 0.88, 0, 0.06, 0.025, 0x695542, 3);
  // Three overlapping, capped cones with exposed brown trunk. Each is six triangles.
  for (const [y0, y1, radius, phase] of [
    [0.34, 1.21, 0.51, 0.2], [0.91, 1.7, 0.36, 0.55], [1.44, 2.04, 0.21, 0.2],
  ]) {
    const start = b.vertexCount, slope = radius / (y1 - y0), len = Math.hypot(1, slope);
    b.color(0xffffff, 0.97 + y1 * 0.01); surface(b, 1);
    const top = b.vertex(0, y1, 0, 0, 1, 0);
    for (let k = 0; k < 4; k++) {
      const angle = k / 4 * Math.PI * 2 + phase, c = Math.cos(angle), s = Math.sin(angle);
      b.color(0xffffff, 0.78 + y0 * 0.08); surface(b, 1);
      b.vertex(c * radius, y0, s * radius, c / len, slope / len, s / len);
    }
    for (let k = 0; k < 4; k++) b.idx.push(top, start + 1 + (k + 1) % 4, start + 1 + k);
    const under = b.vertexCount;
    for (let k = 0; k < 4; k++) {
      const p = (start + k + 1) * 3;
      b.color(0xffffff, 0.73); surface(b, 1);
      b.vertex(b.pos[p], y0, b.pos[p + 2], 0, -1, 0);
    }
    b.idx.push(under, under + 1, under + 2, under, under + 2, under + 3);
  }
  out.push(b.build()); // 6 trunk + 3 * 6 cone = 24.
  out[0].name = 'broadleaf-far'; out[1].name = 'conifer-far';
  return out;
}

export interface TreeInstance {
  type: number; x: number; y: number; z: number; s: number; rot: number; tint: number;
  /** Squat broadleaf instance, kept in the existing oak draw bucket. */
  shrub?: boolean;
}

/** Map world type 0 broadleaf / 1 conifer to the existing five model buckets. */
export function treeVariant(type: number, h: number): number {
  if (type === 1) return h < 0.7 ? 3 : 4;
  return h < 0.6 ? 0 : h < 0.85 ? 1 : 2;
}

/**
 * Bounded, deterministic undergrowth from this super-chunk's trees. A spatial hash finds clusters and
 * unoccupied angular sectors; sparse edges get more shrubs than shaded interiors, isolated trees get none.
 * Sample the real terrain and keep transport formations, buildings, steep slopes and water clear.
 * This changes only render instances, so saves and the simulation's tree count are unaffected.
 */
export function forestTreeInstances(list: TreeInstance[], world: World): TreeInstance[] {
  if (list.length < 3) return list;
  const cell = 3.2, grid = new Map<string, TreeInstance[]>();
  const key = (x: number, z: number) => x + ':' + z;
  for (const t of list) {
    if (t.shrub || t.s < 0.7) continue;
    const k = key(Math.floor(t.x / cell), Math.floor(t.z / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(t); else grid.set(k, [t]);
  }
  const out = list.slice();
  for (const t of list) {
    if (t.shrub || t.s < 0.7) continue;
    const hx = Math.floor(t.x * 64), hz = Math.floor(t.z * 64);
    // Reject most parents before searching: the final rate is <= 18% and at most one shrub per parent.
    const roll = hash2(hx, hz, 701);
    if (roll >= 0.18) continue;
    const gx = Math.floor(t.x / cell), gz = Math.floor(t.z / cell);
    let neighbours = 0, sectors = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      for (const other of grid.get(key(gx + dx, gz + dz)) ?? []) {
        if (other === t) continue;
        const ox = other.x - t.x, oz = other.z - t.z;
        if (ox * ox + oz * oz > cell * cell) continue;
        neighbours++;
        const sector = Math.floor((Math.atan2(oz, ox) + Math.PI) / (Math.PI * 2) * 8) % 8;
        sectors |= 1 << sector;
      }
    }
    if (neighbours < 2) continue;
    const gaps: number[] = [];
    for (let k = 0; k < 8; k++) if (!(sectors & (1 << k))) gaps.push(k);
    const edge = gaps.length >= 3;
    if (!edge && roll >= 0.025) continue;
    const sector = gaps.length ? gaps[Math.floor(hash2(hx, hz, 703) * gaps.length)] : hash2(hx, hz, 703) * 8;
    const angle = (sector + 0.25 + hash2(hx, hz, 709) * 0.5) / 8 * Math.PI * 2 - Math.PI;
    const radius = (0.32 + hash2(hx, hz, 719) * 0.2) * Math.min(1.15, t.s);
    const x = t.x + Math.cos(angle) * radius, z = t.z + Math.sin(angle) * radius;
    if (!world.inside(x, z, 0.4)) continue;
    const y = world.heightAt(x, z);
    if (y < WATER_Y + 0.08 || world.slopeAt(x, z) > 0.65 || Math.abs(y - t.y) > 0.42) continue;
    if (world.net.nearestEdge(x, z, 1.0)) continue;
    if (world.buildingsNear(x, z, 2).some((b) =>
      pointInRect(x, z, b.x, b.z, b.angle, b.w / 2 + 0.4, b.d / 2 + 0.4))) continue;
    out.push({ type: 0, x, y: y - 0.025, z, s: 0.24 + hash2(hx, hz, 727) * 0.13,
      rot: hash2(hx, hz, 733) * Math.PI * 2, tint: hash2(hx, hz, 739), shrub: true });
  }
  return out;
}

const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler();
const position = new THREE.Vector3(), scale = new THREE.Vector3(), color = new THREE.Color();
const IMP_SCALE: [number, number, number][] = [
  [1.08, 1.02, 1.08], [0.73, 1.19, 0.73], [0.47, 1.30, 0.47], [1, 1, 1], [1.02, 0.97, 1.02],
];

function variantOf(t: TreeInstance, variants = TREE_VARIANTS) {
  return Number.isInteger(t.type) && t.type >= 0 && t.type < variants ? t.type : 0;
}

/** Same anchored lean and independent aspect variation in both LODs (not correlated with brightness). */
function transformOf(t: TreeInstance, far: boolean) {
  const hx = Math.floor(t.x * 64), hz = Math.floor(t.z * 64), v = variantOf(t);
  const lean = t.shrub ? 0.022 : v === 2 ? 0.026 : 0.045;
  euler.set((hash2(hx, hz, 811) - 0.5) * 2 * lean, t.rot,
    (hash2(hx, hz, 821) - 0.5) * 2 * lean, 'YXZ');
  quaternion.setFromEuler(euler);
  position.set(t.x, t.y, t.z);
  const sc = far ? IMP_SCALE[v] : [1, 1, 1];
  scale.set(t.s * sc[0] * (0.92 + hash2(hx, hz, 823) * 0.16),
    t.s * sc[1] * (t.shrub ? 0.47 : 0.94 + hash2(hx, hz, 827) * 0.12),
    t.s * sc[2] * (0.94 + hash2(hx, hz, 829) * 0.12));
  matrix.compose(position, quaternion, scale);
}

/** Muted warm / cool variation in linear RGB, independent of size and lean. */
function tintOf(t: TreeInstance, out: THREE.Color) {
  const hx = Math.floor(t.x * 64), hz = Math.floor(t.z * 64);
  const brightness = 0.84 + clamp01(t.tint) * 0.28;
  const warm = (hash2(hx, hz, 839) - 0.5) * 2;
  out.setRGB(brightness * (1 + warm * 0.055), brightness, brightness * (1 - warm * 0.045));
}

export function nearTreeData(list: TreeInstance[], variants: number): { m: Float32Array[]; c: Float32Array[] } {
  const counts = new Array<number>(variants).fill(0);
  for (const t of list) counts[variantOf(t, variants)]++;
  const m = counts.map((n) => new Float32Array(n * 16)), c = counts.map((n) => new Float32Array(n * 3));
  const offsets = counts.map(() => 0);
  for (const t of list) {
    const v = variantOf(t, variants), i = offsets[v]++;
    transformOf(t, false); matrix.toArray(m[v], i * 16);
    tintOf(t, color); color.toArray(c[v], i * 3);
  }
  return { m, c };
}

/** Area-weighted foliage colour, excluding bark. Cache by geometry, never by variant id across worlds. */
const foliageAverages = new WeakMap<THREE.BufferGeometry, THREE.Color>();
function foliageColour(g: THREE.BufferGeometry): THREE.Color {
  const cached = foliageAverages.get(g);
  if (cached) return cached;
  const p = g.getAttribute('position'), c = g.getAttribute('color'), flags = g.getAttribute('aTreeSurface');
  const index = g.index!;
  let red = 0, green = 0, blue = 0, area = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), d = index.getX(i + 2);
    if (flags.getX(a) < 0.5 || flags.getX(b) < 0.5 || flags.getX(d) < 0.5) continue;
    const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
    const vx = p.getX(d) - p.getX(a), vy = p.getY(d) - p.getY(a), vz = p.getZ(d) - p.getZ(a);
    const weight = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    red += (c.getX(a) + c.getX(b) + c.getX(d)) / 3 * weight;
    green += (c.getY(a) + c.getY(b) + c.getY(d)) / 3 * weight;
    blue += (c.getZ(a) + c.getZ(b) + c.getZ(d)) / 3 * weight;
    area += weight;
  }
  const average = new THREE.Color(red / (area || 1), green / (area || 1), blue / (area || 1));
  foliageAverages.set(g, average);
  return average;
}

/** Far instance colour compensates for the shape's own AO, keeping the near/far palette consistent. */
export function impostorData(list: TreeInstance[], geos: THREE.BufferGeometry[], imps: THREE.BufferGeometry[]):
  { m: Float32Array[]; c: Float32Array[] } {
  const counts = new Array<number>(IMPOSTOR_KINDS).fill(0);
  for (const t of list) counts[impostorKind(variantOf(t, geos.length))]++;
  const m = counts.map((n) => new Float32Array(n * 16)), c = counts.map((n) => new Float32Array(n * 3));
  const offsets = counts.map(() => 0);
  for (const t of list) {
    const v = variantOf(t, geos.length), kind = impostorKind(v), i = offsets[kind]++;
    transformOf(t, true); matrix.toArray(m[kind], i * 16);
    tintOf(t, color);
    const crown = foliageColour(geos[v]), shade = foliageColour(imps[kind]);
    c[kind][i * 3] = crown.r * color.r / shade.r;
    c[kind][i * 3 + 1] = crown.g * color.g / shade.g;
    c[kind][i * 3 + 2] = crown.b * color.b / shade.b;
  }
  return { m, c };
}

/**
 * Own tree materials, shared across every region. Inherit the caller's wind, uTreeDist, clouds and
 * shadow-fade hooks / uniform references. No textures, DOM/canvas dependency, or extra draw passes.
 */
const treeMaterials = new WeakMap<THREE.Material, (THREE.MeshStandardMaterial | undefined)[]>();
function treeMaterial(source: THREE.Material, far: boolean): THREE.MeshStandardMaterial {
  let cache = treeMaterials.get(source);
  if (!cache) { cache = []; treeMaterials.set(source, cache); }
  const kind = far ? 1 : 0;
  if (cache[kind]) return cache[kind]!;
  const material = (source as THREE.MeshStandardMaterial).isMeshStandardMaterial
    ? (source as THREE.MeshStandardMaterial).clone() : new THREE.MeshStandardMaterial();
  material.name = far ? 'railfever-tree-far' : 'railfever-tree-near';
  material.vertexColors = true; material.flatShading = false;
  material.roughness = 0.96; material.metalness = 0;
  const inherited = source.onBeforeCompile.bind(source), inheritedKey = source.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    inherited(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute vec2 aTreeSurface;',
        'varying vec2 vRfTreeSurface; varying vec3 vRfTreeLocal; varying vec3 vRfTreeTint;',
      ].join('\n'))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vRfTreeSurface = aTreeSurface; vRfTreeLocal = position; vRfTreeTint = vec3(1.0);',
        '#ifdef USE_INSTANCING_COLOR',
        'vRfTreeTint = instanceColor;',
        '#endif',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec2 vRfTreeSurface; varying vec3 vRfTreeLocal; varying vec3 vRfTreeTint;',
      ].join('\n'))
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        // Bark keeps its own brown / pale albedo instead of being multiplied by green far-crown tint.
        'diffuseColor.rgb /= mix(max(vRfTreeTint, vec3(0.001)), vec3(1.0), vRfTreeSurface.x);',
        ...(far ? [] : [
          'float rfDetail = 1.0 - smoothstep(0.025, 0.12, length(fwidth(vRfTreeLocal)));',
          'float rfFleck = sin(vRfTreeLocal.x * 61.0 + sin(vRfTreeLocal.y * 43.0)) * sin(vRfTreeLocal.z * 57.0 - vRfTreeLocal.y * 37.0);',
          'diffuseColor.rgb *= 1.0 + rfFleck * 0.035 * rfDetail * vRfTreeSurface.x;',
          // Broken horizontal birch marks, fading before their frequency can alias in distant views.
          'float rfBand = 0.5 + 0.5 * sin(vRfTreeLocal.y * 83.0 + sin(vRfTreeLocal.x * 147.0 + vRfTreeLocal.z * 113.0) * 1.4);',
          'float rfBreak = smoothstep(0.1, 0.65, sin(vRfTreeLocal.x * 89.0 - vRfTreeLocal.z * 117.0));',
          'float rfBark = smoothstep(0.86, 0.97, rfBand) * rfBreak * rfDetail * vRfTreeSurface.y;',
          'diffuseColor.rgb *= 1.0 - rfBark * 0.48;',
        ]),
      ].join('\n'));
  };
  material.customProgramCacheKey = () => inheritedKey + '|organic-trees-v1-' + kind;
  cache[kind] = material;
  return material;
}

function treeMesh(geo: THREE.BufferGeometry, source: THREE.Material, capacity: number, far: boolean): THREE.InstancedMesh {
  const count = Math.max(1, capacity), mesh = new THREE.InstancedMesh(geo, treeMaterial(source, far), count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.count = 0; mesh.castShadow = !far; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Existing mesh factories and distance-based LOD interface are unchanged. */
export function makeTreeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  return treeMesh(geo, mat, capacity, false);
}
export function makeImpostorMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  return treeMesh(geo, mat, capacity, true);
}
