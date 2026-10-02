// Small helpers on top of the game's company, AI, line and demand APIs shared by several UI modules.
import type { Game } from '../game/game';
import { MAX_AI_COMPANIES } from '../game/game';
import type { Company } from '../game/economy';
import type { Line } from '../game/lines';
import { LINE_PALETTES } from '../game/lines';
import type { LineKind } from '../game/constants';
import { AIConfig, DEFAULT_AI_CONFIG, AI_PRESETS, normalizeAIConfig } from '../game/ai';
import type { DemandView, DemandTown, DemandPair } from '../game/demand';
import type { StationPlan, Station } from '../game/stations';
import { STATION_RADIUS, BUSSTOP_RADIUS } from '../game/constants';

export type { AIConfig };
export { AI_PRESETS };

// ------------------------------------------------------------------ demand
export type { DemandView, DemandTown, DemandPair };

/** Share of the trips starting or ending in a town (incl. local trips) that the network can carry now. */
export function townDemandShare(v: DemandView, t: DemandTown): number {
  let pot = t.local, car = t.local * t.localServed;
  for (const p of v.pairs) if (p.a === t.id || p.b === t.id) { pot += p.potential; car += p.potential * p.served; }
  return pot > 0 ? car / pot : 0;
}

// ------------------------------------------------------------------ lines
/** Rename a line; an empty name returns to automatic naming. */
export function renameLine(g: Game, l: Line, name: string) { g.lines.rename(l.id, name); }

/** Set a line's colour; null returns to the automatic colour. */
export function setLineColor(g: Game, l: Line, color: string | null) { g.lines.setColor(l.id, color); }

/** Is the name still the automatic one? */
export function isAutoName(l: Line): boolean { return l.autoName; }

/** Colours offered for a line: the automatic colours of its mode (any other colour via the custom picker). */
export function linePalette(kind: LineKind): string[] { return LINE_PALETTES[kind]; }

// ------------------------------------------------------------------ companies
export const MAX_AI = MAX_AI_COMPANIES;
export const DEFAULT_AI: AIConfig = DEFAULT_AI_CONFIG;

export function liveCompanies(g: Game): Company[] { return g.activeCompanies; }
export function aiCount(g: Game): number { return g.activeCompanies.filter((c) => c.ai).length; }
export function aiConfigOf(g: Game, id: number): AIConfig | null { return g.aiOf(id)?.config ?? null; }

/** Update an AI's settings at runtime. */
export function applyAIConfig(g: Game, id: number, cfg: Partial<AIConfig>) {
  const ai = g.aiOf(id);
  if (ai) ai.config = normalizeAIConfig(cfg, ai.config);
}

/** Add an AI company; a string is the reason it could not be added. */
export function addAI(g: Game, cfg?: Partial<AIConfig>, name?: string, color?: string): Company | string {
  if (!g.canAddAI()) return `At most ${MAX_AI} AI companies`;
  try { return g.addAICompany(cfg, name, color); } catch (e) { return (e as Error).message; }
}

/** Matching preset of a configuration (ignoring start money), if any. */
export function presetOf(c: AIConfig): (typeof AI_PRESETS)[number] | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
  return AI_PRESETS.find((p) => near(p.config.activeness, c.activeness) && near(p.config.risk, c.risk)
    && near(p.config.focus.rail, c.focus.rail) && near(p.config.focus.road, c.focus.road) && near(p.config.focus.tram, c.focus.tram));
}

/** Configurations for a new game's AI companies by style ('mixed' = a different preset each). */
export function aiConfigsFor(style: string, n: number): AIConfig[] {
  const mixed = ['balanced', 'rail', 'bus', 'aggressive', 'tram', 'cautious', 'balanced'];
  return Array.from({ length: n }, (_, i) => normalizeAIConfig((AI_PRESETS.find((p) => p.id === (style === 'mixed' ? mixed[i % mixed.length] : style)) ?? AI_PRESETS[0]).config));
}

// ------------------------------------------------------------------ stations: levels, catchment, transfers
export type StationLevel = 'ground' | 'elevated' | 'underground';
export interface StationLevelOpts { level: StationLevel; height?: number; depth?: number }

/** Plan a rail station on the ground, elevated (viaduct) or underground (passed through when supported). */
export function planStation(g: Game, x: number, z: number, angle: number, length: number, tracks: number, owner: number, o?: StationLevelOpts): StationPlan {
  const plan = g.stations.planRail as unknown as (...a: unknown[]) => StationPlan;
  if (!o || o.level === 'ground') return plan.call(g.stations, x, z, angle, length, tracks, owner);
  return plan.call(g.stations, x, z, angle, length, tracks, owner, { ...o, underground: o.level === 'underground' });
}
/** Level of a planned or built station part ('ground' when the game does not know levels). */
export function levelOf(p: unknown): StationLevel {
  const q = p as { level?: StationLevel; underground?: boolean } | null;
  return q?.level ?? (q?.underground ? 'underground' : 'ground');
}

export type CatchMode = 'rail' | 'tram' | 'bus';
/** Catchment colours by mode (as --rail, --tram, --road). */
export const CATCH_COLOR: Record<CatchMode, number> = { rail: 0x5aa9ff, tram: 0xc084fc, bus: 0xff8a3d };
export interface CatchShape { x: number; z: number; r: number; mode: CatchMode }

/** Catchment circles of a station (the game's per-mode shapes, or rail / stop radii). */
export function catchShapes(g: Game, st: Station): CatchShape[] {
  const f = (g.stations as unknown as { catchmentShapes?: (s: Station) => { x: number; z: number; r: number; mode: string }[] }).catchmentShapes;
  if (f) return f.call(g.stations, st).map((c) => ({ x: c.x, z: c.z, r: c.r, mode: c.mode === 'rail' ? 'rail' : c.mode === 'tram' ? 'tram' : 'bus' }));
  const out: CatchShape[] = [];
  if (st.rail) out.push({ x: st.rail.x, z: st.rail.z, r: g.stations.catchmentRadius(st), mode: 'rail' });
  for (const p of st.stops) out.push({ x: p.x, z: p.z, r: BUSSTOP_RADIUS, mode: g.world.net.edges.get(p.edge)?.tram ? 'tram' : 'bus' });
  return out;
}
/** Catchment radius of a new station / stop of a mode (rail: by platform length). */
export function catchRadius(mode: CatchMode, platformLen = 16): number {
  const R = (globalThis as unknown as { __rfCatch?: Record<CatchMode, number> }).__rfCatch;
  if (R) return R[mode];
  return mode === 'rail' ? STATION_RADIUS + platformLen / 2 : mode === 'tram' ? Math.round(BUSSTOP_RADIUS * 1.4) : BUSSTOP_RADIUS;
}

/** Stations linked with `st` for transfers (its transfer complex), when the game supports links. */
export function stationLinks(_g: Game, st: Station): number[] {
  const l = (st as unknown as { links?: number[] }).links;
  return Array.isArray(l) ? l : [];
}
