// Minimap: terrain, network (Bezier strokes), towns, stations, vehicles and the camera view; click/drag to navigate.
import * as THREE from 'three';
import type { UI } from './ui';
import { h } from './dom';
import { WATER_Y } from '../game/constants';

export class Minimap {
  el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private net: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private baseTimer = 0;
  private overTimer = 0;
  private netTimer = 0;
  private netVer = -1;
  private heightsVer = -1;
  private size = 0;
  visible = true;
  private dragging = false;
  private readonly px = 210;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(private ui: UI) {
    this.base = h('canvas', { class: 'mm-base' });
    this.net = h('canvas', { class: 'mm-net' });
    this.over = h('canvas', { class: 'mm-over' });
    const toggle = h('button', { class: 'mm-toggle', title: 'Toggle minimap (M)', onclick: () => this.toggle() }, '▾');
    this.el = h('div', { class: 'minimap' }, this.base, this.net, this.over, toggle);
    for (const c of [this.base, this.net, this.over]) c.width = c.height = this.px;
    ui.root.appendChild(this.el);
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
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) this.toggle();
    });
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('collapsed', !this.visible);
  }

  reset() { this.baseTimer = 0; this.netTimer = 0; this.netVer = -1; this.heightsVer = -1; }

  /** Terrain colours from heights and water, trees and buildings. */
  private drawBase() {
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
        r = 52 - depth * 22; gg = 108 - depth * 40; b = 150 - depth * 30;
      } else {
        const f = Math.min(1, hh / maxH);
        r = 108 + f * 70; gg = 150 + f * 14 - f * f * 50; b = 78 + f * 40;
        if (f > 0.82) { r = 200 + f * 40; gg = 200 + f * 40; b = 206 + f * 40; }
        // hill shading
        const sx = w.heightAt(wx + k, wz) - hh;
        const shade = Math.max(-26, Math.min(26, -sx * 14 / k));
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
    for (const t of w.trees) if (t) dot(t.x, t.z, 48, 92, 46, tmix);
    for (const bd of w.buildings.values()) dot(bd.x, bd.z, 200, 118, 96, 0.85);
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = N;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    const ctx = this.base.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, this.px, this.px);
    ctx.drawImage(tmp, 0, 0, this.px, this.px);
  }

  /** Roads (grey) and rail (dark / company colour) drawn as Bezier strokes, plus stations. */
  private drawNetwork() {
    const g = this.ui.game;
    const net = g.world.net;
    this.netVer = g.networkVersion;
    const k = this.px / g.world.size;
    const ctx = this.net.getContext('2d')!;
    ctx.clearRect(0, 0, this.px, this.px);
    ctx.lineCap = 'round';
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
    stroke('road', (o) => (o < 0 ? 'rgba(92,92,98,0.95)' : 'rgba(120,120,128,0.95)'), Math.max(1, k * 0.9));
    stroke('rail', (o) => (o === 0 ? '#3a2a20' : g.company(o).color), Math.max(1.2, k * 1.1));
    for (const st of g.stations.map.values()) {
      ctx.fillStyle = g.company(st.owner).color;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(st.x * k - 2.5, st.z * k - 2.5, 5, 5);
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawOverlay() {
    const g = this.ui.game;
    const ctx = this.over.getContext('2d')!;
    const k = this.px / g.world.size;
    ctx.clearRect(0, 0, this.px, this.px);
    // vehicles
    const p = { x: 0, y: 0, z: 0 };
    for (const v of g.vehicles.map.values()) {
      if (!v.worldPos(p)) continue;
      ctx.fillStyle = v.kind === 'train' ? '#ffffff' : '#5ac8fa';
      ctx.fillRect(p.x * k - 1.5, p.z * k - 1.5, 3, 3);
    }
    // camera view: frustum corners on the ground plane
    const cam = this.ui.renderer.camera;
    const pts: [number, number][] = [];
    const gy = this.ui.renderer.controls.focus?.y ?? 0;
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.ray.setFromCamera(this.ndc.set(nx, ny), cam);
      const o = this.ray.ray.origin, dd = this.ray.ray.direction;
      let t = dd.y < -1e-3 ? (o.y - gy) / -dd.y : 900;
      t = Math.min(t, 900);
      pts.push([(o.x + dd.x * t) * k, (o.z + dd.z * t) * k]);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  update(dt: number) {
    if (!this.visible || !this.ui.game) return;
    const w = this.ui.game.world;
    this.baseTimer -= dt;
    this.netTimer -= dt;
    this.overTimer -= dt;
    if (this.size !== w.size || (this.baseTimer <= 0 && this.heightsVer !== w.heightsVersion) || this.baseTimer < -20) { this.baseTimer = 4; this.drawBase(); }
    if (this.netTimer <= 0 && this.netVer !== this.ui.game.networkVersion) { this.netTimer = 0.8; this.drawNetwork(); }
    if (this.overTimer <= 0) { this.overTimer = 0.15; this.drawOverlay(); }
  }
}
