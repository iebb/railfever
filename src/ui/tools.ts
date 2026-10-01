// Map interaction tools: Transport-Fever-style track & road construction (click-click chains with live
// preview), stations, depots, signals, demolition, terraforming and object queries.
import * as THREE from 'three';
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { findSnap, planEdge, commitProposal, Snap, Proposal, BuildOptions } from '../game/construction';
import { toggleSignal, bulldoze, terraformBrush, depotSize, DepotPlan } from '../game/build-ops';
import { stationLayout, StationPlan } from '../game/stations';
import { fmtMoney } from '../game/economy';
import { STATION_RADIUS, BUSSTOP_RADIUS, NetKind, TRACK_TYPES, ROAD_TYPES } from '../game/constants';
import { CROSS_LABEL, MarkerKind } from '../render/overlay';
import { distToRect } from '../game/world';
import type { NNode } from '../game/network';
import { esc } from './dom';

export type ToolId = 'inspect' | 'rail' | 'road' | 'station' | 'busstop' | 'depot-rail' | 'depot-road' | 'signal' | 'bulldoze' | 'terraform' | 'line-edit';
export type CrossingPref = BuildOptions['crossing'];

export const TOOL_INFO: Record<ToolId, { name: string; hint: string }> = {
  inspect: { name: 'Query', hint: 'Click stations, vehicles, depots, towns, buildings or tracks for details.' },
  rail: { name: 'Build track', hint: 'Click to start, click again to build — construction continues from the new end with a smooth curve. Right-click or Esc ends the chain. Snap onto track ends to extend, onto track to branch.' },
  road: { name: 'Build road', hint: 'Click to start, click again to build — continues from the new end. Snap onto roads to create junctions. Connect to town streets so buses can reach them.' },
  station: { name: 'Train station', hint: 'Click to place. R / Shift+R or Ctrl+wheel rotate by 15°. Lines up with a nearby track end; connect its tracks with the track tool.' },
  busstop: { name: 'Bus stop', hint: 'Click on a road. Next to one of your train stations it joins it (passengers transfer).' },
  'depot-rail': { name: 'Train depot', hint: 'Click near a free end of your track (it snaps on), or place it and connect it with track. R rotates.' },
  'depot-road': { name: 'Bus depot', hint: 'Click next to a road: the depot faces it and connects itself. R rotates when away from roads.' },
  signal: { name: 'Signals', hint: 'Click a track to add a signal. Click a signal to cycle two-way → one-way → one-way (reversed) → none. Signals split track into blocks so trains can follow each other.' },
  bulldoze: { name: 'Demolish', hint: 'Click to remove an object, or drag a rectangle to clear an area. Other companies’ property is protected.' },
  terraform: { name: 'Terraform', hint: 'Hold the left button to raise, lower or level the ground under the brush.' },
  'line-edit': { name: 'Edit line', hint: 'Click stations (or their labels) to add them as stops. Press Esc or Done when finished.' },
};

const CONSTRUCTION: ToolId[] = ['rail', 'road', 'station', 'busstop', 'depot-rail', 'depot-road', 'signal', 'bulldoze', 'terraform'];
const SIGNAL_NAMES = ['none', 'two-way', 'one-way', 'one-way (reversed)'];
const DEG = Math.PI / 180;

/** Terrain shader uniforms used by the tools (cast: the terrain view owns the declaration). */
interface TerrainU {
  uGrid?: { value: number };
  uHiRect?: { value: THREE.Vector4 };
  uHiColor?: { value: THREE.Color };
  uHiOn?: { value: number };
  uCircle?: { value: THREE.Vector4 };
  uCircleColor?: { value: THREE.Color };
}

export interface Hit { kind: 'station' | 'depot' | 'building' | 'edge' | 'town'; id: number }

const fmtLen = (u: number) => (u >= 100 ? `${(u / 100).toFixed(2)} km` : `${Math.round(u * 10)} m`);
export const fmtHeight = (h: number) => (h === 0 ? '±0 m' : `${h > 0 ? '+' : '−'}${Math.round(Math.abs(h) * 10)} m`);
const snapKey = (s: Snap | null) => (s ? `${s.kind}:${s.node ?? ''}:${s.edge ?? ''}:${s.x.toFixed(2)},${s.z.toFixed(2)}` : '-');

export class Tools {
  tool: ToolId = 'inspect';
  // ---- construction options (edited by the options panel)
  railType: 'standard' | 'highspeed' = 'standard';
  roadType: 'street' | 'road' = 'road';
  tracks = 2;
  heightOffset = 0;
  crossing: CrossingPref = 'auto';
  stationLen = 16;
  stationTracks = 2;
  stationAngle = 0;
  autoAlign = true;
  depotAngle = 0;
  terraMode: 'raise' | 'lower' | 'level' = 'raise';
  brushRadius = 4;
  lineEditId: number | null = null;
  onToolChange: () => void = () => {};

  // ---- pointer state
  tooltip: HTMLDivElement;
  private client = { x: -1, y: -1 };
  private overMap = false;
  private ground: THREE.Vector3 | null = null;
  private down: { x: number; y: number; button: number; ground: THREE.Vector3 | null; moved: boolean; hadStart: boolean } | null = null;
  private moveDirty = false;
  private camPos = new THREE.Vector3();
  private camQuat = new THREE.Quaternion();
  private netVer = -1;
  private rect: DOMRect | null = null;
  private v3 = new THREE.Vector3();

  // ---- track / road chain
  start: Snap | null = null;
  hoverSnap: Snap | null = null;
  proposal: Proposal | null = null;
  private planDirty = false;
  private planAt = 0;
  private planMs = 0;
  private planKey = '';
  // ---- other tool state
  private stationPlan: StationPlan | null = null;
  private depotPlan: DepotPlan | null = null;
  private dragRect: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private dozeAt = 0;
  private brush = { timer: 0, level: 0, cost: 0, err: false };
  private wheelAcc = 0;
  hoverStation: number | null = null;

