// In-world hover card (inspect mode): name + key stats, anchored above the station, vehicle, depot or town.
import * as THREE from 'three';
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { WATER_Y } from '../game/constants';
import { esc, svg } from './dom';
import { fmtMult } from './format';
import { accessState } from './win-access';
import type { Game } from '../game/game';
import { fmtMoney } from '../game/economy';
import type { Train } from '../game/train';
import type { RoadVehicle } from '../game/roadvehicle';

export interface HoverTarget { kind: 'station' | 'vehicle' | 'depot' | 'town'; id: number }

/** One line on the player's access to another company's station. */
function accessHint(g: Game, owner: number): string {
  const k = accessState(g, owner).kind;
  return k === 'agreement' ? `Track access · upkeep shared ${fmtMult(g.accessMultiplier(owner))}` : k === 'pending' ? 'Access request pending' : k === 'blocked' ? 'You are blocked from this network' : k === 'closed' ? 'The owner refuses access' : 'No track access · click to request';
}

const stat = (ic: string, html: string) => `<span class="hc-stat">${svg(ic, 14)}<span>${html}</span></span>`;

export class HoverCard {
  el: HTMLDivElement;
  private cur: HoverTarget | null = null;
  private html = '';
  private color = '';
  private t = 0;
  private sx = NaN; private sy = NaN;
  private shown = false;
  /** card size (measured when the content changes) and whether it currently overlaps a HUD card */
  private cw = 0; private chh = 0;
  private blocked = false;
  private avoidT = 0;
  private v = new THREE.Vector3();

  constructor(private ui: UI) {
    this.el = document.createElement('div');
    this.el.className = 'hovercard';
    this.el.setAttribute('aria-hidden', 'true');
    ui.root.appendChild(this.el);
  }

  get target() { return this.cur; }

  set(t: HoverTarget | null) {
    if (t && this.cur && t.kind === this.cur.kind && t.id === this.cur.id) return;
    this.cur = t;
    this.t = 0;
    if (!t) this.hide();
  }

  private hide() {
    if (!this.shown) return;
    this.shown = false;
    this.el.classList.remove('show');
  }

  /** World anchor above the object, or null if it no longer exists. */
  private anchor(t: HoverTarget): { x: number; y: number; z: number } | null {
    const g = this.ui.game;
    const w = g.world;
    if (t.kind === 'station') {
      const s = g.stations.get(t.id);
      if (!s) return null;
      return s.rail ? { x: s.x, y: s.rail.y + 2.1, z: s.z } : { x: s.x, y: Math.max(w.heightAt(s.x, s.z), WATER_Y) + 2, z: s.z };
    }
    if (t.kind === 'vehicle') {
      const v = g.vehicles.get(t.id);
      if (!v) return null;
      const p = { x: 0, y: 0, z: 0 };
      if (!v.worldPos(p)) return null;
      return { x: p.x, y: p.y + 0.9, z: p.z };
    }
    if (t.kind === 'depot') {
      const d = g.depots.get(t.id);
      return d ? { x: d.x, y: d.y + 1.6, z: d.z } : null;
    }
    const town = g.towns.list[t.id];
    if (!town) return null;
    return { x: town.x, y: Math.max(w.heightAt(town.x, town.z), WATER_Y) + 6.5 + Math.min(5, town.pop / 2500), z: town.z };
  }

