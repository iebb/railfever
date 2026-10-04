// City lines that grow with their towns (linegrow). A city railway's termini stay free ends it can be extended from
// (ai.ts urbanJob: the depot ramp branches off a short tail beside the line's straight continuation; terminusOf tells
// what lies beyond a terminus), and the AI network task 'extend' (ai-network.ts runs growTask) reviews the company's
// city lines as their towns grow:
//  - beyond a terminus: residents along the line's onward direction that no rail station reaches on foot get one to
//    three new stations, and the terminus becomes a through stop (a depot lead in the way goes: its depot moves out to a
//    yard beside the new terminus, the trains in the depot with it);
//  - infill: a stop in a long gap between two stations where the town has filled in;
// each valued by the demand model's line forecast against its works, trains and upkeep (incentives, not rules: an
// option is built when its operating surplus repays it within the urban payback horizon, the best one the company can
// pay for now first), at the line's level or underground (nothing above to demolish) where that comes out better. The
// work item's cursor (the survey, the options valued one a work unit, then the winner's build in steps: its stations
// one a unit, the track to them, the line running on) is saved with the planner and replays exactly; a step that
// fails takes up what the build laid and refunds it.
import type { Game } from './game';
import type { AIController } from './ai';
import { scheduleNetworkTask } from './ai-network';
import type { Station, StationPlan, StationLevel, RailMode } from './stations';
import type { Line } from './lines';
import type { Snap, BuildOptions, Proposal } from './construction';
import type { VehicleModel } from './vehicle-types';
import type { Train } from './train';
import type { OnTrackPlan } from './trackops';
import { CATCHMENT_RADIUS, railPartMode, STATION_DEPTH, STATION_HEIGHT, CITY_WALK_SCALE, STATION_UPKEEP_FACTOR } from './stations';
import { TRACK_TYPES, UNIT_M, URBAN_PAYBACK, discountedPayback, DAY_SECONDS, trackTypeOf } from './constants';
import { onwardCentres } from './ai-urban';
import { planEdge, commitProposal } from './construction';
import { WALK_DETOUR, walkingCatchment } from './catchment';
import { linearStops, outAndBack } from './lines';
import { depotFits, depotAtEnd, nodeSnap, nodeAt, stationEnds } from './routing';
import { findRailRoute, railNext, depotServes, consistRule } from './train';
import { marginalSharedTrain } from './ai-capacity';
import { endTangent } from './geom';
import { finishDoubleTrack, planDoubleTrackFinish, doubleTrackCrossoverGap, planStationOnTrack, commitStationOnTrack } from './trackops';
import { linePatterns, patternHeadways } from './patterns';
import { estimateVehicleYear, trackBasePerUnit, YEAR_S } from './opcosts';
import * as Subway from './subway';
import { demolitionCost } from './demolition';

// ============================================================================ reach and spacing

/**
 * Walking radius (units) of a city rail station of style `mode` at (x, z): the reach the stations of a growing line are
 * spaced and searched by, and residents counted within.
 * city-integration: the citycatch branch gives in-city metro and light-rail stations half the rail walking radius;
 * Apply the same saved-station rule to prospective stops at their new sites.
 */
export function cityStationRadius(g: Game, x: number, z: number, mode: RailMode): number {
  const city = mode !== 'mainline' && g.stations.cityAt(x, z, g.towns.nearest(x, z));
  return CATCHMENT_RADIUS.rail * (city ? CITY_WALK_SCALE : 1);
}

/**
 * The track a line's new pieces are laid with: copied from the line's own running track beside one of its stations
 * (its type), and the station style its new stations take from that station (railPartMode; planRail's platform type).
 * city-integration: the one-track branch (wip/onetrack) makes track one type, the overhead wire an attribute and the
 * style a station-part property: copy the running track's wire into the build options and pass the style to planRail.
 */
export interface LineTrack { type: string; platform: string; mode: RailMode; minRadius: number; maxGrade: number; costPerUnit: number; speed: number }
export function lineTrackAt(g: Game, st: Station): LineTrack {
  const net = g.world.net, r = st.rail!;
  let type = trackTypeOf(r.trackType);
  find: for (const t of g.stations.trackEnds(st)) for (const nid of [t.front, t.back]) for (const id of net.nodes.get(nid)?.edges ?? []) {
    const e = net.edges.get(id);
    if (e && e.kind === 'rail' && e.station < 0 && e.depot < 0 && TRACK_TYPES[e.type]) { type = TRACK_TYPES[type]?.electrified || TRACK_TYPES[e.type]?.electrified ? 'electric' : trackTypeOf(e.type); break find; }
  }
  const tt = TRACK_TYPES[type] ?? TRACK_TYPES.standard;
  return { type, platform: type, mode: railPartMode(r), minRadius: tt.minRadius, maxGrade: tt.maxGrade, costPerUnit: tt.costPerUnit, speed: tt.speed };
}

/**
 * Spacing (units, centre to centre) of the stations of a growing city line: by walking reach (subway style about three
 * quarters of a walk, light-rail style a little less, main-line style about one), never closer than the platforms and
 * the crossovers before a terminus allow (ai.ts urbanLayout's rule).
 */
export function cityStationSpacing(g: Game, x: number, z: number, track: LineTrack, platform: number): number {
  const mode = track.mode;
  const floor = platform + Math.max(track.minRadius * 2 + 2, 18);
  return Math.max(floor, cityStationRadius(g, x, z, mode) * WALK_DETOUR * (mode === 'metro' ? 0.72 : mode === 'lightrail' ? 0.6 : 1.1));
}

/** Ramp length (units) from a line's level up or down to the ground for a depot (as ai.ts urbanJob). */
const rampLength = (level: StationLevel) => (level === 'underground' ? 58 : level === 'elevated' ? 26 : 10);
/** Straight tail beyond a terminus's outer platform track that a yard's ramp branches off (ai.ts URBAN_TAIL). */
const TAIL = 4;
/** Within this distance of the new track's start (units) the planner lets a branch run alongside (construction.ts SWITCH_ZONE). */
const SWITCH_ZONE = 14;

// ============================================================================ city-integration: subways (wip/subway)

/** An underground depot planned off a free track end (wip/subway's SubwayYardPlan): a tunnel stub and the cavern at its end. */
interface SubwayYard { ok: boolean; error?: string; x: number; z: number; y: number; length: number; dx: number; dz: number; depth: number; stubCost: number; depotCost: number; cost: number }
/** What this module uses of the subway branch's planners (its src/game/subway.ts; subway-api.md). */
interface SubwayApi {
  /** build options of a track that stays in its tunnel the whole way */
  subwayOpts(type: string, tracks: number, owner: number, depth: number): BuildOptions;
  /** a tunnel stub off a free track end (turned aside by `lat`, units left of the way out) and the depot cavern beyond */
  planSubwayYard(g: Game, start: { x: number; y: number; z: number; dx: number; dz: number; node?: number }, owner: number,
    opts?: { type?: string; depth?: number; lengths?: number[]; lat?: number }): SubwayYard;
  /** build it from that free end; the depot id, or -1 with nothing left behind */
  buildSubwayYard(g: Game, node: number, yard: SubwayYard, owner: number, type?: string): number;
}
/**
 * An extension's track between underground stations stays in
 * its tunnels (no portal in town: linkOpts), and the yard a depot moves to at a new underground terminus may be a cavern
 * off the tail turning aside (planTerminusYard) where that is cheaper than a ramp up to a depot on the surface.
 */
const SUBWAY: SubwayApi = Subway;

// ============================================================================ termini

/** What lies beyond one end of a terminus's platforms (see terminusOf). */
export interface TerminusEnd {
  station: number;
  end: 'front' | 'back';
  /** outward unit direction along the platforms */
  ux: number; uz: number;
  /** the platform tracks' end nodes there, ordered by `lat`: their offset to the left of the outward direction (construction.ts groups) */
  heads: number[];
  lat: number[];
  /**
   * free: nothing beyond the platforms; tail: one outer track runs on straight and level to a fork whose branch (a spur
   * to depots of ours: the yard's ramp) turns off clear of the line's straight continuation, the other tracks end at
   * the platforms; lead: own plain track to own depots only, in the way on; other: anything else (junctions, other
   * companies' track).
   */
  kind: 'free' | 'tail' | 'lead' | 'other';
  /** tail: the head it starts from (index into heads), the fork node and the tail's length */
  root: number; fork: number; tail: number;
  /** lead / tail: the spur's track beyond the platforms or the fork, and its depots (they move out when the line runs on) */
  lead: number[]; depots: number[];
}

/** The end of station `T`'s platforms facing away from its neighbour `N` on a line. */
export function outerEnd(T: Station, N: Station): 'front' | 'back' {
  const r = T.rail!;
  return Math.sin(r.angle) * (T.x - N.x) + Math.cos(r.angle) * (T.z - N.z) >= 0 ? 'front' : 'back';
}

/**
 * What lies beyond the `end` of a station's platform tracks (owner's view): nothing, a tail with a branch clear of the
 * straight continuation (the line can run on beside it), a depot lead to move first, or something else.
 */
export function terminusOf(g: Game, st: Station, end: 'front' | 'back', owner: number): TerminusEnd | null {
  const net = g.world.net, r = st.rail;
  if (!r) return null;
  const sg = end === 'front' ? 1 : -1, ux = Math.sin(r.angle) * sg, uz = Math.cos(r.angle) * sg, lx = -uz, lz = ux;
  const hs = g.stations.trackEnds(st).map((t) => t[end]).filter((id) => net.nodes.has(id))
    .map((id) => { const n = net.nodes.get(id)!; return { id, lat: (n.x - r.x) * lx + (n.z - r.z) * lz }; })
    .sort((a, b) => a.lat - b.lat);
  const res: TerminusEnd = { station: st.id, end, ux, uz, heads: hs.map((h) => h.id), lat: hs.map((h) => h.lat), kind: 'free',
    root: -1, fork: -1, tail: 0, lead: [], depots: [] };
  if (!hs.length || r.throughEdges.length) { res.kind = 'other'; return res; }
  const own = new Set([...r.edges, ...r.throughEdges]);
  const beyond = hs.map((h) => (net.nodes.get(h.id)?.edges ?? []).filter((id) => !own.has(id)));
  if (beyond.every((b) => !b.length)) return res;
  // a tail: one outer track on straight and level to a fork, the others free
  const used = beyond.map((b, i) => (b.length ? i : -1)).filter((i) => i >= 0);
  if (used.length === 1 && (used[0] === 0 || used[0] === hs.length - 1) && beyond[used[0]].length === 1) {
    const k = used[0], e = net.edges.get(beyond[k][0]), n0 = net.nodes.get(hs[k].id)!;
    if (e && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0 && e.len >= 1.5 && e.len <= 10) {
      const far = net.nodes.get(e.a === n0.id ? e.b : e.a)!;
      const along = (far.x - n0.x) * ux + (far.z - n0.z) * uz, side = (far.x - n0.x) * lx + (far.z - n0.z) * lz;
      if (Math.abs(side) < 0.06 && Math.abs(along - e.len) < 0.1 && Math.abs(far.y - n0.y) < 0.06 && far.edges.length === 2
        && branchClear(g, st, res, k, far.id, e.id)) {
        const spur = depotSpur(g, [far.id], new Set([e.id]), owner);
        if (spur) return { ...res, kind: 'tail', root: k, fork: far.id, tail: e.len, lead: spur.edges, depots: spur.depots };
      }
    }
  }
  // a depot lead: own plain track to own depots only
  const spur = depotSpur(g, hs.map((h) => h.id), own, owner);
  return spur ? { ...res, kind: 'lead', lead: spur.edges, depots: spur.depots } : { ...res, kind: 'other' };
}

/**
 * Own plain track from nodes `from` (not over the edges in `skip`) that leads to own depots only (no dead end, no
 * station, no other company's track, at most 400 units): its edges and depots, or null.
 */
function depotSpur(g: Game, from: number[], skip: Set<number>, owner: number): { edges: number[]; depots: number[] } | null {
  const net = g.world.net, seen = new Set(skip), nodes = new Set(from), stack = [...from], edges: number[] = [], depots: number[] = [];
  let length = 0;
  while (stack.length) {
    const n = net.nodes.get(stack.pop()!);
    if (!n) return null;
    for (const id of n.edges) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || g.stations.throughStationOf(e.id) >= 0) return null;
      if (e.depot >= 0) {
        const d = g.depots.get(e.depot);
        if (!d || d.owner !== owner) return null;
        if (!depots.includes(d.id)) depots.push(d.id);
        continue;
      }
      edges.push(e.id);
      length += e.len;
      const o = e.a === n.id ? e.b : e.a;
      if (!nodes.has(o)) { nodes.add(o); stack.push(o); }
    }
    if (length > 400) return null;
  }
  for (const nid of nodes) if (!from.includes(nid) && (net.nodes.get(nid)?.edges.length ?? 0) < 2) return null;
  return depots.length ? { edges, depots } : null;
}

