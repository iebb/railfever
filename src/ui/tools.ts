// Map interaction tools: Transport-Fever-style track & road construction (click-click chains with live
// preview), stations, depots, signals, demolition, terraforming and object queries.
import * as THREE from 'three';
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { findSnap, planEdge, commitProposal, Snap, Proposal, BuildOptions } from '../game/construction';
import { toggleSignal, bulldoze, terraformBrush, depotSize, DepotPlan } from '../game/build-ops';
import { brush as brushVolume } from '../game/terraform';
import { bezOffset, startTangent, endTangent } from '../game/geom';
import { stationLayout, StationPlan } from '../game/stations';
import { fmtMoney } from '../game/economy';
import { STATION_RADIUS, BUSSTOP_RADIUS, NetKind, TRACK_TYPES, ROAD_TYPES, RAIL } from '../game/constants';
import { CROSS_LABEL, MarkerKind } from '../render/overlay';
import { distToRect } from '../game/world';
import type { NNode, NEdge } from '../game/network';
import { esc, svg } from './dom';
import { fmtLen, fmtHeight } from './format';

export type ToolId = 'inspect' | 'rail' | 'road' | 'station' | 'busstop' | 'depot-rail' | 'depot-road' | 'signal' | 'bulldoze' | 'terraform' | 'line-edit';
export type CrossingPref = BuildOptions['crossing'];

