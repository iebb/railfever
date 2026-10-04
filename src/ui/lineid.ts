// Line identity: JR-style rail symbols (the company letter + route letter on the line colour), rail station numbering
// badges (AS01: white rounded square with the line colour as its border), the transport mode of a line (rail is one
// mode: main-line, metro and light-rail track and stations are construction styles of it), and the per-view mode /
// company filters of every line view (remembered in localStorage).
import type { Game } from '../game/game';
import { PLAYER } from '../game/game';
import type { Line } from '../game/lines';
import type { Vehicle } from '../game/vehicle';
import type { VehicleModel } from '../game/vehicle-types';
import { h, icon, esc } from './dom';

export type LineMode = 'rail' | 'tram' | 'bus' | 'coach';
export const LINE_MODES: LineMode[] = ['rail', 'tram', 'bus', 'coach'];
export const MODE_META: Record<LineMode, { label: string; icon: string; color: string }> = {
  rail: { label: 'Rail', icon: 'train', color: 'var(--rail)' },
  tram: { label: 'Tram', icon: 'tram', color: 'var(--tram)' },
  bus: { label: 'Bus', icon: 'bus', color: 'var(--road)' },
  coach: { label: 'Coach', icon: 'coach', color: 'var(--coach)' },
};

/** Readable text colour on a background colour (#rrggbb): near-black on light colours, white on dark ones. */
export function inkOn(bg: string): string {
  const n = parseInt(bg.replace('#', '').slice(0, 6), 16);
  if (!isFinite(n)) return '#ffffff';
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#0d1219' : '#ffffff';
}

const isCoach = (m: VehicleModel | null | undefined) => !!m && m.kind === 'bus' && /coach/.test(m.style ?? '');

/**
 * Mode of a line: every rail line is 'rail' (whatever mix of main-line, metro and light-rail track and stations it
 * uses), road lines by their vehicles (coaches: long-distance), trams.
 */
export function lineMode(g: Game, l: Line): LineMode {
  if (l.kind === 'tram') return 'tram';
  if (l.kind === 'road') {
    let c = 0, b = 0;
    for (const id of l.vehicles) { const v = g.vehicles.get(id) as unknown as { model?: VehicleModel | null } | undefined; if (!v) continue; if (isCoach(v.model)) c++; else b++; }
    return c > b ? 'coach' : 'bus';
  }
  return 'rail';
}

/** Mode of a vehicle: its line's, else by its model (trains: rail; coaches, trams, buses). */
export function vehicleMode(g: Game, v: Vehicle): LineMode {
  if (v.line) return lineMode(g, v.line);
  const t = v as unknown as { cars?: VehicleModel[]; model?: VehicleModel | null };
  if (t.cars) return 'rail';
  return t.model?.kind === 'tram' ? 'tram' : isCoach(t.model) ? 'coach' : 'bus';
}

// ------------------------------------------------------------------ symbols and badges
/** A rail line's symbol text: company letter + route letter (Lines.lineCode), or R + number; '' for other modes. */
export function lineCodeOf(g: Game, l: Line): string {
  if (l.kind !== 'rail') return '';
  const c = l.code ? (g.company(l.owner).code ?? '?') + l.code : '';
  return c && !c.includes('?') ? c : 'R' + l.num;
}

/** Rail: JR-style code symbol. Other modes: a plain chip in the line colour, paired with the name by callers. */
export function lineSymbol(g: Game, l: Line, size: '' | 'sm' | 'lg' = ''): HTMLElement {
  if (l.kind !== 'rail') return h('span', { class: 'lcolor' + (size ? ' ' + size : ''), style: `--c:${l.color}`, 'aria-label': l.name });
  const code = lineCodeOf(g, l);
  return h('span', { class: 'lsym' + (size ? ' ' + size : ''), style: `--c:${l.color};--ink:${inkOn(l.color)}`, 'aria-label': `Line ${code}` }, code);
}

/** Symbol + name of a line as one clickable chip (lists, station windows). */
export function lineTag(g: Game, l: Line, onClick?: () => void): HTMLElement {
  return h('span', { class: 'ltag' + (onClick ? ' link' : ''), style: `--c:${l.color}`, onclick: onClick }, lineSymbol(g, l, 'sm'), h('span', { class: 'ltag-n' }, l.name));
}

/** A station number on a line: the full code, its letters (company + route) and number, the line and its colour. */
export interface Badge { code: string; prefix: string; num: string; color: string; line: number }

/** Split a station code by the line's route letters ('AS01' with route 'S' -> 'AS' + '01'). */
export function splitCode(code: string, route: string): { prefix: string; num: string } {
  const i = route ? code.lastIndexOf(route) : -1;
  if (i >= 0 && /^\d+$/.test(code.slice(i + route.length))) return { prefix: code.slice(0, i + route.length), num: code.slice(i + route.length) };
  const m = /^(.*?)(\d{2,})$/.exec(code);
  return m ? { prefix: m[1], num: m[2] } : { prefix: code, num: '' };
}

