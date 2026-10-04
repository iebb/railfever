// Track access window: requests to use your network, your answer policy and price multiplier, blocked companies,
// who uses your network, the networks you use and requests to other companies.
import type { UI } from './ui';
import type { Game, AccessPolicy, AccessResult } from '../game/game';
import { PLAYER, MAX_ACCESS_MULTIPLIER, ACCESS_REQUEST_DAYS } from '../game/game';
import { h, clear, add, tile, section, icon, toggle, seg, field } from './dom';
import { fmtMoney } from '../game/economy';
import { fmtMonthYear, fmtMult, fmtPct, equalUseShare, fmtLen } from './format';
import { liveCompanies } from './gameapi';

/** How an owner answers requests, in words (AI owners judge "ask" requests themselves, at once). */
export function policyText(g: Game, owner: number): string {
  const p = g.accessPolicy(owner);
  if (p === 'open') return 'Open network';
  if (p === 'auto-approve') return 'Grants access';
  if (p === 'auto-reject') return 'Refuses access';
  return g.company(owner).ai ? 'Decides on request' : 'Asks each time';
}

/** Track access multiplier slider (0×–3× in 0.25 steps) with a live label; `set` runs on every change. */
export function multSlider(label: string, value: number, disabled: boolean, set: (v: number) => void, word: (v: number) => string, hint?: string): HTMLElement {
  const out = h('span', { class: 'sl-v' }, word(value));
  const r = h('input', { type: 'range', min: '0', max: String(MAX_ACCESS_MULTIPLIER), step: '0.25', value: String(value), class: 'range', 'aria-label': label, disabled }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); set(v); out.textContent = word(v); });
  return field(label, h('div', { class: 'slider wide' }, r, out), hint);
}

/** Ask `owner` for access to its network on the player's behalf; tells the result. */
export function requestAccessUI(ui: UI, owner: number): AccessResult {
  const g = ui.game;
  const co = g.company(owner);
  const r = g.requestAccess(PLAYER, owner);
  if (r === 'granted') { ui.toast(`Access agreed with ${co.name} · upkeep ${fmtMult(g.accessMultiplier(owner))}`, 'good'); ui.sound('toggle', { pitch: 1.12 }); }
  else if (r === 'pending') { ui.toast(`Request sent; ${co.name} will answer`, 'info'); ui.sound('click'); }
  else if (r === 'blocked') ui.toast(`${co.name} has blocked you from its network`, 'bad');
  else ui.toast(`${co.name} refuses access to its network`, 'bad');
  ui.wm.get('access')?.refresh?.();
  return r;
}

/** End `user`'s agreement on `owner`'s network after confirming what it affects (null = cancelled). */
function endAgreement(ui: UI, user: number, owner: number, verb: string): boolean {
  const g = ui.game;
  const imp = g.accessImpact(user, owner);
  const whose = user === PLAYER ? 'Your' : `${g.company(user).name}'s`;
  const what = [
    imp.stops ? `${whose} lines lose ${imp.stops} stop${imp.stops > 1 ? 's' : ''} on ${imp.lines.length} line${imp.lines.length > 1 ? 's' : ''}` : '',
    imp.onTrack ? `${imp.onTrack} vehicle${imp.onTrack > 1 ? 's' : ''} must reroute` : '',
  ].filter(Boolean).join('; ');
  const other = g.company(user === PLAYER ? owner : user).name;
  if (what && !confirm(`${verb} the track access agreement with ${other}? ${what}.`)) return false;
  g.endAccess(user, owner);
  ui.toast(`Access agreement with ${other} ended`, 'info');
  ui.sound('toggle', { pitch: 0.88 });
  return true;
}

