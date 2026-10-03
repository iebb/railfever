// Deterministic railway planning audit. Bundle as aiplan.mjs, then run with node.
// Default: replay seed-23 fixture + seeds 7/23/51 at 512/768, 3 AIs, four years.
// --fixture | --seed 23 --size 512 [--years 3]; --baseline disables duration assertions.
// --json /path/report.json saves every plan, phase tick count and stage distribution.
// --compare /path/before.json prints before/after company summaries; --cpu diagnoses wall-time outliers.
import { readFileSync, writeFileSync } from 'node:fs';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { planningProbe, chainProfile, chainProfileGen, routeGen, routeConflictAt, routeConflictGen, runGen, type OPoint } from '../src/game/routing';
import { serialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { fails, check, placeAndConnect, depotBehind, busStopSites, addBusStop, roadDepotNear, Train, RoadVehicle, build, free, roadOpts } from './lib';
import { flatGame } from './stationlib';
import { crossingSegments, geometryPointRanges } from '../src/game/construction';
import { segIntersect } from '../src/game/geom';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const baseline = process.argv.includes('--baseline'), years = arg('--years', 4);
type Phase = 'sites' | 'route' | 'costs' | 'build';
interface Project { kind: string; towns: number[]; started: number; line: number }
interface Plan {
  kind: string; towns: number[]; start: number; end?: number; outcome: 'active' | 'completed' | 'abandoned';
  budget: number; phases: Record<Phase, number>; steps: number; planningSteps: number;
}
interface Samples { ms: number[]; work: number }
interface CompanyReport { company: number; plans: Plan[]; steps: number[]; otherSteps: number[]; stages: Record<string, Samples>; slowSteps: { tick: number; phase: string; ms: number; at: number; cpuMs?: number; parts: Record<string, number> }[] }
const phaseOf = (s: string): Phase => s.startsWith('building') ? 'build' : s.endsWith(': costs') ? 'costs' : s.endsWith(': route') ? 'route' : 'sites';
const quantile = (a: number[], q: number) => { const s = [...a].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(s.length * q) - 1)] : 0; };
const stats = (a: number[]) => ({ n: a.length, median: quantile(a, .5), p99: quantile(a, .99), max: Math.max(0, ...a), total: a.reduce((a, b) => a + b, 0) });
const comparisonIndex = process.argv.indexOf('--compare');
const comparison = comparisonIndex < 0 ? [] : JSON.parse(readFileSync(process.argv[comparisonIndex + 1], 'utf8')).results as { seed: number; size: number; fixture: boolean; years: number; companies: CompanyReport[] }[];

function summary(r: CompanyReport) {
  const phases = Object.fromEntries((['sites', 'route', 'costs', 'build'] as Phase[]).map((p) => [p, stats(r.plans.map((v) => v.phases[p] / TICKS_PER_DAY))]));
  const durations = r.plans.map((p) => (p.phases.sites + p.phases.route + p.phases.costs) / TICKS_PER_DAY);
  return {
    company: r.company, plans: r.plans.length, completed: r.plans.filter((p) => p.outcome === 'completed').length,
    abandoned: r.plans.filter((p) => p.outcome === 'abandoned').length, active: r.plans.filter((p) => p.outcome === 'active').length,
    planningDays: stats(durations), phases, stepsPerPlan: stats(r.plans.map((p) => p.steps)), planningStepsPerPlan: stats(r.plans.map((p) => p.planningSteps)),
    stepMs: stats(r.steps), otherStepMs: stats(r.otherSteps),
  };
}

/** Same player network, configuration and pending agreements as scripts/replay.ts's startup fixture. */
function fixture() {
  const g = Game.create({ size: 384, seed: 23, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
  g.economy.money = 40_000_000;
  const pr = placeAndConnect(g, 60, 150, 0, new Set(), 1, () => {});
  if (!pr) throw new Error('fixture player railway');
  const dep = depotBehind(g, pr.A, pr.B, 0), line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  check(g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id) instanceof Train, 'fixture train');
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0], sites = busStopSites(g, big, 0, 12, 30);
  check(sites.length === 2, 'fixture bus stop sites');
  const stops = sites.map(([x, z]) => addBusStop(g, x, z, 0)), bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0); bl.stops = stops;
  for (let i = 0; i < 2; i++) check(g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id) instanceof RoadVehicle, 'fixture bus');
  g.ais[0].config = { ...g.ais[0].config, activeness: 1.4, risk: 0.7, focus: { rail: 2, road: 1, tram: .5 } };
  g.requestAccess(0, g.ais[1].companyId); g.setAccessPolicy(0, 'ask'); g.requestAccess(g.ais[0].companyId, 0, 'test');
  g.lines.rename(line.id, 'Main Line');
  return g;
}

