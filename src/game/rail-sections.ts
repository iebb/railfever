// Section identity is additive: adoption never edits physical rail, signals, trains or construction ownership.
import type { Game } from './game';
import type { NEdge } from './network';
import { profAt } from './network';
import { RAIL, PSTEP, trackTypeOf } from './constants';
import { arcTable, bezPoint, bezDeriv, bezReverse, tAtS, startTangent } from './geom';
import { alignmentHeight, closestRailT, sAtT } from './rail-offsets';
import {
  railUAtS, type RailAlignment, type RailSection, type RailSlot, type RailStep, type RailPortRef,
  type RailJunction, type RailStructure, type RailMembership, type RailSectionsSave, type TrackCount,
} from './rail-section-types';

type ChainStep = { e: NEdge; dir: 1 | -1 };
type Chain = { steps: ChainStep[]; start: number; end: number; min: number };
const copy = <T>(x: T): T => structuredClone(x);

export class RailSections {
  sections = new Map<number, RailSection>();
  junctions = new Map<number, RailJunction>();
  structures = new Map<number, RailStructure>();
  /** Rebuilt, never saved. Physical edge membership is unique. */
  byEdge = new Map<number, RailMembership>();
  connectorJunction = new Map<number, number>();
  nextSection = 1;
  nextSlot = 1;
  nextJunction = 1;
  nextStructure = 1;
  version = 0;
  compatibilityError: string | null = null;
  private unsupported: unknown;
  private suspended = 0;

  constructor(private game: Game) {
    const net = game.world.net;
    net.onSplit.push((old, e1, e2, s) => this.split(old, e1, e2, s));
    net.onRemove.push((e) => {
      if (this.suspended) return;
      const m = this.byEdge.get(e.id);
      if (m) this.fallback(m.section, new Set([e.id]));
      const jid = this.connectorJunction.get(e.id), j = jid === undefined ? undefined : this.junctions.get(jid);
      if (j) { j.connectors = j.connectors.filter((id) => id !== e.id); j.version++; this.rebuildIndexes(); }
    });
  }

  get(id: number) { return this.sections.get(id); }
  membership(edge: number) { return this.byEdge.get(edge); }

  /** Unadopted legacy construction remains a pure singleton view until an explicit adoption boundary. */
  viewForEdge(id: number): RailSection | undefined {
    const m = this.byEdge.get(id);
    if (m) return this.get(m.section);
    const e = this.game.world.net.edges.get(id);
    if (!e || !this.plain(e) || this.compatibilityError) return undefined;
    return this.record([{ e, dir: 1 }], 0, 0);
  }

  /** Composite graph edits assign their planned slots before reconciliation can allocate fallback metadata. */
  batch<T>(apply: () => T): T {
    this.suspended++;
    try { return apply(); } finally { this.suspended--; }
  }

  register(section: Omit<RailSection, 'id' | 'version' | 'ends'>): RailSection {
    if (this.compatibilityError) throw new Error(this.compatibilityError);
    const s: RailSection = { ...copy(section), id: this.nextSection++, version: 0, ends: [{ kind: 'terminal', nodes: [] }, { kind: 'terminal', nodes: [] }] };
    this.sections.set(s.id, s);
    this.updateEnds(s); this.version++; this.rebuildIndexes();
    return s;
  }

  rebuildIndexes() {
    this.byEdge.clear(); this.connectorJunction.clear();
    for (const s of this.sections.values()) for (const slot of s.slots) for (const step of slot.steps) {
      if (this.byEdge.has(step.edge)) throw new Error('Duplicate rail membership');
      this.byEdge.set(step.edge, { section: s.id, slot: slot.id, step });
    }
    for (const j of this.junctions.values()) for (const id of j.connectors) {
      if (this.byEdge.has(id) || this.connectorJunction.has(id)) throw new Error('Duplicate rail connector');
      this.connectorJunction.set(id, j.id);
    }
  }

