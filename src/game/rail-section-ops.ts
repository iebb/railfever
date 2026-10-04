/**
 * Stage 3/5 entry points (synchronous; previews never allocate durable IDs or mutate the game):
 *   planRailSection(game, start: Snap, end: Snap, RailSectionBuildOptions) -> RailSectionPlan
 *   planSectionCount(game, sectionId, 1..4, { side?, user?, traffic? }) -> RailSectionPlan
 *   commitRailSectionPlan(game, plan) -> { error, cost, section?, edges? }
 * BuildOptions + optional tangents {start,end} (unit travel vectors) builds straight or curved free spans.
 * New builds retain the original construction alignment; count edits retain every surviving edge/node.
 * side: right/left/both/auto; positive offsets are right of the stable reference direction. Auto compares
 * complete quotes, right first on ties. Slot IDs are allocated in lateral order and never renumbered.
 * Plans expose symbolic additions, retained/removal IDs, correspondence and the complete quoted cost.
 * Commit checks dependencies, rights, cash and occupation/reservations again, applies the diff in slot/
 * reference order, charges once and emits one network change. Exceptional failures restore object identity,
 * map/adjacency order, allocators, caches, reservations, economies, terrain/locks and dirty state.
 * Stage 2 supports open ground spans. Connected ends, stations, depots, crossings, shared structures and
 * directional signal changes return errors; no half-junctions, work queues or player controls are installed.
 * Unadopted legacy edges have a read-only view; explicit RailSections.adoptUnassigned() follows final ownership.
 */
import type { Game } from './game';
import type { NEdge } from './network';
import { planEdge, type Snap, type BuildOptions } from './construction';
import { RAIL, TRACK_TYPES, trackTypeOf } from './constants';
import { COSTS } from './economy';
import { arcTable, bezPoint, bezDeriv, tAtS, type V2 } from './geom';
import { applyEarthworks, recomputeLocks } from './terraform';
import { alignmentOf, offsetRailAlignment, type RailOffsetPiece } from './rail-offsets';
import type { RailAlignment, RailSection, RailSlot, TrackCount, SectionTraffic } from './rail-section-types';

export type RailSectionSide = 'auto' | 'right' | 'left' | 'both';
export interface RailSectionBuildOptions extends BuildOptions { tangents?: { start: V2; end: V2 } }
export interface SectionCountOptions { side?: RailSectionSide; user?: number; traffic?: SectionTraffic['policy'] }
export interface RailSectionDiff {
  retained: number[];
  additions: { offset: number; pieces: RailOffsetPiece[] }[];
  removedSlots: number[];
  removedEdges: number[];
  demolish: number[];
  trees: number[];
  /** Stage 2 never splits or changes a retained edge/signal. Later stages extend this diff. */
  splits: { edge: number; s: number }[];
  signals: { node: number; signal: number }[];
}
export interface RailSectionPlan {
  ok: boolean;
  error?: string;
  cost: number;
  payer: number;
  infrastructureOwner: number;
  section: number | null;
  count: TrackCount;
  side: RailSectionSide;
  type: string;
  alignment: RailAlignment;
  traffic: SectionTraffic;
  diff: RailSectionDiff;
}
export interface RailSectionCommit { error: string | null; cost: number; section?: number; edges?: number[] }
type Intent = { kind: 'build'; start: Snap; end: Snap; opts: RailSectionBuildOptions } | { kind: 'count'; section: number; count: TrackCount; opts: SectionCountOptions };
type Dependencies = { key: string; heights: Float32Array; locks: Uint8Array };
const plans = new WeakMap<RailSectionPlan, { game: Game; dependencies: Dependencies; signature: string; intent: Intent }>();
const copy = <T>(x: T): T => structuredClone(x);

