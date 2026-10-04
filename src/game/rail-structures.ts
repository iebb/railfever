// Shared civil geometry, quotes and upkeep. All planning helpers are pure; IDs belong to RailSections.
import type { Game } from './game';
import type { NEdge, Section } from './network';
import { RAIL, TRACK_TYPES, WATER_Y, PSTEP } from './constants';
import { arcTable, bezPoint, bezDeriv, tAtS, closestOnPolyline } from './geom';
import { SHARED_TRACK, structureFactor } from './construction';
import { trackMaintenance, railCivilMaintenance } from './opcosts';
import { LOCK, TUNNEL_LINING } from './terraform';
import { distToRect } from './world';
import { alignmentHeight, closestRailT, sAtT, offsetRailAlignment, type RailOffsetPiece } from './rail-offsets';
import { railSAtU, railUAtS, type RailAlignment, type RailAlignmentPiece, type RailSection, type RailSlot, type RailStep, type RailStructure } from './rail-section-types';

export interface CivilSpan { u0: number; u1: number; type: 'bridge' | 'tunnel' }
/** The live demolition tariff (not the obsolete tile tariff in economy.COSTS). No civil refund. */
export function railRemovalCost(units: number) { return units * 400; }
export interface RailStructureDraft extends Omit<RailStructure, 'id' | 'section' | 'slots'> {
  /** Existing metadata ID, or null for a new span. No preview allocator use. */
  structure: number | null;
  cost: number;
}
const copy = <T>(x: T): T => structuredClone(x);
const tabs = new WeakMap<RailAlignmentPiece, ReturnType<typeof arcTable>>();
const table = (p: RailAlignmentPiece) => { let t = tabs.get(p); if (!t) { t = arcTable(p.bez); tabs.set(p, t); } return t; };

/** Reference-distance sample, with a true lateral offset and the saved vertical alignment. */
export function formationAt(a: RailAlignment, u: number, offset = 0) {
  const p = a.pieces.find((p) => u <= p.u1 + 1e-8) ?? a.pieces.at(-1)!;
  const t = tAtS(table(p), Math.max(0, Math.min(p.u1 - p.u0, u - p.u0)));
  const q = bezPoint(p.bez, t), d = bezDeriv(p.bez, t), l = Math.hypot(d.x, d.z) || 1;
  const tx = d.x / l, tz = d.z / l;
  return { s: u, x: q.x - tz * offset, y: alignmentHeight(a, u), z: q.z + tx * offset, tx, tz, lx: -tz, lz: tx };
}

/** Map one civil interval to each physical fragment (including reversed edges). */
export function memberSections(step: Pick<RailStep, 'u0' | 'u1' | 'knots' | 'dir'>, spans: CivilSpan[]): Section[] {
  const out: Section[] = [];
  for (const st of spans) {
    const u0 = Math.max(step.u0, st.u0), u1 = Math.min(step.u1, st.u1);
    if (u1 - u0 < 1e-5) continue;
    const a = railSAtU(step as RailStep, u0), b = railSAtU(step as RailStep, u1);
    out.push({ s0: Math.min(a, b), s1: Math.max(a, b), type: st.type });
  }
  return out.sort((a, b) => a.s0 - b.s0);
}

export function slotSpans(g: Game, slot: RailSlot): CivilSpan[] {
  const spans: CivilSpan[] = [];
  for (const step of slot.steps) for (const sec of g.world.net.edges.get(step.edge)?.sections ?? []) {
    const a = railUAtS(step, sec.s0), b = railUAtS(step, sec.s1);
    spans.push({ u0: Math.min(a, b), u1: Math.max(a, b), type: sec.type });
  }
  spans.sort((a, b) => a.u0 - b.u0);
  const out: CivilSpan[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && last.type === s.type && s.u0 <= last.u1 + 0.075) last.u1 = Math.max(last.u1, s.u1);
    else out.push({ ...s });
  }
  return out;
}

