// Heads-up display: company plate, clock & speed, actions, news drawer, and the tool dock
// (categories → tray of tools → contextual options card).
import type { UI } from './ui';
import type { Game, News } from '../game/game';
import { PLAYER } from '../game/game';
import type { ToolId, LineLevel } from './tools';
import { TOOL_INFO } from './tools';
import { h, icon, clear, seg, stepper, kbd, toggle, add } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { TRACK_TYPES, ROAD_TYPES, LINE_LEVEL, ELECTRIFY } from '../game/constants';
import { structureFactor } from '../game/construction';
import { fmtDate, fmtHeight, fmtLen, newsDate, fmtPct } from './format';
import { walkLimit } from '../game/catchment';
import type { StationLevel } from './gameapi';
import { stationStyles, catchBonusOf } from './gameapi';
import { STATION_HEIGHT, STATION_DEPTH, PLATFORM_LENGTH, railModeOf, GROUND_ENTRANCES, ENTRANCE_TYPES, entranceCost } from '../game/stations';
import type { EntranceKind } from '../game/stations';
import { styleOf } from '../game/station-styles';
import { audio } from '../audio/engine';
import { onStorageMode, storageMode } from '../game/storage';
import { exportSave } from './win-menu';

interface Cat { id: string; label: string; icon: string; color: string; tip: string; keys: string; tools?: ToolId[]; actions?: [string, string, string, string][] }

/** Tool categories of the dock. */
const CATS: Cat[] = [
  { id: 'inspect', label: 'Inspect', icon: 'inspect', color: '#eef2f7', tip: 'Inspect', keys: '1', tools: ['inspect'] },
  { id: 'rail', label: 'Rail', icon: 'rail', color: 'var(--rail)', tip: 'Rail: track, double track, signals, depot, electrify, connect', keys: '2 4 5 J', tools: ['rail', 'double', 'signal', 'depot-rail', 'electrify', 'connect'] },
  { id: 'urban', label: 'Urban', icon: 'metro', color: 'var(--rail)', tip: 'City rail presets · double track with wire · metro / light-rail station styles · lift / sink track', keys: 'U', tools: ['metro', 'metro-station', 'relevel'] },
  { id: 'road', label: 'Road', icon: 'road', color: 'var(--road)', tip: 'Road: roads, bus depot', keys: '6 8', tools: ['road', 'depot-road'] },
  { id: 'tram', label: 'Tram', icon: 'tram', color: 'var(--tram)', tip: 'Tram: tracks, stops, depot', keys: '', tools: ['tram', 'tramstop', 'depot-tram'] },
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
  tram: { icon: 'tramtrack', key: '', cat: 'tram', color: 'var(--tram)' },
  tramstop: { icon: 'tramstop', key: '', cat: 'tram', color: 'var(--tram)' },
  'depot-tram': { icon: 'tramdepot', key: '', cat: 'tram', color: 'var(--tram)' },
  bulldoze: { icon: 'bulldoze', key: '9', cat: 'demolish', color: 'var(--demolish)' },
  terraform: { icon: 'terraform', key: '0', cat: 'terrain', color: 'var(--terrain)' },
  'line-edit': { icon: 'lines', key: '', cat: 'lines', color: 'var(--accent)' },
  double: { icon: 'parallel', key: '', cat: 'rail', color: 'var(--rail)' },
  entrance: { icon: 'entrance', key: '', cat: 'stations', color: 'var(--station)' },
  metro: { icon: 'metro', key: 'U', cat: 'urban', color: 'var(--rail)' },
  'metro-station': { icon: 'station', key: '', cat: 'urban', color: 'var(--rail)' },
  relevel: { icon: 'relevel', key: '', cat: 'urban', color: 'var(--rail)' },
  electrify: { icon: 'bolt', key: '', cat: 'rail', color: 'var(--rail)' },
  connect: { icon: 'connect', key: 'J', cat: 'rail', color: 'var(--rail)' },
};

/** Tools whose game API may still be missing (shown only when available; all have landed). */
const toolAvailable = (t: ToolId) => !!t;

/** One-line descriptions for the compact tool card (the long help sits behind '?'). */
const TOOL_SHORT: Partial<Record<ToolId, string>> = {
  rail: 'Click: start / build; continue from the new end.',
  road: 'Click: start / build; continue from the new end.',
  station: 'Auto-aligns with nearby track ends.',
  busstop: 'Click on a road to place a stop.',
  'depot-rail': 'Snaps to a free track end.',
  'depot-road': 'Roadside: connects automatically.',
  tram: 'Road tracks: click or drag along streets.',
  tramstop: 'Click on a road with tram tracks.',
  'depot-tram': 'Beside a road with tram tracks.',
  signal: 'Click: add / cycle; drag: place a series.',
  double: 'Click or drag along your single track.',
  entrance: 'Ground: beside tracks; elevated / underground: near a road.',
  bulldoze: 'Click: remove; drag: clear an area.',
  terraform: 'Hold to raise, lower or level.',
  'line-edit': 'Click stations to add stops.',
  metro: 'Click: start / build; ground, elevated or underground.',
  'metro-station': 'Underground by default; street entrances.',
  electrify: 'Click track or drag along a line.',
  connect: 'Pick a point on each track.',
  relevel: 'Click or drag along your track.',
};

