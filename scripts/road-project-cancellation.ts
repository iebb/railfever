// Native paid road cancellation: exact titles, retained incumbents, actual resale and give-up refund policy.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickBus, type AIController } from '../src/game/ai';
import { planTownCandidates, planExtensions, moreValue, roadPlanJob, pays, type BusHost, type RoadPlan } from '../src/game/ai-bus';
import { bezLine } from '../src/game/geom';
import { replaceLineStops } from '../src/game/line-edit';
import { linePatterns, setPatterns, setVehiclePattern } from '../src/game/patterns';

const drain = <T>(job: Generator<void, T>): T => { let r = job.next(); while (!r.done) r = job.next(); return r.value; };
const host = (ai: AIController): BusHost => (ai as unknown as { busHost(): BusHost }).busHost();
type Ledger = { stations: number[]; depots: number[]; line: number; roadLine?: number; roadJoin?: number; roadVehicles?: number[];
  roadStops?: { station: number; x: number; z: number }[]; roadExtension?: { line: number; beforeStops: number[]; afterStops: number[] } };
type NativeAI = { project: Ledger | null; job: Generator<void, void>; watch: { spent: number } | null;
  roadTask: { build: { stage: string; stop?: { before: number; error: string | null } } } | null;
  roadPlanJob(plan: RoadPlan | null, kind: string): Generator<void, void>; cancelJob(): void; giveUpJob(why: string): void };