/** Count edits require common transitions. Unequal legacy spans stay separately owned civil groups. */
export function sectionSpans(g: Game, s: RailSection): CivilSpan[] {
  const ref = slotSpans(g, s.slots[0]);
  for (const slot of s.slots.slice(1)) {
    const other = slotSpans(g, slot);
    if (other.length !== ref.length || other.some((x, i) => x.type !== ref[i].type || Math.abs(x.u0 - ref[i].u0) > 0.08 || Math.abs(x.u1 - ref[i].u1) > 0.08)) throw new Error('Structure spans differ');
  }
  return ref;
}

/** Actual physical length covered by a group's intervals; independent of signal/geometry fragments. */
export function civilLength(g: Game, slot: RailSlot, st: CivilSpan, edge?: number): number {
  let length = 0;
  for (const step of slot.steps) {
    if (edge !== undefined && step.edge !== edge) continue;
    const e = g.world.net.edges.get(step.edge); if (!e) continue;
    const mapped = memberSections(step, [st])[0]; if (!mapped) continue;
    for (const sec of e.sections) if (sec.type === st.type) length += Math.max(0, Math.min(sec.s1, mapped.s1) - Math.max(sec.s0, mapped.s0));
  }
  return length;
}

function crown(lo: number, hi: number) {
  const half = (hi - lo) / 2;
  return Math.max(TUNNEL_LINING.rail, 0.48 + Math.min(half * 0.55, 0.62) + 0.14);
}
function envelope(span: CivilSpan, offsets: number[]) {
  const pad = span.type === 'bridge' ? 0.27 : 0.38;
  const lo = Math.min(...offsets) - pad, hi = Math.max(...offsets) + pad;
  return { lo, hi, above: span.type === 'tunnel' ? crown(lo, hi) : RAIL.clearance, below: span.type === 'bridge' ? 0.31 : 0.2 };
}
function portals(g: Game, a: RailAlignment, span: CivilSpan, lo: number, hi: number): [boolean, boolean] {
  return [span.u0, span.u1].map((u) => {
    const p = formationAt(a, u, (lo + hi) / 2);
    return g.world.heightAt(p.x, p.z) - p.y < crown(lo, hi) + TUNNEL_LINING.cover + 0.2;
  }) as [boolean, boolean];
}

/** Query physical edges at a point without adding graph nodes or resources. */
function nearEdges(g: Game, x: number, z: number, radius: number, exclude: Set<number>) {
  const net = g.world.net;
  return net.edgesNear(x - radius, z - radius, x + radius, z + radius).filter((e) => !exclude.has(e.id)).map((e) => {
    const geo = net.geo(e), q = closestOnPolyline(x, z, geo.pts, 3, geo.n);
    const s = geo.cum[q.i] + (geo.cum[Math.min(geo.n - 1, q.i + 1)] - geo.cum[q.i]) * q.f;
    return { e, d: q.d, s, y: net.heightAtS(e, s), type: net.sectionAt(e, s) };
  });
}

