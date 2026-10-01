// Procedural terrain generation.
import { World } from './world';
import { RNG, Simplex2 } from './rng';

export type Hilliness = 'flat' | 'hilly' | 'mountainous';
export type WaterAmount = 'low' | 'medium' | 'high';

export interface TerrainOptions {
  seed: number;
  hilliness: Hilliness;
  water: WaterAmount;
}

/** Fill the world's corner heights. */
export function generateHeights(world: World, opt: TerrainOptions) {
  const s = world.size;
  const s1 = s + 1;
  const noise = new Simplex2(opt.seed);
  const noise2 = new Simplex2(opt.seed * 7 + 13);
  const noise3 = new Simplex2(opt.seed * 31 + 5);
  const amp = opt.hilliness === 'flat' ? { base: 3.5, mtn: 5 } : opt.hilliness === 'hilly' ? { base: 6.5, mtn: 18 } : { base: 9, mtn: 38 };
  const seaBias = opt.water === 'low' ? 4.5 : opt.water === 'medium' ? 2.6 : 0.8;
  const contF = 1 / Math.max(80, s * 0.55);
  const baseF = 1 / 42;
  const mtnF = 1 / 70;

  const H = new Float32Array(s1 * s1);
  const mask = new Float32Array(s1 * s1);
  for (let z = 0; z <= s; z++) {
    for (let x = 0; x <= s; x++) {
      const cont = noise.fbm(x * contF + 11.3, z * contF - 7.1, 3);
      const base = noise2.fbm(x * baseF, z * baseF, 5, 2.0, 0.5);
      const m = smooth(0.05, 0.55, noise3.fbm(x * mtnF * 0.6 + 40, z * mtnF * 0.6 - 30, 2));
      const ridge = noise3.ridged(x * mtnF, z * mtnF, 5);
      // slight lowering towards map edges so coasts appear at the borders sometimes
      const ex = Math.min(x, s - x) / s, ez = Math.min(z, s - z) / s;
      const edge = smooth(0.0, 0.12, Math.min(ex, ez));
      let h = seaBias + cont * 7 + base * amp.base + ridge * m * amp.mtn - (1 - edge) * 3;
      // terraces on lowland make flat building land more common
      if (h > 0.5 && h < 8) h = h * 0.75 + Math.round(h) * 0.25;
      H[z * s1 + x] = h;
      mask[z * s1 + x] = m;
    }
  }
  const L = world.hgt;
  for (let i = 0; i < L.length; i++) {
    let v = Math.round(H[i]);
    if (v < -3) v = -3;
    if (v > 60) v = 60;
    L[i] = v;
  }
  // Lipschitz constraint: neighbouring corners may differ by at most 1 (2-3 in mountains)
  const maxd = new Uint8Array(s1 * s1);
  for (let i = 0; i < maxd.length; i++) maxd[i] = 1 + Math.floor(mask[i] * (opt.hilliness === 'mountainous' ? 3.6 : opt.hilliness === 'hilly' ? 2.2 : 0));
  clampSlopes(L, s1, maxd);
}

export function clampSlopes(L: Int16Array, s1: number, maxd: Uint8Array | number) {
  const md = (i: number) => (typeof maxd === 'number' ? maxd : maxd[i]);
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const fwd = pass === 0;
      for (let zz = 0; zz < s1; zz++) {
        const z = fwd ? zz : s1 - 1 - zz;
        for (let xx = 0; xx < s1; xx++) {
          const x = fwd ? xx : s1 - 1 - xx;
          const i = z * s1 + x;
          let m = L[i];
          const d = md(i);
          if (x > 0) m = Math.min(m, L[i - 1] + d);
          if (x < s1 - 1) m = Math.min(m, L[i + 1] + d);
          if (z > 0) m = Math.min(m, L[i - s1] + d);
          if (z < s1 - 1) m = Math.min(m, L[i + s1] + d);
          if (m < L[i]) { L[i] = m; changed = true; }
        }
      }
    }
    if (!changed) break;
  }
}

/** Place forests and scattered trees. */
export function generateTrees(world: World, seed: number) {
  const s = world.size;
  const rng = new RNG(seed * 3 + 1);
  const noise = new Simplex2(seed * 17 + 3);
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const t = world.idx(x, z);
      if (!world.isEmpty(t) || world.townOf[t] >= 0) continue;
      const mn = world.tileMin(x, z);
      if (mn <= 0) continue;
      const f = noise.fbm(x / 28, z / 28, 4) + 0.15 * noise.noise(x / 6, z / 6);
      const hgt = world.tileMax(x, z);
      let count = 0;
      if (f > 0.12) count = 1 + Math.min(3, Math.floor((f - 0.12) * 12 + rng.next() * 1.5));
      else if (rng.chance(0.035)) count = 1;
      if (count > 0) {
        // conifers at altitude, deciduous lower, mixed between
        const alt = hgt / 25;
        const conifer = rng.next() < 0.25 + alt * 1.2 + noise.noise(x / 40 + 100, z / 40) * 0.3;
        const type = conifer ? 1 : 0;
        world.trees[t] = Math.min(4, count) | (type << 4);
      }
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
