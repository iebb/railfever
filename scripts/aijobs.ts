// Every AI job ends: no company stays busy with one job for more than MAX_DAYS in real fixed-step games (a city
// railway that cannot be sited gives up within its planning work limit), a mid-planning save replays exactly, and the
// safety net gives up a job that shows no progress or never ends, rolling its works back.
// Bundle as aijobs.mjs; optional args: seeds (default 5,7,23), years (default 3).
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { check, fails, free, build, railOpts } from './lib';

const MAX_DAYS = 180;
const seeds = (process.argv[2] ?? '5,7,23').split(',').map(Number), years = Number(process.argv[3] ?? 3);
const saved = (g: Game) => JSON.stringify(serialize(g));
let urbanReplays = 0;

/** A company's work that a save resumes exactly (others are abandoned on loading, see AIController.load). */
const resumable = (a: any) => !a.busy || ['metro', 'lightrail', 'double'].includes(a.project?.kind) || (!a.project && (!!a.accessTask || !!a.state.through));

for (const seed of seeds) {
  const t0 = Date.now();
  const g = Game.create({ size: 512, seed, towns: Math.round(512 / 42), hilliness: 'hilly', water: 'medium', startYear: 1985,
    aiConfigs: Array.from({ length: 3 }, () => ({ focus: { rail: 1.5, road: 1.5, tram: 0.8 } })) });
  g.aiAcquisitions = false;
  const open = new Map<number, { job: unknown; from: number; what: string }>();
  const notes = new Set<string>();
  // City railway projects (the seed-7 light railway in Chalcott planned from day 175 used to run until day 733).
  const city = new Map<string, { company: number; from: number; to?: number }>();
  let longest = 0, longestWhat = '', last = -1, jobs = 0, watchUnits = 0, watchIdle = 0;
  let replay: { g: Game; at: number } | null = null;
  const close = (id: number, o: { from: number; what: string }) => {
    const days = g.day - o.from;
    jobs++;
    if (days > longest) { longest = days; longestWhat = `company ${id} ${o.what} days ${o.from}-${g.day}`; }
    check(days <= MAX_DAYS, `seed ${seed}: company ${id} was busy with ${o.what} for ${days} days (days ${o.from}-${g.day})`);
  };
  const end = years * 360;
  while (g.day < end || replay) {
    g.stepTick();
    if (replay) {
      replay.g.stepTick();
      if (g.tick !== replay.g.tick) throw new Error('lockstep tick mismatch');
      if (g.day >= replay.at + 120) {
        const a = serialize(g), b = serialize(replay.g);
        const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        check(!keys.length, `seed ${seed}: a save during city-railway planning on day ${replay.at} replays 120 days exactly (differs: ${keys.join(', ')})`);
        if (!keys.length) { urbanReplays++; console.log(`  a save on day ${replay.at}, during city-railway planning, replayed 120 days exactly`); }
        replay = null;
      }
    }
    if (g.day === last || g.day > end) continue;
    last = g.day;
    for (const ai of g.ais) {
      const a = ai as any, job = a.job, o = open.get(ai.companyId);
      if (o && o.job !== job) { close(ai.companyId, o); open.delete(ai.companyId); }
      if (job && !open.has(ai.companyId)) open.set(ai.companyId, { job, from: g.day, what: a.project ? `${a.project.kind} project` : a.state.phase });
      for (const n of ai.log) if (/city railway in .* abandoned|gave up/.test(n)) notes.add(`company ${ai.companyId}: ${n}`);
      if (a.watch) { watchUnits = Math.max(watchUnits, a.watch.units); watchIdle = Math.max(watchIdle, a.watch.idle); }
      const p = a.project, key = p && ['metro', 'lightrail'].includes(p.kind) ? `${ai.companyId}:${p.kind}@${p.started}` : '';
      if (key && !city.has(key)) city.set(key, { company: ai.companyId, from: g.day });
      for (const [k, c] of city) if (c.company === ai.companyId && c.to === undefined && k !== key) c.to = g.day;
    }
    // One save during a city railway's planning, while every busy company's work resumes from a save.
    const planning = g.ais.find((ai) => { const p = (ai as any).project; return p && ['metro', 'lightrail'].includes(p.kind) && !p.built && (p.planned ?? 0) > 40; });
    if (!replay && planning && urbanReplays === 0 && g.ais.every(resumable)) {
      const data = saved(g), loaded = deserialize(JSON.parse(data)), state = JSON.parse(data).ais.find((x: any) => x.companyId === planning.companyId).state;
      check(saved(loaded) === data, `seed ${seed}: a save during city-railway planning round-trips exactly (day ${g.day})`);
      check(state.watch?.key?.startsWith(state.project.kind + '@') && state.watch.units > 0 && state.project.planned > 0,
        `seed ${seed}: the save keeps the job's progress watch and planning work count`);
      replay = { g: loaded, at: g.day };
    }
  }
  for (const [id, o] of open) {
    const days = g.day - o.from;
    if (days > longest) { longest = days; longestWhat = `company ${id} ${o.what} days ${o.from}- (running)`; }
    check(days <= MAX_DAYS, `seed ${seed}: company ${id} still busy with ${o.what} after ${days} days (since day ${o.from})`);
  }
  console.log(`seed ${seed}: ${jobs} jobs, longest ${longest} days (${longestWhat}); watched jobs ran up to ${watchUnits} work units, ${watchIdle} without progress [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  const cities = [...city.values()];
  if (cities.length) console.log(`  city railway projects: ${cities.map((c) => `company ${c.company} days ${c.from}-${c.to ?? '(running)'}`).join(', ')}`);
  if (seed === 7) check(cities.length > 0 && cities.every((c) => (c.to ?? g.day) - c.from <= MAX_DAYS),
    'seed 7: the city railway projects (one stuck from day 175 to day 733 before) finish within the limit');
  for (const n of notes) console.log('  ' + n);
}
check(urbanReplays > 0 || !seeds.includes(7), 'a save during city-railway planning was replayed');

// ---------------------------------------------------------------- the safety net (watchJob / giveUpJob)
function netFixture() {
  const g = Game.create({ size: 256, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.aiAcquisitions = false; g.aiEnabled = true;
  const ai = g.ais[0] as any, e = g.company(ai.companyId).economy;
  e.money = 200_000_000; ai.state.cooldown = 1e9;
  const capital = () => -e.yearTotals.reduce((n, y) => n + y.v.construction, e.thisYear.construction);
  return { g, ai, me: ai.companyId as number, capital };
}
const runWhileBusy = (g: Game, ai: any, days: number) => { const from = g.day; while (ai.busy && g.day < from + days) g.stepTick(); return g.day - from; };

{
  console.log('safety net: a job that stops progressing is given up and rolled back');
  const { g, ai, me, capital } = netFixture();
  const c0 = capital();
  ai.project = { kind: 'rail', towns: [0, 1], stations: [], edges: [], depots: [], line: -1, started: g.day };
  ai.job = (function* (): Generator<void, void> {
    ai.state.phase = 'laying test track';
    const e0 = g.world.net.nextEdge;
    build(g, free(g, 60, 128), free(g, 180, 128), railOpts(me), 'stall fixture');
    ai.track(e0);
    yield;
    for (;;) yield;
  })();
  while (ai.busy && !ai.project?.edges.length && g.day < 5) g.stepTick();
  const edges: number[] = [...(ai.project?.edges ?? [])], built = capital() - c0;
  check(edges.length > 0 && built > 0, 'stall: the job laid track before it stopped progressing');
  const days = runWhileBusy(g, ai, 400);
  check(!ai.busy && !ai.project && days >= 140 && days <= 160, `stall: given up after about 150 days at the default work rate (${days})`);
  check(ai.log.some((n: string) => n.includes('gave up laying test track: no progress for')), 'stall: a note says what was given up and why');
  check(ai.isFailed('0-1'), 'stall: the failure is remembered, so the project is not chosen again at once');
  check(edges.every((id) => !g.world.net.edges.has(id)), 'stall: its unfinished track is removed');
  check(Math.abs(capital() - c0) < 1, `stall: its construction and removal are refunded (${Math.round(capital() - c0)} left of ${Math.round(built)})`);
  check(!JSON.parse(saved(g)).ais[0].state.watch, 'stall: no progress watch is left behind');
}

{
  console.log('safety net: a job that keeps changing phase but never ends is given up');
  const { g, ai } = netFixture();
  ai.project = { kind: 'coach', towns: [2, 3], stations: [], edges: [], depots: [], line: -1, started: g.day };
  ai.job = (function* (): Generator<void, void> { for (let i = 0; ; i++) { ai.state.phase = `test step ${i}`; yield; } })();
  const days = runWhileBusy(g, ai, 600);
  check(!ai.busy && days >= 350 && days <= 370, `endless: given up after about 360 days (${days})`);
  check(ai.log.some((n: string) => /gave up test step \d+: unfinished after \d+ days/.test(n)) && ai.isFailed('coach2-3'), 'endless: noted and remembered');
}

{
  console.log('safety net: a job that keeps building is not interrupted');
  const { g, ai, me } = netFixture();
  ai.project = { kind: 'rail', towns: [4, 5], stations: [], edges: [], depots: [], line: -1, started: g.day };
  let pieces = 0;
  ai.job = (function* (): Generator<void, void> {
    ai.state.phase = 'laying test track';
    // one short piece every 100 days or so (800 units), each a visible step of progress, for 300 days in all
    for (let k = 0; k < 3; k++) {
      for (let u = 0; u < 800; u++) yield;
      const e0 = g.world.net.nextEdge;
      if (build(g, free(g, 40 + k * 40, 60), free(g, 70 + k * 40, 60), railOpts(me), 'progress fixture')) pieces++;
      ai.track(e0);
    }
  })();
  const days = runWhileBusy(g, ai, 600);
  check(!ai.busy && pieces === 3 && !ai.log.some((n: string) => n.includes('gave up')), `progress: the job finished its own way after ${days} days`);
}

console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
