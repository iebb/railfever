// Incremental, economically priced middle-of-line diversions. Old track is never dismantled.
import type { Game } from './game';
import type { Line } from './lines';
import type { GrowHost } from './ai-grow';
import type { Station, StationPlan, StationLevel } from './stations';
import type { VehicleModel } from './vehicle-types';
import type { NEdge } from './network';
import type { Proposal, Snap, BuildOptions } from './construction';
import { linearStops, outAndBack } from './lines';
import { railPartMode, STATION_DEPTH, STATION_HEIGHT, STATION_UPKEEP_FACTOR } from './stations';
import { Train, consistRule, findRailRoute, platformDepartureFrontiers, depotServes, makeSeg } from './train';
import { planEdge, commitProposal, findSnap } from './construction';
import { nodeSnap, stationEnds } from './routing';
import { estimateVehicleYear, trackBasePerUnit, trackMaintenance, YEAR_S } from './opcosts';
import { TRACK_TYPES, UNIT_M } from './constants';
import { forecastMailRevenue } from './ai-mail';
import { demolitionCost } from './demolition';
import { plannedSet } from './demand';

export type RerouteHost = Pick<GrowHost, 'g' | 'me' | 'ai' | 'note' | 'news' | 'considered' | 'succeed' | 'cared' | 'careFor'
  | 'canSpend' | 'affordable' | 'managed' | 'setStops' | 'signal' | 'consent' | 'demolitionOk' | 'compensate'>
  & { stat(k: 'netRerouted' | 'netRerouteStops', n?: number): void };
interface Anchor { x: number; z: number; y: number }
export interface RerouteOption { a: number; b: number; town: number; x: number; z: number; angle: number; level: StationLevel }
interface Debit { cost: number; edges: number[]; station: number; refundable: number }
export interface RerouteCursor {
  stage: 'survey' | 'value' | 'station' | 'left' | 'right' | 'open'; at: number; identity: string;
  options: RerouteOption[]; best?: { option: number; score: number };
  built?: { option: RerouteOption; station: number; anchors: Anchor[]; bypass: number; oldLengths: number[];
    prefix: number; suffix: number; oldSpeeds: number[]; linkLengths: number[]; linkSpeeds: number[];
    capital: number; addedTrack: number; spent: number; debits: Debit[]; waits: number };
}
export const copyRerouteCursor = (c: RerouteCursor): RerouteCursor => ({ ...c, options: c.options.map(o => ({ ...o })),
  ...(c.best ? { best: { ...c.best } } : {}), ...(c.built ? { built: { ...c.built, option: { ...c.built.option }, anchors: c.built.anchors.map(a => ({ ...a })),
    oldLengths: [...c.built.oldLengths], oldSpeeds: [...c.built.oldSpeeds], linkLengths: [...c.built.linkLengths], linkSpeeds: [...c.built.linkSpeeds],
    debits: c.built.debits.map(d => ({ ...d, edges: [...d.edges] })) } } : {}) });

/** No shared/patterned timetable is rewritten underneath another operator. Physical shared corridors can stay. */
export function rerouteLine(h: RerouteHost, l: Line): number[] | null {
  if (l.owner !== h.me || l.kind !== 'rail' || l.loop || l.patterns?.length || l.operators?.length || l.platforms?.some(p => p.manual) || !l.vehicles.length) return null;
  const path = linearStops(l.stops);
  const first = h.g.vehicles.get(l.vehicles[0]);
  if (!(first instanceof Train)) return null;
  const stock = first.cars.map(c => c.id).sort().join(',');
  return path && path.length >= 2 && path.every(id => !!h.g.stations.get(id)?.rail)
    && l.vehicles.every(id => { const t = h.g.vehicles.get(id); return t instanceof Train && t.owner === h.me && t.capacity > 0 && t.cars.map(c => c.id).sort().join(',') === stock; }) ? path : null;
}
const identity = (g: Game, l: Line) => JSON.stringify([l.owner, l.stops, l.patterns, l.operators, l.vehicles.map(id => {
  const t = g.vehicles.get(id); return [id, t?.owner, t instanceof Train ? [t.depotId, t.pattern, t.cars.map(c => c.id).sort()] : null];
})]);