function pierClear(g: Game, a: RailAlignment, u: number, offset: number, exclude: Set<number>): boolean {
  const p = formationAt(a, u, offset), w = g.world;
  const bottom = p.y - 0.31, ground = w.heightAt(p.x, p.z);
  if (w.buildingsNear(p.x, p.z, 2).some((b) => distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.3)) return false;
  for (const st of g.stations.footprintsNear(p.x, p.z, 0.4)) for (const f of g.stations.footprints(st))
    if (distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.3 && (f.y0 === undefined || f.y0 < bottom && (f.y1 ?? Infinity) > ground - 0.4)) return false;
  for (const dp of g.depots.near(p.x, p.z, 0.6)) if (Math.abs(dp.y - ground) < 1) return false;
  for (const q of nearEdges(g, p.x, p.z, 2, exclude)) {
    if (q.d > w.net.halfWidth(q.e) + 0.26) continue;
    if (q.type === 'tunnel') { if (q.y + TUNNEL_LINING.rail > ground - 0.4) return false; }
    else if (q.y < bottom && q.y + RAIL.clearance > ground - 0.4) return false;
  }
  // Removed outside rails leave a paid deck/bore. Foundations must clear that entire envelope too.
  for (const st of g.railSections.structuresNear(p.x - 0.3, p.z - 0.3, p.x + 0.3, p.z + 0.3)) {
    const section = g.railSections.get(st.section)!;
    if (section.slots.filter((slot) => st.slots.includes(slot.id)).every((slot) => slot.steps.every((q) => exclude.has(q.edge)))) continue;
    for (const piece of section.alignment.pieces) {
      if (piece.u1 < st.u0 || piece.u0 > st.u1) continue;
      const t = closestRailT(piece.bez, p.x, p.z), at = formationAt(section.alignment,
        Math.max(st.u0, Math.min(st.u1, piece.u0 + sAtT(table(piece), t))));
      const dx = p.x - at.x, dz = p.z - at.z, lateral = dx * at.lx + dz * at.lz;
      if (lateral < st.lo - 0.3 || lateral > st.hi + 0.3 || Math.abs(dx * at.tx + dz * at.tz) > 0.3) continue;
      if (at.y - st.clearance.below < bottom && at.y + st.clearance.above > ground - 0.4) return false;
    }
  }
  return true;
}

/** Saved support positions; a width edit may refit them, a split or count reduction never does. */
function supports(g: Game, a: RailAlignment, span: CivilSpan, lo: number, hi: number, exclude: Set<number>, strict: boolean): RailStructure['supports'] {
  if (span.type !== 'bridge') return [];
  const out: RailStructure['supports'] = [], length = span.u1 - span.u0, n = Math.max(1, Math.ceil(length / 4)), offset = (lo + hi) / 2;
  for (let i = 0; i <= n; i++) {
    const target = span.u0 + length * i / n;
    let used = false;
    for (const shift of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const u = target + shift;
      if (u < span.u0 || u > span.u1 || out.length && u <= out.at(-1)!.u + 0.3 || !pierClear(g, a, u, offset, exclude)) continue;
      const p = formationAt(a, u, offset), kind = p.y - 0.31 - g.world.heightAt(p.x, p.z) < 0.4 ? 'abutment' : 'pier';
      out.push({ u, offset, kind }); used = true; break;
    }
    if (!used && strict) throw new Error('Pier blocked');
  }
  if (strict && (out[0]?.u > span.u0 + 1.6 || (out.at(-1)?.u ?? 0) < span.u1 - 1.6 || out.some((q, i) => i > 0 && q.u - out[i - 1].u > 7))) throw new Error('Pier span');
  return out;
}

