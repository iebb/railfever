// Earthworks along network edges, formation locks and terraform brushes.
import { type World, distToRect, pointInRect } from './world';
import { Network, type NEdge } from './network';
import { WATER_Y } from './constants';

/** Depth of the formation (terrain surface) below the edge's running height. */
export function formationDepth(e: NEdge) { return e.kind === 'rail' ? 0.1 : 0.04; }

/**
 * Earthworks beside a formation: the slope's rise per unit across (rail 1:2, roads 1:1.5), how far a slope may
 * reach (units), and how far the flat formation reaches past the half width — every vertex of every grid cell
 * the formation touches, so the terrain's triangles never cover its edge.
 */
export const EARTHWORKS = { slopeRail: 0.5, slopeRoad: 1 / 1.5, reach: 10, corePad: 1.42, round: 0.3 };
/** Dry land is never dug below this (no pits filling with water). */
export const DRY_MIN = WATER_Y + 0.05;
/**
 * World.lock bits: 1 = a formation zone (any network edge), 2 = under a building, 4 = a rail formation zone.
 * Rails keep their exact profile (the terrain must never cover them); roads are draped on the terrain.
 */
export const LOCK = { formation: 1, building: 2, rail: 4 };

/** Sparse, read-only clearance view: removed houses lose their locks, retained neighbours keep theirs. */
export function previewDemolition(w: World, removed: Iterable<number>): World {
  const ids = new Set(removed);
  if (!ids.size) return w;
  const locks = new Map<number, number>();
  for (const id of ids) {
    const b = w.buildings.get(id);
    if (!b) continue;
    const r = Math.hypot(b.w, b.d) / 2 + 0.5;
    const nearby = w.buildingsNear(b.x, b.z, r + 2).filter(q => !ids.has(q.id));
    for (let z = Math.max(0, Math.floor(b.z - r)); z <= Math.min(w.size, Math.ceil(b.z + r)); z++)
      for (let x = Math.max(0, Math.floor(b.x - r)); x <= Math.min(w.size, Math.ceil(b.x + r)); x++) {
        if (!pointInRect(x, z, b.x, b.z, b.angle, b.w / 2 + 0.6, b.d / 2 + 0.6)) continue;
        const k = w.vi(x, z), retained = nearby.some(q => pointInRect(x, z, q.x, q.z, q.angle, q.w / 2 + 0.6, q.d / 2 + 0.6));
        locks.set(k, retained ? w.lock[k] | LOCK.building : w.lock[k] & ~LOCK.building);
      }
  }
  const view = Object.create(w) as World;
  const lockView = new Proxy(w.lock, {
    get: (target, key) => typeof key === 'string' && /^\d+$/.test(key) ? locks.get(Number(key)) ?? target[Number(key)] : Reflect.get(target, key, target),
    set: () => { throw new Error('Clearance previews are read-only'); },
  });
  Object.defineProperty(view, 'lock', { value: lockView });
  view.buildingsNear = (x, z, r) => w.buildingsNear(x, z, r).filter(b => !ids.has(b.id));
  return view;
}

/** Per vertex: the height range the formations allow (flat core, slopes beside), and the nearest target. */
interface Acc { lo: number; hi: number; dmin: number; tnear: number; core: boolean }

/** Same triangle interpolation as World.heightAt, with sparse prospective vertex values. */
function heightAtVertices(w: World, x: number, z: number, vertex: (k: number) => number): number {
  x = Math.max(0, Math.min(w.size - 1e-4, x)); z = Math.max(0, Math.min(w.size - 1e-4, z));
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, k = iz * (w.size + 1) + ix;
  const h0 = vertex(k), h1 = vertex(k + 1), h2 = vertex(k + w.size + 2), h3 = vertex(k + w.size + 1);
  return fx >= fz ? h0 + (h1 - h0) * fx + (h2 - h1) * fz : h0 + (h2 - h3) * fx + (h3 - h0) * fz;
}

