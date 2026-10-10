// Shared stations for lines that end apart (connected networks): two of our railways ending at separate stations of one
// town, too far apart for a walking link, are brought to one station in staged works while their trains keep running:
//  1. new platforms where both lines can reach them (on the ground, elevated or underground where the centre or the
//     alignment needs it): a through station between the two approaches (each line from its own end, so the lines can
//     later run through), or a terminus both approach from one side;
//  2. a branch from each line's approach track to them (a turnout on the line, the old platforms in service meanwhile);
//     the platform throats connected; then each line's stop moves to the new platforms once none of its trains is
//     committed to the old ones (waiting passengers and mail move over);
//  3. the old platforms no line uses any more taken up with their track stubs (the usual removal costs).
// Valued by what it earns: the lines' forecasts at the new site against the old (catchment), and the journeys between the
// two lines' other stations the shared station newly allows (one change of trains: 10% off the fares, as charged; a
// through service later avoids it), against the works, their upkeep less the old platforms', and the cost of capital.
// Every stage is one bounded work unit; the cursor (WorkItem.hub) holds plain data only, so a save during the works
// resumes the same decisions on the same tick.
import type { Game } from './game';
import type { Line } from './lines';
import type { Station, StationPlan, StationLevel } from './stations';
import type { NEdge } from './network';
import type { Proposal, BuildOptions, Snap } from './construction';
import type { AIController } from './ai';
import type { VehicleModel } from './vehicle-types';
import { linearStops } from './lines';
import { STATION_DEPTH, STATION_HEIGHT, STATION_UPKEEP_FACTOR } from './stations';
import { Train, findRailRoute, platformDepartureFrontiers, consistRule, depotServes } from './train';
import { planEdge, commitProposal, findSnap } from './construction';
import { nodeSnap, stationEnds } from './routing';
import { trackMaintenance } from './opcosts';
import { demolitionCost } from './demolition';
import { plannedSet } from './demand';
import { patternHeadway } from './patterns';
import { cargoGroups } from './vehicle';
import { absorbMail, settleMail } from './mail';

/** Termini of two lines this far apart (units) at most are looked at; a branch leaves a line this far out (either). */
export const HUB_REACH = 160, HUB_ANCHORS = [24, 50, 80];
/** Tests and calibration: build the best feasible hub whatever its economics (as networkOptions.xlinkForce). */
export const hubOptions = { force: false };

export interface HubHost {
  readonly g: Game; readonly me: number; readonly ai: AIController;
  note(s: string): void;
  news(s: string, x?: number, z?: number): void;
  considered(k: string): void;
  stat(n?: number): void;
  succeed(): void;
  cared(key: string): boolean;
  careFor(key: string, days: number): void;
  canSpend(cost: number, share?: number): boolean;
  affordable(cost: number, share?: number): boolean;
  managed(): Map<number, { depot: number; maxVehicles: number; towns: number[]; opened: number }> | null;
  signal(lineId: number): number;
  consent(p: Proposal, planned?: boolean): boolean;
  demolitionOk(ids: number[]): boolean;
  compensate(ids: number[], residents?: { townId: number; pop: number; cost: number }[]): void;
  /** monthly trips and yearly receipts newly possible between two sets of stations (a change of trains: x0.9) */
  newTrips(as: number[], bs: number[], direct: boolean, headway: number): { trips: number; revenue: number };
  headway(ls: Line[]): number;
  takeUpStub(nodeId: number): number;
  reachesAvoiding(node: number, A: Station, B: Station): boolean;
  connectThroat(stationId: number): void;
}

interface Point { x: number; y: number; z: number }
/** Where a line's branch leaves its approach: the point, the direction out of town there, the distance from the old platforms. */
interface Anchor extends Point { ux: number; uz: number; dist: number }
/** A site for the new platforms: centre, axis, level, per line its platform track and end (0 back, 1 front), and where its branch leaves. */
export interface HubOption { x: number; z: number; angle: number; level: StationLevel; length: number; track: number[]; end: number[]; anchors: Anchor[] }
interface Debit { cost: number; edges: number[]; station: number; refundable: number }
export interface HubCursor {
  stage: 'value' | 'station' | 'branch' | 'throat' | 'switch' | 'remove';
  at: number; identity: string;
  /** the two lines' old termini in the town */
  olds: number[];
  /** the sites that pay, best first (`best`: the one being built) */
  options: HubOption[]; ranked?: { option: number; score: number; capital: number; trips: number }[];
  best?: { option: number; score: number; capital: number; trips: number };
  /** receipts of the two lines as they are (forecast), once */
  base?: number[];
  built?: { station: number; spent: number; debits: Debit[]; waits: number; switched: number[]; removed: number[] };
  /** the works wait for trains to pass (the planner puts them aside meanwhile: other tasks and projects go on) */
  wait?: boolean;
}
export const copyHubCursor = (c: HubCursor): HubCursor => ({ ...c, olds: [...c.olds],
  options: c.options.map((o) => ({ ...o, track: [...o.track], end: [...o.end], anchors: o.anchors.map((a) => ({ ...a })) })), ...(c.best ? { best: { ...c.best } } : {}),
  ...(c.ranked ? { ranked: c.ranked.map((r) => ({ ...r })) } : {}),
  ...(c.base ? { base: [...c.base] } : {}),
  ...(c.built ? { built: { ...c.built, debits: c.built.debits.map((d) => ({ ...d, edges: [...d.edges] })), switched: [...c.built.switched], removed: [...c.built.removed] } } : {}) });