/**
 * Does the branch beyond a tail's fork keep clear of the line's straight continuation (the new tracks as planned:
 * construction.ts lets them run beside it only within its switch zone)? It never turns in across the line, and
 * beyond the zone it lies at least a track spacing outside the continued tracks or a clearance above / below them;
 * depots on it stand outside them.
 */
function branchClear(g: Game, st: Station, t: TerminusEnd, k: number, fork: number, tail: number): boolean {
  const net = g.world.net, r = st.rail!, lx = -t.uz, lz = t.ux;
  const side = k === 0 ? -1 : 1, lo = Math.min(...t.lat) - 0.45, hi = Math.max(...t.lat) + 0.45, edge = side > 0 ? hi : -lo;
  const f = net.nodes.get(fork)!, p = { x: 0, y: 0, z: 0 };
  const seen = new Set<number>([tail]), stack = [fork], nodes = new Set<number>([fork]);
  let length = 0;
  while (stack.length) {
    const n = net.nodes.get(stack.pop()!);
    if (!n) return false;
    for (const id of n.edges) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail') return false;
      if (e.depot >= 0) {
        const d = g.depots.get(e.depot);
        if (d && ((d.x - r.x) * lx + (d.z - r.z) * lz) * side < edge + 1.6) return false;
        continue;
      }
      for (let s = 0; s <= e.len; s += 1) {
        net.pointAt(e, Math.min(s, e.len), p);
        const lat = (p.x - r.x) * lx + (p.z - r.z) * lz;
        if ((lat - t.lat[k]) * side < -0.06) return false;
        if (Math.hypot(p.x - f.x, p.z - f.z) > SWITCH_ZONE && lat * side < edge + 0.4 && Math.abs(p.y - f.y) < 0.65) return false;
      }
      length += e.len;
      const o = e.a === n.id ? e.b : e.a;
      if (length < 60 && !nodes.has(o)) { nodes.add(o); stack.push(o); }
    }
  }
  return true;
}

// ============================================================================ depots at termini (yards)

/** A yard planned at a terminus (planTerminusYard): its head, the fork and the depot's place, and the works' price. */
export interface YardPlan { station: number; end: 'front' | 'back'; head: number; fx: number; fz: number; y: number; x: number; z: number; cost: number;
  /** city-integration: an underground depot off the fork instead of a ramp (wip/subway) */
  under?: SubwayYard }

/** A level tail at an underground terminus obeys the same full-bore cover rule as its onward links. */
function yardTail(g: Game, head: number, fx: number, fz: number, y: number, opts: BuildOptions, r: NonNullable<Station['rail']>): Proposal {
  const n = g.world.net.nodes.get(head)!;
  if (r.level !== 'underground') return planEdge(g, nodeSnap(g, head, 'rail'), { kind: 'free', x: fx, z: fz, y },
    { ...opts, heightOffset: y - g.world.heightAt(fx, fz) || 1e-3 });
  return g.world.net.withTemporaryNodes('rail', [{ x: fx, y, z: fz, dx: (n.x - fx) / TAIL, dz: (n.z - fz) / TAIL }], opts.owner, (nodes) => {
    const p = planEdge(g, nodeSnap(g, head, 'rail'), { kind: 'node', x: fx, y, z: fz, node: nodes[0].id },
      { ...opts, ...SUBWAY.subwayOpts(opts.type, 1, opts.owner, r.depth) });
    for (const t of p.tracks) t.end = { kind: 'free', x: fx, y, z: fz };
    return p;
  });
}

/**
 * A depot yard at a terminus that keeps it extendable (ai.ts urbanJob's): a straight level tail beyond an outer
 * platform track that ends at its platforms (no track beyond), a ramp off the tail's end turning away to that side (up
 * from a tunnel or down from a viaduct to the ground) and a depot at its end. `ignore`: track and depots to plan as
 * if gone. Plans only; null where no site fits.
 * city-integration: with wip/subway an underground line's yard may end in an underground depot instead (a stub from the
 * fork turning aside, planSubwayYard's cavern; the cheaper of the two): never a stub straight on, which terminusOf reads
 * as a depot lead.
 */
export function planTerminusYard(g: Game, owner: number, st: Station, end: 'front' | 'back', heads: number[] | null,
  ok: (p: Proposal) => boolean, ignore?: BuildOptions['ignore']): YardPlan | null {
  const net = g.world.net, r = st.rail;
  if (!r) return null;
  const t = terminusOf(g, st, end, owner);
  if (!t || !t.heads.length) return null;
  const level = (r.level ?? 'ground') as StationLevel, ramp = rampLength(level), lx = -t.uz, lz = t.ux;
  let under: YardPlan | null = null;
  const opts: BuildOptions = { kind: 'rail', type: lineTrackAt(g, st).type, tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...(ignore ? { ignore } : {}) };
  for (const k of [0, t.heads.length - 1]) {
    const head = t.heads[k], n = net.nodes.get(head);
    if (!n || (heads && !heads.includes(head)) || (k > 0 && t.heads.length === 1)) continue;
    if (n.edges.some((id) => !r.edges.includes(id) && !ignore?.edges.has(id))) continue;
    const side = k === 0 ? -1 : 1;
    const fx = n.x + t.ux * TAIL, fz = n.z + t.uz * TAIL;
    // the tail: straight on and level from the platform end to the fork
    const tp = yardTail(g, head, fx, fz, n.y, opts, r);
    if (!tp.ok || !ok(tp)) continue;
    // city-integration: an underground line's depot may stay underground, a cavern off the fork (wip/subway)
    if (SUBWAY && level === 'underground' && !under) for (const lat of [8, 12]) {
      const yp = SUBWAY.planSubwayYard(g, { x: fx, y: n.y, z: fz, dx: t.ux, dz: t.uz }, owner, { type: opts.type, depth: r.depth, lat: lat * side });
      if (yp.ok) { under = { station: st.id, end, head, fx, fz, y: n.y, x: yp.x, z: yp.z, cost: Math.round(tp.cost + yp.cost), under: yp }; break; }
    }
    for (const kf of [1, 1.25, 0.85, 1.5, 2]) for (const lat of [12, 24, 36]) {
      const x = fx + t.ux * ramp * kf + lx * lat * side, z = fz + t.uz * ramp * kf + lz * lat * side;
      if (!g.world.inside(x, z, 8)) continue;
      // (judged while the fork's temporary node stands: consent looks at the plan's nodes)
      const { pr, fits } = net.withTemporaryNodes('rail', [{ x: fx, y: n.y, z: fz, dx: t.ux, dz: t.uz }], owner, (ns) => {
        const q = planEdge(g, { kind: 'node', x: fx, y: n.y, z: fz, node: ns[0].id }, { kind: 'free', x, z, y: g.world.heightAt(x, z) }, opts);
        return { pr: q, fits: q.ok && ok(q) };
      });
      if (!fits) continue;
      const e = pr.tracks[0], tangent = endTangent(e.bez), y = e.prof[e.prof.length - 1];
      if (!depotFits(g, x, z, -tangent.x, -tangent.z, owner, 0, y)) continue;
      const dp = g.depots.plan('rail', x + tangent.x * 2.15, z + tangent.z * 2.15, Math.atan2(-tangent.x, -tangent.z), owner);
      if (!dp.ok) continue;
      const plan: YardPlan = { station: st.id, end, head, fx, fz, y: n.y, x, z, cost: Math.round(pr.cost + tp.cost + dp.cost) };
      return under && under.cost <= plan.cost ? under : plan;
    }
  }
  return under;
}

/** Build a planned yard (the tail, the ramp, the depot); the depot id, or -1 with nothing left behind (works refunded). */
export function buildTerminusYard(g: Game, owner: number, y: YardPlan, ok: (p: Proposal) => boolean): number {
  const net = g.world.net, eco = g.company(owner).economy, money = eco.money, e0 = net.nextEdge;
  const st = g.stations.get(y.station), n = net.nodes.get(y.head);
  const undo = () => { for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.owner === owner && net.edges.get(id)!.depot < 0) net.removeEdge(id); if (eco.money < money) eco.spend(eco.money - money, 'construction', true); g.onNetworkChanged(); return -1; };
  if (!st?.rail || !n) return -1;
  const opts: BuildOptions = { kind: 'rail', type: lineTrackAt(g, st).type, tracks: 1, heightOffset: 0, crossing: 'auto', owner };
  const tp = yardTail(g, y.head, y.fx, y.fz, y.y, opts, st.rail);
  if (!tp.ok || !ok(tp) || commitProposal(g, tp)) return undo();
  const fork = nodeAt(g, 'rail', y.fx, y.fz);
  if (!fork) return undo();
  // city-integration: the cavern off the fork (wip/subway's buildSubwayYard: from the tail's free end)
  if (y.under) { const id = SUBWAY ? SUBWAY.buildSubwayYard(g, fork.id, y.under, owner, opts.type) : -1; return id >= 0 ? id : undo(); }
  const pr = planEdge(g, nodeSnap(g, fork.id, 'rail'), { kind: 'free', x: y.x, z: y.z, y: g.world.heightAt(y.x, y.z) }, opts);
  if (!pr.ok || !ok(pr) || commitProposal(g, pr)) return undo();
  const endNode = net.nearestNode(y.x, y.z, 0.1, 'rail', (q) => q.edges.length === 1);
  const id = endNode ? depotAtEnd(g, endNode.id, owner) : -1;
  return id >= 0 ? id : undo();
}

/** Is a vehicle on its way out of a depot (on its track, or entering the line from it)? */
export function depotBusy(g: Game, depotId: number): boolean {
  const d = g.depots.get(depotId);
  if (!d) return true;
  if (g.vehicles.isEdgeBusy(d.edge)) return true;
  for (const v of g.vehicles.map.values()) {
    const segs = (v as unknown as { segs?: { depot?: number; e: number }[] }).segs;
    if (segs && segs.some((s) => s.depot === d.id || s.e === d.edge)) return true;
  }
  return false;
}

/**
 * The vehicles at home in depot `from` move to depot `to` (those inside move with it, those out on the line return
 * there later; trackops relocateDepot's rule), the companies' lines buy at `to`, and `from` is taken down. 'busy' while
 * a vehicle is on its way out of `from`; null when done.
 */
export function moveDepotHome(g: Game, from: number, to: number): string | null {
  const old = g.depots.get(from), nd = g.depots.get(to);
  if (!old || !nd || old.kind !== nd.kind) return 'No such depot';
  if (depotBusy(g, from)) return 'busy';
  for (const v of g.vehicles.map.values()) {
    const vd = v as unknown as { depotId?: number };
    if (vd.depotId !== old.id) continue;
    vd.depotId = nd.id;
    v.homeX = nd.x; v.homeZ = nd.z;
  }
  for (const ai of g.ais) for (const info of (ai as unknown as { lines?: Map<number, { depot: number }> }).lines?.values() ?? []) if (info.depot === from) info.depot = to;
  const err = g.depots.remove(old.id);
  if (!err) g.company(old.owner).economy.spend(15000, 'construction', true);
  return err;
}

// ============================================================================ the network task 'extend'

/** One way a line could grow (survey): beyond a terminus, or a stop in a long gap. Plain numbers (saved with the cursor). */
export interface GrowOption {
  kind: 'ext' | 'fill';
  /** ext: the path end (0: the first station, 1: the last), the stations beyond, the first link's bearing off the axis (radians), the level */
  end?: 0 | 1; n?: number; turn?: number; level?: StationLevel;
  /** A priced continuation to a neighbouring centre; gap is from the existing ends to its platform start. */
  town?: number; gap?: number;
  /** fill: the consecutive stations and the point between them */
  a?: number; b?: number; x?: number; z?: number;
  /** residents beyond every station's walking reach it would reach (survey estimate) */
  pop: number;
}
/**
 * The 'extend' work item's state: at 0 the survey, 1..opts the next option to value, then the best one's build in
 * steps (a depot moved, the stations, the track and the line; `made` what the build has laid so far).
 */
