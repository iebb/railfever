// Full native road AI lifecycle: fixed-step live/unobserved world versus a JSON cold load at every tick.
// --case=bus|coach|road|market-bus|market-coach|plan-join|plan-extend|plan-upgrade|selector; optional --oracle=/absolute/before.mjs.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import type { AIController } from '../src/game/ai';
import { bulldoze } from '../src/game/build-ops';
import { roadPlanJob as buildRoadPlan, planTownCandidates, moreValue, planExtensions, routeUpgradeValue, pays, type RoadPlan, type BusHost } from '../src/game/ai-bus';
import { pickBus } from '../src/game/ai';

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const kind = process.argv.find(a => a.startsWith('--case='))?.slice(7) ?? 'bus';
  assert(['bus', 'coach', 'road', 'market-bus', 'market-coach', 'selector', 'plan-join', 'plan-extend', 'plan-upgrade'].includes(kind));
  const oracleArg = process.argv.find(a => a.startsWith('--oracle='));
  const oracle = oracleArg ? await import(pathToFileURL(oracleArg.slice(9)).href) : null;
  const api = { Game, serialize, deserialize, bulldoze, planTownCandidates, moreValue, planExtensions, routeUpgradeValue, pays, pickBus, roadPlanJob: buildRoadPlan };
  type API = typeof api;
  type TestAI = { state: AIController['state']; project: unknown; job: Generator<void, void>; roadTask: { kind: string; stage: string; stop?: { stage: string }; build?: { stage: string; depotSearch?: { stage: string } } } | null;
    config: AIController['config']; chooseProject(): Generator<void, void>;
    roadPlanJob(p: RoadPlan | null, kind: string): Generator<void, void> };
  function fixture(a: API) {
    const g = a.Game.create({ size: 192, seed: 7, towns: 4, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 1 });
    g.company(1).economy.money = 20_000_000;
    if (kind === 'road') {
      // A lawful native public-road demolition leaves town streets intact; the AI must reconnect them at its own cost.
      for (const e of [...g.world.net.edges.values()]) if (e.kind === 'road' && e.type === 'road' && e.depot < 0) {
        const q = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len / 2, q);
        if (g.towns.list.every(T => Math.hypot(T.x - q.x, T.z - q.z) > T.radius + 4)) a.bulldoze(g, q.x, q.z, q.x, q.z, 0, false);
      }
    }
    const ai = g.ais[0] as unknown as TestAI;
    if (kind.startsWith('plan-')) {
      const drain = <T>(job: Generator<void, T>): T => { let r = job.next(); while (!r.done) r = job.next(); return r.value; };
      const h = (g.ais[0] as unknown as { busHost(): BusHost }).busHost(), T = g.towns.list[0], model = a.pickBus(g.year, T.pop)!;
      const base = drain(a.planTownCandidates(h, T, model)).filter(a.pays).sort((p, q) => q.revenue - q.yearly - (p.revenue - p.yearly))[0];
      assert(base, 'native paying service exists before a planned road investment');
      assert.match(drain(a.roadPlanJob(h, base)), /^opened /);
      const line = [...g.lines.map.values()][0];
      let plan: RoadPlan | null | undefined;
      if (kind === 'plan-join') {
        for (const id of line.vehicles.slice(1)) g.vehicles.sell(id);
        plan = drain(a.moreValue(h, line, model));
      } else if (kind === 'plan-extend') plan = drain(a.planExtensions(h, line, 12))[0];
      else plan = drain(a.routeUpgradeValue(h, line));
      assert(plan && plan.kind === (kind === 'plan-join' ? 'join' : kind === 'plan-extend' ? 'extend' : 'upgrade'), 'native planned investment quote exists');
      const projectKind = kind === 'plan-join' ? 'busjoin' : kind === 'plan-extend' ? 'busext' : 'busrail';
      ai.project = { kind: projectKind, towns: plan.towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
      ai.job = ai.roadPlanJob(plan, projectKind); ai.state.projects++;
    } else if (kind === 'selector') {
      // Native weighted selection with a valid road-focused company configuration; no option or pay guard is forced.
      ai.config = { ...ai.config, focus: { rail: 0, road: 1, tram: 0 } };
      ai.state.phase = 'evaluating projects'; ai.job = ai.chooseProject();
      let units = 0;
      while (!ai.project && ai.job && units++ < 5000) g.stepTick();
      const p = ai.project as { kind?: string } | null;
      assert(p && ['bus', 'coach', 'busjoin', 'busext', 'busrail', 'road'].includes(p.kind ?? ''), 'native selector hands its weighted choice into a road project');
    } else if (kind.startsWith('market-')) {
      const projectKind = kind.slice(7), towns = projectKind === 'coach' ? [0, 1] : [0];
      ai.project = { kind: projectKind, towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
      ai.job = ai.roadPlanJob(null, projectKind);
      ai.state.projects++;
    } else assert(g.ais[0].startProject(kind as 'bus' | 'coach' | 'road', kind === 'bus' ? [0] : [0, 1]));
    return g;
  }
  function same(a: string, b: string, stage: string) {
    if (a === b) return;
    let i = 0; while (a[i] === b[i]) i++;
    assert.fail(`${stage}: first full-save difference at ${i}: ${a.slice(i - 65, i + 140)} / ${b.slice(i - 65, i + 140)}`);
  }
  const live = fixture(api);
  let cold = deserialize(JSON.parse(JSON.stringify(serialize(live))));
  assert(live.ais[0].busy && cold.ais[0].busy, 'pending native entry remains busy before its first work unit');
  same(JSON.stringify(serialize(cold)), JSON.stringify(serialize(live)), 'pending entry before first work');
  let ticks = 0, previous = '', changed = 0, legacyChecked = false;
  const stages = new Set<string>(), actions: { tick: number; assets: string; money: number }[] = [];
  while (live.ais[0].busy && ticks++ < 8000) {
    live.stepTick(); cold.stepTick();
    const a = JSON.stringify(serialize(live)), b = JSON.stringify(serialize(cold));
    if (!legacyChecked && kind !== 'road' && !kind.startsWith('plan-')) {
      const record = JSON.parse(a), state = record.ais[0].state;
      if (state.project?.stations.length > 0) {
        delete state.road;
        const migrated = deserialize(record);
        assert(!migrated.ais[0].busy && migrated.stations.map.size < live.stations.map.size, 'legacy record without a continuation retains native paid-station cleanup');
        assert(serialize(migrated).catchmentInputsDirty, 'legacy paid cleanup retains its owed catchment refresh');
        if (oracle) same(JSON.stringify(serialize(migrated)), JSON.stringify(oracle.serialize(oracle.deserialize(JSON.parse(JSON.stringify(record))))), 'legacy migration agrees with frozen original cleanup');
        legacyChecked = true;
      }
    }
    assert.equal(cold.ais[0].busy, live.ais[0].busy, `native busy state tick ${ticks}`);
    same(a, b, `native live/cold tick ${ticks}`);
    cold = deserialize(JSON.parse(b));
    same(JSON.stringify(serialize(cold)), a, `native immediate cold tick ${ticks}`);
    const ai = live.ais[0] as unknown as TestAI, c = ai.roadTask;
    if (c) stages.add(`${c.kind}:${c.stage}:${c.stop?.stage ?? ''}:${c.build?.stage ?? ''}:${c.build?.depotSearch?.stage ?? ''}`);
    const assets = `${live.stations.map.size},${live.depots.map.size},${live.lines.map.size},${live.vehicles.map.size},${live.world.net.edges.size}`;
    if (assets !== previous) { actions.push({ tick: live.tick, assets, money: live.company(1).economy.money }); previous = assets; changed++; }
  }
  assert(!live.ais[0].busy, 'native road project finishes within its original bounded work budget');
  if (kind === 'road') assert(live.ais[0].stats.road > 0 && changed >= 3, 'native project commits paid town joins and road segments');
  else if (kind === 'plan-upgrade') assert(live.routeWorks.length > 0, 'native upgrade starts its durable paid works');
  else if (kind.startsWith('plan-')) assert(live.vehicles.map.size > 0 && changed >= 2, 'native planned investment changes the paid service');
  else assert(legacyChecked && live.vehicles.map.size > 0 && changed >= 3, 'native project pays for stops/depot and opens actual vehicles');
  // Exercise the post-completion save boundary and actual native stock/depot release with all traffic retained.
  for (let i = 0; i < 128; i++) {
    live.stepTick(); cold.stepTick();
    const a = JSON.stringify(serialize(live));
    same(JSON.stringify(serialize(cold)), a, `post-completion live/cold tick ${i}`);
    assert.equal(cold.ais[0].busy, live.ais[0].busy, `post-completion busy tick ${i}`);
    cold = deserialize(JSON.parse(a));
    same(JSON.stringify(serialize(cold)), a, `post-completion immediate cold tick ${i}`);
  }
  if (kind !== 'road') assert([...live.vehicles.map.values()].some(v => v.owner === 1 && (v.state === 'running' || v.state === 'loading')), 'actual paid stock leaves its native depot and serves the line');
  if (oracle) {
    const before = fixture(oracle); let n = 0;
    while (before.ais[0].busy && n++ < 8000) before.stepTick();
    assert.equal(n, ticks, 'frozen source finishes on the identical fixed tick');
    for (let i = 0; i < 128; i++) before.stepTick();
    same(JSON.stringify(oracle.serialize(before)), JSON.stringify(serialize(live)), 'frozen native complete saved world');
  }
  console.log(`PASS ${kind}: ${ticks} native fixed ticks +128 release ticks, ${stages.size} substages, full save equality live/cold/immediate load at every tick${oracle ? ', frozen 88cd481 source oracle' : ''}`);
  console.log(JSON.stringify({ stages: [...stages], actions }));
}