/** Complete width checks, including the empty capacity retained after removing tracks. */
export function validateFormation(g: Game, a: RailAlignment, spans: CivilSpan[], lo: number, hi: number, exclude = new Set<number>(), groups: RailStructureDraft[] = []) {
  const w = g.world, net = w.net, n = Math.max(1, Math.ceil(a.length / 0.5)), lateral = Math.max(1, Math.ceil((hi - lo) / 0.25));
  const civilSamples = new Map<number, { piece: RailAlignmentPiece; count: number; pts: Float32Array }[]>();
  for (let i = 0; i <= n; i++) {
    const u = a.length * i / n, span = spans.find((s) => u >= s.u0 - 1e-6 && u <= s.u1 + 1e-6), group = groups.find((s) => u >= s.u0 - 1e-6 && u <= s.u1 + 1e-6);
    const type = span?.type ?? 'ground', bottom = type === 'bridge' ? 0.31 : type === 'tunnel' ? 0.2 : 0.1;
    const top = type === 'tunnel' ? group?.clearance.above ?? crown(lo, hi) : RAIL.clearance;
    const l0 = group?.lo ?? lo, l1 = group?.hi ?? hi;
    for (let j = 0; j <= lateral; j++) {
      const p = formationAt(a, u, l0 + (l1 - l0) * j / lateral), terrain = w.heightAt(p.x, p.z);
      if (!w.inside(p.x, p.z, 1)) throw new Error('Outside the map');
      if (type === 'bridge' && terrain > p.y - 0.065) throw new Error('Deck terrain');
      if (type === 'tunnel') {
        const atPortal = span && ((group?.portals[0] && u < span.u0 + 2) || (group?.portals[1] && u > span.u1 - 2));
        const required = atPortal ? Math.min(top + TUNNEL_LINING.cover, 0.8 + Math.min(u - span!.u0, span!.u1 - u) * 0.3) : top + TUNNEL_LINING.cover;
        if (terrain - p.y < required - 0.035) throw new Error(terrain < WATER_Y + 0.05 ? 'Tunnel water cover' : 'Tunnel cover');
        if (atPortal && terrain < WATER_Y + 0.05) throw new Error('Portal water');
      } else if (type === 'ground' && (terrain < WATER_Y + 0.05 || p.y - 0.1 < WATER_Y + 0.045 && terrain > p.y - 0.1 + 0.01)) throw new Error('Formation water');
      for (const b of w.buildingsNear(p.x, p.z, 2)) if (distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.05 && type === 'bridge' && b.y + b.floors * 0.3 + 0.4 > p.y - bottom) throw new Error('Deck blocked');
      for (const st of g.stations.footprintsNear(p.x, p.z, 0.2)) for (const f of g.stations.footprints(st)) {
        if (distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) > 0.1) continue;
        if (f.y0 !== undefined && f.y1 !== undefined && (p.y + top <= f.y0 || p.y - bottom >= f.y1)) continue;
        throw new Error('Station in the way');
      }
      for (const dp of g.depots.near(p.x, p.z, 0.4)) if (Math.abs(dp.y - p.y) < top + bottom) throw new Error('Depot in the way');
      for (const q of type === 'ground' ? [] : nearEdges(g, p.x, p.z, 2, exclude)) {
        if (q.d > net.halfWidth(q.e) + 0.015) continue;
        const otherTop = q.type === 'tunnel' ? TUNNEL_LINING.rail + 0.2 : RAIL.clearance, otherBottom = q.type === 'bridge' ? 0.31 : 0.1;
        if (p.y + top > q.y - otherBottom + 0.005 && p.y - bottom < q.y + otherTop - 0.005) throw new Error(q.type === 'tunnel' ? 'Bore clearance' : 'Formation clearance');
      }
      // A retained wide structure may have no rail at its outside edge. Its civil envelope still exists.
      for (const other of g.railSections.structuresNear(p.x - 0.1, p.z - 0.1, p.x + 0.1, p.z + 0.1)) {
        if (groups.some((q) => q.structure === other.id)) continue;
        const section = g.railSections.get(other.section)!;
        if (section.slots.every((slot) => slot.steps.every((step) => exclude.has(step.edge)))) continue;
        let samples = civilSamples.get(other.id);
        if (!samples) {
          samples = section.alignment.pieces.filter((piece) => piece.u1 >= other.u0 && piece.u0 <= other.u1).map((piece) => {
            const count = Math.max(2, Math.ceil((piece.u1 - piece.u0) / 0.5)), pts = new Float32Array((count + 1) * 3);
            for (let k = 0; k <= count; k++) { const q = formationAt(section.alignment, piece.u0 + (piece.u1 - piece.u0) * k / count); pts.set([q.x, q.y, q.z], k * 3); }
            return { piece, count, pts };
          }); civilSamples.set(other.id, samples);
        }
        for (const { piece, count, pts } of samples) {
          const q = closestOnPolyline(p.x, p.z, pts, 3, count + 1);
          const ou = piece.u0 + (piece.u1 - piece.u0) * (q.i + q.f) / count;
          if (ou < other.u0 || ou > other.u1) continue;
          const at = formationAt(section.alignment, ou), off = (p.x - at.x) * at.lx + (p.z - at.z) * at.lz;
          if (off < other.lo - 0.015 || off > other.hi + 0.015 || q.d > Math.max(Math.abs(other.lo), Math.abs(other.hi)) + 0.02) continue;
          if (p.y + top > at.y - other.clearance.below && p.y - bottom < at.y + other.clearance.above) throw new Error('Structure clearance');
        }
      }
    }
  }
}

