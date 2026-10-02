// Heads-up display: company plate, clock & speed, actions, news drawer, and the tool dock
// (categories → tray of tools → contextual options card).
import type { UI } from './ui';
import type { Game, News } from '../game/game';
import type { ToolId } from './tools';
import { TOOL_INFO } from './tools';
import { h, icon, clear, seg, stepper, kbd, toggle, add } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { TRACK_TYPES, ROAD_TYPES } from '../game/constants';
import { fmtDate, fmtHeight, newsDate } from './format';
import { audio } from '../audio/engine';

interface Cat { id: string; label: string; icon: string; color: string; tip: string; keys: string; tools?: ToolId[]; actions?: [string, string, string, string][] }

/** Tool categories of the dock. */
const CATS: Cat[] = [
  { id: 'inspect', label: 'Inspect', icon: 'inspect', color: '#eef2f7', tip: 'Inspect', keys: '1', tools: ['inspect'] },
  { id: 'rail', label: 'Rail', icon: 'rail', color: 'var(--rail)', tip: 'Rail: track, signals, depot', keys: '2 4 5', tools: ['rail', 'signal', 'depot-rail'] },
  { id: 'road', label: 'Road', icon: 'road', color: 'var(--road)', tip: 'Road: roads, bus depot', keys: '6 8', tools: ['road', 'depot-road'] },
  { id: 'stations', label: 'Stations', icon: 'station', color: 'var(--station)', tip: 'Stations: train, bus', keys: '3 7', tools: ['station', 'busstop'] },
  { id: 'lines', label: 'Lines', icon: 'lines', color: 'var(--accent)', tip: 'Lines, vehicles & towns', keys: 'L V T', actions: [['lines', 'Lines', 'lines', 'L'], ['vehicles', 'Vehicles', 'vehicles', 'V'], ['towns', 'Towns', 'towns', 'T']] },
  { id: 'terrain', label: 'Terrain', icon: 'terraform', color: 'var(--terrain)', tip: 'Terrain: raise, lower, level', keys: '0', tools: ['terraform'] },
  { id: 'demolish', label: 'Demolish', icon: 'bulldoze', color: 'var(--demolish)', tip: 'Demolish', keys: '9', tools: ['bulldoze'] },
];

export const TOOL_META: Record<ToolId, { icon: string; key: string; cat: string; color: string }> = {
  inspect: { icon: 'inspect', key: '1', cat: 'inspect', color: '#eef2f7' },
  rail: { icon: 'rail', key: '2', cat: 'rail', color: 'var(--rail)' },
  station: { icon: 'station', key: '3', cat: 'stations', color: 'var(--station)' },
  signal: { icon: 'signal', key: '4', cat: 'rail', color: 'var(--rail)' },
  'depot-rail': { icon: 'depot', key: '5', cat: 'rail', color: 'var(--rail)' },
  road: { icon: 'road', key: '6', cat: 'road', color: 'var(--road)' },
  busstop: { icon: 'busstop', key: '7', cat: 'stations', color: 'var(--station)' },
  'depot-road': { icon: 'garage', key: '8', cat: 'road', color: 'var(--road)' },
  bulldoze: { icon: 'bulldoze', key: '9', cat: 'demolish', color: 'var(--demolish)' },
  terraform: { icon: 'terraform', key: '0', cat: 'terrain', color: 'var(--terrain)' },
  'line-edit': { icon: 'lines', key: '', cat: 'lines', color: 'var(--accent)' },
};

/** One-line descriptions for the compact tool card (the long help sits behind '?'). */
const TOOL_SHORT: Partial<Record<ToolId, string>> = {
  rail: 'Click to start, click to build — continues from the new end.',
  road: 'Click to start, click to build — continues from the new end.',
  station: 'Click to place — lines up with nearby track ends.',
  busstop: 'Click on a road to place a stop.',
  'depot-rail': 'Click near a free track end to attach the depot.',
  'depot-road': 'Click next to a road — the depot connects itself.',
  signal: 'Click a track to add a signal, a signal to cycle it.',
  bulldoze: 'Click to remove, drag to clear an area.',
  terraform: 'Hold the button to reshape the ground.',
  'line-edit': 'Click stations to add them as stops.',
};