export const TOOL_INFO: Record<ToolId, { name: string; hint: string }> = {
  inspect: { name: 'Inspect', hint: 'Click stations, vehicles, depots, towns, buildings or tracks for details.' },
  rail: { name: 'Build track', hint: 'Click to start, click again to build — construction continues from the new end with a smooth curve. Right-click, Esc or a long press ends the chain. Snap onto track ends to extend, onto track to branch. Hold Shift over a track to copy it as a parallel track.' },
  road: { name: 'Build road', hint: 'Click to start, click again to build — continues from the new end. Snap onto roads to create junctions. Connect to town streets so buses can reach them.' },
  station: { name: 'Train station', hint: 'Click to place. R / Shift+R or Ctrl+wheel rotate by 15°. Lines up with a nearby track end; connect its tracks with the track tool.' },
  busstop: { name: 'Bus stop', hint: 'Click on a road. Next to one of your train stations it joins it (passengers transfer).' },
  'depot-rail': { name: 'Train depot', hint: 'Click near a free end of your track (it snaps on), or place it and connect it with track. R rotates.' },
  'depot-road': { name: 'Bus depot', hint: 'Click next to a road: the depot faces it and connects itself. R rotates when away from roads.' },
  signal: { name: 'Signals', hint: 'Click a track to add a signal. Click a signal to cycle two-way → one-way → one-way (reversed) → none. Signals split track into blocks so trains can follow each other.' },
  bulldoze: { name: 'Demolish', hint: 'Click to remove an object, or drag a rectangle to clear an area. Other companies’ property is protected.' },
  terraform: { name: 'Terraform', hint: 'Hold the left button to raise or lower the ground under the brush. Level flattens to the height where you press.' },
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

export { fmtHeight };

/** Content of the build tooltip card. */
interface Tip { title?: string; cost?: number; rows?: [string, string][]; err?: string[]; warn?: string[]; ok?: string[]; hint?: string }
const pill = (cls: string, ic: string, t: string) => `<span class="pill ${cls}">${svg(ic, 12)}${esc(t)}</span>`;
function tipHtml(c: Tip): string {
  let s = '';
  if (c.title) s += `<div class="tt-title">${c.title}</div>`;
  if (c.cost !== undefined) s += `<div class="tt-cost">${fmtMoney(c.cost)}</div>`;
  if (c.rows?.length) s += `<div class="tt-rows">${c.rows.map(([ic, t]) => `<div class="tt-row">${svg(ic, 14)}<span>${t}</span></div>`).join('')}</div>`;
  const pills = [...(c.err ?? []).map((t) => pill('err', 'warning', t)), ...(c.warn ?? []).map((t) => pill('warn', 'warning', t)), ...(c.ok ?? []).map((t) => pill('ok', 'check', t))];
  if (pills.length) s += `<div class="tt-pills">${pills.join('')}</div>`;
  if (c.hint) s += `<div class="tt-hint">${c.hint}</div>`;
  return s;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
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
  private down: { x: number; y: number; button: number; ground: THREE.Vector3 | null; moved: boolean; hadStart: boolean; id: number; touch: boolean; t: number } | null = null;
  private touches = new Set<number>();
  private shift = false;
  private parallel: { edge: number; side: number; prop: Proposal } | null = null;
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
    window.addEventListener('pointercancel', (e) => { this.touches.delete(e.pointerId); if (this.down?.id === e.pointerId) this.down = null; });
    // Ctrl+wheel rotates stations and depots (captured before the camera zooms)
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    const shift = (e: KeyboardEvent) => { if (e.key === 'Shift' && this.shift !== (e.type === 'keydown')) { this.shift = e.type === 'keydown'; if (this.tool === 'rail') this.moveDirty = true; } };
    window.addEventListener('keydown', shift);
    window.addEventListener('keyup', shift);
    window.addEventListener('blur', () => { this.shift = false; });
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
    this.parallel = null;
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
    this.overlay.setDemolish(null);
    this.overlay.setMarker('start0', null);
    for (let i = 1; i < 4; i++) this.overlay.setMarker('start' + i, null);
    const u = this.terr;
    if (u.uHiOn) u.uHiOn.value = 0;
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ pointer events
  private onDown = (e: PointerEvent) => {
    if (!this.game || e.altKey || (e.button !== 0 && e.button !== 2)) return;
    const touch = e.pointerType === 'touch';
    if (touch) {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // a second finger: camera gesture, abandon what the first one started
        if (this.down && !this.down.hadStart && this.building) this.endChain();
        this.down = null;
        return;
      }
    }
    this.client = { x: e.clientX, y: e.clientY };
    this.overMap = true;
    this.shift = e.shiftKey;
    this.ground = this.pick();
    this.down = { x: e.clientX, y: e.clientY, button: e.button, ground: this.ground?.clone() ?? null, moved: false, hadStart: !!this.start, id: e.pointerId, touch, t: performance.now() };
    if (e.button !== 0) return;
    const p = this.ground;
    if (!p) return;
    if (this.tool === 'rail' && !this.start && e.shiftKey) {
      this.down = null;
      this.buildParallel();
      return;
    }
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
    if (e.pointerType === 'touch' && this.touches.size > 1) return;
    if (this.down && e.pointerId !== this.down.id) return;
    this.client = { x: e.clientX, y: e.clientY };
    if (e.shiftKey !== this.shift && this.tool === 'rail') { this.shift = e.shiftKey; this.moveDirty = true; }
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
    this.touches.delete(e.pointerId);
    const d = this.down;
    if (!d || e.button !== d.button || e.pointerId !== d.id) return;
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
        this.overlay.setDisc(null);
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
    const best = this.edgeAtCursor(kind, (e) => e.depot < 0);
    if (best) return findSnap(g, kind, best.x, best.z, 0.3);
    return findSnap(g, kind, p.x, p.z, Math.max(0.3, Math.min(2, this.camDist() * 0.012)));
  }

  /** Edge closest to the cursor in screen space (within 12 px), with the nearest world point on it. */
  private edgeAtCursor(kind: NetKind, pred: (e: NEdge) => boolean, tol = 12): { edge: NEdge; x: number; z: number; d: number } | null {
    const net = this.game.world.net;
    const p = this.ground;
    if (!p) return null;
    const cx = this.client.x, cy = this.client.y;
    const R = Math.max(3, Math.min(16, this.camDist() * 0.1));
    let best: { edge: NEdge; x: number; z: number; d: number } | null = null;
    for (const e of net.edgesNear(p.x - R, p.z - R, p.x + R, p.z + R)) {
      if (e.kind !== kind || !pred(e)) continue;
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
          if (d < tol && (!best || d < best.d)) best = { edge: e, x: geo.pts[pi * 3] + (geo.pts[j * 3] - geo.pts[pi * 3]) * f, z: geo.pts[pi * 3 + 2] + (geo.pts[j * 3 + 2] - geo.pts[pi * 3 + 2]) * f, d };
        }
        prev = s; pi = j;
        if (i < geo.n - 1 && i + step > geo.n - 1) i = geo.n - 1 - step;
      }
    }
    return best;
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
    this.showSnap('start', sn, 0xffb020, 'start');
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
    // long press (touch) ends a construction chain
    const d = this.down;
    if (d && d.touch && !d.moved && performance.now() - d.t > 650 && (this.start || this.dragRect)) {
      this.endChain();
      this.ui.toast('Construction ended', 'info');
    }
    // terraform brush while the button is held
    if (this.tool === 'terraform' && this.down?.button === 0 && this.ground) {
      this.brush.timer -= dt;
      if (this.brush.timer <= 0) {
        this.brush.timer = 0.12;
        const r = terraformBrush(g, this.ground.x, this.ground.z, this.brushRadius, this.terraMode, this.brush.level, PLAYER);
        if (r.error) { if (!this.brush.err) this.ui.toast(r.error, 'bad'); this.brush.err = true; }
        else this.brush.cost += r.cost;
        const what = this.terraMode === 'level' ? `Levelling to ${Math.round(this.brush.level * 10)} m` : this.terraMode === 'raise' ? 'Raising ground' : 'Lowering ground';
        this.tip({ title: what, cost: this.brush.cost, err: this.brush.err ? ['Not enough money'] : [] }, this.brush.err ? 'err' : 'info');
        if (this.terraMode === 'level') this.overlay.setDisc({ x: this.ground.x, z: this.ground.z, r: this.brushRadius, y: this.brush.level + 0.03, color: 0xffb020 });
      }
    }
    // bulldoze rectangle preview (throttled dry run)
    if (this.dragRect && this.ground && this.down) {
      const r = this.dragRect;
      r.x1 = this.ground.x; r.z1 = this.ground.z;
      const u = this.terr;
      if (u.uHiRect && u.uHiOn && u.uHiColor) {
        u.uHiRect.value.set(Math.min(r.x0, r.x1), Math.min(r.z0, r.z1), Math.max(r.x0, r.x1), Math.max(r.z0, r.z1));
        u.uHiColor.value.setHex(0xff5a5f);
        u.uHiOn.value = 1;
      }
      const now = performance.now();
      if (now - this.dozeAt > 120) {
        this.dozeAt = now;
        const res = bulldoze(g, r.x0, r.z0, r.x1, r.z1, PLAYER, true);
        this.tip(res.changed ? { title: 'Clear area', cost: res.cost, rows: [['bulldoze', plural(res.changed, 'object')]], err: res.error ? [res.error] : [] } : { title: 'Clear area', rows: [['info', 'Nothing to remove']] }, res.changed ? 'err' : 'info');
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
        if (this.tool === 'rail' && !this.start && this.shift && this.hoverParallel()) break;
        if (this.parallel) { this.parallel = null; ov.setProposal(null); ov.setHoverEdge(null); ov.setDemolish(null); }
        const sn = this.snapAt(this.kind);
        this.hoverSnap = sn;
        const err = this.ownErr(sn);
        this.showSnap('hover', sn, err ? 0xff5a4a : sn.kind === 'node' ? 0x5ff07a : sn.kind === 'edge' ? 0xffd84a : 0xffffff);
        if (this.start) { this.planDirty = true; this.positionTip(); }
        else this.tip(this.describeSnap(sn, err), err ? 'err' : 'info');
        break;
      }
      case 'station': {
        const pos = this.stationPlacement(p.x, p.z);
        const pl = g.stations.planRail(pos.x, pos.z, pos.angle, this.stationLen, this.stationTracks, PLAYER);
        this.stationPlan = pl;
        ov.setStationGhost(pl);
        ov.setDemolish(pl.ok ? pl.demolish : null);
        const R = STATION_RADIUS + this.stationLen / 2;
        this.setCircle(pos.x, pos.z, R, pl.ok ? 0x3ccb7f : 0xff6b6b);
        const pop = this.coveredPop(pos.x, pos.z, R);
        const rows: [string, string][] = [['station', `${plural(this.stationTracks, 'track')} × ${this.stationLen * 10} m`], ['people', `<b>${pop.toLocaleString('en-US')}</b> residents in reach`]];
        if (pl.join) rows.push(['plus', `Joins ${esc(pl.join.name)}`]);
        if (pos.snapped) rows.push(['target', pos.snapped === 'end' ? 'Lined up with the track end' : 'Aligned with the track']);
        this.tip({ title: 'Train station', cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : [pl.error ?? 'Cannot build'], warn: [...(pl.ok && pl.demolish.length ? [`Demolishes ${plural(pl.demolish.length, 'building')}`] : []), ...(pl.ok && !g.economy.canAfford(pl.cost) ? ['Not enough money'] : [])] }, pl.ok ? 'ok' : 'err');
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
          this.setCircle(q.x, q.z, BUSSTOP_RADIUS, 0x3ccb7f);
          const pop = this.coveredPop(q.x, q.z, BUSSTOP_RADIUS);
          const rows: [string, string][] = [['people', `<b>${pop.toLocaleString('en-US')}</b> residents in reach`]];
          if (pl.join) rows.push(['plus', `Joins ${esc(pl.join.name)}`]);
          this.tip({ title: 'Bus stop', cost: pl.cost, rows, warn: g.economy.canAfford(pl.cost) ? [] : ['Not enough money'] }, 'ok');
        } else {
          ov.setFootprints(null);
          ov.setMarker('hover0', { x: p.x, y: p.y, z: p.z }, 'free', 0xff5a4a);
          this.setCircle(0, 0, 0, 0);
          this.tip({ title: 'Bus stop', err: [pl.error ?? 'Cannot build'] }, 'err');
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
        ov.setDemolish(pl.demolish?.length ? pl.demolish : null);
        const how = pl.snapNode >= 0 ? 'Connects to the track end' : kind === 'road' && pos.road ? 'Connects to the road' : kind === 'rail' ? 'Connect it with track afterwards' : 'Place it next to a road';
        const nd = pl.demolish?.length ?? 0;
        this.tip({ title: kind === 'rail' ? 'Train depot' : 'Bus depot', cost: pl.ok ? pl.cost : undefined, rows: [[pl.snapNode >= 0 || pos.road ? 'check' : 'info', how]], err: pl.ok ? [] : [pl.error ?? 'Cannot build'], warn: [...(nd ? [`Demolishes ${plural(nd, 'building')}`] : []), ...(pl.ok && !g.economy.canAfford(pl.cost) ? ['Not enough money'] : [])] }, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'signal': this.hoverSignal(p); break;
      case 'bulldoze': {
        if (this.dragRect) break;
        const net = g.world.net;
        const ne = net.nearestEdge(p.x, p.z, 0.9);
        ov.setHoverEdge(ne && ne.edge.station < 0 && ne.edge.depot < 0 ? ne.edge.id : null, 0xff5a5f);
        const now = performance.now();
        if (now - this.dozeAt < 40) break;
        this.dozeAt = now;
        const r = bulldoze(g, p.x, p.z, p.x, p.z, PLAYER, true);
        if (r.changed) this.tip({ title: 'Demolish', cost: r.cost, err: r.error ? [r.error] : [], hint: 'Drag to clear an area' }, 'err');
        else if (r.error) this.tip({ title: 'Demolish', err: [r.error] }, 'err');
        else this.hideTip();
        break;
      }
      case 'terraform': {
        this.setCircle(p.x, p.z, this.brushRadius, this.terraMode === 'raise' ? 0x4ade80 : this.terraMode === 'lower' ? 0xff8a3d : 0xffb020);
        if (this.down) break;
        const h = g.world.heightAt(p.x, p.z);
        if (this.terraMode === 'level') {
          this.overlay.setDisc({ x: p.x, z: p.z, r: this.brushRadius, y: h + 0.03, color: 0xffb020 });
          this.tip({ title: 'Level ground', rows: [['level', `Flattens to <b>${Math.round(h * 10)} m</b> (where you press)`], ['catchment', `Radius ${this.brushRadius * 10} m`]], hint: 'Hold the button to apply' }, 'info');
        } else {
          const step = Math.round(brushVolume(g.world, p.x, p.z, this.brushRadius, this.terraMode, 0.25, 0, true) * 1500);
          this.tip({ title: this.terraMode === 'raise' ? 'Raise ground' : 'Lower ground', rows: [['coin', `≈ <b>${fmtMoney(step * 8)}</b> per second held`], ['catchment', `Radius ${this.brushRadius * 10} m`]], hint: 'Hold the button to apply' }, 'info');
        }
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
      ov.setMarker('hover0', n, 'signal', n.owner === PLAYER ? 0xffb020 : 0xff5a4a);
      ov.setHoverEdge(n.edges, 0xffb020);
      if (n.owner !== PLAYER) this.tip({ title: 'Signal', err: [`Belongs to ${g.company(n.owner).name}`] }, 'err');
      else this.tip({ title: 'Change signal', rows: [['signal', `${SIGNAL_NAMES[n.signal]} → <b>${SIGNAL_NAMES[(n.signal + 1) % 4]}</b>`]] }, 'info');
      return;
    }
    const ne = net.nearestEdge(p.x, p.z, 1.0, 'rail');
    if (!ne) { ov.setMarker('hover0', null); ov.setHoverEdge(null); this.tip({ title: 'Signals', rows: [['info', 'Point at one of your tracks']] }, 'info'); return; }
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
    ov.setMarker('hover0', q, 'signal', err ? 0xff5a4a : 0xffb020);
    ov.setHoverEdge(e.id, err ? 0xff5a4a : 0xffb020);
    this.tip(err ? { title: 'Signal', err: [err] } : { title: 'Two-way signal', cost: 9000, hint: 'Click again later to make it one-way' }, err ? 'err' : 'info');
  }

  private hoverInspect(p: THREE.Vector3) {
    const g = this.game, ov = this.overlay;
    const hit = this.hitAt(p.x, p.z);
    ov.setHoverEdge(null);
    ov.setFootprints(null);
    this.hoverStation = null;
    if (!hit) { this.hideTip(); return; }
    const own = (o: number): [string, string][] => (o === PLAYER ? [] : [['company', o < 0 ? 'Town' : esc(g.company(o).name)]]);
    if (hit.kind === 'station') {
      const st = g.stations.get(hit.id)!;
      this.hoverStation = st.id;
      const rects = g.stations.footprints(st).map((f) => ({ ...f, color: 0xffb020, y: st.rail?.y, lift: 0.12 }));
      for (const s of st.stops) rects.push({ x: s.x, z: s.z, angle: 0, w: 0.9, d: 0.9, color: 0xffb020, y: undefined, lift: 0.08 });
      ov.setFootprints(rects);
      if (this.tool === 'line-edit') {
        const l = this.lineEditId != null ? g.lines.get(this.lineEditId) : null;
        const okKind = l && (l.kind === 'rail' ? !!st.rail : st.stops.length > 0);
        const err = st.owner !== PLAYER ? 'Station of another company' : !okKind ? (l?.kind === 'rail' ? 'No train platforms' : 'No bus stop') : '';
        this.tip(err ? { title: esc(st.name), err: [err] } : { title: esc(st.name), ok: [`Add to ${l?.name ?? 'line'}`] }, err ? 'err' : 'ok');
      } else this.tip({ title: esc(st.name), rows: [...own(st.owner), ['people', `<b>${st.waitingTotal}</b> waiting`], ['star', `Rating <b>${(st.rating * 100).toFixed(0)}%</b>`]] }, 'info');
      return;
    }
    if (this.tool === 'line-edit') { this.hideTip(); return; }
    if (hit.kind === 'depot') {
      const dp = g.depots.get(hit.id)!;
      const sz = depotSize(dp.kind);
      ov.setFootprints([{ x: dp.x, z: dp.z, angle: dp.angle, w: sz.w, d: sz.d, color: 0xffb020, y: dp.y, lift: 0.1 }]);
      this.tip({ title: dp.kind === 'rail' ? 'Train depot' : 'Bus depot', rows: own(dp.owner), hint: dp.owner === PLAYER ? 'Click to buy vehicles' : undefined }, 'info');
    } else if (hit.kind === 'edge') {
      const e = g.world.net.edges.get(hit.id)!;
      ov.setHoverEdge(e.id, 0xffb020);
      const name = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).name : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).name;
      this.tip({ title: esc(name), rows: [...own(e.owner), ['length', fmtLen(e.len) + (e.sections.length ? ' · ' + e.sections.map((s) => s.type).join(', ') : '')]] }, 'info');
    } else if (hit.kind === 'building') {
      const b = g.world.buildings.get(hit.id)!;
      ov.setFootprints([{ x: b.x, z: b.z, angle: b.angle, w: b.w, d: b.d, color: 0xffb020, lift: 0.08 }]);
      this.tip({ title: esc(g.towns.list[b.townId]?.name ?? 'Building'), rows: [['people', `<b>${b.pop}</b> residents`]] }, 'info');
    } else if (hit.kind === 'town') {
      const t = g.towns.list[hit.id];
      this.tip({ title: esc(t.name), rows: [['people', `<b>${t.pop.toLocaleString('en-US')}</b> residents`]] }, 'info');
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
    this.overlay.setDemolish(p.demolish);
    this.showSnap('start', start, 0xffb020, 'start');
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
    this.overlay.setDemolish(null);
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

  private describeSnap(sn: Snap, err: string | null): Tip {
    const rail = this.kind === 'rail';
    if (err) return { title: rail ? 'Track' : 'Road', err: [err] };
    const net = this.game.world.net;
    if (sn.kind === 'node') {
      const n = net.nodes.get(sn.node!);
      const cnt = sn.group?.length ?? 1;
      const st = n?.edges.map((id) => net.edges.get(id)).find((e) => e && e.station >= 0);
      if (st) return { title: 'Platform end', rows: [['rail', `Click to build out of the station${cnt > 1 ? ` (${cnt} tracks)` : ''}`]] };
      if (n && n.edges.length === 1) return { title: rail ? 'Track end' : 'Road end', rows: [[rail ? 'rail' : 'road', rail ? `Click to extend ${cnt > 1 ? `${cnt} parallel tracks` : 'the track'}` : 'Click to extend the road']] };
      return { title: rail ? 'Switch' : 'Junction', rows: [[rail ? 'rail' : 'road', 'Click to build from here']] };
    }
    if (sn.kind === 'edge') return { title: rail ? 'Branch off' : 'New junction', rows: [[rail ? 'rail' : 'road', rail ? 'Click to start a switch here' : 'Click to start a junction here']] };
    const t = rail ? (this.tracks > 1 ? `${this.tracks} parallel tracks` : 'Single track') : (ROAD_TYPES[this.roadType] ?? ROAD_TYPES.road).name;
    const rows: [string, string][] = [[rail ? 'rail' : 'road', `Click to start · ${esc(t)}`]];
    if (this.heightOffset) rows.push(['height', `Section ends at <b>${fmtHeight(this.heightOffset)}</b>`]);
    return { title: rail ? 'New track' : 'New road', rows, hint: rail ? 'Hold Shift over a track to copy it in parallel' : undefined };
  }

  private showPlanTip() {
    const p = this.proposal;
    if (!p) return;
    const g = this.game;
    const N = Math.max(1, p.tracks.length);
    const st = p.stats;
    if (p.errors[0] === 'Too short') { this.tip({ title: p.opts.kind === 'rail' ? 'Track' : 'Road', rows: [['target', 'Move the cursor to plan the next section']], hint: 'Right-click or Esc ends construction' }, 'info'); return; }
    this.tip(this.proposalTip(p, N), p.ok && g.economy.canAfford(p.cost) ? 'ok' : 'err');
  }

  /** Tooltip card of a planned track / road. */
  private proposalTip(p: Proposal, N: number, title?: string): Tip {
    const st = p.stats;
    const rows: [string, string][] = [];
    rows.push(['length', `<b>${fmtLen(st.len / N)}</b>${N > 1 ? ` × ${N} tracks` : ''}`]);
    rows.push(['speed', `<b>${Math.round(st.speed)}</b> km/h`]);
    rows.push(['grade', `grade <b>${(st.maxGrade * 100).toFixed(1)}%</b>`]);
    rows.push(['radius', isFinite(st.minRadius) && st.minRadius < 5000 ? `radius <b>${Math.round(st.minRadius * 10).toLocaleString('en-US')} m</b>` : 'straight']);
    if (st.bridges || st.tunnels) rows.push([st.bridges ? 'bridge' : 'tunnel', [st.bridges ? plural(st.bridges, 'bridge') : '', st.tunnels ? plural(st.tunnels, 'tunnel') : ''].filter(Boolean).join(' · ')]);
    if (p.crossings.length) {
      const m = new Map<string, number>();
      for (const c of p.crossings) m.set(CROSS_LABEL[c.mode], (m.get(CROSS_LABEL[c.mode]) ?? 0) + 1);
      rows.push(['crossing', [...m].map(([k, v]) => `${v} ${k}${v > 1 ? (k.endsWith('ss') ? 'es' : 's') : ''}`).join(', ')]);
    }
    if (this.heightOffset && this.hoverSnap?.kind === 'free' && !title) rows.push(['height', `end ${fmtHeight(this.heightOffset)}`]);
    const warn = [...p.warnings];
    if (p.demolish.length) warn.unshift(`Demolishes ${plural(p.demolish.length, 'building')}`);
    return { title: title ?? (p.opts.kind === 'rail' ? (N > 1 ? 'Parallel tracks' : 'Track') : (ROAD_TYPES[p.opts.type] ?? ROAD_TYPES.road).name), cost: p.cost, rows, warn, err: p.errors.slice(0, 1) };
  }

  // ------------------------------------------------------------------ parallel track copy (Shift)
  /** Plan (or build) a copy of a rail edge, offset sideways by the track spacing. */
  private parallelPlan(e: NEdge, side: number, commit: boolean): { prop: Proposal; err: string | null } {
    const g = this.game, net = g.world.net;
    const ob = bezOffset(e.bez, side * RAIL.spacing);
    const t0 = startTangent(ob), t1 = endTangent(ob);
    // temporary end nodes give the planner fixed tangents; they are removed again unless the copy is built
    const saveNext = net.nextNode, saveVer = net.version;
    const temp: number[] = [];
    let blocked = false;
    const endSnap = (x: number, z: number, y: number, dx: number, dz: number): Snap => {
      const s = findSnap(g, 'rail', x, z, 0.12);
      if (s.kind === 'node') return s;
      if (s.kind === 'edge') blocked = true;
      const n = net.addNode('rail', x, y, z, dx, dz, PLAYER);
      temp.push(n.id);
      return { kind: 'node', x, z, y, node: n.id, group: [n.id] };
    };
    try {
      const a = endSnap(ob.x0, ob.z0, e.prof[0], t0.x, t0.z);
      const b = endSnap(ob.x3, ob.z3, e.prof[e.prof.length - 1], -t1.x, -t1.z);
      const prop = planEdge(g, a, b, { ...this.buildOptions(), kind: 'rail', tracks: 1, heightOffset: 0 });
      const own = this.ownErr(a) ?? this.ownErr(b);
      if (own) { prop.ok = false; prop.errors.unshift(own); }
      if (blocked) { prop.ok = false; prop.errors.unshift('There is already a track on this side'); }
      return { prop, err: commit ? commitProposal(g, prop) : null };
    } finally {
      for (const id of temp) { const n = net.nodes.get(id); if (n && !n.edges.length) net.removeNode(id); }
      if (!commit) { net.nextNode = saveNext; net.version = saveVer; }
    }
  }

  /** Side of edge e (+1 right / -1 left of its direction) the cursor is on. */
  private sideOf(e: NEdge, x: number, z: number): number {
    const net = this.game.world.net;
    const ne = net.nearestEdge(x, z, 3, 'rail', (f) => f.id === e.id);
    const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, ne ? ne.s : e.len / 2, q, d);
    const p = this.ground!;
    return (p.x - q.x) * -d.z + (p.z - q.z) * d.x >= 0 ? 1 : -1;
  }

  /** Shift held over own track: preview a parallel copy. Returns false when nothing is under the cursor. */
  private hoverParallel(): boolean {
    const ov = this.overlay;
    const hit = this.edgeAtCursor('rail', (e) => e.station < 0 && e.depot < 0 && e.owner === PLAYER, 40);
    if (!hit || !this.ground) return false;
    const side = this.sideOf(hit.edge, this.ground.x, this.ground.z);
    const cur = this.parallel;
    const prop = cur && cur.edge === hit.edge.id && cur.side === side && this.planKey === `par:${this.game.networkVersion}:${this.railType}:${this.crossing}`
      ? cur.prop : this.parallelPlan(hit.edge, side, false).prop;
    this.planKey = `par:${this.game.networkVersion}:${this.railType}:${this.crossing}`;
    this.parallel = { edge: hit.edge.id, side, prop };
    for (let i = 0; i < 4; i++) ov.setMarker('hover' + i, null);
    ov.setProposal(prop);
    ov.setHoverEdge(hit.edge.id, 0xffffff);
    ov.setDemolish(prop.demolish);
    const tip = this.proposalTip(prop, 1, `Parallel track · ${side > 0 ? 'right' : 'left'}`);
    if (prop.ok) tip.hint = 'Shift+click to build';
    this.tip(tip, prop.ok && this.game.economy.canAfford(prop.cost) ? 'ok' : 'err');
    return true;
  }

  private buildParallel() {
    const hit = this.edgeAtCursor('rail', (e) => e.station < 0 && e.depot < 0 && e.owner === PLAYER, 40);
    if (!hit || !this.ground) { this.ui.toast('Hold Shift over one of your tracks to copy it', 'info'); return; }
    const side = this.sideOf(hit.edge, this.ground.x, this.ground.z);
    const r = this.parallelPlan(hit.edge, side, true);
    if (!r.prop.ok) { this.ui.toast(r.prop.errors[0] ?? 'Cannot build here', 'bad'); return; }
    if (r.err) { this.ui.toast(r.err, 'bad'); return; }
    this.ui.floatCost(r.prop.cost, this.client.x, this.client.y);
    this.ui.sound('build');
    this.parallel = null;
    this.planKey = '';
    this.moveDirty = true;
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
  private tip(c: Tip, kind: 'ok' | 'err' | 'info' = 'info') { this.showTip(tipHtml(c), kind); }

  private tipHtml = '';
  private tipKind = '';
  private tipShown = false;
  private showTip(html: string, kind: 'ok' | 'err' | 'info' = 'info') {
    const t = this.tooltip;
    if (html !== this.tipHtml) { this.tipHtml = html; t.innerHTML = html; }
    if (kind !== this.tipKind) { this.tipKind = kind; t.className = 'tooltip ' + kind; }
    if (!this.tipShown) { this.tipShown = true; t.style.display = 'block'; }
    this.positionTip();
  }
  hideTip() { if (this.tipShown) { this.tipShown = false; this.tooltip.style.display = 'none'; } }
  private positionTip() {
    const t = this.tooltip;
    if (!this.tipShown) return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = this.client.x + 18, y = this.client.y + 16;
    if (x + w > W - 6) x = this.client.x - w - 14;
    if (y + h > H - 6) y = this.client.y - h - 12;
    t.style.transform = `translate3d(${Math.max(4, x)}px, ${Math.max(4, y)}px, 0)`;
  }
}

function norm(a: number) { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; }
