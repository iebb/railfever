// Minimap: terrain, network, vehicles and the camera view; click to navigate.
import * as THREE from 'three';
import type { UI } from './ui';
import { h } from './dom';

export class Minimap {
  el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private img: ImageData | null = null;
  private baseTimer = 0;
  private overTimer = 0;
  private size = 0;
  visible = true;
  private dragging = false;
  private readonly px = 210;

  constructor(private ui: UI) {
    this.base = h('canvas', { class: 'mm-base' }) as HTMLCanvasElement;
    this.over = h('canvas', { class: 'mm-over' }) as HTMLCanvasElement;
    const toggle = h('button', { class: 'mm-toggle', title: 'Toggle minimap (M)', onclick: () => this.toggle() }, '▾');
    this.el = h('div', { class: 'minimap' }, this.base, this.over, toggle);
    this.base.width = this.base.height = this.over.width = this.over.height = this.px;
    ui.root.appendChild(this.el);
    const nav = (e: PointerEvent) => {
      const r = this.over.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.size;
      const z = ((e.clientY - r.top) / r.height) * this.size;
      this.ui.renderer.controls.jumpTo(x, z);
    };
    this.over.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; this.dragging = true; nav(e); e.preventDefault(); });
    window.addEventListener('pointermove', (e) => { if (this.dragging) nav(e); });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'm' || e.key === 'M') this.toggle();
    });
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('collapsed', !this.visible);
  }

  reset() { this.img = null; this.baseTimer = 0; }

  private drawBase() {
    const g = this.ui.game;
    const w = g.world;
    const s = w.size;
    this.size = s;
    if (!this.img || this.img.width !== s) this.img = new ImageData(s, s);
    const d = this.img.data;
    let maxH = 1;
    for (let i = 0; i < w.hgt.length; i++) if (w.hgt[i] > maxH) maxH = w.hgt[i];
    for (let z = 0; z < s; z++) for (let x = 0; x < s; x++) {
      const t = z * s + x;
      const i = t * 4;
      let r: number, gg: number, b: number;
      const hmax = w.tileMax(x, z);
      if (hmax <= 0) {
        const depth = -w.tileMin(x, z);
        r = 40 - depth * 6; gg = 105 - depth * 12; b = 150 - depth * 10;
      } else {
        const f = Math.min(1, hmax / maxH);
        r = 105 + f * 70; gg = 150 + f * 10 - f * f * 40; b = 75 + f * 40;
        if (f > 0.8) { r = 200 + f * 40; gg = 200 + f * 40; b = 205 + f * 40; }
        const tr = w.trees[t] & 15;
        if (tr) { r -= 25 + tr * 8; gg -= 10 + tr * 6; b -= 20 + tr * 5; }
      }
      if (w.road[t]) { r = 95; gg = 95; b = 100; }
      if (w.building[t] >= 0) { r = 196; gg = 120; b = 96; }
      if (w.rail[t]) { r = 120; gg = 70; b = 40; }
      if (w.span[t] >= 0) { const st = w.structures.get(w.span[t]); if (st && st.kind === 'bridge') { r = 150; gg = 110; b = 80; } }
      if (w.station[t] >= 0) { r = 255; gg = 190; b = 60; }
      if (w.depot[t] >= 0) { r = 230; gg = 230; b = 230; }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = s;
    tmp.getContext('2d')!.putImageData(this.img, 0, 0);
    const ctx = this.base.getContext('2d')!;
    ctx.imageSmoothingEnabled = s > this.px;
    ctx.clearRect(0, 0, this.px, this.px);
    ctx.drawImage(tmp, 0, 0, this.px, this.px);
  }

  private ray = new THREE.Raycaster();
  private drawOverlay() {
    const g = this.ui.game;
    const ctx = this.over.getContext('2d')!;
    const k = this.px / g.world.size;
    ctx.clearRect(0, 0, this.px, this.px);
    // line routes through their stations
    for (const l of g.lines.map.values()) {
      if (l.stops.length < 2) continue;
      ctx.strokeStyle = l.color;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      l.stops.forEach((sid, i) => { const st = g.stations.get(sid); if (!st) return; const X = (st.x + 0.5) * k, Y = (st.z + 0.5) * k; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      if (l.stops.length > 2) ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // vehicles
    const p = { x: 0, y: 0, z: 0 };
    for (const v of g.vehicles.map.values()) {
      if (!v.worldPos(p)) continue;
      ctx.fillStyle = v.kind === 'train' ? '#ffffff' : '#5ac8fa';
      ctx.fillRect(p.x * k - 1.5, p.z * k - 1.5, 3, 3);
    }
    // camera view
    const cam = this.ui.renderer.camera;
    const pts: [number, number][] = [];
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
      const o = this.ray.ray.origin, dd = this.ray.ray.direction;
      let t = dd.y < -1e-3 ? (o.y - 0.5) / -dd.y : 400;
      t = Math.min(t, 400);
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
    if (!this.visible) return;
    this.baseTimer -= dt;
    this.overTimer -= dt;
    if (this.baseTimer <= 0 || this.size !== this.ui.game.world.size) { this.baseTimer = 2.5; this.drawBase(); }
    if (this.overTimer <= 0) { this.overTimer = 0.15; this.drawOverlay(); }
  }
}