  /** Called at completed mutation boundaries, never by a view or a serializer. No orphan auto-adoption. */
  reconcile(finalOwnership = true) {
    if (this.suspended || this.compatibilityError) return;
    for (const s of [...this.sections.values()]) {
      let invalid = false;
      const owners = new Set<number>();
      const types = new Set<string>();
      const reference = s.alignment.pieces.map((p) => ({ piece: p, tab: arcTable(p.bez) }));
      for (const slot of s.slots) for (let i = 0; i < slot.steps.length; i++) {
        const q = slot.steps[i], e = this.game.world.net.edges.get(q.edge);
        if (!e) { invalid = true; continue; }
        if (!this.plain(e)) invalid = true;
        owners.add(e.owner);
        types.add(trackTypeOf(e.type));
        // A branch or depot inserted inside a span becomes a boundary; signals alone do not.
        if (i < slot.steps.length - 1) {
          const n = this.game.world.net.nodes.get(q.dir > 0 ? e.b : e.a);
          if (!n || n.edges.length !== 2) invalid = true;
        }
        // Relevel/regeometry changes need a fresh reference, not a stale offset alignment. Check the
        // interior too: a bowed curve or a new grade may leave both endpoints unchanged.
        const tab = arcTable(e.bez), samples = Math.max(2, Math.ceil(e.len / PSTEP));
        for (let i = 0; i <= samples && !invalid; i++) {
          const at = e.len * i / samples, u = railUAtS(q, at);
          const refPiece = reference.find(({ piece }) => u <= piece.u1 + 1e-8) ?? reference.at(-1)!;
          const piece = refPiece.piece;
          const t = tAtS(refPiece.tab, u - piece.u0), ref = bezPoint(piece.bez, t), d = bezDeriv(piece.bez, t), len = Math.hypot(d.x, d.z) || 1;
          const actual = bezPoint(e.bez, tAtS(tab, at));
          if (Math.hypot(actual.x - (ref.x - d.z / len * slot.offset), actual.z - (ref.z + d.x / len * slot.offset)) > 0.055 ||
              Math.abs(profAt(e.prof, e.len, at) - alignmentHeight(s.alignment, u)) > 0.025) invalid = true;
        }
      }
      // Joint-network adapters temporarily borrow ownership. Only the later flush or explicit buyout
      // boundary may record a changed owner; synchronous construction notifications leave it alone.
      if (!finalOwnership && [...owners].some((owner) => owner !== s.owner)) continue;
      if (invalid || owners.size !== 1 || types.size !== 1) { this.fallback(s.id); continue; }
      const owner = [...owners][0];
      if (owner !== s.owner) { s.owner = owner; s.version++; this.version++; }
      const type = [...types][0];
      if (type !== s.type) { s.type = type; s.version++; this.version++; }
      const manualSignal = s.slots.some((slot) => slot.steps.some((q) => {
        const e = this.game.world.net.edges.get(q.edge)!;
        return [e.a, e.b].some((id) => {
          const n = this.game.world.net.nodes.get(id)!;
          const generated = s.traffic.signals.find((q) => q.node === id);
          return !!n.signal && (!generated || n.signal !== generated.signal || (n.signalKind ?? 'path') !== generated.kind || !!n.signalPass !== generated.pass);
        });
      }));
      if (manualSignal && s.traffic.policy !== 'custom') { s.traffic.policy = 'custom'; s.version++; this.version++; }
      const before = JSON.stringify(s.ends);
      this.updateEnds(s);
      if (JSON.stringify(s.ends) !== before) { s.version++; this.version++; }
    }
    this.refreshJunctionPorts(); this.rebuildIndexes();
  }

  /** Explicit legacy adoption. Deterministic metadata IDs only; call after station records/final owners exist. */
  adoptUnassigned() {
    if (this.compatibilityError) return;
    this.reconcile();
    const edges = new Set([...this.game.world.net.edges.values()].filter((e) => this.plain(e) && !this.byEdge.has(e.id) && !this.connectorJunction.has(e.id)).map((e) => e.id));
    const chains = this.chains(edges), byNode = new Map<number, Chain[]>();
    for (const c of chains) for (const n of [c.start, c.end]) { const list = byNode.get(n) ?? []; list.push(c); byNode.set(n, list); }
    const done = new Set<Chain>();
    for (const c of chains) {
      if (done.has(c)) continue;
      const ref = this.record(c.steps, 0, 0);
      const start = this.game.world.net.nodes.get(c.start)!, possible = new Set<Chain>();
      for (const nid of this.game.world.net.nodeGrid.query(start.x - 1.4, start.z - 1.4, start.x + 1.4, start.z + 1.4))
        for (const other of byNode.get(nid) ?? []) if (other !== c && !done.has(other)) possible.add(other);
      const members: { chain: Chain; slot: RailSlot }[] = [{ chain: c, slot: ref.slots[0] }];
      for (const other of [...possible].sort((a, b) => a.min - b.min)) {
        const slot = this.parallelSlot(ref.alignment, c, other);
        if (slot) members.push({ chain: other, slot });
      }
      members.sort((a, b) => a.slot.offset - b.slot.offset || a.chain.min - b.chain.min);
      // Duplicate spacing, a fifth track, or a missing interior member is ambiguous: adopt singletons.
      const valid = members.length <= 4 && members.every((m, i) => !i || Math.abs(m.slot.offset - members[i - 1].slot.offset - RAIL.spacing) < 0.025);
      const use = valid ? members : members.filter((m) => m.chain === c);
      ref.id = this.nextSection++;
      ref.slots = use.map((m) => ({ ...m.slot, id: this.nextSlot++ }));
      ref.count = ref.slots.length as TrackCount;
      if (use.some((m) => m.chain.steps.some(({ e }) => [e.a, e.b].some((id) => this.game.world.net.nodes.get(id)?.signal)))) ref.traffic.policy = 'custom';
      this.sections.set(ref.id, ref);
      for (const m of use) done.add(m.chain);
      this.updateEnds(ref); this.version++;
    }
    this.refreshJunctionPorts(); this.rebuildIndexes();
  }

