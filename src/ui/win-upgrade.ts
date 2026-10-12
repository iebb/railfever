// Route upgrade planner (a bus or coach line to trams, light rail, a metro or a railway): the new line previewed on the
// map with its stations and price, then started as staged works (route-works.ts); the line window shows their progress.
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { h, clear, add, tile, icon, seg, field, bar } from './dom';
import { fmtMoney } from '../game/economy';
import { MODEL_BY_ID } from '../game/vehicle-types';
import { planRouteUpgrade, startRouteWorks, cancelRouteWorks, upgradeModes, worksOn, worksStatus, type UpgradeMode, type UpgradeLevel, type UpgradeQuote } from '../game/route-works';

const MODE_LABEL: Record<UpgradeMode, string> = { tram: 'Tram', lightrail: 'Light rail', metro: 'Metro', rail: 'Rail' };
const MODE_TIP: Record<UpgradeMode, string> = {
  tram: 'Tracks in its streets; same stops', lightrail: 'Stations at its stops; ground or viaduct',
  metro: 'Underground stations at its stops', rail: 'A station per town; single track',
};
const PREVIEW = 'upgrade';

/** The new line on the map: trams in the streets they take, a railway station to station with a ring at each station. */
function showPreview(ui: UI, q: UpgradeQuote | null) {
  const ov = ui.renderer.overlay, net = ui.game.world.net;
  if (!q?.ok || q.path.length < 2) { ov.setSegments(PREVIEW, null); ov.setRings(null); return; }
  const segs: { x0: number; z0: number; x1: number; z1: number }[] = [];
  if (q.mode === 'tram') for (const id of q.edges ?? []) {
    const e = net.edges.get(id);
    if (!e) continue;
    const n = Math.max(1, Math.ceil(e.len / 2)), a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) { net.pointAt(e, e.len * i / n, a); net.pointAt(e, e.len * (i + 1) / n, b); segs.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z }); }
  } else segs.push(...q.path.slice(1).map((p, i) => ({ x0: q.path[i].x, z0: q.path[i].z, x1: p.x, z1: p.z })));
  ov.setSegments(PREVIEW, segs, q.mode === 'tram' ? 0x7bd88f : q.mode === 'metro' ? 0xb38cff : 0x4fc3ff, { dash: q.mode === 'metro' ? 1 : 0 });
  ov.setRings(q.mode === 'tram' ? null : q.path.map((p) => ({ x: p.x, z: p.z, r: 3 })), 0xffffff);
}

export function openRouteUpgrade(ui: UI, lineId: number, done?: () => void) {
  const g = ui.game, l0 = g.lines.get(lineId);
  if (!l0 || l0.owner !== PLAYER) return;
  const modes = upgradeModes(g, lineId);
  let mode: UpgradeMode = modes.includes('lightrail') ? 'tram' : modes[modes.length - 1];
  let level: UpgradeLevel = 'elevated';
  let quote: UpgradeQuote | null = null, key = '';
  const win = ui.wm.open('upgrade-' + lineId, 'Upgrade route', { width: 420, icon: 'upgrade', color: l0.color, sub: l0.name, onClose: () => showPreview(ui, null) });
  const plan = () => {
    const k = `${mode}:${level}`;
    if (k === key && quote) return quote;
    key = k;
    quote = planRouteUpgrade(g, lineId, PLAYER, mode, mode === 'lightrail' ? level : undefined);
    showPreview(ui, quote);
    return quote;
  };
  const render = () => {
    const l = g.lines.get(lineId);
    if (!l || l.id !== lineId || l.kind !== 'road' || worksOn(g, lineId)) { win.close(); return; }
    clear(win.body);
    add(win.body, field('Mode', seg<UpgradeMode>(modes.map((m) => [m, MODE_LABEL[m], MODE_TIP[m]]), mode, (m) => { mode = m; render(); })));
    if (mode === 'lightrail') add(win.body, field('Level', seg<UpgradeLevel>([['elevated', 'Viaduct'], ['ground', 'Ground']], level, (v) => { level = v; render(); })));
    const q = plan();
    if (!q.ok) {
      add(win.body, h('div', { class: 'alert warn', role: 'alert' }, icon('warning', 16), h('div', { class: 'alert-b' }, q.error ?? 'Not possible')));
      add(win.body, h('div', { class: 'btns right' }, h('button', { class: 'btn ghost', onclick: () => win.close() }, 'Close')));
      return;
    }
    const model = MODEL_BY_ID.get(q.cars[0]);
    const stations = q.mode === 'tram' ? new Set(l.stops).size : q.sites?.length ?? 0;
    const km = q.trackLength * 10 >= 1000 ? `${(q.trackLength / 100).toFixed(1)} km` : `${Math.round(q.trackLength * 10)} m`;
    const short = q.cost - g.economy.money;
    add(win.body,
      h('div', { class: 'tiles' },
        tile(String(stations), q.mode === 'tram' ? 'Stops' : 'Stations'),
        tile(km, 'New track'),
        tile(`${q.vehicles}×`, model ? model.name : 'Vehicles'),
        tile(`${q.days} d`, 'Works')),
      ui.kv(q.mode === 'tram' ? 'Tracks' : 'Track', fmtMoney(q.track)),
      q.stations ? ui.kv('Stations', fmtMoney(q.stations)) : null,
      q.depot ? ui.kv('Depot', fmtMoney(q.depot)) : null,
      ui.kv('Vehicles', fmtMoney(q.fleet)),
      q.resale ? ui.kv('Buses sold', h('span', { class: 'pos' }, '+' + fmtMoney(q.resale))) : null,
      ui.kv('Total', h('b', { class: short > 0 ? 'neg' : '' }, fmtMoney(q.cost))),
      h('div', { class: 'pad muted', style: 'padding-bottom:0' }, 'Buses run until the switch. Paid as built.'),
      h('div', { class: 'btns right' },
        h('button', { class: 'btn ghost', onclick: () => win.close() }, 'Cancel'),
        h('button', { class: 'btn primary', 'data-tip': short > 0 ? `Short ${fmtMoney(short)}: works wait for funds` : undefined, onclick: () => {
          const err = startRouteWorks(g, q);
          if (err) { ui.toast(err, 'bad'); return; }
          ui.sound('cash');
          ui.toast(`${l.name}: works started`, 'good');
          win.close();
          done?.();
        } }, icon('upgrade', 16), 'Start works')));
  };
  win.refresh = render;
  render();
}

/** The works on a line in its window: what they are at, a progress bar, cancel before the switch. */
export function worksPanel(ui: UI, lineId: number, rerender: () => void): HTMLElement | null {
  const g = ui.game, w = worksOn(g, lineId);
  if (!w) return null;
  const s = worksStatus(w), mine = w.owner === PLAYER;
  return h('div', { class: 'alert info' }, icon('upgrade', 16), h('div', { class: 'alert-b' },
    h('b', null, `To ${MODE_LABEL[w.mode].toLowerCase()}`), ' · ', s.label,
    w.stage === 'build' ? bar(s.share, 'var(--accent)') : null,
    mine && w.stage !== 'remove' ? h('div', { class: 'btns' }, h('button', { class: 'btn sm', 'data-tip': 'Built parts removed, refunded', onclick: () => {
      if (!confirm('Cancel the works? Built parts are removed and refunded.')) return;
      const err = cancelRouteWorks(g, w.id, PLAYER);
      if (err) ui.toast(err, 'bad'); else ui.toast('Works cancelled', 'info');
      rerender();
    } }, 'Cancel works')) : null));
}
