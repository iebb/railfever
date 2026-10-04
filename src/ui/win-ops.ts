// Operations panels of the line window: congestion warnings with one-click fixes (signals, double track, more
// platforms), through services across operators and track types, track compatibility of the line's vehicles,
// shared lines (partner operators, join / leave), fares with the speed factor, and decommissioning.
import type { UI } from './ui';
import type { Game } from '../game/game';
import { PLAYER } from '../game/game';
import type { Line } from '../game/lines';
import type { NEdge } from '../game/network';
import { h, icon, add, seg, section } from './dom';
import { fmtMoney } from '../game/economy';
import { TRACK_TYPES, RAIL_FARE } from '../game/constants';
import { Train, lineCongestion, lineOperators, LineCongestion } from '../game/train';
import { autoSignalLine } from '../game/signals';
import { planDoubleTrack, commitDoubleTrack, DoublePlan } from '../game/trackops';
import { planStationUpgrade, commitStationUpgrade, stationCapacity, UpgradePlan } from '../game/stations';
import { electrify } from '../game/build-ops';
import { lineRoute, lineTable, patternHeadways, linePatterns, PATTERN_LABEL } from '../game/patterns';
import { fareBreakdown, stationFareContext, TRANSFER_FARE_FACTOR, FARE_LEVEL } from '../game/fares';
import { computeLinePath } from './linepaths';
import { fmtLen, fmtPct, TYPE_META } from './format';
import type { PartnerPolicy } from '../game/lines';

// ------------------------------------------------------------------ small cache (per game; keyed results)
const memos = new WeakMap<Game, Map<string, { key: string; v: unknown; t: number }>>();
const LINE_MEMOS = new Set(['cong', 'sigfix', 'dblfix', 'route', 'elec']);
const STATION_MEMOS = new Set(['platfix', 'station-expand', 'restyle']);
const VEHICLE_MEMOS = new Set(['van-add', 'van-drop']);

/** Drop entries for deleted entities, even when their windows are no longer open. */
export function pruneMemos(g: Game) {
  const m = memos.get(g);
  if (!m) return;
  for (const [name, c] of m) {
    const [kind, id, depot] = name.split(':');
    const lineGone = (LINE_MEMOS.has(kind) || kind === 'rail-warning' && id !== 'none') && !g.lines.map.has(Number(id));
    const stationGone = STATION_MEMOS.has(kind) && !g.stations.map.has(Number(id));
    const vehicleGone = VEHICLE_MEMOS.has(kind) && !g.vehicles.map.has(Number(id));
    const depotGone = kind === 'rail-warning' && depot !== 'none' && !g.depots.map.has(Number(depot))
      || kind === 'find-depot' && typeof c.v === 'number' && !g.depots.map.has(c.v);
    if (lineGone || stationGone || vehicleGone || depotGone) m.delete(name);
  }
}

/** Cache while `key` stays the same; `minAge` also throttles recomputations during rapid network changes. */
export function memo<T>(g: Game, name: string, key: string, fn: () => T, maxAge = Infinity, minAge = 0): T {
  let m = memos.get(g);
  if (!m) { m = new Map(); memos.set(g, m); }
  const c = m.get(name), now = performance.now();
  if (c && (now - c.t < minAge || c.key === key && now - c.t < maxAge)) return c.v as T;
  const v = fn();
  m.set(name, { key, v, t: now });
  return v;
}

