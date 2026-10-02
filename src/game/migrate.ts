// Upgrades for saves made before operating costs and electric track rules (v2.4).
import type { Game } from './game';
import { consistRule, findRailRoute, railNext, ruleAllows } from './train';
import type { Cont, TrackRule } from './train';
import type { RailPart } from './stations';

/** Preserve old electric trains' routes by adding wire for free, without changing unrelated track. */
export function migrateElectricTrains(g: Game): void {
  const net = g.world.net;
  const byCompany = new Map<number, Set<number>>();
  const lineRoutes = new Map<string, Set<number>>();
  const stationTracks = new Map<number, RailPart>();
  for (const st of g.stations.map.values()) if (st.rail) {
    for (const id of [...st.rail.edges, ...(st.rail.throughEdges ?? [])]) stationTracks.set(id, st.rail);
  }
  for (const t of g.vehicles.trains()) {
    const rule = consistRule(t.cars);
    if (!rule.wire) continue;
    const legacyRule: TrackRule = { ...rule, wire: false };
    const edges = new Set<number>();
    const route = (start: Cont[], target: number, into = edges): boolean => {
      if (!start.length) return false;
      const r = findRailRoute(g, start, target, t.owner, t.id, 60000, false, legacyRule);
      if (!r) return false;
      for (const c of r.conts) into.add(c.edge.id);
      return true;
    };
    // Include the occupied path and the already planned path, even if the train has no line now.
    for (const s of [...t.segs, ...t.pending]) if (s.e >= 0) edges.add(s.e);
    const l = t.line;
    if (l) {
      const key = `${l.id}:${t.owner}:${[...(rule.types ?? [])].sort().join(',')}`;
      let used = lineRoutes.get(key);
      if (!used) {
        used = new Set<number>();
        for (let i = 0; i < l.stops.length; i++) {
          const st = g.stations.get(l.stops[i]);
          const target = l.stops[(i + 1) % l.stops.length];
          for (const id of st?.rail?.edges ?? []) {
            const e = net.edges.get(id);
            if (!e || !ruleAllows(legacyRule, e) || !g.canUse(t.owner, e.owner)) continue;
            used.add(id);
            if (target === st!.id) continue;
            // Both platform exits matter: a terminus reverses past its departure signal.
            for (const dir of [1, -1]) route(railNext(g, e, dir, t.owner, false, legacyRule, true), target, used);
          }
        }
        lineRoutes.set(key, used);
      }
      for (const id of used) edges.add(id);
      // A train can be on a siding, or mid-route when the save was taken. Wire its way back to the line.
      const target = l.stops[t.stopIndex % Math.max(1, l.stops.length)];
      if (target !== undefined) {
        for (const [s, reverse] of [[t.segs[t.segs.length - 1], false], [t.segs[0], true]] as const) {
          const e = s ? net.edges.get(s.e) : undefined;
          if (e) route(railNext(g, e, reverse ? -s!.dir : s!.dir, t.owner, false, legacyRule, e.station >= 0), target);
        }
      }
    }
    const dp = g.depots.get(t.depotId);
    const stub = dp ? net.edges.get(dp.edge) : undefined;
    if (stub) {
      edges.add(stub.id);
      // The stub may have an approach siding before joining the station-to-station routes.
      for (const target of l?.stops ?? []) if (route([{ edge: stub, dir: 1 }], target)) break;
    }
    // Re-planning can choose another platform or through track. Wire the whole affected station, including
    // stations passed without a stop, so its stored track type can also preserve wire through future rebuilds.
    for (const id of [...edges]) {
      const r = stationTracks.get(id);
      if (!r || (r.trackType ?? 'standard') !== 'standard') continue;
      for (const eid of [...r.edges, ...(r.throughEdges ?? [])]) {
        const e = net.edges.get(eid);
        if (e && ruleAllows(legacyRule, e) && g.canUse(t.owner, e.owner)) edges.add(eid);
      }
    }
    const companyEdges = byCompany.get(t.owner) ?? new Set<number>();
    for (const id of edges) {
      const e = net.edges.get(id);
      if (e?.kind === 'rail' && e.type === 'standard') companyEdges.add(id);
    }
    if (companyEdges.size) byCompany.set(t.owner, companyEdges);
  }
  // Collect first, then change track: companies sharing a route each receive one upgrade notice.
  const changed = new Set<number>();
  const stations = new Set<RailPart>();
  for (const [owner, edges] of byCompany) {
    for (const id of edges) {
      if (changed.has(id)) continue;
      const e = net.edges.get(id)!;
      e.type = 'electric';
      net.touchEdge(e);
      changed.add(id);
      const r = stationTracks.get(id);
      if (r) stations.add(r);
    }
    g.postNews(`${g.company(owner).name}: Lines used by electric trains were electrified when this save was upgraded`, 'info');
  }
  // Station rebuilds use the stored track type, not the old edges. Do not relabel partially wired stations.
  for (const r of stations) {
    if ((r.trackType ?? 'standard') === 'standard' && r.edges.length
      && [...r.edges, ...(r.throughEdges ?? [])].every((id) => net.edges.get(id)?.type === 'electric')) r.trackType = 'electric';
  }
  if (changed.size) g.onNetworkChanged();
}
