// Company windows: player finances; the companies overview with AI settings, buyouts, track access and history.
import type { UI } from './ui';
import { MONTH_NAMES, PLAYER, DEFAULT_ACCESS_MULTIPLIER } from '../game/game';
import type { Game } from '../game/game';
import { h, clear, tile, section, icon, toggle, add, field, stepper, seg } from './dom';
import { AI_NAMES, AI_PRESETS, normalizeAIConfig } from '../game/ai';
import { liveCompanies, aiCount, aiConfigOf, addAI, applyAIConfig, presetOf, MAX_AI, DEFAULT_AI } from './gameapi';
import { fmtMoney, CATEGORIES, CATEGORY_LABEL, COMPANY_COLORS, Economy, MonthRecord, Category } from '../game/economy';
import { fmtLen, fmtMult, fmtPct, equalUseShare } from './format';
import { multSlider } from './win-access';
import type { AccessPolicy } from '../game/game';
import { chart } from './charts';
import { cashPitch } from '../audio/engine';

/** Operating categories: acquisitions are capital spending and kept out of profit. */
const OPERATING = CATEGORIES.filter((k) => k !== 'acquisition');
/** Rows hidden while they are zero in every column. */
const OPTIONAL = new Set<Category>(['trackIncome', 'trackFees', 'acquisition']);
const monthSum = (m: MonthRecord) => OPERATING.reduce((a, k) => a + m.v[k], 0);

function monthLabels(e: Economy, n: number) { return e.months.slice(-n).map((m) => MONTH_NAMES[m.month]); }

