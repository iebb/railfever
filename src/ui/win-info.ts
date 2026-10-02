// Info windows: stations, towns, track/road edges, vehicles, depots and the purchase dialog (train composer).
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { h, clear, fmtInt, bar, tile, section, icon, stepper, add } from './dom';
import { fmtMoney, fmtMoneyFull } from '../game/economy';
import { availableModels, VehicleModel, MODEL_BY_ID, modelTracks } from '../game/vehicle-types';
import { Train, depotReaches, depotServes, lineCompatibility, trackAllows } from '../game/train';
import { RoadVehicle, roadDepotReaches } from '../game/roadvehicle';
import type { Line } from '../game/lines';
import { BUILDING_TYPES } from '../game/towns';
import type { Vehicle } from '../game/vehicle';
import { TRACK_TYPES, ROAD_TYPES, TRAM } from '../game/constants';
import { curveSpeed } from '../game/construction';
import { fmtLen, fmtPct, fmtMult, equalUseShare, TYPE_META } from './format';
import { accessState, accessControl, policyText } from './win-access';
import { cashPitch } from '../audio/engine';
import type { LineKind } from '../game/constants';
import { KIND_META } from './format';
import { demandView, stationDemand } from '../game/demand';
import { townDemandShare } from './gameapi';
import type { Station, StationLevel, UpgradePlan } from '../game/stations';
import { DEFAULT_PLATFORM_LENGTH, WALK_LINE, ENTRANCE_COST, planStationUpgrade, commitStationUpgrade, stationCapacity, stationComplex, railModeOf } from '../game/stations';
import { connectStationThroat, canMerge, mergeStations } from '../game/trackops';
import { styleOf, stylesFor } from '../game/station-styles';
import { badgeEl, badgeOn, badgeRow, stationBadges, lineTag } from './lineid';
import { memo, expandPlan, commitExpand } from './win-ops';
import { linePatterns, patternStops, setVehiclePattern, PATTERN_LABEL } from '../game/patterns';
import type { OpCost } from '../game/opcosts';
import { patBadge } from './win-services';
import { field, seg } from './dom';
import { servedColor, hexCss } from './mapmodes';

const CAR_GAP = 0.1;
type StationBuild = { length: number; tracks: number; through: number; level: StationLevel; side: 'auto' | 'left' | 'right' };
interface RestyleState { current: string; selected: string }

/** Transport mode of a vehicle (trams are road vehicles with tram models). */
export function vehicleKind(v: Vehicle): LineKind {
  if (v.kind === 'train') return 'rail';
  return (v as RoadVehicle).model?.kind === 'tram' ? 'tram' : 'road';
}
const depotTitle = (k: string) => (k === 'rail' ? 'Train depot' : k === 'tram' ? 'Tram depot' : 'Bus depot');
const depotIcon = (k: string) => (k === 'rail' ? 'depot' : k === 'tram' ? 'tramdepot' : 'garage');
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

