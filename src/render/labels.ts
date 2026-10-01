// In-world signage: town name plates and station plates (company colour, pictogram, waiting count,
// stop marks of open lines). Priority-capped, decluttered, terrain-occluded; DOM writes only on change.
import * as THREE from 'three';
import type { Game } from '../game/game';
import { WATER_Y } from '../game/constants';
import { svg } from '../ui/icons';

interface Label {
  el: HTMLDivElement;
  kind: 'town' | 'stn';
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  ico: HTMLSpanElement | null;
  mark: HTMLSpanElement | null;
  text: string; subText: string; markText: string; markColor: string; icoKind: string; cls: string; bg: string;
  sx: number; sy: number; sc: number; op: number; z: number; shown: boolean;
}

interface Cand { l: Label; x: number; y: number; z: number; prio: number; maxDist: number; scale: number; force: boolean; d: number; sx: number; sy: number; w: number; h: number }

function inkFor(bg: string): string {
  const c = new THREE.Color(bg);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return lum > 0.5 ? '#0d1219' : '#ffffff';
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
  /** maximum number of labels on screen */
  maxVisible = 60;
  private hl: number | null = null;
  private v = new THREE.Vector3();
  private cands: Cand[] = [];
  private placed: number[] = [];
  private wasVisible = true;

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

  private make(kind: 'town' | 'stn', onClick: () => void): Label {
    const el = document.createElement('div');
    el.className = 'lbl ' + kind;
    const name = document.createElement('span'); name.className = 'lbl-name';
    const sub = document.createElement('span'); sub.className = kind === 'town' ? 'lbl-pop' : 'lbl-wait';
    let ico: HTMLSpanElement | null = null, mark: HTMLSpanElement | null = null;
    if (kind === 'stn') {
      ico = document.createElement('span'); ico.className = 'lbl-ico';
      mark = document.createElement('span'); mark.className = 'lbl-mark'; mark.style.display = 'none';
      el.append(ico, mark, name, sub);
    } else el.append(name, sub);
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    el.style.display = 'none';
    this.container.appendChild(el);
    return { el, kind, name, sub, ico, mark, text: '', subText: '', markText: '', markColor: '', icoKind: '', cls: '', bg: '', sx: -1e9, sy: -1e9, sc: -1, op: -1, z: -1, shown: false };
  }

  update(game: Game, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number) {
    if (this.visible !== this.wasVisible) { this.wasVisible = this.visible; this.container.style.display = this.visible ? '' : 'none'; }
    if (!this.visible) return;
    const world = game.world;
    const cands = this.cands;
    cands.length = 0;
    const cp = camera.position;
    // ---- towns
    const townMax = Math.max(180, camDist * 3.2);
    for (const t of game.towns.list) {
      let l = this.towns.get(t.id);
      if (!l) { const id = t.id; l = this.make('town', () => this.onClickTown(id)); this.towns.set(t.id, l); }
      this.setText(l, t.name.toUpperCase(), t.pop.toLocaleString('en-US'), t.served > 0);
      this.setCls(l, t.pop >= 3000 ? 'lbl town big' : 'lbl town');
      const y = Math.max(world.heightAt(t.x, t.z), WATER_Y) + 3 + Math.min(5, t.pop / 2500);
      cands.push({ l, x: t.x, y, z: t.z, prio: 1e5 + t.pop, maxDist: townMax, scale: 1, force: false, d: 0, sx: 0, sy: 0, w: 0, h: 34 });
    }
    // ---- stations
    const stMax = camDist < 170 ? Math.max(60, camDist * 2.6) : 0;
    for (const s of game.stations.map.values()) {
      let l = this.stations.get(s.id);
      if (!l) { const id = s.id; l = this.make('stn', () => this.onClickStation(id)); this.stations.set(s.id, l); }
      const served = game.lines.stationServed(s.id);
      const mk = this.marks.get(s.id);
      const isHl = this.hl === s.id;
      this.setText(l, s.name, served ? String(s.waitingTotal) : '–', false);
      this.setIcon(l, s.rail ? 'train' : 'bus');
      this.setMark(l, mk);
      this.setCls(l, 'lbl stn' + (!served && !mk && !isHl ? ' dim' : '') + (isHl ? ' hl' : ''));
      const bg = game.company(s.owner).color;
      if (l.bg !== bg) { l.bg = bg; l.el.style.setProperty('--c', bg); l.el.style.setProperty('--ink', inkFor(bg)); }
      const y = s.rail ? s.rail.y + 1.0 : Math.max(world.heightAt(s.x, s.z), WATER_Y) + 0.8;
      const force = !!mk || isHl;
      cands.push({ l, x: s.x, y, z: s.z, prio: isHl ? 1e9 : mk ? 1e8 : (served ? 2e4 : 1e4), maxDist: force ? 3000 : stMax, scale: isHl ? 1.12 : 0.95, force, d: 0, sx: 0, sy: 0, w: 0, h: 24 });
    }
    // ---- project & cull
    const v = this.v;
    let n = 0;
    for (const c of cands) {
      c.d = v.set(c.x, c.y, c.z).distanceTo(cp);
      if (c.d > c.maxDist) continue;
      v.project(camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.15) continue;
      c.sx = (v.x * 0.5 + 0.5) * w;
      c.sy = (-v.y * 0.5 + 0.5) * h;
      if (!c.force) c.prio -= c.d * (c.l.kind === 'stn' ? 40 : 2);
      cands[n++] = c;
    }
    cands.length = n;
    cands.sort((a, b) => b.prio - a.prio);
    // ---- select: cap, declutter (screen rectangles), terrain occlusion
    const placed = this.placed;
    placed.length = 0;
    const keep = new Set<Label>();
    for (const c of cands) {
      if (keep.size >= this.maxVisible && !c.force) break;
      const s = Math.max(0.72, Math.min(1.1, 0.78 + (40 / Math.max(1, c.d)) * 0.2)) * c.scale;
      c.w = (c.l.text.length * (c.l.kind === 'town' ? 9 : 7.2) + (c.l.kind === 'stn' ? 56 : 12)) * s;
      c.h *= s;
      const x0 = c.sx - c.w / 2, x1 = c.sx + c.w / 2, y0 = c.sy - c.h, y1 = c.sy;
      let hit = false;
      if (!c.force) for (let i = 0; i < placed.length; i += 4) if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) { hit = true; break; }
      if (hit) continue;
      if (!c.force && this.occluded(game, camera, c.x, c.y, c.z)) continue;
      placed.push(x0 - 4, y0 - 2, x1 + 4, y1 + 2);
      keep.add(c.l);
      this.place(c, s, w, h);
    }
    for (const l of this.towns.values()) if (l.shown && !keep.has(l)) this.hide(l);
    for (const l of this.stations.values()) if (l.shown && !keep.has(l)) this.hide(l);
    // drop labels of removed towns / stations
    if (this.stations.size > game.stations.map.size) for (const [id, l] of this.stations) if (!game.stations.map.has(id)) { l.el.remove(); this.stations.delete(id); }
    if (this.towns.size > game.towns.list.length) for (const [id, l] of this.towns) if (!game.towns.list[id]) { l.el.remove(); this.towns.delete(id); }
  }

  private setText(l: Label, text: string, sub: string, up: boolean) {
    if (l.text !== text) { l.text = text; l.name.textContent = text; }
    const st = sub + (up ? '▲' : '');
    if (l.subText !== st) {
      l.subText = st;
      if (up) { l.sub.textContent = sub + ' '; const u = document.createElement('span'); u.className = 'up'; u.textContent = '▲'; l.sub.appendChild(u); }
      else l.sub.textContent = sub;
    }
  }

  private setIcon(l: Label, kind: string) {
    if (!l.ico || l.icoKind === kind) return;
    l.icoKind = kind;
    l.ico.innerHTML = svg(kind, 14);
  }

  private setMark(l: Label, mk: { color: string; text: string } | undefined) {
    if (!l.mark) return;
    const t = mk ? mk.text : '';
    if (t !== l.markText) { l.markText = t; l.mark.textContent = t; l.mark.style.display = t ? '' : 'none'; }
    const c = mk ? mk.color : '';
    if (c !== l.markColor) { l.markColor = c; l.mark.style.background = c; }
  }

  private setCls(l: Label, cls: string) { if (l.cls !== cls) { l.cls = cls; l.el.className = cls; } }

  private hide(l: Label) { l.shown = false; l.el.style.display = 'none'; }

  private place(c: Cand, s: number, w: number, h: number) {
    const l = c.l;
    if (!l.shown) { l.shown = true; l.el.style.display = ''; l.sx = -1e9; }
    if (Math.abs(c.sx - l.sx) > 0.5 || Math.abs(c.sy - l.sy) > 0.5 || Math.abs(s - l.sc) > 0.01) {
      l.sx = c.sx; l.sy = c.sy; l.sc = s;
      l.el.style.transform = `translate3d(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
    }
    const op = c.force ? 1 : Math.round(Math.max(0, Math.min(1, (c.maxDist - c.d) / (c.maxDist * 0.25))) * 20) / 20;
    if (op !== l.op) { l.op = op; l.el.style.opacity = String(op); }
    const z = 100000 - Math.round(c.d * 10);
    if (Math.abs(z - l.z) > 5) { l.z = z; l.el.style.zIndex = String(z); }
    void w; void h;
  }

  /** Is the straight line from the camera to the point blocked by terrain? */
  private occluded(game: Game, camera: THREE.Camera, x: number, y: number, z: number): boolean {
    const wd = game.world;
    const c = camera.position;
    for (let i = 1; i < 12; i++) {
      const f = i / 12;
      const px = c.x + (x - c.x) * f, pz = c.z + (z - c.z) * f;
      if (!wd.inside(px, pz)) continue;
      if (c.y + (y - c.y) * f < wd.heightAt(px, pz) - 0.05) return true;
    }
    return false;
  }
}
