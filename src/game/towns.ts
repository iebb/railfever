// Towns: rotated street grids on the road graph, perimeter-block frontage, parks/plazas and growth.
import type { Game } from './game';
import { World, Building, distToRect, pointInRect } from './world';
import { RNG, hash2 } from './rng';
import { townName } from './names';
import { ROAD_TYPES, WATER_Y } from './constants';
import { planEdge, commitProposal, findSnap, BuildOptions } from './construction';
import { NEdge, NNode } from './network';
import { closestOnPolyline } from './geom';

export const BT_HOUSE_S = 0, BT_HOUSE_L = 1, BT_TOWNHOUSE = 2, BT_SHOP = 3, BT_APARTMENT = 4,
  BT_OFFICE = 5, BT_TOWER = 6, BT_CHURCH = 7, BT_PARK = 8, BT_PLAZA = 9;

export const FLOOR_H = 0.3;

export interface BuildingType {
  name: string;
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  popPerFloor: [number, number];
  setback: number;
  rank: number;
}

export const BUILDING_TYPES: BuildingType[] = [
  { name: 'Cottage', w: [0.8, 1.0], d: [0.7, 0.9], floors: [1, 2], popPerFloor: [1.5, 2.5], setback: 0.35, rank: 0 },
  { name: 'House', w: [1.0, 1.3], d: [0.9, 1.1], floors: [2, 2], popPerFloor: [2, 3], setback: 0.3, rank: 1 },
  { name: 'Townhouse', w: [1.1, 1.5], d: [0.9, 1.2], floors: [3, 4], popPerFloor: [3, 4], setback: 0.08, rank: 2 },
  { name: 'Shops', w: [1.4, 2.0], d: [1.1, 1.5], floors: [1, 3], popPerFloor: [4, 6], setback: 0.06, rank: 2 },
  { name: 'Apartments', w: [1.8, 2.6], d: [1.4, 1.8], floors: [4, 7], popPerFloor: [8, 12], setback: 0.1, rank: 3 },
  { name: 'Offices', w: [2.0, 2.8], d: [1.8, 2.4], floors: [6, 12], popPerFloor: [12, 18], setback: 0.08, rank: 4 },
  { name: 'Tower', w: [2.2, 2.8], d: [2.2, 2.8], floors: [14, 30], popPerFloor: [14, 20], setback: 0.08, rank: 5 },
  { name: 'Church', w: [1.6, 1.6], d: [3.0, 3.0], floors: [1, 1], popPerFloor: [0, 0], setback: 0.4, rank: 9 },
  // land use: a whole block (rect = block interior), no floors, no inhabitants
  { name: 'Park', w: [4, 12], d: [4, 12], floors: [0, 0], popPerFloor: [0, 0], setback: 0, rank: 9 },
  { name: 'Plaza', w: [4, 12], d: [4, 12], floors: [0, 0], popPerFloor: [0, 0], setback: 0, rank: 9 },
];

/**
 * A town's street grid: lattice point (i, j) lies at origin + u * gu[i + n] + v * gv[j + n] with
 * u = (sin angle, cos angle) and v = (cos angle, -sin angle). Block (i, j) spans lattice lines i..i+1, j..j+1.
 */
export interface TownGrid {
  ox: number; oz: number;
  angle: number;
  n: number;
  gu: number[];
  gv: number[];
  /** lattice segments that could not be built (see latticeKey) */
  failed: number[];
  /** the central block (0, 0) is a plaza */
  plaza: boolean;
}

export interface Town {
  id: number;
  name: string;
  x: number; z: number;
  angle: number;
  pop: number;
  buildings: Set<number>;
  radius: number;
  nextGrowthDay: number;
  hasChurch: boolean;
  passGenMonth: number; passTransMonth: number; passGenLast: number; passTransLast: number;
  served: number;
  /** street grid (towns from old saves get one on their next growth step) */
  grid?: TownGrid;
}

const TOWN_OPTS = (): BuildOptions => ({ kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: -1, town: true });

const latticeKey = (g: TownGrid, i: number, j: number, dir: number) => ((i + g.n) * (2 * g.n + 1) + (j + g.n)) * 2 + dir;

/**
 * Street sides found full (no lot left) per town. Transient: edge ids are never reused, and the
 * running game forgets the set every couple of months (demolitions, terraforming free new lots).
 */
const fullSides = new WeakMap<Town, { set: Set<number>; day: number }>();
const sideKey = (e: NEdge, side: number) => e.id * 2 + (side > 0 ? 1 : 0);
function fullSet(town: Town, day: number): Set<number> {
  let f = fullSides.get(town);
  if (!f || day - f.day > 60) { f = { set: new Set(), day }; fullSides.set(town, f); }
  return f.set;
}

