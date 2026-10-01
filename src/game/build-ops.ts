// Depots, signals, demolition and terraforming.
import type { Game } from './game';
import { NetKind, RAIL } from './constants';
import { bezLine } from './geom';
import { NEdge } from './network';
import { distToRect, World } from './world';
import { rectsOverlap } from './towns';
import { applyEarthworks, recomputeLocks, brush } from './terraform';
import { planEdge, commitProposal, nodeGroup, Snap, Proposal } from './construction';

export interface Depot {
  id: number;
  kind: NetKind;
  x: number; z: number; y: number;
  angle: number;
  owner: number;
  /** exit node (connects to the network) and the stub edge inside the building */
  node: number;
  edge: number;
}

export function depotSize(kind: NetKind) { return kind === 'rail' ? { w: 1.5, d: 4.2 } : { w: 1.8, d: 1.6 }; }

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

  /** Plan a depot at (x,z) facing `angle`; snaps to a nearby free track/road end. */
  plan(kind: NetKind, x: number, z: number, angle: number, owner: number): DepotPlan {
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
    const plan: DepotPlan = { ok: true, x, z, y: 0, angle, exitX, exitZ, snapNode, cost: kind === 'rail' ? 90000 : 60000, demolish: [] };
    const failp = (e: string) => { if (plan.ok) { plan.ok = false; plan.error = e; } };
    if (!w.inside(x, z, 4)) failp('Too close to the map edge');
    let mx = -Infinity, mn = Infinity;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const rx = fz, rz = -fx;
      const h = w.heightAt(x + rx * sz.w * a + fx * sz.d * b, z + rz * sz.w * a + fz * sz.d * b);
      mx = Math.max(mx, h); mn = Math.min(mn, h);
    }
    plan.y = snapNode >= 0 ? net.nodes.get(snapNode)!.y : mx;
    if (mn < 0.2) failp('Cannot build on water');
    // a depot on a track end takes the track's height and is levelled on commit
    if (snapNode >= 0 ? Math.max(mx - plan.y, plan.y - mn) > 2.5 : mx - mn > 1.5) failp('Ground is too steep');
    const rect = { x, z, angle, w: sz.w, d: sz.d };
    const R = Math.hypot(sz.w, sz.d) / 2 + 1;
    for (const id of w.bgrid.query(x - R, z - R, x + R, z + R)) { const b = w.buildings.get(id); if (b && rectsOverlap(rect, b, 0.05)) { plan.demolish.push(id); plan.cost += 6000 + b.pop * 2500; } }
    const siblings = new Set(snapNode >= 0 ? nodeGroup(g, snapNode) : []);
    for (const e of net.edgesNear(x - R, z - R, x + R, z + R)) {
      if (snapNode >= 0 && (siblings.has(e.a) || siblings.has(e.b))) continue; // the track the depot attaches to and its parallel siblings
      const geo = net.geo(e);
      const hw = net.halfWidth(e);
      for (let i = 0; i < geo.n; i++) if (distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], x, z, angle, sz.w / 2, sz.d / 2) < hw - 0.1) { failp('Track or road in the way'); break; }
    }
    for (const st of g.stations.footprintsNear(x, z, R)) if (g.stations.footprints(st).some((f) => rectsOverlap(rect, f, 0.02))) failp('Station in the way');
    for (const d of this.map.values()) { const s2 = depotSize(d.kind); if (rectsOverlap(rect, { x: d.x, z: d.z, angle: d.angle, w: s2.w, d: s2.d }, 0.1)) failp('Depot in the way'); }
    plan.cost += Math.round((mx - mn) * 20000);
    if (kind === 'road' && plan.ok) {
      const link = this.roadLink(exitX, exitZ, plan.y, owner, -1);
      if (link && !link.ok) failp('Cannot connect to the road');
      else if (link) { for (const id of link.demolish) if (!plan.demolish.includes(id)) plan.demolish.push(id); plan.cost += link.cost; }
      else if (!net.nearestEdge(exitX, exitZ, 4, 'road', (ed) => ed.depot < 0)) failp('No road nearby');
    }
    return plan;
  }

  /** Street linking a road depot exit to the nearest road (null if none is needed or none is near). */
  private roadLink(x: number, z: number, y: number, owner: number, exitNode: number): Proposal | null {
    const g = this.game;
    const net = g.world.net;
    const ne = net.nearestEdge(x, z, 4, 'road', (ed) => ed.depot < 0);
    if (!ne) return null;
    const nodeEnd = ne.s < 0.8 ? ne.edge.a : ne.s > ne.edge.len - 0.8 ? ne.edge.b : -1;
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p);
    const nn = nodeEnd >= 0 ? net.nodes.get(nodeEnd)! : null;
    const end: Snap = nn ? { kind: 'node', x: nn.x, z: nn.z, y: nn.y, node: nn.id } : { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: ne.edge.id, s: ne.s };
    if (Math.hypot(end.x - x, end.z - z) <= 0.3) return null;
    const start: Snap = exitNode >= 0 ? { kind: 'node', x, z, y, node: exitNode } : { kind: 'free', x, z, y };
    return planEdge(g, start, end, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner });
  }

  commit(kind: NetKind, plan: DepotPlan, owner: number): string | null {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    if (!plan.ok) return plan.error ?? 'Cannot build';
    if (!g.company(owner).economy.spend(plan.cost, 'construction')) return 'Not enough money';
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const fx = Math.sin(plan.angle), fz = Math.cos(plan.angle);
    const sz = depotSize(kind);
    const inX = plan.x - fx * (sz.d / 2 - 0.4), inZ = plan.z - fz * (sz.d / 2 - 0.4);
    const inner = net.addNode(kind, inX, plan.y, inZ, kind === 'rail' ? fx : 0, kind === 'rail' ? fz : 0, owner);
    const exit = plan.snapNode >= 0 ? net.nodes.get(plan.snapNode)! : net.addNode(kind, plan.exitX, plan.y, plan.exitZ, kind === 'rail' ? fx : 0, kind === 'rail' ? fz : 0, owner);
    const len = Math.hypot(exit.x - inX, exit.z - inZ);
    const prof = new Float32Array(Math.max(2, Math.ceil(len) + 1)).fill(plan.y);
    prof[prof.length - 1] = exit.y;
    const id = this.nextId++;
    const e = net.addEdge(kind, inner.id, exit.id, bezLine(inX, inZ, exit.x, exit.z), prof, [], kind === 'rail' ? 'standard' : 'road', owner, { depot: id });
    const dp: Depot = { id, kind, x: plan.x, z: plan.z, y: plan.y, angle: plan.angle, owner, node: exit.id, edge: e.id };
    this.map.set(id, dp);
    // flatten the ground under the building
    for (let zz = Math.floor(plan.z - 4); zz <= Math.ceil(plan.z + 4); zz++) for (let xx = Math.floor(plan.x - 4); xx <= Math.ceil(plan.x + 4); xx++) {
      if (xx < 1 || zz < 1 || xx >= w.size || zz >= w.size) continue;
      const d = distToRect(xx, zz, plan.x, plan.z, plan.angle, sz.w / 2 + 0.3, sz.d / 2 + 0.3);
      const k = w.vi(xx, zz);
      if (w.lock[k] & 2) continue;
      const wgt = d <= 0 ? 1 : Math.max(0, 1 - d / 2);
      if (wgt > 0) w.setVertex(xx, zz, w.h[k] + (plan.y - 0.08 - w.h[k]) * wgt);
    }
    applyEarthworks(w, [e]);
    w.removeTreesNear(plan.x, plan.z, Math.hypot(sz.w, sz.d) / 2 + 0.5);
    w.markObjArea(plan.x - 4, plan.z - 4, plan.x + 4, plan.z + 4);
    // road depots connect themselves to the nearest road (planned, demolitions and cost included, in plan())
    if (kind === 'road') {
      const link = this.roadLink(exit.x, exit.z, exit.y, owner, exit.id);
      if (link && link.ok) commitProposal(g, link);
    }
    g.onNetworkChanged();
    return null;
  }

  remove(id: number): string | null {
    const g = this.game;
    const dp = this.map.get(id);
    if (!dp) return null;
    if (g.vehicles.all().some((v) => (v as any).depotId === id && !(v as any).onMap)) return 'Vehicles are in the depot';
    if (g.vehicles.isEdgeBusy(dp.edge)) return 'Vehicle in the way';
    g.world.net.removeEdge(dp.edge);
    this.map.delete(id);
    g.world.markObjArea(dp.x - 4, dp.z - 4, dp.x + 4, dp.z + 4);
    g.onNetworkChanged();
    return null;
  }
}