type Scenario = 'new' | 'extend' | 'join' | 'stop-part' | 'rail-stop-part';
const scenarios: Scenario[] = ['new', 'extend', 'join', 'stop-part', 'rail-stop-part'];

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  function same(a: Game, b: Game, why: string) {
    const x = JSON.stringify(serialize(a)), y = JSON.stringify(serialize(b));
    if (x === y) return;
    let i = 0; while (x[i] === y[i]) i++;
    assert.fail(`${why}: first full-save difference ${i}: ${x.slice(i - 60, i + 140)} / ${y.slice(i - 60, i + 140)}`);
  }
  function start(g: Game, owner: number, plan: RoadPlan, kind: string) {
    const ai = g.aiOf(owner)! as unknown as NativeAI;
    ai.project = { kind, towns: plan.towns, stations: [], edges: [], depots: [], line: -1, started: g.day } as Ledger;
    ai.job = ai.roadPlanJob(plan, kind);
    return ai;
  }
  function partFixture(rail: boolean) {
    const g = Game.create({ size: 128, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 2 });
    g.world.h.fill(4); g.world.heightsVersion++;
    for (const co of g.companies) co.economy.money = 20_000_000;
    for (const ai of g.ais) ai.state.cooldown = 1e9;
    const net = g.world.net, a = net.addNode('road', 20, 4, 60), b = net.addNode('road', 110, 4, 60);
    net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(91).fill(4), [], 'street', -1);
    assert.equal(g.stations.commitBusStop(50, 60, 1), null);
    const incumbent = [...g.stations.map.values()][0];
    if (rail) {
      const p = g.stations.planRail(50, 66, Math.PI / 2, 8, 1, 1);
      assert(p.ok, p.error); assert.equal(g.stations.commitRail(p, 1), null);
      assert(incumbent.rail, 'native rail platform joins the incumbent stop station');
    }
    assert.equal(g.stations.commitBusStop(54.5, 60, 2), null);
    const foreign = [...g.stations.map.values()].find(s => s.owner === 2)!;
    assert.equal(g.stations.link(incumbent.id, foreign.id), null);
    assert.equal(g.stations.commitBusStop(85, 60, 1), null);
    const other = [...g.stations.map.values()].find(s => s.id !== incumbent.id && s.owner === 1)!;
    const line = g.lines.create('road', 1); line.stops = [incumbent.id, other.id]; g.lines.rebuild();
    const model = pickBus(g.year, 2500)!;
    const plan: RoadPlan = { kind: 'extend', line: line.id, sites: [{ x: 52, z: 60, townId: -1 }], place: 'end', model,
      vehicles: 0, towns: [], revenue: 0, yearly: 0, outlay: 30_000, why: 'native pending paid part' };
    return { g, owner: 1, plan, kind: 'busext' };
  }
  function fixture(scenario: Scenario) {
    if (scenario === 'stop-part' || scenario === 'rail-stop-part') return partFixture(scenario === 'rail-stop-part');
    const g = Game.create({ size: 192, seed: 7, towns: 4, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 2 });
    for (const co of g.companies) co.economy.money = 20_000_000;
    for (const ai of g.ais) ai.state.cooldown = 1e9;
    const h = host(g.ais[0]), T = g.towns.list[0], model = pickBus(g.year, T.pop)!;
    const base = drain(planTownCandidates(h, T, model)).filter(pays).sort((p, q) => q.revenue - q.yearly - (p.revenue - p.yearly))[0];
    assert(base, 'actual native paying line');
    if (scenario === 'new') return { g, owner: 1, plan: base, kind: 'bus' };
    assert.match(drain(roadPlanJob(h, base)), /^opened /);
    const line = [...g.lines.map.values()][0];
    if (scenario === 'extend') {
      const plan = drain(planExtensions(h, line, 12))[0]; assert(plan);
      return { g, owner: 1, plan, kind: 'busext' };
    }
    for (const id of line.vehicles.slice(1)) g.vehicles.sell(id);
    const plan = drain(moreValue(host(g.ais[1]), line, model)); assert(plan);
    return { g, owner: 2, plan, kind: 'busjoin' };
  }
  function prepared(scenario: Scenario) {
    const p = fixture(scenario), g = p.g;
    const existing = {
      stations: [...g.stations.map].map(([id, s]) => ({ id, owner: s.owner, x: s.x, z: s.z, rail: JSON.stringify(s.rail), stops: JSON.stringify(s.stops), links: [...s.links] })),
      depots: [...g.depots.map.keys()], vehicles: [...g.vehicles.map.keys()], lines: [...g.lines.map].map(([id, l]) => ({ id, owner: l.owner, stops: [...l.stops] })),
    };
    const ai = start(g, p.owner, p.plan, p.kind);
    return { ...p, ai, existing };
  }
  function checkpoint(p: ReturnType<typeof prepared>, tag: string, mode: 'raw' | 'give-up') {
    const { g, owner, ai, existing } = p, ledger = structuredClone(ai.project!), beforeNext = g.stations.nextId;
    if (ai.roadTask?.build.stop && !ai.roadTask.build.stop.error) {
      const id = ai.roadTask.build.stop.before;
      if (g.stations.get(id)?.owner === owner) assert(ledger.stations.includes(id), 'a newly committed station is titled before the native post-commit yield');
    }
    const saved = JSON.parse(JSON.stringify(serialize(g))), cold = deserialize(saved), coldAI = cold.aiOf(owner)! as unknown as NativeAI;
    same(g, cold, `${tag} immediate pre-cancel JSON load`);
    const cash = g.company(owner).economy.money, worth = g.company(owner).economy.netWorth, spent = ai.watch?.spent ?? 0;
    let rawCash = cash;
    for (const id of ledger.roadVehicles ?? []) { const v = g.vehicles.get(id); if (v?.owner === owner) rawCash += g.vehicles.resaleValue(v); }
    const foreign = g.companies.filter(c => c.id !== owner).map(c => [c.id, c.economy.money] as const);
    if (mode === 'raw') { ai.cancelJob(); coldAI.cancelJob(); }
    else { ai.giveUpJob('native cancellation regression'); coldAI.giveUpJob('native cancellation regression'); }
    same(g, cold, `${tag} ${mode} source versus saved cancellation`);
    assert(!g.aiOf(owner)!.busy && !ai.project, 'cancelled task releases its busy/project state');
    for (const id of ledger.roadVehicles ?? []) assert(!g.vehicles.get(id), 'only actual project purchases are sold');
    for (const id of ledger.stations) assert(!g.stations.get(id), 'only actual new owned stations are removed');
    for (const id of ledger.depots) assert(!g.depots.get(id), 'actual new owned depots are removed after stock release');
    if (ledger.roadLine !== undefined) assert(!g.lines.get(ledger.roadLine), 'new road timetable is removed');
    if (ledger.roadJoin !== undefined) assert(!g.lines.get(ledger.roadJoin)?.operators?.includes(owner), 'only project-added partner membership is released');
    for (const id of existing.vehicles) assert(g.vehicles.get(id), 'preexisting stock survives');
    for (const id of existing.depots) assert(g.depots.get(id), 'preexisting depot survives');
    for (const line of existing.lines) {
      const live = g.lines.get(line.id); assert(live && live.owner === line.owner, 'incumbent own/foreign timetable survives');
      assert.deepEqual(live.stops, line.stops, 'incumbent native itinerary survives added-stop cancellation');
    }
    for (const station of existing.stations) {
      const live = g.stations.get(station.id); assert(live && live.owner === station.owner);
      assert.equal(JSON.stringify(live.rail), station.rail, 'incumbent rail part/style remain');
      assert.equal(JSON.stringify(live.stops), station.stops, 'old bus parts remain');
      assert.equal(live.x, station.x); assert.equal(live.z, station.z);
      for (const id of station.links) assert(live.links.includes(id), 'preexisting walking links remain');
    }
    for (const [id, money] of foreign) assert.equal(g.company(id).economy.money, money, 'foreign cash is untouched');
    if (mode === 'raw') assert.equal(g.company(owner).economy.money, rawCash, 'raw cancellation retains native resale/removal cash policy');
    else assert(g.company(owner).economy.netWorth >= worth + spent - 1e-7, 'give-up refunds the watched project net-worth loss under its existing policy');
    assert.equal(g.stations.nextId, beforeNext, 'cancellation allocates no replacement station');
  }
  // The same native removeStop API serves UI edits and paid-project cleanup.
  for (const rail of [false, true]) {
    const { g } = partFixture(rail), st = [...g.stations.map.values()].find(s => s.owner === 1)!, before = structuredClone(st);
    const nextId = g.stations.nextId;
    assert.equal(g.stations.commitBusStop(52, 60, 1), null);
    assert.equal(g.stations.nextId, nextId, 'native appended bus part allocates no station');
    assert.equal(st.stops.length, before.stops.length + 1);
    if (!rail) assert.notEqual(st.x, before.x, 'appended part moves stop-only centroid');
    g.stations.removeStop(st, st.stops.length - 1);
    assert.equal(st.x, before.x); assert.equal(st.z, before.z);
    assert.deepEqual(st.stops, before.stops); assert.deepEqual(st.rail, before.rail);
    assert.deepEqual(st.links, before.links, 'native removal retains preexisting links');
    g.stations.removeStop(st, 0);
    if (rail) {
      assert.equal(g.stations.get(st.id), st, 'last bus part preserves rail station');
      assert.deepEqual(st.rail, before.rail); assert.equal(st.x, before.x); assert.equal(st.z, before.z);
      assert.deepEqual(st.links, before.links);
    } else {
      assert(!g.stations.get(st.id), 'last part deletes stop-only station');
      for (const id of before.links) assert(!g.stations.get(id)?.links.includes(st.id), 'native deletion unlinks the removed station');
    }
  }
  console.log('PASS native removeStop: centroid, retained rail/platforms/links, native last-part deletion');
  let checks = 0;
  for (const scenario of scenarios) {
    const survey = prepared(scenario), captures = [{ tag: 'entry', tick: 0 }], seen = new Set<string>();
    let tick = 0;
    while (survey.g.aiOf(survey.owner)!.busy && tick++ < 3000) {
      survey.g.stepTick();
      const p = survey.ai.project;
      if (!p) continue;
      const labels = [p.stations.length ? `station-${p.stations.length}` : '', p.depots.length ? 'depot' : '',
        p.roadJoin !== undefined ? 'membership' : '', p.roadVehicles?.length ? `stock-${p.roadVehicles.length}` : '',
        p.roadStops?.length ? 'incumbent-stop-part' : '', p.roadExtension ? 'incumbent-line-edit' : ''].filter(Boolean);
      for (const tag of labels) if (!seen.has(tag)) { seen.add(tag); captures.push({ tag, tick }); }
    }
    assert(tick < 3000, 'native road project terminates');
    if (scenario === 'new') assert(seen.has('depot') && seen.has('stock-1') && seen.has('station-1'));
    if (scenario === 'join') assert(seen.has('membership'));
    if (scenario.endsWith('part')) assert(seen.has('incumbent-stop-part'), 'native nextId-unchanged paid-part boundary exercised');
    for (const capture of captures) for (const mode of ['raw', 'give-up'] as const) {
      const p = prepared(scenario);
      for (let i = 0; i < capture.tick; i++) p.g.stepTick();
      assert(p.g.aiOf(p.owner)!.busy, 'captured operation is genuinely unfinished');
      checkpoint(p, `${scenario}/${capture.tag}`, mode); checks++;
    }
    console.log(`PASS ${scenario}: ${captures.length} native payment/cancel boundaries, raw and give-up, direct and JSON-loaded cleanup`);
  }
  // A lawful stop edit after the native survey can make a direct bus/coach commit append to an incumbent.
  for (const kind of ['bus', 'coach'] as const) {
    const direct = Game.create({ size: 192, seed: 7, towns: 4, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 1 });
    direct.company(1).economy.money = 20_000_000; direct.ais[0].state.cooldown = 1e9;
    assert(direct.ais[0].startProject(kind, kind === 'bus' ? [0] : [0, 1]));
    type DirectTask = { stage: string; at: number; stops?: { x: number; z: number }[]; sa?: { x: number; z: number }; sb?: { x: number; z: number } };
    const directAI = direct.ais[0] as unknown as NativeAI & { roadTask: DirectTask };
    let incumbent: ReturnType<Game['stations']['get']>, original: { x: number; z: number; stops: unknown; links: number[] } | undefined, ticks = 0;
    while (!incumbent && direct.ais[0].busy && ticks++ < 3000) {
      const task = directAI.roadTask;
      if (task.stage === 'stopCommit') {
        const site = kind === 'bus' ? task.stops![task.at] : task.at ? task.sb! : task.sa!;
        const ne = direct.world.net.nearestEdge(site.x, site.z, 1.4, 'road'); assert(ne);
        for (const delta of [1.7, -1.7, 2, -2]) {
          const q = { x: 0, y: 0, z: 0 }; direct.world.net.pointAt(ne.edge, ne.s + delta, q);
          if (!direct.stations.planBusStop(q.x, q.z, 1).ok) continue;
          const id = direct.stations.nextId;
          assert.equal(direct.stations.commitBusStop(q.x, q.z, 1), null);
          incumbent = direct.stations.get(id); assert(incumbent, 'native intervening edit builds an actual incumbent station');
          assert.equal(direct.stations.planBusStop(site.x, site.z, 1).join?.id, id, 'original native candidate now appends to this own incumbent');
          original = { x: incumbent.x, z: incumbent.z, stops: structuredClone(incumbent.stops), links: [...incumbent.links] };
          break;
        }
      }
      if (!incumbent) direct.stepTick();
    }
    assert(incumbent && original, 'native pending stop commit reached');
    const nextId = direct.stations.nextId;
    let directCold = deserialize(JSON.parse(JSON.stringify(serialize(direct))));
    for (let i = 0; !directAI.project?.roadStops?.length && i < 8; i++) {
      direct.stepTick(); directCold.stepTick(); same(direct, directCold, `${kind} pending incumbent part work tick ${i + 1}`);
      directCold = deserialize(JSON.parse(JSON.stringify(serialize(directCold))));
      same(direct, directCold, `${kind} pending incumbent part immediate cold tick ${i + 1}`);
    }
    assert(directAI.project?.roadStops?.some(part => part.station === incumbent!.id));
    assert.equal(direct.stations.nextId, nextId, 'direct native commit appended a part without allocating station');
    assert.equal(incumbent.stops.length, (original.stops as unknown[]).length + 1);
    const checkpointSave = JSON.parse(JSON.stringify(serialize(direct)));
    for (const mode of ['raw', 'give-up'] as const) {
      const live = mode === 'raw' ? direct : deserialize(checkpointSave), loaded = deserialize(checkpointSave);
      const a = live.ais[0] as unknown as NativeAI, b = loaded.ais[0] as unknown as NativeAI;
      if (mode === 'raw') { a.cancelJob(); b.cancelJob(); } else { a.giveUpJob('native pending stop part'); b.giveUpJob('native pending stop part'); }
      same(live, loaded, `${kind} ${mode} incumbent part direct/cold cancellation`);
      const st = live.stations.get(incumbent.id); assert(st);
      assert.deepEqual(st.stops, original.stops); assert.equal(st.x, original.x); assert.equal(st.z, original.z);
      for (const id of original.links) assert(st.links.includes(id));
    }
    console.log(`PASS direct native ${kind}: pending incumbent part ownership, exact work and saved raw/give-up cleanup (${ticks} planning ticks)`);
  }
  // Observe real cargo and inherited service patterns before cancelling a genuinely running incumbent's extension.
  const running = fixture('extend'), g = running.g, line = g.lines.get(running.plan.line!)!;
  assert.equal(setPatterns(g, line.id, [{ id: 7, name: 'Retained native local', kind: 'local', stops: line.stops.map(() => true) }]), null);
  for (const id of line.vehicles) assert.equal(setVehiclePattern(g, id, 7), null);
  let warm = 0;
  while (![...g.vehicles.map.values()].some(v => v.lineId === line.id && v.load > 0) && warm++ < 360 * 40) g.stepTick();
  assert(warm < 360 * 40, 'native incumbent actually boards passengers within a year');
  const plan = drain(planExtensions(host(g.aiOf(1)!), line, 12))[0]; assert(plan, 'native running-line extension quote remains viable');
  const existing = {
    stations: [...g.stations.map].map(([id, s]) => ({ id, owner: s.owner, x: s.x, z: s.z, rail: JSON.stringify(s.rail), stops: JSON.stringify(s.stops), links: [...s.links] })),
    depots: [...g.depots.map.keys()], vehicles: [...g.vehicles.map.keys()], lines: [...g.lines.map].map(([id, l]) => ({ id, owner: l.owner, stops: [...l.stops] })),
  };
  const patterns = structuredClone(linePatterns(line)), ai = start(g, 1, plan, 'busext');
  let units = 0;
  while (!ai.project?.roadExtension && g.aiOf(1)!.busy && units++ < 3000) g.stepTick();
  assert(ai.project?.roadExtension, 'native extension really installed its itinerary');
  const retained = existing.vehicles.map(id => {
    const v = g.vehicles.get(id)!;
    return { id, cargo: JSON.stringify([...v.cargo]), mail: JSON.stringify([...v.mailCargo]), pattern: v.pattern,
      target: v.line?.stops[v.stopIndex], departure: v.line?.stops[v.spacing.departureIndex] };
  });
  assert(retained.some(v => JSON.parse(v.cargo).length), 'actual boarded cargo remains at the paid itinerary checkpoint');
  const edit = deserialize(JSON.parse(JSON.stringify(serialize(g)))), editLine = edit.lines.get(line.id)!;
  // A real intervening user timetable edit invalidates the exact cleanup title; do not restore its old itinerary.
  const oldIds = [...new Set(existing.lines[0].stops)], edited = [...editLine.stops];
  [edited[1], edited[2]] = [edited[2], edited[1]];
  replaceLineStops(edit, editLine, edited);
  const editedCold = deserialize(JSON.parse(JSON.stringify(serialize(edit))));
  (edit.aiOf(1)! as unknown as NativeAI).cancelJob(); (editedCold.aiOf(1)! as unknown as NativeAI).cancelJob();
  same(edit, editedCold, 'intervening user edit live/cold cancellation');
  assert.deepEqual(editLine.stops.filter(id => oldIds.includes(id)), edited.filter(id => oldIds.includes(id)), 'intervening itinerary order survives owned cleanup');
  checkpoint({ ...running, g, ai, plan, existing }, 'running inherited-pattern/cargo extension', 'raw');
  assert.deepEqual(linePatterns(line), patterns, 'inverse native edit preserves inherited service patterns');
  for (const before of retained) {
    const v = g.vehicles.get(before.id)!;
    assert.equal(JSON.stringify([...v.cargo]), before.cargo, 'incumbent passenger groups are retained');
    assert.equal(JSON.stringify([...v.mailCargo]), before.mail, 'incumbent mail groups are retained');
    assert.equal(v.pattern, before.pattern);
    if (before.target !== undefined && existing.stations.some(s => s.id === before.target)) assert.equal(v.line?.stops[v.stopIndex], before.target, 'native edit remaps incumbent target');
    if (before.departure !== undefined && existing.stations.some(s => s.id === before.departure)) assert.equal(v.line?.stops[v.spacing.departureIndex], before.departure, 'native edit remaps pending departure');
  }
  const resumed = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  for (let i = 0; i < 128; i++) { g.stepTick(); resumed.stepTick(); same(g, resumed, `running cancellation continued tick ${i + 1}`); }
  console.log(`PASS native running incumbent: boarded cargo, inherited pattern/target, guarded user edit, 128 exact cold continuation ticks (${warm} warm ticks)`);
  console.log(`PASS ${checks} owned cancellation checks; native success yield schedule stays independently covered by original-source oracle`);
}
