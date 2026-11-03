// Passive headless observation only. No simulation policy, counters or provenance are added to saves.
import type { Game } from '../src/game/game';
import type { Station, WaitGroup } from '../src/game/stations';
import { WALK_LINE } from '../src/game/stations';
import type { Vehicle } from '../src/game/vehicle';
import { Train, consistRule, findRailRoute, platformDepartureFrontiers, railNext, ruleAllows } from '../src/game/train';
import { linePatterns, patternStops } from '../src/game/patterns';
import { fareGroupKey, changeClass, railHistory } from '../src/game/fares';
import { serialize, deserialize } from '../src/game/save';

interface Origin { vehicle: number; line: number; owner: number; rail: boolean; station: number }
interface Provenance { origin: Origin | null; count: number; signature: string }
interface Boarding { vehicle: Vehicle; station: Station; groups: { group: WaitGroup; count: number; origin: Origin | null }[]; taken?: { origin: Origin | null; count: number }[] }
interface EdgeUse { edge: number; units: number; owners: Set<number>; lines: Set<number>; trains: Set<number> }
export interface TransferCount { fromOwner: number; toOwner: number; fromLine: number; toLine: number; walked: boolean; sameComplex: boolean; count: number }
const signature = (w: WaitGroup) => JSON.stringify([w.line, w.alight, w.dest, w.rail ?? 0, w.ic ?? 0]);
const sameOrigin = (a: Origin | null, b: Origin | null) => !!a && !!b && a.vehicle === b.vehicle && a.line === b.line && a.owner === b.owner && a.station === b.station;
const installed = new WeakSet<Game>();

