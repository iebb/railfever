// Capacity works use the corridor's recovered operating surplus to pay for construction and upkeep.
import type { AIController } from './ai';
import type { Game } from './game';
import type { Line } from './lines';
import type { Proposal } from './construction';
import { sharedCapacityPlan, sharedUpgradeReturn, capacityTrackUpkeep, touchSharedCapacity } from './ai-capacity';
import { autoSignalLine } from './signals';
import { planStationUpgrade, commitStationUpgrade } from './stations';
import { planDoubleTrack, commitDoubleTrack, quoteDoubleTrackCompletion, type DoublePlan } from './trackops';
import { lineCongestion } from './train';

type WorksReturn = ReturnType<typeof sharedUpgradeReturn>;
function fundWorks(ai: AIController, cost: number, value: WorksReturn): boolean {
  if (!value.pays || ai.available() < cost) return false;
  for (const share of value.contributions) {
    const partner = ai.game.aiOf(share.owner);
    if (!partner || partner.available() < share.cost || share.annual <= share.cost * (0.045 - 0.03 * partner.config.risk + 0.03)) return false;
  }
  if (!ai.capacityFunds(cost)) return false;
  for (const share of value.contributions) if (share.owner !== ai.companyId && !ai.game.aiOf(share.owner)!.capacityFunds(share.cost)) return false;
  return true;
}
function settleWorks(ai: AIController, value: WorksReturn, quoted: number, spent: number) {
  if (!(quoted > 0 && spent > 0)) return;
  let contributions = 0;
  for (const share of value.contributions) {
    if (share.owner === ai.companyId) continue;
    const cost = spent * share.cost / quoted;
    ai.game.company(share.owner).economy.spend(cost, 'construction', true); contributions += cost;
  }
  // The title holder's construction account retains its own share; partners buy the capacity they recover.
  if (contributions > 0) ai.game.company(ai.companyId).economy.spend(-contributions, 'construction', true);
}

// Track upgrades enforce access rights and keep each existing infrastructure title.
export function planCapacityTrackUpgrade(g: Game, edges: number[], side: 1 | -1, payer: number): DoublePlan {
  return planDoubleTrack(g, edges, side, payer);
}
export function commitCapacityTrackUpgrade(g: Game, plan: DoublePlan, consent?: (p: Proposal) => boolean, maxSpend?: number,
  formation?: { formationCost: number }) {
  if (maxSpend === undefined) return commitDoubleTrack(g, plan, true, {}, consent);
  const reserve = formation ?? quoteDoubleTrackCompletion(g, plan);
  const eco = g.company(plan.owner).economy;
  const own = Object.getOwnPropertyDescriptor(eco, 'canAfford'), native = eco.canAfford;
  const ownSpend = Object.getOwnPropertyDescriptor(eco, 'spend'), nativeSpend = eco.spend;
  const construction = eco.current.construction;
  // Keep cash, debt and books visible at their real native values. Only this synchronous construction
  // call is capped; refunds reduce net spend normally and the exact prior method state is restored.
  const canAfford = function(this: typeof eco, cost: number) {
    return native.call(this, cost) && construction - this.current.construction + cost <= maxSpend;
  };
  Object.defineProperty(eco, 'canAfford', { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: canAfford });
  Object.defineProperty(eco, 'spend', { configurable: true, writable: true, enumerable: ownSpend?.enumerable ?? false,
    value: function(this: typeof eco, cost: number, category: Parameters<typeof nativeSpend>[1], force = false) {
      // Existing-node signals spend directly; they must observe the same ceiling as new-node signals.
      if (cost > 0 && category === 'construction' && !canAfford.call(this, cost)) return false;
      return nativeSpend.call(this, cost, category, force);
    } });
  try { return commitDoubleTrack(g, plan, true, { maxFormationSpend: reserve.formationCost }, consent); }
  finally {
    if (own) Object.defineProperty(eco, 'canAfford', own); else Reflect.deleteProperty(eco, 'canAfford');
    if (ownSpend) Object.defineProperty(eco, 'spend', ownSpend); else Reflect.deleteProperty(eco, 'spend');
  }
}

