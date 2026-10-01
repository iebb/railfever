// Company windows: player finances and the competitors overview with history charts.
import type { UI } from './ui';
import { MONTH_NAMES, PLAYER } from '../game/game';
import { h, clear, tile, section, icon, toggle, add } from './dom';
import { fmtMoney, CATEGORIES, CATEGORY_LABEL, Economy, MonthRecord } from '../game/economy';
import { chart } from './charts';

const monthSum = (m: MonthRecord) => CATEGORIES.reduce((a, k) => a + m.v[k], 0);

/** Resale value of a company's vehicles. */
function vehicleValue(ui: UI, owner: number) {
  const g = ui.game;
  let s = 0;
  for (const v of g.vehicles.map.values()) if (v.owner === owner) s += g.vehicles.resaleValue(v);
  return s;
}

function monthLabels(e: Economy, n: number) { return e.months.slice(-n).map((m) => MONTH_NAMES[m.month]); }

export function openFinances(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('finances', 'Finances', { width: 580, icon: 'money', color: 'var(--pos)', sub: g.player.name });
  const render = () => {
    const e = g.economy;
    ui.wm.setTabs(win, [['overview', 'Overview'], ['history', 'History']], render);
    clear(win.body);
    const net = e.netWorth + vehicleValue(ui, PLAYER);
    add(win.body, h('div', { class: 'tiles' },
      tile(fmtMoney(e.money), 'Cash', e.money < 0 ? 'neg' : ''),
      tile(fmtMoney(e.loan), 'Loan'),
      tile(fmtMoney(net), 'Net worth', net < 0 ? 'neg' : ''),
      tile(fmtMoney(g.maintenanceOf(PLAYER)), 'Upkeep / yr')));
    if (win.tab === 'overview') {
      add(win.body, h('div', { class: 'btns', style: 'margin-top:0' },
        h('button', { class: 'btn', onclick: () => { if (!e.borrow()) ui.toast('Maximum loan reached', 'bad'); win.last = undefined; render(); } }, icon('plus', 16), `Borrow ${fmtMoney(e.loanStep)}`),
        h('button', { class: 'btn', onclick: () => { if (!e.repay()) ui.toast('Cannot repay', 'bad'); win.last = undefined; render(); } }, icon('minus', 16), `Repay ${fmtMoney(e.loanStep)}`),
        h('span', { class: 'muted' }, `max ${fmtMoney(e.maxLoan)} · ${(e.interestRate * 100).toFixed(1)}% interest`)));
      const months = e.months.slice(-3);
      const cols: { label: string; v: Record<string, number> }[] = [
        ...months.map((m) => ({ label: `${MONTH_NAMES[m.month]} ${m.year}`, v: m.v as Record<string, number> })),
        { label: 'This month', v: e.current },
        { label: `${g.year}`, v: e.thisYear },
      ];
      const ly = e.yearTotals[e.yearTotals.length - 1];
      if (ly) cols.push({ label: String(ly.year), v: ly.v });
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, ''), cols.map((c) => h('th', null, c.label))));
      for (const cat of CATEGORIES) tbl.appendChild(h('tr', null, h('td', null, CATEGORY_LABEL[cat]), cols.map((c) => h('td', { class: c.v[cat] < 0 ? 'neg' : c.v[cat] > 0 ? 'pos' : 'muted' }, c.v[cat] ? fmtMoney(c.v[cat]) : '–'))));
      tbl.appendChild(h('tr', { class: 'total' }, h('td', null, 'Profit'), cols.map((c) => { const s = CATEGORIES.reduce((a, k) => a + c.v[k], 0); return h('td', { class: s < 0 ? 'neg' : 'pos' }, fmtMoney(s)); })));
      add(win.body, section('Income & expenses'), tbl);
    } else {
      const ms = e.months.slice(-24);
      add(win.body, section('Monthly profit & income', `${ms.length} months`));
      if (!ms.length) add(win.body, h('div', { class: 'pad' }, 'The chart fills up month by month.'));
      else {
        add(win.body, chart([
          { values: ms.map(monthSum), color: '#4ade80', kind: 'bar', label: 'Profit' },
          { values: ms.map((m) => m.v.income), color: '#8fc3ff', label: 'Income' },
          { values: ms.map((m) => m.v.running + m.v.maintenance), color: '#ffc857', label: 'Running & upkeep' },
        ], { w: 548, h: 170, labels: monthLabels(e, 24) }),
        h('div', { class: 'legend' }, h('span', { style: '--c:#4ade80' }, h('i'), 'Profit'), h('span', { style: '--c:#8fc3ff' }, h('i'), 'Income'), h('span', { style: '--c:#ffc857' }, h('i'), 'Running & upkeep')));
      }
      const years = e.yearTotals.slice(-8);
      if (years.length) {
        add(win.body, section('Yearly results'));
        const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, 'Year'), h('th', null, 'Income'), h('th', null, 'Costs'), h('th', null, 'Profit')));
        for (const y of [...years].reverse()) {
          const p = CATEGORIES.reduce((a, k) => a + y.v[k], 0);
          tbl.appendChild(h('tr', null, h('td', null, String(y.year)), h('td', { class: 'pos' }, fmtMoney(y.v.income)), h('td', { class: 'neg' }, fmtMoney(p - y.v.income)), h('td', { class: p < 0 ? 'neg' : 'pos' }, fmtMoney(p))));
        }
        add(win.body, tbl);
      }
    }
  };
  win.refresh = render;
  render();
}

