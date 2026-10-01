import { Game } from '../src/game/game';
import { planRoute, commitPlan } from '../src/game/construction';
import { planRailStation, commitRailStation, commitBusStop, commitDepot, autoDepotDir, toggleSignal, bulldoze, terraformCorner } from '../src/game/build-ops';
import { MODEL_BY_ID, availableModels } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { RNG } from '../src/game/rng';
import { serialize, deserialize } from '../src/game/save';

const seed = Number(process.argv[2] ?? 1);
const r = new RNG(seed);
let g = Game.create({ size: 96, seed, towns: 6, hilliness: 'hilly', water: 'medium', startYear: 1960 });
g.economy.money = 1e9;
const w = () => g.world;
const rt = () => ({ x: 4 + r.int(w().size - 8), z: 4 + r.int(w().size - 8) });
const near = (p: { x: number; z: number }, d: number) => ({ x: Math.max(2, Math.min(w().size - 3, p.x + r.int(2 * d + 1) - d)), z: Math.max(2, Math.min(w().size - 3, p.z + r.int(2 * d + 1) - d)) });
let ops = 0, errs = 0;
function checkInvariants() {
  const V = g.vehicles as any;
  const resv: Int32Array = V.resv;
  const trains = new Map<number, Train>();
  for (const t of g.vehicles.trains()) trains.set(t.id, t);
  for (let i = 0; i < resv.length; i++) {
    const id = resv[i];
    if (!id) continue;
    const t = trains.get(id);
    if (!t || !t.segs.some((s) => s.res === i)) throw new Error(`stale reservation tile ${i} by ${id}`);
  }
  for (const t of trains.values()) {
    for (let i = 1; i < t.segs.length; i++) {
      // contiguity check: each seg's start must be near previous end
      const a = t.segs[i - 1], b = t.segs[i];
      const pa = { x: 0, y: 0, z: 0 }, pb = { x: 0, y: 0, z: 0 };
      const ca = a.curve, cb = b.curve;
      const ea = a.rev ? 0 : ca.pts.length / 3 - 1, sb = b.rev ? cb.pts.length / 3 - 1 : 0;
      pa.x = ca.pts[ea * 3]; pa.z = ca.pts[ea * 3 + 2]; pb.x = cb.pts[sb * 3]; pb.z = cb.pts[sb * 3 + 2];
      if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > 0.05) throw new Error(`train ${t.id} path gap between seg ${i - 1} and ${i}: ${JSON.stringify([pa, pb])}`);
    }
    if (t.segs.length && (t.headSeg < 0 || t.headSeg >= t.segs.length)) throw new Error('bad headSeg');
  }
}
const towns = g.towns.list;
for (let step = 0; step < 600; step++) {
  const k = r.next();
  const town = towns[r.int(towns.length)];
  try {
    if (k < 0.25) {
      const a = near(town, 12), b = near(a, 20);
      const p = planRoute(g, r.chance(0.6) ? 'rail' : 'road', a.x, a.z, b.x, b.z);
      if (p.ok) commitPlan(g, p);
    } else if (k < 0.35) {
      const a = near(town, 10);
      const p = planRailStation(g, a.x, a.z, r.int(2), 2 + r.int(4), 1 + r.int(2));
      if (p.ok) commitRailStation(g, p);
    } else if (k < 0.42) {
      const a = near(town, 6);
      commitBusStop(g, a.x, a.z);
    } else if (k < 0.48) {
      const a = near(town, 10);
      const kind = r.chance(0.5) ? 'rail' : 'road';
      commitDepot(g, kind, a.x, a.z, autoDepotDir(g, kind, a.x, a.z, r.int(4)));
    } else if (k < 0.55) {
      const a = near(town, 12);
      toggleSignal(g, a.x, a.z);
    } else if (k < 0.62) {
      const a = near(town, 12);
      bulldoze(g, a.x, a.z, a.x + r.int(3), a.z + r.int(3), false);
    } else if (k < 0.65) {
      const a = near(town, 12);
      terraformCorner(g, a.x, a.z, r.chance(0.5) ? 1 : -1);
    } else if (k < 0.75) {
      // lines
      const sts = g.stations.all();
      if (sts.length >= 2) {
        const kind = r.chance(0.5) ? 'rail' : 'road';
        const cands = sts.filter((s) => (kind === 'rail' ? g.stations.hasRail(s) : g.stations.hasRoad(s)));
        if (cands.length >= 2) {
          const l = g.lines.all().find((x) => x.kind === kind && r.chance(0.5)) ?? g.lines.create(kind);
          const s = cands[r.int(cands.length)];
          if (l.stops[l.stops.length - 1] !== s.id) l.stops.push(s.id);
          g.lines.rebuild();
          for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
        }
      }
    } else if (k < 0.85) {
      const deps = [...w().depots.values()];
      if (deps.length) {
        const dp = deps[r.int(deps.length)];
        const lines = g.lines.all().filter((l) => l.kind === dp.kind);
        const line = lines.length ? lines[r.int(lines.length)] : null;
        if (dp.kind === 'rail') {
          const loco = availableModels(g.year, 'loco')[0], wag = availableModels(g.year, 'wagon')[0];
          g.vehicles.buyTrain(dp.id, [loco, ...Array(1 + r.int(4)).fill(wag)], line ? line.id : null);
        } else g.vehicles.buyRoad(dp.id, availableModels(g.year, 'bus')[0], line ? line.id : null);
      }
    } else if (k < 0.88) {
      const vs = g.vehicles.all();
      if (vs.length) g.vehicles.sell(vs[r.int(vs.length)].id);
    } else if (k < 0.9) {
      const ls = g.lines.all();
      if (ls.length && r.chance(0.3)) g.lines.delete(ls[r.int(ls.length)].id);
    } else if (k < 0.91) {
      // save/load roundtrip
      g = deserialize(JSON.parse(JSON.stringify(serialize(g))));
      g.economy.money = 1e9;
    }
    ops++;
    for (let i = 0; i < 20; i++) g.update(0.25);
    checkInvariants();
  } catch (e) {
    errs++;
    console.error('step', step, 'error:', (e as Error).stack?.split('\n').slice(0, 6).join('\n'));
    if (errs > 5) break;
  }
}
const trains = g.vehicles.trains();
console.log('seed', seed, 'ops', ops, 'errs', errs, 'day', g.day, 'stations', g.stations.map.size, 'lines', g.lines.map.size, 'vehicles', g.vehicles.map.size,
  'trains moving', trains.filter((t) => t.state === 'running').length, 'delivered', g.vehicles.all().reduce((s, v) => s + v.delivered, 0));
const states = new Map<string, number>();
for (const v of g.vehicles.all()) { const k = v.kind + ':' + v.state + ':' + v.status.replace(/ to .*/, '').replace(/ at .*/, ''); states.set(k, (states.get(k) ?? 0) + 1); }
console.log([...states.entries()]);
console.log(g.lines.all().map((l) => `${l.kind} stops=${l.stops.length} veh=${l.vehicles.length}`).join(' | '));
