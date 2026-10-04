// An operating agreement for shared railway capacity. All amounts are annual fares/costs, not fleet quotas.
import type { Game } from './game';
import type { Line } from './lines';
import type { NEdge } from './network';
import type { VehicleModel } from './vehicle-types';
import { Train } from './train';
import { capacityRouteBetween as routeBetween, capacityTopologyKey } from './rail-capacity-routes';
import { linearStops } from './lines';
import { patternOf, patternStops, patternHeadways, nextStopIndex } from './patterns';
import { fareFor, estimateLegTime, tripFactor, refTime } from './fares';
import { estimateVehicleYear, YEAR_S, trackBasePerUnit } from './opcosts';
import { KMH_TO_UPS, TRACK_TYPES, RAIL } from './constants';
import { railPartMode } from './stations';
import { railCapacityOptions } from './rail-capacity-options';

export interface RailCapacityState {
  day: number;
  /** Daily exponentially weighted signal delay and share held; simulation observations survive loading. */
  delay: number; held: number; longest: number;
  demand?: { month: number; route: string; revenue: number; boardings: number; fare: number; distance: number; seconds: number; ride: number };
  withdrawn?: number;
  works?: { day: number; owner: number; edges: number[]; side: 1 | -1 };
  tried?: number;
}

export interface CapacityResource {
  id: number; kind: 'single' | 'block' | 'platform'; edges: number[]; owners: number[];
  length: number; available: number;
}
interface RouteInventory { resources: CapacityResource[]; edgeResource: Map<number, number>; routes: Map<number, number[][]> }
interface Channel {
  line: Line; owner: number; pattern: number; cars: VehicleModel[]; trains: Train[];
  cycle: number; seats: number; running: number; capital: number; budget: number; boardings: number;
  use: Map<number, number>; limit: number;
}
export interface CapacityAllocation { line: number; owner: number; pattern: number; trains: number; traffic: number }
export interface SharedCapacityPlan {
  lines: number[]; resources: CapacityResource[]; allocations: CapacityAllocation[];
  /** The lowest contribution leaves first, including a partner's sole train when it displaces better traffic. */
  withdraw: { train: number; owner: number; line: number; value: number }[];
  limit: number; physical: number; revenue: number; delay: number;
}

const inventoryMemo = new WeakMap<Game, { key: string; value: RouteInventory }>();
const planMemo = new WeakMap<Game, Map<number, { key: string; plan: SharedCapacityPlan; channels: Channel[]; counts: number[]; inventory: RouteInventory }>>();
const fleet = (g: Game, l: Line) => l.vehicles.map(id => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train);

/** Parallel running tracks at the same height; crossovers/grade separations never count as another lane. */
function parallel(g: Game, e: NEdge): number[] {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(e, e.len / 2, p, d);
  const dl = Math.hypot(d.x, d.z) || 1, out: number[] = [];
  for (const o of net.edgesNear(p.x - 2 * RAIL.spacing, p.z - 2 * RAIL.spacing, p.x + 2 * RAIL.spacing, p.z + 2 * RAIL.spacing)) {
    if (o.id === e.id || o.kind !== 'rail' || o.station >= 0 || o.depot >= 0) continue;
    const hit = net.nearestEdge(p.x, p.z, 2 * RAIL.spacing + 0.1, 'rail', x => x.id === o.id);
    if (!hit || hit.d < 0.2) continue;
    const q = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
    net.pointAt(o, hit.s, q, t);
    if (Math.abs(q.y - p.y) < 0.3 && Math.abs(d.x * t.x + d.z * t.z) / (dl * (Math.hypot(t.x, t.z) || 1)) > 0.95) out.push(o.id);
  }
  return out.sort((a, b) => a - b);
}