const TOOL_LABEL: Partial<Record<ToolId, string>> = { rail: 'Track', signal: 'Signals', 'depot-rail': 'Train depot', road: 'Road', 'depot-road': 'Bus depot', station: 'Train station', busstop: 'Bus stop' };

/** Key hints per tool: [keys, action]. */
const KEYS: Partial<Record<ToolId, [string[], string][]>> = {
  rail: [[['Click'], 'start / build'], [['Esc'], 'end chain'], [['[', ']'], 'height'], [['Shift'], 'parallel copy']],
  road: [[['Click'], 'start / build'], [['Esc'], 'end chain'], [['[', ']'], 'height']],
  station: [[['Click'], 'place'], [['R'], 'rotate'], [['Shift', 'R'], 'back'], [['Ctrl', 'Wheel'], 'rotate']],
  busstop: [[['Click'], 'on a road']],
  'depot-rail': [[['Click'], 'place'], [['R'], 'rotate']],
  'depot-road': [[['Click'], 'next to a road'], [['R'], 'rotate']],
  signal: [[['Click'], 'add / cycle signal']],
  bulldoze: [[['Click'], 'remove'], [['Drag'], 'clear area']],
  terraform: [[['Hold'], 'apply brush']],
  'line-edit': [[['Click'], 'add station'], [['Esc'], 'done']],
};

export class Hud {
  private plateChip: HTMLSpanElement;
  private plateName: HTMLSpanElement;
  private plateMoney: HTMLSpanElement;
  private plateDelta: HTMLSpanElement;
  private dateEl: HTMLSpanElement;
  private spdBtns: HTMLButtonElement[] = [];
  private fpsEl: HTMLSpanElement;
  private badge: HTMLSpanElement;
  private newsBtn: HTMLButtonElement;
  private dock: HTMLDivElement;
  private trayEl: HTMLDivElement;
  private card: HTMLDivElement;
  private wrap: HTMLDivElement;
  /** long help of the tool card expanded */
  helpOpen = false;
  private catBtns = new Map<string, HTMLButtonElement>();
  private vol: HTMLDivElement;
  private volBtn: HTMLButtonElement;
  private volRange: HTMLInputElement;
  private prevTool: ToolId | undefined;
  private trayHide = 0;
  private drawer: HTMLDivElement | null = null;
  openCat: string | null = null;
  private lastTool: Record<string, ToolId> = {};
  private unread = 0;
  // change detection (no DOM writes unless something changed)
  private sMoney = ''; private sDate = ''; private sFps = ''; private sSpeed = ''; private sCard = '';
  private fpsT = 0;
  private deltaT = 0; private deltaBase = NaN; private deltaHide = 0;