/** A line of ours the works may move: rail, out and back, no partners, patterns or manual platforms, our trains of one consist. */
export function hubLine(h: HubHost, l: Line): number[] | null {
  const g = h.g;
  if (l.owner !== h.me || l.kind !== 'rail' || l.loop || l.patterns?.length || l.operators?.length || l.platforms?.some((p) => p.manual) || !l.vehicles.length) return null;
  const path = linearStops(l.stops), first = g.vehicles.get(l.vehicles[0]);
  if (!path || path.length < 2 || !(first instanceof Train) || !path.every((id) => !!g.stations.get(id)?.rail)) return null;
  const stock = first.cars.map((c) => c.id).sort().join(',');
  return l.vehicles.every((id) => { const t = g.vehicles.get(id); return t instanceof Train && t.owner === h.me && t.cars.map((c) => c.id).sort().join(',') === stock; }) ? path : null;
}

/** Pairs of our lines ending at two separate stations of ours in one town, too far apart to walk between: [a, b, Xa, Xb]. */
export function hubPairs(h: HubHost): number[][] {
  const g = h.g, out: number[][] = [];
  const ends = [...g.lines.map.values()].flatMap((l) => {
    const path = hubLine(h, l);
    if (!path) return [];
    return [path[0], path[path.length - 1]].map((sid) => ({ l, st: g.stations.get(sid)! })).filter(({ st }) => st.townId >= 0 && st.owner === h.me);
  });
  for (const a of ends) for (const b of ends) {
    if (a.l.id >= b.l.id || a.st.townId !== b.st.townId || a.st === b.st || h.cared(`hub${a.l.id}:${b.l.id}`)) continue;
    if (Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z) > HUB_REACH || g.stations.complex(a.st.id).includes(b.st.id)) continue;
    // (within walking range a link does it: citylink)
    if (g.stations.gap(a.st, b.st) <= g.stations.linkRange(a.st, b.st)) continue;
    out.push([a.l.id, b.l.id, a.st.id, b.st.id]);
  }
  return out;
}

/** Native full-body routing from a's platforms to b, including the platform departure (as ai-reroute's). */
function route(g: Game, a: Station, b: Station, cars: VehicleModel[], owner: number) {
  const length = cars.reduce((n, c) => n + c.length + .1, 0), rule = consistRule(cars);
  let best: ReturnType<typeof findRailRoute> = null;
  for (const group of g.stations.railTrackGroups(a)) {
    if (group.length < length) continue;
    for (const steps of [group.steps, [...group.steps].reverse().map((s) => ({ edge: s.edge, dir: -s.dir }))]) {
      const front = platformDepartureFrontiers(g, steps, owner, rule, length);
      const found = findRailRoute(g, [...front.forward, ...front.reverse], b.id, owner, -1, 20000, false, rule, true, { length });
      if (found && (!best || found.cost < best.cost)) best = found;
    }
  }
  return best;
}

const trainsOf = (g: Game, l: Line) => l.vehicles.map((id) => g.vehicles.get(id)).filter((t): t is Train => t instanceof Train);
const neighbour = (path: number[], x: number) => path[0] === x ? path[1] : path[path.length - 2];

/**
 * The branch point on line l's approach to its old terminus X: on our own plain single track (the trains of both
 * directions pass it), `out` units or more out of the platforms, with the direction out of town there.
 */