  private content(t: HoverTarget): { html: string; color: string } | null {
    const g = this.ui.game;
    if (t.kind === 'station') {
      const s = g.stations.get(t.id);
      if (!s) return null;
      const co = g.company(s.owner);
      const town = g.towns.list[s.townId];
      const lines = g.lines.linesAt(s.id).length;
      return {
        color: co.color,
        html: `<div class="hc-title">${svg(s.rail ? 'station' : s.stops.some((p) => g.world.net.edges.get(p.edge)?.tram) ? 'tramstop' : 'busstop', 16)}<span>${esc(s.name)}</span></div>` +
          `<div class="hc-sub">${esc(co.name)}${town ? ' · ' + esc(town.name) : ''}</div>` +
          `<div class="hc-stats">${stat('people', `<b>${s.waitingTotal.toLocaleString('en-US')}</b> waiting`)}${stat('star', `<b>${Math.round(s.rating * 100)}%</b>`)}${stat('lines', `<b>${lines}</b> line${lines === 1 ? '' : 's'}`)}</div>` +
          `<div class="hc-hint">${s.owner >= 0 && s.owner !== PLAYER ? accessHint(g, s.owner) : s.rail && (s as unknown as { roadAccess?: boolean }).roadAccess === false ? '<span class="neg">No road access — no passengers</span>' : 'Click for details'}</div>`,
      };
    }
    if (t.kind === 'vehicle') {
      const v = g.vehicles.get(t.id);
      if (!v) return null;
      const co = g.company(v.owner);
      const rail = v.kind === 'train';
      const model = rail ? (v as Train).cars[0]?.name : (v as RoadVehicle).model?.name;
      return {
        color: v.line?.color ?? co.color,
        html: `<div class="hc-title">${svg(rail ? 'train' : 'bus', 16)}<span>${esc(v.name)}</span></div>` +
          `<div class="hc-sub">${esc(v.line ? v.line.name : 'No line')} · ${esc(model ?? '')}${v.owner !== PLAYER ? ' · ' + esc(co.name) : ''}</div>` +
          `<div class="hc-stats">${stat('speed', `<b>${Math.round(v.speedKmh)}</b> km/h`)}${stat('people', `<b>${v.load}</b>/${v.capacity}`)}${stat('coin', `<b>${fmtMoney(v.profitYear)}</b>/yr`)}</div>` +
          `<div class="hc-hint">${esc(v.status)}</div>`,
      };
    }
    if (t.kind === 'depot') {
      const d = g.depots.get(t.id);
      if (!d) return null;
      const co = g.company(d.owner);
      const n = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === d.id).length;
      return {
        color: co.color,
        html: `<div class="hc-title">${svg(d.kind === 'rail' ? 'depot' : 'garage', 16)}<span>${d.kind === 'rail' ? 'Train depot' : 'Bus depot'}</span></div>` +
          `<div class="hc-sub">${esc(co.name)}</div>` +
          `<div class="hc-stats">${stat('vehicles', `<b>${n}</b> vehicle${n === 1 ? '' : 's'}`)}</div>` +
          `<div class="hc-hint">${d.owner === PLAYER ? 'Click to buy vehicles' : 'Click for details'}</div>`,
      };
    }
    const town = g.towns.list[t.id];
    if (!town) return null;
    const pct = town.passGenLast ? Math.min(100, Math.round((town.passTransLast / town.passGenLast) * 100)) : 0;
    const growth = town.served === 0 ? 'slow' : town.served === 1 ? 'good' : 'fast';
    return {
      color: '#eef2f7',
      html: `<div class="hc-title">${svg('towns', 16)}<span>${esc(town.name)}</span></div>` +
        `<div class="hc-sub">${town.served ? `${town.served} active station${town.served > 1 ? 's' : ''}` : 'No public transport yet'}</div>` +
        `<div class="hc-stats">${stat('people', `<b>${town.pop.toLocaleString('en-US')}</b>`)}${stat('chart', `<b>${pct}%</b> transported`)}${stat('up', `growth <b>${growth}</b>`)}</div>` +
        `<div class="hc-hint">Click for details</div>`,
    };
  }

  update(dt: number) {
    const t = this.cur;
    if (!t || !this.ui.game) return;
    const a = this.anchor(t);
    if (!a) { this.set(null); return; }
    const cam = this.ui.renderer.camera;
    const v = this.v.set(a.x, a.y, a.z).project(cam);
    if (v.z > 1 || v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.2) { this.hide(); return; }
    this.t -= dt;
    if (this.t <= 0) {
      this.t = 0.4;
      const c = this.content(t);
      if (!c) { this.set(null); return; }
      if (c.html !== this.html) { this.html = c.html; this.el.innerHTML = c.html; this.cw = this.el.offsetWidth; this.chh = this.el.offsetHeight; }
      if (c.color !== this.color) { this.color = c.color; this.el.style.setProperty('--c', c.color); }
    }
    const W = this.ui.root.clientWidth, H = this.ui.root.clientHeight;
    const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H - 10;
    // stay out from under the left column's cards and the tool card (checked a few times a second)
    this.avoidT -= dt;
    if (this.avoidT <= 0) {
      this.avoidT = 0.12;
      const x0 = sx - this.cw / 2, x1 = sx + this.cw / 2, y0 = sy - this.chh, y1 = sy;
      this.blocked = this.ui.hud.avoidRects().some((r) => x0 < r.right && x1 > r.left && y0 < r.bottom && y1 > r.top);
    }
    if (this.blocked) { this.hide(); return; }
    if (Math.abs(sx - this.sx) > 0.5 || Math.abs(sy - this.sy) > 0.5) {
      this.sx = sx; this.sy = sy;
      this.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
    if (!this.shown) { this.shown = true; this.el.classList.add('show'); }
  }
}