/** Slicing and memoization must preserve the complete route/profile and consume identical warm/cold units. */
function primitives() {
  const g = flatGame(192, 3);
  check(!!build(g, free(g, 12, 96), free(g, 180, 96), roadOpts(0), 'planner fixture crossing'), 'planner crossing built');
  const before = JSON.stringify(serialize(g));
  const edge = [...g.world.net.edges.values()].find((e) => e.kind === 'road')!, geo = g.world.net.geo(edge);
  // Compare the indexed crossing candidates and nearby samples against the original full scans.
  for (let q = 0; q < 100; q++) {
    const x = 10 + q * 1.73, z = 94 + (q % 7) * .53, ax = x - 2, az = z - 3, bx = x + 2, bz = z + 3;
    const intersections = (ids: number[]) => ids.flatMap((j) => {
      const r = segIntersect(ax, az, bx, bz, geo.pts[j * 3], geo.pts[j * 3 + 2], geo.pts[j * 3 + 3], geo.pts[j * 3 + 5]);
      return r ? [{ j, r }] : [];
    });
    const all = Array.from({ length: geo.n - 1 }, (_, i) => i);
    check(JSON.stringify(intersections(crossingSegments(geo, ax, az, bx, bz) ?? all)) === JSON.stringify(intersections(all)), `ordered crossing index ${q}`);
    const reach = 1.1, ranges = geometryPointRanges(geo, x, z, reach);
    const ids = ranges ? ranges.flatMap((i) => Array.from({ length: Math.min(32, geo.n - i) }, (_, j) => i + j)) : Array.from({ length: geo.n }, (_, i) => i);
    const nearest = (a: number[]) => {
      let best = Infinity, index = -1;
      for (const i of a) { const d = Math.hypot(geo.pts[i * 3] - x, geo.pts[i * 3 + 2] - z); if (d < best) { best = d; index = i; } }
      return best < reach ? { best, index } : null;
    };
    check(JSON.stringify(nearest(ids)) === JSON.stringify(nearest(Array.from({ length: geo.n }, (_, i) => i))), `ordered proximity index ${q}`);
  }
  const from: OPoint = { x: 24, z: 24, tx: 0, tz: 1 }, to: OPoint = { x: 160, z: 168, tx: 0, tz: 1 };
  const way = [from, to];
  for (const type of ['standard', 'highspeed']) for (const tracks of [1, 2]) {
    const expected = JSON.stringify(chainProfile(g, way, tracks, 3, 3, 'rail', new Set(), false, undefined, type));
    for (const step of [1, 256]) check(JSON.stringify(runGen(chainProfileGen(g, way, tracks, 3, 3, 'rail', new Set(), false, undefined, type, step))) === expected, `${type}/${tracks}: identical sliced terrain/crossing fit`);
  }
  const profile = chainProfile(g, way, 1, 3, 3, 'rail');
  check(!!profile, 'crossing profile is feasible');
  if (profile) check(JSON.stringify(runGen(routeConflictGen(g, profile, 'rail', 1, new Set(), 7))) === JSON.stringify(routeConflictAt(g, profile, 'rail', 1)), 'identical sliced conflicts');
  const plan = () => {
    const gen = routeGen(g, from, to, { kind: 'rail', owner: 0, tracks: 1, y0: 3, y1: 3, minR: 14, parallel: 3, sliced: true }, 17);
    let units = 0, r = gen.next();
    while (!r.done) { units++; r = gen.next(); }
    return JSON.stringify({ units, result: r.value });
  };
  const cold = plan();
  check(plan() === cold, 'warm/cold route caches preserve exact plans and work units');
  check(JSON.stringify(serialize(g)) === before, 'planning leaves saved simulation state unchanged');
  console.log('planner primitives: ordered geometry indexes, exact slicing, warm/cold work units, preview purity');
}

let current: CompanyReport | undefined;
const spans: { stage: string; time: number }[] = [];
let parts: Record<string, number> = {};
planningProbe.observe = (stage, begin, work = 0) => {
  if (!current) return;
  if (begin) { spans.push({ stage, time: performance.now() }); return; }
  const i = spans.findLastIndex((s) => s.stage === stage);
  if (i < 0) return;
  const span = spans.splice(i, 1)[0], s = current.stages[stage] ??= { ms: [], work: 0 };
  const dt = performance.now() - span.time;
  s.ms.push(dt); s.work += work; parts[stage] = (parts[stage] ?? 0) + dt;
};