/** Numbering badge element: the letters over the number in a white rounded square with a coloured border. */
export function badgeEl(b: Badge, size: '' | 'sm' | 'lg' = '', tip = true): HTMLElement {
  return h('span', { class: 'snum' + (size ? ' ' + size : ''), style: `--c:${b.color}`, 'data-tip': tip ? b.code : undefined, 'aria-label': b.code }, h('i', null, b.prefix), h('b', null, b.num));
}

/** Same badge for throttled HTML hover cards, without constructing throwaway DOM nodes. */
export function badgeHtml(b: Badge, size: '' | 'sm' | 'lg' = ''): string {
  return `<span class="snum${size ? ' ' + size : ''}" style="--c:${esc(b.color)}" aria-label="${esc(b.code)}"><i>${esc(b.prefix)}</i><b>${esc(b.num)}</b></span>`;
}

interface BadgeCache { ver: number; n: number; stations: number; t: number; map: Map<number, Badge[]> }
const badgeCaches = new WeakMap<Game, BadgeCache>();

/**
 * Rail station numbering badges of every station (one per serving rail line, in line order), cached: rebuilt when the line
 * network changes, and every few seconds for colour changes. One map read per station afterwards.
 */
export function allBadges(g: Game): Map<number, Badge[]> {
  const now = performance.now();
  let c = badgeCaches.get(g);
  if (c && c.ver === g.lines.version && c.n === g.lines.map.size && c.stations === g.stations.map.size && now - c.t < 3000) return c.map;
  const map = new Map<number, Badge[]>();
  const L = g.lines as unknown as { stationCode?: (l: number, s: number) => string; routeCode?: (l: Line) => string };
  if (L.stationCode && L.routeCode) {
    const lines = [...g.lines.map.values()].filter((l) => l.kind === 'rail' && l.stops.length > 0).sort((a, b) => a.id - b.id);
    for (const l of lines) {
      const route = L.routeCode.call(g.lines, l);
      for (const sid of new Set(l.stops)) {
        if (!g.stations.map.has(sid)) continue;
        const code = L.stationCode.call(g.lines, l.id, sid);
        if (!code) continue;
        const sp = splitCode(code, route);
        const arr = map.get(sid);
        const b: Badge = { code, prefix: sp.prefix, num: sp.num, color: l.color, line: l.id };
        if (arr) arr.push(b); else map.set(sid, [b]);
      }
    }
  }
  // Keep unchanged lists (and the map itself) stable across the periodic colour check.
  for (const [sid, list] of map) {
    const old = c?.map.get(sid);
    if (old && old.length === list.length && old.every((b, i) => {
      const n = list[i];
      return b.code === n.code && b.prefix === n.prefix && b.num === n.num && b.color === n.color && b.line === n.line;
    })) map.set(sid, old);
  }
  const same = c && c.map.size === map.size && [...map].every(([sid, list]) => c!.map.get(sid) === list);
  c = { ver: g.lines.version, n: g.lines.map.size, stations: g.stations.map.size, t: now, map: same ? c!.map : map };
  badgeCaches.set(g, c);
  return c.map;
}

/** A station's numbering badges (empty when no numbered line stops there). */
const NO_BADGES: Badge[] = [];
export function stationBadges(g: Game, stationId: number): Badge[] { return allBadges(g).get(stationId) ?? NO_BADGES; }

/** The badge of one station on one line, if any. */
export function badgeOn(g: Game, lineId: number, stationId: number): Badge | null {
  return stationBadges(g, stationId).find((b) => b.line === lineId) ?? null;
}

/** Row of a station's badges (at most `max`, then +n). */
export function badgeRow(g: Game, stationId: number, max = 4, size: '' | 'sm' | 'lg' = ''): HTMLElement | null {
  const bs = stationBadges(g, stationId);
  if (!bs.length) return null;
  return h('span', { class: 'snums' }, bs.slice(0, max).map((b) => badgeEl(b, size)), bs.length > max ? h('span', { class: 'snum-more' }, `+${bs.length - max}`) : null);
}

// ------------------------------------------------------------------ filters (per view)
/** A line view's filter: hidden modes and whose lines ('mine', 'all' or a company id). */
export interface LineFilter { hidden: LineMode[]; company: 'mine' | 'all' | number }
const FILTER_KEY = 'railfever.filters';
let filterStore: Record<string, LineFilter> | null = null;

