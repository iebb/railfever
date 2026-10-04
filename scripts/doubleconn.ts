// Initial-track investment, complete connector junctions and replay; --full surveys 5/7/23/51, 512/768, nine years.
// --survey-only skips fixtures; --output <json> records a survey; --compare <json> enforces its base comparison.
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { Train, lineCongestion, depotServes } from '../src/game/train';
import { initialTrackChoice, layInitialDoubleTrack, type InitialTrackTraffic } from '../src/game/ai-initial-track';
import { lineIsDouble, trackIsDouble, upgradeRoute } from '../src/game/dualtrack';
import { planDoubleTrack, commitDoubleTrack, planConnection, commitConnection, connectStationThroat } from '../src/game/trackops';
import { buildDepotOnLine } from '../src/game/routing';
import { routeBetween, saveNetwork, networkPlanner } from '../src/game/ai-network';
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

  openingCleanup();
  openingDirections();
  failedOpening();

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
  midconnectReplay();
}

/** A registered draft is cleaned up; a usable opening is kept even before the first train purchase. */
function openingCleanup() {
  console.log('Interrupted railway openings');
  const draft = fixture(), ai = draft.g.ais[0] as any;
  ai.lines.set(draft.l.id, { kind: 'rail', towns: [], depot: -1, maxVehicles: 2, opened: draft.g.day });
  const project = { kind: 'rail', towns: [], line: draft.l.id, started: draft.g.day,
    edges: upgradeRoute(draft.g, draft.A.id, draft.B.id, 1), stations: [draft.A.id, draft.B.id], depots: [] };
  ai.abandon(project);
  check(!draft.g.lines.get(draft.l.id) && !ai.lines.has(draft.l.id)
    && !draft.g.stations.get(draft.A.id) && !draft.g.stations.get(draft.B.id),
    'failed depot draft leaves no empty managed line or unfinished stations');

  const ready = fixture(); connectStationThroat(ready.g, ready.A.id, 1); connectStationThroat(ready.g, ready.B.id, 1);
  const dp = depotFor(ready.g, ready.A, ready.B, 1), owner = ready.g.ais[0] as any;
  check(dp >= 0 && depotServes(ready.g, ready.g.depots.get(dp)!, ready.A.id, ready.B.id) >= 0,
    'completed opening has a depot that actually serves both stops');
  owner.abandon({ kind: 'rail', towns: [], line: ready.l.id, started: ready.g.day,
    edges: upgradeRoute(ready.g, ready.A.id, ready.B.id, 1), stations: [ready.A.id, ready.B.id], depots: [dp] });
  check(!!ready.g.lines.get(ready.l.id) && !!ready.g.depots.get(dp) && ready.l.vehicles.length === 0,
    'completed opening with only project depot provenance survives before its first train');
  owner.lines.set(ready.l.id, { kind: 'rail', towns: [], depot: dp, maxVehicles: 2, opened: ready.g.day });
  owner.abandon({ kind: 'rail', towns: [], line: ready.l.id, started: ready.g.day, edges: [], stations: [], depots: [] });
  check(!!ready.g.lines.get(ready.l.id) && !!ready.g.depots.get(dp), 'managed completed opening also survives interruption');
  const train = ready.g.vehicles.buyTrain(dp, loco(), ready.l.id);
  check(typeof train !== 'string', 'retained opening can buy and dispatch its first train');
  owner.lines.delete(ready.l.id);
  owner.abandon({ kind: 'rail', towns: [], line: ready.l.id, started: ready.g.day, edges: [], stations: [], depots: [] });
  check(!!ready.g.lines.get(ready.l.id) && typeof train !== 'string' && !!ready.g.vehicles.get(train.id),
    'an existing running service survives even without draft depot metadata');
}

