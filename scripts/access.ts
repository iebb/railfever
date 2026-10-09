// Track access between companies on a flat test layout:
//
//   [A]=0==J1====AI====[E]====AI====J2==0=[D]        A, D: player stations (2 tracks), E: AI station (1 track)
//     \==1==/ \______ player detour _____/ \==1==/  J1, J2: junctions; the direct route runs over AI track
//
// Player trains (line A-E-D or A-D) pay the AI per unit on its track and per stop at E; an AI train between
// the player's stations A and D pays the player. Ending access drops E from the player's line and the player's
// train re-routes over its own (longer) detour. Also: re-plan without access, fee accounting, reservations.
// npx esbuild scripts/access.ts --bundle --platform=node --format=esm --outfile=$S/access.mjs && node $S/access.mjs
import { Game, PLAYER } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { findSnap } from '../src/game/construction';
import { stationEnds, nodeSnap, nodeAt, buildRailDepot, buildDepotOnLine } from '../src/game/routing';
import { fails, check, fmt, build, free, railOpts, checkReservations, Train } from './lib';
import type { Economy, Category } from '../src/game/economy';
import type { Vehicle } from '../src/game/vehicle';
import { brakeDistance, trainForces } from '../src/game/train';

export interface AccessLayout {
  g: Game; A: number; D: number; E: number; depA: number; depAI: number;
  direct: number[]; detour: number[]; ai: number;
}