/** Resources are exclusive single-track stretches, directional blocks and connected platform tracks. */
function inventory(g: Game): RouteInventory {
  const lines = [...g.lines.map.values()].filter(l => l.kind === 'rail' && l.stops.length >= 2).sort((a, b) => a.id - b.id);
  const key = `${capacityTopologyKey(g)}:${g.lines.version}:` + lines.map(l => `${l.id}/${l.owner}/${l.stops.join(',')}`).join(';');
  const memo = inventoryMemo.get(g);
  if (memo?.key === key) return memo.value;
  const net = g.world.net, routes = new Map<number, number[][]>(), edges = new Set<number>();
  for (const l of lines) {
    const hops: number[][] = [];
    for (let i = 0; i < l.stops.length; i++) {
      const a = l.stops[i], b = l.stops[(i + 1) % l.stops.length];
      const hop = a === b ? [] : routeBetween(g, a, b, l.owner) ?? [];
      hops.push(hop); for (const id of hop) edges.add(id);
    }
    for (const sid of new Set(l.stops)) for (const id of g.stations.get(sid)?.rail?.edges ?? []) edges.add(id);
    routes.set(l.id, hops);
  }
  const twins = new Map<number, number[]>();
  for (const id of edges) {
    const e = net.edges.get(id);
    if (e && e.station < 0 && e.depot < 0) twins.set(id, parallel(g, e));
  }
  const resources: CapacityResource[] = [], edgeResource = new Map<number, number>();
  const single = new Set([...twins].filter(([, t]) => !t.length).map(([id]) => id));
  const seen = new Set<number>();
  for (const seed of [...single].sort((a, b) => a - b)) {
    if (seen.has(seed)) continue;
    const queue = [seed], ids: number[] = []; seen.add(seed);
    while (queue.length) {
      const id = queue.pop()!, e = net.edges.get(id)!; ids.push(id);
      for (const nid of [e.a, e.b]) for (const next of net.nodes.get(nid)?.edges ?? []) {
        if (single.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    ids.sort((a, b) => a - b);
    const r: CapacityResource = { id: resources.length, kind: 'single', edges: ids,
      owners: [...new Set(ids.map(id => net.edges.get(id)!.owner))].sort((a, b) => a - b),
      length: ids.reduce((n, id) => n + net.edges.get(id)!.len, 0), available: 2 };
    resources.push(r); for (const id of ids) edgeResource.set(id, r.id);
  }
  // Each signalled block has independent following capacity; short pieces of an unsignalled twin cannot
  // manufacture slots: use at least the signal spacing for their occupation time below.
  for (const [id, ts] of [...twins].sort(([a], [b]) => a - b)) {
    if (!ts.length || edgeResource.has(id)) continue;
    const ids = [id, ...ts].filter(x => !edgeResource.has(x));
    const r: CapacityResource = { id: resources.length, kind: 'block', edges: ids,
      owners: [...new Set(ids.map(x => net.edges.get(x)!.owner))].sort((a, b) => a - b),
      length: Math.max(...ids.map(x => net.edges.get(x)!.len)), available: Math.max(2, ids.length) };
    resources.push(r); for (const x of ids) edgeResource.set(x, r.id);
  }
  for (const sid of [...new Set(lines.flatMap(l => l.stops))].sort((a, b) => a - b)) {
    const st = g.stations.get(sid), rail = st?.rail;
    if (!st || !rail) continue;
    const ids = rail.edges.filter(id => net.edges.has(id));
    // A painted second platform with no approach connection is no passing place.
    const connected = ids.filter(id => { const e = net.edges.get(id)!; return [e.a, e.b].some(n => (net.nodes.get(n)?.edges ?? []).some(x => x !== id && net.edges.get(x)?.depot === -1)); }).length;
    const r: CapacityResource = { id: resources.length, kind: 'platform', edges: ids, owners: [st.owner], length: rail.length,
      available: Math.max(1, Math.min(rail.tracks, connected)) };
    resources.push(r); for (const id of ids) edgeResource.set(id, r.id);
  }
  const value = { resources, edgeResource, routes }; inventoryMemo.set(g, { key, value }); return value;
}

export function usesSharedRail(g: Game, l: Line): boolean {
  if (l.kind !== 'rail' || !railCapacityOptions.enabled) return false;
  if ((l.operators?.length ?? 0) > 0 || new Set(fleet(g, l).map(t => t.owner)).size > 1) return true;
  const inv = inventory(g), ours = new Set((inv.routes.get(l.id) ?? []).flat());
  if ([...ours].some(id => { const e = g.world.net.edges.get(id); return e && e.owner >= 0 && e.owner !== l.owner; })) return true;
  return [...inv.routes].some(([id, routes]) => id !== l.id && routes.some(h => h.some(e => ours.has(e))));
}

export function observeRailCapacity(g: Game) {
  for (const l of g.lines.map.values()) {
    if (!usesSharedRail(g, l)) continue;
    const s = l.capacity ??= { day: -1, delay: 0, held: 0, longest: 0 };
    if (s.day === g.day) continue;
    const ts = fleet(g, l).filter(t => t.onMap), waiting = ts.filter(t => t.state === 'waiting');
    const delay = waiting.reduce((n, t) => n + t.stuckTime, 0) / Math.max(1, ts.length);
    s.delay = (29 * s.delay + delay) / 30;
    s.held = (29 * s.held + waiting.filter(t => t.stuckTime > 30).length / Math.max(1, ts.length)) / 30;
    s.longest = Math.max(0, ...waiting.map(t => t.stuckTime)); s.day = g.day;
  }
}

function demand(g: Game, l: Line, cycle: number) {
  const s = l.capacity ??= { day: -1, delay: 0, held: 0, longest: 0 };
  const route = l.stops.join(','), month = Math.floor(g.day / 30);
  if (s.demand?.route === route && s.demand.month === month) return s.demand;
  const sites = (linearStops(l.stops) ?? [...new Set(l.stops)]).map(id => g.stations.get(id)).filter(s => !!s?.rail);
  let distance = 1;
  for (const a of sites) for (const b of sites) distance = Math.max(distance, Math.hypot(a!.x - b!.x, a!.z - b!.z));
  const trains = fleet(g, l), kmh = Math.max(20, Math.min(100, ...trains.map(t => t.maxSpeedKmh * 0.6)));
  const forecast = g.demand.forecastLine(sites as NonNullable<typeof sites[number]>[], sites[0]?.rail ? railPartMode(sites[0].rail) : 'mainline', kmh, cycle / Math.max(1, trains.length), l.owner, l.id);
  const ride = estimateLegTime(distance, kmh, 0), seconds = estimateLegTime(distance, kmh, cycle / Math.max(1, trains.length));
  const fare = fareFor(distance, seconds, 1, { mode: 'rail' });
  let lost = 0;
  for (const st of sites) {
    let ours = 0, all = 0;
    for (const q of st!.waiting.values()) { all += q.count; if (q.line === l.id) ours += q.count; }
    lost += (st!.lostLast + st!.lostMonth) * (all ? ours / all : 1 / Math.max(1, [...g.lines.map.values()].filter(x => x.stops.includes(st!.id)).length));
  }
  // Observed receipts and abandoned journeys protect a successful corridor from optimistic/poor forecasts.
  const receipts = Math.max(l.incomeLast, l.incomeYear * 360 / Math.max(30, g.day % 360));
  const revenue = Math.max(forecast.revenue, receipts + lost * 6 * fare);
  s.demand = { month, route, revenue, boardings: Math.max(1, forecast.boardings, revenue / Math.max(1, fare)), fare, distance, seconds, ride };
  return s.demand;
}

/** A new through link also sells journeys from the existing OD network, beyond walking catchments.
 * Keep its construction forecast until actual receipts can replace it; it is the entrant's economic bid. */
export function priceSharedProject(g: Game, l: Line, forecast: { revenue: number; boardings: number; kmh: number; headway: number }) {
  if (!usesSharedRail(g, l)) return;
  const d = demand(g, l, forecast.headway);
  if (forecast.revenue <= d.revenue) return;
  d.revenue = forecast.revenue; d.boardings = Math.max(1, forecast.boardings);
  d.ride = estimateLegTime(d.distance, forecast.kmh, 0);
  d.seconds = estimateLegTime(d.distance, forecast.kmh, forecast.headway);
  d.fare = fareFor(d.distance, d.seconds, 1, { mode: 'rail' });
}

function channelsFor(g: Game, lines: Line[], inv: RouteInventory, candidate?: { line: Line; owner: number; cars: VehicleModel[]; pattern?: number }): Channel[] {
  const out: Channel[] = [], net = g.world.net;
  for (const l of lines) {
    const ts = fleet(g, l), groups = new Map<string, { owner: number; pid: number; trains: Train[]; cars: VehicleModel[] }>();
    for (const t of ts) {
      const pid = patternOf(l, t.pattern)?.id ?? 0, key = `${t.owner}:${pid}`;
      let c = groups.get(key);
      if (!c) { c = { owner: t.owner, pid, trains: [], cars: t.cars }; groups.set(key, c); }
      c.trains.push(t);
    }
    if (candidate?.line.id === l.id) {
      const pid = patternOf(l, candidate.pattern)?.id ?? 0, key = `${candidate.owner}:${pid}`;
      if (!groups.has(key)) groups.set(key, { owner: candidate.owner, pid, trains: [], cars: candidate.cars });
    }
    const headways = patternHeadways(g, l);
    const cycle = Math.max(1, ...headways.map(p => p.cycle), 2 * l.stops.length * 10);
    const d = demand(g, l, cycle), weights = new Map<string, number>();
    for (const [key, c] of groups) {
      const served = new Set(patternStops(l, c.pid).map(i => l.stops[i]));
      const traffic = c.trains.reduce((n, t) => n + t.delivered * 360 / Math.max(30, g.day - t.boughtDay), 0);
      const catchment = [...served].reduce((n, id) => { const st = g.stations.get(id); return n + (st?.owner === c.owner ? Math.max(1, st.catchPop, st.genLast * 12) : 0); }, 0);
      const payments = g.access.filter(a => a.user === c.owner).reduce((n, a) => n + a.paidLastMonth * 12, 0);
      // Traffic and paid access buy the right to useful paths. An entrant bids with the demand at its stations.
      weights.set(key, Math.max(1, traffic + catchment * 0.1 + payments / Math.max(1, d.fare)));
    }
    const sum = [...weights.values()].reduce((n, x) => n + x, 0);
    for (const [key, c] of groups) {
      const indices = patternStops(l, c.pid);
      if (indices.length < 2 || !c.cars.length) continue;
      const carSpeed = Math.min(...c.cars.map(m => m.speed)), speed = Math.max(0.4, carSpeed * 0.6 * KMH_TO_UPS);
      const use = new Map<number, number>(); let distance = 0;
      for (const i of indices) {
        const j = nextStopIndex(l, c.pid, i), a = l.stops[i], b = l.stops[j];
        if (a === b) continue;
        const hop = c.owner === l.owner && j === (i + 1) % l.stops.length ? inv.routes.get(l.id)?.[i] ?? [] : routeBetween(g, a, b, c.owner) ?? [];
        const perHop = new Map<number, number>();
        for (const id of hop) {
          const e = net.edges.get(id), rid = inv.edgeResource.get(id);
          if (!e || rid === undefined || e.depot >= 0) continue;
          const r = inv.resources[rid], cap = Math.max(0.4, Math.min(speed, (TRACK_TYPES[e.type]?.speed ?? carSpeed) * 0.6 * KMH_TO_UPS));
          const seconds = r.kind === 'platform' ? 10 + c.cars.reduce((n, m) => n + m.length, 0) / cap
            : (r.kind === 'block' ? Math.max(e.len, 50) : e.len) / cap;
          perHop.set(rid, (perHop.get(rid) ?? 0) + seconds);
          if (e.station < 0) distance += e.len;
        }
        for (const [rid, seconds] of perHop) use.set(rid, (use.get(rid) ?? 0) + seconds);
      }
      const pcycle = Math.max(1, headways.find(p => p.pid === c.pid)?.cycle ?? distance / speed + indices.length * 10);
      for (const [rid, seconds] of use) use.set(rid, seconds / pcycle);
      const year = estimateVehicleYear(c.cars, distance / Math.max(1, indices.length), g.year, 0.5);
      const wear = distance / 2 * year.trackWearPerUnit;
      const part = weights.get(key)! / Math.max(1, sum);
      out.push({ line: l, owner: c.owner, pattern: c.pid, cars: c.cars, trains: c.trains,
        cycle: pcycle, seats: c.cars.reduce((n, m) => n + m.capacity, 0) * YEAR_S / pcycle * indices.length * 0.65,
        running: year.total + wear, capital: c.cars.reduce((n, m) => n + m.cost, 0), budget: d.revenue * part, boardings: d.boardings * part,
        use, limit: use.size ? Math.ceil(Math.min(...[...use].map(([rid, u]) => inv.resources[rid].available / Math.max(0.001, u)))) : 0 });
    }
  }
  return out.sort((a, b) => a.line.id - b.line.id || a.owner - b.owner || a.pattern - b.pattern);
}

function loads(channels: Channel[], counts: number[]): Map<number, number> {
  const out = new Map<number, number>();
  channels.forEach((c, i) => { for (const [r, u] of c.use) out.set(r, (out.get(r) ?? 0) + u * counts[i]); });
  return out;
}

/** More holds mean fewer round trips, lower time-valued fares, and more passengers abandoning the queue. */
function receipts(channels: Channel[], counts: number[], inv: RouteInventory, enlarged?: ReadonlyMap<number, number>): number[] {
  const load = loads(channels, counts);
  return channels.map((c, i) => {
    if (!counts[i]) return 0;
    let delay = 0;
    for (const [rid, u] of c.use) {
      const available = enlarged?.get(rid) ?? inv.resources[rid].available;
      const pressure = (load.get(rid) ?? 0) / available;
      // Beyond throughput, an extra departure queues behind all the other trains, including its own fleet.
      delay += c.cycle * u * (0.12 * Math.max(0, pressure - 0.65) ** 2 + 20 * Math.max(0, pressure - 1) ** 2);
    }
    const observation = c.line.capacity;
    // Decisions use the saved fixed-day observation, so a warm cache and a loaded game see identical prices.
    const measured = Math.max(observation?.delay ?? 0, (observation?.longest ?? 0) * (observation?.held ?? 0));
    const actual = Math.max(1, fleetCount(channels, c.line.id));
    const proposed = channels.reduce((n, x, j) => n + (x.line.id === c.line.id ? counts[j] : 0), 0);
    const upgraded = enlarged ? [...c.use].reduce((n, [id, u]) => n + u * (inv.resources[id].available / (enlarged.get(id) ?? inv.resources[id].available)) ** 2, 0)
      / Math.max(0.001, [...c.use.values()].reduce((n, u) => n + u, 0)) : 1;
    delay += measured * (proposed / actual) ** 2 * upgraded;
    const availability = c.cycle / (c.cycle + 2 * delay);
    const d = c.line.capacity!.demand!;
    const frequency = channels.reduce((n, other, j) => n + (other.line.id === c.line.id && other.pattern === c.pattern ? counts[j] / other.cycle : 0), 0);
    const seconds = d.ride + 0.5 / Math.max(0.001, frequency) + delay;
    const fare = fareFor(d.distance, seconds, 1, { mode: 'rail' }) / Math.max(1, d.fare);
    const capture = tripFactor(seconds, refTime(d.distance)) / Math.max(0.01, tripFactor(d.seconds, refTime(d.distance)));
    const carried = Math.min(1, c.seats * counts[i] * availability / Math.max(1, c.boardings));
    // Availability also prices suppressed trips and abandonment, beyond the people that fit in the train.
    return c.budget * carried * availability * fare * capture;
  });
}
const fleetCount = (channels: Channel[], line: number) => channels.reduce((n, c) => n + (c.line.id === line ? c.trains.length : 0), 0);
const netValue = (channels: Channel[], counts: number[], inv: RouteInventory, enlarged?: ReadonlyMap<number, number>) =>
  receipts(channels, counts, inv, enlarged).reduce((n, r, i) => n + r - counts[i] * (channels[i].running + channels[i].capital * 0.03), 0);

function connectedLines(g: Game, l: Line, inv: RouteInventory): Line[] {
  const ids = new Set<number>([l.id]), used = new Set<number>();
  const add = (line: Line) => { for (const id of (inv.routes.get(line.id) ?? []).flat()) { const r = inv.edgeResource.get(id); if (r !== undefined) used.add(r); } };
  add(l);
  for (let changed = true; changed;) {
    changed = false;
    for (const other of [...g.lines.map.values()].sort((a, b) => a.id - b.id)) {
      if (other.kind !== 'rail' || ids.has(other.id)) continue;
      if ((inv.routes.get(other.id) ?? []).some(h => h.some(id => used.has(inv.edgeResource.get(id) ?? -1)))) {
        ids.add(other.id); add(other); changed = true;
      }
    }
  }
  return [...ids].sort((a, b) => a - b).map(id => g.lines.map.get(id)!).filter(Boolean);
}

/** Every operator reads the same deterministic auction of paths, weighted by its traffic/access payments. */
export function sharedCapacityPlan(g: Game, l: Line): SharedCapacityPlan {
  const inv = inventory(g), lines = connectedLines(g, l, inv);
  const key = `${g.day}:${capacityTopologyKey(g)}:${g.lines.version}:` + lines.map(x => `${x.id}/${fleet(g, x).map(t => `${t.id},${t.owner},${t.pattern},${t.delivered},${t.profitLast},${t.cars.map(c => c.id).join(',')}`).join('/')}/${x.capacity?.delay}/${x.capacity?.held}/${x.capacity?.longest}`).join(';');
  let m = planMemo.get(g); if (!m) { m = new Map(); planMemo.set(g, m); }
  const old = m.get(l.id);
  if (old?.key === key) return { ...old.plan, limit: old.plan.allocations.filter(a => a.line === l.id).reduce((n, a) => n + a.trains, 0),
    physical: Math.max(0, ...old.channels.filter(c => c.line.id === l.id).map(c => c.limit)) };
  const channels = channelsFor(g, lines, inv), counts = channels.map(c => c.trains.length);
  const target = channels.map(c => g.company(c.owner).ai ? 0 : c.trains.length);
  let value = netValue(channels, target, inv);
  // Each accepted path has positive marginal surplus after its delays to *all* services have been charged.
  for (;;) {
    let best = -1, gain = 0;
    for (let i = 0; i < channels.length; i++) {
      if (!g.company(channels[i].owner).ai || target[i] >= channels[i].limit) continue;
      target[i]++; const next = netValue(channels, target, inv) - value; target[i]--;
      if (next > gain + 1e-6) { best = i; gain = next; }
    }
    if (best < 0) break;
    target[best]++; value += gain;
  }
  const withdraw: SharedCapacityPlan['withdraw'] = [];
  const actual = netValue(channels, counts, inv);
  channels.forEach((c, i) => {
    if (!g.company(c.owner).ai || counts[i] <= target[i]) return;
    counts[i]--; const marginal = actual - netValue(channels, counts, inv); counts[i]++;
    const worst = [...c.trains].sort((a, b) => a.delivered / Math.max(1, g.day - a.boughtDay) - b.delivered / Math.max(1, g.day - b.boughtDay)
      || a.profitLast - b.profitLast || b.id - a.id)[0];
    if (worst) withdraw.push({ train: worst.id, owner: c.owner, line: c.line.id, value: marginal });
  });
  withdraw.sort((a, b) => a.value - b.value || b.train - a.train || a.owner - b.owner);
  const used = new Set(channels.flatMap(c => [...c.use.keys()]));
  const plan: SharedCapacityPlan = { lines: lines.map(x => x.id), resources: inv.resources.filter(r => used.has(r.id)),
    allocations: channels.map((c, i) => ({ line: c.line.id, owner: c.owner, pattern: c.pattern, trains: target[i], traffic: c.budget })),
    withdraw, limit: channels.reduce((n, c, i) => n + (c.line.id === l.id ? target[i] : 0), 0),
    physical: Math.max(0, ...channels.filter(c => c.line.id === l.id).map(c => c.limit)),
    revenue: receipts(channels, counts, inv).reduce((n, x) => n + x, 0), delay: Math.max(0, ...lines.map(x => x.capacity?.delay ?? 0)) };
  const entry = { key, plan, channels, counts, inventory: inv };
  for (const x of lines) m.set(x.id, entry);
  return plan;
}

/** Read-only audit of the most recent decision; inspecting the plan must never change a demand snapshot. */
export function observedCapacityAgreement(g: Game, l: Line) {
  const e = planMemo.get(g)?.get(l.id);
  return e ? { day: Number(e.key.split(':')[0]), allocations: e.plan.allocations } : undefined;
}

/** The private fare gain minus the delay/abandonment bill to everyone else, own trains included. */
export function marginalSharedTrain(g: Game, l: Line, owner: number, cars: VehicleModel[], pattern?: number): number {
  const inv = inventory(g), channels = channelsFor(g, connectedLines(g, l, inv), inv, { line: l, owner, cars, pattern });
  const pid = patternOf(l, pattern)?.id ?? 0, i = channels.findIndex(c => c.line.id === l.id && c.owner === owner && c.pattern === pid);
  if (i < 0) return -Infinity;
  const counts = channels.map(c => c.trains.length), before = netValue(channels, counts, inv);
  counts[i]++; return netValue(channels, counts, inv) - before;
}

export function sharedTrainAllowed(g: Game, l: Line, owner: number, cars: VehicleModel[], pattern?: number): boolean {
  if (!usesSharedRail(g, l)) return true;
  const plan = sharedCapacityPlan(g, l), pid = patternOf(l, pattern)?.id ?? 0;
  const allocated = plan.allocations.find(a => a.line === l.id && a.owner === owner && a.pattern === pid);
  const existing = fleet(g, l).filter(t => t.owner === owner && (patternOf(l, t.pattern)?.id ?? 0) === pid).length;
  // A new bidder is valued before it has any vehicles/receipts; incumbents honour the agreed paid paths.
  return (!allocated || existing < allocated.trains) && marginalSharedTrain(g, l, owner, cars, pattern) > 0;
}

/** Extra coaches buy seats without buying another path; their extra cost/clearance time must still pay. */
export function marginalSharedConsist(g: Game, l: Line, t: Train, cars: VehicleModel[]): number {
  if (!usesSharedRail(g, l)) return Infinity;
  const inv = inventory(g), channels = channelsFor(g, connectedLines(g, l, inv), inv);
  const i = channels.findIndex(c => c.line.id === l.id && c.owner === t.owner && c.pattern === (patternOf(l, t.pattern)?.id ?? 0));
  if (i < 0) return -Infinity;
  const counts = channels.map(c => c.trains.length), before = netValue(channels, counts, inv), c = channels[i], n = Math.max(1, counts[i]);
  const legs = patternStops(l, c.pattern).length, hop = c.line.capacity!.demand!.distance / Math.max(1, legs / 2);
  const oldYear = estimateVehicleYear(t.cars, hop, g.year, 0.5), newYear = estimateVehicleYear(cars, hop, g.year, 0.5);
  const extraSeats = cars.reduce((s, m) => s + m.capacity, 0) - t.capacity;
  const oldCost = t.cars.reduce((s, m) => s + m.cost, 0), newCost = cars.reduce((s, m) => s + m.cost, 0);
  channels[i] = { ...c, seats: c.seats + extraSeats * YEAR_S / c.cycle * legs * 0.65 / n,
    running: c.running + (newYear.total - oldYear.total) / n, capital: c.capital + (newCost - oldCost) / n,
    cycle: c.cycle * (1 + Math.max(0, oldYear.trips / Math.max(1, newYear.trips) - 1) / n), use: new Map(c.use) };
  const length = cars.reduce((s, m) => s + m.length, 0) - t.length;
  for (const [rid, u] of c.use) if (inv.resources[rid].kind === 'platform')
    channels[i].use.set(rid, u + length / Math.max(0.4, t.maxSpeed * 0.6) / c.cycle / n);
  return netValue(channels, counts, inv) - before;
}

/** Surplus recovered by an upgrade, at today's fleet (and its next profitable departure). */
export function sharedUpgradeReturn(g: Game, l: Line, resourceIds: number[], multiplier: number, cost: number, upkeep: number): { annual: number; pays: boolean; contributions: { owner: number; cost: number; annual: number }[] } {
  sharedCapacityPlan(g, l);
  const e = planMemo.get(g)!.get(l.id)!;
  const enlarged = new Map(resourceIds.map(id => [id, e.inventory.resources[id].available * multiplier]));
  const before = netValue(e.channels, e.counts, e.inventory);
  let after = netValue(e.channels, e.counts, e.inventory, enlarged), bestCounts = [...e.counts];
  for (let i = 0; i < e.channels.length; i++) {
    const counts = [...e.counts]; counts[i]++;
    const value = netValue(e.channels, counts, e.inventory, enlarged);
    if (value > after) { after = value; bestCounts = counts; }
  }
  const annual = after - before - upkeep;
  const risk = g.aiOf(l.owner)?.config.risk ?? 0.5;
  // Capital's opportunity cost plus debt service, the same economic terms as through-link construction.
  const required = cost * (0.045 - 0.03 * risk + 0.03);
  const oldReceipts = receipts(e.channels, e.counts, e.inventory), newReceipts = receipts(e.channels, bestCounts, e.inventory, enlarged);
  const gains = new Map<number, number>();
  e.channels.forEach((c, i) => {
    const gain = newReceipts[i] - oldReceipts[i] - (bestCounts[i] - e.counts[i]) * (c.running + c.capital * 0.03);
    if (g.company(c.owner).ai) gains.set(c.owner, (gains.get(c.owner) ?? 0) + gain);
  });
  const positive = [...gains].filter(([, gain]) => gain > 0).sort(([a], [b]) => a - b), total = positive.reduce((n, [, gain]) => n + gain, 0);
  // Operators finance the works in proportion to recovered surplus; title alone does not oblige an owner
  // to subsidise partners' fares. Human companies never make an automatic contribution.
  const contributions = positive.map(([owner, gain]) => ({ owner, annual: gain - upkeep * gain / Math.max(1, total), cost: cost * gain / Math.max(1, total) }));
  return { annual, pays: annual > required && total - upkeep > required, contributions };
}

export function capacityTrackUpkeep(g: Game, edges: number[]): number {
  return edges.reduce((n, id) => { const e = g.world.net.edges.get(id); return n + (e ? e.len * trackBasePerUnit(e.type) : 0); }, 0);
}