export interface GrowCursor { at: number; opts?: GrowOption[]; best?: { opt: number; score: number; fleet?: boolean }; made?: GrowBuild; encounteredBusy?: boolean }
export const copyGrowCursor = (c: GrowCursor): GrowCursor => ({ at: c.at, ...(c.opts ? { opts: c.opts.map((o) => ({ ...o })) } : {}),
  ...(c.best ? { best: { ...c.best } } : {}), ...(c.made ? { made: copyGrowBuild(c.made) } : {}), ...(c.encounteredBusy ? { encounteredBusy: true } : {}) });

/** What the network planner lends the task (ai-network.ts NetPlanner). */
export interface GrowHost {
  readonly g: Game; readonly me: number; readonly ai: AIController;
  note(s: string): void;
  news(s: string, x?: number, z?: number): void;
  considered(k: string): void;
  stat(k: 'netExtended' | 'netGrowInfill' | 'netDepotsMoved', n?: number): void;
  /** the job did what it was for (one change a job) */
  succeed(): void;
  cared(key: string): boolean;
  careFor(key: string, days: number): void;
  canSpend(cost: number, share?: number): boolean;
  /** canSpend's test without its borrowing: `cost` within `share` of what the company can commit now */
  affordable(cost: number, share?: number): boolean;
  fleet(l: Line): { ours: number[]; others: number };
  managed(): Map<number, { depot: number; maxVehicles: number; towns: number[]; opened: number; urban?: string }> | null;
  setStops(l: Line, stops: number[]): void;
  signal(lineId: number): number;
  canon(lineId: number): void;
  mayAlter(ids: Iterable<number>): boolean;
  consent(p: Proposal, planned?: boolean): boolean;
  demolitionOk(ids: number[]): boolean;
  compensate(ids: number[], residents?: { townId: number; pop: number; cost: number }[]): void;
  localOnly(l: Line, stationId: number): void;
}

/** A line of ours the task looks after: rail, out and back over stations with platforms, our trains on it. */
export function growLine(h: GrowHost, l: Line): number[] | null {
  const g = h.g;
  if (l.kind !== 'rail' || l.owner !== h.me || !h.fleet(l).ours.length) return null;
  const path = l.loop === true ? null : linearStops(l.stops);
  if (!path || path.length < 2 || !path.every((sid) => !!g.stations.get(sid)?.rail)) return null;
  const stations = path.map((sid) => g.stations.get(sid)!);
  const town = stations[0].townId;
  const urban = h.managed()?.get(l.id)?.urban || stations.every((s) => railPartMode(s.rail!) !== 'mainline');
  return urban && town >= 0 && stations.every((s) => s.townId >= 0) ? path : null;
}

/** Resident counts of buildings within `r` of a point that no served rail station reaches on foot (each building once). */
function uncoveredNear(g: Game, covered: Set<number>, counted: Set<number>, x: number, z: number, r: number): number {
  const w = g.world;
  let pop = 0;
  for (const id of w.bgrid.query(x - r, z - r, x + r, z + r)) {
    if (counted.has(id) || covered.has(id)) continue;
    const b = w.buildings.get(id);
    if (!b || b.pop <= 0 || (b.x - x) ** 2 + (b.z - z) ** 2 > r * r) continue;
    counted.add(id);
    pop += b.pop;
  }
  return pop;
}

/** Buildings within reach of served rail stations near a box (walking catchments). */
function coveredBuildings(g: Game, x0: number, z0: number, x1: number, z1: number): Set<number> {
  const out = new Set<number>();
  for (const st of g.stations.map.values()) {
    if (!st.rail || !g.lines.stationServed(st.id) || st.x < x0 || st.x > x1 || st.z < z0 || st.z > z1) continue;
    for (const id of walkingCatchment(g, st).buildings.keys()) out.add(id);
  }
  return out;
}

/** Station centres (and axes) of an extension: `n` stations beyond the start point `(sx, sz)` heading (ux, uz), the first link bending by `turn`. */
function chainSites(sx: number, sz: number, ux: number, uz: number, turn: number, gap0: number, gap: number, platform: number, n: number): { x: number; z: number; angle: number; ix: number; iz: number }[] {
  const out: { x: number; z: number; angle: number; ix: number; iz: number }[] = [];
  const rot = (a: number) => ({ x: ux * Math.cos(a) + uz * Math.sin(a), z: -ux * Math.sin(a) + uz * Math.cos(a) });
  let px = sx, pz = sz, d = rot(turn), axis = rot(2 * turn);
  for (let i = 0; i < n; i++) {
    const g0 = i === 0 ? gap0 : gap;
    const ix = px + (i === 0 ? d.x : axis.x) * g0, iz = pz + (i === 0 ? d.z : axis.z) * g0;
    const x = ix + axis.x * platform / 2, z = iz + axis.z * platform / 2;
    out.push({ x, z, angle: Math.atan2(axis.x, axis.z), ix, iz });
    px = x + axis.x * platform / 2; pz = z + axis.z * platform / 2;
  }
  return out;
}

/** The line's service today, for valuing changes (as ai.ts urbanEconomics: physics-based hop times). */
interface Service {
  owner: number; line: number;
  cars: VehicleModel[]; trains: number; totalTrains: number; pid: number; path: number[];
  cycle: number; headway: number; hop: number; kmh: number; spacing: number;
  perTrain: number; wear: number; seats: number; trips: number; price: number; depot: number;
}
function serviceOf(h: GrowHost, l: Line, path: number[], affected: number[] = [], chosen?: number): Service | null {
  const g = h.g, pats = linePatterns(l);
  const fleet = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v?.kind === 'train' && v.owner === h.me && v.carries('pax'));
  if (!fleet.length) return null;
  const pidOf = (t: Train) => pats.some((p) => p.id === t.pattern) ? t.pattern! : pats[0].id;
  const ph = patternHeadways(g, l);
  const eligible = pats.filter((p) => (chosen === undefined || p.id === chosen)
    && affected.every((sid) => l.stops.some((s, i) => s === sid && p.stops[i] !== false))
    && ph.some((x) => x.pid === p.id && x.vehicles > 0));
  eligible.sort((a, b) => b.stops.filter((x) => x !== false).length - a.stops.filter((x) => x !== false).length
    || fleet.filter((t) => pidOf(t) === b.id).length - fleet.filter((t) => pidOf(t) === a.id).length || a.id - b.id);
  const p = eligible[0];
  if (!p) return null;
  const ours = fleet.filter((t) => pidOf(t) === p.id);
  const served = path.filter((sid) => l.stops.some((s, i) => s === sid && p.stops[i] !== false));
  if (served.length < 2) return null;
  const sts = served.map((sid) => g.stations.get(sid)!);
  const len = routeLength(sts), spacing = Math.max(4, len / (sts.length - 1));
  const cars = [...(ours[0] ?? fleet[0]).cars];
  const yr = estimateVehicleYear(cars, spacing / 1.15, g.year, 0.4, lineTrackAt(g, sts[0]).speed);
  const main = ph.find((x) => x.pid === p.id)!;
  const cycle = main.cycle, hop = YEAR_S / Math.max(1, yr.trips);
  const info = h.managed()?.get(l.id);
  const home = ours[0] ?? fleet[0];
  const depot = info && g.depots.get(info.depot)?.owner === h.me ? info.depot : home.depotId;
  return { owner: h.me, line: l.id, cars, trains: ours.length, totalTrains: main.vehicles, pid: p.id, path: served, cycle,
    headway: cycle / main.vehicles, hop, kmh: len * UNIT_M / (cycle / 2) * 3.6, spacing,
    perTrain: yr.total, wear: yr.trackWearPerUnit, seats: cars.reduce((a, m) => a + m.capacity, 0),
    trips: yr.trips, price: cars.reduce((a, m) => a + m.cost, 0), depot };
}

const routeLength = (points: (Station | StationPlan)[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.z - points[i].z), 0);
/** Forecast at this alternative's actual fleet frequency, shared with the other operator's trains on its pattern. */
const forecast = (g: Game, points: (Station | StationPlan)[], mode: RailMode, sv: Service, extra = 0) =>
  g.demand.forecastLine(points, mode, sv.kmh, sv.cycle / (sv.totalTrains + extra), sv.owner, sv.line);
/** The operator's share of receipts constrained by full-cycle seats on the busiest direction of an actual leg.
 * Long riders occupy every intervening segment; a physics estimate of annual average hops is not boarding capacity. */
export const forecastSeatFactor = (legLoads: number[], cycle: number, trains: number, seats: number) =>
  Math.min(1, trains * YEAR_S / Math.max(1, cycle) * seats * 0.7 / Math.max(1, ...legLoads));
const carried = (f: { revenue: number; legLoads: number[] }, sv: Service, extra = 0) =>
  f.revenue * forecastSeatFactor(f.legLoads, sv.cycle, sv.totalTrains + extra, sv.seats)
    * (sv.trains + extra) / (sv.totalTrains + extra);

/**
 * May the company commit `capital` (and a margin) to growing a line now? An extension is a further stage of the city
 * railway: within what the company has available, as its opening stage was (ai.ts urbanJob: "extensions can follow
 * retained operating profit"); a stop in a gap as the network's other works (30% of its budget). `borrow`: take the
 * loan steps the spend needs (only when it is built).
 */
function funds(h: GrowHost, kind: 'ext' | 'fill', capital: number, borrow: boolean): boolean {
  const need = capital * 1.1;
  if (kind === 'ext') return need + 300_000 <= h.ai.available() && (!borrow || h.canSpend(need, 1));
  return borrow ? h.canSpend(need, 0.3) : h.affordable(need, 0.3);
}
/** Years an urban extension's operating surplus has to repay it in (the rule its line opened by). */
const payback = (h: GrowHost, mode: RailMode) => discountedPayback(
  mode === 'mainline' ? URBAN_PAYBACK.crosscity : URBAN_PAYBACK[mode], h.g.company(h.me).economy.interestRate);
/** Upkeep a year of a station / a unit of double track at a level (game.ts stationMaintenance, opcosts trackMaintenance). */
const LEVEL_STATION = STATION_UPKEEP_FACTOR, LEVEL_TRACK = { ground: 1, elevated: 4, underground: 5 };
/** Compensation for demolished town buildings (ai-network compensate), on top of their price in the plans. */
function displacedResidents(g: Game, ids: number[]) {
  return ids.flatMap((id) => { const b = g.world.buildings.get(id); return b ? [{ townId: b.townId, pop: b.pop, cost: demolitionCost(g, b) }] : []; });
}
function compensation(g: Game, ids: number[]): number { return displacedResidents(g, ids).reduce((c, b) => c + b.cost, 0); }

/** Nodes as a construction group (planEdge): node ids in group order, the snap's node the first. */
function groupSnap(g: Game, ids: number[]): Snap {
  const n = g.world.net.nodes.get(ids[0])!;
  return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [...ids] };
}

/** A planned extension (planExtension): its new stations, the price of the works and what it changes at the terminus. */
interface ExtPlan {
  stations: StationPlan[];
  /** works: stations, track, the depot's move (a new yard, the old lead taken up), compensation */
  works: number;
  /** double track laid (units) */
  track: number;
  /** Separate crossover base upkeep and arc length, including their native bridge/tunnel sections. */
  crossoverUpkeep: number;
  crossoverTrack: number;
  demolish: number[];
  level: StationLevel;
}

/**
 * Build options of an extension's double track from a station part of the line (`from`: the terminus or the last new
 * station) to the next one: the line's track type, at `level` (its depth / deck height from where it starts).
 * city-integration: with wip/subway, a link between two underground ends takes subwayOpts (it stays in its tunnel: no
 * portal in town); from a surface terminus the ramp down stays this planner's (planSubwayExtension's allowRamp is the
 * subway branch's single-station equivalent).
 */
function linkOpts(track: LineTrack, level: StationLevel, owner: number, from: { depth: number; height: number; level?: string }, to: { depth: number; height: number; level?: string },
  ignore?: BuildOptions['ignore']): BuildOptions {
  if (SUBWAY && level === 'underground' && from.level === 'underground' && to.level === 'underground')
    return { ...SUBWAY.subwayOpts(track.type, 2, owner, from.depth || to.depth), ...(ignore ? { ignore } : {}) };
  return { kind: 'rail', type: track.type, tracks: 2, heightOffset: 0, crossing: level === 'ground' ? 'level' : 'auto', owner,
    level, levelDepth: level === 'underground' ? (from.depth || to.depth) : undefined, levelHeight: level === 'elevated' ? (from.height || to.height) : undefined,
    ...(ignore ? { ignore } : {}) };
}