/** Ground samples of an edge (every <= 0.4) with the graded end 1 unit past a dead end. */
function groundSamples(w: World, e: NEdge): { x: number; y: number; z: number; s: number }[] {
  const net = w.net, g = net.geo(e), out: { x: number; y: number; z: number; s: number }[] = [];
  let lastS = -1;
  for (let i = 0; i < g.n; i++) {
    const s = g.cum[i];
    if (i > 0 && i < g.n - 1 && s - lastS < 0.4) continue;
    lastS = s;
    if (net.sectionAt(e, s) !== 'ground') continue;
    out.push({ x: g.pts[i * 3], y: g.pts[i * 3 + 1], z: g.pts[i * 3 + 2], s });
  }
  // dead ends (track and road ends, depot stubs, access streets): the formation ends a unit past the node
  for (const [nid, i, sg] of [[e.a, 0, -1], [e.b, g.n - 1, 1]] as const) {
    const n = net.nodes.get(nid);
    if (!n || n.edges.length !== 1 || net.sectionAt(e, sg < 0 ? 0 : e.len) !== 'ground') continue;
    const tx = g.tan[i * 2] * sg, tz = g.tan[i * 2 + 1] * sg;
    for (const k of [0.4, 0.8, 1]) out.push({ x: g.pts[i * 3] + tx * k, y: g.pts[i * 3 + 1], z: g.pts[i * 3 + 2] + tz * k, s: sg < 0 ? -k : e.len + k });
  }
  return out;
}

/**
 * Does a rail edge's ground end at node `nid` stand at a tunnel mouth: the next edge there runs on in tunnel, or
 * another track's portal lies beside it at about its height (a second track laid up to the first one's portal, its
 * connection running on in the bore)? Its grading then stops there as at a portal within the edge.
 */
function portalEnd(w: World, e: NEdge, nid: number): boolean {
  const net = w.net, n = net.nodes.get(nid);
  if (!n || e.kind !== 'rail') return false;
  // (where another track runs on from the node on the ground, its own formation continues there)
  if (n.edges.some((id) => {
    const q = id === e.id ? undefined : net.edges.get(id);
    return !!q && net.sectionAt(q, q.a === nid ? 0 : q.len) === 'ground';
  })) return false;
  const p = { x: 0, y: 0, z: 0 }, r = 2.5;
  for (const q of net.edgesNear(n.x - r, n.z - r, n.x + r, n.z + r)) {
    if (q.id === e.id || q.kind !== 'rail') continue;
    for (const t of q.sections) {
      if (t.type !== 'tunnel') continue;
      for (const s of [t.s0, t.s1]) {
        net.pointAt(q, s, p);
        if (Math.hypot(p.x - n.x, p.z - n.z) <= r && Math.abs(p.y - n.y) < 1.2) return true;
      }
    }
  }
  return false;
}

