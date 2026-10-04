// Complete rail upgrades. The cursor contains only IDs and counters: one atomic work unit per yield,
// so saving during an upgrade resumes the same decisions on the same fixed tick.
import type { Game } from './game';
import type { Line } from './lines';
import type { NEdge } from './network';
import { planDoubleTrack, commitDoubleTrack, type DoublePlan } from './trackops';
import { autoSignalLine } from './signals';
import { planStationUpgrade, commitStationUpgrade } from './stations';
import { TRACK_TYPES, RAIL } from './constants';
import { estimateLegFare } from './fares';
import { Heap, Train } from './train';

export interface DoubleJob {
  line: number;
  stops: number[];
  /** Actual consecutive service legs, including a circular route's closing leg; reverse repeats are omitted. */
  legs?: [number, number][];
  at: number;
  phase: string;
  built: number;
  length: number;
  signals: number;
  crossovers: number;
  error: string;
  blocked: boolean;
  deferred: boolean;
  spent?: number;
  returnValue?: number;
  finishFailed?: number[];
}

/** Physical shortest route, independent of one-way signals; previews and retries use the same deterministic trace. */
export function upgradeRoute(g: Game, a: number, b: number, user: number): number[] {
  const net = g.world.net, st = g.stations.get(a);
  if (!st?.rail) return [];
  const entries: { e: NEdge; dir: number; cost: number; path: number[] }[] = [], queue = new Heap();
  const push = (q: (typeof entries)[number]) => { entries.push(q); queue.push(entries.length - 1, q.cost); };
  // The shortest physical approach fixes the original formation across retries, including turnout ladders.
  for (const id of st.rail.edges) {
    const e = net.edges.get(id);
    if (!e) continue;
    for (const dir of [1, -1]) for (const c of net.nextRail(e, dir)) push({ e: c.edge, dir: c.dir, cost: c.edge.len, path: [] });
  }
  const seen = new Map<string, number>();
  for (let guard = 0; queue.size && guard < 30000; guard++) {
    const q = entries[queue.pop()], key = `${q.e.id}:${q.dir}`;
    if ((seen.get(key) ?? Infinity) <= q.cost || !g.canUse(user, q.e.owner) || q.e.depot >= 0) continue;
    seen.set(key, q.cost);
    if (q.e.station === b) return q.path;
    const path = q.e.station < 0 ? [...q.path, q.e.id] : q.path;
    for (const c of net.nextRail(q.e, q.dir)) push({ e: c.edge, dir: c.dir, cost: q.cost + c.edge.len, path });
  }
  return [];
}

/** A genuine parallel rail, at the same height, sampled along the edge (includes short throat/junction pieces). */
export function trackIsDouble(g: Game, id: number, user: number): boolean {
  const net = g.world.net, e = net.edges.get(id);
  if (!e || e.kind !== 'rail' || e.depot >= 0) return false;
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
  const K = Math.max(1, Math.ceil(e.len / 2));
  for (let i = 0; i < K; i++) {
    net.pointAt(e, e.len * (i + 0.5) / K, p, d);
    let twin = false;
    for (const o of net.edgesNear(p.x - 1.7, p.z - 1.7, p.x + 1.7, p.z + 1.7)) {
      if (o.id === id || o.kind !== 'rail' || o.depot >= 0 || !g.canUse(user, o.owner)) continue;
      const near = net.nearestEdge(p.x, p.z, 1.65, 'rail', (e) => e.id === o.id);
      if (!near) continue;
      if (near.d < 0.25) {
        // Distinct station/junction leads may swap sides at a protected diamond. Unlike a loop's merge, the
        // two rails remain separate here and reserve only the actual conflicting crossing movement.
        const diamond = [...net.crossings.values()].some((c) => c.kind === 'diamond' && ((c.e1 === id && c.e2 === o.id) || (c.e2 === id && c.e1 === o.id)) && Math.hypot(c.x - p.x, c.z - p.z) < 5);
        if (!diamond) continue;
      }
      net.pointAt(o, near.s, q, t);
      // A flying movement's ramps run on a bank before the actual bridge span. Include those grade-limited
      // approaches too; otherwise a sound second track is repeatedly mistaken for a gap beside its flyover.
      if (Math.abs(q.y - p.y) < RAIL.clearance + 0.3 && Math.abs((d.x * t.x + d.z * t.z) / (Math.hypot(d.x, d.z) * Math.hypot(t.x, t.z) || 1)) > 0.94) { twin = true; break; }
    }
    if (!twin) return false;
  }
  return true;
}