/** A depot spur and its depots (their own track too), to plan track as if they were gone. */
function spurIgnore(g: Game, spur: number[], depots: number[]): NonNullable<BuildOptions['ignore']> {
  const edges = new Set(spur);
  for (const id of depots) { const d = g.depots.get(id); if (d) edges.add(d.edge); }
  return { edges, depots: new Set(depots) };
}

/** What a yard (tail, ramp, depot) at a new terminus costs, about (planTerminusYard's works). */
function yardEstimate(track: LineTrack, level: StationLevel): number {
  const per = track.costPerUnit;
  return Math.round((TAIL + rampLength(level) * 1.2) * per * (level === 'underground' ? 5 : level === 'elevated' ? 3.5 : 1.3) + 110_000);
}

/**
 * Plan an extension of a line beyond its terminus T (`te`, its end facing outward): `n` new stations at the line's
 * spacing, the first link bending by `turn`, at `level`; double track from the platform ends (a free end, or a depot
 * lead there taken up: its depot moves out to a yard at the new terminus), or from the fork and the other track's end
 * as far out (a tail: the branch stays beside the line). Checked in today's world with the stations' and links'
 * previews. A reason when it does not fit.
 */
function planExtension(h: GrowHost, T: Station, te: TerminusEnd, n: number, turn: number, level: StationLevel, destination?: Pick<GrowOption, 'town' | 'gap'>): ExtPlan | string {
  const g = h.g, net = g.world.net, me = h.me, r = T.rail!;
  if (te.heads.length !== 2 || te.kind === 'other' || T.owner !== me) return 'terminus';
  const track = lineTrackAt(g, T), grade = track.maxGrade * 0.8;
  const PL = r.length, SP = cityStationSpacing(g, T.x, T.z, track, PL);
  // a depot beyond the terminus moves out to a yard at the new terminus, its spur taken up: a lead in the way on
  // (the track planned as if it were gone), or a tail's yard (it would join the line half way, on one running track)
  const ignore = te.kind === 'lead' ? spurIgnore(g, te.lead, te.depots) : undefined;
  if (ignore && [...ignore.edges].some(id => g.vehicles.isEdgeBusy(id))) return 'busy';
  let works = 0;
  if (te.depots.length) {
    let lead = 0;
    for (const id of te.lead) lead += net.edges.get(id)?.len ?? 0;
    works += yardEstimate(track, level) + 15000 + lead * 400;
  }
  // the start of the new double track: two nodes level with each other beyond the platform ends
  const a0 = te.kind === 'tail' ? te.tail : 0;
  const starts = te.heads.map((id) => { const q = net.nodes.get(id)!; return { x: q.x + te.ux * a0, z: q.z + te.uz * a0, y: q.y }; });
  const sx = (starts[0].x + starts[1].x) / 2, sz = (starts[0].z + starts[1].z) / 2;
  // a level change on the way needs room for its ramp (the new station's height within the grade of the first link)
  const lv0 = (r.level ?? 'ground') as StationLevel;
  const climb = lv0 === level ? 0 : (level === 'underground' ? STATION_DEPTH.metro + 0.6 : 0) + (lv0 === 'elevated' ? STATION_HEIGHT.def + 0.6 : 0)
    + (level === 'elevated' ? STATION_HEIGHT.def + 0.6 : 0) + (lv0 === 'underground' ? r.depth + 0.6 : 0);
  const crossingRoom = doubleTrackCrossoverGap(track.type);
  const gap = Math.max(crossingRoom, SP - PL), gap0 = Math.max(crossingRoom, SP - PL - a0, climb / grade, destination?.gap ?? 0);
  // (a site that does not work, a street across it say, moves on along the line a little; back only where the
  // crossovers before a terminus and a level change's ramp keep their room: ai.ts urbanJob's site offsets)
  const throat = Math.max(crossingRoom, track.minRadius * 2 + 2, track.mode === 'lightrail' ? 18 : 0);
  // (as chainSites: the first link bends by `turn`, the new stations' axis by twice that)
  const rot = (a: number) => ({ x: te.ux * Math.cos(a) + te.uz * Math.sin(a), z: -te.ux * Math.sin(a) + te.uz * Math.cos(a) });
  const dir0 = rot(turn), axis = rot(2 * turn), angle = Math.atan2(axis.x, axis.z), ux = axis.x, uz = axis.z;
  const plans: StationPlan[] = [];
  const demolish: number[] = [];
  let prevY = r.y, px = sx, pz = sz;
  const site = (x: number, z: number, link: number): StationPlan | string => {
    if (!g.world.inside(x, z, 10)) return 'map edge';
    // A cross-town continuation targets that actual centre; local growth remains within its original town.
    if ((g.towns.nearest(x, z)?.id ?? -1) !== (destination?.town ?? T.townId)) return 'town';
    for (const o of g.stations.footprintsNear(x, z, SP * 0.55)) if (o.rail && Math.hypot(o.x - x, o.z - z) < SP * 0.55) return 'station near';
    const reach = grade * Math.max(1, link);
    let lo = Infinity, hi = -Infinity;
    for (const k of [-0.5, 0, 0.5]) { const y = g.world.heightAt(x + ux * PL * k, z + uz * PL * k); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    // (the new station's style: the terminus's)
    let opt: Record<string, unknown> = { trackType: track.platform, mode: track.mode, level, ...(level !== 'ground' && g.stations.cityAt(x, z, g.towns.nearest(x, z)) ? { entrances: 4 } : {}) };
    if (level === 'underground') {
      const want = lo - Math.max(STATION_DEPTH.metro, (lv0 === 'underground' ? r.depth : 0)), y = Math.max(prevY - reach, Math.min(prevY + reach, want));
      const depth = lo - y;
      if (depth < STATION_DEPTH.min || depth > STATION_DEPTH.max) return 'depth';
      opt = { ...opt, depth };
    } else if (level === 'elevated') {
      const want = hi + STATION_HEIGHT.def, y = Math.max(prevY - reach, Math.min(prevY + reach, want)), height = y - hi;
      if (height < STATION_HEIGHT.min || height > STATION_HEIGHT.max) return 'height';
      opt = { ...opt, height };
    }
    const pl = g.stations.planRail(x, z, angle, PL, 2, me, opt);
    if (!pl.ok) return pl.error ?? 'site';
    if (pl.join?.rail) return 'platforms there';
    if (pl.join) { pl.links = [...new Set([...pl.links, pl.join])]; pl.join = null; }
    if (Math.abs(pl.y - prevY) > reach + 0.05) return 'grade';
    // (stairs to a deck must leave the track's way on at both ends free)
    if (level !== 'underground') for (const e of pl.entrances) {
      const dx = e.x - pl.x, dz = e.z - pl.z;
      if (Math.abs(dx * ux + dz * uz) > PL / 2 - 0.3 && Math.abs(dx * uz - dz * ux) < pl.footprint.w / 2 + 1.1) return 'entrance on the line';
    }
    if (!h.demolitionOk(pl.demolish)) return 'demolition';
    return pl;
  };
  for (let i = 0; i < n; i++) {
    const dir = i === 0 ? dir0 : { x: ux, z: uz }, link = i === 0 ? gap0 : gap, least = Math.max(throat - (i === 0 ? a0 : 0), i === 0 ? climb / grade : 0);
    let pl: StationPlan | null = null, why = '';
    for (let k = 0; k <= 12 && !pl; k++) {
      const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2.5;
      if (off > SP * 0.5 || link + off < least - 1e-6) continue;
      const ix = px + dir.x * (link + off), iz = pz + dir.z * (link + off);
      const s = site(ix + ux * PL / 2, iz + uz * PL / 2, link + off);
      if (typeof s === 'string') why ||= s;
      else pl = s;
    }
    if (!pl) return why || 'site';
    plans.push(pl);
    demolish.push(...pl.demolish);
    works += pl.cost + compensation(g, pl.demolish);
    prevY = pl.y;
    px = pl.x + ux * PL / 2; pz = pl.z + uz * PL / 2;
  }
  // the links, each from the last station's outer end (the terminus's start nodes first) to the next one's inner end
  let laid = 0, crossoverUpkeep = 0, crossoverTrack = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i], ux = Math.sin(p.angle), uz = Math.cos(p.angle), rx = uz, rz = -ux;
    // (inner end nodes of the next station: track order; planEdge takes an end group right to left)
    const ends = p.layout.trackOffsets.map((off) => ({ x: p.x + rx * off - ux * PL / 2, y: p.y, z: p.z + rz * off - uz * PL / 2, dx: -ux, dz: -uz }));
    let from: { x: number; y: number; z: number; dx: number; dz: number }[];
    if (i === 0) from = starts.map((q) => ({ ...q, dx: te.ux, dz: te.uz }));
    else {
      const q = plans[i - 1], qx = Math.sin(q.angle), qz = Math.cos(q.angle), qrx = qz, qrz = -qx;
      from = q.layout.trackOffsets.map((off) => ({ x: q.x + qrx * off + qx * PL / 2, y: q.y, z: q.z + qrz * off + qz * PL / 2, dx: qx, dz: qz })).reverse();
    }
    const opts = linkOpts(track, level, me, i === 0 ? T.rail! : plans[i - 1], p, ignore);
    // (the terminus's real end nodes where they are the start: a free end, or a tail's fork)
    const real = i === 0 && te.kind !== 'tail' ? [...te.heads] : i === 0 ? te.heads.map((id, k) => (k === te.root ? te.fork : -1)) : [-1, -1];
    const pj = net.withTemporaryNodes('rail', [...from.filter((_, k) => real[k] < 0), ...ends], me, (tmp) => {
      let t = 0;
      const startIds = from.map((_, k) => (real[k] >= 0 ? real[k] : tmp[t++].id));
      const endIds = ends.map(() => tmp[t++].id);
      // (the first node of a group sets the start frame: a temporary one faces the way out)
      const lead = startIds.find((id) => !net.nodes.get(id)!.edges.length) ?? startIds[0];
      const snap = groupSnap(g, [lead, ...startIds.filter((id) => id !== lead)]);
      snap.group = startIds;
      return planEdge(g, snap, groupSnap(g, endIds), opts);
    });
    if (!pj.ok) return pj.errors[0] ?? 'track';
    if (!h.consent(pj, true) || !h.demolitionOk(pj.demolish)) return 'track consent';
    const fin = planDoubleTrackFinish(g, pj, me, plans);
    if (fin.error) return fin.error;
    works += pj.cost + fin.cost + compensation(g, pj.demolish);
    crossoverUpkeep += fin.upkeep!; crossoverTrack += fin.track!;
    demolish.push(...pj.demolish);
    laid += pj.stats.len / 2;
  }
  if (te.kind === 'tail') works += te.tail * track.costPerUnit * (LEVEL_TRACK[lv0] ?? 1);
  return { stations: plans, works: Math.round(works), track: laid, crossoverUpkeep, crossoverTrack, demolish, level };
}