/** Collect, per vertex, the heights the edge's ground sections allow: flat formation, linear side slopes. */
function stampEdge(w: World, e: NEdge, out: Map<number, Acc>, coreOnly = false) {
  const net = w.net;
  const hw = net.halfWidth(e);
  const core = hw + EARTHWORKS.corePad;
  const fd = formationDepth(e);
  const k = e.kind === 'rail' ? EARTHWORKS.slopeRail : EARTHWORKS.slopeRoad;
  const s1 = w.size + 1;
  const tunnels: { s0: number; s1: number }[] = e.sections.filter((sec) => sec.type === 'tunnel');
  // (a ground end at a tunnel mouth: the hillside beyond it stays, as behind a portal within the edge; else its end,
  // laid before its connection on into the bore, cut away the slope and the streets over the portal)
  if (e.kind === 'rail') for (const [nid, at] of [[e.a, 0], [e.b, e.len]] as const)
    if (net.sectionAt(e, at) === 'ground' && portalEnd(w, e, nid)) tunnels.push(at === 0 ? { s0: -Infinity, s1: 0 } : { s0: e.len, s1: Infinity });
  const g = net.geo(e);
  for (const p of groundSamples(w, e)) {
    const target = p.y - fd;
    const terr = w.heightAt(p.x, p.z);
    const ext = coreOnly ? 0 : Math.min(EARTHWORKS.reach, Math.abs(target - terr) / k + 1);
    const R = core + ext;
    // grading stops at tunnel portals so the hillside behind them stays intact
    const nearTunnel = tunnels.some((t) => p.s > t.s0 - R - 0.5 && p.s < t.s1 + R + 0.5);
    let tx = 0, tz = 0;
    if (nearTunnel) { const i = Math.max(0, Math.min(g.n - 1, Math.round((p.s / Math.max(0.01, e.len)) * (g.n - 1)))); tx = g.tan[i * 2]; tz = g.tan[i * 2 + 1]; }
    for (let z = Math.max(0, Math.floor(p.z - R)); z <= Math.min(w.size, Math.ceil(p.z + R)); z++) {
      for (let x = Math.max(0, Math.floor(p.x - R)); x <= Math.min(w.size, Math.ceil(p.x + R)); x++) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > R) continue;
        if (nearTunnel) {
          // (the cutting reaches just into the portal, so the cells of the approach a unit out are flat)
          const sv = p.s + (x - p.x) * tx + (z - p.z) * tz;
          if (tunnels.some((t) => sv > (t.s0 < 0.02 ? -Infinity : t.s0 + 0.45) && sv < (t.s1 > e.len - 0.02 ? Infinity : t.s1 - 0.45))) continue;
        }
        const key = z * s1 + x;
        let a = out.get(key);
        if (!a) { a = { lo: -Infinity, hi: Infinity, dmin: Infinity, tnear: target, core: false }; out.set(key, a); }
        if (d <= core) { a.lo = Math.max(a.lo, target); a.hi = Math.min(a.hi, target); a.core = true; }
        else { const dd = (d - core) * k; a.hi = Math.min(a.hi, target + dd); a.lo = Math.max(a.lo, target - dd); }
        if (d < a.dmin) { a.dmin = d; a.tnear = target; }
      }
    }
  }
}

/**
 * Ground formations share terrain vertices. Check actual road cross-sections against the projected terrain,
 * and shared rail cores against their running heights, before accepting works that could remove their support.
 * The preview network owns its geometry caches and nodes; surveying never writes the world's network or terrain.
 */