/** Exact full-body native routing, including the onward platform departure. No reservations are bypassed when operating. */
function route(g: Game, a: Station, b: Station, cars: VehicleModel[], owner: number, onward = a.id) {
  const length = cars.reduce((n, c) => n + c.length + .1, 0), rule = consistRule(cars);
  let best: ReturnType<typeof findRailRoute> = null;
  for (const group of g.stations.railTrackGroups(a)) {
    if (group.length < length) continue;
    for (const steps of [group.steps, [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }))]) {
      const front = platformDepartureFrontiers(g, steps, owner, rule, length);
      const found = findRailRoute(g, [...front.forward, ...front.reverse], b.id, owner, -1, 20000, false, rule, true, { length, onward });
      if (found && (!best || found.cost < best.cost)) best = found;
    }
  }
  return best;
}
const lengthOf = (g: Game, found: NonNullable<ReturnType<typeof route>>) => found.conts.reduce((n, c) => n + (g.world.net.edges.get(c.edge.id)?.len ?? 0), 0);
const nextCall = (path: number[], leg: number, reverse: boolean) => reverse ? path[leg ? leg - 1 : 1]
  : path[leg + 2 < path.length ? leg + 2 : path.length - 2];
const routesFor = (g: Game, path: number[], cars: VehicleModel[], owner: number) => [false, true].flatMap(reverse =>
  path.slice(1).map((_, i) => route(g, g.stations.get(path[reverse ? i + 1 : i])!, g.stations.get(path[reverse ? i : i + 1])!, cars, owner, nextCall(path, i, reverse))));
const reversibleProposal = (p: Proposal) => !p.roadBridges?.length && !p.crossings.some(c => c.mode === 'under'
  && !p.tracks[c.track].sections.some(s => s.type === 'tunnel' && c.sNew >= s.s0 - .5 && c.sNew <= s.s1 + .5));

/** Only bounded nearby centres between existing calls; on-track infill remains the cheaper earlier review. */
function survey(h: RerouteHost, l: Line, path: number[]): RerouteOption[] {
  const g = h.g, fleet = l.vehicles.map(id => g.vehicles.get(id) as Train), options: (RerouteOption & { rank: number })[] = [];
  for (let leg = 0; leg + 1 < path.length; leg++) {
    const A = g.stations.get(path[leg])!, B = g.stations.get(path[leg + 1])!, dx = B.x - A.x, dz = B.z - A.z, d2 = dx * dx + dz * dz;
    if (d2 < 80 * 80) continue;
    const r = route(g, A, B, fleet[0].cars, h.me);
    if (!r || r.conts.some(c => c.edge.owner !== h.me || c.edge.type === 'highspeed')) continue;
    for (const town of g.towns.list) {
      const u = ((town.x - A.x) * dx + (town.z - A.z) * dz) / d2;
      const off = Math.hypot(town.x - A.x - dx * u, town.z - A.z - dz * u);
      if (!(town.pop > 0) || u < .2 || u > .8 || off < 6 || off > 60
        || path.some(id => { const st = g.stations.get(id)!; return Math.hypot(st.x - town.x, st.z - town.z) < 30; })) continue;
      const extra = Math.hypot(town.x - A.x, town.z - A.z) + Math.hypot(town.x - B.x, town.z - B.z) - Math.sqrt(d2);
      const rank = town.pop / Math.max(1, extra + off);
      for (const level of ['ground', 'elevated', 'underground'] as const)
        options.push({ a: A.id, b: B.id, town: town.id, x: town.x, z: town.z, angle: Math.atan2(dx, dz), level, rank });
    }
  }
  return options.sort((a, b) => b.rank - a.rank || a.town - b.town || a.a - b.a).slice(0, 6).map(({ rank: _, ...o }) => o);
}

