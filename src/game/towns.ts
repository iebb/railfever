// Towns: organic street networks on the road graph, building lots and growth.
import type { Game } from './game';
import { World, Building, distToRect } from './world';
import { RNG } from './rng';
import { townName } from './names';
import { ROAD_TYPES, WATER_Y } from './constants';
import { planEdge, commitProposal, findSnap, Snap, BuildOptions } from './construction';
import { NEdge } from './network';

export const BT_HOUSE_S = 0, BT_HOUSE_L = 1, BT_TOWNHOUSE = 2, BT_SHOP = 3, BT_APARTMENT = 4,
  BT_OFFICE = 5, BT_TOWER = 6, BT_CHURCH = 7;

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
];

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
}

const TOWN_OPTS = (): BuildOptions => ({ kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: -1, town: true });

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
        id: this.list.length, name: townName(rng, used), x: site.x, z: site.z, angle: rng.next() * Math.PI,
        pop: 0, buildings: new Set(), radius: 4, nextGrowthDay: rng.int(30), hasChurch: false,
        passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0,
      };
      this.list.push(town);
      const target = isCity ? 2200 + rng.int(2600) : 250 + rng.int(1100);
      this.seedTown(town, rng, target);
      let guard = 0;
      while (town.pop < target && guard++ < 2500) this.growStep(town, rng, 0);
    });
  }

  private buildStreet(from: Snap, tx: number, tz: number): boolean {
    const g = this.game;
    const to = findSnap(g, 'road', tx, tz, 1.4);
    if (to.kind !== 'free' && from.kind !== 'free' && to.node !== undefined && to.node === from.node) return false;
    const prop = planEdge(g, from, to, TOWN_OPTS());
    if (!prop.ok) return false;
    if (prop.stats.bridges && prop.stats.len > 0 && prop.tracks.some((t) => t.sections.some((s) => s.type === 'bridge' && s.s1 - s.s0 > 6))) return false;
    if (prop.stats.tunnels) return false;
    return commitProposal(g, prop) === null;
  }

  private seedTown(town: Town, rng: RNG, target: number) {
    const arms = target > 1500 ? 4 : target > 600 ? 3 : 2;
    const armLen = 10 + Math.sqrt(target) * 0.45;
    const net = this.world.net;
    for (let k = 0; k < arms; k++) {
      let ang = town.angle + (k * Math.PI * 2) / (arms === 3 ? 3 : 4) + (rng.next() - 0.5) * 0.25;
      let cur: Snap = k === 0 ? { kind: 'free', x: town.x, z: town.z, y: 0 } : findSnap(this.game, 'road', town.x, town.z, 1.5);
      let travelled = 0;
      while (travelled < armLen) {
        const seg = 6 + rng.next() * 3;
        const tx = cur.x + Math.sin(ang) * seg, tz = cur.z + Math.cos(ang) * seg;
        const before = net.nextNode;
        if (!this.buildStreet(cur, tx, tz)) break;
        const n = net.nearestNode(tx, tz, 1.5, 'road');
        if (!n || n.id < before && travelled > 0 && Math.hypot(n.x - tx, n.z - tz) > 1.4) break;
        cur = { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id };
        travelled += seg;
        ang += (rng.next() - 0.5) * 0.3;
      }
    }
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

  /** Try to place a building on a lot along a street. */
  private tryLot(town: Town, e: NEdge, rng: RNG, day: number, typeOverride = -1): boolean {
    const net = this.world.net;
    const ra = net.junctionRadius(e.a) + 0.4, rb = net.junctionRadius(e.b) + 0.4;
    if (e.len - ra - rb < 1) return false;
    const s = ra + rng.next() * (e.len - ra - rb);
    const p = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };
    net.pointAt(e, s, p, dir);
    const dl = Math.hypot(dir.x, dir.z) || 1;
    const tx = dir.x / dl, tz = dir.z / dl;
    const side = rng.chance(0.5) ? 1 : -1;
    const nx = -tz * side, nz = tx * side; // outward normal
    const type = typeOverride >= 0 ? typeOverride : this.chooseType(town, p.x + nx * 2, p.z + nz * 2, rng);
    const bt = BUILDING_TYPES[type];
    const w = bt.w[0] + rng.next() * (bt.w[1] - bt.w[0]);
    const d = bt.d[0] + rng.next() * (bt.d[1] - bt.d[0]);
    const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.street;
    const off = rt.half + rt.sidewalk + bt.setback + d / 2;
    const bx = p.x + nx * off, bz = p.z + nz * off;
    if (Math.hypot(bx - town.x, bz - town.z) > this.growthRadius(town) + 4) return false;
    // facade faces the street: forward = -normal
    const angle = Math.atan2(-nx, -nz);
    const y = this.canPlace(bx, bz, angle, w, d);
    if (y === null) return false;
    this.placeBuilding(town, type, bx, bz, angle, w, d, y, rng, day);
    return true;
  }

  maxRadius(town: Town) { return 10 + Math.sqrt(Math.max(100, town.pop)) * 0.6; }
  /** Radius within which new lots and streets may appear (compact core, or the existing built-up area). */
  growthRadius(town: Town) { return Math.max(this.maxRadius(town) * 1.15, town.radius - 2.5); }

  /** One growth step: building, upgrade or street extension. */
  growStep(town: Town, rng: RNG, day: number): boolean {
    const w = this.world;
    const net = w.net;
    // pace growth in the running game (generation grows freely): about 0.5 % of the population per
    // step, independent of how many steps the game schedules for big towns
    if (day > 0 && town.buildings.size > 0 && town.pop > 0) {
      const avg = town.pop / town.buildings.size;
      const gain = (0.005 * town.pop) / (1 + Math.floor(town.pop / 2500));
      if (rng.next() > gain / Math.max(1, avg)) return false;
    }
    const streets = this.streets(town);
    if (!streets.length) return false;
    // upgrade a building near the centre now and then
    if (town.buildings.size > 20 && rng.chance(0.15) && this.upgrade(town, rng, day)) return true;
    // church once established
    if (!town.hasChurch && town.pop > 500) {
      const near = streets.filter((e) => { const n = net.nodes.get(e.a)!; return Math.hypot(n.x - town.x, n.z - town.z) < 12; });
      for (let k = 0; k < 6 && near.length; k++) if (this.tryLot(town, near[rng.int(near.length)], rng, day, BT_CHURCH)) return true;
    }
    // new building along a street, biased towards the centre
    const weights = streets.map((e) => {
      const g = net.geo(e);
      const mx = g.pts[Math.floor(g.n / 2) * 3], mz = g.pts[Math.floor(g.n / 2) * 3 + 2];
      return 1 / (1 + (Math.hypot(mx - town.x, mz - town.z) / 10) ** 2) * e.len;
    });
    const tot = weights.reduce((a, b) => a + b, 0);
    for (let attempt = 0; attempt < 10; attempt++) {
      let r = rng.next() * tot, i = 0;
      while (i < streets.length - 1 && r > weights[i]) { r -= weights[i]; i++; }
      if (this.tryLot(town, streets[i], rng, day)) return true;
    }
    // inner lots taken: try anywhere along the streets
    for (let attempt = 0; attempt < 5; attempt++) if (this.tryLot(town, streets[rng.int(streets.length)], rng, day)) return true;
    // extend the street network; if that fails too, densify
    return this.extendStreets(town, streets, rng) || (town.buildings.size > 8 && this.upgrade(town, rng, day));
  }

  /** Replace a building by a higher-ranked one (bigger footprint if there is room, else taller). */
  private upgrade(town: Town, rng: RNG, day: number): boolean {
    const w = this.world;
    const ids = [...town.buildings];
    for (let k = 0; k < 4; k++) {
      const b = w.buildings.get(ids[rng.int(ids.length)]);
      if (!b || b.type === BT_CHURCH) continue;
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

  private extendStreets(town: Town, streets: NEdge[], rng: RNG): boolean {
    const net = this.world.net;
    const maxR = this.growthRadius(town);
    for (let attempt = 0; attempt < 6; attempt++) {
      const e = streets[rng.int(streets.length)];
      if (rng.chance(0.45)) {
        // extend a dead end outwards
        for (const nid of [e.a, e.b]) {
          const n = net.nodes.get(nid)!;
          if (n.edges.length !== 1) continue;
          if (Math.hypot(n.x - town.x, n.z - town.z) > maxR + 6) continue;
          const d = net.leaveDir(e, nid);
          const ang = Math.atan2(-d.x, -d.z) + (rng.next() - 0.5) * 0.4;
          const len = 6 + rng.next() * 3;
          if (this.buildStreet({ kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }, n.x + Math.sin(ang) * len, n.z + Math.cos(ang) * len)) return true;
        }
      } else {
        // branch off perpendicular from the middle of a long street
        if (e.len < 11) continue;
        const s = 5 + rng.next() * (e.len - 10);
        const p = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };
        net.pointAt(e, s, p, dir);
        if (Math.hypot(p.x - town.x, p.z - town.z) > maxR) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        const dl = Math.hypot(dir.x, dir.z) || 1;
        const nx = (-dir.z / dl) * side, nz = (dir.x / dl) * side;
        const len = 6 + rng.next() * 4;
        if (this.buildStreet({ kind: 'edge', x: p.x, z: p.z, y: p.y, edge: e.id, s }, p.x + nx * len, p.z + nz * len)) return true;
      }
    }
    return false;
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
