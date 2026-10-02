// Simulation performance stress test: 512 map, ~12 towns, ~150 company vehicles, ambient traffic.
// Reports ms per frame at 8x speed (60 fps frames), the worst frame, and hitches after network changes.
// npx esbuild scripts/perf.ts --bundle --platform=node --format=esm --outfile=$S/perf.mjs && node $S/perf.mjs [frames]
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { findSnap } from '../src/game/construction';
import { fmt, depotBehind, placeAndConnect, addBusStop, roadDepotNear, build, roadOpts, free, Train } from './lib';

const FRAMES = Number(process.argv[2] ?? 3000);
const T0 = performance.now();
const TOWNS = Number(process.argv[3] ?? 20);
const g = Game.create({ size: 512, seed: 5, towns: TOWNS, hilliness: 'hilly', water: 'medium', startYear: 1985 });
const genMs = performance.now() - T0;
g.economy.money = 1e9;
const quiet = () => {};

// ---- bus lines: two per town, 5 buses each
let busLines = 0, buses = 0;
for (const town of g.towns.list) {
  const pts: [number, number][] = [];
  for (const e of g.towns.streets(town, 0)) {
    if (e.len < 4) continue;
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    if (!g.stations.planBusStop(p.x, p.z, 0).ok) continue;
    if (pts.every((q) => Math.hypot(q[0] - p.x, q[1] - p.z) > 9)) pts.push([p.x, p.z]);
  }
  pts.sort((a, b) => Math.hypot(a[0] - town.x, a[1] - town.z) - Math.hypot(b[0] - town.x, b[1] - town.z));
  if (pts.length < 4) continue;
  const ids = pts.slice(0, 4).map((p) => addBusStop(g, p[0], p[1], 0));
  const dep = roadDepotNear(g, pts[0][0], pts[0][1], 0);
  if (dep < 0) continue;
  for (const [a, b] of [[0, 2], [1, 3]]) {
    if (ids[a] < 0 || ids[b] < 0 || ids[a] === ids[b]) continue;
    const l = g.lines.create('road', 0);
    l.stops = [ids[a], ids[b]];
    busLines++;
    for (let k = 0; k < 5; k++) if (typeof g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_c')!, l.id) !== 'string') buses++;
  }
}
// ---- intercity bus lines over the generated country roads, 3 buses each
let icLines = 0;
{
  const centreStop = (t: (typeof g.towns.list)[number]) => {
    const st = [...g.stations.map.values()].filter((s) => s.owner === 0 && s.stops.length && Math.hypot(s.x - t.x, s.z - t.z) < t.radius);
    st.sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    return st[0];
  };
  const T = g.towns.list;
  for (let i = 0; i < T.length && icLines < 6; i++) for (let j = i + 1; j < T.length && icLines < 6; j++) {
    const d = Math.hypot(T[i].x - T[j].x, T[i].z - T[j].z);
    if (d < 60 || d > 130) continue;
    const a = centreStop(T[i]), b = centreStop(T[j]);
    if (!a || !b) continue;
    const dep = roadDepotNear(g, a.stops[0].x, a.stops[0].z, 0);
    if (dep < 0) continue;
    const l = g.lines.create('road', 0);
    l.stops = [a.id, b.id];
    icLines++;
    for (let k = 0; k < 3; k++) if (typeof g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_c')!, l.id) !== 'string') buses++;
  }
}
// ---- rail lines between town pairs, 3 trains each
let railLines = 0, trains = 0;
const used = new Set<number>();
for (let k = 0; k < 8; k++) {
  const pr = placeAndConnect(g, 70, 200, 0, used, 1, quiet);
  if (!pr) break;
  used.add(pr.TA.id); used.add(pr.TB.id);
  const dep = depotBehind(g, pr.A, pr.B, 0);
  if (dep < 0) continue;
  const l = g.lines.create('rail', 0);
  l.stops = [pr.A.id, pr.B.id];
  railLines++;
  for (let i = 0; i < 3; i++) {
    const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], l.id);
    if (t instanceof Train) trains++;
  }
}
const setupMs = performance.now() - T0 - genMs;
// warm up: let vehicles leave depots and ambient traffic spawn
g.speed = 8;
for (let i = 0; i < 600; i++) g.update(1 / 60);
console.log(`512 map: gen ${fmt(genMs, 0)} ms, setup ${fmt(setupMs, 0)} ms; ${busLines} town + ${icLines} intercity bus lines/${buses} buses, ${railLines} rail lines/${trains} trains, ambient ${g.vehicles.ambient.length}, edges ${g.world.net.edges.size}`);

// ---- instrument periodic jobs
const jobs = new Map<string, { n: number; t: number; max: number }>();
const wrap = (obj: any, name: string, label: string) => {
  const f = obj[name].bind(obj);
  obj[name] = (...args: any[]) => {
    const t = performance.now();
    const r = f(...args);
    const dt = performance.now() - t;
    const j = jobs.get(label) ?? { n: 0, t: 0, max: 0 };
    j.n++; j.t += dt; j.max = Math.max(j.max, dt);
    jobs.set(label, j);
    return r;
  };
};
wrap(g.towns, 'growStep', 'town growStep');
wrap(g.lines, 'rebuild', 'lines.rebuild');
wrap(g.stations, 'recomputeCatchment', 'catchment');
wrap(g.vehicles, 'manageAmbient', 'manageAmbient');
wrap(g.vehicles, 'onNetworkChanged', 'vehicles.onNetworkChanged');
wrap(g, 'flushNetworkChanges', 'flushNetworkChanges');
for (const ai of g.ais) { wrap(ai, 'daily', 'ai.daily'); wrap(ai, 'monthly', 'ai.monthly'); }

// ---- 8x speed frames
const times: number[] = [];
const d0 = g.day;
for (let i = 0; i < FRAMES; i++) {
  const t = performance.now();
  g.update(1 / 60);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
const states = new Map<string, number>();
for (const v of g.vehicles.all()) states.set(v.kind + ':' + v.state, (states.get(v.kind + ':' + v.state) ?? 0) + 1);
console.log(`8x: ${FRAMES} frames (${g.day - d0} days): avg ${fmt(avg, 2)} ms, p50 ${fmt(pct(0.5), 2)}, p95 ${fmt(pct(0.95), 2)}, p99 ${fmt(pct(0.99), 2)}, max ${fmt(times[times.length - 1], 1)} ms; ambient ${g.vehicles.ambient.length}`);
console.log('  vehicle states', [...states.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
console.log('  jobs: ' + [...jobs.entries()].map(([k, j]) => `${k} n=${j.n} total=${fmt(j.t, 0)}ms max=${fmt(j.max, 1)}ms`).join(' | '));
jobs.clear();

// ---- network change hitches: build roads in towns while everything runs
const hitches: number[] = [];
for (const town of g.towns.list.slice(0, 6)) {
  const a = findSnap(g, 'road', town.x + town.radius + 6, town.z, 1.2);
  const p = build(g, a.kind === 'free' ? free(g, town.x + town.radius + 6, town.z) : a, free(g, town.x + town.radius + 16, town.z + 3), roadOpts(0, 'road'), 'perf road');
  if (!p) continue;
  const t = performance.now();
  g.update(1 / 60);
  hitches.push(performance.now() - t);
}
console.log(`network change: next frame ${hitches.map((h) => fmt(h, 1)).join(', ')} ms`);
console.log('  jobs: ' + [...jobs.entries()].map(([k, j]) => `${k} n=${j.n} total=${fmt(j.t, 0)}ms max=${fmt(j.max, 1)}ms`).join(' | '));