function anchors(g: Game, found: NonNullable<ReturnType<typeof route>>, owner: number): { points: Anchor[]; bypass: number; prefix: number; suffix: number } | null {
  const total = lengthOf(g, found), wanted = [Math.min(30, total * .2), total - Math.min(30, total * .2)], points: Anchor[] = [], at: number[] = [];
  let walked = 0;
  for (const c of found.conts) {
    const e = g.world.net.edges.get(c.edge.id)!;
    for (let k = points.length; k < wanted.length; k++) {
      if (wanted[k] > walked + e.len) break;
      if (e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 4) break;
      const along = Math.max(2, Math.min(e.len - 2, wanted[k] - walked)), s = c.dir > 0 ? along : e.len - along, p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, s, p); points.push({ ...p }); at.push(walked + along);
    }
    walked += e.len;
  }
  return points.length === 2 && at[1] - at[0] > 30 ? { points, bypass: at[1] - at[0], prefix: at[0], suffix: total - at[1] } : null;
}
function anchorSnap(g: Game, p: Anchor, owner: number): Snap | null {
  const snap = findSnap(g, 'rail', p.x, p.z, .35);
  const edges = snap.kind === 'edge' ? [g.world.net.edges.get(snap.edge!)] : snap.kind === 'node' ? g.world.net.nodes.get(snap.node!)?.edges.map(id => g.world.net.edges.get(id)) ?? [] : [];
  return edges.some(e => e?.owner === owner && e.kind === 'rail' && e.station < 0 && e.depot < 0) && Math.abs(snap.y - p.y) < .1 ? snap : null;
}
function branch(h: RerouteHost, a: Anchor, site: StationPlan | Station, side: 0 | 1, type: string): Proposal | null {
  const g = h.g, start = anchorSnap(g, a, h.me); if (!start) return null;
  const rail = 'id' in site ? site.rail! : site, ux = Math.sin(rail.angle), uz = Math.cos(rail.angle);
  const opt: BuildOptions = { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: h.me, junctionUpgrade: true,
    ...(rail.level === 'ground' ? {} : rail.level === 'underground' ? { level: 'underground', levelDepth: rail.depth } : { level: 'elevated', levelHeight: rail.height }) };
  let p: Proposal;
  if ('id' in site) {
    const ends = stationEnds(g, site)[0]; if (!ends) return null;
    p = planEdge(g, start, nodeSnap(g, side ? ends.front : ends.back, 'rail'), opt);
  } else {
    const offset = site.layout.trackOffsets[0], sign = side ? 1 : -1;
    const end = { x: site.x + uz * offset + ux * site.length / 2 * sign, z: site.z - ux * offset + uz * site.length / 2 * sign,
      y: site.y, dx: ux * sign, dz: uz * sign };
    p = g.world.net.withTemporaryNodes('rail', [end], h.me, nodes => planEdge(g, start, nodeSnap(g, nodes[0].id, 'rail'), opt));
  }
  return p.ok && reversibleProposal(p) && h.consent(p, !('id' in site)) && h.demolitionOk(p.demolish) ? p : null;
}