/** The paid pair must retain an interior depot's actual departure direction on either side. */
function openingDirections() {
  console.log('Directional opening depots');
  for (const dir of [1, -1] as const) {
    const f = fixture(), route = upgradeRoute(f.g, f.A.id, f.B.id, 1), e = f.g.world.net.edges.get(route[0])!;
    const depot = buildDepotOnLine(f.g, e.id, e.len / 2, 1, { dir, side: -1 });
    check(depot >= 0 && depotServes(f.g, f.g.depots.get(depot)!, f.A.id, f.B.id) >= 0,
      `single opening depot serves both stops (${dir})`);
    const blocked = fixture(), edge = blocked.g.world.net.edges.get(upgradeRoute(blocked.g, blocked.A.id, blocked.B.id, 1)[0])!;
    const yard = f.g.depots.get(depot)!, reserved: { x: number; z: number }[] = [];
    // A planned corridor across every outside-yard alternative must veto siting before any paid work.
    for (let dx = -3; dx <= 3; dx += 0.5) for (let dz = -3; dz <= 3; dz += 0.5)
      reserved.push({ x: yard.x + dx, z: yard.z + dz });
    const empty = JSON.stringify(serialize(blocked.g));
    check(buildDepotOnLine(blocked.g, edge.id, edge.len / 2, 1, { dir, side: -1, reserved }) < 0
      && JSON.stringify(serialize(blocked.g)) === empty,
      `reserved companion corridor vetoes the depot before any branch is committed (${dir})`);
    const current = upgradeRoute(f.g, f.A.id, f.B.id, 1), ai = f.g.ais[0] as any;
    const preserve = (plan: ReturnType<typeof planDoubleTrack>) => ai.initialPairDepot(plan, depot, f.A.id, f.B.id);
    const plans = ([1, -1] as const).map(side => planDoubleTrack(f.g, current, side, 1));
    check(plans.some(p => p.ok && preserve(p)), `a complete candidate retains depot departure (${dir})`);
    const before = JSON.stringify(serialize(f.g));
    let deniedFunds = 0;
    const denied = layInitialDoubleTrack(f.g, current, 1, traffic, () => { deniedFunds++; return true; }, undefined, () => false);
    check(!denied.built && deniedFunds === 0 && JSON.stringify(serialize(f.g)) === before,
      `rejected depot directions pay nothing and leave the formation unchanged (${dir})`);
    let funded = 0;
    const built = layInitialDoubleTrack(f.g, current, 1, traffic, () => { funded++; return true; }, undefined, preserve);
    check(built.built && funded === 1 && depotServes(f.g, f.g.depots.get(depot)!, f.A.id, f.B.id) >= 0,
      `funded complete pair preserves the interior depot (${dir})`);
    check(lineIsDouble(f.g, f.l, 1) && !!routeBetween(f.g, f.A.id, f.B.id, 1) && !!routeBetween(f.g, f.B.id, f.A.id, 1),
      `depot-aware opening keeps both station routes and the full companion (${dir})`);
  }
}