  constructor(private ui: UI) {
    const R = ui.root;
    // company plate
    this.plateChip = h('span', { class: 'plate-chip' });
    this.plateName = h('span', { class: 'plate-name' });
    this.plateMoney = h('span', { class: 'plate-money' });
    this.plateDelta = h('span', { class: 'plate-delta' });
    const plate = h('button', { class: 'plate chrome', 'data-tip': 'Finances', 'aria-label': 'Finances', onclick: () => ui.openFinances() },
      this.plateChip, h('span', { class: 'plate-txt' }, this.plateName, this.plateMoney), this.plateDelta);
    R.appendChild(h('div', { class: 'hud hud-tl' }, plate));
    // clock & speed
    this.dateEl = h('span', { class: 'clock-date' });
    const speeds: [string, number, string][] = [['pause', 0, 'Pause'], ['play', 1, 'Normal speed'], ['', 2, 'Fast 2×'], ['', 4, 'Faster 4×'], ['', 8, 'Fastest 8×']];
    const sp = h('div', { class: 'speed', role: 'radiogroup', 'aria-label': 'Game speed' });
    for (const [ic, v, tip] of speeds) {
      const b = h('button', { class: 'spd', 'data-tip': tip, 'data-key': v === 0 ? 'Space' : undefined, 'data-sfx': 'none', 'aria-label': tip, onclick: () => ui.setSpeed(v) }, ic ? icon(ic, 15) : `${v}×`);
      this.spdBtns.push(b);
      sp.appendChild(b);
    }
    R.appendChild(h('div', { class: 'hud hud-tc' }, h('div', { class: 'clock chrome' }, this.dateEl, sp)));
    // actions
    this.fpsEl = h('span', { class: 'fps' });
    this.badge = h('span', { class: 'badge' });
    this.badge.style.display = 'none';
    this.newsBtn = h('button', { class: 'hbtn chrome', 'data-tip': 'News', 'data-key': 'N', 'aria-label': 'News', onclick: () => this.toggleNews() }, icon('bell', 19), this.badge);
    // volume: click mutes, hovering reveals the master volume slider
    this.volBtn = h('button', { class: 'hbtn', 'data-tip': 'Mute', 'aria-label': 'Mute', 'data-sfx': 'none', onclick: () => this.toggleMute() }, icon('volume', 19));
    this.volRange = h('input', { type: 'range', min: '0', max: '100', 'aria-label': 'Master volume' }) as HTMLInputElement;
    this.volRange.addEventListener('input', () => {
      audio.settings.master = Number(this.volRange.value) / 100;
      if (audio.settings.muted && audio.settings.master > 0) audio.settings.muted = false;
      this.syncVol();
    });
    this.volRange.addEventListener('change', () => { audio.saveSettings(); this.ui.sound('click'); });
    this.vol = h('div', { class: 'vol chrome' }, this.volBtn, h('div', { class: 'vol-slider' }, this.volRange));
    R.appendChild(h('div', { class: 'hud hud-tr' },
      this.fpsEl,
      this.vol,
      this.newsBtn,
      h('button', { class: 'hbtn chrome', 'data-tip': 'Companies', 'data-key': 'C', 'aria-label': 'Companies', onclick: () => ui.openCompetitors() }, icon('company', 19)),
      h('button', { class: 'hbtn chrome', 'data-tip': 'Help', 'data-key': 'F1', 'aria-label': 'Help', onclick: () => ui.openHelp() }, icon('help', 19)),
      h('button', { class: 'hbtn chrome', 'data-tip': 'Menu', 'aria-label': 'Menu', onclick: () => ui.openMenu() }, icon('menu', 19)),
    ));
    this.syncVol();
    // dock
    this.dock = h('div', { class: 'dock glass', role: 'toolbar', 'aria-label': 'Tools' });
    CATS.forEach((c, i) => {
      if (i === 4 || i === 1) this.dock.appendChild(h('span', { class: 'dock-sep' }));
      const b = h('button', { class: 'cat', style: `--c:${c.color}`, 'data-tip': c.tip, 'data-key': c.keys, 'data-sfx': 'none', 'aria-label': c.label, onclick: () => this.pickCat(c), onpointerenter: () => audio.play('hover') }, icon(c.icon, 24), h('span', { class: 'cat-l' }, c.label));
      this.catBtns.set(c.id, b);
      this.dock.appendChild(b);
    });
    this.trayEl = h('div', { class: 'tray chrome' });
    this.card = h('div', { class: 'toolcard glass', role: 'region', 'aria-label': 'Tool options' });
    this.trayEl.style.display = 'none';
    this.card.style.display = 'none';
    this.wrap = h('div', { class: 'dockwrap' }, this.trayEl, this.dock);
    R.appendChild(this.wrap);
    // the options card lives at the bottom right, clear of the build area and the minimap
    R.appendChild(this.card);
    window.addEventListener('resize', () => this.placeCard());
  }

  /** Volume button state from the audio settings. */
  syncVol() {
    const st = audio.settings;
    const off = st.muted || st.master <= 0;
    this.vol.classList.toggle('muted', off);
    this.volBtn.replaceChildren(icon(off ? 'mute' : 'volume', 19));
    this.volBtn.dataset.tip = off ? 'Unmute' : 'Mute';
    this.volBtn.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
    this.volBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
    const v = String(Math.round(st.master * 100));
    if (this.volRange.value !== v) this.volRange.value = v;
  }

  toggleMute() {
    audio.settings.muted = !audio.settings.muted;
    if (!audio.settings.muted && audio.settings.master <= 0) audio.settings.master = 0.6;
    audio.saveSettings();
    this.syncVol();
    if (!audio.settings.muted) this.ui.sound('toggle', { pitch: 1.12 });
  }

