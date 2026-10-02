// Automatic signalling: what the rules would add, change or keep (shown on the map) and what it costs, then
// apply it — for a line, a stretch of track or the whole railway.
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { autoSignalLine, autoSignalNetwork, AutoSignal, AutoSignalResult } from '../game/signals';
import { h, clear, add, tile, section, icon } from './dom';
import { fmtMoney } from '../game/economy';

export type AutoTarget = { line: number } | { edges: number[]; label: string } | { network: true };

/** Marker colours of the preview: new, changed, kept signals. */
export const AUTO_COLOR: Record<AutoSignal['action'], number> = { add: 0xffb020, change: 0x4fc3ff, keep: 0x9aa5b4 };
const ROLE_LABEL: Record<AutoSignal['role'], string> = {
  block: 'block signals on open line', approach: 'path signals before junctions and station entries',
  starter: 'starter signals at platform ends', loop: 'signals at passing loops', depot: 'depot exit signals',
};
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Show a planned signalling on the map (arrows: block signals, diamonds: path signals). */
export function showAutoSignals(ui: UI, r: AutoSignalResult | null) {
  if (!r) { ui.renderer.overlay.setSignalGhosts(null); return; }
  const g = ui.game, net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  ui.renderer.overlay.setSignalGhosts(r.signals.map((s) => {
    const e = net.edges.get(s.edge);
    if (e) net.pointAt(e, Math.max(0, Math.min(e.len, s.s)), p, d);
    else { p.y = g.world.heightAt(s.x, s.z); d.x = 1; d.z = 0; }
    const f = s.forward ? 1 : -1;
    return { x: s.x, y: p.y, z: s.z, dx: d.x * f, dz: d.z * f, existing: s.action === 'keep', twoWay: s.kind === 'path', color: AUTO_COLOR[s.action] };
  }));
}

export function openAutoSignal(ui: UI, target: AutoTarget) {
  const g = ui.game;
  const label = 'line' in target ? (g.lines.get(target.line)?.name ?? 'Line') : 'edges' in target ? target.label : 'All your railway';
  const win = ui.wm.open('autosig', 'Auto-signal', { width: 430, icon: 'signal', color: 'var(--rail)', sub: label, onClose: () => showAutoSignals(ui, null) });
  let key = '';
  let res: AutoSignalResult | null = null;
  const plan = (preview: boolean): AutoSignalResult =>
    'line' in target ? autoSignalLine(g, target.line, PLAYER, { preview })
      : 'edges' in target ? autoSignalLine(g, target.edges, PLAYER, { preview })
        : autoSignalNetwork(g, PLAYER, { preview });
  const render = () => {
    const k = `${g.networkVersion}`;
    if (k !== key || !res) { key = k; res = plan(true); showAutoSignals(ui, res); }
    const r = res;
    clear(win.body);
    const n = (a: AutoSignal['action']) => r.signals.filter((s) => s.action === a).length;
    const adds = n('add'), changes = n('change'), keeps = n('keep');
    const roles = new Map<AutoSignal['role'], number>();
    for (const s of r.signals) if (s.action !== 'keep') roles.set(s.role, (roles.get(s.role) ?? 0) + 1);
    const legend = (c: number, t: string) => h('span', { style: `--c:${hex(c)}` }, h('i'), t);
    add(win.body,
      h('div', { class: 'tiles' },
        tile(String(adds), 'New', adds ? 'warn' : ''),
        tile(String(changes), 'Changed'),
        tile(String(keeps), 'Kept'),
        tile(fmtMoney(r.cost), 'Cost', g.economy.canAfford(r.cost) ? '' : 'neg')),
      h('div', { class: 'legend' }, legend(AUTO_COLOR.add, 'new'), legend(AUTO_COLOR.change, 'changed'), legend(AUTO_COLOR.keep, 'kept'), h('span', { class: 'muted' }, '▲ block · ◆ path')),
      roles.size ? section('What it does') : null,
      roles.size ? h('div', { class: 'list' }, [...roles].map(([role, c]) => h('div', { class: 'row' }, h('span', null, ROLE_LABEL[role]), h('span', { class: 'num' }, String(c))))) : null,
      r.warnings.length ? h('div', { class: 'warn' }, icon('warning', 16), h('span', null, r.warnings.slice(0, 4).join(' · '))) : null,
      !adds && !changes ? h('div', { class: 'pad muted' }, 'Everything is signalled by the rules already.') : null,
      h('div', { class: 'pad muted', style: 'padding-bottom:0' }, 'Path signals guard junctions and station entries: a train passes only when its whole way to the next signal is free. Block signals space trains on open line. Single track keeps signals only at passing loops, so opposing trains never meet head on.'),
      h('div', { class: 'btns right' },
        h('button', { class: 'btn ghost', onclick: () => win.close() }, 'Cancel'),
        h('button', { class: 'btn primary', disabled: !adds && !changes || !g.economy.canAfford(r.cost), 'data-sfx': 'none', onclick: () => {
          if (adds + changes > 20 && !confirm(`Place ${adds} signals and change ${changes} for ${fmtMoney(r.cost)}?`)) return;
          const done = plan(false);
          ui.sound('signal', { pitch: 1.1 });
          ui.toast(`Signalling: ${done.placed} placed · ${done.changed} changed${done.warnings.length ? ' — ' + done.warnings[0] : ''}`, done.warnings.length ? 'info' : 'good');
          win.close();
        } }, icon('signal', 16), adds || changes ? `Apply${r.cost ? ` for ${fmtMoney(r.cost)}` : ''}` : 'Apply')),
    );
  };
  win.refresh = render;
  render();
}
