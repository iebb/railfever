// Procedural terrain (continuous heights, 1 unit = 10 m) and vegetation.
import { World, pointInRect } from './world';
import { RNG, Simplex2 } from './rng';
import { WATER_Y } from './constants';

export type Hilliness = 'flat' | 'hilly' | 'mountainous';
export type WaterAmount = 'low' | 'medium' | 'high';

export interface TerrainOptions { seed: number; hilliness: Hilliness; water: WaterAmount }

export function generateHeights(world: World, opt: TerrainOptions) {
  const s = world.size;
  const s1 = s + 1;
  const n1 = new Simplex2(opt.seed);
  const n2 = new Simplex2(opt.seed * 7 + 13);
  const n3 = new Simplex2(opt.seed * 31 + 5);
  const n4 = new Simplex2(opt.seed * 53 + 17);
  const n5 = new Simplex2(opt.seed * 97 + 29);
  const amp = opt.hilliness === 'flat' ? { hill: 2.5, mtn: 4, base: 2 } : opt.hilliness === 'hilly' ? { hill: 6, mtn: 16, base: 3.5 } : { hill: 9, mtn: 36, base: 5 };
  const seaBias = opt.water === 'low' ? 5 : opt.water === 'medium' ? 3 : 1.2;
  // the large features grow with the map: seas and lakes (continents), and mountain ranges (where the
  // ridges rise) are larger on big maps, hills and single mountains keep their natural size
  const big = Math.sqrt(Math.max(1, s / 384));
  const contF = 1 / Math.max(220, s * 0.6);
  const hillF = 1 / 75;
  const mtnF = 1 / 140, maskF = (mtnF * 0.55) / big;
  // the slowly varying layers on a coarse grid (C units), interpolated: continents, mountain ranges and a
  // gentle domain warp of the hills (no regular noise pattern)
  const C = 4, cn = Math.ceil(s / C) + 1;
  const cont = new Float32Array(cn * cn), mask = new Float32Array(cn * cn), wx = new Float32Array(cn * cn), wz = new Float32Array(cn * cn);
  for (let cz = 0; cz < cn; cz++) for (let cx = 0; cx < cn; cx++) {
    const x = cx * C, z = cz * C, k = cz * cn + cx;
    cont[k] = n1.fbm(x * contF + 11.3, z * contF - 7.1, 3);
    mask[k] = smooth(0.05, 0.55, n3.fbm(x * maskF + 40, z * maskF - 30, 2));
    wx[k] = n5.fbm(x / 170, z / 170, 2) * 12;
    wz[k] = n5.fbm(x / 170 + 51.7, z / 170 - 73.1, 2) * 12;
  }
  for (let z = 0; z <= s; z++) {
    const fz = z / C, iz = Math.min(cn - 2, Math.floor(fz)), tz = fz - iz;
    for (let x = 0; x <= s; x++) {
      const fx = x / C, ix = Math.min(cn - 2, Math.floor(fx)), tx = fx - ix;
      const k = iz * cn + ix;
      const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
      const k1 = k + 1, k2 = k + cn, k3 = k + cn + 1;
      const c = cont[k] * w00 + cont[k1] * w10 + cont[k2] * w01 + cont[k3] * w11;
      const m = mask[k] * w00 + mask[k1] * w10 + mask[k2] * w01 + mask[k3] * w11;
      const ux = x + wx[k] * w00 + wx[k1] * w10 + wx[k2] * w01 + wx[k3] * w11;
      const uz = z + wz[k] * w00 + wz[k1] * w10 + wz[k2] * w01 + wz[k3] * w11;
      // (the finest hill octave is left to the detail layer)
      const hills = n2.fbm(ux * hillF, uz * hillF, 4, 2.0, 0.5);
      const ridge = m > 0.001 ? n3.ridged(ux * mtnF, uz * mtnF, 5) * m : 0;
      const detail = n4.fbm(x / 18, z / 18, 3) * 0.6;
      const ex = Math.min(x, s - x) / s, ez = Math.min(z, s - z) / s;
      const edge = smooth(0, 0.1, Math.min(ex, ez));
      let h = seaBias + c * amp.base * 2.2 + hills * amp.hill + ridge * amp.mtn + detail - (1 - edge) * 4;
      // gentle valley floors: compress low land a bit
      if (h > 0 && h < 4) h = h * 0.85;
      world.h[z * s1 + x] = h;
    }
  }
  // limit extreme slopes (keeps cliffs plausible)
  const maxStep = opt.hilliness === 'mountainous' ? 3.2 : opt.hilliness === 'hilly' ? 1.8 : 0.8;
  for (let it = 0; it < 2; it++) {
    for (let pass = 0; pass < 2; pass++) {
      for (let zz = 0; zz <= s; zz++) {
        const z = pass ? s - zz : zz;
        for (let xx = 0; xx <= s; xx++) {
          const x = pass ? s - xx : xx;
          const i = z * s1 + x;
          let m = world.h[i];
          if (x > 0) m = Math.min(m, world.h[i - 1] + maxStep);
          if (x < s) m = Math.min(m, world.h[i + 1] + maxStep);
          if (z > 0) m = Math.min(m, world.h[i - s1] + maxStep);
          if (z < s) m = Math.min(m, world.h[i + s1] + maxStep);
          world.h[i] = m;
        }
      }
    }
  }
  world.heightsVersion++;
}

/** Scatter trees in forests and some solitary ones. */
export function generateTrees(world: World, seed: number) {
  const s = world.size;
  const rng = new RNG(seed * 3 + 1);
  const noise = new Simplex2(seed * 17 + 3);
  const cell = 1.6;
  for (let gz = 0; gz < s; gz += cell) {
    for (let gx = 0; gx < s; gx += cell) {
      const f = noise.fbm(gx / 55, gz / 55, 4) + 0.18 * noise.noise(gx / 9, gz / 9);
      let p = 0;
      if (f > 0.1) p = Math.min(0.95, (f - 0.1) * 3.2);
      else p = 0.02;
      if (rng.next() > p) continue;
      const x = gx + rng.next() * cell, z = gz + rng.next() * cell;
      const h = world.heightAt(x, z);
      if (h < WATER_Y + 0.3) continue;
      const slope = world.slopeAt(x, z);
      if (slope > 1.2) continue;
      // keep roads, railways and building lots clear; town gardens only get the odd tree
      if (world.net.nearestEdge(x, z, 1.0)) continue;
      let blocked = false, near = 0;
      for (const b of world.buildingsNear(x, z, 4)) {
        if (pointInRect(x, z, b.x, b.z, b.angle, b.w / 2 + 0.35, b.d / 2 + 0.35)) { blocked = true; break; }
        near++;
      }
      if (blocked || (near > 1 && rng.next() > 0.25)) continue;
      const alt = h / 25;
      const conifer = rng.next() < 0.25 + alt * 1.1 + noise.noise(x / 60 + 100, z / 60) * 0.3;
      world.addTree({ x, z, s: 0.75 + rng.next() * 0.65, type: conifer ? 1 : 0, tint: rng.next() });
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