/** Build the layout on a flat map (AI company 1 owns E and the direct track). */
export function buildAccessLayout(log = console.log): AccessLayout | null {
  const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false;
  // perfectly level ground
  g.world.h.fill(2);
  g.world.heightsVersion++;
  g.economy.money = 1e8;
  const AI = 1;
  g.company(AI).economy.money = 1e8;
  // networks shared on request here (the v2.2 defaults); open access (the default now) is tested at the end
  g.setAccessPolicy(PLAYER, 'ask');
  g.setAccessPolicy(AI, 'auto-approve');
  const net = g.world.net;
  const Z = 128;
  const station = (x: number, tracks: number, owner: number) => {
    const plan = g.stations.planRail(x, Z, Math.PI / 2, 16, tracks, owner);
    const id = g.stations.nextId;
    const err = g.stations.commitRail(plan, owner);
    if (err) { log(`station at ${x}: ${err}`); return -1; }
    return id;
  };
  const A = station(60, 2, PLAYER), D = station(230, 2, PLAYER), E = station(130, 1, AI);
  if (A < 0 || D < 0 || E < 0) return null;
  const sA = g.stations.get(A)!, sD = g.stations.get(D)!, sE = g.stations.get(E)!;
  const eA = stationEnds(g, sA), eD = stationEnds(g, sD), eE = stationEnds(g, sE);
  const e0 = net.nextEdge;
  // player throats: A's tracks merge on the way to J1 (x=100), D's from J2 (x=190)
  const edgeAt = (x: number) => { const s = findSnap(g, 'rail', x, Z, 0.8); return s.kind === 'edge' ? s : null; };
  if (!build(g, nodeSnap(g, eA[0].front, 'rail'), free(g, 100, Z), railOpts(PLAYER), 'A0-J1')) return null;
  const J1 = nodeAt(g, 'rail', 100, Z)!;
  const mA = edgeAt(82);
  if (!mA || !build(g, nodeSnap(g, eA[1].front, 'rail'), mA, railOpts(PLAYER), 'A1 merge')) return null;
  if (!build(g, nodeSnap(g, eD[0].back, 'rail'), free(g, 190, Z), railOpts(PLAYER), 'D0-J2')) return null;
  const J2 = nodeAt(g, 'rail', 190, Z)!;
  const mD = edgeAt(208);
  if (!mD || !build(g, nodeSnap(g, eD[1].back, 'rail'), mD, railOpts(PLAYER), 'D1 merge')) return null;
  const playerThroats = [...net.edges.keys()].filter((id) => id >= e0);
  // direct route over AI track through E (joining the player's junctions needs access while it is built)
  g.setAccessPolicy(PLAYER, 'auto-approve');
  g.requestAccess(AI, PLAYER);
  const d0 = net.nextEdge;
  if (!build(g, nodeSnap(g, J1.id, 'rail'), nodeSnap(g, eE[0].back, 'rail'), railOpts(AI), 'J1-E')) return null;
  if (!build(g, nodeSnap(g, eE[0].front, 'rail'), nodeSnap(g, J2.id, 'rail'), railOpts(AI), 'E-J2')) return null;
  const direct = [...net.edges.keys()].filter((id) => id >= d0);
  // the player's detour north of the line, branching off its own throat tracks
  const t0 = net.nextEdge;
  if (!build(g, free(g, 125, Z - 20), free(g, 135, Z - 20), railOpts(PLAYER), 'detour')) return null;
  const P1 = nodeAt(g, 'rail', 125, Z - 20)!, P2 = nodeAt(g, 'rail', 135, Z - 20)!;
  const bA = edgeAt(90);
  if (!bA || !build(g, nodeSnap(g, P1.id, 'rail'), bA, railOpts(PLAYER), 'detour west')) return null;
  const bD = edgeAt(200);
  if (!bD || !build(g, nodeSnap(g, P2.id, 'rail'), bD, railOpts(PLAYER), 'detour east')) return null;
  const north = (id: number) => { const e = net.edges.get(id); if (!e) return false; const q = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, q); return q.z < Z - 2; };
  const detour = [...net.edges.keys()].filter((id) => id >= t0 && north(id));
  // the player's depot behind A; the AI's on a siding off its track (built while it may use the player's junctions)
  const depA = buildRailDepot(g, sA, PLAYER, { x: 1, z: 0 });
  let depAI = -1;
  for (const id of direct) {
    const e = net.edges.get(id);
    if (!e || depAI >= 0) continue;
    for (const f of [0.5, 0.35, 0.65]) { depAI = buildDepotOnLine(g, e.id, e.len * f, AI); if (depAI >= 0) break; }
  }
  g.endAccess(AI, PLAYER);
  g.setAccessPolicy(PLAYER, 'ask');
  log(`layout: J1 ${J1.edges.length} edges, J2 ${J2.edges.length} edges, direct ${direct.map((id) => fmt(net.edges.get(id)?.len ?? 0)).join('+')}, detour ${detour.map((id) => fmt(net.edges.get(id)?.len ?? 0)).join('+')}, depots ${depA}/${depAI}, throats ${playerThroats.length}`);
  if (depA < 0 || depAI < 0) return null;
  // the siding split the AI's first edge: collect the AI's direct edges again
  const directNow = [...net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === AI && e.depot < 0 && e.station < 0).map((e) => e.id);
  return { g, A, D, E, depA, depAI, direct: directNow, detour, ai: AI };
}

/** Edges of a train's current path (occupied and reserved). */
const pathEdges = (t: Train) => [...t.segs, ...t.pending].map((s) => s.e).filter((e) => e >= 0);
/** Cumulative amount booked in a category (all years). */
const total = (e: Economy, cat: Category) => e.yearTotals.reduce((s, y) => s + y.v[cat], 0) + e.thisYear[cat];

