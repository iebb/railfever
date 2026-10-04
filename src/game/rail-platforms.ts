// Saved route-call platform preferences. Reads are pure; only explicit route, stock and topology edits allocate.
import type { Game } from './game';
import type { Line, RailPlatformCall } from './lines';
import type { RailTrackGroup } from './stations';
import { isLoopLine, turnIndex } from './patterns';
import type { Train, TrackRule } from './train';
import { consistRule, findRailRoute, railNext, ruleAllows } from './train';

interface Call { pattern: number; stop: number; station: number; occurrence: number; previous: number; next: number; turn: boolean }
const signatures = new WeakMap<Line, string>();
const topologies = new WeakMap<Game, { signature: string; epoch: number }>();

/** Read pattern flags without the lazy pattern alignment cache (UI and train route reads never allocate). */
function calls(l: Line): Call[] {
  const out: Call[] = [], n = l.stops.length;
  // Same Auto/explicit loop rule as Lines.isLoop. Stored return calls already describe both directions.
  const cyclic = isLoopLine(l) || turnIndex(l.stops) > 0;
  const patterns = l.patterns?.length ? l.patterns : [{ id: 0, stops: l.stops.map(() => true), ids: l.stops }];
  for (const p of patterns) {
    const old = p.ids ?? l.stops, used = new Map<number, number>();
    const positions = new Map<number, number[]>();
    old.forEach((s, i) => positions.set(s, [...(positions.get(s) ?? []), i]));
    let flags = l.stops.map(s => { const k = used.get(s) ?? 0; used.set(s, k + 1); const a = positions.get(s); return !a || p.stops[a[Math.min(k, a.length - 1)]] !== false; });
    if (new Set(l.stops.filter((_, i) => flags[i])).size < 2) flags = l.stops.map(() => true);
    const served = flags.flatMap((yes, i) => yes ? [i] : []), occurrences = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const station = l.stops[i], occurrence = occurrences.get(station) ?? 0;
      occurrences.set(station, occurrence + 1);
      if (!flags[i]) continue;
      const j = served.indexOf(i);
      const neighbor = (direction: number) => {
        for (let k = 1; k <= served.length; k++) {
          const index = j + direction * k;
          if (!cyclic && (index < 0 || index >= served.length)) break;
          const sid = l.stops[served[(index + served.length * 2) % served.length]];
          if (sid !== station) return sid;
        }
        return station;
      };
      let previous = neighbor(-1), next = neighbor(1);
      // A non-loop path's served ends turn towards the same adjacent served station.
      if (previous === station) previous = next;
      if (next === station) next = previous;
      // Out-and-back endpoints, including short turns, arrive from and depart towards the same station.
      out.push({ pattern: p.id, stop: i, station, occurrence, previous, next, turn: previous === next });
    }
  }
  return out;
}

function stock(g: Game, l: Line, pattern: number): { owner: number; rule: TrackRule | null; length: number }[] {
  const first = l.patterns?.[0]?.id ?? 0, known = new Set(l.patterns?.map(p => p.id) ?? [first]);
  const trains = l.vehicles.map(id => g.vehicles.get(id)).filter((v): v is Train => !!v && v.kind === 'train'
    && (v.pattern !== undefined && known.has(v.pattern) ? v.pattern : first) === pattern);
  const seen = new Set<string>();
  return trains.length ? trains.flatMap(t => {
    const rule = consistRule(t.cars), key = JSON.stringify([t.owner, t.length, rule.wire, rule.types && [...rule.types]]);
    if (seen.has(key)) return []; seen.add(key); return [{ owner: t.owner, rule, length: t.length }];
  }) : [{ owner: l.owner, rule: null, length: 0 }];
}

