// Instanced trees, 1 unit = 10 m. Five near species and four-triangle crossed cards in two far buckets.
// Shrubs reuse the broadleaf bucket with squat transforms: no extra materials, groups or draw calls.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { hash2 } from '../game/rng';
import { WATER_Y } from '../game/constants';
import { pointInRect } from '../game/world';
import type { World } from '../game/world';
import { applyClouds } from './clouds';

/** Variant ids: 0 oak/beech, 1 birch, 2 poplar, 3 spruce, 4 pine. */
export const TREE_VARIANTS = 5;
export const IMPOSTOR_KINDS = 2;
/** Half-width of the near/card dither band; also used by CPU bucket selection. */
export const TREE_FADE = 10;
/** Shared main-camera position, including the near trees' shadow-material LOD selection. */
export const treeCameraUniform = { value: new THREE.Vector3() };
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Nested hash subsets: half beyond 400, quarter beyond 840, eighth in extreme whole-map views. */
export function treeDensity(distance: number) {
  return 1 - 0.5 * smooth(320, 400, distance) - 0.25 * smooth(720, 840, distance) - 0.125 * smooth(1100, 1320, distance);
}
const ATLAS_COLS = 8, TILE_W = 128, TILE_H = 256, PAD = 4;

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

/** Two double-sided cards; species and the two orthogonal views come from a shared startup atlas. */
let startupAtlas: ReturnType<typeof createTreeAtlas> | undefined;
export function createImpostorGeometries(near?: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  if (!startupAtlas) {
    const models = near ?? createTreeGeometries(); startupAtlas = createTreeAtlas(models);
    if (!near) models.forEach((g) => g.dispose());
  }
  return ['broadleaf-far', 'conifer-far'].map((name) => {
    const b = new GeoBuilder(true), half = 0.5 * TILE_W / (TILE_W - 2 * PAD);
    const bottom = -PAD / (TILE_H - 2 * PAD), top = 1 - bottom;
    for (let view = 0; view < 2; view++) {
      const base = b.vertexCount;
      for (const [x, y, u, v] of [[-half, bottom, 0, 0], [half, bottom, 1, 0], [half, top, 1, 1], [-half, top, 0, 1]]) {
        surface(b, 1); b.attr('aTreeView', 1, view);
        b.vertex(view ? 0 : x, y, view ? -x : 0, view, 0, 1 - view, u, v);
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = b.build(); g.name = name; g.userData.treeAtlas = startupAtlas; return g;
  });
}

const profiles = new WeakMap<THREE.BufferGeometry, { width: number; height: number }>();
function profile(g: THREE.BufferGeometry) {
  let p = profiles.get(g);
  if (!p) {
    g.computeBoundingBox(); const b = g.boundingBox!;
    p = { width: 2 * Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z)), height: b.max.y };
    profiles.set(g, p);
  }
  return p;
}

/** CPU orthographic rasterization of the near models: no DOM, extra renderer, or GPU readback. */
export function createTreeAtlas(geos: THREE.BufferGeometry[]): { color: THREE.DataTexture; normal: THREE.DataTexture } {
  const width = ATLAS_COLS * TILE_W, height = 2 * TILE_H;
  const rgba = new Uint8Array(width * height * 4), normals = new Uint8Array(rgba.length);
  const encode = (v: number) => Math.round(clamp01(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  for (let species = 0; species < geos.length; species++) {
    const g = geos[species], p = g.getAttribute('position'), c = g.getAttribute('color');
    const n = g.getAttribute('normal'), flags = g.getAttribute('aTreeSurface'), ix = g.index!, bounds = profile(g);
    for (let view = 0; view < 2; view++) {
      const depth = new Float32Array(TILE_W * TILE_H).fill(-Infinity);
      for (let tri = 0; tri < ix.count; tri += 3) {
        const ids = [ix.getX(tri), ix.getX(tri + 1), ix.getX(tri + 2)];
        const x = ids.map((i) => PAD + (0.5 + (view ? -p.getZ(i) : p.getX(i)) / bounds.width) * (TILE_W - 2 * PAD));
        const y = ids.map((i) => PAD + p.getY(i) / bounds.height * (TILE_H - 2 * PAD));
        const z = ids.map((i) => view ? p.getX(i) : p.getZ(i));
        const area = (x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0]);
        if (Math.abs(area) < 1e-8) continue;
        for (let py = Math.max(PAD, Math.floor(Math.min(...y))); py < Math.min(TILE_H - PAD, Math.ceil(Math.max(...y))); py++) {
          for (let px = Math.max(PAD, Math.floor(Math.min(...x))); px < Math.min(TILE_W - PAD, Math.ceil(Math.max(...x))); px++) {
            const a = ((x[1] - px - 0.5) * (y[2] - py - 0.5) - (y[1] - py - 0.5) * (x[2] - px - 0.5)) / area;
            const b = ((x[2] - px - 0.5) * (y[0] - py - 0.5) - (y[2] - py - 0.5) * (x[0] - px - 0.5)) / area, d = 1 - a - b;
            if (a < 0 || b < 0 || d < 0) continue;
            const zi = a * z[0] + b * z[1] + d * z[2], local = py * TILE_W + px;
            if (zi < depth[local]) continue;
            depth[local] = zi;
            const weights = [a, b, d], target = ((view * TILE_H + py) * width + species * TILE_W + px) * 4;
            const mix = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, channel: number) =>
              ids.reduce((sum, id, k) => sum + attr.getComponent(id, channel) * weights[k], 0);
            // Normals are expressed in the card's normalized coordinates; the instance undoes this scale.
            const nn = [mix(n, 0) * bounds.width, mix(n, 1) * bounds.height, mix(n, 2) * bounds.width];
            const length = Math.hypot(...nn) || 1;
            for (let k = 0; k < 3; k++) { rgba[target + k] = encode(mix(c, k)); normals[target + k] = Math.round((nn[k] / length * 0.5 + 0.5) * 255); }
            rgba[target + 3] = 255; normals[target + 3] = Math.round(clamp01(mix(flags, 0)) * 255);
          }
        }
      }
      // Dilate RGB/normal into transparent texels: bilinear/mipmap edges stay green instead of black.
      for (let pass = 0; pass < PAD; pass++) {
        const old = normals.slice();
        for (let py = 0; py < TILE_H; py++) for (let px = 0; px < TILE_W; px++) {
          const i = ((view * TILE_H + py) * width + species * TILE_W + px) * 4;
          if (old[i] || old[i + 1] || old[i + 2]) continue;
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || nx >= TILE_W || ny < 0 || ny >= TILE_H) continue;
            const j = i + (dy * width + dx) * 4;
            if (!old[j] && !old[j + 1] && !old[j + 2]) continue;
            rgba.set(rgba.subarray(j, j + 3), i); normals.set(old.subarray(j, j + 4), i); break;
          }
        }
      }
    }
  }
  const texture = (data: Uint8Array<ArrayBuffer>, srgb: boolean) => {
    const t = new THREE.DataTexture(data, width, height);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true; return t;
  };
  return { color: texture(rgba, true), normal: texture(normals, false) };
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

