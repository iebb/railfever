// Main user interface: owns the HUD, tools, minimap and windows; per-frame updates with change detection.
import * as THREE from 'three';
import type { Game, NewGameOptions, News } from '../game/game';
import { PLAYER } from '../game/game';
import type { Renderer } from '../render/renderer';
import { WindowManager } from './windows';
import { Tools, ToolId, Hit } from './tools';
import { h, icon } from './dom';
import type { Line } from '../game/lines';
import type { LineKind } from '../game/constants';
import { KIND_META } from './format';
import type { Vehicle } from '../game/vehicle';
import { Minimap } from './minimap';
import { computeLinePath } from './linepaths';
import { Hud } from './hud';
import { newsDate, fmtCompact } from './format';
import { audio, Sfx, PlayOpts } from '../audio/engine';
import { UiTips } from './tips';
import { HoverCard } from './hovercard';
import { Checklist } from './checklist';
import { MapModes } from './mapmodes';
import { catchShapes, CATCH_COLOR, stationLinks } from './gameapi';
import * as info from './win-info';
import * as lines from './win-lines';
import * as company from './win-company';
import * as access from './win-access';
import * as menu from './win-menu';
import { showTitle, TitleOpts } from './title';

export interface AppHooks {
  /** extra: settings applied after creation (e.g. the AI activeness preset) */
  newGame(opts: NewGameOptions): void;
  setGame(g: Game): void;
}

interface FloatText { el: HTMLDivElement; x: number; y: number; z: number; t: number; client?: { x: number; y: number }; tx: string }
/** Optional camera features (follow mode) that the controller may provide. */
interface FollowCam { follow?: (() => THREE.Vector3 | null) | null; distance?: number }

const UI_KEY = 'railfever.ui';

export class UI {
  wm: WindowManager;
  tools!: Tools;
  game!: Game;
  hud: Hud;
  minimap: Minimap;
  tips: UiTips;
  hoverCard: HoverCard;
  checklist: Checklist;
  mapModes: MapModes;
  private toastBox: HTMLDivElement;
  private floatLayer: HTMLDivElement;
  private floats: FloatText[] = [];
  private refreshTimer = 0;
  private incomeAcc = new Map<number, number>();
  private incomeTimer = 0;
  /** time of the last sound (a generic click is skipped when an action already made a sound) */
  private lastSfx = 0;
  private lastNewsSfx = 0;
  reduceTransparency = false;
  catchmentStation = -1;
  private linePathSig = new Map<number, string>();
  lineBroken = new Map<number, [number, number][]>();
  following: number | null = null;
  titleOpen = false;
  /** left column holding the checklist, the map view card and the minimap */
  leftCol!: HTMLDivElement;
  private lastDebug: boolean | null = null;