function anchorOf(h: HubHost, l: Line, path: number[], X: Station, out: number): Anchor | null {
  const g = h.g, net = g.world.net, cars = trainsOf(g, l)[0]?.cars, Y = g.stations.get(neighbour(path, X.id));
  if (!cars || !Y) return null;
  const away = route(g, X, Y, cars, h.me), back = route(g, Y, X, cars, h.me);
  if (!away || !back) return null;
  const inbound = new Set(back.conts.map((c) => c.edge.id));
  let walked = 0;
  for (const c of away.conts) {
    const e = net.edges.get(c.edge.id)!;
    if (e.station >= 0 && walked > 0) return null;
    // (track is often laid in short pieces: a point inside one, or its joint, takes the turnout)
    if (e.station < 0 && e.depot < 0 && e.owner === h.me && e.len >= 1 && inbound.has(e.id) && walked + e.len - 0.5 >= out) {
      const along = Math.min(e.len - 0.5, Math.max(0.5, out - walked)), s = c.dir > 0 ? along : e.len - along, p = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
      if (net.sectionAt(e, s) !== 'ground') { walked += e.len; continue; }
      net.pointAt(e, s, p, t);
      const tl = Math.hypot(t.x, t.z) || 1;
      return { x: p.x, y: p.y, z: p.z, ux: t.x / tl * c.dir, uz: t.z / tl * c.dir, dist: walked + along };
    }
    walked += e.len;
    if (walked > out + 60) return null;
  }
  return null;
}

/** Candidate sites: a through station between the approaches (each line from its own end) or a terminus they share. */
function survey(h: HubHost, X: Station[], A: Anchor[], length: number): HubOption[] {
  const g = h.g, town = g.towns.list[X[0].townId];
  if (!town) return [];
  const options: (HubOption & { rank: number })[] = [];
  const add = (x: number, z: number, ax: number, az: number, end: number[]) => {
    if (!g.world.inside(x, z, 10)) return;
    const angle = Math.atan2(ax, az), fx = Math.sin(angle), fz = Math.cos(angle);
    // each line's platform track on its side of the axis (two lines from one side: one each)
    const side = A.map((a) => (a.x - x) * fz - (a.z - z) * fx);
    const track = end[0] !== end[1] ? [side[0] < 0 ? 0 : 1, side[0] < 0 ? 1 : 0] : side[0] <= side[1] ? [0, 1] : [1, 0];
    const rank = Math.hypot(x - town.x, z - town.z);
    (['ground', 'elevated', 'underground'] as const).forEach((level, k) => options.push({ x, z, angle, level, length, track, end, anchors: A.map((a) => ({ ...a })), rank: rank + k * 0.01 }));
  };
  const inA = { x: -A[0].ux, z: -A[0].uz }, outB = { x: A[1].ux, z: A[1].uz };
  const tx = inA.x + outB.x, tz = inA.z + outB.z, tl = Math.hypot(tx, tz);
  const mid = { x: (X[0].x + X[1].x) / 2, z: (X[0].z + X[1].z) / 2 };
  if (tl > 0.6) {
    // through: on from line 0's approach into line 1's; centred where the approaches meet, else between the termini
    const ax = tx / tl, az = tz / tl;
    const dx = A[1].x - A[0].x, dz = A[1].z - A[0].z, den = inA.x * (-A[1].uz) - inA.z * (-A[1].ux);
    const t = Math.abs(den) > 1e-3 ? (dx * (-A[1].uz) - dz * (-A[1].ux)) / den : -1;
    const s = Math.abs(den) > 1e-3 ? (dx * inA.z - dz * inA.x) / den : -1;
    const meet = t > 20 && s > 20 && t < 200 && s < 200 ? { x: A[0].x + inA.x * t, z: A[0].z + inA.z * t } : null;
    const between = { x: (A[0].x + A[1].x) / 2, z: (A[0].z + A[1].z) / 2 };
    // (where the approaches meet the line turns: its curve cuts the corner, on the inner side)
    const ix = -inA.x + outB.x, iz = -inA.z + outB.z, il = Math.hypot(ix, iz) || 1, k = meet ? 0.3 * Math.min(t, s) : 0;
    const inner = meet ? { x: meet.x + ix / il * k, z: meet.z + iz / il * k } : null;
    for (const c of meet ? [inner!, meet, { x: (meet.x + mid.x) / 2, z: (meet.z + mid.z) / 2 }] : [between, mid]) add(c.x, c.z, ax, az, [0, 1]);
  }
  const ix = inA.x - A[1].ux, iz = inA.z - A[1].uz, il = Math.hypot(ix, iz);
  if (il > 1.2) {
    // terminus: both lines from the back, its front towards the centre
    const ax = ix / il, az = iz / il;
    for (const k of [0, 18]) add(mid.x + ax * k, mid.z + az * k, ax, az, [0, 0]);
  }
  // (the site nearest the centre at each level, then the next)
  return options.sort((a, b) => a.rank - b.rank || a.x - b.x || a.z - b.z).slice(0, 6).map(({ rank: _, ...o }) => o);
}