/** The value of a planned extension or stop: annual revenue gained less the added costs a year, and the capital it needs. */
interface Investment { score: number; net: number; capital: number; revenue: number; trains: number }
interface Valuation extends Investment { fleet: Investment }
function value(h: GrowHost, l: Line, beforeRoute: Station[], afterRoute: (Station | StationPlan)[], works: number, track: number, stations: StationPlan[], _hops: number, sv: Service, mode: RailMode, level: StationLevel, crossoverUpkeep = 0, crossoverTrack = 0): Valuation {
  const g = h.g;
  const before = beforeRoute.filter((s) => sv.path.includes(s.id));
  const after = afterRoute.filter((s) => !('id' in s) || sv.path.includes(s.id));
  const type = lineTrackAt(g, before[0]).type, len = routeLength(before), len1 = routeLength(after);
  const spacing = Math.max(4, len1 / Math.max(1, after.length - 1));
  const yr = estimateVehicleYear(sv.cars, spacing / 1.15, g.year, 0.4, lineTrackAt(g, before[0]).speed);
  const hop = YEAR_S / Math.max(1, yr.trips);
  // Scale the measured timetable cycle by the projected physics of the changed route, including added dwell.
  const cycle = sv.cycle * hop * (after.length - 1) / (sv.hop * (before.length - 1));
  const extra = Math.max(0, Math.ceil(sv.totalTrains * cycle / sv.cycle - 1e-9) - sv.totalTrains);
  const next: Service = { ...sv, cycle, hop, spacing, kmh: len1 * UNIT_M / (cycle / 2) * 3.6, trips: yr.trips, perTrain: yr.total, wear: yr.trackWearPerUnit };
  const f0 = forecast(g, before, mode, sv);
  const today = carried(f0, sv), rate = observedRate(h, l, today, sv);
  const fleetRevenue = (carried(forecast(g, before, mode, sv, extra), sv, extra) - today) * rate;
  const fleetNet = fleetRevenue - extra * sv.perTrain - len * 2 * extra * sv.wear;
  const fleetCapital = extra * sv.price;
  // A hypothetical fleet which cannot admit even its first departure must not displace a viable extension.
  // The purchase loop still reprices each actual added train against the physical resources it consumes.
  const fleetAllowed = extra > 0 && marginalSharedTrain(g, l, h.me, sv.cars, sv.pid) > 0;
  const fleet = { score: fleetAllowed ? fleetNet * payback(h, mode) - fleetCapital : 0, net: fleetNet, capital: fleetCapital,
    revenue: fleetRevenue, trains: fleetAllowed ? extra : 0 };
  const revenue = (carried(forecast(g, after, mode, next, extra), next, extra) - today) * rate;
  // All native crossover structures need base upkeep. Conservatively allow each forecast train's
  // passage wear over the installed arcs as well, rather than hiding it in the straight main rails.
  const upkeep = crossoverUpkeep + crossoverTrack * (sv.totalTrains + extra) * next.wear
    + track * 2 * (trackBasePerUnit(type) * (LEVEL_TRACK[level] ?? 1) + (sv.totalTrains + extra) * next.wear)
    + len * 2 * ((sv.totalTrains + extra) * next.wear - sv.totalTrains * sv.wear)
    + stations.reduce((a, p) => a + (20000 + p.tracks * p.length * 500) * (LEVEL_STATION[p.level] ?? 1), 0);
  const net = revenue - ((sv.trains + extra) * next.perTrain - sv.trains * sv.perTrain) - upkeep;
  const capital = works + extra * sv.price;
  return { score: net * payback(h, mode) - capital, net, capital, revenue, trains: extra, fleet };
}

/** Passenger receipts and forecasts over the same saved, unchanged operator/pattern service periods. */
function observedRate(h: GrowHost, l: Line, forecastToday: number, sv: Service): number {
  const g = h.g, key = h.me + ':' + sv.pid;
  const signature = l.stops.join(',') + '|' + linePatterns(l).map((p) => p.id + ':' + p.stops.map(Number).join('')).join('|')
    + '|' + l.vehicles.map((id) => { const t = g.vehicles.get(id) as Train; return id + ':' + t.owner + ':' + t.pattern + ':' + t.cars.map((m) => m.id).sort().join(','); }).join('|');
  const observations = l.growth ??= {};
  let p = observations[key];
  if (!p) {
    const opened = h.managed()?.get(l.id)?.opened ?? g.day;
    const fullYear = opened <= Math.floor(g.day / 360) * 360 - 360;
    const soleService = sv.trains === l.vehicles.length && linePatterns(l).length === 1;
    // Older saves have receipts but no historical forecast. Use them only as a conservative initial estimate;
    // a measured zero is evidence, while a young/unobserved service gets a half-forecast prior.
    const rate = fullYear && soleService && forecastToday > 0
      ? Math.min(0.5, Math.max(0, l.incomeLast - (l.mail?.incomeLast ?? 0)) / forecastToday) : 0.5;
    // One cycle of prior evidence prevents a few quiet daily work units from being mistaken for a complete
    // service period. Its weight decays continuously; there is no minimum multiplier for weak/zero receipts.
    const priorExpected = forecastToday * sv.cycle / (DAY_SECONDS * 360);
    p = observations[key] = { day: g.day, signature, forecast: forecastToday, counter: 0, atCounter: 0, expected: 0, receipts: 0, rate, days: 0,
      priorExpected, priorReceipts: priorExpected * rate };
  } else {
    const days = Math.max(0, g.day - p.day);
    // Other tasks can change a route or fleet between reviews. Its unknown change date cannot be calibrated;
    // keep the previous evidence and start the next comparable period without restoring optimism.
    if (days > 0 && signature === p.signature && p.forecast > 0) {
      p.expected += p.forecast * days / 360;
      p.receipts += Math.max(0, p.counter - p.atCounter);
      p.days = (p.days ?? 0) + days;
      // Fade the young-service prior continuously; a full observed year is entirely measured evidence.
      const prior = Math.max(0, 1 - p.days / 360);
      p.rate = Math.min(1.5, (p.receipts + p.priorReceipts * prior) / (p.expected + p.priorExpected * prior));
    }
    p.day = g.day; p.signature = signature; p.forecast = forecastToday; p.atCounter = p.counter;
  }
  return p.rate;
}

/** Prefer the affordable investment with the greater surplus/payback score, including adding only trains. */
function preference(h: GrowHost, kind: 'ext' | 'fill', v: Valuation): { score: number; fleet: boolean } | null {
  const choices = [{ investment: v, fleet: false }, { investment: v.fleet, fleet: true }]
    .filter((c) => c.investment.score > 0 && funds(h, kind, c.investment.capital, false))
    .sort((a, b) => b.investment.score - a.investment.score || Number(b.fleet) - Number(a.fleet));
  return choices.length ? { score: choices[0].investment.score, fleet: choices[0].fleet } : null;
}

/** Survey: where the line could grow (cheap counts of residents no station reaches on foot), the promising options first. */
function survey(h: GrowHost, l: Line, path: number[]): GrowOption[] {
  const g = h.g, me = h.me;
  const sts = path.map((id) => g.stations.get(id)!);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of sts) { x0 = Math.min(x0, s.x); z0 = Math.min(z0, s.z); x1 = Math.max(x1, s.x); z1 = Math.max(z1, s.z); }
  const covered = coveredBuildings(g, x0 - 160, z0 - 160, x1 + 160, z1 + 160);
  const sv = serviceOf(h, l, path);
  if (!sv) return [];
  // a covered resident's fares a year on this line (observed; a floor for a young line), against rough works per station
  let catchPop = 0;
  for (const s of sts) catchPop += s.catchPop;
  const perRes = Math.max(300, catchPop > 50 && l.incomeLast > 0 ? l.incomeLast / catchPop : 0);
  const out: (GrowOption & { rank: number })[] = [];
  for (const end of [0, 1] as const) {
    const T = sts[end ? sts.length - 1 : 0], N = sts[end ? sts.length - 2 : 1];
    // (a terminus of ours in town: another company's station is theirs to extend)
    if (T.townId < 0 || T.owner !== me) continue;
    const te = terminusOf(g, T, outerEnd(T, N), me);
    if (!te || te.kind === 'other' || te.heads.length !== 2) { h.considered('extend.blockedEnd'); continue; }
    const r = T.rail!, PL = r.length, track = lineTrackAt(g, T), mode = track.mode, SP = cityStationSpacing(g, T.x, T.z, track, PL);
    const rough = (lv: StationLevel) => (2 * PL * 9000 + 120000) * (lv === 'underground' ? 5 : lv === 'elevated' ? 3.5 : 1)
      + 2 * (SP - PL) * track.costPerUnit * (lv === 'underground' ? 7 : lv === 'elevated' ? 4.5 : 1.5);
    const q = endCentre(g, te), a0 = te.kind === 'free' ? 0 : TAIL;
    const sx = q.x + te.ux * a0, sz = q.z + te.uz * a0;
    const towns = new Set(sts.map(s => s.townId));
    for (const c of onwardCentres(g, sx, sz, te.ux, te.uz, towns, SP)) {
      const x = sx + te.ux * c.along, z = sz + te.uz * c.along;
      const pop = uncoveredNear(g, covered, new Set(), x, z, cityStationRadius(g, x, z, mode));
      if (!(pop > 0) || g.towns.nearest(x, z)?.id !== c.town) continue;
      for (const level of levelsFor(T)) {
        const factor = LEVEL_TRACK[level], capital = rough(level) + 2 * Math.max(0, c.along - SP) * track.costPerUnit * factor;
        const rank = pop * perRes * payback(h, mode) - .3 * capital;
        if (rank > 0) out.push({ kind: 'ext', end, n: 1, turn: 0, level, town: c.town, gap: c.along - PL / 2, pop, rank });
      }
    }
    for (const turn of [0, 0.2, -0.2, 0.4, -0.4]) {
      // Count the residents at the same buildable formation used by planExtension. A shorter
      // old station gap could rank an unserved third district and omit the viable two-stop stage.
      const nativeGap = Math.max(doubleTrackCrossoverGap(track.type), track.minRadius * 2 + 2, mode === 'lightrail' ? 18 : 0);
      const sites = chainSites(sx, sz, te.ux, te.uz, turn, Math.max(nativeGap, SP - PL - a0), Math.max(nativeGap, SP - PL), PL, 3);
      const counted = new Set<number>();
      let pop = 0;
      for (let k = 0; k < sites.length; k++) {
        if ((g.towns.nearest(sites[k].x, sites[k].z)?.id ?? -1) !== T.townId) break;
        const add = uncoveredNear(g, covered, counted, sites[k].x, sites[k].z, cityStationRadius(g, sites[k].x, sites[k].z, mode));
        if (add <= 0) break;
        pop += add;
        for (const level of levelsFor(T)) {
          const rank = pop * perRes * payback(h, mode) - 0.3 * rough(level) * (k + 1);
          if (rank > 0) out.push({ kind: 'ext', end, n: k + 1, turn, level, pop, rank });
        }
      }
    }
  }
  // infill: long gaps (room for a station and its throats) between two stations of one town
  for (let i = 0; i + 1 < sts.length; i++) {
    const A = sts[i], B = sts[i + 1];
    if (A.townId < 0 || A.townId !== B.townId) continue;
    const r = A.rail!, track = lineTrackAt(g, A), SP = cityStationSpacing(g, A.x, A.z, track, r.length);
    const d = Math.hypot(B.x - A.x, B.z - A.z);
    if (d < 2 * SP) continue;
    let best: { x: number; z: number; pop: number } | null = null;
    for (let s = SP; s <= d - SP + 1e-6; s += 3) {
      const x = A.x + (B.x - A.x) * s / d, z = A.z + (B.z - A.z) * s / d;
      const pop = uncoveredNear(g, covered, new Set(), x, z, cityStationRadius(g, x, z, track.mode));
      if (pop > 0 && (!best || pop > best.pop)) best = { x, z, pop };
    }
    if (!best) continue;
    const lv = (r.level ?? 'ground') as StationLevel;
    const rough = (2 * r.length * 9000 + 120000) * (lv === 'underground' ? 5 : lv === 'elevated' ? 3.5 : 1);
    const rank = best.pop * perRes * payback(h, track.mode) - 0.3 * rough;
    if (rank > 0) out.push({ kind: 'fill', a: A.id, b: B.id, x: best.x, z: best.z, pop: best.pop, rank });
  }
  out.sort((p, q) => q.rank - p.rank || p.pop - q.pop);
  // (the most promising six, two of each kind and level among them where there are: a cheap level that turns out not
  // to fit leaves the others their chance)
  const picked: typeof out = [], groups = new Map<string, typeof out>();
  for (const o of out) {
    const k = o.kind + (o.level ?? '');
    const candidates = groups.get(k) ?? [];
    candidates.push(o); groups.set(k, candidates);
  }
  // A high-population bend can be blocked by streets while the straight continuation is buildable.
  // Keep that cheaper alignment in the bounded search instead of spending both slots on one bend.
  for (const candidates of groups.values()) {
    if (picked.length < 6) picked.push(candidates[0]);
    const alternative = candidates.find(o => o !== candidates[0] && o.kind === 'ext' && o.turn === 0)
      ?? candidates.find(o => o !== candidates[0]);
    if (alternative && picked.length < 6) picked.push(alternative);
  }
  for (const o of out) if (picked.length < 6 && !picked.includes(o)) picked.push(o);
  picked.sort((p, q) => q.rank - p.rank || p.pop - q.pop);
  return picked.map(({ rank, ...o }) => { void rank; return o; });
}