  setGame(g: Game) {
    this.unread = 0;
    this.prevTool = undefined;
    this.syncVol();
    this.badge.style.display = 'none';
    this.sMoney = this.sDate = this.sSpeed = this.sCard = '';
    this.deltaBase = NaN;
    this.closeNews();
    const co = g.player;
    this.plateChip.style.setProperty('--c', co.color);
    this.plateName.textContent = co.name;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    const g = this.ui.game;
    const money = g.economy.money;
    const sm = fmtMoneyFull(money);
    if (sm !== this.sMoney) {
      this.sMoney = sm;
      this.plateMoney.textContent = sm;
      this.plateMoney.classList.toggle('neg', money < 0);
    }
    // money delta flash (changes accumulated over ~0.6 s)
    if (isNaN(this.deltaBase)) this.deltaBase = money;
    this.deltaT += dt;
    if (this.deltaT > 0.6) {
      const d = money - this.deltaBase;
      this.deltaT = 0;
      this.deltaBase = money;
      if (Math.abs(d) >= 1000) {
        this.plateDelta.textContent = (d > 0 ? '+' : '−') + fmtMoney(Math.abs(d));
        this.plateDelta.className = 'plate-delta show ' + (d > 0 ? 'pos' : 'neg');
        this.deltaHide = 1.6;
      }
    }
    if (this.deltaHide > 0) { this.deltaHide -= dt; if (this.deltaHide <= 0) this.plateDelta.classList.remove('show'); }
    const sd = fmtDate(g);
    if (sd !== this.sDate) { this.sDate = sd; this.dateEl.textContent = sd; }
    const ss = g.paused ? 'p' : String(g.speed);
    if (ss !== this.sSpeed) {
      this.sSpeed = ss;
      const idx = g.paused ? 0 : [1, 2, 4, 8].indexOf(g.speed) + 1;
      this.spdBtns.forEach((b, i) => { b.classList.toggle('on', i === idx && i > 0); b.classList.toggle('paused', i === 0 && g.paused); b.setAttribute('aria-checked', i === idx ? 'true' : 'false'); });
    }
    this.fpsT -= dt;
    if (this.fpsT <= 0) {
      this.fpsT = 0.5;
      const f = `${this.ui.renderer.fps.toFixed(0)} FPS`;
      if (f !== this.sFps) { this.sFps = f; this.fpsEl.textContent = f; }
    }
    // the tool card shows chain-dependent buttons
    const sig = this.cardSig();
    if (sig !== this.sCard) this.renderCard();
  }

  // ------------------------------------------------------------------ news
  onNews(n: News) {
    if (this.drawer) { this.renderNews(); return; }
    void n;
    this.unread++;
    this.badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
    this.badge.style.display = '';
  }

  toggleNews() { if (this.drawer) this.closeNews(); else this.openNews(); }

  openNews() {
    if (this.drawer) return;
    this.unread = 0;
    this.badge.style.display = 'none';
    this.newsBtn.classList.add('on');
    this.drawer = h('div', { class: 'drawer glass', role: 'dialog', 'aria-label': 'News' });
    this.ui.root.appendChild(this.drawer);
    this.renderNews();
  }

  closeNews() {
    this.drawer?.remove();
    this.drawer = null;
    this.newsBtn.classList.remove('on');
  }

  private renderNews() {
    const d = this.drawer;
    if (!d) return;
    const g = this.ui.game;
    clear(d);
    const body = h('div', { class: 'drawer-body' });
    for (const n of [...g.news].reverse()) {
      const row = h('div', { class: 'news-row ' + n.kind }, h('i'), h('div', null, h('span', { class: 'news-date' }, newsDate(g, n)), n.text));
      if (n.x !== undefined) { row.classList.add('link'); row.addEventListener('click', () => this.ui.centerOn(n.x!, n.z!)); }
      body.appendChild(row);
    }
    if (!g.news.length) body.appendChild(h('div', { class: 'pad' }, 'No news yet.'));
    d.append(h('div', { class: 'drawer-head' }, icon('bell', 18), h('span', null, 'News'), h('button', { class: 'ibtn', 'data-tip': 'Close', 'data-key': 'Esc', 'aria-label': 'Close', onclick: () => this.closeNews() }, icon('close', 18))), body);
  }