const minSec = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Congestion of a rail line (all its operators' trains), cached about a second. */
export function congestionOf(g: Game, lineId: number): LineCongestion | null {
  const l = g.lines.get(lineId);
  if (!l || l.kind !== 'rail' || !l.vehicles.length) return null;
  return memo(g, 'cong:' + lineId, String(g.networkVersion), () => lineCongestion(g, lineId), 1000);
}

// ------------------------------------------------------------------ congestion
/** Plain own single track around the given edges (to the switches / stations at both ends), the longest run. */
function singleRun(g: Game, edgeIds: number[], max = 60): number[] {
  const net = g.world.net;
  const plain = (e: NEdge | undefined): e is NEdge => !!e && e.kind === 'rail' && e.owner === PLAYER && e.station < 0 && e.depot < 0;
  const seen = new Set<number>();
  let best: number[] = [], bestLen = 0;
  for (const id of edgeIds) {
    const e0 = net.edges.get(id);
    if (!plain(e0) || seen.has(id)) continue;
    const walk = (from: NEdge, node: number): number[] => {
      const out: number[] = [];
      let cur = from, n = node;
      while (out.length < max) {
        const nd = net.nodes.get(n);
        if (!nd || nd.edges.length !== 2) break;
        const nx = net.edges.get(nd.edges[0] === cur.id ? nd.edges[1] : nd.edges[0]);
        if (!plain(nx) || seen.has(nx.id) || nx.id === e0.id) break;
        seen.add(nx.id);
        out.push(nx.id);
        n = nx.a === n ? nx.b : nx.a;
        cur = nx;
      }
      return out;
    };
    seen.add(id);
    const back = walk(e0, e0.a), fwd = walk(e0, e0.b);
    const run = [...back.reverse(), id, ...fwd];
    const len = run.reduce((s, x) => s + (net.edges.get(x)?.len ?? 0), 0);
    if (len > bestLen) { bestLen = len; best = run; }
  }
  return best;
}

/** Double track for a congested single-track stretch: the right side, else the left. */
function doubleFor(g: Game, run: number[]): DoublePlan | null {
  if (!run.length) return null;
  let first: DoublePlan | null = null;
  for (const side of [1, -1] as const) {
    const p = planDoubleTrack(g, run, side, PLAYER);
    if (p.ok) return p;
    first ??= p;
  }
  return first;
}

/**
 * Congestion warning of a rail line with what would help and a one-click fix: signal the line, double the
 * single-track stretch the trains wait on, or add platforms where they queue for one. Null while it flows.
 */
export function congestionPanel(ui: UI, l: Line, after: () => void, showTrains?: () => void): HTMLElement | null {
  const g = ui.game;
  const c = congestionOf(g, l.id);
  if (!c || c.level < 2) return null;
  const mine = l.owner === PLAYER;
  const stuck = c.level >= 3;
  const what = c.deadlock ? 'Trains are stuck waiting for each other (deadlock)' : stuck ? `Trains are stuck: one has waited ${minSec(c.longestWait)}` : `Congested: ${plural(c.waits, 'train')} waiting (longest ${minSec(c.longestWait)})`;
  const btns: HTMLElement[] = [];
  let advice = '';
  const nv = g.networkVersion;
  if (c.suggestion === 'signals') {
    advice = 'There are no signals where the trains wait: signal the line so trains can follow each other and pass at loops.';
    if (mine) {
      const pre = memo(g, 'sigfix:' + l.id, String(nv), () => autoSignalLine(g, l.id, PLAYER, { preview: true }));
      const n = pre.signals.filter((s) => s.action !== 'keep').length;
      if (n) btns.push(h('button', { class: 'btn sm primary', disabled: !g.economy.canAfford(pre.cost), 'data-sfx': 'none', onclick: () => {
        const r = autoSignalLine(g, l.id, PLAYER);
        ui.sound('signal', { pitch: 1.1 });
        ui.toast(`Signalling: ${r.placed} placed · ${r.changed} changed${r.warnings.length ? ' — ' + r.warnings[0] : ''}`, r.warnings.length ? 'info' : 'good');
        after();
      } }, icon('signal', 15), `Auto-signal · ${plural(n, 'signal')} · ${fmtMoney(pre.cost)}`));
      btns.push(h('button', { class: 'btn sm', onclick: () => ui.openAutoSignal({ line: l.id }) }, 'Preview…'));
    }
  } else if (c.suggestion === 'platforms' && c.platformWaits.length) {
    const top = [...c.platformWaits].sort((a, b) => b.trains - a.trains)[0];
    const st = g.stations.get(top.station);
    advice = `${plural(top.trains, 'train')} queue${top.trains === 1 ? 's' : ''} for a free platform at ${st?.name ?? 'a station'}: give it more platforms.`;
    if (st && st.owner === PLAYER) {
      const up = memo(g, 'platfix:' + st.id, String(nv), () => expandPlan(g, st.id));
      if (up?.ok) btns.push(h('button', { class: 'btn sm primary', disabled: !g.economy.canAfford(up.cost), 'data-sfx': 'none', onclick: () => commitExpand(ui, st.id, after) }, icon('upgrade', 15), `${up.tracks} platforms at ${st.name} · ${fmtMoney(up.cost)}`));
      else if (up) advice += ` (${up.error ?? 'no room to expand'})`;
      btns.push(h('button', { class: 'btn sm', onclick: () => ui.openStation(st.id) }, 'Station…'));
    }
  } else if (c.suggestion === 'double' || c.suggestion === 'loops') {
    advice = c.suggestion === 'double' ? 'The trains wait on single track: double the stretch so they can pass each other.' : 'Single track with few trains: a passing loop or double track on the stretch where they meet helps.';
    if (mine) {
      const all = c.blockedStretches.flat();
      const key = nv + '|' + all.slice(0, 40).join(',');
      const plan = memo(g, 'dblfix:' + l.id, key, () => doubleFor(g, singleRun(g, all)));
      if (plan?.ok) btns.push(h('button', { class: 'btn sm primary', disabled: !g.economy.canAfford(plan.cost), 'data-sfx': 'none', onclick: () => {
        const current = lineCongestion(g, l.id);
        const fresh = doubleFor(g, singleRun(g, current.blockedStretches.flat()));
        if (!fresh?.ok) { ui.toast(fresh?.errors[0] ?? 'No single-track stretch to double here now', 'info'); after(); return; }
        const r = commitDoubleTrack(g, fresh, true, { rightHand: ui.tools.rightHand });
        if (r.error) { ui.toast(r.error, 'bad'); return; }
        ui.sound('build-rail');
        ui.toast(`Double track: ${fmtLen(fresh.length)} · ${plural(r.signals, 'signal')} · ${plural(r.crossovers, 'crossover')}`, 'good');
        after();
      } }, icon('parallel', 15), `Double ${fmtLen(plan.length)} · ${fmtMoney(plan.cost)}`));
      else if (plan) advice += ` (${plan.errors[0] ?? 'cannot be doubled here'}: try the Double track tool)`;
      btns.push(h('button', { class: 'btn sm', onclick: () => { ui.tools.setTool('double'); const e = g.world.net.edges.get(all[0]); if (e) { const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len / 2, p); ui.centerOn(p.x, p.z, 45); } } }, icon('parallel', 15), 'Double track tool'));
    }
  } else {
    advice = 'More trains than the track can take: take a train off the line, or add passing tracks.';
    if (showTrains) btns.push(h('button', { class: 'btn sm', onclick: showTrains }, icon('train', 15), 'Trains'));
  }
  if (c.edgeIds.length) btns.push(h('button', { class: 'btn sm ghost', 'data-tip': 'Show where the trains wait', onclick: () => {
    const e = g.world.net.edges.get(c.edgeIds[0]);
    if (!e) return;
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    ui.centerOn(p.x, p.z, 40);
    ui.renderer.overlay.setHoverEdge(c.edgeIds, 0xff5a5f);
  } }, icon('target', 15), 'Show'));
  return h('div', { class: 'alert' + (stuck ? '' : ' warn') }, icon('warning', 16),
    h('div', { class: 'alert-b' }, h('b', null, what), h('div', null, advice), btns.length ? h('div', { class: 'btns' }, btns) : null));
}

