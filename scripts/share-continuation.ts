// Native shared-service work, including the save immediately after startShare and paid depot boundaries.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { flatGame, station, endNode, nodeSnap, build, railOpts } from './stationlib';
import { placeAndConnect, checkReservations } from './lib';

const oraclePath = process.argv.find(s => s.startsWith('--oracle='))?.slice(9);
const oracle: { deserialize: typeof deserialize; serialize: typeof serialize } | undefined = oraclePath
  ? await import(pathToFileURL(oraclePath).href) : undefined;
const json = (g: Game) => JSON.stringify(serialize(g));
function equal(a: string, b: string, label: string) {
  if (a === b) return;
  let at = 0; while (at < a.length && at < b.length && a[at] === b[at]) at++;
  assert.fail(`${label}: first full-save mismatch ${at}: ${a.slice(Math.max(0, at - 80), at + 160)} vs ${b.slice(Math.max(0, at - 80), at + 160)}`);
}
function decisionState(value: string) {
  const data = JSON.parse(value);
  for (const ai of data.ais) if (ai.state.share) { delete ai.state.share; delete ai.state.splitPieces; }
  return JSON.stringify(data);
}

function flatFixture(level: 'ground' | 'elevated' | 'underground' = 'ground') {
  const g = flatGame(256), me = g.addAICompany({ startMoney: 100_000_000 }).id;
  const options = { level, height: 2.4, depth: 2.4 };
  const A = station(g, 30, 128, Math.PI / 2, 12, 2, 0, options)!, B = station(g, 220, 128, Math.PI / 2, 12, 2, 0, options)!;
  assert(A && B);
  assert(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 1, { level, levelHeight: 2.4, levelDepth: 2.4 }), 'foreign corridor'));
  g.aiAcquisitions = false;
  return { g, me, A: A.id, B: B.id };
}

function nativeFixture() {
  const g = Game.create({ seed: 11, size: 384, towns: 10, hilliness: 'flat', water: 'low', startYear: 1990 });
  g.economy.money = 100_000_000;
  const pr = placeAndConnect(g, 60, 200, 0, new Set(), 1, () => {}, true);
  assert(pr, 'native generated towns support a paid connected railway');
  const me = g.addAICompany({ startMoney: 100_000_000 }).id;
  g.aiAcquisitions = false;
  return { g, me, A: pr.A.id, B: pr.B.id };
}

type Fixture = ReturnType<typeof flatFixture> & { joinLine?: number };
type Mode = 'open' | 'approve' | 'reject' | 'revoke' | 'poor';
function event(f: Fixture, g: Game, tick: number, mode: Mode) {
  if (tick === 8 && (mode === 'approve' || mode === 'reject')) {
    const request = g.requestsTo(0).find(r => r.user === f.me);
    assert(request, `${mode}: native pending request survives eight ticks`);
    if (mode === 'approve') assert.equal(g.approveAccess(request.id), null);
    else { g.rejectAccess(request.id); assert(!g.hasAccess(f.me, 0)); }
  }
  const ai = g.aiOf(f.me)! as any;
  if (mode === 'revoke' && ai.shareTask?.stage === 'purchase') g.setAllowAccess(0, false);
}

let totalTicks = 0, branches = 0;
function run(f: Fixture, mode: Mode, label: string, expectSuccess = false) {
  const g = f.g, ai = g.aiOf(f.me)! as any;
  if (mode === 'approve' || mode === 'reject') g.setAccessPolicy(0, 'ask');
  if (mode === 'poor') { g.company(f.me).economy.money = 0; g.company(f.me).economy.loan = 100_000_000; }
  const old = oracle?.deserialize(JSON.parse(json(g))), oldAI = old?.aiOf(f.me)!;
  assert(ai.startShare(0, f.A, f.B, f.joinLine ?? -1));
  assert(!oldAI || oldAI.startShare(0, f.A, f.B, f.joinLine ?? -1));
  let cold = deserialize(JSON.parse(json(g)));
  equal(json(cold), json(g), `${label}: task exists before its first work unit`);
  assert.equal(cold.aiOf(f.me)!.busy, true);
  const stages = new Set<string>();
  let tick = 0;
  const retained: { game: Game; until: number; stage: string }[] = [];
  for (; (ai.busy || retained.length) && tick < 2000; tick++) {
    event(f, g, tick, mode); event(f, cold, tick, mode);
    // The original controller has no exposed stage. Revoke at the same already-established native boundary.
    if (old) {
      if (mode === 'revoke' && !g.canUse(f.me, 0)) old.setAllowAccess(0, false);
      else if (mode !== 'revoke') event(f, old, tick, mode);
    }
    for (const branch of retained) event(f, branch.game, tick, mode);
    g.stepTick(); cold.stepTick(); old?.stepTick();
    const current = json(g);
    for (let at = retained.length - 1; at >= 0; at--) {
      const branch = retained[at]; branch.game.stepTick();
      equal(json(branch.game), current, `${label}: retained cold ${branch.stage}/${tick}`);
      if (tick >= branch.until) retained.splice(at, 1);
    }
    equal(json(cold), current, `${label}: cold next fixed tick ${tick}`);
    assert.equal(cold.aiOf(f.me)!.busy, ai.busy);
    if (old) equal(decisionState(current), decisionState(JSON.stringify(oracle!.serialize(old))), `${label}: original decision tick ${tick}`);
    const stage = ai.shareTask?.stage;
    if (stage && !stages.has(stage)) {
      stages.add(stage);
      retained.push({ game: deserialize(JSON.parse(current)), until: tick + 128, stage });
      branches++;
    }
    cold = deserialize(JSON.parse(current));
    equal(json(cold), current, `${label}: immediate roundtrip ${tick}`);
  }
  assert(!ai.busy, `${label}: native job finishes`);
  if (label.includes('fallback')) assert(stages.has('sideCommit'), `${label}: actual structural siding fallback is exercised`);
  assert(ai.log.every((line: string) => !line.includes('error:')), `${label}: no AI errors`);
  assert.equal(checkReservations(g).length, 0);
  if (expectSuccess) assert(g.vehicles.trains().some(t => t.owner === f.me), `${label}: native economics approved and paid for a train`);
  else assert(!g.vehicles.trains().some(t => t.owner === f.me), `${label}: refused proposal buys no train`);
  assert.equal(ai.shareTask, null, `${label}: completed continuation is discarded`);
  totalTicks += tick;
  console.log(`${label}: ${tick} fixed ticks, ${[...stages].join("/")} saved stages, ${ai.stats.shared} shared services`);
}

