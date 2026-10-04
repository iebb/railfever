// Service patterns of a line (line window, Services tab): one column per pattern — Local, Rapid, Express or Limited
// Express — with a stop / pass toggle per station, short-turns (a pattern's first and last stops are its termini),
// headways and the vehicles running each pattern; and the vehicle -> pattern choice used in the vehicle lists.
import type { UI } from './ui';
import type { Line } from '../game/lines';
import type { Vehicle } from '../game/vehicle';
import { PLAYER } from '../game/game';
import { h, icon, add, section } from './dom';
import {
  linePatterns, lineRoute, setPatterns, addPattern, removePattern, setVehiclePattern, suggestExpress, patternHeadways,
  vehiclesByPattern, classifyFlags, patternName, PATTERN_KINDS, PATTERN_LABEL, PatternKind, ServicePattern,
} from '../game/patterns';
import { badgeOn, badgeEl } from './lineid';

const KIND_SHORT: Record<PatternKind, string> = { local: 'Local', rapid: 'Rapid', express: 'Express', limited: 'Ltd Exp' };
const minSec = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/** Kind badge of a pattern (Local grey, Rapid orange, Express red, Limited Express purple). */
export function patBadge(kind: PatternKind, title?: string): HTMLElement {
  return h('span', { class: 'pk ' + kind, 'data-tip': title ?? PATTERN_LABEL[kind] }, KIND_SHORT[kind]);
}

/** Name for a pattern of a kind and flags: the kind, and the termini of a short-turn. */
function nameFor(ui: UI, l: Line, kind: PatternKind, flags: boolean[]): string {
  const base = patternName(ui.game, l, flags);
  const auto = PATTERN_LABEL[classifyFlags(l, flags).kind];
  return base.startsWith(auto) ? PATTERN_LABEL[kind] + base.slice(auto.length) : base;
}

/** Copies of the line's patterns (the implicit all-stops local becomes pattern 0). */
function copyPatterns(l: Line): ServicePattern[] {
  return linePatterns(l).map((p) => ({ ...p, stops: [...p.stops], ids: p.ids ? [...p.ids] : [...l.stops] }));
}

/** Per route occurrence: stop/pass/out flags. Only a symmetric out-and-back pairs its two directions. */
export function patternMatrix(l: Line): { stations: number[]; stopIndices: number[][]; cells: ('stop' | 'pass' | 'out')[][]; patterns: ServicePattern[] } {
  const ps = linePatterns(l);
  const r = lineRoute(l);
  const stations = r.stations;
  const stopIndices = stations.map((_, i) => r.turn > 0 && i > 0 && i < r.turn ? [i, l.stops.length - i] : [i]);
  const cells = stations.map(() => ps.map(() => 'pass' as 'stop' | 'pass' | 'out'));
  ps.forEach((p, j) => {
    let lo = Infinity, hi = -Infinity;
    stopIndices.forEach((indices, k) => {
      if (indices.some((i) => p.stops[i] !== false)) { lo = Math.min(lo, k); hi = Math.max(hi, k); cells[k][j] = 'stop'; }
    });
    if (!r.loop) stations.forEach((_, k) => { if ((k < lo || k > hi) && cells[k][j] !== 'stop') cells[k][j] = 'out'; });
  });
  return { stations, stopIndices, cells, patterns: ps };
}