export function openFinances(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('finances', 'Finances', { width: 580, icon: 'money', color: 'var(--pos)', sub: g.player.name });
  const render = () => {
    const e = g.economy;
    ui.wm.setTabs(win, [['overview', 'Overview'], ['history', 'History']], render);
    clear(win.body);
    const value = g.companyValue(PLAYER);
    add(win.body, h('div', { class: 'tiles' },
      tile(fmtMoney(e.money), 'Cash', e.money < 0 ? 'neg' : ''),
      tile(fmtMoney(e.loan), 'Loan'),
      tile(fmtMoney(value), 'Company value', value < 0 ? 'neg' : ''),
      tile(fmtMoney(g.maintenanceOf(PLAYER)), 'Upkeep / yr')));
    if (win.tab === 'overview') {
      add(win.body, h('div', { class: 'btns', style: 'margin-top:0' },
        h('button', { class: 'btn', onclick: () => { if (!e.borrow()) ui.toast('Maximum loan reached', 'bad'); else ui.sound('cash', { pitch: cashPitch(e.loanStep) }); win.last = undefined; render(); } }, icon('plus', 16), `Borrow ${fmtMoney(e.loanStep)}`),
        h('button', { class: 'btn', onclick: () => { if (!e.repay()) ui.toast('Cannot repay', 'bad'); else ui.sound('click'); win.last = undefined; render(); } }, icon('minus', 16), `Repay ${fmtMoney(e.loanStep)}`),
        h('span', { class: 'muted' }, `max ${fmtMoney(e.maxLoan)} · ${(e.interestRate * 100).toFixed(1)}% interest`)));
      const months = e.months.slice(-3);
      const cols: { label: string; v: Record<Category, number> }[] = [
        ...months.map((m) => ({ label: `${MONTH_NAMES[m.month]} ${m.year}`, v: m.v })),
        { label: 'This month', v: e.current },
        { label: `${g.year}`, v: e.thisYear },
      ];
      const ly = e.yearTotals[e.yearTotals.length - 1];
      if (ly) cols.push({ label: String(ly.year), v: ly.v });
      const row = (cat: Category, cls = '') => h('tr', { class: cls }, h('td', null, CATEGORY_LABEL[cat]), cols.map((c) => h('td', { class: c.v[cat] < 0 ? 'neg' : c.v[cat] > 0 ? 'pos' : 'muted' }, c.v[cat] ? fmtMoney(c.v[cat]) : '–')));
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, ''), cols.map((c) => h('th', null, c.label))));
      for (const cat of OPERATING) if (!OPTIONAL.has(cat) || cols.some((c) => c.v[cat])) tbl.appendChild(row(cat));
      tbl.appendChild(h('tr', { class: 'total' }, h('td', null, 'Profit'), cols.map((c) => { const s = OPERATING.reduce((a, k) => a + c.v[k], 0); return h('td', { class: s < 0 ? 'neg' : 'pos' }, fmtMoney(s)); })));
      if (cols.some((c) => c.v.acquisition)) tbl.appendChild(row('acquisition', 'after'));
      add(win.body, section('Income & expenses'), tbl);
    } else {
      const ms = e.months.slice(-24);
      add(win.body, section('Monthly profit & income', `${ms.length} months`));
      if (!ms.length) add(win.body, h('div', { class: 'pad' }, 'The chart fills up month by month.'));
      else {
        add(win.body, chart([
          { values: ms.map(monthSum), color: '#4ade80', kind: 'bar', label: 'Profit' },
          { values: ms.map((m) => m.v.income + m.v.trackIncome), color: '#8fc3ff', label: 'Income' },
          { values: ms.map((m) => m.v.running + m.v.maintenance + m.v.trackFees), color: '#ffc857', label: 'Running & upkeep' },
        ], { w: 548, h: 170, labels: monthLabels(e, 24) }),
        h('div', { class: 'legend' }, h('span', { style: '--c:#4ade80' }, h('i'), 'Profit'), h('span', { style: '--c:#8fc3ff' }, h('i'), 'Income'), h('span', { style: '--c:#ffc857' }, h('i'), 'Running, upkeep & fees')));
      }
      const years = e.yearTotals.slice(-8);
      if (years.length) {
        add(win.body, section('Yearly results'));
        const tbl = h('table', { class: 'tbl fin' }, h('tr', null, h('th', null, 'Year'), h('th', null, 'Income'), h('th', null, 'Costs'), h('th', null, 'Profit')));
        for (const y of [...years].reverse()) {
          const p = OPERATING.reduce((a, k) => a + y.v[k], 0);
          const inc = y.v.income + y.v.trackIncome;
          tbl.appendChild(h('tr', null, h('td', null, String(y.year)), h('td', { class: 'pos' }, fmtMoney(inc)), h('td', { class: 'neg' }, fmtMoney(p - inc)), h('td', { class: p < 0 ? 'neg' : 'pos' }, fmtMoney(p))));
        }
        add(win.body, tbl);
      }
    }
  };
  win.refresh = render;
  render();
}

/** Track, roads and tram tracks a company owns (in world units), and its station / line / vehicle counts. */
function holdings(g: Game, id: number) {
  let rail = 0, road = 0, tram = 0;
  for (const e of g.world.net.edges.values()) {
    if (e.tram && e.tramOwner === id) tram += e.len;
    if (e.owner !== id) continue;
    if (e.kind === 'rail') rail += e.len; else road += e.len;
  }
  return {
    rail, road, tram,
    stations: g.stations.all().filter((s) => s.owner === id).length,
    lines: g.lines.all().filter((l) => l.owner === id).length,
    vehicles: g.vehicles.ofOwner(id).length,
  };
}