// ------------------------------------------------------------------ station
export function openStation(ui: UI, id: number) {
  const g = ui.game;
  const st = g.stations.get(id);
  if (!st) return;
  const co = g.company(st.owner);
  const win = ui.wm.open('station-' + id, st.name, { width: 430, icon: st.rail ? 'station' : 'busstop', color: co.color, cls: 'station-info' });
  /** pending rebuild (platform length / tracks / level) of the station window's Build tab */
  const up: StationBuild = { length: st.rail?.length ?? DEFAULT_PLATFORM_LENGTH, tracks: st.rail?.tracks ?? 2, through: st.rail?.through ?? 0, level: st.rail?.level ?? 'ground', side: 'auto' };
  const restyle: RestyleState = { current: styleOf(st.rail?.style).id, selected: styleOf(st.rail?.style).id };
  let upCache: { key: string; plan: UpgradePlan } | null = null;
  let railSig = JSON.stringify(st.rail);
  const syncBuild = () => {
    const r = g.stations.get(id)?.rail;
    if (r) { up.length = r.length; up.tracks = r.tracks; up.through = r.through ?? 0; up.level = r.level; }
    up.side = 'auto';
    railSig = JSON.stringify(r ?? null);
    upCache = null;
  };
  const render = () => {
    const s = g.stations.get(id);
    if (!s) { win.close(); return; }
    if (JSON.stringify(s.rail) !== railSig) syncBuild();
    const mine = s.owner === PLAYER;
    ui.wm.setTabs(win, [['overview', 'Overview'], ['waiting', 'Waiting'], ['lines', 'Lines'], ...(mine ? [['build', 'Build'] as [string, string]] : [])], render);
    win.title.textContent = s.name;
    const town = g.towns.list[s.townId];
    win.sub.textContent = [g.company(s.owner).name, town?.name].filter(Boolean).join(' · ');
    clear(win.body);
    const lines = g.lines.linesAt(s.id);
    const rerender = () => { win.last = undefined; render(); };
    const badges = stationBadges(g, s.id);
    if (badges.length) add(win.body, h('div', { class: 'stnhead', 'aria-label': 'Station numbers' }, badges.map((b) =>
      h('button', { class: 'lsymbtn', 'data-tip': `${b.code} · ${g.lines.get(b.line)?.name ?? 'Line'}`, 'aria-label': `Open line ${b.code}`, onclick: () => ui.openLine(b.line) }, badgeEl(b, '', false)))));
    if (win.tab === 'overview') {
      const parts: string[] = [];
      if (s.rail) parts.push(`${s.rail.tracks} track${s.rail.tracks > 1 ? 's' : ''}${s.rail.through ? ` + ${s.rail.through} through` : ''} × ${Math.round(s.rail.length * 10)} m`);
      const tramN = s.stops.filter((p) => !!g.world.net.edges.get(p.edge)?.tram).length;
      if (s.stops.length - tramN) parts.push(`${s.stops.length - tramN} bus stop${s.stops.length - tramN > 1 ? 's' : ''}`);
      if (tramN) parts.push(`${tramN} tram stop${tramN > 1 ? 's' : ''}`);
      add(win.body, 
        h('div', { class: 'tiles' },
          tile(fmtPct(s.rating), 'Rating', s.rating < 0.4 ? 'neg' : '', bar(s.rating)),
          tile(fmtInt(s.waitingTotal), 'Waiting'),
          tile(fmtInt(s.catchPop), 'Catchment'),
          tile(String(lines.length), 'Lines')),
        ui.kv('Facilities', parts.join(' + ') || '—'),
        s.rail ? ui.kv('Level', s.rail.level === 'elevated' ? `Elevated · ${Math.round(s.rail.height * 10)} m` : s.rail.level === 'underground' ? `Underground · ${Math.round(s.rail.depth * 10)} m deep` : 'Ground') : null,
        s.rail ? ui.kv('Building style', h('span', { class: 'inline wrap' }, `${styleOf(s.rail.style).name} · +${fmtPct(styleOf(s.rail.style).catchBonus)} radius`,
          mine ? h('button', { class: 'btn sm', onclick: () => { win.tab = 'build'; rerender(); } }, 'Restyle…') : null)) : null,
        s.rail ? ui.kv('Road access', s.roadAccess ? h('span', { class: 'pos' }, s.rail.level === 'ground' ? 'Connected to the street' : 'Entrances on the street') : h('span', { class: 'neg' }, 'None — no passengers')) : null,
        mine && s.rail && !s.roadAccess ? h('div', { class: 'warn' }, icon('warning', 16),
          h('span', null, s.rail.level === 'ground' ? 'This station won\u2019t attract passengers until its forecourt is connected to a street. ' : 'None of its entrances is beside a road: add one next to a street. ',
            s.rail.level === 'ground'
              ? h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: () => { ui.tools.roadType = 'street'; ui.tools.setTool('road'); const f = g.stations.forecourt(s); ui.centerOn(f?.x ?? s.x, f?.z ?? s.z, 30); ui.toast('Build a street from the station forecourt to the road network', 'info'); } }, icon('road', 15), 'Build access road')
              : h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: () => startEntrance(ui, s.id) }, icon('entrance', 15), 'Add entrance'))) : null,
        !mine && s.owner >= 0 ? accessRows(ui, s.owner, g.stationMaintenance(s), () => { win.last = undefined; render(); }) : null,
        ui.kv('New passengers', `${fmtInt(s.genLast)} last month`),
        ui.kv('Boarded · arrived', `${fmtInt(s.pickupLast)} · ${fmtInt(s.arrivedLast)}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => ui.centerOn(s.x, s.z) }, icon('target', 16), 'Center'),
          h('button', { class: 'btn' + (ui.catchmentStation === id ? ' on' : ''), onclick: () => { ui.setCatchment(ui.catchmentStation === id ? -1 : id); win.last = undefined; render(); } }, icon('catchment', 16), 'Catchment'),
          mine ? h('button', { class: 'btn ghost', onclick: () => { const n = prompt('Rename station', s.name); if (n) { s.name = n.slice(0, 40); render(); } } }, icon('edit', 16), 'Rename') : null),
        capacityPanel(ui, s, () => { syncBuild(); rerender(); }),
        complexParts(ui, s),
        sharedStopPanel(ui, s, lines),
        mine ? transferSection(ui, s, () => { syncBuild(); rerender(); }) : null,
      );
    } else if (win.tab === 'waiting') {
      const byDest = new Map<number, number>();
      for (const wg of s.waiting.values()) byDest.set(wg.dest, (byDest.get(wg.dest) ?? 0) + wg.count);
      const sorted = [...byDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      const towns = stationDemand(g, s.id).slice(0, 6);
      add(win.body, section('Waiting by destination town', `${fmtInt(s.waitingTotal)} total`));
      if (!sorted.length) add(win.body, h('div', { class: 'pad' }, 'Nobody is waiting here.'));
      else {
        add(win.body, h('div', { class: 'list' }, towns.map((e) => h('div', { class: 'row' },
          h('span', null, g.towns.list[e.town]?.name ?? 'Elsewhere'),
          h('span', { class: 'ldots' }, e.lines.slice(0, 5).map((x) => {
            if (x.line === WALK_LINE) return h('span', { class: 'walkchip', 'data-tip': `Walking to a linked station: ${fmtInt(x.count)}` }, icon('walk', 11));
            const l = g.lines.get(x.line);
            return l ? h('i', { style: `--c:${l.color}`, 'data-tip': `${l.name}: ${fmtInt(x.count)}` }) : null;
          })),
          h('span', { class: 'num' }, fmtInt(e.count))))));
        add(win.body, section('By station'), h('div', { class: 'list' }, sorted.map(([d, c]) => h('div', { class: 'row' }, ui.stationLink(d), h('span', { class: 'num' }, fmtInt(c))))));
      }
    } else if (win.tab === 'lines') {
      add(win.body, section('Lines serving this station'));
      if (lines.length) add(win.body, h('div', { class: 'list station-lines' }, lines.map((l) => {
        const b = badgeOn(g, l.id, s.id);
        return h('div', { class: 'row' }, b ? badgeEl(b, 'sm') : null, lineTag(g, l, () => ui.openLine(l.id)), ui.ownerTag(l.owner));
      })));
      else add(win.body, h('div', { class: 'pad' }, mine ? 'No lines stop here yet. Open Lines (L) to create one and click this station on the map.' : 'No lines.'));
      // where passengers can get to from here, by their first leg (a line, or a walk to a linked station)
      const table = g.lines.routing.get(s.id);
      if (table && table.size) {
        const legs = new Map<string, { line: number; via: number; n: number }>();
        for (const hop of table.values()) {
          const k = hop.line === WALK_LINE ? `w${hop.alight}` : `l${hop.line}`;
          const e = legs.get(k);
          if (e) e.n++; else legs.set(k, { line: hop.line, via: hop.alight, n: 1 });
        }
        add(win.body, section('Connections', `${table.size} stations reachable`), h('div', { class: 'list' }, [...legs.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((x) => {
          const l = x.line === WALK_LINE ? null : g.lines.get(x.line);
          return h('div', { class: 'row' },
            l ? h('span', null, ui.lineChip(l)) : h('span', { class: 'inline' }, h('span', { class: 'walkchip' }, icon('walk', 12)), 'Walk to ', ui.stationLink(x.via)),
            h('span', { class: 'num' }, `${x.n} station${x.n > 1 ? 's' : ''}`));
        })));
      }
    } else {
      buildTab(ui, s, up, () => {
        const key = `${up.length}|${up.tracks}|${up.through}|${up.level}|${up.side}|${railSig}|${g.networkVersion}|${g.world.net.version}`;
        if (!upCache || upCache.key !== key) upCache = { key, plan: planStationUpgrade(g, s.id, up) };
        return upCache.plan;
      }, rerender, win.body);
      add(win.body, restylePanel(ui, s, restyle, rerender));
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
      demandRows(ui, id),
      section('Buildings'),
      h('div', { class: 'list' }, [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => h('div', { class: 'row' }, h('span', null, BUILDING_TYPES[t]?.name ?? '?'), h('span', { class: 'num' }, String(c))))),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => ui.centerOn(town.x, town.z) }, icon('target', 16), 'Center')),
    );
  };
  win.refresh = render;
  render();
}

/** Trip demand of a town and its strongest connections (from the demand model). */
function demandRows(ui: UI, id: number): HTMLElement | null {
  const g = ui.game;
  const d = demandView(g, PLAYER);
  const t = d.towns.find((x) => x.id === id);
  if (!t) return null;
  const share = townDemandShare(d, t);
  const pairs = d.pairs.filter((p) => p.a === id || p.b === id).slice(0, 4);
  const demandOn = ui.mapModes.mode === 'demand';
  return h('div', null,
    ui.kv('Trip demand', h('span', null, `${fmtInt(t.potential)} / month · `, h('span', { style: `color:${hexCss(servedColor(share))}` }, `${fmtPct(share)} served`))),
    ui.kv('Coverage', `${fmtPct(t.served)} of residents near a served station`),
    section('Top destinations', h('button', { class: 'btn sm' + (demandOn ? ' on' : ''), onclick: () => ui.mapModes.toggle('demand') }, icon('demand', 15), 'Demand view')),
    pairs.length ? h('div', { class: 'list' }, pairs.map((p) => {
      const o = g.towns.list[p.a === id ? p.b : p.a];
      return h('div', { class: 'row link', 'data-tip': `${fmtPct(p.served)} served · ${(p.dist / 100).toFixed(1)} km`, onclick: () => o && ui.openTown(o.id) },
        h('span', null, o?.name ?? '?'), h('span', { class: 'ldots' }, h('i', { style: `--c:${hexCss(servedColor(p.served))}` })), h('span', { class: 'num' }, `${fmtInt(p.potential)} / mo`));
    })) : h('div', { class: 'pad muted' }, 'No other towns nearby.'));
}

/** Capacity figures are sampled by the simulation; expansion plans are cached until the layout changes. */
function capacityPanel(ui: UI, s: Station, after: () => void): HTMLElement | null {
  const g = ui.game;
  const cap = stationCapacity(g, s.id);
  if (!cap || !s.rail) return null;
  const rec = cap.recommended;
  const advice: string[] = [];
  if (rec) {
    const tracks = rec.tracks - cap.platforms, through = rec.through - cap.through;
    if (tracks > 0) advice.push(`Add ${tracks} platform track${tracks === 1 ? '' : 's'}`);
    if (through > 0) advice.push(`add ${through} through track${through === 1 ? '' : 's'}`);
    if (rec.length > cap.length) advice.push(`lengthen to ${fmtLen(rec.length)}`);
  }
  const key = `${g.networkVersion}|${g.world.net.version}|${s.rail.style}|${rec?.tracks}|${rec?.through}|${rec?.length}`;
  const up = rec && s.owner === PLAYER ? memo(g, 'station-expand:' + s.id, key, () => expandPlan(g, s.id)) : null;
  const occ = Math.max(0, Math.min(1, cap.occupancy));
  return h('div', null,
    section('Platform capacity', `${cap.platforms} platform tracks${cap.through ? ` + ${cap.through} through` : ''}`),
    h('div', { class: 'cap' }, h('span', { class: 'k' }, 'Occupancy'),
      h('div', { role: 'progressbar', 'aria-label': 'Platform occupancy', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(occ * 100) }, bar(occ, occ > 0.6 ? 'var(--neg)' : occ > 0.4 ? 'var(--warn)' : 'var(--pos)')),
      h('span', { class: 'v' }, fmtPct(occ))),
    ui.kv('Trains waiting for a platform', h('span', { class: cap.waitingTrains ? 'neg' : '' }, String(cap.waitingTrains))),
    ui.kv('Trains calling', `${cap.trainsPerHour.toFixed(2)} / hour · ${cap.lines} lines`),
    h('div', { class: 'muted station-advice' }, cap.reason),
    rec ? h('div', { class: 'alert warn' }, icon('upgrade', 16), h('div', { class: 'alert-b' },
      h('b', null, advice.join(' · ')),
      up && !up.ok ? h('div', null, up.error ?? 'No room to expand here') : null,
      s.owner !== PLAYER ? h('div', null, `${g.company(s.owner).name} can expand this station.`) : null,
      up ? h('div', { class: 'btns' }, h('button', { class: 'btn sm primary', disabled: !up.ok || !g.economy.canAfford(up.cost), 'data-sfx': 'none', onclick: () => commitExpand(ui, s.id, after) }, icon('upgrade', 15), up.ok ? `Expand · ${fmtMoney(up.cost)}` : 'Expand')) : null)) : null);
}

/** Changing just the passenger building preserves the station's platforms and service. */
function restylePanel(ui: UI, s: Station, state: RestyleState, after: () => void): HTMLElement | null {
  const g = ui.game, r = s.rail;
  if (!r || s.owner !== PLAYER) return null;
  const current = styleOf(r.style);
  if (state.current !== current.id) { state.current = current.id; state.selected = current.id; }
  const choices = stylesFor(r.level, r.tracks, g.year);
  const chosen = choices.find((x) => x.id === state.selected) ?? current;
  state.selected = chosen.id;
  const sel = h('select', { class: 'select', 'aria-label': 'Station building style' },
    !choices.some((x) => x.id === current.id) ? h('option', { value: current.id, selected: chosen.id === current.id, disabled: true }, `${current.name} (current)`) : null,
    choices.map((x) => h('option', { value: x.id, selected: x.id === chosen.id }, `${x.name} · +${fmtPct(x.catchBonus)} radius`)));
  sel.addEventListener('change', () => { state.selected = sel.value; after(); });
  const changed = chosen.id !== current.id;
  const key = `${g.networkVersion}|${g.world.net.version}|${r.level}|${r.tracks}|${r.through}|${r.length}|${current.id}|${chosen.id}|${g.year}`;
  const pl = changed ? memo(g, 'restyle:' + s.id, key, () => planStationUpgrade(g, s.id, { style: chosen.id })) : null;
  return h('div', { class: 'station-restyle' },
    section('Restyle', `${current.name} · +${fmtPct(current.catchBonus)} radius`),
    field('Building', sel, chosen.desc),
    ui.kv('Catchment radius bonus', `+${fmtPct(chosen.catchBonus)}`),
    pl ? ui.kv(pl.ok ? 'Restyle cost' : 'Not possible', h('span', { class: pl.ok ? '' : 'neg' }, pl.ok ? fmtMoneyFull(pl.cost) : pl.error ?? 'Cannot restyle')) : null,
    pl?.warnings.length ? h('div', { class: 'warn' }, icon('warning', 16), pl.warnings.join(' · ')) : null,
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', disabled: !pl?.ok || !g.economy.canAfford(pl.cost), 'data-sfx': 'none', onclick: () => {
      const fresh = planStationUpgrade(g, s.id, { style: state.selected });
      const err = commitStationUpgrade(g, fresh);
      if (err) { ui.toast(err === 'busy' ? 'A train is in the station — try again in a moment' : err, err === 'busy' ? 'info' : 'bad'); after(); return; }
      state.current = state.selected;
      ui.sound('station', { x: s.x, z: s.z });
      ui.toast(`${s.name} restyled`, 'good');
      if (ui.catchmentStation === s.id) ui.setCatchment(s.id);
      after();
    } }, icon('station', 16), pl?.ok ? `Restyle · ${fmtMoney(pl.cost)}` : 'Restyle')));
}

/** The linked parts of a complex remain individually inspectable, regardless of their owner. */
function complexParts(ui: UI, s: Station): HTMLElement | null {
  const g = ui.game, c = stationComplex(g, s.id);
  if (c.parts.length < 2) return null;
  return h('div', null, section('Complex parts', ui.stationLink(c.main)),
    h('div', { class: 'list' }, c.parts.map((id) => {
      const p = g.stations.get(id);
      if (!p) return null;
      const mode = g.stations.mode(p);
      const label = mode === 'mainline' ? 'Rail' : mode === 'lightrail' ? 'Light rail' : mode === 'metro' ? 'Metro' : mode === 'tram' ? 'Tram' : 'Bus';
      return h('div', { class: 'complex-part' },
        h('div', { class: 'inline wrap' }, ui.stationLink(id), id === c.main ? h('span', { class: 'flag ok' }, 'Main') : null, id === s.id ? h('span', { class: 'muted' }, '(this part)') : null, ui.ownerTag(p.owner)),
        h('div', { class: 'inline wrap muted' }, `${label}${p.rail ? ` · ${p.rail.level} · ${p.rail.tracks} platform tracks` : ''} · ${fmtInt(p.waitingTotal)} waiting`, badgeRow(g, id, Infinity, 'sm')));
    })));
}

/** The shared-stop meter uses the same company weights as Game.billAccess. */
function sharedStopPanel(ui: UI, s: Station, lines: Line[]): HTMLElement | null {
  if (!s.stops.length || s.owner < 0) return null;
  const g = ui.game;
  const by = new Map<number, Set<Line>>([[s.owner, new Set()]]);
  const remember = (owner: number, l?: Line) => {
    if (owner < 0 || !g.companies[owner] || g.companies[owner].defunct) return;
    let ls = by.get(owner);
    if (!ls) { ls = new Set(); by.set(owner, ls); }
    if (l) ls.add(l);
  };
  for (const l of lines) if (l.kind !== 'rail') {
    for (const owner of [l.owner, ...(l.operators ?? [])]) remember(owner, l);
    for (const id of l.vehicles) { const v = g.vehicles.get(id); if (v) remember(v.owner, l); }
  }
  // TODO: expose Game.stationUsage(id); feature-detect its existing meter until a public per-stop API lands.
  const meter = g as unknown as { stationUsage?: (id: number) => number[] | undefined; usage?: Map<number, number[]> };
  const use = meter.stationUsage?.(s.id) ?? meter.usage?.get(s.id * 4 + 2);
  if (use) for (let owner = 0; owner < use.length; owner++) if (use[owner] > 0) remember(owner);
  if (by.size < 2) return null;
  const known = !!meter.stationUsage || meter.usage instanceof Map;
  const mult = g.accessMultiplier(s.owner), monthly = g.stationMaintenance(s) / 12;
  let guests = 0;
  if (use) for (let owner = 0; owner < use.length; owner++) if (owner !== s.owner) guests += use[owner] || 0;
  const W = (use?.[s.owner] ?? 0) + mult * guests;
  const share = (owner: number) => W > 0 ? (owner === s.owner ? (use?.[owner] ?? 0) : mult * (use?.[owner] ?? 0)) / W : owner === s.owner ? 1 : 0;
  return h('div', { class: 'stopshare' },
    section('Shared stop upkeep', `${fmtMoney(monthly)} / month`),
    h('div', { class: 'muted station-advice' }, known ? `Month so far · users weighted ${fmtMult(mult)}; final shares depend on calls at month end.` : 'Per-stop usage figures are not available yet.'),
    [...by].map(([owner, ls]) => h('div', { class: 'stopshare-company' },
      h('div', { class: 'kv' }, ui.ownerTag(owner), h('span', { class: 'v', 'data-tip': 'Estimated maintenance share from calls at this stop this month' }, known ? `${fmtPct(share(owner))} · ${fmtMoneyFull(monthly * share(owner))}/mo` : '—')),
      h('div', { class: 'share-lines' }, ls.size ? [...ls].map((l) => lineTag(g, l, () => ui.openLine(l.id))) : h('span', { class: 'muted' }, owner === s.owner ? 'Stop owner' : 'No current line')))));
}

/** Nearby stations with a rebuild / complex explanation from the authoritative merge check. */
function transferSection(ui: UI, s: Station, after: () => void): HTMLElement | null {
  const g = ui.game;
  const opts = g.stations.transferOptions(s.id);
  if (!opts.length) return null;
  const kindIcon = (o: Station | undefined) => (!o ? 'station' : o.rail ? 'station' : o.stops.some((p) => g.world.net.edges.get(p.edge)?.tram) ? 'tramstop' : 'busstop');
  const done = (err: string | null | void, ok: string) => { if (typeof err === 'string' && err) ui.toast(err, 'bad'); else { ui.toast(ok, 'good'); ui.sound('station', { x: s.x, z: s.z, pitch: 1.1 }); } after(); };
  return h('div', null,
    section('Merge with nearby station'),
    h('div', { class: 'list' }, opts.slice(0, 6).map((o) => {
      const other = g.stations.get(o.id);
      const c = canMerge(g, s.id, o.id);
      const linked = o.linked && c.kind === 'complex';
      return h('div', { class: 'merge-choice' },
        h('div', { class: 'inline wrap' }, icon(kindIcon(other), 15), ui.stationLink(o.id), h('span', { class: 'muted' }, fmtLen(o.gap)),
          c.kind ? h('span', { class: 'flag' }, c.kind === 'rebuild' ? 'Rebuild' : 'Complex') : null),
        h('div', { class: c.ok ? 'muted' : 'neg' }, c.reason),
        h('div', { class: 'btns' },
          o.linked
            ? h('button', { class: 'btn sm', 'data-tip': 'Passengers no longer walk between the two', onclick: () => { g.stations.unlink(s.id, o.id); done(null, `${o.name} unlinked`); } }, 'Unlink')
            : h('button', { class: 'btn sm', disabled: !!o.link, 'data-tip': o.link ?? 'Passengers may walk between the two stations to change lines', onclick: () => done(g.stations.link(s.id, o.id), `${o.name} linked for transfers`) }, 'Link'),
          h('button', { class: 'btn sm primary', disabled: !c.ok || linked, 'data-tip': c.reason, onclick: () => {
            const check = canMerge(g, s.id, o.id);
            if (!check.ok) { done(check.reason, ''); return; }
            if (check.kind === 'rebuild' && !confirm(`Merge ${o.name} into ${s.name}? Its platforms, stops, waiting passengers and line stops move to ${s.name}.`)) return;
            const result = mergeStations(g, s.id, o.id);
            done(result.error, result.kind === 'complex' ? `${o.name} joined to the transfer complex` : `${o.name} merged into ${s.name}`);
          } }, linked ? 'In complex' : c.kind === 'complex' ? 'Form complex' : 'Merge')));
    })));
}

/** Add-entrance mode of the entrance tool for a station. */
export function startEntrance(ui: UI, stationId: number) {
  const T = ui.tools;
  T.setTool('entrance');
  T.entranceStation = stationId;
  T.refreshHover();
  ui.hud.onToolChange();
  const st = ui.game.stations.get(stationId);
  if (st) ui.centerOn(st.x, st.z, 40);
}

/** Build tab: rebuild (platform length, tracks, level), entrances, move the station. */
function buildTab(ui: UI, s: Station, up: StationBuild, plan: () => UpgradePlan, after: () => void, body: HTMLElement) {
  const g = ui.game;
  const r = s.rail;
  if (!r) { add(body, h('div', { class: 'pad' }, 'Bus and tram stops have nothing to rebuild. Move a stop by removing it and building a new one.')); return; }
  const changed = up.length !== r.length || up.tracks !== r.tracks || up.through !== (r.through ?? 0) || up.level !== r.level;
  const pl = changed ? plan() : null;
  add(body,
    section('Rebuild', changed ? 'planned' : 'as built'),
    field('Platforms', stepper(`${Math.round(up.length * 10)} m`, () => { up.length = Math.max(4, up.length - 2); after(); }, () => { up.length = Math.min(60, up.length + 2); after(); }, 'Platform length')),
    field('Tracks', stepper(String(up.tracks), () => { up.tracks = Math.max(g.stations.get(s.id)?.rail?.tracks ?? up.tracks, up.tracks - 1); after(); }, () => { up.tracks = Math.min(8, up.tracks + 1); after(); }), 'With platforms · up to 8'),
    field('Through', stepper(String(up.through), () => { up.through = Math.max(0, up.through - 1); after(); }, () => { up.through = Math.min(2, up.through + 1); after(); }), 'Without platforms, for trains that do not stop'),
    field('Level', seg<StationLevel>([['ground', 'Ground'], ['elevated', 'Elevated'], ['underground', 'Underground']], up.level, (v) => { up.level = v; after(); })),
    field('Expand side', seg<StationBuild['side']>([['auto', 'Auto'], ['left', 'Left'], ['right', 'Right']], up.side, (v) => { up.side = v; after(); }), 'Auto chooses the side with room'),
    pl ? h('div', { class: 'kv' }, h('span', { class: 'k' }, pl.ok ? 'Cost' : 'Not possible'), h('span', { class: 'v ' + (pl.ok ? '' : 'neg') }, pl.ok ? fmtMoney(pl.cost) : pl.error ?? 'Cannot rebuild')) : null,
    pl && pl.warnings.length ? h('div', { class: 'warn' }, icon('warning', 16), pl.warnings.join(' · ')) : null,
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', disabled: !pl || !pl.ok || !g.economy.canAfford(pl.cost), 'data-sfx': 'none', onclick: () => {
        if (!pl) return;
        const err = commitStationUpgrade(g, planStationUpgrade(g, s.id, up));
        if (err === 'busy') { ui.toast('A train is in the station — try again in a moment', 'info'); return; }
        if (err) { ui.toast(err, 'bad'); return; }
        ui.sound('station', { x: s.x, z: s.z });
        ui.toast(`${s.name} rebuilt`, 'good');
        const current = g.stations.get(s.id)?.rail;
        if (current) { up.length = current.length; up.tracks = current.tracks; up.through = current.through ?? 0; up.level = current.level; }
        after();
      } }, icon('upgrade', 16), pl && pl.ok ? `Rebuild for ${fmtMoney(pl.cost)}` : 'Rebuild'),
      changed ? h('button', { class: 'btn ghost', onclick: () => {
        const current = g.stations.get(s.id)?.rail;
        if (current) { up.length = current.length; up.tracks = current.tracks; up.through = current.through ?? 0; up.level = current.level; }
        up.side = 'auto'; after();
      } }, 'Reset') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', 'data-tip': 'Place the station somewhere else; lines and passengers move with it', onclick: () => {
        const current = g.stations.get(s.id);
        const r = current?.rail;
        if (!r || current.owner !== PLAYER) return;
        const T = ui.tools;
        T.setTool(railModeOf(r.trackType) === 'mainline' ? 'station' : 'metro-station');
        T.stationLen = r.length; T.stationTracks = r.tracks; T.stationLevel = r.level;
        T.stationType = r.trackType; T.stationStyle = styleOf(r.style).id;
        T.stationThrough = r.through ?? 0; T.throughMode = r.throughMode ?? 'middle';
        T.stationOnLine = false; T.stationAngle = r.angle;
        if (r.level === 'elevated') T.stationHeight = r.height || T.stationHeight;
        if (r.level === 'underground') T.stationDepth = r.depth || T.stationDepth;
        T.relocating = s.id;
        T.refreshHover();
        ui.hud.onToolChange();
      } }, icon('move', 16), 'Move')));
  // platform / through tracks left unconnected where other tracks of the station are connected
  const net = g.world.net, own = new Set([...r.edges, ...(r.throughEdges ?? [])]);
  const ends = g.stations.trackEnds(s, true);
  const open = (nid: number) => (net.nodes.get(nid)?.edges.filter((id) => !own.has(id)).length ?? 0) === 0;
  const loose = ends.reduce((a, t) => a + (open(t.front) ? 1 : 0) + (open(t.back) ? 1 : 0), 0);
  const tied = ends.length * 2 - loose;
  if (loose && tied) {
    add(body, section('Track connections', `${loose} open track end${loose > 1 ? 's' : ''}`),
      h('div', { class: 'btns' }, h('button', { class: 'btn', 'data-tip': 'Lay turnouts from the open platform and through tracks onto the connected ones', onclick: () => {
        const res = connectStationThroat(g, s.id, PLAYER);
        if (res.connected) { ui.sound('build-rail', { x: s.x, z: s.z }); ui.toast(`${res.connected} track${res.connected > 1 ? 's' : ''} connected${res.failed.length ? ` — ${res.failed[0]}` : ''}`, res.failed.length ? 'info' : 'good'); }
        else ui.toast(res.failed[0] ?? 'Nothing to connect', 'bad');
        after();
      } }, icon('rail', 16), 'Connect station tracks')));
  }
  if (r.level !== 'ground') {
    add(body, section('Entrances', String(r.entrances.length)),
      h('div', { class: 'list' }, r.entrances.map((e, i) => {
        const onRoad = g.stations.entranceAccess(s, e);
        return h('div', { class: 'row' },
          h('span', { class: 'inline' }, icon('entrance', 14), `Entrance ${i + 1}`),
          h('span', { class: onRoad ? 'pos' : 'neg' }, onRoad ? 'on the street' : 'no road'),
          h('span', { class: 'rowbtns' },
            h('button', { class: 'ibtn sm', 'data-tip': 'Show', 'aria-label': 'Show entrance', onclick: () => ui.centerOn(e.x, e.z, 25) }, icon('target', 14)),
            h('button', { class: 'ibtn sm', disabled: r.entrances.length <= 1, 'data-tip': r.entrances.length <= 1 ? 'A station needs at least one entrance' : 'Remove', 'aria-label': 'Remove entrance', onclick: () => {
              const err = g.stations.removeEntrance(s.id, i, PLAYER);
              if (err) ui.toast(err, 'bad'); else { ui.sound('demolish', { x: e.x, z: e.z, pitch: 1.3 }); after(); }
            } }, icon('trash', 14))));
      })),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => startEntrance(ui, s.id) }, icon('plus', 16), 'Add entrance'), h('span', { class: 'muted' }, `${fmtMoney(ENTRANCE_COST[r.level])} each · own catchment`)));
  }
}

/** Owner, access status (with "Request access") and how the upkeep would be shared, for another company's item. */
function accessRows(ui: UI, owner: number, upkeepYear: number, after: () => void): HTMLElement {
  const g = ui.game;
  const st = accessState(g, owner);
  const m = g.accessMultiplier(owner);
  return h('div', null,
    ui.kv('Owner', h('span', { class: 'inline' }, ui.ownerTag(owner), h('button', { class: 'ibtn sm', 'data-tip': 'Track access', 'aria-label': 'Track access', onclick: () => ui.openTrackAccess() }, icon('key', 15)))),
    ui.kv('Track access', h('span', { class: 'inline' }, h('span', { class: st.kind === 'agreement' ? 'pos' : st.kind === 'blocked' || st.kind === 'closed' ? 'neg' : 'muted' }, st.kind === 'agreement' ? (g.hasAccess(PLAYER, owner) ? 'Agreement' : 'Open network') : st.kind === 'pending' ? 'Request pending' : st.kind === 'blocked' ? 'Blocked' : st.kind === 'closed' ? 'Refused' : policyText(g, owner)),
      st.kind === 'agreement' ? null : accessControl(ui, owner, after))),
    ui.kv('Upkeep', h('span', { 'data-tip': `Shared by usage: the owner's traffic counts once, users' ${fmtMult(m)}; at 50/50 usage users pay ${fmtPct(equalUseShare(m))}` }, `${fmtMoney(upkeepYear)}/yr · users pay ${fmtMult(m)}`)),
    st.kind === 'agreement' ? h('div', { class: 'muted', style: 'margin-top:4px' }, st.text) : null);
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
      ed.tram ? ui.kv('Tram tracks', ed.tramOwner !== undefined && ed.tramOwner >= 0 ? g.company(ed.tramOwner).name : 'yes') : null,
      ed.station >= 0 ? ui.kv('Station', ui.stationLink(ed.station)) : null,
      rail && ed.owner >= 0 && ed.owner !== PLAYER ? accessRows(ui, ed.owner, g.edgeMaintenance(ed), () => { win.last = undefined; render(); }) : null,
      !rail && ed.tram && (ed.tramOwner ?? -1) >= 0 && ed.tramOwner !== PLAYER ? accessRows(ui, ed.tramOwner!, ed.len * TRAM.maintPerUnit, () => { win.last = undefined; render(); }) : null,
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
    const units = new Map<string, number>();
    for (const c of v.cars) if (c.kind === 'emu') units.set(c.name, (units.get(c.name) ?? 0) + 1);
    return [loco.length > 1 ? `${loco.length}× ${loco[0].name}` : loco[0]?.name, ...[...wn.entries()].map(([n, c]) => `${c}× ${n}`), ...[...units].map(([n, c]) => `${c}× ${n}`)].filter(Boolean).join(' + ');
  }
  return (v as RoadVehicle).model?.name ?? 'Car';
}

export function openVehicle(ui: UI, id: number) {
  const g = ui.game;
  const v = g.vehicles.get(id);
  if (!v) return;
  const vk = vehicleKind(v);
  const win = ui.wm.open('veh-' + id, v.name, { width: 400, icon: KIND_META[vk].icon, color: g.company(v.owner).color, cls: 'vehicle-info' });
  const render = () => {
    const v2 = g.vehicles.get(id);
    if (!v2) { win.close(); return; }
    win.title.textContent = v2.name;
    win.sub.textContent = vehicleDesc(v2) + (v2 instanceof Train ? ` · ${Math.round(v2.length * 10)} m` : '');
    clear(win.body);
    const mine = v2.owner === PLAYER;
    const kind = vk;
    const after = () => { win.last = undefined; render(); };
    let lineEl: Node;
    if (mine) {
      const lines = g.lines.all().filter((l) => l.kind === kind && (l.owner === PLAYER || l.operators?.includes(PLAYER)));
      const current = lines.find((l) => l.id === v2.line?.id);
      const sel = h('select', { class: 'select', 'aria-label': 'Line' }, h('option', { value: '', selected: !current }, '— no line —'),
        lines.map((l) => h('option', { value: String(l.id), selected: l.id === current?.id }, l.name + (l.owner !== PLAYER ? ' · partner' : ''))));
      sel.addEventListener('change', () => {
        const next = sel.value ? g.lines.get(Number(sel.value)) : null;
        const err = next ? g.lines.operateError(next, PLAYER) : null;
        if (err) ui.toast(err, 'bad'); else v2.setLine(next?.id ?? null);
        after();
      });
      lineEl = sel;
    } else lineEl = v2.line ? lineTag(g, v2.line, () => ui.openLine(v2.line!.id)) : document.createTextNode('—');
    const target = v2.targetStation();
    const load = v2.capacity ? v2.load / v2.capacity : 0;
    const compat = v2 instanceof Train ? railWarning(ui, v2.cars, v2.line, v2.depotId) : null;
    add(win.body, 
      h('div', { class: 'tiles' },
        tile(`${v2.speedKmh.toFixed(0)}`, `km/h of ${v2.maxSpeedKmh}`),
        tile(`${v2.load}/${v2.capacity}`, 'Passengers', '', bar(load, 'var(--info)')),
        tile(fmtMoney(v2.profitYear), 'Profit this year', v2.profitYear < 0 ? 'neg' : 'pos'),
        tile(`${v2.age.toFixed(1)}`, 'Years old')),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Line'), h('span', { class: 'v' }, lineEl)),
      vehicleService(ui, v2, after),
      compat ? h('div', { class: 'alert warn' }, icon('warning', 16), h('div', { class: 'alert-b' }, h('b', null, 'Compatibility'), h('div', null, compat))) : null,
      ui.kv('Status', v2.status),
      target ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Next stop'), h('span', { class: 'v' }, ui.stationLink(target.id))) : null,
      v2 instanceof Train && Math.abs(v2.grade) > 0.004 ? ui.kv('Gradient', fmtPct(v2.grade, 1)) : null,
      ui.kv('Profit last year', h('span', { class: v2.profitLast < 0 ? 'neg' : 'pos' }, fmtMoneyFull(v2.profitLast))),
      ui.kv('Base running cost', fmtMoney(v2.runningCost) + ' / yr'),
      ui.kv('Value', fmtMoney(g.vehicles.resaleValue(v2))),
      vehicleCosts(v2),
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

/** Pattern assignment also works for an old line with its implicit all-stops Local service. */
function vehicleService(ui: UI, v: Vehicle, after: () => void): HTMLElement | null {
  const l = v.line;
  if (!l) return null;
  const ps = linePatterns(l), cur = ps.find((p) => p.id === v.pattern) ?? ps[0];
  if (!cur) return null;
  const n = new Set(patternStops(l, cur.id).map((i) => l.stops[i])).size;
  if (v.owner !== PLAYER) return ui.kv('Service pattern', h('span', { class: 'inline wrap' }, patBadge(cur.kind, cur.name), cur.name));
  const sel = h('select', { class: 'select', 'aria-label': 'Service pattern' }, ps.map((p) =>
    h('option', { value: String(p.id), selected: p.id === cur.id }, p.name === PATTERN_LABEL[p.kind] ? p.name : `${p.name} · ${PATTERN_LABEL[p.kind]}`)));
  sel.addEventListener('change', () => {
    const err = setVehiclePattern(ui.game, v.id, Number(sel.value));
    if (err) ui.toast(err, 'bad'); else ui.sound('toggle');
    after();
  });
  return h('div', null,
    field('Service pattern', h('span', { class: 'vehicle-service' }, patBadge(cur.kind, cur.name), sel), `${n} stations served · set stop/pass and short-turns in the line’s Services tab`),
    h('div', { class: 'btns' }, h('button', { class: 'btn sm ghost', onclick: () => {
      ui.openLine(l.id);
      const w = ui.wm.get('line-' + l.id);
      if (w) { w.tab = 'services'; w.last = undefined; w.refresh?.(); }
    } }, icon('lines', 15), 'Edit services…')));
}

/** No annualisation or aggregate company fees: show the vehicle's own last monthly bill. */
function vehicleCosts(v: Vehicle): HTMLElement {
  const last = v.opLast as (Partial<OpCost> & { trackFees?: number; trackWear?: number }) | null | undefined;
  const out = h('div', null, section('Last month’s operating costs'));
  if (!last) { add(out, h('div', { class: 'muted station-advice' }, 'Figures appear after the first monthly bill.')); return out; }
  const money = (x: number | undefined) => typeof x === 'number' && isFinite(x) ? fmtMoneyFull(x) : '—';
  add(out, h('div', { class: 'costgrid' },
    h('span', null, 'Energy & fuel'), h('span', null, money(last.energy)),
    h('span', null, 'Crew wages'), h('span', null, money(last.crew)),
    h('span', null, 'Vehicle maintenance'), h('span', null, money(last.maint)),
    h('span', null, 'Vehicle overheads'), h('span', null, money(last.overhead)),
    h('span', null, 'Vehicle operating total'), h('span', null, money(last.total)),
    h('span', null, 'Track access fees'), h('span', null, money(last.trackFees)),
    typeof last.trackWear === 'number' ? [h('span', null, 'Track wear'), h('span', null, money(last.trackWear))] : null));
  // TODO: OpCost needs per-vehicle trackFees; fees and track wear are currently billed at company level.
  if (typeof last.trackFees !== 'number') add(out, h('div', { class: 'muted station-advice' }, 'Track fees and wear are billed to the company; per-vehicle fees are unavailable. See Finances.'));
  const use: string[] = [];
  if (typeof last.km === 'number' && isFinite(last.km)) use.push(`${last.km.toFixed(1)} km`);
  if (typeof last.kwh === 'number' && isFinite(last.kwh)) use.push(`${fmtInt(last.kwh)} kWh`);
  if (typeof last.hours === 'number' && isFinite(last.hours)) use.push(`${last.hours.toFixed(1)} hours in service`);
  if (use.length) add(out, h('div', { class: 'muted station-advice' }, use.join(' · ')));
  return out;
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
  const buses = availableModels(year, rv.model?.kind === 'tram' ? 'tram' : 'bus');
  const best = buses[buses.length - 1];
  if (!rv.model || !best || best.id === rv.model.id || best.intro <= rv.model.intro) return null;
  return { cars: [best], label: best.name };
}

function upgradeVehicle(ui: UI, v: Vehicle) {
  const g = ui.game;
  const opt = upgradeOption(ui, v);
  if (!opt) return;
  const kind = vehicleKind(v);
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
  if (dp.owner === PLAYER) { openPurchase(ui, dp.kind as LineKind, depotId, null); return; }
  const win = ui.wm.open('depot-' + depotId, depotTitle(dp.kind), { width: 340, icon: depotIcon(dp.kind), color: g.company(dp.owner).color, sub: g.company(dp.owner).name });
  const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
  add(win.body, 
    h('div', { class: 'tiles' }, tile(String(here.length), 'Vehicles')),
    h('div', { class: 'list' }, here.slice(0, 12).map((v) => h('div', { class: 'row link', onclick: () => openVehicle(ui, v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))),
  );
}

/** Purchase dialog / train composer. If depotId is null a suitable depot for the line is chosen. */
export function openPurchase(ui: UI, kind: LineKind, depotId: number | null, lineId: number | null) {
  const g = ui.game;
  const year = g.year;
  const rail = kind === 'rail';
  const meta = KIND_META[kind];
  const win = ui.wm.open('buy-' + kind + '-' + (depotId ?? 'line'), rail ? 'Train composer' : `Buy ${meta.vehicle}`, { width: 470, icon: meta.icon, color: meta.color, sub: depotId != null ? depotTitle(kind) : 'For a line', cls: 'purchase-info' });
  const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon'), emus = availableModels(year, 'emu'), buses = availableModels(year, kind === 'tram' ? 'tram' : 'bus');
  const initialLine = lineId != null ? g.lines.get(lineId) : null;
  const initialDepot = depotId != null ? g.depots.get(depotId) : null;
  const exit = initialDepot ? g.world.net.nodes.get(initialDepot.node)?.edges.map((id) => g.world.net.edges.get(id)).find((e) => e?.kind === 'rail' && e.depot < 0) : null;
  const trackType = initialLine?.stops.map((id) => g.stations.get(id)?.rail?.trackType).find(Boolean) ?? exit?.type;
  const units = emus.filter((m) => !trackType || modelTracks(m).includes(trackType));
  const primaryUnits = units.filter((m) => m.tracks?.[0] === trackType);
  const unitDefault = primaryUnits[primaryUnits.length - 1] ?? units[units.length - 1] ?? emus[emus.length - 1];
  const state = { train: (emus.length && (trackType === 'metro' || trackType === 'lightrail' || trackType === 'highspeed') ? 'unit' : 'hauled') as 'hauled' | 'unit',
    loco: locos[locos.length - 1]?.id ?? '', locoN: 1, wagon: wagons[wagons.length - 1]?.id ?? '', count: 2,
    unit: unitDefault?.id ?? '', unitN: 1, bus: buses[buses.length - 1]?.id ?? '', line: initialLine?.id ?? lineId, depot: depotId };
  let purchaseCars: VehicleModel[] = [];
  const validateSelection = () => {
    const line = state.line != null ? g.lines.get(state.line) : null;
    state.line = line && line.kind === kind && g.lines.canOperate(line, PLAYER) ? line.id : null;
    const depot = state.depot != null ? g.depots.get(state.depot) : null;
    if (!depot || depot.owner !== PLAYER || depot.kind !== kind) state.depot = null;
  };
  const render = () => {
    validateSelection();
    clear(win.body);
    const modelRow = (m: VehicleModel, selected: boolean, onSel: () => void) => {
      const pick = () => { onSel(); render(); };
      return h('div', { class: 'model' + (selected ? ' sel' : ''), role: 'radio', tabindex: 0, 'aria-label': m.name, 'aria-checked': selected ? 'true' : 'false', onclick: pick,
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
        h('div', { class: 'mname' }, h('span', null, m.name), h('span', { class: 'mcost', title: m.kind === 'emu' ? 'Price for one whole unit' : 'Purchase price' }, fmtMoney(m.cost))),
        h('div', { class: 'mstats' },
          h('span', null, icon('speed', 13), `${m.speed} km/h`),
          m.capacity ? h('span', null, icon('people', 13), `${m.capacity}${m.kind === 'emu' ? ' / unit' : ''}`) : null,
          m.power ? h('span', null, `${m.power} kW`) : null,
          h('span', null, icon('length', 13), `${Math.round(m.length * 10)} m`),
          h('span', null, `${fmtMoney(m.running)}/yr base`)),
        h('div', { class: 'mtags' },
          m.kind === 'emu' ? h('span', { class: 'mtag' }, `${m.unitCars ?? 1} cars / unit`) : null,
          m.traction !== 'none' ? h('span', { class: 'mtag' }, m.traction === 'electric' ? icon('bolt', 12) : null, m.traction) : null,
          rail ? modelTracks(m).filter((t) => m.traction !== 'electric' || TRACK_TYPES[t]?.electrified).map((t) => h('span', { class: 'mtag', style: `--c:${TYPE_META[t]?.color ?? '#9aa5b4'}`, title: `${TRACK_TYPES[t]?.name ?? t}${m.traction === 'electric' ? ' · electrification required' : ''}` }, h('i'), TYPE_META[t]?.short ?? t)) : null));
    };
    if (rail) {
      if (emus.length) add(win.body, field('Train type', seg([['hauled', 'Locomotive + coaches'], ['unit', 'Multiple units']], state.train, (v) => { state.train = v; render(); })));
      if (state.train === 'unit') {
        add(win.body, section('Multiple units', 'price and capacity per whole unit'));
        for (const m of emus) add(win.body, modelRow(m, state.unit === m.id, () => (state.unit = m.id)));
        add(win.body, field('Units', stepper(String(state.unitN), () => { state.unitN = Math.max(1, state.unitN - 1); render(); }, () => { state.unitN = Math.min(4, state.unitN + 1); render(); }), 'Couple complete units; cars are included in the unit price'));
      } else {
        add(win.body, section('Locomotive'));
        for (const m of locos) add(win.body, modelRow(m, state.loco === m.id, () => (state.loco = m.id)));
        add(win.body, section('Coaches'));
        for (const m of wagons) add(win.body, modelRow(m, state.wagon === m.id, () => (state.wagon = m.id)));
        add(win.body, h('div', { class: 'inline wrap', style: 'margin-top:10px' },
          h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Locomotives'), stepper(String(state.locoN), () => { state.locoN = Math.max(1, state.locoN - 1); render(); }, () => { state.locoN = Math.min(2, state.locoN + 1); render(); })),
          h('div', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Coaches'), stepper(String(state.count), () => { state.count = Math.max(1, state.count - 1); render(); }, () => { state.count = Math.min(14, state.count + 1); render(); }))));
      }
    } else {
      // long-distance coaches (faster, more seats, for intercity lines on country roads) listed apart from city buses
      const isCoach = (m: VehicleModel) => kind === 'road' && /coach/.test(m.style ?? '');
      const city = buses.filter((m) => !isCoach(m)), coaches = buses.filter(isCoach);
      add(win.body, section(coaches.length ? 'City buses' : 'Model'));
      for (const m of city) add(win.body, modelRow(m, state.bus === m.id, () => (state.bus = m.id)));
      if (coaches.length) {
        add(win.body, section('Long-distance coaches', 'intercity lines'));
        for (const m of coaches) add(win.body, modelRow(m, state.bus === m.id, () => (state.bus = m.id)));
      }
    }
    const loco = MODEL_BY_ID.get(state.loco), wagon = MODEL_BY_ID.get(state.wagon), unit = MODEL_BY_ID.get(state.unit), bus = MODEL_BY_ID.get(state.bus);
    const cars: VehicleModel[] = rail
      ? state.train === 'unit' ? unit ? Array<VehicleModel>(state.unitN).fill(unit) : []
        : (loco ? [...Array<VehicleModel>(state.locoN).fill(loco), ...(wagon ? Array<VehicleModel>(state.count).fill(wagon) : [])] : [])
      : bus ? [bus] : [];
    purchaseCars = cars;
    const cost = cars.reduce((s, c) => s + c.cost, 0);
    const cap = cars.reduce((s, c) => s + c.capacity, 0);
    const spd = cars.length ? Math.min(...cars.map((c) => c.speed)) : 0;
    const len = cars.reduce((s, c) => s + c.length + CAR_GAP, 0);
    const lines = g.lines.all().filter((l) => l.kind === kind && (l.owner === PLAYER || l.operators?.includes(PLAYER)));
    const currentLine = state.line != null ? g.lines.get(state.line) : null;
    state.line = currentLine && lines.includes(currentLine) ? currentLine.id : null;
    const sel = h('select', { class: 'select', 'aria-label': 'Line' }, h('option', { value: '', selected: state.line == null }, '— no line —'), lines.map((l) => h('option', { value: String(l.id), selected: l.id === state.line }, `${l.name} (${l.stops.length} stops)${l.owner !== PLAYER ? ' · ' + g.company(l.owner).name + ' · partner' : ''}`)));
    sel.addEventListener('change', () => { state.line = sel.value ? Number(sel.value) : null; render(); });
    // shortest platform on the selected line
    let warn = '';
    const line = state.line != null ? g.lines.get(state.line) : undefined;
    const resolved = state.depot ?? findDepot(ui, kind, line, cars);
    const candidate = resolved != null ? g.depots.get(resolved) : null;
    const dp = candidate?.owner === PLAYER && candidate.kind === kind ? candidate : null;
    const depotSel = h('select', { class: 'select', 'aria-label': 'Purchase depot' },
      h('option', { value: '', selected: state.depot == null }, 'Auto · connected depot'),
      g.depots.all().filter((d) => d.kind === kind && d.owner === PLAYER).map((d) => h('option', { value: String(d.id), selected: d.id === state.depot }, `${depotTitle(d.kind)} ${d.id} · ${g.towns.nearest(d.x, d.z)?.name ?? 'Countryside'}`)));
    depotSel.addEventListener('change', () => { state.depot = depotSel.value ? Number(depotSel.value) : null; render(); });
    const compat = rail ? railWarning(ui, cars, line, dp?.id ?? null) : line?.stops.length && dp && !roadDepotReaches(g, dp, line.stops[0]) ? `This depot cannot reach the first stop of ${line.name}.` : null;
    const opError = line ? g.lines.operateError(line, PLAYER) : null;
    let minP = Infinity;
    if (rail && line) {
      let minName = '';
      for (const sid of line.stops) { const st = g.stations.get(sid); if (st?.rail && st.rail.length < minP) { minP = st.rail.length; minName = st.name; } }
      if (isFinite(minP) && len > minP) warn = `The train (${Math.round(len * 10)} m) is longer than the platforms at ${minName} (${Math.round(minP * 10)} m) — use fewer ${state.train === 'unit' ? 'units' : 'coaches'}.`;
    }
    // composition strip
    const strip = rail && cars.length ? h('div', { class: 'consist', title: 'Composition' }, cars.map((c) => h('span', { class: 'car' + (c.kind === 'loco' ? ' loco' : c.kind === 'emu' ? ' unit' : ''), style: `flex:${c.length};--c:${hex(c.color)}`, 'data-tip': c.kind === 'emu' ? `${c.name} · ${c.unitCars ?? 1} cars` : c.name }))) : null;
    const power = cars.reduce((s, c) => s + c.power, 0);
    add(win.body, 
      section('Summary'),
      strip,
      rail && state.train === 'unit' && unit ? ui.kv('Whole units', `${state.unitN} × ${unit.unitCars ?? 1} cars · ${unit.capacity} passengers / unit`) : null,
      h('div', { class: 'summary' },
        tile(fmtMoney(cost), 'Price'),
        tile(String(cap), 'Passengers'),
        tile(String(spd), 'km/h'),
        rail ? tile(`${Math.round(len * 10)} m`, isFinite(minP) ? `of ${Math.round(minP * 10)} m platform` : 'Length', warn ? 'neg' : '') : null,
        rail ? tile(`${power}`, 'kW') : null),
      warn ? h('div', { class: 'warn' }, icon('warning', 16), warn) : null,
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Assign to line'), h('span', { class: 'v' }, sel)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Depot'), h('span', { class: 'v' }, depotSel)),
      dp && state.depot == null ? h('div', { class: 'muted station-advice' }, `Selected automatically: ${depotTitle(dp.kind)} ${dp.id}`) : null,
      compat ? h('div', { class: 'alert warn' }, icon('warning', 16), h('div', { class: 'alert-b' }, h('b', null, 'Compatibility'), h('div', null, compat))) : null,
      opError || !dp ? h('div', { class: 'warn' }, icon('warning', 16), opError ?? `No ${depotTitle(kind).toLowerCase()} ${line ? 'connected to this line for the selected model' : 'available'}. Build one or choose another depot.`) : null,
      h('div', { class: 'btns right' }, h('button', { class: 'btn primary', disabled: !cars.length || !dp || !!opError || dp.owner !== PLAYER || !g.economy.canAfford(cost), 'data-sfx': 'none', onclick: () => buy() }, icon('plus', 16), `Buy for ${fmtMoney(cost)}`)),
    );
    if (depotId != null && g.depots.get(depotId)?.owner === PLAYER) {
      add(win.body, h('div', { class: 'btns' }, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', 'data-tip': 'Place the depot somewhere else; its vehicles move with it', onclick: () => {
        const T = ui.tools;
        T.setTool(kind === 'rail' ? 'depot-rail' : kind === 'tram' ? 'depot-tram' : 'depot-road');
        T.relocatingDepot = depotId;
        T.refreshHover();
        ui.hud.onToolChange();
        win.close();
      } }, icon('move', 16), 'Move depot')));
    }
    if (depotId != null) {
      const here = g.vehicles.all().filter((v) => (v as Train | RoadVehicle).depotId === depotId);
      if (here.length) {
        add(win.body, section('Vehicles from this depot', String(here.length)),
          h('div', { class: 'list' }, here.map((v) => h('div', { class: 'row link', onclick: () => openVehicle(ui, v.id) }, h('span', null, v.name), h('span', { class: 'muted' }, v.status)))));
      }
    }
    const buy = () => {
      // Window morphing may keep this button's listener: read the latest composition and line on click.
      validateSelection();
      const chosenCars = purchaseCars;
      const chosenLine = state.line != null ? g.lines.get(state.line) : undefined;
      if (!chosenCars.length) return;
      let dId = state.depot;
      if (dId == null) {
        dId = findDepot(ui, kind, chosenLine, chosenCars);
        if (dId == null) { ui.toast(`No ${depotTitle(kind).toLowerCase()} connected to this line for the selected model. Build one first.`, 'bad'); return; }
      }
      const depot = g.depots.get(dId);
      if (!depot || depot.owner !== PLAYER || depot.kind !== kind) { ui.toast('Choose a depot for this vehicle from your company', 'bad'); return; }
      const r = rail ? g.vehicles.buyTrain(dId, chosenCars, state.line) : g.vehicles.buyRoad(dId, chosenCars[0], state.line);
      if (typeof r === 'string') { ui.toast(r, 'bad'); return; }
      ui.toast(`${r.name} purchased`, 'good');
      ui.sound('purchase');
      if (state.line == null) ui.toast('Tip: assign the vehicle to a line so it starts working.', 'info');
      render();
    };
  };
  win.refresh = render;
  render();
}

/** Model-aware route check, cached because pathfinding is too expensive for every window refresh. */
function railWarning(ui: UI, cars: VehicleModel[], line: Line | null | undefined, depotId: number | null): string | null {
  if (!cars.length) return null;
  const g = ui.game;
  const key = `${g.networkVersion}|${g.world.net.version}|${g.lines.version}|${line?.id}|${line?.stops.join(',')}|${depotId}|${cars.map((c) => c.id).join(',')}`;
  return memo(g, 'rail-warning:' + (line?.id ?? 'none') + ':' + (depotId ?? 'none'), key, () => {
    const problem = line ? lineCompatibility(g, line.id, cars) : null;
    if (problem) return problem;
    const dp = depotId != null ? g.depots.get(depotId) : null;
    if (!dp) return null;
    if (dp.kind !== 'rail') return 'Choose a train depot for this model.';
    if (line && line.stops.length >= 2 && depotServes(g, dp, line.stops[0], line.stops[1], cars) < 0) return `Depot ${dp.id} cannot send this train onto ${line.name}: check track types, electrification and access.`;
    if (line?.stops.length === 1 && !depotReaches(g, dp, line.stops[0], cars)) return `Depot ${dp.id} cannot reach ${g.stations.get(line.stops[0])?.name ?? 'the line'} with this model.`;
    if (!line?.stops.length) {
      const exits = g.world.net.nodes.get(dp.node)?.edges.map((id) => g.world.net.edges.get(id)).filter((e) => e?.kind === 'rail' && e.depot < 0) ?? [];
      if (!exits.length) return 'This depot is not connected to the rail network.';
      if (exits.every((e) => e && !trackAllows(cars, e))) return 'The track leaving this depot does not allow this model: check track types and electrification.';
    }
    return null;
  }, 3000);
}

export function findDepot(ui: UI, kind: LineKind, line: Line | null | undefined, cars?: VehicleModel[]): number | null {
  const g = ui.game;
  const key = `${g.networkVersion}|${g.world.net.version}|${g.lines.version}|${line?.id}|${line?.stops.join(',')}|${cars?.map((c) => c.id).join(',')}`;
  return memo(g, 'find-depot:' + kind, key, () => {
    const depots = g.depots.all().filter((d) => (d.kind as string) === kind && d.owner === PLAYER);
    if (!depots.length) return null;
    if (!line || !line.stops.length) return depots.find((d) => kind !== 'rail' || !cars || !railWarning(ui, cars, line, d.id))?.id ?? depots[0].id;
    const st = g.stations.get(line.stops[0]);
    if (!st) return depots[0].id;
    depots.sort((a, b) => Math.hypot(a.x - st.x, a.z - st.z) - Math.hypot(b.x - st.x, b.z - st.z));
    for (const d of depots) {
      const ok = kind === 'rail' ? line.stops.length >= 2 ? depotServes(g, d, line.stops[0], line.stops[1], cars) >= 0 : depotReaches(g, d, st.id, cars) : roadDepotReaches(g, d, st.id);
      if (ok) return d.id;
    }
    return null;
  }, 3000);
}