/** The new platforms as planned. */
/** Shifts of a site (along its axis, across it) tried in turn where streets or buildings leave no room at the first. */
const SITE_SHIFTS: [number, number][] = [[0, 0], [8, 0], [-8, 0], [0, 6], [0, -6], [16, 0], [-16, 0], [8, 6], [-8, -6], [0, 12], [0, -12]];
/** The new platforms as planned (the first of the shifted sites that works), or null. */
function planSite(h: HubHost, o: HubOption, type: string): StationPlan | null {
  const g = h.g, ux = Math.sin(o.angle), uz = Math.cos(o.angle);
  for (const [along, across] of SITE_SHIFTS) {
    const x = o.x + ux * along + uz * across, z = o.z + uz * along - ux * across;
    if (!g.world.inside(x, z, 10)) continue;
    const p = g.stations.planRail(x, z, o.angle, o.length, 2, h.me, { level: o.level, trackType: type, mode: 'mainline',
      ...(o.level === 'underground' ? { depth: STATION_DEPTH.def, entrances: 2 } : o.level === 'elevated' ? { height: STATION_HEIGHT.def, entrances: 2 } : {}) });
    // (a plan joining one of our stops would keep that stop's station: not new platforms the works can take up again)
    if (p.ok && !p.join && p.roadAccess && h.demolitionOk(p.demolish)) return p;
    hubWhy(`site ${o.level}: ${!p.ok ? p.error : p.join ? 'joins a stop' : !p.roadAccess ? 'no road access' : 'demolition'}`);
  }
  return null;
}

/** A line's branch: from its anchor on the approach to its platform track's end of the (planned or built) station. */
function branch(h: HubHost, a: Anchor, site: StationPlan | Station, track: number, end: number, type: string): Proposal | null {
  const g = h.g, net = g.world.net;
  const snap = findSnap(g, 'rail', a.x, a.z, .35);
  const on = snap.kind === 'edge' ? [net.edges.get(snap.edge!)] : snap.kind === 'node' ? net.nodes.get(snap.node!)?.edges.map((id) => net.edges.get(id)) ?? [] : [];
  if (!on.some((e) => e?.owner === h.me && e.kind === 'rail' && e.station < 0 && e.depot < 0) || Math.abs(snap.y - a.y) > .1) { hubWhy('anchor snap'); return null; }
  const rail = 'id' in site ? site.rail! : site, level = rail.level ?? 'ground';
  const opt: BuildOptions = { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: h.me, junctionUpgrade: true,
    ...(level === 'ground' ? {} : level === 'underground' ? { level: 'underground', levelDepth: rail.depth } : { level: 'elevated', levelHeight: rail.height }) };
  let p: Proposal;
  if ('id' in site) {
    const ends = stationEnds(g, site)[track]; if (!ends) return null;
    p = planEdge(g, snap, nodeSnap(g, end ? ends.front : ends.back, 'rail'), opt);
  } else {
    // (tracks in lateral order, as stationEnds gives the built station's)
    const offsets = [...site.layout.trackOffsets].sort((p, q) => p - q);
    const ux = Math.sin(site.angle), uz = Math.cos(site.angle), offset = offsets[track] ?? 0, sign = end ? 1 : -1;
    const at = { x: site.x + uz * offset + ux * site.length / 2 * sign, z: site.z - ux * offset + uz * site.length / 2 * sign, y: site.y, dx: ux * sign, dz: uz * sign };
    p = net.withTemporaryNodes('rail', [at], h.me, (nodes) => planEdge(g, snap, nodeSnap(g, nodes[0].id, 'rail'), opt));
  }
  hubWhy(!p.ok ? 'branch: ' + p.errors.join(', ') : p.roadBridges?.length ? 'branch: road bridges' : '');
  return p.ok && !p.roadBridges?.length && h.consent(p, !('id' in site)) && h.demolitionOk(p.demolish) ? p : null;
}

const demolished = (g: Game, ids: number[]) => ids.reduce((n, id) => { const b = g.world.buildings.get(id); return n + (b ? demolitionCost(g, b) : 0); }, 0);
const proposalUpkeep = (p: Proposal) => p.tracks.reduce((n, t) => n + trackMaintenance({ kind: p.opts.kind, type: p.opts.type, len: t.len, sections: t.sections } as NEdge), 0);

