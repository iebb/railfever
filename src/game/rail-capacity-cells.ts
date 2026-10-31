// Closed terminal cells need an empty receiving platform: their running paths have no holding boundary.
import type { Game } from './game';
import type { VehicleModel } from './vehicle-types';
import { consistRule, platformDepartureFrontiers, railNext, ruleAllows } from './train';
import { capacityTopologyKey } from './rail-capacity-routes';

export interface AtomicTerminalCell { key: string; slots: number[] }

/** Strict receiving-space feasibility, including unions of overlapping restricted platform sets.
 * One extra copy of each active class must fit: this is Hall's condition with a spare for every class. */
export function blockedTerminalCells(cells: { slots: number[]; count: number }[]): Set<number> {
  const blocked = new Set<number>();
  for (let extra = 0; extra < cells.length; extra++) {
    if (!cells[extra].count) continue;
    const copies = cells.flatMap((c, i) => Array.from({ length: c.count }, () => i)); copies.push(extra);
    const held = new Map<number, number>();
    for (let train = 0; train < copies.length; train++) {
      const seen = new Set<number>(), slots = new Set<number>();
      const place = (copy: number): boolean => {
        if (seen.has(copy)) return false;
        seen.add(copy);
        for (const slot of cells[copies[copy]].slots) {
          if (slots.has(slot)) continue;
          slots.add(slot);
          const prior = held.get(slot);
          if (prior === undefined || place(prior)) { held.set(slot, copy); return true; }
        }
        return false;
      };
      if (!place(train)) { for (const copy of seen) blocked.add(copies[copy]); break; }
    }
  }
  return blocked;
}

const memo = new WeakMap<Game, { topology: string; cells: Map<string, AtomicTerminalCell | null> }>();
const state = (edge: number, dir: number) => edge * 2 + +(dir > 0);

/** Recognize only complete, two-terminal atomic paths. Any lawful intermediate holding/escape path
 * makes this test inapplicable; ordinary resource pricing still handles those larger networks. */
export function atomicTerminalCell(g: Game, stations: number[], owner: number, cars: VehicleModel[]): AtomicTerminalCell | null {
  const pair = [...new Set(stations)].sort((a, b) => a - b);
  if (pair.length !== 2) return null;
  const net = g.world.net, topology = `${capacityTopologyKey(g)}:${net.version}:` + JSON.stringify(
    [...net.nodes.values()].filter(n => n.kind === 'rail' && n.signal).map(n => [n.id, n.signal, !!n.signalPass]));
  let cache = memo.get(g);
  if (!cache || cache.topology !== topology) { cache = { topology, cells: new Map() }; memo.set(g, cache); }
  // Match Train.length, including its 0.1-unit clearance between the represented vehicles.
  const rule = consistRule(cars), length = cars.reduce((n, c) => n + c.length + .1, 0);
  const key = JSON.stringify([pair, owner, length, rule.wire, rule.types && [...rule.types].sort()]);
  if (cache.cells.has(key)) return cache.cells.get(key)!;
  const calculate = (): AtomicTerminalCell | null => {
    const groups = pair.map(sid => {
      const st = g.stations.get(sid);
      return st?.rail ? g.stations.railTrackGroups(st).filter(p => p.length + 1e-6 >= length + .05
        && p.steps.every(s => { const e = net.edges.get(s.edge); return e && g.canUse(owner, e.owner) && ruleAllows(rule, e); })) : [];
    });
    if (groups.some(p => !p.length)) return null;
    const graph = new Map<number, number[]>();
    for (const e of net.edges.values()) {
      if (e.kind !== 'rail' || e.depot >= 0 || !g.canUse(owner, e.owner) || !ruleAllows(rule, e)) continue;
      for (const dir of [1, -1]) graph.set(state(e.id, dir), railNext(g, e, dir, owner, false, rule).map(c => state(c.edge.id, c.dir)));
    }
    const hop = (from: number, to: number) => {
      const ends = new Map<number, number>(), entry = new Map<number, { remaining: number; previous?: number; group: number }>();
      for (const p of groups[to]) for (const dir of [1, -1]) {
        const ordered = dir > 0 ? p.steps : [...p.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }));
        let remaining = p.length;
        ordered.forEach((s, i) => {
          entry.set(state(s.edge, s.dir), { remaining, group: p.id, ...(i ? { previous: state(ordered[i - 1].edge, ordered[i - 1].dir) } : {}) });
          remaining -= net.edges.get(s.edge)!.len;
        });
        const last = ordered[ordered.length - 1]; ends.set(state(last.edge, last.dir), p.id);
      }
      const forward = new Map<number, number[]>(), reverse = new Map<number, number[]>();
      for (const [at, next] of graph) {
        const allowed = ends.has(at) ? [] : next.filter(n => {
          const p = entry.get(n); return !p || p.previous === at || p.remaining + 1e-6 >= length + .05;
        });
        forward.set(at, allowed);
        for (const n of allowed) { const back = reverse.get(n) ?? []; back.push(at); reverse.set(n, back); }
      }
      // Only paths which can actually reach the other terminal belong to this cell. A branch to
      // another terminus cannot manufacture headroom for a short turn which cannot reverse there.
      const reaches = new Set(ends.keys()), back = [...reaches];
      while (back.length) for (const n of reverse.get(back.pop()!) ?? []) if (!reaches.has(n)) { reaches.add(n); back.push(n); }
      const depart = new Set<number>(), arrive = new Set<number>(), seen = new Set<number>(), queue: number[] = [];
      for (const p of groups[from]) for (const dir of [1, -1]) {
        const ordered = dir > 0 ? p.steps : [...p.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }));
        const front = platformDepartureFrontiers(g, ordered, owner, rule, length);
        for (const c of [...front.forward, ...front.reverse]) {
          const k = state(c.edge.id, c.dir);
          if (!reaches.has(k)) continue;
          depart.add(p.id); if (!seen.has(k)) { seen.add(k); queue.push(k); }
        }
      }
      while (queue.length) {
        const at = queue.pop()!, e = net.edges.get(Math.floor(at / 2))!;
        if (e.station >= 0 && !pair.includes(e.station)) return null;
        if (ends.has(at)) arrive.add(ends.get(at)!);
        for (const next of forward.get(at) ?? []) {
          if (!reaches.has(next)) continue;
          const nEdge = net.edges.get(Math.floor(next / 2))!, node = net.nodes.get(next % 2 ? nEdge.a : nEdge.b)!;
          // Match Train.extensionEnd: internal fragments of a complete destination platform are
          // acquired together. A facing boundary anywhere else provides another holding place.
          const a = entry.get(at), b = entry.get(next);
          if (node.signal && net.signalFor(node, net.sideAt(nEdge, node.id)) > 0 && !(a && b && a.group === b.group)) return null;
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      return { depart, arrive };
    };
    const ab = hop(0, 1), ba = hop(1, 0);
    if (!ab || !ba) return null;
    const slots = [...ab.depart].filter(id => ba.arrive.has(id)).concat([...ba.depart].filter(id => ab.arrive.has(id))).sort((a, b) => a - b);
    return slots.length >= 2 ? { key: pair.join(':'), slots } : null;
  };
  const value = calculate(); cache.cells.set(key, value); return value;
}
