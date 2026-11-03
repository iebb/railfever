// Native road-project work carried across fixed-step saves. Cursor data is ordinary JSON.
import type { Game } from './game';
import type { DepotPlan } from './build-ops';
import { distToRect } from './world';
import { roadDepotAtDeadEnd, type OPoint, type RouteCursor, type RoutePlan } from './routing';
import type { RoadPlan, RoadBuildCursor, RoadMarketCursor } from './ai-bus';
import type { NEdge, NNode } from './network';
import type { VehicleModel } from './vehicle-types';
import type { SelectionDemand } from './ai-selection';
import type { Depot } from './build-ops';
import type { Line } from './lines';
import type { AIChainCursor } from './ai-chain-job';
import type { Town } from './towns';
import { type Proposal, type Snap, type BuildOptions, findSnap, planEdge } from './construction';
import { WATER_Y } from './constants';
import { endTangent } from './geom';

/** Native asset IDs are never reused. Retain Map order, skip removals and visit later additions once. */
export interface RoadMapCursor { ids: number[] | null; at: number; visited: Set<number> }
export const newRoadMapCursor = (): RoadMapCursor => ({ ids: null, at: 0, visited: new Set() });
export function nextRoadMapValue<T>(map: ReadonlyMap<number, T>, c: RoadMapCursor): T | undefined {
  c.ids ??= [...map.keys()];
  while (true) {
    while (c.at < c.ids.length) {
      const id = c.ids[c.at++]; c.visited.add(id);
      const value = map.get(id);
      if (value !== undefined) return value;
    }
    // A live native Map iterator also visits assets appended during a nested quote. Scan only at its frontier.
    const added = [...map.keys()].filter(id => !c.visited.has(id));
    if (!added.length) return undefined;
    c.ids.push(...added);
  }
}

export interface RoadMarketTask {
  version: 1; kind: 'market'; stage: 'init' | 'plan' | 'build' | 'done';
  projectKind: string; where: string; plan: RoadPlan | null; market?: RoadMarketCursor; build: RoadBuildCursor;
}
export interface RoadBusCandidate { x: number; z: number; d: number; rail?: boolean }
export interface NativeBusTask {
  version: 1; kind: 'bus'; town: number;
  stage: 'init' | 'candidate' | 'inspect' | 'choose' | 'stops' | 'stopCommit' | 'stopLink' | 'stopFinish'
    | 'depot' | 'line' | 'vehicles' | 'finish' | 'done';
  streets: NEdge[]; at: number; candidates: RoadBusCandidate[]; model?: VehicleModel;
  stops: RoadBusCandidate[]; ring: boolean; ids: number[]; before: number; sid: number;
  depot: number; depotSearch?: RoadDepotCursor; firstEdge: number; line: number; openedLine?: Line; vehicles: number;
}
export interface CoachStopCursor {
  stage: 'init' | 'street' | 'inspect' | 'rival' | 'candidate' | 'score' | 'done';
  streets: NEdge[]; at: number; candidates: { x: number; z: number; d: number }[];
  scan: RoadMapCursor; rival: Set<number>; best: { x: number; z: number; d: number } | null; bestScore: number;
  result?: { x: number; z: number } | null;
}
export const newCoachStopCursor = (): CoachStopCursor => ({ stage: 'init', streets: [], at: 0, candidates: [], scan: newRoadMapCursor(), rival: new Set(), best: null, bestScore: -Infinity });
export interface NativeCoachTask {
  version: 1; kind: 'coach'; a: number; b: number;
  stage: 'init' | 'a' | 'b' | 'service' | 'forecast' | 'demand' | 'value' | 'stops' | 'stopCommit' | 'stopLink'
    | 'stopFinish' | 'depot' | 'reachA' | 'reachB' | 'line' | 'vehicles' | 'finish' | 'done';
  model?: VehicleModel; stop: CoachStopCursor; sa?: { x: number; z: number } | null; sb?: { x: number; z: number } | null;
  cost: number; quoted: number;
  service?: { seats: number; perPax: number; running: number; trackUpkeep: number; headway: number; kmh: number };
  forecast?: ReturnType<Game['demand']['forecastLine']>; demand?: SelectionDemand;
  market?: { market: number; carried: number }; free: number;
  at: number; ids: number[]; before: number; sid: number; firstEdge: number;
  depot: number; depotSearch?: RoadDepotCursor; capturedDepot?: Depot;
  line?: Line; bought: number;
}
export interface TownExitResult { prop: Proposal; x: number; z: number; tx: number; tz: number }
export interface TownExitCursor {
  stage: 'init' | 'candidate' | 'inspect' | 'verify' | 'done'; at: number;
  candidates: { sn: Snap; tx: number; tz: number; score: number }[];
  x: number; z: number; plan?: Proposal; result?: TownExitResult | null;
}
export const newTownExitCursor = (): TownExitCursor => ({ stage: 'init', at: 0, candidates: [], x: 0, z: 0 });
export interface NativeRoadTask {
  version: 1; kind: 'road'; a: number; b: number;
  stage: 'init' | 'direction' | 'a' | 'b' | 'routeStart' | 'route' | 'chainStart' | 'chain' | 'done';
  ux: number; uz: number; exit: TownExitCursor; xa?: TownExitResult | null; xb?: TownExitResult | null;
  from?: OPoint; to?: OPoint; gap: number; route?: RouteCursor; plan?: RoutePlan;
  firstEdge: number; nA?: NNode; nB?: NNode;
  /** The native paid-chain cursor is supplied by the shared AI chain adapter. */
  chain?: AIChainCursor;
}
export type RoadControllerTask = RoadMarketTask | NativeBusTask | NativeCoachTask | NativeRoadTask;