function service(cars: VehicleModel[], lengths: number[], year: number, speeds: number[]) {
  const legs = lengths.map((len, i) => { const estimate = estimateVehicleYear(cars, len / 1.15, year, .4, speeds[i]); return { len, estimate, seconds: YEAR_S / Math.max(1e-9, estimate.trips) }; });
  const seconds = legs.reduce((n, p) => n + p.seconds, 0);
  return { cycle: seconds, seats: cars.reduce((n, c) => n + c.capacity, 0),
    running: legs.reduce((n, p) => n + p.estimate.total * p.seconds / seconds, 0),
    wear: legs.reduce((n, p) => n + p.len * p.estimate.trackWearPerUnit * p.seconds / seconds, 0) };
}
interface Value { capital: number; revenue: number; net: number; score: number; addedTrack: number; headway: number }
/** Marginal full-service receipts, capacity, costs and mail headway losses; existing receipts are subtracted. */
function value(h: RerouteHost, l: Line, path: number[], after: (Station | StationPlan)[], oldLengths: number[], newLengths: number[], capital: number, addedTrack: number, station: StationPlan | Station, oldSpeeds: number[], newSpeeds: number[], addedMaintenance: number): Value {
  const g = h.g, fleet = l.vehicles.map(id => g.vehicles.get(id) as Train), old = fleet.map(t => service(t.cars, oldLengths, g.year, oldSpeeds)), next = fleet.map(t => service(t.cars, newLengths, g.year, newSpeeds));
  const before = path.map(id => g.stations.get(id)!), oldRate = old.reduce((n, s) => n + 1 / s.cycle, 0), newRate = next.reduce((n, s) => n + 1 / s.cycle, 0);
  const oldHeadway = 1 / oldRate, headway = 1 / newRate, kmh = (lengths: number[], cycles: typeof old, rate: number) => lengths.reduce((n, x) => n + x, 0) * UNIT_M / 1000 / (cycles.length / rate / 3600);
  // (both routes on one demand set: demand.ts plannedSet)
  const on = plannedSet(g, [...before, ...after]);
  const f0 = g.demand.forecastLine(before, 'mainline', kmh(oldLengths, old, oldRate), oldHeadway, h.me, l.id, undefined, 'rail', on);
  const f1 = g.demand.forecastLine(after, 'mainline', kmh(newLengths, next, newRate), headway, h.me, l.id, undefined, 'rail', on);
  const carried = (f: typeof f0, cycles: typeof old) => f.revenue * Math.min(1, cycles.reduce((n, s) => n + YEAR_S / s.cycle * s.seats * .7, 0) / Math.max(1, ...f.legLoads));
  const gross = carried(f0, old), opened = h.managed()?.get(l.id)?.opened ?? g.day;
  const observed = g.day - opened >= 360 && gross > 0 ? Math.min(1, Math.max(0, l.incomeLast - (l.mail?.incomeLast ?? 0)) / gross) : .5;
  let revenue = (carried(f1, next) - gross) * observed;
  const mail = fleet.map((t, i) => ({ t, i })).filter(({ t }) => t.mailCapacity > 0);
  if (mail.length) {
    const receipts = (cycles: typeof old) => { const rate = mail.reduce((n, m) => n + 1 / cycles[m.i].cycle, 0); const capacity = mail.reduce((n, m) => n + m.t.mailCapacity / cycles[m.i].cycle, 0) / rate;
      return forecastMailRevenue(g, before, Math.min(...oldSpeeds) * .6, 1 / rate, capacity, l); };
    revenue -= Math.max(0, receipts(old) - receipts(next));
  }
  const running = next.reduce((n, s, i) => n + s.running - old[i].running, 0), wear = Math.max(0, next.reduce((n, s, i) => n + s.wear - old[i].wear, 0));
  const level = ('id' in station ? station.rail!.level : station.level) ?? 'ground';
  const upkeep = 'id' in station ? g.stationMaintenance(station) : (20000 + station.tracks * station.length * 500) * (STATION_UPKEEP_FACTOR[level] ?? 1);
  const maintenance = addedMaintenance + wear + upkeep;
  const net = revenue - running - maintenance, need = capital * (.045 - .03 * h.ai.config.risk + Math.max(.03, g.company(h.me).economy.interestRate));
  return { capital, revenue, net, score: net - need, addedTrack, headway };
}
interface Quotation { site: StationPlan | Station; proposals: Proposal[]; anchors: Anchor[]; bypass: number; prefix: number; suffix: number;
  oldLengths: number[]; oldSpeeds: number[]; value: Value; option: RerouteOption }