/** The stations of a line with its old terminus X replaced by `site`. */
const replaced = (g: Game, path: number[], X: number, site: Station | StationPlan) => path.map((id) => id === X ? site : g.stations.get(id)!);

/** Receipts a year of a line through these stops (its own service: the line itself left out of the routes). */
function receipts(h: HubHost, l: Line, points: (Station | StationPlan)[]): number {
  const g = h.g, kmh = 45, headway = Math.max(60, patternHeadway(g, l));
  return g.demand.forecastLine(points, 'mainline', kmh, headway, h.me, l.id, undefined, 'rail', plannedSet(g, points)).revenue;
}

/** One option valued: works, upkeep (less the old platforms'), receipts (forecast deltas and newly connected journeys). */
function quote(h: HubHost, lines: Line[], paths: number[][], X: Station[], o: HubOption, base: number[]) {
  const A = o.anchors;
  const g = h.g, type = lines.some((l) => trainsOf(g, l).some((t) => t.rule.wire)) ? 'electric' : 'standard';
  const site = planSite(h, o, type);
  if (!site) return null;
  const branches = A.map((a, k) => branch(h, a, site, o.track[k], o.end[k], type));
  if (branches.some((p) => !p)) return null;
  const added = branches.reduce((n, p) => n + p!.stats.len, 0);
  const capital = site.cost + demolished(g, site.demolish) + branches.reduce((n, p) => n + p!.cost + demolished(g, p!.demolish), 0) + 30_000 + added * 300 + 40_000;
  // upkeep: the new platforms and branches, less the old platforms nobody else stops at
  let upkeep = (20_000 + site.tracks * site.length * 500) * (STATION_UPKEEP_FACTOR[site.level] ?? 1) + branches.reduce((n, p) => n + proposalUpkeep(p!), 0);
  for (const [k, st] of X.entries()) if (g.lines.linesAt(st.id).every((l) => l === lines[k])) upkeep -= g.stationMaintenance(st);
  // receipts: each line at the new site against today (calibrated by what it earns), and journeys between the lines
  let revenue = 0;
  for (const [k, l] of lines.entries()) {
    const after = receipts(h, l, replaced(g, paths[k], X[k].id, site));
    const opened = h.managed()?.get(l.id)?.opened ?? g.day;
    const observed = g.day - opened >= 360 && base[k] > 0 ? Math.min(1, Math.max(0, l.incomeLast - (l.mail?.incomeLast ?? 0)) / base[k]) : .5;
    revenue += (after - base[k]) * observed;
  }
  const others = paths.map((p, k) => p.filter((id) => id !== X[k].id));
  const linked = h.newTrips(others[0], others[1], false, h.headway(lines));
  revenue += linked.revenue * .7;
  const net = revenue - upkeep, need = capital * (.045 - .03 * h.ai.config.risk + Math.max(.03, g.company(h.me).economy.interestRate));
  return { site, branches: branches as Proposal[], capital, score: net - need, trips: linked.trips, type };
}

/** Run an operation, booking what it cost and the edges it left of ours (followed through splits). */
function record(h: HubHost, b: NonNullable<HubCursor['built']>, operation: () => string | null, irreversible = 0, station = -1): string | null {
  const net = h.g.world.net, retained = new Set(net.edges.keys()), start = net.nextEdge, eco = h.g.company(h.me).economy, construction = eco.thisYear.construction;
  const split = (old: { id: number }, a: { id: number }, c: { id: number }) => {
    if (retained.delete(old.id)) { retained.add(a.id); retained.add(c.id); }
    for (const d of b.debits) { const at = d.edges.indexOf(old.id); if (at >= 0) d.edges.splice(at, 1, a.id, c.id); }
  };
  net.onSplit.push(split); let error: string | null;
  try { error = operation(); } finally { net.onSplit = net.onSplit.filter((f) => f !== split); }
  const cost = Math.max(0, construction - eco.thisYear.construction), edges: number[] = [];
  for (let id = start; id < net.nextEdge; id++) if (!retained.has(id) && net.edges.get(id)?.owner === h.me) edges.push(id);
  b.spent += cost; b.debits.push({ cost, edges, station: station >= 0 && h.g.stations.get(station) ? station : -1, refundable: Math.max(0, cost - irreversible) });
  return error;
}

