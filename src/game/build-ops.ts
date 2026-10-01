// Construction operations other than routes: stations, stops, depots, signals,
// demolition and terraforming.
import type { Game } from './game';
import { World, SLOPE_FLAT } from './world';
import { DX, DZ, OPP, CORNER_DX, CORNER_DZ } from './constants';
import { cornerLocked } from './terraform';
import { COSTS } from './economy';
import type { Station } from './stations';
import { clearStructureCache } from './geom';

export interface StationPlan {
  ok: boolean;
  error?: string;
  x0: number; z0: number; x1: number; z1: number;
  axis: number;
  level: number;
  cost: number;
  corners: Map<number, number>;
  join: Station | null;
}

/** axis 0: tracks run north-south; axis 1: east-west. Rectangle centred on (x,z). */
export function planRailStation(game: Game, x: number, z: number, axis: number, length: number, tracks: number): StationPlan {
  const w = game.world;
  const wx = axis === 0 ? tracks : length, wz = axis === 0 ? length : tracks;
  const x0 = x - Math.floor((wx - 1) / 2), z0 = z - Math.floor((wz - 1) / 2);
  const x1 = x0 + wx - 1, z1 = z0 + wz - 1;
  const plan: StationPlan = { ok: true, x0, z0, x1, z1, axis, level: 0, cost: 0, corners: new Map(), join: null };
  const failp = (e: string) => { plan.ok = false; plan.error = plan.error ?? e; };
  if (x0 < 1 || z0 < 1 || x1 >= w.size - 1 || z1 >= w.size - 1) { failp('Too close to the map edge'); return plan; }
  const piece = axis === 0 ? 0 : 1;
  const levels = new Set<number>();
  let trees = 0;
  for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) {
    const t = w.idx(xx, zz);
    if (w.building[t] >= 0) failp('Buildings in the way');
    if (w.depot[t] >= 0) failp('Depot in the way');
    if (w.span[t] >= 0) failp('Bridge or tunnel in the way');
    if (w.station[t] >= 0) failp('Station already here');
    if (w.road[t]) failp('Road in the way');
    if (w.rail[t] && w.rail[t] !== 1 << piece) failp('Track in the way');
    for (let c = 0; c < 4; c++) levels.add(w.corner(xx, zz, c));
    trees += w.trees[t] & 15;
  }
  // choose the cheapest feasible level
  const s1 = w.size + 1;
  let bestL = NaN, bestCost = Infinity, bestMap: Map<number, number> | null = null;
  for (const L of levels) {
    if (L <= 0) continue;
    let cost = 0, ok = true;
    const map = new Map<number, number>();
    for (let cz = z0; cz <= z1 + 1 && ok; cz++) for (let cx = x0; cx <= x1 + 1; cx++) {
      const h = w.cornerH(cx, cz);
      if (h === L) continue;
      if (cornerLocked(w, cx, cz)) { ok = false; break; }
      cost += Math.abs(h - L);
      map.set(cz * s1 + cx, L);
    }
    if (ok && cost < bestCost) { bestCost = cost; bestL = L; bestMap = map; }
  }
  if (!bestMap) failp('Cannot level the ground here');
  else { plan.level = bestL; plan.corners = bestMap; }
  plan.cost = (wx * wz) * COSTS.stationTile + (isFinite(bestCost) ? bestCost : 0) * COSTS.terraform + trees * COSTS.tree;
  plan.join = game.stations.findNear(x0, z0, x1, z1, 1);
  return plan;
}

export function commitRailStation(game: Game, plan: StationPlan): string | null {
  const w = game.world;
  if (!plan.ok) return plan.error ?? 'Cannot build';
  if (!game.economy.canAfford(plan.cost)) return 'Not enough money';
  for (let zz = plan.z0; zz <= plan.z1; zz++) for (let xx = plan.x0; xx <= plan.x1; xx++) if (game.isTileBusy(w.idx(xx, zz))) return 'Vehicle in the way';
  game.economy.spend(plan.cost, 'construction');
  const s1 = w.size + 1;
  for (const [ci, l] of plan.corners) w.setCorner(ci % s1, (ci / s1) | 0, l);
  const st = plan.join ?? game.stations.create(Math.round((plan.x0 + plan.x1) / 2), Math.round((plan.z0 + plan.z1) / 2));
  const piece = plan.axis === 0 ? 0 : 1;
  for (let zz = plan.z0; zz <= plan.z1; zz++) for (let xx = plan.x0; xx <= plan.x1; xx++) {
    const t = w.idx(xx, zz);
    w.rail[t] = 1 << piece;
    w.signal[t] = 0;
    w.trees[t] = 0;
    game.stations.addTile(st, t, 1);
  }
  game.onNetworkChanged();
  game.lines.rebuild();
  return null;
}