/** Station expansion as its capacity figures recommend (more platform tracks on the side with room). */
export function expandPlan(g: Game, stationId: number): UpgradePlan | null {
  const cap = stationCapacity(g, stationId);
  const st = g.stations.get(stationId);
  if (!cap || !st?.rail) return null;
  const rec = cap.recommended ?? { tracks: Math.min(8, st.rail.tracks + 2), through: st.rail.through ?? 0, length: st.rail.length };
  return planStationUpgrade(g, stationId, { tracks: rec.tracks, through: rec.through, length: rec.length, side: 'auto' });
}

export function commitExpand(ui: UI, stationId: number, after: () => void) {
  const g = ui.game;
  const st = g.stations.get(stationId);
  if (!st?.rail || st.owner !== PLAYER) { ui.toast('Choose one of your rail stations to expand', 'bad'); after(); return; }
  const up = expandPlan(g, stationId);
  if (!up?.ok) { ui.toast(up?.error ?? 'This station cannot be expanded now', 'bad'); after(); return; }
  const err = commitStationUpgrade(g, up);
  if (err === 'busy') { ui.toast('A train is in the station — try again in a moment', 'info'); return; }
  if (err) { ui.toast(err, 'bad'); return; }
  ui.sound('station', st ? { x: st.x, z: st.z } : {});
  ui.toast(`${st?.name ?? 'Station'} expanded to ${up.tracks} platform tracks`, 'good');
  after();
}