/** Take the works up again before any line uses them (refunding what can be undone); occupied works stay. */
function undo(h: HubHost, b: NonNullable<HubCursor['built']>, why: string) {
  const g = h.g, net = g.world.net;
  let refund = 0;
  if (b.switched.length || g.lines.all().some((l) => l.stops.includes(b.station)) || b.debits.some((d) => d.edges.some((id) => g.vehicles.isEdgeBusy(id) || g.vehicles.getRes(id)))) {
    h.note(`hub works stopped: ${why}; works retained`); h.considered('hub.retained'); return;
  }
  for (const d of [...b.debits].reverse()) {
    const removed = new Set<number>();
    for (const id of d.edges) { const e = net.edges.get(id); if (e?.owner === h.me && e.station < 0 && !g.vehicles.isEdgeBusy(id)) { net.removeEdge(id); removed.add(id); } }
    if (d.station >= 0 && g.stations.get(d.station)?.owner === h.me) g.stations.removeStation(d.station);
    if (d.edges.every((id) => removed.has(id) || !net.edges.has(id)) && (d.station < 0 || !g.stations.get(d.station))) refund += d.refundable;
  }
  if (refund) g.company(h.me).economy.spend(-refund, 'construction', true);
  g.onNetworkChanged(); g.lines.rebuild(); h.note(`hub works given up: ${why}`); h.considered('hub.rollback');
}

/** Waiting passengers and mail of an old terminus no line serves any more move to the new platforms; so do journeys to it. */
function handOver(g: Game, X: Station, S: Station) {
  const re = (id: number) => id === X.id ? S.id : id;
  const moved = [...X.waiting.values()];
  X.waiting.clear(); X.waitingTotal = 0;
  for (const st of g.stations.map.values()) {
    if (st === X || ![...st.waiting.values()].some((w) => w.alight === X.id || w.dest === X.id)) continue;
    const old = [...st.waiting.values()];
    st.waiting.clear(); st.waitingTotal = 0;
    for (const w of old) if (re(w.dest) !== st.id) g.stations.addWaiting(st, w.line, re(w.alight), re(w.dest), w.count, 0, w.t, w.transfers ?? 0, w.rail ?? 0, w.ic ?? 0);
  }
  for (const w of moved) if (re(w.dest) !== S.id) g.stations.addWaiting(S, w.line, re(w.alight), re(w.dest), w.count, 0, w.t, w.transfers ?? 0, w.rail ?? 0, w.ic ?? 0);
  for (const v of g.vehicles.map.values()) {
    if (![...v.cargo.values()].some((c) => c.alight === X.id || c.dest === X.id)) continue;
    v.cargo = cargoGroups([...v.cargo.values()].map((c) => ({ ...c, alight: re(c.alight), dest: re(c.dest) })));
  }
  return absorbMail(g, S, X, re);
}

/** Track of the old terminus and its approach up to the branch: trains on it are committed to the old platforms. */
function committedEdges(g: Game, l: Line, path: number[], X: Station, a: Anchor, owner: number): Set<number> {
  const out = new Set<number>([...(X.rail?.edges ?? []), ...(X.rail?.throughEdges ?? [])]);
  const cars = trainsOf(g, l)[0]?.cars, Y = g.stations.get(neighbour(path, X.id));
  const r = cars && Y ? route(g, X, Y, cars, owner) : null;
  let walked = 0;
  for (const c of r?.conts ?? []) { out.add(c.edge.id); walked += c.edge.len; if (walked > a.dist + 4) break; }
  return out;
}

