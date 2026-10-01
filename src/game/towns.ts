// Towns: placement, road networks, buildings and growth.
import { World, SLOPE_FLAT } from './world';
import { RNG } from './rng';
import { DX, DZ, OPP } from './constants';
import { canLevelTile, levelTile } from './terraform';
import { clampSlopes } from './terrain-gen';
import { townName } from './names';

export const BT_HOUSE_S = 0, BT_HOUSE_L = 1, BT_TOWNHOUSE = 2, BT_SHOP = 3, BT_APARTMENT = 4,
  BT_OFFICE = 5, BT_TOWER = 6, BT_CHURCH = 7;

export interface BuildingType {
  name: string;
  floors: [number, number];
  popPerFloor: [number, number];
  rank: number;
}

export const BUILDING_TYPES: BuildingType[] = [
  { name: 'Cottage', floors: [1, 2], popPerFloor: [5, 7], rank: 0 },
  { name: 'House', floors: [2, 2], popPerFloor: [7, 10], rank: 1 },
  { name: 'Townhouse', floors: [3, 4], popPerFloor: [9, 12], rank: 2 },
  { name: 'Shops', floors: [1, 3], popPerFloor: [8, 12], rank: 2 },
  { name: 'Apartments', floors: [4, 7], popPerFloor: [14, 18], rank: 3 },
  { name: 'Offices', floors: [6, 11], popPerFloor: [18, 24], rank: 4 },
  { name: 'Tower', floors: [12, 22], popPerFloor: [20, 26], rank: 5 },
  { name: 'Church', floors: [1, 1], popPerFloor: [0, 0], rank: 9 },
];

export interface Town {
  id: number;
  name: string;
  x: number; z: number;
  block: number;
  pop: number;
  roads: number[];
  buildings: Set<number>;
  radius: number;
  nextGrowthDay: number;
  hasChurch: boolean;
  // statistics
  passGenMonth: number;
  passTransMonth: number;
  passGenLast: number;
  passTransLast: number;
  served: number;
}

export class Towns {
  list: Town[] = [];
  constructor(public world: World) {}

  get(id: number): Town { return this.list[id]; }

