// HTML labels for towns and stations projected onto the 3D view (distance fading, terrain occlusion).
import * as THREE from 'three';
import type { Game } from '../game/game';
import { WATER_Y } from '../game/constants';

interface Label { el: HTMLDivElement; lt: HTMLSpanElement; ls: HTMLSpanElement; text: string; sub: string; bg: string; op: number; shown: boolean }

function textColorFor(bg: string): string {
  const c = new THREE.Color(bg);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return lum > 0.55 ? '#141a21' : '#ffffff';
}

export class Labels {
  container: HTMLDivElement;
  private towns = new Map<number, Label>();
  private stations = new Map<number, Label>();
  onClickTown: (id: number) => void = () => {};
  onClickStation: (id: number) => void = () => {};
  visible = true;
  /** stop marks of open lines: station id -> colour and stop numbers (shown in front of the name) */
  marks = new Map<number, { color: string; text: string }>();
  private hl: number | null = null;
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'labels';
    parent.appendChild(this.container);
  }

  /** Emphasise one station label (e.g. the selected station), or none. */
  highlight(stationId: number | null) { this.hl = stationId; }

  clear() {
    this.container.innerHTML = '';
    this.towns.clear();
    this.stations.clear();
    this.marks.clear();
    this.hl = null;
  }

  private make(cls: string, onClick: () => void): Label {
    const el = document.createElement('div');
    el.className = 'label ' + cls;
    const lt = document.createElement('span'); lt.className = 'lt';
    const ls = document.createElement('span'); ls.className = 'ls';
    el.append(lt, ls);
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    el.style.display = 'none';
    this.container.appendChild(el);
    return { el, lt, ls, text: '', sub: '', bg: '', op: -1, shown: false };
  }

  private setText(l: Label, text: string, sub: string) {
    if (l.text !== text) { l.text = text; l.lt.textContent = text; }
    if (l.sub !== sub) { l.sub = sub; l.ls.textContent = sub; l.ls.style.display = sub ? '' : 'none'; }
  }

  update(game: Game, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number) {
    this.container.style.display = this.visible ? '' : 'none';
    if (!this.visible) return;
    const world = game.world;
    const seenT = new Set<number>();
    const townMax = Math.max(180, camDist * 3.2);
    for (const t of game.towns.list) {
      seenT.add(t.id);
      let l = this.towns.get(t.id);
      if (!l) { const id = t.id; l = this.make('town', () => this.onClickTown(id)); this.towns.set(t.id, l); }
      this.setText(l, t.name, t.pop.toLocaleString('en-US') + (t.served > 0 ? ' ▲' : ''));
      const y = Math.max(world.heightAt(t.x, t.z), WATER_Y) + 3 + Math.min(5, t.pop / 2500);
      this.place(game, l, t.x, y, t.z, camera, w, h, townMax, 1);
    }
    const seenS = new Set<number>();
    const stMax = camDist < 160 ? Math.max(60, camDist * 2.6) : 0;
    for (const s of game.stations.map.values()) {
      seenS.add(s.id);
      let l = this.stations.get(s.id);
      if (!l) { const id = s.id; l = this.make('station', () => this.onClickStation(id)); this.stations.set(s.id, l); }
      const served = game.lines.stationServed(s.id);
      const mk = this.marks.get(s.id);
      const isHl = this.hl === s.id;
      this.setText(l, mk ? `${mk.text} ${s.name}` : s.name, served ? `${s.waitingTotal} waiting` : 'no service');
      l.el.classList.toggle('unserved', !served && !mk && !isHl);
      const bg = mk ? mk.color : game.company(s.owner).color;
      if (l.bg !== bg) { l.bg = bg; l.lt.style.background = bg; l.lt.style.color = textColorFor(bg); }
      l.lt.style.boxShadow = isHl ? '0 0 0 2px #fff, 0 2px 10px rgba(0,0,0,0.45)' : '';
      const y = s.rail ? s.rail.y + 1.0 : Math.max(world.heightAt(s.x, s.z), WATER_Y) + 0.8;
      this.place(game, l, s.x, y, s.z, camera, w, h, mk || isHl ? 2000 : stMax, isHl ? 1.15 : 0.9);
    }
    for (const [id, l] of this.towns) if (!seenT.has(id)) { l.el.remove(); this.towns.delete(id); }
    for (const [id, l] of this.stations) if (!seenS.has(id)) { l.el.remove(); this.stations.delete(id); }
  }

  /** Is the straight line from the camera to the point blocked by terrain? */
  private occluded(game: Game, camera: THREE.Camera, x: number, y: number, z: number): boolean {
    const w = game.world;
    const c = camera.position;
    for (let i = 1; i < 12; i++) {
      const f = i / 12;
      const px = c.x + (x - c.x) * f, pz = c.z + (z - c.z) * f;
      if (!w.inside(px, pz)) continue;
      if (c.y + (y - c.y) * f < w.heightAt(px, pz) - 0.05) return true;
    }
    return false;
  }

  private place(game: Game, l: Label, x: number, y: number, z: number, camera: THREE.PerspectiveCamera, w: number, h: number, maxDist: number, scale: number) {
    const v = this.v.set(x, y, z);
    const d = v.distanceTo(camera.position);
    v.project(camera);
    const hide = v.z > 1 || v.x < -1.15 || v.x > 1.15 || v.y < -1.15 || v.y > 1.15 || d > maxDist || this.occluded(game, camera, x, y, z);
    if (hide) {
      if (l.shown) { l.el.style.display = 'none'; l.shown = false; }
      return;
    }
    if (!l.shown) { l.el.style.display = ''; l.shown = true; }
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    const s = Math.max(0.7, Math.min(1.1, 0.75 + (40 / Math.max(1, d)) * 0.2)) * scale;
    const op = Math.round(Math.max(0, Math.min(1, (maxDist - d) / (maxDist * 0.25))) * 20) / 20;
    if (op !== l.op) { l.op = op; l.el.style.opacity = String(op); }
    l.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%) scale(${s.toFixed(2)})`;
    l.el.style.zIndex = String(100000 - Math.round(d * 10));
  }
}
