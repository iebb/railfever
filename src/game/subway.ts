// Subways: urban railways that stay underground the whole way (no ramps or portals, nothing demolished above them;
// construction.ts BuildOptions.subway), their underground depots (build-ops.ts UNDERGROUND_DEPOT), and the planners
// the AI and city-line extensions use: a depot at depth beyond a station's free platform end (planSubwayYard), a
// line extended underground from its terminus (planSubwayExtension), and what a line on the ground would demolish
// instead (surfaceDemolition). All of it is ordinary rail: the same trains, signals, fares and catchments.
import type { Game } from './game';
import { TRACK_TYPES, LINE_LEVEL } from './constants';
import { planEdge, commitProposal, structureFactor, nodeGroup, SHARED_TRACK, type Snap, type Proposal, type BuildOptions } from './construction';
import { demolitionTotal } from './demolition';
import { STATION_DEPTH, type StationPlan, type StationOpts } from './stations';
import { distToRect } from './world';
import { endTangent } from './geom';
import { stationEnds, depotAtEnd, nodeSnap, removeEdges } from './routing';

export interface P2 { x: number; z: number }

/**
 * What a railway on the ground along these points would demolish: the buildings on its formation (half width
 * `halfWidth`) and where its cut or fill reshapes the ground beside it (`regrade`, a typical allowance in towns),
 * at the land value there (demolition.ts). An estimate for comparing alignments; planEdge has the exact figure.
 */
export function surfaceDemolition(g: Game, pts: P2[], halfWidth = 0.55, regrade = 0.8): { buildings: number[]; cost: number } {
  const w = g.world, ids = new Set<number>(), reach = halfWidth + 0.1 + regrade;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    for (let t = 0; t <= L + 1e-6; t += 0.5) {
      const x = a.x + (b.x - a.x) * (t / L), z = a.z + (b.z - a.z) * (t / L);
      for (const bd of w.buildingsNear(x, z, reach + 2)) if (!ids.has(bd.id) && distToRect(x, z, bd.x, bd.z, bd.angle, bd.w / 2, bd.d / 2) <= reach) ids.add(bd.id);
    }
  }
  return { buildings: [...ids], cost: Math.round(demolitionTotal(g, ids)) };
}

/**
 * Construction cost per unit of route of a subway at `depth` with `tracks` tracks: the first track with the tunnel in
 * full (structureFactor), each further one sharing the bore (SHARED_TRACK), as planEdge prices it.
 */
export function subwayCostPerUnit(type: string, depth: number, tracks = 2): number {
  const per = (TRACK_TYPES[type] ?? TRACK_TYPES.standard).costPerUnit, f = structureFactor('rail', 'tunnel', depth);
  return per * f + Math.max(0, tracks - 1) * per * (SHARED_TRACK.materials + (f - 1) * SHARED_TRACK.structures);
}

/** Build options of a subway (underground the whole way, at `depth`). */
export function subwayOpts(type: string, tracks: number, owner: number, depth: number): BuildOptions {
  return { kind: 'rail', type, tracks, heightOffset: 0, crossing: 'auto', owner, level: 'underground', levelDepth: Math.max(LINE_LEVEL.depth.min, Math.min(LINE_LEVEL.depth.max, depth)), subway: true };
}

// ------------------------------------------------------------------------------------ depots at depth

/** A planned underground depot beyond a free platform end: a tunnel stub and the depot cavern at its end. */
export interface SubwayYardPlan {
  ok: boolean; error?: string;
  /** the stub's end (the depot's exit) and its height; the stub's length */
  x: number; z: number; y: number; length: number;
  /** way out of the station (unit) */
  dx: number; dz: number;
  /** depth the stub was planned at (LINE_LEVEL range) */
  depth: number;
  stubCost: number; depotCost: number; cost: number;
}

/**
 * Plan an underground depot off a free track end `start` (a node, or a planned one: its position, height and the way
 * out): a tunnel stub of `lengths` units at the platform's depth (room for the throat's turnout from the other platform
 * track, connectStationThroat), then the cavern beyond its end. `lat` turns the stub aside (units to the left of the
 * way out, negative: right) on one arc, leaving the way straight on free (a yard off a tail beyond a terminus that the
 * line can later be extended from). No ramp, no portal, nothing at street level but its vents. Nothing is built.
 */
