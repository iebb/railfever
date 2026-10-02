// Minimap card: terrain (pre-rendered offscreen), network & stations & town names (redrawn on network
// changes), vehicles and the camera view (overlay); layer toggles; click / drag to move the camera.
import * as THREE from 'three';
import type { UI } from './ui';
import { h, icon } from './dom';
import { WATER_Y } from '../game/constants';
import { loadFonts } from './fonts';
import type { MapMode } from './mapmodes';
import { servedColor, hexCss } from './mapmodes';
import { PLAYER } from '../game/game';
import { catchShapes, catchColor } from './gameapi';

export class Minimap {
  el: HTMLDivElement;
  private view: HTMLDivElement;
  private base: HTMLCanvasElement;
  private net: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private terrain: HTMLCanvasElement | null = null;
  private baseTimer = 0;
  private overTimer = 0;
  private netTimer = 0;
  private netVer = -1;
  private heightsVer = -1;
  private size = 0;
  private dpr = 1;
  visible = true;
  layers = { network: true, vehicles: true, names: true };
  private layerBtns: Record<string, HTMLButtonElement> = {};
  private mode: MapMode = 'none';
  private modeBtns: Record<string, HTMLButtonElement> = {};
  private dragging = false;
  private readonly px = 216;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(private ui: UI) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.base = h('canvas', { class: 'mm-base' });
    this.net = h('canvas', { class: 'mm-net' });
    this.over = h('canvas', { class: 'mm-over', 'aria-label': 'Minimap: click to move the camera' });
    for (const c of [this.base, this.net, this.over]) c.width = c.height = Math.round(this.px * this.dpr);
    this.view = h('div', { class: 'mm-view' }, this.base, this.net, this.over);
    const layer = (key: keyof Minimap['layers'], ic: string, title: string) => {
      const b = h('button', { class: 'ibtn sm mm-layer on', 'data-tip': title, 'aria-label': title, 'aria-pressed': 'true', onclick: () => {
        this.layers[key] = !this.layers[key];
        b.classList.toggle('on', this.layers[key]);
        b.setAttribute('aria-pressed', String(this.layers[key]));
        this.netVer = -1; this.netTimer = 0; this.overTimer = 0;
      } }, icon(ic, 15));
      this.layerBtns[key] = b;
      return b;
    };
    const collapse = h('button', { class: 'ibtn sm', 'data-tip': 'Collapse map', 'data-key': 'M', 'aria-label': 'Collapse minimap', onclick: () => this.toggle() }, icon('chevd', 15));
    const modeBtn = (m: 'lines' | 'demand' | 'catchment', ic: string, tip: string) => (this.modeBtns[m] = h('button', { class: 'ibtn sm mm-layer', 'data-tip': tip, 'data-key': m === 'lines' ? 'M' : m === 'demand' ? 'P' : 'O', 'data-sfx': 'none', 'aria-label': tip, onclick: () => this.ui.mapModes.toggle(m) }, icon(ic, 15)));
    this.el = h('div', { class: 'minimap glass' },
      h('div', { class: 'mm-head' }, h('span', { class: 'mm-title' }, 'Map'), layer('network', 'rail', 'Network'), layer('vehicles', 'train', 'Vehicles'), layer('names', 'towns', 'Town names'), modeBtn('lines', 'map', 'Lines map'), modeBtn('demand', 'demand', 'Demand'), modeBtn('catchment', 'catchment', 'Catchment'), collapse),
      this.view);
    ui.root.appendChild(this.el);
    loadFonts().then(() => { this.netVer = -1; });
    const nav = (e: PointerEvent) => {
      if (!this.size) return;
      const r = this.over.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.size;
      const z = ((e.clientY - r.top) / r.height) * this.size;
      this.ui.renderer.controls.jumpTo(Math.max(0, Math.min(this.size, x)), Math.max(0, Math.min(this.size, z)));
    };
    this.over.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; this.dragging = true; nav(e); e.preventDefault(); });
    window.addEventListener('pointermove', (e) => { if (this.dragging) nav(e); });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || this.ui.titleOpen) return;
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) this.toggle();
    });
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('collapsed', !this.visible);
    if (this.visible) this.reset();
  }

  reset() { this.baseTimer = 0; this.netTimer = 0; this.netVer = -1; this.heightsVer = -1; this.terrain = null; }

  /** Map view (lines / demand) drawn on the overlay layer. */
  setMapMode(m: MapMode) {
    this.mode = m;
    this.overTimer = 0;
    for (const [k, b] of Object.entries(this.modeBtns)) b.classList.toggle('on', k === m);
  }

  /** Terrain colours from heights and water with hill shading, trees and buildings (offscreen, once). */
  private renderTerrain() {
    const g = this.ui.game;
    const w = g.world;
    const s = w.size;
    this.size = s;
    this.heightsVer = w.heightsVersion;
    const N = Math.min(s, 384);
    const k = s / N;
    const img = new ImageData(N, N);
    const d = img.data;
    let maxH = 1;
    for (let i = 0; i < w.h.length; i += 7) if (w.h[i] > maxH) maxH = w.h[i];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const wx = (x + 0.5) * k, wz = (z + 0.5) * k;
      const hh = w.heightAt(wx, wz);
      let r: number, gg: number, b: number;
      if (hh < WATER_Y) {
        const depth = Math.min(1, -hh / 3);
        r = 38 - depth * 16; gg = 78 - depth * 26; b = 112 - depth * 24;
      } else {
        const f = Math.min(1, hh / maxH);
        r = 92 + f * 60; gg = 116 + f * 22 - f * f * 34; b = 74 + f * 34;
        if (f > 0.82) { r = 190 + f * 40; gg = 192 + f * 40; b = 198 + f * 40; }
        const sx = w.heightAt(wx + k, wz) - hh, sz = w.heightAt(wx, wz + k) - hh;
        const shade = Math.max(-24, Math.min(24, (-sx - sz * 0.6) * 12 / k));
        r += shade; gg += shade; b += shade;
      }
      const i = (z * N + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    const dot = (wx: number, wz: number, r: number, gg: number, b: number, mix: number) => {
      const x = Math.floor(wx / k), z = Math.floor(wz / k);
      if (x < 0 || z < 0 || x >= N || z >= N) return;
      const i = (z * N + x) * 4;
      d[i] += (r - d[i]) * mix; d[i + 1] += (gg - d[i + 1]) * mix; d[i + 2] += (b - d[i + 2]) * mix;
    };
    const tmix = Math.min(0.5, 0.18 * k * k);
    for (const t of w.trees) if (t) dot(t.x, t.z, 40, 74, 40, tmix);
    for (const bd of w.buildings.values()) dot(bd.x, bd.z, 214, 196, 176, 0.8);
    const tmp = this.terrain ?? document.createElement('canvas');
    tmp.width = tmp.height = N;
    tmp.getContext('2d')?.putImageData(img, 0, 0);
    this.terrain = tmp;
  }

  private drawBase() {
    if (!this.terrain || this.heightsVer !== this.ui.game.world.heightsVersion) this.renderTerrain();
    const ctx = this.base.getContext('2d');
    if (!ctx || !this.terrain) return;
    const P = this.base.width;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, P, P);
    ctx.drawImage(this.terrain, 0, 0, P, P);
  }

  /** Roads (grey), rail (company colours), stations and town names. */
  private drawNetwork() {
    const g = this.ui.game;
    const net = g.world.net;
    this.netVer = g.networkVersion;
    const P = this.net.width;
    const k = P / g.world.size;
    const ctx = this.net.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, P, P);
    ctx.lineCap = 'round';
    if (this.layers.network) {
      const stroke = (kind: 'road' | 'rail', color: (owner: number) => string, width: number) => {
        const groups = new Map<string, Path2D>();
        for (const e of net.edges.values()) {
          if (e.kind !== kind) continue;
          const c = color(e.owner);
          let p = groups.get(c);
          if (!p) { p = new Path2D(); groups.set(c, p); }
          const b = e.bez;
          p.moveTo(b.x0 * k, b.z0 * k);
          p.bezierCurveTo(b.x1 * k, b.z1 * k, b.x2 * k, b.z2 * k, b.x3 * k, b.z3 * k);
        }
        ctx.lineWidth = width;
        for (const [c, p] of groups) { ctx.strokeStyle = c; ctx.stroke(p); }
      };
      stroke('road', (o) => (o < 0 ? 'rgba(210,214,220,0.55)' : 'rgba(255,170,110,0.75)'), Math.max(1, k * 0.9));
      stroke('rail', (o) => g.company(o).color, Math.max(1.6, k * 1.2));
      // tram tracks in roads
      const tp = new Path2D();
      let trams = 0;
      for (const e of net.edges.values()) {
        if (!e.tram) continue;
        const b = e.bez;
        tp.moveTo(b.x0 * k, b.z0 * k);
        tp.bezierCurveTo(b.x1 * k, b.z1 * k, b.x2 * k, b.z2 * k, b.x3 * k, b.z3 * k);
        trams++;
      }
      if (trams) { ctx.lineWidth = Math.max(1.2, k * 0.7); ctx.strokeStyle = '#c084fc'; ctx.stroke(tp); }
      for (const st of g.stations.map.values()) {
        const r = 2.6 * this.dpr;
        ctx.fillStyle = '#10161f';
        ctx.fillRect(st.x * k - r - 1, st.z * k - r - 1, 2 * r + 2, 2 * r + 2);
        ctx.fillStyle = g.company(st.owner).color;
        ctx.fillRect(st.x * k - r, st.z * k - r, 2 * r, 2 * r);
      }
    }
    if (this.layers.names) {
      const fs = Math.round(11.5 * this.dpr);
      ctx.font = `700 ${fs}px "Barlow Condensed", "Inter", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      const boxes: number[][] = [];
      for (const t of [...g.towns.list].sort((a, b) => b.pop - a.pop)) {
        const txt = t.name.toUpperCase();
        const tw = ctx.measureText(txt).width;
        const x = Math.max(tw / 2 + 2, Math.min(P - tw / 2 - 2, t.x * k)), y = Math.max(fs + 2, t.z * k - 3 * this.dpr);
        const box = [x - tw / 2, y - fs, x + tw / 2, y];
        if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        boxes.push(box);
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = 'rgba(10,14,20,0.8)';
        ctx.strokeText(txt, x, y);
        ctx.fillStyle = '#eef2f7';
        ctx.fillText(txt, x, y);
      }
    }
  }

  private drawOverlay() {
    const g = this.ui.game;
    const ctx = this.over.getContext('2d');
    if (!ctx) return;
    const P = this.over.width;
    const k = P / g.world.size;
    ctx.clearRect(0, 0, P, P);
    // map views
    if (this.mode === 'demand' && this.ui.mapModes.demand?.regions?.length) {
      // districts by served share, the strongest flows between them
      const d = this.ui.mapModes.demand;
      const byId = new Map(d.regions.map((r) => [r.id, r]));
      for (const r of d.regions) {
        ctx.beginPath(); ctx.arc(r.x * k, r.z * k, Math.max(1.5 * this.dpr, r.r * k), 0, Math.PI * 2);
        ctx.globalAlpha = 0.35; ctx.fillStyle = hexCss(servedColor(r.served)); ctx.fill();
      }
      const maxT = Math.max(1, d.flows[0]?.trips ?? 1);
      ctx.lineCap = 'round';
      for (let i = Math.min(d.flows.length, 200) - 1; i >= 0; i--) {
        const f = d.flows[i];
        if (i >= 50 && !(f.served > 0.01)) continue;
        const A = byId.get(f.a), B = byId.get(f.b);
        if (!A || !B) continue;
        ctx.strokeStyle = hexCss(servedColor(f.served));
        ctx.globalAlpha = 0.3 + Math.sqrt(f.trips / maxT) * 0.65;
        ctx.lineWidth = (0.6 + Math.sqrt(f.trips / maxT) * 3.4) * this.dpr;
        ctx.beginPath(); ctx.moveTo(A.x * k, A.z * k); ctx.lineTo(B.x * k, B.z * k); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (this.mode === 'demand' && this.ui.mapModes.demand) {
      const d = this.ui.mapModes.demand;
      const towns = new Map(d.towns.map((t) => [t.id, t]));
      const maxP = Math.max(1, d.maxPotential);
      ctx.lineCap = 'round';
      // as in the 3D view: the 50 strongest connections and all served ones, the strongest drawn last
      for (let i = Math.min(d.pairs.length, 400) - 1; i >= 0; i--) {
        const p = d.pairs[i];
        if (i >= 50 && !(p.served > 0.01)) continue;
        const A = towns.get(p.a), B = towns.get(p.b);
        if (!A || !B) continue;
        ctx.strokeStyle = hexCss(servedColor(p.served));
        ctx.globalAlpha = 0.3 + Math.sqrt(p.potential / maxP) * 0.65;
        ctx.lineWidth = (0.8 + Math.sqrt(p.potential / maxP) * 4) * this.dpr;
        ctx.beginPath(); ctx.moveTo(A.x * k, A.z * k); ctx.lineTo(B.x * k, B.z * k); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const t of d.towns) {
        const f = this.ui.mapModes.shares.get(t.id) ?? 0;
        const r = (2 + Math.sqrt(t.pop) * 0.06) * this.dpr;
        ctx.fillStyle = hexCss(servedColor(f));
        ctx.beginPath(); ctx.arc(t.x * k, t.z * k, r, 0, Math.PI * 2); ctx.fill();
      }
    } else if (this.mode === 'catchment') {
      for (const st of g.stations.map.values()) {
        if (st.owner !== PLAYER) continue;
        for (const c of catchShapes(g, st, true)) {
          const col = hexCss(catchColor(c));
          ctx.beginPath(); ctx.arc(c.x * k, c.z * k, Math.max(1.5 * this.dpr, c.r * k), 0, Math.PI * 2);
          ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill();
          ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = this.dpr; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    } else if (this.mode === 'lines') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2 * this.dpr;
      for (const l of g.lines.map.values()) {
        if (l.stops.length < 2 || (!this.ui.mapModes.showAll && l.owner !== PLAYER)) continue;
        ctx.strokeStyle = l.color;
        ctx.beginPath();
        l.stops.forEach((sid, i) => { const st = g.stations.get(sid); if (!st) return; if (i) ctx.lineTo(st.x * k, st.z * k); else ctx.moveTo(st.x * k, st.z * k); });
        if (l.stops.length > 2) ctx.closePath();
        ctx.stroke();
      }
    }
    if (this.layers.vehicles) {
      const p = { x: 0, y: 0, z: 0 };
      const r = 1.6 * this.dpr;
      for (const v of g.vehicles.map.values()) {
        if (!v.worldPos(p)) continue;
        ctx.fillStyle = v.kind === 'train' ? '#ffffff' : '#ffb27a';
        ctx.fillRect(p.x * k - r, p.z * k - r, 2 * r, 2 * r);
      }
    }
    // camera view: frustum corners on the ground plane
    const cam = this.ui.renderer.camera;
    const gy = this.ui.renderer.controls.focus?.y ?? 0;
    ctx.beginPath();
    let i = 0;
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.ray.setFromCamera(this.ndc.set(nx, ny), cam);
      const o = this.ray.ray.origin, dd = this.ray.ray.direction;
      const t = Math.min(dd.y < -1e-3 ? (o.y - gy) / -dd.y : 900, 900);
      const x = (o.x + dd.x * t) * k, y = (o.z + dd.z * t) * k;
      if (i++) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,176,32,0.1)';
    ctx.fill();
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.stroke();
  }

  update(dt: number) {
    if (!this.visible || !this.ui.game) return;
    const w = this.ui.game.world;
    this.baseTimer -= dt;
    this.netTimer -= dt;
    this.overTimer -= dt;
    const stale = this.baseTimer < -30;
    if (this.size !== w.size || !this.terrain || stale || (this.baseTimer <= 0 && this.heightsVer !== w.heightsVersion)) {
      if (stale || this.size !== w.size) this.terrain = null;
      this.baseTimer = 4;
      this.drawBase();
    }
    if (this.netTimer <= 0 && this.netVer !== this.ui.game.networkVersion) { this.netTimer = 0.8; this.drawNetwork(); }
    if (this.overTimer <= 0) { this.overTimer = 0.2; this.drawOverlay(); }
  }
}