export interface SimplePlan { ok: boolean; error?: string; cost: number; join?: Station | null; dir?: number; level?: number }

export function planBusStop(game: Game, x: number, z: number): SimplePlan {
  const w = game.world;
  if (!w.inBounds(x, z)) return { ok: false, error: 'Out of bounds', cost: 0 };
  const t = w.idx(x, z);
  const m = w.road[t];
  if (w.station[t] >= 0) return { ok: false, error: 'Already a station', cost: 0 };
  if (!(m === 0b0101 || m === 0b1010)) return { ok: false, error: 'Needs a straight road', cost: 0 };
  if (w.rail[t]) return { ok: false, error: 'Cannot build on a level crossing', cost: 0 };
  if (w.headAt(t, 0) >= 0 || w.headAt(t, 1) >= 0 || w.headAt(t, 2) >= 0 || w.headAt(t, 3) >= 0) return { ok: false, error: 'Cannot build on a bridge head', cost: 0 };
  return { ok: true, cost: COSTS.busStop, join: game.stations.findNear(x, z, x, z, 2) };
}

export function commitBusStop(game: Game, x: number, z: number): string | null {
  const p = planBusStop(game, x, z);
  if (!p.ok) return p.error!;
  if (!game.economy.spend(p.cost, 'construction')) return 'Not enough money';
  const st = p.join ?? game.stations.create(x, z);
  game.stations.addTile(st, game.world.idx(x, z), 2);
  game.onNetworkChanged();
  game.lines.rebuild();
  return null;
}

/** Find a depot orientation that connects to adjacent rail/road. */
export function autoDepotDir(game: Game, kind: 'rail' | 'road', x: number, z: number, fallback: number): number {
  const w = game.world;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d], nz = z + DZ[d];
    if (!w.inBounds(nx, nz)) continue;
    const n = w.idx(nx, nz);
    if (kind === 'rail' && w.railEdges(n) & (1 << OPP[d])) return d;
    if (kind === 'road' && w.road[n] & (1 << OPP[d])) return d;
  }
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d], nz = z + DZ[d];
    if (!w.inBounds(nx, nz)) continue;
    const n = w.idx(nx, nz);
    if (kind === 'road' && w.road[n] && w.station[n] < 0 && !w.rail[n]) return d;
  }
  return fallback;
}

export function planDepot(game: Game, kind: 'rail' | 'road', x: number, z: number, dir: number): SimplePlan {
  const w = game.world;
  if (!w.inBounds(x, z) || x < 1 || z < 1 || x >= w.size - 1 || z >= w.size - 1) return { ok: false, error: 'Out of bounds', cost: 0 };
  const t = w.idx(x, z);
  if (!w.isEmpty(t) || w.span[t] >= 0) return { ok: false, error: 'Tile is not free', cost: 0 };
  const c = w.corners(x, z);
  const mx = Math.max(...c);
  if (mx <= 0) return { ok: false, error: 'Cannot build on water', cost: 0 };
  let level = mx;
  // prefer the level of the edge facing the connection
  const nx = x + DX[dir], nz = z + DZ[dir];
  const el = w.edgeLevel(x, z, dir);
  if (!isNaN(el) && el > 0) level = el;
  let terra = 0;
  for (let k = 0; k < 4; k++) {
    if (c[k] === level) continue;
    if (cornerLocked(w, x + CORNER_DX[k], z + CORNER_DZ[k])) return { ok: false, error: 'Ground cannot be levelled', cost: 0 };
    terra += Math.abs(c[k] - level);
  }
  void nx; void nz;
  const cost = (kind === 'rail' ? COSTS.depotRail : COSTS.depotRoad) + terra * COSTS.terraform + (w.trees[t] & 15) * COSTS.tree;
  return { ok: true, cost, dir, level };
}

