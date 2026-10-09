// Repeatable simulation benchmark: what a player feels per rendered frame at 1x/4x/8x, per game day, and the spikes.
// npx esbuild scripts/perfbench.ts --bundle --platform=node --format=esm --outfile=$S/perfbench.mjs && node --expose-gc $S/perfbench.mjs
//   [size=768] [ais=1] [years=0,5,15] [seed=7] [style=balanced|rail|mixed|...] [--window=90] [--json=out.json]
//   [--save=file.json] writes the game after the last window; [--load=file.json] starts from such a save instead of a new map
//   (years then count from the loaded date).
// Runs the fixed-step simulation with stepTick (deterministic; wall time never changes it) and records every tick.
// A window of `window` game days starting at each listed year is reported:
//   day       ms per game day (40 ticks): median / p95 / max
//   frame@Nx  simulation ms inside one 60 fps frame at speed N (N/3 ticks per frame): p50 / p99 / max, frames > 16.7 ms, > 50 ms
//   spikes    the slowest ticks of the window with their largest instrumented jobs (inclusive times)
//   save      captureSave (main-thread hitch of an autosave), JSON size, deserialize (load), heap after GC
// Works on older sources too (2.8.1/2.9) for comparisons: copy it into their scripts/ and bundle there.
// Rendering, windows, tools and autosave hitches in a browser: scripts/perfbench-browser.js.
import { Game } from '../src/game/game';
import { AI_PRESETS, normalizeAIConfig } from '../src/game/ai';
import { captureSave, serialize, deserialize } from '../src/game/save';
import { writeFileSync, readFileSync } from 'node:fs';

if (!process.argv[1]?.endsWith('perfbench.mjs')) throw new Error('bundle as perfbench.mjs');
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SIZE = Number(pos[0] ?? 768), NAI = Number(pos[1] ?? 1);
const YEARS = (pos[2] ?? '0,5,15').split(',').map(Number).sort((a, b) => a - b);
const SEED = Number(pos[3] ?? 7), STYLE = pos[4] ?? 'balanced';
const WINDOW = Number(flag('window', '90'));
const JSON_OUT = flag('json', '');
const LOAD = flag('load', ''), SAVE = flag('save', '');
const TICKS_PER_DAY = 40, DAYS_PER_YEAR = 360;
const towns = Math.max(3, Math.min(40, Math.round(3.2 * (SIZE / 384) ** 2)));
const mixed = ['balanced', 'rail', 'bus', 'aggressive', 'tram', 'cautious', 'balanced'];
const aiConfigs = Array.from({ length: NAI }, (_, i) => {
  const id = STYLE === 'mixed' ? mixed[i % mixed.length] : STYLE;
  return normalizeAIConfig((AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0]).config);
});
const gc = (globalThis as any).gc as (() => void) | undefined;
const heapMB = () => { gc?.(); gc?.(); return process.memoryUsage().heapUsed / 1048576; };

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const q = (sorted: ArrayLike<number>, p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);

const t0 = performance.now();
const heap0 = heapMB();
const g: any = LOAD ? deserialize(JSON.parse(readFileSync(LOAD, 'utf8'))) : Game.create({ size: SIZE, seed: SEED, towns, hilliness: 'hilly', water: 'medium', startYear: 1950, aiCompanies: NAI, aiConfigs } as any);
const startTick = g.tick;
const genMs = performance.now() - t0;
console.log(`perfbench ${LOAD ? 'loaded ' + LOAD + ' ' : ''}size ${g.world.size} seed ${SEED} towns ${g.towns.list.length} ais ${g.ais.length} (${STYLE}) gen ${f(genMs, 0)} ms, heap ${f(heapMB() - heap0, 0)} MB`);