function premium(g: Game, a: RailAlignment, span: CivilSpan, type: string, pieces: RailOffsetPiece[]) {
  let cost = 0, length = 0;
  for (const piece of pieces) {
    const q = memberSections({ ...piece, dir: 1 }, [span])[0]; if (!q) continue;
    const count = Math.max(1, Math.ceil((q.s1 - q.s0) / PSTEP)), tab = arcTable(piece.bez);
    for (let i = 0; i < count; i++) {
      const s0 = q.s0 + (q.s1 - q.s0) * i / count, s1 = q.s0 + (q.s1 - q.s0) * (i + 1) / count;
      const u = railUAtS({ ...piece, edge: 0, dir: 1 }, (s0 + s1) / 2), at = bezPoint(piece.bez, tAtS(tab, (s0 + s1) / 2));
      const y = alignmentHeight(a, u), terrain = g.world.heightAt(at.x, at.z), h = span.type === 'bridge' ? y - terrain : terrain - y;
      cost += TRACK_TYPES[type].costPerUnit * (structureFactor('rail', span.type, h) - 1) * (s1 - s0); length += s1 - s0;
    }
  }
  return { cost, maintenance: railCivilMaintenance(type, length, span.type) };
}

/** Quote each span once, with only positive expansion beyond its retained paid width. */
export function planRailStructures(g: Game, a: RailAlignment, spans: CivilSpan[], offsets: number[], type: string, old?: RailSection, additions: { offset: number; pieces: RailOffsetPiece[] }[] = []): RailStructureDraft[] {
  const exclude = new Set(old?.slots.flatMap((s) => s.steps.map((q) => q.edge)) ?? []), out: RailStructureDraft[] = [];
  for (const span of spans) {
    const previous = old?.structures.map((id) => g.railSections.structures.get(id)!).find((s) => s.type === span.type && Math.abs(s.u0 - span.u0) < 0.08 && Math.abs(s.u1 - span.u1) < 0.08 && s.slots.length === old.slots.length);
    if (old && !previous) throw new Error('Structure spans differ');
    const env = envelope(span, offsets), lo = Math.min(env.lo, previous?.lo ?? Infinity), hi = Math.max(env.hi, previous?.hi ?? -Infinity);
    const expansion = !previous || lo < previous.lo - 1e-5 || hi > previous.hi + 1e-5;
    if (additions.length && previous && !expansion && previous.type === 'bridge' && (!previous.supports.length || previous.supports.some((q) => !pierClear(g, a, q.u, q.offset, exclude)))) throw new Error('Pier blocked');
    const capacityOffsets = [...new Set([...(previous?.capacityOffsets ?? []), ...offsets])].sort((a, b) => a - b);
    const draft: RailStructureDraft = previous ? { ...copy(previous), structure: previous.id, cost: 0 } : {
      structure: null, version: 0, owner: old?.owner ?? -1, ...span, lo, hi, capacityOffsets, style: span.type === 'tunnel' ? 'bore' : 'girder', supports: [], portals: [false, false],
      clearance: { above: env.above, below: env.below }, civilCost: 0, maintenance: 0, cost: 0,
    };
    draft.lo = lo; draft.hi = hi; draft.capacityOffsets = capacityOffsets;
    if (expansion) {
      draft.version += previous ? 1 : 0;
      draft.clearance.above = span.type === 'tunnel' ? crown(lo, hi) : env.above;
      draft.portals = span.type === 'tunnel' ? portals(g, a, span, lo, hi) : [false, false];
      draft.supports = supports(g, a, span, lo, hi, exclude, true);
      for (let i = 0; i < offsets.length; i++) {
        const off = offsets[i];
        if (previous && off >= previous.lo + (span.type === 'bridge' ? 0.27 : 0.38) - 1e-5 && off <= previous.hi - (span.type === 'bridge' ? 0.27 : 0.38) + 1e-5) continue;
        const pieces = additions.find((a) => a.offset === off)?.pieces ?? offsetRailAlignment(a, off, 0, Infinity);
        const bill = premium(g, a, span, type, pieces), factor = previous || i > 0 ? SHARED_TRACK.structures : 1;
        draft.cost += bill.cost * factor; draft.maintenance += bill.maintenance * factor;
      }
      draft.civilCost += draft.cost;
      delete draft.legacyShares;
    }
    out.push(draft);
  }
  if (additions.length) {
    const pad = spans.some((s) => s.type === 'tunnel') ? 0.38 : 0.32;
    validateFormation(g, a, spans, Math.min(...offsets) - pad, Math.max(...offsets) + pad, exclude, out);
  }
  return out;
}

