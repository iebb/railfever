// Main user interface: HUD, toolbar, tool options and windows.
import * as THREE from 'three';
import type { Game, NewGameOptions, News } from '../game/game';
import { MONTH_NAMES, PLAYER } from '../game/game';
import type { Renderer } from '../render/renderer';
import { WindowManager } from './windows';
import { Tools, ToolId, TOOL_INFO, Hit, fmtHeight } from './tools';
import { h, clear, fmtInt, bar, icon } from './dom';
import { fmtMoney, fmtMoneyFull, CATEGORIES, CATEGORY_LABEL } from '../game/economy';
import { availableModels, VehicleModel, MODEL_BY_ID } from '../game/vehicle-types';
import { Train, depotReaches } from '../game/train';
import { RoadVehicle, roadDepotReaches } from '../game/roadvehicle';
import { LINE_COLORS, Line } from '../game/lines';
import { BUILDING_TYPES } from '../game/towns';
import { saveToSlot, loadFromSlot, listSlots, deleteSlot, exportToFile, importFromText } from '../game/save';
import type { Vehicle } from '../game/vehicle';
import { TRACK_TYPES, ROAD_TYPES } from '../game/constants';
import { Minimap } from './minimap';
import { computeLinePath } from './linepaths';

export interface AppHooks {
  newGame(opts: NewGameOptions): void;
  setGame(g: Game): void;
}

interface FloatText { el: HTMLDivElement; x: number; y: number; z: number; t: number; client?: { x: number; y: number } }
/** Optional camera features (follow mode) that the controller may provide. */
interface FollowCam { follow?: (() => THREE.Vector3 | null) | null; distance?: number }

const CAR_GAP = 0.1;

export class UI {
  wm: WindowManager;
  tools!: Tools;
  game!: Game;
  private moneyEl!: HTMLSpanElement;
  private dateEl!: HTMLSpanElement;
  private speedBtns: HTMLButtonElement[] = [];
  private toolBtns = new Map<ToolId, HTMLButtonElement>();
  private optionsEl!: HTMLDivElement;
  private toastBox!: HTMLDivElement;
  private floatLayer!: HTMLDivElement;
  private floats: FloatText[] = [];
  private refreshTimer = 0;
  private incomeAcc = new Map<number, number>();
  private incomeTimer = 0;
  private audio: AudioContext | null = null;
  soundOn = true;
  private catchmentStation = -1;
  private lastCash = 0;
  private linePathSig = new Map<number, string>();
  private fpsEl!: HTMLSpanElement;
  private following: number | null = null;
  minimap: Minimap;

  constructor(public root: HTMLElement, public renderer: Renderer, private app: AppHooks) {
    this.wm = new WindowManager(root);
    this.buildHud();
    this.minimap = new Minimap(this);
    window.addEventListener('keydown', this.onKey);
  }

  setGame(g: Game) {
    this.game = g;
    this.wm.closeAll();
    this.following = null;
    this.catchmentStation = -1;
    this.linePathSig.clear();
    if (!this.tools) this.tools = new Tools(this);
    this.tools.onToolChange = () => this.updateToolbar();
    this.renderer.controls.singleTouchPan = () => this.tools.tool === 'inspect';
    this.tools.setTool('inspect');
    g.listeners.news.push((n) => this.onNews(n));
    g.listeners.income.push((amt, v, st) => { if (v.owner === PLAYER) this.incomeAcc.set(st.id, (this.incomeAcc.get(st.id) ?? 0) + amt); });
    const labels = this.renderer.labels;
    labels.onClickTown = (id: number) => this.openTown(id);
    labels.onClickStation = (id: number) => {
      if (this.tools.tool === 'line-edit' && this.tools.lineEditId != null) this.addStopToLine(this.tools.lineEditId, id);
      else this.openStation(id);
    };
    this.updateSpeedButtons();
    this.minimap.reset();
    for (const n of g.news.slice(-1)) this.onNews(n);
  }