// ---- instrumentation: inclusive ms per job inside the current tick
const jobNames: string[] = [];
const tickJobs = new Map<string, number>();
const wrap = (obj: any, name: string, label: string) => {
  if (!obj || typeof obj[name] !== 'function') return;
  const fn = obj[name];
  if (!jobNames.includes(label)) jobNames.push(label);
  obj[name] = function (this: unknown, ...args: unknown[]) {
    const s = performance.now();
    try { return fn.apply(this, args); } finally { tickJobs.set(label, (tickJobs.get(label) ?? 0) + performance.now() - s); }
  };
};
const instrument = (game: any) => {
  wrap(game.vehicles, 'update', 'vehicles');
  wrap(game.lines, 'flushCatchment', 'catchment');
  wrap(game.demand, 'daily', 'demand.daily');
  wrap(game.stations, 'daily', 'stations.daily');
  wrap(game.stations, 'updateRatings', 'ratings');
  wrap(game.towns, 'daily', 'towns.daily');
  wrap(game.mail, 'daily', 'mail.daily');
  wrap(game, 'onNewMonth', 'month');
  wrap(game, 'onNewYear', 'year');
  wrap(game, 'flushNetworkChanges', 'network');
  wrap(game, 'refreshAccess', 'access');
  for (const ai of game.ais) { wrap(ai, 'daily', 'ai.daily'); wrap(ai, 'monthly', 'ai.monthly'); wrap(ai, 'work', 'ai.work'); wrap(ai, 'sharedCapacityDaily', 'ai.shared'); }
};
instrument(g);

interface Spike { day: number; ms: number; jobs: string }
interface WindowReport {
  year: number; days: number; vehicles: number; lines: number; stations: number; edges: number;
  dayMs: { median: number; p95: number; max: number; mean: number };
  frames: Record<string, { p50: number; p99: number; max: number; over16: number; over50: number; frames: number; keepsUp: boolean }>;
  maxTick: number; spikes: Spike[]; jobs: Record<string, { total: number; max: number }>;
  save?: { captureMs: number; jsonKB: number; serializeMs: number; deserializeMs: number; heapMB: number };
}
const reports: WindowReport[] = [];

