// Map views: "Lines map" (every line's route in its colour, side by side where lines share track, with the station
// numbers on the stations and the name of the line under the pointer) and "Demand" (desire lines between towns by
// potential and served share, town rings with share transported).
import * as THREE from 'three';
import type { UI } from './ui';
import type { Line } from '../game/lines';
import { PLAYER } from '../game/game';
import { h, icon, clear, seg } from './dom';
import { getFilter, validateFilter, lineMatches, filterBar, modeCounts, lineSymbol, lineMode, lineCodeOf, allBadges, MODE_META, LineFilter, Badge } from './lineid';
import { computeLinePath, LinePath } from './linepaths';
import { townDemandShare, mailDemandView, fmtMailTonnes, catchStreets, catchWalkLimit, drawCatchStreets, CATCH_COLOR, CatchMode, CITY_REACH, stationInCity } from './gameapi';
import { demandView, DemandView } from '../game/demand';
import { ROUTE_LIFT } from '../render/overlay';
import { mailView, type MailView } from '../game/mail-view';
import type { Arc, ShareRing } from '../render/overlay';
import { markY, markHalfHeight, pinY } from '../render/labels';
import type { Labels, StationMark } from '../render/labels';
import { RouteIndex } from './routepick';
import { fmtInt } from './dom';
import { CITY_STATION } from '../game/stations';

export type MapMode = 'none' | 'lines' | 'demand' | 'catchment' | 'signals';

/**
 * Orange (unserved) → pale yellow → blue (served): a colour-blind-safe ramp (the ends stay > 100 delta E apart under
 * deuteranopia, protanopia and tritanopia; the old red → green ramp fell to 14). Desire lines also get dashes by
 * served share (servedDash) as a second cue.
 */
