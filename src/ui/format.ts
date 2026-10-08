// Display formatting shared by the HUD, windows and tooltips.
import { ACCESS_CAP } from '../game/access-cost';
import type { Game, News } from '../game/game';
import type { Line } from '../game/lines';
import type { Station } from '../game/stations';
import { MONTH_NAMES } from '../game/game';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, MAIL_UNIT_T } from '../game/constants';
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
/** Fixed full-cost fraction at equal use; wear is reimbursed separately. */
export const equalUseShare = (p: number) => Math.min(ACCESS_CAP, Math.max(0, p) / 2);
export const fmtAccessFactor = (p: number) => `×${Number(p.toFixed(5))} of cost`;

/** Mail (whole units of MAIL_UNIT_T) in tonnes, without the unit: 0.4, 12.5, 1,240. */
export function tonnes(units: number): string {
  const t = Math.max(0, units) * MAIL_UNIT_T;
  return t < 100 ? String(Math.round(t * 10) / 10) : Math.round(t).toLocaleString('en-US');
}
/** Mail in tonnes with the unit: "2.4 t". */
export const fmtMail = (units: number) => `${tonnes(units)} t`;
/** Load of a vehicle's mail room: "2.4 / 6 t". */
export const fmtMailLoad = (load: number, room: number) => `${tonnes(load)} / ${tonnes(room)} t`;

/** Does a vehicle of the line carry mail, or has the line carried any (Line.mail)? Reads only. */
export function lineCarriesMail(g: Game, l: Line): boolean {
  if (l.mail) return true;
  for (const id of l.vehicles) if (g.vehicles.get(id)?.carries('mail')) return true;
  return false;
}

/**
 * Should the station show mail: it has handled mail (Station.mail) or a vehicle with room for mail calls there. Never
 * at a tram stop (trams carry no mail). Reads only: the UI never creates mail state.
 */
export function stationShowsMail(g: Game, s: Station): boolean {
  if (!s.mail && !g.lines.mailServed(s.id)) return false;
  if (s.rail) return true;
  const lines = g.lines.linesAt(s.id);
  return lines.length ? lines.some((l) => l.kind !== 'tram') : !s.stops.every((p) => !!g.world.net.edges.get(p.edge)?.tram);
}

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

/** Short names and colours of the track types (type picker, route summaries). */
export const TYPE_META: Record<string, { short: string; color: string }> = {
  standard: { short: 'Standard', color: '#9aa5b4' }, electric: { short: 'Electric', color: '#5aa9ff' }, highspeed: { short: 'High-speed', color: '#ff5a5f' },
  metro: { short: 'Metro', color: '#2ec4b6' }, lightrail: { short: 'Light rail', color: '#9bd16a' },
};
