// First-run "Getting started" checklist: ticks itself from the game state; dismissible, remembered.
import type { UI } from './ui';
import type { ToolId } from './tools';
import { PLAYER } from '../game/game';
import { fmtMoney } from '../game/economy';
import { TRACK_TYPES } from '../game/constants';
import { DEFAULT_PLATFORM_LENGTH, stationLayout } from '../game/stations';
import { availableModels } from '../game/vehicle-types';
import { patternOf } from '../game/patterns';
import { h, icon } from './dom';

const KEY = 'railfever.checklist';

interface Step { id: string; title: string; hint: string; action?: [string, () => void] }

export class Checklist {
  el: HTMLDivElement;
  private state = { hidden: false, collapsed: false };
  /** collapsed to its header while a map view card is open (until the player expands it) */
  private auto = false;
  private done = new Set<string>();
  private timer = 0;
  private sig = '';
  private finishedAt = 0;
  private stage = 0;
  private stationEstimate: number | null = null;

  constructor(private ui: UI) {
    this.el = h('div', { class: 'checklist glass', role: 'region', 'aria-label': 'Getting started' });
    this.el.style.display = 'none';
    ui.root.appendChild(this.el);
    try { Object.assign(this.state, JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { /* ignore */ }
  }

  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* ignore */ } }

  setGame() {
    this.done.clear();
    this.sig = '';
    this.timer = 0;
    this.finishedAt = 0;
    this.stage = 0;
    this.stationEstimate = null;
    this.el.style.display = this.state.hidden ? 'none' : '';
  }

  get hidden() { return this.state.hidden; }

  /** Collapse to the header while a map view card is open (restored when it closes). */
  setAutoCollapse(on: boolean) {
    if (on === this.auto) return;
    this.auto = on;
    this.sig = ''; this.timer = 0;
  }
  private get collapsed() { return this.state.collapsed || this.auto; }

  /** Show it again (e.g. from the settings). */
  reopen() { this.state.hidden = false; this.state.collapsed = false; this.save(); this.setGame(); }

  dismiss() { this.state.hidden = true; this.save(); this.el.style.display = 'none'; }

  private tool(t: ToolId, label: string): [string, () => void] { return [label, () => this.ui.tools.setTool(t)]; }

  financesSeen() { this.done.add('budget'); this.done.add('finances'); this.sig = ''; this.timer = 0; }