export const SERVED_RAMP = ['#ff7a2f', '#ffe08a', '#5ea8ff'] as const;
const RAMP_RGB = SERVED_RAMP.map((c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
export function servedColor(f: number): number {
  const t = Math.max(0, Math.min(1, f));
  const c0 = RAMP_RGB[t < 0.5 ? 0 : 1];
  const c1 = RAMP_RGB[t < 0.5 ? 1 : 2];
  const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * k), g = Math.round(c0[1] + (c1[1] - c0[1]) * k), b = Math.round(c0[2] + (c1[2] - c0[2]) * k);
  return (r << 16) | (g << 8) | b;
}
export const hexCss = (c: number) => '#' + c.toString(16).padStart(6, '0');
/** Dash pattern of a desire line by served share: short dashes when unserved, longer as service grows, solid when served. */
export const servedDash = (f: number) => (f >= 0.97 ? 0 : 0.35 + 0.55 * Math.max(0, f));

/** Lines map: route width in px (normal / selected), spacing of lines sharing track, world dimming. */
const ROUTE_W = 5, ROUTE_W_SEL = 8, LANE_STEP = 6.5;
const DIM: Record<MapMode, number> = { none: 0, lines: 0.4, demand: 0.3, catchment: 0.16, signals: 0.34 };
/**
 * Signal blocks overlay: free, reserved (a train's path is set through it) and occupied blocks; path / block signals.
 * Blue / yellow / vermilion stay apart for colour-blind players; free blocks are thin, reserved ones dashed and
 * occupied ones wider (second cue). Signals: colour and size give the kind (path signals pink and larger, block
 * signals white), the head the direction (diamond two-way, arrow one-way).
 */
const BLOCK_COLOR = { free: 0x4d8fe0, reserved: 0xffd23f, occupied: 0xf2542d };
const SIG_COLOR = { path: 0xff85c0, block: 0xf5f7fa };
const DISPLAY_KEY = 'railfever.linesmap';

/** Where a line was shown by a hover or a tap: a point on its route, or the station whose number it was. */
interface LineSpot { line: number; x: number; y: number; z: number; station?: number }

export class MapModes {
  mode: MapMode = 'none';
  /**
   * lines map: mode / company filter (remembered), and the display: 'lines' (routes in their colours with the station
   * numbers on the stations) or 'stations' (quiet routes under station pins with names, waiting and all numbers).
   * Both show a line's name only while it is hovered (tapped on touch).
   */
  filter: LineFilter = getFilter('map');
  filterVer = 0;
  display: 'lines' | 'stations' = 'lines';
  /**
   * lines map hover sources: a legend row under the pointer or with the keyboard focus, the name tag, a station's
   * number, the route under the pointer, a tap
   */
  private hov = { list: null as number | null, kbd: null as number | null, tag: null as number | null, label: null as number | null, station: null as number | null, pick: null as LineSpot | null, tap: null as LineSpot | null };
  /** line whose numbers come first at interchanges (see orderFocus) */
  private focus: number | null = null;
  /** routes in a grid of world cells, for hover picking */
  private index = new RouteIndex();
  private lastTag: (LineSpot & { gap: number; below: boolean }) | null = null;
  private badgeRef: Map<number, Badge[]> | null = null;
  private complexRef: Map<number, number> | null = null;
  private rows = new Map<number, HTMLElement>();
  private rowOn: number | null = null;
  demand: DemandView | null = null;
  demandLayer: 'pax' | 'mail' = 'pax';
  mailDemand: MailView | null = null;
  /** demand view: share of each town's trips the network can carry (by town id) */
  shares = new Map<number, number>();
  /** the card (lines legend / demand summary); placed in the left column by the UI */
  card: HTMLDivElement;
  private sigs = new Map<number, string>();
  private styles = new Map<number, number>();
  private vis: Line[] = [];
  private visIds = new Set<number>();
  private visT = 0; private visFv = -1; private visLv = -1; private visN = -1;
  private pathT = 0; private pathNv = -1; private pathLv = -1; private pathFv = -1;
  private selIds = new Set<number>();
  private winIds = new Set<number>();
  private pins = new Set<number>();
  private labelSig = '';
  private queue: number[] = [];
  private paths = new Map<number, LinePath>();
  private tagPos = new Map<number, { x: number; y: number; z: number }>();
  private lanesDirty = false;
  private shownSig = -1;
  private demandT = 0;
  private catchSig = '';
  /** signals overlay: block of every own rail edge (union of edges joined by nodes without a signal) */
  private blocks: { ver: number; of: Map<number, number>; pts: Map<number, Float32Array> } | null = null;
  private blockSig = '';
  private blockT = 0;
  private listT = 0;
  private listSig = '';
  onChange: () => void = () => {};

  constructor(private ui: UI) {
    this.card = h('div', { class: 'mapcard glass', role: 'region', 'aria-label': 'Map view' });
    this.card.style.display = 'none';
    ui.root.appendChild(this.card);
    const lb = ui.renderer.labels;
    lb.onHoverTag = (id) => { this.hov.tag = this.mode === 'lines' ? id : null; };
    lb.onHoverLine = (line, station) => { const on = this.mode === 'lines'; this.hov.label = on ? line : null; this.hov.station = on ? station : null; };
    lb.onTapLine = (line, station) => this.tapStation(line, station);
    lb.onClickTag = (id) => this.ui.openLine(id);
    this.card.addEventListener('pointerleave', () => { this.hov.list = null; });
    try { const d = localStorage.getItem(DISPLAY_KEY); if (d === 'lines' || d === 'stations') this.display = d; } catch { /* ignore */ }
  }

  /** Line highlighted with its name shown: hovered or focused in the legend, by its name tag, a station's number or
   *  its route (tapped on touch); null when none. */
  get hoverLine(): number | null {
    const h = this.hov;
    return h.list ?? h.kbd ?? h.tag ?? h.label ?? h.tap?.line ?? h.pick?.line ?? null;
  }

  private clearHover() {
    this.hov = { list: null, kbd: null, tag: null, label: null, station: null, pick: null, tap: null };
    this.focus = null;
    this.lastTag = null;
  }

  /** Does a line (still) stop at a station or another station of its transfer complex? */
  private stopsAt(line: number, station: number): boolean {
    const g = this.ui.game, l = g.lines.get(line);
    if (!l || !g.stations.get(station)) return false;
    if (l.stops.includes(station)) return true;
    const of = this.ui.renderer.labels.complexOf, main = of?.get(station);
    return main !== undefined && l.stops.some((s) => of!.get(s) === main);
  }

  /** Forget a station's number hovered or tapped once the station is gone or its line no longer stops there. */
  private dropStaleStations() {
    const h = this.hov;
    if (h.tap?.station != null && !this.stopsAt(h.tap.line, h.tap.station)) h.tap = null;
    if (h.station != null && (h.label == null || !this.stopsAt(h.label, h.station))) { h.label = null; h.station = null; }
  }

  /** Station whose numbers are under the pointer (lines map, line display): it gets the hover card. */
  get labelStation(): number | null { return this.mode === 'lines' && this.display === 'lines' ? this.hov.station : null; }

  /**
   * Lines map, inspect tool: the route under the pointer (client px; `ground`: the terrain point there, null clears)
   * highlights its line and shows its name near the pointer. Returns whether a route is there.
   */
  hoverRoute(clientX: number, clientY: number, ground: THREE.Vector3 | null): boolean {
    this.hov.pick = this.pickRoute(clientX, clientY, ground);
    return !!this.hov.pick;
  }
  /** The pointer left the map: forget the route under it (a line tapped on touch stays shown). */
  clearRouteHover() { this.hov.pick = null; }
  /** Another tool: forget the route under the pointer and a tapped line. */
  clearPointerHover() { this.hov.pick = null; this.hov.tap = null; }

  /**
   * A click on the map (inspect tool) in the lines map: a route opens its line. On touch the first tap only shows
   * the line, as a hover does (a tap beside the routes hides it again). True when the click was taken.
   */
  clickRoute(clientX: number, clientY: number, ground: THREE.Vector3 | null, touch: boolean): boolean {
    const hit = this.pickRoute(clientX, clientY, ground);
    const h = this.hov;
    if (!hit) { if (touch) h.tap = null; return false; }
    if (touch && h.tap?.line !== hit.line) { h.tap = hit; return true; }
    h.tap = null;
    this.ui.openLine(hit.line);
    return true;
  }

  /** The route under a screen point while the pointer is over the map (`ground`: the terrain point there). */
  private pickRoute(clientX: number, clientY: number, ground: THREE.Vector3 | null): LineSpot | null {
    if (this.mode !== 'lines' || !ground || this.index.empty) return null;
    const r = this.ui.renderer;
    const hit = this.index.pick(r.camera, r.renderer.domElement.getBoundingClientRect(), clientX, clientY, this.hoverLine);
    return hit && this.visIds.has(hit.line) ? { line: hit.line, x: hit.x, y: hit.y, z: hit.z } : null;
  }

  /**
   * Touch tap on a station's number (inspect tool): shows its line as hovering does; a second tap opens the station
   * (false: the label's click goes ahead, as it does with other tools, e.g. adding the stop to a line).
   */
  private tapStation(line: number, station: number): boolean {
    const t = this.hov.tap;
    const st = this.ui.game?.stations.get(station);
    if (this.mode !== 'lines' || this.ui.tools?.tool !== 'inspect' || !st || (t && t.line === line && t.station === station)) { this.hov.tap = null; return false; }
    this.hov.tap = { line, x: st.x, y: 0, z: st.z, station };
    return true;
  }

  toggle(m: Exclude<MapMode, 'none'>) { this.set(this.mode === m ? 'none' : m); }

  set(m: MapMode) {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    const ov = this.ui.renderer.overlay;
    const lb = this.ui.renderer.labels;
    // tear down the previous view
    if (prev === 'lines') {
      for (const id of this.paths.keys()) ov.setLinePath(id, null);
      this.paths.clear(); this.sigs.clear(); this.styles.clear(); this.tagPos.clear(); this.queue = []; this.shownSig = -1; this.labelSig = '';
      this.visT = 0; this.pathT = 0; this.visIds.clear();
      this.index.build([]); this.rows.clear(); this.rowOn = null;
      lb.routeTags.clear();
      lb.pinStations = null; lb.stationMarks = null; lb.openStation = null;
    }
    if (prev === 'demand') { ov.setArcs(null); ov.setShareRings(null); ov.setCatchments('demand', null); lb.townInfo.clear(); this.demand = null; this.mailDemand = null; this.shares.clear(); }
    if (prev === 'catchment') { drawCatchStreets(ov, 'map', null); this.catchSig = ''; }
    if (prev === 'signals') { ov.setTrackLayers(null); ov.setSignalGhosts(null); this.blocks = null; this.blockSig = ''; }
    ov.setDim(DIM[m]);
    this.clearHover();
    this.listSig = '';
    this.demandT = 0;
    this.card.style.display = m === 'none' ? 'none' : '';
    if (m !== 'none') this.ui.sound('open'); else this.ui.sound('close');
    this.ui.minimap.setMapMode(m);
    this.onChange();
  }

  update(dt: number) {
    if (!this.ui.game) return;
    if (this.mode === 'lines') this.updateLines(dt);
    else if (this.mode === 'demand') this.updateDemand(dt);
    else if (this.mode === 'catchment') this.updateCatchment();
    else if (this.mode === 'signals') this.updateSignals(dt);
  }

  // ------------------------------------------------------------------ lines map
  /** Lines shown (mode / company filter), refreshed twice a second or when the filter or the lines change. */
  private visibleLines(dt: number): Line[] {
    const g = this.ui.game;
    if (validateFilter(g, this.filter)) { this.filterVer++; this.listSig = ''; }
    this.visT -= dt;
    if (this.visT <= 0 || this.visFv !== this.filterVer || this.visLv !== g.lines.version || this.visN !== g.lines.map.size) {
      this.visT = 0.5; this.visFv = this.filterVer; this.visLv = g.lines.version; this.visN = g.lines.map.size;
      this.vis = g.lines.all().filter((l) => l.stops.length >= 2 && lineMatches(g, l, this.filter)).sort((a, b) => a.id - b.id);
      const vis = this.visIds;
      vis.clear();
      for (const l of this.vis) vis.add(l.id);
      // forget hovers of lines no longer shown
      const h = this.hov;
      if (h.list != null && !vis.has(h.list)) h.list = null;
      if (h.kbd != null && !vis.has(h.kbd)) h.kbd = null;
      if (h.tag != null && !vis.has(h.tag)) h.tag = null;
      if (h.label != null && !vis.has(h.label)) { h.label = null; h.station = null; }
      if (h.pick && !vis.has(h.pick.line)) h.pick = null;
      if (h.tap && !vis.has(h.tap.line)) h.tap = null;
    }
    return this.vis;
  }
  /** Is a line shown by the lines map's filter (minimap)? */
  lineVisible(l: Line): boolean {
    if (this.mode !== 'lines') return lineMatches(this.ui.game, l, this.filter);
    this.visibleLines(0); // The minimap may draw before this frame's map update.
    return this.visIds.has(l.id);
  }

  /** Switch the lines map between its line display and its station display (opening it if closed). */
  toggleDisplay() {
    if (this.mode !== 'lines') { this.display = 'stations'; this.saveDisplay(); this.set('lines'); return; }
    this.setDisplay(this.display === 'lines' ? 'stations' : 'lines');
  }
  setDisplay(d: 'lines' | 'stations') {
    if (d === this.display) return;
    this.display = d;
    this.clearHover();
    this.saveDisplay();
    this.styles.clear();
    this.labelSig = '';
    this.listSig = '';
    this.ui.sound('toggle', { pitch: d === 'stations' ? 1.1 : 0.9 });
  }
  private saveDisplay() { try { localStorage.setItem(DISPLAY_KEY, this.display); } catch { /* ignore */ } }

  /** Lines with an open window (also in winIds) and the hovered line. */
  private selectedIds(): Set<number> {
    const s = this.selIds, w = this.winIds;
    s.clear(); w.clear();
    for (const win of this.ui.wm.wins.values()) if (win.id.startsWith('line-')) { const id = Number(win.id.slice(5)); s.add(id); w.add(id); }
    if (this.hoverLine != null) s.add(this.hoverLine);
    return s;
  }

  private updateLines(dt: number) {
    const g = this.ui.game;
    const ov = this.ui.renderer.overlay;
    const lines = this.visibleLines(dt);
    this.dropStaleStations();
    // routes: checked when the network or the lines changed, else a few times a second
    this.pathT -= dt;
    if (this.pathT <= 0 || this.pathNv !== g.networkVersion || this.pathLv !== g.lines.version || this.pathFv !== this.visFv) {
      this.pathT = 0.4; this.pathNv = g.networkVersion; this.pathLv = g.lines.version; this.pathFv = this.visFv;
      for (const id of [...this.paths.keys()]) if (!this.visIds.has(id)) { ov.setLinePath(id, null); this.paths.delete(id); this.sigs.delete(id); this.styles.delete(id); this.tagPos.delete(id); this.lanesDirty = true; }
      for (const l of lines) {
        const sig = l.stops.join(',') + '|' + g.networkVersion + '|' + g.lines.isLoop(l);
        if (this.sigs.get(l.id) !== sig && !this.queue.includes(l.id)) this.queue.push(l.id);
      }
    }
    // (re)compute routes whose stops / network changed, within a small time budget per frame
    if (this.queue.length) {
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < 4) {
        const id = this.queue.shift()!;
        const l = g.lines.get(id);
        if (!l || !this.visIds.has(id)) continue;
        this.sigs.set(id, l.stops.join(',') + '|' + g.networkVersion + '|' + g.lines.isLoop(l));
        const p = computeLinePath(g, l);
        this.paths.set(id, p);
        this.tagPos.set(id, midPoint(p.curves));
        this.lanesDirty = true;
      }
    }
    // geometry: rebuilt when routes, the set of lines or a colour changed (lanes depend on all of them)
    let shownSig = 0;
    for (const l of lines) shownSig = (shownSig * 31 + l.id * 7 + parseInt(l.color.slice(1), 16)) % 2147483647;
    if (this.lanesDirty || shownSig !== this.shownSig) {
      this.lanesDirty = false;
      this.shownSig = shownSig;
      this.labelSig = '';
      const lanes = laneOffsets(lines.map((l) => [l.id, this.paths.get(l.id)] as const));
      const routes: { id: number; curves: Float32Array[]; lanes?: Float32Array[] }[] = [];
      for (const l of lines) {
        const p = this.paths.get(l.id);
        if (!p) continue;
        ov.setLinePath(l.id, p.curves, l.color, { lanes: lanes.get(l.id) });
        this.styles.delete(l.id);
        routes.push({ id: l.id, curves: p.curves, lanes: lanes.get(l.id) });
      }
      // (hover picking looks the routes up in a grid, built here and not per frame)
      this.index.build(routes);
    }
    // style: selected / hovered lines wider with chevrons and on top, the others dimmed while one is selected;
    // the station display draws the routes thin and quiet under the station pins
    const sel = this.selectedIds();
    const st = this.display === 'stations';
    let selSig = st ? 1 : 0;
    for (const l of lines) {
      if (!this.paths.has(l.id)) continue;
      const on = sel.has(l.id), dim = sel.size > 0 && !on, loop = g.lines.isLoop(l);
      if (on) selSig = (selSig * 31 + l.id) % 2147483647;
      const code = (on ? 1 : 0) + (dim ? 2 : 0) + (loop ? 4 : 0) + (st ? 8 : 0);
      if (this.styles.get(l.id) === code) continue;
      this.styles.set(l.id, code);
      // loops always show their running direction
      ov.setLinePathStyle(l.id, { width: st ? (on ? 5 : 3) : on ? ROUTE_W_SEL : ROUTE_W, opacity: dim ? (st ? 0.3 : 0.45) : st ? 0.6 : 0.92, chevrons: on || (loop && !st), order: on ? 5 : 0 });
    }
    // labels: the station numbers on the stations (line display) or station pins with their numbers (station
    // display), rebuilt only when something they show changed (the labels then touch only stations that changed)
    const lb = this.ui.renderer.labels;
    const focus = this.orderFocus();
    const badges = allBadges(g);
    const lsig = `${shownSig}|${selSig}|${focus}|${this.display}|${this.queue.length}|${g.lines.version}`;
    if (lsig !== this.labelSig || badges !== this.badgeRef || lb.complexOf !== this.complexRef) {
      this.labelSig = lsig; this.badgeRef = badges; this.complexRef = lb.complexOf;
      const pins = this.pins;
      pins.clear();
      if (st) for (const l of lines) for (const sid of l.stops) pins.add(sid);
      lb.pinStations = st ? pins : null;
      lb.stationMarks = st ? null : this.stationMarks(lines, sel, this.winIds, focus, badges, lb.complexOf);
    }
    this.updateTag(lb);
    // (a tapped station shows all its numbers, as pointing at it does)
    lb.openStation = this.hov.tap?.station ?? null;
    this.syncRows();
    this.listT -= dt;
    if (this.listT <= 0) { this.listT = 0.5; this.renderLinesCard(lines); }
  }

  /**
   * The line whose numbers come first at interchanges: the one shown by its route, the legend or a tap on it. It keeps
   * while the pointer is on a station's numbers or a name tag, or a tap shows a station's number, so the numbers
   * never move under the pointer or finger.
   */
  private orderFocus(): number | null {
    const h = this.hov;
    if (h.label == null && h.tag == null && h.tap?.station == null) this.focus = h.list ?? h.kbd ?? h.tap?.line ?? h.pick?.line ?? null;
    return this.focus;
  }

  /**
   * Line display: every station of the lines shown, with its numbers on those lines (the focused line's first, then
   * those with an open window: never the hovered one, which would move the numbers under the pointer), or a stop dot
   * where none of them numbers it; ranked by the lines at the station or its transfer complex; dimmed while other
   * lines are highlighted (`sel`).
   */
  private stationMarks(lines: Line[], sel: Set<number>, open: Set<number>, focus: number | null, badges: Map<number, Badge[]>, complexOf: Map<number, number> | null): Map<number, StationMark> {
    const g = this.ui.game;
    const out = new Map<number, StationMark>();
    for (const l of lines) for (const sid of l.stops) {
      let m = out.get(sid);
      if (!m) { m = { badges: [], lines: [], color: l.color, rank: 0, on: false, dim: false, sig: '' }; out.set(sid, m); }
      if (!m.lines.includes(l.id)) m.lines.push(l.id);
    }
    const atComplex = new Map<number, Set<number>>();
    if (complexOf) for (const [sid, m] of out) {
      const main = complexOf.get(sid);
      if (main === undefined) continue;
      let s = atComplex.get(main);
      if (!s) atComplex.set(main, (s = new Set()));
      for (const id of m.lines) s.add(id);
    }
    const order = (id: number) => (id === focus ? 0 : open.has(id) ? 1 : 2);
    for (const [sid, m] of out) {
      m.lines.sort((a, b) => order(a) - order(b));
      m.order = Object.fromEntries(m.lines.map(id => [id, order(id)]));
      // (lines running through on one route share a number: shown once)
      m.badges = (badges.get(sid) ?? []).filter((b) => this.visIds.has(b.line)).sort((a, b) => order(a.line) - order(b.line))
        .filter((b, i, a) => a.findIndex((o) => o.code === b.code) === i);
      m.color = g.lines.get(m.lines[0])?.color ?? m.color;
      const main = complexOf?.get(sid);
      m.rank = Math.max(m.lines.length, main === undefined ? 0 : atComplex.get(main)?.size ?? 0);
      m.on = m.lines.some((id) => sel.has(id));
      m.dim = sel.size > 0 && !m.on;
      m.sig = m.badges.length ? m.badges.map((b) => b.code + b.color + b.line).join(',') : m.color;
    }
    return out;
  }

  /**
   * The hovered line's name tag: just above the pointer on its route, under the station whose number is hovered or
   * tapped, or mid-route for a legend row; it keeps still while the pointer is on it. Written only when it changed.
   */
  private updateTag(lb: Labels) {
    const g = this.ui.game, h = this.hov, line = this.hoverLine;
    let t = this.lastTag;
    if (line == null) t = null;
    else if (!(h.tag === line && t?.line === line)) {
      const spot = h.list === line || h.kbd === line ? null : h.label === line && h.station != null ? { line, x: 0, y: 0, z: 0, station: h.station } : h.tap?.line === line ? h.tap : h.pick?.line === line ? h.pick : null;
      const s = spot?.station != null ? g.stations.get(spot.station) : undefined;
      if (s) t = this.display === 'lines'
        ? { line, x: s.x, y: markY(g, s), z: s.z, gap: markHalfHeight(this.ui.renderer.controls.smoothDistance) + 5, below: true }
        : { line, x: s.x, y: pinY(g, s), z: s.z, gap: 9, below: true };
      else if (spot && spot.station == null) t = { line, x: spot.x, y: spot.y + ROUTE_LIFT, z: spot.z, gap: 12, below: false };
      else { const m = this.tagPos.get(line); t = m ? { line, x: m.x, y: m.y + 0.6, z: m.z, gap: 2, below: false } : null; }
    }
    this.lastTag = t;
    const l = t ? g.lines.get(t.line) : undefined;
    if (!t || !l) { if (lb.routeTags.size) lb.routeTags.clear(); return; }
    const cur = lb.routeTags.get(t.line);
    if (lb.routeTags.size === 1 && cur && cur.x === t.x && cur.y === t.y && cur.z === t.z && cur.gap === t.gap && cur.below === t.below && cur.text === l.name && cur.color === l.color) return;
    lb.routeTags.clear();
    lb.routeTags.set(t.line, { x: t.x, y: t.y, z: t.z, text: l.name, color: l.color, hl: true, code: lineCodeOf(g, l), gap: t.gap, below: t.below });
  }

  /** Legend: the hovered line's row lit (class only; the list itself is rebuilt at most twice a second). */
  private syncRows() {
    const id = this.hoverLine;
    if (id === this.rowOn) return;
    if (this.rowOn != null) this.rows.get(this.rowOn)?.classList.remove('on');
    if (id != null) this.rows.get(id)?.classList.add('on');
    this.rowOn = id;
  }

  private renderLinesCard(lines: Line[]) {
    const g = this.ui.game;
    const sig = this.filterVer + '|' + this.display + '|' + lines.map((l) => l.id + l.name + l.color + l.vehicles.length + g.lines.isLoop(l)).join(';') + '|' + this.queue.length + '|' + g.lines.version + '|' + g.activeCompanies.map((c) => c.id + ':' + c.name).join(';');
    if (sig === this.listSig) return;
    this.listSig = sig;
    const c = this.card;
    // (a legend row with the keyboard focus keeps it through the rebuild)
    let refocus: number | null = null;
    for (const [id, row] of this.rows) if (row === document.activeElement) refocus = id;
    clear(c);
    this.rows.clear();
    this.rowOn = null;
    const all = g.lines.all().filter((l) => l.stops.length >= 2);
    const numbered = new Set(lines.filter((l) => l.kind === 'rail').flatMap((l) => l.stops)).size;
    // (a line's name shows only while it is pointed at, or tapped on touch screens)
    const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    const show = touch ? 'tap: name · tap again: open' : 'hover: name · click: open';
    const note = this.display === 'lines'
      ? `${numbered ? `${numbered} stations · ` : ''}numbers: company, line, stop (AS01) · ${show}`
      : `Pins: name, waiting, numbers · ${show}`;
    c.append(
      h('div', { class: 'mc-head' }, icon('map', 18), h('span', { class: 'mc-title' }, 'Lines map'), h('span', { class: 'mc-sub' }, `${lines.length}`),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close', 'data-key': 'M', 'data-sfx': 'none', 'aria-label': 'Close lines map', onclick: () => this.set('none') }, icon('close', 16))),
      h('div', { class: 'mc-body' },
        h('div', { class: 'mc-modes' }, seg<'lines' | 'stations'>([['lines', 'Lines', 'Coloured routes and station numbers (B)'], ['stations', 'Stations', 'Station pins: names, waiting passengers, numbers (B)']], this.display, (v) => { this.setDisplay(v); this.listSig = ''; })),
        filterBar(g, this.filter, modeCounts(g, all, this.filter), () => { this.filterVer++; this.listSig = ''; }, true),
        lines.length
          // rows are buttons: Tab to a line shows it on the map with its name, as pointing at it does; Enter opens it
          ? h('div', { class: 'mc-list' }, lines.map((l) => {
            const row = h('button', {
              type: 'button', class: 'mc-row', 'data-sfx': 'none',
              'data-tip': `${l.name} · ${l.vehicles.length} vehicle${l.vehicles.length === 1 ? '' : 's'}${l.owner !== PLAYER ? ' · ' + g.company(l.owner).name : ''}`,
              onpointerenter: () => { this.hov.list = l.id; },
              onpointerleave: () => { if (this.hov.list === l.id) this.hov.list = null; },
              onfocus: () => { this.hov.kbd = l.id; },
              onblur: () => { if (this.hov.kbd === l.id) this.hov.kbd = null; },
              onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); this.ui.openLine(l.id); } },
              onclick: () => this.ui.openLine(l.id),
            }, lineSymbol(g, l, 'sm'), icon(MODE_META[lineMode(g, l)].icon, 14), h('span', { class: 'mc-name' }, l.name), g.lines.isLoop(l) ? h('span', { class: 'loopic', 'data-tip': 'Loop line' }, icon('loop', 12)) : null, l.owner !== PLAYER ? h('span', { class: 'mc-own', style: `--c:${g.company(l.owner).color}` }) : null);
            this.rows.set(l.id, row);
            return row;
          }))
          : h('div', { class: 'mc-empty' }, all.length ? 'No lines match the filter.' : 'No lines with 2+ stops'),
        h('div', { class: 'mc-note' }, note),
        this.queue.length ? h('div', { class: 'mc-note' }, `Tracing routes… ${this.queue.length}`) : null),
    );
    const again = refocus != null ? this.rows.get(refocus) : undefined;
    if (again) again.focus({ preventScroll: true });
    else if (refocus != null) this.hov.kbd = null;
    this.syncRows();
  }

  // ------------------------------------------------------------------ signal blocks
  /** Your railway in signal blocks coloured by occupancy, with the signals (diamonds: two-way, arrows: one-way). */
  private updateSignals(dt: number) {
    this.blockT -= dt;
    if (this.blockT > 0) return;
    this.blockT = 0.25;
    const g = this.ui.game, net = g.world.net, ov = this.ui.renderer.overlay;
    if (!this.blocks || this.blocks.ver !== g.networkVersion) {
      const parent = new Map<number, number>();
      const find = (a: number): number => { let r = a; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
      const pts = new Map<number, Float32Array>();
      for (const e of net.edges.values()) {
        if (e.kind !== 'rail' || e.owner !== PLAYER) continue;
        parent.set(e.id, e.id);
        const geo = net.geo(e), q = new Float32Array(geo.pts);
        for (let i = 1; i < q.length; i += 3) q[i] += 0.3;
        pts.set(e.id, q);
      }
      for (const n of net.nodes.values()) {
        if (n.kind !== 'rail' || n.signal) continue;
        const own = n.edges.filter((id) => parent.has(id));
        for (let i = 1; i < own.length; i++) { const a = find(own[0]), b = find(own[i]); if (a !== b) parent.set(a, b); }
      }
      const of = new Map<number, number>();
      for (const id of pts.keys()) of.set(id, find(id));
      this.blocks = { ver: g.networkVersion, of, pts };
      this.blockSig = '';
      // the signals
      const spots: { x: number; y: number; z: number; dx: number; dz: number; existing: boolean; twoWay: boolean; color: number; size: number }[] = [];
      for (const n of net.nodes.values()) {
        if (n.kind !== 'rail' || !n.signal || n.owner !== PLAYER) continue;
        const f = n.signal === 3 ? -1 : 1;
        const block = n.signalKind === 'block';
        spots.push({ x: n.x, y: n.y, z: n.z, dx: (n.dx || 1) * f, dz: n.dz * f, existing: false, twoWay: n.signal === 1, color: SIG_COLOR[block ? 'block' : 'path'], size: block ? 1 : 1.3 });
      }
      ov.setSignalGhosts(spots);
    }
    const B = this.blocks;
    const occ = new Set<number>(), res = new Set<number>();
    for (const v of g.vehicles.trains()) for (const id of v.occupiedEdges()) { const b = B.of.get(id); if (b !== undefined) occ.add(b); }
    for (const [id, b] of B.of) if (!occ.has(b) && g.vehicles.getRes(id)) res.add(b);
    const sig = [...occ].sort((a, b) => a - b).join(',') + '|' + [...res].sort((a, b) => a - b).join(',');
    if (sig !== this.blockSig) {
      this.blockSig = sig;
      const layers = { free: [] as Float32Array[], reserved: [] as Float32Array[], occupied: [] as Float32Array[] };
      for (const [id, b] of B.of) (occ.has(b) ? layers.occupied : res.has(b) ? layers.reserved : layers.free).push(B.pts.get(id)!);
      ov.setTrackLayers([
        { pts: layers.free, color: BLOCK_COLOR.free, width: 4 },
        { pts: layers.reserved, color: BLOCK_COLOR.reserved, width: 5.5, dash: 0.55, dashPx: 12 },
        { pts: layers.occupied, color: BLOCK_COLOR.occupied, width: 7 },
      ]);
    }
    this.listT -= 0.25;
    if (this.listT <= 0) { this.listT = 1; this.renderSignalsCard(occ.size, res.size, new Set(B.of.values()).size); }
  }

  private renderSignalsCard(occ: number, res: number, blocks: number) {
    const g = this.ui.game;
    let path = 0, block = 0, twoWay = 0;
    for (const n of g.world.net.nodes.values()) if (n.kind === 'rail' && n.signal && n.owner === PLAYER) { if (n.signalKind === 'block') block++; else path++; if (n.signal === 1) twoWay++; }
    const c = this.card;
    clear(c);
    // legend swatches repeat the map's second cues: thin / dashed / wide blocks; large pink path and small white block
    // signals; diamond heads for two-way and arrows for one-way signals (shown neutral)
    const sw = (col: number, t: string, num: string, cls = '') => h('div', { class: 'mc-row', style: 'cursor:default' }, h('i', { class: cls, style: `--c:${hexCss(col)};background:${hexCss(col)}` }), h('span', { class: 'mc-name' }, t), h('span', { class: 'mc-num' }, num));
    const SHAPE = 0xc9d1dc;
    c.append(
      h('div', { class: 'mc-head' }, icon('signal', 18), h('span', { class: 'mc-title' }, 'Signals'), h('span', { class: 'mc-sub' }, `${path + block}`),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close', 'data-sfx': 'none', 'aria-label': 'Close signals view', onclick: () => this.set('none') }, icon('close', 16))),
      h('div', { class: 'mc-body' },
        h('div', { class: 'mc-list' },
          sw(BLOCK_COLOR.free, 'Free blocks', String(blocks - occ - res), 'mc-thin'),
          sw(BLOCK_COLOR.reserved, 'Reserved (a train\u2019s path is set)', String(res), 'mc-dash'),
          sw(BLOCK_COLOR.occupied, 'Occupied by a train', String(occ), 'mc-wide'),
          sw(SIG_COLOR.path, 'Path signals (larger)', String(path), 'mc-dot big'),
          sw(SIG_COLOR.block, 'Block signals', String(block), 'mc-dot'),
          sw(SHAPE, 'Two-way signals', String(twoWay), 'mc-diamond'),
          sw(SHAPE, 'One-way signals', String(path + block - twoWay), 'mc-arrow')),
        h('div', { class: 'mc-note' }, 'Signal-to-signal blocks · path: junctions / station entries · block: open line · arrows: direction'),
        h('div', { class: 'btns' }, h('button', { class: 'btn sm', onclick: () => this.ui.openAutoSignal() }, icon('signal', 14), 'Auto-signal railway…'))),
    );
  }

  // ------------------------------------------------------------------ catchment layer
  /** Your stations' catchment areas by mode, with how many residents the network reaches. */
  private updateCatchment() {
    const g = this.ui.game;
    const mine = g.stations.all().filter((s) => s.owner === PLAYER);
    const sig = g.world.net.version + '|' + g.stations.catchVersion + '|' + mine.length + '|' + Math.floor(g.day / 30);
    if (sig === this.catchSig) return;
    this.catchSig = sig;
    const shown = new Set<number>();
    const segments = mine.flatMap(s => {
      const group = g.stations.catchmentGroup(s.id);
      if (shown.has(group)) return [];
      shown.add(group); return catchStreets(g, s).segments;
    });
    drawCatchStreets(this.ui.renderer.overlay, 'map', { segments, buildings: new Map() });
    const inactive = mine.filter((s) => s.rail && !s.roadAccess).length;
    const reach = mine.reduce((a, s) => a + s.catchPop, 0);
    const pop = g.towns.list.reduce((a, t) => a + t.pop, 0);
    const towns = g.towns.list.filter((t) => !mine.some((s) => Math.hypot(s.x - t.x, s.z - t.z) < t.radius + 10));
    // (in-city metro / light-rail stations walk half as far: a row of their own)
    const city = mine.filter((s) => stationInCity(s)).length;
    const n = (m: CatchMode) => mine.filter((s) => g.stations.catchMode(s) === m).length - (m === 'rail' ? city : 0);
    const c = this.card;
    clear(c);
    // the ring's border repeats the mode's dash pattern on the map (solid, dashed, dotted)
    const row = (m: CatchMode, label: string, r: number, count = n(m)) => h('div', { class: 'mc-row', style: 'cursor:default' }, h('i', { class: 'mc-ring ' + m, style: `--c:${hexCss(CATCH_COLOR[m])}` }), h('span', { class: 'mc-name' }, label), h('span', { class: 'mc-num' }, `${Math.round(r * 10)} m · ${count}`));
    c.append(
      h('div', { class: 'mc-head' }, icon('catchment', 18), h('span', { class: 'mc-title' }, 'Catchment'), h('span', { class: 'mc-sub' }, `${fmtInt(reach)} residents`),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close', 'data-sfx': 'none', 'aria-label': 'Close catchment view', onclick: () => this.set('none') }, icon('close', 16))),
      h('div', { class: 'mc-body' },
        h('div', { class: 'mc-list' }, row('rail', 'Rail stations', catchWalkLimit('rail')), row('rail', 'City metro / LR', catchWalkLimit('rail') * CITY_REACH, city), row('tram', 'Tram stops', catchWalkLimit('tram')), row('bus', 'Bus stops', catchWalkLimit('bus'))),
        h('div', { class: 'mc-stats' },
          h('div', null, h('b', null, pop > 0 ? `${Math.round((reach / pop) * 100)}%` : '–'), h('span', null, 'of residents near your stations')),
          towns.length ? h('div', null, h('b', null, String(towns.length)), h('span', null, `town${towns.length > 1 ? 's' : ''} without your stations`)) : null,
          inactive ? h('div', null, h('b', { class: 'neg' }, String(inactive)), h('span', null, `station${inactive > 1 ? 's' : ''} without road access`)) : null),
        h('div', { class: 'mc-note' }, `Street reach from forecourts, entrances and stops · tram: dashed · rail: equal reach; in-city metro / light rail (town ${fmtInt(CITY_STATION.pop)}+ core): half · grid allowance included · buildings extend reach · hover: coverage`)),
    );
  }

  // ------------------------------------------------------------------ demand view
  setDemandLayer(layer: 'pax' | 'mail') {
    if (layer === this.demandLayer) return;
    this.demandLayer = layer;
    this.demand = null; this.mailDemand = null; this.shares.clear(); this.demandT = 0;
    if (this.mode !== 'demand') return;
    const ov = this.ui.renderer.overlay;
    ov.setArcs(null); ov.setShareRings(null); ov.setCatchments('demand', null);
    this.ui.renderer.labels.townInfo.clear();
    this.ui.sound('toggle', { pitch: layer === 'mail' ? 1.1 : 0.9 });
    this.updateDemand(0);
  }

  private demandToggle() {
    const toggle = seg<'pax' | 'mail'>([
      ['pax', 'Passengers', 'Potential trips · served share'],
      ['mail', 'Mail', 'Potential tonnes · estimated carried share'],
    ], this.demandLayer, (v) => this.setDemandLayer(v));
    toggle.setAttribute('aria-label', 'Demand cargo');
    return h('div', { class: 'mc-modes mc-demand-toggle' }, toggle);
  }

  /**
   * Regional demand: districts as circles coloured by the share of their residents the network serves (more
   * opaque where they produce more trips), the strongest origin-destination flows as raised arcs (width by
   * trips, colour by served share), town labels with the share of their trips the network can carry.
   */
  private updateDemand(dt: number) {
    this.demandT -= dt;
    if (this.demandT > 0) return;
    this.demandT = 0.5;
    if (this.demandLayer === 'mail') { this.updateMailDemand(); return; }
    const g = this.ui.game;
    const d = demandView(g, PLAYER);
    if (d === this.demand) return; // cached per game day and network version
    this.demand = d;
    const ov = this.ui.renderer.overlay;
    ov.setShareRings(null);
    const regions = d.regions ?? [];
    const byId = new Map(regions.map((r) => [r.id, r]));
    // flows: the 50 strongest plus every served one; weak ones fade, strong ones on top
    const flows = (d.flows ?? []).filter((f, i) => i < 50 || f.served > 0.01).slice(0, 140).reverse();
    const maxT = Math.max(1, ...(d.flows ?? []).slice(0, 1).map((f) => f.trips));
    const arcs: Arc[] = [];
    for (const f of flows) {
      const A = byId.get(f.a), B = byId.get(f.b);
      if (!A || !B) continue;
      const k = Math.sqrt(f.trips / maxT), dist = Math.hypot(A.x - B.x, A.z - B.z);
      arcs.push({ ax: A.x, az: A.z, bx: B.x, bz: B.z, w: 1.5 + k * 6.5, alpha: 0.25 + k * 0.7, color: servedColor(f.served), dash: servedDash(f.served), h: 1.5 + dist * 0.2 });
    }
    if (!regions.length) {
      // older model without regions: town pairs
      const towns = new Map(d.towns.map((t) => [t.id, t]));
      const maxP = Math.max(1, d.maxPotential);
      for (const p of d.pairs.filter((q, i) => i < 50 || q.served > 0.01).slice(0, 160).reverse()) {
        const A = towns.get(p.a), B = towns.get(p.b);
        if (!A || !B) continue;
        const k = Math.sqrt(p.potential / maxP);
        arcs.push({ ax: A.x, az: A.z, bx: B.x, bz: B.z, w: 1.5 + k * 6.5, alpha: 0.28 + k * 0.67, color: servedColor(p.served), dash: servedDash(p.served), h: 2 + p.dist * 0.2 });
      }
    }
    ov.setArcs(arcs);
    // district choropleth
    const maxDem = Math.max(1, ...regions.map((r) => r.produced + r.attracted));
    const dark = new THREE.Color(0x2a3240);
    ov.setCatchments('demand', regions.map((r) => {
      const c = new THREE.Color(servedColor(r.served)).lerp(dark, 0.65 * (1 - Math.sqrt((r.produced + r.attracted) / maxDem)));
      return { x: r.x, z: r.z, r: Math.max(4, r.r), color: c.getHex() };
    }));
    // town labels
    const info = this.ui.renderer.labels.townInfo;
    info.clear();
    this.shares.clear();
    for (const t of d.towns) {
      const frac = townDemandShare(d, t);
      this.shares.set(t.id, frac);
      info.set(t.id, `${Math.round(frac * 100)}% served · ${fmtInt(t.potential)}/mo`);
    }
    this.renderDemandCard(d);
  }

  private updateMailDemand() {
    const d = mailView(this.ui.game);
    if (d === this.mailDemand) return;
    this.mailDemand = d;
    this.demand = mailDemandView(d);
    const ov = this.ui.renderer.overlay;
    ov.setCatchments('demand', null);
    const towns = new Map(d.towns.map((t) => [t.id, t]));
    const maxP = Math.max(Number.EPSILON, d.maxPotential);
    const arcs: Arc[] = [];
    for (const p of d.pairs.filter((p, i) => i < 50 || p.share > 0.01).slice(0, 160).reverse()) {
      const A = towns.get(p.a), B = towns.get(p.b);
      if (!A || !B) continue;
      const k = Math.sqrt(p.potential / maxP);
      arcs.push({ ax: A.x, az: A.z, bx: B.x, bz: B.z, w: 1.5 + k * 6.5, alpha: 0.28 + k * 0.67, color: servedColor(p.share), dash: servedDash(p.share), h: 2 + p.dist * 0.2 });
    }
    ov.setArcs(arcs);
    const rings: ShareRing[] = [];
    const info = this.ui.renderer.labels.townInfo;
    info.clear(); this.shares.clear();
    for (const t of d.towns) {
      this.shares.set(t.id, t.share);
      info.set(t.id, `${Math.round(t.share * 100)}% carried · ${fmtMailTonnes(t.potential)} t/mo`);
      rings.push({ x: t.x, z: t.z, r: Math.max(6, t.radius + 2), frac: t.share, color: servedColor(t.share) });
    }
    ov.setShareRings(rings);
    this.renderMailCard(d);
  }

  private renderMailCard(d: MailView) {
    const g = this.ui.game, c = this.card;
    clear(c);
    const unserved = d.towns.filter((t) => t.stations === 0).length;
    const pairs = d.pairs.filter((p) => p.share < 0.5).sort((a, b) => (b.potential - b.carried) - (a.potential - a.carried)).slice(0, 5);
    c.append(
      h('div', { class: 'mc-head' }, icon('demand', 18), h('span', { class: 'mc-title' }, 'Demand'), h('span', { class: 'mc-sub' }, `${Math.round(d.potential > 0 ? d.carried / d.potential * 100 : 0)}% carried`),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close', 'data-key': 'Esc', 'data-sfx': 'none', 'aria-label': 'Close demand view', onclick: () => this.set('none') }, icon('close', 16))),
      h('div', { class: 'mc-body mc-mail' },
        this.demandToggle(),
        h('div', { class: 'mc-grad', role: 'img', 'aria-label': 'Mail share: orange short dashes 0% · blue solid 100%' }, h('span', null, '0% carried'), h('i'), h('span', null, '100%')),
        h('div', { class: 'mc-stats' },
          h('div', null, h('b', null, fmtMailTonnes(d.potential)), h('span', null, 'potential t / month')),
          h('div', null, h('b', null, fmtMailTonnes(d.carried)), h('span', null, 'estimated carried t / month')),
          unserved ? h('div', null, h('b', null, String(unserved)), h('span', null, `town${unserved > 1 ? 's' : ''} without a mail station`)) : null),
        h('div', { class: 'mc-note' }, 'Width: potential t/mo both ways · colour / dashes: estimated share · rings / labels: outgoing mail, including beyond-network mail · vans / trucks / postbuses'),
        pairs.length ? h('div', { class: 'mc-sec' }, 'Biggest uncarried flows') : null,
        pairs.length ? h('div', { class: 'mc-list' }, pairs.map((p) => h('div', {
          class: 'mc-row', 'data-tip': `${fmtMailTonnes(p.potential)} t / month potential · ${fmtMailTonnes(p.carried)} t / month estimated carried · ${(p.dist / 100).toFixed(1)} km · ${Math.round(p.share * 100)}% carried`,
          onclick: () => { const A = g.towns.list[p.a], B = g.towns.list[p.b]; if (A && B) this.ui.centerOn((A.x + B.x) / 2, (A.z + B.z) / 2, Math.max(60, p.dist * 0.9)); },
        }, h('i', { class: servedDash(p.share) ? 'mc-dash' : '', style: `--c:${hexCss(servedColor(p.share))};background:${hexCss(servedColor(p.share))}` }),
        h('span', { class: 'mc-name' }, `${g.towns.list[p.a]?.name ?? '?'} – ${g.towns.list[p.b]?.name ?? '?'}`), h('span', { class: 'mc-num' }, `${fmtMailTonnes(p.potential)} t`)))) : null),
    );
  }

  /** Name of a demand region: the town, its centre, or the compass sector of an outer district. */
  regionName(r: { town: number; kind: string; x: number; z: number }): string {
    const t = this.ui.game.towns.list[r.town];
    if (!t) return 'Countryside';
    if (r.kind === 'town') return t.name;
    if (r.kind === 'centre') return `${t.name} centre`;
    const a = Math.atan2(r.x - t.x, -(r.z - t.z));
    const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return `${t.name} ${dirs[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]}`;
  }

  /** Demand region under a ground point (demand view hover), with a tooltip text. */
  regionAt(x: number, z: number): { title: string; rows: [string, string][] } | null {
    const d = this.demand;
    if (this.mode !== 'demand' || !d?.regions?.length) return null;
    let best: (typeof d.regions)[number] | null = null, bd = Infinity;
    for (const r of d.regions) { const k = Math.hypot(r.x - x, r.z - z) / Math.max(4, r.r); if (k < 1 && k < bd) { bd = k; best = r; } }
    if (!best) return null;
    const out = (d.flows ?? []).filter((f) => f.a === best!.id || f.b === best!.id).slice(0, 3);
    const rows: [string, string][] = [
      ['people', `<b>${fmtInt(best.pop)}</b> residents · <b>${fmtInt(best.jobs)}</b> jobs`],
      ['demand', `<b>${fmtInt(best.produced)}</b> trips/mo from here · <b>${fmtInt(best.attracted)}</b> to here`],
      ['catchment', `<b>${Math.round(best.served * 100)}%</b> of residents near a served station`],
    ];
    for (const f of out) {
      const o = d.regions.find((r) => r.id === (f.a === best!.id ? f.b : f.a));
      if (o) rows.push(['chevr', `${this.regionName(o)} · ${fmtInt(f.trips)}/mo · ${Math.round(f.served * 100)}% served`]);
    }
    return { title: this.regionName(best), rows };
  }

  private renderDemandCard(d: DemandView) {
    const g = this.ui.game;
    const c = this.card;
    clear(c);
    let total = 0, carried = 0, mine = 0;
    for (const p of d.pairs) { total += p.potential; carried += p.potential * p.served; mine += p.potential * p.served * p.mine; }
    const regions = d.regions ?? [];
    const byId = new Map(regions.map((r) => [r.id, r]));
    const unserved = d.towns.filter((t) => t.stations === 0).length;
    const flows = (d.flows ?? []).filter((f) => f.served < 0.5).slice(0, 5);
    const pairs = regions.length ? [] : d.pairs.filter((p) => p.served < 0.5).slice(0, 5);
    const tname = (id: number) => g.towns.list[id]?.name ?? '?';
    const flowRow = (f: (typeof flows)[number]) => {
      const A = byId.get(f.a), B = byId.get(f.b);
      if (!A || !B) return null;
      const dist = Math.hypot(A.x - B.x, A.z - B.z);
      return h('div', {
        class: 'mc-row',
        'data-tip': `${fmtInt(f.trips)} trips / month · ${(dist / 100).toFixed(1)} km · ${Math.round(f.served * 100)}% served`,
        onclick: () => this.ui.centerOn((A.x + B.x) / 2, (A.z + B.z) / 2, Math.max(50, dist * 0.9)),
      }, h('i', { class: servedDash(f.served) ? 'mc-dash' : '', style: `--c:${hexCss(servedColor(f.served))};background:${hexCss(servedColor(f.served))}` }), h('span', { class: 'mc-name' }, `${this.regionName(A)} – ${this.regionName(B)}`), h('span', { class: 'mc-num' }, fmtInt(f.trips)));
    };
    c.append(
      h('div', { class: 'mc-head' }, icon('demand', 18), h('span', { class: 'mc-title' }, 'Demand'), h('span', { class: 'mc-sub' }, `${Math.round(total > 0 ? (carried / total) * 100 : 0)}% served`),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close', 'data-key': 'Esc', 'data-sfx': 'none', 'aria-label': 'Close demand view', onclick: () => this.set('none') }, icon('close', 16))),
      h('div', { class: 'mc-body' },
        this.demandToggle(),
        h('div', { class: 'mc-grad', role: 'img', 'aria-label': 'Unserved: orange dashed · served: blue solid' }, h('span', null, 'unserved'), h('i'), h('span', null, 'served')),
        h('div', { class: 'mc-stats' },
          h('div', null, h('b', null, fmtInt(total)), h('span', null, 'trips / month between towns')),
          regions.length ? h('div', null, h('b', null, String(regions.length)), h('span', null, 'districts')) : null,
          h('div', null, h('b', null, `${Math.round(carried > 0 ? (mine / carried) * 100 : 0)}%`), h('span', null, 'of carried trips start on your lines')),
          unserved ? h('div', null, h('b', null, String(unserved)), h('span', null, `town${unserved > 1 ? 's' : ''} without a station`)) : null),
        h('div', { class: 'mc-note' }, regions.length ? 'Circles: districts · arcs: trips/mo, dashed unserved · hover: details' : 'Width: trips/mo · dashed: unserved'),
        flows.length || pairs.length ? h('div', { class: 'mc-sec' }, 'Biggest unserved flows') : null,
        flows.length ? h('div', { class: 'mc-list' }, flows.map(flowRow)) : null,
        pairs.length ? h('div', { class: 'mc-list' }, pairs.map((p) => h('div', {
          class: 'mc-row', 'data-tip': `${fmtInt(p.potential)} trips / month · ${(p.dist / 100).toFixed(1)} km`,
          onclick: () => { const A = g.towns.list[p.a], B = g.towns.list[p.b]; if (A && B) this.ui.centerOn((A.x + B.x) / 2, (A.z + B.z) / 2, Math.max(60, p.dist * 0.9)); },
        }, h('i', { class: servedDash(p.served) ? 'mc-dash' : '', style: `--c:${hexCss(servedColor(p.served))};background:${hexCss(servedColor(p.served))}` }), h('span', { class: 'mc-name' }, `${tname(p.a)} – ${tname(p.b)}`), h('span', { class: 'mc-num' }, fmtInt(p.potential))))) : null),
    );
  }
}

/** Point halfway along the longest polyline (anchor of a route's name tag). */
function midPoint(curves: Float32Array[]): { x: number; y: number; z: number } {
  let best: Float32Array | null = null, bestLen = -1;
  for (const c of curves) {
    let L = 0;
    for (let i = 3; i < c.length; i += 3) L += Math.hypot(c[i] - c[i - 3], c[i + 2] - c[i - 1]);
    if (L > bestLen) { bestLen = L; best = c; }
  }
  if (!best || best.length < 3) return { x: 0, y: 0, z: 0 };
  let acc = 0;
  for (let i = 3; i < best.length; i += 3) {
    const l = Math.hypot(best[i] - best[i - 3], best[i + 2] - best[i - 1]);
    if (acc + l >= bestLen / 2) {
      const f = l > 0 ? (bestLen / 2 - acc) / l : 0;
      return { x: best[i - 3] + (best[i] - best[i - 3]) * f, y: best[i - 2] + (best[i + 1] - best[i - 2]) * f, z: best[i - 1] + (best[i + 2] - best[i - 1]) * f };
    }
    acc += l;
  }
  return { x: best[0], y: best[1], z: best[2] };
}

/**
 * Lateral offsets (px, per polyline vertex) so that lines sharing an edge run side by side: on every edge the
 * lines using it get lanes centred on the track (in the edge's own direction, so both legs of a line share a
 * lane); the offsets are smoothed along each route where the number of lines changes.
 */
export function laneOffsets(paths: (readonly [number, LinePath | undefined])[]): Map<number, Float32Array[]> {
  const byEdge = new Map<number, number[]>();
  for (const [id, p] of paths) {
    if (!p) continue;
    const seen = new Set<number>();
    for (const arr of p.edges) for (const se of arr) {
      const e = Math.abs(se) - 1;
      if (seen.has(e)) continue;
      seen.add(e);
      const a = byEdge.get(e);
      if (a) a.push(id); else byEdge.set(e, [id]);
    }
  }
  const out = new Map<number, Float32Array[]>();
  for (const [id, p] of paths) {
    if (!p) continue;
    out.set(id, p.edges.map((arr) => {
      const n = arr.length;
      let lane = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const se = arr[i], users = byEdge.get(Math.abs(se) - 1);
        if (!users || users.length < 2) continue;
        lane[i] = (users.indexOf(id) - (users.length - 1) / 2) * LANE_STEP * Math.sign(se);
      }
      // soften the steps where lines join or leave a shared section
      for (let pass = 0; pass < 4; pass++) {
        const nx = new Float32Array(n);
        for (let i = 0; i < n; i++) nx[i] = (lane[Math.max(0, i - 1)] + 2 * lane[i] + lane[Math.min(n - 1, i + 1)]) / 4;
        lane = nx;
      }
      return lane;
    }));
  }
  return out;
}