/** The centre of a terminus's platform ends (outer end). */
function endCentre(g: Game, te: TerminusEnd): { x: number; z: number } {
  const a = g.world.net.nodes.get(te.heads[0])!, b = g.world.net.nodes.get(te.heads[te.heads.length - 1])!;
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

/** The terminus of a path end and its outer end. */
function terminusAt(h: GrowHost, path: number[], end: 0 | 1): { T: Station; te: TerminusEnd } | null {
  const g = h.g, T = g.stations.get(end ? path[path.length - 1] : path[0]), N = g.stations.get(end ? path[path.length - 2] : path[1]);
  if (!T?.rail || !N) return null;
  const te = terminusOf(g, T, outerEnd(T, N), h.me);
  return te ? { T, te } : null;
}

/**
 * Levels an extension may be built at: the terminus's own, underground (nothing above to demolish, a dense town), and
 * from a viaduct down to the ground too (out where the town thins, at a third of the price).
 */
function levelsFor(T: Station): StationLevel[] {
  const lv = (T.rail!.level ?? 'ground') as StationLevel;
  // city-integration: the subway branch builds underground-only lines with underground depots (subway-api.md); its
  // planner takes over here for underground extensions when merged.
  return lv === 'underground' ? ['underground'] : lv === 'elevated' ? ['elevated', 'ground', 'underground'] : ['ground', 'underground'];
}

/** Value one option in today's world: the better level for an extension; null when it does not fit. */
function evaluate(h: GrowHost, l: Line, path: number[], o: GrowOption): { score: number; level: StationLevel; fleet: boolean } | 'busy' | null {
  const g = h.g, sv = serviceOf(h, l, path, o.kind === 'ext' ? [path[o.end ? path.length - 1 : 0]] : [o.a!, o.b!]);
  if (!sv) return null;
  const before = path.map((id) => g.stations.get(id)!);
  const mode = railPartMode(before[0].rail!);
  if (o.kind === 'ext') {
    const t = terminusAt(h, path, o.end!), level = o.level ?? 'ground';
    if (!t) return null;
    const p = planExtension(h, t.T, t.te, o.n!, o.turn!, level, o);
    if (typeof p === 'string') { h.considered('extend.ext.' + p.split(' ')[0]); return p === 'busy' ? 'busy' : null; }
    const after: (Station | StationPlan)[] = o.end ? [...before, ...p.stations] : [...[...p.stations].reverse(), ...before];
    const v = value(h, l, before, after, p.works, p.track, p.stations, p.stations.length, sv, mode, level, p.crossoverUpkeep, p.crossoverTrack);
    h.considered('extend.ext.valued');
    const best = preference(h, 'ext', v);
    return best ? { ...best, level } : null;
  }
  const f = planFill(h, l, path, o);
  if (typeof f === 'string') { h.considered('extend.fill.' + f.split(' ')[0]); return null; }
  const i = path.indexOf(o.a!), j = path.indexOf(o.b!);
  const after: (Station | StationPlan)[] = [...before];
  after.splice(Math.max(i, j), 0, f.plan.station!);
  const lv = (before[0].rail!.level ?? 'ground') as StationLevel;
  // (a stop more costs a stop's dwell and braking each way: about a fifth of a hop)
  const v = value(h, l, before, after, f.plan.cost + compensation(g, f.plan.station!.demolish), 0, [f.plan.station!], 0.2, sv, mode, lv);
  h.considered('extend.fill.valued');
  const best = preference(h, 'fill', v);
  return best ? { ...best, level: lv } : null;
}

/** A station cut into the line's track between two stops near the option's point; a reason when none fits. */
function planFill(h: GrowHost, l: Line, path: number[], o: GrowOption): { plan: OnTrackPlan } | string {
  const g = h.g, net = g.world.net, me = h.me;
  const A = g.stations.get(o.a!), B = g.stations.get(o.b!);
  if (!A?.rail || !B?.rail || Math.abs(path.indexOf(A.id) - path.indexOf(B.id)) !== 1) return 'changed';
  const r = A.rail, SP = cityStationSpacing(g, o.x!, o.z!, lineTrackAt(g, A), r.length);
  const route = routeEdges(g, A.id, B.id, me);
  if (!route) return 'route';
  const q = { x: 0, y: 0, z: 0 }, spots: { e: number; s: number; d: number }[] = [];
  for (const id of route) {
    const e = net.edges.get(id);
    if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0 || e.len < 1 || g.stations.throughStationOf(e.id) >= 0) continue;
    for (let s = Math.min(2, e.len / 2); s <= e.len - Math.min(2, e.len / 2) + 1e-6; s += 3) {
      net.pointAt(e, s, q);
      const d = Math.hypot(q.x - o.x!, q.z - o.z!);
      if (d <= SP / 2) spots.push({ e: e.id, s, d });
    }
  }
  spots.sort((a, b) => a.d - b.d || a.e - b.e || a.s - b.s);
  const double = A.rail.tracks >= 2 && B.rail.tracks >= 2;
  let first = '';
  for (const sp of spots.slice(0, 10)) {
    if (!h.mayAlter([sp.e])) continue;
    const plan = planStationOnTrack(g, sp.e, sp.s, { length: r.length, tracks: double ? 2 : 1, mode: railPartMode(r) }, me);
    if (!plan.ok || !plan.station) { first ||= plan.error ?? 'site'; continue; }
    const st = plan.station;
    if ([...g.stations.map.values()].some((x) => x.rail && Math.hypot(x.x - st.x, x.z - st.z) < SP * 0.6)) { first ||= 'spacing'; continue; }
    if (!h.demolitionOk(st.demolish)) { first ||= 'demolition'; continue; }
    return { plan };
  }
  return first || 'site';
}

/** Edges of a route between two stations' platforms (either track, the cheaper way), or null. */
function routeEdges(g: Game, a: number, b: number, owner: number): number[] | null {
  const net = g.world.net, A = g.stations.get(a);
  let best: { ids: number[]; cost: number } | null = null;
  for (const eid of A?.rail?.edges ?? []) {
    const e = net.edges.get(eid);
    if (!e) continue;
    for (const d of [1, -1]) {
      const r = findRailRoute(g, railNext(g, e, d, owner), b, owner, -1, 20000);
      if (r && (!best || r.cost < best.cost)) best = { ids: r.conts.map((c) => c.edge.id), cost: r.cost };
    }
  }
  return best ? best.ids : null;
}