// ------------------------------------------------------------------ route: operators, track types, compatibility
export interface RouteInfo {
  /** owners of the track the line runs on: distance and share, longest first */
  owners: { owner: number; distance: number; share: number }[];
  /** track types on the route: type id -> length */
  types: Map<string, number>;
  /** standard (unelectrified) track on the route, for "electrify the line" */
  standard: number[];
  through: boolean;
}

/** Route by owner and type, cached per network / stops / vehicles and recomputed at most once a second. */
export function routeInfo(g: Game, l: Line, fresh = false): RouteInfo | null {
  if (l.kind !== 'rail' || l.stops.length < 2) return null;
  const key = `${g.networkVersion}|${g.world.net.version}|${l.owner}|${l.stops.join(',')}|${l.vehicles.join(',')}|${g.lines.isLoop(l)}`;
  return memo(g, 'route:' + l.id, key, () => {
    const owners = lineOperators(g, l.id);
    const p = computeLinePath(g, l);
    const seen = new Set<number>(), types = new Map<string, number>(), standard: number[] = [];
    const net = g.world.net;
    for (const arr of p.edges) for (const se of arr) {
      const id = Math.abs(se) - 1;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e) continue;
      types.set(e.type, (types.get(e.type) ?? 0) + e.len);
      if (e.type === 'standard') standard.push(id);
    }
    for (const sid of l.stops) for (const id of g.stations.get(sid)?.rail?.edges ?? []) { const e = net.edges.get(id); if (e?.type === 'standard' && !standard.includes(id)) standard.push(id); }
    const modes = new Set([...types.keys()].map((t) => TRACK_TYPES[t]?.mode ?? 'mainline'));
    return { owners, types, standard, through: owners.length > 1 || modes.size > 1 };
  }, fresh ? 0 : Infinity, fresh ? 0 : 1000);
}