/** All hooks call the original once, preserving this, arguments, return and throw. dispose restores descriptors. */
export function observeNetwork(g: Game) {
  if (installed.has(g)) throw Error('Network observer already installed');
  installed.add(g);
  const undo: (() => void)[] = [], attached = new WeakSet<Vehicle>();
  let provenance = new WeakMap<WaitGroup, Provenance>();
  let serving: { vehicle: Vehicle; station: Station } | undefined, moving: Vehicle | undefined;
  const boards: Boarding[] = [];
  const deliveries = new Map<string, number>();
  const edges = new Map<number, EdgeUse>(), calls = new Map<string, number>(), transfers = new Map<string, TransferCount>();
  const movedByTrain = new Map<number, number>(), actualTurns = new Map<string, { node: number; from: number; to: number; owner: number; line: number; count: number }>();
  const lastCalls = new Map<string, number>(), served = new Map<number, Map<number, { owner: number; day: number }>>();
  const lastMovement = new Map<number, { owner: number; day: number }>(), stateSeconds = new Map<number, Record<string, number>>();
  const operatorUnits = new Map<number, number>(), foreignUnits = new Map<number, number>(), trainCalls = new Map<number, number>();
  const counters = { handoffEnqueued: 0, confirmedRailTransfers: 0, confirmedCrossCompanyRailTransfers: 0, unknownBoardings: 0,
    allBoardings: 0, foreignTrainPassages: 0, unattributedRailPassages: 0 };
  function hook(object: object, name: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any) {
    const target = object as Record<string, any>, descriptor = Object.getOwnPropertyDescriptor(object, name), original = target[name];
    if (typeof original !== 'function') throw Error(`Missing native observer method ${name}`);
    const fn = wrap(original);
    Object.defineProperty(object, name, { configurable: true, writable: true, value: fn });
    undo.push(() => { if (target[name] === fn) { if (descriptor) Object.defineProperty(object, name, descriptor); else delete target[name]; } });
  }
  function known(w: WaitGroup): Origin | null {
    const p = provenance.get(w);
    return p && w.count <= p.count && p.signature === signature(w) ? p.origin : null;
  }
  function captureTaken(frame: Boarding) {
    // Native boarding only subtracts counts. Snapshot BEFORE rekeyWaiting can merge/rekey the remaining groups.
    if (!frame.taken) frame.taken = frame.groups.map(({ group, count, origin }) => ({ origin, count: Math.max(0, count - group.count) }));
  }
  function attach(v: Vehicle) {
    if (attached.has(v)) return;
    attached.add(v);
    hook(v, 'update', original => function(this: Vehicle, ...args: any[]) {
      const prior = moving; moving = this;
      if (this.state === 'depot') movedByTrain.delete(this.id);
      try {
        const result = original.apply(this, args);
        if (this.kind === 'train' && typeof args[0] === 'number' && args[0] > 0) {
          const state = this.status === 'Holding for even spacing' ? 'spacing' : this.state;
          const row = stateSeconds.get(this.id) ?? {}; row[state] = (row[state] ?? 0) + args[0]; stateSeconds.set(this.id, row);
        }
        return result;
      } finally { moving = prior; }
    });
    hook(v, 'serveStation', original => function(this: Vehicle, st: Station, ...args: any[]) {
      const prior = serving; serving = { vehicle: this, station: st };
      const before = this.delivered;
      try {
        const result = original.call(this, st, ...args);
        if (this.kind === 'train' && this.delivered > before) {
          const key = `${this.owner}:${this.lineId}`; deliveries.set(key, (deliveries.get(key) ?? 0) + this.delivered - before);
        }
        return result;
      } finally { serving = prior; }
    });
    hook(v, 'boardStation', original => function(this: Vehicle, st: Station, ...args: any[]) {
      const frame: Boarding = { vehicle: this, station: st, groups: [...st.waiting.values()].map(group => ({ group, count: group.count, origin: known(group) })) };
      boards.push(frame);
      try {
        const result = original.call(this, st, ...args);
        captureTaken(frame);
        counters.allBoardings += result;
        for (const { origin, count } of frame.taken!) {
          if (!(count > 0)) continue;
          if (!origin) { counters.unknownBoardings += count; continue; }
          if (!origin.rail || this.kind !== 'train' || origin.vehicle === this.id || origin.line === this.lineId) continue;
          const item: TransferCount = { fromOwner: origin.owner, toOwner: this.owner, fromLine: origin.line, toLine: this.lineId ?? -1,
            walked: origin.station !== st.id, sameComplex: origin.station === st.id || g.stations.isSameStationComplex(origin.station, st.id), count };
          const key = JSON.stringify([item.fromOwner, item.toOwner, item.fromLine, item.toLine, item.walked, item.sameComplex]);
          const old = transfers.get(key); if (old) old.count += count; else transfers.set(key, item);
          counters.confirmedRailTransfers += count;
          if (origin.owner !== this.owner) counters.confirmedCrossCompanyRailTransfers += count;
        }
        return result;
      } finally { boards.pop(); }
    });
  }
  hook(g.vehicles, 'buyTrain', original => function(this: typeof g.vehicles, ...args: any[]) {
    const result = original.apply(this, args); if (result instanceof Train) attach(result); return result;
  });
  hook(g.vehicles, 'buyRoad', original => function(this: typeof g.vehicles, ...args: any[]) {
    const result = original.apply(this, args); if (typeof result !== 'string' && result && typeof result === 'object') attach(result); return result;
  });
  for (const v of g.vehicles.all()) attach(v);
  hook(g, 'recordTrackUse', original => function(this: Game, ...args: Parameters<Game['recordTrackUse']>) {
    const result = original.apply(this, args);
    const [user, e, units, tram = false] = args;
    if (tram || e.kind !== 'rail' || e.depot >= 0 || !(units > 0) || !Number.isFinite(units)) return result;
    const row = edges.get(e.id) ?? { edge: e.id, units: 0, owners: new Set(), lines: new Set(), trains: new Set() };
    row.units += units; row.owners.add(user); edges.set(e.id, row);
    operatorUnits.set(user, (operatorUnits.get(user) ?? 0) + units);
    if (e.owner !== user) foreignUnits.set(user, (foreignUnits.get(user) ?? 0) + units);
    if (moving instanceof Train && moving.owner === user) {
      lastMovement.set(moving.id, { owner: user, day: g.day });
      row.trains.add(moving.id); if (moving.lineId !== null) row.lines.add(moving.lineId);
      if (e.owner !== user) counters.foreignTrainPassages++;
      const old = g.world.net.edges.get(movedByTrain.get(moving.id) ?? -1);
      if (old && old.id !== e.id && old.depot < 0) {
        const node = [old.a, old.b].find(n => n === e.a || n === e.b);
        if (node !== undefined) {
          const key = `${node}:${old.id}:${e.id}:${user}:${moving.lineId}`;
          const turn = actualTurns.get(key); if (turn) turn.count++;
          else actualTurns.set(key, { node, from: old.id, to: e.id, owner: user, line: moving.lineId ?? -1, count: 1 });
        }
      }
      movedByTrain.set(moving.id, e.id);
    } else counters.unattributedRailPassages++;
    return result;
  });
  hook(g, 'recordStop', original => function(this: Game, v: Vehicle, st: Station) {
    const result = original.call(this, v, st);
    if (v.kind === 'train') {
      const key = `${v.owner}:${v.lineId}:${st.id}`; calls.set(key, (calls.get(key) ?? 0) + 1); lastCalls.set(key, g.day);
      const byStation = served.get(v.id) ?? new Map(); byStation.set(st.id, { owner: v.owner, day: g.day }); served.set(v.id, byStation);
      trainCalls.set(v.id, (trainCalls.get(v.id) ?? 0) + 1);
    }
    return result;
  });
  hook(g.stations, 'addWaiting', original => function(this: typeof g.stations, ...args: Parameters<typeof g.stations.addWaiting>) {
    const [st, line, alight, dest, count, , , transferred = 0, rail = 0, ic = 0] = args;
    if (line === WALK_LINE || !(count > 0)) return original.apply(this, args);
    const key = fareGroupKey(line, alight, dest, railHistory(rail), changeClass(Math.max(0, transferred), count), ic);
    const old = st.waiting.get(key), oldCount = old?.count ?? 0, oldOrigin = old ? known(old) : null;
    const result = original.apply(this, args);
    const group = st.waiting.get(key);
    if (group) {
      const v = serving?.vehicle;
      const origin: Origin | null = v && v.lineId !== null ? { vehicle: v.id, line: v.lineId, owner: v.owner, rail: v.kind === 'train', station: serving!.station.id } : null;
      provenance.set(group, { origin: oldCount > 0 && !sameOrigin(oldOrigin, origin) ? null : origin, count: group.count, signature: signature(group) });
      if (origin) counters.handoffEnqueued += count;
    }
    return result;
  });
  hook(g.stations, 'rekeyWaiting', original => function(this: typeof g.stations, st: Station, ...args: any[]) {
    for (const frame of boards) if (frame.station === st) captureTaken(frame);
    const priorMap = provenance, unchanged = new Map<WaitGroup, Provenance>();
    for (const w of st.waiting.values()) {
      const origin = known(w);
      // Snapshot the CURRENT count, not the older provenance ceiling: a partially boarded12→8
      // group must not regain its old identity if native rekey then merges2unknown riders into it.
      if (origin) unchanged.set(w, { origin, count: w.count, signature: signature(w) });
      provenance.delete(w);
    }
    let completed = false;
    try {
      const result = original.call(this, st, ...args);
      completed = true;
      return result;
    } finally {
      for (const w of st.waiting.values()) {
        provenance.delete(w);
        const before = unchanged.get(w);
        // Native rekey merges only upwards; a surviving object with equal count/signature was
        // neither merged nor rerouted. A line rebuild or incomplete/throwing rekey stays unknown.
        if (completed && provenance === priorMap && before && w.count === before.count && signature(w) === before.signature)
          provenance.set(w, before);
      }
    }
  });
  hook(g.lines, 'rebuild', original => function(this: typeof g.lines, ...args: any[]) {
    provenance = new WeakMap(); // Routing/line changes never inherit guessed queue provenance.
    return original.apply(this, args);
  });
  return {
    counters, edges, calls, trainCalls, transfers, actualTurns, lastCalls, served, lastMovement, stateSeconds, deliveries,
    summary() {
      return { ...counters, operatorKm: [...operatorUnits].map(([owner, units]) => ({ owner, km: units / 100, foreignKm: (foreignUnits.get(owner) ?? 0) / 100 })),
        deliveredRailPassengers: [...deliveries], calls: [...calls], lastCalls: [...lastCalls], sampledTrainStateSeconds: [...stateSeconds], transfers: [...transfers.values()], actualTurns: [...actualTurns.values()],
        edges: [...edges.values()].map(e => ({ ...e, owners: [...e.owners], lines: [...e.lines], trains: [...e.trains] })) };
    },
    dispose() { for (const restore of undo.reverse()) restore(); installed.delete(g); },
  };
}
export type NetworkObserver = ReturnType<typeof observeNetwork>;