  /** Nearest town to a tile, weighted by size. */
  nearest(x: number, z: number): Town | null {
    let best: Town | null = null, bd = Infinity;
    for (const t of this.list) {
      const d = Math.hypot(t.x - x, t.z - z) / (1 + Math.sqrt(t.pop) / 60);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  recomputePop(town: Town) {
    let p = 0, r = 2;
    for (const id of town.buildings) {
      const b = this.world.buildings[id];
      if (!b) { town.buildings.delete(id); continue; }
      p += b.pop;
      r = Math.max(r, Math.hypot(b.x - town.x, b.z - town.z));
    }
    town.pop = p;
    town.radius = r;
  }

  // ---------------------------------------------------------------- generation
  generate(count: number, seed: number, cityFraction = 0.2) {
    const w = this.world;
    const rng = new RNG(seed * 13 + 77);
    const used = new Set<string>();
    const s = w.size;
    const minDist = Math.max(12, Math.sqrt((s * s) / count) * 0.62);
    const sites: { x: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      let best: { x: number; z: number; score: number } | null = null;
      for (let tries = 0; tries < 300; tries++) {
        const x = 8 + rng.int(s - 16), z = 8 + rng.int(s - 16);
        if (w.tileMin(x, z) < 1) continue;
        let tooClose = false;
        for (const o of sites) if (Math.hypot(o.x - x, o.z - z) < minDist) { tooClose = true; break; }
        if (tooClose) continue;
        // roughness and land area around
        let mn = 999, mx = -999, water = 0;
        for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
          const xx = x + dx, zz = z + dz;
          if (!w.inBounds(xx, zz)) continue;
          const h = w.cornerH(xx, zz);
          if (h <= 0) water++;
          mn = Math.min(mn, h); mx = Math.max(mx, h);
        }
        const score = -(mx - mn) * 2 - water * 0.5 + rng.next() * 3;
        if (!best || score > best.score) best = { x, z, score };
      }
      if (!best) break;
      sites.push(best);
    }
    // gently flatten town centres
    const s1 = s + 1;
    for (const site of sites) {
      const base = Math.max(1, w.cornerH(site.x, site.z));
      const R = 9;
      for (let dz = -R; dz <= R + 1; dz++) for (let dx = -R; dx <= R + 1; dx++) {
        const cx = site.x + dx, cz = site.z + dz;
        if (cx < 0 || cz < 0 || cx > s || cz > s) continue;
        const d = Math.hypot(dx, dz);
        const wgt = 1 - smoothstep(R * 0.45, R, d);
        if (wgt <= 0) continue;
        const i = cz * s1 + cx;
        const h = w.hgt[i];
        if (h <= 0 && d > 3) continue;
        w.hgt[i] = Math.round(h + (base - h) * wgt);
      }
    }
    // keep town areas gently sloped, leave mountains alone
    const maxd = new Uint8Array(s1 * s1).fill(8);
    for (const site of sites) {
      const R = 12;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const cx = site.x + dx, cz = site.z + dz;
        if (cx < 0 || cz < 0 || cx > s || cz > s || dx * dx + dz * dz > R * R) continue;
        maxd[cz * s1 + cx] = 1;
      }
    }
    clampSlopes(w.hgt, s1, maxd);
    w.heightsVersion++;

    sites.forEach((site, i) => {
      const isCity = i < Math.max(1, Math.round(count * cityFraction));
      const town: Town = {
        id: this.list.length, name: townName(rng, used), x: site.x, z: site.z,
        block: rng.chance(0.7) ? 3 : 4,
        pop: 0, roads: [], buildings: new Set(), radius: 2, nextGrowthDay: rng.int(30), hasChurch: false,
        passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0,
      };
      this.list.push(town);
      const target = isCity ? 1800 + rng.int(2500) : 150 + rng.int(900);
      this.seedTown(town, rng);
      let guard = 0;
      while (town.pop < target && guard++ < 4000) this.growStep(town, rng, 0);
    });
  }

  private seedTown(town: Town, rng: RNG) {
    const w = this.world;
    const t0 = w.idx(town.x, town.z);
    // centre tile must be flat
    const c = w.corners(town.x, town.z);
    if (World.slopeOf(c) !== SLOPE_FLAT) {
      const lvl = Math.max(1, Math.round((c[0] + c[1] + c[2] + c[3]) / 4));
      if (canLevelTile(w, town.x, town.z, lvl)) levelTile(w, town.x, town.z, lvl);
    }
    if (World.slopeOf(w.corners(town.x, town.z)) !== SLOPE_FLAT) return;
    w.road[t0] = 0;
    w.roadOwner[t0] = 1;
    w.townOf[t0] = town.id;
    w.trees[t0] = 0;
    town.roads.push(t0);
    w.markTile(town.x, town.z);
    for (let d = 0; d < 4; d++) {
      let x = town.x, z = town.z;
      for (let k = 0; k < town.block * 2; k++) {
        if (!this.extendRoad(town, x, z, d)) break;
        x += DX[d]; z += DZ[d];
      }
    }
  }

  private onGrid(town: Town, x: number, z: number): { v: boolean; h: boolean } {
    const b = town.block;
    return { v: mod(x - town.x, b) === 0, h: mod(z - town.z, b) === 0 };
  }

