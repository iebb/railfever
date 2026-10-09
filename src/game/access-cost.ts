// Pure annual access quotes. Billing and planners use the same prices and per-item ceiling.
import type { Game } from './game';
import type { NEdge } from './network';
import type { Station } from './stations';
import { BASE_INTEREST_RATE } from './economy';
import { PSTEP, TRACK_TYPES, TRAM } from './constants';
import { arcTable, bezPoint, tAtS } from './geom';
import { profAt } from './network';
import { trackMaterialCost, trackEarthworksCost } from './construction';
import { entranceCost, ENTRANCE_COST, stationPlatformCost, stationLevelCost, stationBuildingCost } from './stations';
import { styleOf } from './station-styles';
import { stationPlatformLength, stationPose } from './station-geometry';

export const DEFAULT_ACCESS_MULTIPLIER = 1.25;
export const MAX_ACCESS_MULTIPLIER = 2;
export const ACCESS_CAP = 0.75;
export const ACCESS_YEARS = 30;
export const ACCESS_ANNUITY = BASE_INTEREST_RATE / (1 - Math.pow(1 + BASE_INTEREST_RATE, -ACCESS_YEARS));
/** The saved slot keeps its old name, but now holds a price factor. */
export function migrateAccessMultiplier(m: number): number { return Math.max(0, Math.min(3, Number.isFinite(m) ? m : 2)) * 0.625; }

export type AccessItem = NEdge | Station | { tram: NEdge };
export function accessItemKey(item: AccessItem): number {
  return 'tram' in item && typeof item.tram === 'object' ? item.tram.id * 4 + 1 : 'stops' in item ? item.id * 4 + 2 : (item as NEdge).id * 4;
}
export function accessItemOwner(item: AccessItem): number {
  return 'tram' in item && typeof item.tram === 'object' ? item.tram.tramOwner ?? -1 : (item as NEdge | Station).owner;
}

const quotes = new WeakMap<Game, { epoch: string; costs: Map<number, number> }>();
/** Stand-alone replacement: current geometry, without historical demolition or neighbouring formation discounts. */
export function accessReplacementCost(g: Game, item: AccessItem): number {
  const w = g.world, epoch = `${w.net.version}:${w.heightsVersion}:${g.stations.walkVersion}:${g.stations.map.size}`;
  let cache = quotes.get(g);
  if (!cache || cache.epoch !== epoch) { cache = { epoch, costs: new Map() }; quotes.set(g, cache); }
  const key = accessItemKey(item), hit = cache.costs.get(key);
  if (hit !== undefined) return hit;
  let cost = 0;
  if ('tram' in item && typeof item.tram === 'object') cost = item.tram.len * TRAM.costPerUnit;
  else if ('stops' in item) {
    cost = item.stops.length * 30000;
    const r = item.rail;
    if (r) {
      const platforms = stationPlatformLength(r);
      const through = r.alignment ? r.alignment.tracks.filter(t => r.throughOffsets.includes(t.offset)).reduce((n, t) => n + t.length, 0) : r.through * r.length;
      // Running rail has its own edge charge. Price the platform facility as construction on retained rail,
      // so a station built with its tracks does not recover the same rail capital twice.
      const base = stationPlatformCost(platforms, through, true);
      if (r.level === 'ground') {
        let lo = Infinity, hi = -Infinity;
        for (let a = -0.5; a <= 0.5; a += 0.125) for (let b = -0.5; b <= 0.5; b += 0.25) {
          const p = stationPose(r, r.width * b, r.length * a), h = w.heightAt(p.x, p.z);
          lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
        cost += base - stationBuildingCost('classic') + stationBuildingCost(r.style) + (hi - lo) * r.length * r.width * 600;
      } else {
        cost += stationLevelCost(base - stationBuildingCost('classic'), r.level, r.depth, r.height);
        if (styleOf(r.style).placement !== 'none') cost += stationBuildingCost(r.style);
      }
      if (r.psd) cost += platforms * 2500;
      for (const e of r.entrances) cost += e.kind ? entranceCost(e.kind, r) : r.level === 'ground' ? 0 : ENTRANCE_COST[r.level];
    }
  } else {
    const e = item as NEdge, tab = arcTable(e.bez), p = { x: 0, z: 0 };
    for (let s0 = 0; s0 < e.len; s0 += PSTEP) {
      const ds = Math.min(PSTEP, e.len - s0), sm = s0 + ds / 2;
      bezPoint(e.bez, tAtS(tab, sm), p);
      const rise = profAt(e.prof, e.len, sm) - w.heightAt(p.x, p.z);
      const section = e.sections.find(s => sm >= s.s0 && sm <= s.s1)?.type ?? null;
      cost += ds * trackMaterialCost(e.kind, e.type, section, section === 'tunnel' ? -rise : rise);
      if (!section) cost += trackEarthworksCost(rise, w.net.halfWidth(e), ds, TRACK_TYPES[e.type]?.formation ?? 1);
    }
  }
  cost = Math.round(cost);
  cache.costs.set(key, cost);
  return cost;
}

export function accessFullCost(g: Game, item: AccessItem): number {
  const maintenance = 'tram' in item && typeof item.tram === 'object' ? item.tram.len * TRAM.maintPerUnit
    : 'stops' in item ? g.stationMaintenance(item) : g.edgeMaintenance(item as NEdge);
  return accessReplacementCost(g, item) * ACCESS_ANNUITY + maintenance;
}

/** Annual cost. Wear is the user's own annual wear, reimbursed in full even at a zero price factor. */
export function accessChargeEstimate(g: Game, user: number, owner: number, items: Iterable<AccessItem>, share: number | ((item: AccessItem) => number), wear = 0): number {
  if (user === owner || owner < 0) return 0;
  let charge = 0;
  const seen = new Set<number>(), p = g.accessMultiplier(owner);
  for (const item of items) {
    const key = accessItemKey(item);
    if (seen.has(key) || accessItemOwner(item) !== owner) continue;
    seen.add(key);
    const use = typeof share === 'number' ? share : share(item), s = Number.isFinite(use) ? Math.max(0, Math.min(1, use)) : 0;
    charge += Math.min(s * p, ACCESS_CAP) * accessFullCost(g, item);
  }
  return charge + (Number.isFinite(wear) ? Math.max(0, wear) : 0);
}
