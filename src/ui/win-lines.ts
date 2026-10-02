// Lines, line details (stops, vehicles, statistics), and the vehicle and town lists.
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { h, clear, fmtInt, tile, section, icon, toggle, add } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { Train } from '../game/train';
import type { RoadVehicle } from '../game/roadvehicle';
import { LINE_COLORS, Line } from '../game/lines';
import { findDepot } from './win-info';
import { chart } from './charts';
import { fmtPct } from './format';

let showAllLines = false;
let showAllVehicles = false;

export function openLines(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('lines', 'Lines', { width: 500, icon: 'lines', color: 'var(--accent)' });
  const render = () => {
    clear(win.body);
    const lines = g.lines.all().filter((l) => showAllLines || l.owner === PLAYER);
    const mine = g.lines.all().filter((l) => l.owner === PLAYER);
    win.sub.textContent = `${mine.length} line${mine.length === 1 ? '' : 's'} · ${mine.reduce((s, l) => s + l.vehicles.length, 0)} vehicles`;
    add(win.body, h('div', { class: 'btns', style: 'margin-top:0' },
      h('button', { class: 'btn primary', onclick: () => newLine(ui, 'rail') }, icon('train', 16), 'New rail line'),
      h('button', { class: 'btn primary', onclick: () => newLine(ui, 'road') }, icon('bus', 16), 'New bus line'),
      h('span', { class: 'spacer' }),
      toggle('All companies', showAllLines, (v) => { showAllLines = v; win.last = undefined; render(); })));
    if (!lines.length) {
      add(win.body, h('div', { class: 'pad' }, 'No lines yet. A line is an ordered list of stations that vehicles serve in a loop. Build two stations, create a line, click the stations on the map, then add vehicles.'));
      return;
    }
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Line'), h('th', { class: 'r' }, 'Stops'), h('th', { class: 'r' }, 'Veh.'), h('th', { class: 'r' }, 'Pax/mo'), h('th', { class: 'r' }, 'Profit (yr)')));
    for (const l of lines) {
      const profit = l.incomeYear - l.costYear;
      tbl.appendChild(h('tr', { class: 'clickable', onclick: () => openLine(ui, l.id) },
        h('td', { class: 'ellip' }, h('span', { class: 'swatch', style: `background:${l.color}` }), l.name, l.owner !== PLAYER ? h('span', { class: 'muted' }, ` · ${g.company(l.owner).name}`) : ''),
        h('td', { class: 'r' }, String(l.stops.length)), h('td', { class: 'r' }, String(l.vehicles.length)), h('td', { class: 'r' }, fmtInt(l.passLast)),
        h('td', { class: 'r ' + (profit < 0 ? 'neg' : 'pos') }, fmtMoney(profit))));
    }
    win.body.appendChild(tbl);
  };
  win.refresh = render;
  render();
}

function newLine(ui: UI, kind: 'rail' | 'road') {
  const l = ui.game.lines.create(kind, PLAYER);
  openLine(ui, l.id);
  editLine(ui, l.id);
}

export function editLine(ui: UI, id: number) {
  ui.tools.setTool('line-edit');
  ui.tools.lineEditId = id;
  ui.hud.onToolChange();
  ui.toast('Click stations on the map to add them as stops', 'info');
}

export function addStopToLine(ui: UI, lineId: number, stationId: number) {
  const g = ui.game;
  const l = g.lines.get(lineId);
  const st = g.stations.get(stationId);
  if (!l || !st || l.owner !== PLAYER) return;
  if (st.owner !== PLAYER) { ui.toast(`${st.name} belongs to ${g.company(st.owner).name}`, 'bad'); return; }
  if (l.kind === 'rail' && !g.stations.hasRail(st)) { ui.toast('This station has no train platforms', 'bad'); return; }
  if (l.kind === 'road' && !g.stations.hasRoad(st)) { ui.toast('This station has no bus stop', 'bad'); return; }
  if (l.stops[l.stops.length - 1] === stationId) { ui.toast('Already the last stop', 'info'); return; }
  l.stops.push(stationId);
  ui.sound('click');
  g.lines.rebuild();
  for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
  ui.hud.onToolChange();
  ui.wm.get('line-' + lineId)?.refresh?.();
}