const runWindow = (year: number) => {
  const ticks = WINDOW * TICKS_PER_DAY;
  const times = new Float64Array(ticks);
  const dayMs: number[] = [];
  const spikes: Spike[] = [];
  const jobs: Record<string, { total: number; max: number }> = {};
  let dayAcc = 0;
  for (let i = 0; i < ticks; i++) {
    tickJobs.clear();
    const s = performance.now();
    g.stepTick();
    const dt = performance.now() - s;
    times[i] = dt;
    dayAcc += dt;
    for (const [k, v] of tickJobs) { const j = (jobs[k] ??= { total: 0, max: 0 }); j.total += v; if (v > j.max) j.max = v; }
    if (dt > 8) {
      const top = [...tickJobs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${f(v)}`).join(', ');
      spikes.push({ day: g.day, ms: dt, jobs: top });
    }
    if ((i + 1) % TICKS_PER_DAY === 0) { dayMs.push(dayAcc); dayAcc = 0; }
  }
  const sortedDays = Float64Array.from(dayMs).sort();
  const frames: WindowReport['frames'] = {};
  for (const speed of [1, 4, 8]) {
    // 60 fps: speed * (1/60) s of game time per frame = speed/3 ticks per frame
    const per = speed / 3, fr: number[] = [];
    for (let k = 0; ; k++) {
      const a = Math.floor(k * per + 1e-9), b = Math.floor((k + 1) * per + 1e-9);
      if (b > ticks) break;
      let ms = 0;
      for (let i = a; i < b; i++) ms += times[i];
      fr.push(ms);
    }
    const sorted = Float64Array.from(fr).sort();
    const mean = fr.reduce((x, y) => x + y, 0) / Math.max(1, fr.length);
    frames[speed + 'x'] = { p50: q(sorted, 0.5), p99: q(sorted, 0.99), max: sorted[sorted.length - 1], frames: fr.length,
      over16: fr.filter((x) => x > 16.7).length, over50: fr.filter((x) => x > 50).length, keepsUp: mean < 12 };
  }
  spikes.sort((a, b) => b.ms - a.ms);
  const vs = g.vehicles.map.size;
  const rep: WindowReport = { year, days: WINDOW, vehicles: vs, lines: g.lines.map.size, stations: g.stations.map.size, edges: g.world.net.edges.size,
    dayMs: { median: q(sortedDays, 0.5), p95: q(sortedDays, 0.95), max: sortedDays[sortedDays.length - 1], mean: dayMs.reduce((a, b) => a + b, 0) / dayMs.length },
    frames, maxTick: Math.max(...times), spikes: spikes.slice(0, 6), jobs };
  // ---- save / load costs at this point
  {
    let s = performance.now();
    captureSave(g);
    const captureMs = performance.now() - s;
    s = performance.now();
    const json = JSON.stringify(serialize(g));
    const serializeMs = performance.now() - s;
    s = performance.now();
    const back: any = deserialize(JSON.parse(json));
    const deserializeMs = performance.now() - s;
    void back;
    rep.save = { captureMs, jsonKB: json.length / 1024, serializeMs, deserializeMs, heapMB: heapMB() };
  }
  reports.push(rep);
  const d = rep.dayMs;
  console.log(`\nyear ${year} (+${WINDOW} d, ${g.dateString?.() ?? g.day}): ${vs} vehicles, ${rep.lines} lines, ${rep.stations} stations, ${rep.edges} edges`);
  console.log(`  day ms: median ${f(d.median, 2)}  mean ${f(d.mean, 2)}  p95 ${f(d.p95, 2)}  max ${f(d.max, 1)}   worst tick ${f(rep.maxTick, 1)} ms`);
  for (const [k, fr] of Object.entries(frames)) {
    console.log(`  frame@${k.padEnd(2)}: p50 ${f(fr.p50, 2)}  p99 ${f(fr.p99, 2)}  max ${f(fr.max, 1)} ms;  >16.7 ms ${fr.over16}/${fr.frames}  >50 ms ${fr.over50}${fr.keepsUp ? '' : '  (cannot keep up)'}`);
  }
  console.log('  jobs (total/max ms): ' + Object.entries(jobs).sort((a, b) => b[1].total - a[1].total).map(([k, j]) => `${k} ${f(j.total, 0)}/${f(j.max, 1)}`).join('  '));
  for (const sp of rep.spikes) console.log(`  spike day ${sp.day}: ${f(sp.ms, 1)} ms  [${sp.jobs}]`);
  const sv = rep.save!;
  console.log(`  save: capture ${f(sv.captureMs, 1)} ms, JSON ${f(sv.jsonKB, 0)} KB, serialize ${f(sv.serializeMs, 0)} ms, deserialize ${f(sv.deserializeMs, 0)} ms; heap ${f(sv.heapMB, 0)} MB`);
};

// ---- advance to each window start (whole run timed too)
const runStart = performance.now();
let skipTicks = 0, skipMs = 0, worstSkip = 0, worstSkipDay = 0;
for (const year of YEARS) {
  const target = startTick + year * DAYS_PER_YEAR * TICKS_PER_DAY;
  while (g.tick < target) {
    const s = performance.now();
    g.stepTick();
    const dt = performance.now() - s;
    skipTicks++; skipMs += dt;
    if (dt > worstSkip) { worstSkip = dt; worstSkipDay = g.day; }
  }
  runWindow(year);
}
const totalMs = performance.now() - runStart;
console.log(`\nbetween windows: ${skipTicks} ticks, mean day ${f((skipMs / Math.max(1, skipTicks)) * TICKS_PER_DAY, 2)} ms, worst tick ${f(worstSkip, 1)} ms (day ${worstSkipDay})`);
console.log(`total ${f(totalMs / 1000, 1)} s for ${g.day} days`);
const summary = reports.map((r) => `y${r.year}: day ${f(r.dayMs.median, 1)}/${f(r.dayMs.max, 0)} 8x p99 ${f(r.frames['8x'].p99, 1)} >50 ${r.frames['8x'].over50} tick ${f(r.maxTick, 0)} save ${f(r.save!.captureMs, 0)}`).join(' | ');
console.log(`SUMMARY size ${SIZE} ais ${NAI} ${STYLE} seed ${SEED}: ${summary}`);
if (SAVE) writeFileSync(SAVE, JSON.stringify(serialize(g)));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ size: SIZE, ais: NAI, style: STYLE, seed: SEED, genMs, reports, worstSkip, worstSkipDay, totalMs }, null, 1));
