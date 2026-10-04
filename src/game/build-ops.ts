// Depots, signals, demolition and terraforming.
import type { Game } from './game';
import { railRemovalCost } from './rail-structures';
import { NetKind, RAIL, TRAM, ROAD_TYPES, ELECTRIFY } from './constants';
import { bezLine } from './geom';
import { NEdge } from './network';
import { distToRect, World } from './world';
import { rectsOverlap } from './towns';
import { applyEarthworks, recomputeLocks, brush, LOCK, DRY_MIN, EARTHWORKS } from './terraform';
import { planEdge, commitProposal, nodeGroup, Snap, Proposal } from './construction';

/** Depot kinds: rail, road (buses) and tram (on a road with tram tracks). */
export type DepotKind = NetKind | 'tram';

export interface Depot {
  id: number;
  kind: DepotKind;
  x: number; z: number; y: number;
  angle: number;
  owner: number;
  /** exit node (connects to the network) and the stub edge inside the building */
  node: number;
  edge: number;
}

export function depotSize(kind: DepotKind) { return kind === 'rail' ? { w: 1.5, d: 4.2 } : kind === 'tram' ? { w: 2.0, d: 3.9 } : { w: 1.8, d: 1.6 }; }

/** Network kind of a depot's track (tram depots sit on roads). */
export const depotNetKind = (kind: DepotKind): NetKind => (kind === 'rail' ? 'rail' : 'road');

/** May company `owner` run trams on this edge? (tram tracks it may use) */
export function tramUsable(g: Game, e: NEdge, owner: number): boolean { return !!e.tram && g.canUse(owner, e.tramOwner ?? -1); }

export interface DepotPlan { ok: boolean; error?: string; x: number; z: number; y: number; angle: number; exitX: number; exitZ: number; snapNode: number; cost: number; demolish: number[] }

export class Depots {
  map = new Map<number, Depot>();
  nextId = 1;
  constructor(private game: Game) {}

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  near(x: number, z: number, r: number): Depot[] {
    const out: Depot[] = [];
    for (const d of this.map.values()) {
      const sz = depotSize(d.kind);
      if (distToRect(x, z, d.x, d.z, d.angle, sz.w / 2, sz.d / 2) <= r) out.push(d);
    }
    return out;
  }

