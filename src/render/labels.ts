// In-world signage: town name plates and station plates (company colour, pictogram, JR-style numbering badges,
// waiting count, stop marks of open lines), one plate per transfer complex. In the lines map: the station numbers
// drawn on the stations themselves (line display) or station pins with all their numbers (station display), and the
// name tag of the line under the pointer. Priority-capped, decluttered, terrain-occluded; DOM writes only on change.
import * as THREE from 'three';
import { PLAYER, type Game } from '../game/game';
import type { Station } from '../game/stations';
import { WATER_Y } from '../game/constants';
import { ROUTE_LIFT } from './overlay';
import { svg } from '../ui/icons';
import { uiScale } from '../ui/uiscale';

/** A station number badge as the UI computes it (ui/lineid.ts Badge); `line`: the line it numbers (hover, tap). */
export interface LabelBadge { code: string; prefix: string; num: string; color: string; line?: number; station?: number }

/**
 * A station in the lines map's line display, drawn on the station itself: its numbering badges on the lines shown
 * (a stop dot in its first line's colour when none of them numbers it). Built by the UI when the lines, the filter or
 * the highlighted lines change; the label's DOM is rebuilt only when `sig` changes.
 */
export interface StationMark {
  /** Global focused/open route order, retained when physical members share one marker. */
  order?: Record<number, number>;
  badges: LabelBadge[];
  /** the lines shown that stop here; a hover or tap on the stop dot (or the name) picks the first */
  lines: number[];
  /** stop dot colour (stations without numbers) */
  color: string;
  /** interchange rank (lines at the station or its transfer complex): interchanges win where markers overlap */
  rank: number;
  /** on a highlighted line (placed first), or dimmed while another line is highlighted */
  on: boolean;
  dim: boolean;
  /** content signature */
  sig: string;
}

/** A line name tag: anchor, text, colour, highlighted, line symbol; drawn `gap` px above the anchor, or below it. */
export interface RouteTag { x: number; y: number; z: number; text: string; color: string; hl: boolean; code?: string; gap?: number; below?: boolean }

const STATION_NAME_MAX_DIST = 170;
/**
 * Hysteresis of the label selection: a label shown in the last frame keeps this much priority (about 12 units of
 * distance for a station plate) and must sink clearly behind the terrain before it is hidden, so labels that
 * compete for a place don't trade it back and forth while the camera moves or waiting counts change.
 */
const LABEL_KEEP = 500;
const OCCLUDE_KEEP = 0.4;
// Three ordinary wheel notches: exp(100 * 0.0014) per notch (camera.ts).
const RAIL_SYMBOL_MAX_DIST = STATION_NAME_MAX_DIST * Math.exp(3 * 100 * 0.0014);
const RAIL_SYMBOL_FADE_DIST = STATION_NAME_MAX_DIST * Math.exp(2 * 100 * 0.0014);
const RAIL_SYMBOL_SIZE = 28;
/**
 * Other companies' bus and tram stops: name plates only up close; in the town view a small stop symbol in the
 * company colour (name on hover) that gives way to town names and to the player's stations.
 */
const RIVAL_STOP_NAME_DIST = 55;
const MINOR_STOP_SIZE = 20;
/** a small numbering badge on a plate (25 px square + 2 px gap, style.css .snum.sm) and a plate showing badges */
const BADGE_W = 27, BADGED_PLATE_H = 29;
/**
 * Station numbers on the stations (lines map): badges side by side before "+n", a badge's height, a stop dot, the
 * "+n" pill; beyond the rail-symbol zoom band only the first number shows (with "+n"), and fully zoomed out the
 * markers are drawn at MARK_MIN_SCALE (numbers stay >= 9 px at the default interface size).
 */
const MARK_ROW = 3, MARK_BH = 25, MARK_DOT = 14, MARK_MORE_W = 22;
const MARK_FAR_DIST = RAIL_SYMBOL_MAX_DIST;
const MARK_MIN_SCALE = 0.84, MARK_SCALE_DIST = 700;
/** labels on screen with station numbers shown (they are small) */
const MARK_CAP = 150;
/** px town names stand higher while station numbers are shown */
const TOWN_LIFT = 10;

/** Normal station plates become rail-only symbols for three more zoom steps. */
export function stationLabelMode(camDist: number, rail: boolean): 'plate' | 'symbol' | 'hidden' {
  if (camDist < STATION_NAME_MAX_DIST) return 'plate';
  return rail && camDist < RAIL_SYMBOL_MAX_DIST ? 'symbol' : 'hidden';
}

/** Smoothly fade the symbols over the last of those steps; no temporary objects. */
export function railSymbolOpacity(camDist: number): number {
  const t = Math.max(0, Math.min(1, (RAIL_SYMBOL_MAX_DIST - camDist) / (RAIL_SYMBOL_MAX_DIST - RAIL_SYMBOL_FADE_DIST)));
  return t * t * (3 - 2 * t);
}

/** Scale of the lines map's station numbers: 1 up to the station-name zoom, MARK_MIN_SCALE fully zoomed out. */
export function markScale(camDist: number): number {
  const t = Math.max(0, Math.min(1, (camDist - STATION_NAME_MAX_DIST) / (MARK_SCALE_DIST - STATION_NAME_MAX_DIST)));
  return 1 - (1 - MARK_MIN_SCALE) * t;
}

/** Height of a station's numbers in the lines map: on its routes (platform tracks, or the road at its stops). */
export function markY(game: Game, s: Station): number {
  return (s.rail ? s.rail.y : Math.max(game.world.heightAt(s.x, s.z), WATER_Y)) + ROUTE_LIFT;
}

