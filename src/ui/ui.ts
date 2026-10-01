// Main user interface: owns the HUD, tools, minimap and windows; per-frame updates with change detection.
import * as THREE from 'three';
import type { Game, NewGameOptions, News } from '../game/game';
import { PLAYER } from '../game/game';
import type { Renderer } from '../render/renderer';
import { WindowManager } from './windows';
import { Tools, ToolId, Hit } from './tools';
import { h, icon } from './dom';
import { fmtMoney } from '../game/economy';
import type { Line } from '../game/lines';
import type { Vehicle } from '../game/vehicle';
import { Minimap } from './minimap';
import { computeLinePath } from './linepaths';
import { Hud } from './hud';
import { newsDate } from './format';
import * as info from './win-info';
import * as lines from './win-lines';
import * as company from './win-company';
import * as menu from './win-menu';
import { showTitle, TitleOpts } from './title';

export interface AppHooks {
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
  private toastBox: HTMLDivElement;
  private floatLayer: HTMLDivElement;
  private floats: FloatText[] = [];
  private refreshTimer = 0;
  private incomeAcc = new Map<number, number>();
  private incomeTimer = 0;
  private audio: AudioContext | null = null;
  soundOn = true;
  reduceTransparency = false;
  catchmentStation = -1;
  private lastCash = 0;
  private linePathSig = new Map<number, string>();
  lineBroken = new Map<number, [number, number][]>();
  following: number | null = null;
  titleOpen = false;

  constructor(public root: HTMLElement, public renderer: Renderer, public app: AppHooks) {
    this.loadPrefs();
    this.wm = new WindowManager(root);
    this.hud = new Hud(this);
    this.minimap = new Minimap(this);
    this.toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    root.appendChild(this.toastBox);
    this.floatLayer = h('div', { class: 'floats' });
    root.appendChild(this.floatLayer);
    window.addEventListener('keydown', this.onKey);
  }