  /** Plan a depot at (x,z) facing `angle`; snaps to a nearby free track/road end. Tram depots connect to tram tracks. */
  plan(kind: DepotKind, x: number, z: number, angle: number, owner: number): DepotPlan {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    const sz = depotSize(kind);
    let snapNode = -1;
    // snap to a free rail end: depot exit coincides with it, facing along its direction
    if (kind === 'rail') {
      const n = net.nearestNode(x, z, sz.d / 2 + 2.5, 'rail', (nn) => nn.edges.length === 1);
      if (n) {
        const e = net.edges.get(n.edges[0])!;
        const ld = net.leaveDir(e, n.id); // direction from node into the track
        angle = Math.atan2(ld.x, ld.z); // depot faces the track
        x = n.x - ld.x * (sz.d / 2 + 0.05);
        z = n.z - ld.z * (sz.d / 2 + 0.05);
        snapNode = n.id;
      }
    }
    const fx = Math.sin(angle), fz = Math.cos(angle);
    const exitX = x + fx * (sz.d / 2 + (kind === 'rail' ? 0.05 : 0.3)), exitZ = z + fz * (sz.d / 2 + (kind === 'rail' ? 0.05 : 0.3));
    const plan: DepotPlan = { ok: true, x, z, y: 0, angle, exitX, exitZ, snapNode, cost: kind === 'rail' ? 90000 : kind === 'tram' ? 120000 : 60000, demolish: [] };
    const failp = (e: string) => { if (plan.ok) { plan.ok = false; plan.error = e; } };
    if (!w.inside(x, z, 4)) failp('Too close to the map edge');
    let mx = -Infinity, mn = Infinity;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const rx = fz, rz = -fx;
      const h = w.heightAt(x + rx * sz.w * a + fx * sz.d * b, z + rz * sz.w * a + fz * sz.d * b);
      mx = Math.max(mx, h); mn = Math.min(mn, h);
    }
    // a rail depot on a track end takes the track's height; a road depot its door's (the street it opens onto
    // starts there), within the ground under it
    plan.y = snapNode >= 0 ? net.nodes.get(snapNode)!.y : kind === 'rail' ? mx : Math.max(mn, Math.min(mx, w.heightAt(exitX, exitZ)));
    if (mn < 0.2) failp('Cannot build on water');
    // a depot on a track end takes the track's height and is levelled on commit
    if (snapNode >= 0 ? Math.max(mx - plan.y, plan.y - mn) > 2.5 : mx - mn > 1.5) failp('Ground is too steep');
    const rect = { x, z, angle, w: sz.w, d: sz.d };
    const R = Math.hypot(sz.w, sz.d) / 2 + 1;
    for (const id of w.bgrid.query(x - R, z - R, x + R, z + R)) { const b = w.buildings.get(id); if (b && rectsOverlap(rect, b, 0.05)) { plan.demolish.push(id); plan.cost += 6000 + b.pop * 2500; } }
    const siblings = new Set(snapNode >= 0 ? nodeGroup(g, snapNode) : []);
    const R2 = R + EARTHWORKS.corePad + 1;
    for (const e of net.edgesNear(x - R2, z - R2, x + R2, z + R2)) {
      if (snapNode >= 0 && (siblings.has(e.a) || siblings.has(e.b))) continue; // the track the depot attaches to and its parallel siblings
      const geo = net.geo(e);
      const hw = net.halfWidth(e);
      for (let i = 0; i < geo.n; i++) {
        const d = distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], x, z, angle, sz.w / 2, sz.d / 2);
        if (d < hw - 0.1) { failp('Track or road in the way'); break; }
        // the depot's levelled pad and a track beside it share grid vertices: only at about the same height
        // (roads are draped on the ground)
        if (e.kind === 'rail' && net.sectionAt(e, geo.cum[i]) === 'ground' && d < hw + EARTHWORKS.corePad && Math.abs(geo.pts[i * 3 + 1] - plan.y) > 0.3) { failp('Too close to a track at another height'); break; }
      }
    }
    for (const st of g.stations.footprintsNear(x, z, R)) if (g.stations.footprints(st).some((f) => rectsOverlap(rect, f, 0.02))) failp('Station in the way');
    for (const d of this.map.values()) { const s2 = depotSize(d.kind); if (rectsOverlap(rect, { x: d.x, z: d.z, angle: d.angle, w: s2.w, d: s2.d }, 0.1)) failp('Depot in the way'); }
    plan.cost += Math.round((mx - mn) * 20000);
    if (kind !== 'rail' && plan.ok) {
      const tram = kind === 'tram';
      const link = this.roadLink(exitX, exitZ, plan.y, owner, -1, tram);
      if (link && !link.ok) failp(tram ? 'Cannot connect to the tram track' : 'Cannot connect to the road');
      else if (link) { for (const id of link.demolish) if (!plan.demolish.includes(id)) plan.demolish.push(id); plan.cost += link.cost; }
      else if (!net.nearestEdge(exitX, exitZ, 4, 'road', (ed) => ed.depot < 0 && (!tram || tramUsable(g, ed, owner)))) failp(tram ? 'No tram track nearby' : 'No road nearby');
    }
    return plan;
  }

  /** Street linking a road (tram) depot exit to the nearest road (tram track); null if none is needed or near. */
  private roadLink(x: number, z: number, y: number, owner: number, exitNode: number, tram = false): Proposal | null {
    const g = this.game;
    const net = g.world.net;
    const ne = net.nearestEdge(x, z, 4, 'road', (ed) => ed.depot < 0 && (!tram || tramUsable(g, ed, owner)));
    if (!ne) return null;
    const nodeEnd = ne.s < 0.8 ? ne.edge.a : ne.s > ne.edge.len - 0.8 ? ne.edge.b : -1;
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p);
    const nn = nodeEnd >= 0 ? net.nodes.get(nodeEnd)! : null;
    const end: Snap = nn ? { kind: 'node', x: nn.x, z: nn.z, y: nn.y, node: nn.id } : { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: ne.edge.id, s: ne.s };
    if (Math.hypot(end.x - x, end.z - z) <= 0.3) return null;
    const start: Snap = exitNode >= 0 ? { kind: 'node', x, z, y, node: exitNode } : { kind: 'free', x, z, y };
    // (straight from the door: the same street whether planned from the plot or built from the depot's exit node)
    return planEdge(g, start, end, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner, tram, straight: true });
  }

  commit(kind: DepotKind, plan: DepotPlan, owner: number): string | null {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    if (!plan.ok) return plan.error ?? 'Cannot build';
    if (!g.company(owner).economy.spend(plan.cost, 'construction')) return 'Not enough money';
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const fx = Math.sin(plan.angle), fz = Math.cos(plan.angle);
    const sz = depotSize(kind);
    const inX = plan.x - fx * (sz.d / 2 - 0.4), inZ = plan.z - fz * (sz.d / 2 - 0.4);
    const nk = depotNetKind(kind);
    const inner = net.addNode(nk, inX, plan.y, inZ, kind === 'rail' ? fx : 0, kind === 'rail' ? fz : 0, owner);
    const exit = plan.snapNode >= 0 ? net.nodes.get(plan.snapNode)! : net.addNode(nk, plan.exitX, plan.y, plan.exitZ, kind === 'rail' ? fx : 0, kind === 'rail' ? fz : 0, owner);
    const len = Math.hypot(exit.x - inX, exit.z - inZ);
    const prof = new Float32Array(Math.max(2, Math.ceil(len) + 1)).fill(plan.y);
    prof[prof.length - 1] = exit.y;
    const id = this.nextId++;
    const e = net.addEdge(nk, inner.id, exit.id, bezLine(inX, inZ, exit.x, exit.z), prof, [], kind === 'rail' ? 'standard' : 'road', owner,
      kind === 'tram' ? { depot: id, tram: true, tramOwner: owner } : { depot: id });
    const dp: Depot = { id, kind, x: plan.x, z: plan.z, y: plan.y, angle: plan.angle, owner, node: exit.id, edge: e.id };
    this.map.set(id, dp);
    // flatten the ground under the building
    for (let zz = Math.floor(plan.z - 4); zz <= Math.ceil(plan.z + 4); zz++) for (let xx = Math.floor(plan.x - 4); xx <= Math.ceil(plan.x + 4); xx++) {
      if (xx < 1 || zz < 1 || xx >= w.size || zz >= w.size) continue;
      const d = distToRect(xx, zz, plan.x, plan.z, plan.angle, sz.w / 2 + 0.3, sz.d / 2 + 0.3);
      const k = w.vi(xx, zz);
      // never under buildings or into another formation's zone, never digging dry land below the water line
      if (w.lock[k] & (LOCK.building | LOCK.formation)) continue;
      const wgt = d <= 0 ? 1 : Math.max(0, 1 - d / 2);
      let v = w.h[k] + (plan.y - 0.08 - w.h[k]) * wgt;
      if (v < w.h[k] && v < DRY_MIN) v = Math.min(w.h[k], DRY_MIN);
      if (wgt > 0) w.setVertex(xx, zz, v);
    }
    applyEarthworks(w, [e]);
    w.removeTreesNear(plan.x, plan.z, Math.hypot(sz.w, sz.d) / 2 + 0.5);
    w.markObjArea(plan.x - 4, plan.z - 4, plan.x + 4, plan.z + 4);
    // road / tram depots connect themselves to the nearest road / tram track (planned, demolitions and cost included, in plan())
    if (kind !== 'rail') {
      const tram = kind === 'tram';
      const link = this.roadLink(exit.x, exit.z, exit.y, owner, exit.id, tram);
      if (link && link.ok) commitProposal(g, link);
      else if (!link) {
        // the door opens right onto the road: join it there (at its end node, or splitting it)
        const ne = net.nearestEdge(exit.x, exit.z, 0.5, 'road', (ed) => ed.id !== e.id && ed.depot < 0 && (!tram || tramUsable(g, ed, owner)));
        if (ne) {
          const at = ne.s < 0.3 ? net.nodes.get(ne.edge.a) : ne.s > ne.edge.len - 0.3 ? net.nodes.get(ne.edge.b) : net.splitEdge(ne.edge.id, ne.s)?.node;
          if (at && at.id !== exit.id) { net.mergeNodes(at.id, exit.id); dp.node = at.id; }
        }
      }
    }
    g.onNetworkChanged();
    return null;
  }

  /** The same blockers are used by demolition previews and removal. */
  removeError(id: number): string | null {
    const g = this.game;
    const dp = this.map.get(id);
    if (!dp) return null;
    if (g.vehicles.all().some((v) => (v as any).depotId === id && !(v as any).onMap)) return 'Vehicles are in the depot';
    if (g.vehicles.isEdgeBusy(dp.edge)) return 'Vehicle in the way';
    return null;
  }

  remove(id: number): string | null {
    const g = this.game;
    const dp = this.map.get(id);
    if (!dp) return null;
    const err = this.removeError(id);
    if (err) return err;
    g.world.net.removeEdge(dp.edge);
    this.map.delete(id);
    recomputeLocks(g.world, dp.x - 4, dp.z - 4, dp.x + 4, dp.z + 4);
    g.world.markObjArea(dp.x - 4, dp.z - 4, dp.x + 4, dp.z + 4);
    g.onNetworkChanged();
    return null;
  }
}

