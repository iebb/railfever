// Small helpers on top of the game's company, AI, line and demand APIs shared by several UI modules.
import type { Game } from '../game/game';
import { MAX_AI_COMPANIES } from '../game/game';
import type { Company } from '../game/economy';
import type { Line } from '../game/lines';
import { LINE_PALETTES } from '../game/lines';
import type { LineKind } from '../game/constants';
import { AIConfig, DEFAULT_AI_CONFIG, AI_PRESETS, normalizeAIConfig } from '../game/ai';
import type { DemandView, DemandTown, DemandPair } from '../game/demand';
import type { MailView } from '../game/mail-view';
import type { StationPlan, Station, StationLevel, CatchMode, CatchShape, StationOpts, RailMode } from '../game/stations';
import { CATCHMENT_RADIUS } from '../game/stations';
import { STATION_STYLES, stylesFor, defaultStationStyle } from '../game/station-styles';
import type { StationBuildingStyle } from '../game/station-styles';
import { readWalkingCatchment, planWalkingCatchment, walkingPopulation, WALK_DETOUR } from '../game/catchment';
import type { WalkingCatchment } from '../game/catchment';
import type { Overlay } from '../render/overlay';

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

/** Mail map volumes already use tonnes; retain a decimal for small town flows. */
export const fmtMailTonnes = (t: number) => t.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Town-pair data for the existing demand minimap; mail has no local trips or district choropleth. */
export function mailDemandView(v: MailView): DemandView {
  return {
    towns: v.towns.map((t) => ({
      id: t.id, x: t.x, z: t.z, pop: t.pop, potential: t.potential, served: t.share, stations: t.stations,
      generated: 0, transported: 0, local: 0, localServed: 0,
    })),
    pairs: v.pairs.map((p) => ({ a: p.a, b: p.b, dist: p.dist, potential: p.potential, served: p.share, mine: 0 })),
    regions: [], flows: [], maxPotential: v.maxPotential,
  };
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
export type { StationLevel, CatchMode, CatchShape };
export interface StationLevelOpts { level: StationLevel; height?: number; depth?: number }

/** Plan a rail station on the ground, elevated (viaduct) or underground (extra options: relocating etc.). */
export function planStation(g: Game, x: number, z: number, angle: number, length: number, tracks: number, owner: number, o?: StationLevelOpts, extra?: StationOpts): StationPlan {
  return g.stations.planRail(x, z, angle, length, tracks, owner, { ...(o ?? {}), ...(extra ?? {}) });
}
/** Level of a planned or built station part. */
export function levelOf(p: { level?: StationLevel } | null | undefined): StationLevel { return p?.level ?? 'ground'; }

/**
 * Catchment colours by mode (as --rail, --tram, --road): every rail station alike, whatever its track type;
 * inactive areas (no road access) are grey. Chosen to stay apart for colour-blind players too (delta E >= ~20
 * between modes under deuteranopia, protanopia and tritanopia); trams also get their own dash pattern (CATCH_DASH)
 * as a second cue.
 */
export const CATCH_COLOR: Record<CatchMode, number> = { rail: 0x5aa9ff, tram: 0xb25ec5, bus: 0xff8a3d };
/** Dash pattern of each mode's catchment streets: drawn share of a period and the period in screen px (none = solid). */
export const CATCH_DASH: Record<CatchMode, { dash: number; dashPx: number } | null> = {
  rail: null, bus: null, tram: { dash: 0.4, dashPx: 7 },
};
export const CATCH_INACTIVE = 0x7a8494;
export const catchColor = (c: CatchShape) => (c.active ? CATCH_COLOR[c.mode] : CATCH_INACTIVE);

/** Legacy station access/reach metadata. Street overlays use catchStreets. */
export function catchShapes(g: Game, st: Station, all = false): CatchShape[] { return g.stations.catchmentShapes(st, all); }
/** Nominal walking limit of a mode, before the street-grid allowance. */
export function catchRadius(mode: CatchMode): number { return CATCHMENT_RADIUS[mode]; }
/** Actual walking budget, including the grid detour calibration and the building style. */
export function catchWalkLimit(mode: CatchMode, bonus = 0): number { return CATCHMENT_RADIUS[mode] * (1 + bonus) * WALK_DETOUR; }
export const catchStreets = readWalkingCatchment;
export const planCatchStreets = planWalkingCatchment;
export const catchStreetPop = walkingPopulation;
/** Independent, mode-coloured (and mode-dashed) street layers; all three are cleared when a preview/view closes. */
export function drawCatchStreets(overlay: Pick<Overlay, 'setSegments'>, key: string, walk: WalkingCatchment | null, color?: number) {
  for (const mode of Object.keys(CATCH_COLOR) as CatchMode[]) {
    const segments = walk?.segments.filter((s) => s.mode === mode) ?? null;
    overlay.setSegments(`catch:${key}:${mode}`, segments, color ?? CATCH_COLOR[mode], CATCH_DASH[mode] ?? {});
  }
}

/** Stations linked with `st` for walking transfers. */
export function stationLinks(_g: Game, st: Station): number[] { return st.links ?? []; }

// ------------------------------------------------------------------ APIs still landing (feature detection)
/** A member of a module or object looked up by name at run time (undefined while the game layer lacks it). */
export function optional<T>(obj: unknown, name: string): T | undefined {
  const v = obj ? (obj as Record<string, unknown>)[name] : undefined;
  return v === undefined || v === null ? undefined : (v as T);
}

/** Walking-limit bonus of a station building style (e.g. 0.2 = +20% reach). */
export function catchBonusOf(styleId?: string): number {
  const s = styleId ? STATION_STYLES[styleId] : undefined;
  const b = optional<number>(s, 'catchBonus');
  return typeof b === 'number' && isFinite(b) ? b : 0;
}

/**
 * Legacy access metadata of a planned station with its building style's bonus: reach scaled by
 * (1 + catchBonus) where the planner has not applied it yet (works before and after the bonus lands).
 */
export function planCatchShapes(g: Game, plan: StationPlan): CatchShape[] {
  const shapes = g.stations.planCatchShapes(plan);
  const bonus = catchBonusOf(plan.style);
  if (!bonus) return shapes;
  return shapes.map((c) => {
    const base = CATCHMENT_RADIUS[c.mode];
    return Math.abs(c.r - base) < 1e-3 ? { ...c, r: base * (1 + bonus) } : c;
  });
}

/** Error text of a commit result (null / '' = OK, a string, or an object with `error`). */
export function errorOf(r: unknown): string | null {
  if (typeof r === 'string') return r || null;
  if (r && typeof r === 'object') { const e = (r as { error?: unknown }).error; return typeof e === 'string' && e ? e : null; }
  return null;
}

/** Building styles for a station tool: level, platform tracks and year; 'none' first. */
export function stationStyles(level: StationLevel, tracks: number, year: number): StationBuildingStyle[] {
  const list = stylesFor(level, tracks, year);
  // UPDATE 9m: a building is optional at every level ('none' may not be listed for a level yet)
  if (!list.some((s) => s.id === 'none') && STATION_STYLES.none) list.unshift(STATION_STYLES.none);
  return list.sort((a, b) => (a.id === 'none' ? -1 : b.id === 'none' ? 1 : 0));
}

/** The automatic style for a new station (defaultStationStyle with the nearest town's population). */
export function autoStationStyle(g: Game, x: number, z: number, tracks: number, level: StationLevel, mode: RailMode): string {
  const t = g.towns.nearest(x, z);
  const pop = t && Math.hypot(t.x - x, t.z - z) < t.radius + 30 ? t.pop : 0;
  return defaultStationStyle(g.year, tracks, level, mode, pop);
}