export function openLine(ui: UI, id: number) {
  const g = ui.game;
  const line = g.lines.get(id);
  if (!line) return;
  const win = ui.wm.open('line-' + id, line.name, { width: 420, icon: line.kind === 'rail' ? 'train' : 'bus', color: line.color });
  const render = () => {
    const l = g.lines.get(id);
    if (!l) { win.close(); return; }
    const mine = l.owner === PLAYER;
    ui.wm.setTabs(win, [['stops', `Stops`], ['vehicles', `Vehicles`], ['stats', 'Statistics']], render);
    win.title.textContent = l.name;
    win.sub.textContent = `${l.kind === 'rail' ? 'Rail' : 'Bus'} line · ${g.company(l.owner).name}`;
    (win.el.querySelector('.win-ic') as HTMLElement | null)?.style.setProperty('--c', l.color);
    clear(win.body);
    const changed = () => { g.lines.rebuild(); for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged(); win.last = undefined; render(); };
    const profit = l.incomeYear - l.costYear;
    add(win.body, h('div', { class: 'linehead' },
      h('span', { class: 'swatch big', style: `background:${l.color}`, title: mine ? 'Change colour' : '', onclick: () => { if (!mine) return; l.color = LINE_COLORS[(LINE_COLORS.indexOf(l.color) + 1) % LINE_COLORS.length]; changed(); } }),
      h('b', null, l.name),
      mine ? h('button', { class: 'btn sm ghost', onclick: () => { const n = prompt('Rename line', l.name); if (n) { l.name = n.slice(0, 40); changed(); } } }, icon('edit', 14), 'Rename') : ui.ownerTag(l.owner)));
    add(win.body, h('div', { class: 'tiles' },
      tile(String(l.stops.length), 'Stops'),
      tile(String(l.vehicles.length), 'Vehicles'),
      tile(fmtInt(l.passLast), 'Pax last month'),
      tile(fmtMoney(profit), 'Profit this year', profit < 0 ? 'neg' : 'pos')));
    if (win.tab === 'stops') {
      const broken = ui.lineBroken.get(id) ?? [];
      const list = h('div', { class: 'list stops' });
      l.stops.forEach((sid, i) => {
        const st = g.stations.get(sid);
        let waiting = 0;
        if (st) for (const wg of st.waiting.values()) if (wg.line === l.id) waiting += wg.count;
        const noRoute = broken.some(([a]) => a === sid);
        list.appendChild(h('div', { class: 'row' },
          h('span', { class: 'stopn', style: `background:${l.color}` }, String(i + 1)),
          ui.stationLink(sid),
          noRoute ? h('span', { class: 'neg', title: 'No route to the next stop' }, '⚠ no route') : null,
          h('span', { class: 'muted num' }, `${waiting} waiting`),
          mine ? h('span', { class: 'rowbtns' },
            h('button', { class: 'ibtn sm', 'data-tip': 'Move up', 'aria-label': 'Move up', onclick: () => { if (i > 0) { [l.stops[i - 1], l.stops[i]] = [l.stops[i], l.stops[i - 1]]; changed(); } } }, icon('up', 14)),
            h('button', { class: 'ibtn sm', 'data-tip': 'Move down', 'aria-label': 'Move down', onclick: () => { if (i < l.stops.length - 1) { [l.stops[i + 1], l.stops[i]] = [l.stops[i], l.stops[i + 1]]; changed(); } } }, icon('down', 14)),
            h('button', { class: 'ibtn sm', 'data-tip': 'Remove stop', 'aria-label': 'Remove stop', onclick: () => { l.stops.splice(i, 1); changed(); } }, icon('close', 14))) : null));
      });
      if (!l.stops.length) list.appendChild(h('div', { class: 'pad' }, 'No stops yet.'));
      add(win.body, section('Stops', l.stops.length >= 2 ? 'vehicles run in a loop' : ''), list);
      if (mine) {
        const editing = ui.tools.tool === 'line-edit' && ui.tools.lineEditId === l.id;
        add(win.body, h('div', { class: 'btns' },
          h('button', { class: 'btn' + (editing ? ' on' : ''), onclick: () => { if (editing) ui.tools.setTool('inspect'); else editLine(ui, l.id); win.last = undefined; render(); } }, icon(editing ? 'check' : 'plus', 16), editing ? 'Done adding stops' : 'Add stops on map')));
        if (l.stops.length < 2) add(win.body, h('div', { class: 'muted', style: 'margin-top:8px' }, 'A line needs at least two stops.'));
      }
    } else if (win.tab === 'vehicles') {
      const vl = h('div', { class: 'list' });
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        vl.appendChild(h('div', { class: 'row link', onclick: () => ui.openVehicle(vid) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status), h('span', { class: 'num' }, `${v.load}/${v.capacity}`)));
      }
      if (!l.vehicles.length) vl.appendChild(h('div', { class: 'pad' }, 'No vehicles on this line.'));
      add(win.body, section('Vehicles', String(l.vehicles.length)), vl);
      if (mine) add(win.body, h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => ui.openPurchase(l.kind === 'rail' ? 'rail' : 'road', null, l.id) }, icon('plus', 16), l.kind === 'rail' ? 'Add train' : l.kind === 'tram' ? 'Add tram' : 'Add bus'),
        l.vehicles.length ? h('button', { class: 'btn', onclick: () => cloneLast(ui, l) }, icon('copy', 16), 'Clone last') : null));
    } else {
      add(win.body, 
        ui.kv('Income this year', fmtMoneyFull(l.incomeYear)),
        ui.kv('Running costs this year', fmtMoneyFull(l.costYear)),
        ui.kv('Profit last year', h('span', { class: l.incomeLast - l.costLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(l.incomeLast - l.costLast))),
        ui.kv('Load factor', (() => { let cap = 0, load = 0; for (const vid of l.vehicles) { const v = g.vehicles.get(vid); if (v) { cap += v.capacity; load += v.load; } } return cap ? fmtPct(load / cap) : '—'; })()));
      if (mine) add(win.body, h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete ${l.name}? Its vehicles will stop.`)) { g.lines.delete(l.id); win.close(); } } }, icon('trash', 16), 'Delete line')));
    }
  };
  win.refresh = render;
  win.onClose = () => { if (ui.tools.tool === 'line-edit' && ui.tools.lineEditId === id) ui.tools.setTool('inspect'); };
  render();
}

function cloneLast(ui: UI, l: Line) {
  const g = ui.game;
  const v = g.vehicles.get(l.vehicles[l.vehicles.length - 1]);
  if (!v) return;
  const dId = (v as Train | RoadVehicle).depotId;
  const dp = g.depots.get(dId)?.owner === PLAYER ? dId : findDepot(ui, l.kind === 'rail' ? 'rail' : 'road', l);
  if (dp == null) { ui.toast('No depot available', 'bad'); return; }
  const r = v instanceof Train ? g.vehicles.buyTrain(dp, v.reversed ? [...v.cars].reverse() : [...v.cars], l.id) : g.vehicles.buyRoad(dp, (v as RoadVehicle).model!, l.id);
  if (typeof r === 'string') ui.toast(r, 'bad'); else { ui.toast(`${r.name} purchased`, 'good'); ui.sound('purchase'); }
}

// ------------------------------------------------------------------ lists
export function openVehicles(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('vehicles', 'Vehicles', { width: 560, icon: 'vehicles', color: 'var(--accent)' });
  const render = () => {
    clear(win.body);
    const all = g.vehicles.all();
    const vs = all.filter((v) => showAllVehicles || v.owner === PLAYER).sort((a, b) => b.profitYear - a.profitYear);
    const mine = all.filter((v) => v.owner === PLAYER);
    const trains = mine.filter((v) => v.kind === 'train').length;
    win.sub.textContent = `${trains} train${trains === 1 ? '' : 's'} · ${mine.length - trains} bus${mine.length - trains === 1 ? '' : 'es'}`;
    add(win.body, h('div', { class: 'btns', style: 'margin-top:0' }, h('span', { class: 'spacer' }), toggle('All companies', showAllVehicles, (v) => { showAllVehicles = v; win.last = undefined; render(); })));
    if (!vs.length) { add(win.body, h('div', { class: 'pad' }, 'No vehicles yet. Build a depot, open it, and buy a train or bus.')); return; }
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Vehicle'), h('th', null, 'Line'), h('th', null, 'Status'), h('th', { class: 'r' }, 'Load'), h('th', { class: 'r' }, 'Profit (yr)')));
    for (const v of vs.slice(0, 300)) {
      tbl.appendChild(h('tr', { class: 'clickable', onclick: () => ui.openVehicle(v.id) },
        h('td', { class: 'ellip' }, v.owner !== PLAYER ? h('span', { class: 'swatch', style: `background:${g.company(v.owner).color}` }) : '', v.name),
        h('td', { class: 'ellip' }, v.line ? h('span', null, h('span', { class: 'swatch', style: `background:${v.line.color}` }), v.line.name) : '—'),
        h('td', { class: 'ellip ' + (v.state === 'noroute' || v.state === 'stopped' ? 'neg' : 'muted') }, v.status),
        h('td', { class: 'r' }, `${v.load}/${v.capacity}`),
        h('td', { class: 'r ' + (v.profitYear < 0 ? 'neg' : 'pos') }, fmtMoney(v.profitYear))));
    }
    add(win.body, tbl);
  };
  win.refresh = render;
  render();
}

export function openTowns(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('towns', 'Towns', { width: 400, icon: 'towns', color: '#eef2f7' });
  const render = () => {
    clear(win.body);
    const total = g.towns.list.reduce((s, t) => s + t.pop, 0);
    win.sub.textContent = `${g.towns.list.length} towns · ${fmtInt(total)} residents`;
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Town'), h('th', { class: 'r' }, 'Population'), h('th', { class: 'r' }, 'Transported')));
    for (const t of [...g.towns.list].sort((a, b) => b.pop - a.pop)) {
      const pct = t.passGenLast ? Math.min(1, t.passTransLast / t.passGenLast) : 0;
      tbl.appendChild(h('tr', { class: 'clickable', onclick: () => { ui.centerOn(t.x, t.z); ui.openTown(t.id); } },
        h('td', null, t.name, t.served ? h('span', { class: 'pos' }, ' ▲') : ''), h('td', { class: 'r' }, fmtInt(t.pop)), h('td', { class: 'r' }, fmtPct(pct))));
    }
    add(win.body, tbl);
    if (g.towns.list.length > 1) {
      const top = [...g.towns.list].sort((a, b) => b.pop - a.pop).slice(0, 12);
      add(win.body, section('Largest towns'), chart([{ values: top.map((t) => t.pop), color: '#a4afbf', kind: 'bar' }], { w: 370, h: 120, fmt: (v) => fmtInt(v) }));
    }
  };
  win.refresh = render;
  render();
}
