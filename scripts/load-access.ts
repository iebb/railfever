// Loading an idle AI world preserves pending road access until the native network flush.
// Bundle as load-access.mjs; --json=/path/results.json retains the immutable checkpoints.
import { writeFileSync } from 'node:fs';
import type { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { flatGame, station } from './stationlib';
import { check, fails, checkReservations } from './lib';

const out = process.argv.find(s => s.startsWith('--json='))?.slice(7);
const results: unknown[] = [];
const saved = (g: Game) => JSON.stringify(serialize(g));
const protectedState = (g: Game) => {
  const s = g.stations as any;
  return JSON.stringify({ save: serialize(g), rng: g.rng.state, res: [...(g.vehicles as any).res],
    accessVersion: s.accessVersion, walkVersion: s.walkVersion, inputs: s.catchInputs,
    pendingPop: [...s.pendingPop], catchVersion: s.catchVersion, catchMaxB: s.catchMaxB });
};
function differences(a: string, b: string) {
  const items: unknown[] = [];
  const walk = (x: any, y: any, path = '') => {
    if (Object.is(x, y)) return;
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
      items.push({ path, a: x, b: y }); return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path + '/' + k);
  };
  walk(JSON.parse(a), JSON.parse(b)); return items;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net;
  const a = net.nearestNode(x0, z0, .01, 'road') ?? net.addNode('road', x0, 3, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, .01, 'road') ?? net.addNode('road', x1, 3, z1, 0, 0, -1);
  return net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1),
    new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(3), [], 'street', -1);
}

for (const edit of ['remove', 'add', 'untouched'] as const) {
  const g = flatGame(128);
  g.addAICompany({ startMoney: 100_000_000 });
  // The idle controller remains present for loadNetwork's real walking-cache warm.
  g.aiEnabled = false; g.aiAcquisitions = false; g.vehicles.ambientEnabled = false;
  const st = station(g, 60, 60, Math.PI / 2, 8, 1, 0, { style: 'modern' });
  if (!st) throw new Error('native station failed');
  const f = g.stations.forecourt(st)!;
  let approach = road(g, f.x - 24, f.z, f.x, f.z);
  g.world.addBuilding({ townId: -1, x: f.x - 6, z: f.z - 2, angle: 0, w: .8, d: .8,
    type: 0, floors: 2, pop: 30, seed: 1, y: 3, built: 0 });
  const publish = () => { g.flushNetworkChanges(); g.lines.catchmentDirty = true; g.lines.flushCatchment(); };
  publish();
  if (edit === 'add') { g.world.net.removeEdge(approach.id); g.onNetworkChanged(); publish(); }
  const priorAccess = st.roadAccess, priorPop = st.catchPop;
  if (edit === 'remove') { g.world.net.removeEdge(approach.id); g.onNetworkChanged(); }
  if (edit === 'add') { approach = road(g, f.x - 24, f.z, f.x, f.z); g.onNetworkChanged(); }
  check(g.ais.length === 1 && g.ais.every(a => !a.busy), 'one actual native AI is idle');
  check(edit === 'add' ? !priorAccess : priorAccess, 'native initial access premise: ' + edit);

  const original = protectedState(g), data = saved(g), encoded = JSON.parse(data);
  const loaded = deserialize(encoded), after = saved(loaded), diff = differences(data, after);
  const pure = protectedState(g) === original;
  check(pure, 'load preserves original state, pending work, RNG and reservations: ' + edit);
  check(after === data, 'idle AI world loads with exact pending access metadata: ' + edit);
  check(loaded.stations.get(st.id)!.roadAccess === priorAccess && loaded.stations.get(st.id)!.catchPop === priorPop,
    'AI walking warm retains saved access and population: ' + edit);
  const load = { sourceAccess: priorAccess, loadedAccess: loaded.stations.get(st.id)!.roadAccess,
    sourcePop: priorPop, loadedPop: loaded.stations.get(st.id)!.catchPop,
    sourceDirty: g.lines.catchmentDirty, loadedDirty: loaded.lines.catchmentDirty,
    accessCurrent: encoded.catchmentAccessCurrent, inputsDirty: encoded.catchmentInputsDirty, differences: diff, pure };

  let exact = true, firstMismatch: unknown;
  for (let tick = 0; tick < 640; tick++) {
    g.stepTick(); loaded.stepTick();
    const a = saved(g), b = saved(loaded);
    if (a !== b || checkReservations(g).length || checkReservations(loaded).length) {
      exact = false; firstMismatch = { tick, differences: differences(a, b) }; break;
    }
    if (tick === 0) {
      check(g.stations.get(st.id)!.roadAccess === (edit !== 'remove')
        && loaded.stations.get(st.id)!.roadAccess === (edit !== 'remove'),
      'normal next network flush publishes actual road access: ' + edit);
      check(g.stations.get(st.id)!.catchPop === (edit === 'remove' ? 0 : 30)
        && loaded.stations.get(st.id)!.catchPop === (edit === 'remove' ? 0 : 30),
      'normal next catchment flush publishes the access population: ' + edit);
    }
  }
  check(exact, 'idle AI access resumes 640 full-save/RNG ticks with lawful reservations: ' + edit);
  results.push({ edit, load, exact, firstMismatch,
    final: { tick: g.tick, pop: g.stations.get(st.id)!.catchPop, access: g.stations.get(st.id)!.roadAccess } });
  if (out) {
    writeFileSync(out + '.' + edit + '.before.native.json', data);
    writeFileSync(out + '.' + edit + '.loaded.native.json', after);
  }
}
if (out) writeFileSync(out, JSON.stringify({ failures: fails.length, results }, null, 2) + '\n');
console.log(fails.length ? `${fails.length} CHECKS FAILED` : 'ALL LOAD ACCESS CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