export function formationSupportError(w: World, planned: (Pick<NEdge, 'kind' | 'type' | 'bez' | 'prof' | 'sections'> & { start?: { kind: string }; end?: { kind: string } })[],
  ignore: ReadonlySet<number> = new Set(), bridges: { edge: number; s0: number; s1: number }[] = [], terrain?: ReadonlyMap<number, number>): string | null {
  if (!planned.length) return null;
  const view = Object.create(w) as World;
  view.net = new Network(view);
  const current = (k: number) => terrain?.get(k) ?? w.h[k];
  if (terrain) view.heightAt = (x, z) => heightAtVertices(w, x, z, current);
  const stamps = new Map<number, Acc>();
  const roads: NEdge[] = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const rail = planned.some(e => e.kind === 'rail');
  for (const p of planned) {
    const a = view.net.addNode(p.kind, p.bez.x0, p.prof[0], p.bez.z0);
    const b = view.net.addNode(p.kind, p.bez.x3, p.prof[p.prof.length - 1], p.bez.z3);
    const e: NEdge = { ...p, id: -a.id, a: a.id, b: b.id, sa: 1, sb: -1, owner: 0, station: -1, depot: -1, version: 0, len: 0 };
    e.len = view.net.geo(e).len;
    a.edges.push(e.id); b.edges.push(e.id);
    // A snapped end joins the existing network: its formation does not extend a unit beyond that joint.
    if (p.start && p.start.kind !== 'free') a.edges.push(-1);
    if (p.end && p.end.kind !== 'free') b.edges.push(-1);
    if (!rail || e.kind === 'rail') stampEdge(view, e, stamps, true);
    if (e.kind === 'road') roads.push(e);
    const g = view.net.geo(e);
    for (let i = 0; i < g.n; i++) {
      x0 = Math.min(x0, g.pts[i * 3]); x1 = Math.max(x1, g.pts[i * 3]);
      z0 = Math.min(z0, g.pts[i * 3 + 2]); z1 = Math.max(z1, g.pts[i * 3 + 2]);
    }
  }
  // A road can share distant core vertices while its actual carriageway remains seated. Test the
  // interpolated surface under the road, rather than assigning every corner the highest road sample nearby.
  const roadTerrain = new Map(terrain);
  if (roads.length) earthworks(w, roads, true, view, roadTerrain, terrain);
  const vertex = (k: number) => {
    const track = stamps.get(k);
    if (track?.core && rail) return Math.fround(w.lock[k] & LOCK.rail ? Math.min(current(k), track.hi) : track.hi);
    if (w.lock[k] & LOCK.rail) return current(k);
    return roadTerrain.get(k) ?? current(k);
  };
  const height = (x: number, z: number) => heightAtVertices(w, x, z, vertex);
  const roadUnsupported = (road: NEdge, net: Network, existing = false) => {
    const p = { x: 0, y: 0, z: 0 }, d = { ...p }, hw = net.halfWidth(road);
    for (let s = 0; s <= road.len + 1e-6; s += 0.25) {
      if (net.sectionAt(road, s) !== 'ground' || existing && road.sections.some(q => Math.abs(s - q.s0) < 1 || Math.abs(s - q.s1) < 1)) continue;
      net.pointAt(road, s, p, d);
      const l = Math.hypot(d.x, d.z) || 1;
      for (const off of [-hw, -hw / 2, 0, hw / 2, hw]) {
        const x = p.x - d.z / l * off, z = p.z + d.x / l * off;
        if (height(x, z) < Math.min(existing ? w.heightAt(x, z) : Infinity, p.y - 0.35) - 1e-5) return true;
      }
    }
    return false;
  };
  for (const road of roads) if (roadUnsupported(road, view.net))
    return rail ? 'Access road conflicts with the station formation' : 'Road formation cannot be supported here';
  const pad = 5;
  for (const original of w.net.edgesNear(x0 - pad, z0 - pad, x1 + pad, z1 + pad)) {
    if (ignore.has(original.id)) continue;
    const supported = bridges.filter(q => q.edge === original.id);
    const e = supported.length ? { ...original, sections: [...original.sections, ...supported.map(q => ({ ...q, type: 'bridge' as const }))] } : original;
    if (e.kind === 'road') {
      if (roadUnsupported(e, w.net, true)) return 'Too close to road at another height';
      continue;
    }
    const old = new Map<number, Acc>();
    stampEdge(w, e, old, true);
    const fd = formationDepth(e);
    for (const [k, a] of old) {
      const next = stamps.get(k);
      if (!a.core || !next?.core) continue;
      // Rails keep the lower core; roads cannot displace rail locks. Other new cores take their surveyed height.
      const nv = w.lock[k] & LOCK.rail ? rail ? Math.min(current(k), next.hi) : current(k) : next.hi;
      const oldFloor = a.lo + fd - 0.35;
      const newFloor = next.lo + (rail ? 0.1 : 0.04) - 0.35;
      if (nv < Math.min(w.h[k], oldFloor) - 1e-5 || nv < newFloor - 1e-5)
        return e.kind === 'rail' ? 'Too close to track at another height' : 'Too close to road at another height';
    }
  }
  return null;
}

/**
 * The lowest a vertex shared with other rail formations may go and keep their tracks seated: 0.22 below the
 * running height of every other ground track whose formation core reaches it (the 0.12 any shared vertex may move,
 * from such a track's formation); Infinity beside a station or depot track (their own works level those sites).
 */