function audit(seed: number, size: number, replay = false) {
  const g = replay ? fixture() : Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  const reports: CompanyReport[] = [];
  const trackers: { sample: () => void }[] = [];
  for (const ai of g.ais) {
    const report: CompanyReport = { company: ai.companyId, plans: [], steps: [], otherSteps: [], stages: {}, slowSteps: [] }; reports.push(report);
    const ext = ai as unknown as { project: Project | null; job: Generator<void, void> | null };
    const wrapped = new WeakSet<Generator<void, void>>();
    let active: Project | null = null, plan: Plan | undefined;
    const observe = () => {
      const p = ext.project, rail = p && (p.kind === 'rail' || p.kind === 'hsr') ? p : null;
      if (rail !== active) {
        if (plan && active) {
          plan.end = g.tick;
          plan.outcome = active.line >= 0 && !!g.lines.get(active.line) ? 'completed' : 'abandoned';
        }
        active = rail;
        plan = rail ? { kind: rail.kind, towns: [...rail.towns], start: g.tick, outcome: 'active', budget: ai.budget,
          phases: { sites: 0, route: 0, costs: 0, build: 0 }, steps: 0, planningSteps: 0 } : undefined;
        if (plan) report.plans.push(plan);
      }
      const job = ext.job;
      if (!job || wrapped.has(job)) return;
      wrapped.add(job);
      const next = job.next.bind(job);
      job.next = (...args) => {
        observe();
        const before = plan, phase = phaseOf(ai.phase), t = performance.now();
        const cpu = process.argv.includes('--cpu') ? process.cpuUsage() : undefined;
        current = report; spans.length = 0; parts = {};
        try { return next(...args); }
        finally {
          const dt = performance.now() - t;
          const usage = cpu ? process.cpuUsage(cpu) : undefined;
          if (before) { before.steps++; if (phase !== 'build') { before.planningSteps++; report.steps.push(dt); } }
          else report.otherSteps.push(dt);
          if (before && phase !== 'build' && dt > 8) report.slowSteps.push({ tick: g.tick, phase: ai.phase, ms: dt, at: t, cpuMs: usage ? (usage.user + usage.system) / 1000 : undefined, parts });
          // A span that yields is measured only up to this unit boundary.
          for (const span of spans) { const s = report.stages[span.stage] ??= { ms: [], work: 0 }; s.ms.push(performance.now() - span.time); }
          current = undefined; spans.length = 0;
        }
      };
    };
    const work = ai.work.bind(ai);
    ai.work = (t0, t1) => { observe(); work(t0, t1); observe(); };
    const planRail = g.stations.planRail;
    // Install this shared wrapper once; the active company is supplied by its current generator unit.
    if (reports.length === 1) g.stations.planRail = function (...args) {
      planningProbe.observe?.('station plan', true);
      try { return planRail.apply(this, args); }
      finally { planningProbe.observe?.('station plan', false, 1); }
    };
    trackers.push({ sample: () => { observe(); if (plan) plan.phases[phaseOf(ai.phase)]++; } });
  }
  const t0 = performance.now();
  if (process.argv.includes('--details')) for (const name of ['planAccessStreet', 'rectConflict', 'roadContact']) {
    const st = g.stations as any, f = st[name].bind(st);
    st[name] = (...args: unknown[]) => {
      planningProbe.observe?.(name, true);
      try { return f(...args); }
      finally { planningProbe.observe?.(name, false); }
    };
  }
  console.log(`\n${replay ? 'replay fixture' : 'map'} seed ${seed}, size ${size}, ${g.ais.length} AIs, ${years} years`);
  while (g.day < years * 360) {
    for (const t of trackers) t.sample();
    g.stepTick();
    if (replay && process.argv.includes('--trace') && g.tick % (30 * TICKS_PER_DAY) === 0) {
      console.log(`  day ${g.day}: ${g.ais.map((ai) => { const p = (ai as any).project; return `co${ai.companyId} ${ai.phase} (${p?.kind ?? '-'}, started ${p?.started ?? '-'})`; }).join(' | ')}`);
    }
  }
  for (const r of reports) {
    const durations = r.plans.map((p) => (p.phases.sites + p.phases.route + p.phases.costs) / TICKS_PER_DAY);
    const before = comparison.find((v) => v.seed === seed && v.size === size && v.fixture === replay && v.years === years)?.companies.find((v) => v.company === r.company);
    console.log(JSON.stringify(before ? { before: summary(before), after: summary(r) } : summary(r)));
    console.log('  stages: ' + JSON.stringify(Object.fromEntries(Object.entries(r.stages).map(([k, s]) => [k, { ...stats(s.ms), work: s.work }]))));
    // Units stay fixed even for companies below the default budget. Normalize their bound to eight/day.
    if (!baseline) for (let i = 0; i < r.plans.length; i++) check(durations[i] * r.plans[i].budget / 8 <= 60, `co${r.company} plan ${i + 1} planning <= 60 default-budget days (${durations[i].toFixed(1)} days at ${r.plans[i].budget}/day)`);
    // Wall times are reports only: OS scheduling/GC must never determine a simulation assertion or decision.
  }
  console.log(`  simulation ${(performance.now() - t0).toFixed(0)} ms`);
  return { seed, size, fixture: replay, years, companies: reports };
}

const results: ReturnType<typeof audit>[] = [];
primitives();
if (process.argv.includes('--verify-only')) { /* primitive checks only */ }
else if (process.argv.includes('--fixture')) results.push(audit(23, 384, true));
else if (process.argv.includes('--seed')) results.push(audit(arg('--seed', 23), arg('--size', 512)));
else {
  results.push(audit(23, 384, true));
  for (const size of [512, 768]) for (const seed of [7, 23, 51]) results.push(audit(seed, size));
}
const ji = process.argv.indexOf('--json');
if (ji >= 0) writeFileSync(process.argv[ji + 1], JSON.stringify({ baseline, results }, null, 2) + '\n');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