function variantOf(t: TreeInstance, variants = TREE_VARIANTS) {
  return Number.isInteger(t.type) && t.type >= 0 && t.type < variants ? t.type : 0;
}

/** Same anchored lean and independent aspect variation in both LODs (not correlated with brightness). */
function transformOf(t: TreeInstance, far: boolean, bounds?: { width: number; height: number }) {
  const hx = Math.floor(t.x * 64), hz = Math.floor(t.z * 64), v = variantOf(t);
  const lean = t.shrub ? 0.022 : v === 2 ? 0.026 : 0.045;
  euler.set((hash2(hx, hz, 811) - 0.5) * 2 * lean, t.rot,
    (hash2(hx, hz, 821) - 0.5) * 2 * lean, 'YXZ');
  quaternion.setFromEuler(euler);
  position.set(t.x, t.y, t.z);
  const sc = far ? [bounds!.width, bounds!.height, bounds!.width] : [1, 1, 1];
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

/** Species atlas selection stays per instance, retaining the existing two far draw buckets. */
export function impostorData(list: TreeInstance[], geos: THREE.BufferGeometry[], _imps: THREE.BufferGeometry[]):
  { m: Float32Array[]; c: Float32Array[]; v: Float32Array[]; rank: Float32Array[] } {
  const counts = new Array<number>(IMPOSTOR_KINDS).fill(0);
  for (const t of list) counts[impostorKind(variantOf(t, geos.length))]++;
  const m = counts.map((n) => new Float32Array(n * 16)), c = counts.map((n) => new Float32Array(n * 3));
  const v = counts.map((n) => new Float32Array(n)), rank = counts.map((n) => new Float32Array(n)), offsets = counts.map(() => 0);
  for (const t of list) {
    const species = variantOf(t, geos.length), kind = impostorKind(species), i = offsets[kind]++;
    transformOf(t, true, profile(geos[species])); matrix.toArray(m[kind], i * 16);
    tintOf(t, color); color.toArray(c[kind], i * 3); v[kind][i] = species;
    rank[kind][i] = hash2(Math.floor(t.x * 64), Math.floor(t.z * 64), 853);
  }
  return { m, c, v, rank };
}

/** Complementary, opaque dithering preserves depth/shadows and needs no extra passes. */
function treeLod(shader: THREE.WebGLProgramParametersWithUniforms, far: boolean) {
  shader.uniforms.uRfTreeCamera = treeCameraUniform;
  if (!shader.uniforms.uTreeDist) shader.uniforms.uTreeDist = { value: 80 };
  if (!shader.vertexShader.includes('uniform float uTreeDist;'))
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTreeDist;');
  // Expand the inherited hard split to the two ends of the dither band.
  shader.vertexShader = shader.vertexShader
    .replace('> uTreeDist)', `> (uTreeDist + ${TREE_FADE.toFixed(1)}))`)
    .replace('< uTreeDist)', `< (uTreeDist - ${TREE_FADE.toFixed(1)}))`)
    .replaceAll('distance(cameraPosition,', 'distance(uRfTreeCamera,')
    .replace('#include <common>', '#include <common>\nuniform vec3 uRfTreeCamera; varying float vRfTreeFade;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
float rfDistance = distance(uRfTreeCamera, (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz);
vRfTreeFade = smoothstep(uTreeDist - ${TREE_FADE.toFixed(1)}, uTreeDist + ${TREE_FADE.toFixed(1)}, rfDistance);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vRfTreeFade;')
    .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
float rfDither = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
if (rfDither ${far ? '>=' : '<'} vRfTreeFade) discard;`);
}

/**
 * Own tree materials, shared across every region. Inherit the caller's wind, uTreeDist, clouds and
 * shadow-fade hooks / uniform references. The far atlas adds no draw passes or DOM dependency.
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
  if (far) { material.map = startupAtlas!.color; material.alphaTest = 0.4; material.side = THREE.DoubleSide; }
  const inherited = source.onBeforeCompile.bind(source), inheritedKey = source.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    inherited(shader, renderer);
    treeLod(shader, far);
    if (far) {
      shader.uniforms.uRfTreeNormal = { value: startupAtlas!.normal };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTreeVariant; attribute float aTreeRank; attribute float aTreeView; varying mat3 vRfTreeNormalMatrix; varying float vRfTreeKeep; varying float vRfTreeView;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vMapUv = vec2((aTreeVariant + uv.x) / ${ATLAS_COLS.toFixed(1)}, (aTreeView + uv.y) / 2.0);
vRfTreeView = aTreeView;
float rfDist = distance(uRfTreeCamera, (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz);
float rfDensity = 1.0 - 0.5 * smoothstep(320.0, 400.0, rfDist) - 0.25 * smoothstep(720.0, 840.0, rfDist) - 0.125 * smoothstep(1100.0, 1320.0, rfDist);
vRfTreeKeep = rfDensity >= 1.0 ? 1.0 : clamp((rfDensity - aTreeRank) / 0.03 + 0.5, 0.0, 1.0);
mat3 rfIm = mat3(instanceMatrix);
rfIm[0] /= dot(rfIm[0], rfIm[0]); rfIm[1] /= dot(rfIm[1], rfIm[1]); rfIm[2] /= dot(rfIm[2], rfIm[2]);
vRfTreeNormalMatrix = normalMatrix * rfIm;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uRfTreeNormal; varying mat3 vRfTreeNormalMatrix; varying float vRfTreeKeep; varying float vRfTreeView;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 rfTreeNormal = texture2D(uRfTreeNormal, vMapUv);')
        .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy) + 17.0, vec2(0.06711056, 0.00583715)))) >= vRfTreeKeep) discard;')
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
vec3 rfAtlasNormal = rfTreeNormal.xyz * 2.0 - 1.0;
if (!gl_FrontFacing) rfAtlasNormal *= mix(vec3(1.0, 1.0, -1.0), vec3(-1.0, 1.0, 1.0), vRfTreeView);
normal = normalize(vRfTreeNormalMatrix * rfAtlasNormal);`);
    }
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
        `diffuseColor.rgb /= mix(max(vRfTreeTint, vec3(0.001)), vec3(1.0), ${far ? 'rfTreeNormal.a' : 'vRfTreeSurface.x'});`,
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
  material.customProgramCacheKey = () => inheritedKey + '|organic-trees-v2-' + kind;
  if (far) applyClouds(material);
  cache[kind] = material;
  return material;
}

function treeMesh(geo: THREE.BufferGeometry, source: THREE.Material, capacity: number, far: boolean): THREE.InstancedMesh {
  const count = Math.max(1, capacity), instanceGeo = far ? geo.clone() : geo;
  if (far) {
    instanceGeo.setAttribute('aTreeVariant', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
    instanceGeo.setAttribute('aTreeRank', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  }
  const mesh = new THREE.InstancedMesh(instanceGeo, treeMaterial(source, far), count);
  if (far) mesh.addEventListener('dispose', () => instanceGeo.dispose());
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.count = 0; mesh.castShadow = !far; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  if (!far) mesh.customDepthMaterial = treeDepthMaterial(source);
  return mesh;
}

const treeDepthMaterials = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>();
function treeDepthMaterial(source: THREE.Material) {
  let mat = treeDepthMaterials.get(source);
  if (!mat) {
    mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.onBeforeCompile = (shader, renderer) => { source.onBeforeCompile(shader, renderer); treeLod(shader, false); };
    mat.customProgramCacheKey = () => source.customProgramCacheKey() + '|tree-depth-v2';
    treeDepthMaterials.set(source, mat);
  }
  return mat;
}

/** Existing mesh factories and distance-based LOD interface are unchanged. */
export function makeTreeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  return treeMesh(geo, mat, capacity, false);
}
export function makeImpostorMesh(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  return treeMesh(geo, mat, capacity, true);
}