/** Oriented rectangle overlap test (SAT) with an extra margin. */
export function rectsOverlap(a: { x: number; z: number; angle: number; w: number; d: number }, b: { x: number; z: number; angle: number; w: number; d: number }, margin = 0): boolean {
  const axes = (r: typeof a) => [[Math.cos(r.angle), -Math.sin(r.angle)], [Math.sin(r.angle), Math.cos(r.angle)]];
  const corners = (r: typeof a) => {
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const hw = r.w / 2 + margin / 2, hd = r.d / 2 + margin / 2;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [r.x + rx * hw * sx + fx * hd * sz, r.z + rz * hw * sx + fz * hd * sz]);
  };
  const ca = corners(a), cb = corners(b);
  for (const ax of [...axes(a), ...axes(b)]) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const c of ca) { const p = c[0] * ax[0] + c[1] * ax[1]; amin = Math.min(amin, p); amax = Math.max(amax, p); }
    for (const c of cb) { const p = c[0] * ax[0] + c[1] * ax[1]; bmin = Math.min(bmin, p); bmax = Math.max(bmax, p); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

export class Towns {
  list: Town[] = [];
  constructor(public game: Game) {}

  get world(): World { return this.game.world; }
  get(id: number): Town { return this.list[id]; }

  nearest(x: number, z: number): Town | null {
    let best: Town | null = null, bd = Infinity;
    for (const t of this.list) {
      const d = Math.hypot(t.x - x, t.z - z) / (1 + Math.sqrt(t.pop) / 60);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  recomputePop(town: Town) {
    let p = 0, r = 4;
    for (const id of town.buildings) {
      const b = this.world.buildings.get(id);
      if (!b) { town.buildings.delete(id); continue; }
      p += b.pop;
      r = Math.max(r, Math.hypot(b.x - town.x, b.z - town.z));
    }
    town.pop = p;
    town.radius = r;
  }

  demolishBuilding(id: number) {
    const b = this.world.buildings.get(id);
    if (!b) return;
    const town = this.list[b.townId];
    this.world.removeBuilding(id);
    if (town) { town.buildings.delete(id); this.recomputePop(town); if (b.type === BT_CHURCH) town.hasChurch = false; }
  }

  // ---------------------------------------------------------------- generation
  generate(count: number, seed: number, cityFraction = 0.2) {
    const w = this.world;
    const rng = new RNG(seed * 13 + 77);
    const used = new Set<string>();
    const s = w.size;
    const minDist = Math.max(45, Math.sqrt((s * s) / Math.max(1, count)) * 0.7);
    const sites: { x: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      let best: { x: number; z: number; score: number } | null = null;
      for (let tries = 0; tries < 400; tries++) {
        const x = 30 + rng.next() * (s - 60), z = 30 + rng.next() * (s - 60);
        if (w.heightAt(x, z) < WATER_Y + 1) continue;
        if (sites.some((o) => Math.hypot(o.x - x, o.z - z) < minDist)) continue;
        let mn = Infinity, mx = -Infinity, water = 0;
        for (let dz = -12; dz <= 12; dz += 4) for (let dx = -12; dx <= 12; dx += 4) {
          const h = w.heightAt(x + dx, z + dz);
          if (h < WATER_Y + 0.3) water++;
          mn = Math.min(mn, h); mx = Math.max(mx, h);
        }
        const score = -(mx - mn) * 1.5 - water * 1.5 + rng.next() * 3;
        if (!best || score > best.score) best = { x, z, score };
      }
      if (!best) break;
      sites.push(best);
    }
    // soften the terrain around town centres
    for (const site of sites) {
      const base = Math.max(WATER_Y + 1, w.heightAt(site.x, site.z));
      const R = 26;
      for (let z = Math.floor(site.z - R); z <= Math.ceil(site.z + R); z++) for (let x = Math.floor(site.x - R); x <= Math.ceil(site.x + R); x++) {
        if (x < 1 || z < 1 || x >= s || z >= s) continue;
        const d = Math.hypot(x - site.x, z - site.z);
        const wgt = (1 - smoothstep(R * 0.35, R, d)) * 0.75;
        if (wgt <= 0) continue;
        const k = w.vi(x, z);
        const h = w.h[k];
        if (h < WATER_Y && d > 8) continue;
        w.h[k] = h + (base - h) * wgt;
      }
    }
    w.heightsVersion++;
    sites.forEach((site, i) => {
      const isCity = i < Math.max(1, Math.round(count * cityFraction));
      const town: Town = {
        id: this.list.length, name: townName(rng, used), x: site.x, z: site.z, angle: 0,
        pop: 0, buildings: new Set(), radius: 4, nextGrowthDay: rng.int(30), hasChurch: false,
        passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0,
      };
      this.list.push(town);
      const target = isCity ? 2200 + rng.int(2600) : 250 + rng.int(1100);
      town.grid = this.makeGrid(town, rng, target);
      town.angle = town.grid.angle;
      this.layoutTown(town, target);
      let guard = 0, misses = 0;
      while (town.pop < target && guard++ < 5000 && misses < 120) misses = this.growStep(town, rng, 0) ? 0 : misses + 1;
    });
  }

  // ---------------------------------------------------------------- the street grid
  /** A grid for a town: the main axis follows the flattest direction (valleys, coasts), blocks ~8-12 x 6-9. */
  makeGrid(town: Town, rng: RNG, target: number): TownGrid {
    const w = this.world;
    const R = 14 + Math.sqrt(Math.max(200, target)) * 0.35;
    const rough = (dx: number, dz: number) => {
      let c = 0, prev = w.heightAt(town.x - dx * R, town.z - dz * R);
      for (let s = -R + 2; s <= R; s += 2) {
        const x = town.x + dx * s, z = town.z + dz * s;
        const h = w.heightAt(x, z);
        c += Math.abs(h - prev) + (h < WATER_Y + 0.3 ? 3 : 0) + (w.inside(x, z, 5) ? 0 : 3);
        prev = h;
      }
      return c;
    };
    let best = 0, bc = Infinity;
    const a0 = rng.next() * Math.PI;
    for (let k = 0; k < 18; k++) {
      const a = a0 + (k / 18) * Math.PI;
      const cost = rough(Math.sin(a), Math.cos(a)) + 0.6 * rough(Math.cos(a), -Math.sin(a));
      if (cost < bc - 1e-9) { bc = cost; best = a; }
    }
    const n = 10;
    const bu = 8 + rng.next() * 4, bv = 6 + rng.next() * 3;
    const gu = new Array<number>(2 * n + 1).fill(0), gv = new Array<number>(2 * n + 1).fill(0);
    for (let k = 1; k <= n; k++) {
      // old cores have slightly smaller blocks
      const core = k <= 1 ? 0.85 : k === 2 ? 0.93 : 1;
      gu[n + k] = gu[n + k - 1] + bu * core * (0.92 + rng.next() * 0.16);
      gu[n - k] = gu[n - k + 1] - bu * core * (0.92 + rng.next() * 0.16);
      gv[n + k] = gv[n + k - 1] + bv * core * (0.92 + rng.next() * 0.16);
      gv[n - k] = gv[n - k + 1] - bv * core * (0.92 + rng.next() * 0.16);
    }
    return { ox: town.x, oz: town.z, angle: best % Math.PI, n, gu, gv, failed: [], plaza: false };
  }

  /** World position of lattice point (i, j). */
  latticePoint(g: TownGrid, i: number, j: number): { x: number; z: number } {
    const a = g.gu[i + g.n], b = g.gv[j + g.n];
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    return { x: g.ox + sa * a + ca * b, z: g.oz + ca * a - sa * b };
  }

  /** Block (i, j) containing a point, or null outside the lattice. */
  cellAt(g: TownGrid, x: number, z: number): [number, number] | null {
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    const dx = x - g.ox, dz = z - g.oz;
    const a = dx * sa + dz * ca, b = dx * ca - dz * sa;
    const find = (arr: number[], v: number) => { for (let k = 0; k < arr.length - 1; k++) if (v >= arr[k] && v < arr[k + 1]) return k - g.n; return null; };
    const i = find(g.gu, a), j = find(g.gv, b);
    return i === null || j === null ? null : [i, j];
  }

  /** Planned grid extent (in blocks from the centre) for a population. */
  plannedRing(pop: number): number { return Math.max(1, Math.min(9, Math.ceil(Math.sqrt(Math.max(1, pop) / 130) / 2))); }

  private latticeNode(g: TownGrid, i: number, j: number): NNode | null {
    if (Math.abs(i) > g.n || Math.abs(j) > g.n) return null;
    const p = this.latticePoint(g, i, j);
    return this.world.net.nearestNode(p.x, p.z, 0.9, 'road', (nn) => nn.edges.length > 0);
  }

  /** Is there a road along the lattice segment? */
  private latticeBuilt(g: TownGrid, i: number, j: number, dir: number): boolean {
    if (Math.abs(i) > g.n || Math.abs(j) > g.n || (dir === 0 && i + 1 > g.n) || (dir === 1 && j + 1 > g.n)) return false;
    const p = this.latticePoint(g, i, j), q = dir === 0 ? this.latticePoint(g, i + 1, j) : this.latticePoint(g, i, j + 1);
    const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const tx = (q.x - p.x) / L, tz = (q.z - p.z) / L;
    const net = this.world.net;
    const ne = net.nearestEdge((p.x + q.x) / 2, (p.z + q.z) / 2, 0.6, 'road');
    if (!ne) return false;
    const pt = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, pt, d);
    return Math.abs(d.x * tx + d.z * tz) / (Math.hypot(d.x, d.z) || 1) > 0.9;
  }

  private cellClosed(g: TownGrid, i: number, j: number): boolean {
    return this.latticeBuilt(g, i, j, 0) && this.latticeBuilt(g, i, j + 1, 0) && this.latticeBuilt(g, i, j, 1) && this.latticeBuilt(g, i + 1, j, 1);
  }

  /** Park/plaza reserved for block (i, j), or -1. */
  reservedUse(town: Town, i: number, j: number): number {
    const g = town.grid;
    if (!g) return -1;
    if (g.plaza && i === 0 && j === 0) return BT_PLAZA;
    if (Math.abs(i + 0.5) < 1.6 && Math.abs(j + 0.5) < 1.6) return -1; // the core stays built-up
    return hash2(i + 101, j + 101, town.id * 7 + 13) < 1 / 12 ? BT_PARK : -1;
  }

  /** Build the street along lattice segment (i, j, dir); records failures. */
  private buildLattice(town: Town, i: number, j: number, dir: number, day = 0): boolean {
    const g = town.grid!;
    const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
    if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i2), Math.abs(j2)) > g.n) return false;
    const k = latticeKey(g, i, j, dir);
    if (g.failed.includes(k)) return false;
    if (this.latticeBuilt(g, i, j, dir)) return true;
    if (!this.tryStreet(this.latticePoint(g, i, j), this.latticePoint(g, i2, j2))) { g.failed.push(k); return false; }
    // newly closed blocks may become parks or the plaza
    if (dir === 0) { this.landUse(town, i, j - 1, day); this.landUse(town, i, j, day); }
    else { this.landUse(town, i - 1, j, day); this.landUse(town, i, j, day); }
    return true;
  }

  /** A straight town street between two points; skipped when steep, over water, blocked or crossing rails. */
  private tryStreet(p: { x: number; z: number }, q: { x: number; z: number }): boolean {
    const g = this.game, w = this.world, net = w.net;
    if (!w.inside(p.x, p.z, 5) || !w.inside(q.x, q.z, 5)) return false;
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    for (let k = 0; k <= 8; k++) {
      const x = p.x + ((q.x - p.x) * k) / 8, z = p.z + ((q.z - p.z) * k) / 8;
      if (w.heightAt(x, z) < WATER_Y + 0.15) return false;
    }
    const sa = findSnap(g, 'road', p.x, p.z, 0.9), sb = findSnap(g, 'road', q.x, q.z, 0.9);
    if (sa.kind === 'node' && sb.kind === 'node' && sa.node === sb.node) return false;
    const prop = planEdge(g, sa, sb, { ...TOWN_OPTS(), straight: true });
    if (!prop.ok || prop.stats.bridges || prop.stats.tunnels || prop.stats.minRadius < 3) return false;
    // never level-cross (or bridge) railways, never cut through company roads
    for (const c of prop.crossings) { const e = net.edges.get(c.edge); if (!e || e.kind === 'rail' || e.owner >= 0) return false; }
    // stay close to the ground (no big cuttings or embankments on hillsides)
    const tp = prop.tracks[0];
    for (let i = 0; i < tp.prof.length; i++) {
      const f = Math.min(1, (i * 1) / Math.max(0.01, tp.len));
      const x = tp.bez.x0 + (tp.bez.x3 - tp.bez.x0) * f, z = tp.bez.z0 + (tp.bez.z3 - tp.bez.z0) * f;
      if (Math.abs(tp.prof[i] - w.heightAt(x, z)) > 1.0) return false;
    }
    void L;
    return commitProposal(g, prop) === null;
  }

  /** Initial layout: two arterials through the centre, then the grid ring by ring. */
  private layoutTown(town: Town, target: number) {
    const g = town.grid!;
    const ring = this.plannedRing(target);
    if (target > 1500) g.plaza = true;
    for (let k = 0; k <= ring; k++) if (!this.buildLattice(town, k, 0, 0)) break;
    for (let k = 0; k <= ring; k++) if (!this.buildLattice(town, -k - 1, 0, 0)) break;
    for (let k = 0; k <= ring; k++) if (!this.buildLattice(town, 0, k, 1)) break;
    for (let k = 0; k <= ring; k++) if (!this.buildLattice(town, 0, -k - 1, 1)) break;
    this.fillRing(town, 1);
  }

  /** Build the lattice segments of ring r that connect to the network, block-closing ones first. */
  private fillRing(town: Town, r: number) {
    const g = town.grid!;
    const segs: [number, number, number][] = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const dir of [0, 1]) {
      const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
      if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i2), Math.abs(j2)) !== r) continue;
      segs.push([i, j, dir]);
    }
    for (let pass = 0; pass < 4; pass++) {
      let progress = false;
      for (const [i, j, dir] of segs) {
        if (g.failed.includes(latticeKey(g, i, j, dir)) || this.latticeBuilt(g, i, j, dir)) continue;
        const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
        if (!this.latticeNode(g, i, j) && !this.latticeNode(g, i2, j2)) continue;
        if (pass === 0 && !this.closesBlock(g, i, j, dir)) continue;
        if (this.buildLattice(town, i, j, dir)) progress = true;
      }
      if (!progress && pass > 0) break;
    }
  }

  /** Would building this segment close one of its two blocks (the other three sides exist)? */
  private closesBlock(g: TownGrid, i: number, j: number, dir: number): boolean {
    const others = (ci: number, cj: number) => {
      const sides: [number, number, number][] = [[ci, cj, 0], [ci, cj + 1, 0], [ci, cj, 1], [ci + 1, cj, 1]];
      return sides.filter(([a, b, d]) => !(a === i && b === j && d === dir)).every(([a, b, d]) => this.latticeBuilt(g, a, b, d));
    };
    return dir === 0 ? others(i, j - 1) || others(i, j) : others(i - 1, j) || others(i, j);
  }

  /** Grow the grid by one segment at its edge (closing blocks first, near the centre first). */
  private extendGrid(town: Town, rng: RNG, day: number): boolean {
    const g = town.grid!;
    const maxRing = Math.min(g.n - 1, this.plannedRing(town.pop * 1.25 + 200));
    const node = new Map<number, boolean>();
    const has = (i: number, j: number) => { const k = (i + g.n) * 100 + j + g.n; let v = node.get(k); if (v === undefined) { v = !!this.latticeNode(g, i, j); node.set(k, v); } return v; };
    const cands: { i: number; j: number; dir: number; score: number }[] = [];
    for (let i = -maxRing; i <= maxRing; i++) for (let j = -maxRing; j <= maxRing; j++) for (const dir of [0, 1]) {
      const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
      const ring = Math.max(Math.abs(i), Math.abs(j), Math.abs(i2), Math.abs(j2));
      if (ring > maxRing || g.failed.includes(latticeKey(g, i, j, dir))) continue;
      const a = has(i, j), b = has(i2, j2);
      if (!a && !b) continue;
      if (a && b && this.latticeBuilt(g, i, j, dir)) continue;
      cands.push({ i, j, dir, score: (a && b ? 3 : 0) - ring * 1.5 + rng.next() * 1.5 });
    }
    cands.sort((p, q) => q.score - p.score);
    const top = cands.slice(0, 10);
    for (const c of top) if (this.closesBlock(g, c.i, c.j, c.dir)) c.score += 6;
    top.sort((p, q) => q.score - p.score);
    for (const c of top.slice(0, 4)) if (this.buildLattice(town, c.i, c.j, c.dir, day)) return true;
    return false;
  }

  /** Place the park/plaza of a closed reserved block. */
  private landUse(town: Town, i: number, j: number, day = 0) {
    const g = town.grid!;
    if (Math.abs(i) >= g.n || Math.abs(j) >= g.n) return;
    const type = this.reservedUse(town, i, j);
    if (type < 0 || !this.cellClosed(g, i, j)) return;
    const W = this.world;
    const a0 = g.gu[i + g.n], a1 = g.gu[i + 1 + g.n], b0 = g.gv[j + g.n], b1 = g.gv[j + 1 + g.n];
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
    const x = g.ox + sa * am + ca * bm, z = g.oz + ca * am - sa * bm;
    const d = a1 - a0 - 1.3, w = b1 - b0 - 1.3;
    if (d < 3 || w < 3) return;
    const rect = { x, z, angle: g.angle, w, d };
    // already used? (buildings or other network inside the block)
    const R = Math.hypot(w, d) / 2 + 1;
    for (const id of W.bgrid.query(x - R, z - R, x + R, z + R)) { const b = W.buildings.get(id); if (b && rectsOverlap(rect, b, 0.05)) return; }
    for (const e of W.net.edgesNear(x - R, z - R, x + R, z + R)) {
      const geo = W.net.geo(e), hw = W.net.halfWidth(e);
      for (let k = 0; k < geo.n; k++) if (distToRect(geo.pts[k * 3], geo.pts[k * 3 + 2], x, z, g.angle, w / 2, d / 2) < hw - 0.05) return;
    }
    let sum = 0, mn = Infinity;
    for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const h = W.heightAt(x + ca * w * u + sa * d * v, z - sa * w * u + ca * d * v);
      sum += h; mn = Math.min(mn, h);
    }
    if (mn < WATER_Y + 0.15) return;
    // the renderer draws the park's own trees and the plaza's paving: clear the block
    for (const id of W.treeGrid.query(x - R, z - R, x + R, z + R)) {
      const t = W.trees[id];
      if (t && pointInRect(t.x, t.z, x, z, g.angle, w / 2 + 0.2, d / 2 + 0.2)) W.removeTreesNear(t.x, t.z, 0.01);
    }
    const b = W.addBuilding({ townId: town.id, x, z, angle: g.angle, w, d, type, floors: 0, pop: 0, seed: hash2(i, j, town.id) * (1 << 30) | 0, y: sum / 5, built: day });
    town.buildings.add(b.id);
  }

  /** Town street edges near the town. */
  streets(town: Town, extra = 6): NEdge[] {
    const R = town.radius + extra;
    return this.world.net.edgesNear(town.x - R, town.z - R, town.x + R, town.z + R)
      .filter((e) => e.kind === 'road' && e.owner === -1 && e.station < 0 && e.depot < 0);
  }

  private chooseType(town: Town, x: number, z: number, rng: RNG): number {
    const d = Math.hypot(x - town.x, z - town.z);
    const P = town.pop;
    const r = rng.next();
    const core = 6 + Math.sqrt(P) * 0.18;
    if (P > 2600 && d < core * 0.55) return r < 0.35 ? BT_TOWER : r < 0.8 ? BT_OFFICE : BT_APARTMENT;
    if (P > 1100 && d < core) return r < 0.5 ? BT_APARTMENT : r < 0.65 && P > 1800 ? BT_OFFICE : r < 0.85 ? BT_SHOP : BT_TOWNHOUSE;
    if (P > 220 && d < core * 1.35) return r < 0.4 ? BT_TOWNHOUSE : r < 0.65 ? BT_SHOP : r < 0.78 && P > 700 ? BT_APARTMENT : BT_HOUSE_L;
    return r < 0.55 ? BT_HOUSE_S : BT_HOUSE_L;
  }

  /** Can a building rectangle be placed? Returns its base height or null. */
  canPlace(x: number, z: number, angle: number, w: number, d: number, ignore = -1): number | null {
    const W = this.world;
    if (!W.inside(x, z, 3)) return null;
    const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
    let mn = Infinity, mx = -Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const h = W.heightAt(x + rx * (w / 2) * sx + fx * (d / 2) * sz, z + rz * (w / 2) * sx + fz * (d / 2) * sz);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    if (mn < WATER_Y + 0.15 || mx - mn > 0.7) return null;
    const rect = { x, z, angle, w, d };
    const R = Math.hypot(w, d) / 2 + 0.5;
    for (const id of W.bgrid.query(x - R - 3, z - R - 3, x + R + 3, z + R + 3)) {
      if (id === ignore) continue;
      const b = W.buildings.get(id);
      if (b && rectsOverlap(rect, b, 0.12)) return null;
    }
    const net = W.net;
    for (const e of net.edgesNear(x - R, z - R, x + R, z + R)) {
      const g = net.geo(e);
      const hw = net.halfWidth(e) + 0.06;
      for (let i = 0; i < g.n; i++) {
        const px = g.pts[i * 3], pz = g.pts[i * 3 + 2];
        if (Math.abs(px - x) > R + hw || Math.abs(pz - z) > R + hw) continue;
        if (distToRect(px, pz, x, z, angle, w / 2, d / 2) < hw) return null;
      }
    }
    for (const n of net.nodeGrid.query(x - R, z - R, x + R, z + R)) {
      const nd = net.nodes.get(n);
      if (nd && distToRect(nd.x, nd.z, x, z, angle, w / 2, d / 2) < net.junctionRadius(nd.id) + 0.1) return null;
    }
    if (this.game.stations.footprintsNear(x, z, R).length) return null;
    if (this.game.depots.near(x, z, R + 1).length) return null;
    return mx;
  }

  private placeBuilding(town: Town, type: number, x: number, z: number, angle: number, w: number, d: number, y: number, rng: RNG, day: number, maxPop = Infinity): Building {
    const bt = BUILDING_TYPES[type];
    const ppf = bt.popPerFloor[0] + rng.next() * (bt.popPerFloor[1] - bt.popPerFloor[0]);
    let floors = bt.floors[0] + rng.int(bt.floors[1] - bt.floors[0] + 1);
    const perFloor = (ppf * (w * d)) / 1.2;
    if (perFloor > 0 && floors * perFloor > maxPop) floors = Math.max(bt.floors[0], Math.floor(maxPop / perFloor));
    this.world.removeTreesNear(x, z, Math.hypot(w, d) / 2 + 0.4);
    const b = this.world.addBuilding({ townId: town.id, x, z, angle, w, d, type, floors, pop: Math.round(floors * ppf * (w * d) / 1.2), seed: rng.int(1 << 30), y, built: day });
    town.buildings.add(b.id);
    town.pop += b.pop;
    town.radius = Math.max(town.radius, Math.hypot(x - town.x, z - town.z));
    if (type === BT_CHURCH) town.hasChurch = true;
    return b;
  }

  /**
   * Perimeter-block frontage: the next free lot on one side of a street, next to the existing row
   * (continuous rows in the centre, detached houses with gaps in the suburbs; block interiors stay open).
   */
  private frontage(town: Town, e: NEdge, side: number, rng: RNG, day: number, typeOverride = -1): boolean {
    const W = this.world, net = W.net;
    const geo = net.geo(e);
    const ra = net.junctionRadius(e.a) + 0.3, rb = net.junctionRadius(e.b) + 0.3;
    const s0 = Math.min(ra, e.len * 0.45), s1 = Math.max(e.len - rb, e.len * 0.55);
    const full = fullSet(town, day);
    if (s1 - s0 < 0.9) { if (typeOverride < 0) full.add(sideKey(e, side)); return false; }
    const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.street;
    const hw = rt.half + rt.sidewalk;
    const at = (s: number) => {
      const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
      net.pointAt(e, s, p, d);
      const l = Math.hypot(d.x, d.z) || 1;
      return { x: p.x, z: p.z, tx: d.x / l, tz: d.z / l };
    };
    // building type for this stretch
    const mid = at((s0 + s1) / 2);
    const type = typeOverride >= 0 ? typeOverride : this.chooseType(town, mid.x - mid.tz * side * 2, mid.z + mid.tx * side * 2, rng);
    const bt = BUILDING_TYPES[type];
    const wdt = bt.w[0] + rng.next() * (bt.w[1] - bt.w[0]);
    const dep = bt.d[0] + rng.next() * (bt.d[1] - bt.d[0]);
    const gap = bt.rank >= 2 ? 0.14 + rng.next() * 0.05 : 0.35 + rng.next() * 0.9;
    // occupied stretches on this side (buildings projected onto the street)
    const box = net.grid.box(e.id);
    if (!box) return false;
    const occ: [number, number][] = [];
    for (const id of W.bgrid.query(box[0] - 3.5, box[1] - 3.5, box[2] + 3.5, box[3] + 3.5)) {
      const b = W.buildings.get(id);
      if (!b) continue;
      const c = closestOnPolyline(b.x, b.z, geo.pts, 3, geo.n);
      const i1 = Math.min(geo.n - 1, c.i + 1);
      const s = geo.cum[c.i] + (geo.cum[i1] - geo.cum[c.i]) * c.f;
      const tx = geo.tan[c.i * 2], tz = geo.tan[c.i * 2 + 1];
      const px = geo.pts[c.i * 3] + (geo.pts[i1 * 3] - geo.pts[c.i * 3]) * c.f, pz = geo.pts[c.i * 3 + 2] + (geo.pts[i1 * 3 + 2] - geo.pts[c.i * 3 + 2]) * c.f;
      const lat = (b.x - px) * -tz + (b.z - pz) * tx;
      if (lat * side <= 0 || Math.abs(lat) > hw + Math.max(b.w, b.d) + 1) continue;
      const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
      const ext = (Math.abs(fz * tx - fx * tz) * b.w + Math.abs(fx * tx + fz * tz) * b.d) / 2;
      occ.push([s - ext, s + ext]);
    }
    occ.sort((p, q) => p[0] - q[0]);
    const free: [number, number][] = [];
    let cur = s0;
    for (const [a, b] of occ) { if (b <= s0 || a >= s1) continue; if (a > cur) free.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < s1) free.push([cur, s1]);
    // fill from the end nearer the town centre
    const pa = at(s0), pb = at(s1);
    const fromA = Math.hypot(pa.x - town.x, pa.z - town.z) <= Math.hypot(pb.x - town.x, pb.z - town.z);
    if (!fromA) free.reverse();
    const off = hw + bt.setback + dep / 2;
    if (!free.some(([a, b]) => b - a >= wdt + gap)) { if (typeOverride < 0) full.add(sideKey(e, side)); return false; }
    for (const [a, b] of free) {
      if (b - a < wdt + gap) continue;
      for (let k = 0; k < 3; k++) {
        const s = fromA ? a + gap / 2 + wdt / 2 + k * 0.45 : b - gap / 2 - wdt / 2 - k * 0.45;
        if (s - wdt / 2 < a - 1e-6 || s + wdt / 2 > b + 1e-6) break;
        const p = at(s);
        const nx = -p.tz * side, nz = p.tx * side;
        const bx = p.x + nx * off, bz = p.z + nz * off;
        // lots facing a park or the plaza stay open
        const g = town.grid;
        if (g) { const cell = this.cellAt(g, bx, bz); if (cell && this.reservedUse(town, cell[0], cell[1]) >= 0) { if (typeOverride < 0) full.add(sideKey(e, side)); return false; } }
        const angle = Math.atan2(-nx, -nz);
        const y = this.canPlace(bx, bz, angle, wdt, dep);
        if (y === null) continue;
        this.placeBuilding(town, type, bx, bz, angle, wdt, dep, y, rng, day);
        return true;
      }
    }
    if (typeOverride < 0) full.add(sideKey(e, side));
    return false;
  }

  maxRadius(town: Town) { return 10 + Math.sqrt(Math.max(100, town.pop)) * 0.6; }
  /** Radius within which new lots and streets may appear (compact core, or the existing built-up area). */
  growthRadius(town: Town) { const m = this.maxRadius(town); return Math.max(m * 1.15, Math.min(town.radius - 2.5, m * 1.5)); }

  /** One growth step: a frontage lot, a new grid segment at the edge, or densification. */
  growStep(town: Town, rng: RNG, day: number): boolean {
    const net = this.world.net;
    // pace growth in the running game (generation grows freely): about 0.5 % of the population per
    // step, independent of how many steps the game schedules for big towns
    if (day > 0 && town.buildings.size > 0 && town.pop > 0) {
      const avg = town.pop / town.buildings.size;
      const gain = (0.005 * town.pop) / (1 + Math.floor(town.pop / 2500));
      if (rng.next() > gain / Math.max(1, avg)) return false;
    }
    if (!town.grid) town.grid = this.makeGrid(town, rng, town.pop);
    const g = town.grid;
    const streets = this.streets(town).filter((e) => e.type === 'street');
    if (!streets.length) return this.extendGrid(town, rng, day);
    // upgrade a building near the centre now and then
    if (town.buildings.size > 20 && rng.chance(0.15) && this.upgrade(town, rng, day)) return true;
    // church once established
    if (!town.hasChurch && town.pop > 500) {
      const near = streets.filter((e) => { const n = net.nodes.get(e.a)!; return Math.hypot(n.x - town.x, n.z - town.z) < 14; });
      for (let k = 0; k < 6 && near.length; k++) if (this.frontage(town, near[rng.int(near.length)], rng.chance(0.5) ? 1 : -1, rng, day, BT_CHURCH)) return true;
    }
    // a plaza once the town is a city (if the central block is still free)
    if (!g.plaza && town.pop > 1500) { g.plaza = true; this.landUse(town, 0, 0, day); }
    // the next lot along a street side that still has room, nearest the centre first
    const full = fullSet(town, day);
    const cands: { e: NEdge; side: number; d: number }[] = [];
    for (const e of streets) {
      const geo = net.geo(e);
      const mx = geo.pts[Math.floor(geo.n / 2) * 3], mz = geo.pts[Math.floor(geo.n / 2) * 3 + 2];
      const d = Math.hypot(mx - town.x, mz - town.z);
      for (const side of [1, -1]) if (!full.has(sideKey(e, side))) cands.push({ e, side, d: d + rng.next() * 7 });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 6)) if (this.frontage(town, c.e, c.side, rng, day)) return true;
    // new blocks at the edge (their streets bring new lots); if that fails too, densify
    if (this.extendGrid(town, rng, day)) return true;
    return town.buildings.size > 8 && this.upgrade(town, rng, day);
  }

  /** Replace a building by a higher-ranked one (bigger footprint if there is room, else taller). */
  private upgrade(town: Town, rng: RNG, day: number): boolean {
    const w = this.world;
    const ids = [...town.buildings];
    for (let k = 0; k < 4; k++) {
      const b = w.buildings.get(ids[rng.int(ids.length)]);
      if (!b || BUILDING_TYPES[b.type].rank >= 9) continue;
      const nt = this.chooseType(town, b.x, b.z, rng);
      if (BUILDING_TYPES[nt].rank <= BUILDING_TYPES[b.type].rank) continue;
      const bt = BUILDING_TYPES[nt];
      // densify gradually: the new building may house at most 2.5x the old one
      const maxPop = b.pop * 2.5 + 20;
      if (bt.floors[0] * bt.popPerFloor[0] * (b.w * b.d) / 1.2 > maxPop) continue;
      const nw = Math.min(bt.w[1], Math.max(bt.w[0], b.w * 1.3)), nd = Math.min(bt.d[1], Math.max(bt.d[0], b.d * 1.3));
      // keep the facade line, grow backwards
      const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
      const cx = b.x - fx * (nd - b.d) / 2, cz = b.z - fz * (nd - b.d) / 2;
      let y = this.canPlace(cx, cz, b.angle, nw, nd, b.id);
      let ux = cx, uz = cz, uw = nw, ud = nd;
      // no room to grow: rebuild taller on the same footprint (only if it suits the new type)
      if (y === null && b.w * b.d >= 0.6 * bt.w[0] * bt.d[0]) { y = this.canPlace(b.x, b.z, b.angle, b.w, b.d, b.id); ux = b.x; uz = b.z; uw = b.w; ud = b.d; }
      if (y === null) continue;
      town.buildings.delete(b.id);
      town.pop -= b.pop;
      w.removeBuilding(b.id);
      this.placeBuilding(town, nt, ux, uz, b.angle, uw, ud, y, rng, day, maxPop);
      return true;
    }
    return false;
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
