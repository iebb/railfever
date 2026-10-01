// Display formatting shared by the HUD, windows and tooltips.
import type { Game, News } from '../game/game';
import { MONTH_NAMES } from '../game/game';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../game/constants';

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

export function newsDate(g: Game, n: News): string {
  const { d, m, y } = dateOf(n.day, g.options.startYear);
  return `${d} ${MONTH_NAMES[m]} ${y}`;
}

/** Length in world units (10 m) as m / km. */
export const fmtLen = (u: number) => (u >= 100 ? `${(u / 100).toFixed(2)} km` : `${Math.round(u * 10)} m`);
/** Height offset in world units as ±m. */
export const fmtHeight = (h: number) => (h === 0 ? '±0 m' : `${h > 0 ? '+' : '−'}${Math.round(Math.abs(h) * 10)} m`);
export const fmtPct = (f: number, digits = 0) => `${(f * 100).toFixed(digits)}%`;
