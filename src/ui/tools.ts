// Map interaction tools.
import type { UI } from './ui';
import { planRoute, commitPlan, RoutePlan } from '../game/construction';
import {
  planRailStation, commitRailStation, planBusStop, commitBusStop, planDepot, commitDepot, autoDepotDir,
  toggleSignal, bulldoze, terraformCorner, levelArea,
} from '../game/build-ops';
import { fmtMoney } from '../game/economy';
import { STATION_RADIUS_RAIL, STATION_RADIUS_BUS, HSTEP } from '../game/constants';

export type ToolId = 'inspect' | 'rail' | 'road' | 'station' | 'busstop' | 'depot-rail' | 'depot-road' | 'signal' | 'bulldoze' | 'terraform' | 'line-edit';

export const TOOL_INFO: Record<ToolId, { name: string; hint: string }> = {
  inspect: { name: 'Inspect', hint: 'Click stations, vehicles, depots or towns for details.' },
  rail: { name: 'Build rail', hint: 'Drag from a track end or open ground to build track. Bridges, tunnels and grading are automatic.' },
  road: { name: 'Build road', hint: 'Drag to build a road. Connect to town streets to reach them with buses.' },
  station: { name: 'Train station', hint: 'Click to place. R rotates. Adjust length and platforms below. Built next to an existing station it joins it.' },
  busstop: { name: 'Bus stop', hint: 'Click on a straight road. Placed next to a train station it becomes part of that station (transfers!).' },
  'depot-rail': { name: 'Train depot', hint: 'Click next to a track end. R rotates. Trains are bought in depots.' },
  'depot-road': { name: 'Bus depot', hint: 'Click next to a road. R rotates. Buses are bought in depots.' },
  signal: { name: 'Signals', hint: 'Click plain track to cycle: two-way → one-way → one-way reversed → none. Signals split track into blocks so several trains can share it.' },
  bulldoze: { name: 'Demolish', hint: 'Click or drag an area to remove track, roads, stations, depots, trees or buildings.' },
  terraform: { name: 'Terraform', hint: 'Raise or lower terrain corners, or drag to level an area.' },
  'line-edit': { name: 'Edit line', hint: 'Click stations to add them as stops. Press Esc when done.' },
};

export class Tools {
  tool: ToolId = 'inspect';
  stationLen = 4;
  stationTracks = 2;
  stationAxis = 0;
  depotDir = 2;
  terraMode: 'raise' | 'lower' | 'level' = 'raise';
  lineEditId: number | null = null;
  private drag: { x: number; z: number; cx: number; cz: number; level: number } | null = null;
  private hoverX = -1; private hoverZ = -1;
  private hoverCX = -1; private hoverCZ = -1;
  private plan: RoutePlan | null = null;
  private planKey = '';
  private downPos: { x: number; y: number } | null = null;
  tooltip: HTMLDivElement;
  private lastClient = { x: 0, y: 0 };
  onToolChange: () => void = () => {};