export function openCompetitors(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('competitors', 'Companies', { width: 620, icon: 'company', color: 'var(--accent)' });
  const render = () => {
    ui.wm.setTabs(win, [['overview', 'Overview'], ['history', 'History']], render);
    clear(win.body);
    const nAI = g.companies.filter((c) => c.ai).length;
    win.sub.textContent = nAI ? `${nAI} AI competitor${nAI > 1 ? 's' : ''}` : 'No competitors';
    if (win.tab === 'overview') {
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, 'Company'), h('th', null, 'Cash'), h('th', null, 'Net worth'), h('th', null, 'Vehicles'), h('th', null, 'Stations'), h('th', null, 'Lines'), h('th', null, 'Profit (yr)')));
      for (const co of g.companies) {
        const e = co.economy;
        const ly = e.yearTotals[e.yearTotals.length - 1];
        const profit = CATEGORIES.reduce((a, k) => a + (ly ? ly.v[k] : e.thisYear[k]), 0);
        tbl.appendChild(h('tr', null,
          h('td', { class: 'ellip' }, ui.ownerTag(co.id), co.id === PLAYER ? h('span', { class: 'muted' }, ' you') : ''),
          h('td', { class: e.money < 0 ? 'neg' : '' }, fmtMoney(e.money)),
          h('td', null, fmtMoney(e.netWorth + vehicleValue(ui, co.id))),
          h('td', null, String(g.vehicles.ofOwner(co.id).length)),
          h('td', null, String(g.stations.all().filter((s) => s.owner === co.id).length)),
          h('td', null, String(g.lines.all().filter((l) => l.owner === co.id).length)),
          h('td', { class: profit < 0 ? 'neg' : 'pos' }, fmtMoney(profit))));
      }
      add(win.body, tbl,
        h('div', { class: 'btns' },
          toggle('AI construction', g.aiEnabled, (v) => { g.aiEnabled = v; win.last = undefined; render(); }, 'AI vehicles keep running when off'),
          h('span', { class: 'spacer' }),
          nAI < 3 ? h('button', { class: 'btn', onclick: () => { const co = g.addAICompany(); ui.toast(`${co.name} enters the market`, 'info'); win.last = undefined; render(); } }, icon('plus', 16), 'Add AI company') : null),
        h('div', { class: 'muted', style: 'margin-top:6px' }, 'Profit shows the last full year, or this year so far.'));
    } else {
      const n = Math.max(0, ...g.companies.map((c) => c.economy.months.length));
      const len = Math.min(24, n);
      add(win.body, section('Monthly profit by company', `${len} months`));
      if (!len) { add(win.body, h('div', { class: 'pad' }, 'History appears after the first month.')); return; }
      const series = g.companies.map((co) => {
        const ms = co.economy.months.slice(-len);
        const vals = Array<number>(len - ms.length).fill(0).concat(ms.map(monthSum));
        return { values: vals, color: co.color, label: co.name };
      });
      const ref = g.companies.reduce((a, c) => (c.economy.months.length > a.economy.months.length ? c : a), g.companies[0]);
      add(win.body, chart(series, { w: 588, h: 180, labels: monthLabels(ref.economy, len) }),
        h('div', { class: 'legend' }, g.companies.map((co) => h('span', { style: `--c:${co.color}` }, h('i'), co.name))));
      add(win.body, section('Cumulative profit'));
      const cum = g.companies.map((co) => {
        const ms = co.economy.months.slice(-len);
        let acc = 0;
        const vals = Array<number>(len - ms.length).fill(0).concat(ms.map((m) => (acc += monthSum(m))));
        return { values: vals, color: co.color };
      });
      add(win.body, chart(cum, { w: 588, h: 150, labels: monthLabels(ref.economy, len) }));
    }
  };
  win.refresh = render;
  render();
}