/** Town exits preserve both the selected street snap and the already-quoted proposal between native yields. */
export function* townExitSteps(g: Game, owner: number, T: Town, ux: number, uz: number, c: TownExitCursor): Generator<void, TownExitResult | null> {
  const net = g.world.net;
  const so: BuildOptions = { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner };
  while (true) {
    if (c.stage === 'done') return c.result!;
    if (c.stage === 'init') {
      const cands = c.candidates;
      for (const e of g.towns.streets(T, 4)) for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid)!;
        if (n.edges.length !== 1) continue;
        const along = (n.x - T.x) * ux + (n.z - T.z) * uz, lat = Math.abs((n.x - T.x) * uz - (n.z - T.z) * ux);
        const d = net.leaveDir(e, nid), tx = -d.x, tz = -d.z, facing = tx * ux + tz * uz;
        if (along < -5 || lat > 30 || facing < 0.5) continue;
        cands.push({ sn: { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }, tx, tz, score: along - lat * 0.5 + facing * 20 });
      }
      const pts: { x: number; z: number; along: number }[] = [];
      for (const e of g.towns.streets(T, 4)) {
        const geo = net.geo(e);
        for (let i = 2; i < geo.n - 2; i += 6) {
          const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
          const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
          if (lat < 20 && along > 0) pts.push({ x, z, along });
        }
      }
      pts.sort((p, q) => q.along - p.along);
      for (const q of pts.slice(0, 6)) {
        const sn = findSnap(g, 'road', q.x, q.z, 0.4);
        if (sn.kind !== 'free') cands.push({ sn, tx: ux, tz: uz, score: q.along - 1000 });
      }
      cands.sort((p, q) => q.score - p.score); c.candidates = cands.slice(0, 10);
      c.stage = 'candidate'; continue;
    }
    if (c.stage === 'candidate') {
      if (c.at >= c.candidates.length) { c.stage = 'done'; c.result = null; continue; }
      c.stage = 'inspect'; yield; continue;
    }
    if (c.stage === 'inspect') {
      const candidate = c.candidates[c.at];
      c.x = candidate.sn.x + candidate.tx * 8; c.z = candidate.sn.z + candidate.tz * 8;
      if (!g.world.inside(c.x, c.z, 6) || g.world.heightAt(c.x, c.z) < WATER_Y + 0.2) { c.at++; c.stage = 'candidate'; continue; }
      c.plan = planEdge(g, candidate.sn, { kind: 'free', x: c.x, z: c.z, y: 0 }, so);
      c.stage = 'verify'; yield; continue;
    }
    if (c.stage === 'verify') {
      const pj = c.plan!;
      if (pj.ok && pj.demolish.length <= 2 && pj.stats.minRadius >= 3) {
        const end = endTangent(pj.tracks[0].bez);
        c.result = { prop: pj, x: c.x, z: c.z, tx: end.x, tz: end.z }; c.stage = 'done'; continue;
      }
      c.at++; c.stage = 'candidate'; continue;
    }
    throw new Error('Invalid town exit continuation stage');
  }
}