function stateKey(g: Game): string {
  const n = g.world.net, w = g.world;
  return JSON.stringify({ network: n.version, nodes: [...n.nodes.values()],
    edges: [...n.edges.values()].map((e) => ({ ...e, prof: Array.from(e.prof) })), crossings: [...n.crossings.values()],
    allocators: [n.nextNode, n.nextEdge, n.nextCrossing], sections: g.railSections.toJSON(),
    stations: [...g.stations.map.values()].map((s) => [s.id, s.owner, s.rail]), depots: [...g.depots.map.values()],
    holds: g.stations.saveWorks(), heightVersion: w.heightsVersion, lots: [...w.buildings.values()], trees: w.trees,
    lotVersion: w.lotVersions.version, terrainVersion: w.terrainVersions.version });
}
function seal(g: Game, p: RailSectionPlan, intent: Intent): RailSectionPlan {
  plans.set(p, { game: g, dependencies: { key: stateKey(g), heights: g.world.h.slice(), locks: g.world.lock.slice() }, signature: JSON.stringify(p), intent: copy(intent) });
  return p;
}
function empty(g: Game, count: TrackCount, user: number, owner: number, type: string, section: number | null, side: RailSectionSide): RailSectionPlan {
  return { ok: true, cost: 0, payer: user, infrastructureOwner: owner, section, count, side, type,
    alignment: { length: 0, pieces: [] }, traffic: { policy: 'two-way', signals: [] },
    diff: { retained: [], additions: [], removedSlots: [], removedEdges: [], demolish: [], trees: [], splits: [], signals: [] } };
}
function fail(p: RailSectionPlan, error: string) { p.ok = false; p.error = error; return p; }
function validCount(n: number): n is TrackCount { return Number.isInteger(n) && n >= 1 && n <= 4; }

/** Original construction curve/profile, followed by deterministic, refined offsets with independent lengths. */
export function planRailSection(g: Game, start: Snap, end: Snap, opts: RailSectionBuildOptions): RailSectionPlan {
  const count = opts.tracks as TrackCount, owner = opts.infrastructureOwner ?? opts.owner;
  const p = empty(g, count, opts.owner, owner, trackTypeOf(opts.type), null, 'both');
  const intent: Intent = { kind: 'build', start, end, opts };
  if (g.railSections.compatibilityError) return seal(g, fail(p, g.railSections.compatibilityError), intent);
  if (opts.kind !== 'rail' || !validCount(count)) return seal(g, fail(p, 'Track count: 1–4'), intent);
  if ([start.x, start.y, start.z, end.x, end.y, end.z].some((v) => !Number.isFinite(v)) || opts.tangents && [opts.tangents.start, opts.tangents.end].some((t) => !Number.isFinite(t.x + t.z) || Math.hypot(t.x, t.z) < 1e-8)) return seal(g, fail(p, 'Invalid alignment'), intent);
  const rights = g.trackUpgradeError(opts.owner, owner);
  if (rights) return seal(g, fail(p, rights), intent);
  if (opts.town) return seal(g, fail(p, 'Company rail only'), intent);
  for (const sn of [start, end]) if (sn.kind !== 'free') return seal(g, fail(p, 'Connected end: stage 3'), intent);
  if (opts.level && opts.level !== 'ground') return seal(g, fail(p, 'Structures: stage 4'), intent);
  const seedOpts = { ...opts, tracks: 1, type: p.type };
  const seedPlan = (options: BuildOptions) => opts.tangents ? g.world.net.withTemporaryNodes('rail', [
      { ...start, dx: opts.tangents.start.x, dz: opts.tangents.start.z },
      { ...end, y: end.y + opts.heightOffset, dx: -opts.tangents.end.x, dz: -opts.tangents.end.z },
    ], owner, ([a, b]) => planEdge(g, { ...start, kind: 'node', node: a.id }, { ...end, kind: 'node', node: b.id }, options)) : planEdge(g, start, end, options);
  let seed = seedPlan(seedOpts);
  if (!seed.ok || seed.crossings.length || seed.tracks[0]?.sections.length) return seal(g, fail(p, seed.errors[0] ?? (seed.crossings.length ? 'Crossings: stage 3' : 'Structures: stage 4')), intent);
  p.alignment = seed.railAlignment ?? alignmentOf(seed.tracks[0].bez, seed.tracks[0].prof);
  const offsets = Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * RAIL.spacing);
  if (count > 1) {
    // A fresh reference profile may be fitted more gently. Its grade budget must account for the
    // shortest member's local ds/du, rather than applying the centre's grade to every offset.
    try {
      let ratio = 1;
      for (const off of offsets) for (const piece of offsetRailAlignment(p.alignment, off, TRACK_TYPES[p.type].minRadius, Infinity)) {
        for (let i = 1; i < piece.knots.length; i++) ratio = Math.min(ratio, (piece.knots[i][1] - piece.knots[i - 1][1]) / (piece.knots[i][0] - piece.knots[i - 1][0]));
      }
      seed = seedPlan({ ...seedOpts, designGrade: Math.min(TRACK_TYPES[p.type].maxGrade, opts.designGrade ?? Infinity) * ratio * 0.995 });
      if (!seed.ok || seed.crossings.length || seed.tracks[0].sections.length) throw new Error(seed.errors[0] ?? 'Structures: stage 4');
      p.alignment = seed.railAlignment!;
    } catch (e) { return seal(g, fail(p, (e as Error).message), intent); }
  }
  fillAdditions(g, p, offsets, opts);
  return seal(g, p, intent);
}