  // ------------------------------------------------------------------ preferences
  private loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
      if (typeof p.sound === 'boolean') this.soundOn = p.sound;
      if (typeof p.solid === 'boolean') this.reduceTransparency = p.solid;
    } catch { /* ignore */ }
    this.root.classList.toggle('solid', this.reduceTransparency);
  }
  savePrefs() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ sound: this.soundOn, solid: this.reduceTransparency })); } catch { /* ignore */ }
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
    this.lastHl = undefined;
  }

  // ------------------------------------------------------------------ title screen
  showTitle(opts: Omit<TitleOpts, 'ui'>) { showTitle({ ...opts, ui: this }); }

  setSpeed(sp: number) {
    if (!this.game) return;
    if (sp === 0) this.game.paused = !this.game.paused;
    else { this.game.paused = false; this.game.speed = sp; }
  }

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!this.game || e.metaKey || e.ctrlKey || this.titleOpen) return;
    const k = e.key;
    const T = this.tools;
    const map: Record<string, ToolId> = { '1': 'inspect', '2': 'rail', '3': 'station', '4': 'signal', '5': 'depot-rail', '6': 'road', '7': 'busstop', '8': 'depot-road', '9': 'bulldoze', '0': 'terraform' };
    if (map[k]) { T.setTool(T.tool === map[k] && k !== '1' ? 'inspect' : map[k]); return; }
    if (k === 'Escape') { if (!T.cancel() && !this.wm.closeTop()) this.hud.closeNews(); return; }
    if (k === ' ') { e.preventDefault(); this.setSpeed(0); return; }
    if ((k === 'r' || k === 'R') && ['station', 'depot-rail', 'depot-road'].includes(T.tool)) {
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
    else if (lk === 'n') this.hud.toggleNews();
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
      for (const [sid, amt] of this.incomeAcc) {
        const st = g.stations.get(sid);
        if (!st || amt < 1) continue;
        const y = (st.rail?.y ?? g.world.heightAt(st.x, st.z)) + 1.2;
        this.addFloat(`+${fmtMoney(amt)}`, 'income', st.x, y, st.z);
      }
      const now = performance.now();
      if (this.incomeAcc.size && now - this.lastCash > 2500) { this.lastCash = now; this.sound('cash'); }
      this.incomeAcc.clear();
    }
    if (this.floats.length) this.updateFloats(dt);
    this.minimap.update(dt);
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
    for (const id of ov.linePathIds()) if (!open.has(id)) { ov.setLinePath(id, null); this.linePathSig.delete(id); }
    let marksSig = '';
    for (const id of open) {
      const l = g.lines.get(id);
      if (!l) continue;
      const sig = l.stops.join(',') + '|' + g.networkVersion + '|' + l.color;
      marksSig += id + ':' + sig + ';';
      if (this.linePathSig.get(id) === sig) continue;
      this.linePathSig.set(id, sig);
      const lp = computeLinePath(g, l);
      ov.setLinePath(id, lp.curves, l.color);
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
    this.addFloat(`−${fmtMoney(cost)}`, 'cost', 0, 0, 0, { x: cx, y: cy });
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
    if (n.kind === 'ai' && !this.game.aiEnabled) return;
    const el = h('div', { class: 'toast news ' + n.kind }, h('span', { class: 'news-date' }, newsDate(this.game, n)), h('span', null, n.text));
    if (n.x !== undefined) { el.classList.add('link'); el.addEventListener('click', () => this.centerOn(n.x!, n.z!)); }
    this.pushToast(el, 6000);
  }

  sound(kind: 'build' | 'demolish' | 'click' | 'cash' | 'error') {
    if (!this.soundOn) return;
    try {
      if (!this.audio) this.audio = new AudioContext();
      const ac = this.audio;
      const t0 = ac.currentTime;
      const gain = ac.createGain();
      gain.connect(ac.destination);
      const osc = ac.createOscillator();
      osc.connect(gain);
      const env = (a: number, d: number, v: number) => { gain.gain.setValueAtTime(0, t0); gain.gain.linearRampToValueAtTime(v, t0 + a); gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); };
      if (kind === 'cash') { osc.type = 'sine'; osc.frequency.setValueAtTime(1320, t0); osc.frequency.setValueAtTime(1760, t0 + 0.07); env(0.005, 0.25, 0.04); }
      else if (kind === 'build') { osc.type = 'triangle'; osc.frequency.setValueAtTime(220, t0); osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.15); env(0.005, 0.2, 0.12); }
      else if (kind === 'demolish') { osc.type = 'sawtooth'; osc.frequency.setValueAtTime(120, t0); osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.3); env(0.005, 0.35, 0.08); }
      else if (kind === 'error') { osc.type = 'square'; osc.frequency.setValueAtTime(160, t0); env(0.005, 0.18, 0.04); }
      else { osc.type = 'sine'; osc.frequency.setValueAtTime(880, t0); env(0.002, 0.06, 0.05); }
      osc.start(t0);
      osc.stop(t0 + 0.5);
    } catch { /* audio unavailable */ }
  }

  // ------------------------------------------------------------------ shared helpers
  kv(k: string, v: Node | string): HTMLElement { return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
  lineChip(l: Line): HTMLElement { return h('span', { class: 'chip', style: `--c:${l.color}`, onclick: () => this.openLine(l.id) }, l.name); }
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

  setCatchment(id: number) {
    const g = this.game;
    this.catchmentStation = id;
    const st = id >= 0 ? g.stations.get(id) : undefined;
    const u = this.renderer.terrain.uniforms as unknown as { uCircle?: { value: THREE.Vector4 }; uCircleColor?: { value: THREE.Color } };
    if (!st) { this.renderer.overlay.setRings(null); if (u.uCircle && this.tools.tool === 'inspect') u.uCircle.value.w = 0; return; }
    const rings: { x: number; z: number; r: number }[] = [];
    if (st.rail) rings.push({ x: st.rail.x, z: st.rail.z, r: g.stations.catchmentRadius(st) });
    for (const p of st.stops) rings.push({ x: p.x, z: p.z, r: 14 });
    this.renderer.overlay.setRings(rings, 0x3ccb7f);
    if (u.uCircle && rings[0]) { u.uCircle.value.set(rings[0].x, rings[0].z, rings[0].r, 1); u.uCircleColor?.value.setHex(0x3ccb7f); }
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
  openPurchase(kind: 'rail' | 'road', depotId: number | null, lineId: number | null) { info.openPurchase(this, kind, depotId, lineId); }
  openLines() { lines.openLines(this); }
  openLine(id: number) { lines.openLine(this, id); }
  editLine(id: number) { lines.editLine(this, id); }
  addStopToLine(lineId: number, stationId: number) { lines.addStopToLine(this, lineId, stationId); }
  openVehicles() { lines.openVehicles(this); }
  openTowns() { lines.openTowns(this); }
  openFinances() { company.openFinances(this); }
  openCompetitors() { company.openCompetitors(this); }
  openNews() { this.hud.openNews(); }
  openMenu() { menu.openMenu(this); }
  openSaveLoad(mode: 'save' | 'load') { menu.openSaveLoad(this, mode); }
  openSettings() { menu.openSettings(this); }
  openHelp() { menu.openHelp(this); }
  openNewGame() { this.showTitle({ newGame: true }); }
}