/** The next site/commit in AIController's road depot search (not the synchronous player search). */
export interface RoadDepotCursor {
  version: 1;
  stage: 'site' | 'inspect' | 'commit' | 'done';
  x: number; z: number;
  maxPop: number; r: number; k: number;
  plan?: DepotPlan;
  result?: number;
}

export function newRoadDepotCursor(x: number, z: number): RoadDepotCursor {
  return { version: 1, stage: 'site', x, z, maxPop: 0, r: 2.5, k: 0 };
}

function nextDepotSite(c: RoadDepotCursor) {
  delete c.plan;
  if (++c.k >= 12) {
    c.k = 0;
    c.r += 1.5;
    if (c.r >= 26) {
      c.r = 2.5;
      if (c.maxPop) { c.stage = 'done'; c.result = -1; return; }
      c.maxPop = 30;
    }
  }
  c.stage = 'site';
}

/** Identical native site order and yield-before-inspect / yield-before-commit boundaries. */
export function* roadDepotSteps(g: Game, owner: number, canAfford: (cost: number) => boolean, c: RoadDepotCursor): Generator<void, number> {
  const net = g.world.net;
  while (true) {
    if (c.stage === 'done') return c.result!;
    if (c.stage === 'site') { c.stage = 'inspect'; yield; continue; }
    if (c.stage === 'inspect') {
      const a = ((c.k + (c.r % 2) * 0.5) / 12) * Math.PI * 2;
      const px = c.x + Math.sin(a) * c.r, pz = c.z + Math.cos(a) * c.r;
      if (!c.maxPop && g.world.buildingsNear(px, pz, 2.2).some(b => distToRect(px, pz, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 1.3)) { nextDepotSite(c); continue; }
      const ne = net.nearestEdge(px, pz, 3.6, 'road', e => e.depot < 0 && e.station < 0);
      if (!ne || ne.d < 2.1 || net.sectionAt(ne.edge, ne.s) !== 'ground') { nextDepotSite(c); continue; }
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(ne.edge, ne.s, q);
      c.plan = g.depots.plan('road', px, pz, Math.atan2(q.x - px, q.z - pz), owner);
      c.stage = 'commit';
      yield;
      continue;
    }
    if (c.stage === 'commit') {
      const plan = c.plan!;
      if (!plan.ok || !canAfford(plan.cost + 40000) || roadDepotAtDeadEnd(g, plan)) { nextDepotSite(c); continue; }
      const dem = plan.demolish ?? [];
      if (dem.length > (c.maxPop ? 1 : 0) || dem.some(id => (g.world.buildings.get(id)?.pop ?? 0) > c.maxPop)) { nextDepotSite(c); continue; }
      const id = g.depots.nextId;
      if (g.depots.commit('road', plan, owner)) { nextDepotSite(c); continue; }
      const dp = g.depots.get(id), exit = dp ? net.nodes.get(dp.node) : undefined;
      if (dp && exit && exit.edges.length >= 2) { c.stage = 'done'; c.result = id; return id; }
      if (dp) g.depots.remove(id);
      nextDepotSite(c);
      continue;
    }
    throw new Error('Invalid road depot continuation stage');
  }
}