export function commitDepot(game: Game, kind: 'rail' | 'road', x: number, z: number, dir: number): string | null {
  const w = game.world;
  const p = planDepot(game, kind, x, z, dir);
  if (!p.ok) return p.error!;
  if (!game.economy.spend(p.cost, 'construction')) return 'Not enough money';
  for (let k = 0; k < 4; k++) w.setCorner(x + CORNER_DX[k], z + CORNER_DZ[k], p.level!);
  const t = w.idx(x, z);
  const id = w.nextDepotId++;
  w.depots.set(id, { id, kind, x, z, dir });
  w.depot[t] = id;
  w.trees[t] = 0;
  w.markTile(x, z);
  // connect road depots to the adjacent road automatically
  if (kind === 'road') {
    const nx = x + DX[dir], nz = z + DZ[dir];
    if (w.inBounds(nx, nz)) {
      const n = w.idx(nx, nz);
      if (w.road[n] && !(w.road[n] & (1 << OPP[dir])) && w.station[n] < 0 && !w.rail[n] &&
        World.shapeSupports(w.corners(nx, nz), w.road[n] | (1 << OPP[dir]))) {
        w.road[n] |= 1 << OPP[dir];
        w.markTile(nx, nz);
      }
    }
  }
  game.onNetworkChanged();
  return null;
}

export function toggleSignal(game: Game, x: number, z: number): string | null {
  const w = game.world;
  if (!w.inBounds(x, z)) return 'Out of bounds';
  const t = w.idx(x, z);
  if (!w.rail[t]) return 'No track here';
  if (w.station[t] >= 0) return 'Cannot place signals in stations';
  if (w.pieceCount(t) !== 1) return 'Signals need plain track (no junctions)';
  const cur = w.signal[t];
  const next = (cur + 1) % 4;
  if (cur === 0 && !game.economy.spend(COSTS.signal, 'construction')) return 'Not enough money';
  w.signal[t] = next;
  w.markTile(x, z);
  game.onNetworkChanged();
  return null;
}

export function removeSignal(game: Game, x: number, z: number) {
  const w = game.world;
  const t = w.idx(x, z);
  if (w.signal[t]) { w.signal[t] = 0; w.markTile(x, z); game.onNetworkChanged(); }
}

function removeStructure(game: Game, sid: number): boolean {
  const w = game.world;
  const s = w.structures.get(sid);
  if (!s) return true;
  if (game.vehicles.isStructureBusy(sid)) return false;
  const ta = w.idx(s.ax, s.az), tb = w.idx(s.bx, s.bz);
  w.heads.delete(ta * 4 + s.dir);
  w.heads.delete(tb * 4 + OPP[s.dir]);
  for (let k = 1; k <= s.span; k++) {
    const qx = s.ax + DX[s.dir] * k, qz = s.az + DZ[s.dir] * k;
    w.span[w.idx(qx, qz)] = -1;
    w.markTile(qx, qz);
  }
  w.structures.delete(sid);
  clearStructureCache(sid);
  w.markTile(s.ax, s.az); w.markTile(s.bx, s.bz);
  return true;
}

export interface BulldozeResult { cost: number; error: string | null; changed: number }

