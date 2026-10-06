// Geometry-preserving level changes on retained rail. All edits remain in the native
// relevel quotation; these helpers only copy geometry and gather/validate its scope.
import type { Game } from './game';
import type { RelevelPlan } from './trackops';
import type { RailStationAlignment } from './station-geometry';
import type { Crossing } from './network';
import { PSTEP, RAIL, TRACK_TYPES } from './constants';
import { crossingSegments } from './construction';
import { segIntersect } from './geom';

/** Keep XY, unequal arc lengths and reference knots; platforms move to one flat level. */
export function alignmentAtLevel(alignment: RailStationAlignment, y: number): RailStationAlignment {
  return { tracks: alignment.tracks.map(t => ({ ...t, knots: t.knots.map(k => ({ ...k })),
    pieces: t.pieces.map(p => ({ ...p, curve: { ...p.curve }, profile: p.profile.map(() => y) })) })) };
}

/** Include enough plain approach rail at every physical platform/through end. Whole
 * native edges are quoted, with their original ownership and outer boundary heights.
 * Junctions and other facilities require an explicitly selected connecting stretch. */
export function gatherRelevelApproaches(g: Game, scope: Set<number>, stationY: Map<number, number>, payer: number): string | null {
  const net = g.world.net;
  for (const [sid, y] of stationY) {
    const st = g.stations.get(sid)!;
    for (const t of g.stations.trackEnds(st, true)) for (const start of [t.back, t.front]) {
      const first = net.nodes.get(start);
      if (!first) return `${st.name}: station track changed`;
      // Include the plain continuation touching the actual curved strip even for a
      // ground refit; its end otherwise collides with the station's clearance preview.
      const rise = Math.max(.025, Math.abs(y - first.y));
      const own = new Set([...st.rail!.edges, ...st.rail!.throughEdges]);
      let node = start, previous = -1, length = 0, grade = Infinity;
      const seen = new Set<number>();
      for (let step = 0; step < 64; step++) {
        const n = net.nodes.get(node);
        if (!n) return `${st.name}: approach changed`;
        const next = n.edges.filter(id => id !== previous && !own.has(id));
        // A free end can move with the station. At a branching throat, every arm must
        // already be in the user's stretch; the native profile solver validates it.
        if (!next.length) break;
        if (next.length !== 1) {
          if (next.every(id => scope.has(id))) break;
          return `${st.name}: include all connecting tracks for approach ramps`;
        }
        const e = net.edges.get(next[0]);
        if (!e || seen.has(e.id)) return `${st.name}: invalid approach`;
        if (e.kind !== 'rail' || e.depot >= 0 || e.station >= 0 || g.stations.throughStationOf(e.id) >= 0) {
          if (scope.has(e.id)) break;
          return `${st.name}: choose a longer plain approach before the next facility`;
        }
        const denied = g.trackUpgradeError(payer, e.owner);
        if (denied) return denied;
        grade = Math.min(grade, (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).maxGrade * .92);
        scope.add(e.id); seen.add(e.id); length += e.len;
        node = e.a === node ? e.b : e.a; previous = e.id;
        if (length >= rise / grade + 2 * PSTEP) break;
        if (step === 63) return `${st.name}: approach ramps exceed the selected stretch`;
      }
    }
  }
  return null;
}

/** Fixed outside profiles cannot be overwritten by a station's new platform height. */
export function relevelBoundaryError(g: Game, plan: RelevelPlan): string | null {
  const net = g.world.net, profiles = new Map(plan.edges.map(e => [e.id, e.prof]));
  const heights = new Map(plan.nodes.map(n => [n.id, n.y]));
  for (const [id, y] of heights) {
    const node = net.nodes.get(id);
    if (!node || !Number.isFinite(y)) return 'The track changed, plan again';
    for (const eid of node.edges) {
      const e = net.edges.get(eid);
      if (!e) return 'The track changed, plan again';
      const p = profiles.get(eid) ?? e.prof, end = e.a === id ? 0 : p.length - 1;
      if (!p.length || !Number.isFinite(p[end]) || Math.abs(y - p[end]) > .025)
        return 'Approach ramps missing: choose a longer connecting stretch';
    }
  }
  return null;
}