function seatFloor(w: World, x: number, z: number, own: ReadonlySet<number>): number {
  const net = w.net, r = 2.2;
  let floor = -Infinity;
  for (const q of net.edgesNear(x - r, z - r, x + r, z + r)) {
    if (q.kind !== 'rail' || own.has(q.id)) continue;
    const n = net.nearestEdge(x, z, net.halfWidth(q) + EARTHWORKS.corePad + 0.05, 'rail', (k) => k.id === q.id);
    if (!n || net.sectionAt(q, n.s) !== 'ground') continue;
    if (q.station >= 0 || q.depot >= 0) return Infinity;
    floor = Math.max(floor, net.heightAtS(q, n.s) - 0.22);
  }
  return floor;
}

/** Rounded min / max (the crest and toe of a slope), within `r` of where the two meet. */
function roundMin(cur: number, line: number, r: number): number {
  const x = cur - line;
  if (x >= r) return line;
  if (x <= -r) return cur;
  return cur - ((x + r) * (x + r)) / (4 * r);
}
function roundMax(cur: number, line: number, r: number): number {
  const y = line - cur;
  if (y >= r) return line;
  if (y <= -r) return cur;
  return cur + ((y + r) * (y + r)) / (4 * r);
}

/**
 * Shape the terrain under new edges: the formation flat over every grid cell it touches, cut and fill slopes
 * beside it (linear, rounded at crest and toe). Slopes stop at other formations, under buildings and at the
 * water (the renderer draws retaining walls there); dry land is never dug below DRY_MIN. Returns the earth
 * volume moved (vertex-height sum).
 */
export function applyEarthworks(w: World, edges: NEdge[], dryRun = false): number {
  return earthworks(w, edges, dryRun);
}

/** The same lock/building/water decisions serve actual works and sparse read-only support forecasts. */
function earthworks(w: World, edges: NEdge[], dryRun: boolean, geometryWorld = w, forecast?: Map<number, number>, terrain?: ReadonlyMap<number, number>): number {
  const stamps = new Map<number, Acc>();
  for (const e of edges) stampEdge(geometryWorld, e, stamps);
  let vol = 0;
  const s1 = w.size + 1, r = EARTHWORKS.round;
  const rail = edges.some((e) => e.kind === 'rail');
  const own = new Set(edges.map((e) => e.id));
  const changes: [number, number][] = [];
  for (const [k, a] of stamps) {
    const lock = w.lock[k];
    // under a building, or another formation's zone (beyond our own formation): left alone
    if (lock & LOCK.building || (lock & LOCK.formation && !a.core)) continue;
    const x = k % s1, z = (k / s1) | 0;
    if (x === 0 || z === 0 || x === w.size || z === w.size) continue;
    const cur = terrain?.get(k) ?? w.h[k];
    let nv: number;
    // Steep rail profiles can cross a grid cell at several heights. Keep every corner below the
    // lowest running height, so interpolated terrain cannot bury the common track's 7% grades.
    if (a.lo > a.hi) nv = rail && a.core ? a.hi : a.tnear;
    else if (a.core) nv = Math.min(a.hi, Math.max(a.lo, cur));
    else nv = roundMax(roundMin(cur, a.hi, r), a.lo, r);
    // where formations meet at different heights the vertex goes to the nearer one; a rail formation takes
    // it from a road (the road is draped over the terrain), never the other way round (not even a little:
    // a level crossing keeps the rail formation under the road)
    if (!rail && lock & LOCK.rail) continue;
    // nor does a track raise another's formation (a crossover, a widened bank, a track beside it at another
    // height behind a retaining wall): where two rail formations share ground the lower one keeps it, so the
    // terrain never buries a track (the higher one stands on its wall)
    if (rail && lock & LOCK.rail && nv > cur) continue;
    if (lock & LOCK.formation && Math.abs(nv - cur) > 0.12) {
      if (!(rail && !(lock & LOCK.rail))) {
        const near = w.net.nearestEdge(x, z, a.dmin + 0.05, rail ? 'rail' : undefined, (q) => !own.has(q.id));
        if (near && w.net.sectionAt(near.edge, near.s) === 'ground') {
          // (a lower track takes the vertex down as far as the higher ones stay seated: a track diverging beside
          // another's bridge abutment kept that formation's level over its own shoulder)
          const floor = rail && nv < cur ? seatFloor(w, x, z, own) : Infinity;
          if (!(floor < cur)) continue;
          nv = Math.max(nv, floor);
        }
      }
    }
    // never dig dry land below the water line (nor deepen water)
    if (nv < cur && nv < DRY_MIN) nv = Math.min(cur, Math.max(nv, DRY_MIN));
    if (Math.abs(nv - cur) < 0.005) continue;
    // the ground of every grid cell under a building's walls stays: a slope stops short of it (a wall), a road's
    // formation barely touches it (the road is draped); a railway's planner demolished what stood in the way
    if (Math.abs(nv - cur) > 0.1 && w.buildingsNear(x, z, 1.5).some((b) => distToRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 1.42)) {
      if (!a.core) continue;
      if (!rail) nv = cur + Math.max(-0.1, Math.min(0.1, nv - cur));
    }
    vol += Math.abs(nv - cur);
    changes.push([k, nv]);
  }
  if (forecast) for (const [k, v] of changes) forecast.set(k, Math.fround(v));
  if (!dryRun) {
    for (const [k, v] of changes) w.setVertex(k % s1, (k / s1) | 0, v);
    for (const e of edges) lockEdge(w, e);
  }
  return vol;
}

