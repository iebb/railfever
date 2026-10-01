// Main user interface: HUD, toolbar and windows.
import * as THREE from 'three';
import type { Game, NewGameOptions, News } from '../game/game';
import type { Renderer } from '../render/renderer';
import { WindowManager } from './windows';
import { Tools, ToolId, TOOL_INFO } from './tools';
import { h, clear, fmtInt, bar, icon } from './dom';
import { fmtMoney, fmtMoneyFull, CATEGORIES, CATEGORY_LABEL } from '../game/economy';
import { MONTH_NAMES } from '../game/game';
import { availableModels, VehicleModel, MODEL_BY_ID } from '../game/vehicle-types';
import { Train, depotReaches } from '../game/train';
import { RoadVehicle, roadDepotReaches } from '../game/roadvehicle';
import { LINE_COLORS, Line } from '../game/lines';
import { BUILDING_TYPES } from '../game/towns';
import { saveToSlot, loadFromSlot, listSlots, deleteSlot, exportToFile, importFromText } from '../game/save';
import type { Vehicle } from '../game/vehicle';
import { HSTEP } from '../game/constants';
import { Minimap } from './minimap';
import { computeLinePath } from './linepaths';

export interface AppHooks {
  newGame(opts: NewGameOptions): void;
  setGame(g: Game): void;
}

