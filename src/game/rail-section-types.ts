// Saved authoring metadata. Network.Section remains a bridge/tunnel interval on one physical edge.
import type { Bez } from './geom';

export type TrackCount = 1 | 2 | 3 | 4;
export type RailKnot = [u: number, s: number];
export interface RailStep {
  edge: number;
  dir: 1 | -1;
  u0: number;
  u1: number;
  /** Increasing reference distance; s is measured in the physical edge's stored direction. */
  knots: RailKnot[];
}
export interface RailSlot { id: number; offset: number; steps: RailStep[] }
export interface RailAlignmentPiece { u0: number; u1: number; bez: Bez; prof: number[] }
export interface RailAlignment { length: number; pieces: RailAlignmentPiece[] }
export interface RailPortRef {
  kind: 'terminal' | 'plain' | 'junction' | 'station' | 'depot';
  /** One node per slot, in lateral order. */
  nodes: number[];
  station?: number;
  junction?: number;
}
export interface SectionTraffic {
  policy: 'two-way' | 'auto' | 'custom';
  /** Only signals made by section operations have provenance. Legacy signals are custom. */
  signals: { node: number; signal: number; kind: 'block' | 'path'; pass: boolean }[];
}
export interface RailSection {
  id: number;
  version: number;
  owner: number;
  /** Canonical wire state, independent of station mode. */
  type: string;
  count: TrackCount;
  alignment: RailAlignment;
  slots: RailSlot[];
  ends: [RailPortRef, RailPortRef];
  traffic: SectionTraffic;
  structures: number[];
  origin: 'authored' | 'derived';
}
export interface RailJunction {
  id: number;
  version: number;
  origin: 'manual' | 'generated';
  nodes: number[];
  ports: { section: number; end: 0 | 1 }[];
  routes: { from: number; to: number }[];
  connectors: number[];
  crossings: number[];
  signals: number[];
}
/** Reserved for shared civil works; no groups are inferred or billed in stages 1–2. */
export interface RailStructure {
  id: number;
  owner: number;
  section: number;
  u0: number;
  u1: number;
  slots: number[];
  type: 'bridge' | 'tunnel';
}
export interface RailSectionsSave {
  schema: 1;
  version: number;
  nextSection: number;
  nextSlot: number;
  nextJunction: number;
  nextStructure: number;
  sections: RailSection[];
  junctions: RailJunction[];
  structures: RailStructure[];
}
export interface RailMembership { section: number; slot: number; step: RailStep }

/** Piecewise interpolation, also valid for a reversed physical edge. */
export function railSAtU(step: RailStep, u: number): number {
  const k = step.knots;
  if (u <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (u <= k[i][0]) {
    const f = (u - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
    return k[i - 1][1] + f * (k[i][1] - k[i - 1][1]);
  }
  return k[k.length - 1][1];
}
export function railUAtS(step: RailStep, s: number): number {
  const k = step.knots, d = step.dir;
  if (d * s <= d * k[0][1]) return k[0][0];
  for (let i = 1; i < k.length; i++) if (d * s <= d * k[i][1]) {
    const f = (s - k[i - 1][1]) / (k[i][1] - k[i - 1][1]);
    return k[i - 1][0] + f * (k[i][0] - k[i - 1][0]);
  }
  return k[k.length - 1][0];
}