function upgradeLegs(l: { stops: number[] }): [number, number][] {
  const seen = new Set<string>(), legs: [number, number][] = [];
  for (let i = 0; i < l.stops.length; i++) {
    const a = l.stops[i], b = l.stops[(i + 1) % l.stops.length], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key); legs.push([a, b]);
  }
  return legs;
}

export function lineIsDouble(g: Game, l: Line, user: number): boolean {
  const stops = [...new Set(l.stops)];
  if (stops.length < 2) return false;
  for (const sid of stops) if ((g.stations.get(sid)?.rail?.tracks ?? 0) < 2) return false;
  for (const [a, b] of upgradeLegs(l)) {
    const route = upgradeRoute(g, a, b, user);
    if (!route.length || route.some((id) => !trackIsDouble(g, id, user))) return false;
  }
  return true;
}

/** Yearly income recoverable from stalled trains, lost riders and the queue, rather than a fixed upgrade rule. */
export function congestionReturn(g: Game, l: Line): number {
  const trains = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train && v.capacity > 0);
  const held = trains.filter((v) => v!.state === 'waiting').length;
  const fraction = Math.min(0.9, held / Math.max(1, trains.length));
  let queue = 0, lost = 0;
  for (const sid of new Set(l.stops)) {
    const st = g.stations.get(sid);
    if (!st) continue;
    let ours = 0, total = 0;
    for (const w of st.waiting.values()) { total += w.count; if (w.line === l.id) ours += w.count; }
    queue += ours;
    if (total > 0) lost += st.lostLast * ours / total;
  }
  const stops = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter(Boolean);
  const distance = stops.length > 1 ? Math.hypot(stops[0]!.x - stops[stops.length - 1]!.x, stops[0]!.z - stops[stops.length - 1]!.z) : 0;
  const kmh = trains.reduce((s, v) => s + v.maxSpeedKmh, 0) / Math.max(1, trains.length);
  const fare = estimateLegFare(distance, Math.max(30, kmh * 0.6), 60, 1, 1.15, true, false, { mode: 'rail' });
  const capacity = trains.reduce((s, v) => s + v!.capacity, 0);
  // A stalled service still has a value before it has booked its first month's receipts.
  return Math.max(l.incomeLast * fraction, capacity * fare * 12 * fraction) + (lost * 12 + queue * 4) * fare;
}

export function newDoubleJob(l: Line, phase: string): DoubleJob {
  return { line: l.id, stops: [...new Set(l.stops)], legs: upgradeLegs(l), at: 0, phase, built: 0, length: 0, signals: 0, crossovers: 0, error: '', blocked: false, deferred: false };
}

/** Clear portions of a failed whole-line plan, including clear parts inside one long unsplit edge. */
function clearRuns(pl: DoublePlan): [number, number][] {
  const bad: [number, number][] = [];
  pl.proposals.forEach((p, i) => { if (!p.ok && pl.points[i + 1]) bad.push([pl.points[i].u - 2, pl.points[i + 1].u + 2]); });
  if (!bad.length) return [];
  bad.sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  let at = pl.points[0]?.u ?? 0;
  for (const [a, b] of bad) {
    if (a - at > 38) runs.push([at, a]);
    at = Math.max(at, b);
  }
  const end = pl.points.at(-1)?.u ?? pl.length;
  if (end - at > 38) runs.push([at, end]);
  return runs;
}