  constructor(public root: HTMLElement, public renderer: Renderer, public app: AppHooks) {
    this.loadPrefs();
    this.wm = new WindowManager(root);
    this.wm.sfx = { open: () => this.sound('open'), close: () => this.sound('close') };
    this.hud = new Hud(this);
    this.minimap = new Minimap(this);
    this.tips = new UiTips(root);
    this.hoverCard = new HoverCard(this);
    this.checklist = new Checklist(this);
    this.mapModes = new MapModes(this);
    this.mapModes.onChange = () => { this.linePathSig.clear(); this.marksSig = ''; this.hud.syncMapButtons(); this.checklist.setAutoCollapse(this.mapModes.mode !== 'none'); };
    // left column: checklist, map view card and minimap flow top to bottom without overlapping
    this.leftCol = h('div', { class: 'leftcol' });
    root.appendChild(this.leftCol);
    this.leftCol.append(this.checklist.el, this.mapModes.card, this.minimap.el);
    this.toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    root.appendChild(this.toastBox);
    this.floatLayer = h('div', { class: 'floats' });
    root.appendChild(this.floatLayer);
    window.addEventListener('keydown', this.onKey);
    // generic UI sounds: clicks on controls and switch toggles (specific actions play their own sound)
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button, .model, .row.link, tr.clickable, .chip, .swatch.big') as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      const sfx = el.dataset?.sfx;
      if (sfx === 'none' || performance.now() - this.lastSfx < 80) return;
      this.sound((sfx as Sfx) || 'click');
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList?.contains('sw-in') && performance.now() - this.lastSfx > 80) this.sound('toggle', { pitch: (t as HTMLInputElement).checked ? 1.12 : 0.88 });
    });
  }

  // ------------------------------------------------------------------ preferences
  private loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
      if (typeof p.solid === 'boolean') this.reduceTransparency = p.solid;
    } catch { /* ignore */ }
    this.root.classList.toggle('solid', this.reduceTransparency);
  }
  savePrefs() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ solid: this.reduceTransparency })); } catch { /* ignore */ }
    this.root.classList.toggle('solid', this.reduceTransparency);
  }

  setGame(g: Game) {
    this.game = g;
    this.wm.closeAll();
    this.following = null;
    this.catchmentStation = -1;
    this.linePathSig.clear();
    this.lineBroken.clear();
    if (!this.tools) this.tools = new Tools(this);
    this.tools.onToolChange = () => this.hud.onToolChange();
    this.renderer.controls.singleTouchPan = () => this.tools.tool === 'inspect';
    this.hud.setGame(g);
    this.tools.setTool('inspect');
    g.listeners.news.push((n) => this.onNews(n));
    g.listeners.income.push((amt, v, st) => { if (v.owner === PLAYER) this.incomeAcc.set(st.id, (this.incomeAcc.get(st.id) ?? 0) + amt); });
    const labels = this.renderer.labels;
    labels.onClickTown = (id: number) => this.openTown(id);
    labels.onClickStation = (id: number) => {
      if (this.tools.tool === 'line-edit' && this.tools.lineEditId != null) this.addStopToLine(this.tools.lineEditId, id);
      else this.openStation(id);
    };
    this.minimap.reset();
    this.hoverCard.set(null);
    this.mapModes.set('none');
    this.checklist.setGame();
    this.lastHl = undefined;
  }

  // ------------------------------------------------------------------ title screen
  showTitle(opts: Omit<TitleOpts, 'ui'>) { showTitle({ ...opts, ui: this }); }

  setSpeed(sp: number) {
    if (!this.game) return;
    if (sp === 0) this.game.paused = !this.game.paused;
    else { this.game.paused = false; this.game.speed = sp; }
    this.sound(sp === 0 ? 'pause' : 'speed', { pitch: sp === 0 ? (this.game.paused ? 0.8 : 1.2) : 0.85 + sp * 0.05 });
  }

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!this.game || e.metaKey || e.ctrlKey || this.titleOpen) return;
    const k = e.key;
    const T = this.tools;
    const map: Record<string, ToolId> = { '1': 'inspect', '2': 'rail', '3': 'station', '4': 'signal', '5': 'depot-rail', '6': 'road', '7': 'busstop', '8': 'depot-road', '9': 'bulldoze', '0': 'terraform' };
    if (map[k]) { T.setTool(T.tool === map[k] && k !== '1' ? 'inspect' : map[k]); return; }
    if (k === 'Escape') {
      if (T.cancel()) return;
      if (this.mapModes.mode !== 'none') { this.mapModes.set('none'); return; }
      if (!this.wm.closeTop()) this.hud.closeNews();
      return;
    }
    if (k === ' ') { e.preventDefault(); this.setSpeed(0); return; }
    if ((k === 'r' || k === 'R') && ['station', 'depot-rail', 'depot-road', 'depot-tram'].includes(T.tool)) {
      T.rotate(e.shiftKey ? -1 : 1);
      this.hud.onToolChange();
      this.renderer.controls.keys.delete('r');
      return;
    }
    if (T.building && (k === 'PageUp' || k === ']' || k === 'PageDown' || k === '[')) {
      e.preventDefault();
      T.adjustHeight(k === 'PageUp' || k === ']' ? 0.5 : -0.5);
      return;
    }
    const lk = k.toLowerCase();
    if (lk === 'l') this.openLines();
    else if (lk === 'v') this.openVehicles();
    else if (lk === 't') this.openTowns();
    else if (lk === 'c') this.openCompetitors();
    else if (lk === 'k') this.openTrackAccess();
    else if (lk === 'n') this.hud.toggleNews();
    else if (lk === 'm') this.mapModes.toggle('lines');
    else if (lk === 'p') this.mapModes.toggle('demand');
    else if (lk === 'o') this.mapModes.toggle('catchment');
    else if (k === 'F1') { e.preventDefault(); this.openHelp(); }
    else if (lk === 'g') { const u = (this.renderer.terrain.uniforms as unknown as { uGrid?: { value: number } }).uGrid; if (u) u.value = u.value ? 0 : 1; }
  };

  // ------------------------------------------------------------------ per-frame
  update(dt: number) {
    const g = this.game;
    if (!g) return;
    this.hud.update(dt);
    this.tools.update(dt);
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) { this.refreshTimer = 0.3; this.wm.refreshAll(); }
    // income floaters
    this.incomeTimer -= dt;
    if (this.incomeTimer <= 0) {
      this.incomeTimer = 0.6;
      // (the audio engine plays the positional income chime itself)
      for (const [sid, amt] of this.incomeAcc) {
        const st = g.stations.get(sid);
        if (!st || amt < 1) continue;
        const y = (st.rail?.y ?? g.world.heightAt(st.x, st.z)) + 1.4;
        this.addFloat(`+${fmtCompact(amt)}`, 'income', st.x, y, st.z);
      }
      this.incomeAcc.clear();
    }
    if (this.floats.length) this.updateFloats(dt);
    const dbg = !!(this.renderer.settings as unknown as { debug?: boolean }).debug;
    if (dbg !== this.lastDebug) { this.lastDebug = dbg; this.leftCol.classList.toggle('below-debug', dbg); }
    this.minimap.update(dt);
    this.hoverCard.update(dt);
    this.checklist.update(dt);
    this.mapModes.update(dt);
    this.updateLinePaths();
    // follow a vehicle when the camera has no follow mode of its own
    if (this.following != null) {
      const v = g.vehicles.get(this.following);
      const cam = this.renderer.controls as unknown as FollowCam;
      if (!v || !this.wm.get('veh-' + this.following)) this.following = null;
      else if (!('follow' in cam)) { const p = { x: 0, y: 0, z: 0 }; if (v.worldPos(p)) this.renderer.controls.jumpTo(p.x, p.z); }
    }
    if (this.catchmentStation >= 0 && (!g.stations.get(this.catchmentStation) || !this.wm.get('station-' + this.catchmentStation))) this.setCatchment(-1);
    this.highlightLabel(this.tools.hoverStation ?? (this.catchmentStation >= 0 ? this.catchmentStation : null));
  }

  private lastHl: number | null | undefined = undefined;
  private highlightLabel(id: number | null) {
    if (id === this.lastHl) return;
    this.lastHl = id;
    this.renderer.labels.highlight(id);
  }

  private updateLinePaths() {
    const g = this.game;
    const ov = this.renderer.overlay;
    const open = new Set<number>();
    for (const win of this.wm.wins.values()) if (win.id.startsWith('line-')) open.add(Number(win.id.slice(5)));
    const linesMap = this.mapModes.mode === 'lines';
    if (!linesMap) for (const id of ov.linePathIds()) if (!open.has(id)) { ov.setLinePath(id, null); this.linePathSig.delete(id); }
    let marksSig = '';
    for (const id of open) {
      const l = g.lines.get(id);
      if (!l) continue;
      const sig = l.stops.join(',') + '|' + g.networkVersion + '|' + l.color;
      marksSig += id + ':' + sig + ';';
      if (this.linePathSig.get(id) === sig) continue;
      this.linePathSig.set(id, sig);
      const lp = computeLinePath(g, l);
      if (!linesMap) ov.setLinePath(id, lp.curves, l.color);
      this.lineBroken.set(id, lp.broken);
    }
    // stop numbers on the station labels of open lines
    if (marksSig === this.marksSig) return;
    this.marksSig = marksSig;
    const marks = this.renderer.labels.marks;
    marks.clear();
    for (const id of open) {
      const l = g.lines.get(id);
      if (!l) continue;
      l.stops.forEach((sid, i) => { const prev = marks.get(sid); marks.set(sid, { color: l.color, text: (prev ? prev.text + ',' : '') + (i + 1) }); });
    }
  }
  private marksSig = '';

  // ------------------------------------------------------------------ floats, toasts, sounds
  private addFloat(text: string, cls: string, x: number, y: number, z: number, client?: { x: number; y: number }) {
    if (this.floats.length > 40) return;
    const el = h('div', { class: 'float ' + cls }, text);
    this.floatLayer.appendChild(el);
    this.floats.push({ el, x, y, z, t: 0, client, tx: '' });
  }

  floatCost(cost: number, cx: number, cy: number) {
    if (cost <= 0) return;
    this.addFloat(`−${fmtCompact(cost).replace('−', '')}`, 'cost', 0, 0, 0, { x: cx, y: cy });
  }

  private v3 = new THREE.Vector3();
  private updateFloats(dt: number) {
    const cam = this.renderer.camera;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    this.floats = this.floats.filter((f) => {
      f.t += dt;
      if (f.t > 2.2) { f.el.remove(); return false; }
      let sx: number, sy: number;
      if (f.client) { sx = f.client.x; sy = f.client.y - f.t * 30; }
      else {
        this.v3.set(f.x, f.y + f.t * 0.4, f.z).project(cam);
        if (this.v3.z > 1) { if (f.tx !== 'none') { f.tx = 'none'; f.el.style.display = 'none'; } return true; }
        sx = (this.v3.x * 0.5 + 0.5) * W; sy = (-this.v3.y * 0.5 + 0.5) * H;
      }
      const tx = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (f.tx === 'none') f.el.style.display = '';
      f.tx = tx;
      f.el.style.transform = tx;
      f.el.style.opacity = String(Math.min(1, (2.2 - f.t) * 1.5).toFixed(2));
      return true;
    });
  }

  toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
    const el = h('div', { class: 'toast ' + kind }, icon(kind === 'bad' ? 'warning' : kind === 'good' ? 'check' : 'info', 17), h('span', null, msg));
    this.pushToast(el, 3200);
    if (kind === 'bad') this.sound('error');
  }

  private pushToast(el: HTMLElement, ms: number) {
    this.toastBox.appendChild(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 500);
    while (this.toastBox.childElementCount > 4) this.toastBox.firstElementChild!.remove();
  }

  private onNews(n: News) {
    this.hud.onNews(n);
    // requests for access to the player's network: always shown, click to review
    const request = n.text.includes('requests access to your tracks');
    if (request) {
      this.sound('notify');
      const el = h('div', { class: 'toast news ai link' }, h('span', { class: 'news-date' }, newsDate(this.game, n)), h('span', null, n.text), h('b', { class: 'toast-act' }, 'Review'));
      el.addEventListener('click', () => this.openTrackAccess());
      this.pushToast(el, 9000);
      return;
    }
    if (n.kind === 'ai' && !this.game.aiEnabled) return;
    // news chimes are throttled (AI companies report often at high speed); bad news always sounds
    const now = performance.now();
    if (!this.titleOpen && (n.kind === 'bad' || now - this.lastNewsSfx > 2500)) {
      this.lastNewsSfx = now;
      this.sound(n.kind === 'good' ? 'news-good' : n.kind === 'bad' ? 'news-bad' : 'notify', n.kind === 'ai' ? { volume: 0.5 } : {});
    }
    const el = h('div', { class: 'toast news ' + n.kind }, h('span', { class: 'news-date' }, newsDate(this.game, n)), h('span', null, n.text));
    if (n.x !== undefined) { el.classList.add('link'); el.addEventListener('click', () => this.centerOn(n.x!, n.z!)); }
    this.pushToast(el, 6000);
  }

  /** Play a sound effect (world events pass x/z for positional sound). */
  sound(kind: Sfx, opts?: PlayOpts) {
    this.lastSfx = performance.now();
    try { audio.play(kind, opts); } catch (e) { console.warn('sfx', kind, e); }
  }

  // ------------------------------------------------------------------ shared helpers
  kv(k: string, v: Node | string): HTMLElement { return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
  lineChip(l: Line): HTMLElement { return h('span', { class: 'chip', style: `--c:${l.color}`, onclick: () => this.openLine(l.id) }, icon(KIND_META[l.kind].icon, 13), l.name); }
  stationLink(id: number): HTMLElement {
    const st = this.game.stations.get(id);
    return h('a', { class: 'link', onclick: () => this.openStation(id) }, st ? st.name : '?');
  }
  ownerTag(owner: number): HTMLElement {
    if (owner < 0) return h('span', { class: 'owner', style: '--c:#9aa5b4' }, h('i'), 'Town');
    const co = this.game.company(owner);
    return h('span', { class: 'owner', style: `--c:${co.color}` }, h('i'), co.name);
  }
  centerOn(x: number, z: number, dist?: number) {
    (this.renderer.controls as unknown as FollowCam).follow = null;
    this.following = null;
    this.renderer.controls.jumpTo(x, z, dist);
  }
  posOf(v: Vehicle): [number, number] { const p = { x: 0, y: 0, z: 0 }; v.worldPos(p); return [p.x, p.z]; }
  follow(v: Vehicle) {
    const c = this.renderer.controls as unknown as FollowCam;
    const [x, z] = this.posOf(v);
    this.renderer.controls.jumpTo(x, z, Math.min(this.renderer.controls.smoothDistance ?? 30, 22));
    this.following = v.id;
    if ('follow' in c) {
      const p = new THREE.Vector3();
      c.follow = () => {
        if (!this.game.vehicles.get(v.id) || this.following !== v.id) return null;
        const o = { x: 0, y: 0, z: 0 };
        v.worldPos(o);
        return p.set(o.x, o.y, o.z);
      };
    }
  }

  /** Show a station's catchment (with the stations of its transfer complex), or none (-1). */
  setCatchment(id: number) {
    const g = this.game;
    this.catchmentStation = id;
    const st = id >= 0 ? g.stations.get(id) : undefined;
    if (!st) { this.renderer.overlay.setCatchments('sel', null); return; }
    const group = [st, ...stationLinks(g, st).map((sid) => g.stations.get(sid)).filter((x): x is NonNullable<typeof x> => !!x)];
    this.renderer.overlay.setCatchments('sel', group.flatMap((s) => catchShapes(g, s)).map((c) => ({ x: c.x, z: c.z, r: c.r, color: CATCH_COLOR[c.mode] })));
  }

  /** Open the info window for a picked object. */
  openHit(hit: Hit) {
    if (hit.kind === 'station') this.openStation(hit.id);
    else if (hit.kind === 'depot') this.openDepot(hit.id);
    else if (hit.kind === 'edge') this.openEdge(hit.id);
    else if (hit.kind === 'building') { const b = this.game.world.buildings.get(hit.id); if (b) this.openTown(b.townId); }
    else if (hit.kind === 'town') this.openTown(hit.id);
  }

  /** Lists of the Lines dock category. */
  openList(id: string) {
    if (id === 'lines') this.openLines();
    else if (id === 'vehicles') this.openVehicles();
    else if (id === 'towns') this.openTowns();
  }

  // ------------------------------------------------------------------ windows (implemented in win-*.ts)
  openStation(id: number) { info.openStation(this, id); }
  openTown(id: number) { info.openTown(this, id); }
  openEdge(id: number) { info.openEdge(this, id); }
  openVehicle(id: number) { info.openVehicle(this, id); }
  openDepot(id: number) { info.openDepot(this, id); }
  openPurchase(kind: LineKind, depotId: number | null, lineId: number | null) { info.openPurchase(this, kind, depotId, lineId); }
  openLines() { lines.openLines(this); }
  openLine(id: number) { lines.openLine(this, id); }
  editLine(id: number) { lines.editLine(this, id); }
  addStopToLine(lineId: number, stationId: number) { lines.addStopToLine(this, lineId, stationId); }
  openVehicles() { lines.openVehicles(this); }
  openTowns() { lines.openTowns(this); }
  openFinances() { company.openFinances(this); }
  openCompetitors() { company.openCompetitors(this); }
  openTrackAccess() { access.openTrackAccess(this); }
  openNews() { this.hud.openNews(); }
  openMenu() { menu.openMenu(this); }
  openSaveLoad(mode: 'save' | 'load') { menu.openSaveLoad(this, mode); }
  openSettings() { menu.openSettings(this); }
  openHelp() { menu.openHelp(this); }
  openNewGame() { this.showTitle({ newGame: true }); }
}
