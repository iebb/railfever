// Fleet-only city growth must price physical paths, and replay a saved investment decision exactly.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { networkPlanner, saveNetwork, networkDaily } from '../src/game/ai-network';
import { marginalSharedTrain, usesSharedRail } from '../src/game/ai-capacity';
import { Train } from '../src/game/train';
import { connectStationThroat } from '../src/game/trackops';
import { flatGame, station, endNode, build, railOpts, nodeSnap, loco, depotFor } from './stationlib';
import { check, fails, checkReservations } from './lib';

if (!process.argv[1]?.endsWith('growthcap.mjs')) throw new Error('bundle as growthcap.mjs');

function fixtures() {
  for (const shared of [false, true]) {
    const g = flatGame(256); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
    for (let i = 0; i < 2; i++) g.addAICompany({ startMoney: 50_000_000 });
    const A = station(g, 20, 128, Math.PI / 2, 10, 2, 1)!;
    const B = station(g, 236, 128, Math.PI / 2, 10, 2, shared ? 2 : 1)!;
    if (!A || !B || !build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
      nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(1))) throw new Error('fixture track');
    for (const st of [A, B]) connectStationThroat(g, st.id, st.owner);
    const depots = [depotFor(g, A, B, 1), depotFor(g, B, A, shared ? 2 : 1)];
    const l = g.lines.create('rail', 1); l.stops = [A.id, B.id];
    if (shared) g.lines.invite(l.id, 2);
    g.lines.rebuild(); l.incomeLast = 30_000_000; l.passLast = 500;
    check(usesSharedRail(g, l) === shared, `${shared ? 'shared' : 'private'} fixture exercises its own ownership`);
    const gains: number[] = [];
    for (let n = 0; n < 4; n++) {
      const owner = shared && n % 2 ? 2 : 1;
      gains.push(marginalSharedTrain(g, l, owner, loco()));
      const t = g.vehicles.buyTrain(depots[owner === 2 ? 1 : 0], loco(), l.id);
      if (!(t instanceof Train)) throw new Error('fixture train: ' + t);
    }
    console.log(`${shared ? 'shared' : 'private'} annual marginal gains: ${gains.map(Math.round).join(', ')}`);
    check(gains.slice(0, 3).every(x => x > 0) && gains[3] < 0,
      `${shared ? 'shared' : 'private'} extra service pays while space is free, then loses money to its own queues`);
    // The busy fixture's topology/fleet is retained; only its actual fare book is quiet now.
    l.incomeLast = 20_000; delete l.capacity;
    check(marginalSharedTrain(g, l, 1, loco()) < 0, `${shared ? 'shared' : 'private'} low revenue cannot pay for another departure`);
    check(checkReservations(g).length === 0, `${shared ? 'shared' : 'private'} pricing leaves reservations consistent`);
  }
}

/** Replay the saved growth transaction with unrelated AI evaluators held idle. Warm only disposable
 * capacity routes before saving: admission must agree with a freshly loaded topology cache. */
function investmentReplay(api: any, snapshot: string, owner: number, line: number, underloaded = false) {
  const g: Game = api.deserialize(JSON.parse(snapshot)); g.aiEnabled = false;
  const l = g.lines.get(line)!;
  if (underloaded) for (const id of l.vehicles.slice(2)) g.vehicles.sell(id);
  const train = g.vehicles.trains().find(t => t.lineId === line && t.owner === owner)!;
  const price = api.marginalSharedTrain(g, l, owner, train.cars, train.pattern);
  const data = JSON.stringify(api.serialize(g)), loaded: Game = api.deserialize(JSON.parse(data));
  const same = () => JSON.stringify(api.serialize(g)) === JSON.stringify(api.serialize(loaded));
  check(same(), 'pending growth investment saves exactly with a warm capacity route cache');
  check(api.marginalSharedTrain(loaded, loaded.lines.get(line), owner, train.cars, train.pattern) === price,
    'a cold loaded capacity cache prices the next departure identically');
  const before = l.vehicles.length;
  api.networkDaily(g.aiOf(owner)); api.networkDaily(loaded.aiOf(owner));
  check(same(), 'the complete growth purchase sequence, funds and saved observation agree after loading');
  if (underloaded) check(price > 0 && l.vehicles.length > before,
    'the same real city investment buys a profitable departure when its existing fleet has room');
  let exact = same();
  for (let day = 0; day < 60; day++) {
    for (let k = 0; k < g.ticksPerDay; k++) { g.stepTick(); loaded.stepTick(); }
    exact &&= same();
  }
  check(exact, 'the resulting fleet, reservations and accounting replay exactly for 60 days');
  console.log(`saved growth purchase: owner ${owner}, line ${line}, fleet ${before} -> ${l.vehicles.length}, next train ${Math.round(price)}/year`);
}