/** Metadata-only adoption. Capture the actual live upkeep, not construction.STRUCTURE_MAINT. */
export function adoptRailStructures(g: Game, s: RailSection) {
  if (s.structures.length) return;
  const groups: { span: CivilSpan; slots: RailSlot[] }[] = [];
  for (const slot of s.slots) for (const span of slotSpans(g, slot)) {
    let group = groups.find((q) => q.span.type === span.type && Math.abs(q.span.u0 - span.u0) < 0.08 && Math.abs(q.span.u1 - span.u1) < 0.08 && !q.slots.includes(slot));
    if (!group) { group = { span: { ...span }, slots: [] }; groups.push(group); }
    group.span.u0 = Math.min(group.span.u0, span.u0); group.span.u1 = Math.max(group.span.u1, span.u1); group.slots.push(slot);
  }
  groups.sort((a, b) => a.span.u0 - b.span.u0 || a.slots[0].offset - b.slots[0].offset);
  const exclude = new Set(s.slots.flatMap((slot) => slot.steps.map((q) => q.edge)));
  for (const { span, slots } of groups) {
    const offsets = slots.map((slot) => slot.offset), env = envelope(span, offsets);
    const legacyShares = slots.map((slot) => ({ offset: slot.offset, maintenance: railCivilMaintenance(s.type, civilLength(g, slot, span), span.type) }));
    const id = g.railSections.nextStructure++;
    const st: RailStructure = { id, version: 0, owner: s.owner, section: s.id, ...span, slots: slots.map((slot) => slot.id), lo: env.lo, hi: env.hi, capacityOffsets: offsets,
      style: span.type === 'tunnel' ? 'bore' : 'girder', supports: supports(g, s.alignment, span, env.lo, env.hi, exclude, false),
      portals: span.type === 'tunnel' ? portals(g, s.alignment, span, env.lo, env.hi) : [false, false], clearance: { above: env.above, below: env.below },
      civilCost: 0, maintenance: legacyShares.reduce((n, s) => n + s.maintenance, 0), legacyShares };
    g.railSections.structures.set(id, st); s.structures.push(id);
  }
}

/** Replace old per-edge civil premiums with one length-weighted group allocation. Wear remains per edge. */
export function sharedTrackMaintenance(g: Game, e: NEdge): number {
  const membership = g.railSections.membership(e.id);
  if (e.kind !== 'rail' || !membership) return trackMaintenance(e);
  const section = g.railSections.get(membership.section)!, slot = section.slots.find((q) => q.id === membership.slot)!;
  let bill = trackMaintenance(e);
  for (const id of section.structures) {
    const st = g.railSections.structures.get(id)!; if (!st.slots.includes(slot.id)) continue;
    const length = civilLength(g, slot, st, e.id); if (!length) continue;
    bill -= railCivilMaintenance(e.type, length, st.type);
    const members = section.slots.filter((q) => st.slots.includes(q.id));
    const total = members.reduce((n, q) => n + civilLength(g, q, st), 0);
    const shares = st.legacyShares;
    if (shares && shares.length === members.length && members.every((q) => shares.some((x) => x.offset === q.offset))) {
      bill += shares.find((q) => q.offset === slot.offset)!.maintenance * length / Math.max(1e-9, civilLength(g, slot, st));
    } else bill += st.maintenance * length / Math.max(1e-9, total);
  }
  return bill;
}