export function quoteReroute(h: RerouteHost, l: Line, o: RerouteOption, built?: RerouteCursor['built']): Quotation | null {
  const g = h.g, path = rerouteLine(h, l); if (!path) return null;
  if (built?.debits.some(d => d.edges.some(id => !g.world.net.edges.has(id) || g.world.net.edges.get(id)!.owner !== h.me))) return null;
  const leg = path.findIndex((id, i) => id === o.a && path[i + 1] === o.b); if (leg < 0) return null;
  const trains = l.vehicles.map(id => g.vehicles.get(id) as Train), cars = trains[0].cars;
  const routes = routesFor(g, path, cars, h.me);
  if (routes.some(r => !r || r.conts.some(c => c.edge.owner !== h.me))) return null;
  const plain = routes[leg]!; if (plain.conts.some(c => c.edge.owner !== h.me)) return null;
  const a = built ? { points: built.anchors, bypass: built.bypass, prefix: built.prefix, suffix: built.suffix } : anchors(g, plain, h.me); if (!a) return null;
  const reverse = routes[path.length - 1 + leg]!;
  if (a.points.some(p => { const snap = anchorSnap(g, p, h.me); return !snap || snap.kind === 'edge' && !reverse.conts.some(c => c.edge.id === snap.edge); })) return null;
  const platform = Math.max(8, Math.ceil(Math.max(...trains.map(t => t.length)) + .5)), type = trains.some(t => t.rule.wire) ? 'electric' : 'standard';
  const mode = railPartMode(g.stations.get(o.a)!.rail!);
  let site: StationPlan | Station;
  if (built) { const st = g.stations.get(built.station); if (!st?.rail || st.owner !== h.me || st.rail.length < platform) return null; site = st; }
  else {
    site = g.stations.planRail(o.x, o.z, o.angle, platform, 2, h.me, { level: o.level, trackType: type, mode,
      ...(o.level === 'underground' ? { depth: STATION_DEPTH.metro, entrances: 4 } : o.level === 'elevated' ? { height: STATION_HEIGHT.def, entrances: 4 } : { style: 'none' }) });
    if (!site.ok || site.join || !site.roadAccess || !h.demolitionOk(site.demolish) || site.access && !reversibleProposal(site.access)) return null;
  }
  const proposals: Proposal[] = [];
  for (let side = built?.linkLengths.length ?? 0; side < 2; side++) {
    const p = branch(h, a.points[side], site, side as 0 | 1, type); if (!p) return null; proposals.push(p);
  }
  const nativeSpeed = (r: NonNullable<ReturnType<typeof route>>) => Math.min(...r.conts.map(c => makeSeg(g, c.edge, c.dir).limit * 36));
  const oldLengths = built?.oldLengths ?? routes.map(r => lengthOf(g, r!)), oldSpeeds = built?.oldSpeeds ?? routes.map(r => nativeSpeed(r!)), priorLinks = built?.addedTrack ?? 0;
  const addedTrack = priorLinks + proposals.reduce((n, p) => n + p.stats.len, 0), railLength = 'id' in site ? site.rail!.length : site.length;
  const linkLengths = [...(built?.linkLengths ?? []), ...proposals.map(p => p.stats.len)], linkSpeeds = [...(built?.linkSpeeds ?? []), ...proposals.map(p => p.stats.speed)];
  const n = path.length - 1, forwardLengths = oldLengths.slice(0, n), reverseLengths = oldLengths.slice(n), forwardSpeeds = oldSpeeds.slice(0, n), reverseSpeeds = oldSpeeds.slice(n);
  // Exact quoted prefix/branch/platform/suffix lengths, with a new native dwell/acceleration cycle at C.
  forwardLengths.splice(leg, 1, a.prefix + linkLengths[0] + railLength, linkLengths[1] + a.suffix);
  reverseLengths.splice(leg, 1, linkLengths[0] + a.prefix + g.stations.get(o.a)!.rail!.length,
    linkLengths[1] + a.suffix - g.stations.get(o.b)!.rail!.length + railLength);
  forwardSpeeds.splice(leg, 1, Math.min(oldSpeeds[leg], linkSpeeds[0]), Math.min(oldSpeeds[leg], linkSpeeds[1]));
  reverseSpeeds.splice(leg, 1, Math.min(oldSpeeds[n + leg], linkSpeeds[0]), Math.min(oldSpeeds[n + leg], linkSpeeds[1]));
  const newLengths = [...forwardLengths, ...reverseLengths], newSpeeds = [...forwardSpeeds, ...reverseSpeeds];
  if (built?.linkLengths.length === 2 && 'id' in site) {
    const changed = [...path.slice(0, leg + 1), site.id, ...path.slice(leg + 1)], realised = routesFor(g, changed, cars, h.me);
    if (realised.some(r => !r || r.conts.some(c => c.edge.owner !== h.me))) return null;
    realised.forEach((r, i) => { newLengths[i] = lengthOf(g, r!); newSpeeds[i] = nativeSpeed(r!); });
  }
  const after: (Station | StationPlan)[] = path.map(id => g.stations.get(id)!); after.splice(leg + 1, 0, site);
  let capital = built?.spent ?? 0;
  if (!built) capital += (site as StationPlan).cost;
  capital += proposals.reduce((n, p) => n + p.cost + p.demolish.reduce((x, id) => x + (g.world.buildings.get(id) ? demolitionCost(g, g.world.buildings.get(id)!) : 0), 0), 0);
  if (!built) capital += (site as StationPlan).demolish.reduce((n, id) => n + (g.world.buildings.get(id) ? demolitionCost(g, g.world.buildings.get(id)!) : 0), 0);
  // Native junction/path signals must fit the full investment and the opening cash reserve.
  capital += 30_000 + addedTrack * 300;
  const proposalUpkeep = (p: Proposal) => p.tracks.reduce((n, t) => n + trackMaintenance({ kind: p.opts.kind, type: p.opts.type, len: t.len, sections: t.sections } as NEdge), 0);
  let addedMaintenance = proposals.reduce((n, p) => n + proposalUpkeep(p), 0);
  if (built) for (const d of built.debits) for (const id of d.edges) { const e = g.world.net.edges.get(id); if (e?.owner === h.me) addedMaintenance += g.edgeMaintenance(e); }
  else {
    const p = site as StationPlan;
    addedMaintenance += p.tracks * p.length * trackBasePerUnit(type) * (p.level === 'underground' ? 5 : p.level === 'elevated' ? 4 : 1);
    if (p.access) addedMaintenance += proposalUpkeep(p.access);
  }
  const v = value(h, l, path, after, oldLengths, newLengths, capital, addedTrack, site, oldSpeeds, newSpeeds, addedMaintenance);
  return { site, proposals, anchors: a.points, bypass: a.bypass, prefix: a.prefix, suffix: a.suffix, oldLengths, oldSpeeds, value: v, option: o };
}