/** Stable reference and survivor IDs. No re-centering when a section grows or shrinks. */
export function planSectionCount(g: Game, sectionId: number, count: TrackCount, opts: SectionCountOptions = {}): RailSectionPlan {
  const s = g.railSections.get(sectionId), user = opts.user ?? 0, side = opts.side ?? 'auto';
  const p = empty(g, count, user, s?.owner ?? user, s?.type ?? 'standard', sectionId, side);
  const intent: Intent = { kind: 'count', section: sectionId, count, opts };
  if (g.railSections.compatibilityError) return seal(g, fail(p, g.railSections.compatibilityError), intent);
  if (!validCount(count)) return seal(g, fail(p, 'Track count: 1–4'), intent);
  if (!['auto', 'right', 'left', 'both'].includes(side)) return seal(g, fail(p, 'Invalid side'), intent);
  if (!s) return seal(g, fail(p, 'Section missing'), intent);
  p.alignment = copy(s.alignment); p.traffic = copy(s.traffic);
  const rights = count < s.count ? user !== s.owner ? 'Owner required' : null : g.trackUpgradeError(user, s.owner);
  if (rights) return seal(g, fail(p, rights), intent);
  const error = plainSpanError(g, s);
  if (error) return seal(g, fail(p, error), intent);
  if (opts.traffic === 'auto' || opts.traffic && opts.traffic !== s.traffic.policy) return seal(g, fail(p, 'Signals: stage 3'), intent);
  if (count === s.count) { p.diff.retained = s.slots.flatMap((s) => s.steps.map((q) => q.edge)); return seal(g, p, intent); }
  if (count < s.count) {
    const remaining = [...s.slots];
    while (remaining.length > count) {
      const left = remaining[0], right = remaining.at(-1)!;
      const q = side === 'left' ? left : side === 'right' ? right : left.id > right.id ? left : right;
      p.diff.removedSlots.push(q.id); p.diff.removedEdges.push(...q.steps.map((s) => s.edge));
      remaining.splice(remaining.indexOf(q), 1);
    }
    p.diff.retained = remaining.flatMap((s) => s.steps.map((q) => q.edge));
    for (const id of p.diff.removedEdges) {
      if (g.vehicles.isEdgeBusy(id)) return seal(g, fail(p, 'Track occupied'), intent);
      if (g.vehicles.getRes(id) || g.stations.heldForWorks(id)) return seal(g, fail(p, 'Track reserved'), intent);
      p.cost += g.world.net.edges.get(id)!.len * COSTS.removeRail;
    }
    if (count === 1 && remaining[0].steps.some((q) => { const e = g.world.net.edges.get(q.edge)!; return [e.a, e.b].some((id) => { const n = g.world.net.nodes.get(id)!; return n.signal >= 2 && !n.signalPass; }); })) return seal(g, fail(p, 'Direction change: stage 3'), intent);
    p.cost = Math.round(p.cost);
    return seal(g, p, intent);
  }
  p.diff.retained = s.slots.flatMap((s) => s.steps.map((q) => q.edge));
  const n = count - s.count, lo = s.slots[0].offset, hi = s.slots.at(-1)!.offset;
  const offsets = (dir: RailSectionSide) => {
    const result: number[] = []; let l = lo, r = hi;
    for (let i = 0; i < n; i++) result.push(dir === 'left' || dir === 'both' && i % 2 === 1 ? (l -= RAIL.spacing) : (r += RAIL.spacing));
    return result.sort((a, b) => a - b);
  };
  const buildOpts: BuildOptions = { kind: 'rail', type: p.type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: user, infrastructureOwner: s.owner };
  if (side === 'auto') {
    const right = copy(p), left = copy(p); right.side = 'right'; left.side = 'left';
    fillAdditions(g, right, offsets('right'), buildOpts); fillAdditions(g, left, offsets('left'), buildOpts);
    const best = right.ok && (!left.ok || right.cost <= left.cost) ? right : left.ok ? left : right;
    return seal(g, best, intent);
  }
  fillAdditions(g, p, offsets(side), buildOpts);
  return seal(g, p, intent);
}