/** The title holder acts for the whole corridor; other operators gain paths under their access agreement. */
export function relieveSharedCapacity(ai: AIController, l: Line): boolean {
  const g = ai.game, me = ai.companyId;
  touchSharedCapacity(g, l);
  const s = l.capacity!;
  if (s.works || g.day - (s.tried ?? -1e9) < 30) return !!s.works;
  const waiting = l.vehicles.map(id => g.vehicles.get(id)).some(t => t?.state === 'waiting' && (t as { stuckTime?: number }).stuckTime! > 30);
  let queue = 0;
  for (const sid of new Set(l.stops)) for (const w of g.stations.get(sid)?.waiting.values() ?? []) if (w.line === l.id) queue += w.count;
  if (!waiting && queue === 0) return false;
  // (the corridor auction is priced only for a line that may need works)
  const agreement = sharedCapacityPlan(g, l);
  const resources = agreement.resources.filter(r => r.edges.some(id => {
    const e = g.world.net.edges.get(id);
    return e && !g.trackUpgradeError(me, e.owner);
  }));
  if (!resources.length) return false;
  s.tried = g.day;
  // Signals and platform tracks are cheaper than new formation; both are valued on all operators' recovered fares.
  const signal = autoSignalLine(g, l.id, me, { preview: true });
  if (signal.placed + signal.changed > 0 || signal.signals.some(x => x.action !== 'keep')) {
    const value = sharedUpgradeReturn(g, l, resources.map(r => r.id), 1.15, signal.cost, 0);
    if (fundWorks(ai, signal.cost, value)) {
      const money = g.company(me).economy.money;
      const built = autoSignalLine(g, l.id, me);
      if (built.placed + built.changed > 0) {
        ai.stats.signals += built.placed;
        settleWorks(ai, value, signal.cost, money - g.company(me).economy.money);
        ai.railNote(`${l.name}: shared signals recover ${Math.round(value.annual / 1000)}k/year`);
        return true;
      }
    }
  }
  const platformWaits = new Set(lineCongestion(g, l.id).platformWaits.map(w => w.station));
  for (const r of resources.filter(r => r.kind === 'platform')) {
    const id = g.world.net.edges.get(r.edges[0])?.station, st = id === undefined ? undefined : g.stations.get(id);
    if (!st?.rail || !platformWaits.has(st.id) || st.owner !== me || st.rail.tracks >= 8 || r.edges.some(e => g.vehicles.isEdgeBusy(e))) continue;
    const plan = planStationUpgrade(g, st.id, { tracks: st.rail.tracks + 1 });
    if (!plan?.ok) continue;
    const value = sharedUpgradeReturn(g, l, [r.id], (st.rail.tracks + 1) / Math.max(1, r.available), plan.cost,
      g.stationMaintenance(st) / Math.max(1, st.rail.tracks));
    if (!fundWorks(ai, plan.cost, value)) continue;
    const money = g.company(me).economy.money;
    if (!commitStationUpgrade(g, plan)) {
      settleWorks(ai, value, plan.cost, money - g.company(me).economy.money);
      ai.railNote(`${l.name}: extra platform at ${st.name} recovers ${Math.round(value.annual / 1000)}k/year`);
      return true;
    }
  }
  // Work on the longest shared single-track bottleneck first. Full double track, then a shorter loop if the
  // geometry will not take the whole chain. Three/four platform tracks remain useful on a doubled corridor.
  const track = resources.filter(r => r.kind === 'single').map(r => ({ ...r,
    edges: r.edges.filter(id => { const e = g.world.net.edges.get(id); return e && !g.trackUpgradeError(me, e.owner); }),
    length: r.edges.reduce((n, id) => { const e = g.world.net.edges.get(id); return n + (e && !g.trackUpgradeError(me, e.owner) ? e.len : 0); }, 0) }))
    .filter(r => r.edges.length)
    .sort((a, b) => b.length - a.length || a.id - b.id)[0];
  if (!track) return false;
  s.works = { day: g.day, owner: me, edges: [...track.edges], side: 1 };
  return true;
}

/** One atomic planning/build unit; the saved request contains ids and the next side, never a live generator. */
export function sharedCapacityWork(ai: AIController): boolean {
  const g = ai.game, me = ai.companyId;
  const l = [...g.lines.map.values()].sort((a, b) => a.id - b.id).find(x => x.capacity?.works?.owner === me);
  if (!l) return false;
  const s = l.capacity!, task = s.works!;
  const edges = task.edges.filter(id => { const e = g.world.net.edges.get(id); return e && !g.trackUpgradeError(me, e.owner); });
  if (edges.length !== task.edges.length) { delete s.works; return true; }
  const plan = planCapacityTrackUpgrade(g, edges, task.side, me);
  if (plan.ok) {
    const agreement = sharedCapacityPlan(g, l);
    const selected = new Set(edges);
    const ids = agreement.resources.filter(r => r.edges.some(id => selected.has(id))).map(r => r.id);
    const value = sharedUpgradeReturn(g, l, ids, 2, plan.cost, capacityTrackUpkeep(g, edges));
    if (fundWorks(ai, plan.cost, value)) {
      const money = g.company(me).economy.money;
      const result = commitCapacityTrackUpgrade(g, plan);
      if (!result.error && result.edges.length) {
        ai.stats.doubled++; ai.stats.trackDouble += result.edges.reduce((n, id) => n + (g.world.net.edges.get(id)?.len ?? 0), 0);
        ai.stats.signals += result.signals;
        settleWorks(ai, value, plan.cost, money - g.company(me).economy.money);
        ai.railNote(`${l.name}: shared second track recovers ${Math.round(value.annual / 1000)}k/year on ${Math.round(plan.cost / 1000)}k`);
        delete s.works; return true;
      }
    }
    // The other side or a smaller loop may recover the same traffic at a lower construction cost.
  }
  if (task.side === 1) task.side = -1;
  else {
    // Try a contiguous open-line piece as an overtaking/passing loop when the whole stretch will not fit.
    const longest = edges.map(id => g.world.net.edges.get(id)!).sort((a, b) => b.len - a.len || a.id - b.id)[0];
    if (edges.length > 1 && longest && longest.len > 24) { task.edges = [longest.id]; task.side = 1; }
    else delete s.works;
  }
  return true;
}