/** Current raw topology plus OBSERVED service/use. No routing/allocation/catchment maintenance is invoked. */
export function networkSnapshot(g: Game, observed?: NetworkObserver) {
  const net = g.world.net, parent = new Map<number, number>();
  const find = (x: number): number => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const e of net.edges.values()) if (e.kind === 'rail') parent.set(find(e.a), find(e.b));
  const components = new Map<number, { nodes: Set<number>; edges: number[]; owners: Set<number>; km: number }>();
  for (const e of net.edges.values()) if (e.kind === 'rail') {
    const id = find(e.a), c = components.get(id) ?? { nodes: new Set(), edges: [], owners: new Set(), km: 0 };
    c.nodes.add(e.a); c.nodes.add(e.b); c.edges.push(e.id); c.owners.add(e.owner); c.km += e.len / 100; components.set(id, c);
  }
  const sidings = new Set<number>();
  for (const e of net.edges.values()) if (e.kind === 'rail' && e.depot >= 0) {
    let edge = e, from = net.nodes.get(e.a)?.edges.length === 1 ? e.a : e.b;
    const seen = new Set<number>();
    while (!seen.has(edge.id)) {
      seen.add(edge.id); sidings.add(edge.id);
      const node = net.nodes.get(edge.a === from ? edge.b : edge.a); if (!node || node.edges.length !== 2) break;
      const next = net.edges.get(node.edges.find(id => id !== edge.id)!);
      if (!next || next.kind !== 'rail' || next.station >= 0) break;
      from = node.id; edge = next;
    }
  }
  const used = (id: number) => (observed?.edges.get(id)?.units ?? 0) > 0 && !sidings.has(id);
  const turnsByNode = new Map<number, { node: number; from: number; to: number; owner: number; line: number; count: number }[]>();
  for (const turn of observed?.actualTurns.values() ?? []) { const a = turnsByNode.get(turn.node) ?? []; a.push(turn); turnsByNode.set(turn.node, a); }
  const joins = [...net.nodes.values()].flatMap(n => {
    const arms = n.edges.filter(id => net.edges.get(id)?.kind === 'rail' && used(id));
    if (arms.length < 2) return [];
    const owners = new Set(arms.map(id => net.edges.get(id)!.owner));
    const turns = (turnsByNode.get(n.id) ?? []).filter(t => arms.includes(t.from) && arms.includes(t.to));
    if (!turns.length || arms.length < 3 && owners.size < 2) return [];
    const lineFlows = arms.map(id => [...(observed?.edges.get(id)?.lines ?? [])].sort((a, b) => a - b));
    const operatorFlows = arms.map(id => [...(observed?.edges.get(id)?.owners ?? [])].sort((a, b) => a - b));
    return [{ node: n.id, arms, infrastructureOwners: [...owners], kind: arms.length >= 3 ? 'junction' : 'ownership-seam', observedTurns: turns,
      stationAttached: arms.some(id => net.edges.get(id)!.station >= 0),
      differentServiceFlows: new Set(lineFlows.flat()).size >= 2 && new Set(lineFlows.map(a => a.join(','))).size >= 2,
      differentOperatorFlows: new Set(operatorFlows.flat()).size >= 2 && new Set(operatorFlows.map(a => a.join(','))).size >= 2 }];
  });
  const rails = g.lines.all().filter(l => l.kind === 'rail' && l.vehicles.some(id => g.vehicles.get(id)?.kind === 'train'));
  // Eligibility uses current stock that moved and called two stations under its current owner in the last year.
  // This is observed service connectivity, not a claim that every current pattern is legally routable.
  const operating = (v: Vehicle) => { const move = observed?.lastMovement.get(v.id); return move?.owner === v.owner && move.day >= g.day - 360
    && [...(observed?.served.get(v.id)?.values() ?? [])].filter(s => s.owner === v.owner && s.day >= g.day - 360).length >= 2; };
  const operatingLines = rails.filter(l => {
    const operators = new Set(l.vehicles.map(id => g.vehicles.get(id)).filter(v => v?.kind === 'train' && operating(v)).map(v => v!.owner));
    const called = new Set<number>();
    for (const [key, day] of observed?.lastCalls ?? []) { const [owner, line, station] = key.split(':').map(Number);
      if (line === l.id && day >= g.day - 360 && operators.has(owner) && l.stops.includes(station)) called.add(station); }
    return called.size >= 2;
  });
  const serviceComponents = (walking: boolean) => {
    const roots = new Map(operatingLines.map(l => [l.id, l.id])), stations = new Map<number, number>();
    const root = (id: number): number => { while (roots.get(id) !== id) id = roots.get(id)!; return id; };
    const owners = new Map<number, Set<number>>();
    for (const l of operatingLines) {
      const actualOwners = new Set(l.vehicles.map(id => g.vehicles.get(id)).filter(v => v?.kind === 'train' && operating(v)).map(v => v!.owner));
      const lineOwners = new Set<number>(); owners.set(l.id, lineOwners);
      for (const [key, day] of observed?.lastCalls ?? []) {
        const [owner, line, station] = key.split(':').map(Number);
        if (line !== l.id || day < g.day - 360 || !actualOwners.has(owner) || !l.stops.includes(station) || !g.stations.get(station)?.rail) continue;
        lineOwners.add(owner);
        const at = walking ? Math.min(...g.stations.complex(station)) : station;
        const other = stations.get(at);
        if (other === undefined) stations.set(at, l.id); else roots.set(root(l.id), root(other));
      }
    }
    const groups = new Map<number, { lines: number[]; operators: Set<number> }>();
    for (const l of operatingLines) { const id = root(l.id), row = groups.get(id) ?? { lines: [], operators: new Set<number>() };
      row.lines.push(l.id); for (const owner of owners.get(l.id)!) row.operators.add(owner); groups.set(id, row); }
    const components = [...groups.values()].map(row => ({ lines: row.lines, operators: [...row.operators] }));
    return { operatingLines: operatingLines.map(l => l.id), components,
      largestFraction: operatingLines.length ? Math.max(...components.map(c => c.lines.length)) / operatingLines.length : 0,
      isolatedOperatingLines: components.filter(c => c.lines.length === 1).flatMap(c => c.lines) };
  };
  const sharing = (complex: boolean, actual = false) => {
    const groups = new Map<number, { parts: Set<number>; lines: Set<number>; owners: Set<number> }>();
    for (const l of rails) for (const id of new Set(l.stops)) {
      const operators = actual ? [...(observed?.lastCalls ?? [])].filter(([key, day]) => { const [owner, line, station] = key.split(':').map(Number); return line === l.id && station === id && day >= g.day - 360 && owner >= 0; }).map(([key]) => Number(key.split(':')[0]))
        : l.vehicles.map(i => g.vehicles.get(i)).filter(v => v?.kind === 'train').map(v => v!.owner);
      if (!operators.length) continue;
      const key = complex ? Math.min(...g.stations.complex(id)) : id;
      const row = groups.get(key) ?? { parts: new Set(), lines: new Set(), owners: new Set() };
      row.parts.add(id); row.lines.add(l.id);
      for (const owner of operators) row.owners.add(owner);
      groups.set(key, row);
    }
    return [...groups].filter(([, v]) => v.lines.size > 1 || v.owners.size > 1).map(([id, v]) => ({ id, parts: [...v.parts], lines: [...v.lines], operators: [...v.owners] }));
  };
  return { day: g.day, companies: g.companies.filter(c => c.ai).map(c => {
    const stock = g.vehicles.all().filter(v => v.kind === 'train' && v.owner === c.id);
    const own = new Map<number, number>();
    const ownFind = (x: number): number => { if (!own.has(x)) own.set(x, x); while (own.get(x) !== x) x = own.get(x)!; return x; };
    for (const e of net.edges.values()) if (e.kind === 'rail' && e.owner === c.id) own.set(ownFind(e.a), ownFind(e.b));
    return { owner: c.id, defunct: c.defunct, boughtBy: c.boughtBy, trains: stock.length, stockedRailLines: [...new Set(stock.map(v => v.lineId))],
      everCalledTrains: stock.filter(v => (observed?.trainCalls.get(v.id) ?? 0) > 0).map(v => v.id),
      operatingTrains: stock.filter(operating).map(v => v.id),
      ownedRailComponents: new Set([...own.keys()].map(ownFind)).size,
      calls: [...(observed?.calls ?? [])].filter(([key]) => Number(key.split(':')[0]) === c.id).reduce((n, [, count]) => n + count, 0),
      deliveredLifetimeCurrentStock: stock.reduce((n, v) => n + v.delivered, 0),
      deliveredObserved: [...(observed?.deliveries ?? [])].filter(([key]) => Number(key.split(':')[0]) === c.id).reduce((sum, [, n]) => sum + n, 0), componentsContainingOwnedRail: new Set([...net.edges.values()].filter(e => e.kind === 'rail' && e.owner === c.id).map(e => find(e.a))).size };
  }), physicalComponents: [...components].map(([id, c]) => ({ id, edges: c.edges, owners: [...c.owners], km: c.km })),
    railServiceByPhysicalStation: serviceComponents(false), railServiceByPublicComplex: serviceComponents(true),
    sharedPhysicalStations: sharing(false), sharedPublicComplexes: sharing(true), observedSharedPhysicalStations: sharing(false, true), observedSharedPublicComplexes: sharing(true, true), observedUsedJoins: joins,
    observedServiceFlowJoins: joins.filter(j => j.kind === 'junction' && j.differentServiceFlows),
    observedSharedEdges: [...(observed?.edges.values() ?? [])].filter(e => e.owners.size > 1 && used(e.edge)).map(e => e.edge),
    observedSharedRunningEdges: [...(observed?.edges.values() ?? [])].filter(e => e.owners.size > 1 && used(e.edge) && net.edges.get(e.edge)?.station === -1).map(e => e.edge) };
}