function store(): Record<string, LineFilter> {
  if (filterStore) return filterStore;
  try { filterStore = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') ?? {}; } catch { filterStore = {}; }
  return filterStore!;
}

/** The filter of a view (default: every mode, the player's lines). Modes no longer listed (the former metro and
 * light-rail chips, now rail) are dropped from remembered filters. */
export function getFilter(view: string, def: LineFilter['company'] = 'mine'): LineFilter {
  const s = store();
  const f = s[view];
  if (!f || !Array.isArray(f.hidden)) s[view] = { hidden: [], company: def };
  else f.hidden = f.hidden.filter((m) => LINE_MODES.includes(m));
  return s[view];
}

export function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(store())); } catch { /* ignore */ }
}

/** A remembered company may have been bought out or be absent from the loaded game. */
export function validateFilter(g: Game, f: LineFilter): boolean {
  if (f.company === 'mine' || f.company === 'all') return false;
  if (typeof f.company === 'number' && f.company !== PLAYER && g.activeCompanies.some((c) => c.id === f.company)) return false;
  f.company = 'mine';
  saveFilters();
  return true;
}

/** Does a line pass a view's filter? */
export function lineMatches(g: Game, l: Line, f: LineFilter): boolean {
  validateFilter(g, f);
  if (f.company === 'mine') { if (l.owner !== PLAYER && !l.operators?.includes(PLAYER)) return false; }
  else if (f.company !== 'all' && l.owner !== f.company && !l.operators?.includes(f.company)) return false;
  return !f.hidden.includes(lineMode(g, l));
}

/** Does a vehicle pass a view's filter? */
export function vehicleMatches(g: Game, v: Vehicle, f: LineFilter): boolean {
  validateFilter(g, f);
  if (f.company === 'mine' ? v.owner !== PLAYER : f.company !== 'all' && v.owner !== f.company) return false;
  return !f.hidden.includes(vehicleMode(g, v));
}

/**
 * Filter bar: a chip per mode (click: show / hide; double-click: only this mode) with counts, and whose lines.
 * `compact`: icons only (narrow cards). `onChange` runs after every change (the filter is saved).
 */
export function filterBar(g: Game, f: LineFilter, counts: Partial<Record<LineMode, number>>, onChange: () => void, compact = false, owners = true): HTMLElement {
  validateFilter(g, f);
  const chips = LINE_MODES.filter((m) => (counts[m] ?? 0) > 0 || !f.hidden.includes(m) || m === 'rail' || m === 'bus').map((m) => {
    const on = !f.hidden.includes(m), n = counts[m] ?? 0;
    const meta = MODE_META[m];
    return h('button', {
      class: 'fchip' + (on ? ' on' : '') + (n ? '' : ' none'), style: `--c:${meta.color}`, role: 'checkbox', 'aria-checked': on ? 'true' : 'false', 'aria-label': meta.label,
      'data-tip': `${meta.label}: ${n} · click: ${on ? 'hide' : 'show'}; double-click: only these`, 'data-sfx': 'toggle',
      onclick: () => { f.hidden = on ? [...f.hidden, m] : f.hidden.filter((x) => x !== m); saveFilters(); onChange(); },
      ondblclick: () => { f.hidden = LINE_MODES.filter((x) => x !== m); saveFilters(); onChange(); },
    }, icon(meta.icon, 14), compact ? null : h('span', null, meta.label), n ? h('small', null, String(n)) : null);
  });
  let sel: HTMLSelectElement | null = null;
  if (owners) {
    sel = h('select', { class: 'select fsel' + (compact ? ' sm' : ''), 'aria-label': 'Company' },
      h('option', { value: 'mine', selected: f.company === 'mine' }, 'Yours'),
      h('option', { value: 'all', selected: f.company === 'all' }, 'All companies'),
      g.activeCompanies.filter((c) => c.id !== PLAYER).map((c) => h('option', { value: String(c.id), selected: f.company === c.id }, c.name))) as HTMLSelectElement;
    sel.addEventListener('change', () => { const v = sel!.value; f.company = v === 'mine' || v === 'all' ? v : Number(v); saveFilters(); onChange(); });
  }
  return h('div', { class: 'filterbar' + (compact ? ' compact' : '') }, h('div', { class: 'fchips', role: 'group', 'aria-label': 'Modes' }, chips), sel);
}

/** Line counts per mode (for the filter chips), of the lines passing the company part of the filter. */
export function modeCounts(g: Game, lines: Line[], f: LineFilter): Partial<Record<LineMode, number>> {
  validateFilter(g, f);
  const out: Partial<Record<LineMode, number>> = {};
  const only = { hidden: [] as LineMode[], company: f.company };
  for (const l of lines) if (lineMatches(g, l, only)) { const m = lineMode(g, l); out[m] = (out[m] ?? 0) + 1; }
  return out;
}