export function openCompetitors(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('competitors', 'Companies', { width: 700, icon: 'company', color: 'var(--accent)' });

  const overview = () => {
    const nAI = aiCount(g);
    const nReq = g.requestsTo(PLAYER).length;
    const tbl = h('table', { class: 'tbl fin' }, h('tr', null, ['Company', 'Value', 'Cash', 'Profit (yr)', 'Vehicles', 'Stations', 'Lines', ''].map((t) => h('th', null, t))));
    for (const co of liveCompanies(g)) {
      const e = co.economy;
      const profit = e.lastYearProfit;
      const hd = holdings(g, co.id);
      const cfg = co.ai ? aiConfigOf(g, co.id) : null;
      const why = co.ai ? g.canBuy(PLAYER, co.id) : null;
      tbl.appendChild(h('tr', null,
        h('td', { class: 'ellip' }, ui.ownerTag(co.id), co.id === PLAYER ? h('span', { class: 'muted' }, ' you') : cfg ? h('span', { class: 'muted' }, ' ' + (presetOf(cfg)?.name ?? 'Custom')) : null),
        h('td', null, fmtMoney(g.companyValue(co.id))),
        h('td', { class: e.money < 0 ? 'neg' : '' }, fmtMoney(e.money)),
        h('td', { class: profit < 0 ? 'neg' : 'pos' }, fmtMoney(profit)),
        h('td', null, String(hd.vehicles)),
        h('td', null, String(hd.stations)),
        h('td', null, String(hd.lines)),
        h('td', null, co.ai ? h('span', { class: 'rowbtns' },
          h('button', { class: 'ibtn sm', 'data-tip': 'AI settings', 'aria-label': `AI settings of ${co.name}`, onclick: () => openAIConfig(ui, co.id) }, icon('settings', 15)),
          h('button', { class: 'ibtn sm', 'data-tip': why ? `Buy out — ${why}` : `Buy out for ${fmtMoney(g.buyoutPrice(co.id))}`, 'aria-label': `Buy out ${co.name}`, onclick: () => openBuyout(ui, co.id) }, icon('buyout', 15))) : null)));
    }
    const gone = g.companies.filter((c) => c.defunct);
    add(win.body, tbl,
      h('div', { class: 'btns' },
        toggle('AI construction', g.aiEnabled, (v) => { g.aiEnabled = v; ui.sound('toggle', { pitch: v ? 1.1 : 0.9 }); win.last = undefined; render(); }, 'AI vehicles keep running when off'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', 'data-tip': 'Requests, policy, blocking and agreements', onclick: () => ui.openTrackAccess() }, icon('key', 16), 'Track access', nReq ? h('span', { class: 'cnt' }, String(nReq)) : null),
        h('button', { class: 'btn', disabled: nAI >= MAX_AI, 'data-tip': nAI >= MAX_AI ? `At most ${MAX_AI} AI companies` : 'Add a rival with its own style', onclick: () => openAIConfig(ui, null) }, icon('plus', 16), 'Add AI company')),
      h('div', { class: 'muted', style: 'margin-top:6px' }, 'Value: cash − loan + depreciated network and vehicles; buyouts are priced from it. Profit: last full year, or this year so far.'),
      gone.length ? h('div', { class: 'muted', style: 'margin-top:4px' }, gone.map((c) => `${c.name} was bought by ${c.boughtBy != null ? g.company(c.boughtBy).name : 'a rival'}.`).join(' ')) : null);
  };

  const history = () => {
    const comps = liveCompanies(g);
    const n = Math.max(0, ...comps.map((c) => c.economy.months.length));
    const len = Math.min(24, n);
    add(win.body, section('Monthly profit by company', `${len} months`));
    if (!len) { add(win.body, h('div', { class: 'pad' }, 'History appears after the first month.')); return; }
    const series = comps.map((co) => {
      const ms = co.economy.months.slice(-len);
      return { values: Array<number>(len - ms.length).fill(0).concat(ms.map(monthSum)), color: co.color, label: co.name };
    });
    const ref = comps.reduce((a, c) => (c.economy.months.length > a.economy.months.length ? c : a), comps[0]);
    add(win.body, chart(series, { w: 668, h: 180, labels: monthLabels(ref.economy, len) }),
      h('div', { class: 'legend' }, comps.map((co) => h('span', { style: `--c:${co.color}` }, h('i'), co.name))));
    add(win.body, section('Cumulative profit'));
    const cum = comps.map((co) => {
      const ms = co.economy.months.slice(-len);
      let acc = 0;
      return { values: Array<number>(len - ms.length).fill(0).concat(ms.map((m) => (acc += monthSum(m)))), color: co.color };
    });
    add(win.body, chart(cum, { w: 668, h: 150, labels: monthLabels(ref.economy, len) }));
  };

  const render = () => {
    ui.wm.setTabs(win, [['overview', 'Overview'], ['history', 'History']], render);
    clear(win.body);
    const nAI = aiCount(g);
    win.sub.textContent = nAI ? `${nAI} AI competitor${nAI > 1 ? 's' : ''}` : 'No competitors';
    if (win.tab === 'history') history();
    else overview();
  };
  win.refresh = render;
  render();
}

/** Colours offered for a new AI company. */
const AI_COLORS = [...COMPANY_COLORS.slice(1), '#8ac926', '#6a5acd', '#c2185b', '#00897b', '#d4d4d8'];

const activenessWord = (v: number) => (v < 0.5 ? 'Passive' : v < 0.85 ? 'Relaxed' : v < 1.3 ? 'Normal' : v < 1.7 ? 'Busy' : 'Aggressive');
const riskWord = (v: number) => (v < 0.25 ? 'Cautious' : v < 0.55 ? 'Moderate' : v < 0.8 ? 'Bold' : 'Reckless');
const focusWord = (v: number) => (v < 0.05 ? 'Never' : v < 0.6 ? 'Rarely' : v < 1.4 ? 'Normal' : v < 2.4 ? 'Preferred' : 'Main focus');

/** Add a new AI company (id null) or change an AI's settings. */
export function openAIConfig(ui: UI, id: number | null) {
  const g = ui.game;
  const co = id != null ? g.company(id) : null;
  const used = new Set(liveCompanies(g).map((c) => c.color.toLowerCase()));
  const st = {
    name: co?.name ?? suggestName(g),
    color: co?.color ?? AI_COLORS.find((c) => !used.has(c.toLowerCase())) ?? AI_COLORS[0],
    cfg: normalizeAIConfig((id != null ? aiConfigOf(g, id) : null) ?? DEFAULT_AI),
    /** what other companies pay for using this AI's network (track access multiplier) */
    mult: id != null ? g.accessMultiplier(id) : DEFAULT_ACCESS_MULTIPLIER,
  };
  const win = ui.wm.open('ai-config', co ? co.name : 'New AI company', { width: 440, icon: 'robot', color: st.color, sub: co ? 'AI settings' : 'Add a competitor' });
  let presetBtns: [string, HTMLElement][] = [];
  let presetHint: HTMLElement | null = null;
  const syncPreset = () => {
    const p = presetOf(st.cfg);
    for (const [pid, b] of presetBtns) b.classList.toggle('on', p?.id === pid);
    if (presetHint) presetHint.textContent = p ? p.hint : 'Custom settings';
  };
  const slider = (label: string, value: number, lo: number, hi: number, step: number, word: (v: number) => string, set: (v: number) => void) => {
    const out = h('span', { class: 'sl-v' }, word(value));
    const r = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), value: String(value), class: 'range', 'aria-label': label }) as HTMLInputElement;
    r.addEventListener('input', () => { const v = Number(r.value); set(v); out.textContent = word(v); syncPreset(); });
    return field(label, h('div', { class: 'slider' }, r, out));
  };
  const render = () => {
    clear(win.body);
    if (co?.defunct) { add(win.body, h('div', { class: 'pad' }, `${co.name} now belongs to ${co.boughtBy != null ? g.company(co.boughtBy).name : 'another company'}.`)); return; }
    const name = h('input', { class: 'input', value: st.name, style: 'flex:1', 'aria-label': 'Company name', disabled: !!co, maxlength: '32' }) as HTMLInputElement;
    name.addEventListener('input', () => { st.name = name.value; });
    presetBtns = AI_PRESETS.map((p) => [p.id, h('button', { class: 'segb', 'data-tip': p.hint, onclick: () => {
      const money = st.cfg.startMoney;
      st.cfg = normalizeAIConfig(p.config);
      if (co) st.cfg.startMoney = money;
      st.mult = p.config.accessMultiplier ?? st.mult;
      render();
    } }, p.name)]);
    presetHint = h('div', { class: 'field-h' });
    add(win.body,
      field('Name', name),
      co ? null : field('Colour', h('div', { class: 'palette inline-pal' }, AI_COLORS.map((c) => h('button', {
        class: 'pal' + (c === st.color ? ' on' : ''), style: `--c:${c}`, 'aria-label': `Colour ${c}`, disabled: used.has(c.toLowerCase()), 'data-sfx': 'none',
        onclick: () => { st.color = c; ui.sound('click', { pitch: 1.1 }); render(); },
      })))),
      field('Style', h('div', null, h('div', { class: 'presets' }, presetBtns.map(([, b]) => b)), presetHint)),
      slider('Activeness', st.cfg.activeness, 0.25, 2, 0.05, (v) => `${activenessWord(v)} ${v.toFixed(2)}×`, (v) => (st.cfg.activeness = v)),
      slider('Risk', st.cfg.risk, 0, 1, 0.05, (v) => `${riskWord(v)} ${Math.round(v * 100)}%`, (v) => (st.cfg.risk = v)),
      section('Focus', 'how often each mode is chosen'),
      slider('Rail', st.cfg.focus.rail, 0, 3, 0.1, focusWord, (v) => (st.cfg.focus.rail = v)),
      slider('Bus', st.cfg.focus.road, 0, 3, 0.1, focusWord, (v) => (st.cfg.focus.road = v)),
      slider('Tram', st.cfg.focus.tram, 0, 3, 0.1, focusWord, (v) => (st.cfg.focus.tram = v)),
      section('Track access', 'when others want to use its network'),
      field('Access', seg<AccessPolicy>([['open', 'Open'], ['ask', 'Judge each'], ['auto-approve', 'Approve all'], ['auto-reject', 'Refuse all']], st.cfg.accessPolicy, (v) => { st.cfg.accessPolicy = v; render(); }),
        st.cfg.accessPolicy === 'open' ? 'Anyone may use its network' : st.cfg.accessPolicy === 'ask' ? 'Refuses competitors when cautious' : undefined),
      multSlider('Users pay', st.mult, false, (v) => { st.mult = v; }, (v) => `${fmtMult(v)} · 50/50 usage → ${fmtPct(equalUseShare(v))}`),
      co ? null : field('Start money', stepper(fmtMoney(st.cfg.startMoney),
        () => { st.cfg.startMoney = Math.max(1_000_000, st.cfg.startMoney - 1_000_000); render(); },
        () => { st.cfg.startMoney = Math.min(50_000_000, st.cfg.startMoney + 1_000_000); render(); }), `The first ${fmtMoney(5_000_000)} is a loan`),
      h('div', { class: 'btns right' },
        co ? h('button', { class: 'btn ghost', onclick: () => openBuyout(ui, co.id) }, icon('buyout', 16), 'Buy out…') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => win.close() }, 'Cancel'),
        co
          ? h('button', { class: 'btn primary', 'data-sfx': 'none', onclick: () => {
            if (co.defunct) { ui.toast(`${co.name} no longer exists`, 'bad'); win.close(); return; }
            applyAIConfig(g, co.id, st.cfg); g.setAccessPolicy(co.id, st.cfg.accessPolicy); g.setAccessMultiplier(co.id, st.mult); ui.sound('toggle', { pitch: 1.1 }); ui.toast(`${co.name}: settings updated`, 'good'); win.close(); ui.wm.get('competitors')?.refresh?.();
          } }, icon('check', 16), 'Apply')
          : h('button', { class: 'btn primary', disabled: aiCount(g) >= MAX_AI, 'data-sfx': 'none', onclick: () => {
            const c = addAI(g, st.cfg, st.name.trim() || undefined, st.color);
            if (typeof c === 'string') { ui.toast(c, 'bad'); return; }
            g.setAccessMultiplier(c.id, st.mult);
            ui.sound('purchase');
            ui.toast(`${c.name} enters the market`, 'info');
            win.close();
            ui.wm.get('competitors')?.refresh?.();
          } }, icon('plus', 16), 'Add company')),
    );
    syncPreset();
  };
  win.refresh = undefined;
  render();
}