async function natural() {
  const modulePath = process.argv[process.argv.indexOf('--baseline-module') + 1];
  const api = process.argv.includes('--baseline-module') && modulePath
    ? await import(pathToFileURL(modulePath).href)
    : { Game, serialize, deserialize, networkPlanner, saveNetwork, networkDaily, marginalSharedTrain, checkReservations };
  const g: Game = api.Game.create({ size: 768, seed: 23, towns: Math.round(768 / 42), hilliness: 'hilly', water: 'medium', startYear: 1985,
    aiConfigs: Array.from({ length: 3 }, () => ({ focus: { rail: 2.5, road: 1.2, tram: 0.5 } })) });
  g.aiAcquisitions = false;
  let longest = 0, sustained = 0, active = 0, waiting = 0, purchaseMs = 0, pricedUnits = 0;
  let saved: { data: string; owner: number; line: number } | undefined;
  const batches: { day: number; before: number; after: number }[] = [];
  const waits = new Map<number, number>();
  while (g.day < 9 * 360) {
    const planners = g.ais.filter(ai => api.networkPlanner(ai)?.task === 'extend');
    let pending = false;
    if (planners.length) for (const [owner, state] of api.saveNetwork(g).companies) {
      const job = state.job, item = job?.items?.[job.cursor], c = item?.grow;
      if (job?.task !== 'extend' || !c?.best?.fleet || c.at <= (c.opts?.length ?? 0)) continue;
      pending = true;
      if (!saved) {
        saved = { data: JSON.stringify(api.serialize(g)), owner, line: item.ids[0] };
        console.log(`pending natural investment: day ${g.day}, owner ${owner}, line ${item.ids[0]}`);
        const checkpoint = process.argv.find(a => a.startsWith('--checkpoint='))?.slice(13);
        if (checkpoint) writeFileSync(checkpoint, saved.data);
      }
    }
    const started = pending ? performance.now() : 0;
    const city = [...g.lines.map.values()].find(l => l.owner === 2 && l.kind === 'rail'
      && [...new Set(l.stops.map(s => g.stations.get(s)?.townId))].join(',') === '0');
    const before = city?.vehicles.length ?? 0;
    g.stepTick();
    if (pending) { purchaseMs = Math.max(purchaseMs, performance.now() - started); pricedUnits++; }
    if (pending && city && city.vehicles.length > before) batches.push({ day: g.day, before, after: city.vehicles.length });
    for (const v of g.vehicles.trains()) {
      const towns = [...new Set((v.line?.stops ?? []).map(s => g.stations.get(s)?.townId ?? -1))];
      if (v.owner !== 2 || towns.length !== 1 || towns[0] !== 0 || !v.onMap) { waits.delete(v.id); continue; }
      active += g.tickSeconds;
      if (v.state !== 'waiting') { waits.delete(v.id); continue; }
      const ticks = (waits.get(v.id) ?? 0) + 1, seconds = ticks * g.tickSeconds;
      waits.set(v.id, ticks); waiting += g.tickSeconds; longest = Math.max(longest, seconds);
      if (seconds >= 120 && (ticks - 1) * g.tickSeconds < 120) sustained++;
    }
    if (saved && process.argv.includes('--replay-only')) break;
  }
  console.log(JSON.stringify({ seed: 23, size: 768, years: g.day / 360, cityOwner: 2, town: 0, active, waiting, longest, sustained, batches, purchaseMs, pricedUnits }));
  if (!process.argv.includes('--replay-only')) {
    check(active > 10_000, 'natural retained city service stays in operation');
    check(sustained === 0 && longest < 120, 'natural fleet investment cannot overcrowd the retained city route into sustained holds');
  }
  check(!!saved, 'natural survey exercises a saved fleet-only growth decision');
  if (saved) {
    investmentReplay(api, saved.data, saved.owner, saved.line);
    investmentReplay(api, saved.data, saved.owner, saved.line, true);
  }
  check(!g.ais.some(ai => ai.log.some(s => /error:|network work.*failed/.test(s))), 'natural growth has no AI errors');
  check(api.checkReservations(g).length === 0, 'natural growth reservations stay consistent');
}

if (!process.argv.includes('--natural-only')) fixtures();
if (!process.argv.includes('--fixtures-only')) await natural();
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
