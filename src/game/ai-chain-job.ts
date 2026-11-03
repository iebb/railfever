// Durable native AI construction. Each pause owns its proposal and retry state; no work is replayed on load.
import type { Game } from './game';
import type { NNode } from './network';
import { RAIL, TRACK_TYPES, type NetKind } from './constants';
import { planEdge, commitProposal, type Snap, type Proposal, type BuildOptions } from './construction';
import { nodeSnap, nodeAt, nodeTangent, biarcJunction, newProfileCursor, stepProfileCursor, planningStep,
  type P2, type OPoint, type ChainProfile, type ChainResult, type ProfileCursor } from './routing';

function aiTerrRef(g: Game, x: number, z: number, tx: number, tz: number, tracks: number): number {
  const w = g.world;
  let h = w.heightAt(x, z);
  if (tracks > 1) {
    const o = ((tracks - 1) / 2) * RAIL.spacing;
    h = Math.max(h, w.heightAt(x - tz * o, z + tx * o), w.heightAt(x + tz * o, z - tx * o));
  }
  return h;
}

function aiProfileAt(prof: ChainProfile, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < prof.x.length; i++) { const d = (prof.x[i] - x) ** 2 + (prof.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return prof.y[best];
}

function aiGroupCentre(g: Game, nodeId: number, kind: NetKind, tracks: number): P2 {
  const n = g.world.net.nodes.get(nodeId)!;
  if (kind !== 'rail' || tracks < 2) return { x: n.x, z: n.z };
  const grp = nodeSnap(g, nodeId, kind).group ?? [nodeId];
  if (grp.length < 2) return { x: n.x, z: n.z };
  const N = Math.min(tracks, grp.length);
  const idx = Math.max(0, grp.indexOf(nodeId));
  const lo = Math.max(0, Math.min(grp.length - N, idx - Math.floor((N - 1) / 2)));
  let x = 0, z = 0;
  for (const id of grp.slice(lo, lo + N)) { const m = g.world.net.nodes.get(id)!; x += m.x; z += m.z; }
  return { x: x / N, z: z / N };
}


interface SegmentCursor {
  start: Snap; end: Snap; endY: number | null;
  highSpeed: boolean; useHeights: boolean[]; heightIndex: number; crossingIndex: number;
  last: Proposal | null; firstError: string; phase: 'quote' | 'commit'; logFailure: boolean; failed: boolean;
}
interface ChainPiece { p: P2; goal: boolean }
interface SegmentRequest { q: P2; goal: boolean; split: boolean }
/** All references here are part of the planner graph codec, including an already-quoted unpaid proposal. */
export interface AIChainCursor {
  version: 1;
  phase: 'waypoint' | 'replan' | 'profile' | 'pieces' | 'segment' | 'pieceDone' | 'done';
  startNode: number; way: OPoint[]; options: BuildOptions; goalNode: number | null;
  profile: ChainProfile | null; yEnd: number; current: number; index: number;
  result: ChainResult; a: OPoint | null; wp: OPoint | null; isGoal: boolean;
  replanNode: NNode | null; exclude: Set<number> | null; replanning: ProfileCursor | null;
  pieces: ChainPiece[]; pieceIndex: number; requests: SegmentRequest[];
  request: SegmentRequest | null; beforeError: string | undefined; segment: SegmentCursor | null;
}
export function newAIChainCursor(startNode: number, way: OPoint[], options: BuildOptions,
  goalNode: number | null, profile: ChainProfile | null): AIChainCursor {
  return { version: 1, phase: 'waypoint', startNode, way, options, goalNode, profile,
    yEnd: profile ? profile.y[profile.y.length - 1] : 0, current: startNode, index: 0,
    result: { ok: false, cost: 0, endNode: startNode, edges: 0, bridges: 0, tunnels: 0, built: 0 },
    a: null, wp: null, isGoal: false, replanNode: null, exclude: null, replanning: null,
    pieces: [], pieceIndex: 0, requests: [], request: null, beforeError: undefined, segment: null };
}
function clearOfCrossings(profile: ChainProfile | null, q: P2, from: P2): P2 {
  if (!profile || !profile.crossings.length) return q;
  const near = (p: P2) => profile.crossings.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 1.8);
  if (!near(q)) return q;
  let k = 0, bd = Infinity;
  for (let i = 0; i < profile.x.length; i++) {
    const d = (profile.x[i] - q.x) ** 2 + (profile.z[i] - q.z) ** 2;
    if (d < bd) { bd = d; k = i; }
  }
  for (let i = k - 1; i > 0; i--) {
    const p = { x: profile.x[i], z: profile.z[i] };
    if (Math.hypot(p.x - from.x, p.z - from.z) < 3) break;
    if (profile.s[k] - profile.s[i] >= 2.2 && !near(p)) return p;
  }
  return q;
}
/** Advances precisely to the next old aiChainGen yield, including the yield BEFORE a proposal is paid. */
export function stepAIChainCursor(g: Game, t: AIChainCursor, log?: (s: string) => void): IteratorResult<void, ChainResult> {
  const pause = (): IteratorResult<void, ChainResult> => ({ done: false, value: undefined });
  const finish = (): IteratorResult<void, ChainResult> => { t.phase = 'done'; return { done: true, value: t.result }; };
  const net = g.world.net, opts = t.options, res = t.result;
  while (true) {
    if (t.phase === 'done') return finish();
    if (t.phase === 'waypoint') {
      if (t.index >= t.way.length) { res.ok = true; res.endNode = t.current; return finish(); }
      const n = net.nodes.get(t.current);
      if (!n) { res.error = 'Lost the chain'; return finish(); }
      t.wp = t.way[t.index]; t.isGoal = t.index === t.way.length - 1 && t.goalNode !== null;
      const c = aiGroupCentre(g, t.current, opts.kind, opts.tracks), t0 = nodeTangent(g, t.current, t.wp);
      t.a = { x: c.x, z: c.z, tx: t0.tx, tz: t0.tz };
      if (t.profile && t.index > 0 && Math.abs(n.y - aiProfileAt(t.profile, c.x, c.z)) > 0.12) {
        t.exclude = new Set(n.edges);
        if (t.goalNode !== null) for (const id of nodeSnap(g, t.goalNode, opts.kind).group ?? [t.goalNode]) for (const e of net.nodes.get(id)?.edges ?? []) t.exclude.add(e);
        for (const id of nodeSnap(g, t.current, opts.kind).group ?? [t.current]) for (const e of net.nodes.get(id)?.edges ?? []) t.exclude.add(e);
        // The original generator retained this live node across the preliminary pause.
        t.replanNode = n; t.phase = 'replan'; return pause();
      }
      t.phase = 'pieces';
    }
    if (t.phase === 'replan') {
      t.replanning = newProfileCursor([t.a!, ...t.way.slice(t.index)], opts.tracks, t.replanNode!.y, t.yEnd,
        opts.kind, t.exclude!, false, undefined, opts.type, 256,
        opts.designGrade ? opts.designGrade / (TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).maxGrade * 0.85 : 0.85,
        (opts.designSpeed ?? (opts.type === 'highspeed' ? 180 : 0)) > 160);
      t.phase = 'profile';
    }
    if (t.phase === 'profile') {
      const r = planningStep('terrain fit', () => stepProfileCursor(g, t.replanning!)); if (!r.done) return pause();
      if (!r.value) { res.error = 'Too steep: the route left its planned heights'; log?.(`re-plan of heights failed at waypoint ${t.index}`); return finish(); }
      t.profile = r.value; t.replanning = null; t.replanNode = null; t.exclude = null; t.phase = 'pieces';
    }
    if (t.phase === 'pieces') {
      const a = t.a!, wp = t.wp!, L = Math.hypot(wp.x - a.x, wp.z - a.z), minLeg = 1.2;
      if (L < minLeg && !t.isGoal) { t.index++; t.phase = 'waypoint'; continue; }
      const ux = (wp.x - a.x) / L, uz = (wp.z - a.z) / L;
      const straight = a.tx * ux + a.tz * uz > 0.9995 && wp.tx * ux + wp.tz * uz > 0.9995;
      t.pieces = [];
      if (!straight) {
        const j = biarcJunction(a, wp);
        if (j && Math.hypot(j.x - a.x, j.z - a.z) > minLeg && Math.hypot(wp.x - j.x, wp.z - j.z) > minLeg) t.pieces.push({ p: j, goal: false });
      }
      t.pieces.push({ p: wp, goal: t.isGoal }); t.pieceIndex = 0; t.phase = 'pieceDone';
    }
    if (t.phase === 'pieceDone') {
      if (t.pieceIndex >= t.pieces.length) { t.index++; t.phase = 'waypoint'; continue; }
      const p = t.pieces[t.pieceIndex];
      t.requests = [{ q: p.goal ? p.p : clearOfCrossings(t.profile, p.p, net.nodes.get(t.current) ?? p.p), goal: p.goal, split: true }];
      t.request = null; t.segment = null; t.phase = 'segment';
    }
    if (t.phase === 'segment') {
      if (!t.request) {
        if (!t.requests.length) { t.pieceIndex++; t.phase = 'pieceDone'; return pause(); }
        t.request = t.requests.shift()!;
        const q = t.request, start = nodeSnap(g, t.current, opts.kind);
        const end: Snap = q.goal ? nodeSnap(g, t.goalNode!, opts.kind) : { kind: 'free', x: q.q.x, z: q.q.z, y: g.world.heightAt(q.q.x, q.q.z) };
        const endY = q.goal || !t.profile ? null : aiProfileAt(t.profile, q.q.x, q.q.z);
        const highSpeed = (opts.designSpeed ?? (opts.type === 'highspeed' ? 180 : 0)) > 160;
        t.beforeError = res.error;
        t.segment = { start, end, endY, highSpeed, useHeights: endY !== null ? highSpeed ? [true] : [true, false] : [false],
          heightIndex: 0, crossingIndex: 0, last: null, firstError: '', phase: 'quote', logFailure: !q.split || q.goal, failed: false };
      }
      const s = t.segment!;
      if (s.phase === 'commit') {
        const p = s.last!; s.phase = 'quote'; s.crossingIndex++;
        if (p.ok) {
          if (p.warnings.includes('Not enough money')) { res.error = 'Not enough money'; return finish(); }
          const err = commitProposal(g, p);
          if (err) { res.error = err; s.failed = true; }
          else {
          if (s.firstError) (res.notes ??= []).push(`end height relaxed: ${s.firstError}`);
          res.cost += p.cost; res.edges += p.tracks.length; res.bridges += p.stats.bridges; res.tunnels += p.stats.tunnels; res.built += p.stats.len;
          if (t.request!.goal) t.current = t.goalNode!;
          else {
            const tp = p.tracks[Math.floor((p.tracks.length - 1) / 2)], nn = nodeAt(g, opts.kind, tp.bez.x3, tp.bez.z3);
            if (!nn) { res.error = 'End node missing'; return finish(); }
            t.current = nn.id;
          }
          t.request = null; t.segment = null; continue;
          }
        }
      }
      const tries: Partial<BuildOptions>[] = s.highSpeed ? [{}, { crossing: 'over' }, { crossing: 'under' }] : [{}, { crossing: 'level' }, { crossing: 'over' }, { crossing: 'under' }];
      if (s.crossingIndex >= tries.length) { s.crossingIndex = 0; s.heightIndex++; }
      if (s.failed || s.heightIndex >= s.useHeights.length) {
        const last = s.last; if (!s.failed) res.error = last ? last.errors.join(', ') : 'Cannot build';
        if (!s.failed && last && s.logFailure && log) {
          const sn = s.start.kind === 'node' ? net.nodes.get(s.start.node!) : undefined;
          log(`segment failed: ${res.error} (start y ${sn?.y.toFixed(2)}, end y ${s.endY?.toFixed(2)}, crossings ${last.crossings.map((c) => { const e = net.edges.get(c.edge)!; return `${c.mode}@${c.sNew.toFixed(1)}/${last.tracks[c.track].len.toFixed(1)} ${e.kind}${e.owner} #${e.id} y${net.heightAtS(e, c.sOld).toFixed(2)} ${net.sectionAt(e, c.sOld)}`; }).join(', ')})`);
        }
        const q = t.request!;
        if (!q.split || q.goal || res.error === 'Not enough money') return finish();
        const c = aiGroupCentre(g, t.current, opts.kind, opts.tracks), tangent = nodeTangent(g, t.current, q.q), L = Math.hypot(q.q.x - c.x, q.q.z - c.z);
        if (L < 4) return finish();
        const ux = (q.q.x - c.x) / L, uz = (q.q.z - c.z) / L, dp = tangent.tx * ux + tangent.tz * uz;
        const tq = { tx: 2 * dp * ux - tangent.tx, tz: 2 * dp * uz - tangent.tz };
        const m = biarcJunction({ x: c.x, z: c.z, ...tangent }, { x: q.q.x, z: q.q.z, ...tq });
        res.error = t.beforeError;
        if (!m) return finish();
        t.requests.unshift({ q: m, goal: false, split: false }, { q: q.q, goal: false, split: false });
        t.request = null; t.segment = null; continue;
      }
      const useH = s.useHeights[s.heightIndex];
      if (!s.crossingIndex && !useH && s.endY !== null && s.last) s.firstError = s.last.errors.join(', ') + ` (crossings ${s.last.crossings.map((c) => c.mode).join('/')})`;
      const o = { ...opts, ...tries[s.crossingIndex] };
      if (useH && s.endY !== null && s.end.kind === 'free') {
        const cl = Math.hypot(s.end.x - s.start.x, s.end.z - s.start.z) || 1;
        o.heightOffset = s.endY - aiTerrRef(g, s.end.x, s.end.z, (s.end.x - s.start.x) / cl, (s.end.z - s.start.z) / cl,
          s.start.group && s.start.group.length > 1 ? s.start.group.length : opts.tracks);
        if (Math.abs(o.heightOffset) < 1e-3) o.heightOffset = 1e-3;
      } else o.heightOffset = 0;
      s.last = planEdge(g, s.start, s.end, o); s.phase = 'commit'; return pause();
    }
  }
}
/** A thin iterator adapter; initialization happens synchronously before the first next() call. */
export function aiChainCursorGen(g: Game, task: AIChainCursor, log?: (s: string) => void): Generator<void, ChainResult> {
  return (function* () { while (true) { const r = stepAIChainCursor(g, task, log); if (r.done) return r.value; yield; } })();
}
