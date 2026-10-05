// Compact station facilities mounted on real running rail. The payer owns the facility;
// the running rail keeps its owner, geometry, height profile, wire and signals.
import type { Game } from './game';
import type { NEdge } from './network';
import type { OnTrackOpts, OnTrackPlan } from './trackops';
import type { StationLayout } from './stations';
import { PSTEP } from './constants';
import { defaultPlatformLength, railModeOf } from './stations';
import { bezSplit, bezReverse, tAtS, arcTable, bezMinRadius } from './geom';
import type { RailTrackStep, RailTrackGroup, RailGeometryTrack, RailGeometryPiece, RailStationAlignment } from './station-geometry';
import { commitProposal } from './construction';

export interface NativeStationPlan {
  edge: number; s: number; options: OnTrackOpts;
  stamp: string;
  tracks: { steps: RailTrackStep[]; cut: [number, number]; through: boolean; offset: number }[];
}
interface Chain { steps: RailTrackStep[]; length: number; seed: number }
interface Point { x: number; y: number; z: number; fx: number; fz: number; edge: number; s: number }

function stamp(g: Game): string {
  return `${g.world.net.version}|${g.world.heightsVersion}|${g.world.lotVersions.version}|${g.stations.walkVersion}`;
}
function chain(g: Game, seed: NEdge, reach: number): Chain {
  const net = g.world.net, seen = new Set<number>([seed.id]);
  const walk = (dir: 1 | -1) => {
    const out: RailTrackStep[] = [];
    let e = seed, d: number = dir, length = 0;
    while (length < reach) {
      const n = net.nodes.get(d > 0 ? e.b : e.a);
      if (!n || n.edges.length !== 2) break;
      const next = net.nextRail(e, d);
      if (next.length !== 1) break;
      const q = next[0];
      if (q.edge.kind !== 'rail' || q.edge.station >= 0 || q.edge.depot >= 0 || seen.has(q.edge.id)) break;
      seen.add(q.edge.id); out.push({ edge: q.edge.id, dir: q.dir as 1 | -1 });
      length += q.edge.len; e = q.edge; d = q.dir;
    }
    return out;
  };
  const back = walk(-1), front = walk(1);
  const steps = [...back.reverse().map((q) => ({ edge: q.edge, dir: -q.dir as 1 | -1 })), { edge: seed.id, dir: 1 as const }, ...front];
  const seedS = back.reduce((n, q) => n + net.edges.get(q.edge)!.len, 0);
  return { steps, length: steps.reduce((n, q) => n + net.edges.get(q.edge)!.len, 0), seed: seedS };
}
function at(g: Game, c: Chain, u: number): Point {
  const net = g.world.net;
  u = Math.max(0, Math.min(c.length, u));
  let q = c.steps[c.steps.length - 1], e = net.edges.get(q.edge)!;
  for (const st of c.steps) { q = st; e = net.edges.get(st.edge)!; if (u <= e.len) break; u -= e.len; }
  const s = q.dir > 0 ? u : e.len - u, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(e, s, p, d);
  const l = Math.hypot(d.x, d.z) || 1;
  return { ...p, fx: d.x / l * q.dir, fz: d.z / l * q.dir, edge: e.id, s };
}
function nearest(g: Game, c: Chain, x: number, z: number): number | null {
  const ids = new Set(c.steps.map((q) => q.edge));
  const q = g.world.net.nearestEdge(x, z, 2, 'rail', (e) => ids.has(e.id));
  if (!q) return null;
  let u = 0;
  for (const st of c.steps) {
    const e = g.world.net.edges.get(st.edge)!;
    if (e.id === q.edge.id) return u + (st.dir > 0 ? q.s : e.len - q.s);
    u += e.len;
  }
  return null;
}

