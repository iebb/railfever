// Display formatting shared by the HUD, windows and tooltips.
import type { Game, News } from '../game/game';
import { MONTH_NAMES } from '../game/game';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../game/constants';
import type { LineKind } from '../game/constants';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Calendar date with real month lengths (the simulation uses 30-day months; days map proportionally). */
export function dateOf(day: number, startYear: number): { d: number; m: number; y: number } {
  const m = Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
  const y = startYear + Math.floor(day / (DAYS_PER_MONTH * MONTHS_PER_YEAR));
  const dom = day % DAYS_PER_MONTH;
  const len = MONTH_DAYS[m];
  return { d: Math.min(len, Math.floor((dom * len) / DAYS_PER_MONTH) + 1), m, y };
}

export function fmtDate(g: Game): string {
  const { d, m, y } = dateOf(g.day, g.options.startYear);
  return `${d} ${MONTH_NAMES[m]} ${y}`;
}

/** Month and year of a game day: "Mar 1952". */
export function fmtMonthYear(g: Game, day: number): string {
  const { m, y } = dateOf(day, g.options.startYear);
  return `${MONTH_NAMES[m]} ${y}`;
}

export function newsDate(g: Game, n: News): string {
  const { d, m, y } = dateOf(n.day, g.options.startYear);
  return `${d} ${MONTH_NAMES[m]} ${y}`;
}

/** Length in world units (10 m) as m / km. */
export const fmtLen = (u: number) => (u >= 100 ? `${(u / 100).toFixed(2)} km` : `${Math.round(u * 10)} m`);
/** Height offset in world units as ±m. */
export const fmtHeight = (h: number) => (h === 0 ? '±0 m' : `${h > 0 ? '+' : '−'}${Math.round(Math.abs(h) * 10)} m`);
export const fmtPct = (f: number, digits = 0) => `${(f * 100).toFixed(digits)}%`;
/** Track access multiplier: ×2, ×1.25, ×0.5. */
export const fmtMult = (m: number) => `×${Number.isInteger(m) ? m : m.toFixed(2).replace(/0$/, '')}`;
/** Share of an item's maintenance a user pays at multiplier m when it uses the item as much as the owner. */
export const equalUseShare = (m: number) => (m > 0 ? m / (1 + m) : 0);

/** Compact money for floating text: $850, $1.2k, $45k, $1.25M. */
export function fmtCompact(x: number): string {
  const a = Math.abs(x), sgn = x < 0 ? '−' : '';
  if (a >= 1e6) return `${sgn}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sgn}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sgn}$${Math.round(a)}`;
}

/** Display metadata per transport mode. */
export const KIND_META: Record<LineKind, { label: string; icon: string; vehicle: string; vehicles: string; color: string }> = {
  rail: { label: 'Rail', icon: 'train', vehicle: 'train', vehicles: 'trains', color: 'var(--rail)' },
  road: { label: 'Bus', icon: 'bus', vehicle: 'bus', vehicles: 'buses', color: 'var(--road)' },
  tram: { label: 'Tram', icon: 'tram', vehicle: 'tram', vehicles: 'trams', color: 'var(--tram)' },
};