/** The player's access to `owner`'s network, in short. */
export function accessState(g: Game, owner: number): { kind: 'agreement' | 'pending' | 'blocked' | 'closed' | 'none'; text: string } {
  const a = g.agreement(PLAYER, owner);
  if (a) return { kind: 'agreement', text: `${g.accessPolicy(owner) === 'open' ? 'Open network' : 'Agreement'} · upkeep ${fmtMult(g.accessMultiplier(owner))} · last month share ${fmtPct(a.usageShareLastMonth)} · paid ${fmtMoney(a.paidLastMonth)}` };
  // an open network may be used without asking (the agreement for the fees starts with the first use)
  if (g.canUse(PLAYER, owner)) return { kind: 'agreement', text: `Open network · upkeep ${fmtMult(g.accessMultiplier(owner))} on use` };
  const q = g.requestsBy(PLAYER).find((r) => r.owner === owner);
  if (q) return { kind: 'pending', text: `Request pending · ${Math.max(0, ACCESS_REQUEST_DAYS - (g.day - q.day))} days left` };
  if (g.isBlocked(owner, PLAYER)) return { kind: 'blocked', text: 'You are blocked from this network' };
  if (g.accessPolicy(owner) === 'auto-reject') return { kind: 'closed', text: 'Refuses access to its network' };
  return { kind: 'none', text: `No agreement · ${policyText(g, owner).toLowerCase()} · upkeep shared ${fmtMult(g.accessMultiplier(owner))}` };
}

/** "Request access" / pending / blocked control for another company's network (inspect cards, lists). */
export function accessControl(ui: UI, owner: number, after: () => void): HTMLElement {
  const g = ui.game;
  const st = accessState(g, owner);
  if (st.kind === 'agreement') return h('span', { class: 'pos' }, g.hasAccess(PLAYER, owner) ? 'Agreement' : 'Open');
  if (st.kind === 'pending') return h('button', { class: 'btn sm', 'data-tip': 'Withdraw the request', onclick: () => { g.cancelAccessRequest(PLAYER, owner); ui.sound('click'); after(); } }, 'Withdraw');
  if (st.kind === 'blocked' || st.kind === 'closed') return h('span', { class: 'muted' }, st.kind === 'blocked' ? 'Blocked' : 'Closed');
  return h('button', { class: 'btn sm', 'data-tip': `${policyText(g, owner)} · users share the upkeep ${fmtMult(g.accessMultiplier(owner))}`, onclick: () => { requestAccessUI(ui, owner); after(); } }, icon('key', 15), 'Request access');
}