  toJSON(): RailSectionsSave | unknown {
    if (this.unsupported !== undefined) return copy(this.unsupported);
    return copy({ schema: 1, version: this.version, nextSection: this.nextSection, nextSlot: this.nextSlot,
      nextJunction: this.nextJunction, nextStructure: this.nextStructure, sections: [...this.sections.values()],
      junctions: [...this.junctions.values()], structures: [...this.structures.values()] } satisfies RailSectionsSave);
  }

  /** Hydrate around the restored graph. Unknown schemas are preserved with editing disabled. */
  load(payload: any) {
    this.sections.clear(); this.junctions.clear(); this.structures.clear(); this.byEdge.clear(); this.connectorJunction.clear();
    this.unsupported = undefined; this.compatibilityError = null;
    if (!payload) { this.adoptUnassigned(); return; }
    if (payload.schema !== 1) {
      this.unsupported = copy(payload); this.compatibilityError = 'Unsupported rail section schema'; return;
    }
    const d = copy(payload) as RailSectionsSave;
    for (const [key, list] of [['sections', d.sections], ['junctions', d.junctions], ['structures', d.structures]] as const) {
      if (!Array.isArray(list)) throw new Error('Invalid rail section metadata');
      const map = this[key] as Map<number, any>;
      for (const item of list) {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || map.has(item.id)) throw new Error('Invalid rail section ID');
        map.set(item.id, item);
      }
    }
    for (const key of ['nextSection', 'nextSlot', 'nextJunction', 'nextStructure'] as const) {
      if (!Number.isSafeInteger(d[key]) || d[key] < 1) throw new Error('Invalid rail section allocator');
      this[key] = d[key];
    }
    this.version = d.version ?? 0;
    this.validate(); this.rebuildIndexes();
  }

  validate() {
    const net = this.game.world.net, slots = new Set<number>();
    for (const s of this.sections.values()) {
      if (s.id >= this.nextSection || !Number.isSafeInteger(s.version) || s.version < 0 || !Number.isSafeInteger(s.owner) || trackTypeOf(s.type) !== s.type || ![1, 2, 3, 4].includes(s.count) || s.count !== s.slots.length || !Number.isFinite(s.alignment.length) || s.alignment.length <= 0) throw new Error('Invalid rail section');
      if (!s.alignment.pieces.length || s.alignment.pieces.some((p, i) => !Number.isFinite(p.u0 + p.u1) || p.u1 <= p.u0 || p.prof.length < 2 || p.prof.some((v) => !Number.isFinite(v)) ||
        Object.values(p.bez).some((v) => !Number.isFinite(v)) || Math.abs(p.u0 - (i ? s.alignment.pieces[i - 1].u1 : 0)) > 1e-4)) throw new Error('Invalid rail alignment');
      if (Math.abs(s.alignment.pieces.at(-1)!.u1 - s.alignment.length) > 1e-4 || s.slots.some((slot, i) => i > 0 && slot.offset <= s.slots[i - 1].offset)) throw new Error('Invalid rail alignment');
      for (const slot of s.slots) {
        if (!Number.isSafeInteger(slot.id) || slot.id < 1 || slot.id >= this.nextSlot || slots.has(slot.id) || !Number.isFinite(slot.offset) || !slot.steps.length) throw new Error('Invalid rail slot');
        slots.add(slot.id);
        let end = -1, u = 0;
        for (const q of slot.steps) {
          const e = net.edges.get(q.edge);
          if (!e || !this.plain(e) || e.owner !== s.owner || trackTypeOf(e.type) !== s.type || ![1, -1].includes(q.dir) || Math.abs(q.u0 - u) > 0.04 || q.u1 <= q.u0 ||
              q.knots.length < 2 || q.knots.some((k, i) => !Number.isFinite(k[0] + k[1]) || k[1] < -1e-5 || k[1] > e.len + 1e-5 || (i > 0 && (k[0] <= q.knots[i - 1][0] || q.dir * (k[1] - q.knots[i - 1][1]) <= 0)))) throw new Error('Invalid rail member');
          const a = q.dir > 0 ? e.a : e.b, b = q.dir > 0 ? e.b : e.a;
          if (end >= 0 && a !== end) throw new Error('Discontinuous rail slot');
          if (Math.abs(q.knots[0][0] - q.u0) > 1e-5 || Math.abs(q.knots.at(-1)![0] - q.u1) > 1e-5 ||
              Math.abs(q.knots[0][1] - (q.dir > 0 ? 0 : e.len)) > 1e-5 || Math.abs(q.knots.at(-1)![1] - (q.dir > 0 ? e.len : 0)) > 1e-5) throw new Error('Invalid rail correspondence');
          end = b; u = q.u1;
        }
        if (Math.abs(u - s.alignment.length) > 0.04) throw new Error('Incomplete rail slot');
      }
      for (let i = 0; i < 2; i++) {
        const port = s.ends[i];
        if (port.nodes.length !== s.count || port.nodes.some((n, j) => {
          const q = i ? s.slots[j].steps.at(-1)! : s.slots[j].steps[0], e = net.edges.get(q.edge)!;
          return n !== (i === (q.dir > 0 ? 1 : 0) ? e.b : e.a);
        }) || port.junction !== undefined && !this.junctions.has(port.junction)) throw new Error('Invalid rail port');
      }
    }
    for (const j of this.junctions.values()) if (j.id >= this.nextJunction || j.nodes.some((n) => !net.nodes.has(n)) || j.ports.some((p) => !this.sections.has(p.section)) || j.connectors.some((e) => !net.edges.has(e))) throw new Error('Invalid rail junction');
    for (const st of this.structures.values()) if (st.id >= this.nextStructure || !this.sections.has(st.section)) throw new Error('Invalid rail structure');
  }

  private plain(e: NEdge) { return e.kind === 'rail' && e.station < 0 && e.depot < 0 && !this.game.stations.railAttachment(e.id); }

  private chains(ids: Set<number>): Chain[] {
    const net = this.game.world.net, out: Chain[] = [], seen = new Set<number>();
    const next = (e: NEdge, node: number) => {
      const n = net.nodes.get(node);
      if (!n || n.edges.length !== 2) return undefined;
      const other = net.edges.get(n.edges.find((id) => id !== e.id)!);
      if (!other || !ids.has(other.id) || other.owner !== e.owner || trackTypeOf(other.type) !== trackTypeOf(e.type) || net.sideAt(e, node) === net.sideAt(other, node)) return undefined;
      const a = net.leaveDir(e, node), b = net.leaveDir(other, node);
      return a.x * b.x + a.z * b.z < -0.995 ? other : undefined;
    };
    for (const id of [...ids].sort((a, b) => a - b)) {
      if (seen.has(id)) continue;
      const seed = net.edges.get(id)!;
      let e = seed, at = e.a;
      const back = new Set([id]);
      while (true) { const n = next(e, at); if (!n || back.has(n.id)) break; back.add(n.id); at = net.other(n, at); e = n; }
      const start = at, steps: ChainStep[] = [];
      while (true) {
        const dir = e.a === at ? 1 : -1;
        steps.push({ e, dir }); seen.add(e.id); at = net.other(e, at);
        const n = next(e, at); if (!n || seen.has(n.id)) break; e = n;
      }
      out.push({ steps, start, end: at, min: Math.min(...steps.map((s) => s.e.id)) });
    }
    return out.sort((a, b) => a.min - b.min);
  }

  private record(steps: ChainStep[], id: number, slotId: number): RailSection {
    const alignment: RailAlignment = { length: 0, pieces: [] }, qs: RailStep[] = [];
    for (const { e, dir } of steps) {
      const u0 = alignment.length, u1 = u0 + e.len, prof: number[] = [];
      for (let i = 0; i < Math.max(2, Math.ceil(e.len / PSTEP) + 1); i++) {
        const s = Math.min(e.len, i * PSTEP); prof.push(profAt(e.prof, e.len, dir > 0 ? s : e.len - s));
      }
      alignment.pieces.push({ u0, u1, bez: dir > 0 ? { ...e.bez } : bezReverse(e.bez), prof }); alignment.length = u1;
      qs.push({ edge: e.id, dir, u0, u1, knots: [[u0, dir > 0 ? 0 : e.len], [u1, dir > 0 ? e.len : 0]] });
    }
    const s: RailSection = { id, version: 0, owner: steps[0].e.owner, type: trackTypeOf(steps[0].e.type), count: 1, alignment,
      slots: [{ id: slotId, offset: 0, steps: qs }], ends: [{ kind: 'terminal', nodes: [] }, { kind: 'terminal', nodes: [] }],
      traffic: { policy: steps.some(({ e }) => [e.a, e.b].some((id) => this.game.world.net.nodes.get(id)?.signal)) ? 'custom' : 'two-way', signals: [] }, structures: [], origin: 'derived' };
    this.updateEnds(s, false); return s;
  }

  private parallelSlot(a: RailAlignment, base: Chain, other: Chain): RailSlot | null {
    const net = this.game.world.net, e = base.steps[0].e, o = other.steps[0].e;
    if (base.start === base.end || other.start === other.end || e.owner !== o.owner || trackTypeOf(e.type) !== trackTypeOf(o.type)) return null;
    const p = net.nodes.get(base.start)!, q = net.nodes.get(other.start)!, r = net.nodes.get(other.end)!;
    const steps = Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(r.x - p.x, r.z - p.z) ? other.steps : [...other.steps].reverse().map((v) => ({ e: v.e, dir: -v.dir as 1 | -1 }));
    const tangent = startTangent(a.pieces[0].bez), first = net.nodes.get(steps[0].dir > 0 ? steps[0].e.a : steps[0].e.b)!;
    const off = (first.x - p.x) * -tangent.z + (first.z - p.z) * tangent.x;
    const mult = Math.round(off / RAIL.spacing);
    if (!mult || Math.abs(mult) > 3 || Math.abs(off - mult * RAIL.spacing) > 0.025) return null;
    const pieces = a.pieces.map((p) => ({ p, tab: arcTable(p.bez) })), out: RailStep[] = [];
    let previous = -Infinity;
    for (const { e, dir } of steps) {
      const tab = arcTable(e.bez), knots: [number, number][] = [], n = Math.max(8, Math.ceil(e.len / 1));
      for (let i = 0; i <= n; i++) {
        const s = dir > 0 ? e.len * i / n : e.len * (1 - i / n), point = bezPoint(e.bez, tAtS(tab, s));
        let best = Infinity, u = 0, lat = 0, dot = 0;
        const d = bezDeriv(e.bez, tAtS(tab, s)), dl = Math.hypot(d.x, d.z) || 1;
        for (const { p, tab } of pieces) {
          const t = closestRailT(p.bez, point.x, point.z), v = bezPoint(p.bez, t), dt = bezDeriv(p.bez, t), l = Math.hypot(dt.x, dt.z) || 1;
          const dist = Math.hypot(v.x - point.x, v.z - point.z);
          if (dist < best) { best = dist; u = p.u0 + sAtT(tab, t); lat = ((point.x - v.x) * -dt.z + (point.z - v.z) * dt.x) / l; dot = dir * (d.x * dt.x + d.z * dt.z) / (dl * l); }
        }
        if (Math.abs(lat - off) > 0.03 || Math.abs(best - Math.abs(off)) > 0.03 || dot < 0.995 || Math.abs(profAt(e.prof, e.len, s) - alignmentHeight(a, u)) > 0.02 || (i > 0 && u <= previous)) return null;
        knots.push([u, s]); previous = u;
      }
      out.push({ edge: e.id, dir, u0: knots[0][0], u1: knots.at(-1)![0], knots });
    }
    if (out[0].u0 > 0.03 || a.length - out.at(-1)!.u1 > 0.03) return null;
    out[0].u0 = 0; out[0].knots[0][0] = 0;
    out.at(-1)!.u1 = a.length; out.at(-1)!.knots.at(-1)![0] = a.length;
    return { id: 0, offset: off, steps: out };
  }

  updateEnds(s: RailSection, allocateJunctions = true) {
    const net = this.game.world.net;
    s.ends = [0, 1].map((end) => {
      const nodes = s.slots.map((slot) => { const q = end ? slot.steps.at(-1)! : slot.steps[0], e = net.edges.get(q.edge)!; return end === (q.dir > 0 ? 1 : 0) ? e.b : e.a; });
      const port: RailPortRef = { kind: 'terminal', nodes };
      for (const nid of nodes) for (const id of net.nodes.get(nid)?.edges ?? []) {
        const e = net.edges.get(id); if (!e) continue;
        const attachment = this.game.stations.railAttachment(id);
        if (attachment || e.station >= 0) { port.kind = 'station'; port.station = attachment?.station ?? e.station; }
        else if (e.depot >= 0 && port.kind !== 'station') port.kind = 'depot';
        else if ((port.kind === 'terminal' || port.kind === 'plain') && net.nodes.get(nid)!.edges.length > 1) port.kind = net.nodes.get(nid)!.edges.length > 2 ? 'junction' : 'plain';
      }
      if (port.kind === 'junction' && allocateJunctions) {
        const junctionNodes = nodes.filter((n) => (net.nodes.get(n)?.edges.length ?? 0) > 2);
        let j = [...this.junctions.values()].find((j) => j.origin === 'manual' && j.nodes.length === junctionNodes.length && j.nodes.every((n, i) => n === junctionNodes[i]));
        if (!j) { j = { id: this.nextJunction++, version: 0, origin: 'manual', nodes: junctionNodes, ports: [], routes: [], connectors: [], crossings: [], signals: [] }; this.junctions.set(j.id, j); }
        port.junction = j.id;
      }
      return port;
    }) as [RailPortRef, RailPortRef];
  }

  private refreshJunctionPorts() {
    for (const j of this.junctions.values()) {
      j.ports = [...this.sections.values()].flatMap((s) => s.ends.flatMap((p, end) => p.junction === j.id ? [{ section: s.id, end: end as 0 | 1 }] : []));
      if (j.origin === 'manual' && (!j.ports.length || j.nodes.some((n) => !this.game.world.net.nodes.has(n)))) this.junctions.delete(j.id);
    }
  }

  /** Conservative repair: invalidate the old grouping and adopt valid remaining chains as singletons. */
  private fallback(id: number, excluded = new Set<number>()) {
    const s = this.sections.get(id); if (!s) return;
    const ids = new Set(s.slots.flatMap((slot) => slot.steps.map((q) => q.edge)).filter((id) => !excluded.has(id) && !!this.game.world.net.edges.get(id) && this.plain(this.game.world.net.edges.get(id)!)));
    this.sections.delete(id);
    for (const c of this.chains(ids)) {
      const r = this.record(c.steps, this.nextSection++, this.nextSlot++);
      if (excluded.size) r.owner = s.owner;
      this.sections.set(r.id, r); this.updateEnds(r);
    }
    this.version++; this.refreshJunctionPorts(); this.rebuildIndexes();
  }

  private split(old: NEdge, e1: NEdge, e2: NEdge, s: number) {
    const m = this.byEdge.get(old.id); if (!m) return;
    const section = this.sections.get(m.section)!, slot = section.slots.find((s) => s.id === m.slot)!;
    const q = m.step, u = railUAtS(q, s), a = q.dir > 0 ? e1 : e2, b = q.dir > 0 ? e2 : e1;
    const fragment = (e: NEdge, u0: number, u1: number): RailStep => {
      const subtract = e === e2 ? s : 0;
      const knots: [number, number][] = [[u0, q.dir > 0 ? 0 : e.len]];
      // Network's split uses its fitted subcurve lengths; preserve every interior reference knot.
      const scale = e.len / (e === e1 ? s : old.len - s);
      for (const k of q.knots) if (k[0] > u0 && k[0] < u1) knots.push([k[0], (k[1] - subtract) * scale]);
      knots.push([u1, q.dir > 0 ? e.len : 0]);
      return { edge: e.id, dir: q.dir, u0, u1, knots };
    };
    slot.steps.splice(slot.steps.indexOf(q), 1, fragment(a, q.u0, u), fragment(b, u, q.u1));
    section.version++; this.version++; this.rebuildIndexes();
  }
}