/** Legal-route inspection is ALWAYS on an independent JSON-detached world. Never primes the live simulation. */
export function inspectDetachedRoutes(fullSave: string, maxCalls = 2048) {
  const g = deserialize(JSON.parse(fullSave)), before = JSON.stringify(serialize(g)), net = g.world.net;
  const calls: { line: number; pattern: number; owner: number; from: number; to: number; length: number; ok: boolean; edges: number[] }[] = [];
  const seen = new Set<string>(); let omitted = 0;
  for (const l of g.lines.all()) if (l.kind === 'rail') for (const v of l.vehicles.map(id => g.vehicles.get(id))) {
    if (!(v instanceof Train)) continue;
    const patterns = linePatterns(l), pattern = patterns.find(p => p.id === v.pattern) ?? patterns[0];
    const key = JSON.stringify([l.id, pattern.id, v.owner, v.cars.map(c => c.id), v.length]); if (seen.has(key)) continue; seen.add(key);
    // Use the same <2-distinct-stop fallback as native vehicles; consecutive duplicate calls are skipped.
    const served: number[] = [];
    for (const index of patternStops(l, pattern.id)) if (served[served.length - 1] !== l.stops[index]) served.push(l.stops[index]);
    if (served.length > 1 && served[0] === served[served.length - 1]) served.pop();
    for (let i = 0; i < served.length; i++) {
      const from = g.stations.get(served[i]), to = g.stations.get(served[(i + 1) % served.length]);
      if (!from?.rail || !to?.rail || from.id === to.id) continue;
      if (calls.length >= maxCalls) { omitted++; continue; }
      const rule = consistRule(v.cars); let best: ReturnType<typeof findRailRoute> = null;
      for (const group of g.stations.railTrackGroups(from)) {
        if (group.length + 1e-6 < v.length + 0.05 || group.steps.some(s => { const e = net.edges.get(s.edge); return !e || !g.canUse(v.owner, e.owner) || !ruleAllows(rule, e); })) continue;
        for (const direction of [1, -1]) {
          const ordered = direction === 1 ? group.steps : [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }));
          const frontiers = platformDepartureFrontiers(g, ordered, v.owner, rule, v.length);
          const route = findRailRoute(g, frontiers.forward, to.id, v.owner, -1, 20000, false, rule, true,
            { length: v.length, onward: served[(i + 2) % served.length] });
          if (route && (!best || route.cost < best.cost)) best = route;
        }
      }
      calls.push({ line: l.id, pattern: pattern.id, owner: v.owner, from: from.id, to: to.id, length: v.length, ok: !!best, edges: best?.conts.map(c => c.edge.id) ?? [] });
    }
  }
  return { calls, omitted, inspectionChangedSave: JSON.stringify(serialize(g)) !== before };
}