/** The plain track of a line's route both ways (both tracks of a double track), for directional running. */
function lineTrack(g: Game, path: number[], owner: number): number[] {
  const net = g.world.net, out = new Set<number>();
  for (let i = 0; i + 1 < path.length; i++) for (const [a, b] of [[path[i], path[i + 1]], [path[i + 1], path[i]]]) {
    const A = g.stations.get(a);
    for (const eid of A?.rail?.edges ?? []) {
      const e = net.edges.get(eid);
      if (!e) continue;
      for (const d of [1, -1]) {
        const r = findRailRoute(g, railNext(g, e, d, owner), b, owner, -1, 20000);
        if (r) for (const c of r.conts) if (c.edge.owner === owner && c.edge.station < 0 && c.edge.depot < 0 && g.stations.throughStationOf(c.edge.id) < 0) out.add(c.edge.id);
      }
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** Do the line's trains (every operator's) find their way between all consecutive stops, both ways? */
function routesOk(g: Game, l: Line, path: number[]): boolean {
  for (const owner of g.lines.operatorsOf(l)) for (let i = 0; i + 1 < path.length; i++) {
    if (!routeEdges(g, path[i], path[i + 1], owner) || !routeEdges(g, path[i + 1], path[i], owner)) return false;
  }
  return true;
}

/** New stops' pattern flags: a pattern serving the old terminus serves the new stations beyond it; the others not. */
function extendPatterns(l: Line, T: number, added: Set<number>) {
  if (!l.patterns || !l.patterns.length) return;
  for (const p of linePatterns(l)) {
    const i = l.stops.indexOf(T), serves = i >= 0 && p.stops[i] !== false;
    l.stops.forEach((sid, k) => { if (added.has(sid)) p.stops[k] = serves; });
  }
}

/** Consist-aware entry onto the stopping pattern, before either borrowing or purchasing. */
function addTrains(h: GrowHost, l: Line, sv: Service, n: number): number {
  const g = h.g, dp = g.depots.get(sv.depot), p = linePatterns(l).find((p) => p.id === sv.pid);
  if (n <= 0) return 0;
  const stops = l.stops.filter((_, i) => p?.stops[i] !== false);
  const reaches = !!dp && dp.owner === h.me && !!p && stops.some((s, i) => {
    const next = stops[(i + 1) % stops.length];
    return s !== next && depotServes(g, dp, s, next, sv.cars) >= 0;
  });
  const rule = consistRule(sv.cars);
  const routes = reaches && stops.every((s, i) => {
    const next = stops[(i + 1) % stops.length], st = g.stations.get(s);
    return s === next || !!st?.rail?.edges.some((id) => {
      const e = g.world.net.edges.get(id);
      return e && [1, -1].some((dir) => !!findRailRoute(g, railNext(g, e, dir, h.me, false, rule), next, h.me, -1, 80000, false, rule));
    });
  });
  if (!routes) { h.note(`${l.name}: no way from its depot through the service; no trains added`); h.considered('extend.depotCut'); return 0; }
  let bought = 0;
  for (let i = 0; i < n; i++) {
    // Each new departure consumes the line's blocks and platforms, including on a private city railway.
    // Reprice after each purchase so a profitable fleet-only alternative cannot buy an overcrowded batch.
    if (!(marginalSharedTrain(g, l, h.me, sv.cars, sv.pid) > 0)) break;
    if (!h.canSpend(sv.price * 1.1, 0.3)) break;
    const t = g.vehicles.buyTrain(sv.depot, [...sv.cars], l.id);
    if (typeof t === 'string') break;
    t.pattern = sv.pid; t.onLineChanged();
    bought++;
  }
  if (bought) h.ai.stats.vehicles += bought;
  return bought;
}

function observeCurrent(h: GrowHost, l: Line, path: number[], pid: number): void {
  const sv = serviceOf(h, l, path, [], pid);
  if (!sv) return;
  const points = sv.path.map((id) => h.g.stations.get(id)!);
  observedRate(h, l, carried(forecast(h.g, points, railPartMode(points[0].rail!), sv), sv), sv);
}

/** Revalue a chosen fleet-only alternative in today's world and buy only when it still wins on incentives. */
function buildFleet(h: GrowHost, l: Line, path: number[], o: GrowOption): boolean | 'busy' {
  const g = h.g, before = path.map((id) => g.stations.get(id)!);
  const sv = serviceOf(h, l, path, o.kind === 'ext' ? [path[o.end ? path.length - 1 : 0]] : [o.a!, o.b!]);
  if (!sv) return false;
  let after: (Station | StationPlan)[], works: number, track: number, stations: StationPlan[], level: StationLevel, crossoverUpkeep = 0, crossoverTrack = 0;
  if (o.kind === 'ext') {
    const t = terminusAt(h, path, o.end!);
    if (!t) return false;
    const p = planExtension(h, t.T, t.te, o.n!, o.turn!, o.level ?? 'ground', o);
    if (typeof p === 'string') return p === 'busy' ? 'busy' : false;
    after = o.end ? [...before, ...p.stations] : [...[...p.stations].reverse(), ...before];
    ({ works, track, stations, level, crossoverUpkeep, crossoverTrack } = p);
  } else {
    const f = planFill(h, l, path, o);
    if (typeof f === 'string') return false;
    const station = f.plan.station!;
    after = [...before]; after.splice(Math.max(path.indexOf(o.a!), path.indexOf(o.b!)), 0, station);
    works = f.plan.cost + compensation(g, station.demolish); track = 0; stations = [station]; level = station.level;
  }
  const v = value(h, l, before, after, works, track, stations, stations.length, sv, railPartMode(before[0].rail!), level, crossoverUpkeep, crossoverTrack);
  if (!preference(h, o.kind, v)?.fleet) return false;
  // addTrains owns the reachability and borrowing check; no funds are borrowed before that check.
  const bought = addTrains(h, l, sv, v.fleet.trains);
  if (!bought) return false;
  const info = h.managed()?.get(l.id);
  if (info) info.maxVehicles = Math.max(info.maxVehicles, h.fleet(l).ours.length);
  observeCurrent(h, l, path, sv.pid);
  h.succeed(); h.considered('extend.fleet');
  h.note(`${l.name}: added ${bought} trains on its existing route; fleet-only investment pays better than new stations (${Math.round(v.fleet.net / 1000)}k/year surplus)`);
  return true;
}

/**
 * An extension under construction (saved with the cursor): the sites of the stations still to build ([x, z, angle, depth,
 * height]), the stations built, the track pieces laid at the terminus and the new double track's start nodes there, the
 * links laid, the money spent so far, and its valuation (trains to add, revenue, surplus a year, capital).
 */
export interface GrowBuild { sites: number[][]; stations: number[]; pieces: number[]; starts: number[]; links: number[]; spent: number; trains: number; revenue: number; net: number; capital: number;
  /** work units the track waited for a depot spur to clear (trains on it); the depot moved out to the new terminus */
  waits: number; moved: boolean; pid?: number;
  /** Construction debits with the assets they paid for: retained/busy works cannot be refunded. */
  debits?: { cost: number; edges: number[]; stations: number[]; depots: number[] }[];
  /** the depot spur beyond the terminus (a lead in the way on, a tail's yard) and its depots: they move out to the new terminus */
  spur: number[]; depots: number[] }
export const copyGrowBuild = (b: GrowBuild): GrowBuild => ({ ...b, sites: b.sites.map((q) => [...q]), stations: [...b.stations], pieces: [...b.pieces], starts: [...b.starts], links: [...b.links],
  spur: [...b.spur], depots: [...b.depots], ...(b.debits ? { debits: b.debits.map((d) => ({ ...d, edges: [...d.edges], stations: [...d.stations], depots: [...d.depots] })) } : {}) });

/** An extension's plan and value in today's world (the funds it needs within the company's means), or a reason. */
function extValued(h: GrowHost, l: Line, path: number[], o: GrowOption): { T: Station; te: TerminusEnd; p: ExtPlan; v: Valuation; sv: Service } | string {
  const g = h.g;
  const t = terminusAt(h, path, o.end!);
  const sv = serviceOf(h, l, path, t ? [t.T.id] : []);
  if (!t || !sv) return 'changed';
  const p = planExtension(h, t.T, t.te, o.n!, o.turn!, o.level ?? 'ground', o);
  if (typeof p === 'string') return p;
  const before = path.map((id) => g.stations.get(id)!), mode = railPartMode(t.T.rail!);
  const after: (Station | StationPlan)[] = o.end ? [...before, ...p.stations] : [...[...p.stations].reverse(), ...before];
  const v = value(h, l, before, after, p.works, p.track, p.stations, p.stations.length, sv, mode, p.level, p.crossoverUpkeep, p.crossoverTrack);
  if (v.score <= 0 || v.fleet.score > v.score) return 'unpaid';
  if (!funds(h, 'ext', v.capital, true)) return 'funds';
  return { T: t.T, te: t.te, p, v, sv };
}

/** Record construction-category debits independently of loan inflows, with the assets created by this step. */
function recordWorks(h: GrowHost, b: GrowBuild, construction: number, edge: number, station: number, depot: number): void {
  const g = h.g, cost = Math.max(0, construction - g.company(h.me).economy.thisYear.construction);
  const edges: number[] = [], stations: number[] = [], depots: number[] = [];
  for (let id = edge; id < g.world.net.nextEdge; id++) if (g.world.net.edges.get(id)?.owner === h.me) edges.push(id);
  for (let id = station; id < g.stations.nextId; id++) if (g.stations.get(id)) stations.push(id);
  for (let id = depot; id < g.depots.nextId; id++) if (g.depots.get(id)) depots.push(id);
  // A failed crossover can refund its connector but leave splits of the new formation. Those assets
  // still belong to this build and must be removed on rollback even when this step's net debit is zero.
  if (!cost && !edges.length && !stations.length && !depots.length) return;
  (b.debits ??= []).push({ cost, edges, stations, depots });
  b.spent += cost;
}

/** Refund only removed works. A cursor from an older save that already moved its depot keeps its recovery route. */
function extUndo(h: GrowHost, name: string, b: GrowBuild, why: string) {
  const g = h.g, net = g.world.net, eco = g.company(h.me).economy;
  if (b.moved) { h.note(`extension of ${name} stopped: ${why}; moved depot and recovery tracks retained`); h.considered('extend.recover'); return; }
  const debits = b.debits ?? [];
  for (const id of new Set(debits.flatMap((d) => d.depots))) if (g.depots.get(id)) g.depots.remove(id);
  for (const id of new Set([...b.links, ...b.pieces, ...debits.flatMap((d) => d.edges)])) {
    const e = net.edges.get(id);
    if (e && e.depot < 0 && e.station < 0 && !g.vehicles.isEdgeBusy(id)) net.removeEdge(id);
  }
  for (const id of new Set([...b.stations, ...debits.flatMap((d) => d.stations)])) if (g.stations.get(id)) g.stations.removeStation(id);
  const removed = (d: typeof debits[number]) => d.edges.every((id) => !net.edges.has(id))
    && d.stations.every((id) => !g.stations.get(id)) && d.depots.every((id) => !g.depots.get(id));
  const legacyRemoved = [...b.links, ...b.pieces].every((id) => !net.edges.has(id)) && b.stations.every((id) => !g.stations.get(id));
  const untracked = Math.max(0, b.spent - debits.reduce((sum, d) => sum + d.cost, 0));
  const refund = debits.filter(removed).reduce((sum, d) => sum + d.cost, 0) + (legacyRemoved ? untracked : 0);
  if (refund > 0) eco.spend(-refund, 'construction', true);
  g.onNetworkChanged(); g.lines.rebuild();
  h.note(`extension of ${name} given up: ${why}; ${Math.round(refund / 1000)}k removed works refunded`);
  h.considered('extend.rollback');
}

/**
 * An extension's second step, a work unit a station: first valued again in today's world and the other track laid
 * out to a tail's fork; then each new station built (its site planned again). The build state, or a reason (what the
 * build laid so far taken up again).
 */
function extStations(h: GrowHost, l: Line, path: number[], o: GrowOption, prev?: GrowBuild): GrowBuild | string {
  const g = h.g, net = g.world.net, me = h.me, eco = g.company(me).economy;
  const ok = (q: Proposal) => h.consent(q) && h.demolitionOk(q.demolish);
  let b = prev;
  const construction = eco.thisYear.construction, edge0 = net.nextEdge, station0 = g.stations.nextId, depot0 = g.depots.nextId;
  const fail = (why: string) => { if (b) { recordWorks(h, b, construction, edge0, station0, depot0); extUndo(h, l.name, b, why); } };
  if (!b) {
    const x = extValued(h, l, path, o);
    if (typeof x === 'string') return x;
    const { T, te, p, v, sv } = x;
    if (te.kind === 'other') return 'terminus';
    b = { sites: p.stations.map((q) => [q.x, q.z, q.angle, q.depth, q.height]), stations: [], pieces: [], starts: [], links: [], spent: 0,
      trains: v.trains, revenue: v.revenue, net: v.net, capital: v.capital, waits: 0, moved: false, pid: sv.pid, debits: [], spur: [...te.lead], depots: [...te.depots] };
    for (let k = 0; k < te.heads.length; k++) {
      if (te.kind !== 'tail') { b.starts.push(te.heads[k]); continue; }
      if (k === te.root) { b.starts.push(te.fork); continue; }
      const n = net.nodes.get(te.heads[k])!, fx = n.x + te.ux * te.tail, fz = n.z + te.uz * te.tail;
      const pp = planEdge(g, nodeSnap(g, n.id, 'rail'), { kind: 'free', x: fx, z: fz, y: n.y },
        { kind: 'rail', type: lineTrackAt(g, T).type, tracks: 1, heightOffset: n.y - g.world.heightAt(fx, fz) || 1e-3, crossing: 'auto', owner: me });
      const e0 = net.nextEdge;
      if (!pp.ok || !ok(pp) || commitProposal(g, pp)) { fail('no room beside the tail'); return 'tail'; }
      for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.kind === 'rail') b.pieces.push(id);
      const q = nodeAt(g, 'rail', fx, fz);
      if (!q) { fail('track end'); return 'tail'; }
      b.starts.push(q.id);
    }
  } else b = copyGrowBuild(b);
  // the next station, planned again on its site at the terminus's style
  const t = terminusAt(h, path, o.end!), site = b.sites.shift();
  if (!t || !site) { fail('the line changed'); return 'changed'; }
  const r = t.T.rail!, level = o.level ?? 'ground';
  // (the terminus's style: city-integration, the one-track branch passes railPartMode as the station's style)
  const re = g.stations.planRail(site[0], site[1], site[2], r.length, 2, me, { trackType: lineTrackAt(g, t.T).platform, mode: railPartMode(r), level, ...(level !== 'ground' && g.stations.cityAt(site[0], site[1], g.towns.nearest(site[0], site[1])) ? { entrances: 4 } : {}), ...(site[3] ? { depth: site[3] } : {}), ...(site[4] ? { height: site[4] } : {}) });
  if (!re.ok || re.join?.rail || !h.demolitionOk(re.demolish)) { fail(re.error ?? 'station site'); return 'site'; }
  if (re.join) { re.links = [...new Set([...re.links, re.join])]; re.join = null; }
  const dem = [...re.demolish], residents = displacedResidents(g, dem), id = g.stations.nextId;
  if (g.stations.commitRail(re, me) || !g.stations.get(id)?.rail) { fail('station'); return 'station'; }
  h.compensate(dem, residents);
  b.stations.push(id);
  recordWorks(h, b, construction, edge0, station0, depot0);
  return b;
}

/** The double track from the terminus's start nodes out through the new stations, planned in today's world (`ignore`: a depot lead about to go). */
function linkPlans(h: GrowHost, T: Station, made: Station[], starts: number[], level: StationLevel, ignore?: BuildOptions['ignore']): Proposal[] | string {
  const g = h.g, net = g.world.net, me = h.me, out: Proposal[] = [];
  let from = starts;
  for (let i = 0; i < made.length; i++) {
    const st = made[i], ends = stationEnds(g, st);
    const opts = linkOpts(lineTrackAt(g, T), level, me, i === 0 ? T.rail! : made[i - 1].rail!, st.rail!, ignore);
    const lead = from.find((id) => net.nodes.get(id)!.edges.length === 1) ?? from[0];
    const snap = groupSnap(g, [lead]);
    snap.group = [...from];
    const pj = planEdge(g, snap, groupSnap(g, ends.map((e) => e.back)), opts);
    if (!pj.ok) return pj.errors[0] ?? 'track';
    if (!h.consent(pj) || !h.demolitionOk(pj.demolish)) return 'track consent';
    out.push(pj);
    from = ends.map((e) => e.front).reverse();
  }
  return out;
}

/**
 * An extension's third step: the double track from the terminus out to its new stations (unused until the next step).
 * A lead in the way is ignored when planning the track. The old depot and spur stay until final validation; this
 * step checks that a replacement yard fits. 'wait' while a train is on the spur.
 */
function extLinks(h: GrowHost, l: Line, path: number[], o: GrowOption, b: GrowBuild): GrowBuild | string {
  const g = h.g, net = g.world.net, me = h.me, eco = g.company(me).economy;
  const t = terminusAt(h, path, o.end!), T = t?.T;
  const made = b.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
  const construction = eco.thisYear.construction, edge0 = net.nextEdge, station0 = g.stations.nextId, depot0 = g.depots.nextId, out = copyGrowBuild(b);
  const fail = (why: string) => { recordWorks(h, out, construction, edge0, station0, depot0); extUndo(h, l.name, out, why); return why; };
  if (!t || !T || made.length !== b.stations.length || b.starts.some((id) => !net.nodes.has(id))) return fail('the line changed');
  const level = o.level ?? 'ground', te = t.te;
  const ok = (q: Proposal) => h.consent(q) && h.demolitionOk(q.demolish);
  const depots = b.depots.filter((d) => !!g.depots.get(d)), move = depots.length > 0;
  // (a lead: the new track starts at the platform ends, where the lead is)
  const lead = move && b.starts.every((id) => te.heads.includes(id));
  const plans = linkPlans(h, T, made, b.starts, level, lead ? spurIgnore(g, b.spur, depots) : undefined);
  if (typeof plans === 'string') return fail(plans);
  const last = made[made.length - 1], before = made.length > 1 ? made[made.length - 2] : T;
  const yard = move ? planTerminusYard(g, me, last, outerEnd(last, before), null, ok) : null;
  if (move) {
    if (b.spur.some((id) => g.vehicles.isEdgeBusy(id)) || depots.some((d) => depotBusy(g, d))) return 'wait';
    if (!yard) return fail('no yard at the new terminus');
  }
  for (const pj of plans) {
    const dem = [...pj.demolish], residents = displacedResidents(g, dem), e0 = net.nextEdge;
    if (commitProposal(g, pj)) return fail('track');
    for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.kind === 'rail' && net.edges.get(id)!.owner === me) out.links.push(id);
    h.compensate(dem, residents);
  }
  // Relocation waits until extConnect: all final validation and the irreversible move share one work unit.
  recordWorks(h, out, construction, edge0, station0, depot0);
  return out;
}