/** One saved stage per work unit. */
export function* hubTask(h: HubHost, item: { ids: number[]; hub?: HubCursor }): Generator<void, void> {
  const g = h.g, [la, lb, xa, xb] = item.ids, key = `hub${la}:${lb}`;
  const lines = [g.lines.get(la), g.lines.get(lb)], X = [g.stations.get(xa), g.stations.get(xb)];
  const finish = (days: number, why: string) => { delete item.hub; h.careFor(key, days); h.considered('hub.' + why); };
  // (the lines' routes; their fleets may change meanwhile: every train is checked at the switch)
  const identity = () => JSON.stringify(lines.map((l) => l ? [l.id, l.stops] : null));
  const c = item.hub;
  if (c) delete c.wait;
  const paths = lines.map((l) => l && l.id === item.ids[lines.indexOf(l)] ? hubLine(h, l) : null);
  // each line still ends at its old terminus, or (switched) at the new platforms; the old ones may be gone then
  const switched = (k: number) => !!c?.built?.switched.includes(k), end = (k: number) => switched(k) ? c!.built!.station : item.ids[2 + k];
  if (lines.some((l) => !l) || X.some((s, k) => !switched(k) && !s?.rail) || paths.some((p) => !p)
    || paths.some((p, k) => p![0] !== end(k) && p![p!.length - 1] !== end(k))) {
    if (c?.built && !c.built.switched.length) undo(h, c.built, 'lines changed');
    if (c?.built?.switched.length) finish(720, 'partial'); else finish(360, 'changed');
    return;
  }
  const L = lines as Line[], S0 = X as Station[], P = paths as number[][];
  if (!c) {
    if (h.cared(key)) return;
    h.careFor(key, 30);
    const trainLength = Math.max(...L.flatMap((l) => trainsOf(g, l).map((t) => t.length)));
    const length = Math.max(8, Math.ceil(trainLength + .5), ...S0.map((s) => Math.ceil(s.rail!.length)));
    const options: HubOption[] = [];
    for (const out of HUB_ANCHORS) {
      const anchors = L.map((l, k) => anchorOf(h, l, P[k], S0[k], out));
      if (anchors.every((a) => !!a)) options.push(...survey(h, S0, anchors as Anchor[], length));
    }
    if (!options.length) { finish(360, 'noSite'); return; }
    item.hub = { stage: 'value', at: 0, identity: identity(), olds: [xa, xb], options };
    h.considered('hub.survey');
    return;
  }
  if (c.identity !== identity() && !c.built?.switched.length) { if (c.built) undo(h, c.built, 'lines changed'); finish(360, 'changed'); return; }
  if (c.stage === 'value') {
    if (!c.base) { c.base = L.map((l, k) => receipts(h, l, P[k].map((id) => g.stations.get(id)!))); return; }
    const o = c.options[c.at++];
    if (o) {
      const q = quote(h, L, P, S0, o, c.base);
      networkScore(q?.score);
      if (q && (q.score > 0 || hubOptions.force) && h.affordable(q.capital * 1.15, 1))
        (c.ranked ??= []).push({ option: c.at - 1, score: q.score, capital: q.capital, trips: q.trips });
      return;
    }
    if (!c.ranked?.length) { finish(360, 'unpaid'); return; }
    c.ranked.sort((x, y) => y.score - x.score || x.option - y.option);
    c.stage = 'station'; c.at = 0; return;
  }
  const fail = (why: string, days = 360) => { if (c.built) undo(h, c.built, why); finish(days, why); };
  if (c.stage === 'station') {
    // the sites in order of value; a built station whose own structures leave no way in for a branch is taken up again
    const r = c.ranked![c.at++];
    if (!r) { finish(360, 'site'); return; }
    const o = c.options[r.option], q = quote(h, L, P, S0, o, c.base!);
    if (!q || (q.score <= 0 && !hubOptions.force)) return;
    if (!h.canSpend(q.capital * 1.15, 1)) { finish(60, 'funds'); return; }
    const id = g.stations.nextId, site = q.site, built = c.built = { station: id, spent: 0, debits: [], waits: 0, switched: [], removed: [] };
    const residents = site.demolish.flatMap((b) => { const x = g.world.buildings.get(b); return x ? [{ townId: x.townId, pop: x.pop, cost: demolitionCost(g, x) }] : []; });
    const error = record(h, built, () => { const e = g.stations.commitRail(site, h.me); if (!e) h.compensate(site.demolish, residents); return e; }, residents.reduce((n, b) => n + b.cost * 2, 0), id);
    const S = g.stations.get(id);
    if (error || !S?.rail || o.anchors.some((a, k) => !branch(h, a, S, o.track[k], o.end[k], q.type))) {
      undo(h, built, 'no way into the new platforms'); delete c.built; return;
    }
    c.best = r; c.stage = 'branch'; c.at = 0;
    h.note(`hub for ${L[0].name} and ${L[1].name}: new platforms ${S.name} (${o.level})`);
    return;
  }
  const o = c.options[c.best!.option];
  const b = c.built!, S = g.stations.get(b.station);
  if (!S?.rail || S.owner !== h.me) { fail('stationGone'); return; }
  const type = L.some((l) => trainsOf(g, l).some((t) => t.rule.wire)) ? 'electric' : 'standard';
  if (c.stage === 'branch') {
    const k = c.at, a = o.anchors[k];
    const p = branch(h, a, S, o.track[k], o.end[k], type);
    if (!p || !h.canSpend(p.cost * 1.1, 1)) { fail('branch'); return; }
    // a turnout on occupied track waits for the train to pass
    const touched = p.tracks.flatMap((t) => [t.start, t.end]).flatMap((s: Snap) => s.kind === 'edge' ? [s.edge!] : s.kind === 'node' ? g.world.net.nodes.get(s.node!)?.edges ?? [] : []);
    if (touched.some((id) => g.vehicles.isEdgeBusy(id) || g.vehicles.getRes(id))) { if (++b.waits > 120) fail('busy'); else c.wait = true; return; }
    const residents = p.demolish.flatMap((x) => { const y = g.world.buildings.get(x); return y ? [{ townId: y.townId, pop: y.pop, cost: demolitionCost(g, y) }] : []; });
    const error = record(h, b, () => { const e = commitProposal(g, p); if (!e) h.compensate(p.demolish, residents); return e; }, residents.reduce((n, x) => n + x.cost * 2, 0));
    if (error) { fail('branch'); return; }
    b.waits = 0;
    if (++c.at >= 2) { c.stage = 'throat'; c.at = 0; }
    return;
  }
  if (c.stage === 'throat') {
    record(h, b, () => { h.connectThroat(S.id); return null; });
    c.stage = 'switch'; c.at = 0; return;
  }
  if (c.stage === 'switch') {
    const k = c.at, l = L[k], Xk = S0[k], path = P[k];
    const next = path.map((id) => id === Xk.id ? S.id : id);
    // its trains (one consist) can run the new route, and reach it from their depots without the old platforms
    const cars = trainsOf(g, l)[0].cars;
    for (let i = 0; i + 1 < next.length; i++) for (const [p, q] of [[next[i], next[i + 1]], [next[i + 1], next[i]]]) {
      if (!route(g, g.stations.get(p)!, g.stations.get(q)!, cars, h.me)) { hubWhy(`route ${g.stations.get(p)?.name} > ${g.stations.get(q)?.name}`); fail('route'); return; }
    }
    for (const t of trainsOf(g, l)) {
      const dp = g.depots.get(t.depotId);
      if (!dp || !h.reachesAvoiding(dp.node, S, Xk) || !next.slice(1).some((to, i) => depotServes(g, dp, next[i], to, t.cars) >= 0)) { fail('depot'); return; }
    }
    // none of its trains committed to the old platforms (standing there, or on the approach past the branch)
    const held = committedEdges(g, l, path, Xk, o.anchors[k], h.me);
    if (trainsOf(g, l).some((t) => t.atStation === Xk.id || t.segs.some((s) => held.has(s.e)) || t.pending.some((s) => held.has(s.e)))) {
      if (++b.waits > 180) fail('trainsAtOld'); else c.wait = true;
      return;
    }
    l.stops = l.stops.map((s) => s === Xk.id ? S.id : s);
    delete l.spacing;
    b.switched.push(k); b.waits = 0;
    const deliveries = g.lines.all().some((x) => x.stops.includes(Xk.id)) ? [] : handOver(g, Xk, S);
    c.identity = identity();
    g.lines.rebuild();
    for (const d of deliveries) settleMail(g, d.st, d.count, d.j, null);
    for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged(true);
    h.signal(l.id);
    if (++c.at >= 2) { c.stage = 'remove'; c.at = 0; }
    return;
  }
  // remove: the old platforms nobody stops at, and their track stubs
  for (const k of [0, 1]) {
    if (b.removed.includes(k)) continue;
    const Xk = g.stations.get(c.olds[k]);
    if (!Xk || Xk.owner !== h.me || g.lines.all().some((x) => x.stops.includes(Xk.id))) { b.removed.push(k); continue; }
    const ends = Xk.rail ? g.stations.trackEnds(Xk, true).flatMap((t) => [t.front, t.back]) : [];
    if (g.stations.removeStation(Xk.id)) { if (++b.waits > 120) b.removed.push(k); else c.wait = true; return; }
    for (const nid of ends) h.takeUpStub(nid);
    b.removed.push(k);
    h.note(`took up ${Xk.name}: its lines moved to ${S.name}`);
    return;
  }
  h.stat(); h.succeed();
  h.note(`${L[0].name} and ${L[1].name} share ${S.name}: ${Math.round(c.best!.trips)} trips a month newly connected, ${Math.round(b.spent / 1000)}k spent`);
  h.news(`brings ${L[0].name} and ${L[1].name} together at ${S.name}.`, S.x, S.z);
  finish(720, 'built');
}

/** Diagnostics (tests): the best hub score seen, quotes made, why the last branch plan failed. */
export const hubProfile = { best: -Infinity, quotes: 0, why: '', whys: [] as string[] };
/** (diagnostics only) why a site, branch or route did not work out */
function hubWhy(why: string) { hubProfile.why = why; if (why) { hubProfile.whys.push(why); if (hubProfile.whys.length > 40) hubProfile.whys.shift(); } }
function networkScore(score: number | undefined) { hubProfile.quotes++; if (score !== undefined) hubProfile.best = Math.max(hubProfile.best, score); }