/** Split only the clear run's boundaries; split listeners retain train paths, ownership and crossing IDs. */
function runEdges(g: Game, route: number[], station: number, from: number, to: number): number[] {
  const net = g.world.net, remaining = [...route], out: number[] = [];
  const first = net.edges.get(remaining[0]);
  let node = first && net.nodes.get(first.a)?.edges.some((id) => net.edges.get(id)?.station === station) ? first.a : first?.b;
  let u = 0;
  for (let i = 0; i < remaining.length; i++) {
    const e = net.edges.get(remaining[i]);
    if (!e) continue;
    const forward = e.a === node;
    node = forward ? e.b : e.a;
    const end = u + e.len;
    if (u < to && end > from) {
      let piece = e, lo = Math.max(0, from - u), hi = Math.min(e.len, to - u);
      if (lo > 0.1 && lo < piece.len - 0.1) {
        const r = net.splitEdge(piece.id, forward ? lo : piece.len - lo)!;
        piece = forward ? r.e2 : r.e1; hi -= lo;
      }
      if (hi > 0.1 && hi < piece.len - 0.1) {
        const r = net.splitEdge(piece.id, forward ? hi : piece.len - hi)!;
        piece = forward ? r.e1 : r.e2;
      }
      out.push(piece.id);
    }
    u = end;
    if (u >= to) break;
  }
  if (out.length) g.onNetworkChanged();
  return out;
}