  constructor(private ui: UI) {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    ui.root.appendChild(this.tooltip);
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => { if (!this.down) { this.overMap = false; this.hideTip(); } });
    // Ctrl+wheel rotates stations and depots (captured before the camera zooms)
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
  }

  get game() { return this.ui.game; }
  get overlay() { return this.ui.renderer.overlay; }
  private get canvas() { return this.ui.renderer.renderer.domElement; }
  private get terr(): TerrainU { return this.ui.renderer.terrain.uniforms as unknown as TerrainU; }
  get kind(): NetKind { return this.tool === 'road' ? 'road' : 'rail'; }
  get building() { return this.tool === 'rail' || this.tool === 'road'; }

  buildOptions(): BuildOptions {
    const rail = this.tool !== 'road';
    return { kind: rail ? 'rail' : 'road', type: rail ? this.railType : this.roadType, tracks: rail ? this.tracks : 1, heightOffset: this.heightOffset, crossing: this.crossing, owner: PLAYER };
  }

  // ------------------------------------------------------------------ tool switching
  setTool(t: ToolId) {
    if (this.tool === 'line-edit' && t !== 'line-edit') this.lineEditId = null;
    this.tool = t;
    this.start = null;
    this.proposal = null;
    this.planKey = '';
    this.planDirty = false;
    this.down = null;
    this.dragRect = null;
    this.stationPlan = null;
    this.depotPlan = null;
    this.hoverStation = null;
    this.clearVisuals();
    const u = this.terr;
    if (u.uGrid) u.uGrid.value = CONSTRUCTION.includes(t) && t !== 'signal' ? 1 : 0;
    this.hideTip();
    this.onToolChange();
    this.refreshHover();
  }

  private clearVisuals() {
    this.overlay.clear();
    const u = this.terr;
    if (u.uHiOn) u.uHiOn.value = 0;
    if (u.uCircle) u.uCircle.value.w = 0;
  }

  /** Re-evaluate the hover state (e.g. after options changed). */
  refreshHover() { this.planKey = ''; this.moveDirty = true; if (this.start) this.planDirty = true; }

  rotate(dir = 1) {
    if (this.tool === 'station') { this.stationAngle = norm(this.stationAngle + dir * 15 * DEG); if (this.autoAlign) { this.autoAlign = false; this.onToolChange(); } }
    else if (this.tool === 'depot-rail' || this.tool === 'depot-road') this.depotAngle = norm(this.depotAngle + dir * 15 * DEG);
    else return;
    this.refreshHover();
  }

  adjustHeight(d: number) {
    this.heightOffset = Math.max(-6, Math.min(6, Math.round((this.heightOffset + d) * 2) / 2));
    this.onToolChange();
    this.refreshHover();
  }

  /** End the current chain / drag; returns false if there was nothing to cancel (caller may close windows). */
  cancel(): boolean {
    if (this.start || this.dragRect || this.down) { this.endChain(); return true; }
    if (this.tool !== 'inspect') { this.setTool('inspect'); return true; }
    return false;
  }

  private endChain() {
    this.start = null;
    this.proposal = null;
    this.planKey = '';
    this.planDirty = false;
    this.down = null;
    this.dragRect = null;
    this.overlay.setProposal(null);
    this.overlay.setMarker('start0', null);
    for (let i = 1; i < 4; i++) this.overlay.setMarker('start' + i, null);
    const u = this.terr;
    if (u.uHiOn) u.uHiOn.value = 0;
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ pointer events
  private onDown = (e: PointerEvent) => {
    if (!this.game || e.altKey || (e.button !== 0 && e.button !== 2)) return;
    this.client = { x: e.clientX, y: e.clientY };
    this.ground = this.pick();
    this.down = { x: e.clientX, y: e.clientY, button: e.button, ground: this.ground?.clone() ?? null, moved: false, hadStart: !!this.start };
    if (e.button !== 0) return;
    const p = this.ground;
    if (!p) return;
    if (this.building && !this.start) {
      // press starts a chain (a drag builds straight away on release)
      const sn = this.snapAt(this.kind);
      const err = this.ownErr(sn);
      if (err) { this.ui.toast(err, 'bad'); this.down = null; return; }
      this.setStart(sn);
    } else if (this.tool === 'terraform') {
      this.brush = { timer: 0, level: this.game.world.heightAt(p.x, p.z), cost: 0, err: false };
    }
  };

  private onMove = (e: PointerEvent) => {
    this.client = { x: e.clientX, y: e.clientY };
    const t = e.target as HTMLElement;
    this.overMap = t === this.canvas || !!t?.closest?.('.labels');
    const d = this.down;
    if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.moved = true;
      if (d.button === 0 && this.tool === 'bulldoze' && d.ground) this.dragRect = { x0: d.ground.x, z0: d.ground.z, x1: d.ground.x, z1: d.ground.z };
    }
    if (!this.overMap && !this.down) { this.hideTip(); return; }
    this.moveDirty = true;
    this.positionTip();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    if (!d || e.button !== d.button) return;
    this.down = null;
    if (!this.game) return;
    this.client = { x: e.clientX, y: e.clientY };
    if (d.button === 2) {
      // right click (not a camera drag) ends the construction chain
      if (!d.moved && (this.start || this.dragRect)) this.endChain();
      return;
    }
    const onMap = (e.target as HTMLElement) === this.canvas || !!(e.target as HTMLElement)?.closest?.('.labels');
    this.ground = this.pick();
    if (this.building) {
      if (d.moved || d.hadStart) this.commitChain();
      return;
    }
    switch (this.tool) {
      case 'bulldoze': {
        const r = this.dragRect;
        this.dragRect = null;
        const u = this.terr;
        if (u.uHiOn) u.uHiOn.value = 0;
        if (r && d.moved) this.doBulldoze(r.x0, r.z0, r.x1, r.z1);
        else if (!d.moved && d.ground) this.doBulldoze(d.ground.x, d.ground.z, d.ground.x, d.ground.z);
        break;
      }
      case 'terraform':
        if (this.brush.cost > 0) { this.ui.floatCost(this.brush.cost, e.clientX, e.clientY); this.ui.sound('build'); }
        this.brush.cost = 0;
        break;
      default:
        if (!d.moved && onMap) this.click(e);
    }
    this.moveDirty = true;
  };

  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || e.target !== this.canvas) return;
    if (this.tool !== 'station' && this.tool !== 'depot-rail' && this.tool !== 'depot-road') return;
    e.preventDefault();
    e.stopPropagation();
    this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    while (Math.abs(this.wheelAcc) >= 40) { const s = Math.sign(this.wheelAcc); this.wheelAcc -= s * 40; this.rotate(s); }
  };

  // ------------------------------------------------------------------ picking & snapping
  private pick(): THREE.Vector3 | null {
    if (this.client.x < 0) return null;
    return this.ui.renderer.pickGround(this.client.x, this.client.y);
  }

  private camDist(): number {
    const c = this.ui.renderer.controls as unknown as { smoothDistance?: number };
    return c.smoothDistance ?? this.ui.renderer.camera.position.distanceTo(this.ground ?? new THREE.Vector3());
  }

  private project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = this.v3.set(x, y, z).project(this.ui.renderer.camera);
    if (v.z > 1 || v.z < -1) return null;
    const r = this.rect ?? (this.rect = this.canvas.getBoundingClientRect());
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  /** Snap under the cursor: nodes and edges are matched in screen space (works for bridges), then findSnap. */
  snapAt(kind: NetKind): Snap {
    const g = this.game;
    const net = g.world.net;
    const p = this.ground ?? new THREE.Vector3(this.start?.x ?? 0, 0, this.start?.z ?? 0);
    const cx = this.client.x, cy = this.client.y;
    const R = Math.max(3, Math.min(16, this.camDist() * 0.1));
    let bn: NNode | null = null, bd = 15;
    for (const id of net.nodeGrid.query(p.x - R, p.z - R, p.x + R, p.z + R)) {
      const n = net.nodes.get(id);
      if (!n || n.kind !== kind || !n.edges.length) continue;
      if (n.edges.some((eid) => { const e = net.edges.get(eid); return !!e && e.depot >= 0 && e.a === n.id; })) continue; // depot interior
      const s = this.project(n.x, n.y, n.z);
      if (!s) continue;
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d < bd) { bd = d; bn = n; }
    }
    if (bn) return findSnap(g, kind, bn.x, bn.z, 0.02);
    let best: { x: number; z: number; d: number } | null = null;
    for (const e of net.edgesNear(p.x - R, p.z - R, p.x + R, p.z + R)) {
      if (e.kind !== kind || e.depot >= 0) continue;
      const geo = net.geo(e);
      const step = Math.max(1, Math.round(1 / Math.max(0.05, geo.len / Math.max(1, geo.n - 1))));
      let prev: { x: number; y: number } | null = null, pi = 0;
      for (let i = 0; i < geo.n; i += step) {
        const j = i;
        const s = this.project(geo.pts[j * 3], geo.pts[j * 3 + 1], geo.pts[j * 3 + 2]);
        if (s && prev) {
          const dx = s.x - prev.x, dy = s.y - prev.y;
          const l2 = dx * dx + dy * dy;
          let f = l2 > 1e-6 ? ((cx - prev.x) * dx + (cy - prev.y) * dy) / l2 : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const d = Math.hypot(prev.x + dx * f - cx, prev.y + dy * f - cy);
          if (d < 12 && (!best || d < best.d)) best = { x: geo.pts[pi * 3] + (geo.pts[j * 3] - geo.pts[pi * 3]) * f, z: geo.pts[pi * 3 + 2] + (geo.pts[j * 3 + 2] - geo.pts[pi * 3 + 2]) * f, d };
        }
        prev = s; pi = j;
        if (i < geo.n - 1 && i + step > geo.n - 1) i = geo.n - 1 - step;
      }
    }
    if (best) return findSnap(g, kind, best.x, best.z, 0.3);
    return findSnap(g, kind, p.x, p.z, Math.max(0.3, Math.min(2, this.camDist() * 0.012)));
  }

  /** Ownership / validity problems of a snap target. */
  private ownErr(s: Snap | null): string | null {
    if (!s) return null;
    const g = this.game, net = g.world.net;
    if (s.kind === 'edge') {
      const e = net.edges.get(s.edge!);
      if (e && e.station >= 0 && e.kind === 'rail') return 'Cannot branch off inside a station';
      if (e && e.kind === 'rail' && e.owner !== PLAYER) return `Track owned by ${g.company(e.owner).name}`;
    } else if (s.kind === 'node') {
      const n = net.nodes.get(s.node!);
      if (n && n.kind === 'rail' && n.owner !== PLAYER) return `Track owned by ${g.company(n.owner).name}`;
    }
    return null;
  }

  private setStart(sn: Snap) {
    this.start = sn;
    this.planKey = '';
    this.planDirty = true;
    this.showSnap('start', sn, 0xffffff, 'start');
  }

  private showSnap(slot: string, sn: Snap | null, color: number, kind?: MarkerKind) {
    const net = this.game.world.net;
    const nodes = sn?.kind === 'node' ? (sn.group ?? [sn.node!]).map((id) => net.nodes.get(id)).filter((n): n is NNode => !!n) : [];
    for (let i = 0; i < 4; i++) {
      if (!sn) { this.overlay.setMarker(slot + i, null); continue; }
      if (nodes.length) {
        const n = nodes[i];
        this.overlay.setMarker(slot + i, n ? { x: n.x, y: n.y, z: n.z } : null, kind ?? 'node', color, nodes.length > 1 ? 0.009 : 0.013);
      } else this.overlay.setMarker(slot + i, i === 0 ? { x: sn.x, y: sn.y, z: sn.z } : null, kind ?? (sn.kind === 'edge' ? 'edge' : 'free'), color);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    const g = this.game;
    if (!g) return;
    const cam = this.ui.renderer.camera;
    if (!cam.position.equals(this.camPos) || !cam.quaternion.equals(this.camQuat)) {
      this.camPos.copy(cam.position);
      this.camQuat.copy(cam.quaternion);
      if (this.overMap || this.down) this.moveDirty = true;
    }
    if (g.networkVersion !== this.netVer) {
      this.netVer = g.networkVersion;
      this.planKey = '';
      if (this.start) this.planDirty = true;
      this.moveDirty = true;
    }
    if (this.moveDirty) {
      this.moveDirty = false;
      this.rect = this.canvas.getBoundingClientRect();
      this.ground = this.overMap || this.down ? this.pick() : null;
      this.hover();
    }
    if (this.planDirty && performance.now() - this.planAt >= Math.min(200, this.planMs * 2)) this.planNow();
    // terraform brush while the button is held
    if (this.tool === 'terraform' && this.down?.button === 0 && this.ground) {
      this.brush.timer -= dt;
      if (this.brush.timer <= 0) {
        this.brush.timer = 0.12;
        const r = terraformBrush(g, this.ground.x, this.ground.z, this.brushRadius, this.terraMode, this.brush.level, PLAYER);
        if (r.error) { if (!this.brush.err) this.ui.toast(r.error, 'bad'); this.brush.err = true; }
        else this.brush.cost += r.cost;
      }
    }
    // bulldoze rectangle preview (throttled dry run)
    if (this.dragRect && this.ground && this.down) {
      const r = this.dragRect;
      r.x1 = this.ground.x; r.z1 = this.ground.z;
      const u = this.terr;
      if (u.uHiRect && u.uHiOn && u.uHiColor) {
        u.uHiRect.value.set(Math.min(r.x0, r.x1), Math.min(r.z0, r.z1), Math.max(r.x0, r.x1), Math.max(r.z0, r.z1));
        u.uHiColor.value.setHex(0xff5544);
        u.uHiOn.value = 1;
      }
      const now = performance.now();
      if (now - this.dozeAt > 120) {
        this.dozeAt = now;
        const res = bulldoze(g, r.x0, r.z0, r.x1, r.z1, PLAYER, true);
        this.showTip(res.changed ? `Demolish ${res.changed} object${res.changed > 1 ? 's' : ''}: <b>${fmtMoney(res.cost)}</b>${res.error ? `<div class="tt-err">${esc(res.error)}</div>` : ''}` : 'Nothing to remove', res.changed ? 'err' : 'info');
      }
    }
  }

  // ------------------------------------------------------------------ hover
  private hover() {
    const g = this.game;
    const p = this.ground;
    const ov = this.overlay;
    const u = this.terr;
    if (!p) {
      if (!this.building) this.clearVisuals();
      ov.setMarker('hover0', null);
      this.hideTip();
      return;
    }
    switch (this.tool) {
      case 'rail':
      case 'road': {
        const sn = this.snapAt(this.kind);
        this.hoverSnap = sn;
        const err = this.ownErr(sn);
        this.showSnap('hover', sn, err ? 0xff5a4a : sn.kind === 'node' ? 0x5ff07a : sn.kind === 'edge' ? 0xffd84a : 0xffffff);
        if (this.start) { this.planDirty = true; this.positionTip(); }
        else this.showTip(this.describeSnap(sn, err), err ? 'err' : 'info');
        break;
      }
      case 'station': {
        const pos = this.stationPlacement(p.x, p.z);
        const pl = g.stations.planRail(pos.x, pos.z, pos.angle, this.stationLen, this.stationTracks, PLAYER);
        this.stationPlan = pl;
        ov.setStationGhost(pl);
        const R = STATION_RADIUS + this.stationLen / 2;
        this.setCircle(pos.x, pos.z, R, pl.ok ? 0x5ac8fa : 0xff6b5a);
        const pop = this.coveredPop(pos.x, pos.z, R);
        const head = pl.ok ? `<b>${fmtMoney(pl.cost)}</b> · ${this.stationTracks} track${this.stationTracks > 1 ? 's' : ''} × ${this.stationLen * 10} m` : `<span class="tt-err">${esc(pl.error ?? 'Cannot build')}</span>`;
        const extra = [
          `Catchment: ${pop.toLocaleString('en-US')} residents`,
          pl.join ? `Joins ${esc(pl.join.name)}` : '',
          pl.ok && pl.demolish.length ? `Demolishes ${pl.demolish.length} building${pl.demolish.length > 1 ? 's' : ''}` : '',
          pos.snapped === 'end' ? 'Lined up with track end' : pos.snapped === 'edge' ? 'Aligned with track' : '',
          pl.ok && !g.economy.canAfford(pl.cost) ? '<span class="tt-warn">Not enough money</span>' : '',
        ].filter(Boolean).map((s) => `<div>${s}</div>`).join('');
        this.showTip(head + extra, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'busstop': {
        const pl = g.stations.planBusStop(p.x, p.z, PLAYER);
        if (pl.ok && pl.edge) {
          const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
          g.world.net.pointAt(pl.edge, pl.s!, q, d);
          const a = Math.atan2(d.x, d.z);
          const off = g.world.net.halfWidth(pl.edge) - 0.12;
          ov.setFootprints([{ x: q.x + Math.cos(a) * off, z: q.z - Math.sin(a) * off, angle: a, w: 0.3, d: 1.2, color: 0x46e07a, y: q.y, lift: 0.06 }]);
          ov.setMarker('hover0', q, 'point', 0x46e07a);
          this.setCircle(q.x, q.z, BUSSTOP_RADIUS, 0x5ac8fa);
          const pop = this.coveredPop(q.x, q.z, BUSSTOP_RADIUS);
          this.showTip(`<b>${fmtMoney(pl.cost)}</b><div>Catchment: ${pop.toLocaleString('en-US')} residents</div>${pl.join ? `<div>Joins ${esc(pl.join.name)}</div>` : ''}`, 'ok');
        } else {
          ov.setFootprints(null);
          ov.setMarker('hover0', { x: p.x, y: p.y, z: p.z }, 'free', 0xff5a4a);
          this.setCircle(0, 0, 0, 0);
          this.showTip(esc(pl.error ?? 'Cannot build'), 'err');
        }
        break;
      }
      case 'depot-rail':
      case 'depot-road': {
        const kind: NetKind = this.tool === 'depot-rail' ? 'rail' : 'road';
        const pos = this.depotPlacement(kind, p.x, p.z);
        const pl = this.planDepot(kind, p.x, p.z);
        this.depotPlan = pl;
        ov.setDepotGhost(pl, kind);
        const how = pl.snapNode >= 0 ? '<div>Connects to the track end</div>' : kind === 'road' && pos.road ? '<div>Connects to the road</div>' : kind === 'rail' ? '<div>Connect it with track afterwards</div>' : '';
        this.showTip(pl.ok ? `<b>${fmtMoney(pl.cost)}</b>${how}` : esc(pl.error ?? 'Cannot build'), pl.ok ? 'ok' : 'err');
        break;
      }
      case 'signal': this.hoverSignal(p); break;
      case 'bulldoze': {
        if (this.dragRect) break;
        const net = g.world.net;
        const ne = net.nearestEdge(p.x, p.z, 0.9);
        ov.setHoverEdge(ne && ne.edge.station < 0 && ne.edge.depot < 0 ? ne.edge.id : null, 0xff5544);
        const now = performance.now();
        if (now - this.dozeAt < 40) break;
        this.dozeAt = now;
        const r = bulldoze(g, p.x, p.z, p.x, p.z, PLAYER, true);
        if (r.changed) this.showTip(`Demolish: <b>${fmtMoney(r.cost)}</b>${r.error ? `<div class="tt-err">${esc(r.error)}</div>` : ''}`, 'err');
        else if (r.error) this.showTip(esc(r.error), 'err');
        else this.hideTip();
        break;
      }
      case 'terraform': {
        this.setCircle(p.x, p.z, this.brushRadius, this.terraMode === 'raise' ? 0x7dff9a : this.terraMode === 'lower' ? 0xffa060 : 0xffe066);
        if (!this.down) this.showTip(`${this.terraMode[0].toUpperCase() + this.terraMode.slice(1)} · radius ${this.brushRadius * 10} m`, 'info');
        break;
      }
      case 'inspect':
      case 'line-edit': this.hoverInspect(p); break;
    }
  }

  private hoverSignal(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const n = net.nearestNode(p.x, p.z, 0.8, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
    if (n) {
      ov.setMarker('hover0', n, 'signal', n.owner === PLAYER ? 0xffe066 : 0xff5a4a);
      ov.setHoverEdge(n.edges, 0xffe066);
      if (n.owner !== PLAYER) this.showTip(`Signal of ${esc(g.company(n.owner).name)}`, 'err');
      else this.showTip(`Signal: ${SIGNAL_NAMES[n.signal]} → <b>${SIGNAL_NAMES[(n.signal + 1) % 4]}</b>`, 'info');
      return;
    }
    const ne = net.nearestEdge(p.x, p.z, 1.0, 'rail');
    if (!ne) { ov.setMarker('hover0', null); ov.setHoverEdge(null); this.showTip('Click on a track', 'info'); return; }
    const e = ne.edge;
    const q = { x: 0, y: 0, z: 0 };
    let err = '';
    if (e.station >= 0 || e.depot >= 0) err = 'Not inside stations or depots';
    else if (e.owner !== PLAYER) err = `Track owned by ${g.company(e.owner).name}`;
    else if (ne.s < 1 || ne.s > e.len - 1) {
      const end = net.nodes.get(ne.s < 1 ? e.a : e.b)!;
      if (end.edges.length !== 2) err = 'Signals need plain track (not at a switch or track end)';
      q.x = end.x; q.y = end.y; q.z = end.z;
    }
    if (!q.x) net.pointAt(e, ne.s, q);
    ov.setMarker('hover0', q, 'signal', err ? 0xff5a4a : 0xffe066);
    ov.setHoverEdge(e.id, err ? 0xff5a4a : 0xffe066);
    this.showTip(err ? esc(err) : `Place two-way signal: <b>${fmtMoney(9000)}</b>`, err ? 'err' : 'info');
  }

  private hoverInspect(p: THREE.Vector3) {
    const g = this.game, ov = this.overlay;
    const hit = this.hitAt(p.x, p.z);
    ov.setHoverEdge(null);
    ov.setFootprints(null);
    this.hoverStation = null;
    if (!hit) { this.hideTip(); return; }
    const own = (o: number) => (o === PLAYER ? '' : o < 0 ? ' <span class="muted">(town)</span>' : ` <span class="muted">(${esc(g.company(o).name)})</span>`);
    if (hit.kind === 'station') {
      const st = g.stations.get(hit.id)!;
      this.hoverStation = st.id;
      const rects = g.stations.footprints(st).map((f) => ({ ...f, color: 0x5ac8fa, y: st.rail?.y, lift: 0.12 }));
      for (const s of st.stops) rects.push({ x: s.x, z: s.z, angle: 0, w: 0.9, d: 0.9, color: 0x5ac8fa, y: undefined, lift: 0.08 });
      ov.setFootprints(rects);
      if (this.tool === 'line-edit') {
        const l = this.lineEditId != null ? g.lines.get(this.lineEditId) : null;
        const okKind = l && (l.kind === 'rail' ? !!st.rail : st.stops.length > 0);
        const err = st.owner !== PLAYER ? 'Station of another company' : !okKind ? (l?.kind === 'rail' ? 'No train platforms' : 'No bus stop') : '';
        this.showTip(err ? `${esc(st.name)}<div class="tt-err">${err}</div>` : `Add <b>${esc(st.name)}</b> to ${esc(l?.name ?? 'line')}`, err ? 'err' : 'ok');
      } else this.showTip(`<b>${esc(st.name)}</b>${own(st.owner)}<div>${st.waitingTotal} waiting · rating ${(st.rating * 100).toFixed(0)}%</div>`, 'info');
      return;
    }
    if (this.tool === 'line-edit') { this.hideTip(); return; }
    if (hit.kind === 'depot') {
      const dp = g.depots.get(hit.id)!;
      const sz = depotSize(dp.kind);
      ov.setFootprints([{ x: dp.x, z: dp.z, angle: dp.angle, w: sz.w, d: sz.d, color: 0x5ac8fa, y: dp.y, lift: 0.1 }]);
      this.showTip(`<b>${dp.kind === 'rail' ? 'Train' : 'Bus'} depot</b>${own(dp.owner)}`, 'info');
    } else if (hit.kind === 'edge') {
      const e = g.world.net.edges.get(hit.id)!;
      ov.setHoverEdge(e.id, 0xffffff);
      const name = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).name : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).name;
      this.showTip(`<b>${esc(name)}</b>${own(e.owner)}<div>${fmtLen(e.len)}${e.sections.length ? ' · ' + e.sections.map((s) => s.type).join(', ') : ''}</div>`, 'info');
    } else if (hit.kind === 'building') {
      const b = g.world.buildings.get(hit.id)!;
      ov.setFootprints([{ x: b.x, z: b.z, angle: b.angle, w: b.w, d: b.d, color: 0x5ac8fa, lift: 0.08 }]);
      this.showTip(`${b.pop} residents · ${esc(g.towns.list[b.townId]?.name ?? '')}`, 'info');
    } else if (hit.kind === 'town') {
      const t = g.towns.list[hit.id];
      this.showTip(`<b>${esc(t.name)}</b> · ${t.pop.toLocaleString('en-US')} residents`, 'info');
    }
  }

  /** Object under a ground point (stations first, then depots, network, buildings, towns). */
  hitAt(x: number, z: number): Hit | null {
    const g = this.game;
    for (const st of g.stations.footprintsNear(x, z, 0.05)) return { kind: 'station', id: st.id };
    for (const st of g.stations.map.values()) for (const s of st.stops) if (Math.hypot(s.x - x, s.z - z) < 0.75) return { kind: 'station', id: st.id };
    const dp = g.depots.near(x, z, 0.05)[0];
    if (dp) return { kind: 'depot', id: dp.id };
    const ne = g.world.net.nearestEdge(x, z, 0.55);
    if (ne) {
      if (ne.edge.station >= 0 && g.stations.get(ne.edge.station)) return { kind: 'station', id: ne.edge.station };
      if (ne.edge.depot >= 0 && g.depots.get(ne.edge.depot)) return { kind: 'depot', id: ne.edge.depot };
      return { kind: 'edge', id: ne.edge.id };
    }
    for (const b of g.world.buildingsNear(x, z, 3)) if (distToRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.02) return { kind: 'building', id: b.id };
    let bt = -1, bd = Infinity;
    for (const t of g.towns.list) { const d = Math.hypot(t.x - x, t.z - z); if (d < Math.max(8, t.radius * 0.85) && d < bd) { bd = d; bt = t.id; } }
    if (bt >= 0) return { kind: 'town', id: bt };
    return null;
  }

  private setCircle(x: number, z: number, r: number, color: number) {
    const u = this.terr;
    if (!u.uCircle) return;
    u.uCircle.value.set(x, z, r, r > 0 ? 1 : 0);
    u.uCircleColor?.value.setHex(color);
  }

  private coveredPop(x: number, z: number, r: number): number {
    const w = this.game.world;
    let pop = 0;
    for (const id of w.bgrid.query(x - r, z - r, x + r, z + r)) {
      const b = w.buildings.get(id);
      if (b && Math.hypot(b.x - x, b.z - z) <= r) pop += b.pop;
    }
    return pop;
  }

  // ------------------------------------------------------------------ placement helpers
  /** Station position/orientation at the cursor, lined up with a nearby track end or edge. */
  private stationPlacement(px: number, pz: number): { x: number; z: number; angle: number; snapped: '' | 'end' | 'edge' } {
    const net = this.game.world.net;
    if (this.autoAlign) {
      const L = this.stationLen;
      const reach = L / 2 + 10;
      let best: NNode | null = null, bd = reach;
      for (const id of net.nodeGrid.query(px - reach, pz - reach, px + reach, pz + reach)) {
        const n = net.nodes.get(id);
        if (!n || n.kind !== 'rail' || n.edges.length !== 1 || n.owner !== PLAYER) continue;
        const e = net.edges.get(n.edges[0]);
        if (!e || e.depot >= 0 || e.station >= 0) continue;
        const d = Math.hypot(n.x - px, n.z - pz);
        if (d < bd) { bd = d; best = n; }
      }
      if (best) {
        const e = net.edges.get(best.edges[0])!;
        const ld = net.leaveDir(e, best.id);
        const ox = -ld.x, oz = -ld.z;
        const along0 = (px - best.x) * ox + (pz - best.z) * oz;
        if (along0 > -1) {
          const a = Math.atan2(ox, oz);
          const rx = Math.cos(a), rz = -Math.sin(a);
          let along = Math.max(L / 2 + 1.5, along0);
          const lat = (px - best.x) * rx + (pz - best.z) * rz;
          const offs = stationLayout(this.stationTracks).trackOffsets;
          let k = offs[0];
          for (const o of offs) if (Math.abs(lat + o) < Math.abs(lat + k)) k = o;
          // leave enough room to connect at the track's grade limit (station level follows the terrain)
          const grade = (TRACK_TYPES[this.railType] ?? TRACK_TYPES.standard).maxGrade * 0.85;
          const y = this.game.stations.planRail(best.x + ox * along - rx * k, best.z + oz * along - rz * k, a, L, this.stationTracks, PLAYER).y;
          along = Math.max(along, L / 2 + Math.min(20, Math.max(1.5, Math.abs(y - best.y) / grade + 1.2)));
          return { x: best.x + ox * along - rx * k, z: best.z + oz * along - rz * k, angle: a, snapped: 'end' };
        }
      }
      const ne = net.nearestEdge(px, pz, 3, 'rail', (e) => e.depot < 0 && e.station < 0);
      if (ne) {
        const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
        net.pointAt(ne.edge, ne.s, q, d);
        let a = Math.atan2(d.x, d.z);
        if (Math.cos(a - this.stationAngle) < 0) a += Math.PI;
        return { x: px, z: pz, angle: norm(a), snapped: 'edge' };
      }
    }
    return { x: px, z: pz, angle: this.stationAngle, snapped: '' };
  }

  private planDepot(kind: NetKind, px: number, pz: number): DepotPlan {
    const g = this.game;
    const pos = this.depotPlacement(kind, px, pz);
    const pl = g.depots.plan(kind, pos.x, pos.z, pos.angle, PLAYER);
    if (pl.snapNode >= 0) {
      const n = g.world.net.nodes.get(pl.snapNode);
      if (n && n.owner !== PLAYER && pl.ok) { pl.ok = false; pl.error = `Track owned by ${g.company(n.owner).name}`; }
    }
    return pl;
  }

  /** Depot position: road depots face the nearest road at a connectable distance. */
  private depotPlacement(kind: NetKind, px: number, pz: number): { x: number; z: number; angle: number; road: boolean } {
    if (kind === 'road') {
      const net = this.game.world.net;
      const ne = net.nearestEdge(px, pz, 4, 'road', (e) => e.depot < 0);
      if (ne) {
        const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
        net.pointAt(ne.edge, ne.s, q, d);
        let ux = px - q.x, uz = pz - q.z;
        const l = Math.hypot(ux, uz);
        if (l < 0.05) { const dl = Math.hypot(d.x, d.z) || 1; ux = -d.z / dl; uz = d.x / dl; } else { ux /= l; uz /= l; }
        const sz = depotSize('road');
        const off = net.halfWidth(ne.edge) + 1.25 + sz.d / 2 + 0.3;
        return { x: q.x + ux * off, z: q.z + uz * off, angle: Math.atan2(-ux, -uz), road: true };
      }
    }
    return { x: px, z: pz, angle: this.depotAngle, road: false };
  }

  // ------------------------------------------------------------------ planning (track / road)
  private validStart(): Snap | null {
    const s = this.start;
    if (!s) return null;
    const g = this.game, net = g.world.net;
    if (s.kind === 'node') {
      const n = net.nodes.get(s.node!);
      this.start = n ? findSnap(g, this.kind, n.x, n.z, 0.02) : findSnap(g, this.kind, s.x, s.z, 0.3);
    } else if (s.kind === 'edge' && !net.edges.has(s.edge!)) this.start = findSnap(g, this.kind, s.x, s.z, 0.3);
    return this.start;
  }

  private planNow(): Proposal | null {
    this.planDirty = false;
    const start = this.validStart();
    const end = this.hoverSnap;
    if (!start || !end) return null;
    const opts = this.buildOptions();
    const key = `${snapKey(start)}|${snapKey(end)}|${JSON.stringify(opts)}|${this.game.networkVersion}`;
    if (key === this.planKey && this.proposal) return this.proposal;
    this.planKey = key;
    const t0 = performance.now();
    const p = planEdge(this.game, start, end, opts);
    const own = this.ownErr(start) ?? this.ownErr(end);
    if (own) { p.ok = false; p.errors.unshift(own); }
    this.planMs = performance.now() - t0;
    this.planAt = performance.now();
    this.proposal = p;
    this.overlay.setProposal(p);
    this.showSnap('start', start, 0xffffff, 'start');
    this.showPlanTip();
    return p;
  }

  private commitChain() {
    const g = this.game;
    if (!this.start) return;
    if (this.ground && (!this.hoverSnap || this.planDirty || !this.proposal)) { this.hoverSnap = this.snapAt(this.kind); this.planKey = ''; }
    const p = this.planNow();
    if (!p) return;
    if (!p.ok) {
      if (p.errors[0] !== 'Too short') this.ui.toast(p.errors[0] ?? 'Cannot build here', 'bad');
      return;
    }
    const err = commitProposal(g, p);
    if (err) { this.ui.toast(err, 'bad'); return; }
    this.ui.floatCost(p.cost, this.client.x, this.client.y);
    this.ui.sound('build');
    const end = this.hoverSnap!;
    this.proposal = null;
    this.overlay.setProposal(null);
    this.planKey = '';
    if (end.kind === 'free') {
      // continue the chain from the new end (tangent continuity comes from the end node direction)
      let x = 0, z = 0;
      for (const tp of p.tracks) { x += tp.bez.x3; z += tp.bez.z3; }
      x /= p.tracks.length; z /= p.tracks.length;
      const ns = findSnap(g, this.kind, x, z, 0.3);
      if (ns.kind === 'node') this.setStart(ns); else this.endChain();
    } else this.endChain();
    this.moveDirty = true;
  }

  private describeSnap(sn: Snap, err: string | null): string {
    if (err) return esc(err);
    const g = this.game, net = g.world.net;
    const rail = this.kind === 'rail';
    if (sn.kind === 'node') {
      const n = net.nodes.get(sn.node!);
      const cnt = sn.group?.length ?? 1;
      const st = n?.edges.map((id) => net.edges.get(id)).find((e) => e && e.station >= 0);
      if (st) return `Click to build from the platform end${cnt > 1 ? ` (${cnt} tracks)` : ''}`;
      if (n && n.edges.length === 1) return rail ? `Click to extend ${cnt > 1 ? `${cnt} parallel tracks` : 'the track'}` : 'Click to extend the road';
      return rail ? 'Click to build from this switch' : 'Click to build from this junction';
    }
    if (sn.kind === 'edge') return rail ? 'Click to branch off (new switch)' : 'Click to start a junction here';
    const t = rail ? `${this.tracks > 1 ? this.tracks + ' parallel tracks' : 'track'}` : 'road';
    return `Click to start a new ${t}${this.heightOffset ? ` at ${fmtHeight(this.heightOffset)}` : ''}`;
  }

  private showPlanTip() {
    const p = this.proposal;
    if (!p) return;
    const g = this.game;
    const N = Math.max(1, p.tracks.length);
    const st = p.stats;
    if (p.errors[0] === 'Too short') { this.showTip('Move the cursor to plan the next section · right-click/Esc to stop', 'info'); return; }
    const parts: string[] = [];
    parts.push(`<b>${fmtMoney(p.cost)}</b> · ${fmtLen(st.len / N)}${N > 1 ? ` × ${N} tracks` : ''}`);
    const rad = isFinite(st.minRadius) && st.minRadius < 5000 ? `radius ${Math.round(st.minRadius * 10).toLocaleString('en-US')} m` : 'straight';
    parts.push(`grade ${(st.maxGrade * 100).toFixed(1)}% · ${rad} · ${Math.round(st.speed)} km/h`);
    const struct: string[] = [];
    if (st.bridges) struct.push(`${st.bridges} bridge${st.bridges > 1 ? 's' : ''}`);
    if (st.tunnels) struct.push(`${st.tunnels} tunnel${st.tunnels > 1 ? 's' : ''}`);
    if (p.crossings.length) {
      const m = new Map<string, number>();
      for (const c of p.crossings) m.set(CROSS_LABEL[c.mode], (m.get(CROSS_LABEL[c.mode]) ?? 0) + 1);
      struct.push([...m].map(([k, v]) => `${v} ${k}${v > 1 ? (k.endsWith('ss') ? 'es' : 's') : ''}`).join(', '));
    }
    if (p.demolish.length) struct.push(`demolishes ${p.demolish.length} building${p.demolish.length > 1 ? 's' : ''}`);
    if (this.heightOffset) struct.push(`height ${fmtHeight(this.heightOffset)}`);
    if (struct.length) parts.push(struct.join(' · '));
    let html = parts.map((s) => `<div>${s}</div>`).join('');
    for (const w of p.warnings) html += `<div class="tt-warn">${esc(w)}</div>`;
    if (p.errors.length) html += `<div class="tt-err">${esc(p.errors[0])}</div>`;
    const ok = p.ok && g.economy.canAfford(p.cost);
    this.showTip(html, ok ? 'ok' : 'err');
  }

  // ------------------------------------------------------------------ clicks
  private click(e: PointerEvent) {
    const g = this.game;
    const p = this.ground;
    switch (this.tool) {
      case 'inspect': {
        const vid = this.ui.renderer.pickVehicle(e.clientX, e.clientY);
        if (vid != null) { this.ui.openVehicle(vid); return; }
        if (!p) return;
        const hit = this.hitAt(p.x, p.z);
        if (hit) this.ui.openHit(hit);
        return;
      }
      case 'line-edit': {
        if (!p || this.lineEditId == null) return;
        const hit = this.hitAt(p.x, p.z);
        if (hit?.kind === 'station') this.ui.addStopToLine(this.lineEditId, hit.id);
        return;
      }
      case 'station': {
        if (!p) return;
        const pos = this.stationPlacement(p.x, p.z);
        const pl = g.stations.planRail(pos.x, pos.z, pos.angle, this.stationLen, this.stationTracks, PLAYER);
        this.stationPlan = null;
        const err = g.stations.commitRail(pl, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(pl.cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'busstop': {
        if (!p) return;
        const cost = g.stations.planBusStop(p.x, p.z, PLAYER).cost;
        const err = g.stations.commitBusStop(p.x, p.z, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'depot-rail':
      case 'depot-road': {
        if (!p) return;
        const kind: NetKind = this.tool === 'depot-rail' ? 'rail' : 'road';
        const pl = this.planDepot(kind, p.x, p.z);
        this.depotPlan = null;
        if (!pl.ok) { this.ui.toast(pl.error ?? 'Cannot build', 'bad'); return; }
        const err = g.depots.commit(kind, pl, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(pl.cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'signal': {
        if (!p) return;
        const n = g.world.net.nearestNode(p.x, p.z, 0.8, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
        if (n && n.owner !== PLAYER) { this.ui.toast(`Signal of ${g.company(n.owner).name}`, 'bad'); return; }
        const err = toggleSignal(g, p.x, p.z, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else this.ui.sound('click');
        break;
      }
    }
    this.moveDirty = true;
  }

  private doBulldoze(x0: number, z0: number, x1: number, z1: number) {
    const g = this.game;
    const r = bulldoze(g, x0, z0, x1, z1, PLAYER, false);
    if (r.error) this.ui.toast(r.error, 'bad');
    if (r.changed) { this.ui.floatCost(r.cost, this.client.x, this.client.y); this.ui.sound('demolish'); }
    this.overlay.setHoverEdge(null);
    this.hideTip();
  }

  // ------------------------------------------------------------------ tooltip
  private showTip(html: string, kind: 'ok' | 'err' | 'info' = 'info') {
    const t = this.tooltip;
    if (t.innerHTML !== html) t.innerHTML = html;
    t.className = 'tooltip ' + kind;
    t.style.display = 'block';
    this.positionTip();
  }
  hideTip() { this.tooltip.style.display = 'none'; }
  private positionTip() {
    const t = this.tooltip;
    if (t.style.display === 'none') return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = this.client.x + 18, y = this.client.y + 16;
    if (x + w > W - 6) x = this.client.x - w - 14;
    if (y + h > H - 6) y = this.client.y - h - 12;
    t.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }
}

function norm(a: number) { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; }