function record(h: RerouteHost, c: NonNullable<RerouteCursor['built']>, operation: () => string | null, irreversible = 0, station = -1): string | null {
  const net = h.g.world.net, retained = new Set(net.edges.keys()), start = net.nextEdge, eco = h.g.company(h.me).economy, construction = eco.thisYear.construction;
  const split = (old: { id: number }, a: { id: number }, b: { id: number }) => {
    if (retained.delete(old.id)) { retained.add(a.id); retained.add(b.id); }
    for (const debit of c.debits) { const at = debit.edges.indexOf(old.id); if (at >= 0) debit.edges.splice(at, 1, a.id, b.id); }
  };
  net.onSplit.push(split); let error: string | null;
  try { error = operation(); } finally { net.onSplit = net.onSplit.filter(f => f !== split); }
  const cost = Math.max(0, construction - eco.thisYear.construction), edges: number[] = [];
  for (let id = start; id < net.nextEdge; id++) if (!retained.has(id) && net.edges.get(id)?.owner === h.me) edges.push(id);
  c.spent += cost; c.debits.push({ cost, edges, station: station >= 0 && h.g.stations.get(station) ? station : -1, refundable: Math.max(0, cost - irreversible) });
  return error;
}
function undo(h: RerouteHost, b: NonNullable<RerouteCursor['built']>, why: string) {
  const g = h.g, net = g.world.net; let refund = 0;
  if (g.lines.all().some(l => l.stops.includes(b.station)) || b.debits.some(d => d.edges.some(id => !net.edges.has(id) || net.edges.get(id)!.owner !== h.me || g.vehicles.isEdgeBusy(id) || g.vehicles.getRes(id)))) {
    h.note(`middle diversion stopped: ${why}; occupied/used works retained, original corridor unchanged`); h.considered('reroute.retained'); return;
  }
  for (const d of [...b.debits].reverse()) {
    const removed = new Set<number>();
    const used = d.station >= 0 && g.lines.all().some(l => l.stops.includes(d.station));
    if (!used) for (const id of d.edges) { const e = net.edges.get(id); if (e?.owner === h.me && !g.vehicles.isEdgeBusy(id)) { net.removeEdge(id); removed.add(id); } }
    if (!used && d.station >= 0 && g.stations.get(d.station)?.owner === h.me) g.stations.removeStation(d.station);
    if (d.edges.every(id => removed.has(id)) && (d.station < 0 || !g.stations.get(d.station))) refund += d.refundable;
  }
  if (refund) g.company(h.me).economy.spend(-refund, 'construction', true);
  g.onNetworkChanged(); g.lines.rebuild(); h.note(`middle diversion given up: ${why}; original corridor retained`); h.considered('reroute.rollback');
}

