// Town street network statistics (used by scale.ts and towns.ts): connectivity of each town's streets to its
// centre, dead ends, and how many of the rings of ring (radial) and hill towns are closed.
import type { Game } from '../src/game/game';
import type { Town } from '../src/game/towns';

export interface TownNet {
  town: Town;
  /** the town's street edges, and how many of them are connected to its centre over the road network */
  edges: number; connected: number; pct: number;
  /** street ends (nodes of the town's streets with a single edge) */
  deadEnds: number;
  /** ring and hill towns: ring segments built / planned / failed (terrain) in the inner rings (all but the outermost), closed rings */
  ringSegs?: number; ringBuilt?: number; ringFailed?: number; rings?: number; ringsClosed?: number;
}

/** Road network components (node id -> component). */
export function roadComponents(g: Game): Map<number, number> {
  const net = g.world.net;
  const comp = new Map<number, number>();
  let c = 0;
  for (const n of net.nodes.values()) {
    if (n.kind !== 'road' || comp.has(n.id)) continue;
    const q = [n.id];
    comp.set(n.id, c);
    while (q.length) {
      const id = q.pop()!;
      for (const eid of net.nodes.get(id)!.edges) {
        const e = net.edges.get(eid)!;
        const o = e.a === id ? e.b : e.a;
        if (!comp.has(o)) { comp.set(o, c); q.push(o); }
      }
    }
    c++;
  }
  return comp;
}

export function townNetworks(g: Game): TownNet[] {
  const net = g.world.net, towns = g.towns as any;
  const comp = roadComponents(g);
  const own = new Map<Town, number[]>();
  for (const e of net.edges.values()) {
    if (e.kind !== 'road' || e.type !== 'street' || e.owner !== -1 || e.station >= 0 || e.depot >= 0) continue;
    const geo = net.geo(e), k = Math.floor(geo.n / 2) * 3;
    const T = g.towns.owner(geo.pts[k], geo.pts[k + 2]);
    if (!T) continue;
    let a = own.get(T);
    if (!a) own.set(T, (a = []));
    a.push(e.id);
  }
  return g.towns.list.map((T) => {
    const ids = own.get(T) ?? [];
    // the centre: the node at the centre of the street lattice (ring towns: the nearest one around the square)
    const centre = towns.centreNode ? towns.centreNode(T) : net.nearestNode(T.x, T.z, 30, 'road', (n: { edges: number[] }) => n.edges.length > 0);
    const c0 = centre ? comp.get(typeof centre === 'number' ? centre : centre.id) : undefined;
    let connected = 0;
    const deg = new Map<number, number>();
    for (const id of ids) {
      const e = net.edges.get(id)!;
      if (c0 !== undefined && comp.get(e.a) === c0) connected++;
      for (const n of [e.a, e.b]) deg.set(n, net.nodes.get(n)!.edges.length);
    }
    let deadEnds = 0;
    for (const d of deg.values()) if (d === 1) deadEnds++;
    const r: TownNet = { town: T, edges: ids.length, connected, pct: ids.length ? (100 * connected) / ids.length : 100, deadEnds };
    const gr = T.grid;
    if (gr && (gr.layout === 'radial' || gr.layout === 'hill')) {
      const segs = (k: number): [number, number, number][] => {
        const out: [number, number, number][] = [];
        for (let i = -k; i < k; i++) out.push([i, k, 0], [i, -k, 0]);
        for (let j = -k; j < k; j++) out.push([k, j, 1], [-k, j, 1]);
        return out;
      };
      let K = 0;
      for (let k = 1; k < gr.n; k++) if (segs(k).some(([i, j, d]) => towns.latticeBuilt(gr, i, j, d))) K = k;
      let total = 0, built = 0, failed = 0, closed = 0;
      const key = (i: number, j: number, d: number) => ((i + gr.n) * (2 * gr.n + 1) + (j + gr.n)) * 2 + d;
      for (let k = 1; k < K; k++) {
        const s = segs(k).filter(([i, j, d]) => !(towns.isOmitted(gr, i, j, d)));
        const b = s.filter(([i, j, d]) => towns.latticeBuilt(gr, i, j, d)).length;
        total += s.length; built += b;
        failed += s.filter(([i, j, d]) => gr.failed.includes(key(i, j, d))).length;
        if (b === s.length) closed++;
      }
      Object.assign(r, { ringSegs: total, ringBuilt: built, ringFailed: failed, rings: Math.max(0, K - 1), ringsClosed: closed });
    }
    return r;
  });
}
