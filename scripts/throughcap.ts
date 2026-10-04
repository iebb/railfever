// Shared-corridor capacity audit. Bundle as throughcap.mjs and run from the scratch directory.
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { Train, deadlockCycles } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { check, fails, checkReservations } from './lib';
import { flatGame, station, endNode, build, railOpts, nodeSnap, loco, depotFor } from './stationlib';
import { connectStationThroat } from '../src/game/trackops';
import { sharedCapacityPlan, sharedTrainAllowed, marginalSharedTrain, observeRailCapacity, sharedUpgradeReturn, observedCapacityAgreement } from '../src/game/ai-capacity';
import { relieveSharedCapacity, sharedCapacityWork } from '../src/game/ai-capacity-works';
import { sharedRailSpacing } from '../src/game/rail-headways';
import { capacityRouteBetween } from '../src/game/rail-capacity-routes';
import { holdForSpacing, noteSpacingDeparture, patternOf } from '../src/game/patterns';
import { makeSeg } from '../src/game/train';

if (!process.argv[1]?.endsWith('throughcap.mjs')) throw new Error('bundle this test as throughcap.mjs');

// Recorded against unmodified a172141 sources (8 fixed-step years, all passenger/mail receipts in company books).
const reference = { commit: 'a172141', years: 8, revenue: 37_147_019, delivered: 9015,
  samples: 40_552, held120Share: 0.3070871966857368, longestHold: 5282.600000010452, deadlocks: 0 };

function fixture(revenue = 12_000_000, trains = 2) {
  const g = flatGame(256); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  for (let i = 0; i < 2; i++) g.addAICompany({ startMoney: 50_000_000, focus: { rail: 3, road: 0, tram: 0 } });
  const A = station(g, 20, 128, Math.PI / 2, 10, 2, 1)!, B = station(g, 236, 128, Math.PI / 2, 10, 2, 2)!;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(1));
  for (const st of [A, B]) connectStationThroat(g, st.id, st.owner);
  const depots = [depotFor(g, A, B, 1), depotFor(g, B, A, 2)];
  const l = g.lines.create('rail', 1); l.stops = [A.id, B.id]; g.lines.invite(l.id, 2); g.lines.rebuild();
  const ts: Train[] = [];
  for (let i = 0; i < trains; i++) {
    const owner = i ? 2 : 1, t = g.vehicles.buyTrain(depots[owner - 1], loco(), l.id);
    if (!(t instanceof Train)) throw new Error('capacity fixture train: ' + t);
    ts.push(t);
  }
  l.incomeLast = revenue; l.passLast = Math.round(revenue / 5000 / 12);
  observeRailCapacity(g);
  return { g, l, ts, depots, A, B };
}

function replay(g: Game, label: string, ticks = 1200) {
  const json = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(json));
  check(JSON.stringify(serialize(loaded)) === json, `${label}: exact save/load round trip`);
  for (let i = 0; i < ticks; i++) { g.stepTick(); loaded.stepTick(); }
  const a = JSON.stringify(serialize(g)), b = JSON.stringify(serialize(loaded));
  if (a !== b) {
    let at = 0; while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
    console.log(`  replay mismatch at ${at}: ${a.slice(Math.max(0, at - 80), at + 150)} / ${b.slice(Math.max(0, at - 80), at + 150)}`);
  }
  check(a === b, `${label}: exact ${ticks}-tick continuation`);
}