/** Half the screen height of a station's numbers (px), for placing a line tag below them. */
export function markHalfHeight(camDist: number): number { return (MARK_BH / 2) * markScale(camDist) * uiScale(); }

/** Anchor of a station pin (lines map, station display): the dot at the foot of the pin. */
export function pinY(game: Game, s: Station): number {
  return (s.rail ? s.rail.y + 1.0 : Math.max(game.world.heightAt(s.x, s.z), WATER_Y) + 0.8) - 0.9;
}

interface Label {
  el: HTMLDivElement;
  kind: 'town' | 'stn' | 'tag' | 'mk';
  /** town, station or line id */
  id: number;
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  ico: HTMLSpanElement | null;
  mark: HTMLSpanElement | null;
  badges: HTMLSpanElement | null;
  sym: HTMLSpanElement | null;
  /** station numbers (lines map): the further badges, the "+n" pill and the stop dot */
  extra: HTMLSpanElement | null;
  more: HTMLSpanElement | null;
  dot: HTMLSpanElement | null;
  text: string; subText: string; markText: string; markColor: string; icoKind: string; cls: string; bg: string; symText: string; markSig: string;
  badgeData: string[]; badgeMax: number; nBadges: number;
  /** tags: px between the anchor and the tag, and whether it hangs below the anchor */
  gap: number; below: boolean;
  sx: number; sy: number; sc: number; op: number; z: number; shown: boolean;
  refreshed: number; served: boolean; waiting: number; size: number; activity: number;
  /** another company's bus / tram stop (a small symbol that yields to town names and the player's stations) */
  minor: boolean;
  occAt: number; occVersion: number; occMargin: number; occluded: boolean;
  occX: number; occY: number; occZ: number; occCX: number; occCY: number; occCZ: number;
}

interface Cand { l: Label; x: number; y: number; z: number; prio: number; maxDist: number; scale: number; force: boolean; compact: boolean; opacity: number; d: number; sx: number; sy: number; w: number; h: number }

function byPriority(a: Cand, b: Cand): number { return b.prio - a.prio; }

function inkFor(bg: string): string {
  const c = new THREE.Color(bg);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return lum > 0.5 ? '#0d1219' : '#ffffff';
}

function span(cls: string): HTMLSpanElement { const e = document.createElement('span'); e.className = cls; return e; }

/** A numbering badge element (white square, line-colour border, letters over the number). */
function badgeSpan(b: LabelBadge, cls = 'snum sm'): HTMLSpanElement {
  const e = span(cls);
  e.style.setProperty('--c', b.color);
  if (b.line != null) e.dataset.line = String(b.line);
  if (b.station != null) e.dataset.station = String(b.station);
  const i = document.createElement('i'); i.textContent = b.prefix;
  const n = document.createElement('b'); n.textContent = b.num;
  e.append(i, n);
  return e;
}

