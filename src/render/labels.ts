// In-world signage: town name plates and station plates (company colour, pictogram, JR-style numbering badges,
// waiting count, stop marks of open lines), one plate per transfer complex, station pins with their numbers in the
// lines map's station display, and line name tags with their symbols. Priority-capped, decluttered,
// terrain-occluded; DOM writes only on change.
import * as THREE from 'three';
import type { Game } from '../game/game';
import { TRACK_TYPES, WATER_Y } from '../game/constants';
import { svg } from '../ui/icons';
import { uiScale } from '../ui/uiscale';

/** A station number badge as the UI computes it (ui/lineid.ts Badge). */
export interface LabelBadge { code: string; prefix: string; num: string; color: string }

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
/** a small numbering badge on a plate (25 px square + 2 px gap, style.css .snum.sm) and a plate showing badges */
const BADGE_W = 27, BADGED_PLATE_H = 29;

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

interface Label {
  el: HTMLDivElement;
  kind: 'town' | 'stn' | 'tag';
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  ico: HTMLSpanElement | null;
  mark: HTMLSpanElement | null;
  chips: HTMLSpanElement | null;
  badges: HTMLSpanElement | null;
  sym: HTMLSpanElement | null;
  text: string; subText: string; markText: string; markColor: string; icoKind: string; cls: string; bg: string; chipSig: string; symText: string;
  badgeData: string[]; badgeMax: number; nBadges: number;
  sx: number; sy: number; sc: number; op: number; z: number; shown: boolean;
}

interface Cand { l: Label; x: number; y: number; z: number; prio: number; maxDist: number; scale: number; force: boolean; compact: boolean; opacity: number; d: number; sx: number; sy: number; w: number; h: number }

function byPriority(a: Cand, b: Cand): number { return b.prio - a.prio; }

function inkFor(bg: string): string {
  const c = new THREE.Color(bg);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return lum > 0.5 ? '#0d1219' : '#ffffff';
}