interface FloatText { el: HTMLDivElement; x: number; y: number; z: number; t: number; client?: { x: number; y: number } }

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
    if (!this.tools) this.tools = new Tools(this);
    this.tools.onToolChange = () => this.updateToolbar();
    this.renderer.controls.singleTouchPan = () => this.tools.tool === 'inspect';
    this.tools.setTool('inspect');
    g.listeners.news.push((n) => this.onNews(n));
    g.listeners.income.push((amt, _v, st) => this.incomeAcc.set(st.id, (this.incomeAcc.get(st.id) ?? 0) + amt));
    this.renderer.labels.onClickTown = (id) => this.openTown(id);
    this.renderer.labels.onClickStation = (id) => {
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
      h('button', { class: 'tbtn', title: 'News', onclick: () => this.openNews() }, icon('news', 18)),
      h('button', { class: 'tbtn', title: 'Help (F1)', onclick: () => this.openHelp() }, icon('help', 18)),
      h('button', { class: 'tbtn', title: 'Menu', onclick: () => this.openMenu() }, icon('menu', 18)),
    );
    R.appendChild(top);

    const groups: { tools: [ToolId | string, string, string][] }[] = [
      { tools: [['inspect', 'inspect', '1']] },
      { tools: [['rail', 'rail', '2'], ['station', 'station', '3'], ['signal', 'signal', '4'], ['depot-rail', 'depot', '5']] },
      { tools: [['road', 'road', '6'], ['busstop', 'bus', '7'], ['depot-road', 'garage', '8']] },
      { tools: [['bulldoze', 'bulldoze', '9'], ['terraform', 'terraform', '0']] },
      { tools: [['#lines', 'lines', 'L'], ['#vehicles', 'vehicles', 'V'], ['#towns', 'towns', 'T'], ['#finances', 'money', 'F']] },
    ];
    const tb = h('div', { class: 'toolbar' });
    for (const grp of groups) {
      const gEl = h('div', { class: 'tgroup' });
      for (const [id, ic, key] of grp.tools) {
        const isTool = !id.startsWith('#');
        const name = isTool ? TOOL_INFO[id as ToolId].name : id.slice(1)[0].toUpperCase() + id.slice(2);
        const b = h('button', { class: 'tool', title: `${name} [${key}]` }, icon(ic, 24), h('span', { class: 'key' }, key));
        b.addEventListener('click', () => {
          if (isTool) this.tools.setTool(this.tools.tool === id ? 'inspect' : (id as ToolId));
          else if (id === '#lines') this.openLines();
          else if (id === '#vehicles') this.openVehicles();
          else if (id === '#towns') this.openTowns();
          else if (id === '#finances') this.openFinances();
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

  private updateToolbar() {
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', this.tools.tool === id);
    const t = this.tools.tool;
    const o = this.optionsEl;
    clear(o);
    if (t === 'inspect') { o.style.display = 'none'; return; }
    o.style.display = 'block';
    o.appendChild(h('div', { class: 'opt-title' }, TOOL_INFO[t].name));
    o.appendChild(h('div', { class: 'opt-hint' }, TOOL_INFO[t].hint));
    const row = h('div', { class: 'opt-row' });
    const stepper = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) => {
      const val = h('span', { class: 'val' }, String(get()));
      const upd = (d: number) => { set(Math.max(min, Math.min(max, get() + d))); val.textContent = String(get()); this.tools.refreshHover(); };
      return h('div', { class: 'stepper' }, h('label', null, label), h('button', { onclick: () => upd(-1) }, '−'), val, h('button', { onclick: () => upd(1) }, '+'));
    };
    if (t === 'station') {
      row.appendChild(stepper('Length', () => this.tools.stationLen, (v) => (this.tools.stationLen = v), 1, 10));
      row.appendChild(stepper('Platforms', () => this.tools.stationTracks, (v) => (this.tools.stationTracks = v), 1, 6));
      row.appendChild(h('button', { class: 'btn', onclick: () => this.tools.rotate() }, 'Rotate [R]'));
    } else if (t === 'depot-rail' || t === 'depot-road') {
      row.appendChild(h('button', { class: 'btn', onclick: () => this.tools.rotate() }, 'Rotate [R]'));
    } else if (t === 'terraform') {
      for (const m of ['raise', 'lower', 'level'] as const) {
        const b = h('button', { class: 'btn' + (this.tools.terraMode === m ? ' on' : ''), onclick: () => { this.tools.terraMode = m; this.updateToolbar(); } }, m[0].toUpperCase() + m.slice(1));
        row.appendChild(b);
      }
    } else if (t === 'line-edit') {
      const line = this.tools.lineEditId != null ? this.game.lines.get(this.tools.lineEditId) : null;
      row.appendChild(h('span', { class: 'swatch', style: `background:${line?.color}` }));
      row.appendChild(h('b', null, line?.name ?? ''));
      row.appendChild(h('span', null, ` · ${line?.stops.length ?? 0} stops`));
      row.appendChild(h('button', { class: 'btn primary', onclick: () => this.tools.setTool('inspect') }, 'Done'));
    }
    if (row.childNodes.length) o.appendChild(row);
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
    if (!this.game) return;
    const k = e.key;
    const map: Record<string, ToolId> = { '1': 'inspect', '2': 'rail', '3': 'station', '4': 'signal', '5': 'depot-rail', '6': 'road', '7': 'busstop', '8': 'depot-road', '9': 'bulldoze', '0': 'terraform' };
    if (map[k]) { this.tools.setTool(this.tools.tool === map[k] && k !== '1' ? 'inspect' : map[k]); return; }
    if (k === 'Escape') { if (!this.tools.cancel()) this.wm.closeTop(); return; }
    if (k === ' ') { e.preventDefault(); this.setSpeed(0); return; }
    if (k === 'r' || k === 'R') { if (['station', 'depot-rail', 'depot-road'].includes(this.tools.tool)) { this.tools.rotate(); this.renderer.controls.keys.delete('r'); } return; }
    if (k === 'l' || k === 'L') this.openLines();
    else if (k === 'v' || k === 'V') this.openVehicles();
    else if (k === 't' || k === 'T') this.openTowns();
    else if (k === 'F1') { e.preventDefault(); this.openHelp(); }
    else if (k === 'g' || k === 'G') { const u = this.renderer.terrain.uniforms.uGrid; u.value = u.value ? 0 : 1; }
  };

  // ------------------------------------------------------------------ per-frame
  update(dt: number) {
    const g = this.game;
    this.moneyEl.textContent = fmtMoneyFull(g.economy.money);
    this.moneyEl.classList.toggle('neg', g.economy.money < 0);
    this.dateEl.textContent = g.dateString();
    this.fpsEl.textContent = this.renderer.fps.toFixed(0) + ' fps';
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) { this.refreshTimer = 0.5; this.wm.refreshAll(); }
    // income floaters
    this.incomeTimer -= dt;
    if (this.incomeTimer <= 0) {
      this.incomeTimer = 0.6;
      for (const [sid, amt] of this.incomeAcc) {
        const st = g.stations.get(sid);
        if (!st || amt < 1) continue;
        this.addFloat(`+${fmtMoney(amt)}`, 'income', st.x + 0.5, g.world.heightAt(st.x + 0.5, st.z + 0.5) + 0.6, st.z + 0.5);
      }
      const now = performance.now();
      if (this.incomeAcc.size && now - this.lastCash > 2500) { this.lastCash = now; this.sound('cash'); }
      this.incomeAcc.clear();
    }
    this.updateFloats(dt);
    this.minimap.update(dt);
    // highlight the stops of open line windows and draw their routes
    const hl = this.renderer.labels.highlight;
    hl.clear();
    const openLines = new Set<number>();
    for (const win of this.wm.wins.values()) if (win.id.startsWith('line-')) openLines.add(Number(win.id.slice(5)));
    for (const id of this.renderer.overlay.linePathIds()) if (!openLines.has(id)) { this.renderer.overlay.setLinePath(id, null); this.linePathSig.delete(id); }
    for (const id of openLines) {
      const l = g.lines.get(id);
      if (!l) continue;
      const sig = l.stops.join(',') + '|' + g.networkVersion + '|' + l.color;
      if (this.linePathSig.get(id) === sig) continue;
      this.linePathSig.set(id, sig);
      this.renderer.overlay.setLinePath(id, computeLinePath(g, l), l.color, l.kind === 'rail' ? 0.16 : 0.08);
    }
    for (const win of this.wm.wins.values()) {
      if (!win.id.startsWith('line-')) continue;
      const l = g.lines.get(Number(win.id.slice(5)));
      if (!l) continue;
      l.stops.forEach((sid, i) => {
        const prev = hl.get(sid);
        hl.set(sid, { color: l.color, text: (prev ? prev.text + ',' : '') + (i + 1) });
      });
    }
    if (this.catchmentStation >= 0) {
      const st = g.stations.get(this.catchmentStation);
      if (!st || !this.wm.get('station-' + this.catchmentStation)) { this.catchmentStation = -1; this.renderer.overlay.hideArea(); }
    }
  }

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

  private onNews(n: News) {
    const el = h('div', { class: 'news-item ' + n.kind }, h('span', { class: 'news-date' }, `${MONTH_NAMES[Math.floor(n.day / 30) % 12]} ${this.game.options.startYear + Math.floor(n.day / 360)}`), n.text);
    if (n.x !== undefined) { el.style.cursor = 'pointer'; el.addEventListener('click', () => this.renderer.controls.jumpTo(n.x! + 0.5, n.z! + 0.5)); }
    this.toastBox.appendChild(el);
    setTimeout(() => el.classList.add('out'), 6500);
    setTimeout(() => el.remove(), 7200);
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
  private kv(k: string, v: Node | string): HTMLElement { return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
  private lineChip(l: Line): HTMLElement {
    return h('span', { class: 'chip', style: `--c:${l.color}`, onclick: () => this.openLine(l.id) }, l.name);
  }
  private stationLink(id: number): HTMLElement {
    const st = this.game.stations.get(id);
    return h('a', { class: 'link', onclick: () => this.openStation(id) }, st ? st.name : '?');
  }
  private centerOn(x: number, z: number) { this.renderer.controls.jumpTo(x + 0.5, z + 0.5); }

  // ------------------------------------------------------------------ station
  openStation(id: number) {
    const g = this.game;
    const st = g.stations.get(id);
    if (!st) return;
    const win = this.wm.open('station-' + id, st.name, { width: 360 });
    const render = () => {
      const s = g.stations.get(id);
      if (!s) { win.close(); return; }
      win.title.textContent = s.name;
      clear(win.body);
      const town = g.towns.list[s.townId];
      const lines = g.lines.linesAt(s.id);
      const kinds = [g.stations.hasRail(s) ? 'Train station' : '', g.stations.hasRoad(s) ? 'Bus stop' : ''].filter(Boolean).join(' + ');
      win.body.append(
        h('div', { class: 'sub' }, `${kinds}${town ? ' · ' + town.name : ''}`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Rating'), h('span', { class: 'v grow' }, bar(s.rating), ` ${(s.rating * 100).toFixed(0)}%`)),
        this.kv('Catchment population', fmtInt(s.catchPop)),
        this.kv('Waiting passengers', fmtInt(s.waitingTotal)),
        this.kv('Last month', `${fmtInt(s.genLast)} new · ${fmtInt(s.pickupLast)} boarded · ${fmtInt(s.arrivedLast)} arrived`),
      );
      // waiting by destination
      const byDest = new Map<number, number>();
      for (const wg of s.waiting.values()) byDest.set(wg.dest, (byDest.get(wg.dest) ?? 0) + wg.count);
      const sorted = [...byDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (sorted.length) {
        const tbl = h('div', { class: 'list' });
        for (const [d, c] of sorted) tbl.appendChild(h('div', { class: 'row' }, this.stationLink(d), h('span', { class: 'num' }, fmtInt(c))));
        win.body.append(h('div', { class: 'section' }, 'Waiting by destination'), tbl);
      }
      win.body.append(h('div', { class: 'section' }, 'Lines'));
      if (lines.length) win.body.append(h('div', { class: 'chips' }, lines.map((l) => this.lineChip(l))));
      else win.body.append(h('div', { class: 'muted' }, 'No lines stop here yet. Open Lines [L] to create one.'));
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => this.centerOn(s.x, s.z) }, 'Center view'),
        h('button', { class: 'btn' + (this.catchmentStation === id ? ' on' : ''), onclick: () => { this.toggleCatchment(id); render(); } }, 'Catchment'),
        h('button', { class: 'btn', onclick: () => { const n = prompt('Rename station', s.name); if (n) { s.name = n.slice(0, 40); render(); } } }, 'Rename'),
      ));
    };
    win.refresh = render;
    render();
  }

  private toggleCatchment(id: number) {
    const g = this.game;
    if (this.catchmentStation === id) { this.catchmentStation = -1; this.renderer.overlay.hideArea(); return; }
    const st = g.stations.get(id);
    if (!st) return;
    this.catchmentStation = id;
    const tiles: [number, number][] = [];
    for (const t of g.stations.catchmentTiles(st)) tiles.push([g.world.tx(t), g.world.tz(t)]);
    this.renderer.overlay.setArea(tiles, 0x55bbff, 0.22);
  }

  // ------------------------------------------------------------------ town
  openTown(id: number) {
    const g = this.game;
    const town = g.towns.list[id];
    if (!town) return;
    const win = this.wm.open('town-' + id, town.name, { width: 320 });
    const render = () => {
      clear(win.body);
      const counts = new Map<number, number>();
      for (const bid of town.buildings) { const b = g.world.buildings[bid]; if (b) counts.set(b.type, (counts.get(b.type) ?? 0) + 1); }
      const pct = town.passGenLast ? Math.min(100, Math.round((town.passTransLast / town.passGenLast) * 100)) : 0;
      const growth = town.served === 0 ? 'Slow (no rail or bus service)' : town.served === 1 ? 'Good (1 active station)' : `Fast (${town.served} active stations)`;
      win.body.append(
        this.kv('Population', fmtInt(town.pop)),
        this.kv('Buildings', fmtInt(town.buildings.size)),
        this.kv('Passengers last month', `${fmtInt(town.passGenLast)} departing · ${fmtInt(town.passTransLast)} arrived`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Transported'), h('span', { class: 'v grow' }, bar(pct / 100), ` ${pct}%`)),
        this.kv('Growth', growth),
        h('div', { class: 'section' }, 'Buildings'),
        h('div', { class: 'list' }, [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => h('div', { class: 'row' }, h('span', null, BUILDING_TYPES[t].name), h('span', { class: 'num' }, String(c))))),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => this.centerOn(town.x, town.z) }, 'Center view')),
      );
    };
    win.refresh = render;
    render();
  }

  // ------------------------------------------------------------------ vehicles
  private vehicleDesc(v: Vehicle): string {
    if (v instanceof Train) {
      const loco = v.cars.find((c) => c.kind === 'loco');
      const wag = v.cars.filter((c) => c.kind === 'wagon');
      const wn = new Map<string, number>();
      for (const w of wag) wn.set(w.name, (wn.get(w.name) ?? 0) + 1);
      return [loco?.name, ...[...wn.entries()].map(([n, c]) => `${c}× ${n}`)].filter(Boolean).join(' + ');
    }
    return (v as RoadVehicle).model?.name ?? 'Car';
  }

  openVehicle(id: number) {
    const g = this.game;
    const v = g.vehicles.get(id);
    if (!v) return;
    const win = this.wm.open('veh-' + id, v.name, { width: 360 });
    let lastSig = '';
    const render = () => {
      const v2 = g.vehicles.get(id);
      if (!v2) { win.close(); return; }
      const sig = v2.lineId + '|' + g.lines.map.size;
      const rebuildSelect = sig !== lastSig;
      lastSig = sig;
      win.title.textContent = v2.name;
      clear(win.body);
      const kind = v2.kind === 'train' ? 'rail' : 'road';
      const sel = h('select', { class: 'select' }, h('option', { value: '' }, '— no line —'),
        g.lines.all().filter((l) => l.kind === kind).map((l) => h('option', { value: String(l.id), selected: l.id === v2.lineId }, l.name)));
      sel.addEventListener('change', () => { v2.setLine(sel.value ? Number(sel.value) : null); render(); });
      void rebuildSelect;
      const target = v2.targetStation();
      win.body.append(
        h('div', { class: 'sub' }, this.vehicleDesc(v2)),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Line'), h('span', { class: 'v' }, sel)),
        this.kv('Status', v2.status),
        target ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Next stop'), h('span', { class: 'v' }, this.stationLink(target.id))) : '',
        this.kv('Speed', `${v2.speedKmh.toFixed(0)} / ${v2.maxSpeedKmh} km/h`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Passengers'), h('span', { class: 'v grow' }, bar(v2.capacity ? v2.load / v2.capacity : 0, '#5ac8fa'), ` ${v2.load} / ${v2.capacity}`)),
        this.kv('Profit this year', h('span', { class: v2.profitYear < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitYear))),
        this.kv('Profit last year', h('span', { class: v2.profitLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitLast))),
        this.kv('Running cost', fmtMoney(v2.runningCost) + '/yr'),
        this.kv('Age · value', `${v2.age.toFixed(1)} yrs · ${fmtMoney(g.vehicles.resaleValue(v2))}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => this.follow(v2) }, 'Follow'),
          this.upgradeOption(v2) ? h('button', { class: 'btn', title: this.upgradeOption(v2)!.label, onclick: () => this.upgradeVehicle(v2) }, 'Upgrade') : null,
          v2.line ? h('button', { class: 'btn', onclick: () => this.openLine(v2.lineId!) }, 'Line') : null,
          h('button', { class: 'btn danger', onclick: () => { if (confirm(`Sell ${v2.name} for ${fmtMoney(g.vehicles.resaleValue(v2))}?`)) { g.vehicles.sell(v2.id); win.close(); } } }, 'Sell'),
        ),
      );
    };
    win.refresh = render;
    render();
  }

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
      const cars = [loco, ...Array(n).fill(wagon ?? curW)];
      return { cars, label: `${loco.name} + ${n}× ${(wagon ?? curW)!.name}` };
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
    const dId = g.world.depots.get((v as any).depotId) ? (v as any).depotId as number : this.findDepot(kind, v.line);
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
    const p = new THREE.Vector3();
    const c = this.renderer.controls;
    c.follow = () => {
      if (!this.game.vehicles.get(v.id)) return null;
      const o = { x: 0, y: 0, z: 0 };
      v.worldPos(o);
      return p.set(o.x, o.y, o.z);
    };
    if (c.distance > 25) c.distance = 14;
  }

  // ------------------------------------------------------------------ depot / purchase
  openDepot(depotId: number) {
    const g = this.game;
    const dp = g.world.depots.get(depotId);
    if (!dp) return;
    this.openPurchase(dp.kind, depotId, null);
  }

  /** Purchase dialog. If depotId is null a suitable depot for the line is chosen automatically. */
  openPurchase(kind: 'rail' | 'road', depotId: number | null, lineId: number | null) {
    const g = this.game;
    const year = g.year;
    const win = this.wm.open('buy-' + kind + '-' + (depotId ?? 'line'), kind === 'rail' ? 'Buy train' : 'Buy bus', { width: 430 });
    const state = { loco: '', wagon: '', count: 4, bus: '', line: lineId };
    const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon'), buses = availableModels(year, 'bus');
    state.loco = locos[locos.length - 1]?.id ?? '';
    state.wagon = wagons[wagons.length - 1]?.id ?? '';
    state.bus = buses[buses.length - 1]?.id ?? '';
    const render = () => {
      clear(win.body);
      const modelRow = (m: VehicleModel, selected: boolean, onSel: () => void) =>
        h('div', { class: 'model' + (selected ? ' sel' : ''), onclick: () => { onSel(); render(); } },
          h('div', { class: 'mname' }, m.name, h('span', { class: 'mcost' }, fmtMoney(m.cost))),
          h('div', { class: 'mstats' }, `${m.speed} km/h`, m.capacity ? ` · ${m.capacity} pax` : '', m.power ? ` · ${m.power} kW` : '', ` · ${fmtMoney(m.running)}/yr`));
      if (kind === 'rail') {
        win.body.append(h('div', { class: 'section' }, 'Locomotive'));
        for (const m of locos) win.body.append(modelRow(m, state.loco === m.id, () => (state.loco = m.id)));
        win.body.append(h('div', { class: 'section' }, 'Coaches'));
        for (const m of wagons) win.body.append(modelRow(m, state.wagon === m.id, () => (state.wagon = m.id)));
        const cnt = h('span', { class: 'val' }, String(state.count));
        win.body.append(h('div', { class: 'stepper' }, h('label', null, 'Number of coaches'),
          h('button', { onclick: () => { state.count = Math.max(1, state.count - 1); render(); } }, '−'), cnt,
          h('button', { onclick: () => { state.count = Math.min(12, state.count + 1); render(); } }, '+')));
      } else {
        win.body.append(h('div', { class: 'section' }, 'Model'));
        for (const m of buses) win.body.append(modelRow(m, state.bus === m.id, () => (state.bus = m.id)));
      }
      const cars: VehicleModel[] = kind === 'rail'
        ? [MODEL_BY_ID.get(state.loco)!, ...Array(state.count).fill(MODEL_BY_ID.get(state.wagon)!)].filter(Boolean)
        : [MODEL_BY_ID.get(state.bus)!].filter(Boolean);
      const cost = cars.reduce((s, c) => s + c.cost, 0);
      const cap = cars.reduce((s, c) => s + c.capacity, 0);
      const spd = Math.min(...cars.map((c) => c.speed));
      const lines = g.lines.all().filter((l) => l.kind === kind);
      const sel = h('select', { class: 'select' }, h('option', { value: '' }, '— no line —'), lines.map((l) => h('option', { value: String(l.id), selected: l.id === state.line }, `${l.name} (${l.stops.length} stops)`)));
      sel.addEventListener('change', () => { state.line = sel.value ? Number(sel.value) : null; });
      win.body.append(
        h('div', { class: 'summary' }, `Total: ${fmtMoney(cost)} · ${cap} passengers · ${spd} km/h`),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Assign to line'), h('span', { class: 'v' }, sel)),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => buy() }, `Buy for ${fmtMoney(cost)}`)),
      );
      if (depotId != null) {
        const here = g.vehicles.all().filter((v) => (v as any).depotId === depotId);
        if (here.length) {
          win.body.append(h('div', { class: 'section' }, 'Vehicles from this depot'));
          win.body.append(h('div', { class: 'list' }, here.map((v) => h('div', { class: 'row link', onclick: () => this.openVehicle(v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))));
        }
      }
      const buy = () => {
        let dId = depotId;
        if (dId == null) {
          const line = state.line != null ? g.lines.get(state.line) : null;
          dId = this.findDepot(kind, line);
          if (dId == null) { this.toast(`No ${kind === 'rail' ? 'train' : 'bus'} depot connected to this line. Build one first.`, 'bad'); return; }
        }
        const r = kind === 'rail' ? g.vehicles.buyTrain(dId, cars, state.line) : g.vehicles.buyRoad(dId, cars[0], state.line);
        if (typeof r === 'string') { this.toast(r, 'bad'); return; }
        this.toast(`${r.name} purchased`, 'good');
        this.sound('build');
        if (!state.line) this.toast('Tip: assign the vehicle to a line so it starts working.', 'info');
      };
    };
    win.refresh = undefined;
    render();
  }

  private findDepot(kind: 'rail' | 'road', line: Line | null | undefined): number | null {
    const g = this.game;
    const depots = [...g.world.depots.values()].filter((d) => d.kind === kind);
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
  openLines() {
    const g = this.game;
    const win = this.wm.open('lines', 'Lines', { width: 470 });
    const render = () => {
      clear(win.body);
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => this.newLine('rail') }, '+ Rail line'),
        h('button', { class: 'btn primary', onclick: () => this.newLine('road') }, '+ Bus line'),
      ));
      const lines = g.lines.all();
      if (!lines.length) {
        win.body.append(h('div', { class: 'muted pad' }, 'No lines yet. A line is an ordered list of stations that vehicles serve in a loop. Build two stations, create a line, click the stations on the map, then add vehicles.'));
        return;
      }
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Line'), h('th', null, 'Stops'), h('th', null, 'Veh.'), h('th', null, 'Pax/mo'), h('th', null, 'Profit (yr)')));
      for (const l of lines) {
        const profit = l.incomeYear - l.costYear;
        tbl.appendChild(h('tr', { class: 'clickable', onclick: () => this.openLine(l.id) },
          h('td', null, h('span', { class: 'swatch', style: `background:${l.color}` }), l.name, h('span', { class: 'muted' }, l.kind === 'rail' ? ' rail' : ' bus')),
          h('td', null, String(l.stops.length)), h('td', null, String(l.vehicles.length)), h('td', null, fmtInt(l.passLast)),
          h('td', { class: profit < 0 ? 'neg' : 'pos' }, fmtMoney(profit))));
      }
      win.body.appendChild(tbl);
    };
    win.refresh = render;
    render();
  }

  private newLine(kind: 'rail' | 'road') {
    const l = this.game.lines.create(kind);
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
    if (!l || !st) return;
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
    const win = this.wm.open('line-' + id, line.name, { width: 400 });
    const render = () => {
      const l = g.lines.get(id);
      if (!l) { win.close(); return; }
      win.title.textContent = l.name;
      clear(win.body);
      const changed = () => { g.lines.rebuild(); for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged(); render(); };
      win.body.append(h('div', { class: 'linehead' },
        h('span', { class: 'swatch big', style: `background:${l.color}`, title: 'Change colour', onclick: () => { l.color = LINE_COLORS[(LINE_COLORS.indexOf(l.color) + 1) % LINE_COLORS.length]; render(); } }),
        h('b', null, l.name),
        h('button', { class: 'btn small', onclick: () => { const n = prompt('Rename line', l.name); if (n) { l.name = n.slice(0, 40); render(); } } }, 'Rename'),
      ));
      win.body.append(h('div', { class: 'section' }, `Stops (${l.stops.length})`));
      const list = h('div', { class: 'list stops' });
      l.stops.forEach((sid, i) => {
        const st = g.stations.get(sid);
        let waiting = 0;
        if (st) for (const wg of st.waiting.values()) if (wg.line === l.id) waiting += wg.count;
        list.appendChild(h('div', { class: 'row' },
          h('span', { class: 'stopn', style: `background:${l.color}` }, String(i + 1)),
          this.stationLink(sid),
          h('span', { class: 'muted num' }, `${waiting} waiting`),
          h('span', { class: 'rowbtns' },
            h('button', { class: 'ibtn', title: 'Move up', onclick: () => { if (i > 0) { [l.stops[i - 1], l.stops[i]] = [l.stops[i], l.stops[i - 1]]; changed(); } } }, '↑'),
            h('button', { class: 'ibtn', title: 'Move down', onclick: () => { if (i < l.stops.length - 1) { [l.stops[i + 1], l.stops[i]] = [l.stops[i], l.stops[i + 1]]; changed(); } } }, '↓'),
            h('button', { class: 'ibtn', title: 'Remove', onclick: () => { l.stops.splice(i, 1); changed(); } }, '✕'))));
      });
      win.body.append(list);
      const editing = this.tools.tool === 'line-edit' && this.tools.lineEditId === l.id;
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn' + (editing ? ' on' : ''), onclick: () => { if (editing) this.tools.setTool('inspect'); else this.editLine(l.id); render(); } }, editing ? 'Done adding stops' : 'Add stops on map'),
      ));
      if (l.stops.length < 2) win.body.append(h('div', { class: 'muted' }, 'A line needs at least two stops.'));
      win.body.append(h('div', { class: 'section' }, `Vehicles (${l.vehicles.length})`));
      const vl = h('div', { class: 'list' });
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        vl.appendChild(h('div', { class: 'row link', onclick: () => this.openVehicle(vid) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status), h('span', { class: 'num' }, `${v.load}/${v.capacity}`)));
      }
      win.body.append(vl);
      win.body.append(h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => this.openPurchase(l.kind, null, l.id) }, l.kind === 'rail' ? '+ Add train' : '+ Add bus'),
        l.vehicles.length ? h('button', { class: 'btn', onclick: () => this.cloneLast(l) }, 'Clone last vehicle') : null,
      ));
      win.body.append(
        h('div', { class: 'section' }, 'Statistics'),
        this.kv('Passengers last month', fmtInt(l.passLast)),
        this.kv('Income this year', fmtMoneyFull(l.incomeYear)),
        this.kv('Running costs this year', fmtMoneyFull(l.costYear)),
        this.kv('Profit last year', fmtMoneyFull(l.incomeLast - l.costLast)),
        h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete ${l.name}? Its vehicles will stop.`)) { g.lines.delete(l.id); win.close(); } } }, 'Delete line')),
      );
    };
    win.refresh = render;
    win.onClose = () => { if (this.tools.tool === 'line-edit' && this.tools.lineEditId === id) this.tools.setTool('inspect'); };
    render();
  }

  private cloneLast(l: Line) {
    const g = this.game;
    const v = g.vehicles.get(l.vehicles[l.vehicles.length - 1]);
    if (!v) return;
    const dId = (v as any).depotId as number;
    const dp = g.world.depots.get(dId) ? dId : this.findDepot(l.kind, l);
    if (dp == null) { this.toast('No depot available', 'bad'); return; }
    const r = v instanceof Train ? g.vehicles.buyTrain(dp, [...(v.reversed ? [...v.cars].reverse() : v.cars)], l.id) : g.vehicles.buyRoad(dp, (v as RoadVehicle).model!, l.id);
    if (typeof r === 'string') this.toast(r, 'bad'); else { this.toast(`${r.name} purchased`, 'good'); this.sound('build'); }
  }

  // ------------------------------------------------------------------ lists
  openVehicles() {
    const g = this.game;
    const win = this.wm.open('vehicles', 'Vehicles', { width: 520 });
    const render = () => {
      clear(win.body);
      const vs = g.vehicles.all().sort((a, b) => b.profitYear - a.profitYear);
      if (!vs.length) { win.body.append(h('div', { class: 'muted pad' }, 'No vehicles yet. Build a depot, open it, and buy a train or bus.')); return; }
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Vehicle'), h('th', null, 'Line'), h('th', null, 'Status'), h('th', null, 'Load'), h('th', null, 'Profit (yr)')));
      for (const v of vs) {
        tbl.appendChild(h('tr', { class: 'clickable', onclick: () => this.openVehicle(v.id) },
          h('td', null, v.name), h('td', null, v.line ? h('span', null, h('span', { class: 'swatch', style: `background:${v.line.color}` }), v.line.name) : '—'),
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

  // ------------------------------------------------------------------ finances
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
          h('div', null, h('div', { class: 'k' }, 'Net worth'), h('div', { class: 'big' }, fmtMoneyFull(e.netWorth + g.vehicles.all().reduce((s, v) => s + g.vehicles.resaleValue(v), 0))))),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => { if (!e.borrow()) this.toast('Maximum loan reached', 'bad'); render(); } }, `Borrow ${fmtMoney(e.loanStep)}`),
          h('button', { class: 'btn', onclick: () => { if (!e.repay()) this.toast('Cannot repay', 'bad'); render(); } }, `Repay ${fmtMoney(e.loanStep)}`),
          h('span', { class: 'muted' }, `Max loan ${fmtMoney(e.maxLoan)} · ${(e.interestRate * 100).toFixed(1)}% interest`)),
      );
      const months = e.months.slice(-3);
      const cols: { label: string; v: Record<string, number> }[] = [
        ...months.map((m) => ({ label: `${MONTH_NAMES[m.month]} ${m.year}`, v: m.v })),
        { label: 'This month', v: e.current },
        { label: `${g.year}`, v: e.thisYear },
      ];
      const ly = e.yearTotals[e.yearTotals.length - 1];
      if (ly) cols.push({ label: String(ly.year), v: ly.v });
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, ''), cols.map((c) => h('th', null, c.label))));
      for (const cat of CATEGORIES) tbl.appendChild(h('tr', null, h('td', null, CATEGORY_LABEL[cat]), cols.map((c) => h('td', { class: c.v[cat] < 0 ? 'neg' : c.v[cat] > 0 ? 'pos' : 'muted' }, c.v[cat] ? fmtMoney(c.v[cat]) : '–'))));
      tbl.appendChild(h('tr', { class: 'total' }, h('td', null, 'Profit'), cols.map((c) => { const s = CATEGORIES.reduce((a, k) => a + c.v[k], 0); return h('td', { class: s < 0 ? 'neg' : 'pos' }, fmtMoney(s)); })));
      win.body.append(tbl);
      // chart of monthly profit
      const cv = h('canvas', { class: 'chart', width: 520, height: 140 });
      win.body.append(h('div', { class: 'section' }, 'Monthly profit'), cv);
      const ctx = cv.getContext('2d')!;
      const data = [...e.months.slice(-24).map((m) => CATEGORIES.reduce((a, k) => a + m.v[k], 0))];
      const inc = [...e.months.slice(-24).map((m) => m.v.income)];
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
      item('Settings…', () => { win.close(); this.openSettings(); }),
      item('Help & controls', () => { win.close(); this.openHelp(); }),
    );
  }

  openNewGame(first = false) {
    const win = this.wm.open('newgame', first ? 'Welcome to Railfever' : 'New game', { width: 400, x: window.innerWidth / 2 - 200, y: Math.max(40, window.innerHeight / 2 - 260) });
    const sel = (opts: [string, string][], val: string) => h('select', { class: 'select' }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
    const size = sel([['64', 'Tiny (64×64)'], ['128', 'Small (128×128)'], ['192', 'Medium (192×192)'], ['256', 'Large (256×256)']], '128');
    const towns = h('input', { type: 'range', min: '3', max: '40', value: '12', class: 'range' }) as HTMLInputElement;
    const townsVal = h('span', { class: 'val' }, '12');
    towns.addEventListener('input', () => (townsVal.textContent = towns.value));
    const hills = sel([['flat', 'Flat'], ['hilly', 'Hilly'], ['mountainous', 'Mountainous']], 'hilly');
    const water = sel([['low', 'Little'], ['medium', 'Some'], ['high', 'Lots']], 'medium');
    const year = sel([['1900', '1900 – steam age'], ['1930', '1930'], ['1950', '1950 – diesel age'], ['1980', '1980 – intercity'], ['2005', '2005 – high speed']], '1950');
    const seed = h('input', { type: 'number', value: String(Math.floor(Math.random() * 99999)), class: 'input' }) as HTMLInputElement;
    if (first) win.body.append(h('p', { class: 'intro' }, 'Build railways and bus lines to connect growing towns. Passengers pay by distance and speed; good service makes towns grow. Everything runs locally in your browser – no internet needed.'));
    win.body.append(
      h('div', { class: 'form' },
        h('label', null, 'Map size'), size,
        h('label', null, 'Towns'), h('div', { class: 'inline' }, towns, townsVal),
        h('label', null, 'Terrain'), hills,
        h('label', null, 'Water'), water,
        h('label', null, 'Start year'), year,
        h('label', null, 'Seed'), h('div', { class: 'inline' }, seed, h('button', { class: 'btn small', onclick: () => (seed.value = String(Math.floor(Math.random() * 99999))) }, '🎲'))),
      h('div', { class: 'btns right' },
        first ? null : h('button', { class: 'btn', onclick: () => win.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          win.close();
          const sz = Number(size.value);
          const nt = Math.min(Number(towns.value), Math.round((sz * sz) / 400));
          this.app.newGame({ size: sz, towns: nt, hilliness: hills.value as any, water: water.value as any, startYear: Number(year.value), seed: Number(seed.value) || 1 });
        } }, 'Start game')),
    );
  }

  openSaveLoad(mode: 'save' | 'load') {
    const win = this.wm.open('saveload', mode === 'save' ? 'Save game' : 'Load game', { width: 400 });
    const render = () => {
      clear(win.body);
      const slots = listSlots();
      if (mode === 'save') {
        const name = h('input', { class: 'input', value: `${this.game.towns.list[0]?.name ?? 'Company'} Transport – ${this.game.dateString()}` }) as HTMLInputElement;
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
              ? h('button', { class: 'btn small', onclick: async () => { if (confirm('Overwrite this save?')) { await saveToSlot(this.game, s.slot, s.name); this.toast('Game saved', 'good'); render(); } } }, 'Overwrite')
              : h('button', { class: 'btn small primary', onclick: async () => {
                try { const g = await loadFromSlot(s.slot); win.close(); this.app.setGame(g); this.toast('Game loaded', 'good'); } catch (e) { this.toast('Load failed: ' + (e as Error).message, 'bad'); }
              } }, 'Load'),
            h('button', { class: 'btn small danger', onclick: () => { if (confirm('Delete this save?')) { deleteSlot(s.slot); render(); } } }, '✕'))));
      }
    };
    render();
  }

  private async exportSave() {
    const blob = await exportToFile(this.game);
    const a = h('a', { href: URL.createObjectURL(blob), download: `railfever-${this.game.year}.rfsave` });
    document.body.appendChild(a);
    a.click();
    a.remove();
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
    const s = r.settings;
    const win = this.wm.open('settings', 'Settings', { width: 340 });
    const chk = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const c = h('input', { type: 'checkbox', checked: get() }) as HTMLInputElement;
      c.addEventListener('change', () => { set(c.checked); r.applySettings(); });
      return h('label', { class: 'check' }, c, label);
    };
    const quality = h('select', { class: 'select' }, h('option', { value: 'high', selected: s.shadowQuality === 'high' }, 'High (4096)'), h('option', { value: 'low', selected: s.shadowQuality === 'low' }, 'Low (2048)'));
    quality.addEventListener('change', () => { s.shadowQuality = quality.value as any; r.applySettings(); });
    const scale = h('select', { class: 'select' }, [0.5, 0.75, 1, 1.5, 2].map((v) => h('option', { value: String(v), selected: Math.abs(s.pixelRatio - v) < 0.01 }, `${v * 100}%`)));
    scale.addEventListener('change', () => { s.pixelRatio = Number(scale.value); r.applySettings(); });
    win.body.append(
      chk('Shadows', () => s.shadows, (v) => (s.shadows = v)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Shadow quality'), h('span', { class: 'v' }, quality)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Render resolution'), h('span', { class: 'v' }, scale)),
      chk('Ambient occlusion', () => s.ao, (v) => (s.ao = v)),
      chk('Cloud shadows', () => s.clouds, (v) => (s.clouds = v)),
      chk('Day / night cycle', () => s.dayNight, (v) => (s.dayNight = v)),
      chk('Town & station labels', () => s.labels, (v) => (s.labels = v)),
      chk('Ambient town traffic', () => this.game.vehicles.ambientEnabled, (v) => { this.game.vehicles.ambientEnabled = v; this.game.vehicles.manageAmbient(); }),
      chk('Sound effects', () => this.soundOn, (v) => (this.soundOn = v)),
      chk('Show build grid [G]', () => r.terrain.uniforms.uGrid.value > 0, (v) => (r.terrain.uniforms.uGrid.value = v ? 1 : 0)),
    );
  }

  openHelp() {
    const win = this.wm.open('help', 'How to play', { width: 480 });
    win.body.innerHTML = `
      <div class="help">
      <h4>Camera</h4>
      <p><b>Right-drag</b> pan · <b>Middle-drag</b> or <b>Shift/Alt + drag</b> rotate &amp; tilt · <b>Wheel</b> zoom · <b>WASD / arrows</b> move · <b>Q/E</b> rotate · <b>R/F</b> tilt</p>
      <h4>Getting started</h4>
      <ol>
        <li>Pick two towns. Build a <b>train station</b> [3] near each (rotate with R).</li>
        <li>Connect them with <b>rail</b> [2]: drag from a platform end to the other station. Slopes, bridges and tunnels are planned automatically – the preview shows the cost.</li>
        <li>Place a <b>train depot</b> [5] next to the end of a track (or drag track from the depot).</li>
        <li>Open <b>Lines</b> [L] → <i>+ Rail line</i>, click both stations on the map, then <i>+ Add train</i>.</li>
        <li>Buses work the same way: <b>bus stops</b> [7] on straight roads, a <b>bus depot</b> [8] next to a road, and a bus line.</li>
      </ol>
      <h4>Tips</h4>
      <ul>
        <li>Stations only collect passengers from buildings in their catchment area (highlighted when placing).</li>
        <li>Bus stops built next to a train station join it – passengers transfer between lines automatically.</li>
        <li>Several trains on one track need <b>signals</b> [4]: a train only proceeds when its path to the next signal or station is free. Give termini two connected platforms.</li>
        <li>On single track, build passing loops and put <b>one-way</b> signals on the loop tracks (one per direction). Don't put signals on the shared single-track sections – trains waiting there block oncoming trains.</li>
        <li>On double track, use one-way signals every few tiles so trains can follow each other closely.</li>
        <li>Fast, frequent service raises station ratings, which produces more passengers and makes towns grow.</li>
        <li>Income depends on distance and travel speed. Keep an eye on running costs in <b>Finances</b>.</li>
      </ul>
      <h4>Keys</h4>
      <p>1 inspect · 2 rail · 3 station · 4 signal · 5 train depot · 6 road · 7 bus stop · 8 bus depot · 9 demolish · 0 terraform · Space pause · G grid · Esc cancel/close</p>
      </div>`;
  }

  openNews() {
    const g = this.game;
    const win = this.wm.open('news', 'News', { width: 420 });
    const render = () => {
      clear(win.body);
      for (const n of [...g.news].reverse()) {
        const row = h('div', { class: 'news-row ' + n.kind }, h('span', { class: 'news-date' }, `${MONTH_NAMES[Math.floor(n.day / 30) % 12]} ${g.options.startYear + Math.floor(n.day / 360)}`), n.text);
        if (n.x !== undefined) { row.classList.add('link'); row.addEventListener('click', () => this.renderer.controls.jumpTo(n.x! + 0.5, n.z! + 0.5)); }
        win.body.append(row);
      }
    };
    render();
  }
}

void HSTEP;