/** Check the actual unchanged XY curves against all intersecting rail/roads, including
 * old overpasses which have no at-grade crossing record. Coordinated diamonds remain
 * reserved diamonds; only crossings that become separated are removed. */
export function relevelCrossingError(g: Game, plan: RelevelPlan): string | null {
  const net = g.world.net, profiles = new Map(plan.edges.map(e => [e.id, e.prof])), removed = new Set<number>();
  const crossingKey = (a: number, b: number) => Math.min(a, b) + ':' + Math.max(a, b);
  const crossings = new Map<string, Crossing[]>();
  for (const c of net.crossings.values()) {
    const key = crossingKey(c.e1, c.e2), list = crossings.get(key) ?? [];
    list.push(c); crossings.set(key, list);
  }
  const at = (id: number, s: number) => {
    const e = net.edges.get(id)!, p = profiles.get(id);
    if (!p) return net.heightAtS(e, s);
    const f = Math.max(0, Math.min(e.len, s)) / PSTEP, i = Math.min(p.length - 1, Math.floor(f)), j = Math.min(p.length - 1, i + 1);
    return p[i] + (p[j] - p[i]) * (f - i);
  };
  for (const pe of plan.edges) {
    const e = net.edges.get(pe.id)!, geo = net.geo(e);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < geo.n; i++) { x0 = Math.min(x0, geo.pts[i * 3]); x1 = Math.max(x1, geo.pts[i * 3]); z0 = Math.min(z0, geo.pts[i * 3 + 2]); z1 = Math.max(z1, geo.pts[i * 3 + 2]); }
    for (const other of net.edgesNear(x0, z0, x1, z1)) {
      if (other.id === e.id || profiles.has(other.id) && other.id < e.id) continue;
      const og = net.geo(other), joins = [e.a, e.b].filter(id => id === other.a || id === other.b).map(id => net.nodes.get(id)!);
      for (let i = 0; i < geo.n - 1; i++) {
        const ax = geo.pts[i * 3], az = geo.pts[i * 3 + 2], bx = geo.pts[i * 3 + 3], bz = geo.pts[i * 3 + 5];
        const candidates = crossingSegments(og, ax, az, bx, bz);
        for (let k = 0, count = candidates?.length ?? og.n - 1; k < count; k++) {
          const j = candidates ? candidates[k] : k;
          const hit = segIntersect(ax, az, bx, bz, og.pts[j * 3], og.pts[j * 3 + 2], og.pts[j * 3 + 3], og.pts[j * 3 + 5]);
          if (!hit) continue;
          const x = ax + (bx - ax) * hit[0], z = az + (bz - az) * hit[0];
          if (joins.some(n => Math.hypot(n.x - x, n.z - z) < .05)) continue;
          const s = geo.cum[i] + (geo.cum[i + 1] - geo.cum[i]) * hit[0], os = og.cum[j] + (og.cum[j + 1] - og.cum[j]) * hit[1];
          const gap = at(e.id, s) - at(other.id, os);
          const known = crossings.get(crossingKey(e.id, other.id))?.find(c => Math.hypot(c.x - x, c.z - z) < .25);
          if (Math.abs(gap) >= RAIL.clearance + .3) { if (known) removed.add(known.id); continue; }
          const oldGap = net.heightAtS(e, s) - net.heightAtS(other, os);
          if (known && Math.abs(gap - oldGap) < .025) continue;
          return `${other.kind === 'road' ? 'A road' : 'Another track'} crosses at the new height near ${Math.round(x)},${Math.round(z)}: choose longer stretch`;
        }
      }
    }
  }
  plan.crossings = [...removed];
  return null;
}