/** Services tab: the pattern matrix (editable on own lines), headways and vehicles per pattern, adding patterns. */
export function servicesTab(ui: UI, l: Line, body: HTMLElement, after: () => void) {
  const g = ui.game;
  const mine = l.owner === PLAYER;
  if (l.stops.length < 2) { add(body, h('div', { class: 'pad' }, 'A line needs two stops before it can run several services.')); return; }
  const { stations, stopIndices, cells, patterns } = patternMatrix(l);
  let heads: { pid: number; vehicles: number; headway: number }[] = [];
  try { heads = patternHeadways(g, l); } catch { heads = []; }
  const byPat = vehiclesByPattern(g, l);
  // mail-only vehicles (vehiclesByPattern counts passenger vehicles by default) run apart: their own count and
  // spacing, the pattern's cycle in the mail table over the mail-only vehicles (patterns.ts spacingSchedule)
  const mailOnly = new Map<number, number>();
  for (const [pid, vs] of vehiclesByPattern(g, l, 'mail')) { const n = vs.filter((v) => v.mailOnly).length; if (n) mailOnly.set(pid, n); }
  let mailHeads: { pid: number; cycle: number }[] = [];
  if (mailOnly.size) try { mailHeads = patternHeadways(g, l, 'mail'); } catch { mailHeads = []; }
  const apply = (list: ServicePattern[]) => { const err = setPatterns(g, l.id, list); if (err) ui.toast(err, 'bad'); else ui.sound('toggle', { pitch: 1.05 }); after(); };
  const toggle = (j: number, row: number) => {
    const list = copyPatterns(l);
    const p = list[j];
    const indices = patternMatrix(l).stopIndices[row];
    if (!p || !indices) return;
    const on = indices.some((i) => p.stops[i] !== false);
    const flags = l.stops.map((_, i) => (indices.includes(i) ? !on : p.stops[i] !== false));
    if (new Set(l.stops.filter((_, i) => flags[i])).size < 2) { ui.toast('A service stops at two stations at least', 'info'); return; }
    p.stops = flags;
    p.ids = [...l.stops];
    p.name = nameFor(ui, l, p.kind, flags);
    apply(list);
  };
  const setKind = (j: number, kind: PatternKind) => {
    const list = copyPatterns(l);
    list[j].kind = kind;
    list[j].name = nameFor(ui, l, kind, list[j].stops);
    apply(list);
  };
  // header: kind (own lines: click to change), headway / vehicles, remove
  const head = h('tr', null, h('th', { class: 'st' }, 'Station'), patterns.map((p, j) => {
    const hw = heads.find((x) => x.pid === p.id);
    const n = byPat.get(p.id)?.length ?? 0;
    const mo = mailOnly.get(p.id) ?? 0, mc = mailHeads.find((x) => x.pid === p.id)?.cycle ?? 0;
    const next = PATTERN_KINDS[(PATTERN_KINDS.indexOf(p.kind) + 1) % PATTERN_KINDS.length];
    const kindCtl = mine
      ? h('button', { class: 'pk ' + p.kind, 'data-tip': `${p.name} — click for ${PATTERN_LABEL[next]}`, 'aria-label': `${p.name}: change kind`, onclick: () => setKind(j, next) }, KIND_SHORT[p.kind])
      : patBadge(p.kind, p.name);
    return h('th', null, h('span', { class: 'svh ' + p.kind }, kindCtl,
      h('small', { 'data-tip': p.name }, n ? `${n} · ${hw ? minSec(hw.headway) : '—'}` : mo ? null : 'no vehicles'),
      mo ? h('small', { class: 'svh-mail', 'data-tip': `${mo} mail-only vehicle${mo > 1 ? 's' : ''}${mc > 0 ? `, every ${minSec(mc / mo)}` : ''}` }, icon('mail', 11), `${mo} · ${mc > 0 ? minSec(mc / mo) : '—'}`) : null,
      mine && patterns.length > 1 ? h('button', { class: 'ibtn sm', style: 'width:22px;height:20px', 'data-tip': `Remove ${p.name} (its vehicles run ${patterns[j === 0 ? 1 : 0].name})`, 'aria-label': 'Remove service', onclick: () => { const err = removePattern(g, l.id, p.id); if (err) ui.toast(err, 'bad'); else ui.sound('demolish', { pitch: 1.4 }); after(); } }, icon('close', 12)) : null));
  }));
  const rows = stations.map((sid, k) => {
    const st = g.stations.get(sid);
    const b = badgeOn(g, l.id, sid);
    return h('tr', { 'data-stop-index': stopIndices[k][0] },
      h('td', { class: 'st' }, b ? badgeEl(b, 'sm') : null, h('a', { class: 'link', onclick: () => ui.openStation(sid) }, st?.name ?? '?')),
      patterns.map((p, j) => {
        const c = cells[k][j];
        const tip = c === 'stop' ? `${p.name} stops at ${st?.name}` : c === 'out' ? `${p.name} turns before ${st?.name}` : `${p.name} passes ${st?.name}`;
        return h('td', null, h('button', { class: `svb ${p.kind}${c === 'stop' ? '' : ' ' + c}`, disabled: !mine, 'data-tip': mine ? tip + ' — click to change' : tip, 'aria-label': tip, 'data-sfx': 'none', onclick: () => toggle(j, k) }, h('i')));
      }));
  });
  add(body,
    section('Services', `${patterns.length} pattern${patterns.length === 1 ? '' : 's'}`),
    h('div', { class: 'svc-wrap' }, h('table', { class: 'svc' }, h('thead', null, head), h('tbody', null, rows))),
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, mine
      ? 'Click a dot: stop ● or pass │. A service that leaves out the stops at an end turns short there. Fast services pass on through tracks where stations have them, else slowly on a platform track.'
      : '● stops · │ passes · faint: beyond the service’s terminus'));
  if (mine) {
    const sug = suggestExpress(g, l);
    add(body, h('div', { class: 'btns' },
      h('button', { class: 'btn', disabled: !sug, 'data-tip': sug ? 'Stops at the termini, interchanges and the busier stations' : 'Nothing worth skipping (four stations or more, some of them small)', onclick: () => {
        const current = g.lines.get(l.id);
        const fresh = current ? suggestExpress(g, current) : null;
        if (!current || !fresh) { ui.toast('No express service to add now', 'info'); after(); return; }
        const p = addPattern(g, current.id, fresh.kind, fresh.stops, nameFor(ui, current, fresh.kind, fresh.stops));
        if (p) { ui.sound('toggle', { pitch: 1.15 }); ui.toast(`${p.name} added — assign vehicles to it in the Vehicles tab`, 'good'); }
        after();
      } }, icon('services', 16), sug ? `Add ${PATTERN_LABEL[sug.kind]}` : 'Add express'),
      h('button', { class: 'btn', 'data-tip': 'An all-stops service to edit: leave out end stations for a short-turn', onclick: () => {
        const flags = l.stops.map(() => true);
        const p = addPattern(g, l.id, 'local', flags, nameFor(ui, l, 'local', flags));
        if (p) ui.sound('toggle');
        after();
      } }, icon('plus', 16), 'Add service')));
  }
  // vehicles by pattern (assignment)
  if (patterns.length > 1 && l.vehicles.length) {
    add(body, section('Vehicles per service'), h('div', { class: 'list' }, l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Vehicle => !!v).map((v) =>
      h('div', { class: 'row' }, h('span', { class: 'inline' }, v.name, v.mailOnly ? h('span', { class: 'muted', 'data-tip': 'Mail only' }, icon('mail', 12)) : null, v.owner !== PLAYER ? h('span', { class: 'muted' }, ` · ${g.company(v.owner).name}`) : null), patternSelect(ui, l, v, after)))));
  }
}