function fixtures() {
  console.log('two-operator single track, economic withdrawal and admission');
  const { g, l, ts } = fixture();
  check(!!capacityRouteBetween(g, l.stops[1], l.stops[0], 2), 'open access has a usable partner corridor');
  g.aiOf(1)!.config.accessPolicy = 'ask'; g.refreshAccess();
  check(!capacityRouteBetween(g, l.stops[1], l.stops[0], 2), 'direct access-policy edits invalidate the cached corridor');
  g.aiOf(1)!.config.accessPolicy = 'open'; g.refreshAccess();
  for (let i = 0; i < 12; i++) {
    const plan = sharedCapacityPlan(g, l);
    const bid = plan.allocations.find(a => a.trains > l.vehicles.filter(id => g.vehicles.get(id)?.owner === a.owner).length);
    if (!bid || !sharedTrainAllowed(g, l, bid.owner, loco())) break;
    const train = g.vehicles.buyTrain(ts[bid.owner - 1].depotId, loco(), l.id);
    if (!(train instanceof Train)) throw new Error('capacity fixture expansion: ' + train);
    ts.push(train);
  }
  const plan = sharedCapacityPlan(g, l), value = marginalSharedTrain(g, l, 2, loco());
  console.log(`  full plan ${JSON.stringify(plan.allocations)}, physical=${plan.physical}, extra=${Math.round(value)}`);
  check(value < 0 && !sharedTrainAllowed(g, l, 2, loco()), 'second operator declines a train when the shared line is full');
  const extra = g.vehicles.buyTrain((ts[1] as Train).depotId, loco(), l.id) as Train;
  ts[0].delivered = 1000; ts[1].delivered = 1000; extra.delivered = 0;
  l.capacity!.delay = 120; l.capacity!.longest = 150;
  const congested = sharedCapacityPlan(g, l);
  console.log(`  congested plan ${JSON.stringify(congested.allocations)}, withdraw=${JSON.stringify(congested.withdraw)}`);
  check(congested.withdraw[0]?.train === extra.id, 'the least valuable marginal train withdraws first, deterministically');
  const chosen = congested.withdraw[0];
  if (chosen) g.aiOf(chosen.owner)!.daily();
  check(!g.vehicles.get(extra.id), 'the partner withdraws its surplus train despite owning no lead line');
  check(g.vehicles.get(ts[0].id) !== undefined, 'the lead does not bear every congestion cut');
  replay(g, 'shared observations and withdrawal');

  console.log('a profitable shared capacity upgrade, and a declined upgrade');
  for (const pays of [true, false]) {
    const f = fixture(pays ? 30_000_000 : 20_000, 3);
    f.l.capacity!.delay = 100;
    f.g.stations.addWaiting(f.A, f.l.id, f.B.id, f.B.id, 400);
    const before = f.g.world.net.nextEdge;
    const partnerCost = f.g.company(2).economy.current.construction;
    const agreement = sharedCapacityPlan(f.g, f.l), singles = agreement.resources.filter(r => r.kind === 'single');
    const quote = sharedUpgradeReturn(f.g, f.l, singles.map(r => r.id), 2, 2_000_000, 50_000);
    console.log(`  ${pays ? 'busy' : 'quiet'} corridor: recovered ${Math.round(quote.annual)}/year, pays=${quote.pays}`);
    check(quote.pays === pays, `${pays ? 'busy' : 'quiet'} corridor values the construction cost and upkeep`);
    for (let i = 0; i < 3; i++) {
      relieveSharedCapacity(f.g.aiOf(1)!, f.l);
      for (let j = 0; j < 6 && f.l.capacity?.works; j++) sharedCapacityWork(f.g.aiOf(1)!);
      if (i < 2) { f.g.day += 31; f.g.tick += 31 * f.g.ticksPerDay; }
    }
    const newTrack = [...f.g.world.net.edges.values()].filter(e => e.id >= before && e.kind === 'rail' && e.station < 0 && e.depot < 0);
    console.log(`  new plain track ${newTrack.length} edges; logs: ${f.g.aiOf(1)!.log.slice(-4).join(' | ')}`);
    check(pays ? f.g.aiOf(1)!.stats.doubled > 0 : f.g.aiOf(1)!.stats.doubled === 0, `${pays ? 'busy' : 'quiet'} corridor ${pays ? 'builds' : 'declines'} a second track/passing loop`);
    if (pays) check(f.g.company(2).economy.current.construction < partnerCost, 'partners contribute to the capacity that recovers their fares');
  }

  const platforms = fixture(40_000_000, 3);
  platforms.l.capacity!.delay = 200; platforms.l.capacity!.held = 0.8; platforms.l.capacity!.longest = 250;
  const queued = platforms.ts[0]; queued.state = 'waiting'; queued.stuckTime = 150; queued.routeTarget = platforms.A.id;
  queued.pending = [makeSeg(platforms.g, platforms.g.world.net.edges.get(platforms.A.rail!.edges[0])!, 1)];
  // A synthetic report of platform queuing with the platform itself free for the atomic station works.
  relieveSharedCapacity(platforms.g.aiOf(1)!, platforms.l);
  platforms.g.day += 31; platforms.g.tick += 31 * platforms.g.ticksPerDay;
  relieveSharedCapacity(platforms.g.aiOf(1)!, platforms.l);
  check(platforms.A.rail!.tracks > 2, 'profitable platform congestion adds more than two platform tracks');

  console.log('shared headways across separate companies/lines, and saved works');
  const f = fixture();
  const other = f.g.lines.create('rail', 2); other.stops = [...f.l.stops];
  f.ts[1].setLine(other.id);
  const a = sharedRailSpacing(f.g, f.ts[0]), b = sharedRailSpacing(f.g, f.ts[1]);
  check(!!a && !!b && a.clock === b.clock && a.headway === b.headway, 'different companies/lines share the same approach clock and headway');
  f.ts[0].spacing.departureIndex = 0; noteSpacingDeparture(f.g, f.ts[0]);
  f.ts[1].state = 'loading';
  check(holdForSpacing(f.g, f.ts[1]), 'a partner holds for a recent departure on the other line');
  f.ts[1].state = 'depot'; f.ts[1].resetSpacing();
  const resource = sharedCapacityPlan(f.g, f.l).resources.find(r => r.kind === 'single')!;
  f.l.capacity!.works = { day: f.g.day, owner: 1, edges: resource.edges.filter(id => f.g.world.net.edges.get(id)?.owner === 1), side: 1 };
  for (const ai of f.g.ais) ai.state.cooldown = 9999;
  f.g.aiEnabled = true;
  replay(f.g, 'shared headway clock and pending capacity works');
  replay(f.g, 'shared headways with a warm topology cache and trains in service');
  check(checkReservations(f.g).length === 0, 'fixtures: reservations consistent');
}