/**
 * An extension's last step: the line runs on to the new terminus (the old one a through stop, its patterns serving the
 * new stations as they served it, numbers in route order), directional running with crossovers before the new
 * terminus, signals, trains for today's headway. Where trains find no way through, everything the build laid is taken
 * up again (works refunded).
 */
function extConnect(h: GrowHost, l: Line, path: number[], o: GrowOption, b: GrowBuild): boolean | 'wait' {
  const g = h.g, me = h.me, net = g.world.net, eco = g.company(me).economy;
  const t = terminusAt(h, path, o.end!), T = t?.T;
  const made = b.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
  if (!T || made.length !== b.stations.length) { extUndo(h, l.name, b, 'the line changed'); return false; }
  const level = o.level ?? 'ground';
  const ids = made.map((s) => s.id);
  const np = o.end ? [...path, ...ids] : [...[...ids].reverse(), ...path];
  // Revalidate the complete route and all depot moves before discarding any old asset.
  if (!routesOk(g, l, np)) { extUndo(h, l.name, b, 'no way through'); return false; }
  const depots = b.moved ? [] : b.depots;
  if (depots.some((id) => !g.depots.get(id))) { extUndo(h, l.name, b, 'depot changed'); return false; }
  if (depots.some((id) => depotBusy(g, id)) || b.spur.some((id) => g.vehicles.isEdgeBusy(id))) return 'wait';
  const construction = eco.thisYear.construction, edge0 = net.nextEdge, station0 = g.stations.nextId, depot0 = g.depots.nextId;
  const fail = (why: string) => { recordWorks(h, b, construction, edge0, station0, depot0); extUndo(h, l.name, b, why); return false; };
  let home = -1;
  if (depots.length) {
    const last = made[made.length - 1], prev = made.length > 1 ? made[made.length - 2] : T;
    const ok = (q: Proposal) => h.consent(q) && h.demolitionOk(q.demolish);
    const yard = planTerminusYard(g, me, last, outerEnd(last, prev), null, ok);
    if (!yard) return fail('no yard at the new terminus');
    home = buildTerminusYard(g, me, yard, ok);
    if (home < 0) return fail('no yard at the new terminus');
  }
  // Finish the complete new pair. Routes through the old trunk can select crossover legs and omit
  // its longer companion, which makes them unsuitable inputs for discovering two physical tracks.
  // The old trunk already has directional running and must retain it.
  const ignored = depots.length ? [...b.spur, ...depots.map(id => g.depots.get(id)!.edge)] : [];
  const fin = finishDoubleTrack(g, b.links, me, { ignoreEdges: ignored });
  if (fin.error) return fail('incomplete directional extension: ' + fin.error);
  if (!routesOk(g, l, np)) return fail('no way through after directional running');
  if (home >= 0) {
    const dp = g.depots.get(home)!;
    const homed = [...g.vehicles.map.values()].filter((v): v is Train => v.kind === 'train' && depots.includes((v as Train).depotId));
    if (!homed.every((v) => path.some((sid, i) => i + 1 < path.length && depotServes(g, { ...dp, owner: v.owner }, sid, path[i + 1], v.cars) >= 0))) return fail('new depot cannot serve the old route');
    for (const id of depots) {
      const err = moveDepotHome(g, id, home);
      if (err) return fail('depot ' + err);
      b.moved = true; // Protect every exit even if a later move unexpectedly fails.
    }
    let len = 0;
    for (const id of b.spur) { const e = net.edges.get(id); if (e) { len += e.len; net.removeEdge(id); } }
    eco.spend(len * 400, 'construction', true);
    g.onNetworkChanged(); h.stat('netDepotsMoved');
    h.note(`moved the depot at ${T.name} out to ${made[made.length - 1].name}: ${l.name} runs on beyond ${T.name}`);
  }
  recordWorks(h, b, construction, edge0, station0, depot0);
  h.setStops(l, outAndBack(np));
  extendPatterns(l, T.id, new Set(ids));
  if (!o.end) g.lines.renumber(l.id);
  g.lines.rebuild();
  for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
  h.signal(l.id);
  const sv = serviceOf(h, l, np, [T.id], b.pid);
  const bought = sv ? addTrains(h, l, sv, b.trains) : 0;
  if (sv) observeCurrent(h, l, np, sv.pid);
  const info = h.managed()?.get(l.id);
  if (info) {
    info.maxVehicles = Math.max(info.maxVehicles, h.fleet(l).ours.length);
    info.towns = [...new Set(np.map((sid) => g.stations.get(sid)?.townId ?? -1).filter((x) => x >= 0))];
  }
  h.canon(l.id);
  h.stat('netExtended');
  h.succeed();
  const last = made[made.length - 1];
  const where = level === 'underground' && (T.rail!.level ?? 'ground') !== 'underground' ? ' (underground)' : '';
  h.note(`extended ${l.name} beyond ${T.name} to ${last.name}${where}: ${made.length} station${made.length > 1 ? 's' : ''}, ${Math.round(b.revenue / 1000)}k revenue, ${Math.round(b.net / 1000)}k/year surplus on ${Math.round(b.capital / 1000)}k${bought ? `, ${bought} train${bought > 1 ? 's' : ''} more` : ''}`);
  h.news(`extends ${l.name} beyond ${T.name} to ${last.name}: the town has grown past the line.`, last.x, last.z);
  return true;
}

/** Build a planned stop in a long gap (re-planned and valued in today's world); true when built. */
function buildFill(h: GrowHost, l: Line, path: number[], o: GrowOption): boolean {
  const g = h.g, me = h.me;
  const sv = serviceOf(h, l, path, [o.a!, o.b!]);
  const f = planFill(h, l, path, o);
  if (!sv || typeof f === 'string') { if (typeof f === 'string') h.note(`no stop between ${g.stations.get(o.a!)?.name} and ${g.stations.get(o.b!)?.name} on ${l.name}: ${f}`); return false; }
  const before = path.map((id) => g.stations.get(id)!), mode = railPartMode(before[0].rail!);
  const i = path.indexOf(o.a!), j = path.indexOf(o.b!);
  const after: (Station | StationPlan)[] = [...before];
  after.splice(Math.max(i, j), 0, f.plan.station!);
  const lv = (before[0].rail!.level ?? 'ground') as StationLevel;
  const v = value(h, l, before, after, f.plan.cost + compensation(g, f.plan.station!.demolish), 0, [f.plan.station!], 0.2, sv, mode, lv);
  if (v.score <= 0) { h.considered('extend.fill.unpaid'); return false; }
  if (!funds(h, 'fill', v.capital, true)) { h.considered('extend.fill.funds'); return false; }
  const dem = [...f.plan.station!.demolish], residents = displacedResidents(g, dem);
  const res = commitStationOnTrack(g, f.plan);
  if (res.error === 'busy') { h.careFor('grow' + l.id, 15); return false; }
  const st = g.stations.get(res.station);
  if (res.station < 0 || !st) { h.note(`stop on ${l.name} failed: ${res.error ?? ''}`); return false; }
  h.compensate(dem, residents);
  const np = [...path];
  np.splice(Math.max(i, j), 0, st.id);
  const old = [...l.stops];
  h.setStops(l, outAndBack(np));
  if (!routesOk(g, l, np)) { h.setStops(l, old); h.note(`${st.name} is not on ${l.name}'s way: the line keeps its stops`); return true; }
  h.localOnly(l, st.id);
  g.lines.rebuild();
  for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
  h.signal(l.id);
  addTrains(h, l, sv, v.trains);
  observeCurrent(h, l, np, sv.pid);
  h.canon(l.id);
  h.stat('netGrowInfill');
  h.succeed();
  h.note(`opened ${st.name} on ${l.name} between ${g.stations.get(o.a!)?.name} and ${g.stations.get(o.b!)?.name} (${Math.round(v.net / 1000)}k/year surplus on ${Math.round(v.capital / 1000)}k)`);
  h.news(`opens ${st.name} on ${l.name}: the town has filled in between its stations.`, st.x, st.z);
  void me;
  return true;
}

/**
 * The 'extend' work item for one line (ai-network.ts): survey, then one option valued per work unit (its best level),
 * then the best option re-planned, valued and built in today's world. Its state lives in `item.grow` (saved with the
 * planner): only plain numbers survive a work unit.
 */
export function* growTask(h: GrowHost, item: { ids: number[]; grow?: GrowCursor }): Generator<void, void> {
  const g = h.g, id = item.ids[0], key = 'grow' + id;
  const finish = (days: number, why: string) => { delete item.grow; h.careFor(key, days); h.considered('extend.' + why); };
  const retryBusy = (why: string) => { finish(15, why); scheduleNetworkTask(h.ai, 'extend', 15); };
  const l = g.lines.map.get(id);
  const path = l ? growLine(h, l) : null;
  const cursor = item.grow ??= { at: 0 };
  if (!l || !path || h.ai.railPolicy.deepTrouble || (h.ai.railPolicy.accounts.get(l.id)?.step ?? 0) > 0) {
    // (an extension half built: what it laid is taken up again)
    if (cursor.made) extUndo(h, l?.name ?? 'a line', cursor.made, 'the line changed');
    finish(180, 'invalid');
    return;
  }
  if (cursor.at === 0) {
    delete cursor.encounteredBusy;
    h.considered('extend.line');
    const opts = survey(h, l, path);
    yield;
    if (!opts.length) { finish(360, 'nothing'); return; }
    cursor.opts = opts; cursor.at = 1;
    return;
  }
  const opts = cursor.opts ?? [], n = opts.length;
  if (cursor.at <= n) {
    const i = cursor.at - 1;
    cursor.at++;
    const ev = evaluate(h, l, path, opts[i]);
    yield;
    if (ev === 'busy') { if (!cursor.best) cursor.encounteredBusy = true; }
    else if (ev && ev.score > 0 && (!cursor.best || ev.score > cursor.best.score)) {
      cursor.best = { opt: i, score: ev.score, fleet: ev.fleet }; delete cursor.encounteredBusy;
    }
    return;
  }
  const best = cursor.best;
  if (!best) {
    const busy = cursor.encounteredBusy;
    if (busy) retryBusy('busy');
    else finish(360, 'unpaid');
    return;
  }
  const o = opts[best.opt];
  if (best.fleet && !cursor.made) {
    const built = buildFleet(h, l, path, o);
    if (built === 'busy') retryBusy('busy');
    else finish(360, 'build');
    yield; return;
  }
  if (o.kind === 'fill') { finish(360, 'build'); buildFill(h, l, path, o); yield; return; }
  // the extension's build, a step a work unit (a save between steps resumes them): (n + 1) the stations, one a unit;
  // (n + 2) the track to them; (n + 3) final validation, depot relocation and the line running on atomically
  if (cursor.at === n + 1) {
    const b = extStations(h, l, path, o, cursor.made);
    yield;
    if (typeof b === 'string') {
      delete cursor.made;
      if (b === 'busy') retryBusy('ext.busy');
      else finish(360, 'ext.' + b.split(' ')[0]);
      return;
    }
    cursor.made = b;
    if (!b.sites.length) cursor.at = n + 2;
    return;
  }
  if (cursor.at === n + 2) {
    const b = extLinks(h, l, path, o, cursor.made!);
    yield;
    if (b === 'wait' && cursor.made!.waits < 20) { cursor.made!.waits++; return; }
    if (typeof b === 'string') { if (b === 'wait') extUndo(h, l.name, cursor.made!, 'trains kept the depot lead busy'); delete cursor.made; finish(360, 'ext.' + b.split(' ')[0]); return; }
    cursor.made = b; cursor.at = n + 3;
    return;
  }
  const b = cursor.made;
  const connected = b ? extConnect(h, l, path, o, b) : false;
  yield;
  if (connected === 'wait' && b && b.waits < 20) { b.waits++; return; }
  if (connected === 'wait' && b) extUndo(h, l.name, b, 'trains kept the depot lead busy');
  finish(360, 'build');
}