// ------------------------------------------------------------------------------------------- run
const isMain = process.argv[1]?.includes('access');
if (isMain) {
  const L = buildAccessLayout();
  check(!!L, 'layout built');
  if (!L) { console.log(`\n${fails.length} FAILURES`); process.exit(1); }
  const { g, A, D, E, depA, depAI, direct, detour, ai } = L;
  const net = g.world.net;
  const P = g.company(PLAYER).economy, Q = g.company(ai).economy;
  const loco = MODEL_BY_ID.get('diesel_b')!, coach = MODEL_BY_ID.get('coach_ic')!;
  const run = (days: number) => { const d0 = g.day; while (g.day < d0 + days) g.update(0.25); };
  const onAI = (t: Train) => pathEdges(t).some((id) => net.edges.get(id)?.owner === ai);
  const onDetour = (t: Train) => pathEdges(t).some((id) => detour.includes(id));

  // ---- 1. player line A-E-D: E belongs to the AI, so the line needs an agreement
  const line = g.lines.create('rail', PLAYER);
  check(!!g.lines.canAddStop(line.id, E), 'cannot stop at the AI station without an agreement: ' + g.lines.canAddStop(line.id, E));
  line.stops = [A, D];
  const pt = g.vehicles.buyTrain(depA, [loco, coach, coach], line.id) as Train;
  check(pt instanceof Train, 'player train bought');
  run(40);
  console.log(`  without access: ${pt.status}, on AI track ${onAI(pt)}, detour ${onDetour(pt)}`);
  check(!g.canUse(PLAYER, ai), 'no access yet');
  check(!onAI(pt), 'without access the player train keeps off the AI track');
  check(pt.delivered > 0 || pt.state !== 'noroute', 'player train runs on its own detour');

  // ---- 2. access: the player's train takes the short way over AI track and stops at E
  check(g.accessPolicy(ai) === 'auto-approve' && g.requestAccess(PLAYER, ai) === 'granted', 'AI grants access (auto-approve)');
  check(g.canUse(PLAYER, ai) && g.hasAccess(PLAYER, ai), 'canUse after the agreement');
  check(g.lines.canAddStop(line.id, E) === null, 'AI station usable as a stop now');
  line.stops = [A, E, D];
  g.lines.rebuild();
  for (const vid of line.vehicles) g.vehicles.get(vid)?.onLineChanged();
  const f0 = { pPaid: total(P, 'trackFees'), qEarned: total(Q, 'trackIncome') };
  const agr = g.agreement(PLAYER, ai)!;
  let sawAI = 0, sawDetour = 0, billedShare = Infinity;
  // Clear the route reserved before access changed, then observe two complete service cycles.
  // Curves now share one speed model; its phase at day 40 must not decide the access result.
  for (let d = 0; d < 180 && !(pt.state === 'loading' && pt.atStation === A); d++) run(1);
  for (let d = 0; d < 270; d++) {
    run(1); if (onAI(pt)) sawAI++; if (onDetour(pt)) sawDetour++;
    if (agr.paidLastMonth > 0) billedShare = Math.min(billedShare, agr.usageShareLastMonth);
  }
  console.log(`  with access: days on AI track ${sawAI}, on detour ${sawDetour}; player paid ${fmt(-(total(P, 'trackFees') - f0.pPaid), 0)}, AI earned ${fmt(total(Q, 'trackIncome') - f0.qEarned, 0)}, agreement: paid ${fmt(agr.paidTotal, 0)}, last month ${fmt(agr.paidLastMonth, 0)} at usage share ${fmt(agr.usageShareLastMonth * 100, 0)}%; ${pt.status}`);
  check(sawAI > 20, 'player train uses the AI track');
  check(total(P, 'trackFees') < f0.pPaid && total(Q, 'trackIncome') > f0.qEarned, 'fees flow from the player to the AI');
  check(Math.abs((f0.pPaid - total(P, 'trackFees')) - (total(Q, 'trackIncome') - f0.qEarned)) < 1, 'fees paid = fees earned');
  check(agr.paidTotal > 0 && Math.abs(agr.paidTotal - (f0.pPaid - total(P, 'trackFees'))) < 1, 'agreement records the fees');
  check(Number.isFinite(billedShare) && billedShare > 0.9, 'the idle owner: the player carries (nearly) all the traffic in every billed month');
  check(Math.abs(g.accessEarnings(ai).total - agr.paidTotal) < 1, 'owner earnings recorded');
  check(g.stations.get(E)!.lastPickup > 0 || pt.delivered > 0, 'train served the AI station');
  check(sawAI > sawDetour, 'with access the short way over AI track is preferred');
  {
    // Full replacement cost replaces weighted upkeep: equal use is p/2, capped at 75%; no wear in these manual meters.
    g.billAccess(); // bill what was metered so far
    const e = net.edges.get(direct.find((id) => net.edges.get(id)!.len > 5)!)!;
    const C = g.accessFullCost(e) / 12, sE = g.stations.get(E)!, CS = g.accessFullCost(sE) / 12;
    const bill = (use: () => void) => { const p0 = total(P, 'trackFees'), q0 = total(Q, 'trackIncome'); use(); g.billAccess(); return { paid: p0 - total(P, 'trackFees'), earned: total(Q, 'trackIncome') - q0 }; };
    check(g.accessMultiplier(ai) === 0.625 && g.accessMultiplier(PLAYER) === 1.25, 'default factors: permissive AI 0.625x, player 1.25x');
    let r = bill(() => { g.recordTrackUse(ai, e, 10); g.recordTrackUse(PLAYER, e, 10); });
    check(Math.abs(r.paid - C * 0.3125) < 0.01, 'equal use at AI default p = 0.625: user pays 31.25% of full cost');
    g.setAccessMultiplier(ai, 2);
    r = bill(() => { g.recordTrackUse(ai, e, 10); g.recordTrackUse(PLAYER, e, 10); });
    console.log(`  split: edge full cost ${fmt(C, 0)}/month, 50/50 at p=2: paid ${fmt(r.paid, 1)} (${fmt(r.paid / C * 100, 1)}%)`);
    check(Math.abs(r.paid - C * 0.75) < 0.01 && Math.abs(r.earned - r.paid) < 1e-6, 'equal use at p = 2: capped at 75% of full cost');
    check(Math.abs(g.agreement(PLAYER, ai)!.usageShareLastMonth - 0.5) < 1e-9, 'usage share 50%');
    g.setAccessMultiplier(ai, 0);
    r = bill(() => { g.recordTrackUse(ai, e, 10); g.recordTrackUse(PLAYER, e, 10); });
    check(r.paid === 0, 'm = 0: free');
    g.setAccessMultiplier(ai, 2);
    r = bill(() => { g.recordTrackUse(PLAYER, e, 7); });
    check(Math.abs(r.paid - C * 0.75) < 0.01, 'owner idle: capped at 75% of full cost');
    g.setAccessMultiplier(ai, 2);
    r = bill(() => { g.recordTrackUse(ai, e, 30); g.recordTrackUse(PLAYER, e, 10); });
    check(Math.abs(r.paid - C * 30 / 60) < 0.01, 'p = 2, 75/25: the user pays 25% × 2 = 50% of full cost');
    g.setAccessMultiplier(ai, 2);
    const aiVehicle = { owner: ai } as unknown as Vehicle;
    r = bill(() => { for (let i = 0; i < 4; i++) { g.recordStop(pt, sE); g.recordStop(aiVehicle, sE); } });
    check(Math.abs(r.paid - CS * 0.75) < 0.01, 'station stops: equal use at p = 2 hits 75% full-cost cap');
    r = bill(() => { g.recordStop(pt, g.stations.get(A)!); g.recordTrackUse(PLAYER, net.edges.get(detour[0])!, 50); });
    check(r.paid === 0, 'own infrastructure is free');
    const est = g.estimateAccessShare(ai, PLAYER);
    check(Math.abs(est.equalUseShare - 0.75) < 1e-9 && est.multiplier === 2, 'estimateAccessShare');
  }

  // ---- 3. the AI runs a train between the player's stations (needs access to the player's network); its line
  // stops at its own station E too (a company running services on a line owns one of its stations)
  const aiLine = g.lines.create('rail', ai);
  aiLine.stops = [A, E, D, E];
  const at = g.vehicles.buyTrain(depAI, [loco, coach], aiLine.id) as Train;
  check(at instanceof Train, 'AI train bought');
  // (without access it may serve its own station E, never the player's A and D nor their track)
  const seenNoAccess = new Set<number>();
  for (let k = 0; k < 80; k++) { g.update(0.25); if (at.atStation >= 0) seenNoAccess.add(at.atStation); if (pathEdges(at).some((id) => net.edges.get(id)?.owner === PLAYER)) seenNoAccess.add(-99); }
  console.log(`  AI train without access: ${at.state} (${at.status}); served ${[...seenNoAccess].map((id) => g.stations.get(id)?.name ?? 'player track').join(', ') || 'nothing'}`);
  check(!seenNoAccess.has(A) && !seenNoAccess.has(D) && !seenNoAccess.has(-99), 'AI train keeps off the player network without access');
  // the player is asked (policy 'ask'): a pending request, approved
  check(g.accessPolicy(PLAYER) === 'ask', 'the player is asked (policy ask)');
  check(g.requestAccess(ai, PLAYER, 'test') === 'pending' && g.requestAccess(ai, PLAYER) === 'pending', 'request pending (once)');
  const rq = g.requestsTo(PLAYER);
  check(rq.length === 1 && rq[0].user === ai && !g.hasAccess(ai, PLAYER), 'pending request listed for the player, no access yet');
  check(g.news.some((n) => n.text.includes('requests access to your tracks')), 'the player is told about the request');
  check(g.approveAccess(rq[0].id) === null && g.hasAccess(ai, PLAYER) && !g.requestsTo(PLAYER).length, 'approved: agreement signed');
  const f1 = { pEarned: total(P, 'trackIncome'), qPaid: total(Q, 'trackFees') };
  run(150);
  console.log(`  AI train with access: delivered ${at.delivered}, ${at.status}; player earned ${fmt(total(P, 'trackIncome') - f1.pEarned, 0)}, AI paid ${fmt(f1.qPaid - total(Q, 'trackFees'), 0)}`);
  check(total(P, 'trackIncome') > f1.pEarned && total(Q, 'trackFees') < f1.qPaid, 'fees flow from the AI to the player too');
  check(at.state !== 'noroute', 'AI train runs on the player network');
  let errs = checkReservations(g);
  check(errs.length === 0, 'reservations consistent ' + errs.slice(0, 3).join('; '));

  // ---- 4. policies, rejection, expiry, blocking
  // Blocking removes foreign calls immediately. A train physically caught on that track may still escape
  // to its remaining owned stop; its position at this test checkpoint must not decide the access result.
  const caughtOnPlayer = at.occupiedEdges().some(id => net.edges.get(id)?.owner === PLAYER);
  g.blockCompany(PLAYER, ai);
  check(g.isBlocked(PLAYER, ai) && !g.canUse(ai, PLAYER) && g.requestAccess(ai, PLAYER) === 'blocked', 'blocked: agreement ended, requests refused');
  check(!aiLine.stops.some((s) => g.stations.get(s)?.owner === PLAYER), `AI line lost its stops at player stations (${aiLine.stops.map((s) => g.stations.get(s)?.name).join(', ')})`);
  g.stepTick(); // let the native loading departure / network replan choose its route off revoked track
  const escapePath = [...at.segs, ...at.pending], foreignEscape = new Set(escapePath.filter(s => net.edges.get(s.e)?.owner === PLAYER).map(s => s.e));
  if (caughtOnPlayer) check(net.edges.get(escapePath.at(-1)?.e ?? -1)?.owner === ai && g.stations.get(at.routeTarget)?.owner === ai,
    'a caught blocked train plans its escape to its remaining owned stop');
  // This fixture is flat. Bound the whole planned trip by half its lowest native speed limit, with a
  // conservative acceleration from the actual consist's traction and braking room for its full body.
  const escapeSpeed = Math.min(at.maxSpeed, ...escapePath.map(s => s.limit)) / 2;
  const forces = trainForces(at, escapeSpeed * 10), acceleration = (forces.traction - forces.resistance) / (at.mass * 1000 * 20);
  const seconds = escapeSpeed / acceleration + (escapePath.reduce((n, s) => n + s.len, 0) + at.length + 2 * brakeDistance(escapeSpeed)) / escapeSpeed;
  const escapeDays = Math.ceil(seconds / (g.tickSeconds * g.ticksPerDay));
  check(!caughtOnPlayer || Number.isFinite(escapeDays) && acceleration > 0, 'native consist can clear its finite flat escape path');
  const deadline = g.day + (caughtOnPlayer && Number.isFinite(escapeDays) ? escapeDays : 0);
  const foreignPath = () => pathEdges(at).filter(id => net.edges.get(id)?.owner === PLAYER);
  let outsideEscape = false, reentered = false, cleared = foreignPath().length === 0;
  const observeBlocked = () => {
    outsideEscape ||= foreignPath().some(id => !foreignEscape.has(id));
    if (cleared && foreignPath().length) reentered = true;
    if (!foreignPath().length) cleared = true;
  };
  const blockedDay = g.day;
  while (!cleared && g.day < deadline) { g.stepTick(); observeBlocked(); }
  console.log(`  blocked escape: caught ${caughtOnPlayer}, cleared in ${g.day - blockedDay} days, native path bound ${caughtOnPlayer ? escapeDays : 0} days, foreign path ${foreignEscape.size} edges`);
  check(cleared && !outsideEscape && checkReservations(g).length === 0,
    `blocked AI train clears its pre-existing escape without other foreign entry or reservation conflicts (${at.state}: ${at.status})`);
  for (let k = 0; k < 10 * g.ticksPerDay; k++) { g.stepTick(); observeBlocked(); }
  check(cleared && !reentered && !foreignPath().length, `blocked AI train keeps off the player network after physically clearing it (${at.state}: ${at.status})`);
  g.unblockCompany(PLAYER, ai);
  check(!g.isBlocked(PLAYER, ai), 'unblocked');
  // reject
  check(g.requestAccess(ai, PLAYER) === 'pending', 'asks again');
  g.rejectAccess(g.requestsTo(PLAYER)[0].id);
  check(!g.hasAccess(ai, PLAYER) && !g.requestsTo(PLAYER).length, 'rejected: no agreement');
  // expiry
  check(g.requestAccess(ai, PLAYER) === 'pending', 'asks once more');
  run(61);
  check(!g.requestsTo(PLAYER).length && !g.hasAccess(ai, PLAYER), 'unanswered request expires after 60 days');
  // auto-reject / auto-approve
  g.setAccessPolicy(PLAYER, 'auto-reject');
  check(g.requestAccess(ai, PLAYER) === 'rejected' && !g.allowAccess[PLAYER], 'auto-reject');
  g.setAccessPolicy(PLAYER, 'auto-approve');
  check(g.requestAccess(ai, PLAYER) === 'granted' && g.hasAccess(ai, PLAYER), 'auto-approve');
  // the owner revokes it
  check(g.endAccess(ai, PLAYER) === null && !g.hasAccess(ai, PLAYER), 'owner ends the agreement');
  // a pending request is decided when the policy changes
  g.setAccessPolicy(PLAYER, 'ask');
  check(g.requestAccess(ai, PLAYER) === 'pending', 'pending again');
  g.setAccessPolicy(PLAYER, 'auto-approve');
  check(g.hasAccess(ai, PLAYER) && !g.requestsTo(PLAYER).length, 'switching to auto-approve grants the waiting request');
  g.endAccess(ai, PLAYER);
  g.setAccessPolicy(PLAYER, 'ask');
  // AI owners: a cautious AI that 'asks' keeps a competitor off its tracks
  g.setAccessPolicy(ai, 'ask');
  g.aiOf(ai)!.config = { ...g.aiOf(ai)!.config, risk: 0.2 };
  check(g.competes(PLAYER, ai) === g.lines.all().some((l) => l.owner === ai && l.stops.length > 1) && g.requestAccess(PLAYER, ai) === 'granted', 'cautious AI still grants access to a non-competitor (we already have it)');
  g.setAccessPolicy(ai, 'auto-approve');

  // ---- 5. ending the player's access: E dropped from the line, train re-routes over the detour
  const impact = g.accessImpact(PLAYER, ai);
  check(impact.lines.includes(line.id) && impact.stops >= 1, `access impact lists the line (${JSON.stringify(impact)})`);
  check(g.endAccess(PLAYER, ai) === null, 'agreement ended');
  check(!line.stops.includes(E) && line.stops.length === 2, 'AI station removed from the player line');
  run(12);
  // what was metered before the agreement ended is billed at the month end
  const monthEnd = (Math.floor(g.day / 30) + 1) * 30;
  while (g.day <= monthEnd) g.update(0.25);
  const paidAfter = total(P, 'trackFees');
  sawAI = 0; sawDetour = 0;
  let leftAt = -1;
  for (let d = 0; d < 90; d++) { run(1); if (onAI(pt)) { sawAI++; leftAt = -1; } else if (leftAt < 0) leftAt = d; if (onDetour(pt)) sawDetour++; }
  console.log(`  after ending access: days on AI track ${sawAI} (off it since day ${leftAt}), on detour ${sawDetour}, state ${pt.state} (${pt.status}), fees after ${fmt(paidAfter - total(P, 'trackFees'), 0)}`);
  check(leftAt >= 0 && leftAt < 30, 'a train caught on the AI track finds its way off it');
  sawAI = 0;
  check(Math.abs(paidAfter - total(P, 'trackFees')) < 1, 'no more fees once the train left the AI track');
  check(sawAI === 0, 'player train no longer uses AI track');
  check(sawDetour > 10 && pt.state !== 'noroute', 'player train re-routed over its own detour');
  errs = checkReservations(g);
  check(errs.length === 0, 'reservations consistent after re-routing ' + errs.slice(0, 3).join('; '));

  // ---- 6. open access (the default): no requests; an agreement for the fees on first use
  {
    const h = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 2 });
    check(h.accessPolicy(PLAYER) === 'open' && h.accessPolicy(1) === 'open' && h.aiOf(1)!.config.accessPolicy === 'open', 'open access is every company\'s default');
    check(h.canUse(2, 1) && h.canUse(PLAYER, 1) && h.canUse(1, PLAYER) && !h.hasAccess(2, 1), 'anyone may use an open network without an agreement');
    check(h.requestAccess(PLAYER, 2) === 'granted' && h.hasAccess(PLAYER, 2), 'a request to an open network is granted at once');
    h.blockCompany(1, 2);
    check(!h.canUse(2, 1) && h.canUse(PLAYER, 1) && h.requestAccess(2, 1) === 'blocked', 'a blocked company may not');
    h.unblockCompany(1, 2);
    h.setAccessPolicy(1, 'ask');
    check(!h.canUse(2, 1) && h.requestAccess(2, 1) === 'granted', 'switched to ask: requests again (an AI that asks grants a non-competitor)');
    h.setAccessPolicy(1, 'open');
  }
  // in the layout: the AI runs its train between the player's stations again, without asking
  g.setAccessPolicy(PLAYER, 'open');
  g.setAccessPolicy(ai, 'open');
  check(!g.hasAccess(ai, PLAYER) && g.canUse(ai, PLAYER) && g.lines.canAddStop(aiLine.id, A) === null, 'open: the AI may stop at the player stations without an agreement');
  aiLine.stops = [A, E, D, E];
  g.lines.rebuild();
  for (const vid of aiLine.vehicles) g.vehicles.get(vid)?.onLineChanged();
  const n0 = g.requestsTo(PLAYER).length, d0 = at.delivered, f2 = { pEarned: total(P, 'trackIncome'), qPaid: total(Q, 'trackFees') };
  const visited = new Set<number>();
  // Include depot/route recovery and at least a full out-and-back cycle under curve limits.
  for (const until = g.day + 300; g.day < until;) { g.update(0.25); if (at.atStation >= 0) visited.add(at.atStation); }
  const ag = g.agreement(ai, PLAYER);
  console.log(`  open access: AI train served ${[...visited].map((id) => g.stations.get(id)?.name).join(', ')} (${at.status}); agreement ${!!ag} (paid ${fmt(ag?.paidTotal ?? 0, 0)}); player earned ${fmt(total(P, 'trackIncome') - f2.pEarned, 0)}`);
  check(g.requestsTo(PLAYER).length === n0 && !!ag, 'open: no request; an agreement made on first use');
  check(visited.has(A) && visited.has(D) && total(P, 'trackIncome') > f2.pEarned && total(Q, 'trackFees') < f2.qPaid, 'open: the AI train serves the player stations and pays its share');
  void d0;
  errs = checkReservations(g);
  check(errs.length === 0, 'reservations consistent ' + errs.slice(0, 3).join('; '));
  void direct; void findSnap;
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
