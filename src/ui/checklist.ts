// First-run "Getting started" checklist: ticks itself from the game state; dismissible, remembered.
import type { UI } from './ui';
import type { ToolId } from './tools';
import { PLAYER } from '../game/game';
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

  private steps(): Step[] {
    return [
      { id: 'stations', title: 'Build two train stations', hint: 'Place them in or near two towns.', action: this.tool('station', 'Station tool') },
      { id: 'track', title: 'Connect them with track', hint: 'Build from a platform end to the other station.', action: this.tool('rail', 'Track tool') },
      { id: 'depot', title: 'Add a train depot', hint: 'Place it at a free end of your track.', action: this.tool('depot-rail', 'Depot tool') },
      { id: 'train', title: 'Buy a train', hint: 'Click your depot to open the train composer.' },
      { id: 'line', title: 'Create a rail line', hint: 'Lines → New rail line, then click both stations.', action: ['Open lines', () => this.ui.openLines()] },
      { id: 'delivery', title: 'Deliver the first passengers', hint: 'Assign the train to the line and let it run.' },
    ];
  }

  /** Evaluate the steps from the game state. */
  private evaluate() {
    const g = this.ui.game;
    const st = g.stations.all().filter((s) => s.owner === PLAYER && s.rail);
    if (st.length >= 2) this.done.add('stations');
    if (st.length >= 2 && !this.done.has('track') && this.connected(st.map((s) => s.rail!.edges))) this.done.add('track');
    if (g.depots.all().some((d) => d.owner === PLAYER && d.kind === 'rail')) this.done.add('depot');
    if (g.vehicles.trains().some((t) => t.owner === PLAYER)) this.done.add('train');
    if (g.lines.all().some((l) => l.owner === PLAYER && l.kind === 'rail' && l.stops.length >= 2)) this.done.add('line');
    if (g.firstArrival.size > 0 || g.vehicles.ofOwner(PLAYER).some((v) => v.delivered > 0)) this.done.add('delivery');
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
    this.evaluate();
    const steps = this.steps();
    const n = steps.filter((s) => this.done.has(s.id)).length;
    if (n === steps.length && !this.finishedAt) this.finishedAt = performance.now();
    if (this.finishedAt && performance.now() - this.finishedAt > 8000) { this.state.hidden = true; this.save(); this.el.style.display = 'none'; return; }
    const sig = [...this.done].join(',') + '|' + this.collapsed;
    if (sig === this.sig) return;
    const fresh = this.sig !== '';
    this.sig = sig;
    if (fresh && n > 0) this.ui.sound('notify');
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
        h('span', { class: 'cl-title' }, all ? 'All set — enjoy!' : 'Getting started'),
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