export function structureBounds(s: RailSection, st: RailStructure): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const n = Math.max(1, Math.ceil((st.u1 - st.u0) / 0.5));
  for (let i = 0; i <= n; i++) for (const off of [st.lo, st.hi]) {
    const p = formationAt(s.alignment, st.u0 + (st.u1 - st.u0) * i / n, off);
    x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z);
  }
  return [x0 - 4, z0 - 4, x1 + 4, z1 + 4];
}

/** Civil lock bit protects paid foundations and bore cover, without claiming ground-track height. */
export function lockRailStructures(g: Game, bounds?: [number, number, number, number]) {
  const w = g.world, b = bounds ?? [0, 0, w.size, w.size];
  for (let z = Math.max(0, Math.floor(b[1])); z <= Math.min(w.size, Math.ceil(b[3])); z++)
    for (let x = Math.max(0, Math.floor(b[0])); x <= Math.min(w.size, Math.ceil(b[2])); x++) w.lock[w.vi(x, z)] &= ~LOCK.civil;
  const stamp = (x: number, z: number, radius: number) => {
    for (let iz = Math.max(0, Math.floor(z - radius)); iz <= Math.min(w.size, Math.ceil(z + radius)); iz++)
      for (let ix = Math.max(0, Math.floor(x - radius)); ix <= Math.min(w.size, Math.ceil(x + radius)); ix++)
        if (ix >= b[0] && iz >= b[1] && ix <= b[2] && iz <= b[3]) w.lock[w.vi(ix, iz)] |= LOCK.civil;
  };
  for (const st of g.railSections.structuresNear(...b)) {
    if (st.legacyShares) continue; // legacy adoption must not change the historical lock grid
    const s = g.railSections.get(st.section)!;
    if (st.type === 'bridge') for (const support of st.supports) { const p = formationAt(s.alignment, support.u, support.offset); stamp(p.x, p.z, 0.3); }
    else {
      const n = Math.max(1, Math.ceil((st.u1 - st.u0) / 0.4)), nl = Math.max(1, Math.ceil((st.hi - st.lo) / 0.4));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= nl; j++) { const p = formationAt(s.alignment, st.u0 + (st.u1 - st.u0) * i / n, st.lo + (st.hi - st.lo) * j / nl); stamp(p.x, p.z, 0.8); }
    }
  }
}