function plainSpanError(g: Game, s: RailSection): string | null {
  const net = g.world.net, all = new Set(s.slots.flatMap((s) => s.steps.map((q) => q.edge)));
  for (const port of s.ends) {
    if (port.kind === 'station') return 'Station end: stage 3';
    if (port.kind === 'junction') return 'Junction end: stage 3';
    if (port.kind === 'depot') return 'Depot end: stage 3';
    if (port.kind !== 'terminal') return 'Connected end: stage 3';
  }
  for (const slot of s.slots) for (let i = 0; i < slot.steps.length; i++) {
    const q = slot.steps[i], e = net.edges.get(q.edge);
    if (!e || e.owner !== s.owner || trackTypeOf(e.type) !== s.type) return 'Section changed';
    if (e.station >= 0 || g.stations.railAttachment(e.id)) return 'Station track: stage 3';
    if (e.depot >= 0) return 'Depot track: stage 3';
    if (e.sections.length || s.structures.length) return 'Structures: stage 4';
    for (const id of [e.a, e.b]) {
      const node = net.nodes.get(id);
      if (!node || node.edges.some((id) => !all.has(id)) || node.edges.length > 2) return 'Manual connection: stage 3';
    }
    if (g.stations.heldForWorks(e.id)) return 'Track reserved';
  }
  for (const c of net.crossings.values()) if (all.has(c.e1) || all.has(c.e2)) return 'Crossings: stage 3';
  return null;
}

function fillAdditions(g: Game, p: RailSectionPlan, offsets: number[], opts: BuildOptions) {
  try {
    const tt = TRACK_TYPES[p.type], buildings = new Set<number>(), trees = new Set<number>();
    for (let slot = 0; slot < offsets.length; slot++) {
      const pieces = offsetRailAlignment(p.alignment, offsets[slot], tt.minRadius, Math.min(tt.maxGrade, opts.designGrade ?? Infinity));
      for (const piece of pieces) {
        const start: Snap = { kind: 'free', x: piece.bez.x0, z: piece.bez.z0, y: piece.prof[0] }, end: Snap = { kind: 'free', x: piece.bez.x3, z: piece.bez.z3, y: piece.prof.at(-1)! };
        const proposal = planEdge(g, start, end, { ...opts, tracks: 1, type: p.type, heightOffset: 0 }, { bez: piece.bez, prof: piece.prof, shared: p.section !== null || slot > 0 });
        if (!proposal.ok) throw new Error(proposal.errors[0]);
        if (proposal.crossings.length) throw new Error('Crossings: stage 3');
        if (proposal.tracks[0].sections.length) throw new Error('Structures: stage 4');
        // Deduplicate trees/buildings across members and refined pieces; charge each removal once.
        p.cost += proposal.cost - proposal.trees * 250;
        for (const id of proposal.demolish) {
          const b = g.world.buildings.get(id)!; p.cost -= 6000 + b.pop * 2500; buildings.add(id);
        }
        const tab = arcTable(piece.bez), hw = 0.32 + 0.5;
        const n = Math.max(2, Math.ceil(piece.len / 0.25));
        for (let i = 0; i <= n; i++) {
          const point = bezPoint(piece.bez, tAtS(tab, piece.len * i / n));
          for (const id of g.world.treeGrid.query(point.x - hw, point.z - hw, point.x + hw, point.z + hw)) {
            const t = g.world.trees[id]; if (t && Math.hypot(t.x - point.x, t.z - point.z) <= hw) trees.add(id);
          }
        }
      }
      p.diff.additions.push({ offset: offsets[slot], pieces });
    }
    p.diff.demolish = [...buildings].sort((a, b) => a - b); p.diff.trees = [...trees].sort((a, b) => a - b);
    for (const id of p.diff.demolish) p.cost += 6000 + g.world.buildings.get(id)!.pop * 2500;
    p.cost = Math.round(p.cost + trees.size * 250);
  } catch (e) { fail(p, (e as Error).message); }
}

/** Identity-preserving mutation journal. Capture once before application; rollback never deserializes a Game. */
class RailMutationJournal {
  private undo: (() => void)[] = [];
  constructor(root: object) {
    const seen = new WeakSet<object>();
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (ArrayBuffer.isView(value)) {
        const view = value as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength), saved = bytes.slice();
        this.undo.push(() => bytes.set(saved)); return;
      }
      if (value instanceof Map) {
        const entries = [...value.entries()]; this.undo.push(() => { value.clear(); for (const [k, v] of entries) value.set(k, v); });
        for (const [k, v] of entries) { visit(k); visit(v); } return;
      }
      if (value instanceof Set) {
        const entries = [...value]; this.undo.push(() => { value.clear(); for (const v of entries) value.add(v); });
        for (const v of entries) visit(v); return;
      }
      const saved = Object.getOwnPropertyDescriptors(value);
      this.undo.push(() => {
        for (const key of Reflect.ownKeys(value)) if (!Object.hasOwn(saved, key)) Reflect.deleteProperty(value, key);
        Object.defineProperties(value, saved);
      });
      for (const descriptor of Object.values(saved)) if ('value' in descriptor) visit(descriptor.value);
    };
    visit(root);
  }
  rollback() { for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i](); }
}

