// Initial-track investment, complete connector junctions and replay; --full surveys 5/7/23/51, 512/768, nine years.
// --survey-only skips fixtures; --output <json> records a survey; --compare <json> enforces its base comparison.
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { Train, lineCongestion } from '../src/game/train';
import { initialTrackChoice, layInitialDoubleTrack, type InitialTrackTraffic } from '../src/game/ai-initial-track';
import { lineIsDouble, trackIsDouble, upgradeRoute } from '../src/game/dualtrack';
import { planDoubleTrack, commitDoubleTrack, planConnection, commitConnection, connectStationThroat } from '../src/game/trackops';
import { routeBetween } from '../src/game/ai-network';
import { autoSignalLine } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { station, endNode, nodeSnap, railOpts, build, check, done, depotFor, loco, runTrains } from './stationlib';
import { checkReservations } from './lib';

if (!process.argv[1]?.endsWith('doubleconn.mjs')) throw new Error('bundle as doubleconn.mjs');
const traffic: InitialTrackTraffic = { revenue: 6_000_000, boardings: 120_000, seats: 100_000, trains: 4,
  headway: 180, kmh: 70, blockLength: 280, risk: 0.6 };
function fixture(companies = 1) {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: companies });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++;
  g.company(1).economy.money = 100_000_000;
  const A = station(g, 30, 190, Math.PI / 2, 12, 2, 1)!, B = station(g, 350, 190, Math.PI / 2, 12, 2, 1)!;
  build(g, nodeSnap(g, endNode(g, A, 1, true), 'rail'), nodeSnap(g, endNode(g, B, 1, false), 'rail'), railOpts(1), 'formation');
  const l = g.lines.create('rail', 1); l.stops = [A.id, B.id];
  g.stations.refreshAccess(true); g.lines.rebuild();
  return { g, A, B, l };
}
function fixtures() {
  console.log('Initial track investment');
  check(initialTrackChoice(traffic, 1_000_000, 30_000).double, 'busy forecast repays a pair');
  const light = { ...traffic, revenue: 60_000, boardings: 500, seats: 50_000, trains: 1 };
  check(!initialTrackChoice(light, 1_000_000, 30_000).double, 'light service keeps single track');
  check(!initialTrackChoice(traffic, 100_000_000, 2_000_000).double, 'costly pair without a return remains single');
  const f = fixture(), base = JSON.stringify(serialize(f.g));
  const lightResult = layInitialDoubleTrack(f.g, upgradeRoute(f.g, f.A.id, f.B.id, 1), 1, light, () => true);
  check(!lightResult.built && JSON.stringify(serialize(f.g)) === base, 'uneconomic geometry quote is read-only');
  const built = layInitialDoubleTrack(f.g, upgradeRoute(f.g, f.A.id, f.B.id, 1), 1, traffic, () => true);
  check(built.built && lineIsDouble(f.g, f.l, 1), 'busy formation opens fully double with both platforms connected');
  console.log(`  second rail ${Math.round(built.cost)}, recovered ${Math.round(built.choice?.recovered ?? 0)}/year`);

  console.log('Connector between directional pairs');
  const g = Game.create({ size: 384, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++; g.company(1).economy.money = 1e8;
  const A = station(g, 30, 110, Math.PI / 2, 12, 2, 1)!, B = station(g, 350, 110, Math.PI / 2, 12, 2, 1)!;
  const C = station(g, 30, 230, Math.PI / 2, 12, 2, 1)!, D = station(g, 350, 230, Math.PI / 2, 12, 2, 1)!;
  for (const [x, y] of [[A, B], [C, D]]) {
    build(g, nodeSnap(g, endNode(g, x, 1, true), 'rail'), nodeSnap(g, endNode(g, y, 1, false), 'rail'), railOpts(1), 'trunk');
    const l = g.lines.create('rail', 1); l.stops = [x.id, y.id];
    const r = upgradeRoute(g, x.id, y.id, 1), plans = ([1, -1] as const).map(side => planDoubleTrack(g, r, side, 1));
    const p = plans.find(p => p.ok); check(!!p && !commitDoubleTrack(g, p!).error, 'fixture trunk is directional double');
    autoSignalLine(g, l.id, 1);
    check(!!routeBetween(g, x.id, y.id, 1) && !!routeBetween(g, y.id, x.id, 1), 'fixture trunk works in both directions');
  }
  const net = g.world.net, source = routeBetween(g, A.id, B.id, 1)!, target = routeBetween(g, C.id, D.id, 1)!;
  const a = net.nearestEdge(120, 110, 2, 'rail', e => source.includes(e.id))!, b = net.nearestEdge(235, 230, 2, 'rail', e => target.includes(e.id))!;
  const conn = planConnection(g, a.edge.id, a.s, b.edge.id, b.s, 1, { dirA: 1, dirB: 1, junctionUpgrade: true });
  check(conn.ok, `through connector fits (${conn.error ?? 'ok'})`);
  if (conn.ok) {
    const result = commitConnection(g, conn, { signals: false });
    check(!result.error, 'single connector formation built before service');
    check(([1, -1] as const).some(side => { const p = planDoubleTrack(g, result.edges, side, 1); return p.ok && p.start.kind === 'track' && p.end.kind === 'track'; }), 'connector plan supplies companion junction leads at both ends');
    const twin = layInitialDoubleTrack(g, result.edges, 1, { ...traffic, blockLength: 280, junctionTraffic: 0.005 }, () => true);
    const through = g.lines.create('rail', 1); through.stops = [A.id, D.id];
    autoSignalLine(g, through.id, 1);
    check(twin.built, 'busy through connector pays for a second rail');
    check(result.edges.filter(id => net.edges.has(id)).every(id => trackIsDouble(g, id, 1)), 'whole connector has a companion rail');
    check(!!routeBetween(g, A.id, D.id, 1) && !!routeBetween(g, D.id, A.id, 1), 'double endpoint junctions carry through service both ways');
    const depot = depotFor(g, A, D, 1), trains: Train[] = [];
    for (let i = 0; i < 4; i++) { const train = g.vehicles.buyTrain(depot, loco(), through.id); if (typeof train !== 'string') trains.push(train); }
    const running = runTrains(g, trains, 720);
    console.log(`  through arrivals ${trains.map(t => running.arrivals.get(t.id)?.length ?? 0).join('/')}, longest hold ${running.worst.days} days`);
    check(trains.length === 4 && trains.every(t => (running.arrivals.get(t.id)?.length ?? 0) >= 6), 'opening through fleet repeatedly uses both companion junctions');
    check(running.worst.days < 30 && checkReservations(g).length === 0, 'double connector runs without persistent holds or reservation leaks');
  }

  console.log('Access and protected titles');
  const shared = fixture(2), sharedEdges = upgradeRoute(shared.g, shared.A.id, shared.B.id, 1);
  for (const id of sharedEdges) shared.g.world.net.edges.get(id)!.owner = 2;
  shared.g.setAccessPolicy(2, 'ask');
  const deniedSave = JSON.stringify(serialize(shared.g));
  check(!layInitialDoubleTrack(shared.g, sharedEdges, 1, traffic, () => true).built
    && JSON.stringify(serialize(shared.g)) === deniedSave, 'no-access pair request leaves the partner formation unchanged');
  shared.g.setAccessPolicy(2, 'auto-approve'); shared.g.requestAccess(1, 2);
  const paid = layInitialDoubleTrack(shared.g, sharedEdges, 1, traffic, () => true);
  const longest = paid.edges.map(id => shared.g.world.net.edges.get(id)!).sort((a, b) => b.len - a.len)[0];
  check(paid.built && longest?.owner === 2, 'access-funded pair preserves the partner trunk title');
  const player = fixture(), protectedEdges = upgradeRoute(player.g, player.A.id, player.B.id, 1);
  for (const id of protectedEdges) player.g.world.net.edges.get(id)!.owner = 0;
  player.g.setAccessPolicy(0, 'auto-approve'); player.g.requestAccess(1, 0);
  const protectedSave = JSON.stringify(serialize(player.g));
  check(!layInitialDoubleTrack(player.g, protectedEdges, 1, traffic, () => true).built
    && JSON.stringify(serialize(player.g)) === protectedSave, 'accessible player formation stays untouched');
  const deniedConnection = planConnection(player.g, protectedEdges[0], 40, protectedEdges[0], 80, 1, { junctionUpgrade: true });
  check(!deniedConnection.ok && /player|access/i.test(deniedConnection.error ?? '')
    && JSON.stringify(serialize(player.g)) === protectedSave, 'junction-upgrade flag cannot bypass protected player rail');

  console.log('Save at the initial-build boundary');
  const original = fixture(), snap = JSON.stringify(serialize(original.g)), loaded = deserialize(JSON.parse(snap));
  const same = (a: Game, b: Game, label: string) => {
    const x = JSON.stringify(serialize(a)), y = JSON.stringify(serialize(b));
    if (x !== y) { let at = 0; while (x[at] === y[at]) at++; console.log(`  differs at ${at}: ${x.slice(at - 60, at + 160)} / ${y.slice(at - 60, at + 160)}`); }
    check(x === y, label);
  };
  same(original.g, loaded, 'part-built single formation round trips exactly');
  for (const world of [original.g, loaded]) {
    layInitialDoubleTrack(world, upgradeRoute(world, original.A.id, original.B.id, 1), 1, traffic, () => true);
    connectStationThroat(world, original.A.id, 1); connectStationThroat(world, original.B.id, 1);
  }
  same(original.g, loaded, 'next atomic double-build decision replays exactly');
  for (let i = 0; i < 80; i++) { original.g.stepTick(); loaded.stepTick(); }
  same(original.g, loaded, 'post-build fixed ticks remain identical');
}

interface Survey { seed: number; size: number; years: number; doubleShare: number; congestion: number; held: number;
  profit: number; operatingNet: number; revenue: number; capital: number; fees: number; railProfit: number; lines: number; trains: number; pairWorks: number }
async function surveys() {
  // A baseline bundle can export its own Game and counters, retaining class identity and its exact AI code.
  const baselinePath = process.argv[process.argv.indexOf('--baseline-module') + 1];
  const baseline = process.argv.includes('--baseline-module') && baselinePath ? await import(pathToFileURL(baselinePath).href) : null;
  const Model = baseline?.Game ?? Game, congestionOf = baseline?.lineCongestion ?? lineCongestion, doubleOf = baseline?.trackIsDouble ?? trackIsDouble;
  const full = process.argv.includes('--full');
  const seeds = (process.argv.find(a => a.startsWith('--seeds='))?.split('=')[1] ?? (full ? '5,7,23,51' : '5,7')).split(',').map(Number);
  const sizes = (process.argv.find(a => a.startsWith('--sizes='))?.split('=')[1] ?? (full ? '512,768' : '512')).split(',').map(Number);
  const years = Number(process.argv.find(a => a.startsWith('--years='))?.split('=')[1] ?? (full ? 9 : 3));
  const out: Survey[] = [];
  for (const size of sizes) for (const seed of seeds) {
    const start = performance.now();
    const g: Game = Model.create({ size, seed, towns: Math.round(size / 42), hilliness: 'hilly', water: 'medium', startYear: 1985,
      aiConfigs: Array.from({ length: 3 }, () => ({ focus: { rail: 2.5, road: 1.2, tram: 0.5 } })) });
    g.aiAcquisitions = false;
    let next = 30, congestion = 0, held = 0;
    while (g.day < years * 360) {
      g.stepTick();
      if (g.day >= next) {
        for (const l of g.lines.all()) if (l.kind === 'rail' && l.owner > 0) congestion += Number(congestionOf(g, l.id).level > 0);
        for (const v of g.vehicles.all()) if (v.kind === 'train' && v.owner > 0 && v.state === 'waiting') held++;
        next += 30;
      }
    }
    const rails = [...g.world.net.edges.values()].filter(e => e.kind === 'rail' && e.owner > 0 && e.station < 0 && e.depot < 0);
    const length = rails.reduce((n, e) => n + e.len, 0), double = rails.reduce((n, e) => n + (doubleOf(g, e.id, e.owner) ? e.len : 0), 0);
    const records = g.ais.map(ai => { const e = g.company(ai.companyId).economy; return e.yearTotals.at(-1)?.v ?? e.thisYear; });
    const sum = (keys: (keyof (typeof records)[number])[]) => records.reduce((n, v) => n + keys.reduce((n, k) => n + (v[k] ?? 0), 0), 0);
    const revenue = sum(['income', 'mailIncome', 'trackIncome']), fees = sum(['trackFees']);
    const result = { seed, size, years, doubleShare: double / Math.max(1, length), congestion, held,
      profit: g.ais.reduce((n, ai) => n + g.company(ai.companyId).economy.lastYearProfit, 0),
      revenue, fees, capital: -sum(['construction', 'vehicles']),
      operatingNet: revenue + sum(['running', 'crew', 'energy', 'vehicleMaint', 'maintenance', 'trackWear', 'trackFees', 'interest']),
      railProfit: g.ais.reduce((n, ai) => n + ai.railPolicy.save().accounts.reduce((n: number, x: any) => n + x[1].lastProfit, 0), 0),
      lines: g.lines.all().filter(l => l.kind === 'rail' && l.owner > 0).length,
      trains: g.vehicles.trains().filter(t => t.owner > 0).length,
      pairWorks: g.ais.reduce((n, ai) => n + ai.stats.doubled, 0) };
    out.push(result); console.log(`SURVEY ${JSON.stringify(result)} (${((performance.now() - start) / 1000).toFixed(1)}s)`);
    check(!g.ais.some(ai => ai.log.some(s => /error:|network work.*failed/.test(s))), 'survey has no AI errors');
  }
  const output = process.argv[process.argv.indexOf('--output') + 1];
  if (process.argv.includes('--output') && output) writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
  const compare = process.argv[process.argv.indexOf('--compare') + 1];
  if (process.argv.includes('--compare') && compare) {
    const base = JSON.parse(readFileSync(compare, 'utf8')) as Survey[];
    check(base.length === out.length && base.every((s, i) => s.seed === out[i].seed && s.size === out[i].size && s.years === out[i].years), 'survey matches baseline worlds');
    const sum = (a: Survey[], k: 'congestion' | 'held' | 'profit' | 'operatingNet') => a.reduce((n, s) => n + s[k], 0);
    check(sum(out, 'congestion') <= sum(base, 'congestion'), 'natural-map congestion events do not increase');
    check(sum(out, 'held') <= sum(base, 'held'), 'natural-map held trains do not increase');
    check(sum(out, 'profit') >= sum(base, 'profit'), 'natural-map AI profits do not fall');
    if (base.every(s => Number.isFinite(s.operatingNet))) check(sum(out, 'operatingNet') >= sum(base, 'operatingNet'), 'natural-map operating net including fees and interest does not fall');
    console.log(`COMPARE congestion ${sum(base, 'congestion')} -> ${sum(out, 'congestion')}; held ${sum(base, 'held')} -> ${sum(out, 'held')}; profit ${sum(base, 'profit')} -> ${sum(out, 'profit')}`);
  }
}
if (!process.argv.includes('--survey-only')) fixtures();
if (!process.argv.includes('--fixtures-only')) await surveys();
done();
