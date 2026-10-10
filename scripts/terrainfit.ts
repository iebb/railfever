// Terrain fit of the network (UPDATE 9e): on ground sections the terrain must never cover the track or road
// surface (terrain <= surface - 0.02; rail only: roads are draped on the terrain) and never leave it floating
// (terrain >= surface - 0.35). Sampled every 0.5 along every ground section, at the axis, +-hw/2 and +-hw.
import type { Game } from '../src/game/game';
import type { NEdge } from '../src/game/network';

export interface FitReport {
  samples: number;
  /** misfits attributed to station sites (levelled by stations.ts) */
  station: number;
  covered: number;
  floating: number;
  /** misfits within a unit of a tunnel portal or bridge abutment (the portal / abutment structure stands there) */
  portal: number;
  /** counts by cause: kind (rail / street / road) + where (end / structure / mid) + edge (depot / station / ...) */
  causes: Map<string, number>;
  worst: { covered: number; floating: number };
  examples: string[];
}

/** Station sites seen so far (removed stations leave their levelled ground behind): call noteStations daily. */
export type Sites = Map<number, { x: number; z: number; r: number }>;
export function noteStations(g: Game, sites: Sites) { for (const st of g.stations.all()) if (st.rail) sites.set(st.id, { x: st.x, z: st.z, r: st.rail.length / 2 + 4 }); }

export function terrainFit(g: Game, edges?: Iterable<NEdge>, sites?: Sites): FitReport {
  const w = g.world, net = w.net;
  const r: FitReport = { samples: 0, station: 0, covered: 0, floating: 0, portal: 0, causes: new Map(), worst: { covered: 0, floating: 0 }, examples: [] };
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  for (const e of edges ?? net.edges.values()) {
    const hw = net.halfWidth(e);
    const kind = e.kind === 'rail' ? 'rail' : e.type === 'street' ? 'street' : 'road';
    const na = net.nodes.get(e.a), nb = net.nodes.get(e.b);
    const flag = e.depot >= 0 ? 'depot' : e.station >= 0 ? 'station' : (na?.edges.length === 1 || nb?.edges.length === 1) ? 'dead end' : 'plain';
    // (a rail edge ending at a tunnel mouth, the next edge running on in the bore: its portal stands at that end as a
    // portal within an edge does, terraform.ts portalEnd; 2.11, where a second track laid up to the first one's portal
    // keeps the hillside and the streets above it)
    const mouth = (nid: number) => e.kind === 'rail' && (net.nodes.get(nid)?.edges ?? []).some((id) => {
      const q = id === e.id ? undefined : net.edges.get(id);
      return !!q && q.kind === 'rail' && net.sectionAt(q, q.a === nid ? 0 : q.len) === 'tunnel';
    });
    const mouthA = mouth(e.a), mouthB = mouth(e.b);
    for (let s = 0.25; s < e.len - 0.25; s += 0.5) {
      if (net.sectionAt(e, s) !== 'ground') continue;
      net.pointAt(e, s, p, d);
      const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
      const where = s < 1.5 || s > e.len - 1.5 ? 'end' : e.sections.some((q) => s > q.s0 - 2 && s < q.s1 + 2) ? 'structure' : 'mid';
      for (const o of [0, -hw / 2, hw / 2, -hw, hw]) {
        const t = w.heightAt(p.x + nx * o, p.z + nz * o);
        r.samples++;
        const cov = kind === 'rail' && t > p.y - 0.02, flo = t < p.y - 0.35;
        if (!cov && !flo) continue;
        if (e.sections.some((q) => Math.abs(s - q.s0) < 1 || Math.abs(s - q.s1) < 1) || (mouthA && s < 1) || (mouthB && s > e.len - 1)) { r.portal++; continue; }
        const key = `${cov ? 'covered' : 'floating'} ${kind} ${where} ${flag} ${clash(g, e, p.x + nx * o, p.z + nz * o, p.y, sites)}`;
        r.causes.set(key, (r.causes.get(key) ?? 0) + 1);
        if (key.endsWith('by station site')) { r.station++; continue; }
        if (cov) { r.covered++; r.worst.covered = Math.max(r.worst.covered, t - p.y); }
        else { r.floating++; r.worst.floating = Math.max(r.worst.floating, p.y - t); }
        if (r.examples.length < 8) r.examples.push(`${cov ? 'covered' : 'floating'} ${kind} #${e.id} s ${s.toFixed(1)}/${e.len.toFixed(1)} off ${o.toFixed(2)} at ${p.x.toFixed(1)},${p.z.toFixed(1)}: surface ${p.y.toFixed(2)} terrain ${t.toFixed(2)} (${flag}, ${where})`);
      }
    }
  }
  return r;
}

/**
 * What else shapes the terrain at a misfit: another formation within reach at a different height (beside: not
 * joined to this edge), a station or depot site, or nothing (this edge's own earthworks).
 */
function clash(g: Game, e: NEdge, x: number, z: number, y: number, sites?: Sites): string {
  const net = g.world.net;
  if (sites) noteStations(g, sites);
  for (const st of sites ? sites.values() : g.stations.all().filter((q) => q.rail).map((q) => ({ x: q.x, z: q.z, r: q.rail!.length / 2 + 4 }))) if (Math.hypot(st.x - x, st.z - z) < st.r) return 'by station site';
  for (const dp of g.depots.near(x, z, 4)) { void dp; return 'by depot'; }
  let best = '', bd = Infinity;
  for (const q of net.edgesNear(x - 4, z - 4, x + 4, z + 4)) {
    if (q.id === e.id) continue;
    const r = net.nearestEdge(x, z, 4, undefined, (k) => k.id === q.id);
    if (!r || net.sectionAt(q, r.s) !== 'ground') continue;
    const dy = net.heightAtS(q, r.s) - y;
    if (Math.abs(dy) < 0.3 || r.d >= bd) continue;
    const joined = q.a === e.a || q.a === e.b || q.b === e.a || q.b === e.b;
    bd = r.d; best = `${joined ? 'joined' : 'beside'} ${q.kind === 'rail' ? (q.station >= 0 ? 'platform' : q.depot >= 0 ? 'depot track' : 'rail') : q.type} ${dy > 0 ? 'above' : 'below'}`;
  }
  return best || 'own';
}

export function fitLine(r: FitReport): string {
  const top = [...r.causes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v} ${k}`).join('; ');
  return `${r.samples} samples: ${r.station} at station sites; elsewhere ${r.covered} covered (worst ${(r.worst.covered * 10).toFixed(1)} m), ${r.floating} floating (worst ${(r.worst.floating * 10).toFixed(1)} m), ${r.portal} at portals / abutments${top ? ' — ' + top : ''}`;
}