/** Exercise the real opening job when no depot builder can supply a usable site. */
function failedOpening() {
  const g = Game.create({ size: 512, seed: 11, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  g.aiAcquisitions = false;
  const ai = g.ais[0] as any;
  ai.depotNearLine = ai.depotSwitch = function* () { return -1; };
  while (g.day < 720 && !ai.log.some((text: string) => text.includes('abandoned: no depot site that serves both stations'))) g.stepTick();
  check(ai.log.some((text: string) => text.includes('abandoned: no depot site that serves both stations')),
    'natural railway job reaches a failed depot opening');
  check(ai.stats.doubled === 0 && ![...ai.lines.values()].some((info: any) => info.kind === 'rail')
    && !g.lines.all().some(l => l.owner === ai.companyId && l.kind === 'rail'),
    'failed depot opening pays no initial pair and retains no phantom railway');
}

/** Observe actual funded AI openings, without constraining generic shared-service connector works. */
function openingObserver(g: Game) {
  let funded = 0, viable = true, failed = 0, cleaned = true, normalized = true;
  const pending: number[] = [];
  for (const controller of g.ais) {
    const ai = controller as any, note = ai.note.bind(ai);
    ai.note = (text: string) => {
      if (text.includes('double from opening')) {
        funded++;
        const line = g.lines.get(ai.project?.line ?? -1), info = ai.lines.get(line?.id ?? -1);
        const depot = g.depots.get(info?.depot ?? -1), stops = [...new Set<number>(line?.stops ?? [])];
        const okay = !!line && !line.vehicles.length && !!depot && depot.owner === ai.companyId
          && stops.length === 2 && depotServes(g, depot, stops[0], stops[1]) >= 0
          && stops.every(id => { const st = g.stations.get(id); return !!st && g.stations.hasAccess(st); });
        viable &&= okay;
        const saved = serialize(g), loaded = deserialize(JSON.parse(JSON.stringify(saved)));
        normalized &&= JSON.stringify(saved.lines) === JSON.stringify(serialize(loaded).lines);
        if (!okay) console.log(`  opening diagnostic ${JSON.stringify({ day: g.day, owner: ai.companyId, text, line: line?.id, depot: info?.depot, first: depot ? depotServes(g, depot, stops[0], stops[1]) : -1, access: stops.map(id => { const st=g.stations.get(id); return st && g.stations.hasAccess(st); }) })}`);
      }
      if (text.includes('abandoned: no depot site') || text.includes('abandoned: depot no longer serves')) {
        failed++;
        if (ai.project?.line >= 0) pending.push(ai.project.line);
      }
      note(text);
    };
  }
  return {
    tick() { for (const id of pending.splice(0)) cleaned &&= !g.lines.get(id) && !g.ais.some(ai => ai.lines.has(id)); },
    verdict(label: string) {
      check(viable, `${label}: every funded initial pair has a serving own depot and accessible stops before trains`);
      check(cleaned, `${label}: failed depot openings leave no draft service to upgrade`);
      check(normalized, `${label}: line metadata round trips before the first train purchase`);
      console.log(`  ${label}: ${funded} funded pairs, ${failed} failed depot openings`);
      return funded;
    },
  };
}

/** Target the two naturally generated worlds which previously paid for phantom initial pairs. */
function openingNatural() {
  let funded = 0;
  for (const [size, seed] of [[512, 11], [768, 51]]) {
    const g = Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
    g.aiAcquisitions = false;
    const observation = openingObserver(g);
    while (g.day < 720) { g.stepTick(); observation.tick(); }
    funded += observation.verdict(`natural ${size}/${seed}`);
    console.log(`  books ${g.ais.map(ai => { const e = g.company(ai.companyId).economy; return `${ai.companyId}: ${Math.round(e.money)} cash/${e.loan} debt`; }).join('; ')}`);
    check(!g.ais.some(ai => ai.log.some(s => /error:/.test(s))), `${size}/${seed}: no AI errors`);
  }
  check(funded > 0, 'affected natural worlds exercise funded initial-pair decisions');
}

/** A pending curve-search cursor survives saving through its completion, with normal train traffic. */
function midconnectReplay() {
  const g = Game.create({ size: 512, seed: 23, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  g.aiAcquisitions = false;
  const observation = openingObserver(g);
  let saved = false;
  while (g.day < 1200) {
    g.stepTick(); observation.tick();
    const idle = g.ais.every(ai => !(ai as any).job && !(ai as any).project);
    if (idle && g.ais.some(ai => networkPlanner(ai)?.task === 'midconnect')
      && saveNetwork(g).companies.some(([, state]) => state.job?.items?.some(i => i.midconnect))) { saved = true; break; }
  }
  observation.verdict('midconnect natural opening');
  check(saved, 'natural map exercises a saved midconnect search without unrelated construction');
  if (!saved) return;
  const requests = saveNetwork(g).companies.flatMap(([owner, state]) => (state.job?.items ?? [])
    .filter(i => i.midconnect).map(i => ({ owner, key: i.ids.join(':'), initial: { ...i.midconnect! }, retired: -1 })));
  const subsequent = new Map<string, { owner: number; key: string; tick: number; initial: unknown }>();
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  const snapshot = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(snapshot));
  let exact = JSON.stringify(serialize(loaded)) === snapshot;
  const day = g.day;
  for (let i = 0; i < 640 && exact; i++) {
    g.stepTick(); loaded.stepTick();
    exact = JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded));
    const pending = saveNetwork(g).companies.flatMap(([owner, state]) => (state.job?.items ?? [])
      .filter(item => item.midconnect).map(item => ({ owner, key: item.ids.join(':'), initial: item.midconnect })));
    for (const request of requests) if (request.retired < 0 && !pending.some(p => p.owner === request.owner && p.key === request.key))
      request.retired = i + 1;
    for (const p of pending) if (!requests.some(r => r.retired < 0 && p.owner === r.owner && p.key === r.key)) {
      const key = `${p.owner}/${p.key}`;
      if (!subsequent.has(key)) subsequent.set(key, { ...p, tick: i + 1 });
    }
  }
  // Other companies may begin a new search during replay; completion belongs to the saved requests.
  check(exact && requests.every(r => r.retired >= 0),
    'saved midconnect search completes with exact replay of 640 fixed ticks');
  console.log(`  saved midconnect requests ${JSON.stringify(requests)}`);
  if (subsequent.size) console.log(`  subsequent midconnect requests ${JSON.stringify([...subsequent.values()])}`);
  console.log(`  midconnect replay ${day} -> ${g.day}, exact ${exact}`);
}

interface Survey { seed: number; size: number; years: number; doubleShare: number; congestion: number; held: number;
  profit: number; operatingNet: number; revenue: number; capital: number; fees: number; railProfit: number; lines: number; trains: number; pairWorks: number;
  sustainedHeld: number; waitingSeconds: number; activeTrainSeconds: number; longestWait: number;
  services: Record<string, { waitingSeconds: number; activeTrainSeconds: number; longestWait: number; sustainedHeld: number }> }
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
    let next = 30, congestion = 0, held = 0, sustainedHeld = 0, waitingSeconds = 0, activeTrainSeconds = 0, longestWait = 0;
    const waitTicks = new Map<number, number>(), services: Survey['services'] = {};
    const serviceKey = (v: Train) => `${v.owner}:` + [...new Set((v.line?.stops ?? []).map(sid => g.stations.get(sid)?.townId ?? -1))].sort((a, b) => a - b).join(',');
    while (g.day < years * 360) {
      g.stepTick();
      for (const v of g.vehicles.trains()) {
        if (v.owner <= 0 || !v.onMap) { waitTicks.delete(v.id); continue; }
        const key = serviceKey(v), service = services[key] ??= { waitingSeconds: 0, activeTrainSeconds: 0, longestWait: 0, sustainedHeld: 0 };
        activeTrainSeconds += g.tickSeconds; service.activeTrainSeconds += g.tickSeconds;
        if (v.state === 'waiting') {
          const ticks = (waitTicks.get(v.id) ?? 0) + 1, seconds = ticks * g.tickSeconds;
          waitTicks.set(v.id, ticks); waitingSeconds += g.tickSeconds; service.waitingSeconds += g.tickSeconds;
          // Count each sustained hold once when it crosses two minutes, including holds between samples.
          if (seconds >= 120 && (ticks - 1) * g.tickSeconds < 120) { sustainedHeld++; service.sustainedHeld++; }
          longestWait = Math.max(longestWait, seconds); service.longestWait = Math.max(service.longestWait, seconds);
        } else waitTicks.delete(v.id);
      }
      if (g.day >= next) {
        for (const l of g.lines.all()) if (l.kind === 'rail' && l.owner > 0) congestion += Number(congestionOf(g, l.id).level > 0);
        for (const v of g.vehicles.trains()) if (v.owner > 0 && v.state === 'waiting') {
          held++;
        }
        next += 30;
      }
    }
    const rails = [...g.world.net.edges.values()].filter(e => e.kind === 'rail' && e.owner > 0 && e.station < 0 && e.depot < 0);
    const length = rails.reduce((n, e) => n + e.len, 0), double = rails.reduce((n, e) => n + (doubleOf(g, e.id, e.owner) ? e.len : 0), 0);
    const records = g.ais.map(ai => { const e = g.company(ai.companyId).economy; return e.yearTotals.at(-1)?.v ?? e.thisYear; });
    const sum = (keys: (keyof (typeof records)[number])[]) => records.reduce((n, v) => n + keys.reduce((n, k) => n + (v[k] ?? 0), 0), 0);
    const revenue = sum(['income', 'mailIncome', 'trackIncome']), fees = sum(['trackFees']);
    const result = { seed, size, years, doubleShare: double / Math.max(1, length), congestion, held,
      sustainedHeld, waitingSeconds, activeTrainSeconds, longestWait, services,
      // Retain the legacy field for comparison files: this is annual cashflow, including capital purchases.
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
    const sum = (a: Survey[], k: 'congestion' | 'held' | 'profit' | 'operatingNet' | 'sustainedHeld' | 'waitingSeconds' | 'activeTrainSeconds' | 'capital' | 'revenue') => a.reduce((n, s) => n + s[k], 0);
    check(sum(out, 'congestion') <= sum(base, 'congestion'), 'natural-map congestion events do not increase');
    check(sum(out, 'held') <= sum(base, 'held'), 'natural-map raw held-train samples do not increase');
    check(base.every(s => Number.isFinite(s.sustainedHeld)), 'baseline measures sustained waits');
    check(sum(out, 'sustainedHeld') <= sum(base, 'sustainedHeld'), 'natural-map held trains over 120 seconds do not increase');
    const waitingShare = (a: Survey[]) => sum(a, 'waitingSeconds') / Math.max(1, sum(a, 'activeTrainSeconds'));
    check(waitingShare(out) <= waitingShare(base), 'natural-map waiting duration per active train time does not increase');
    const retained: { old: Survey['services'][string]; now: Survey['services'][string] }[] = [];
    const share = (s: Survey['services'][string]) => s.waitingSeconds / Math.max(1, s.activeTrainSeconds);
    for (let i = 0; i < out.length; i++) {
      const world = `${out[i].seed}/${out[i].size}`;
      for (const [key, old] of Object.entries(base[i].services ?? {})) {
        const now = out[i].services[key];
        if (now) {
          retained.push({ old, now });
          console.log(`COHORT ${world} ${key}: waiting seconds ${old.waitingSeconds} -> ${now.waitingSeconds}; share ${share(old)} -> ${share(now)}; sustained ${old.sustainedHeld} -> ${now.sustainedHeld}; longest ${old.longestWait} -> ${now.longestWait}`);
        } else console.log(`ABSENT ${world} baseline service ${key}: ${JSON.stringify(old)}`);
      }
      for (const [key, now] of Object.entries(out[i].services)) if (!base[i].services?.[key])
        console.log(`ADDED ${world} service ${key}: ${JSON.stringify(now)}; waiting share ${share(now)}`);
    }
    check(retained.every(s => s.now.sustainedHeld <= s.old.sustainedHeld), 'retained services do not gain sustained holds');
    check(base.every(s => Number.isFinite(s.operatingNet)), 'baseline measures actual annual operating net');
    check(sum(out, 'operatingNet') >= sum(base, 'operatingNet'), 'natural-map operating profit including fees and interest does not fall');
    console.log(`ECONOMY receipts ${sum(base, 'revenue')} -> ${sum(out, 'revenue')}; operating profit ${sum(base, 'operatingNet')} -> ${sum(out, 'operatingNet')}; capital ${sum(base, 'capital')} -> ${sum(out, 'capital')}; cashflow ${sum(base, 'profit')} -> ${sum(out, 'profit')} (${sum(out, 'profit') < sum(base, 'profit') ? 'original cashflow gate failed' : 'cashflow did not fall'})`);
    console.log(`COMPARE congestion ${sum(base, 'congestion')} -> ${sum(out, 'congestion')}; raw held ${sum(base, 'held')} -> ${sum(out, 'held')} (${sum(out, 'held') > sum(base, 'held') ? 'original raw-count gate failed' : 'raw count did not increase'}); sustained ${sum(base, 'sustainedHeld')} -> ${sum(out, 'sustainedHeld')}; waiting share ${waitingShare(base)} -> ${waitingShare(out)}; cashflow ${sum(base, 'profit')} -> ${sum(out, 'profit')}`);
  }
}
if (process.argv.includes('--opening-failure-only')) failedOpening();
else if (process.argv.includes('--opening-only')) openingNatural();
else if (!process.argv.includes('--survey-only')) fixtures();
if (!process.argv.includes('--fixtures-only') && !process.argv.includes('--opening-only') && !process.argv.includes('--opening-failure-only')) await surveys();
done();