/** One bounded saved phase per review. No generator frame or proposal survives a simulation work unit. */
export function* rerouteTask(h: RerouteHost, item: { ids: number[]; reroute?: RerouteCursor }): Generator<void, void> {
  const g = h.g, l = g.lines.get(item.ids[0]), key = 'reroute' + item.ids[0];
  const finish = (days: number, why: string) => { delete item.reroute; h.careFor(key, days); h.considered('reroute.' + why); };
  const c = item.reroute;
  if (!l || !rerouteLine(h, l) || c && identity(g, l) !== c.identity) { if (c?.built) undo(h, c.built, 'timetable or stock changed'); finish(120, 'changed'); return; }
  if (!c) {
    if (h.cared(key)) return;
    item.reroute = { stage: 'value', at: 0, identity: identity(g, l), options: survey(h, l, rerouteLine(h, l)!) };
    h.considered('reroute.survey'); return;
  }
  if (c.stage === 'value') {
    const o = c.options[c.at++];
    if (o) { const q = quoteReroute(h, l, o); if (q && q.value.score > 0 && h.affordable(q.value.capital * 1.15, 1)
      && (!c.best || q.value.score > c.best.score)) c.best = { option: c.at - 1, score: q.value.score }; return; }
    if (!c.best) { finish(120, 'unpaid'); return; } c.stage = 'station'; return;
  }
  const o = c.built?.option ?? c.options[c.best!.option], q = quoteReroute(h, l, o, c.built);
  const fail = (why: string) => { if (c.built) undo(h, c.built, why); finish(120, why); };
  if (!q || q.value.score <= 0) { fail('unpaidOrSite'); return; }
  if (c.built?.debits.some(d => d.edges.some(id => !g.world.net.edges.has(id) || g.world.net.edges.get(id)!.owner !== h.me))) { fail('worksChanged'); return; }
  if (!h.affordable(Math.max(0, q.value.capital - (c.built?.spent ?? 0)) * 1.15, 1)) { fail('funds'); return; }
  if (c.stage === 'station') {
    if ('id' in q.site || !h.canSpend(q.value.capital * 1.15, 1)) { finish(30, 'funds'); return; }
    const st = g.stations.nextId, site = q.site;
    const built = c.built = { option: { ...o }, station: st, anchors: q.anchors.map(a => ({ ...a })), bypass: q.bypass, prefix: q.prefix, suffix: q.suffix,
      oldLengths: q.oldLengths, oldSpeeds: q.oldSpeeds, linkLengths: [], linkSpeeds: [],
      capital: q.value.capital, addedTrack: 0, spent: 0, debits: [], waits: 0 };
    const residents = site.demolish.flatMap(id => { const b = g.world.buildings.get(id); return b ? [{ townId: b.townId, pop: b.pop, cost: demolitionCost(g, b) }] : []; });
    const irreversible = residents.reduce((n, b) => n + b.cost * 2, 0);
    const error = record(h, built, () => { const error = g.stations.commitRail(site, h.me); if (!error) h.compensate(site.demolish, residents); return error; }, irreversible, st);
    if (error) { fail('station'); return; } c.stage = 'left'; return;
  }
  if (c.stage === 'left' || c.stage === 'right') {
    const p = q.proposals[0];
    if (!p || !h.canSpend(p.cost * 1.1, 1)) { fail('trackFunds'); return; }
    // A turnout on occupied track waits; no work removes existing rails or ignores train clearance.
    const touched = p.tracks.flatMap(t => [t.start, t.end]).flatMap(s => s.kind === 'edge' ? [s.edge!] : s.kind === 'node' ? g.world.net.nodes.get(s.node!)?.edges ?? [] : []);
    if (touched.some(id => g.vehicles.isEdgeBusy(id))) { if (++c.built!.waits > 120) fail('busy'); return; }
    const residents = p.demolish.flatMap(id => { const b = g.world.buildings.get(id); return b ? [{ townId: b.townId, pop: b.pop, cost: demolitionCost(g, b) }] : []; });
    const error = record(h, c.built!, () => { const error = commitProposal(g, p); if (!error) h.compensate(p.demolish, residents); return error; },
      p.roadBridges?.length ? p.cost : residents.reduce((n, b) => n + b.cost * 2, 0));
    if (error) { fail('track'); return; } c.built!.addedTrack += p.stats.len; c.built!.linkLengths.push(p.stats.len); c.built!.linkSpeeds.push(p.stats.speed); c.built!.waits = 0;
    c.stage = c.stage === 'left' ? 'right' : 'open'; return;
  }
  const b = c.built!, st = g.stations.get(b.station)!, path = rerouteLine(h, l)!, at = path.indexOf(o.a), next = [...path.slice(0, at + 1), st.id, ...path.slice(at + 1)];
  if (!h.canSpend(30_000 + b.addedTrack * 300, 1)) { fail('signalFunds'); return; }
  for (const id of l.vehicles) {
    const t = g.vehicles.get(id) as Train;
    for (let i = 0; i + 1 < next.length; i++) for (const reverse of [false, true]) {
      const from = reverse ? next[i + 1] : next[i], to = reverse ? next[i] : next[i + 1];
      if (!route(g, g.stations.get(from)!, g.stations.get(to)!, t.cars, h.me, nextCall(next, i, reverse))) { fail('route'); return; }
    }
    const dp = g.depots.get(t.depotId);
    if (!dp || dp.owner !== h.me || !next.slice(1).some((to, i) => depotServes(g, dp, next[i], to, t.cars) >= 0)) { fail('depot'); return; }
  }
  if (!g.stations.hasAccess(st)) { fail('access'); return; }
  h.setStops(l, outAndBack(next)); g.lines.rebuild(); for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged(); h.signal(l.id);
  const info = h.managed()?.get(l.id); if (info) { info.towns = [...new Set(next.map(id => g.stations.get(id)?.townId ?? -1).filter(t => t >= 0))]; info.maxVehicles = Math.max(info.maxVehicles, l.vehicles.length); }
  h.stat('netRerouted'); h.stat('netRerouteStops'); h.succeed();
  h.note(`${l.name}: diverted ${g.stations.get(o.a)!.name}–${g.stations.get(o.b)!.name} through ${st.name}; original track retained, ${Math.round(q.value.net / 1000)}k/year marginal surplus on ${Math.round(b.spent / 1000)}k`);
  h.news(`diverts ${l.name} through ${st.name}, retaining its original corridor.`, st.x, st.z); finish(360, 'built');
}