  // ------------------------------------------------------------------ dock
  private pickCat(c: Cat) {
    const T = this.ui.tools;
    if (!this.ui.game) return;
    if (c.actions) { this.openCat = this.openCat === c.id ? null : c.id; this.ui.sound(this.openCat ? 'open' : 'close'); if (T.tool !== 'inspect' && this.openCat) T.setTool('inspect'); this.onToolChange(); return; }
    const tools = c.tools!;
    const cur = TOOL_META[T.tool].cat === c.id;
    if (tools.length === 1) {
      this.openCat = null;
      T.setTool(cur && c.id !== 'inspect' ? 'inspect' : tools[0]);
      return;
    }
    if (cur) { this.openCat = null; T.setTool('inspect'); return; }
    this.openCat = c.id;
    T.setTool(this.lastTool[c.id] ?? tools[0]);
  }

  /** Sync the dock, tray and tool card with the active tool. */
  onToolChange() {
    const T = this.ui.tools;
    const t = T.tool;
    const meta = TOOL_META[t];
    if (this.prevTool !== undefined && t !== this.prevTool) this.ui.sound(t === 'inspect' ? 'close' : 'tool');
    this.prevTool = t;
    if (t !== 'inspect' && t !== 'line-edit') this.lastTool[meta.cat] = t;
    const cat = CATS.find((c) => c.id === meta.cat);
    if (t === 'inspect') { if (this.openCat !== 'lines') this.openCat = null; }
    else if (cat && ((cat.tools && cat.tools.length > 1) || cat.id === 'terrain')) this.openCat = cat.id;
    else if (t !== 'line-edit') this.openCat = null;
    for (const [id, b] of this.catBtns) {
      const on = id === this.openCat || (id === meta.cat && (t !== 'inspect' || id === 'inspect'));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.renderTray();
    this.renderCard();
  }

  /** Keep the tool card above the dock and tray (bottom right; full width on phones). */
  private placeCard() {
    if (this.card.style.display === 'none') return;
    const H = window.innerHeight;
    let top = this.dock.getBoundingClientRect().top;
    if (this.trayEl.style.display !== 'none') {
      // lift above the tray only where they would collide (narrow screens)
      const tr = this.trayEl.getBoundingClientRect(), cr = this.card.getBoundingClientRect();
      if (tr.right > cr.left - 8 && tr.left < cr.right + 8) top = Math.min(top, tr.top);
    }
    if (top > 0 && top < H) this.card.style.bottom = Math.round(H - top + 8) + 'px';
  }

  /** Screen areas the cursor tooltip should not cover. */
  avoidRects(): DOMRect[] {
    const out: DOMRect[] = [];
    if (this.card.style.display !== 'none') out.push(this.card.getBoundingClientRect());
    const mm = this.ui.minimap.el;
    if (mm.isConnected !== false) out.push(mm.getBoundingClientRect());
    return out;
  }

  private renderTray() {
    this.renderTrayContent();
    this.placeCard();
  }

  private renderTrayContent() {
    const tr = this.trayEl;
    const c = CATS.find((x) => x.id === this.openCat);
    clearTimeout(this.trayHide);
    if (!c || (!c.actions && (!c.tools || (c.tools.length < 2 && c.id !== 'terrain')))) {
      // fade out, then remove from the layout
      if (tr.style.display !== 'none' && !tr.classList.contains('leaving')) {
        tr.classList.add('leaving');
        this.trayHide = window.setTimeout(() => { tr.style.display = 'none'; tr.classList.remove('leaving'); this.placeCard(); }, 130);
      }
      return;
    }
    const T = this.ui.tools;
    clear(tr);
    tr.classList.remove('leaving');
    tr.style.display = '';
    tr.style.setProperty('--c', c.color);
    if (c.actions) {
      for (const [id, label, ic, key] of c.actions) {
        tr.appendChild(h('button', { class: 'toolb', 'data-tip': label, 'data-key': key, 'data-sfx': 'none', onclick: () => this.ui.openList(id) }, icon(ic, 20), label, kbd(key)));
      }
      return;
    }
    if (c.id === 'terrain') {
      for (const [m, label, ic] of [['raise', 'Raise', 'raise'], ['lower', 'Lower', 'lower'], ['level', 'Level', 'level']] as const) {
        const on = T.tool === 'terraform' && T.terraMode === m;
        tr.appendChild(h('button', { class: 'toolb' + (on ? ' on' : ''), 'data-tip': `${label} ground`, 'data-key': '0', 'data-sfx': T.tool === 'terraform' ? 'click' : 'none', onclick: () => { T.terraMode = m; if (T.tool !== 'terraform') T.setTool('terraform'); else { T.refreshHover(); this.onToolChange(); } } }, icon(ic, 20), label));
      }
      return;
    }
    for (const t of c.tools!) {
      const m = TOOL_META[t];
      tr.appendChild(h('button', { class: 'toolb' + (T.tool === t ? ' on' : ''), 'data-tip': TOOL_INFO[t].name, 'data-key': m.key || undefined, 'data-sfx': 'none', 'aria-label': TOOL_INFO[t].name, onclick: () => T.setTool(t) }, icon(m.icon, 20), TOOL_LABEL[t] ?? TOOL_INFO[t].name, m.key ? kbd(m.key) : null));
    }
  }

  private cardSig() {
    const T = this.ui.tools;
    const line = T.lineEditId != null ? this.ui.game.lines.get(T.lineEditId) : null;
    return [T.tool, T.railType, T.roadType, T.tracks, T.heightOffset, T.crossing, T.stationLen, T.stationTracks, Math.round(T.stationAngle * 100), T.autoAlign, T.terraMode, T.brushRadius, !!T.start, line ? line.name + line.stops.length + line.color : ''].join('|');
  }

  /** Compact options card of the active tool: header, one-line description (long help behind '?'), options. */
  private renderCard() {
    const T = this.ui.tools;
    const t = T.tool;
    this.sCard = this.cardSig();
    const card = this.card;
    if (t === 'inspect') { card.style.display = 'none'; return; }
    const meta = TOOL_META[t];
    clear(card);
    card.style.display = '';
    card.style.setProperty('--c', meta.color);
    const redo = () => { T.refreshHover(); this.renderCard(); };
    const opt = (label: string, ...ctrl: (Node | null)[]) => h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, label), ...ctrl.filter((x): x is Node => !!x));
    const opts: HTMLElement[] = [];
    if (t === 'rail' || t === 'road') {
      if (t === 'rail') {
        opts.push(opt('Track', seg([['standard', 'Standard', `${TRACK_TYPES.standard.speed} km/h`], ['highspeed', 'High-speed', `${TRACK_TYPES.highspeed.speed} km/h · electrified`]], T.railType, (v) => { T.railType = v; redo(); })));
        opts.push(opt('Tracks', seg([[1, '1'], [2, '2'], [3, '3'], [4, '4']], T.tracks, (v) => { T.tracks = v; redo(); })));
      } else {
        opts.push(opt('Road', seg([['street', 'Town street', `${ROAD_TYPES.street.speed} km/h · sidewalks`], ['road', 'Country road', `${ROAD_TYPES.road.speed} km/h`]], T.roadType, (v) => { T.roadType = v; redo(); })));
      }
      opts.push(opt('Height', stepper(fmtHeight(T.heightOffset), () => T.adjustHeight(-0.5), () => T.adjustHeight(0.5), 'End height: raised ends make bridges, lowered ends cuttings and tunnels ( [ / ] or PgUp / PgDn )')));
      opts.push(opt('Cross', seg([['auto', 'Auto'], ['over', 'Over'], ['under', 'Under'], ['level', 'Level']], T.crossing, (v) => { T.crossing = v; redo(); })));
      if (T.start) opts.push(h('button', { class: 'btn sm', onclick: () => T.cancel() }, icon('close', 14), 'End chain'));
    } else if (t === 'station') {
      opts.push(opt('Length', stepper(`${T.stationLen * 10} m`, () => { T.stationLen = Math.max(8, T.stationLen - 2); redo(); }, () => { T.stationLen = Math.min(40, T.stationLen + 2); redo(); })));
      opts.push(opt('Tracks', stepper(String(T.stationTracks), () => { T.stationTracks = Math.max(1, T.stationTracks - 1); redo(); }, () => { T.stationTracks = Math.min(6, T.stationTracks + 1); redo(); })));
      opts.push(opt('Rotate', h('div', { class: 'inline' }, h('button', { class: 'ibtn sm', 'data-tip': 'Rotate left', 'data-key': 'Shift R', 'aria-label': 'Rotate left', onclick: () => T.rotate(-1) }, icon('rotl', 16)), h('span', { class: 'stp-v' }, `${Math.round((T.stationAngle * 180) / Math.PI)}°`), h('button', { class: 'ibtn sm', 'data-tip': 'Rotate right', 'data-key': 'R', 'aria-label': 'Rotate right', onclick: () => T.rotate(1) }, icon('rotr', 16)))));
      opts.push(toggle('Align to track', T.autoAlign, (v) => { T.autoAlign = v; redo(); }));
    } else if (t === 'depot-rail' || t === 'depot-road') {
      opts.push(opt('Rotate', h('div', { class: 'inline' }, h('button', { class: 'ibtn sm', 'data-tip': 'Rotate left', 'data-key': 'Shift R', 'aria-label': 'Rotate left', onclick: () => T.rotate(-1) }, icon('rotl', 16)), h('button', { class: 'ibtn sm', 'data-tip': 'Rotate right', 'data-key': 'R', 'aria-label': 'Rotate right', onclick: () => T.rotate(1) }, icon('rotr', 16)))));
    } else if (t === 'terraform') {
      opts.push(opt('Mode', seg([['raise', 'Raise'], ['lower', 'Lower'], ['level', 'Level']], T.terraMode, (v) => { T.terraMode = v; redo(); this.renderTray(); })));
      const rng = h('input', { type: 'range', min: '1', max: '14', value: String(T.brushRadius), class: 'range', 'aria-label': 'Brush radius' }) as HTMLInputElement;
      const val = h('span', { class: 'stp-v' }, `${T.brushRadius * 10} m`);
      rng.addEventListener('input', () => { T.brushRadius = Number(rng.value); val.textContent = `${T.brushRadius * 10} m`; T.refreshHover(); this.sCard = this.cardSig(); });
      opts.push(opt('Radius', rng, val));
    } else if (t === 'line-edit') {
      const line = T.lineEditId != null ? this.ui.game.lines.get(T.lineEditId) : null;
      opts.push(h('span', { class: 'chip', style: `--c:${line?.color ?? '#fff'}` }, line?.name ?? ''), h('span', { class: 'muted' }, `${line?.stops.length ?? 0} stops`));
      opts.push(h('button', { class: 'btn sm primary', onclick: () => T.setTool('inspect') }, icon('check', 14), 'Done'));
    }
    const keys = KEYS[t] ?? [];
    const help = this.helpOpen
      ? h('div', { class: 'tc-help' }, h('p', null, TOOL_INFO[t].hint), keys.length ? h('div', { class: 'tc-keys' }, keys.map(([ks, what]) => h('span', null, ks.map((k) => kbd(k)), what))) : null)
      : h('div', { class: 'tc-desc', title: TOOL_INFO[t].hint }, TOOL_SHORT[t] ?? TOOL_INFO[t].hint);
    add(card,
      h('div', { class: 'tc-head' }, h('span', { class: 'tc-dot' }), h('span', { class: 'tc-title' }, TOOL_INFO[t].name),
        h('button', { class: 'ibtn sm' + (this.helpOpen ? ' on' : ''), 'data-tip': this.helpOpen ? 'Hide help' : 'Help & keys', 'aria-label': 'Help', 'aria-expanded': this.helpOpen ? 'true' : 'false', onclick: () => { this.helpOpen = !this.helpOpen; this.renderCard(); } }, icon('help', 16)),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close tool', 'data-key': 'Esc', 'data-sfx': 'none', 'aria-label': 'Close tool', onclick: () => T.setTool('inspect') }, icon('close', 16))),
      help,
      opts.length ? h('div', { class: 'tc-opts' }, opts) : null,
    );
    this.placeCard();
  }
}