/** One saved work unit. All planning is read-only; construction and its bookkeeping finish before yielding. */
export function doubleJobStep(g: Game, job: DoubleJob, user: number, fund: (cost: number) => boolean, worth: (cost: number) => boolean): boolean {
  const l = g.lines.get(job.line), net = g.world.net;
  if (!l) return true;
  const legs = job.legs ?? upgradeLegs({ stops: job.stops });
  if (job.at >= legs.length) return true;
  const [a, b] = legs[job.at];
  const route = upgradeRoute(g, a, b, user);
  const denied = route.map((id) => g.trackUpgradeError(user, net.edges.get(id)!.owner)).find(Boolean);
  if (!route.length || denied) { job.error = denied || 'No continuous railway'; job.blocked = true; job.at++; return false; }
  const maintenanceRate = TRACK_TYPES[net.edges.get(route[0])!.type]?.maintPerUnit ?? 100;
  // A line with one platform must first provide two places for opposing trains. Other operators' stations
  // retain their layout: an approach can be upgraded as soon as their owner supplies the extra platform.
  for (const sid of [a, b]) {
    const st = g.stations.get(sid);
    if (!st?.rail || st.rail.tracks >= 2) continue;
    if (st.owner !== user) { job.deferred = true; job.error = 'The station needs a second platform'; job.at++; return false; }
    const up = planStationUpgrade(g, sid, { tracks: 2 });
    if (!up.ok) { job.blocked = true; job.error = up.error ?? 'No room for a second platform'; job.at++; return false; }
    if (!worth(up.cost)) { job.blocked = true; job.error = 'platform costs exceed recoverable revenue'; job.at++; return false; }
    if (!fund(up.cost)) { job.deferred = true; job.error = 'not enough money for platforms'; job.at++; return false; }
    const err = commitStationUpgrade(g, up);
    if (err) { job.error = err; job.deferred = true; job.at++; return false; }
    job.spent = (job.spent ?? 0) + up.cost;
    g.stations.refreshAccess();
    return false; // the rebuild changed approach IDs: trace the same leg next unit
  }
  if (route.every((id) => trackIsDouble(g, id, user)) && !job.finishFailed?.includes(job.at)) { job.at++; return false; }
  const plans = [1, -1].map((side) => planDoubleTrack(g, route, side as 1 | -1, user));
  let viable = plans.filter((p) => p.ok).sort((p, q) => p.cost - q.cost);
  // A bridge removes flat-junction conflicts when its extra cost earns back enough saved train/passenger time.
  if (viable[0]?.proposals.some((p) => p.crossings.some((c) => c.mode === 'diamond')) && congestionReturn(g, l) > 1_000_000) {
    const flying = planDoubleTrack(g, route, viable[0].side, user, true, { flying: true });
    if (flying.ok && flying.cost - viable[0].cost < congestionReturn(g, l) * 2 && worth(flying.cost)) viable.unshift(flying);
  }
  if (!viable.length) {
    // The ground planner includes widening structures and demolition. Before settling for loops, try a short
    // deviation round the failed pieces, on both sides. Its real earthworks/structure costs still have to pay.
    for (const pl of plans) for (const extra of [0.65, 1.2]) {
      const detours = pl.proposals.flatMap((p, i) => !p.ok && pl.points[i + 1] ? [{ at: (pl.points[i].u + pl.points[i + 1].u) / 2, reach: Math.min(40, pl.length / 3), extra }] : []);
      if (!detours.length) continue;
      const repair = planDoubleTrack(g, route, pl.side, user, true, { detours });
      if (repair.ok) viable.push(repair);
    }
    viable.sort((p, q) => p.cost - q.cost);
  }
  let built = false;
  const build = (pl: DoublePlan) => {
    // Added track's maintenance belongs to its owner, with access fees apportioned by actual use.
    const newLength = pl.proposals.reduce((s, p, i) => s + (pl.skipped?.includes(i) ? 0 : p.stats.len), 0) + (pl.joined?.filter((x) => !x).length ?? 2) * 10;
    const structureUpkeep = pl.proposals.reduce((s, p, i) => s + (pl.skipped?.includes(i) ? 0 : p.tracks.reduce((v, t) => v + t.sections.reduce((v, q) => v + (q.s1 - q.s0) * maintenanceRate * (q.type === 'tunnel' ? 4 : 3), 0), 0)), 0);
    const upkeep = newLength * maintenanceRate + structureUpkeep;
    if (!worth(pl.cost + upkeep * 3)) { job.blocked = true; job.error = 'track costs exceed recoverable revenue'; return false; }
    if (!fund(pl.cost + 150_000)) { job.deferred = true; job.error = 'not enough money'; return false; }
    const res = commitDoubleTrack(g, pl, true);
    if (res.error) { job.error = res.error; job.deferred ||= /money|train|vehicle|changed/i.test(res.error); return false; }
    job.built++; job.length += res.edges.reduce((s, id) => s + (net.edges.get(id)?.len ?? 0), 0);
    job.spent = (job.spent ?? 0) + res.cost + upkeep * 3;
    job.signals += res.signals; job.crossovers += res.crossovers;
    if (res.finishError) {
      job.error = res.finishError;
      (job.finishFailed ??= []).push(job.at);
      if (/money|train|vehicle|changed/i.test(res.finishError)) job.deferred = true; else job.blocked = true;
    } else job.finishFailed = job.finishFailed?.filter((at) => at !== job.at);
    return true;
  };
  for (const pl of viable) { if (build(pl)) { built = true; break; } if (job.deferred) break; }
  if (!built && !job.deferred) {
    job.error = plans[0].errors[0] ?? job.error;
    // Structures are widened/rebuilt by planEdge and payable demolitions are included in these plans.
    // An obstructed throat can reject a full plan before it even sketches the clear open line. In that case
    // sketch a temporary loop with ordinary end turnouts; do not mistake a cheaper loop for full completion.
    const stopgaps = plans.map((pl) => pl.proposals.length ? pl : planDoubleTrack(g, route, pl.side, user, false));
    for (const pl of stopgaps) if (pl.ok && !pl.complete) { if (build(pl)) { built = true; break; } if (job.deferred) break; }
    const clear = stopgaps.map((pl) => ({ pl, runs: clearRuns(pl) })).sort((p, q) => q.runs.reduce((s, [a, b]) => s + b - a, 0) - p.runs.reduce((s, [a, b]) => s + b - a, 0))[0];
    const first = net.edges.get(clear.pl.steps[0]?.edge), node = clear.pl.start.node >= 0 ? clear.pl.start.node : first ? clear.pl.steps[0].dir > 0 ? first.a : first.b : -1;
    const source = net.nodes.get(node)?.edges.map((id) => net.edges.get(id)!).find((e) => e.station === a || e.station === b)?.station ?? a;
    for (const [from, to] of built || job.deferred ? [] : clear.runs) {
      const fresh = upgradeRoute(g, source, source === a ? b : a, user);
      if (fresh.some((id) => g.vehicles.isEdgeBusy(id))) { job.deferred = true; break; }
      const run = runEdges(g, fresh, source, from, to);
      for (const side of [1, -1] as const) {
        const pl = planDoubleTrack(g, run, side, user, false);
        if (pl.ok && build(pl)) { built = true; break; }
        if (job.deferred) break;
      }
      if (job.deferred) break;
    }
    job.blocked = true;
  }
  // Signals on the surrounding station/junction paths preserve directional running and protect diamonds.
  const sig = autoSignalLine(g, l.id, user);
  job.signals += sig.placed;
  g.stations.refreshAccess();
  job.at++;
  return false;
}