  /** Extend a town road from tile (x,z) in direction d. */
  extendRoad(town: Town, x: number, z: number, d: number): boolean {
    const w = this.world;
    const nx = x + DX[d], nz = z + DZ[d];
    if (!w.inBounds(nx, nz) || nx < 2 || nz < 2 || nx >= w.size - 2 || nz >= w.size - 2) return false;
    const t = w.idx(x, z), n = w.idx(nx, nz);
    if (w.road[t] & (1 << d)) return false;
    if (w.station[t] >= 0 || w.rail[t]) return false; // never turn stops or crossings into junctions
    const g = this.onGrid(town, x, z);
    if ((d === 1 || d === 3) && !g.h) return false;
    if ((d === 0 || d === 2) && !g.v) return false;
    if (w.rail[n] || w.building[n] >= 0 || w.station[n] >= 0 || w.depot[n] >= 0 || w.span[n] >= 0) return false;
    if (w.townOf[n] >= 0 && w.townOf[n] !== town.id && w.road[n]) return false;
    if (w.tileMin(nx, nz) <= 0) return false;
    if (Math.hypot(nx - town.x, nz - town.z) > 5 + Math.sqrt(town.pop) / 2.8) return false;
    if (!World.shapeSupports(w.corners(x, z), w.road[t] | (1 << d))) return false;
    const need = w.road[n] | (1 << OPP[d]);
    if (!World.shapeSupports(w.corners(nx, nz), need)) {
      const lvl = w.edgeLevel(x, z, d);
      if (isNaN(lvl) || lvl <= 0) return false;
      if (!canLevelTile(w, nx, nz, lvl)) return false;
      levelTile(w, nx, nz, lvl);
    }
    w.road[t] |= 1 << d;
    const wasRoad = w.road[n] !== 0;
    w.road[n] |= 1 << OPP[d];
    w.roadOwner[n] = w.roadOwner[n] || 1;
    w.trees[n] = 0;
    if (!wasRoad) { w.townOf[n] = town.id; town.roads.push(n); }
    w.markTile(x, z); w.markTile(nx, nz);
    // connect onwards to aligned neighbouring roads, closing grid loops
    const gn = this.onGrid(town, nx, nz);
    for (let d2 = 0; d2 < 4; d2++) {
      if (d2 === OPP[d]) continue;
      if ((d2 === 1 || d2 === 3) && !gn.h) continue;
      if ((d2 === 0 || d2 === 2) && !gn.v) continue;
      const mx = nx + DX[d2], mz = nz + DZ[d2];
      if (!w.inBounds(mx, mz)) continue;
      const m = w.idx(mx, mz);
      if (!w.road[m] || w.rail[m] || w.station[m] >= 0) continue;
      if (!World.shapeSupports(w.corners(nx, nz), w.road[n] | (1 << d2))) continue;
      if (!World.shapeSupports(w.corners(mx, mz), w.road[m] | (1 << OPP[d2]))) continue;
      w.road[n] |= 1 << d2;
      w.road[m] |= 1 << OPP[d2];
      w.markTile(mx, mz);
    }
    return true;
  }

  /** Desired building type for a location in a town. */
  private chooseType(town: Town, x: number, z: number, rng: RNG): number {
    const d = Math.hypot(x - town.x, z - town.z);
    const P = town.pop;
    const r = rng.next();
    if (P > 2600 && d < 2.5 + P / 2500) return r < 0.4 ? BT_TOWER : r < 0.85 ? BT_OFFICE : BT_APARTMENT;
    if (P > 1200 && d < 3 + P / 1100) return r < 0.5 ? BT_APARTMENT : r < 0.7 && P > 1800 ? BT_OFFICE : r < 0.85 ? BT_SHOP : BT_TOWNHOUSE;
    if (P > 350 && d < 2.5 + P / 500) return r < 0.4 ? BT_TOWNHOUSE : r < 0.65 ? BT_SHOP : r < 0.8 && P > 700 ? BT_APARTMENT : BT_HOUSE_L;
    return r < 0.55 ? BT_HOUSE_S : BT_HOUSE_L;
  }