const baseline = process.argv.includes('--baseline');
const quick = process.argv.includes('--quick');
const years = Number(process.argv.find(a => a.startsWith('--years='))?.slice(8) ?? 8);
const output = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const snapshot = process.argv.find(a => a.startsWith('--snapshot='))?.slice(11);

function scenario() {
  const g = Game.create({ size: 768, towns: 18, hilliness: 'hilly', water: 'medium', startYear: 1950, seed: 2026,
    aiCompanies: 7, aiConfigs: Array.from({ length: 7 }, () => ({ activeness: 1.1, focus: { rail: 3, road: 0, tram: 0 },
      risk: 0.6, startMoney: 50_000_000, accessMultiplier: 1, accessPolicy: 'open' as const })) });
  let revenue = 0, delivered = 0, samples = 0, held120 = 0, longest = 0, deadlocks = 0, longestDeadlock = 0;
  let allSamples = 0, allHeld120 = 0, allLongest = 0;
  let nonRailFleet = false;
  // All earning fleets in this scenario are rail. Company books also retain mail paid to an earlier
  // carrier at somebody else's unloading stop, and receipts of trains sold during the audit.
  const railReceipts = () => g.companies.reduce((total, c) => total + c.economy.yearTotals.reduce((n, y) =>
    n + (y.v.income ?? 0) + (y.v.mailIncome ?? 0), 0) + (c.economy.thisYear.income ?? 0) + (c.economy.thisYear.mailIncome ?? 0), 0);
  const excessSince = new Map<string, number>(); let longestExcess = 0, agreementSamples = 0;
  const yearly: unknown[] = [];
  const update = Train.prototype.update;
  Train.prototype.update = function(dt) {
    const pax = this.delivered;
    update.call(this, dt);
    delivered += Math.max(0, this.delivered - pax);
  };
  const started = performance.now();
  try {
    while (g.day < years * 360) {
      g.stepTick();
      if (g.tick % g.ticksPerDay !== 0) continue;
      nonRailFleet ||= [...g.vehicles.map.values()].some(v => !(v instanceof Train) && v.lineId !== null && (v.capacity > 0 || v.mailCapacity > 0));
      const shared = [...g.lines.map.values()].filter(l => l.kind === 'rail'
        && new Set(l.vehicles.map(id => g.vehicles.get(id)?.owner)).size > 1);
      const through = new Set(shared.flatMap(l => l.vehicles));
      const seenAgreements = new Set<string>();
      if (!baseline) for (const l of g.lines.map.values()) {
        const agreement = observedCapacityAgreement(g, l);
        if (!agreement || agreement.day !== g.day) continue;
        for (const a of agreement.allocations.filter(a => a.line === l.id)) {
          agreementSamples++;
          const actual = l.vehicles.map(id => g.vehicles.get(id)).filter(t => t && t.owner === a.owner && (patternOf(l, t.pattern)?.id ?? 0) === a.pattern).length;
          const key = `${l.id}:${a.owner}:${a.pattern}`;
          seenAgreements.add(key);
          if (actual > a.trains) {
            const since = excessSince.get(key) ?? g.day; excessSince.set(key, since);
            longestExcess = Math.max(longestExcess, g.day - since);
          } else excessSince.delete(key);
        }
      }
      // A withdrawn operator no longer has an active bid. A later new bid starts a new settling period.
      for (const key of excessSince.keys()) if (!seenAgreements.has(key)) excessSince.delete(key);
      for (const t of g.vehicles.map.values()) if (t instanceof Train && t.lineId !== null) {
        allSamples++; allHeld120 += +(t.state === 'waiting' && t.stuckTime > 120);
        allLongest = Math.max(allLongest, t.stuckTime);
        if (!through.has(t.id)) continue;
        samples++; held120 += +(t.state === 'waiting' && t.stuckTime > 120);
        longest = Math.max(longest, t.stuckTime);
      }
      const cycles = deadlockCycles(g, 20);
      if (cycles.length) {
        deadlocks += cycles.length;
        longestDeadlock = Math.max(longestDeadlock, ...cycles.flat().map(t => t.stuckTime));
      }
      if (snapshot && g.day === 720) writeFileSync(snapshot, JSON.stringify(serialize(g)));
      if (g.day % 360 === 0) {
        revenue = railReceipts();
        const trains = [...g.vehicles.map.values()].filter(v => v instanceof Train);
        const entry = { year: g.year, lines: [...g.lines.map.values()].filter(l => l.kind === 'rail').length,
          trains: trains.length, throughLines: shared.length, throughTrains: through.size, revenue: Math.round(revenue),
          delivered, held120Share: samples ? held120 / samples : 0, longestHold: longest,
          deadlocks, longestDeadlock, money: g.companies.slice(1).map(c => Math.round(c.economy.money)) };
        yearly.push(entry); console.log(JSON.stringify(entry));
      }
    }
  } finally { Train.prototype.update = update; }
  revenue = railReceipts();
  const result = { seed: 2026, years, revenue: Math.round(revenue), delivered, samples, held120,
    held120Share: samples ? held120 / samples : 0, longestHold: longest, deadlocks, longestDeadlock,
    allHeld120Share: allSamples ? allHeld120 / allSamples : 0, allLongestHold: allLongest, yearly,
    agreementSamples, longestExcessDays: longestExcess, upgrades: g.ais.reduce((n, ai) => n + ai.stats.doubled, 0),
    seconds: (performance.now() - started) / 1000 };
  console.log(JSON.stringify(result));
  check(samples > 0, '8 companies: through services exercised');
  check(!nonRailFleet, '8 companies: every earning fleet is rail (company fare/mail books measure rail revenue)');
  check(checkReservations(g).length === 0, '8 companies: reservations consistent');
  if (!baseline) {
    // A 2% tail tolerates short construction/route changes; a 240 s maximum rules out multi-year blocking.
    check(held120 / Math.max(1, samples) < 0.02, '8 companies: less than 2% of through train-days held over 120 s');
    check(longest < 240, '8 companies: longest through hold below 240 s (four simulation minutes)');
    check(deadlocks === 0, '8 companies: no mutual-wait deadlocks');
    // Merges can change several contracts at once; the lowest bidder winds down first, one path per day.
    check(agreementSamples > 1000 && longestExcess < 30, '8 companies: all operators settle within the shared plan in less than a month');
    check(allHeld120 / Math.max(1, allSamples) < 0.02 && allLongest < 360, '8 companies: shared track in general has no persistent congestion');
    if (years === reference.years) {
      console.log(`a172141 -> tuned: fares ${reference.revenue} -> ${result.revenue}; >120s ${100 * reference.held120Share}% -> ${100 * result.held120Share}%; longest ${reference.longestHold}s -> ${result.longestHold}s`);
      check(revenue >= reference.revenue, '8 companies: total rail fares do not fall versus a172141');
    }
  }
  return result;
}

if (!baseline) fixtures();
const result = quick ? {} : scenario();
if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(fails.length ? `${fails.length} FAILURES` : baseline ? 'BASELINE RECORDED' : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
