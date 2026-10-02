// Helpers for the station / signal / double-track tests (synthetic flat maps, straight lines, train runs).
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train, railNext } from '../src/game/train';
import type { Station } from '../src/game/stations';
import type { NEdge } from '../src/game/network';
import { fails, check, fmt, build, free, railOpts } from './lib';
import { nodeSnap, buildRailDepot, stationEnds } from '../src/game/routing';

export { fails, check, fmt, build, free, railOpts, nodeSnap };

/** A game on flat land (height `h`) without towns or trees; `shape` may sculpt the terrain. */
export function flatGame(size = 256, h = 3, shape?: (x: number, z: number) => number): Game {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 });
  g.economy.money = 400_000_000;
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = shape ? shape(x, z) : h;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  return g;
}

/** Commit a rail station; returns it (or null with the reason logged). */
export function station(g: Game, x: number, z: number, angle: number, length: number, tracks: number, owner = 0, opts: Parameters<Game['stations']['planRail']>[6] = {}): Station | null {
  const p = g.stations.planRail(x, z, angle, length, tracks, owner, opts);
  if (!p.ok) { console.log(`  station at ${fmt(x)},${fmt(z)} failed: ${p.error}`); return null; }
  const id = g.stations.nextId;
  const err = g.stations.commitRail(p, owner);
  if (err) { console.log('  commitRail:', err); return null; }
  return g.stations.get(p.join ? p.join.id : id) ?? null;
}

/** Front (+axis) / back node of a station track (lateral order). */
export function endNode(g: Game, st: Station, track: number, front: boolean): number {
  const e = stationEnds(g, st)[track];
  return front ? e.front : e.back;
}

/** Rail edges created since edge id `from` that are plain track (not station/depot). */
export function newTrack(g: Game, from: number, owner = 0): number[] {
  const out: number[] = [];
  for (const [id, e] of g.world.net.edges) if (id >= from && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0) out.push(id);
  return out;
}

export const loco = () => [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!];

export function depotFor(g: Game, st: Station, toward: { x: number; z: number }, owner = 0): number {
  return buildRailDepot(g, st, owner, { x: toward.x - st.x, z: toward.z - st.z });
}

/**
 * Run the game for `days`, counting station arrivals per train, the longest spell (days) a train waited at a
 * signal or had no route, and the day each train first left its depot (-1: never).
 */
export function runTrains(g: Game, trains: Train[], days: number) {
  const arrivals = new Map<number, number[]>();
  const lastState = new Map<number, string>();
  const spell = new Map<number, { kind: string; since: number }>();
  const left = new Map<number, number>();
  let worst = { id: -1, kind: '', days: 0 };
  for (let i = 0; i < days * 8; i++) {
    g.update(0.25);
    for (const t of trains) {
      if (t.state === 'loading' && lastState.get(t.id) !== 'loading') { const a = arrivals.get(t.id) ?? []; a.push(t.atStation); arrivals.set(t.id, a); }
      lastState.set(t.id, t.state);
      if (t.onMap && !left.has(t.id)) left.set(t.id, g.day);
      const bad = t.state === 'waiting' || t.state === 'noroute';
      const sp = spell.get(t.id);
      if (bad) {
        if (!sp || sp.kind !== t.state) spell.set(t.id, { kind: t.state, since: g.day });
        else if (g.day - sp.since > worst.days) worst = { id: t.id, kind: t.state + ' ' + t.status, days: g.day - sp.since };
      } else spell.delete(t.id);
    }
  }
  return { arrivals, worst, left: trains.map((t) => left.get(t.id) ?? -1) };
}

/** Edges reachable from (edge, dir) following railNext (signals and access respected), up to `max` edges. */
export function reach(g: Game, e: NEdge, dir: number, owner = 0, max = 4000): Set<number> {
  const seen = new Set<string>(), out = new Set<number>();
  const stack: { e: NEdge; d: number }[] = [{ e, d: dir }];
  while (stack.length && seen.size < max) {
    const c = stack.pop()!;
    const k = c.e.id + ':' + c.d;
    if (seen.has(k)) continue;
    seen.add(k); out.add(c.e.id);
    for (const n of railNext(g, c.e, c.d, owner)) stack.push({ e: n.edge, d: n.dir });
  }
  return out;
}

export function done() {
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