/** Longer tray tooltips where the name alone does not explain the tool. */
const TRAY_TIP: Partial<Record<ToolId, string>> = {
  signal: 'Two-way: single track with loops; one-way: double track; drag: signal a stretch.',
  double: 'Second track with switches at both ends.',
  electrify: 'Overhead wire for electric trains, metro and light-rail units.',
  connect: 'Connecting curve with turnouts for through running.',
  metro: 'Double track with wire · underground default · any level · any train or rail line',
  'metro-station': 'Metro or light-rail station style · underground default · street entrances',
  relevel: 'Lift onto a viaduct or sink into a tunnel.',
};
const TOOL_LABEL: Partial<Record<ToolId, string>> = { tram: 'Tracks', tramstop: 'Tram stop', 'depot-tram': 'Tram depot', rail: 'Track', double: 'Double', signal: 'Signals', 'depot-rail': 'Train depot', road: 'Road', 'depot-road': 'Bus depot', station: 'Train station', busstop: 'Bus stop', entrance: 'Entrance', metro: 'Urban track', 'metro-station': 'Station', relevel: 'Re-level', electrify: 'Electrify', connect: 'Connect' };

/** Key hints per tool: [keys, action]. */
const KEYS: Partial<Record<ToolId, [string[], string][]>> = {
  rail: [[['Click'], 'start / build'], [['Esc'], 'end chain'], [['[', ']'], 'height'], [['Shift'], 'parallel copy']],
  road: [[['Click'], 'start / build'], [['Esc'], 'end chain'], [['[', ']'], 'height']],
  station: [[['Click'], 'place'], [['R'], 'rotate'], [['Shift', 'R'], 'back'], [['Alt', 'Wheel'], 'rotate']],
  busstop: [[['Click'], 'on a road']],
  'depot-rail': [[['Click'], 'place'], [['R'], 'rotate']],
  'depot-road': [[['Click'], 'next to a road'], [['R'], 'rotate']],
  tram: [[['Click'], 'one road'], [['Drag'], 'along streets'], [['Esc'], 'cancel']],
  tramstop: [[['Click'], 'on tram tracks']],
  'depot-tram': [[['Click'], 'next to tram tracks'], [['R'], 'rotate']],
  signal: [[['Click'], 'add / cycle signal'], [['Drag'], 'block signals along a track'], [['Right-click'], 'remove']],
  double: [[['Click'], 'one track'], [['Drag'], 'along the line'], [['Esc'], 'cancel']],
  entrance: [[['Click'], 'beside the tracks or a road'], [['Esc'], 'done']],
  bulldoze: [[['Click'], 'remove'], [['Drag'], 'clear area']],
  terraform: [[['Hold'], 'apply brush']],
  'line-edit': [[['Click'], 'add station'], [['Esc'], 'done']],
  metro: [[['Click'], 'start / build'], [['Esc'], 'end chain'], [['[', ']'], 'end height'], [['Shift'], 'parallel copy']],
  'metro-station': [[['Click'], 'place'], [['R'], 'rotate'], [['Shift', 'R'], 'back'], [['Alt', 'Wheel'], 'rotate']],
  electrify: [[['Click'], 'one track'], [['Drag'], 'along the line'], [['Esc'], 'cancel']],
  connect: [[['Click'], 'first track'], [['Click'], 'second track'], [['Esc'], 'pick again']],
  relevel: [[['Click'], 'one track'], [['Drag'], 'along a stretch'], [['Esc'], 'cancel']],
};