  private placeBuilding(town: Town, x: number, z: number, type: number, rng: RNG, day: number, face: number) {
    const bt = BUILDING_TYPES[type];
    const floors = bt.floors[0] + rng.int(bt.floors[1] - bt.floors[0] + 1);
    const ppf = bt.popPerFloor[0] + rng.next() * (bt.popPerFloor[1] - bt.popPerFloor[0]);
    const b = this.world.addBuilding({
      townId: town.id, x, z, type, floors, pop: Math.round(floors * ppf), seed: rng.int(1 << 30), face, built: day,
    });
    town.buildings.add(b.id);
    town.pop += b.pop;
    town.radius = Math.max(town.radius, Math.hypot(x - town.x, z - town.z));
  }

  private canBuildAt(town: Town, x: number, z: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, z) || x < 1 || z < 1 || x >= w.size - 1 || z >= w.size - 1) return false;
    const t = w.idx(x, z);
    if (!w.isEmpty(t) || w.span[t] >= 0) return false;
    const g = this.onGrid(town, x, z);
    if (g.v || g.h) return false;
    const c = w.corners(x, z);
    const mn = Math.min(c[0], c[1], c[2], c[3]), mx = Math.max(c[0], c[1], c[2], c[3]);
    return mn > 0 && mx - mn <= 1;
  }

  /** One growth step: new building, building upgrade, or road extension. */
  growStep(town: Town, rng: RNG, day: number): boolean {
    const w = this.world;
    if (town.roads.length === 0) return false;
    // upgrade an existing building near the centre now and then
    if (town.buildings.size > 12 && rng.chance(0.18)) {
      const ids = [...town.buildings];
      for (let k = 0; k < 4; k++) {
        const b = w.buildings[ids[rng.int(ids.length)]];
        if (!b || b.type === BT_CHURCH) continue;
        const nt = this.chooseType(town, b.x, b.z, rng);
        if (BUILDING_TYPES[nt].rank > BUILDING_TYPES[b.type].rank) {
          town.buildings.delete(b.id);
          town.pop -= b.pop;
          w.removeBuilding(b.id);
          this.placeBuilding(town, b.x, b.z, nt, rng, day, b.face);
          return true;
        }
      }
    }
    // church once the town is established
    const wantChurch = !town.hasChurch && town.pop > 450;
    // new building next to a road, biased towards the centre
    for (let attempt = 0; attempt < 14; attempt++) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < 3; k++) {
        const r = town.roads[rng.int(town.roads.length)];
        const d = Math.hypot(w.tx(r) - town.x, w.tz(r) - town.z);
        if (d < bd) { bd = d; best = r; }
      }
      if (best < 0 || !w.road[best]) continue;
      const rx = w.tx(best), rz = w.tz(best);
      const d = rng.int(4);
      const bx = rx + DX[d], bz = rz + DZ[d];
      if (!this.canBuildAt(town, bx, bz)) continue;
      const c = w.corners(bx, bz);
      if (World.slopeOf(c) !== SLOPE_FLAT) {
        const lvl = Math.max(...c);
        if (canLevelTile(w, bx, bz, lvl)) levelTile(w, bx, bz, lvl);
      }
      let type = this.chooseType(town, bx, bz, rng);
      if (wantChurch && Math.hypot(bx - town.x, bz - town.z) < 4) { type = BT_CHURCH; town.hasChurch = true; }
      this.placeBuilding(town, bx, bz, type, rng, day, OPP[d]);
      return true;
    }
    // extend the road network
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = town.roads[rng.int(town.roads.length)];
      if (!w.road[r] || w.townOf[r] !== town.id) continue;
      const d = rng.int(4);
      if (this.extendRoad(town, w.tx(r), w.tz(r), d)) return true;
    }
    return false;
  }

  compactRoads(town: Town) {
    const w = this.world;
    town.roads = town.roads.filter((t) => w.road[t] && w.townOf[t] === town.id);
  }
}

function mod(a: number, b: number) { return ((a % b) + b) % b; }
function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