// ------------------------------------------------------------------ signals

/** Place or cycle a signal on a rail edge near (x,z). */
export function toggleSignal(g: Game, x: number, z: number, owner: number): string | null {
  const net = g.world.net;
  // existing signal node? (only on the track under the cursor, not on a parallel neighbour 0.45 away)
  const under = net.nearestEdge(x, z, 1.0, 'rail');
  const n = net.nearestNode(x, z, 0.8, 'rail', (nn) => nn.edges.length === 2 && (!under || nn.edges.includes(under.edge.id) || Math.hypot(nn.x - x, nn.z - z) < 0.2));
  if (n && n.signal) {
    for (const id of n.edges) { const e = net.edges.get(id); const err = e && g.trackUpgradeError(owner, e.owner); if (err) return err; }
    n.signal = (n.signal + 1) % 4;
    // cycled by hand: a plain signal (not passable from behind); removed: no kind left behind
    delete n.signalPass;
    if (!n.signal) delete n.signalKind;
    net.version++;
    g.world.markObjArea(n.x - 2, n.z - 2, n.x + 2, n.z + 2);
    g.onNetworkChanged();
    return null;
  }
  const ne = net.nearestEdge(x, z, 1.0, 'rail');
  if (!ne) return 'Click on a track';
  const e = ne.edge;
  if (e.station >= 0 || e.depot >= 0) return 'Cannot place signals in stations or depots';
  const access = g.trackUpgradeError(owner, e.owner);
  if (access) return access;
  let node = n && Math.hypot(n.x - x, n.z - z) < 0.8 ? n : null;
  if (!node) {
    if (ne.s < 1 || ne.s > e.len - 1) {
      const end = net.nodes.get(ne.s < 1 ? e.a : e.b)!;
      if (end.edges.length !== 2) return 'Signals need plain track (not at a switch)';
      node = end;
    } else {
      if (g.vehicles.isEdgeBusy(e.id)) return 'Train in the way';
      const r = net.splitEdge(e.id, ne.s);
      if (!r) return 'Cannot place here';
      node = r.node;
    }
  }
  if (!g.company(owner).economy.spend(9000, 'construction')) return 'Not enough money';
  // default: one-way in the direction from the click towards the edge's end
  node.signal = 1;
  net.version++;
  g.world.markObjArea(node.x - 2, node.z - 2, node.x + 2, node.z + 2);
  g.onNetworkChanged();
  return null;
}