export function validateRailStructures(g: Game) {
  const r = g.railSections;
  for (const s of r.sections.values()) {
    if (new Set(s.structures).size !== s.structures.length || s.structures.some((id) => r.structures.get(id)?.section !== s.id)) throw new Error('Invalid rail structure membership');
    for (const slot of s.slots) {
      const spans = s.structures.map((id) => r.structures.get(id)!).filter((st) => st.slots.includes(slot.id)).sort((a, b) => a.u0 - b.u0);
      if (spans.some((st, i) => i > 0 && st.u0 < spans[i - 1].u1 - 0.08)) throw new Error('Overlapping rail structures');
      const physical = slotSpans(g, slot);
      if (physical.length !== spans.length || physical.some((p, i) => p.type !== spans[i].type || Math.abs(p.u0 - spans[i].u0) > 0.08 || Math.abs(p.u1 - spans[i].u1) > 0.08)) throw new Error('Incomplete rail structures');
    }
  }
  for (const st of r.structures.values()) {
    const s = r.get(st.section), slots = s?.slots.filter((q) => st.slots.includes(q.id));
    if (!s || !s.structures.includes(st.id) || st.id >= r.nextStructure || !Number.isSafeInteger(st.version) || st.version < 0 || st.owner !== s.owner ||
        !['bridge', 'tunnel'].includes(st.type) || !['girder', 'truss', 'bore'].includes(st.style) || (st.type === 'tunnel') !== (st.style === 'bore') ||
        ![st.u0, st.u1, st.lo, st.hi, st.maintenance, st.civilCost, st.clearance?.above, st.clearance?.below].every(Number.isFinite) || st.u0 < -1e-5 || st.u1 > s.alignment.length + 0.08 || st.u1 <= st.u0 || st.lo >= st.hi || st.maintenance < 0 || st.civilCost < 0 || st.clearance.above <= 0 || st.clearance.below < 0 ||
        !slots?.length || slots.length !== st.slots.length || new Set(st.slots).size !== st.slots.length || slots.some((q) => q.offset < st.lo || q.offset > st.hi || civilLength(g, q, st) < 0.01) ||
        !st.capacityOffsets.length || st.capacityOffsets.some((v, i) => !Number.isFinite(v) || v < st.lo || v > st.hi || i > 0 && v <= st.capacityOffsets[i - 1]) ||
        !Array.isArray(st.portals) || st.portals.length !== 2 || st.portals.some((v) => typeof v !== 'boolean') ||
        st.supports.some((q, i) => !Number.isFinite(q.u + q.offset) || q.u < st.u0 || q.u > st.u1 || q.offset < st.lo || q.offset > st.hi || !['pier', 'abutment'].includes(q.kind) || i > 0 && q.u <= st.supports[i - 1].u) ||
        st.legacyShares && (st.legacyShares.some((q) => !Number.isFinite(q.offset + q.maintenance) || q.maintenance < 0) || Math.abs(st.legacyShares.reduce((n, q) => n + q.maintenance, 0) - st.maintenance) > 1e-5)) throw new Error('Invalid rail structure');
  }
}

/** A generic demolition/regeometry partitions bills over surviving civil intervals, without a second bill. */
export function partitionCivilBills(g: Game, old: RailSection, structures: RailStructure[], replacements: RailSection[]) {
  const newGroups = replacements.flatMap((s) => s.structures.map((id) => g.railSections.structures.get(id)!));
  const adjustments = new Map<RailStructure, number>();
  for (const st of structures) {
    const candidates: { group: RailStructure; length: number }[] = [], coverage: [number, number][] = [];
    for (const group of newGroups) {
      if (group.type !== st.type) continue;
      let length = 0;
      for (const slot of g.railSections.get(group.section)!.slots) for (const step of slot.steps) {
        const previous = old.slots.filter((s) => st.slots.includes(s.id)).flatMap((s) => s.steps).find((q) => q.edge === step.edge);
        if (!previous) continue;
        const a = memberSections(previous, [st])[0], b = memberSections(step, [group])[0];
        if (!a || !b) continue;
        const lo = Math.max(a.s0, b.s0), hi = Math.min(a.s1, b.s1); if (hi <= lo) continue;
        length += hi - lo;
        const u0 = railUAtS(previous, lo), u1 = railUAtS(previous, hi); coverage.push([Math.min(u0, u1), Math.max(u0, u1)]);
      }
      if (length > 0) candidates.push({ group, length });
    }
    coverage.sort((a, b) => a[0] - b[0]);
    let covered = 0, end = st.u0;
    for (const [u0, u1] of coverage) { covered += Math.max(0, u1 - Math.max(end, u0)); end = Math.max(end, u1); }
    const total = candidates.reduce((n, q) => n + q.length, 0), bill = st.maintenance * Math.min(1, covered / (st.u1 - st.u0));
    for (const q of candidates) {
      const raw = railCivilMaintenance(g.railSections.get(q.group.section)!.type, q.length, st.type);
      adjustments.set(q.group, (adjustments.get(q.group) ?? 0) + bill * q.length / total - raw);
    }
  }
  for (const [st, delta] of adjustments) {
    st.maintenance = Math.max(0, st.maintenance + delta);
    st.legacyShares = [{ offset: g.railSections.get(st.section)!.slots[0].offset, maintenance: st.maintenance }];
  }
}
