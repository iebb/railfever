// Lines (rail, bus, tram), line details (stops, vehicles, statistics) with inline rename and colour picker,
// and the vehicle and town lists.
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import type { LineKind } from '../game/constants';
import { h, clear, fmtInt, tile, section, icon, toggle, add, seg, field } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { Train } from '../game/train';
import type { RoadVehicle } from '../game/roadvehicle';
import type { Line } from '../game/lines';
import type { Station } from '../game/stations';
import type { Game } from '../game/game';
import { availableModels } from '../game/vehicle-types';
import { findDepot } from './win-info';
import { chart } from './charts';
import { fmtPct, fmtMult, KIND_META } from './format';
import { renameLine, setLineColor, isAutoName, linePalette } from './gameapi';
import { requestAccessUI } from './win-access';
import { demandView } from '../game/demand';
import { getFilter, validateFilter, lineMatches, vehicleMatches, filterBar, modeCounts, lineSymbol, lineMode, vehicleMode, MODE_META, badgeOn, badgeEl, LineMode } from './lineid';
import { congestionOf, congestionPanel, compatPanel, routePanel, routeInfo, sharedPanel, faresPanel, decommission } from './win-ops';
import { servicesTab, patternSelect, stopDots } from './win-services';
import { subsetOf, linePatterns, canJoinLines, joinLines } from '../game/patterns';

/** Does the station offer stops for this transport mode? */
export function servesKind(g: Game, st: Station, kind: LineKind): boolean {
  if (kind === 'rail') return !!st.rail;
  if (kind === 'tram') return st.stops.some((p) => !!g.world.net.edges.get(p.edge)?.tram);
  return st.stops.length > 0;
}

export function openLines(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('lines', 'Lines', { width: 560, icon: 'lines', color: 'var(--accent)' });
  const f = getFilter('lines');
  const render = () => {
    validateFilter(g, f);
    clear(win.body);
    const all = g.lines.all();
    const mine = all.filter((l) => l.owner === PLAYER);
    const lines = all.filter((l) => lineMatches(g, l, f));
    win.sub.textContent = `${mine.length} line${mine.length === 1 ? '' : 's'} · ${mine.reduce((s, l) => s + l.vehicles.length, 0)} vehicles`;
    const trams = availableModels(g.year, 'tram').length > 0;
    add(win.body,
      h('div', { class: 'btns', style: 'margin-top:0' },
        h('button', { class: 'btn primary', onclick: () => newLine(ui, 'rail') }, icon('train', 16), 'Rail line'),
        h('button', { class: 'btn primary', onclick: () => newLine(ui, 'road') }, icon('bus', 16), 'Bus line'),
        h('button', { class: 'btn primary', disabled: !trams, 'data-tip': trams ? undefined : 'No trams available yet in this era', onclick: () => newLine(ui, 'tram') }, icon('tram', 16), 'Tram line')),
      filterBar(g, f, modeCounts(g, all, f), () => { win.last = undefined; render(); }));
    const sugg = !f.hidden.includes('bus') || !f.hidden.includes('coach') ? intercitySuggestions(ui) : null;
    if (!lines.length) {
      add(win.body, h('div', { class: 'pad' }, all.some((l) => l.owner === PLAYER || f.company !== 'mine') ? 'No lines match the filter.' : 'No lines yet. A line is an ordered list of stations that vehicles serve in a loop. Build two stations, create a line, click the stations on the map, then add vehicles.'), sugg);
      return;
    }
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Line'), h('th', { class: 'r' }, 'Stops'), h('th', { class: 'r' }, 'Veh.'), h('th', { class: 'r' }, 'Pax/mo'), h('th', { class: 'r' }, 'Profit (yr)')));
    for (const l of lines) {
      const profit = l.incomeYear - l.costYear;
      const cong = congestionOf(g, l.id);
      const partner = l.owner !== PLAYER && g.lines.canOperate(l, PLAYER);
      tbl.appendChild(h('tr', { class: 'clickable', onclick: () => openLine(ui, l.id) },
        h('td', { class: 'ellip', style: 'max-width:260px' }, h('span', { class: 'inline', style: 'gap:6px' }, lineSymbol(g, l, 'sm'), icon(MODE_META[lineMode(g, l)].icon, 14),
          h('span', { class: 'ltag-n' }, l.name),
          g.lines.isLoop(l) ? h('span', { class: 'loopic', 'data-tip': 'Loop line' }, icon('loop', 12)) : null,
          (l.patterns?.length ?? 0) > 1 ? h('span', { class: 'flag shared', 'data-tip': linePatterns(l).map((p) => p.name).join(' · ') }, `${l.patterns!.length} services`) : null,
          cong && cong.level >= 2 ? h('span', { class: 'neg', 'data-tip': cong.level >= 3 ? 'Trains stuck' : 'Congested' }, icon('warning', 14)) : null,
          l.owner !== PLAYER ? h('span', { class: 'muted' }, `${partner ? 'partner · ' : ''}${g.company(l.owner).name}`) : (l.operators?.length ? h('span', { class: 'flag shared' }, 'shared') : null))),
        h('td', { class: 'r' }, String(l.stops.length)), h('td', { class: 'r' }, String(l.vehicles.length)), h('td', { class: 'r' }, fmtInt(l.passLast)),
        h('td', { class: 'r ' + (profit < 0 ? 'neg' : 'pos') }, fmtMoney(profit))));
    }
    win.body.appendChild(tbl);
    if (sugg) win.body.appendChild(sugg);
  };
  win.refresh = render;
  render();
}