/** Copy the exact subcurves and profile into saved facility geometry, in station back-to-front order. */
function geometry(g: Game, c: Chain, cut: [number, number], offset: number): RailGeometryTrack {
  const net = g.world.net, pieces: RailGeometryPiece[] = [];
  let u = 0;
  for (const q of c.steps) {
    const e = net.edges.get(q.edge)!, a = Math.max(0, cut[0] - u), b = Math.min(e.len, cut[1] - u);
    u += e.len;
    if (b <= a + 1e-6) continue;
    const s0 = q.dir > 0 ? a : e.len - b, s1 = q.dir > 0 ? b : e.len - a;
    const t0 = tAtS(net.table(e), s0), t1 = tAtS(net.table(e), s1);
    let curve = { ...e.bez };
    if (t1 < 1) curve = bezSplit(curve, t1)[0];
    if (t0 > 0) curve = bezSplit(curve, t0 / Math.max(1e-9, t1))[1];
    if (q.dir < 0) curve = bezReverse(curve);
    const length = arcTable(curve).len, n = Math.max(2, Math.ceil(length / PSTEP) + 1);
    const profile = Array.from({ length: n }, (_, i) => {
      const f = Math.min(i * PSTEP, length) / length;
      return net.heightAtS(e, q.dir > 0 ? s0 + (s1 - s0) * f : s1 - (s1 - s0) * f);
    });
    pieces.push({ curve, length, profile });
  }
  return { offset, pieces, length: pieces.reduce((n, p) => n + p.length, 0), knots: [] };
}

