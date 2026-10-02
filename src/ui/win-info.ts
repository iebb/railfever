// Info windows: stations, towns, track/road edges, vehicles, depots and the purchase dialog (train composer).
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { h, clear, fmtInt, bar, tile, section, icon, stepper, add } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { availableModels, VehicleModel, MODEL_BY_ID } from '../game/vehicle-types';
import { Train, depotReaches } from '../game/train';
import { RoadVehicle, roadDepotReaches } from '../game/roadvehicle';
import type { Line } from '../game/lines';
import { BUILDING_TYPES } from '../game/towns';
import type { Vehicle } from '../game/vehicle';
import { TRACK_TYPES, ROAD_TYPES } from '../game/constants';
import { curveSpeed } from '../game/construction';
import { fmtLen, fmtPct } from './format';
import { cashPitch } from '../audio/engine';

const CAR_GAP = 0.1;
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

// ------------------------------------------------------------------ station
export function openStation(ui: UI, id: number) {
  const g = ui.game;
  const st = g.stations.get(id);
  if (!st) return;
  const co = g.company(st.owner);
  const win = ui.wm.open('station-' + id, st.name, { width: 380, icon: st.rail ? 'station' : 'busstop', color: co.color });
  const render = () => {
    const s = g.stations.get(id);
    if (!s) { win.close(); return; }
    ui.wm.setTabs(win, [['overview', 'Overview'], ['waiting', 'Waiting'], ['lines', 'Lines']], render);
    win.title.textContent = s.name;
    const town = g.towns.list[s.townId];
    win.sub.textContent = [g.company(s.owner).name, town?.name].filter(Boolean).join(' · ');
    clear(win.body);
    const mine = s.owner === PLAYER;
    const lines = g.lines.linesAt(s.id);
    if (win.tab === 'overview') {
      const parts: string[] = [];
      if (s.rail) parts.push(`${s.rail.tracks} track${s.rail.tracks > 1 ? 's' : ''} × ${Math.round(s.rail.length * 10)} m`);
      if (s.stops.length) parts.push(`${s.stops.length} bus stop${s.stops.length > 1 ? 's' : ''}`);
      add(win.body, 
        h('div', { class: 'tiles' },
          tile(fmtPct(s.rating), 'Rating', s.rating < 0.4 ? 'neg' : '', bar(s.rating)),
          tile(fmtInt(s.waitingTotal), 'Waiting'),
          tile(fmtInt(s.catchPop), 'Catchment'),
          tile(String(lines.length), 'Lines')),
        ui.kv('Facilities', parts.join(' + ') || '—'),
        ui.kv('New passengers', `${fmtInt(s.genLast)} last month`),
        ui.kv('Boarded · arrived', `${fmtInt(s.pickupLast)} · ${fmtInt(s.arrivedLast)}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => ui.centerOn(s.x, s.z) }, icon('target', 16), 'Center'),
          h('button', { class: 'btn' + (ui.catchmentStation === id ? ' on' : ''), onclick: () => { ui.setCatchment(ui.catchmentStation === id ? -1 : id); win.last = undefined; render(); } }, icon('catchment', 16), 'Catchment'),
          mine ? h('button', { class: 'btn ghost', onclick: () => { const n = prompt('Rename station', s.name); if (n) { s.name = n.slice(0, 40); render(); } } }, icon('edit', 16), 'Rename') : null),
      );
    } else if (win.tab === 'waiting') {
      const byDest = new Map<number, number>();
      for (const wg of s.waiting.values()) byDest.set(wg.dest, (byDest.get(wg.dest) ?? 0) + wg.count);
      const sorted = [...byDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      add(win.body, section('Waiting by destination', `${fmtInt(s.waitingTotal)} total`));
      if (!sorted.length) add(win.body, h('div', { class: 'pad' }, 'Nobody is waiting here.'));
      else add(win.body, h('div', { class: 'list' }, sorted.map(([d, c]) => h('div', { class: 'row' }, ui.stationLink(d), h('span', { class: 'num' }, fmtInt(c))))));
    } else {
      add(win.body, section('Lines serving this station'));
      if (lines.length) add(win.body, h('div', { class: 'chips' }, lines.map((l) => ui.lineChip(l))));
      else add(win.body, h('div', { class: 'pad' }, mine ? 'No lines stop here yet. Open Lines (L) to create one and click this station on the map.' : 'No lines.'));
    }
  };
  win.refresh = render;
  render();
}

// ------------------------------------------------------------------ town
export function openTown(ui: UI, id: number) {
  const g = ui.game;
  const town = g.towns.list[id];
  if (!town) return;
  const win = ui.wm.open('town-' + id, town.name, { width: 350, icon: 'towns', color: '#eef2f7' });
  const render = () => {
    clear(win.body);
    const counts = new Map<number, number>();
    for (const bid of town.buildings) { const b = g.world.buildings.get(bid); if (b) counts.set(b.type, (counts.get(b.type) ?? 0) + 1); }
    const pct = town.passGenLast ? Math.min(1, town.passTransLast / town.passGenLast) : 0;
    const growth = town.served === 0 ? 'Slow' : town.served === 1 ? 'Good' : 'Fast';
    win.sub.textContent = town.served ? `${town.served} active station${town.served > 1 ? 's' : ''}` : 'No public transport';
    add(win.body, 
      h('div', { class: 'tiles' },
        tile(fmtInt(town.pop), 'Population'),
        tile(fmtInt(town.buildings.size), 'Buildings'),
        tile(fmtPct(pct), 'Transported', '', bar(pct)),
        tile(growth, 'Growth', town.served ? 'pos' : '')),
      ui.kv('Passengers last month', `${fmtInt(town.passGenLast)} departing · ${fmtInt(town.passTransLast)} arrived`),
      section('Buildings'),
      h('div', { class: 'list' }, [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => h('div', { class: 'row' }, h('span', null, BUILDING_TYPES[t]?.name ?? '?'), h('span', { class: 'num' }, String(c))))),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => ui.centerOn(town.x, town.z) }, icon('target', 16), 'Center')),
    );
  };
  win.refresh = render;
  render();
}

// ------------------------------------------------------------------ track / road info
export function openEdge(ui: UI, id: number) {
  const g = ui.game;
  const e = g.world.net.edges.get(id);
  if (!e) return;
  const rail = e.kind === 'rail';
  const win = ui.wm.open('edge', rail ? 'Track' : 'Road', { width: 340, icon: rail ? 'rail' : 'road', color: rail ? 'var(--rail)' : 'var(--road)' });
  const render = () => {
    const ed = g.world.net.edges.get(id);
    if (!ed) { win.close(); return; }
    clear(win.body);
    const tt = rail ? TRACK_TYPES[ed.type] ?? TRACK_TYPES.standard : null;
    const rt = !rail ? ROAD_TYPES[ed.type] ?? ROAD_TYPES.road : null;
    win.title.textContent = (tt ?? rt)!.name;
    win.sub.textContent = ed.owner < 0 ? 'Town' : g.company(ed.owner).name;
    const geo = g.world.net.geo(ed);
    let grade = 0;
    for (let i = 1; i < ed.prof.length; i++) grade = Math.max(grade, Math.abs(ed.prof[i] - ed.prof[i - 1]));
    const speed = rail ? Math.min(tt!.speed, curveSpeed(geo.minRadius)) : rt!.speed;
    const straight = !isFinite(geo.minRadius) || geo.minRadius > 5000;
    const sec = ed.sections.map((s) => `${s.type} ${Math.round((s.s1 - s.s0) * 10)} m`).join(', ');
    add(win.body, 
      h('div', { class: 'tiles' },
        tile(fmtLen(ed.len), 'Length'),
        tile(`${Math.round(speed)}`, 'km/h limit'),
        tile(straight ? '—' : `${Math.round(geo.minRadius * 10)} m`, 'Min. radius'),
        tile(fmtPct(grade, 1), 'Max. grade')),
      sec ? ui.kv('Structures', sec) : null,
      ed.station >= 0 ? ui.kv('Station', ui.stationLink(ed.station)) : null,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(ed, ed.len / 2, p); ui.centerOn(p.x, p.z); } }, icon('target', 16), 'Center')),
    );
  };
  win.refresh = render;
  render();
}

// ------------------------------------------------------------------ vehicles
export function vehicleDesc(v: Vehicle): string {
  if (v instanceof Train) {
    const loco = v.cars.filter((c) => c.kind === 'loco');
    const wn = new Map<string, number>();
    for (const w of v.cars) if (w.kind === 'wagon') wn.set(w.name, (wn.get(w.name) ?? 0) + 1);
    return [loco.length > 1 ? `${loco.length}× ${loco[0].name}` : loco[0]?.name, ...[...wn.entries()].map(([n, c]) => `${c}× ${n}`)].filter(Boolean).join(' + ');
  }
  return (v as RoadVehicle).model?.name ?? 'Car';
}

export function openVehicle(ui: UI, id: number) {
  const g = ui.game;
  const v = g.vehicles.get(id);
  if (!v) return;
  const rail = v.kind === 'train';
  const win = ui.wm.open('veh-' + id, v.name, { width: 380, icon: rail ? 'train' : 'bus', color: g.company(v.owner).color });
  const render = () => {
    const v2 = g.vehicles.get(id);
    if (!v2) { win.close(); return; }
    win.title.textContent = v2.name;
    win.sub.textContent = vehicleDesc(v2) + (v2 instanceof Train ? ` · ${Math.round(v2.length * 10)} m` : '');
    clear(win.body);
    const mine = v2.owner === PLAYER;
    const kind = rail ? 'rail' : 'road';
    let lineEl: Node;
    if (mine) {
      const sel = h('select', { class: 'select', 'aria-label': 'Line' }, h('option', { value: '' }, '— no line —'),
        g.lines.all().filter((l) => l.kind === kind && l.owner === PLAYER).map((l) => h('option', { value: String(l.id), selected: l.id === v2.lineId }, l.name)));
      sel.addEventListener('change', () => { v2.setLine(sel.value ? Number(sel.value) : null); render(); });
      lineEl = sel;
    } else lineEl = document.createTextNode(v2.line?.name ?? '—');
    const target = v2.targetStation();
    const load = v2.capacity ? v2.load / v2.capacity : 0;
    add(win.body, 
      h('div', { class: 'tiles' },
        tile(`${v2.speedKmh.toFixed(0)}`, `km/h of ${v2.maxSpeedKmh}`),
        tile(`${v2.load}/${v2.capacity}`, 'Passengers', '', bar(load, 'var(--info)')),
        tile(fmtMoney(v2.profitYear), 'Profit this year', v2.profitYear < 0 ? 'neg' : 'pos'),
        tile(`${v2.age.toFixed(1)}`, 'Years old')),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Line'), h('span', { class: 'v' }, lineEl)),
      ui.kv('Status', v2.status),
      target ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Next stop'), h('span', { class: 'v' }, ui.stationLink(target.id))) : null,
      v2 instanceof Train && Math.abs(v2.grade) > 0.004 ? ui.kv('Gradient', fmtPct(v2.grade, 1)) : null,
      ui.kv('Profit last year', h('span', { class: v2.profitLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitLast))),
      ui.kv('Running cost', fmtMoney(v2.runningCost) + ' / yr'),
      ui.kv('Value', fmtMoney(g.vehicles.resaleValue(v2))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn' + (ui.following === id ? ' on' : ''), onclick: () => { if (ui.following === id) ui.centerOn(...ui.posOf(v2)); else ui.follow(v2); win.last = undefined; render(); } }, icon('target', 16), ui.following === id ? 'Following' : 'Follow'),
        v2.line ? h('button', { class: 'btn', onclick: () => ui.openLine(v2.lineId!) }, icon('lines', 16), 'Line') : null,
        mine && upgradeOption(ui, v2) ? h('button', { class: 'btn', title: upgradeOption(ui, v2)!.label, onclick: () => upgradeVehicle(ui, v2) }, icon('up', 16), 'Upgrade') : null,
        mine ? h('button', { class: 'btn danger', onclick: () => { const val = g.vehicles.resaleValue(v2); if (confirm(`Sell ${v2.name} for ${fmtMoney(val)}?`)) { g.vehicles.sell(v2.id); ui.sound('cash', { pitch: cashPitch(val) }); win.close(); } } }, icon('tag', 16), 'Sell') : null,
      ),
    );
  };
  win.refresh = render;
  render();
}

/** The newest equivalent vehicle, if better than the current one. */
function upgradeOption(ui: UI, v: Vehicle): { cars: VehicleModel[]; label: string } | null {
  const year = ui.game.year;
  if (v instanceof Train) {
    const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon');
    const loco = locos[locos.length - 1], wagon = wagons[wagons.length - 1];
    const cur = v.cars.find((c) => c.kind === 'loco');
    const curW = v.cars.find((c) => c.kind === 'wagon');
    if (!loco || !cur || (loco.speed <= cur.speed && (!wagon || !curW || wagon.capacity <= curW.capacity))) return null;
    const n = v.cars.filter((c) => c.kind === 'wagon').length;
    const w = wagon ?? curW;
    if (!w) return null;
    return { cars: [loco, ...Array<VehicleModel>(n).fill(w)], label: `${loco.name} + ${n}× ${w.name}` };
  }
  const rv = v as RoadVehicle;
  const buses = availableModels(year, 'bus');
  const best = buses[buses.length - 1];
  if (!rv.model || !best || best.id === rv.model.id || best.intro <= rv.model.intro) return null;
  return { cars: [best], label: best.name };
}

function upgradeVehicle(ui: UI, v: Vehicle) {
  const g = ui.game;
  const opt = upgradeOption(ui, v);
  if (!opt) return;
  const kind = v.kind === 'train' ? 'rail' : 'road';
  const cur = (v as Train | RoadVehicle).depotId;
  const dId = g.depots.get(cur) ? cur : findDepot(ui, kind, v.line);
  if (dId == null) { ui.toast('No depot available for the replacement', 'bad'); return; }
  const cost = opt.cars.reduce((s, c) => s + c.cost, 0) - g.vehicles.resaleValue(v);
  if (!confirm(`Replace ${v.name} with ${opt.label}? Net cost ${fmtMoney(cost)}.`)) return;
  const lineId = v.lineId;
  g.vehicles.sell(v.id);
  const r = kind === 'rail' ? g.vehicles.buyTrain(dId, opt.cars, lineId) : g.vehicles.buyRoad(dId, opt.cars[0], lineId);
  if (typeof r === 'string') { ui.toast(r, 'bad'); return; }
  ui.wm.close('veh-' + v.id);
  ui.toast(`${r.name} replaces ${v.name}`, 'good');
  openVehicle(ui, r.id);
}

// ------------------------------------------------------------------ depot / purchase
export function openDepot(ui: UI, depotId: number) {
  const g = ui.game;
  const dp = g.depots.get(depotId);
  if (!dp) return;
  if (dp.owner === PLAYER) { openPurchase(ui, dp.kind, depotId, null); return; }
  const win = ui.wm.open('depot-' + depotId, dp.kind === 'rail' ? 'Train depot' : 'Bus depot', { width: 340, icon: dp.kind === 'rail' ? 'depot' : 'garage', color: g.company(dp.owner).color, sub: g.company(dp.owner).name });
  const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
  add(win.body, 
    h('div', { class: 'tiles' }, tile(String(here.length), 'Vehicles')),
    h('div', { class: 'list' }, here.slice(0, 12).map((v) => h('div', { class: 'row link', onclick: () => openVehicle(ui, v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))),
  );
}

/** Purchase dialog / train composer. If depotId is null a suitable depot for the line is chosen. */
export function openPurchase(ui: UI, kind: 'rail' | 'road', depotId: number | null, lineId: number | null) {
  const g = ui.game;
  const year = g.year;
  const rail = kind === 'rail';
  const win = ui.wm.open('buy-' + kind + '-' + (depotId ?? 'line'), rail ? 'Train composer' : 'Buy bus', { width: 470, icon: rail ? 'train' : 'bus', color: rail ? 'var(--rail)' : 'var(--road)', sub: depotId != null ? (rail ? 'Train depot' : 'Bus depot') : 'For a line' });
  const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon'), buses = availableModels(year, 'bus');
  const state = { loco: locos[locos.length - 1]?.id ?? '', locoN: 1, wagon: wagons[wagons.length - 1]?.id ?? '', count: 4, bus: buses[buses.length - 1]?.id ?? '', line: lineId };
  const render = () => {
    clear(win.body);
    const modelRow = (m: VehicleModel, selected: boolean, onSel: () => void) =>
      h('div', { class: 'model' + (selected ? ' sel' : ''), role: 'radio', 'aria-checked': selected ? 'true' : 'false', onclick: () => { onSel(); render(); } },
        h('div', { class: 'mname' }, h('span', null, m.name), h('span', { class: 'mcost' }, fmtMoney(m.cost))),
        h('div', { class: 'mstats' },
          h('span', null, icon('speed', 13), `${m.speed} km/h`),
          m.capacity ? h('span', null, icon('people', 13), `${m.capacity}`) : null,
          m.power ? h('span', null, `${m.power} kW`) : null,
          h('span', null, icon('length', 13), `${Math.round(m.length * 10)} m`),
          h('span', null, `${fmtMoney(m.running)}/yr`)));
    if (rail) {
      add(win.body, section('Locomotive'));
      for (const m of locos) add(win.body, modelRow(m, state.loco === m.id, () => (state.loco = m.id)));
      add(win.body, section('Coaches'));
      for (const m of wagons) add(win.body, modelRow(m, state.wagon === m.id, () => (state.wagon = m.id)));
      add(win.body, h('div', { class: 'inline wrap', style: 'margin-top:10px' },
        h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Locomotives'), stepper(String(state.locoN), () => { state.locoN = Math.max(1, state.locoN - 1); render(); }, () => { state.locoN = Math.min(2, state.locoN + 1); render(); })),
        h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Coaches'), stepper(String(state.count), () => { state.count = Math.max(1, state.count - 1); render(); }, () => { state.count = Math.min(14, state.count + 1); render(); }))));
    } else {
      add(win.body, section('Model'));
      for (const m of buses) add(win.body, modelRow(m, state.bus === m.id, () => (state.bus = m.id)));
    }
    const loco = MODEL_BY_ID.get(state.loco), wagon = MODEL_BY_ID.get(state.wagon), bus = MODEL_BY_ID.get(state.bus);
    const cars: VehicleModel[] = rail
      ? (loco ? [...Array<VehicleModel>(state.locoN).fill(loco), ...(wagon ? Array<VehicleModel>(state.count).fill(wagon) : [])] : [])
      : bus ? [bus] : [];
    const cost = cars.reduce((s, c) => s + c.cost, 0);
    const cap = cars.reduce((s, c) => s + c.capacity, 0);
    const spd = cars.length ? Math.min(...cars.map((c) => c.speed)) : 0;
    const len = cars.reduce((s, c) => s + c.length + CAR_GAP, 0);
    const lines = g.lines.all().filter((l) => l.kind === kind && l.owner === PLAYER);
    const sel = h('select', { class: 'select', 'aria-label': 'Line' }, h('option', { value: '' }, '— no line —'), lines.map((l) => h('option', { value: String(l.id), selected: l.id === state.line }, `${l.name} (${l.stops.length} stops)`)));
    sel.addEventListener('change', () => { state.line = sel.value ? Number(sel.value) : null; render(); });
    // shortest platform on the selected line
    let warn = '';
    const line = state.line != null ? g.lines.get(state.line) : undefined;
    let minP = Infinity;
    if (rail && line) {
      let minName = '';
      for (const sid of line.stops) { const st = g.stations.get(sid); if (st?.rail && st.rail.length < minP) { minP = st.rail.length; minName = st.name; } }
      if (isFinite(minP) && len > minP) warn = `The train (${Math.round(len * 10)} m) is longer than the platforms at ${minName} (${Math.round(minP * 10)} m).`;
    }
    // composition strip
    const strip = rail && cars.length ? h('div', { class: 'consist', title: 'Composition' }, cars.map((c) => h('span', { class: 'car' + (c.kind === 'loco' ? ' loco' : ''), style: `flex:${c.length};--c:${hex(c.color)}` }))) : null;
    const power = cars.reduce((s, c) => s + c.power, 0);
    add(win.body, 
      section('Summary'),
      strip,
      h('div', { class: 'summary' },
        tile(fmtMoney(cost), 'Price'),
        tile(String(cap), 'Passengers'),
        tile(String(spd), 'km/h'),
        rail ? tile(`${Math.round(len * 10)} m`, isFinite(minP) ? `of ${Math.round(minP * 10)} m platform` : 'Length', warn ? 'neg' : '') : null,
        rail ? tile(`${power}`, 'kW') : null),
      warn ? h('div', { class: 'warn' }, icon('warning', 16), warn) : null,
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Assign to line'), h('span', { class: 'v' }, sel)),
      h('div', { class: 'btns right' }, h('button', { class: 'btn primary', disabled: !cars.length || !g.economy.canAfford(cost), onclick: () => buy() }, icon('plus', 16), `Buy for ${fmtMoney(cost)}`)),
    );
    if (depotId != null) {
      const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
      if (here.length) {
        add(win.body, section('Vehicles from this depot', String(here.length)),
          h('div', { class: 'list' }, here.map((v) => h('div', { class: 'row link', onclick: () => openVehicle(ui, v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))));
      }
    }
    const buy = () => {
      if (!cars.length) return;
      let dId = depotId;
      if (dId == null) {
        dId = findDepot(ui, kind, line);
        if (dId == null) { ui.toast(`No ${rail ? 'train' : 'bus'} depot connected to this line. Build one first.`, 'bad'); return; }
      }
      const r = rail ? g.vehicles.buyTrain(dId, cars, state.line) : g.vehicles.buyRoad(dId, cars[0], state.line);
      if (typeof r === 'string') { ui.toast(r, 'bad'); return; }
      ui.toast(`${r.name} purchased`, 'good');
      ui.sound('purchase');
      if (!state.line) ui.toast('Tip: assign the vehicle to a line so it starts working.', 'info');
      render();
    };
  };
  win.refresh = undefined;
  render();
}

export function findDepot(ui: UI, kind: 'rail' | 'road', line: Line | null | undefined): number | null {
  const g = ui.game;
  const depots = g.depots.all().filter((d) => d.kind === kind && d.owner === PLAYER);
  if (!depots.length) return null;
  if (!line || !line.stops.length) return depots[0].id;
  const st = g.stations.get(line.stops[0]);
  if (!st) return depots[0].id;
  depots.sort((a, b) => Math.hypot(a.x - st.x, a.z - st.z) - Math.hypot(b.x - st.x, b.z - st.z));
  for (const d of depots.slice(0, 8)) {
    const ok = kind === 'rail' ? depotReaches(g, d, st.id) : roadDepotReaches(g, d, st.id);
    if (ok) return d.id;
  }
  return null;
}