// ------------------------------------------------------------------ intercity bus suggestions
const suggCaches = new WeakMap<Game, { key: string; rows: { a: number; b: number; dist: number; potential: number }[] }>();

/**
 * Town pairs linked by roads (one road network component) without a bus line of the player, strongest demand
 * first: candidates for long-distance coach lines.
 */
function intercitySuggestions(ui: UI): HTMLElement | null {
  const g = ui.game;
  const key = `${g.networkVersion}|${g.lines.version}|${Math.floor(g.day / 30)}`;
  let suggCache = suggCaches.get(g);
  if (!suggCache || suggCache.key !== key) {
    const net = g.world.net;
    // road connectivity (union-find over road nodes)
    const parent = new Map<number, number>();
    const find = (a: number): number => { let r = a; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
    for (const e of net.edges.values()) if (e.kind === 'road' && e.depot < 0) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
    const comp = new Map<number, number>();
    for (const t of g.towns.list) { const ne = net.nearestEdge(t.x, t.z, Math.max(6, t.radius * 0.5), 'road'); if (ne) comp.set(t.id, find(ne.edge.a)); }
    // town pairs a player bus line already serves
    const served = new Set<number>();
    for (const l of g.lines.all()) {
      if (l.owner !== PLAYER || l.kind !== 'road') continue;
      const ts = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      for (const a of ts) for (const b of ts) if (a < b) served.add(a * 4096 + b);
    }
    const rows: { a: number; b: number; dist: number; potential: number }[] = [];
    for (const p of demandView(g, PLAYER).pairs) {
      if (rows.length >= 3) break;
      const a = Math.min(p.a, p.b), b = Math.max(p.a, p.b);
      if (p.dist < 60 || p.dist > 700 || served.has(a * 4096 + b)) continue;
      const ca = comp.get(a), cb = comp.get(b);
      if (ca === undefined || ca !== cb) continue;
      rows.push({ a, b, dist: p.dist, potential: p.potential });
    }
    suggCache = { key, rows };
    suggCaches.set(g, suggCache);
  }
  if (!suggCache.rows.length) return null;
  const name = (id: number) => g.towns.list[id]?.name ?? '?';
  return h('div', null,
    section('Intercity bus ideas', 'towns linked by road'),
    h('div', { class: 'list' }, suggCache.rows.map((r) => h('div', { class: 'row' },
      h('span', null, icon('bus', 14), ` ${name(r.a)} – ${name(r.b)}`),
      h('span', { class: 'muted' }, `≈ ${((r.dist * 1.25) / 100).toFixed(1)} km by road · ${fmtInt(r.potential)} trips/mo`),
      h('button', { class: 'btn sm', 'data-tip': 'Show both towns and pick the bus stop tool', onclick: () => {
        const A = g.towns.list[r.a], B = g.towns.list[r.b];
        if (A && B) ui.centerOn((A.x + B.x) / 2, (A.z + B.z) / 2, Math.max(60, r.dist * 0.9));
        ui.tools.setTool('busstop');
        ui.toast(`Place a bus stop in ${name(r.a)} and in ${name(r.b)}, then create a bus line — long routes suit coaches`, 'info');
      } }, 'Plan')))),
    h('div', { class: 'muted', style: 'margin-top:4px' }, 'Fares grow with distance: long bus routes between towns pay better than short hops in town.'));
}

function newLine(ui: UI, kind: LineKind) {
  // Release an abandoned edit's number before allocating the next line.
  if (ui.tools.tool === 'line-edit') ui.tools.endLineEdit();
  // Provisional until stops are added: endLineEdit removes an empty line and releases its number.
  const l = ui.game.lines.create(kind, PLAYER);
  openLine(ui, l.id);
  editLine(ui, l.id);
}

export function editLine(ui: UI, id: number) {
  // End X before starting Y, including when both use the same tool.
  if (ui.tools.tool === 'line-edit' && ui.tools.lineEditId !== id) ui.tools.endLineEdit();
  const line = ui.game.lines.get(id);
  if (!line || line.owner !== PLAYER) return;
  ui.tools.setTool('line-edit');
  ui.tools.lineEditId = line.id;
  ui.hud.onToolChange();
  ui.toast('Click stations on the map to add them as stops', 'info');
}

export function addStopToLine(ui: UI, lineId: number, stationId: number) {
  const g = ui.game;
  const l = g.lines.get(lineId);
  const st = g.stations.get(stationId);
  if (!l || !st || l.owner !== PLAYER) return;
  if (!servesKind(g, st, l.kind)) {
    ui.toast(l.kind === 'rail' ? 'This station has no train platforms' : l.kind === 'tram' ? 'This station has no tram stop' : 'This station has no bus stop', 'bad');
    return;
  }
  // another company's station: needs an approved access agreement with its owner (asked for here)
  if (!g.canUse(PLAYER, st.owner) && requestAccessUI(ui, st.owner) !== 'granted') return;
  if (l.stops[l.stops.length - 1] === stationId) { ui.toast('Already the last stop', 'info'); return; }
  l.stops.push(stationId);
  ui.sound('click', { pitch: 1 + Math.min(0.5, l.stops.length * 0.06) });
  g.lines.rebuild();
  for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
  ui.hud.onToolChange();
  ui.wm.get('line-' + lineId)?.refresh?.();
}

export function openLine(ui: UI, id: number) {
  const g = ui.game;
  const line = g.lines.get(id);
  if (!line) return;
  // a line merged into another as a service pattern: its id leads to that line
  if (line.id !== id) { openLine(ui, line.id); return; }
  const meta0 = KIND_META[line.kind];
  const win = ui.wm.open('line-' + id, line.name, { width: 460, icon: meta0.icon, color: line.color });
  let renaming = false;
  let palette = false;
  const render = () => {
    const l = g.lines.get(id);
    if (!l || l.id !== id) { win.close(); if (l) openLine(ui, l.id); return; }
    const mine = l.owner === PLAYER;
    const operates = mine || g.lines.canOperate(l, PLAYER);
    const meta = KIND_META[l.kind];
    ui.wm.setTabs(win, [['stops', 'Stops'], ['services', 'Services'], ['vehicles', 'Vehicles'], ['stats', 'Statistics']], render);
    win.title.textContent = l.name;
    const nOps = l.operators?.filter((o) => o !== l.owner).length ?? 0;
    win.sub.textContent = `${MODE_META[lineMode(g, l)].label} line · ${g.company(l.owner).name}${nOps ? ` + ${nOps} partner${nOps > 1 ? 's' : ''}` : ''}`;
    (win.el.querySelector('.win-ic') as HTMLElement | null)?.style.setProperty('--c', l.color);
    clear(win.body);
    const rerender = () => { win.last = undefined; render(); };
    const changed = () => { g.lines.rebuild(); for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged(); ui.onLineEdited(l.id); rerender(); };
    const profit = l.incomeYear - l.costYear;
    // header: line symbol (colour palette), name (inline rename), auto-name badge, owner; through service / services
    let nameEl: HTMLElement;
    if (renaming && mine) {
      const inp = h('input', { class: 'input', value: l.name, 'aria-label': 'Line name', style: 'flex:1' }) as HTMLInputElement;
      const done = (ok: boolean) => { if (!renaming) return; renaming = false; if (ok && inp.value.trim() !== l.name) { renameLine(g, l, inp.value.trim()); ui.sound('toggle', { pitch: 1.1 }); } rerender(); };
      inp.placeholder = 'Empty = automatic name';
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
      inp.addEventListener('blur', () => done(true));
      nameEl = inp;
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      nameEl = h('b', { class: mine ? 'renamable' : '', 'data-tip': mine ? 'Rename' : undefined, onclick: () => { if (!mine) return; renaming = true; render(); } }, l.name);
    }
    const auto = isAutoName(l);
    const route = routeInfo(g, l);
    const nPat = l.patterns?.length ?? 0;
    add(win.body, h('div', { class: 'linehead' },
      h('button', { class: 'lsymbtn', 'data-tip': mine ? 'Line colour' : `Line ${l.name}`, 'aria-label': mine || l.kind !== 'rail' ? 'Line colour' : 'Line symbol', disabled: !mine, onclick: () => { if (!mine) return; palette = !palette; rerender(); } }, lineSymbol(g, l, 'lg')),
      nameEl,
      auto && !renaming ? h('span', { class: 'autobadge', 'data-tip': 'Named automatically from its stops' }, 'auto') : null,
      !mine ? ui.ownerTag(l.owner) : null));
    if (route?.through || nPat > 1 || nOps) add(win.body, h('div', { class: 'lineflags' },
      route?.through ? h('span', { class: 'flag thru', 'data-tip': 'Runs over several operators’ networks or track types' }, 'Through service') : null,
      nPat > 1 ? h('span', { class: 'flag shared' }, `${nPat} services`) : null,
      nOps ? h('span', { class: 'flag shared', 'data-tip': g.lines.operatorsOf(l).map((o) => g.company(o).name).join(' · ') }, `Shared · ${nOps + 1} operators`) : null));
    if (palette && mine) {
      add(win.body, h('div', { class: 'palette', role: 'radiogroup', 'aria-label': 'Line colour' },
        linePalette(l.kind).map((c) => h('button', { class: 'pal' + (!l.autoColor && c.toLowerCase() === l.color.toLowerCase() ? ' on' : ''), style: `--c:${c}`, 'aria-label': c, 'data-sfx': 'none', onclick: () => { setLineColor(g, l, c); palette = false; ui.sound('click', { pitch: 1.15 }); changed(); } })),
        customColor(l.autoColor || linePalette(l.kind).some((c) => c.toLowerCase() === l.color.toLowerCase()) ? null : l.color, l.color, (c) => { setLineColor(g, l, c); palette = false; ui.sound('click', { pitch: 1.15 }); changed(); }),
        h('button', { class: 'pal auto' + (l.autoColor ? ' on' : ''), 'data-tip': 'Automatic colour', 'aria-label': 'Automatic colour', 'data-sfx': 'none', onclick: () => { setLineColor(g, l, null); palette = false; ui.sound('click'); changed(); } }, 'A')));
    }
    add(win.body, h('div', { class: 'tiles' },
      tile(String(l.stops.length), 'Stops'),
      tile(String(l.vehicles.length), meta.vehicles),
      tile(fmtInt(l.passLast), 'Pax last month'),
      tile(fmtMoney(profit), 'Profit this year', profit < 0 ? 'neg' : 'pos')));
    const editing = ui.tools.tool === 'line-edit' && ui.tools.lineEditId === l.id;
    if (win.tab === 'stops') {
      add(win.body, congestionPanel(ui, l, rerender, () => { win.tab = 'vehicles'; rerender(); }), compatPanel(ui, l, rerender));
      // a line inside another line's route becomes one of its services when editing ends (UPDATE 9k)
      const sup = editing && l.stops.length >= 2 ? subsetOf(g, l) : null;
      if (sup) add(win.body, h('div', { class: 'alert info' }, icon('info', 16), h('div', { class: 'alert-b' }, 'These stops lie on ', h('b', null, sup.name), ': when you finish, this line becomes one of its services (a short-turn or a service skipping stops).')));
      const broken = ui.lineBroken.get(id) ?? [];
      const list = h('div', { class: 'list stops' });
      l.stops.forEach((sid, i) => {
        const st = g.stations.get(sid);
        let waiting = 0;
        if (st) for (const wg of st.waiting.values()) if (wg.line === l.id) waiting += wg.count;
        const noRoute = broken.some(([a]) => a === sid);
        const b = l.kind === 'rail' ? badgeOn(g, l.id, sid) : null;
        list.appendChild(h('div', { class: 'row' },
          b ? badgeEl(b, 'sm') : l.kind === 'rail' ? h('span', { class: 'stopn', style: `background:${l.color}` }, String(i + 1)) : lineSymbol(g, l, 'sm'),
          ui.stationLink(sid),
          st && st.owner >= 0 && st.owner !== l.owner ? h('span', { class: 'owner', style: `--c:${g.company(st.owner).color}`, 'data-tip': `Station of ${g.company(st.owner).name}: upkeep shared by usage at ${fmtMult(g.accessMultiplier(st.owner))}` }, h('i'), g.company(st.owner).name.split(' ')[0]) : null,
          stopDots(l, i),
          noRoute ? h('span', { class: 'neg', title: 'No route to the next stop' }, '⚠ no route') : null,
          h('span', { class: 'muted num' }, `${waiting} waiting`),
          mine ? h('span', { class: 'rowbtns' },
            h('button', { class: 'ibtn sm', 'data-tip': 'Move up', 'aria-label': 'Move up', onclick: () => { if (i > 0) { [l.stops[i - 1], l.stops[i]] = [l.stops[i], l.stops[i - 1]]; changed(); } } }, icon('up', 14)),
            h('button', { class: 'ibtn sm', 'data-tip': 'Move down', 'aria-label': 'Move down', onclick: () => { if (i < l.stops.length - 1) { [l.stops[i + 1], l.stops[i]] = [l.stops[i], l.stops[i + 1]]; changed(); } } }, icon('down', 14)),
            h('button', { class: 'ibtn sm', 'data-tip': 'Remove stop', 'aria-label': 'Remove stop', onclick: () => { l.stops.splice(i, 1); changed(); } }, icon('close', 14))) : null));
      });
      if (!l.stops.length) list.appendChild(h('div', { class: 'pad' }, 'No stops yet.'));
      const loop = g.lines.isLoop(l);
      add(win.body, section('Stops', l.stops.length >= 2 ? (loop ? 'vehicles circle round the stops' : 'vehicles run out and back') : ''), list);
      if (mine && l.stops.length >= 2) {
        const setting = l.loop === undefined ? 'auto' : l.loop ? 'loop' : 'back';
        add(win.body, field('Route', seg([['auto', 'Auto', 'Loop when the stops are three or more different stations'], ['loop', 'Loop', 'Vehicles keep circling one way round the stops'], ['back', 'Out and back', 'Vehicles turn at the first and last stop']], setting, (v) => {
          g.lines.setLoop(l.id, v === 'auto' ? undefined : v === 'loop');
          ui.sound('toggle', { pitch: v === 'back' ? 0.9 : 1.1 });
          changed();
        }), setting === 'auto' ? `Now: ${loop ? 'loop' : 'out and back'}` : undefined));
      }
      if (mine) {
        add(win.body, field('Spacing', toggle('Even spacing', l.evenSpacing !== false, (enabled) => {
          g.lines.setEvenSpacing(l.id, enabled);
          ui.sound('toggle', { pitch: enabled ? 1.1 : 0.9 });
          rerender();
        }, 'Space vehicles out at stops and depot departures')));
        add(win.body, h('div', { class: 'btns' },
          h('button', { class: 'btn' + (editing ? ' on' : ''), onclick: () => { if (editing) ui.tools.setTool('inspect'); else editLine(ui, l.id); rerender(); } }, icon(editing ? 'check' : 'plus', 16), editing ? 'Done adding stops' : 'Add stops on map'),
          h('button', { class: 'btn', disabled: editing, 'data-tip': editing ? 'Finish adding stops before joining lines' : 'Combine two lines at a shared terminus into a through line', onclick: () => openLineJoin(ui, l.id) }, icon('lines', 16), 'Join with line…'),
          l.kind === 'rail' && l.stops.length >= 2 ? h('button', { class: 'btn', 'data-tip': 'Signal the line’s track by the rules (preview first)', onclick: () => ui.openAutoSignal({ line: l.id }) }, icon('signal', 16), 'Auto-signal') : null));
        if (l.stops.length < 2) add(win.body, h('div', { class: 'muted', style: 'margin-top:8px' }, 'A line needs at least two stops.'));
      }
      add(win.body, routePanel(ui, l));
    } else if (win.tab === 'services') {
      servicesTab(ui, l, win.body, rerender);
    } else if (win.tab === 'vehicles') {
      add(win.body, congestionPanel(ui, l, rerender));
      const vl = h('div', { class: 'list' });
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        const ps = patternSelect(ui, l, v, rerender);
        vl.appendChild(h('div', { class: 'row link', onclick: () => ui.openVehicle(vid) },
          h('span', null, v.name),
          v.owner !== PLAYER ? ui.ownerTag(v.owner) : null,
          ps ? h('span', { onclick: (e: Event) => e.stopPropagation() }, ps) : null,
          h('span', { class: 'muted' }, v.status),
          h('span', { class: 'num' }, `${v.load}/${v.capacity}`)));
      }
      if (!l.vehicles.length) vl.appendChild(h('div', { class: 'pad' }, 'No vehicles on this line.'));
      add(win.body, section('Vehicles', String(l.vehicles.length)), vl);
      if (operates) add(win.body, h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => ui.openPurchase(l.kind, null, l.id) }, icon('plus', 16), `Add ${meta.vehicle}`),
        l.vehicles.some((x) => g.vehicles.get(x)?.owner === PLAYER) ? h('button', { class: 'btn', onclick: () => cloneLast(ui, l) }, icon('copy', 16), 'Clone last') : null));
      add(win.body, sharedPanel(ui, l, rerender));
    } else {
      add(win.body,
        ui.kv('Income this year', fmtMoneyFull(l.incomeYear)),
        ui.kv('Running costs this year', fmtMoneyFull(l.costYear)),
        ui.kv('Profit last year', h('span', { class: l.incomeLast - l.costLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(l.incomeLast - l.costLast))),
        ui.kv('Load factor', (() => { let cap = 0, load = 0; for (const vid of l.vehicles) { const v = g.vehicles.get(vid); if (v) { cap += v.capacity; load += v.load; } } return cap ? fmtPct(load / cap) : '—'; })()),
        faresPanel(ui, l));
      const losing = l.incomeLast - l.costLast < 0 && profit < 0 && l.vehicles.length > 0;
      if (mine && losing) add(win.body, h('div', { class: 'alert warn' }, icon('warning', 16), h('div', { class: 'alert-b' }, h('b', null, 'Losing money'), h('div', null, 'Last year and this year so far. Faster or more frequent service, express services or a longer route can help; else decommission it.'))));
      if (operates) add(win.body, h('div', { class: 'btns' },
        h('button', { class: 'btn', 'data-tip': mine ? 'Sell your vehicles on it and delete the line (a partner takes a shared line over)' : 'Sell your vehicles on it and leave the line', onclick: () => decommission(ui, l, () => { if (g.lines.get(id)?.id === id) rerender(); else win.close(); }) }, icon('trash', 16), 'Decommission…'),
        mine ? h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete ${l.name}? Its vehicles will stop.`)) { g.lines.delete(l.id); win.close(); } } }, icon('trash', 16), 'Delete line') : null));
    }
  };
  win.refresh = () => { if (!renaming) render(); };
  win.onClose = () => { if (ui.tools.tool === 'line-edit' && ui.tools.lineEditId === id) ui.tools.setTool('inspect'); };
  render();
}

/** Pick a connected terminus, review the complete route and confirm the join. */
function openLineJoin(ui: UI, id: number) {
  const g = ui.game, line = g.lines.get(id);
  if (!line || line.owner !== PLAYER) return;
  const win = ui.wm.open('line-join-' + line.id, 'Join with line…', { width: 520, icon: 'lines', color: line.color, cls: 'linejoin-info' });
  let selected: number | undefined;
  let error = '';
  const render = () => {
    const l = g.lines.map.get(id);
    if (!l || l.owner !== PLAYER) { win.close(); return; }
    clear(win.body);
    win.sub.textContent = l.name;
    const choices = g.lines.all().filter((other) => other.id !== id).map((other) => ({ other, check: canJoinLines(g, l, other) }));
    const candidates = choices.filter((c) => c.check.ok);
    add(win.body, h('p', { class: 'linejoin-note' }, 'Join two lines at a shared terminus. Through vehicles can carry passengers across the junction without changing trains or buses.'));
    if (error) add(win.body, h('div', { class: 'alert warn', role: 'alert' }, error));
    if (!candidates.length) {
      add(win.body, h('div', { class: 'alert info' }, choices.length ? 'No lines can be joined right now.' : 'There are no other lines to join.'));
      // Reasons at an actual shared terminus are most useful (disconnected platforms, access or rolling stock).
      const rejected = choices.filter((c) => !c.check.ok).sort((a, b) => Number(b.check.junction !== null) - Number(a.check.junction !== null));
      if (rejected.length) add(win.body, h('div', { class: 'list linejoin-reasons' }, rejected.slice(0, 8).map(({ other, check }) => h('div', { class: 'linejoin-reason' },
        h('b', null, other.name), h('span', { class: 'muted' }, check.reason)))));
      add(win.body, h('div', { class: 'muted linejoin-note' }, 'Both lines need the same transport kind, a shared terminus and a connected route. Each operator must own a station on the joined line and have access to the route.'));
      return;
    }
    add(win.body, section('Lines you can join', `${candidates.length}`), h('div', { class: 'list linejoin-choices' }, candidates.map(({ other, check }) => h('button', {
      class: 'linejoin-choice' + (selected === other.id ? ' on' : ''), 'aria-pressed': selected === other.id ? 'true' : 'false',
      onclick: () => { selected = other.id; error = ''; win.last = undefined; render(); },
    }, lineSymbol(g, other, 'sm'), h('span', { class: 'linejoin-choice-text' }, h('b', null, other.name),
      h('span', { class: 'muted' }, `Join at ${g.stations.get(check.junction!)?.name ?? '?'} · ${g.company(other.owner).name}`)), h('span', { class: 'muted' }, 'Preview')))));
    const choice = candidates.find((c) => c.other.id === selected);
    if (!choice || !choice.check.ok) return;
    const preview = choice.check, survivor = g.lines.map.get(preview.into)!;
    const junctionName = g.stations.get(preview.junction)?.name ?? '?';
    add(win.body, section('Joined route', 'out and back'), h('ol', { class: 'linejoin-route', style: `--linejoin-color:${survivor.color}`, 'aria-label': 'Joined route' },
      preview.route.map((sid) => h('li', { class: sid === preview.junction ? 'junction' : '' },
        h('span', null, g.stations.get(sid)?.name ?? '?'), sid === preview.junction ? h('span', { class: 'flag thru' }, 'Junction') : null))),
      h('p', { class: 'linejoin-note' }, h('b', null, survivor.name), ' keeps its name, code and colour. Existing vehicles keep their owners and their old sections as short-turn services. New vehicles default to the full through route.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => {
        // Revalidate: access or track may have changed while the preview was open.
        const result = joinLines(g, id, choice.other.id);
        if (typeof result === 'string') { error = result; win.last = undefined; render(); return; }
        win.close();
        ui.wm.close('line-' + result.from);
        ui.wm.close('line-' + result.into);
        ui.wm.get('lines')?.refresh?.();
        ui.toast(result.text, 'good');
        ui.sound('notify');
        openLine(ui, result.into);
      } }, icon('check', 16), `Join lines at ${junctionName}`), h('button', { class: 'btn', onclick: () => win.close() }, 'Cancel')));
  };
  win.refresh = render;
  render();
}

/** Palette swatch opening the browser's colour picker; `current` = the custom colour in use (highlighted). */
function customColor(current: string | null, base: string, onPick: (c: string) => void): HTMLElement {
  const inp = h('input', { type: 'color', value: current ?? base, 'aria-label': 'Custom colour' }) as HTMLInputElement;
  inp.addEventListener('change', () => onPick(inp.value));
  return h('label', { class: 'pal custom' + (current ? ' on' : ''), style: current ? `background:${current}` : undefined, 'data-tip': 'Custom colour' }, inp, current ? null : icon('plus', 14));
}

/** Buy another vehicle like the player's last one on the line. */
function cloneLast(ui: UI, l: Line) {
  const g = ui.game;
  const own = l.vehicles.filter((id) => g.vehicles.get(id)?.owner === PLAYER);
  const v = g.vehicles.get(own[own.length - 1]);
  if (!v) return;
  const dId = (v as Train | RoadVehicle).depotId;
  const dp = g.depots.get(dId)?.owner === PLAYER ? dId : findDepot(ui, l.kind, l);
  if (dp == null) { ui.toast('No depot available', 'bad'); return; }
  const r = v instanceof Train ? g.vehicles.buyTrain(dp, v.reversed ? [...v.cars].reverse() : [...v.cars], l.id) : g.vehicles.buyRoad(dp, (v as RoadVehicle).model!, l.id);
  if (typeof r === 'string') ui.toast(r, 'bad'); else { ui.toast(`${r.name} purchased`, 'good'); ui.sound('purchase'); }
}

// ------------------------------------------------------------------ lists
export function openVehicles(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('vehicles', 'Vehicles', { width: 600, icon: 'vehicles', color: 'var(--accent)' });
  const f = getFilter('vehicles');
  const render = () => {
    validateFilter(g, f);
    clear(win.body);
    const all = g.vehicles.all();
    const vs = all.filter((v) => vehicleMatches(g, v, f)).sort((a, b) => b.profitYear - a.profitYear);
    const mine = all.filter((v) => v.owner === PLAYER);
    const count = (k: LineKind) => mine.filter((v) => (v.line?.kind ?? (v.kind === 'train' ? 'rail' : (v as RoadVehicle).model?.kind === 'tram' ? 'tram' : 'road')) === k).length;
    win.sub.textContent = `${count('rail')} trains · ${count('road')} buses · ${count('tram')} trams`;
    const counts: Partial<Record<LineMode, number>> = {};
    for (const v of all) if (vehicleMatches(g, v, { hidden: [], company: f.company })) { const m = vehicleMode(g, v); counts[m] = (counts[m] ?? 0) + 1; }
    add(win.body, filterBar(g, f, counts, () => { win.last = undefined; render(); }));
    if (!vs.length) { add(win.body, h('div', { class: 'pad' }, mine.length ? 'No vehicles match the filter.' : 'No vehicles yet. Build a depot, open it, and buy a train, bus or tram.')); return; }
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Vehicle'), h('th', null, 'Line'), h('th', null, 'Status'), h('th', { class: 'r' }, 'Load'), h('th', { class: 'r' }, 'Profit (yr)')));
    for (const v of vs.slice(0, 300)) {
      tbl.appendChild(h('tr', { class: 'clickable', onclick: () => ui.openVehicle(v.id) },
        h('td', { class: 'ellip' }, v.owner !== PLAYER ? h('span', { class: 'swatch', style: `background:${g.company(v.owner).color}` }) : null, v.name),
        h('td', { class: 'ellip' }, v.line ? h('span', { class: 'inline', style: 'gap:6px' }, lineSymbol(g, v.line, 'sm'), h('span', { class: 'ltag-n' }, v.line.name)) : '—'),
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