// ------------------------------------------------------------------ signals

/** Place or cycle a signal on a rail edge near (x,z). */
export function toggleSignal(g: Game, x: number, z: number, owner: number): string | null {
  const net = g.world.net;
  // existing signal node?
  const n = net.nearestNode(x, z, 0.8, 'rail', (nn) => nn.edges.length === 2);
  if (n && n.signal) {
    if (n.owner !== owner) return 'Not your track';
    n.signal = (n.signal + 1) % 4;
    net.version++;
    g.world.markObjArea(n.x - 2, n.z - 2, n.x + 2, n.z + 2);
    g.onNetworkChanged();
    return null;
  }
  const ne = net.nearestEdge(x, z, 1.0, 'rail');
  if (!ne) return 'Click on a track';
  const e = ne.edge;
  if (e.station >= 0 || e.depot >= 0) return 'Cannot place signals in stations or depots';
  if (e.owner !== owner) return 'Not your track';
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

export interface BulldozeResult { cost: number; error: string | null; changed: number }

/** Remove objects at a point (radius) or in a rectangle. */
export function bulldoze(g: Game, x0: number, z0: number, x1: number, z1: number, owner: number, dryRun: boolean): BulldozeResult {
  const w = g.world;
  const net = w.net;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  const point = x1 - x0 < 0.01 && z1 - z0 < 0.01;
  const res: BulldozeResult = { cost: 0, error: null, changed: 0 };
  const inArea = (x: number, z: number, pad: number) => x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad;
  // stations
  for (const st of g.stations.all()) {
    const hit = g.stations.footprints(st).some((f) => point ? distToRect(x0, z0, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.1 : inArea(f.x, f.z, 0)) ||
      st.stops.some((p) => point ? Math.hypot(p.x - x0, p.z - z0) < 0.6 : inArea(p.x, p.z, 0));
    if (!hit) continue;
    if (st.owner !== owner) { res.error = 'Owned by another company'; continue; }
    res.cost += 20000; res.changed++;
    if (dryRun) continue;
    if (st.rail && (point ? g.stations.footprints(st).some((f) => distToRect(x0, z0, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.1) : true)) {
      const err = g.stations.removeStation(st.id);
      if (err) res.error = err;
    } else {
      for (let i = st.stops.length - 1; i >= 0; i--) {
        const p = st.stops[i];
        if (point ? Math.hypot(p.x - x0, p.z - z0) < 0.6 : inArea(p.x, p.z, 0)) g.stations.removeStop(st, i);
      }
    }
  }
  // depots
  for (const dp of g.depots.all()) {
    const sz = depotSize(dp.kind);
    const hit = point ? distToRect(x0, z0, dp.x, dp.z, dp.angle, sz.w / 2, sz.d / 2) < 0.1 : inArea(dp.x, dp.z, 0);
    if (!hit) continue;
    if (dp.owner !== owner) { res.error = 'Owned by another company'; continue; }
    res.cost += 15000; res.changed++;
    if (!dryRun) { const err = g.depots.remove(dp.id); if (err) res.error = err; }
  }
  // edges
  const edges = point ? (() => { const ne = net.nearestEdge(x0, z0, 0.9); return ne ? [ne.edge] : []; })()
    : net.edgesNear(x0, z0, x1, z1).filter((e) => { const geo = net.geo(e); for (let i = 0; i < geo.n; i++) if (inArea(geo.pts[i * 3], geo.pts[i * 3 + 2], 0)) return true; return false; });
  const removed: NEdge[] = [];
  for (const e of edges) {
    if (e.station >= 0 || e.depot >= 0) continue;
    if (e.owner >= 0 && e.owner !== owner) { res.error = 'Owned by another company'; continue; }
    if (g.vehicles.isEdgeBusy(e.id)) { res.error = 'Vehicle in the way'; continue; }
    res.cost += (e.kind === 'rail' ? 400 : 250) * e.len; res.changed++;
    if (!dryRun) removed.push(e);
  }
  // buildings (point only, or all in area)
  const blds = point ? w.buildingsNear(x0, z0, 4).filter((b) => distToRect(x0, z0, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.05)
    : [...w.buildings.values()].filter((b) => inArea(b.x, b.z, 0));
  for (const b of blds) {
    res.cost += 6000 + b.pop * 2500; res.changed++;
    if (!dryRun) g.towns.demolishBuilding(b.id);
  }
  // trees in area
  if (!point) {
    let n = 0;
    for (const id of w.treeGrid.query(x0, z0, x1, z1)) { const t = w.trees[id]; if (t && inArea(t.x, t.z, 0)) n++; }
    res.cost += n * 250;
    if (n) res.changed++;
    if (!dryRun && n) {
      for (const id of w.treeGrid.query(x0, z0, x1, z1)) {
        const t = w.trees[id];
        if (t && inArea(t.x, t.z, 0)) { w.trees[id] = null; w.freeTrees.push(id); w.treeGrid.remove(id); w.markObj(t.x, t.z); }
      }
    }
  }
  if (!dryRun && removed.length) {
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const e of removed) {
      const b = net.grid.box(e.id);
      if (b) { bx0 = Math.min(bx0, b[0]); bz0 = Math.min(bz0, b[1]); bx1 = Math.max(bx1, b[2]); bz1 = Math.max(bz1, b[3]); }
      net.removeEdge(e.id);
    }
    recomputeLocks(w, bx0, bz0, bx1, bz1);
    g.onNetworkChanged();
  }
  if (!dryRun && res.cost > 0) g.company(owner).economy.spend(res.cost, 'construction', true);
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

export function isWorld(w: World) { return !!w; }
export { RAIL };