  // ------------------------------------------------------------------ HUD
  private buildHud() {
    const R = this.root;
    this.moneyEl = h('span', { class: 'money' });
    this.dateEl = h('span', { class: 'date' });
    const speeds: [string, number][] = [['pause', 0], ['play', 1], ['ff', 2], ['ff', 4], ['ff', 8]];
    const speedBox = h('div', { class: 'speeds' });
    speeds.forEach(([ic, sp], i) => {
      const b = h('button', { class: 'sbtn', title: sp === 0 ? 'Pause (Space)' : `${sp}× speed` }, icon(ic, 16), sp > 1 ? h('small', null, sp + '×') : null);
      b.addEventListener('click', () => this.setSpeed(sp));
      this.speedBtns[i] = b;
      speedBox.appendChild(b);
    });
    this.fpsEl = h('span', { class: 'fps' });
    const top = h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'RAIL'), h('span', { class: 'logo2' }, 'FEVER')),
      h('button', { class: 'money-btn', title: 'Finances', onclick: () => this.openFinances() }, icon('money', 18), this.moneyEl),
      h('div', { class: 'datebox' }, this.dateEl, speedBox),
      h('div', { class: 'spacer' }),
      this.fpsEl,
      h('button', { class: 'tbtn', title: 'Competitors (C)', onclick: () => this.openCompetitors() }, icon('company', 18)),
      h('button', { class: 'tbtn', title: 'News', onclick: () => this.openNews() }, icon('news', 18)),
      h('button', { class: 'tbtn', title: 'Help (F1)', onclick: () => this.openHelp() }, icon('help', 18)),
      h('button', { class: 'tbtn', title: 'Menu', onclick: () => this.openMenu() }, icon('menu', 18)),
    );
    R.appendChild(top);

    const groups: [ToolId | string, string, string][][] = [
      [['inspect', 'inspect', '1']],
      [['rail', 'rail', '2'], ['station', 'station', '3'], ['signal', 'signal', '4'], ['depot-rail', 'depot', '5']],
      [['road', 'road', '6'], ['busstop', 'bus', '7'], ['depot-road', 'garage', '8']],
      [['bulldoze', 'bulldoze', '9'], ['terraform', 'terraform', '0']],
      [['#lines', 'lines', 'L'], ['#vehicles', 'vehicles', 'V'], ['#towns', 'towns', 'T'], ['#finances', 'money', 'F'], ['#competitors', 'company', 'C']],
    ];
    const tb = h('div', { class: 'toolbar' });
    for (const grp of groups) {
      const gEl = h('div', { class: 'tgroup' });
      for (const [id, ic, key] of grp) {
        const isTool = !id.startsWith('#');
        const name = isTool ? TOOL_INFO[id as ToolId].name : id.slice(1)[0].toUpperCase() + id.slice(2);
        const b = h('button', { class: 'tool', title: `${name} [${key}]` }, icon(ic, 24), h('span', { class: 'key' }, key));
        b.addEventListener('click', () => {
          if (!this.game) return;
          if (isTool) this.tools.setTool(this.tools.tool === id ? 'inspect' : (id as ToolId));
          else if (id === '#lines') this.openLines();
          else if (id === '#vehicles') this.openVehicles();
          else if (id === '#towns') this.openTowns();
          else if (id === '#finances') this.openFinances();
          else if (id === '#competitors') this.openCompetitors();
        });
        if (isTool) this.toolBtns.set(id as ToolId, b);
        gEl.appendChild(b);
      }
      tb.appendChild(gEl);
    }
    this.optionsEl = h('div', { class: 'tool-options' });
    R.appendChild(h('div', { class: 'bottom' }, this.optionsEl, tb));
    this.toastBox = h('div', { class: 'toasts' });
    R.appendChild(this.toastBox);
    this.floatLayer = h('div', { class: 'floats' });
    R.appendChild(this.floatLayer);
  }

  /** Tool options panel above the toolbar. */
  updateToolbar() {
    const T = this.tools;
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', T.tool === id);
    const t = T.tool;
    const o = this.optionsEl;
    clear(o);
    if (t === 'inspect') { o.style.display = 'none'; return; }
    o.style.display = 'block';
    o.appendChild(h('div', { class: 'opt-title' }, TOOL_INFO[t].name));
    o.appendChild(h('div', { class: 'opt-hint' }, TOOL_INFO[t].hint));
    const redo = () => { this.updateToolbar(); T.refreshHover(); };
    const seg = <V extends string | number>(label: string, opts: [V, string, string?][], get: () => V, set: (v: V) => void) =>
      h('div', { class: 'seg-wrap' }, h('label', null, label), h('div', { class: 'seg' }, opts.map(([v, l, tip]) =>
        h('button', { class: 'segb' + (get() === v ? ' on' : ''), title: tip ?? '', onclick: () => { set(v); redo(); } }, l))));
    const stepper = (label: string, get: () => string, dec: () => void, inc: () => void, tip = '') =>
      h('div', { class: 'stepper', title: tip }, h('label', null, label), h('button', { onclick: () => { dec(); redo(); } }, '−'), h('span', { class: 'val' }, get()), h('button', { onclick: () => { inc(); redo(); } }, '+'));
    const rows: HTMLElement[] = [];
    if (t === 'rail' || t === 'road') {
      if (t === 'rail') {
        rows.push(seg('Track', [['standard', 'Standard', `${TRACK_TYPES.standard.speed} km/h`], ['highspeed', 'High-speed ⚡', `${TRACK_TYPES.highspeed.speed} km/h, electrified`]], () => T.railType, (v) => (T.railType = v)));
        rows.push(seg('Parallel', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], () => T.tracks, (v) => (T.tracks = v)));
      } else {
        rows.push(seg('Road', [['street', 'Town street', `${ROAD_TYPES.street.speed} km/h, sidewalks`], ['road', 'Country road', `${ROAD_TYPES.road.speed} km/h`]], () => T.roadType, (v) => (T.roadType = v)));
      }
      rows.push(stepper('Height', () => fmtHeight(T.heightOffset), () => T.adjustHeight(-0.5), () => T.adjustHeight(0.5), 'PageUp/PageDown or [ ] — raised ends make bridges, lowered ends make cuttings and tunnels'));
      rows.push(seg('Crossings', [['auto', 'Auto'], ['over', 'Over'], ['under', 'Under'], ['level', 'Level']], () => T.crossing, (v) => (T.crossing = v)));
      if (T.start) rows.push(h('button', { class: 'btn small', onclick: () => T.cancel() }, 'End chain [Esc]'));
    } else if (t === 'station') {
      rows.push(stepper('Length', () => `${T.stationLen * 10} m`, () => (T.stationLen = Math.max(8, T.stationLen - 2)), () => (T.stationLen = Math.min(40, T.stationLen + 2))));
      rows.push(stepper('Tracks', () => String(T.stationTracks), () => (T.stationTracks = Math.max(1, T.stationTracks - 1)), () => (T.stationTracks = Math.min(6, T.stationTracks + 1))));
      rows.push(h('div', { class: 'inline' }, h('button', { class: 'btn small', onclick: () => T.rotate(-1) }, '⟲'), h('span', { class: 'val' }, `${Math.round((T.stationAngle * 180) / Math.PI)}°`), h('button', { class: 'btn small', onclick: () => T.rotate(1) }, '⟳')));
      const cb = h('input', { type: 'checkbox', checked: T.autoAlign }) as HTMLInputElement;
      cb.addEventListener('change', () => { T.autoAlign = cb.checked; T.refreshHover(); });
      rows.push(h('label', { class: 'check' }, cb, 'Align to track'));
    } else if (t === 'depot-rail' || t === 'depot-road') {
      rows.push(h('div', { class: 'inline' }, h('button', { class: 'btn small', onclick: () => T.rotate(-1) }, '⟲ Rotate'), h('button', { class: 'btn small', onclick: () => T.rotate(1) }, 'Rotate ⟳')));
    } else if (t === 'terraform') {
      rows.push(seg('Mode', [['raise', 'Raise'], ['lower', 'Lower'], ['level', 'Level']], () => T.terraMode, (v) => (T.terraMode = v)));
      const rng = h('input', { type: 'range', min: '1', max: '14', value: String(T.brushRadius), class: 'range' }) as HTMLInputElement;
      const val = h('span', { class: 'val' }, `${T.brushRadius * 10} m`);
      rng.addEventListener('input', () => { T.brushRadius = Number(rng.value); val.textContent = `${T.brushRadius * 10} m`; T.refreshHover(); });
      rows.push(h('div', { class: 'inline' }, h('label', { class: 'muted' }, 'Radius'), rng, val));
    } else if (t === 'line-edit') {
      const line = T.lineEditId != null ? this.game.lines.get(T.lineEditId) : null;
      rows.push(h('span', { class: 'swatch', style: `background:${line?.color}` }), h('b', null, line?.name ?? ''), h('span', null, ` · ${line?.stops.length ?? 0} stops`));
      rows.push(h('button', { class: 'btn primary', onclick: () => T.setTool('inspect') }, 'Done'));
    }
    if (rows.length) o.appendChild(h('div', { class: 'opt-row' }, rows));
  }

  setSpeed(sp: number) {
    if (sp === 0) this.game.paused = !this.game.paused;
    else { this.game.paused = false; this.game.speed = sp; }
    this.updateSpeedButtons();
  }
  private updateSpeedButtons() {
    const g = this.game;
    if (!g) return;
    const idx = g.paused ? 0 : [1, 2, 4, 8].indexOf(g.speed) + 1;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!this.game || e.metaKey || e.ctrlKey) return;
    const k = e.key;
    const T = this.tools;
    const map: Record<string, ToolId> = { '1': 'inspect', '2': 'rail', '3': 'station', '4': 'signal', '5': 'depot-rail', '6': 'road', '7': 'busstop', '8': 'depot-road', '9': 'bulldoze', '0': 'terraform' };
    if (map[k]) { T.setTool(T.tool === map[k] && k !== '1' ? 'inspect' : map[k]); return; }
    if (k === 'Escape') { if (!T.cancel()) this.wm.closeTop(); return; }
    if (k === ' ') { e.preventDefault(); this.setSpeed(0); return; }
    if ((k === 'r' || k === 'R') && ['station', 'depot-rail', 'depot-road'].includes(T.tool)) {
      T.rotate(e.shiftKey ? -1 : 1);
      this.updateToolbar();
      this.renderer.controls.keys.delete('r');
      return;
    }
    if (T.building && (k === 'PageUp' || k === ']' || k === 'PageDown' || k === '[')) {
      e.preventDefault();
      T.adjustHeight(k === 'PageUp' || k === ']' ? 0.5 : -0.5);
      return;
    }
    if (k === 'l' || k === 'L') this.openLines();
    else if (k === 'v' || k === 'V') this.openVehicles();
    else if (k === 't' || k === 'T') this.openTowns();
    else if (k === 'c' || k === 'C') this.openCompetitors();
    else if (k === 'F1') { e.preventDefault(); this.openHelp(); }
    else if (k === 'g' || k === 'G') { const u = (this.renderer.terrain.uniforms as unknown as { uGrid?: { value: number } }).uGrid; if (u) u.value = u.value ? 0 : 1; }
  };

  // ------------------------------------------------------------------ per-frame
  update(dt: number) {
    const g = this.game;
    if (!g) return;
    this.moneyEl.textContent = fmtMoneyFull(g.economy.money);
    this.moneyEl.classList.toggle('neg', g.economy.money < 0);
    this.dateEl.textContent = g.dateString();
    this.fpsEl.textContent = this.renderer.fps.toFixed(0) + ' fps';
    this.tools.update(dt);
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) { this.refreshTimer = 0.5; this.wm.refreshAll(); }
    // income floaters
    this.incomeTimer -= dt;
    if (this.incomeTimer <= 0) {
      this.incomeTimer = 0.6;
      for (const [sid, amt] of this.incomeAcc) {
        const st = g.stations.get(sid);
        if (!st || amt < 1) continue;
        const y = (st.rail?.y ?? g.world.heightAt(st.x, st.z)) + 0.9;
        this.addFloat(`+${fmtMoney(amt)}`, 'income', st.x, y, st.z);
      }
      const now = performance.now();
      if (this.incomeAcc.size && now - this.lastCash > 2500) { this.lastCash = now; this.sound('cash'); }
      this.incomeAcc.clear();
    }
    this.updateFloats(dt);
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
    // label highlight: hovered station, else the station of the top-most station window
    this.highlightLabel(this.tools.hoverStation ?? (this.catchmentStation >= 0 ? this.catchmentStation : null));
  }

  private lastHl: number | null | undefined = undefined;
  private highlightLabel(id: number | null) {
    if (id === this.lastHl) return;
    this.lastHl = id;
    const l = this.renderer.labels as unknown as { highlight?: unknown };
    if (typeof l.highlight === 'function') (l.highlight as (id: number | null) => void).call(this.renderer.labels, id);
  }

  private updateLinePaths() {
    const g = this.game;
    const ov = this.renderer.overlay;
    const open = new Set<number>();
    for (const win of this.wm.wins.values()) if (win.id.startsWith('line-')) open.add(Number(win.id.slice(5)));
    for (const id of ov.linePathIds()) if (!open.has(id)) { ov.setLinePath(id, null); this.linePathSig.delete(id); }
    for (const id of open) {
      const l = g.lines.get(id);
      if (!l) continue;
      const sig = l.stops.join(',') + '|' + g.networkVersion + '|' + l.color;
      if (this.linePathSig.get(id) === sig) continue;
      this.linePathSig.set(id, sig);
      const lp = computeLinePath(g, l);
      ov.setLinePath(id, lp.curves, l.color);
      this.lineBroken.set(id, lp.broken);
    }
    // stop numbers on the station labels of open lines
    const marks = (this.renderer.labels as unknown as { marks?: Map<number, { color: string; text: string }> }).marks;
    if (marks) {
      marks.clear();
      for (const id of open) {
        const l = g.lines.get(id);
        if (!l) continue;
        l.stops.forEach((sid, i) => { const prev = marks.get(sid); marks.set(sid, { color: l.color, text: (prev ? prev.text + ',' : '') + (i + 1) }); });
      }
    }
  }
  private lineBroken = new Map<number, [number, number][]>();

  private addFloat(text: string, cls: string, x: number, y: number, z: number, client?: { x: number; y: number }) {
    const el = h('div', { class: 'float ' + cls }, text);
    this.floatLayer.appendChild(el);
    this.floats.push({ el, x, y, z, t: 0, client });
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
        if (this.v3.z > 1) { f.el.style.display = 'none'; return true; }
        sx = (this.v3.x * 0.5 + 0.5) * W; sy = (-this.v3.y * 0.5 + 0.5) * H;
      }
      f.el.style.display = '';
      f.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      f.el.style.opacity = String(Math.min(1, (2.2 - f.t) * 1.5));
      return true;
    });
  }

  toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
    const el = h('div', { class: 'toast ' + kind }, msg);
    this.toastBox.appendChild(el);
    if (kind === 'bad') this.sound('error');
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
    while (this.toastBox.childElementCount > 5) this.toastBox.firstElementChild!.remove();
  }

  private newsDate(n: News) { return `${MONTH_NAMES[Math.floor(n.day / 30) % 12]} ${this.game.options.startYear + Math.floor(n.day / 360)}`; }

  private onNews(n: News) {
    const el = h('div', { class: 'news-item ' + n.kind }, h('span', { class: 'news-date' }, this.newsDate(n)), n.text);
    if (n.x !== undefined) { el.style.cursor = 'pointer'; el.addEventListener('click', () => this.centerOn(n.x!, n.z!)); }
    this.toastBox.appendChild(el);
    setTimeout(() => el.classList.add('out'), 6500);
    setTimeout(() => el.remove(), 7200);
    while (this.toastBox.childElementCount > 5) this.toastBox.firstElementChild!.remove();
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

  // ------------------------------------------------------------------ helpers
  kv(k: string, v: Node | string): HTMLElement { return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
  lineChip(l: Line): HTMLElement {
    return h('span', { class: 'chip', style: `--c:${l.color}`, onclick: () => this.openLine(l.id) }, l.name);
  }
  stationLink(id: number): HTMLElement {
    const st = this.game.stations.get(id);
    return h('a', { class: 'link', onclick: () => this.openStation(id) }, st ? st.name : '?');
  }
  ownerTag(owner: number): HTMLElement {
    if (owner < 0) return h('span', { class: 'owner' }, 'Town');
    const co = this.game.company(owner);
    return h('span', { class: 'owner' }, h('span', { class: 'swatch', style: `background:${co.color}` }), co.name);
  }
  centerOn(x: number, z: number, dist?: number) {
    (this.renderer.controls as unknown as FollowCam).follow = null;
    this.following = null;
    this.renderer.controls.jumpTo(x, z, dist);
  }

  /** Open the info window for a picked object. */
  openHit(hit: Hit) {
    if (hit.kind === 'station') this.openStation(hit.id);
    else if (hit.kind === 'depot') this.openDepot(hit.id);
    else if (hit.kind === 'edge') this.openEdge(hit.id);
    else if (hit.kind === 'building') { const b = this.game.world.buildings.get(hit.id); if (b) this.openTown(b.townId); }
    else if (hit.kind === 'town') this.openTown(hit.id);
  }

  // ------------------------------------------------------------------ station
  openStation(id: number) {
    const g = this.game;
    const st = g.stations.get(id);
    if (!st) return;
    const win = this.wm.open('station-' + id, st.name, { width: 370 });
    const render = () => {
      const s = g.stations.get(id);
      if (!s) { win.close(); return; }
      win.title.textContent = s.name;
      clear(win.body);
      const town = g.towns.list[s.townId];
      const mine = s.owner === PLAYER;
      const lines = g.lines.linesAt(s.id);
      const parts: string[] = [];
      if (s.rail) parts.push(`${s.rail.tracks} track${s.rail.tracks > 1 ? 's' : ''} × ${Math.round(s.rail.length * 10)} m`);
      if (s.stops.length) parts.push(`${s.stops.length} bus stop${s.stops.length > 1 ? 's' : ''}`);
      win.body.append(
        h('div', { class: 'sub' }, this.ownerTag(s.owner), ` · ${parts.join(' + ') || 'empty'}${town ? ' · ' + town.name : ''}`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Rating'), h('span', { class: 'v grow' }, bar(s.rating), ` ${(s.rating * 100).toFixed(0)}%`)),
        this.kv('Catchment population', fmtInt(s.catchPop)),
        this.kv('Waiting passengers', fmtInt(s.waitingTotal)),
        this.kv('Last month', `${fmtInt(s.genLast)} new · ${fmtInt(s.pickupLast)} boarded · ${fmtInt(s.arrivedLast)} arrived`),
      );
      const byDest = new Map<number, number>();
      for (const wg of s.waiting.values()) byDest.set(wg.dest, (byDest.get(wg.dest) ?? 0) + wg.count);
      const sorted = [...byDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (sorted.length) {
        win.body.append(h('div', { class: 'section' }, 'Waiting by destination'),
          h('div', { class: 'list' }, sorted.map(([d, c]) => h('div', { class: 'row' }, this.stationLink(d), h('span', { class: 'num' }, fmtInt(c))))));
      }
      win.body.append(h('div', { class: 'section' }, 'Lines'));
      if (lines.length) win.body.append(h('div', { class: 'chips' }, lines.map((l) => this.lineChip(l))));
      else win.body.append(h('div', { class: 'muted' }, mine ? 'No lines stop here yet. Open Lines [L] to create one.' : 'No lines.'));
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => this.centerOn(s.x, s.z) }, 'Center view'),
        h('button', { class: 'btn' + (this.catchmentStation === id ? ' on' : ''), onclick: () => { this.setCatchment(this.catchmentStation === id ? -1 : id); render(); } }, 'Catchment'),
        mine ? h('button', { class: 'btn', onclick: () => { const n = prompt('Rename station', s.name); if (n) { s.name = n.slice(0, 40); render(); } } }, 'Rename') : null,
      ));
    };
    win.refresh = render;
    render();
  }

  private setCatchment(id: number) {
    const g = this.game;
    this.catchmentStation = id;
    const st = id >= 0 ? g.stations.get(id) : undefined;
    const u = this.renderer.terrain.uniforms as unknown as { uCircle?: { value: THREE.Vector4 } };
    if (!st) { this.renderer.overlay.setRings(null); if (u.uCircle && this.tools.tool === 'inspect') u.uCircle.value.w = 0; return; }
    const rings = [];
    if (st.rail) rings.push({ x: st.rail.x, z: st.rail.z, r: g.stations.catchmentRadius(st) });
    for (const p of st.stops) rings.push({ x: p.x, z: p.z, r: 14 });
    this.renderer.overlay.setRings(rings, 0x5ac8fa);
    if (u.uCircle && rings[0]) u.uCircle.value.set(rings[0].x, rings[0].z, rings[0].r, 1);
  }

  // ------------------------------------------------------------------ town
  openTown(id: number) {
    const g = this.game;
    const town = g.towns.list[id];
    if (!town) return;
    const win = this.wm.open('town-' + id, town.name, { width: 330 });
    const render = () => {
      clear(win.body);
      const counts = new Map<number, number>();
      for (const bid of town.buildings) { const b = g.world.buildings.get(bid); if (b) counts.set(b.type, (counts.get(b.type) ?? 0) + 1); }
      const pct = town.passGenLast ? Math.min(100, Math.round((town.passTransLast / town.passGenLast) * 100)) : 0;
      const growth = town.served === 0 ? 'Slow (no rail or bus service)' : town.served === 1 ? 'Good (1 active station)' : `Fast (${town.served} active stations)`;
      win.body.append(
        this.kv('Population', fmtInt(town.pop)),
        this.kv('Buildings', fmtInt(town.buildings.size)),
        this.kv('Passengers last month', `${fmtInt(town.passGenLast)} departing · ${fmtInt(town.passTransLast)} arrived`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Transported'), h('span', { class: 'v grow' }, bar(pct / 100), ` ${pct}%`)),
        this.kv('Growth', growth),
        h('div', { class: 'section' }, 'Buildings'),
        h('div', { class: 'list' }, [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => h('div', { class: 'row' }, h('span', null, BUILDING_TYPES[t]?.name ?? '?'), h('span', { class: 'num' }, String(c))))),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => this.centerOn(town.x, town.z) }, 'Center view')),
      );
    };
    win.refresh = render;
    render();
  }

  // ------------------------------------------------------------------ track / road info
  openEdge(id: number) {
    const g = this.game;
    const e = g.world.net.edges.get(id);
    if (!e) return;
    const rail = e.kind === 'rail';
    const win = this.wm.open('edge', rail ? 'Track' : 'Road', { width: 320 });
    const render = () => {
      const ed = g.world.net.edges.get(id);
      if (!ed) { win.close(); return; }
      clear(win.body);
      const tt = rail ? TRACK_TYPES[ed.type] ?? TRACK_TYPES.standard : null;
      const rt = !rail ? ROAD_TYPES[ed.type] ?? ROAD_TYPES.road : null;
      const geo = g.world.net.geo(ed);
      let grade = 0;
      for (let i = 1; i < ed.prof.length; i++) grade = Math.max(grade, Math.abs(ed.prof[i] - ed.prof[i - 1]));
      const speed = rail ? Math.min(tt!.speed, 4.3 * Math.sqrt(geo.minRadius * 10)) : rt!.speed;
      const sec = ed.sections.map((s) => `${s.type} ${Math.round((s.s1 - s.s0) * 10)} m`).join(', ');
      win.body.append(
        h('div', { class: 'sub' }, this.ownerTag(ed.owner), ` · ${(tt ?? rt)!.name}`),
        this.kv('Length', `${Math.round(ed.len * 10)} m`),
        this.kv('Speed limit', `${Math.round(speed)} km/h`),
        this.kv('Min. radius', isFinite(geo.minRadius) && geo.minRadius < 5000 ? `${Math.round(geo.minRadius * 10)} m` : 'straight'),
        this.kv('Max. grade', `${(grade * 100).toFixed(1)}%`),
        sec ? this.kv('Structures', sec) : '',
        ed.station >= 0 ? this.kv('Station', this.stationLink(ed.station)) : '',
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(ed, ed.len / 2, p); this.centerOn(p.x, p.z); } }, 'Center view')),
      );
    };
    win.refresh = render;
    render();
  }

  // ------------------------------------------------------------------ vehicles
  vehicleDesc(v: Vehicle): string {
    if (v instanceof Train) {
      const loco = v.cars.filter((c) => c.kind === 'loco');
      const wn = new Map<string, number>();
      for (const w of v.cars) if (w.kind === 'wagon') wn.set(w.name, (wn.get(w.name) ?? 0) + 1);
      return [loco.length > 1 ? `${loco.length}× ${loco[0].name}` : loco[0]?.name, ...[...wn.entries()].map(([n, c]) => `${c}× ${n}`)].filter(Boolean).join(' + ');
    }
    return (v as RoadVehicle).model?.name ?? 'Car';
  }

  openVehicle(id: number) {
    const g = this.game;
    const v = g.vehicles.get(id);
    if (!v) return;
    const win = this.wm.open('veh-' + id, v.name, { width: 370 });
    const render = () => {
      const v2 = g.vehicles.get(id);
      if (!v2) { win.close(); return; }
      win.title.textContent = v2.name;
      clear(win.body);
      const mine = v2.owner === PLAYER;
      const kind = v2.kind === 'train' ? 'rail' : 'road';
      const lineEl: Node = mine
        ? (() => {
          const sel = h('select', { class: 'select' }, h('option', { value: '' }, '— no line —'),
            g.lines.all().filter((l) => l.kind === kind && l.owner === PLAYER).map((l) => h('option', { value: String(l.id), selected: l.id === v2.lineId }, l.name)));
          sel.addEventListener('change', () => { v2.setLine(sel.value ? Number(sel.value) : null); render(); });
          return sel;
        })()
        : document.createTextNode(v2.line?.name ?? '—');
      const target = v2.targetStation();
      const lenM = v2 instanceof Train ? ` · ${Math.round(v2.length * 10)} m` : '';
      win.body.append(
        h('div', { class: 'sub' }, this.ownerTag(v2.owner), ` · ${this.vehicleDesc(v2)}${lenM}`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Line'), h('span', { class: 'v' }, lineEl)),
        this.kv('Status', v2.status),
        target ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Next stop'), h('span', { class: 'v' }, this.stationLink(target.id))) : '',
        this.kv('Speed', `${v2.speedKmh.toFixed(0)} / ${v2.maxSpeedKmh} km/h${v2 instanceof Train && Math.abs(v2.grade) > 0.004 ? ` · grade ${(v2.grade * 100).toFixed(1)}%` : ''}`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Passengers'), h('span', { class: 'v grow' }, bar(v2.capacity ? v2.load / v2.capacity : 0, '#5ac8fa'), ` ${v2.load} / ${v2.capacity}`)),
        this.kv('Profit this year', h('span', { class: v2.profitYear < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitYear))),
        this.kv('Profit last year', h('span', { class: v2.profitLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitLast))),
        this.kv('Running cost', fmtMoney(v2.runningCost) + '/yr'),
        this.kv('Age · value', `${v2.age.toFixed(1)} yrs · ${fmtMoney(g.vehicles.resaleValue(v2))}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn' + (this.following === id ? ' on' : ''), onclick: () => { if (this.following === id) this.centerOn(...this.posOf(v2)); else this.follow(v2); render(); } }, this.following === id ? 'Stop following' : 'Follow'),
          v2.line ? h('button', { class: 'btn', onclick: () => this.openLine(v2.lineId!) }, 'Line') : null,
          mine && this.upgradeOption(v2) ? h('button', { class: 'btn', title: this.upgradeOption(v2)!.label, onclick: () => this.upgradeVehicle(v2) }, 'Upgrade') : null,
          mine ? h('button', { class: 'btn danger', onclick: () => { if (confirm(`Sell ${v2.name} for ${fmtMoney(g.vehicles.resaleValue(v2))}?`)) { g.vehicles.sell(v2.id); win.close(); } } }, 'Sell') : null,
        ),
      );
    };
    win.refresh = render;
    render();
  }

  private posOf(v: Vehicle): [number, number] { const p = { x: 0, y: 0, z: 0 }; v.worldPos(p); return [p.x, p.z]; }

  /** The newest equivalent vehicle, if better than the current one. */
  private upgradeOption(v: Vehicle): { cars: VehicleModel[]; label: string } | null {
    const year = this.game.year;
    if (v instanceof Train) {
      const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon');
      const loco = locos[locos.length - 1], wagon = wagons[wagons.length - 1];
      const cur = v.cars.find((c) => c.kind === 'loco');
      const curW = v.cars.find((c) => c.kind === 'wagon');
      if (!loco || !cur || (loco.speed <= cur.speed && (!wagon || !curW || wagon.capacity <= curW.capacity))) return null;
      const n = v.cars.filter((c) => c.kind === 'wagon').length;
      const w = wagon ?? curW;
      if (!w) return null;
      return { cars: [loco, ...Array<VehicleModel>(n).fill(w)], label: `${loco.name} + ${n}× ${w.name}` };
    }
    const rv = v as RoadVehicle;
    const buses = availableModels(year, 'bus');
    const best = buses[buses.length - 1];
    if (!rv.model || !best || best.id === rv.model.id || best.intro <= rv.model.intro) return null;
    return { cars: [best], label: best.name };
  }

  private upgradeVehicle(v: Vehicle) {
    const g = this.game;
    const opt = this.upgradeOption(v);
    if (!opt) return;
    const kind = v.kind === 'train' ? 'rail' : 'road';
    const cur = (v as Train | RoadVehicle).depotId;
    const dId = g.depots.get(cur) ? cur : this.findDepot(kind, v.line);
    if (dId == null) { this.toast('No depot available for the replacement', 'bad'); return; }
    const cost = opt.cars.reduce((s, c) => s + c.cost, 0) - g.vehicles.resaleValue(v);
    if (!confirm(`Replace ${v.name} with ${opt.label}? Net cost ${fmtMoney(cost)}.`)) return;
    const lineId = v.lineId;
    g.vehicles.sell(v.id);
    const r = kind === 'rail' ? g.vehicles.buyTrain(dId, opt.cars, lineId) : g.vehicles.buyRoad(dId, opt.cars[0], lineId);
    if (typeof r === 'string') { this.toast(r, 'bad'); return; }
    this.wm.close('veh-' + v.id);
    this.toast(`${r.name} replaces ${v.name}`, 'good');
    this.openVehicle(r.id);
  }

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

  // ------------------------------------------------------------------ depot / purchase
  openDepot(depotId: number) {
    const g = this.game;
    const dp = g.depots.get(depotId);
    if (!dp) return;
    if (dp.owner === PLAYER) { this.openPurchase(dp.kind, depotId, null); return; }
    const win = this.wm.open('depot-' + depotId, dp.kind === 'rail' ? 'Train depot' : 'Bus depot', { width: 320 });
    const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
    win.body.append(
      h('div', { class: 'sub' }, this.ownerTag(dp.owner)),
      this.kv('Vehicles', String(here.length)),
      h('div', { class: 'list' }, here.slice(0, 12).map((v) => h('div', { class: 'row link', onclick: () => this.openVehicle(v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))),
    );
  }

  /** Purchase dialog / train composer. If depotId is null a suitable depot for the line is chosen. */
  openPurchase(kind: 'rail' | 'road', depotId: number | null, lineId: number | null) {
    const g = this.game;
    const year = g.year;
    const win = this.wm.open('buy-' + kind + '-' + (depotId ?? 'line'), kind === 'rail' ? 'Buy train' : 'Buy bus', { width: 440 });
    const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon'), buses = availableModels(year, 'bus');
    const state = { loco: locos[locos.length - 1]?.id ?? '', locoN: 1, wagon: wagons[wagons.length - 1]?.id ?? '', count: 4, bus: buses[buses.length - 1]?.id ?? '', line: lineId };
    const render = () => {
      clear(win.body);
      const modelRow = (m: VehicleModel, selected: boolean, onSel: () => void) =>
        h('div', { class: 'model' + (selected ? ' sel' : ''), onclick: () => { onSel(); render(); } },
          h('div', { class: 'mname' }, m.name, h('span', { class: 'mcost' }, fmtMoney(m.cost))),
          h('div', { class: 'mstats' }, `${m.speed} km/h`, m.capacity ? ` · ${m.capacity} pax` : '', m.power ? ` · ${m.power} kW` : '', ` · ${Math.round(m.length * 10)} m · ${fmtMoney(m.running)}/yr`));
      const step = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) =>
        h('div', { class: 'stepper' }, h('label', null, label),
          h('button', { onclick: () => { set(Math.max(min, get() - 1)); render(); } }, '−'), h('span', { class: 'val' }, String(get())),
          h('button', { onclick: () => { set(Math.min(max, get() + 1)); render(); } }, '+'));
      if (kind === 'rail') {
        win.body.append(h('div', { class: 'section' }, 'Locomotive'));
        for (const m of locos) win.body.append(modelRow(m, state.loco === m.id, () => (state.loco = m.id)));
        win.body.append(h('div', { class: 'section' }, 'Coaches'));
        for (const m of wagons) win.body.append(modelRow(m, state.wagon === m.id, () => (state.wagon = m.id)));
        win.body.append(h('div', { class: 'inline wrap' }, step('Locomotives', () => state.locoN, (v) => (state.locoN = v), 1, 2), step('Coaches', () => state.count, (v) => (state.count = v), 1, 14)));
      } else {
        win.body.append(h('div', { class: 'section' }, 'Model'));
        for (const m of buses) win.body.append(modelRow(m, state.bus === m.id, () => (state.bus = m.id)));
      }
      const loco = MODEL_BY_ID.get(state.loco), wagon = MODEL_BY_ID.get(state.wagon), bus = MODEL_BY_ID.get(state.bus);
      const cars: VehicleModel[] = kind === 'rail'
        ? (loco ? [...Array<VehicleModel>(state.locoN).fill(loco), ...(wagon ? Array<VehicleModel>(state.count).fill(wagon) : [])] : [])
        : bus ? [bus] : [];
      const cost = cars.reduce((s, c) => s + c.cost, 0);
      const cap = cars.reduce((s, c) => s + c.capacity, 0);
      const spd = cars.length ? Math.min(...cars.map((c) => c.speed)) : 0;
      const len = cars.reduce((s, c) => s + c.length + CAR_GAP, 0);
      const lines = g.lines.all().filter((l) => l.kind === kind && l.owner === PLAYER);
      const sel = h('select', { class: 'select' }, h('option', { value: '' }, '— no line —'), lines.map((l) => h('option', { value: String(l.id), selected: l.id === state.line }, `${l.name} (${l.stops.length} stops)`)));
      sel.addEventListener('change', () => { state.line = sel.value ? Number(sel.value) : null; render(); });
      // shortest platform on the selected line
      let warn = '';
      const line = state.line != null ? g.lines.get(state.line) : undefined;
      if (kind === 'rail' && line) {
        let minP = Infinity, minName = '';
        for (const sid of line.stops) { const st = g.stations.get(sid); if (st?.rail && st.rail.length < minP) { minP = st.rail.length; minName = st.name; } }
        if (isFinite(minP) && len > minP) warn = `Train (${Math.round(len * 10)} m) is longer than the platforms at ${minName} (${Math.round(minP * 10)} m)`;
      }
      const power = cars.reduce((s, c) => s + c.power, 0);
      win.body.append(
        h('div', { class: 'summary' }, `${fmtMoney(cost)} · ${cap} passengers · ${spd} km/h`, kind === 'rail' ? ` · ${Math.round(len * 10)} m · ${power} kW` : ''),
        warn ? h('div', { class: 'warn' }, warn) : '',
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Assign to line'), h('span', { class: 'v' }, sel)),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => buy() }, `Buy for ${fmtMoney(cost)}`)),
      );
      if (depotId != null) {
        const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
        if (here.length) {
          win.body.append(h('div', { class: 'section' }, 'Vehicles from this depot'),
            h('div', { class: 'list' }, here.map((v) => h('div', { class: 'row link', onclick: () => this.openVehicle(v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))));
        }
      }
      const buy = () => {
        if (!cars.length) return;
        let dId = depotId;
        if (dId == null) {
          dId = this.findDepot(kind, line);
          if (dId == null) { this.toast(`No ${kind === 'rail' ? 'train' : 'bus'} depot connected to this line. Build one first.`, 'bad'); return; }
        }
        const r = kind === 'rail' ? g.vehicles.buyTrain(dId, cars, state.line) : g.vehicles.buyRoad(dId, cars[0], state.line);
        if (typeof r === 'string') { this.toast(r, 'bad'); return; }
        this.toast(`${r.name} purchased`, 'good');
        this.sound('build');
        if (!state.line) this.toast('Tip: assign the vehicle to a line so it starts working.', 'info');
        render();
      };
    };
    win.refresh = undefined;
    render();
  }

  private findDepot(kind: 'rail' | 'road', line: Line | null | undefined): number | null {
    const g = this.game;
    const depots = g.depots.all().filter((d) => d.kind === kind && d.owner === PLAYER);
    if (!depots.length) return null;
    if (!line || !line.stops.length) return depots[0].id;
    const st = g.stations.get(line.stops[0]);
    if (!st) return depots[0].id;
    depots.sort((a, b) => Math.hypot(a.x - st.x, a.z - st.z) - Math.hypot(b.x - st.x, b.z - st.z));
    for (const d of depots.slice(0, 8)) {
      const ok = kind === 'rail' ? depotReaches(g, d, st.id) : roadDepotReaches(g, d, st.id);
      if (ok) return d.id;
    }
    return null;
  }

  // ------------------------------------------------------------------ lines
  private showAllLines = false;
  openLines() {
    const g = this.game;
    const win = this.wm.open('lines', 'Lines', { width: 490 });
    const render = () => {
      clear(win.body);
      const all = h('input', { type: 'checkbox', checked: this.showAllLines }) as HTMLInputElement;
      all.addEventListener('change', () => { this.showAllLines = all.checked; render(); });
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => this.newLine('rail') }, '+ Rail line'),
        h('button', { class: 'btn primary', onclick: () => this.newLine('road') }, '+ Bus line'),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check' }, all, 'All companies'),
      ));
      const lines = g.lines.all().filter((l) => this.showAllLines || l.owner === PLAYER);
      if (!lines.length) {
        win.body.append(h('div', { class: 'muted pad' }, 'No lines yet. A line is an ordered list of stations that vehicles serve in a loop. Build two stations, create a line, click the stations on the map, then add vehicles.'));
        return;
      }
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Line'), h('th', null, 'Stops'), h('th', null, 'Veh.'), h('th', null, 'Pax/mo'), h('th', null, 'Profit (yr)')));
      for (const l of lines) {
        const profit = l.incomeYear - l.costYear;
        tbl.appendChild(h('tr', { class: 'clickable', onclick: () => this.openLine(l.id) },
          h('td', { class: 'ellip' }, h('span', { class: 'swatch', style: `background:${l.color}` }), l.name, h('span', { class: 'muted' }, l.kind === 'rail' ? ' rail' : ' bus'), l.owner !== PLAYER ? h('span', { class: 'muted' }, ` · ${this.game.company(l.owner).name}`) : ''),
          h('td', null, String(l.stops.length)), h('td', null, String(l.vehicles.length)), h('td', null, fmtInt(l.passLast)),
          h('td', { class: profit < 0 ? 'neg' : 'pos' }, fmtMoney(profit))));
      }
      win.body.appendChild(tbl);
    };
    win.refresh = render;
    render();
  }

  private newLine(kind: 'rail' | 'road') {
    const l = this.game.lines.create(kind, PLAYER);
    this.openLine(l.id);
    this.editLine(l.id);
  }

  editLine(id: number) {
    this.tools.setTool('line-edit');
    this.tools.lineEditId = id;
    this.updateToolbar();
    this.toast('Click stations on the map to add them as stops', 'info');
  }

  addStopToLine(lineId: number, stationId: number) {
    const g = this.game;
    const l = g.lines.get(lineId);
    const st = g.stations.get(stationId);
    if (!l || !st || l.owner !== PLAYER) return;
    if (st.owner !== PLAYER) { this.toast(`${st.name} belongs to ${g.company(st.owner).name}`, 'bad'); return; }
    if (l.kind === 'rail' && !g.stations.hasRail(st)) { this.toast('This station has no train platforms', 'bad'); return; }
    if (l.kind === 'road' && !g.stations.hasRoad(st)) { this.toast('This station has no bus stop', 'bad'); return; }
    if (l.stops[l.stops.length - 1] === stationId) { this.toast('Already the last stop', 'info'); return; }
    l.stops.push(stationId);
    this.sound('click');
    g.lines.rebuild();
    for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
    this.updateToolbar();
    this.wm.get('line-' + lineId)?.refresh?.();
  }

  openLine(id: number) {
    const g = this.game;
    const line = g.lines.get(id);
    if (!line) return;
    const win = this.wm.open('line-' + id, line.name, { width: 410 });
    const render = () => {
      const l = g.lines.get(id);
      if (!l) { win.close(); return; }
      const mine = l.owner === PLAYER;
      win.title.textContent = l.name;
      clear(win.body);
      const changed = () => { g.lines.rebuild(); for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged(); render(); };
      win.body.append(h('div', { class: 'linehead' },
        h('span', { class: 'swatch big', style: `background:${l.color}`, title: mine ? 'Change colour' : '', onclick: () => { if (!mine) return; l.color = LINE_COLORS[(LINE_COLORS.indexOf(l.color) + 1) % LINE_COLORS.length]; render(); } }),
        h('b', null, l.name),
        mine ? h('button', { class: 'btn small', onclick: () => { const n = prompt('Rename line', l.name); if (n) { l.name = n.slice(0, 40); render(); } } }, 'Rename') : this.ownerTag(l.owner),
      ));
      win.body.append(h('div', { class: 'section' }, `Stops (${l.stops.length})`));
      const broken = this.lineBroken.get(id) ?? [];
      const list = h('div', { class: 'list stops' });
      l.stops.forEach((sid, i) => {
        const st = g.stations.get(sid);
        let waiting = 0;
        if (st) for (const wg of st.waiting.values()) if (wg.line === l.id) waiting += wg.count;
        const noRoute = broken.some(([a]) => a === sid);
        list.appendChild(h('div', { class: 'row' },
          h('span', { class: 'stopn', style: `background:${l.color}` }, String(i + 1)),
          this.stationLink(sid),
          noRoute ? h('span', { class: 'neg', title: 'No route to the next stop' }, '⚠ no route') : '',
          h('span', { class: 'muted num' }, `${waiting} waiting`),
          mine ? h('span', { class: 'rowbtns' },
            h('button', { class: 'ibtn', title: 'Move up', onclick: () => { if (i > 0) { [l.stops[i - 1], l.stops[i]] = [l.stops[i], l.stops[i - 1]]; changed(); } } }, '↑'),
            h('button', { class: 'ibtn', title: 'Move down', onclick: () => { if (i < l.stops.length - 1) { [l.stops[i + 1], l.stops[i]] = [l.stops[i], l.stops[i + 1]]; changed(); } } }, '↓'),
            h('button', { class: 'ibtn', title: 'Remove', onclick: () => { l.stops.splice(i, 1); changed(); } }, '✕')) : ''));
      });
      win.body.append(list);
      if (mine) {
        const editing = this.tools.tool === 'line-edit' && this.tools.lineEditId === l.id;
        win.body.append(h('div', { class: 'btns' },
          h('button', { class: 'btn' + (editing ? ' on' : ''), onclick: () => { if (editing) this.tools.setTool('inspect'); else this.editLine(l.id); render(); } }, editing ? 'Done adding stops' : 'Add stops on map'),
        ));
        if (l.stops.length < 2) win.body.append(h('div', { class: 'muted' }, 'A line needs at least two stops.'));
      }
      win.body.append(h('div', { class: 'section' }, `Vehicles (${l.vehicles.length})`));
      const vl = h('div', { class: 'list' });
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        vl.appendChild(h('div', { class: 'row link', onclick: () => this.openVehicle(vid) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status), h('span', { class: 'num' }, `${v.load}/${v.capacity}`)));
      }
      win.body.append(vl);
      if (mine) win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => this.openPurchase(l.kind, null, l.id) }, l.kind === 'rail' ? '+ Add train' : '+ Add bus'),
        l.vehicles.length ? h('button', { class: 'btn', onclick: () => this.cloneLast(l) }, 'Clone last vehicle') : null,
      ));
      win.body.append(
        h('div', { class: 'section' }, 'Statistics'),
        this.kv('Passengers last month', fmtInt(l.passLast)),
        this.kv('Income this year', fmtMoneyFull(l.incomeYear)),
        this.kv('Running costs this year', fmtMoneyFull(l.costYear)),
        this.kv('Profit last year', fmtMoneyFull(l.incomeLast - l.costLast)),
      );
      if (mine) win.body.append(h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete ${l.name}? Its vehicles will stop.`)) { g.lines.delete(l.id); win.close(); } } }, 'Delete line')));
    };
    win.refresh = render;
    win.onClose = () => { if (this.tools.tool === 'line-edit' && this.tools.lineEditId === id) this.tools.setTool('inspect'); };
    render();
  }

  private cloneLast(l: Line) {
    const g = this.game;
    const v = g.vehicles.get(l.vehicles[l.vehicles.length - 1]);
    if (!v) return;
    const dId = (v as Train | RoadVehicle).depotId;
    const dp = g.depots.get(dId)?.owner === PLAYER ? dId : this.findDepot(l.kind, l);
    if (dp == null) { this.toast('No depot available', 'bad'); return; }
    const r = v instanceof Train ? g.vehicles.buyTrain(dp, v.reversed ? [...v.cars].reverse() : [...v.cars], l.id) : g.vehicles.buyRoad(dp, (v as RoadVehicle).model!, l.id);
    if (typeof r === 'string') this.toast(r, 'bad'); else { this.toast(`${r.name} purchased`, 'good'); this.sound('build'); }
  }

  // ------------------------------------------------------------------ lists
  private showAllVehicles = false;
  openVehicles() {
    const g = this.game;
    const win = this.wm.open('vehicles', 'Vehicles', { width: 540 });
    const render = () => {
      clear(win.body);
      const all = h('input', { type: 'checkbox', checked: this.showAllVehicles }) as HTMLInputElement;
      all.addEventListener('change', () => { this.showAllVehicles = all.checked; render(); });
      win.body.append(h('div', { class: 'btns' }, h('label', { class: 'check' }, all, 'All companies')));
      const vs = g.vehicles.all().filter((v) => this.showAllVehicles || v.owner === PLAYER).sort((a, b) => b.profitYear - a.profitYear);
      if (!vs.length) { win.body.append(h('div', { class: 'muted pad' }, 'No vehicles yet. Build a depot, open it, and buy a train or bus.')); return; }
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Vehicle'), h('th', null, 'Line'), h('th', null, 'Status'), h('th', null, 'Load'), h('th', null, 'Profit (yr)')));
      for (const v of vs.slice(0, 300)) {
        tbl.appendChild(h('tr', { class: 'clickable', onclick: () => this.openVehicle(v.id) },
          h('td', { class: 'ellip' }, v.owner !== PLAYER ? h('span', { class: 'swatch', style: `background:${g.company(v.owner).color}` }) : '', v.name),
          h('td', { class: 'ellip' }, v.line ? h('span', null, h('span', { class: 'swatch', style: `background:${v.line.color}` }), v.line.name) : '—'),
          h('td', { class: 'ellip ' + (v.state === 'noroute' || v.state === 'stopped' ? 'neg' : 'muted') }, v.status), h('td', null, `${v.load}/${v.capacity}`),
          h('td', { class: v.profitYear < 0 ? 'neg' : 'pos' }, fmtMoney(v.profitYear))));
      }
      win.body.append(tbl);
    };
    win.refresh = render;
    render();
  }

  openTowns() {
    const g = this.game;
    const win = this.wm.open('towns', 'Towns', { width: 380 });
    const render = () => {
      clear(win.body);
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Town'), h('th', null, 'Population'), h('th', null, 'Transported')));
      for (const t of [...g.towns.list].sort((a, b) => b.pop - a.pop)) {
        const pct = t.passGenLast ? Math.min(100, Math.round((t.passTransLast / t.passGenLast) * 100)) : 0;
        tbl.appendChild(h('tr', { class: 'clickable', onclick: () => { this.centerOn(t.x, t.z); this.openTown(t.id); } },
          h('td', null, t.name), h('td', null, fmtInt(t.pop)), h('td', null, `${pct}%`)));
      }
      win.body.append(tbl, h('div', { class: 'muted' }, `Total population: ${fmtInt(g.towns.list.reduce((s, t) => s + t.pop, 0))}`));
    };
    win.refresh = render;
    render();
  }

  // ------------------------------------------------------------------ finances & competitors
  private vehicleValue(owner: number) {
    const g = this.game;
    let s = 0;
    for (const v of g.vehicles.map.values()) if (v.owner === owner) s += g.vehicles.resaleValue(v);
    return s;
  }

  openFinances() {
    const g = this.game;
    const win = this.wm.open('finances', 'Finances', { width: 560 });
    const render = () => {
      const e = g.economy;
      clear(win.body);
      win.body.append(
        h('div', { class: 'fin-top' },
          h('div', null, h('div', { class: 'k' }, 'Cash'), h('div', { class: 'big ' + (e.money < 0 ? 'neg' : '') }, fmtMoneyFull(e.money))),
          h('div', null, h('div', { class: 'k' }, 'Loan'), h('div', { class: 'big' }, fmtMoneyFull(e.loan))),
          h('div', null, h('div', { class: 'k' }, 'Net worth'), h('div', { class: 'big' }, fmtMoneyFull(e.netWorth + this.vehicleValue(PLAYER)))),
          h('div', null, h('div', { class: 'k' }, 'Maintenance / yr'), h('div', { class: 'big' }, fmtMoney(g.maintenanceOf(PLAYER))))),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => { if (!e.borrow()) this.toast('Maximum loan reached', 'bad'); render(); } }, `Borrow ${fmtMoney(e.loanStep)}`),
          h('button', { class: 'btn', onclick: () => { if (!e.repay()) this.toast('Cannot repay', 'bad'); render(); } }, `Repay ${fmtMoney(e.loanStep)}`),
          h('span', { class: 'muted' }, `Max loan ${fmtMoney(e.maxLoan)} · ${(e.interestRate * 100).toFixed(1)}% interest`)),
      );
      const months = e.months.slice(-3);
      const cols: { label: string; v: Record<string, number> }[] = [
        ...months.map((m) => ({ label: `${MONTH_NAMES[m.month]} ${m.year}`, v: m.v as Record<string, number> })),
        { label: 'This month', v: e.current },
        { label: `${g.year}`, v: e.thisYear },
      ];
      const ly = e.yearTotals[e.yearTotals.length - 1];
      if (ly) cols.push({ label: String(ly.year), v: ly.v });
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, ''), cols.map((c) => h('th', null, c.label))));
      for (const cat of CATEGORIES) tbl.appendChild(h('tr', null, h('td', null, CATEGORY_LABEL[cat]), cols.map((c) => h('td', { class: c.v[cat] < 0 ? 'neg' : c.v[cat] > 0 ? 'pos' : 'muted' }, c.v[cat] ? fmtMoney(c.v[cat]) : '–'))));
      tbl.appendChild(h('tr', { class: 'total' }, h('td', null, 'Profit'), cols.map((c) => { const s = CATEGORIES.reduce((a, k) => a + c.v[k], 0); return h('td', { class: s < 0 ? 'neg' : 'pos' }, fmtMoney(s)); })));
      win.body.append(tbl);
      const cv = h('canvas', { class: 'chart', width: 520, height: 140 });
      win.body.append(h('div', { class: 'section' }, 'Monthly profit'), cv);
      const ctx = cv.getContext('2d')!;
      const data = e.months.slice(-24).map((m) => CATEGORIES.reduce((a, k) => a + m.v[k], 0));
      const inc = e.months.slice(-24).map((m) => m.v.income);
      const max = Math.max(1, ...data.map(Math.abs), ...inc);
      const W = cv.width, H = cv.height, mid = H * 0.6;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
      const bw = W / 24;
      data.forEach((v, i) => {
        const hgt = (v / max) * (mid - 6);
        ctx.fillStyle = v >= 0 ? '#4cd964' : '#ff5e3a';
        ctx.fillRect(i * bw + 3, v >= 0 ? mid - hgt : mid, bw - 6, Math.abs(hgt) * (v >= 0 ? 1 : 0.6));
      });
      ctx.strokeStyle = '#5ac8fa'; ctx.lineWidth = 2; ctx.beginPath();
      inc.forEach((v, i) => { const y = mid - (v / max) * (mid - 6); if (i) ctx.lineTo(i * bw + bw / 2, y); else ctx.moveTo(i * bw + bw / 2, y); });
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '11px sans-serif';
      ctx.fillText('bars: profit · line: income', 6, H - 6);
    };
    win.refresh = render;
    render();
  }

  openCompetitors() {
    const g = this.game;
    const win = this.wm.open('competitors', 'Companies', { width: 600 });
    const render = () => {
      clear(win.body);
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, 'Company'), h('th', null, 'Cash'), h('th', null, 'Net worth'), h('th', null, 'Vehicles'), h('th', null, 'Stations'), h('th', null, 'Lines'), h('th', null, 'Profit (yr)')));
      for (const co of g.companies) {
        const e = co.economy;
        const vehicles = g.vehicles.ofOwner(co.id).length;
        const stations = g.stations.all().filter((s) => s.owner === co.id).length;
        const lines = g.lines.all().filter((l) => l.owner === co.id).length;
        const ly = e.yearTotals[e.yearTotals.length - 1];
        const profit = CATEGORIES.reduce((a, k) => a + (ly ? ly.v[k] : e.thisYear[k]), 0);
        tbl.appendChild(h('tr', null,
          h('td', { class: 'ellip' }, h('span', { class: 'swatch', style: `background:${co.color}` }), co.name, co.id === PLAYER ? h('span', { class: 'muted' }, ' (you)') : ''),
          h('td', { class: e.money < 0 ? 'neg' : '' }, fmtMoney(e.money)),
          h('td', null, fmtMoney(e.netWorth + this.vehicleValue(co.id))),
          h('td', null, String(vehicles)), h('td', null, String(stations)), h('td', null, String(lines)),
          h('td', { class: profit < 0 ? 'neg' : 'pos' }, fmtMoney(profit))));
      }
      const ai = h('input', { type: 'checkbox', checked: g.aiEnabled }) as HTMLInputElement;
      ai.addEventListener('change', () => { g.aiEnabled = ai.checked; });
      const nAI = g.companies.filter((c) => c.ai).length;
      win.body.append(tbl,
        h('div', { class: 'btns' },
          h('label', { class: 'check' }, ai, 'AI construction enabled'),
          h('span', { class: 'spacer' }),
          nAI < 3 ? h('button', { class: 'btn', onclick: () => { const co = g.addAICompany(); this.toast(`${co.name} enters the market`, 'info'); render(); } }, '+ Add AI company') : null),
        h('div', { class: 'muted' }, 'Profit shows the last full year (or this year so far). AI vehicles keep running when construction is disabled.'));
    };
    win.refresh = render;
    render();
  }

  // ------------------------------------------------------------------ menus
  openMenu() {
    const win = this.wm.open('menu', 'Menu', { width: 260, x: window.innerWidth - 300, y: 60 });
    const item = (label: string, fn: () => void) => h('button', { class: 'menu-item', onclick: () => { fn(); } }, label);
    win.body.append(
      item('New game…', () => { win.close(); this.openNewGame(); }),
      item('Save game…', () => { win.close(); this.openSaveLoad('save'); }),
      item('Load game…', () => { win.close(); this.openSaveLoad('load'); }),
      item('Export save to file', () => this.exportSave()),
      item('Import save from file…', () => this.importSave()),
      item('Companies…', () => { win.close(); this.openCompetitors(); }),
      item('Settings…', () => { win.close(); this.openSettings(); }),
      item('Help & controls', () => { win.close(); this.openHelp(); }),
    );
  }

  openNewGame(first = false) {
    const win = this.wm.open('newgame', first ? 'Welcome to Railfever' : 'New game', { width: 420, x: window.innerWidth / 2 - 210, y: Math.max(40, window.innerHeight / 2 - 280) });
    const sel = (opts: [string, string][], val: string) => h('select', { class: 'select' }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
    const size = sel([['256', 'Small (2.6 km)'], ['384', 'Medium (3.8 km)'], ['512', 'Large (5.1 km)'], ['768', 'Huge (7.7 km)']], '384');
    const towns = h('input', { type: 'range', min: '3', max: '40', value: '10', class: 'range' }) as HTMLInputElement;
    const townsVal = h('span', { class: 'val' }, '10');
    towns.addEventListener('input', () => (townsVal.textContent = towns.value));
    size.addEventListener('change', () => { const s = Number(size.value); towns.value = String(Math.max(3, Math.round(10 * (s / 384) ** 2))); townsVal.textContent = towns.value; });
    const hills = sel([['flat', 'Flat'], ['hilly', 'Hilly'], ['mountainous', 'Mountainous']], 'hilly');
    const water = sel([['low', 'Little'], ['medium', 'Some'], ['high', 'Lots']], 'medium');
    const year = sel([['1900', '1900 – steam age'], ['1930', '1930'], ['1950', '1950 – diesel age'], ['1980', '1980 – intercity'], ['2005', '2005 – high speed']], '1950');
    const ai = sel([['0', 'None'], ['1', '1 competitor'], ['2', '2 competitors'], ['3', '3 competitors']], '1');
    const seed = h('input', { type: 'number', value: String(Math.floor(Math.random() * 99999)), class: 'input' }) as HTMLInputElement;
    if (first) win.body.append(h('p', { class: 'intro' }, 'Build railways and bus lines between growing towns — curved tracks, bridges, tunnels and parallel lines, against AI rivals if you like. Passengers pay by distance and speed; good service makes towns grow. Everything runs locally in your browser.'));
    win.body.append(
      h('div', { class: 'form' },
        h('label', null, 'Map size'), size,
        h('label', null, 'Towns'), h('div', { class: 'inline' }, towns, townsVal),
        h('label', null, 'Terrain'), hills,
        h('label', null, 'Water'), water,
        h('label', null, 'Start year'), year,
        h('label', null, 'AI companies'), ai,
        h('label', null, 'Seed'), h('div', { class: 'inline' }, seed, h('button', { class: 'btn small', onclick: () => (seed.value = String(Math.floor(Math.random() * 99999))) }, '🎲'))),
      h('div', { class: 'btns right' },
        first ? null : h('button', { class: 'btn', onclick: () => win.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          win.close();
          const sz = Number(size.value);
          const nt = Math.min(Number(towns.value), Math.round((sz * sz) / 3000));
          this.app.newGame({ size: sz, towns: nt, hilliness: hills.value as NewGameOptions['hilliness'], water: water.value as NewGameOptions['water'], startYear: Number(year.value), seed: Number(seed.value) || 1, aiCompanies: Number(ai.value) });
        } }, 'Start game')),
    );
  }

  openSaveLoad(mode: 'save' | 'load') {
    const win = this.wm.open('saveload', mode === 'save' ? 'Save game' : 'Load game', { width: 420 });
    const render = () => {
      clear(win.body);
      const slots = listSlots();
      if (mode === 'save') {
        const name = h('input', { class: 'input', value: `${this.game.player.name} – ${this.game.dateString()}` }) as HTMLInputElement;
        win.body.append(h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
          try { await saveToSlot(this.game, 'slot' + Date.now(), name.value); this.toast('Game saved', 'good'); render(); } catch (e) { this.toast('Save failed: ' + (e as Error).message, 'bad'); }
        } }, 'Save new')));
      }
      if (!slots.length) win.body.append(h('div', { class: 'muted pad' }, 'No saved games.'));
      for (const s of slots) {
        win.body.append(h('div', { class: 'slot' },
          h('div', null, h('b', null, s.name), h('div', { class: 'muted' }, `${s.date} · ${fmtMoney(s.money)} · saved ${new Date(s.saved).toLocaleString()}`)),
          h('div', { class: 'rowbtns' },
            mode === 'save'
              ? h('button', { class: 'btn small', onclick: async () => { if (confirm('Overwrite this save?')) { try { await saveToSlot(this.game, s.slot, s.name); this.toast('Game saved', 'good'); } catch (e) { this.toast('Save failed: ' + (e as Error).message, 'bad'); } render(); } } }, 'Overwrite')
              : h('button', { class: 'btn small primary', onclick: async () => {
                try { const g = await loadFromSlot(s.slot); win.close(); this.app.setGame(g); this.toast('Game loaded', 'good'); } catch (e) { this.toast('Load failed: ' + (e as Error).message, 'bad'); }
              } }, 'Load'),
            h('button', { class: 'btn small danger', onclick: () => { if (confirm('Delete this save?')) { deleteSlot(s.slot); render(); } } }, '✕'))));
      }
    };
    render();
  }

  private async exportSave() {
    try {
      const blob = await exportToFile(this.game);
      const a = h('a', { href: URL.createObjectURL(blob), download: `railfever-${this.game.year}.rfsave` });
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) { this.toast('Export failed: ' + (e as Error).message, 'bad'); }
  }

  private importSave() {
    const inp = h('input', { type: 'file', accept: '.rfsave,.txt,.json' }) as HTMLInputElement;
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { const g = await importFromText(await f.text()); this.wm.closeAll(); this.app.setGame(g); this.toast('Game imported', 'good'); }
      catch (e) { this.toast('Import failed: ' + (e as Error).message, 'bad'); }
    });
    inp.click();
  }

  openSettings() {
    const r = this.renderer;
    const s = r.settings as unknown as Record<string, unknown>;
    const win = this.wm.open('settings', 'Settings', { width: 340 });
    const chk = (label: string, get: () => boolean, set: (v: boolean) => void, apply = true) => {
      const c = h('input', { type: 'checkbox', checked: get() }) as HTMLInputElement;
      c.addEventListener('change', () => { set(c.checked); if (apply) r.applySettings(); });
      return h('label', { class: 'check' }, c, label);
    };
    const opt = (key: string, label: string) => (key in s ? chk(label, () => !!s[key], (v) => (s[key] = v)) : null);
    const items: (HTMLElement | null)[] = [opt('shadows', 'Shadows')];
    if ('shadowQuality' in s) {
      const quality = h('select', { class: 'select' }, h('option', { value: 'high', selected: s.shadowQuality === 'high' }, 'High'), h('option', { value: 'low', selected: s.shadowQuality === 'low' }, 'Low'));
      quality.addEventListener('change', () => { s.shadowQuality = quality.value; r.applySettings(); });
      items.push(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Shadow quality'), h('span', { class: 'v' }, quality)));
    }
    if ('pixelRatio' in s) {
      const scale = h('select', { class: 'select' }, [0.5, 0.75, 1, 1.5, 2].map((v) => h('option', { value: String(v), selected: Math.abs(Number(s.pixelRatio) - v) < 0.01 }, `${v * 100}%`)));
      scale.addEventListener('change', () => { s.pixelRatio = Number(scale.value); r.applySettings(); });
      items.push(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Render resolution'), h('span', { class: 'v' }, scale)));
    }
    items.push(opt('ao', 'Ambient occlusion'), opt('clouds', 'Cloud shadows'), opt('dayNight', 'Day / night cycle'), opt('labels', 'Town & station labels'));
    const g = this.game;
    items.push(
      chk('Ambient town traffic', () => g.vehicles.ambientEnabled, (v) => { g.vehicles.ambientEnabled = v; g.vehicles.manageAmbient(); }, false),
      chk('AI companies build', () => g.aiEnabled, (v) => (g.aiEnabled = v), false),
      chk('Sound effects', () => this.soundOn, (v) => (this.soundOn = v), false),
      chk('Construction grid [G]', () => ((r.terrain.uniforms as unknown as { uGrid?: { value: number } }).uGrid?.value ?? 0) > 0, (v) => { const u = (r.terrain.uniforms as unknown as { uGrid?: { value: number } }).uGrid; if (u) u.value = v ? 1 : 0; }, false),
    );
    win.body.append(...items.filter((x): x is HTMLElement => !!x));
  }

  openHelp() {
    const win = this.wm.open('help', 'How to play', { width: 500 });
    win.body.innerHTML = `
      <div class="help">
      <h4>Camera</h4>
      <p><b>Right-drag</b> pan · <b>Middle-drag</b> or <b>Alt + drag</b> rotate &amp; tilt · <b>Wheel</b> zoom · <b>WASD / arrows</b> move · <b>Q/E</b> rotate · <b>R/F</b> tilt · <b>M</b> minimap</p>
      <h4>Building track and roads</h4>
      <ol>
        <li>Choose <b>Build track</b> [2] or <b>Build road</b> [6]. Click to set the start (on open ground, a track end, or onto a track to branch off).</li>
        <li>Move the mouse: a live preview shows the curve, bridges (blue), tunnels (purple) and crossings. The tooltip shows cost, length, grade, curve radius and speed limit. Red means it can't be built.</li>
        <li>Click to build. Construction continues from the new end with a smooth curve; <b>right-click</b> or <b>Esc</b> ends the chain. You can also drag to build one section.</li>
        <li>Options: standard or high-speed track, <b>1–4 parallel tracks</b>, road type, <b>height</b> ([ ] or PgUp/PgDn, ±5 m steps — raised ends give bridges, lowered ends cuttings and tunnels) and how to cross other lines (auto, overpass, underpass, level).</li>
      </ol>
      <h4>Getting started</h4>
      <ol>
        <li>Place a <b>train station</b> [3] near two towns (R / Shift+R or Ctrl+wheel rotate; it lines up with nearby track ends). The blue circle is its catchment.</li>
        <li>Connect the station track ends with track. Add a <b>train depot</b> [5] at a free track end.</li>
        <li>Open <b>Lines</b> [L] → <i>+ Rail line</i>, click both stations on the map, then <i>+ Add train</i>. Check the train length against the platforms.</li>
        <li>Buses: <b>bus stops</b> [7] on roads, a <b>bus depot</b> [8] next to a road, and a bus line.</li>
      </ol>
      <h4>Tips</h4>
      <ul>
        <li>Several trains on one line need <b>signals</b> [4]. On double track use one-way signals every few hundred metres; on single track build passing loops.</li>
        <li>Fast, frequent service raises station ratings; well-served towns grow faster.</li>
        <li>AI companies build their own networks (see <b>Companies</b> [C]); you can inspect but not change their property.</li>
      </ul>
      <h4>Keys</h4>
      <p>1 query · 2 track · 3 station · 4 signal · 5 train depot · 6 road · 7 bus stop · 8 bus depot · 9 demolish · 0 terraform · L lines · V vehicles · T towns · C companies · Space pause · G grid · Esc cancel/close</p>
      </div>`;
  }

  openNews() {
    const g = this.game;
    const win = this.wm.open('news', 'News', { width: 440 });
    const render = () => {
      clear(win.body);
      for (const n of [...g.news].reverse()) {
        const row = h('div', { class: 'news-row ' + n.kind }, h('span', { class: 'news-date' }, this.newsDate(n)), n.text);
        if (n.x !== undefined) { row.classList.add('link'); row.addEventListener('click', () => this.centerOn(n.x!, n.z!)); }
        win.body.append(row);
      }
    };
    render();
  }
}