/** A candidate must connect the incoming and outgoing served hops on the same physical platform/direction. */
function candidates(g: Game, l: Line, c: Call): RailTrackGroup[] {
  const st = g.stations.get(c.station), prev = g.stations.get(c.previous), next = g.stations.get(c.next), net = g.world.net;
  if (!st?.rail || !prev?.rail || !next?.rail || prev.id === st.id || next.id === st.id) return [];
  const fleet = stock(g, l, c.pattern).map(s => ({ ...s, incoming: g.stations.railTrackGroups(prev).flatMap(from => {
    const first = from.steps[0], last = from.steps[from.steps.length - 1];
    return [[first.edge, -first.dir], [last.edge, last.dir]].flatMap(([id, dir]) => {
      const e = net.edges.get(id); return e && g.canUse(s.owner, e.owner) && ruleAllows(s.rule, e)
        ? railNext(g, e, dir, s.owner, false, s.rule, true) : [];
    });
  }) }));
  return g.stations.railTrackGroups(st).filter(group => fleet.every(({ owner, rule, length, incoming }) => {
    if (group.length + 1e-6 < length + 0.05 || group.steps.some(s => { const e = net.edges.get(s.edge); return !e || !g.canUse(owner, e.owner) || !ruleAllows(rule, e); })) return false;
    for (const direction of [1, -1] as const) {
      const arrival = direction === 1 ? group.steps[group.steps.length - 1] : group.steps[0];
      const arrivalDir = direction * arrival.dir;
      const ae = net.edges.get(arrival.edge)!;
      const onward = !!findRailRoute(g, railNext(g, ae, arrivalDir, owner, false, rule), next.id, owner, -1, 20000, false, rule, true, { length })
        || c.turn && !!findRailRoute(g, railNext(g, ae, -arrivalDir, owner, false, rule, true), next.id, owner, -1, 20000, false, rule, true, { length });
      if (!onward) continue;
      if (findRailRoute(g, incoming, st.id, owner, -1, 20000, false, rule, true, { group: group.id, direction, length })) return true;
    }
    return false;
  }));
}

/** Pure list for the platform preference control; group identity is independent of its displayed number. */
export function platformChoices(g: Game, l: Line, pattern: number, stop: number): RailTrackGroup[] {
  const c = calls(l).find(c => c.pattern === pattern && c.stop === stop);
  return c ? candidates(g, l, c) : [];
}

/** Pure train/UI lookup: an unknown pattern follows the first service, just like the timetable. */
export function platformPreference(l: Line, pattern: number | undefined, stop: number): RailPlatformCall | undefined {
  const first = l.patterns?.[0]?.id ?? 0, pid = l.patterns?.some(p => p.id === pattern) ? pattern! : first;
  return l.platforms?.find(p => p.pattern === pid && p.stop === stop && p.station === l.stops[stop]);
}

/** Scan the physical rail graph once per explicit reconciliation, independent of the number of lines. */
function topologyEpoch(g: Game): number {
  const net = g.world.net;
  const rails = [...net.edges.values()].filter(e => e.kind === 'rail');
  const owners = [...new Set(rails.map(e => e.owner))];
  const signature = JSON.stringify([rails.map(e => [e.id, e.version, e.owner, e.a, e.b, e.sa, e.sb, e.type, e.station]),
    [...net.nodes.values()].filter(n => n.kind === 'rail').map(n => [n.id, n.signal, n.signalPass, n.signalKind]),
    g.companies.map(c => owners.map(o => g.canUse(c.id, o)))]);
  let cached = topologies.get(g);
  if (!cached || cached.signature !== signature) { cached = { signature, epoch: (cached?.epoch ?? 0) + 1 }; topologies.set(g, cached); }
  return cached.epoch;
}

function signature(g: Game, l: Line, topology: number): string {
  return JSON.stringify([topology, l.stops, l.patterns, l.loop, l.vehicles.map(id => { const t = g.vehicles.get(id); return t?.kind === 'train' ? [t.owner, t.pattern, (t as Train).cars.map(c => c.id)] : null; }),
    l.stops.map(id => { const s = g.stations.get(id); return s && g.stations.railTrackGroups(s).map(q => [q.id, q.back, q.front, q.length]); })]);
}