/** Height of a tunnel's lining top above the running level (rail / road), and the earth wanted above it. */
export const TUNNEL_LINING = { rail: 0.95, road: 0.8, cover: 0.4 };

/**
 * Backfill thin cover over the tunnels of new edges: the terrain is raised (never lowered) to the lining top
 * plus TUNNEL_LINING.cover across the tunnel's width, falling off smoothly to the sides; portals keep their
 * cuttings, and locked (network, buildings) and underwater vertices stay. Returns the earth volume added.
 */
export function coverTunnels(w: World, edges: NEdge[]): number {
  const net = w.net, s1 = w.size + 1;
  const want = new Map<number, number>();
  for (const e of edges) {
    const tun = e.sections.filter((sec) => sec.type === 'tunnel');
    if (!tun.length) continue;
    const g = net.geo(e);
    const core = net.halfWidth(e) + 0.9, R = core + 2.6;
    const top = (e.kind === 'rail' ? TUNNEL_LINING.rail : TUNNEL_LINING.road) + TUNNEL_LINING.cover;
    for (let i = 0; i < g.n; i++) {
      const s = g.cum[i];
      if (!tun.some((t) => s >= t.s0 + 0.8 && s <= t.s1 - 0.8)) continue;
      const px = g.pts[i * 3], pz = g.pts[i * 3 + 2], need = g.pts[i * 3 + 1] + top;
      if (w.heightAt(px, pz) >= need) continue;
      for (let z = Math.max(1, Math.floor(pz - R)); z <= Math.min(w.size - 1, Math.ceil(pz + R)); z++) {
        for (let x = Math.max(1, Math.floor(px - R)); x <= Math.min(w.size - 1, Math.ceil(px + R)); x++) {
          const d = Math.hypot(x - px, z - pz);
          if (d > R) continue;
          const k = z * s1 + x, cur = w.h[k];
          const f = d <= core ? 1 : 1 - (d - core) / (R - core), wgt = f * f * (3 - 2 * f);
          const v = cur + Math.max(0, need - cur) * wgt;
          if (v > (want.get(k) ?? cur) + 0.005) want.set(k, v);
        }
      }
    }
  }
  let vol = 0;
  for (const [k, v] of want) {
    if (w.lock[k] || w.h[k] < WATER_Y) continue;
    vol += v - w.h[k];
    w.setVertex(k % s1, (k / s1) | 0, v);
  }
  return vol;
}