  /** Sample real roadside halt plans once per game; no duplicated station-price formula. */
  private budget(): string {
    const g = this.ui.game, net = g.world.net;
    if (this.stationEstimate == null) {
      let cheapest = Infinity;
      const p = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };
      for (const town of g.towns.list.slice(0, 4)) {
        const roads = net.edgesNear(town.x - 24, town.z - 24, town.x + 24, town.z + 24).filter((e) => e.kind === 'road' && e.len >= DEFAULT_PLATFORM_LENGTH).slice(0, 6);
        for (const e of roads) {
          net.pointAt(e, e.len / 2, p, dir);
          const angle = Math.atan2(dir.x, dir.z);
          const offset = net.halfWidth(e) + stationLayout(1, 0, 'middle').width / 2 + 1.5;
          for (const side of [-1, 1]) {
            const plan = g.stations.planRail(p.x + Math.cos(angle) * offset * side, p.z - Math.sin(angle) * offset * side,
              angle, DEFAULT_PLATFORM_LENGTH, 1, PLAYER, { level: 'ground', trackType: 'standard', style: 'shelter' });
            if (plan.ok && plan.roadAccess && !plan.join) cheapest = Math.min(cheapest, plan.cost);
          }
        }
      }
      this.stationEstimate = cheapest;
    }
    const locos = availableModels(g.year, 'loco'), coaches = availableModels(g.year, 'wagon', false);
    const train = (locos[locos.length - 1]?.cost ?? 0) + 2 * (coaches[coaches.length - 1]?.cost ?? 0);
    const station = isFinite(this.stationEstimate) ? `an ${DEFAULT_PLATFORM_LENGTH * 10} m halt here ~${fmtMoney(this.stationEstimate)}` : 'check each halt’s preview price';
    return `Keep money for a train: ${station}, single track ~${fmtMoney(TRACK_TYPES.standard.costPerUnit * 100)}/km, a starter train ~${fmtMoney(train)}. Bridges and demolition add cost.`;
  }

  private steps(): Step[] {
    if (this.stage === 1) return [
      { id: 'second-train', title: 'Add a second train safely', hint: 'Give trains a passing loop on single track, or add signals to double track. Then add a train to the same line.', action: ['Open lines', () => this.ui.openLines()] },
      { id: 'bus-line', title: 'Run a bus line in a town', hint: 'Place two bus stops and a bus depot beside roads, create a bus line, then buy a bus.', action: this.tool('busstop', 'Bus stop tool') },
      { id: 'finances', title: 'Check your Finances', hint: 'Compare income, running costs and interest. Borrow or repay in affordable steps.', action: ['Open finances', () => this.ui.openFinances()] },
      { id: 'express', title: 'Try an express service', hint: 'Extend a rail line to 3+ stations. In Services, add an Express that skips a stop and assign a train.', action: ['Open lines', () => this.ui.openLines()] },
    ];
    return [
      { id: 'budget', title: 'Keep money for a train', hint: this.budget(), action: ['Budget noted', () => { this.done.add('budget'); this.sig = ''; this.timer = 0; }] },
      { id: 'stations', title: 'Build two train stations', hint: 'Start with one-platform halts near two towns; keep the streets and houses where possible.', action: this.tool('station', 'Station tool') },
      { id: 'track', title: 'Connect them with track', hint: 'Start with single track, from a platform end to the other station. Check the cost before building.', action: this.tool('rail', 'Track tool') },
      { id: 'depot', title: 'Add a train depot', hint: 'Place it at a free end of your track.', action: this.tool('depot-rail', 'Depot tool') },
      { id: 'line', title: 'Create a rail line', hint: 'Lines → Rail line, then click both stations.', action: ['Open lines', () => this.ui.openLines()] },
      { id: 'train', title: 'Buy a train for the line', hint: 'Use Add train in the line window, or click your depot. Check the selected line before buying.' },
      { id: 'delivery', title: 'Deliver the first passengers', hint: 'Assign the train to the line and let it run.' },
    ];
  }

  /** Evaluate the steps from the game state. */
  private evaluate() {
    const g = this.ui.game;
    const st = g.stations.all().filter((s) => s.owner === PLAYER && s.rail);
    if (st.length) this.done.add('budget');
    if (st.length >= 2) this.done.add('stations');
    if (st.length >= 2 && !this.done.has('track') && this.connected(st.map((s) => s.rail!.edges))) this.done.add('track');
    if (g.depots.all().some((d) => d.owner === PLAYER && d.kind === 'rail')) this.done.add('depot');
    if (g.vehicles.trains().some((t) => t.owner === PLAYER)) this.done.add('train');
    if (g.lines.all().some((l) => l.owner === PLAYER && l.kind === 'rail' && l.stops.length >= 2)) this.done.add('line');
    if (st.some((s) => g.firstArrival.has(s.id)) || g.vehicles.ofOwner(PLAYER).some((v) => v.delivered > 0)) this.done.add('delivery');
    const railLines = g.lines.all().filter((l) => l.owner === PLAYER && l.kind === 'rail');
    if (railLines.some((l) => l.vehicles.filter((id) => { const v = g.vehicles.get(id); return v?.owner === PLAYER && v.kind === 'train'; }).length >= 2 && this.passingRoom(l.stops[0]))) this.done.add('second-train');
    if (g.lines.all().some((l) => l.owner === PLAYER && l.kind === 'road' && l.stops.length >= 2 && l.vehicles.some((id) => g.vehicles.get(id)?.owner === PLAYER))) this.done.add('bus-line');
    if (railLines.some((l) => new Set(l.stops).size >= 3 && l.patterns?.some((p) => (p.kind === 'express' || p.kind === 'limited') && p.stops.filter(Boolean).length >= 2 && p.stops.some((stop) => !stop) &&
      l.vehicles.some((id) => { const v = g.vehicles.get(id); return v?.owner === PLAYER && patternOf(l, v.pattern)?.id === p.id; })))) this.done.add('express');
  }

  /** Signals or a cycle (passing loop / double track) in this line's rail component. */
  private passingRoom(stationId: number): boolean {
    const g = this.ui.game, net = g.world.net;
    const edge = net.edges.get(g.stations.get(stationId)?.rail?.edges[0] ?? -1);
    if (!edge) return false;
    const nodes = new Set<number>(), edges = new Set<number>(), queue = [edge.a];
    while (queue.length) {
      const id = queue.pop()!;
      if (nodes.has(id)) continue;
      nodes.add(id);
      const node = net.nodes.get(id);
      if (node?.owner === PLAYER && node.signal > 0) return true;
      for (const eid of node?.edges ?? []) {
        const e = net.edges.get(eid);
        if (e?.kind !== 'rail' || e.owner !== PLAYER || edges.has(eid)) continue;
        edges.add(eid); queue.push(e.a === id ? e.b : e.a);
      }
    }
    return edges.size >= nodes.size;
  }

  /** Are at least two stations joined by the player's track (union-find over rail edges)? */
  private connected(platforms: number[][]): boolean {
    const net = this.ui.game.world.net;
    const parent = new Map<number, number>();
    const find = (a: number): number => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const e of net.edges.values()) if (e.kind === 'rail' && e.owner === PLAYER) union(e.a, e.b);
    const roots = new Set<number>();
    for (const edges of platforms) {
      const e = edges.map((id) => net.edges.get(id)).find(Boolean);
      if (!e) continue;
      const r = find(e.a);
      if (roots.has(r)) return true;
      roots.add(r);
    }
    return false;
  }

  update(dt: number) {
    if (this.state.hidden || !this.ui.game || this.ui.titleOpen) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1.2;
    const previousDone = this.done.size;
    this.evaluate();
    let steps = this.steps();
    if (this.stage === 0 && steps.every((s) => this.done.has(s.id))) { this.stage = 1; steps = this.steps(); }
    const n = steps.filter((s) => this.done.has(s.id)).length;
    if (n === steps.length && !this.finishedAt) this.finishedAt = performance.now();
    if (this.finishedAt && performance.now() - this.finishedAt > 8000) { this.state.hidden = true; this.save(); this.el.style.display = 'none'; return; }
    const sig = this.stage + '|' + [...this.done].join(',') + '|' + this.collapsed;
    if (sig === this.sig) return;
    const fresh = this.sig !== '';
    this.sig = sig;
    if (fresh && this.done.size > previousDone) this.ui.sound('notify');
    this.render(steps, n);
  }

  private render(steps: Step[], n: number) {
    const el = this.el;
    const all = n === steps.length;
    const collapsed = this.collapsed;
    el.classList.toggle('collapsed', collapsed);
    el.classList.toggle('done', all);
    const cur = steps.find((s) => !this.done.has(s.id));
    el.replaceChildren(
      h('div', { class: 'cl-head' },
        icon(all ? 'check' : 'checklist', 18),
        h('span', { class: 'cl-title' }, all ? 'All set — enjoy!' : this.stage === 1 ? 'Keep growing' : 'Getting started'),
        h('span', { class: 'cl-prog' }, `${n}/${steps.length}`),
        h('button', { class: 'ibtn sm', 'data-tip': collapsed ? 'Expand' : 'Collapse', 'aria-label': collapsed ? 'Expand' : 'Collapse', onclick: () => {
          if (collapsed) { this.state.collapsed = false; this.auto = false; } else this.state.collapsed = true;
          this.save(); this.timer = 0; this.sig = '';
        } }, icon(collapsed ? 'chevr' : 'chevd', 16)),
        h('button', { class: 'ibtn sm', 'data-tip': 'Dismiss', 'aria-label': 'Dismiss checklist', onclick: () => this.dismiss() }, icon('close', 16))),
      h('div', { class: 'cl-bar' }, h('i', { style: `width:${Math.round((n / steps.length) * 100)}%` })),
      h('div', { class: 'cl-steps' }, steps.map((s) => {
        const done = this.done.has(s.id), isCur = s === cur;
        return h('div', { class: 'cl-step' + (done ? ' done' : '') + (isCur ? ' cur' : '') },
          icon(done ? 'check' : 'circle', 18),
          h('div', { class: 'cl-t' }, s.title),
          isCur ? h('div', { class: 'cl-h' }, s.hint) : null,
          isCur && s.action ? h('button', { class: 'btn sm', onclick: s.action[1] }, s.action[0]) : null);
      })),
    );
  }
}