/** Which service a vehicle runs (own vehicles: a select; others: the badge). Null when the line has one pattern. */
export function patternSelect(ui: UI, l: Line, v: Vehicle, after: () => void): HTMLElement | null {
  const ps = linePatterns(l);
  if (ps.length < 2) return null;
  const cur = ps.find((p) => p.id === v.pattern) ?? ps[0];
  if (v.owner !== PLAYER) return patBadge(cur.kind, cur.name);
  const sel = h('select', { class: 'select', style: 'height:28px;max-width:170px', 'aria-label': `Service of ${v.name}` }, ps.map((p) => h('option', { value: String(p.id), selected: p.id === cur.id }, p.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    const err = setVehiclePattern(ui.game, v.id, Number(sel.value));
    if (err) ui.toast(err, 'bad'); else ui.sound('toggle');
    after();
  });
  return h('span', { class: 'inline' }, patBadge(cur.kind, cur.name), sel);
}

/** Per stop: dots of the patterns stopping there (stop list). */
export function stopDots(l: Line, stopIndex: number): HTMLElement | null {
  const ps = linePatterns(l);
  if (ps.length < 2) return null;
  return h('span', { class: 'pdots', 'aria-hidden': 'true' }, ps.map((p) => h('i', { class: p.kind + (p.stops[stopIndex] === false ? ' pass' : ''), 'data-tip': `${p.name}: ${p.stops[stopIndex] === false ? 'passes' : 'stops'}` })));
}