  constructor(private ui: UI) {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    ui.root.appendChild(this.tooltip);
    const canvas = ui.renderer.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', (e) => {
      const t = e.target as HTMLElement;
      // follow the pointer over the map (and over map labels); ignore UI panels unless dragging
      if (this.drag || t === canvas || t.closest?.('.labels')) this.onMove(e);
    });
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => { this.tooltip.style.display = 'none'; });
  }

  get game() { return this.ui.game; }
  get overlay() { return this.ui.renderer.overlay; }

  setTool(t: ToolId) {
    if (this.tool === 'line-edit' && t !== 'line-edit') this.lineEditId = null;
    this.tool = t;
    this.drag = null;
    this.plan = null;
    this.planKey = '';
    this.overlay.clear();
    this.ui.renderer.terrain.uniforms.uHiOn.value = 0;
    const gridTools: ToolId[] = ['rail', 'road', 'station', 'busstop', 'depot-rail', 'depot-road', 'bulldoze', 'terraform', 'signal'];
    this.ui.renderer.terrain.uniforms.uGrid.value = gridTools.includes(t) ? 1 : 0;
    this.tooltip.style.display = 'none';
    this.onToolChange();
    this.refreshHover();
  }

  rotate() {
    if (this.tool === 'station') this.stationAxis = 1 - this.stationAxis;
    if (this.tool === 'depot-rail' || this.tool === 'depot-road') this.depotDir = (this.depotDir + 1) % 4;
    this.planKey = '';
    this.refreshHover();
  }

  cancel(): boolean {
    if (this.drag) { this.drag = null; this.plan = null; this.overlay.setPlan(null); this.overlay.hideArea(); this.tooltip.style.display = 'none'; return true; }
    if (this.tool !== 'inspect') { this.setTool('inspect'); return true; }
    return false;
  }

  private showTip(text: string, kind: 'ok' | 'err' | 'info' = 'info') {
    const t = this.tooltip;
    t.style.display = 'block';
    t.className = 'tooltip ' + kind;
    t.innerHTML = text;
    t.style.left = this.lastClient.x + 18 + 'px';
    t.style.top = this.lastClient.y + 14 + 'px';
  }
  private hideTip() { this.tooltip.style.display = 'none'; }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.altKey) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const p = this.ui.renderer.pickGround(e.clientX, e.clientY);
    const g = this.game;
    if (!p) return;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    const cx = Math.round(p.x), cz = Math.round(p.z);
    switch (this.tool) {
      case 'rail':
      case 'road':
      case 'bulldoze':
        this.drag = { x, z, cx, cz, level: 0 };
        this.planKey = '';
        this.updateHover(x, z, cx, cz);
        break;
      case 'terraform':
        if (this.terraMode === 'level') {
          this.drag = { x, z, cx, cz, level: g.world.cornerH(cx, cz) };
          this.updateHover(x, z, cx, cz);
        } else {
          const r = terraformCorner(g, cx, cz, this.terraMode === 'raise' ? 1 : -1);
          if (!r.ok) this.ui.toast(r.error!, 'bad');
          else this.ui.floatCost(r.cost, e.clientX, e.clientY);
          this.updateHover(x, z, cx, cz);
        }
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const clicked = this.downPos && Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) < 6;
    this.downPos = null;
    const g = this.game;
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (this.tool === 'rail' || this.tool === 'road') {
        if (this.planTimer) {
          // a plan for the final position is still pending: compute it now
          clearTimeout(this.planTimer);
          this.planTimer = 0;
          this.plan = planRoute(g, this.tool, d.x, d.z, this.hoverX, this.hoverZ);
        }
        if (this.plan && this.plan.steps.length) {
          const err = commitPlan(g, this.plan);
          if (err) this.ui.toast(err, 'bad');
          else { this.ui.floatCost(this.plan.cost, e.clientX, e.clientY); this.ui.sound('build'); }
        } else if (this.plan && this.plan.error && !clicked) this.ui.toast(this.plan.error, 'bad');
        this.plan = null;
        this.overlay.setPlan(null);
      } else if (this.tool === 'bulldoze') {
        const r = bulldoze(g, d.x, d.z, this.hoverX, this.hoverZ, false);
        if (r.error) this.ui.toast(r.error, 'bad');
        if (r.changed) { this.ui.floatCost(r.cost, e.clientX, e.clientY); this.ui.sound('demolish'); }
        this.overlay.hideArea();
      } else if (this.tool === 'terraform' && this.terraMode === 'level') {
        const r = levelArea(g, d.cx, d.cz, this.hoverCX, this.hoverCZ, d.level);
        if (r.error) this.ui.toast(r.error, 'bad');
        else if (r.cost) this.ui.floatCost(r.cost, e.clientX, e.clientY);
        if (r.skipped) this.ui.toast(`${r.skipped} corners were blocked by construction`, 'info');
        this.overlay.hideArea();
      }
      this.hideTip();
      this.refreshHover();
      return;
    }
    if (!clicked || (e.target as HTMLElement) !== this.ui.renderer.renderer.domElement) return;
    const p = this.ui.renderer.pickGround(e.clientX, e.clientY);
    switch (this.tool) {
      case 'inspect': {
        const vid = this.ui.renderer.pickVehicle(e.clientX, e.clientY);
        if (vid != null) { this.ui.openVehicle(vid); return; }
        if (!p) return;
        this.inspectTile(Math.floor(p.x), Math.floor(p.z));
        return;
      }
      case 'line-edit': {
        if (!p) return;
        const t = g.world.idx(Math.floor(p.x), Math.floor(p.z));
        const sid = g.world.station[t];
        if (sid >= 0 && this.lineEditId != null) this.ui.addStopToLine(this.lineEditId, sid);
        return;
      }
    }
    if (!p) return;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    switch (this.tool) {
      case 'station': {
        const plan = planRailStation(g, x, z, this.stationAxis, this.stationLen, this.stationTracks);
        const err = commitRailStation(g, plan);
        if (err) this.ui.toast(err, 'bad'); else { this.ui.floatCost(plan.cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'busstop': {
        const cost = planBusStop(g, x, z).cost;
        const err = commitBusStop(g, x, z);
        if (err) this.ui.toast(err, 'bad'); else { this.ui.floatCost(cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'depot-rail':
      case 'depot-road': {
        const kind = this.tool === 'depot-rail' ? 'rail' : 'road';
        const dir = autoDepotDir(g, kind, x, z, this.depotDir);
        const cost = planDepot(g, kind, x, z, dir).cost;
        const err = commitDepot(g, kind, x, z, dir);
        if (err) this.ui.toast(err, 'bad'); else { this.ui.floatCost(cost, e.clientX, e.clientY); this.ui.sound('build'); }
        break;
      }
      case 'signal': {
        const err = toggleSignal(g, x, z);
        if (err) this.ui.toast(err, 'bad'); else this.ui.sound('click');
        break;
      }
    }
    this.planKey = '';
    this.refreshHover();
  };

  inspectTile(x: number, z: number) {
    const g = this.game;
    const w = g.world;
    if (!w.inBounds(x, z)) return;
    const t = w.idx(x, z);
    if (w.station[t] >= 0) { this.ui.openStation(w.station[t]); return; }
    if (w.depot[t] >= 0) { this.ui.openDepot(w.depot[t]); return; }
    if (w.building[t] >= 0) { const b = w.buildings[w.building[t]]; if (b) this.ui.openTown(b.townId); return; }
    if (w.townOf[t] >= 0) { this.ui.openTown(w.townOf[t]); return; }
  }

  private onMove = (e: PointerEvent) => {
    this.lastClient = { x: e.clientX, y: e.clientY };
    const p = this.ui.renderer.pickGround(e.clientX, e.clientY);
    if (!p) { this.overlay.hideHover(); this.hideTip(); return; }
    this.updateHover(Math.floor(p.x), Math.floor(p.z), Math.round(p.x), Math.round(p.z));
  };

  refreshHover() { if (this.hoverX >= 0) { this.planKey = ''; this.updateHover(this.hoverX, this.hoverZ, this.hoverCX, this.hoverCZ, true); } }

  private updateHover(x: number, z: number, cx: number, cz: number, force = false) {
    const g = this.game;
    const w = g.world;
    const changed = force || x !== this.hoverX || z !== this.hoverZ || cx !== this.hoverCX || cz !== this.hoverCZ;
    this.hoverX = x; this.hoverZ = z; this.hoverCX = cx; this.hoverCZ = cz;
    const ov = this.overlay;
    const terr = this.ui.renderer.terrain.uniforms;
    if (!w.inBounds(x, z)) { ov.hideHover(); return; }
    if (!changed && !this.drag) { this.positionTip(); return; }
    switch (this.tool) {
      case 'inspect':
      case 'line-edit': {
        const t = w.idx(x, z);
        const st = w.station[t];
        ov.setHover(x, z, st >= 0 ? 0x66ccff : 0xffffff);
        if (this.tool === 'line-edit' && st >= 0) this.showTip(`Add <b>${g.stations.get(st)?.name}</b>`, 'ok');
        else if (st >= 0 && this.tool === 'inspect') this.showTip(g.stations.get(st)?.name ?? '', 'info');
        else this.hideTip();
        break;
      }
      case 'rail':
      case 'road': {
        if (this.drag) {
          const key = `${this.drag.x},${this.drag.z}-${x},${z}`;
          if (key !== this.planKey) {
            this.planKey = key;
            const kind = this.tool;
            const d = this.drag;
            const run = () => {
              this.planTimer = 0;
              if (!this.drag || this.planKey !== key) return;
              const t0 = performance.now();
              this.plan = planRoute(g, kind, d.x, d.z, x, z);
              this.lastPlanMs = performance.now() - t0;
              ov.setPlan(this.plan);
              this.showPlanTip();
            };
            if (this.planTimer) clearTimeout(this.planTimer);
            if (this.lastPlanMs > 30) { this.planTimer = window.setTimeout(run, 70); this.showTip('Planning…', 'info'); }
            else run();
          } else this.showPlanTip();
          ov.hideHover();
        } else {
          ov.setHover(x, z, 0xffffff);
          this.hideTip();
        }
        break;
      }
      case 'station': {
        const pl = planRailStation(g, x, z, this.stationAxis, this.stationLen, this.stationTracks);
        const tiles: [number, number][] = [];
        for (let zz = pl.z0; zz <= pl.z1; zz++) for (let xx = pl.x0; xx <= pl.x1; xx++) tiles.push([xx, zz]);
        ov.setArea(tiles, pl.ok ? 0x44ff88 : 0xff4444, 0.4);
        ov.hideHover();
        const R = STATION_RADIUS_RAIL;
        terr.uHiRect.value.set(pl.x0 - R, pl.z0 - R, pl.x1 + 1 + R, pl.z1 + 1 + R);
        terr.uHiOn.value = 1;
        const join = pl.join ? `<br>Joins ${pl.join.name}` : '';
        const covered = this.coveredPop(pl.x0 - R, pl.z0 - R, pl.x1 + R, pl.z1 + R);
        this.showTip(pl.ok ? `${fmtMoney(pl.cost)} · covers ${covered.toLocaleString('en-US')} residents${join}` : pl.error!, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'busstop': {
        const pl = planBusStop(g, x, z);
        ov.setHover(x, z, pl.ok ? 0x44ff88 : 0xff4444);
        const R = STATION_RADIUS_BUS;
        terr.uHiRect.value.set(x - R, z - R, x + 1 + R, z + 1 + R);
        terr.uHiOn.value = 1;
        const covered = this.coveredPop(x - R, z - R, x + R, z + R);
        this.showTip(pl.ok ? `${fmtMoney(pl.cost)} · covers ${covered.toLocaleString('en-US')} residents${pl.join ? '<br>Joins ' + pl.join.name : ''}` : pl.error!, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'depot-rail':
      case 'depot-road': {
        const kind = this.tool === 'depot-rail' ? 'rail' : 'road';
        const dir = autoDepotDir(g, kind, x, z, this.depotDir);
        const pl = planDepot(g, kind, x, z, dir);
        ov.setHover(x, z, pl.ok ? 0x44ff88 : 0xff4444);
        ov.setArrow(x, z, dir);
        this.showTip(pl.ok ? fmtMoney(pl.cost) : pl.error!, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'signal': {
        const t = w.idx(x, z);
        const ok = w.rail[t] !== 0 && w.pieceCount(t) === 1 && w.station[t] < 0;
        ov.setHover(x, z, ok ? 0xffee55 : 0xff4444);
        const names = ['none', 'two-way', 'one-way', 'one-way (reversed)'];
        this.showTip(ok ? `Signal: ${names[w.signal[t]]} → ${names[(w.signal[t] + 1) % 4]}` : 'Needs plain track', ok ? 'info' : 'err');
        break;
      }
      case 'bulldoze': {
        if (this.drag) {
          const x0 = Math.min(this.drag.x, x), x1 = Math.max(this.drag.x, x), z0 = Math.min(this.drag.z, z), z1 = Math.max(this.drag.z, z);
          const tiles: [number, number][] = [];
          for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) tiles.push([xx, zz]);
          ov.setArea(tiles, 0xff5544, 0.35);
          const r = bulldoze(g, x0, z0, x1, z1, true);
          this.showTip(r.changed ? `Demolish: ${fmtMoney(r.cost)}` : 'Nothing to remove', r.changed ? 'err' : 'info');
          ov.hideHover();
        } else {
          ov.setHover(x, z, 0xff5544);
          const r = bulldoze(g, x, z, x, z, true);
          if (r.changed) this.showTip(`Demolish: ${fmtMoney(r.cost)}`, 'err'); else this.hideTip();
        }
        break;
      }
      case 'terraform': {
        if (this.terraMode === 'level') {
          if (this.drag) {
            const x0 = Math.min(this.drag.cx, cx), x1 = Math.max(this.drag.cx, cx), z0 = Math.min(this.drag.cz, cz), z1 = Math.max(this.drag.cz, cz);
            const tiles: [number, number][] = [];
            for (let zz = z0; zz < Math.max(z1, z0 + 1); zz++) for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) tiles.push([xx, zz]);
            ov.setArea(tiles, 0xffcc44, 0.3);
            const r = levelArea(g, x0, z0, x1, z1, this.drag.level, true);
            this.showTip(`Level to ${this.drag.level}: ${fmtMoney(r.cost)}`, 'info');
          } else {
            ov.hideArea();
            this.hideTip();
          }
        }
        if (w.inBounds(Math.min(cx, w.size - 1), Math.min(cz, w.size - 1))) {
          ov.setMarker(cx, w.cornerH(cx, cz) * HSTEP + 0.03, cz);
        }
        ov.hideHover();
        break;
      }
    }
  }

  /** Population of buildings inside a tile rectangle. */
  private coveredPop(x0: number, z0: number, x1: number, z1: number): number {
    const w = this.game.world;
    let pop = 0;
    for (let z = Math.max(0, z0); z <= Math.min(w.size - 1, z1); z++) for (let x = Math.max(0, x0); x <= Math.min(w.size - 1, x1); x++) {
      const b = w.building[w.idx(x, z)];
      if (b >= 0) pop += w.buildings[b]?.pop ?? 0;
    }
    return pop;
  }

  private planTimer = 0;
  private lastPlanMs = 0;
  private showPlanTip() {
    const pl = this.plan;
    if (!pl || !this.drag) return;
    const g = this.game;
    if (pl.ok) {
      const br = pl.steps.filter((s) => s.link?.kind === 'bridge').length, tu = pl.steps.filter((s) => s.link?.kind === 'tunnel').length;
      const extra = (br ? ` · ${br} bridge${br > 1 ? 's' : ''}` : '') + (tu ? ` · ${tu} tunnel${tu > 1 ? 's' : ''}` : '');
      const afford = g.economy.canAfford(pl.cost);
      this.showTip(`${fmtMoney(pl.cost)}${extra}${afford ? '' : '<br>Not enough money'}`, afford ? 'ok' : 'err');
    } else if (pl.error === 'Drag to another tile') this.showTip('Drag to plan a route…', 'info');
    else this.showTip(pl.error ?? 'Cannot build', 'err');
  }

  private positionTip() {
    if (this.tooltip.style.display === 'none') return;
    this.tooltip.style.left = this.lastClient.x + 18 + 'px';
    this.tooltip.style.top = this.lastClient.y + 14 + 'px';
  }
}