function joinedFixture(): Fixture {
  const f = nativeFixture(), line = f.g.lines.create('rail', 0);
  line.stops = [f.A, f.B]; f.g.lines.rebuild();
  return { ...f, joinLine: line.id };
}

function cancelPendingDepot() {
  const f = flatFixture(), ai = f.g.aiOf(f.me)! as any;
  const old = oracle?.deserialize(JSON.parse(json(f.g))), oldAI = old?.aiOf(f.me)! as any;
  assert(ai.startShare(0, f.A, f.B)); if (oldAI) assert(oldAI.startShare(0, f.A, f.B));
  for (let tick = 0; ai.shareTask?.depot < 0 && tick < 1000; tick++) { f.g.stepTick(); old?.stepTick(); }
  const depot = ai.shareTask?.depot;
  assert(depot >= 0 && !ai.project.depots.includes(depot), 'real depot paid before post-build yield and reachability ledger');
  const cold = deserialize(JSON.parse(json(f.g))), coldAI = cold.aiOf(f.me)! as any;
  if (old) equal(decisionState(json(f.g)), decisionState(JSON.stringify(oracle!.serialize(old))), 'native pre-cancel original boundary');
  ai.cancelJob(); coldAI.cancelJob(); oldAI?.cancelJob();
  equal(json(cold), json(f.g), 'saved pending ownership cancels identically');
  assert(!f.g.depots.get(depot) && ![...f.g.world.net.edges.values()].some(e => e.owner === f.me), 'cancellation removes paid depot and owned siding');
  assert(f.g.stations.get(f.A)?.rail && f.g.stations.get(f.B)?.rail && !f.g.hasAccess(f.me, 0), 'foreign platforms survive and unused agreement is cleaned');
  assert.equal(checkReservations(f.g).length, 0);
  if (old) assert(old.depots.get(depot), 'original controller reproduces the untracked paid-depot leak');
  console.log('pending depot cancellation: live/cold cleanup exact, original orphan reproduced');
}

const cases: [string, () => Fixture, Mode, boolean?][] = [
  ['native unserved refusal', flatFixture, 'open'],
  ['approved unserved refusal', flatFixture, 'approve'],
  ['request rejection', flatFixture, 'reject'],
  ['unaffordable train', flatFixture, 'poor'],
  ['elevated siding fallback', () => flatFixture('elevated'), 'open'],
  ['tunnel siding fallback', () => flatFixture('underground'), 'open'],
  ['generated profitable opening', nativeFixture, 'open', true],
  ['generated approved opening', nativeFixture, 'approve', true],
  ['revoked paid opening', nativeFixture, 'revoke'],
  ['generated joined opening', joinedFixture, 'open', true],
];
const selected = process.argv.find(s => s.startsWith('--case='))?.slice(7);
assert(!selected || selected === 'cancel' || cases.some(([label]) => label.includes(selected)), 'unknown shared-service case');
for (const [label, fixture, mode, success] of cases) {
  if (selected && !label.includes(selected) || process.argv.includes('--flat-only') && (fixture === nativeFixture || fixture === joinedFixture)) continue;
  run(fixture(), mode, label, success);
}
if (!selected || selected === 'cancel') cancelPendingDepot();
console.log(`ALL CHECKS PASSED: ${totalTicks} fixed ticks, ${branches} retained cold branches${oracle ? ', original-source oracle' : ''}`);