export class Labels {
  container: HTMLDivElement;
  private towns = new Map<number, Label>();
  private stations = new Map<number, Label>();
  onClickTown: (id: number) => void = () => {};
  onClickStation: (id: number) => void = () => {};
  visible = true;
  /** stop marks of open lines: rail numbers or a colour chip (shown in front of the name) */
  marks = new Map<number, { color: string; text: string }>();
  /** maximum number of labels on screen */
  maxVisible = 60;
  /** colours of the lines serving each station (shown as chips on the plates, e.g. in the lines map) */
  lineChips = new Map<number, string[]>();
  /** text replacing the population pill of towns (e.g. share transported in the demand view) */
  townInfo = new Map<number, string>();
  /** line name tags on routes (lines map): line id -> anchor, text, colour, highlighted, line symbol */
  routeTags = new Map<number, { x: number; y: number; z: number; text: string; color: string; hl: boolean; code?: string }>();
  onClickTag: (lineId: number) => void = () => {};
  onHoverTag: (lineId: number | null) => void = () => {};
  /** station numbering badges by station (set by the UI; JR style 'AS01'), or null */
  badges: Map<number, LabelBadge[]> | null = null;
  /** badges shown on a normal plate (the station display of the lines map shows more) */
  badgeMax = 2;
  /** transfer complexes: station id -> the complex's main station (one plate per complex), or null */
  complexOf: Map<number, number> | null = null;
  /** lines map station display: only these stations, drawn as pins with all their numbers; null = normal plates */
  pinStations: Set<number> | null = null;
  private tags = new Map<number, Label>();
  private hoveredTag: number | null = null;
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

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'labels';
    parent.appendChild(this.container);
  }

  /** Emphasise one station label (e.g. the selected station), or none. */
  highlight(stationId: number | null) { this.hl = stationId; }

  clear() {
    this.setHoverTag(null);
    this.container.innerHTML = '';
    this.towns.clear();
    this.stations.clear();
    this.tags.clear();
    this.marks.clear();
    this.hl = null;
    this.complexRef = null;
    this.badgeRef = null;
    this.parts.clear(); this.merged.clear();
    this.lineChips.clear(); this.routeTags.clear(); this.townInfo.clear();
    this.badges = null; this.complexOf = null; this.pinStations = null;
    this.cands.length = 0; this.pool.length = 0; this.keep.clear();
  }

  private make(kind: 'town' | 'stn' | 'tag', onClick: () => void): Label {
    const el = document.createElement('div');
    el.className = 'lbl ' + kind;
    const name = document.createElement('span'); name.className = 'lbl-name';
    const sub = document.createElement('span'); sub.className = kind === 'town' ? 'lbl-pop' : 'lbl-wait';
    let ico: HTMLSpanElement | null = null, mark: HTMLSpanElement | null = null, chips: HTMLSpanElement | null = null, badges: HTMLSpanElement | null = null, sym: HTMLSpanElement | null = null;
    if (kind === 'stn') {
      ico = document.createElement('span'); ico.className = 'lbl-ico';
      mark = document.createElement('span'); mark.className = 'lbl-mark'; mark.style.display = 'none';
      chips = document.createElement('span'); chips.className = 'lbl-chips'; chips.style.display = 'none';
      badges = document.createElement('span'); badges.className = 'lbl-badges';
      el.append(ico, badges, mark, name, sub, chips);
    } else if (kind === 'tag') {
      sym = document.createElement('span'); sym.className = 'lcolor sm';
      el.append(sym, name);
    } else el.append(name, sub);
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    el.style.display = 'none';
    this.container.appendChild(el);
    return { el, kind, name, sub, ico, mark, chips, badges, sym, text: '', subText: '', markText: '', markColor: '', icoKind: '', cls: '', bg: '', chipSig: '', symText: '', badgeData: [], badgeMax: -1, nBadges: 0, sx: -1e9, sy: -1e9, sc: -1, op: -1, z: -1, shown: false };
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
      for (const id of [main, ...ids.filter((x) => x !== main)]) for (const b of this.badges?.get(id) ?? []) if (!out.some((o) => o.code === b.code)) out.push(b);
      this.merged.set(main, out);
    }
  }

  update(game: Game, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number) {
    if (this.visible !== this.wasVisible) { this.wasVisible = this.visible; this.container.style.display = this.visible ? '' : 'none'; }
    if (!this.visible) { this.setHoverTag(null); return; }
    const world = game.world;
    const cands = this.cands;
    cands.length = 0;
    const cp = camera.position;
    this.refreshComplexes();
    const pins = this.pinStations;
    // ---- towns
    const townMax = Math.max(180, camDist * 3.2);
    for (const t of game.towns.list) {
      let l = this.towns.get(t.id);
      if (!l) { const id = t.id; l = this.make('town', () => this.onClickTown(id)); this.towns.set(t.id, l); }
      const info = this.townInfo.get(t.id);
      this.setText(l, t.name.toUpperCase(), info ?? t.pop.toLocaleString('en-US'), !info && t.served > 0);
      this.setCls(l, t.pop >= 3000 ? 'lbl town big' : 'lbl town');
      const y = Math.max(world.heightAt(t.x, t.z), WATER_Y) + 3 + Math.min(5, t.pop / 2500);
      cands.push(this.cand(l, t.x, y, t.z, 1e5 + t.pop, townMax, 1, false, 34));
    }
    // ---- stations (one plate per transfer complex: its main station's, with everyone waiting there)
    const stMax = Math.max(60, camDist * 2.6);
    const symbolOpacity = railSymbolOpacity(camDist);
    const pinMax = Math.max(400, camDist * 4);
    for (const s of game.stations.map.values()) {
      const mk = this.marks.get(s.id);
      const isHl = this.hl === s.id;
      const main = this.complexOf?.get(s.id);
      const part = main !== undefined && main !== s.id;
      // pins: only the stations of the lines shown; other plates of a complex only when marked / selected
      if ((pins && !pins.has(s.id)) || (part && !mk && !isHl && !(pins && pins.has(s.id) && !pins.has(main!)))) continue;
      const force = (!!mk && !pins) || isHl;
      // Keep explicit map pins and the existing forced road plates. Rail symbols still obey the zoom band.
      const mode = pins || (force && !s.rail) ? 'plate' : stationLabelMode(camDist, !!s.rail);
      if (mode === 'hidden') continue;
      const compact = mode === 'symbol';
      let l = this.stations.get(s.id);
      if (!l) { const id = s.id; l = this.make('stn', () => this.onClickStation(id)); this.stations.set(s.id, l); }
      const ids = !part && main !== undefined ? this.parts.get(s.id) : undefined;
      let served = game.lines.stationServed(s.id), waiting = s.waitingTotal;
      let size = s.rail ? s.rail.tracks * s.rail.length : 0;
      let activity = s.pickupLast + s.arrivedLast;
      if (ids) for (const id of ids) { if (id === s.id) continue; const o = game.stations.get(id); if (!o) continue; waiting += o.waitingTotal; size += o.rail ? o.rail.tracks * o.rail.length : 0; activity += o.pickupLast + o.arrivedLast; if (game.lines.stationServed(id)) served = true; }
      if (!compact) {
        this.setText(l, s.name, served ? String(waiting) : '–', false);
        this.setMark(l, pins ? undefined : mk);
        this.setChips(l, pins ? undefined : this.lineChips.get(s.id));
        const bl = (ids ? this.merged.get(s.id) : undefined) ?? this.badges?.get(s.id) ?? null;
        this.setBadges(l, bl, pins ? 5 : this.badgeMax);
      }
      const railMode = s.rail ? TRACK_TYPES[s.rail.trackType]?.mode : undefined;
      let icon = s.rail ? railMode === 'metro' ? 'metro' : railMode === 'lightrail' ? 'lightrail' : 'train' : 'bus';
      if (!s.rail) for (const stop of s.stops) if (world.net.edges.get(stop.edge)?.tram) { icon = 'tram'; break; }
      this.setIcon(l, icon);
      const noRoad = !!s.rail && (s as unknown as { roadAccess?: boolean }).roadAccess === false;
      this.setCls(l, 'lbl stn' + (pins ? ' pin' : '') + (compact ? ' compact' : '') + (!compact && l.nBadges ? ' badged' : '') + (!compact && !served && !mk && !isHl ? ' dim' : '') + (isHl ? ' hl' : '') + (noRoad && !pins && !compact ? ' noroad' : ''));
      const bg = game.company(s.owner).color;
      if (l.bg !== bg) { l.bg = bg; l.el.style.setProperty('--c', bg); l.el.style.setProperty('--ink', inkFor(bg)); }
      let y = s.rail ? s.rail.y + 1.0 : Math.max(world.heightAt(s.x, s.z), WATER_Y) + 0.8;
      // Underground metro symbols belong above the surface, so terrain does not bury them.
      if (compact) y = Math.max(y, Math.max(world.heightAt(s.x, s.z), WATER_Y) + 0.8);
      if (pins) y -= 0.9;
      const prio = isHl ? 1e9 : mk ? 1e8 : pins ? 5e4 + l.nBadges * 1e3 : compact ? 2e4 + (served ? 1000 : 0) + Math.min(8000, size * 20) + Math.min(8000, waiting * 4 + activity * 0.2) : (served ? 2e4 : 1e4);
      // Selection raises symbol priority, but may not bypass their collisions or distance fade.
      cands.push(this.cand(l, s.x, y, s.z, prio, compact ? stMax : force ? 3000 : pins ? pinMax : stMax, isHl ? 1.1 : 1, force && !compact, compact ? RAIL_SYMBOL_SIZE : pins ? 44 : l.nBadges ? BADGED_PLATE_H : 24, compact, compact ? symbolOpacity : 1));
    }
    // ---- line name tags (lines map)
    for (const [id, t] of this.routeTags) {
      let l = this.tags.get(id);
      if (!l) {
        l = this.make('tag', () => this.onClickTag(id));
        l.el.addEventListener('pointerenter', () => this.setHoverTag(id));
        l.el.addEventListener('pointerleave', () => { if (this.hoveredTag === id) this.setHoverTag(null); });
        this.tags.set(id, l);
      }
      if (l.text !== t.text) { l.text = t.text; l.name.textContent = t.text; l.el.title = t.text; }
      const code = game.lines.get(id)?.kind === 'rail' ? t.code ?? '' : '';
      if (l.sym && l.symText !== code) { l.symText = code; l.sym.textContent = code; l.sym.className = code ? 'lsym sm' : 'lcolor sm'; }
      this.setCls(l, t.hl ? 'lbl tag hl' : 'lbl tag');
      if (l.bg !== t.color) { l.bg = t.color; l.el.style.setProperty('--c', t.color); l.el.style.setProperty('--ink', inkFor(t.color)); }
      cands.push(this.cand(l, t.x, t.y, t.z, t.hl ? 5e8 : 9e4, 5000, 1, t.hl, 20));
    }
    for (const [id, l] of this.tags) if (!this.routeTags.has(id)) {
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
    const cap = pins ? Math.max(this.maxVisible, 90) : this.maxVisible;
    // the interface size (Settings) zooms the labels' contents: their boxes grow with it
    const ui = uiScale();
    for (const c of cands) {
      if (keep.size >= cap && !c.force) break;
      // never shrink below ~11 px text (smallest plate text is 12 px)
      const s = (c.compact ? 1 : Math.max(0.92, Math.min(1.1, 0.8 + (40 / Math.max(1, c.d)) * 0.2))) * c.scale;
      const L = c.l;
      c.w = (c.compact ? RAIL_SYMBOL_SIZE : L.kind === 'tag' ? Math.min(170, L.text.length * 6.6 + 16) + (L.symText ? 28 : 16) : L.text.length * (L.kind === 'town' ? 9 : 7.2) + (L.kind === 'stn' ? (L.cls.includes(' pin') ? 22 : 56) + L.nBadges * BADGE_W : 12)) * s * ui;
      c.h *= s * ui;
      const x0 = c.sx - c.w / 2, x1 = c.sx + c.w / 2, y0 = c.sy - c.h, y1 = c.sy;
      let hit = false;
      if (!c.force) for (let i = 0; i < placed.length; i += 4) if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) { hit = true; break; }
      if (hit) continue;
      if (!c.force && L.kind !== 'tag' && !pins && this.occluded(game, camera, c.x, c.y, c.z, L.shown ? OCCLUDE_KEEP : 0.05)) continue;
      placed.push(x0 - 4, y0 - 2, x1 + 4, y1 + 2);
      keep.add(L);
      this.place(c, s, w, h);
    }
    for (const l of this.towns.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.stations.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.tags.values()) if (l.shown && !keep.has(l)) this.hide(l);
    // drop labels of removed towns / stations
    if (this.stations.size > game.stations.map.size) for (const [id, l] of this.stations) if (!game.stations.map.has(id)) { l.el.remove(); this.stations.delete(id); }
    if (this.towns.size > game.towns.list.length) for (const [id, l] of this.towns) if (!game.towns.list[id]) { l.el.remove(); this.towns.delete(id); }
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

  private setChips(l: Label, colors: string[] | undefined) {
    if (!l.chips) return;
    const sig = colors ? colors.join(',') : '';
    if (sig === l.chipSig) return;
    l.chipSig = sig;
    l.chips.style.display = sig ? '' : 'none';
    l.chips.replaceChildren(...(colors ?? []).slice(0, 6).map((c) => { const i = document.createElement('i'); i.style.background = c; return i; }));
    if (colors && colors.length > 6) { const m = document.createElement('b'); m.textContent = `+${colors.length - 6}`; l.chips.appendChild(m); }
  }

  /** Numbering badges on a plate (at most `max`, then +n); compare content rather than refreshed objects. */
  private setBadges(l: Label, list: LabelBadge[] | null, max: number) {
    if (!l.badges) return;
    const count = list?.length ?? 0;
    const data = l.badgeData;
    let changed = data.length !== count * 4 || l.badgeMax !== max;
    if (list) for (let j = 0; j < count && !changed; j++) {
      const b = list[j], k = j * 4;
      changed = data[k] !== b.code || data[k + 1] !== b.prefix || data[k + 2] !== b.num || data[k + 3] !== b.color;
    }
    if (!changed) return;
    data.length = count * 4;
    if (list) for (let j = 0; j < count; j++) {
      const b = list[j], k = j * 4;
      data[k] = b.code; data[k + 1] = b.prefix; data[k + 2] = b.num; data[k + 3] = b.color;
    }
    l.badgeMax = max;
    const shown = Math.min(count, max);
    l.nBadges = shown + (count > max ? 1 : 0);
    l.badges.replaceChildren();
    for (let j = 0; j < shown; j++) {
      const b = list![j];
      const e = document.createElement('span');
      e.className = 'snum sm';
      e.style.setProperty('--c', b.color);
      const i = document.createElement('i'); i.textContent = b.prefix;
      const n = document.createElement('b'); n.textContent = b.num;
      e.append(i, n);
      l.badges.appendChild(e);
    }
    if (list && list.length > max) { const m = document.createElement('span'); m.className = 'snum-more'; m.textContent = `+${list.length - max}`; l.badges.appendChild(m); }
  }

  private setHoverTag(id: number | null) {
    if (this.hoveredTag === id) return;
    this.hoveredTag = id;
    this.onHoverTag(id);
  }

  private hide(l: Label) {
    if (this.hoveredTag != null && this.tags.get(this.hoveredTag) === l) this.setHoverTag(null);
    l.shown = false; l.el.style.display = 'none';
  }

  private place(c: Cand, s: number, w: number, h: number) {
    const l = c.l;
    if (!l.shown) { l.shown = true; l.el.style.display = ''; l.sx = -1e9; }
    if (Math.abs(c.sx - l.sx) > 0.5 || Math.abs(c.sy - l.sy) > 0.5 || Math.abs(s - l.sc) > 0.01) {
      l.sx = c.sx; l.sy = c.sy; l.sc = s;
      l.el.style.transform = `translate3d(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
    }
    const steps = c.compact ? 100 : 20;
    const op = c.force ? 1 : Math.round(Math.min(c.opacity, Math.max(0, Math.min(1, (c.maxDist - c.d) / (c.maxDist * 0.25)))) * steps) / steps;
    if (op !== l.op) { l.op = op; l.el.style.opacity = String(op); }
    const z = 100000 - Math.round(c.d * 10);
    if (Math.abs(z - l.z) > 5) { l.z = z; l.el.style.zIndex = String(z); }
    void w; void h;
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