export function planNativeStationOnTrack(g: Game, edgeId: number, s: number, o: OnTrackOpts, owner: number): OnTrackPlan {
  const net = g.world.net;
  const plan: OnTrackPlan = { ok: true, warnings: [], cost: 0, owner, station: null, mains: [], feeds: [], feedTrack: [], throat: [] };
  const fail = (error: string) => { plan.ok = false; plan.error = error; return plan; };
  const e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail') return fail('No track here');
  if (e.station >= 0 || e.depot >= 0) return fail('Already a station or depot track');
  const denied = g.trackUpgradeError(owner, e.owner);
  if (denied) return fail(denied);
  if (!Number.isFinite(s) || (o.length !== undefined && !Number.isFinite(o.length)) || (o.tracks !== undefined && (!Number.isInteger(o.tracks) || o.tracks < 1))) return fail('Invalid station dimensions');
  s = Math.max(0, Math.min(e.len, s));
  const L = Math.max(4, Math.min(40, o.length ?? defaultPlatformLength(o.mode ?? e.type)));
  const A = chain(g, e, L / 2 + 3), uc = A.seed + Math.max(0, Math.min(e.len, s)), q = at(g, A, uc);
  if (uc - L / 2 < 0.3 || uc + L / 2 > A.length - 0.3) return fail(`Needs ${Math.round(L * 10)} m of plain track`);
  const rows: { chain: Chain; lat: number }[] = [{ chain: A, lat: 0 }];
  const used = new Set(A.steps.map((t) => t.edge));
  for (const candidate of [...net.edgesNear(q.x - 1.7, q.z - 1.7, q.x + 1.7, q.z + 1.7)].sort((a, b) => a.id - b.id)) {
    if (candidate.kind !== 'rail' || candidate.station >= 0 || candidate.depot >= 0 || used.has(candidate.id)) continue;
    const C = chain(g, candidate, L / 2 + 5), v = nearest(g, C, q.x, q.z);
    if (v === null) continue;
    const p = at(g, C, v), lat = (p.x - q.x) * q.fz - (p.z - q.z) * q.fx;
    if (Math.abs(lat) < 0.3 || Math.abs(lat) > 1.6 || Math.abs(p.y - q.y) > 0.15 || Math.abs(p.fx * q.fx + p.fz * q.fz) < 0.99) continue;
    if (p.fx * q.fx + p.fz * q.fz < 0) { C.steps.reverse(); for (const t of C.steps) t.dir = -t.dir as 1 | -1; C.seed = C.length - C.seed - candidate.len; }
    if (rows.some((r) => Math.abs(r.lat - lat) < 0.15)) continue;
    rows.push({ chain: C, lat }); for (const t of C.steps) used.add(t.edge);
  }
  if (rows.length > 4) return fail('At most four existing running tracks');
  rows.sort((a, b) => a.lat - b.lat);
  const mid = (rows[0].lat + rows[rows.length - 1].lat) / 2;
  const P = Math.min(o.tracks ?? Math.min(2, rows.length), Math.min(2, rows.length));
  if (P < 1 || rows.length - P > 2) return fail('Existing formation needs two outside platform tracks');
  if ((o.tracks ?? P) > 2 && rows.length > 2) return fail('Interior platforms need wider track spacing');
  if (o.platformStyle === 'island' && rows.length > 1) return fail('Existing close tracks need outside side platforms');
  const platformRows = P === 2 ? [0, rows.length - 1] : [Math.abs(rows[0].lat) <= Math.abs(rows[rows.length - 1].lat) ? 0 : rows.length - 1];
  const offsets = rows.map((r) => r.lat - mid), PW = 0.56, gap = 0.21;
  const layout: StationLayout = { trackOffsets: [], throughOffsets: [], platforms: [], width: 0 };
  rows.forEach((r, i) => (platformRows.includes(i) ? layout.trackOffsets : layout.throughOffsets).push(offsets[i]));
  for (const i of platformRows) layout.platforms.push({ off: offsets[i] + (i === 0 ? -1 : 1) * (PW / 2 + gap), w: PW });
  const lo = Math.min(offsets[0] - 0.2, ...layout.platforms.map((p) => p.off - p.w / 2));
  const hi = Math.max(offsets[offsets.length - 1] + 0.2, ...layout.platforms.map((p) => p.off + p.w / 2));
  // One platform on a single track is deliberately asymmetric; the geometry uses its exact offset.
  layout.width = 2 * Math.max(Math.abs(lo), Math.abs(hi)) + 0.08;
  const alignment: RailStationAlignment = { tracks: [] }, tracks: NativeStationPlan['tracks'] = [];
  const ignore = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const C = rows[i].chain, p0 = at(g, A, uc - L / 2), p1 = at(g, A, uc + L / 2);
    const v0 = nearest(g, C, p0.x, p0.z), v1 = nearest(g, C, p1.x, p1.z);
    if (v0 === null || v1 === null || v1 - v0 < L * 0.8 || v0 < 0.1 || v1 > C.length - 0.1) return fail('Tracks do not continue alongside the whole platform');
    const cut: [number, number] = [v0, v1], geo = geometry(g, C, cut, offsets[i]);
    const n = Math.max(2, Math.ceil(L / 0.4));
    let previous = -Infinity;
    for (let k = 0; k <= n; k++) {
      const u = L * k / n, p = at(g, A, uc - L / 2 + u), v = nearest(g, C, p.x, p.z);
      if (v === null || v < previous - 0.01) return fail('Tracks do not run parallel through this site');
      previous = v;
      const b = at(g, C, v), lat = (b.x - p.x) * p.fz - (b.z - p.z) * p.fx;
      if (Math.abs(lat - rows[i].lat) > 0.06 || Math.abs(b.fx * p.fx + b.fz * p.fz) < 0.985) return fail('Tracks spread or cross within the platforms');
      if (Math.abs(b.y - q.y) > 0.15) return fail('Grade: platforms need near-level track');
      if (net.sectionAt(net.edges.get(b.edge)!, b.s) !== net.sectionAt(e, s)) return fail('Station cannot cross a bridge or tunnel end');
      geo.knots.push({ u, s: Math.max(0, Math.min(geo.length, (v - v0) * geo.length / (v1 - v0))) });
    }
    for (const p of geo.pieces) if (bezMinRadius(p.curve) <= PW + gap + 0.3) return fail('Curve too tight for safe platform clearance');
    alignment.tracks.push(geo);
    tracks.push({ steps: C.steps.map((t) => ({ ...t })), cut, through: !platformRows.includes(i), offset: offsets[i] });
    plan.mains.push({ steps: C.steps.map((t) => ({ ...t })), cut, lat: offsets[i] });
    let walked = 0;
    for (const t of C.steps) {
      const f = net.edges.get(t.edge)!;
      if (walked < cut[1] && walked + f.len > cut[0]) { const err = g.trackUpgradeError(owner, f.owner); if (err) return fail(err); }
      walked += f.len; ignore.add(t.edge);
    }
  }
  const level = o.level ?? (net.sectionAt(e, s) === 'tunnel' ? 'underground' : net.sectionAt(e, s) === 'bridge' ? 'elevated' : 'ground');
  if ((level === 'ground' ? 'ground' : level === 'elevated' ? 'bridge' : 'tunnel') !== net.sectionAt(e, s)) return fail('Station must stay at the existing track level');
  const cx = q.x + q.fz * mid, cz = q.z - q.fx * mid;
  const st = g.stations.planRail(cx, cz, Math.atan2(q.fx, q.fz), L, P, owner, {
    alignment, layout, level, fixedY: q.y, ignoreEdges: ignore, trackType: e.type,
    mode: o.mode ?? railModeOf(e.type), platformStyle: 'side', through: rows.length - P, throughMode: 'middle',
    psd: o.psd, style: o.style, blockedEnds: [1, -1],
  });
  plan.station = st;
  if (!st.ok) return fail(st.error ?? 'Cannot build the station here');
  plan.cost = st.cost; plan.warnings.push(...st.warnings);
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  plan.native = { edge: edgeId, s, options: { ...o }, stamp: stamp(g), tracks };
  return plan;
}