/** Estimate or perform demolition of a rectangle. */
export function bulldoze(game: Game, x0: number, z0: number, x1: number, z1: number, dryRun: boolean): BulldozeResult {
  const w = game.world;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  let cost = 0, changed = 0;
  let error: string | null = null;
  const touchedTowns = new Set<number>();
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (!w.inBounds(x, z)) continue;
    const t = w.idx(x, z);
    let c = 0;
    if (w.rail[t]) c += COSTS.removeRail * w.pieceCount(t);
    if (w.road[t] && !(w.station[t] >= 0 && w.stationKind[t] === 2)) c += COSTS.removeRoad;
    if (w.station[t] >= 0) c += COSTS.removeRail;
    if (w.depot[t] >= 0) c += COSTS.removeRail * 2;
    const b = w.building[t];
    if (b >= 0) c += (w.buildings[b]!.pop + 5) * COSTS.removeBuildingPerPop;
    if (w.trees[t] & 15) c += (w.trees[t] & 15) * COSTS.tree;
    if (c === 0 && ![0, 1, 2, 3].some((e) => w.headAt(t, e) >= 0)) continue;
    if (game.isTileBusy(t)) { error = 'Vehicle in the way'; continue; }
    if (w.depot[t] >= 0) {
      const id = w.depot[t];
      if (game.vehicles.all().some((v) => (v as any).depotId === id && !(v as any).onMap)) { error = 'Vehicles are in the depot'; continue; }
    }
    if (dryRun) { cost += c; changed++; continue; }
    // structures
    let blocked = false;
    for (let e = 0; e < 4; e++) {
      const sid = w.headAt(t, e);
      if (sid >= 0 && !removeStructure(game, sid)) { error = 'Vehicle on bridge or tunnel'; blocked = true; }
    }
    if (blocked) continue;
    cost += c;
    changed++;
    if (w.station[t] >= 0) {
      const kind = w.stationKind[t];
      game.stations.removeTile(t);
      if (kind === 1) { w.rail[t] = 0; w.signal[t] = 0; }
    } else {
      if (w.rail[t]) { w.rail[t] = 0; w.signal[t] = 0; }
      if (w.road[t]) {
        // detach neighbours' edges pointing here
        for (let d = 0; d < 4; d++) {
          if (!(w.road[t] & (1 << d))) continue;
          const n = w.neighbour(t, d);
          if (n < 0 || !(w.road[n] & (1 << OPP[d])) || w.headAt(t, d) >= 0) continue;
          w.road[n] &= ~(1 << OPP[d]);
          if (w.road[n] === 0) { w.roadOwner[n] = 0; w.townOf[n] = -1; }
          w.markTile(w.tx(n), w.tz(n));
        }
        w.road[t] = 0;
        w.roadOwner[t] = 0;
      }
    }
    if (w.depot[t] >= 0) { w.depots.delete(w.depot[t]); w.depot[t] = -1; }
    if (b >= 0) {
      const bb = w.buildings[b]!;
      const town = game.towns.list[bb.townId];
      if (town) { town.buildings.delete(b); touchedTowns.add(town.id); }
      w.removeBuilding(b);
    }
    w.trees[t] = 0;
    if (w.road[t] === 0 && w.building[t] < 0) w.townOf[t] = -1;
    w.markTile(x, z);
  }
  if (!dryRun) {
    if (cost > 0) game.economy.spend(cost, 'construction', true);
    for (const id of touchedTowns) game.towns.recomputePop(game.towns.list[id]);
    if (changed) game.onNetworkChanged();
  }
  return { cost, error, changed };
}

export function terraformCorner(game: Game, cx: number, cz: number, delta: number, dryRun = false): { ok: boolean; error?: string; cost: number } {
  const w = game.world;
  if (cx < 1 || cz < 1 || cx >= w.size || cz >= w.size) return { ok: false, error: 'Cannot modify map edge', cost: 0 };
  if (cornerLocked(w, cx, cz)) return { ok: false, error: 'Construction in the way', cost: 0 };
  const h = w.cornerH(cx, cz) + delta;
  if (h < -3 || h > 60) return { ok: false, error: 'Height limit reached', cost: 0 };
  const cost = COSTS.terraform;
  if (dryRun) return { ok: true, cost };
  if (!game.economy.spend(cost, 'construction')) return { ok: false, error: 'Not enough money', cost };
  w.setCorner(cx, cz, h);
  return { ok: true, cost };
}

export function levelArea(game: Game, cx0: number, cz0: number, cx1: number, cz1: number, level: number, dryRun = false): { cost: number; skipped: number; error?: string } {
  const w = game.world;
  if (cx0 > cx1) [cx0, cx1] = [cx1, cx0];
  if (cz0 > cz1) [cz0, cz1] = [cz1, cz0];
  let cost = 0, skipped = 0;
  const changes: [number, number][] = [];
  for (let cz = Math.max(1, cz0); cz <= Math.min(w.size - 1, cz1); cz++) for (let cx = Math.max(1, cx0); cx <= Math.min(w.size - 1, cx1); cx++) {
    const h = w.cornerH(cx, cz);
    if (h === level) continue;
    if (cornerLocked(w, cx, cz)) { skipped++; continue; }
    cost += Math.abs(h - level) * COSTS.terraform;
    changes.push([cx, cz]);
  }
  if (dryRun) return { cost, skipped };
  if (!game.economy.canAfford(cost)) return { cost, skipped, error: 'Not enough money' };
  game.economy.spend(cost, 'construction');
  for (const [cx, cz] of changes) w.setCorner(cx, cz, level);
  return { cost, skipped };
}

export function isFlat(w: World, x: number, z: number) { return w.slope(x, z) === SLOPE_FLAT; }