/** ID order: additions sorted by offset, then each piece's start/end node and edge, then saved section. */
export function commitRailSectionPlan(g: Game, p: RailSectionPlan): RailSectionCommit {
  const result = (error: string): RailSectionCommit => ({ error, cost: 0 });
  if (!p.ok) return result(p.error ?? 'Cannot build');
  const record = plans.get(p);
  if (!record || record.game !== g || record.signature !== JSON.stringify(p)) return result('Plan changed');
  const dep = record.dependencies, w = g.world, net = w.net;
  if (dep.key !== stateKey(g) || dep.heights.some((h, i) => h !== w.h[i]) || dep.locks.some((l, i) => l !== w.lock[i])) return result('Plan stale');
  const old = p.section === null ? undefined : g.railSections.get(p.section);
  const rights = old && p.count < old.count ? p.payer !== old.owner ? 'Owner required' : null : g.trackUpgradeError(p.payer, p.infrastructureOwner);
  if (rights) return result(rights);
  if (old) { const err = plainSpanError(g, old); if (err) return result(err); }
  for (const id of p.diff.removedEdges) {
    if (g.vehicles.isEdgeBusy(id)) return result('Track occupied');
    if (g.vehicles.getRes(id) || g.stations.heldForWorks(id)) return result('Track reserved');
  }
  const eco = g.company(p.payer).economy;
  if (!eco.canAfford(p.cost)) return result('Not enough money');
  if (old && !p.diff.additions.length && !p.diff.removedEdges.length) return { error: null, cost: 0, section: old.id, edges: p.diff.retained.slice() };
  const journal = new RailMutationJournal(g);
  try {
    let section: RailSection | undefined;
    const created: NEdge[] = [];
    const removedBounds = p.diff.removedEdges.map((id) => net.grid.box(id)!).filter(Boolean);
    g.railSections.batch(() => {
      for (const id of p.diff.demolish) g.towns.demolishBuilding(id);
      const slots: RailSlot[] = old ? old.slots.filter((s) => !p.diff.removedSlots.includes(s.id)) : [];
      for (const addition of [...p.diff.additions].sort((a, b) => a.offset - b.offset)) {
        const slot: RailSlot = { id: g.railSections.nextSlot++, offset: addition.offset, steps: [] };
        let node: number | undefined;
        for (const piece of addition.pieces) {
          const a = bezDeriv(piece.bez, 0), b = bezDeriv(piece.bez, 1), la = Math.hypot(a.x, a.z), lb = Math.hypot(b.x, b.z);
          if (node === undefined) node = net.addNode('rail', piece.bez.x0, piece.prof[0], piece.bez.z0, a.x / la, a.z / la, p.infrastructureOwner).id;
          const end = net.addNode('rail', piece.bez.x3, piece.prof.at(-1)!, piece.bez.z3, b.x / lb, b.z / lb, p.infrastructureOwner);
          const e = net.addEdge('rail', node, end.id, { ...piece.bez }, piece.prof.slice(), [], p.type, p.infrastructureOwner);
          created.push(e); slot.steps.push({ edge: e.id, dir: 1, u0: piece.u0, u1: piece.u1, knots: copy(piece.knots) }); node = end.id;
        }
        slots.push(slot);
      }
      for (const id of p.diff.removedEdges) net.removeEdge(id);
      slots.sort((a, b) => a.offset - b.offset);
      if (old) {
        old.slots = slots; old.count = p.count; old.version++; section = old;
        g.railSections.version++; g.railSections.updateEnds(old); g.railSections.rebuildIndexes();
      } else section = g.railSections.register({ owner: p.infrastructureOwner, type: p.type, count: p.count, alignment: p.alignment,
        slots, traffic: p.traffic, structures: [], origin: 'authored' });
      for (const id of p.diff.trees) {
        const t = w.trees[id]; if (t) w.removeTreesNear(t.x, t.z, 0.000001);
      }
      if (created.length) applyEarthworks(w, created);
      if (p.diff.removedEdges.length) {
        for (const b of removedBounds) recomputeLocks(w, b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 3);
      }
      g.railSections.validate();
      if (!eco.spend(p.cost, 'construction')) throw new Error('Not enough money');
    });
    g.onNetworkChanged();
    return { error: null, cost: p.cost, section: section!.id, edges: [...p.diff.retained, ...created.map((e) => e.id)] };
  } catch (e) {
    journal.rollback();
    return result(`Commit failed: ${(e as Error).message}`);
  }
}