export function planSubwayYard(g: Game, start: { x: number; y: number; z: number; dx: number; dz: number; node?: number }, owner: number, opts: { type?: string; depth?: number; lengths?: number[]; lat?: number } = {}): SubwayYardPlan {
  const net = g.world.net;
  const type = opts.type ?? 'metro';
  const depth = Math.max(LINE_LEVEL.depth.min, Math.min(LINE_LEVEL.depth.max, opts.depth ?? (g.world.heightAt(start.x, start.z) - start.y)));
  const res: SubwayYardPlan = { ok: false, x: 0, z: 0, y: 0, length: 0, dx: start.dx, dz: start.dz, depth, stubCost: 0, depotCost: 0, cost: 0 };
  let why = 'No room for a depot underground';
  const lat = opts.lat ?? 0;
  for (const L of opts.lengths ?? [8, 10, 12, 14]) {
    const ex = start.x + start.dx * L - start.dz * lat, ez = start.z + start.dz * L + start.dx * lat;
    if (!g.world.inside(ex, ez, 8)) continue;
    const o = subwayOpts(type, 1, owner, depth);
    const plan = (nodeId: number) => planEdge(g, { kind: 'node', x: start.x, y: start.y, z: start.z, node: nodeId }, { kind: 'free', x: ex, z: ez, y: 0 }, o);
    const pr = start.node !== undefined ? plan(start.node) : net.withTemporaryNodes('rail', [start], owner, (nodes) => plan(nodes[0].id));
    if (!pr.ok) { why = pr.errors[0] ?? why; continue; }
    const tp = pr.tracks[0], y = tp.prof[tp.prof.length - 1], t = endTangent(tp.bez);
    // the cavern beyond the stub's end, facing back along it
    const dp = g.depots.plan('rail', ex + t.x * 2.15, ez + t.z * 2.15, Math.atan2(-t.x, -t.z), owner, { level: 'underground', y, snap: false });
    if (!dp.ok) { why = dp.error ?? why; continue; }
    return { ok: true, x: ex, z: ez, y, length: L, dx: start.dx, dz: start.dz, depth, stubCost: pr.cost, depotCost: dp.cost, cost: pr.cost + dp.cost };
  }
  res.error = why;
  return res;
}

/**
 * Build a planned yard off the free platform end `node`: the stub in tunnel, then the depot at its end (underground:
 * depotAtEnd builds underground at a tunnel end). Returns the depot id, or -1 with nothing left behind.
 */
export function buildSubwayYard(g: Game, node: number, yard: SubwayYardPlan, owner: number, type = 'metro'): number {
  const net = g.world.net, n = net.nodes.get(node);
  if (!yard.ok || !n || n.edges.length !== 1) return -1;
  const pr = planEdge(g, nodeSnap(g, node, 'rail'), { kind: 'free', x: yard.x, z: yard.z, y: 0 }, subwayOpts(type, 1, owner, yard.depth));
  if (!pr.ok) return -1;
  const e0 = net.nextEdge;
  if (commitProposal(g, pr)) return -1;
  const end = net.nearestNode(yard.x, yard.z, 0.1, 'rail', (q) => q.edges.length === 1);
  const id = end ? depotAtEnd(g, end.id, owner) : -1;
  if (id < 0) removeEdges(g, [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.owner === owner).map((e) => e.id), owner);
  return id;
}

// ------------------------------------------------------------------------------------ extending a line underground

export interface SubwayExtensionOpts {
  /** platform track type of the new station and the tunnel (default: the terminus' platform track type) */
  trackType?: string;
  /** platform length (default: the terminus') */
  length?: number;
  /** platform tracks of the new station (default: as many as the terminus has free at that end, at most 2) */
  tracks?: number;
  /** wanted platform depth below the ground (default: the terminus' depth when underground, else STATION_DEPTH.metro) */
  depth?: number;
  /** a terminus on the surface: tunnel from it with a ramp and portal right beyond it (default false: fail) */
  allowRamp?: boolean;
  /** further planRail options (style, platform style, screen doors) */
  station?: Partial<StationOpts>;
}

export interface SubwayExtensionPlan {
  ok: boolean; error?: string;
  owner: number;
  /** the terminus station and the end of it the extension leaves from */
  terminus: number; end: 'front' | 'back';
  /** the new underground station (its axis continues the line on one arc from the terminus) */
  station: StationPlan | null;
  /** the tunnel as planned (against the new platforms' planned ends); re-planned on the real ones when built */
  tunnel: Proposal | null;
  cost: number;
  costSplit: { station: number; tunnels: number; demolition: number };
  /** buildings demolished (only where the new station's entrance pavilions go) */
  demolish: number[];
  tunnelLength: number;
  /** tracks of the tunnel */
  tracks: number;
  /** a ramp and portal beyond a terminus on the surface (allowRamp) */
  ramp: boolean;
}

