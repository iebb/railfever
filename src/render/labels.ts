// HTML labels for towns and stations projected onto the 3D view.
import * as THREE from 'three';
import type { Game } from '../game/game';

interface Label { el: HTMLDivElement; key: string; text: string; sub: string }

export class Labels {
  container: HTMLDivElement;
  private towns = new Map<number, Label>();
  private stations = new Map<number, Label>();
  onClickTown: (id: number) => void = () => {};
  onClickStation: (id: number) => void = () => {};
  visible = true;
  /** stations to highlight (e.g. stops of an open line): id -> [colour, stop numbers] */
  highlight = new Map<number, { color: string; text: string }>();
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'labels';
    parent.appendChild(this.container);
  }

  clear() {
    this.container.innerHTML = '';
    this.towns.clear();
    this.stations.clear();
  }

  private make(cls: string, onClick: () => void): Label {
    const el = document.createElement('div');
    el.className = 'label ' + cls;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    this.container.appendChild(el);
    return { el, key: '', text: '', sub: '' };
  }

  private setText(l: Label, text: string, sub: string) {
    if (l.text === text && l.sub === sub) return;
    l.text = text; l.sub = sub;
    l.el.innerHTML = `<span class="lt">${text}</span>${sub ? `<span class="ls">${sub}</span>` : ''}`;
  }

  update(game: Game, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number) {
    this.container.style.display = this.visible ? '' : 'none';
    if (!this.visible) return;
    const world = game.world;
    const seenT = new Set<number>();
    for (const t of game.towns.list) {
      seenT.add(t.id);
      let l = this.towns.get(t.id);
      if (!l) { l = this.make('town', () => this.onClickTown(t.id)); this.towns.set(t.id, l); }
      this.setText(l, t.name, t.pop.toLocaleString('en-US') + (t.served > 0 ? ' ▲' : ''));
      this.place(l, t.x + 0.5, world.heightAt(t.x + 0.5, t.z + 0.5) + 1.2 + Math.min(1.6, t.pop / 3000), t.z + 0.5, camera, w, h, 400, 1);
    }
    const seenS = new Set<number>();
    for (const s of game.stations.map.values()) {
      seenS.add(s.id);
      let l = this.stations.get(s.id);
      if (!l) { l = this.make('station', () => this.onClickStation(s.id)); this.stations.set(s.id, l); }
      const served = game.lines.stationServed(s.id);
      const hl = this.highlight.get(s.id);
      this.setText(l, hl ? `${hl.text} ${s.name}` : s.name, served ? `${s.waitingTotal} waiting` : 'no service');
      l.el.classList.toggle('unserved', !served && !hl);
      const lt = l.el.firstElementChild as HTMLElement | null;
      if (lt) lt.style.background = hl ? hl.color : '';
      this.place(l, s.x + 0.5, world.heightAt(s.x + 0.5, s.z + 0.5) + 0.75, s.z + 0.5, camera, w, h, hl ? 400 : camDist < 70 ? 140 : 0, 0.9);
    }
    for (const [id, l] of this.towns) if (!seenT.has(id)) { l.el.remove(); this.towns.delete(id); }
    for (const [id, l] of this.stations) if (!seenS.has(id)) { l.el.remove(); this.stations.delete(id); }
  }

  private place(l: Label, x: number, y: number, z: number, camera: THREE.PerspectiveCamera, w: number, h: number, maxDist: number, scale: number) {
    const v = this.v.set(x, y, z);
    const d = v.distanceTo(camera.position);
    v.project(camera);
    if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2 || d > maxDist) {
      if (l.el.style.display !== 'none') l.el.style.display = 'none';
      return;
    }
    if (l.el.style.display === 'none') l.el.style.display = '';
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    const s = Math.max(0.65, Math.min(1.1, (30 / d) * scale + 0.5));
    l.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%) scale(${s.toFixed(2)})`;
    l.el.style.zIndex = String(10000 - Math.round(d * 10));
  }
}