/** Explicit mutation only. Valid preferences survive stock, route and topology edits; stale ones become Auto. */
export function reconcilePlatforms(g: Game, force = false) {
  const used = new Map<number, { line: number; pattern: number; stop: number }[]>();
  const lines = [...g.lines.map.values()].filter(l => l.kind === 'rail').sort((a, b) => a.id - b.id);
  const topology = topologyEpoch(g);
  // Other routes' existing choices count even if their cached allocation is unchanged this time.
  for (const l of lines) for (const p of l.platforms ?? []) used.set(p.group, [...(used.get(p.group) ?? []), { line: l.id, pattern: p.pattern, stop: p.stop }]);
  for (const l of lines) {
    const sig = signature(g, l, topology);
    if (!force && signatures.get(l) === sig) continue;
    signatures.set(l, sig);
    const previous = l.platforms ?? [], records: RailPlatformCall[] = [];
    // Replace this line's load records exactly once; repeated rebuilds cannot accumulate old/new choices.
    for (const [group, load] of used) used.set(group, load.filter(p => p.line !== l.id));
    for (const c of calls(l)) {
      const options = candidates(g, l, c), old = previous.find(p => p.pattern === c.pattern && p.station === c.station && p.occurrence === c.occurrence)
        // A station merge changes its id while retaining the physical track group.
        ?? previous.find(p => p.pattern === c.pattern && p.stop === c.stop && options.some(q => q.id === p.group));
      const retained = old && options.find(q => q.id === old.group || q.back === old.back && q.front === old.front);
      let choice = retained;
      if (!choice) choice = options.sort((a, b) => {
        const load = (q: RailTrackGroup) => (used.get(q.id) ?? []).reduce((n, p) => n + (p.line !== l.id ? 10 : p.pattern === c.pattern && p.stop === c.stop ? 0 : 1), 0);
        return load(a) - load(b) || a.offset - b.offset || a.id - b.id;
      })[0];
      if (!choice) continue;
      records.push({ pattern: c.pattern, stop: c.stop, station: c.station, occurrence: c.occurrence, group: choice.id,
        back: choice.back, front: choice.front, ...(retained && old?.manual ? { manual: true } : {}) });
      used.set(choice.id, [...(used.get(choice.id) ?? []), { line: l.id, pattern: c.pattern, stop: c.stop }]);
    }
    if (records.length || l.platforms) l.platforms = records;
  }
}

/** Explicit join/merge hook: preserve the old service's physical preferences under its new pattern ids. */
export function inheritPlatformPreferences(target: Line, source: Line, patterns: ReadonlyMap<number, number>) {
  if (!source.platforms?.length) return;
  const targetCalls = calls(target), sourceCalls = calls(source), incoming: RailPlatformCall[] = [];
  for (const p of source.platforms) {
    const pattern = patterns.get(p.pattern), old = sourceCalls.find(c => c.pattern === p.pattern && c.stop === p.stop);
    if (pattern === undefined || !old) continue;
    for (const c of targetCalls.filter(c => c.pattern === pattern && c.station === p.station && (c.previous === old.previous || c.next === old.next))) {
      incoming.push({ ...p, pattern, stop: c.stop, occurrence: c.occurrence });
    }
  }
  const keys = new Set(incoming.map(p => p.pattern + ':' + p.stop));
  target.platforms = [...(target.platforms ?? []).filter(p => !keys.has(p.pattern + ':' + p.stop)), ...incoming];
  signatures.delete(target);
}

/** A manual preference is validated now; a train may still choose a legal free alternative in operation. */
export function setPlatformPreference(g: Game, l: Line, pattern: number, stop: number, group: number | null): string | null {
  if (l.kind !== 'rail') return 'Not a rail line';
  const c = calls(l).find(c => c.pattern === pattern && c.stop === stop);
  if (!c) return 'Service does not stop here';
  if (group !== null && !candidates(g, l, c).some(q => q.id === group)) return 'Platform does not serve this route or train';
  l.platforms = (l.platforms ?? []).filter(p => !(p.pattern === pattern && p.stop === stop));
  if (group !== null) {
    const q = candidates(g, l, c).find(q => q.id === group)!;
    l.platforms.push({ pattern, stop, station: c.station, occurrence: c.occurrence, group, back: q.back, front: q.front, manual: true });
  }
  signatures.delete(l); reconcilePlatforms(g);
  for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged();
  return null;
}