/**
 * Plan extending a line underground from its terminus `terminusId` to a new underground station centred at (x, z):
 * the station's platforms continue the line on a single arc from the terminus' free end (no S-bend), at a depth the
 * tunnel reaches within the track type's grade, and a tunnel joins every free platform track of that end to it (double
 * track when both have two), all underground (BuildOptions.subway: no portal, nothing demolished above it). A
 * terminus on the surface needs `allowRamp` (a ramp and portal right beyond it). Nothing is built; the line's stops
 * are the caller's to change.
 */
export function planSubwayExtension(g: Game, terminusId: number, x: number, z: number, owner: number, opts: SubwayExtensionOpts = {}): SubwayExtensionPlan {
  const net = g.world.net, w = g.world;
  const res: SubwayExtensionPlan = { ok: false, owner, terminus: terminusId, end: 'front', station: null, tunnel: null, cost: 0, costSplit: { station: 0, tunnels: 0, demolition: 0 }, demolish: [], tunnelLength: 0, tracks: 0, ramp: false };
  const bad = (e: string) => { res.ok = false; res.error = e; return res; };
  const T = g.stations.get(terminusId);
  if (!T?.rail) return bad('Not a rail station');
  if (!g.canUse(owner, T.owner)) return bad(`${T.name} belongs to ${g.company(T.owner).name} (no track access)`);
  const r = T.rail;
  const ends = stationEnds(g, T);
  const ax = Math.sin(r.angle), az = Math.cos(r.angle);
  // the free end facing the target (every platform track free there)
  let side = 0, nodes: number[] = [];
  for (const sg of [1, -1]) {
    const ids = ends.map((e) => (sg > 0 ? e.front : e.back));
    if (!ids.length || !ids.every((id) => net.nodes.get(id)?.edges.length === 1)) continue;
    if (((x - r.x) * ax + (z - r.z) * az) * sg <= r.length / 2) continue;
    side = sg; nodes = ids;
  }
  if (!side) return bad('The terminus has no free end facing there');
  res.end = side > 0 ? 'front' : 'back';
  const under = (r.level ?? 'ground') === 'underground';
  if (!under && !opts.allowRamp) return bad('The terminus is not underground (allow a ramp to tunnel from it)');
  res.ramp = !under;
  const type = opts.trackType ?? r.trackType ?? 'metro';
  const tt = TRACK_TYPES[type] ?? TRACK_TYPES.metro;
  const L = opts.length ?? r.length;
  const N = Math.max(1, Math.min(2, opts.tracks ?? nodes.length, nodes.length));
  const tracks = Math.max(N, Math.min(8, opts.tracks ?? N));
  res.tracks = N;
  // the arc from the end (the centre of its free tracks) to the new platforms' near end: tangent there by reflecting
  // the start tangent about the chord (a circular arc), iterated as the near end moves with the platforms' axis
  let p0x = 0, p0z = 0, p0y = 0;
  for (const id of nodes) { const n = net.nodes.get(id)!; p0x += n.x / nodes.length; p0z += n.z / nodes.length; p0y += n.y / nodes.length; }
  const t0x = ax * side, t0z = az * side;
  let ux = t0x, uz = t0z, cx = 0, cz = 0, chord = 0, cosT = 1;
  for (let k = 0; k < 4; k++) {
    const e1x = x - ux * L / 2, e1z = z - uz * L / 2;
    chord = Math.hypot(e1x - p0x, e1z - p0z);
    if (chord < 1e-6) break;
    cx = (e1x - p0x) / chord; cz = (e1z - p0z) / chord;
    cosT = t0x * cx + t0z * cz;
    ux = 2 * cosT * cx - t0x; uz = 2 * cosT * cz - t0z;
  }
  if (chord < 6) return bad('Too close to the terminus');
  if (cosT < 0.5) return bad('Too sharp a turn from the terminus');
  const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
  const radius = theta < 1e-4 ? Infinity : chord / (2 * Math.sin(theta));
  if (radius < tt.minRadius + (N - 1) * 0.45) return bad(`Too sharp a turn (radius ${Math.round(radius * 10)} m, min ${tt.minRadius * 10} m)`);
  const arc = theta < 1e-4 ? chord : radius * 2 * theta;
  res.tunnelLength = arc;
  // depth: as wanted, within the grade from the terminus' platforms
  const angle = Math.atan2(ux, uz);
  const depth = opts.depth ?? (under ? r.depth || STATION_DEPTH.metro : STATION_DEPTH.metro);
  const so: StationOpts = { level: 'underground', depth, trackType: type, ...opts.station };
  let sp = g.stations.planRail(x, z, angle, L, tracks, owner, so);
  const reach = tt.maxGrade * 0.85 * Math.max(1, arc - 1);
  if (sp.ok && Math.abs(sp.y - p0y) > reach) sp = g.stations.planRail(x, z, angle, L, tracks, owner, { ...so, fixedY: Math.max(p0y - reach, Math.min(p0y + reach, sp.y)) });
  if (!sp.ok) return bad(sp.error ?? 'No room for the station underground');
  // (a stop-only station there stays a station of its own, linked for transfers: taking the new station down again
  // must not take its stops with it)
  if (sp.join) { sp.links = [...new Set([...sp.links, sp.join])]; sp.join = null; }
  res.station = sp;
  // the tunnel to the new platforms' near end (planned against nodes standing in for them)
  const ox = Math.cos(angle), oz = -Math.sin(angle);
  const near = sp.layout.trackOffsets.map((off) => ({ x: sp.x + ox * off - ux * L / 2, z: sp.z + oz * off - uz * L / 2, y: sp.y, dx: -ux, dz: -uz }));
  const o: BuildOptions = res.ramp ? { kind: 'rail', type, tracks: N, heightOffset: 0, crossing: 'auto', owner, level: 'underground', levelDepth: Math.max(LINE_LEVEL.depth.min, Math.min(LINE_LEVEL.depth.max, depth)) } : subwayOpts(type, N, owner, depth);
  const pr = net.withTemporaryNodes('rail', near, owner, (tmp) => {
    const grp = nodeGroup(g, tmp[0].id);
    const end: Snap = { kind: 'node', x: tmp[0].x, y: tmp[0].y, z: tmp[0].z, node: tmp[0].id, group: grp.length >= N ? grp : tmp.map((q) => q.id) };
    return planEdge(g, nodeSnap(g, nodes[0], 'rail'), end, o);
  });
  res.tunnel = pr;
  if (!pr.ok) return bad(`Tunnel: ${pr.errors[0] ?? 'cannot be planned'}`);
  res.demolish = [...new Set([...sp.demolish, ...pr.demolish])];
  res.costSplit = { station: sp.cost, tunnels: pr.cost, demolition: Math.round(demolitionTotal(g, res.demolish)) };
  res.cost = sp.cost + pr.cost;
  res.ok = true;
  if (!g.company(owner).economy.canAfford(res.cost)) res.error = 'Not enough money';
  return res;
}