function suggestName(g: Game): string {
  const used = new Set(g.companies.map((c) => c.name));
  return AI_NAMES.find((n) => !used.has(n)) ?? `Rival Transport ${g.companies.length}`;
}

/** Buyout: price, what the company owns, affordability, confirmation. */
export function openBuyout(ui: UI, id: number) {
  const g = ui.game;
  const co = g.company(id);
  const win = ui.wm.open('buyout-' + id, `Buy ${co.name}`, { width: 440, icon: 'buyout', color: co.color, sub: 'Company acquisition' });
  const render = () => {
    clear(win.body);
    if (co.defunct) { add(win.body, h('div', { class: 'pad' }, `${co.name} now belongs to ${co.boughtBy != null ? g.company(co.boughtBy).name : 'another company'}.`)); return; }
    const price = g.buyoutPrice(id);
    const why = g.canBuy(PLAYER, id);
    const te = co.economy;
    const a = g.companyAssets(id);
    const hd = holdings(g, id);
    const money = g.economy.money;
    const asset = (label: string, what: string, v: number) => (v > 0 ? h('tr', null, h('td', null, label), h('td', { class: 'muted' }, what), h('td', null, fmtMoney(v))) : null);
    add(win.body,
      h('div', { class: 'tiles' },
        tile(fmtMoney(price), 'Price', why ? 'neg' : ''),
        tile(fmtMoney(g.companyValue(id)), 'Company value'),
        tile(fmtMoney(te.lastYearProfit), 'Profit (yr)', te.lastYearProfit < 0 ? 'neg' : 'pos')),
      section('You take over'),
      h('table', { class: 'tbl fin' },
        h('tr', null, h('th', null, 'Asset'), h('th', null, ''), h('th', null, 'Value')),
        asset('Track', fmtLen(hd.rail), a.track),
        asset('Roads', fmtLen(hd.road), a.road),
        asset('Tram tracks', fmtLen(hd.tram), a.tram),
        asset('Stations', String(hd.stations), a.stations),
        asset('Depots', '', a.depots),
        asset('Vehicles', `${hd.vehicles} on ${hd.lines} line${hd.lines === 1 ? '' : 's'}`, a.vehicles),
        h('tr', null, h('td', null, 'Cash'), h('td', null, ''), h('td', { class: te.money < 0 ? 'neg' : 'pos' }, fmtMoney(te.money))),
        h('tr', null, h('td', null, 'Loan'), h('td', null, ''), h('td', { class: te.loan ? 'neg' : 'muted' }, te.loan ? '−' + fmtMoney(te.loan) : '–'))),
      ui.kv('Your cash', h('span', { class: money >= price ? 'pos' : 'neg' }, fmtMoney(money))),
      why ? h('div', { class: 'warn' }, icon('warning', 16), money < price ? `You need ${fmtMoney(price - money)} more — borrow in Finances or wait.` : why) : null,
      h('div', { class: 'muted', style: 'margin-top:6px' }, 'Its lines and vehicles keep running under your name; its track access agreements pass to you.'),
      h('div', { class: 'btns right' },
        h('button', { class: 'btn ghost', onclick: () => win.close() }, 'Cancel'),
        h('button', { class: 'btn primary', disabled: !!why, 'data-sfx': 'none', onclick: () => {
          if (!confirm(`Buy ${co.name} for ${fmtMoney(price)}? You take over its network, vehicles, cash and loan.`)) return;
          const err = g.buyCompany(PLAYER, id);
          if (err) { ui.toast(err, 'bad'); ui.sound('error'); render(); return; }
          ui.sound('cash', { pitch: cashPitch(price) });
          ui.toast(`${co.name} is now part of ${g.player.name}`, 'good');
          win.close();
          ui.wm.get('ai-config')?.close();
          ui.wm.get('competitors')?.refresh?.();
        } }, icon('buyout', 16), `Buy for ${fmtMoney(price)}`)),
    );
  };
  win.refresh = render;
  render();
}
