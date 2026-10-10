// The way on beyond a terminus: where a line ends, the ground straight on beyond its platforms stays free so that the
// line can run on from there (lines and stations are extendable; when the city grows the line grows with it). AI depots
// and their sidings keep out of it (depot-sites.ts; routing.ts buildDepotOnLine). The player's depot tool is not bound.
import type { Game } from './game';
import type { Station } from './stations';

export interface P2 { x: number; z: number }

/** The way on beyond one terminal platform end: its middle, the outward unit direction and the half width kept free. */
export interface OnwardEnd { station: number; x: number; z: number; ux: number; uz: number; half: number }

/** Units straight on beyond a terminal platform end that stay free, and the room beside the outer tracks. */
export const ONWARD_REACH = 48;
export const ONWARD_PAD = 6;
/** Plain track beyond the platforms (stubs, buffers, depot leads) up to this length still leaves the end a line end. */
const END_TRACK = 60;

/**
 * Is this end of a station's platforms the end of the line (nothing runs on beyond it): free track ends, or plain track
 * within END_TRACK units that reaches no other station (buffers, stubs, a depot lead)? A station with through tracks
 * is never one.
 */
export function terminalEnd(g: Game, st: Station, end: 'front' | 'back'): boolean {
  const net = g.world.net, r = st.rail;
  if (!r || r.throughEdges.length) return false;
  const heads = g.stations.trackEnds(st).map((t) => t[end]).filter((id) => net.nodes.has(id));
  if (!heads.length) return false;
  const seen = new Set<number>(r.edges), nodes = new Set<number>(heads), stack = [...heads];
  let length = 0;
  while (stack.length) {
    const n = net.nodes.get(stack.pop()!);
    if (!n) continue;
    for (const id of n.edges) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || e.depot >= 0) continue;
      if (e.station >= 0 || g.stations.throughStationOf(id) >= 0) return false;
      length += e.len;
      if (length > END_TRACK) return false;
      const o = e.a === n.id ? e.b : e.a;
      if (!nodes.has(o)) { nodes.add(o); stack.push(o); }
    }
  }
  return true;
}

/** The way on beyond an end of a station's platforms (its heads' middle, outward direction, half width). */
export function onwardEnd(g: Game, st: Station, end: 'front' | 'back'): OnwardEnd | null {
  const net = g.world.net, r = st.rail;
  if (!r) return null;
  const heads = g.stations.trackEnds(st).map((t) => ({ node: net.nodes.get(t[end]), edge: net.edges.get(t.edge) }))
    .filter((h) => !!h.node);
  if (!heads.length) return null;
  let x = 0, z = 0, ux = 0, uz = 0;
  for (const h of heads) {
    x += h.node!.x; z += h.node!.z;
    // outward: away from the platform track at its end (curved platforms included)
    const own = h.node!.edges.map((id) => net.edges.get(id)).find((e) => !!e && e.station === st.id) ?? h.edge;
    if (own) { const d = net.leaveDir(own, h.node!.id); ux -= d.x; uz -= d.z; }
  }
  x /= heads.length; z /= heads.length;
  let l = Math.hypot(ux, uz);
  if (l < 1e-6) {
    const sg = end === 'front' ? 1 : -1;
    ux = Math.sin(r.angle) * sg; uz = Math.cos(r.angle) * sg; l = 1;
  }
  ux /= l; uz /= l;
  let spread = 0;
  for (const h of heads) spread = Math.max(spread, Math.abs((h.node!.x - x) * uz - (h.node!.z - z) * ux));
  return { station: st.id, x, z, ux, uz, half: Math.max(spread, (r.width ?? 2) / 2) + ONWARD_PAD };
}

/** The ways on beyond the terminal platform ends of rail stations within `r` of (x, z) (any company's). */
export function onwardEnds(g: Game, x: number, z: number, r: number): OnwardEnd[] {
  const out: OnwardEnd[] = [];
  for (const st of g.stations.map.values()) {
    const rr = st.rail;
    if (!rr || Math.hypot(rr.x - x, rr.z - z) > rr.length / 2 + ONWARD_REACH + r) continue;
    for (const end of ['front', 'back'] as const) {
      if (!terminalEnd(g, st, end)) continue;
      const o = onwardEnd(g, st, end);
      if (o) out.push(o);
    }
  }
  return out;
}

/** Does point p lie on the way on beyond one of these ends (straight on beyond the platforms, within their width)? */
export function inOnward(p: P2, ends: readonly OnwardEnd[]): boolean {
  for (const e of ends) {
    const dx = p.x - e.x, dz = p.z - e.z, along = dx * e.ux + dz * e.uz;
    if (along < -0.5 || along > ONWARD_REACH) continue;
    if (Math.abs(dx * e.uz - dz * e.ux) < e.half) return true;
  }
  return false;
}

/** Corners, edge middles and centre of a rectangle (x, z, angle, w across, d along). */
export function rectPoints(x: number, z: number, angle: number, w: number, d: number): P2[] {
  const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx, out: P2[] = [];
  for (const a of [-0.5, 0, 0.5]) for (const b of [-0.5, 0, 0.5]) out.push({ x: x + rx * w * a + fx * d * b, z: z + rz * w * a + fz * d * b });
  return out;
}