export function openTrackAccess(ui: UI) {
  const g = ui.game;
  const win = ui.wm.open('access', 'Track access', { width: 600, icon: 'key', color: 'var(--accent)' });
  const render = () => {
    clear(win.body);
    const e = g.economy;
    const reqs = g.requestsTo(PLAYER);
    const { using, usedBy } = g.agreementsOf(PLAYER);
    const policy = g.accessPolicy(PLAYER);
    const m = g.accessMultiplier(PLAYER);
    const earned = g.accessEarnings(PLAYER);
    const others = liveCompanies(g).filter((c) => c.id !== PLAYER);
    const rerender = () => { win.last = undefined; render(); };
    win.sub.textContent = reqs.length ? `${reqs.length} request${reqs.length > 1 ? 's' : ''} waiting` : `${policyText(g, PLAYER)} · users pay ${fmtMult(m)}`;
    add(win.body,
      h('div', { class: 'tiles' },
        tile(String(reqs.length), 'Requests waiting', reqs.length ? 'warn' : ''),
        tile(fmtMoney(e.thisYear.trackIncome), 'Earned (yr)', e.thisYear.trackIncome > 0 ? 'pos' : ''),
        tile(fmtMoney(-e.thisYear.trackFees), 'Paid (yr)', e.thisYear.trackFees < 0 ? 'neg' : ''),
        tile(`${usedBy.length} / ${using.length}`, 'Users · networks used')));

    // ---- incoming requests
    add(win.body, section('Incoming requests', reqs.length ? String(reqs.length) : null));
    if (!reqs.length) add(win.body, h('div', { class: 'pad muted' }, policy === 'ask' ? 'No pending requests.' : policy === 'open' ? 'Open network · no request needed · blocked companies excluded · shared upkeep' : `Automatic answers: ${policy === 'auto-approve' ? 'approved' : 'rejected'}`));
    for (const r of reqs) {
      const name = g.company(r.user).name;
      const left = Math.max(0, ACCESS_REQUEST_DAYS - (g.day - r.day));
      add(win.body, h('div', { class: 'acc req' },
        h('div', { class: 'acc-l' },
          h('div', { class: 'acc-t' }, ui.ownerTag(r.user), g.competes(r.user, PLAYER) ? h('span', { class: 'flag warn', 'data-tip': 'Serves the same town pairs as you' }, 'competitor') : null),
          h('div', { class: 'acc-s' }, `${r.reason ? r.reason + ' · ' : ''}asked ${fmtMonthYear(g, r.day)} · ${left} days left; then auto-rejected`)),
        h('div', { class: 'rowbtns' },
          h('button', { class: 'btn sm primary', 'data-sfx': 'none', onclick: () => { const err = g.approveAccess(r.id); if (err) ui.toast(err, 'bad'); else { ui.toast(`${name} may now use your network`, 'good'); ui.sound('toggle', { pitch: 1.12 }); } rerender(); } }, icon('check', 15), 'Approve'),
          h('button', { class: 'btn sm', 'data-sfx': 'none', onclick: () => { g.rejectAccess(r.id); ui.toast(`Request from ${name} rejected`, 'info'); ui.sound('toggle', { pitch: 0.88 }); rerender(); } }, 'Reject'),
          h('button', { class: 'ibtn sm', 'data-tip': 'Reject and block', 'aria-label': `Block ${name}`, onclick: () => { g.blockCompany(PLAYER, r.user); ui.toast(`${name} is blocked from your network`, 'info'); rerender(); } }, icon('close', 15)))));
    }

    // ---- policy
    add(win.body, section('Your policy'),
      field('Access', seg<AccessPolicy>([['open', 'Open', 'Open to all except blocked companies'], ['ask', 'Ask', 'Approve or reject each request'], ['auto-approve', 'Approve all', 'Auto-approve requests'], ['auto-reject', 'Reject all', 'Nobody new may use your network']], policy, (v) => {
        g.setAccessPolicy(PLAYER, v);
        ui.sound('toggle', { pitch: v === 'auto-reject' ? 0.88 : 1.12 });
        rerender();
      }), policy === 'open' ? `Open to all · users pay ${fmtMult(m)} of their usage share` : policy === 'auto-reject' ? 'Existing agreements continue; revoke below.' : undefined),
      multSlider('Users pay', m, false, (v) => g.setAccessMultiplier(PLAYER, v), (v) => `${fmtMult(v)} · 50/50 usage → they pay ${fmtPct(equalUseShare(v))}`),
      h('div', { class: 'explain' },
        h('p', null, 'Users ', h('b', null, 'share the upkeep'), ' by usage: monthly track, tram track and station upkeep; owner weight 1, users × owner’s multiplier.'),
        h('p', { class: 'ex' }, icon('info', 15), h('span', null, `50/50 use at ${fmtMult(2)}: user 2/3, owner 1/3; ${fmtMult(0)}: free; solely used by others: they pay all.`))));
    if (others.length) {
      const grid = h('div', { class: 'blockgrid' });
      for (const co of others) {
        const blocked = g.isBlocked(PLAYER, co.id);
        const t = toggle(co.name, blocked, (v) => {
          if (v) {
            if (g.hasAccess(co.id, PLAYER) && !endAgreementConfirm(ui, co.id)) { rerender(); return; }
            g.blockCompany(PLAYER, co.id);
            ui.toast(`${co.name} is blocked from your network`, 'info');
          } else { g.unblockCompany(PLAYER, co.id); ui.toast(`${co.name} may ask for access again`, 'info'); }
          rerender();
        }, blocked ? 'blocked' : undefined);
        t.querySelector('.sw-l')?.prepend(h('i', { class: 'codot', style: `--c:${co.color}` }));
        grid.appendChild(t);
      }
      add(win.body, section('Blocked companies', 'cannot use or ask for your network'), grid);
    }

    // ---- who uses my network
    add(win.body, section('Who uses my network', earned.total ? `${fmtMoney(earned.lastMonth)} last month · ${fmtMoney(earned.total)} in total` : null));
    if (usedBy.length) {
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, ['Company', 'Since', 'Usage share', 'Paid (month)', 'Total', ''].map((t) => h('th', null, t))));
      for (const a of usedBy) {
        tbl.appendChild(h('tr', null,
          h('td', { class: 'ellip' }, ui.ownerTag(a.user)),
          h('td', null, fmtMonthYear(g, a.since)),
          h('td', null, fmtPct(a.usageShareLastMonth)),
          h('td', { class: a.paidLastMonth ? 'pos' : 'muted' }, fmtMoney(a.paidLastMonth)),
          h('td', { class: a.paidTotal ? 'pos' : 'muted' }, fmtMoney(a.paidTotal)),
          h('td', null, h('span', { class: 'rowbtns' },
            h('button', { class: 'btn sm', onclick: () => { if (endAgreement(ui, a.user, PLAYER, 'Revoke')) rerender(); } }, 'Revoke'),
            h('button', { class: 'ibtn sm', 'data-tip': 'Revoke and block', 'aria-label': `Block ${g.company(a.user).name}`, onclick: () => {
              if (!endAgreementConfirm(ui, a.user)) return;
              g.blockCompany(PLAYER, a.user);
              ui.toast(`${g.company(a.user).name} is blocked from your network`, 'info');
              rerender();
            } }, icon('close', 15))))));
      }
      add(win.body, tbl);
    } else add(win.body, h('div', { class: 'pad muted' }, 'Nobody uses your network.'));

    // ---- networks I use
    add(win.body, section('Networks I use'));
    if (using.length) {
      const tbl = h('table', { class: 'tbl fin' }, h('tr', null, ['Owner', 'Rate', 'My share', 'Paid (month)', 'Total', ''].map((t) => h('th', null, t))));
      for (const a of using) {
        const om = g.accessMultiplier(a.owner);
        tbl.appendChild(h('tr', null,
          h('td', { class: 'ellip' }, ui.ownerTag(a.owner)),
          h('td', { 'data-tip': `Equal use: you pay ${fmtPct(equalUseShare(om))} upkeep` }, fmtMult(om)),
          h('td', null, fmtPct(a.usageShareLastMonth)),
          h('td', { class: a.paidLastMonth ? 'neg' : 'muted' }, fmtMoney(a.paidLastMonth)),
          h('td', { class: a.paidTotal ? 'neg' : 'muted' }, fmtMoney(a.paidTotal)),
          h('td', null, h('button', { class: 'btn sm', onclick: () => { if (endAgreement(ui, PLAYER, a.owner, 'End')) rerender(); } }, 'End'))));
      }
      add(win.body, tbl);
    } else add(win.body, h('div', { class: 'pad muted' }, 'No other networks used.'));

    // ---- request access to others
    const candidates = others.filter((co) => !g.hasAccess(PLAYER, co.id));
    if (candidates.length) {
      add(win.body, section('Other networks', 'open ones need no request'));
      for (const co of candidates) {
        const st = accessState(g, co.id);
        const hd = networkSummary(g, co.id);
        add(win.body, h('div', { class: 'acc' },
          h('div', { class: 'acc-l' },
            h('div', { class: 'acc-t' }, ui.ownerTag(co.id), h('span', { class: 'mult', 'data-tip': `Equal use: users pay ${fmtPct(equalUseShare(g.accessMultiplier(co.id)))} upkeep` }, fmtMult(g.accessMultiplier(co.id)))),
            h('div', { class: 'acc-s' }, [st.kind === 'none' ? policyText(g, co.id) : st.text, hd].filter(Boolean).join(' · '))),
          accessControl(ui, co.id, rerender)));
      }
    }
  };
  win.refresh = render;
  render();
}

/** Confirm ending `user`'s agreement on the player's network (before blocking it); false = cancelled. */
function endAgreementConfirm(ui: UI, user: number): boolean {
  const g = ui.game;
  if (!g.hasAccess(user, PLAYER)) return true;
  const imp = g.accessImpact(user, PLAYER);
  return !(imp.stops || imp.onTrack) || confirm(`Block ${g.company(user).name}? Agreement ends; ${imp.stops} stop${imp.stops === 1 ? '' : 's'} removed from its lines.`);
}

/** "12.4 km track · 3 stations" */
function networkSummary(g: Game, id: number): string {
  let rail = 0, tram = 0;
  for (const e of g.world.net.edges.values()) {
    if (e.tram && e.tramOwner === id) tram += e.len;
    if (e.owner === id && e.kind === 'rail') rail += e.len;
  }
  const st = g.stations.all().filter((s) => s.owner === id).length;
  return [rail ? `${fmtLen(rail)} track` : '', tram ? `${fmtLen(tram)} tram track` : '', st ? `${st} station${st > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'no network yet';
}