/**
 * Build a planned underground extension: the station, then the tunnel re-planned on its real platform ends. A tunnel
 * that no longer plans takes the new station down again (its cost refunded). The line's stops are the caller's.
 */
export function commitSubwayExtension(g: Game, plan: SubwayExtensionPlan): { error: string | null; station: number; edges: number[] } {
  const net = g.world.net;
  const none = (error: string) => ({ error, station: -1, edges: [] as number[] });
  if (!plan.ok || !plan.station || !plan.tunnel) return none(plan.error ?? 'Cannot build');
  const T = g.stations.get(plan.terminus);
  if (!T?.rail) return none('The terminus is gone');
  const nodes = stationEnds(g, T).map((e) => (plan.end === 'front' ? e.front : e.back));
  if (!nodes.every((id) => net.nodes.get(id)?.edges.length === 1)) return none('The terminus end is no longer free');
  const eco = g.company(plan.owner).economy;
  if (!eco.canAfford(plan.cost)) return none('Not enough money');
  const sid = g.stations.nextId;
  const err = g.stations.commitRail(plan.station, plan.owner);
  if (err) return none(err);
  const st = g.stations.get(sid);
  if (!st?.rail) return none('Station not built');
  const fx = Math.sin(st.rail.angle), fz = Math.cos(st.rail.angle);
  const toward = (T.x - st.x) * fx + (T.z - st.z) * fz > 0;
  const near = stationEnds(g, st).map((e) => (toward ? e.front : e.back));
  const tp = plan.tunnel.opts;
  const e0 = net.nextEdge;
  const pr = planEdge(g, nodeSnap(g, nodes[0], 'rail'), nodeSnap(g, near[0], 'rail'), tp);
  const fail = (why: string) => {
    removeEdges(g, [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id), plan.owner);
    if (!g.stations.removeStation(st.id)) eco.spend(-plan.station!.cost, 'construction', true);
    return none(why);
  };
  if (!pr.ok) return fail(`Tunnel: ${pr.errors[0] ?? 'cannot be built'}`);
  const ce = commitProposal(g, pr);
  if (ce) return fail(ce);
  const edges = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id);
  return { error: null, station: st.id, edges };
}