/** Through service and route summary: who owns the track (shares), which track types it runs on. */
export function routePanel(ui: UI, l: Line): HTMLElement | null {
  const g = ui.game;
  const r = routeInfo(g, l);
  if (!r || !r.owners.length) return null;
  const total = r.owners.reduce((s, o) => s + o.distance, 0) || 1;
  const own = (o: number) => (o < 0 ? { name: 'Town', color: '#9aa5b4' } : g.company(o));
  return h('div', null,
    section(r.through ? 'Through service' : 'Route', r.owners.length > 1 ? `${r.owners.length} operators' track` : fmtLen(total)),
    h('div', { class: 'opbar', role: 'img', 'aria-label': 'Track owners along the route' }, r.owners.map((o) => h('i', { style: `flex:${Math.max(0.02, o.share)};--c:${own(o.owner).color}`, 'data-tip': `${own(o.owner).name}: ${fmtLen(o.distance)} (${fmtPct(o.share)})` }))),
    h('div', { class: 'legend' }, r.owners.map((o) => h('span', { style: `--c:${own(o.owner).color}` }, h('i'), `${own(o.owner).name} ${fmtPct(o.share)}`))),
    r.types.size ? h('div', { class: 'ttypes', style: 'margin-top:6px' }, [...r.types].sort((a, b) => b[1] - a[1]).map(([t, len]) => h('span', { class: 'ttype', style: `--c:${TYPE_META[t]?.color ?? '#9aa5b4'}` }, h('i'), `${TYPE_META[t]?.short ?? t} ${fmtLen(len)}`))) : null,
    r.through ? h('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, 'Trains run through onto other networks or track types; track use is billed by usage share (Track access).') : null);
}

/** Vehicles of the line that find no route their track types allow, with "electrify the line" where wire is missing. */
export function compatPanel(ui: UI, l: Line, after: () => void): HTMLElement | null {
  const g = ui.game;
  if (l.kind !== 'rail') return null;
  const bad = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train && v.state === 'noroute' && /compatible/i.test(v.status));
  if (!bad.length) return null;
  const wire = bad.some((t) => t.rule.wire);
  const r = routeInfo(g, l);
  const btns: HTMLElement[] = [];
  if (wire && r?.standard.length) {
    const pre = memo(g, 'elec:' + l.id, g.networkVersion + '|' + r.standard.length, () => electrify(g, r.standard, PLAYER, true));
    if (pre.changed) btns.push(h('button', { class: 'btn sm primary', disabled: !g.economy.canAfford(pre.cost), 'data-sfx': 'none', onclick: () => {
      const current = g.lines.get(l.id);
      const fresh = current ? routeInfo(g, current, true) : null;
      const res = electrify(g, fresh?.standard ?? [], PLAYER);
      if (!res.changed) { ui.toast(res.error ?? 'Nothing to electrify', 'bad'); return; }
      ui.sound('build-rail', { pitch: 1.25 });
      ui.toast(`${fmtLen(res.length)} of the line electrified${res.error ? ` — ${res.error}` : ''}`, res.error ? 'info' : 'good');
      after();
    } }, icon('bolt', 15), `Electrify the line · ${fmtLen(pre.length)} · ${fmtMoney(pre.cost)}`));
  }
  btns.push(h('button', { class: 'btn sm', onclick: () => ui.openVehicle(bad[0].id) }, icon('train', 15), bad[0].name));
  return h('div', { class: 'alert' }, icon('warning', 16), h('div', { class: 'alert-b' },
    h('b', null, `${plural(bad.length, 'train')}: no compatible route`),
    h('div', null, bad[0].status + '.'),
    h('div', { class: 'btns' }, btns)));
}

// ------------------------------------------------------------------ shared lines
/** Why the player cannot join a line as a further operator (null: can). */
export function joinBlock(g: Game, l: Line): string | null {
  if (l.owner === PLAYER || g.lines.canOperate(l, PLAYER)) return null;
  const pol = g.lines.partnerPolicy(l);
  if (pol === 'closed') return `${g.company(l.owner).name} runs it alone`;
  if (pol === 'invite') return `Invite only: ${g.company(l.owner).name} picks its partners`;
  if (!g.canUse(PLAYER, l.owner)) return `No track access to ${g.company(l.owner).name}'s network`;
  // UPDATE 9k: an operator must own at least one station of the line
  if (!l.stops.some((s) => g.stations.get(s)?.owner === PLAYER)) return 'You need a station of your own on the line';
  return null;
}

const POLICY_TEXT: Record<PartnerPolicy, string> = { open: 'Any company with a station on the line may add vehicles', invite: 'Only companies you invite', closed: 'Only you run vehicles on it' };

/** Operators of a line: lead and partners with their vehicles; policy, invitations, join / leave. */
export function sharedPanel(ui: UI, l: Line, after: () => void): HTMLElement {
  const g = ui.game;
  const mine = l.owner === PLAYER;
  const ops = g.lines.operatorsOf(l);
  const by = g.lines.vehiclesBy(l);
  const rows = ops.map((o) => h('div', { class: 'row' },
    h('span', { class: 'inline' }, ui.ownerTag(o), o === l.owner ? h('span', { class: 'flag ok' }, 'Lead') : null),
    h('span', { class: 'num' }, plural(by.get(o) ?? 0, 'vehicle')),
    mine && o !== l.owner ? h('button', { class: 'ibtn sm', 'data-tip': `Remove ${g.company(o).name} (its vehicles leave the line)`, 'aria-label': 'Remove partner', onclick: () => {
      if (!confirm(`Remove ${g.company(o).name} from ${l.name}? Its vehicles there go back to their depots.`)) return;
      g.lines.leave(l.id, o); ui.sound('toggle', { pitch: 0.88 }); after();
    } }, icon('close', 14)) : null));
  const out = h('div', null, section('Operators', ops.length > 1 ? `shared by ${ops.length}` : null), h('div', { class: 'list' }, rows));
  if (mine) {
    const pol = g.lines.partnerPolicy(l);
    add(out, h('div', { class: 'field' }, h('label', { class: 'field-l' }, 'Partners'),
      h('div', { class: 'field-c' }, seg<PartnerPolicy>([['open', 'Open', POLICY_TEXT.open], ['invite', 'Invite', POLICY_TEXT.invite], ['closed', 'Closed', POLICY_TEXT.closed]], pol, (v) => { g.lines.setPartnerPolicy(l.id, v); ui.sound('toggle'); after(); })),
      h('div', { class: 'field-h' }, POLICY_TEXT[pol])));
    const cands = g.activeCompanies.filter((c) => c.id !== PLAYER && !ops.includes(c.id));
    if (pol !== 'closed' && cands.length) {
      const sel = h('select', { class: 'select', 'aria-label': 'Invite a company' }, h('option', { value: '' }, 'Invite a company…'), cands.map((c) => h('option', { value: String(c.id) }, c.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => { if (!sel.value) return; g.lines.invite(l.id, Number(sel.value)); ui.sound('toggle', { pitch: 1.1 }); ui.toast(`${g.company(Number(sel.value)).name} may now run vehicles on ${l.name}`, 'good'); after(); });
      add(out, h('div', { class: 'btns' }, sel));
    }
  } else if (g.lines.canOperate(l, PLAYER)) {
    add(out, h('div', { class: 'btns' },
      h('button', { class: 'btn primary', onclick: () => ui.openPurchase(l.kind, null, l.id) }, icon('plus', 16), 'Add a vehicle'),
      h('button', { class: 'btn danger', onclick: () => {
        if (!confirm(`Leave ${l.name}? Your ${plural(by.get(PLAYER) ?? 0, 'vehicle')} there go back to their depots.`)) return;
        g.lines.leave(l.id, PLAYER); ui.sound('toggle', { pitch: 0.88 }); ui.toast(`You no longer run ${l.name}`, 'info'); after();
      } }, icon('leave', 16), 'Leave the line')));
  } else {
    const why = joinBlock(g, l);
    add(out, h('div', { class: 'btns' },
      h('button', { class: 'btn primary', disabled: !!why, 'data-tip': why ?? 'Run your own vehicles on this line (they earn your fares; track fees as usual)', onclick: () => {
        const err = g.lines.join(l.id, PLAYER);
        if (err) { ui.toast(err, 'bad'); return; }
        ui.sound('purchase'); ui.toast(`You joined ${l.name}: add vehicles to run it`, 'good'); after();
      } }, icon('join', 16), 'Join the line'),
      why ? h('span', { class: 'muted', style: 'font-size:12px' }, why) : null));
  }
  return out;
}

// ------------------------------------------------------------------ fares, service, decommission
/**
 * Fare of a trip from one end of the line to the other, as vehicles charge it: base by distance (rail: one model
 * for every track type, with a minimum per boarding; tram and bus: a boarding charge plus distance), speed factor
 * against walking / the car.
 */
export function faresPanel(ui: UI, l: Line): HTMLElement | null {
  const g = ui.game;
  if (l.stops.length < 2 || !l.vehicles.length) return null;
  const r = lineRoute(l);
  const a = g.stations.get(r.stations[0]);
  let b = g.stations.get(r.stations[r.stations.length - 1]);
  if (r.loop && a) { let far = 0; for (const id of r.stations) { const s = g.stations.get(id); const d = s ? Math.hypot(s.x - a.x, s.z - a.z) : 0; if (s && d > far) { far = d; b = s; } } }
  if (!a || !b || a === b) return null;
  let t = 0;
  try { t = lineTable(g, l).edges.find((e) => e.from === a.id && e.to === b!.id)?.cost ?? 0; } catch { t = 0; }
  if (!(t > 0)) return null;
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  const f = fareBreakdown(d, t, stationFareContext(g, a, b, l.kind === 'rail' ? 'rail' : l.kind === 'tram' ? 'tram' : 'bus'));
  const pats = linePatterns(l);
  let heads: { pid: number; vehicles: number; headway: number }[] = [];
  try { heads = patternHeadways(g, l); } catch { heads = []; }
  return h('div', null,
    section('Fares', `${a.name} → ${b.name}`),
    h('div', { class: 'costgrid' },
      h('span', null, 'Distance · journey'), h('span', null, `${(d / 100).toFixed(1)} km · ${minSec(t)} incl. waiting`),
      h('span', null, 'Walking / by car'), h('span', null, minSec(f.refSeconds)),
      h('span', null, 'Speed factor'), h('span', { class: f.factor >= 1 ? 'pos' : 'neg' }, `×${f.factor.toFixed(2)}`),
      h('span', null, 'Fare per passenger'), h('span', null, `${fmtMoney(f.perPassenger)} (base ${fmtMoney(f.base)})`)),
    heads.length ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, heads.map((x) => `${pats.find((p) => p.id === x.pid)?.name ?? PATTERN_LABEL.local}: every ${minSec(x.headway)} (${plural(x.vehicles, 'vehicle')})`).join(' · ')) : null,
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, `Faster and more frequent service earns more per trip; each change of vehicle takes ${Math.round((1 - TRANSFER_FARE_FACTOR) * 100)}% off the fare of the leg ending in it and of every later leg.${l.kind === 'rail' ? ` A rail journey pays at least ${fmtMoney(RAIL_FARE.minimum * FARE_LEVEL)} before the speed factor, whatever the track type, once however often its passengers change trains.` : ''}`));
}

/** Sell the player's vehicles on a line and delete it (or hand a shared line over to a partner). */
export function decommission(ui: UI, l: Line, done: () => void) {
  const g = ui.game;
  const mineV = l.vehicles.map((id) => g.vehicles.get(id)).filter((v) => !!v && v.owner === PLAYER);
  const value = mineV.reduce((s, v) => s + g.vehicles.resaleValue(v!), 0);
  const partners = g.lines.operatorsOf(l).filter((o) => o !== PLAYER && (g.lines.vehiclesBy(l).get(o) ?? 0) > 0);
  const heir = partners[0];
  const msg = `Decommission ${l.name}? ${mineV.length ? `Your ${plural(mineV.length, 'vehicle')} ${mineV.length === 1 ? 'is' : 'are'} sold for ${fmtMoney(value)}, then ` : ''}${heir !== undefined ? `${g.company(heir).name} takes the line over.` : 'the line is deleted.'} Track and stations stay.`;
  if (!confirm(msg)) return;
  for (const v of mineV) g.vehicles.sell(v!.id);
  if (heir !== undefined && l.owner === PLAYER) g.lines.transfer(l, heir);
  else if (l.owner === PLAYER) g.lines.delete(l.id);
  else g.lines.leave(l.id, PLAYER);
  g.lines.rebuild();
  ui.sound('cash');
  ui.toast(`${l.name} decommissioned${value ? ` · ${fmtMoney(value)} from vehicle sales` : ''}`, 'info');
  done();
}