/** Cost of a track type per km at a level (ground track; viaduct / tunnel by the structure factor). */
export function typeCostKm(type: string, level: LineLevel, height: number, depth: number): { cost: number; factor: number } {
  const tt = TRACK_TYPES[type] ?? TRACK_TYPES.standard;
  const factor = level === 'elevated' ? structureFactor('rail', 'bridge', height) : level === 'underground' ? structureFactor('rail', 'tunnel', depth) : 1;
  return { cost: tt.costPerUnit * 100 * factor, factor };
}

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
  /** Small-screen tool details are folded until the player asks for them. */
  private detailsOpen = false;
  private catBtns = new Map<string, HTMLButtonElement>();
  private vol: HTMLDivElement;
  private volBtn: HTMLButtonElement;
  private volRange: HTMLInputElement;
  private prevTool: ToolId | undefined;
  private mapBtns: Record<string, HTMLButtonElement> = {};
  private saveEl: HTMLSpanElement;
  private storageBanner: HTMLElement | null = null;
  private storageDismissed = false;
  /** track tool: offer 3 and 4 parallel tracks too */
  private moreTracks = false;
  private accessBtn: HTMLButtonElement;
  private accessBadge: HTMLSpanElement;
  private sAccess = -1;
  private saveHide = 0;
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
    const plate = h('button', { class: 'plate chrome', 'data-tip': 'Finances', 'data-key': 'I', 'aria-label': 'Finances', onclick: () => ui.openFinances() },
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
    this.saveEl = h('span', { class: 'savechip', role: 'status', 'aria-live': 'polite' });
    R.appendChild(h('div', { class: 'hud hud-tc' }, h('div', { class: 'clock chrome' }, this.dateEl, sp), this.saveEl));
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
    this.accessBadge = h('span', { class: 'badge' });
    this.accessBadge.style.display = 'none';
    this.accessBtn = h('button', { class: 'hbtn chrome', 'data-tip': 'Track access', 'data-key': 'K', 'aria-label': 'Track access', onclick: () => ui.openTrackAccess() }, icon('key', 19), this.accessBadge);
    this.mapBtns.lines = h('button', { class: 'hbtn chrome', 'data-tip': 'Lines map', 'data-key': 'M', 'data-sfx': 'none', 'aria-label': 'Lines map', 'aria-pressed': 'false', onclick: () => ui.mapModes.toggle('lines') }, icon('map', 19));
    this.mapBtns.demand = h('button', { class: 'hbtn chrome', 'data-tip': 'Demand view', 'data-key': 'P', 'data-sfx': 'none', 'aria-label': 'Demand view', 'aria-pressed': 'false', onclick: () => ui.mapModes.toggle('demand') }, icon('demand', 19));
    this.mapBtns.signals = h('button', { class: 'hbtn chrome', 'data-tip': 'Signal blocks', 'data-sfx': 'none', 'aria-label': 'Signal blocks', 'aria-pressed': 'false', onclick: () => ui.mapModes.toggle('signals') }, icon('signal', 19));
    this.mapBtns.catchment = h('button', { class: 'hbtn chrome', 'data-tip': 'Catchment areas', 'data-key': 'O', 'data-sfx': 'none', 'aria-label': 'Catchment areas', 'aria-pressed': 'false', onclick: () => ui.mapModes.toggle('catchment') }, icon('catchment', 19));
    R.appendChild(h('div', { class: 'hud hud-tr' },
      this.fpsEl,
      this.mapBtns.lines,
      this.mapBtns.demand,
      this.mapBtns.catchment,
      this.mapBtns.signals,
      this.vol,
      this.newsBtn,
      h('button', { class: 'hbtn chrome', 'data-tip': 'Companies', 'data-key': 'C', 'aria-label': 'Companies', onclick: () => ui.openCompetitors() }, icon('company', 19)),
      this.accessBtn,
      h('button', { class: 'hbtn chrome', 'data-tip': 'Help', 'data-key': 'F1', 'aria-label': 'Help', onclick: () => ui.openHelp() }, icon('help', 19)),
      h('button', { class: 'hbtn chrome', 'data-tip': 'Menu', 'aria-label': 'Menu', onclick: () => ui.openMenu() }, icon('menu', 19)),
    ));
    this.syncVol();
    // dock
    this.dock = h('div', { class: 'dock glass', role: 'toolbar', 'aria-label': 'Tools' });
    CATS.forEach((c) => {
      if (c.id === 'rail' || c.id === 'lines') this.dock.appendChild(h('span', { class: 'dock-sep' }));
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
    onStorageMode((mode) => {
      if (mode !== 'memory') return;
      this.showSave('memory');
      if (this.storageBanner || this.storageDismissed) return;
      this.storageBanner = h('div', { class: 'storage-banner', role: 'status', 'aria-live': 'polite' },
        icon('warning', 18), h('span', null, "Session-only saves: lost on reload; Export to keep."),
        h('button', { class: 'btn sm', onclick: () => exportSave(this.ui) }, 'Export'),
        h('button', { class: 'ibtn sm', 'aria-label': 'Dismiss storage notice', onclick: () => {
          this.storageDismissed = true; this.storageBanner?.remove(); this.storageBanner = null;
        } }, icon('close', 16)));
      R.appendChild(this.storageBanner);
    });
  }

  /** Small autosave indicator under the clock: "Saving…", then "Saved" (fades), or "Save failed". */
  showSave(state: 'saving' | 'saved' | 'error' | 'memory') {
    if (state === 'saved' && storageMode() === 'memory') state = 'memory';
    const el = this.saveEl;
    clearTimeout(this.saveHide);
    el.className = 'savechip show ' + state;
    el.replaceChildren(icon(state === 'error' || state === 'memory' ? 'warning' : state === 'saved' ? 'check' : 'save', 13), state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'memory' ? 'Session only · Export' : 'Autosave failed');
    if (state !== 'saving' && state !== 'memory') this.saveHide = window.setTimeout(() => {
      if (storageMode() === 'memory') this.showSave('memory'); else el.classList.remove('show');
    }, state === 'error' ? 5000 : 1600);
  }

  /** Highlight the active map view button. */
  syncMapButtons() {
    const m = this.ui.mapModes?.mode ?? 'none';
    for (const [k, b] of Object.entries(this.mapBtns)) { b.classList.toggle('on', k === m); b.setAttribute('aria-pressed', k === m ? 'true' : 'false'); }
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
    clearTimeout(this.saveHide);
    if (storageMode() === 'memory') this.showSave('memory');
    else { this.saveEl.className = 'savechip'; this.saveEl.replaceChildren(); }
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
    // pending requests for access to the player's network
    const nReq = g.requestsTo(PLAYER).length;
    if (nReq !== this.sAccess) {
      this.sAccess = nReq;
      this.accessBadge.textContent = String(nReq);
      this.accessBadge.style.display = nReq ? '' : 'none';
      this.accessBtn.dataset.tip = nReq ? `Track access · ${nReq} request${nReq > 1 ? 's' : ''} waiting` : 'Track access';
    }
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
      if (this.ui.isDebtNews(n)) {
        row.classList.add('link'); row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.addEventListener('click', () => this.ui.openFinances());
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.ui.openFinances(); } });
      } else if (n.x !== undefined) { row.classList.add('link'); row.addEventListener('click', () => this.ui.centerOn(n.x!, n.z!)); }
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
    const tools = c.tools!.filter(toolAvailable);
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
    const H = window.innerHeight;
    const dockTop = this.wrap.getBoundingClientRect().top;
    if (dockTop > 0 && dockTop < H) this.ui.root.style.setProperty('--dock-clearance', `${Math.ceil(H - dockTop + 8)}px`);
    this.ui.syncCompactPanels();
    if (this.card.style.display === 'none') return;
    let top = this.dock.getBoundingClientRect().top;
    if (this.trayEl.style.display !== 'none') {
      // lift above the tray only where they would collide (narrow screens)
      const tr = this.trayEl.getBoundingClientRect(), cr = this.card.getBoundingClientRect();
      if (tr.right > cr.left - 8 && tr.left < cr.right + 8) top = Math.min(top, tr.top);
    }
    if (top > 0 && top < H) this.card.style.bottom = Math.round(H - top + 8) + 'px';
  }

  /** Screen areas the cursor tooltip should not cover. */
  /** Screen rectangles tooltips and hover cards should not cover: the tool card and the left column's cards. */
  avoidRects(): DOMRect[] {
    const out: DOMRect[] = [];
    if (this.card.style.display !== 'none') out.push(this.card.getBoundingClientRect());
    for (const el of [this.ui.checklist.el, this.ui.mapModes.card, this.ui.minimap.el]) {
      if (el.isConnected === false || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    }
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
    for (const t of c.tools!.filter(toolAvailable)) {
      const m = TOOL_META[t];
      tr.appendChild(h('button', { class: 'toolb' + (T.tool === t ? ' on' : '') + (t === 'signal' ? ' key' : ''), 'data-tip': TRAY_TIP[t] ?? TOOL_INFO[t].name, 'data-key': m.key || undefined, 'data-sfx': 'none', 'aria-label': TOOL_INFO[t].name, onclick: () => T.setTool(t) }, icon(m.icon, 20), TOOL_LABEL[t] ?? TOOL_INFO[t].name, m.key ? kbd(m.key) : null));
    }
  }

  private cardSig() {
    const T = this.ui.tools;
    const line = T.lineEditId != null ? this.ui.game.lines.get(T.lineEditId) : null;
    return [T.tool, T.tramMode, T.railType, T.proposal?.opts.type, T.railLevel, T.levelHeight, T.levelDepth, T.stationType, T.stationStyle, T.conn ? T.conn.edge : -1, T.relevelTo, this.ui.game.year, T.roadType, T.tracks, this.moreTracks, T.directional, T.rightHand, T.signalMode, T.signalKind, T.signalSpacing, T.signalClass, T.signalPass, T.stationThrough, T.throughMode, T.stationOnLine, T.doubleSide, T.relocating, T.relocatingDepot, T.entranceStation, T.entranceKind, T.entranceStation != null ? this.ui.game.stations.get(T.entranceStation)?.rail?.entrances.length : -1, T.heightOffset, T.crossing, T.stationLen, T.stationTracks, T.stationLevel, T.stationHeight, T.stationDepth, Math.round(T.stationAngle * 100), T.autoAlign, T.terraMode, T.brushRadius, !!T.start, T.constructionWarnings.join('\n'), line ? line.name + line.stops.length + line.color : ''].join('|');
  }

  /** Station tools: platform length and level follow the selected station style's defaults. */
  private setStationType(v: string) {
    const T = this.ui.tools;
    const prev = T.stationType;
    T.stationType = v;
    if (T.tool !== 'metro-station' || prev === v) return;
    const len = (x: string) => PLATFORM_LENGTH[railModeOf(x)];
    if (T.stationLen === len(prev)) T.stationLen = len(v);
    const lvl = (x: string): StationLevel => (x === 'metro' ? 'underground' : 'ground');
    if (T.stationLevel === lvl(prev)) T.stationLevel = lvl(v);
  }

  /** Level (ground / elevated / underground) with the viaduct height or tunnel depth (line levels, LINE_LEVEL). */
  private levelOpts(lv: LineLevel, height: number, depth: number, setLv: (v: LineLevel) => void, setH: (v: number) => void, setD: (v: number) => void, names = ['Ground', 'Elevated', 'Underground']): HTMLElement {
    const H = LINE_LEVEL.height, D = LINE_LEVEL.depth;
    const step = (v: number, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round((v + d) * 100) / 100));
    return h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Level'),
      seg<LineLevel>([
        ['ground', names[0], 'Earthworks; bridges and tunnels where needed'],
        ['elevated', names[1], 'Continuous viaduct · about 5–8× ground-track cost'],
        ['underground', names[2], 'Continuous tunnel · cut-and-cover 6–9×; deep bored 9.5–13× ground-track cost'],
      ], lv, setLv),
      lv === 'elevated' ? stepper(`${Math.round(height * 10)} m`, () => setH(step(height, -0.1, H.min, H.max)), () => setH(step(height, 0.1, H.min, H.max)), 'Deck height above ground')
        : lv === 'underground' ? stepper(`${Math.round(depth * 10)} m`, () => setD(step(depth, -0.25, D.min, D.max)), () => setD(step(depth, 0.25, D.min, D.max)), 'Depth below ground; shallow tunnels cost less') : null);
  }

  /** Station building style: Auto, then the styles for the level, platform tracks and year, with their catchment bonus. */
  private styleOpts(): HTMLElement {
    const T = this.ui.tools, g = this.ui.game;
    const list = stationStyles(T.stationLevel, T.stationTracks, g.year);
    const moving = T.relocating != null ? g.stations.get(T.relocating)?.rail : null;
    if (moving && T.stationLevel === moving.level && T.stationTracks === moving.tracks) {
      const retained = styleOf(moving.style);
      if (!list.some((st) => st.id === retained.id)) list.push(retained);
    }
    const cur = T.stationStyle !== 'auto' && list.some((st) => st.id === T.stationStyle) ? T.stationStyle : 'auto';
    const pick = (id: string) => { T.stationStyle = id; T.refreshHover(); this.renderCard(); };
    const chip = (id: string, label: string, tip: string, bonus = 0) => h('button', { class: 'styb' + (cur === id ? ' on' : ''), 'data-tip': tip, role: 'radio', 'aria-checked': cur === id ? 'true' : 'false', onclick: () => pick(id) }, label, bonus ? h('small', null, `+${Math.round(bonus * 100)}%`) : null);
    return h('div', { class: 'opt wide' }, h('span', { class: 'opt-l' }, 'Building'),
      h('div', { class: 'stychips', role: 'radiogroup', 'aria-label': 'Building style' },
        chip('auto', 'Auto', 'By era, level and town; may choose no building'),
        list.map((st) => { const b = catchBonusOf(st.id); return chip(st.id, STYLE_SHORT[st.id] ?? st.name, `${st.name}: ${st.desc}${b ? ` · catchment +${Math.round(b * 100)}%` : st.id === 'none' ? ' · no catchment bonus' : ''}`, b); })));
  }

  /** Compact options card of the active tool: header, one-line description (long help behind '?'), options. */
  private renderCard() {
    const T = this.ui.tools;
    const t = T.tool;
    this.sCard = this.cardSig();
    const card = this.card;
    this.ui.root.classList.toggle('has-tool-card', t !== 'inspect');
    if (t === 'inspect') { card.style.display = 'none'; this.placeCard(); return; }
    const meta = TOOL_META[t];
    clear(card);
    card.style.display = '';
    card.classList.toggle('expanded', this.detailsOpen);
    card.style.setProperty('--c', meta.color);
    const redo = () => { T.refreshHover(); this.renderCard(); };
    const opt = (label: string, ...ctrl: (Node | null)[]) => h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, label), ...ctrl.filter((x): x is Node => !!x));
    const opts: HTMLElement[] = [];
    if (t === 'tram') opts.push(opt('Mode', seg([['add', 'Add to roads', 'Lay tracks in existing roads'], ['build', 'New road', 'Build a new road with tracks'], ['remove', 'Remove', 'Take your tracks up']], T.tramMode, (v) => { T.tramMode = v; T.resetChain(); redo(); })));
    if (T.railBuild || t === 'road' || (t === 'tram' && T.tramMode === 'build')) {
      if (T.railBuild) {
        opts.push(this.levelOpts(T.railLevel, T.levelHeight, T.levelDepth, (lv) => { T.railLevel = lv; redo(); }, (hh) => { T.levelHeight = hh; redo(); }, (d) => { T.levelDepth = d; redo(); }));
        opts.push(typeSpec(T.proposal?.opts.type ?? T.railType, T.railLevel, T.levelHeight, T.levelDepth));
        const many = this.moreTracks || T.tracks > 2;
        opts.push(opt('Tracks', seg<number>(many ? [[1, 'Single'], [2, 'Double'], [3, '3'], [4, '4']] : [[1, 'Single', 'Upgrade to double later'], [2, 'Double', 'Parallel tracks for passing']], T.tracks, (v) => { T.tracks = v; redo(); }),
          many ? null : h('button', { class: 'ibtn sm', 'data-tip': 'More tracks (3–4)', 'aria-label': 'More tracks', onclick: () => { this.moreTracks = true; this.renderCard(); } }, icon('plus', 14))));
        if (T.tracks === 2) {
          opts.push(toggle('Directional', T.directional, (v) => { T.directional = v; redo(); }, 'One way per track · signals · crossovers before stations'));
          if (T.directional) opts.push(opt('Run on', seg<string>([['right', 'Right'], ['left', 'Left']], T.rightHand ? 'right' : 'left', (v) => { T.rightHand = v === 'right'; redo(); })));
        }
      } else {
        opts.push(opt('Road', seg([['street', 'Town street', `${ROAD_TYPES.street.speed} km/h · sidewalks`], ['road', 'Country road', `${ROAD_TYPES.road.speed} km/h`]], T.roadType, (v) => { T.roadType = v; redo(); })));
      }
      opts.push(opt('End', stepper(fmtHeight(T.heightOffset), () => T.adjustHeight(-0.5), () => T.adjustHeight(0.5), 'End height: bridges / cuttings / tunnels · [ / ] or PgUp / PgDn')));
      // elevated / underground lines cross everything over / under by themselves
      if (!T.railBuild || T.railLevel === 'ground') opts.push(opt('Cross', seg([
        ['auto', 'Auto', 'By terrain and speed'],
        ['over', 'Overpass', 'Build above the line being crossed'],
        ['under', 'Underpass', 'Build below the line being crossed'],
        ['level', 'Level', 'Road level crossing: trains ≤160 km/h'],
      ], T.crossing, (v) => { T.crossing = v; redo(); })));
      if (T.start) opts.push(h('button', { class: 'btn sm', onclick: () => T.cancel() }, icon('close', 14), 'End chain'));
    } else if (t === 'electrify') {
      opts.push(h('div', { class: 'tc-spec' }, icon('bolt', 14), h('span', null, 'Overhead wire ', h('b', null, `${fmtMoney(ELECTRIFY.costPerUnit * 100)}/km`), ' · for electric locomotives, EMUs, metro and light rail')));
    } else if (t === 'connect') {
      const a = T.conn ? this.ui.game.world.net.edges.get(T.conn.edge) : undefined;
      if (a) opts.push(h('span', { class: 'muted' }, 'First track selected'), h('button', { class: 'btn sm', 'data-key': 'Esc', onclick: () => T.clearConn() }, icon('close', 14), 'Pick again'));
      else opts.push(h('span', { class: 'muted' }, 'Pick the first track'));
    } else if (t === 'relevel') {
      opts.push(this.levelOpts(T.relevelTo, T.levelHeight, T.levelDepth, (lv) => { T.relevelTo = lv; redo(); }, (hh) => { T.levelHeight = hh; redo(); }, (d) => { T.levelDepth = d; redo(); }, ['Ground', 'Lift', 'Sink']));
    } else if (t === 'signal') {
      opts.push(opt('Mode', seg([['place', 'Place'], ['remove', 'Remove']], T.signalMode, (v) => { T.signalMode = v; redo(); })));
      opts.push(opt('Type', seg([['oneway', 'One-way', 'One direction; double track'], ['twoway', 'Two-way', 'Both directions; single track with passing loops']], T.signalKind, (v) => { T.signalKind = v; redo(); })));
      opts.push(opt('Kind', seg([['block', 'Block', 'Spaces trains on open line'], ['path', 'Path', 'Junctions and station entries: path to the next signal must be free']], T.signalClass, (v) => { T.signalClass = v; redo(); })));
      if (T.signalKind === 'oneway') opts.push(toggle('Passable from behind', T.signalPass, (v) => { T.signalPass = v; redo(); }, 'Allows reverse-direction trains'));
      opts.push(opt('Spacing', seg<number>([[25, '250 m'], [50, '500 m'], [100, '1 km']], T.signalSpacing, (v) => { T.signalSpacing = v; redo(); })));
      opts.push(h('button', { class: 'btn sm', 'data-tip': 'Preview signals for your railway', onclick: () => this.ui.openAutoSignal() }, icon('signal', 14), 'Auto-signal railway…'));
    } else if (t === 'double') {
      opts.push(opt('Side', seg([['auto', 'Auto', 'Right first, then left if blocked'], ['right', 'Right'], ['left', 'Left']], T.doubleSide, (v) => { T.doubleSide = v; redo(); })));
      opts.push(toggle('Directional', T.directional, (v) => { T.directional = v; redo(); }, 'One way per track · signals · crossovers before stations'));
      if (T.directional) opts.push(opt('Run on', seg<string>([['right', 'Right'], ['left', 'Left']], T.rightHand ? 'right' : 'left', (v) => { T.rightHand = v === 'right'; redo(); })));
    } else if (t === 'entrance') {
      const st = T.entranceStation != null ? this.ui.game.stations.get(T.entranceStation) : undefined;
      const r = st?.rail;
      opts.push(h('span', { class: 'chip', style: '--c:var(--station)' }, st?.name ?? '—'), h('span', { class: 'muted' }, r ? `${r.entrances.length} entrance${r.entrances.length === 1 ? '' : 's'}` : ''));
      if (r?.level === 'ground') {
        const label: Record<string, string> = { hall: 'Side hall', footbridge: 'Footbridge', underpass: 'Underpass', gate: 'End gate' };
        opts.push(opt('Type', seg<EntranceKind>(GROUND_ENTRANCES.map((k) => [k, label[k], `${ENTRANCE_TYPES[k].desc} · ${fmtMoney(entranceCost(k, r))} · upkeep ${fmtMoney(ENTRANCE_TYPES[k].upkeep)} a year`]), T.entranceKind, (v) => { T.entranceKind = v; redo(); })));
      }
      opts.push(h('button', { class: 'btn sm primary', onclick: () => { const id = T.entranceStation; T.setTool('inspect'); if (id != null) this.ui.openStation(id); } }, icon('check', 14), 'Done'));
    } else if (T.stationTool) {
      if (T.relocating != null) {
        const st = this.ui.game.stations.get(T.relocating);
        opts.push(h('span', { class: 'chip', style: '--c:var(--station)' }, icon('move', 13), `Moving ${st?.name ?? 'station'}`), h('button', { class: 'btn sm', onclick: () => T.setTool('inspect') }, 'Cancel'));
      }
      const onLine = T.stationOnLine && T.relocating == null;
      if (t === 'metro-station') {
        const styles: [string, string, string?][] = [['metro', 'Metro', 'Screen doors · side platforms · underground default'], ['lightrail', 'Light rail', 'Short side platforms · shelter · ground default']];
        opts.push(opt('Station style', seg(styles, T.stationType, (v) => { this.setStationType(v); redo(); })));
      }
      opts.push(opt('Level', seg<StationLevel>([['ground', onLine ? 'As the line' : 'Ground', onLine ? 'Matches the line’s level' : undefined], ['elevated', 'Elevated', 'Viaduct · little land use · extra cost'], ['underground', 'Underground', 'Surface entrances only · extra cost']], T.stationLevel, (v) => { T.stationLevel = v; redo(); })));
      if (T.stationLevel === 'elevated') opts.push(opt('Height', stepper(`${Math.round(T.stationHeight * 10)} m`, () => { T.stationHeight = Math.max(STATION_HEIGHT.min, +(T.stationHeight - 0.3).toFixed(1)); redo(); }, () => { T.stationHeight = Math.min(STATION_HEIGHT.max, +(T.stationHeight + 0.3).toFixed(1)); redo(); }, 'Deck height above highest ground')));
      if (T.stationLevel === 'underground') opts.push(opt('Depth', stepper(`${Math.round(T.stationDepth * 10)} m`, () => { T.stationDepth = Math.max(STATION_DEPTH.min, +(T.stationDepth - 0.3).toFixed(1)); redo(); }, () => { T.stationDepth = Math.min(STATION_DEPTH.max, +(T.stationDepth + 0.3).toFixed(1)); redo(); }, 'Platform depth below the ground')));
      if (!onLine) opts.push(this.styleOpts());
      if (T.relocating == null) opts.push(opt('Place', seg([['free', 'Anywhere', 'Auto-aligns with nearby track ends'], ['line', 'On a line', 'Insert into your track; trains keep running']], T.stationOnLine ? 'line' : 'free', (v) => { T.stationOnLine = v === 'line'; redo(); })));
      opts.push(opt('Through', stepper(String(T.stationThrough), () => { T.stationThrough = Math.max(0, T.stationThrough - 1); redo(); }, () => { T.stationThrough = Math.min(2, T.stationThrough + 1); redo(); }, 'Platform-free tracks for non-stopping trains'),
        T.stationThrough ? seg([['middle', 'Middle', 'Between side platforms'], ['outer', 'Outer', 'Outside the island platforms']], T.throughMode, (v) => { T.throughMode = v; redo(); }) : null));
      opts.push(opt('Length', stepper(`${T.stationLen * 10} m`, () => { T.stationLen = Math.max(4, T.stationLen - 2); redo(); }, () => { T.stationLen = Math.min(40, T.stationLen + 2); redo(); })));
      opts.push(opt('Tracks', stepper(String(T.stationTracks), () => { T.stationTracks = Math.max(1, T.stationTracks - 1); redo(); }, () => { T.stationTracks = Math.min(8, T.stationTracks + 1); redo(); }, 'Platform tracks (up to 8)')));
      opts.push(opt('Rotate', h('div', { class: 'inline' }, h('button', { class: 'ibtn sm', 'data-tip': 'Rotate left', 'data-key': 'Shift R', 'aria-label': 'Rotate left', onclick: () => T.rotate(-1) }, icon('rotl', 16)), h('span', { class: 'stp-v' }, `${Math.round((T.stationAngle * 180) / Math.PI)}°`), h('button', { class: 'ibtn sm', 'data-tip': 'Rotate right', 'data-key': 'R', 'aria-label': 'Rotate right', onclick: () => T.rotate(1) }, icon('rotr', 16)))));
      opts.push(toggle('Align to track', T.autoAlign, (v) => { T.autoAlign = v; redo(); }));
    } else if (t === 'depot-rail' || t === 'depot-road' || t === 'depot-tram') {
      if (T.relocatingDepot != null) opts.push(h('span', { class: 'chip', style: `--c:${TOOL_META[t].color}` }, icon('move', 13), 'Moving depot'), h('button', { class: 'btn sm', onclick: () => T.setTool('inspect') }, 'Cancel'));
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
    // Keep the everyday controls visible; fold the rest only inside the small-screen media query.
    const primary = T.stationTool ? ['Length', 'Tracks', 'Rotate'] : T.railBuild ? ['Tracks'] : t === 'signal' ? ['Mode', 'Type'] : [];
    const fold = T.stationTool || T.building || t === 'signal' || t === 'double' || t === 'relevel';
    if (fold) for (const option of opts) {
      const label = option.querySelector('.opt-l')?.textContent ?? '';
      option.classList.toggle('tc-secondary', !option.classList.contains('typepick') && !primary.includes(label) && !option.classList.contains('btn'));
    }
    const help = this.helpOpen
      ? h('div', { class: 'tc-help' }, h('p', null, TOOL_INFO[t].hint), keys.length ? h('div', { class: 'tc-keys' }, keys.map(([ks, what]) => h('span', null, ks.map((k) => kbd(k)), what))) : null)
      : h('div', { class: 'tc-desc', title: TOOL_INFO[t].hint }, TOOL_SHORT[t] ?? TOOL_INFO[t].hint);
    const warnings = T.constructionWarnings;
    add(card,
      h('div', { class: 'tc-head' }, h('span', { class: 'tc-dot' }), h('span', { class: 'tc-title' }, TOOL_INFO[t].name),
        fold ? h('button', { class: 'ibtn sm tc-details-toggle', 'data-tip': this.detailsOpen ? 'Collapse details' : 'More options',
          'aria-label': this.detailsOpen ? 'Collapse tool details' : 'Expand tool details', 'aria-expanded': String(this.detailsOpen),
          onclick: () => { this.detailsOpen = !this.detailsOpen; this.renderCard(); } }, icon(this.detailsOpen ? 'chevd' : 'chevr', 16)) : null,
        h('button', { class: 'ibtn sm' + (this.helpOpen ? ' on' : ''), 'data-tip': this.helpOpen ? 'Hide help' : 'Help & keys', 'aria-label': 'Help', 'aria-expanded': this.helpOpen ? 'true' : 'false', onclick: () => { this.helpOpen = !this.helpOpen; this.renderCard(); } }, icon('help', 16)),
        h('button', { class: 'ibtn sm', 'data-tip': 'Close tool', 'data-key': 'Esc', 'data-sfx': 'none', 'aria-label': 'Close tool', onclick: () => T.setTool('inspect') }, icon('close', 16))),
      help,
      T.stationTool ? h('div', { class: 'tc-compact-note' }, `${T.stationTracks} platform track${T.stationTracks === 1 ? '' : 's'} · ${T.stationLen * 10} m · ${T.stationLevel} · ${T.stationStyle === 'auto' ? 'auto building' : STYLE_SHORT[T.stationStyle] ?? T.stationStyle}`) : null,
      opts.length ? h('div', { class: 'tc-opts' }, opts) : null,
      warnings.length ? h('div', { class: 'tc-warnings', role: 'status', 'aria-live': 'polite' }, warnings.map((w) => h('div', { class: 'tc-warning' }, icon('warning', 14), h('span', null, w)))) : null,
    );
    this.placeCard();
  }
}

/** Short names of the building styles (style picker). */
const STYLE_SHORT: Record<string, string> = { none: 'None', shelter: 'Halt', classic: 'Building', brick: 'Brick', modern: 'Modern', concourse: 'Concourse', terminal: 'Terminal' };

/** Unified track limits, wire state and estimated cost per km at the level. */
function typeSpec(type: string, level: LineLevel, height: number, depth: number): HTMLElement {
  const tt = TRACK_TYPES[type] ?? TRACK_TYPES.standard;
  const c = typeCostKm(type, level, height, depth);
  return h('div', { class: 'tc-spec' },
    h('span', null, 'R ≥ ', h('b', null, `${tt.minRadius * 10} m`)),
    h('span', null, 'grade ≤ ', h('b', null, fmtPct(tt.maxGrade, 1))),
    h('span', null, tt.electrified ? 'overhead wire' : 'no wire: steam & diesel'),
    h('span', { class: level !== 'ground' ? 'hot' : '' }, `≈ ${fmtMoney(c.cost)}/km per track`, level !== 'ground' ? ` (${c.factor.toFixed(1)}×)` : ''));
}