/** Lock the formation zone of an edge (every vertex of the grid cells it covers) so later works leave it. */
export function lockEdge(w: World, e: NEdge) {
  const stamps = new Map<number, Acc>();
  stampEdge(w, e, stamps, true);
  const bits = LOCK.formation | (e.kind === 'rail' ? LOCK.rail : 0);
  for (const [k, a] of stamps) if (a.core) w.lock[k] |= bits;
}

/**
 * Re-grade the network formations in an area after other works changed the ground there (a station or depot
 * site levelled or removed): the locks are cleared, the ground edges' earthworks applied again (rails first:
 * they win shared vertices; then roads) and the locks recomputed. Returns the earth volume moved.
 */
export function repairFormations(w: World, x0: number, z0: number, x1: number, z1: number): number {
  const s1 = w.size + 1;
  for (let z = Math.max(0, Math.floor(z0)); z <= Math.min(w.size, Math.ceil(z1)); z++)
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w.size, Math.ceil(x1)); x++) w.lock[z * s1 + x] &= ~(LOCK.formation | LOCK.rail);
  const edges = w.net.edgesNear(x0, z0, x1, z1).filter((e) => !e.sections.some((q) => q.s0 <= 0.02 && q.s1 >= e.len - 0.02));
  let vol = 0;
  const rails = edges.filter((e) => e.kind === 'rail'), roads = edges.filter((e) => e.kind !== 'rail');
  if (rails.length) vol += applyEarthworks(w, rails);
  if (roads.length) vol += applyEarthworks(w, roads);
  recomputeLocks(w, x0, z0, x1, z1);
  return vol;
}

/** Recompute network locks in an area (after removing edges or converting sections). */
export function recomputeLocks(w: World, x0: number, z0: number, x1: number, z1: number, ungraded?: ReadonlySet<number>) {
  const s1 = w.size + 1;
  for (let z = Math.max(0, Math.floor(z0)); z <= Math.min(w.size, Math.ceil(z1)); z++)
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w.size, Math.ceil(x1)); x++) w.lock[z * s1 + x] &= ~(LOCK.formation | LOCK.rail);
  for (const e of w.net.edgesNear(x0 - 2, z0 - 2, x1 + 2, z1 + 2)) if (!ungraded?.has(e.id)) lockEdge(w, e);
}

/** Raise/lower/flatten terrain with a circular brush. Returns the volume moved. */
export function brush(w: World, cx: number, cz: number, radius: number, mode: 'raise' | 'lower' | 'level', amount: number, level = 0, dryRun = false): number {
  let vol = 0;
  for (let z = Math.max(1, Math.floor(cz - radius)); z <= Math.min(w.size - 1, Math.ceil(cz + radius)); z++) {
    for (let x = Math.max(1, Math.floor(cx - radius)); x <= Math.min(w.size - 1, Math.ceil(cx + radius)); x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > radius) continue;
      const k = w.vi(x, z);
      if (w.lock[k]) continue;
      const f = 1 - d / radius;
      const wgt = f * f * (3 - 2 * f);
      const cur = w.h[k];
      let nv = cur;
      if (mode === 'raise') nv = cur + amount * wgt;
      else if (mode === 'lower') nv = cur - amount * wgt;
      else nv = cur + (level - cur) * Math.min(1, wgt * 1.5);
      nv = Math.max(-6, Math.min(80, nv));
      // dry land is not dug below the water line
      if (nv < cur && nv < DRY_MIN) nv = Math.min(cur, DRY_MIN);
      vol += Math.abs(nv - cur);
      if (!dryRun) w.setVertex(x, z, nv);
    }
  }
  return vol;
}