export class Labels {
  container: HTMLDivElement;
  private towns = new Map<number, Label>();
  private stations = new Map<number, Label>();
  private markers = new Map<number, Label>();
  onClickTown: (id: number) => void = () => {};
  onClickStation: (id: number) => void = () => {};
  visible = true;
  /** stop marks of open lines: rail numbers or a colour chip (shown in front of the name) */
  marks = new Map<number, { color: string; text: string }>();
  /** maximum number of labels on screen */
  maxVisible = 60;
  /** text replacing the population pill of towns (e.g. share transported in the demand view) */
  townInfo = new Map<number, string>();
  /** line name tags (lines map: the hovered line's): line id -> anchor, text, colour, highlighted, line symbol */
  routeTags = new Map<number, RouteTag>();
  onClickTag: (lineId: number) => void = () => {};
  onHoverTag: (lineId: number | null) => void = () => {};
  /** the pointer is over a station's number (its line) or its marker (lines map); null when it leaves */
  onHoverLine: (lineId: number | null, stationId: number | null) => void = () => {};
  /** a tap (touch) on a station's number in the lines map: show that line; false = already shown (the tap opens the station) */
  onTapLine: (lineId: number, stationId: number) => boolean = () => false;
  /** station numbering badges by station (set by the UI; JR style 'AS01'), or null */
  badges: Map<number, LabelBadge[]> | null = null;
  /** badges shown on a normal plate (the station display of the lines map shows more) */
  badgeMax = 2;
  /** transfer complexes: station id -> the complex's main station (one plate per complex), or null */
  complexOf: Map<number, number> | null = null;
  /** lines map station display: only these stations, drawn as pins with all their numbers; null = normal plates */
  pinStations: Set<number> | null = null;
  /** lines map line display: only these stations, drawn as their numbers on the station itself; null = off */
  stationMarks: Map<number, StationMark> | null = null;
  /** station whose numbers all show while zoomed out (tapped on touch, as pointing at it shows them) */
  openStation: number | null = null;
  /** receives wheel events over the lines map's labels (the 3D view: zooming works over a station's numbers) */
  wheelTarget: HTMLElement | null = null;
  private tags = new Map<number, Label>();
  private hoveredTag: number | null = null;
  private hoverLn: number | null = null;
  private hoverStn: number | null = null;
  /** pointer type of the last press on a label (a touch tap on a number shows its line first) */
  private downType = '';
  private hl: number | null = null;
  private v = new THREE.Vector3();
  private cands: Cand[] = [];
  private placed: number[] = [];
  private wasVisible = true;
  private keep = new Set<Label>();
  // complexes: main -> parts, and the merged badges of a complex (rebuilt when the inputs change)
  private complexRef: Map<number, number> | null = null;
  private badgeRef: Map<number, LabelBadge[]> | null = null;
  private parts = new Map<number, number[]>();
  private merged = new Map<number, LabelBadge[]>();
  private shownMarks: Map<number, StationMark> | null = null;
  private hoverAnchor: number | null = null;
  private markRef: Map<number, StationMark> | null = null;
  private markComplexRef: Map<number, number> | null = null;
  private groupedMarks = new Map<number, StationMark>();

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'labels';
    parent.appendChild(this.container);
    this.container.addEventListener('wheel', (e) => {
      const t = this.wheelTarget;
      if (!t || !(e.target as HTMLElement | null)?.closest?.('.lbl.mk, .lbl.pin, .lbl.tag')) return;
      e.preventDefault();
      t.dispatchEvent(new WheelEvent(e.type, e));
    }, { passive: false });
  }

  /** Emphasise one station label (e.g. the selected station), or none. */
  highlight(stationId: number | null) { this.hl = stationId; }

  clear() {
    this.setHoverTag(null);
    this.setHoverLine(null, null);
    this.container.innerHTML = '';
    this.towns.clear();
    this.stations.clear();
    this.markers.clear();
    this.tags.clear();
    this.marks.clear();
    this.hl = null;
    this.complexRef = null;
    this.badgeRef = null;
    this.parts.clear(); this.merged.clear();
    this.shownMarks = null;
    this.markRef = null; this.markComplexRef = null; this.groupedMarks.clear();
    this.routeTags.clear(); this.townInfo.clear();
    this.badges = null; this.complexOf = null; this.pinStations = null; this.stationMarks = null; this.openStation = null;
    this.cands.length = 0; this.pool.length = 0; this.keep.clear();
  }

  private make(kind: Label['kind'], id: number, onClick: () => void): Label {
    const el = document.createElement('div');
    el.className = 'lbl ' + kind;
    const name = span('lbl-name');
    const sub = span(kind === 'town' ? 'lbl-pop' : 'lbl-wait');
    let ico: HTMLSpanElement | null = null, mark: HTMLSpanElement | null = null, badges: HTMLSpanElement | null = null, sym: HTMLSpanElement | null = null;
    let extra: HTMLSpanElement | null = null, more: HTMLSpanElement | null = null, dot: HTMLSpanElement | null = null;
    if (kind === 'stn') {
      ico = span('lbl-ico');
      mark = span('lbl-mark'); mark.style.display = 'none';
      badges = span('lbl-badges');
      el.append(ico, badges, mark, name, sub);
    } else if (kind === 'mk') {
      dot = span('mk-dot'); badges = span('mk-b'); extra = span('mk-x'); more = span('mk-more');
      el.append(dot, badges, extra, more, name);
    } else if (kind === 'tag') {
      sym = span('lcolor sm');
      el.append(sym, name);
    } else el.append(name, sub);
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.downType = e.pointerType; });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.downType === 'touch' && (kind === 'mk' || kind === 'stn') && this.tapLine(kind, id, e.target)) return;
      if (kind === 'mk' || kind === 'stn') this.onClickStation(this.stationAt(id, e.target)); else onClick();
    });
    if (kind === 'mk' || kind === 'stn') {
      // a number picks its line; elsewhere on a marker its station's first line (mouse and pen: touch taps instead)
      el.addEventListener('pointerover', (e) => {
        if (e.pointerType === 'touch' || (kind === 'stn' && !this.pinStations)) return;
        const line = this.lineAt(kind, id, e.target);
        this.hoverAnchor = id;
        this.setHoverLine(line, line == null ? null : this.stationAt(id, e.target));
      });
      el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && this.hoverAnchor === id) this.setHoverLine(null, null); });
    }
    el.style.display = 'none';
    this.container.appendChild(el);
    return { el, kind, id, name, sub, ico, mark, badges, sym, extra, more, dot, text: '', subText: '', markText: '', markColor: '', icoKind: '', cls: '', bg: '', symText: '', markSig: '', badgeData: [], badgeMax: -1, nBadges: 0, gap: 0, below: false, sx: -1e9, sy: -1e9, sc: -1, op: -1, z: -1, shown: false,
      refreshed: -1e9, served: false, waiting: 0, size: 0, activity: 0, minor: false, occAt: -1e9, occVersion: -1, occMargin: -1,
      occluded: false, occX: 0, occY: 0, occZ: 0, occCX: 0, occCY: 0, occCZ: 0 };
  }

  /** The line a pointer on a station label picks: a number's line, else (station numbers) the station's first line. */
  private lineAt(kind: Label['kind'], id: number, target: EventTarget | null): number | null {
    const b = (target as HTMLElement | null)?.closest?.('[data-line]') as HTMLElement | null;
    if (b?.dataset.line) return Number(b.dataset.line);
    return kind === 'mk' ? this.shownMarks?.get(id)?.lines[0] ?? null : null;
  }

  private stationAt(id: number, target: EventTarget | null): number {
    const badge = (target as HTMLElement | null)?.closest?.('[data-station]') as HTMLElement | null;
    return badge?.dataset.station ? Number(badge.dataset.station) : id;
  }

  /** Touch tap on a station's numbers (lines map): the first tap shows the line, as hovering does. */
  private tapLine(kind: Label['kind'], id: number, target: EventTarget | null): boolean {
    if (kind === 'stn' && !this.pinStations) return false;
    const line = this.lineAt(kind, id, target);
    return line != null && this.onTapLine(line, this.stationAt(id, target));
  }

  private setHoverLine(line: number | null, station: number | null) {
    if (line === null) this.hoverAnchor = null;
    if (line === this.hoverLn && station === this.hoverStn) return;
    this.hoverLn = line; this.hoverStn = station;
    this.onHoverLine(line, station);
  }

  /** Complex parts and merged badges, when the complexes or the badges changed. */
  private refreshComplexes() {
    if (this.complexRef === this.complexOf && this.badgeRef === this.badges) return;
    this.complexRef = this.complexOf;
    this.badgeRef = this.badges;
    this.parts.clear();
    this.merged.clear();
    if (!this.complexOf) return;
    for (const [id, main] of this.complexOf) { const a = this.parts.get(main); if (a) a.push(id); else this.parts.set(main, [id]); }
    for (const [main, ids] of this.parts) {
      const out: LabelBadge[] = [];
      for (const id of [main, ...ids.filter((x) => x !== main)]) for (const b of this.badges?.get(id) ?? []) if (!out.some((o) => o.code === b.code)) out.push({ ...b, station: b.station ?? id });
      this.merged.set(main, out);
    }
  }

  /** One lines-map marker for a public station; badges retain their physical member/line targets. */
  private complexMarks(marks: Map<number, StationMark> | null): Map<number, StationMark> | null {
    if (!marks) return null;
    if (marks === this.markRef && this.complexOf === this.markComplexRef) return this.groupedMarks;
    this.markRef = marks; this.markComplexRef = this.complexOf;
    const out = new Map<number, StationMark>();
    const colors = new Map<number, string>();
    for (const [id, mark] of marks) {
      const main = this.complexOf?.get(id) ?? id;
      let group = out.get(main);
      if (!group) { group = { ...mark, badges: [], lines: [], order: {} }; out.set(main, group); }
      Object.assign(group.order!, mark.order);
      if (mark.lines.length) colors.set(mark.lines[0], mark.color);
      if (mark.on && !group.on) group.color = mark.color;
      group.on ||= mark.on; group.dim &&= mark.dim;
      for (const line of mark.lines) if (!group.lines.includes(line)) group.lines.push(line);
      for (const b of mark.badges) if (!group.badges.some(o => o.code === b.code)) group.badges.push({ ...b, station: b.station ?? id });
      group.rank = Math.max(group.rank, mark.rank, group.lines.length);
    }
    for (const mark of out.values()) {
      const order = (id: number | undefined) => id === undefined ? 2 : mark.order?.[id] ?? 2;
      mark.lines.sort((a, b) => order(a) - order(b));
      mark.badges.sort((a, b) => order(a.line) - order(b.line));
      mark.color = colors.get(mark.lines[0]) ?? mark.color;
      mark.sig = mark.badges.map(b => `${b.code}:${b.color}:${b.line}:${b.station}`).join(',') + ':' + mark.color;
    }
    return this.groupedMarks = out;
  }

  update(game: Game, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number) {
    if (this.visible !== this.wasVisible) { this.wasVisible = this.visible; this.container.style.display = this.visible ? '' : 'none'; }
    if (!this.visible) { this.setHoverTag(null); this.setHoverLine(null, null); return; }
    const world = game.world;
    const cands = this.cands;
    cands.length = 0;
    const cp = camera.position;
    const now = performance.now();
    this.refreshComplexes();
    const pins = this.pinStations;
    const smarks = this.shownMarks = this.complexMarks(this.stationMarks);
    // ---- towns (with station numbers on the map, their names stand a little higher: a central station sits below)
    const townMax = Math.max(180, camDist * 3.2);
    const townGap = smarks ? TOWN_LIFT * uiScale() : 0;
    for (const t of game.towns.list) {
      if (!this.near(camera, t.x, t.z, townMax)) continue;
      const y = Math.max(world.heightAt(t.x, t.z), WATER_Y) + 3 + Math.min(5, t.pop / 2500);
      if (!this.inView(camera, t.x, y, t.z, townMax)) continue;
      let l = this.towns.get(t.id);
      if (!l) { const id = t.id; l = this.make('town', id, () => this.onClickTown(id)); this.towns.set(t.id, l); }
      if (l.gap !== townGap) { l.gap = townGap; l.sx = -1e9; }
      if (now - l.refreshed >= 150) {
        l.refreshed = now;
        const info = this.townInfo.get(t.id);
        this.setText(l, t.name.toUpperCase(), info ?? t.pop.toLocaleString('en-US'), !info && t.served > 0);
      }
      this.setCls(l, t.pop >= 3000 ? 'lbl town big' : 'lbl town');
      cands.push(this.cand(l, t.x, y, t.z, 1e5 + t.pop, townMax, 1, false, 34));
    }
    // ---- station numbers on the stations (lines map, line display): every zoom level, interchanges and busy
    // stations first where they overlap; only the first number beyond the rail-symbol band, names when close
    if (smarks) {
      const far = camDist >= MARK_FAR_DIST, named = camDist < STATION_NAME_MAX_DIST, ms = markScale(camDist);
      for (const [id, m] of smarks) {
        const s = game.stations.get(id);
        if (!s) continue;
        const y = markY(game, s);
        if (!this.inView(camera, s.x, y, s.z, 1e5)) continue;
        let l = this.markers.get(id);
        if (!l) { l = this.make('mk', id, () => this.onClickStation(id)); this.markers.set(id, l); }
        this.setMarkContent(l, m, s.name);
        const members = this.parts.get(id) ?? [id], isHl = members.includes(this.hl!);
        this.setCls(l, 'lbl mk' + (m.badges.length ? '' : ' dot') + (far ? ' far' : '') + (named ? ' named' : '') + (m.on ? ' on' : '') + (m.dim && !isHl ? ' dim' : '') + (isHl ? ' hl' : '') + (members.includes(this.openStation!) ? ' open' : ''));
        // numbered stations above town names, unnumbered stop dots below them (unless their line is highlighted)
        const prio = isHl ? 1e9 : (m.badges.length ? 3e5 : 4e4) + (m.on ? 2e5 : 0) + m.rank * 5000 + Math.min(8000, s.waitingTotal * 4 + (s.pickupLast + s.arrivedLast) * 0.2);
        cands.push(this.cand(l, s.x, y, s.z, prio, 1e5, ms, isHl, m.badges.length ? MARK_BH : MARK_DOT));
      }
    }
    // ---- stations (one plate per transfer complex: its main station's, with everyone waiting there)
    const stMax = Math.max(60, camDist * 2.6);
    const symbolOpacity = railSymbolOpacity(camDist);
    const pinMax = Math.max(400, camDist * 4);
    if (!smarks) for (const s of game.stations.map.values()) {
      const main = this.complexOf?.get(s.id);
      const part = main !== undefined && main !== s.id;
      if (part) continue;
      const ids = this.parts.get(s.id) ?? [s.id];
      const mk = ids.map(id => this.marks.get(id)).find(Boolean), isHl = ids.includes(this.hl!);
      if (pins && !ids.some(id => pins.has(id))) continue;
      const force = (!!mk && !pins) || isHl;
      const minor = !force && !pins && s.owner !== PLAYER && !ids.some((id) => game.stations.get(id)?.rail);
      // Keep explicit map pins and the existing forced road plates. Rail symbols still obey the zoom band.
      const mode = pins || (force && !s.rail) ? 'plate'
        : minor ? (camDist < RIVAL_STOP_NAME_DIST ? 'plate' : camDist < STATION_NAME_MAX_DIST ? 'symbol' : 'hidden')
        : stationLabelMode(camDist, !!s.rail);
      if (mode === 'hidden') continue;
      const compact = mode === 'symbol';
      const maxDist = compact ? stMax : force ? 3000 : pins ? pinMax : stMax;
      if (!this.near(camera, s.x, s.z, maxDist)) continue;
      const surface = Math.max(world.heightAt(s.x, s.z), WATER_Y);
      let y = Math.max(s.rail ? s.rail.y + 1 : surface + 0.8, surface + 0.8);
      if (pins) y = pinY(game, s);
      if (!this.inView(camera, s.x, y, s.z, maxDist)) continue;
      let l = this.stations.get(s.id);
      if (!l) { const id = s.id; l = this.make('stn', id, () => this.onClickStation(id)); this.stations.set(s.id, l); }
      l.minor = minor;
      const fresh = force || now - l.refreshed >= 150 || l.cls.includes(' compact') !== compact || l.cls.includes(' pin') !== !!pins;
      if (fresh) {
        l.refreshed = now;
        l.served = game.lines.stationServed(s.id); l.waiting = s.waitingTotal;
        l.size = s.rail ? s.rail.tracks * s.rail.length : 0; l.activity = s.pickupLast + s.arrivedLast;
        if (ids) for (const id of ids) { if (id === s.id) continue; const o = game.stations.get(id); if (!o) continue;
          l.waiting += o.waitingTotal; l.size += o.rail ? o.rail.tracks * o.rail.length : 0; l.activity += o.pickupLast + o.arrivedLast;
          if (game.lines.stationServed(id)) l.served = true;
        }
      }
      const { served, waiting, size, activity } = l;
      // (a rival stop's symbol shows its name on hover)
      if ((!compact || minor) && fresh) {
        this.setText(l, s.name, served ? String(waiting) : '–', false);
        this.setMark(l, pins ? undefined : mk);
        const bl = (ids ? this.merged.get(s.id) : undefined) ?? this.badges?.get(s.id) ?? null;
        this.setBadges(l, bl, pins ? 5 : this.badgeMax);
      }
      // (one rail mode: every rail station has the train symbol, whatever its track type)
      let icon = s.rail ? 'train' : 'bus';
      if (!s.rail) for (const stop of s.stops) if (world.net.edges.get(stop.edge)?.tram) { icon = 'tram'; break; }
      this.setIcon(l, icon);
      const noRoad = !!s.rail && (s as unknown as { roadAccess?: boolean }).roadAccess === false;
      this.setCls(l, 'lbl stn' + (pins ? ' pin' : '') + (compact ? ' compact' : '') + (minor ? ' minor' : '') + (!compact && l.nBadges ? ' badged' : '') + (!compact && !served && !mk && !isHl ? ' dim' : '') + (isHl ? ' hl' : '') + (noRoad && !pins && !compact ? ' noroad' : ''));
      const bg = game.company(s.owner).color;
      if (l.bg !== bg) { l.bg = bg; l.el.style.setProperty('--c', bg); l.el.style.setProperty('--ink', inkFor(bg)); }
      const prio = isHl ? 1e9 : mk ? 1e8 : pins ? 5e4 + l.nBadges * 1e3 : minor ? (compact ? 3e3 : 6e3) + Math.min(2000, waiting * 2) : compact ? 2e4 + (served ? 1000 : 0) + Math.min(8000, size * 20) + Math.min(8000, waiting * 4 + activity * 0.2) : (served ? 2e4 : 1e4);
      // Selection raises symbol priority, but may not bypass their collisions or distance fade.
      cands.push(this.cand(l, s.x, y, s.z, prio, maxDist, isHl ? 1.1 : 1, force && !compact, compact ? (minor ? MINOR_STOP_SIZE : RAIL_SYMBOL_SIZE) : pins ? 44 : l.nBadges ? BADGED_PLATE_H : 24, compact, compact && !minor ? symbolOpacity : 1));
    }
    // ---- line name tags (lines map: the line under the pointer), above everything and outside the declutter
    for (const [id, t] of this.routeTags) {
      if (!this.inView(camera, t.x, t.y, t.z, 1e5)) continue;
      let l = this.tags.get(id);
      if (!l) {
        l = this.make('tag', id, () => this.onClickTag(id));
        l.el.addEventListener('pointerenter', () => this.setHoverTag(id));
        l.el.addEventListener('pointerleave', () => { if (this.hoveredTag === id) this.setHoverTag(null); });
        this.tags.set(id, l);
      }
      if (l.text !== t.text) { l.text = t.text; l.name.textContent = t.text; l.el.title = t.text; }
      const code = game.lines.get(id)?.kind === 'rail' ? t.code ?? '' : '';
      if (l.sym && l.symText !== code) { l.symText = code; l.sym.textContent = code; l.sym.className = code ? 'lsym sm' : 'lcolor sm'; }
      const gap = t.gap ?? 0, below = !!t.below;
      if (l.gap !== gap || l.below !== below) { l.gap = gap; l.below = below; l.sx = -1e9; }
      this.setCls(l, 'lbl tag' + (t.hl ? ' hl' : '') + (below ? ' below' : ''));
      if (l.bg !== t.color) { l.bg = t.color; l.el.style.setProperty('--c', t.color); l.el.style.setProperty('--ink', inkFor(t.color)); }
      cands.push(this.cand(l, t.x, t.y, t.z, t.hl ? 5e8 : 9e4, 1e5, 1, t.hl, 20));
    }
    // (tags of other lines stay hidden for the next hover; those of deleted lines go)
    if (this.tags.size > this.routeTags.size) for (const [id, l] of this.tags) if (!game.lines.map.has(id)) {
      if (this.hoveredTag === id) this.setHoverTag(null);
      l.el.remove(); this.tags.delete(id);
    }
    // ---- project & cull
    const v = this.v;
    let n = 0;
    for (const c of cands) {
      c.d = v.set(c.x, c.y, c.z).distanceTo(cp);
      if (c.d > c.maxDist) continue;
      v.project(camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.15) continue;
      c.sx = (v.x * 0.5 + 0.5) * w;
      c.sy = (-v.y * 0.5 + 0.5) * h;
      if (!c.force) c.prio -= c.d * (c.l.kind === 'stn' && !c.compact ? 40 : 2);
      if (!c.force && c.l.shown) c.prio += LABEL_KEEP;
      cands[n++] = c;
    }
    cands.length = n;
    cands.sort(byPriority);
    // ---- select: cap, declutter (screen rectangles), terrain occlusion
    const placed = this.placed;
    placed.length = 0;
    const keep = this.keep;
    keep.clear();
    const cap = pins ? Math.max(this.maxVisible, 90) : smarks ? Math.max(this.maxVisible, MARK_CAP) : this.maxVisible;
    // the interface size (Settings) zooms the labels' contents: their boxes grow with it
    const ui = uiScale();
    for (const c of cands) {
      if (keep.size >= cap && !c.force) break;
      const L = c.l;
      let x0: number, x1: number, y0: number, y1: number;
      // never shrink below ~11 px text (smallest plate text is 12 px); station numbers scale by zoom alone
      const s = L.kind === 'mk' ? c.scale : (c.compact ? 1 : Math.max(0.92, Math.min(1.1, 0.8 + (40 / Math.max(1, c.d)) * 0.2))) * c.scale;
      c.h *= s * ui;
      if (L.kind === 'mk') {
        // centred on the station; the name (close up) hangs to the right of the numbers
        const far = L.cls.includes(' far'), nb = L.nBadges;
        c.w = (nb ? (far ? 1 : Math.min(nb, MARK_ROW)) * BADGE_W - 2 + (!far && nb > MARK_ROW ? MARK_MORE_W : 0) : MARK_DOT) * s * ui;
        const name = L.cls.includes(' named') ? (L.text.length * 6.4 + 18) * s * ui : 0;
        x0 = c.sx - c.w / 2; x1 = c.sx + c.w / 2 + name; y0 = c.sy - c.h / 2; y1 = c.sy + c.h / 2;
      } else {
        c.w = (c.compact ? (L.minor ? MINOR_STOP_SIZE : RAIL_SYMBOL_SIZE) : L.kind === 'tag' ? Math.min(170, L.text.length * 6.6 + 16) + (L.symText ? 28 : 16) : L.text.length * (L.kind === 'town' ? 9 : 7.2) + (L.kind === 'stn' ? (L.cls.includes(' pin') ? 22 : 56) + L.nBadges * BADGE_W : 12)) * s * ui;
        const lift = L.kind === 'town' ? L.gap : 0;
        x0 = c.sx - c.w / 2; x1 = c.sx + c.w / 2; y0 = c.sy - c.h - lift; y1 = c.sy - lift;
      }
      // The player's station signs and numbers never give way to town names; stations still declutter against each
      // other. Stop dots without numbers and other companies' bus / tram stops give way to town names.
      const layer = L.kind === 'stn' && L.minor ? 0 : L.kind === 'stn' || (L.kind === 'mk' && L.nBadges) ? 1 : L.kind === 'town' ? 2 : 0;
      let hit = false;
      if (!c.force) for (let i = 0; i < placed.length; i += 5) if (layer + placed[i + 4] !== 3 && x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) { hit = true; break; }
      if (hit) continue;
      if (!c.force && L.kind !== 'tag' && L.kind !== 'mk' && !pins && this.cachedOcclusion(L, now, game, camera, c.x, c.y, c.z, L.shown ? OCCLUDE_KEEP : 0.05)) continue;
      // (tags float above the rest: the labels under them keep their places while the pointer moves)
      if (L.kind === 'mk') placed.push(x0 - 2, y0 - 1, x1 + 2, y1 + 1, layer);
      else if (L.kind !== 'tag') placed.push(x0 - 4, y0 - 2, x1 + 4, y1 + 2, layer);
      keep.add(L);
      this.place(c, s);
    }
    for (const l of this.towns.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.stations.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.markers.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.tags.values()) if (l.shown && !keep.has(l)) this.hide(l);
    // drop labels of removed towns / stations
    for (const [id, l] of this.stations) if (!game.stations.map.has(id)) { l.el.remove(); this.stations.delete(id); }
    for (const [id, l] of this.markers) if (!game.stations.map.has(id)) { if (this.hoverStn === id) this.setHoverLine(null, null); l.el.remove(); this.markers.delete(id); }
    if (this.towns.size > game.towns.list.length) for (const [id, l] of this.towns) if (!game.towns.list[id]) { l.el.remove(); this.towns.delete(id); }
  }

  /** Cull before constructing or updating DOM/text. Placement and station-over-town priority still run each frame. */
  private near(camera: THREE.Camera, x: number, z: number, maxDist: number) {
    return (x - camera.position.x) ** 2 + (z - camera.position.z) ** 2 <= maxDist * maxDist;
  }
  private inView(camera: THREE.Camera, x: number, y: number, z: number, maxDist: number) {
    const p = this.v.set(x, y, z);
    if (p.distanceToSquared(camera.position) > maxDist * maxDist) return false;
    p.project(camera);
    return p.z <= 1 && p.x >= -1.1 && p.x <= 1.1 && p.y >= -1.1 && p.y <= 1.15;
  }

  private cachedOcclusion(l: Label, now: number, game: Game, camera: THREE.Camera, x: number, y: number, z: number, margin: number) {
    const c = camera.position;
    const moved = (c.x - l.occCX) ** 2 + (c.y - l.occCY) ** 2 + (c.z - l.occCZ) ** 2 > 4;
    if (now - l.occAt >= 150 || moved || l.occVersion !== game.world.heightsVersion || l.occMargin !== margin
      || x !== l.occX || y !== l.occY || z !== l.occZ) {
      l.occAt = now; l.occVersion = game.world.heightsVersion; l.occMargin = margin;
      l.occCX = c.x; l.occCY = c.y; l.occCZ = c.z; l.occX = x; l.occY = y; l.occZ = z;
      l.occluded = this.occluded(game, camera, x, y, z, margin);
    }
    return l.occluded;
  }

  /** A candidate record (pooled: the array keeps its objects between frames). */
  private pool: Cand[] = [];
  private poolN = 0;
  private cand(l: Label, x: number, y: number, z: number, prio: number, maxDist: number, scale: number, force: boolean, hh: number, compact = false, opacity = 1): Cand {
    if (this.cands.length === 0) this.poolN = 0;
    let c = this.pool[this.poolN];
    if (!c) { c = { l, x, y, z, prio, maxDist, scale, force, compact, opacity, d: 0, sx: 0, sy: 0, w: 0, h: hh }; this.pool[this.poolN] = c; }
    else { c.l = l; c.x = x; c.y = y; c.z = z; c.prio = prio; c.maxDist = maxDist; c.scale = scale; c.force = force; c.compact = compact; c.opacity = opacity; c.d = 0; c.sx = 0; c.sy = 0; c.w = 0; c.h = hh; }
    this.poolN++;
    return c;
  }

  private setText(l: Label, text: string, sub: string, up: boolean) {
    if (l.text !== text) { l.text = text; l.name.textContent = text; }
    const st = up ? sub + '▲' : sub;
    if (l.subText === st) return;
    l.subText = st;
    if (up) { l.sub.textContent = sub + ' '; const u = document.createElement('span'); u.className = 'up'; u.textContent = '▲'; l.sub.appendChild(u); }
    else l.sub.textContent = sub;
  }

  private setIcon(l: Label, kind: string) {
    if (!l.ico || l.icoKind === kind) return;
    l.icoKind = kind;
    l.ico.innerHTML = svg(kind, 14);
  }

  private setMark(l: Label, mk: { color: string; text: string } | undefined) {
    if (!l.mark) return;
    // The UI also supplies stop-order indices for unnumbered lines; draw those as colour chips.
    const t = mk ? mk.text.split(',').filter((code) => !/^\d+$/.test(code)).join(',') : '';
    if (t !== l.markText) { l.markText = t; l.mark.textContent = t; }
    const cls = 'lbl-mark' + (mk && !t ? ' lcolor sm' : '');
    if (l.mark.className !== cls) l.mark.className = cls;
    const display = mk ? '' : 'none';
    if (l.mark.style.display !== display) l.mark.style.display = display;
    const c = mk ? mk.color : '';
    if (c !== l.markColor) { l.markColor = c; l.mark.style.background = c; }
  }

  private setCls(l: Label, cls: string) { if (l.cls !== cls) { l.cls = cls; l.el.className = cls; } }

  /** Numbering badges on a plate (at most `max`, then +n); compare content rather than refreshed objects. */
  private setBadges(l: Label, list: LabelBadge[] | null, max: number) {
    if (!l.badges) return;
    const count = list?.length ?? 0;
    const data = l.badgeData;
    let changed = data.length !== count * 6 || l.badgeMax !== max;
    if (list) for (let j = 0; j < count && !changed; j++) {
      const b = list[j], k = j * 6;
      changed = data[k] !== b.code || data[k + 1] !== b.prefix || data[k + 2] !== b.num || data[k + 3] !== b.color || data[k + 4] !== String(b.line) || data[k + 5] !== String(b.station);
    }
    if (!changed) return;
    data.length = count * 6;
    if (list) for (let j = 0; j < count; j++) {
      const b = list[j], k = j * 6;
      data[k] = b.code; data[k + 1] = b.prefix; data[k + 2] = b.num; data[k + 3] = b.color; data[k + 4] = String(b.line);
      data[k + 5] = String(b.station);
    }
    l.badgeMax = max;
    const shown = Math.min(count, max);
    l.nBadges = shown + (count > max ? 1 : 0);
    l.badges.replaceChildren();
    for (let j = 0; j < shown; j++) l.badges.appendChild(badgeSpan(list![j]));
    if (list && list.length > max) { const m = span('snum-more'); m.textContent = `+${list.length - max}`; l.badges.appendChild(m); }
  }

  /**
   * A station's numbers on the station (lines map): the first badge, the others beside it (close up: up to MARK_ROW
   * in all, then "+n"; zoomed out they show on hover and a "+n" pill sits on the corner), or a stop dot; the name.
   */
  private setMarkContent(l: Label, m: StationMark, name: string) {
    if (l.text !== name) { l.text = name; l.name.textContent = name; l.markSig = ''; }
    if (l.markSig === m.sig) return;
    l.markSig = m.sig;
    const n = m.badges.length;
    l.nBadges = n;
    l.badges!.replaceChildren(...m.badges.slice(0, 1).map((b) => badgeSpan(b)));
    l.extra!.replaceChildren(...m.badges.slice(1).map((b) => badgeSpan(b)));
    l.more!.dataset.row = n > MARK_ROW ? `+${n - MARK_ROW}` : '';
    l.more!.dataset.far = n > 1 ? `+${n - 1}` : '';
    l.dot!.style.setProperty('--c', m.color);
    l.el.setAttribute('aria-label', n ? `${name}: ${m.badges.map((b) => b.code).join(', ')}` : name);
  }

  private setHoverTag(id: number | null) {
    if (this.hoveredTag === id) return;
    this.hoveredTag = id;
    this.onHoverTag(id);
  }

  private hide(l: Label) {
    if (this.hoveredTag != null && this.tags.get(this.hoveredTag) === l) this.setHoverTag(null);
    if ((l.kind === 'mk' || l.kind === 'stn') && this.hoverAnchor === l.id) this.setHoverLine(null, null);
    l.shown = false; l.el.style.display = 'none';
  }

  private place(c: Cand, s: number) {
    const l = c.l;
    if (!l.shown) { l.shown = true; l.el.style.display = ''; l.sx = -1e9; }
    if (Math.abs(c.sx - l.sx) > 0.5 || Math.abs(c.sy - l.sy) > 0.5 || Math.abs(s - l.sc) > 0.01) {
      l.sx = c.sx; l.sy = c.sy; l.sc = s;
      // station numbers: centred on the station; tags (and town names over station numbers): a gap above (or below)
      // the anchor; plates stand on it
      const at = l.kind === 'mk' ? '-50%, -50%' : l.below ? `-50%, ${l.gap.toFixed(1)}px` : l.gap ? `-50%, calc(-100% - ${l.gap.toFixed(1)}px)` : '-50%, -100%';
      l.el.style.transform = `translate3d(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px, 0) translate(${at}) scale(${s.toFixed(3)})`;
    }
    const steps = c.compact ? 100 : 20;
    const op = c.force ? 1 : Math.round(Math.min(c.opacity, Math.max(0, Math.min(1, (c.maxDist - c.d) / (c.maxDist * 0.25)))) * steps) / steps;
    if (op !== l.op) { l.op = op; l.el.style.opacity = String(op); }
    // (station signs and numbers above town names, the hovered line's tag above everything)
    const z = l.kind === 'tag' ? 250000 : (l.kind === 'mk' || l.kind === 'stn' ? 200000 : 100000) - Math.round(c.d * 10);
    if (Math.abs(z - l.z) > 5) { l.z = z; l.el.style.zIndex = String(z); }
  }

  /** Is the straight line from the camera to the point blocked by terrain (by more than `margin`)? */
  private occluded(game: Game, camera: THREE.Camera, x: number, y: number, z: number, margin: number): boolean {
    const wd = game.world;
    const c = camera.position;
    for (let i = 1; i < 12; i++) {
      const f = i / 12;
      const px = c.x + (x - c.x) * f, pz = c.z + (z - c.z) * f;
      if (!wd.inside(px, pz)) continue;
      if (c.y + (y - c.y) * f < wd.heightAt(px, pz) - margin) return true;
    }
    return false;
  }
}