// ------------------------------------------------------------------ demolition

/** Demolition charge for one station entrance. */
const ENTRANCE_DEMOLITION = 5000;

export interface BulldozeResult {
  cost: number; error: string | null; changed: number;
  /** Owned structures hit by the selection, for the UI's demolition confirmation. */
  stationIds: number[]; depotIds: number[];
}

/** Remove objects at a point (radius) or in a rectangle. */
export function bulldoze(g: Game, x0: number, z0: number, x1: number, z1: number, owner: number, dryRun: boolean): BulldozeResult {
  const w = g.world;
  const net = w.net;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  const point = x1 - x0 < 0.01 && z1 - z0 < 0.01;
  const res: BulldozeResult = { cost: 0, error: null, changed: 0, stationIds: [], depotIds: [] };
  const removals: { cost: number; remove: () => string | null }[] = [];
  const planRemoval = (cost: number, remove: () => string | null) => {
    res.cost += cost; res.changed++;
    removals.push({ cost, remove });
  };
  const inArea = (x: number, z: number, pad: number) => x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad;
  // Through tracks belong to their station too, even when their edge.station is -1.
  const stationEdges = new Set(g.stations.all().flatMap((st) => st.rail ? [...st.rail.edges, ...st.rail.throughEdges] : []));
  // Freeze the selection before removing structures; a point must not hit a second, newly exposed edge.
  const edges = point ? (() => { const ne = net.nearestEdge(x0, z0, 0.9); return ne ? [ne.edge] : []; })()
    : net.edgesNear(x0, z0, x1, z1).filter((e) => { const geo = net.geo(e); for (let i = 0; i < geo.n; i++) if (inArea(geo.pts[i * 3], geo.pts[i * 3 + 2], 0)) return true; return false; });
  // stations
  let structureHit = false;
  for (const st of g.stations.all()) {
    const parts = g.stations.footprints(st).filter((f) => point ? distToRect(x0, z0, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.1 : inArea(f.x, f.z, 0));
    const stopHit = st.stops.some((p) => point ? Math.hypot(p.x - x0, p.z - z0) < 0.6 : inArea(p.x, p.z, 0));
    if (!parts.length && !stopHit) continue;
    if (parts.some((f) => f.part !== 'platforms')) structureHit = true;
    if (st.owner !== owner) { res.error = 'Owned by another company'; continue; }
    // only entrances hit: they go and the station stays (a station below or above the street keeps one: its
    // last entrance takes the whole station, as before)
    const doors = [...new Set(parts.map((f) => f.entrance ?? -1))].sort((a, b) => b - a);
    const r = st.rail;
    if (r && !stopHit && parts.every((f) => f.part === 'entrance' && f.entrance !== undefined) && ((r.level ?? 'ground') === 'ground' || doors.length < r.entrances.length)) {
      for (const i of doors) {
        const err = g.stations.removeEntranceError(st.id, i, owner);
        if (err) { res.error = err; continue; }
        planRemoval(ENTRANCE_DEMOLITION, () => g.stations.removeEntrance(st.id, i, owner));
      }
      continue;
    }
    res.stationIds.push(st.id);
    if (st.rail && (point ? g.stations.footprints(st).some((f) => distToRect(x0, z0, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.1) : true)) {
      // Matches Stations.removeStation's blocker without changing stations.ts.
      if ([...st.rail.edges, ...st.rail.throughEdges].some((eid) => g.vehicles.isEdgeBusy(eid))) { res.error = 'Train in the station'; continue; }
      planRemoval(20000, () => g.stations.removeStation(st.id));
    } else {
      const stops = st.stops.map((p, i) => ({ p, i })).filter(({ p }) => point ? Math.hypot(p.x - x0, p.z - z0) < 0.6 : inArea(p.x, p.z, 0));
      planRemoval(20000, () => {
        for (const { i } of stops.reverse()) g.stations.removeStop(st, i);
        return null;
      });
    }
  }
  // depots
  for (const dp of g.depots.all()) {
    const sz = depotSize(dp.kind);
    const hit = point ? distToRect(x0, z0, dp.x, dp.z, dp.angle, sz.w / 2, sz.d / 2) < 0.1 : inArea(dp.x, dp.z, 0);
    if (!hit) continue;
    if (dp.owner !== owner) { res.error = 'Owned by another company'; continue; }
    res.depotIds.push(dp.id);
    const err = g.depots.removeError(dp.id);
    if (err) { res.error = err; continue; }
    planRemoval(15000, () => g.depots.remove(dp.id));
  }
  // edges (a click on a station building or entrance takes that, not the street beside it)
  const removed: NEdge[] = [];
  for (const e of point && structureHit ? [] : edges) {
    if (e.station >= 0 || e.depot >= 0 || stationEdges.has(e.id)) continue;
    if (e.owner >= 0 && e.owner !== owner) { res.error = 'Owned by another company'; continue; }
    if (e.tram && (e.tramOwner ?? -1) >= 0 && e.tramOwner !== owner) { res.error = 'Tram tracks of another company'; continue; }
    if (g.vehicles.isEdgeBusy(e.id)) { res.error = 'Vehicle in the way'; continue; }
    planRemoval(e.kind === 'rail' ? railRemovalCost(e.len) : 250 * e.len, () => { removed.push(e); return null; });
  }
  // buildings (point only, or all in area)
  const blds = point ? w.buildingsNear(x0, z0, 4).filter((b) => distToRect(x0, z0, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.05)
    : [...w.buildings.values()].filter((b) => inArea(b.x, b.z, 0));
  for (const b of blds) {
    planRemoval(6000 + b.pop * 2500, () => { g.towns.demolishBuilding(b.id); return null; });
  }
  // trees in area
  if (!point) {
    let n = 0;
    for (const id of w.treeGrid.query(x0, z0, x1, z1)) { const t = w.trees[id]; if (t && inArea(t.x, t.z, 0)) n++; }
    if (n) planRemoval(n * 250, () => {
      for (const id of w.treeGrid.query(x0, z0, x1, z1)) {
        const t = w.trees[id];
        if (t && inArea(t.x, t.z, 0)) { w.trees[id] = null; w.freeTrees.push(id); w.treeGrid.remove(id); w.markObj(t.x, t.z); }
      }
      return null;
    });
  }
  // Validate the whole selection, then execute only those removals that were priced above.
  const economy = g.company(owner).economy;
  if (res.cost > 0 && !economy.canAfford(res.cost)) {
    res.error = 'Not enough money'; res.changed = 0;
    if (!dryRun) res.cost = 0;
    return res;
  }
  if (dryRun) return res;
  res.cost = 0; res.changed = 0;
  for (const op of removals) {
    const err = op.remove();
    if (err) { res.error = err; continue; }
    res.cost += op.cost; res.changed++;
  }
  if (removed.length) {
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const e of removed) {
      const b = net.grid.box(e.id);
      if (b) { bx0 = Math.min(bx0, b[0]); bz0 = Math.min(bz0, b[1]); bx1 = Math.max(bx1, b[2]); bz1 = Math.max(bz1, b[3]); }
      net.removeEdge(e.id);
    }
    recomputeLocks(w, bx0, bz0, bx1, bz1);
    g.onNetworkChanged();
  }
  if (res.cost > 0) economy.spend(res.cost, 'construction');
  return res;
}

export function terraformBrush(g: Game, x: number, z: number, radius: number, mode: 'raise' | 'lower' | 'level', level: number, owner: number): { cost: number; error?: string } {
  const vol = brush(g.world, x, z, radius, mode, 0.25, level, true);
  const cost = Math.round(vol * 1500);
  if (cost <= 0) return { cost: 0 };
  if (!g.company(owner).economy.spend(cost, 'construction')) return { cost, error: 'Not enough money' };
  brush(g.world, x, z, radius, mode, 0.25, level, false);
  return { cost };
}

// ------------------------------------------------------------------ tram tracks

export interface TramTrackResult { cost: number; changed: number; error: string | null }

/** Is a tram physically on this edge? */
function tramOn(g: Game, edgeId: number): boolean {
  for (const v of g.vehicles.roads()) if (v.model?.kind === 'tram' && v.occupiedEdges().includes(edgeId)) return true;
  return false;
}

/**
 * Lay tram tracks (with overhead wire) in existing road edges, owned by `owner`, for TRAM.costPerUnit per
 * unit. Roads of other companies need an access agreement; edges that already carry tracks are skipped.
 */
export function addTramTracks(g: Game, edgeIds: number[], owner: number, dryRun = false): TramTrackResult {
  const net = g.world.net;
  const res: TramTrackResult = { cost: 0, changed: 0, error: null };
  const todo: NEdge[] = [];
  for (const id of new Set(edgeIds)) {
    const e = net.edges.get(id);
    if (!e || e.tram) continue;
    if (e.kind !== 'road') { res.error = 'Tram tracks are laid in roads'; continue; }
    if (e.station >= 0 || e.depot >= 0) { res.error = 'Not inside a depot'; continue; }
    if (e.owner >= 0 && !g.canUse(owner, e.owner)) { res.error = 'Road of another company'; continue; }
    res.cost += TRAM.costPerUnit * e.len; res.changed++;
    todo.push(e);
  }
  res.cost = Math.round(res.cost);
  if (dryRun || !todo.length) return res;
  if (!g.company(owner).economy.spend(res.cost, 'construction')) return { cost: res.cost, changed: 0, error: 'Not enough money' };
  for (const e of todo) { e.tram = true; e.tramOwner = owner; net.touchEdge(e); }
  g.onNetworkChanged();
  return res;
}

export interface ElectrifyResult {
  /** cost of the wire (spent unless a dry run or an error), edges electrified, units of track */
  cost: number; changed: number; length: number;
  error: string | null;
}

/**
 * Overhead wire for standard track: standard -> electric (ELECTRIFY.costPerUnit per unit of track, platform
 * tracks included). One's own track, or another company's that one may use (it stays theirs; the electrifying
 * company pays). Track already carrying wire is left alone.
 */
export function electrify(g: Game, edgeIds: number[], owner: number, dryRun = false): ElectrifyResult {
  const net = g.world.net;
  const res: ElectrifyResult = { cost: 0, changed: 0, length: 0, error: null };
  const todo: NEdge[] = [];
  for (const id of new Set(edgeIds)) {
    const e = net.edges.get(id);
    if (!e || e.kind !== 'rail' || e.depot >= 0 || e.type !== ELECTRIFY.from) continue;
    const access = g.trackUpgradeError(owner, e.owner);
    if (access) { res.error = access; continue; }
    res.cost += ELECTRIFY.costPerUnit * e.len; res.length += e.len; res.changed++;
    todo.push(e);
  }
  res.cost = Math.round(res.cost);
  if (!todo.length) { res.error ??= 'No unelectrified track here'; return res; }
  if (dryRun) return res;
  if (!g.company(owner).economy.spend(res.cost, 'construction')) return { cost: res.cost, changed: 0, length: 0, error: 'Not enough money' };
  for (const e of todo) { e.type = ELECTRIFY.to; net.touchEdge(e); }
  for (const st of g.stations.map.values()) if (st.rail?.edges.length && [...st.rail.edges, ...st.rail.throughEdges].every((id) => net.edges.get(id)?.type === ELECTRIFY.to)) st.rail.trackType = ELECTRIFY.to;
  g.onNetworkChanged();
  return res;
}

/** Take up tram tracks owned by `owner` (not under a tram; trams routed over them re-plan). */
export function removeTramTracks(g: Game, edgeIds: number[], owner: number, dryRun = false): TramTrackResult {
  const net = g.world.net;
  const res: TramTrackResult = { cost: 0, changed: 0, error: null };
  const todo: NEdge[] = [];
  for (const id of new Set(edgeIds)) {
    const e = net.edges.get(id);
    if (!e || !e.tram || e.depot >= 0) continue;
    if (e.tramOwner !== owner) { res.error = 'Tram tracks of another company'; continue; }
    if (tramOn(g, e.id)) { res.error = 'Tram in the way'; continue; }
    res.cost += TRAM.removePerUnit * e.len; res.changed++;
    todo.push(e);
  }
  res.cost = Math.round(res.cost);
  if (dryRun || !todo.length) return res;
  g.company(owner).economy.spend(res.cost, 'construction', true);
  for (const e of todo) { delete e.tram; delete e.tramOwner; net.touchEdge(e); }
  g.onNetworkChanged();
  return res;
}

/**
 * Road edges along the shortest road path between the road points nearest to (ax,az) and (bx,bz)
 * (e.g. for laying tram tracks by dragging along streets). Null if not connected.
 */
export function roadPath(g: Game, ax: number, az: number, bx: number, bz: number, maxLen = 400): number[] | null {
  const net = g.world.net;
  const ok = (e: NEdge) => e.kind === 'road' && e.depot < 0 && e.station < 0;
  const ea = net.nearestEdge(ax, az, 2, 'road', ok), eb = net.nearestEdge(bx, bz, 2, 'road', ok);
  if (!ea || !eb) return null;
  if (ea.edge.id === eb.edge.id) return [ea.edge.id];
  // Dijkstra over nodes, starting from both ends of the first edge
  const dist = new Map<number, number>(), via = new Map<number, number>();
  const open: [number, number][] = [];
  const start = (n: number, d: number) => { dist.set(n, d); via.set(n, -1); open.push([d, n]); };
  start(ea.edge.a, ea.s); start(ea.edge.b, ea.edge.len - ea.s);
  const goal = new Set([eb.edge.a, eb.edge.b]);
  let found = -1;
  while (open.length) {
    open.sort((p, q) => p[0] - q[0]);
    const [d, u] = open.shift()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (goal.has(u)) { found = u; break; }
    if (d > maxLen) break;
    for (const eid of net.nodes.get(u)?.edges ?? []) {
      const e = net.edges.get(eid);
      if (!e || !ok(e)) continue;
      const v = e.a === u ? e.b : e.a, nd = d + e.len * ((ROAD_TYPES[e.type] ?? ROAD_TYPES.road).speed > 60 ? 1.1 : 1);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); via.set(v, eid); open.push([nd, v]); }
    }
  }
  if (found < 0) return null;
  const out = [eb.edge.id];
  for (let n = found, guard = 0; guard < 10000; guard++) {
    const eid = via.get(n) ?? -1;
    if (eid < 0) break;
    out.push(eid);
    const e = net.edges.get(eid)!;
    n = e.a === n ? e.b : e.a;
  }
  out.push(ea.edge.id);
  return [...new Set(out.reverse())];
}

export function isWorld(w: World) { return !!w; }
export { RAIL };