export function commitNativeStationOnTrack(g: Game, plan: OnTrackPlan): { error: string | null; station: number } {
  const n = plan.native, net = g.world.net;
  if (!plan.ok || !plan.station || !n) return { error: plan.error ?? 'Cannot build', station: -1 };
  if (stamp(g) !== n.stamp) return { error: 'The site changed, plan again', station: -1 };
  for (const t of n.tracks) {
    let u = 0;
    for (const q of t.steps) {
      const e = net.edges.get(q.edge);
      if (!e) return { error: 'The track changed, plan again', station: -1 };
      if (u < t.cut[1] && u + e.len > t.cut[0]) {
        const denied = g.trackUpgradeError(plan.owner, e.owner);
        if (denied) return { error: denied, station: -1 };
        if (g.vehicles.isEdgeBusy(e.id)) return { error: 'busy', station: -1 };
      }
      u += e.len;
    }
  }
  if (!g.company(plan.owner).economy.canAfford(plan.cost)) return { error: 'Not enough money', station: -1 };
  // Street work also checks moving road traffic before spending or splitting rail.
  if (plan.station.access) {
    const err = commitProposal(g, plan.station.access);
    if (err) return { error: err, station: -1 };
  }
  // All rejection happens before splitting. Native construction thereafter only splits valid plain intervals
  // and attaches the preflighted facility; no rail is removed or transferred to the facility owner.
  const lists = n.tracks.map((t) => t.steps.map((q) => ({ ...q })));
  const onSplit = (old: NEdge, a: NEdge, b: NEdge) => {
    for (const steps of lists) {
      const i = steps.findIndex((q) => q.edge === old.id);
      if (i < 0) continue;
      const d = steps[i].dir;
      steps.splice(i, 1, ...(d > 0 ? [{ edge: a.id, dir: 1 as const }, { edge: b.id, dir: 1 as const }] : [{ edge: b.id, dir: -1 as const }, { edge: a.id, dir: -1 as const }]));
    }
  };
  net.onSplit.push(onSplit);
  const groups: RailTrackGroup[] = [];
  try {
    for (let i = 0; i < n.tracks.length; i++) {
      const t = n.tracks[i], steps = lists[i], ends: number[] = [];
      for (const end of [1, 0]) {
        const C = { steps, length: steps.reduce((v, q) => v + net.edges.get(q.edge)!.len, 0), seed: 0 };
        const p = at(g, C, t.cut[end]), e = net.edges.get(p.edge)!;
        if (p.s <= 0.05) ends[end] = e.a;
        else if (p.s >= e.len - 0.05) ends[end] = e.b;
        else ends[end] = net.splitEdge(e.id, p.s)!.node.id;
      }
      const inside: RailTrackStep[] = [];
      let reached = false;
      for (const q of steps) {
        const e = net.edges.get(q.edge)!, a = q.dir > 0 ? e.a : e.b, b = q.dir > 0 ? e.b : e.a;
        if (a === ends[0]) reached = true;
        if (reached) inside.push({ ...q });
        if (reached && b === ends[1]) break;
      }
      groups.push({ id: inside[0].edge, through: t.through, offset: t.offset, steps: inside, back: ends[0], front: ends[1], length: inside.reduce((v, q) => v + net.edges.get(q.edge)!.len, 0) });
    }
  } finally { net.onSplit = net.onSplit.filter((f) => f !== onSplit); }
  // Save the exact built subcurves, including endpoint snaps and Network's split profile sampling.
  const alignment = { tracks: groups.map((q, i) => {
    const C = { steps: q.steps, length: q.length, seed: 0 }, built = geometry(g, C, [0, q.length], q.offset);
    const old = plan.station!.alignment!.tracks[i];
    built.knots = old.knots.map((k) => ({ u: k.u, s: k.s * built.length / Math.max(1e-9, old.length) }));
    return built;
  }) };
  return g.stations.commitNativeRail({ ...plan.station, alignment }, plan.owner, groups, true);
}
