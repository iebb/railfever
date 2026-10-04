// City catchments and interchanges (citycatch). In-city metro and light-rail stations walk half as far (a quarter of
// the area; walks stay physical: one walking weight and coverage curve for every station), decided by town
// (population and core radius, with hysteresis) when built and at month ends, and saved; main-line stations and
// stops out of town keep the full reach; a merged station's parts keep their own reaches; mail follows the same areas.
// Two city lines' stations a short walk apart become one interchange (the AI links them, or builds a stop of its own
// beside the other line's station when the trips pay); a new city line stops beside an existing station; the AI still
// builds city railways in large towns.
// npx esbuild scripts/citycatch.ts --bundle --platform=node --format=esm --outfile=$S/citycatch.mjs && node $S/citycatch.mjs
import '../src/game/patterns';
import { Game } from '../src/game/game';
import type { AIController } from '../src/game/ai';
import type { Town } from '../src/game/towns';
import type { Station, StationOpts } from '../src/game/stations';
import { CATCHMENT_RADIUS, CITY_WALK_SCALE, CITY_STATION, CITY_TRANSFER_RANGE, railWalkScale, planWalkScale, railPartMode, TRANSFER_RANGE, stationComplex } from '../src/game/stations';
import { walkingCatchment, walkingPopulation, walkWeight, coverOf, walkLimit, entranceCatchment, planWalkingCatchment, stopWalkingCatchment, pointWalkingCatchment, stopSiteWalkingCatchment, FULL_COVER_WALK } from '../src/game/catchment';
import { styleOf } from '../src/game/station-styles';
import { runNetworkTask, networkProfile } from '../src/game/ai-network';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { stationEnds, nodeSnap, depotAtEnd } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { planTerminusYard, buildTerminusYard } from '../src/game/ai-grow';
import { connectStationThroat, finishDoubleTrack, canMerge, mergeStations } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { outAndBack } from '../src/game/lines';
import { Train } from '../src/game/train';
import { check, fails, fmt, build, railOpts, addBusStop } from './lib';

const T0 = performance.now();
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const stat = (ai: AIController, k: string) => (ai.stats as unknown as Record<string, number>)[k] ?? 0;
/** `node citycatch.mjs 3,5`: run only those sections. */
const ONLY = process.argv.slice(2).find((a) => /^[0-9,]+$/.test(a))?.split(',');
function section(n: number, title: string, run: () => void) {
  if (ONLY && !ONLY.includes(String(n))) return;
  console.log(title);
  run();
}

/** A flat game with `ais` AI companies (open access, money, no projects of their own). */
function flat(ais = 0, size = 512): Game {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  for (const w of [...g.world.buildings.keys()]) g.world.removeBuilding(w);
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  g.economy.money = 400_000_000;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
/**
 * A town on a street grid every 8 units (`width` x `height`, `pop` residents in apartment blocks along the streets);
 * `free`: a strip of this half-width along x through the centre stays unbuilt (a corridor for surface lines).
 */
function town(g: Game, name: string, x: number, z: number, pop: number, width = 160, height = 96, free = 0): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) if (!(free && zs[i - 1] < z && zs[i] > z)) road(g, rx, zs[i - 1], rx, zs[i]);
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) {
    if (free && Math.abs(rz - z) < free) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    t.buildings.add(g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 6, pop: count, seed: i, y: 4, built: 0 }).id);
  });
  g.demand.rebuild();
  return t;
}
/** A committed rail station (planRail + commitRail), or null with the reason logged. */
function railStation(g: Game, x: number, z: number, angle: number, length: number, owner: number, opts: StationOpts = {}): Station | null {
  const p = g.stations.planRail(x, z, angle, length, 2, owner, opts);
  if (!p.ok) { console.log(`  station ${fmt(x)},${fmt(z)}: ${p.error}`); return null; }
  const id = g.stations.nextId, err = g.stations.commitRail(p, owner);
  if (err) { console.log(`  station ${fmt(x)},${fmt(z)}: ${err}`); return null; }
  return g.stations.get(p.join ? p.join.id : id) ?? null;
}
/** Share the catchments out now (as the next tick would). */
function shareOut(g: Game) { g.lines.rebuild(); g.lines.catchmentDirty = true; g.lines.flushCatchment(); }

/** A depot beyond a station's end facing `away`: a ramp (to the ground from below or above the street) and the depot at its end. */
function rampDepot(g: Game, st: Station, away: { x: number; z: number }, owner: number, type: string): number {
  const net = g.world.net, r = st.rail!, ux = Math.sin(r.angle), uz = Math.cos(r.angle);
  const dir = ux * (away.x - st.x) + uz * (away.z - st.z) >= 0 ? 1 : -1;
  // Subway fixtures use the same quoted underground yard as ordinary native construction.
  if (r.level === 'underground' && railPartMode(r) === 'metro') {
    const plan = planTerminusYard(g, owner, st, dir > 0 ? 'front' : 'back', null, p => p.ok);
    if (!plan) return -1;
    const cash = g.company(owner).economy.money;
    const depot = buildTerminusYard(g, owner, plan, p => p.ok);
    check(depot >= 0 && cash > g.company(owner).economy.money && g.depots.get(depot)?.level === 'underground',
      'subway fixture pays for its native complete underground yard');
    if (depot >= 0) connectStationThroat(g, st.id, owner);
    return depot;
  }
  const end = stationEnds(g, st).map((e) => (dir > 0 ? e.front : e.back))[0];
  const ramp = r.level === 'underground' ? 58 : r.level === 'elevated' ? 26 : 10;
  for (const k of [1, 1.25, 1.5, 2]) for (const lat of [0, 12, -12, 24, -24]) {
    const n0 = net.nodes.get(end)!, x = n0.x + ux * dir * ramp * k - uz * lat, z = n0.z + uz * dir * ramp * k + ux * lat;
    if (!g.world.inside(x, z, 8)) continue;
    const pr = planEdge(g, nodeSnap(g, end, 'rail'), { kind: 'free', x, z, y: g.world.heightAt(x, z) }, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner });
    if (!pr.ok || commitProposal(g, pr)) continue;
    const n = net.nearestNode(x, z, 0.1, 'rail', (q) => q.edges.length === 1);
    const dep = n ? depotAtEnd(g, n.id, owner) : -1;
    if (dep >= 0) { connectStationThroat(g, st.id, owner); return dep; }
  }
  return -1;
}

/**
 * A double-track city line over the stations (in order), owned by `owner`: track between them at their level, a
 * depot beyond the last station, directional running, signals and `trains` units of `model`; the line id or -1.
 */
function cityLine(g: Game, owner: number, sts: Station[], model: string, trains = 2, tt = 'lightrail'): number {
  const net = g.world.net, e0 = net.nextEdge;
  const fwd = (a: Station, b: Station) => Math.sin(a.rail!.angle) * (b.x - a.x) + Math.cos(a.rail!.angle) * (b.z - a.z) >= 0;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = sts[i], b = sts[i + 1];
    const ea = stationEnds(g, a).map((e) => (fwd(a, b) ? e.front : e.back)), eb = stationEnds(g, b).map((e) => (fwd(b, a) ? e.front : e.back));
    const lv = a.rail!.level;
    const p = build(g, nodeSnap(g, ea[0], 'rail'), nodeSnap(g, eb[0], 'rail'), railOpts(owner, 2, { type: tt, level: lv, levelDepth: a.rail!.depth || undefined, levelHeight: a.rail!.height || undefined, crossing: lv === 'ground' ? 'level' : 'auto' }), `city track ${a.name}-${b.name}`);
    if (!p) return -1;
  }
  const edges = [...net.edges.values()].filter((e) => e.id >= e0 && e.owner === owner && e.station < 0 && e.depot < 0).map((e) => e.id);
  const last = sts[sts.length - 1], prev = sts[sts.length - 2];
  const dep = rampDepot(g, last, { x: 2 * last.x - prev.x, z: 2 * last.z - prev.z }, owner, tt);
  if (dep < 0) { check(false, `city line: a depot beyond ${last.name}`); return -1; }
  finishDoubleTrack(g, edges, owner);
  const l = g.lines.create('rail', owner);
  l.stops = outAndBack(sts.map((s) => s.id));
  autoSignalLine(g, l.id, owner);
  for (let i = 0; i < trains; i++) { const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get(model)!], l.id); if (!(t instanceof Train)) { check(false, `city line: a train (${t})`); return -1; } }
  g.lines.rebuild();
  return l.id;
}

// ------------------------------------------------------------------ 1. in-city metro and light rail walk half as far
section(1, 'in-city metro and light-rail stations walk half as far', () => {
  const sites: [string, StationOpts, number][] = [['metro', { trackType: 'metro', level: 'underground', style: 'none' }, 12],
    ['lightrail', { trackType: 'lightrail', level: 'elevated', style: 'none' }, 7], ['standard', { trackType: 'standard', level: 'underground', style: 'none' }, 12]];
  const res = new Map<string, { st: Station; g: Game; pop: number; streets: number }>();
  for (const [tt, opts, len] of sites) {
    const g = flat(), t = town(g, 'Dense', 256, 256, 8000);
    const plan = g.stations.planRail(256, 258, Math.PI / 2, len, 2, 0, opts);
    check(plan.ok && !!plan.city === (tt !== 'standard'), `${tt}: the plan stands in town (${plan.city ?? false}; ${plan.error ?? 'ok'}), core radius ${fmt(g.towns.maxRadius(t), 1)}`);
    const st = railStation(g, 256, 258, Math.PI / 2, len, 0, opts)!;
    shareOut(g);
    const w = walkingCatchment(g, st);
    res.set(tt, { st, g, pop: walkingPopulation(g, w), streets: w.segments.reduce((a, s) => a + Math.hypot(s.x1 - s.x0, s.z1 - s.z0), 0) });
  }
  const M = res.get('metro')!, L = res.get('lightrail')!, S = res.get('standard')!;
  for (const [tt, r] of [['metro', M], ['lightrail', L]] as const) {
    const { g, st } = r, R = CATCHMENT_RADIUS.rail * CITY_WALK_SCALE, limit = walkLimit('rail') * CITY_WALK_SCALE;
    check(st.city === true && railWalkScale(st) === CITY_WALK_SCALE && near(g.stations.catchmentRadius(st), R), `${tt}: in town, half the rail reach (${fmt(g.stations.catchmentRadius(st) * 10, 1)} m nominal)`);
    check(g.stations.catchmentShapes(st, true).every((c) => c.mode === 'rail' && near(c.r, R)), `${tt}: every access shape (its ${st.rail!.entrances.length} entrances too) at the half reach`);
    const wb = [...walkingCatchment(g, st).buildings.values()], walks = wb.map((b) => b.distance);
    check(walks.length > 0 && walks.every((d) => d <= limit + 1e-6) && wb.every((b) => near(b.limit, limit)), `${tt}: every walk within the half limit (${fmt(Math.max(...walks), 2)} <= ${fmt(limit, 2)} units)`);
    // one curve of the physical walk for every station: the half reach (147 m along streets) ends where the full
    // coverage of the taper (FULL_COVER_WALK, 147 m) ends, so an in-city stop covers all it reaches, nothing beyond
    const S2 = g.stations, own = wb.length;
    let checked = 0, ok = true;
    for (const [id, b] of walkingCatchment(g, st).buildings) {
      const sh = S2.stationsForBuilding(id);
      if (sh.st.length !== 1) continue;
      checked++;
      if (!near(sh.w[0], coverOf(walkWeight(b.distance)), 1e-9) || !near(sh.w[0], 1, 1e-9)) ok = false;
    }
    check(near(limit, FULL_COVER_WALK) && checked > 0 && ok, `${tt}: covered by the walk as at every station, wholly within its reach (${checked}/${own} buildings it alone reaches, full coverage to ${fmt(FULL_COVER_WALK, 2)} units)`);
  }
  console.log(`  walking residents: metro ${M.pop}, light rail ${L.pop}, main-line-style at the same place ${S.pop}; streets ${fmt(M.streets, 0)} / ${fmt(S.streets, 0)} units`);
  check(M.pop > 0 && M.pop < S.pop * 0.5 && M.streets < S.streets * 0.45, `a quarter of the area: the in-city metro reaches ${fmt(M.pop / S.pop * 100, 0)}% of the residents and ${fmt(M.streets / S.streets * 100, 0)}% of the streets of a main-line-style station at the same place`);
  // entrances: an added entrance reaches as far as the station itself
  {
    const { g, st } = M;
    // (the first place beside a street within reach where an entrance fits, scanning out from the station)
    let pl = g.stations.planEntrance(st.id, st.x, st.z - 7, 0);
    search: for (let r = 6; r <= 20; r += 2) for (let k = 0; k < 16; k++) {
      pl = g.stations.planEntrance(st.id, st.x + Math.cos(k * Math.PI / 8) * r, st.z + Math.sin(k * Math.PI / 8) * r, 0);
      if (pl.ok) break search;
    }
    const err = pl.ok ? g.stations.commitEntrance(st.id, pl, 0) : pl.error;
    check(!err, `metro: an added entrance (${err ?? 'ok'})`);
    const i = st.rail!.entrances.length - 1, walk = entranceCatchment(g, st, i);
    check(!err && walk.buildings.size > 0 && [...walk.buildings.values()].every((b) => b.distance <= walkLimit('rail') * CITY_WALK_SCALE + 1e-6 && near(b.limit, walkLimit('rail') * CITY_WALK_SCALE)),
      `metro: the added entrance walks at the station's half reach too (${walk.buildings.size} buildings)`);
  }
  // a merged station's parts keep their own reaches: its bus stop walks as a bus stop, its rail access at half
  {
    const { g, st } = L;
    const stop = addBusStop(g, st.x + 10, 252, 0);
    if (stop >= 0 && stop !== st.id) check(!g.stations.merge(st.id, stop), 'light rail: a bus stop merged into the station');
    const s = g.stations.get(st.id)!;
    shareOut(g);
    const segs = walkingCatchment(g, s).segments;
    const bus = segs.filter((q) => q.mode === 'bus'), rail = segs.filter((q) => q.mode === 'rail');
    check(s.stops.length >= 1 && bus.length > 0 && rail.length > 0 && s.city === true, `light rail with a merged bus stop: bus walks (${bus.length} pieces) and half-reach rail walks (${rail.length})`);
    const busLimit = walkLimit('bus'), railLimit = walkLimit('rail') * CITY_WALK_SCALE, wb = [...walkingCatchment(g, s).buildings];
    const far = Math.max(...wb.map(([, b]) => b.limit));
    check(near(far, busLimit), `the merged bus stop keeps the bus reach (${fmt(far, 2)} = ${fmt(busLimit, 2)} units), the rail part its half reach`);
    // mixed bus and half-reach rail access: walks stay physical, each within its own access point's limit; what only
    // the bus stop reaches has its walk to the stop (the stop's own catchment), and all share one curve of the walk
    const stopP = s.stops[0], own = stopP ? stopWalkingCatchment(g, stopP.edge, stopP.s, 'bus').buildings : new Map();
    const byBus = wb.filter(([, b]) => near(b.limit, busLimit)), byRail = wb.filter(([, b]) => near(b.limit, railLimit));
    check(byBus.length > 0 && byRail.length > 0 && wb.every(([, b]) => b.distance <= b.limit + 1e-6 && (near(b.limit, busLimit) || near(b.limit, railLimit)))
      && byBus.every(([id, b]) => b.distance >= railLimit - 1e-6 || near(b.distance, own.get(id)?.distance ?? -1)),
      `mixed bus and half-reach rail: physical walks within each access point's own limit (${byBus.length} by the bus stop's reach, ${byRail.length} by the rail part's)`);
    const shares = wb.map(([id, b]) => ({ b, sh: g.stations.stationsForBuilding(id) })).filter((x) => x.sh.st.length === 1);
    check(shares.length > 0 && shares.every((x) => near(x.sh.w[0], coverOf(walkWeight(x.b.distance)), 1e-9)), 'mixed bus and rail: its buildings covered by the physical walk, whichever access reaches them');
  }
  // mail shares the same walking areas (mail.ts allocateMail reads the walking catchments)
  {
    const { g } = M, pl = g.stations.planRail(200, 258, Math.PI / 2, 12, 2, 0, { trackType: 'metro', level: 'underground', style: 'none' });
    const plS = g.stations.planRail(200, 258, Math.PI / 2, 12, 2, 0, { trackType: 'standard', level: 'underground', style: 'none' });
    const [mc] = g.mail.forecastPops([pl], 300), [ms] = g.mail.forecastPops([plS], 300);
    check(planWalkScale(pl) === CITY_WALK_SCALE && planWalkScale(plS) === 1 && mc > 0 && mc < ms * 0.6, `mail: an in-city stop collects from its smaller area (${fmt(mc, 0)} vs ${fmt(ms, 0)} weighted residents)`);
    const walk = planWalkingCatchment(g, pl);
    check([...walk.buildings.values()].every((b) => b.distance <= walkLimit('rail') * CITY_WALK_SCALE + 1e-6), 'mail and passenger previews of a planned in-city stop walk the half reach');
  }
  // the AI's estimate of an in-city stop before it plans one (its selection and spacing): walks at the half reach from
  // the streets by the platform ends and sides, as the station's four entrances will (not from one point at the site)
  {
    const { g } = M, x = 200, z = 258, lim = walkLimit('rail') * CITY_WALK_SCALE;
    const pl = g.stations.planRail(x, z, Math.PI / 2, 12, 2, 0, { trackType: 'metro', level: 'underground', style: 'none', entrances: 4 });
    const est = stopSiteWalkingCatchment(g, x, z, Math.PI / 2, 12, 'rail', CITY_WALK_SCALE);
    const pe = walkingPopulation(g, est), pr = pl.ok ? walkingPopulation(g, planWalkingCatchment(g, pl)) : 0;
    console.log(`  AI estimate of an in-city stop: ${fmt(pe, 0)} walking residents; planned with four entrances ${fmt(pr, 0)}`);
    check(pl.ok && pl.entrances.length === 4 && [...est.buildings.values()].every((b) => b.distance <= lim + 1e-6 && near(b.limit, lim)) && pe > pr * 0.6 && pe < pr * 1.5,
      `AI estimate of an in-city stop: ${fmt(pe, 0)} walking residents from its entrances' streets (the planned station with four entrances: ${fmt(pr, 0)})`);
    check(walkingPopulation(g, stopSiteWalkingCatchment(g, x, z, Math.PI / 2, 12, 'rail', 1)) === walkingPopulation(g, pointWalkingCatchment(g, x, z, 'rail', 0, 8)),
      'a stop walking its full reach is estimated from the one point at its site, as before');
  }
  // trips per building never depend on a station's type: an in-city metro stop and a main-line station reaching one
  // building share it by their physical walks alone (one curve), and cover it by the nearer walk
  {
    const { g, st } = M;
    const main = railStation(g, st.x + 22, 258, Math.PI / 2, 8, 0, { trackType: 'standard', level: 'underground', style: 'none' });
    if (!main) { check(false, 'type-neutral shares: a main-line station beside the metro'); return; }
    shareOut(g);
    const wm = walkingCatchment(g, st).buildings, wl = walkingCatchment(g, main).buildings;
    const both = [...wm.keys()].filter((id) => wl.has(id) && g.stations.stationsForBuilding(id).st.length === 2);
    const ok = both.every((id) => {
      const sh = g.stations.stationsForBuilding(id), dm = wm.get(id)!.distance, dl = wl.get(id)!.distance;
      const a = walkWeight(dm), b = walkWeight(dl), cover = coverOf(Math.max(a, b));
      return near(sh.w[sh.st.indexOf(st.id)], a / (a + b) * cover, 1e-9) && near(sh.w[sh.st.indexOf(main.id)], b / (a + b) * cover, 1e-9);
    });
    check(both.length > 0 && ok, `type-neutral shares: ${both.length} buildings reached by an in-city metro stop and a main-line station split by their physical walks alone`);
    const points = [200, 320].map((x) => g.stations.planRail(x, 258, Math.PI / 2, 7, 2, 0,
      { mode: 'metro', trackType: 'electric', level: 'underground', style: 'none', entrances: 4 }));
    const forecasts = ['mainline', 'metro', 'lightrail'].map((mode) => g.demand.forecastLine(points, mode as 'mainline' | 'metro' | 'lightrail', 35, 900));
    check(points.every((p) => p.ok) && forecasts[0].boardings > 0 && forecasts.every((f) => JSON.stringify(f) === JSON.stringify(forecasts[0])),
      'identical platforms and walkers: the forecast earns identical trips and revenue for every rail style, including sparse queues');
  }
});

// ------------------------------------------------------------------ 2. main line and country stations keep the full reach
section(2, 'main-line stations and metro / light rail out of town keep the full reach', () => {
  const g = flat(), big = town(g, 'Big', 256, 200, 8000), village = town(g, 'Village', 256, 400, 1200, 48, 32);
  const main = railStation(g, 256, 202, Math.PI / 2, 8, 0, { trackType: 'standard', level: 'underground', style: 'none' })!;
  const vil = railStation(g, 256, 402, Math.PI / 2, 7, 0, { trackType: 'lightrail', level: 'elevated', style: 'none' })!;
  // out in the country, beyond the big town's core: a hamlet along a lane
  road(g, 256 + 110, 120, 256 + 140, 120);
  for (const hx of [370, 374, 386, 390]) g.world.addBuilding({ townId: -1, x: hx, z: 118.6, angle: 0, w: 1.2, d: 1.2, type: 0, floors: 2, pop: 12, seed: hx, y: 4, built: 0 });
  const out = railStation(g, 380, 124, Math.PI / 2, 7, 0, { trackType: 'lightrail', style: 'shelter' })!;
  shareOut(g);
  for (const [what, st] of [['main line in the centre', main], ['light rail in a village of 1,200', vil], ['light rail out of town', out]] as const) {
    check(!!st && st.city === undefined && railWalkScale(st) === 1 && near(g.stations.catchmentRadius(st), CATCHMENT_RADIUS.rail * (1 + styleOf(st.rail!.style).catchBonus)), `${what}: not in town, the full rail reach (${st?.city})`);
    const wb = st ? [...walkingCatchment(g, st).buildings.values()] : [];
    const farthest = Math.max(0, ...wb.map((b) => b.distance));
    check(!!st && wb.length > 0 && wb.every((b) => b.limit >= walkLimit('rail') - 1e-9) && (what !== 'main line in the centre' || farthest > walkLimit('rail') * CITY_WALK_SCALE),
      `${what}: walks to the full rail limit (${wb.length} buildings, farthest walk ${fmt(farthest, 1)} units)`);
  }
  check(g.stations.cityAt(256, 200, big) && !g.stations.cityAt(256, 400, village) && !g.stations.cityAt(380, 124, big), 'in town: the big town\'s core only (not a village, not beyond the core)');
  const busId = addBusStop(g, 196, 228, 0), bus = g.stations.get(busId)!;
  check(!!bus && railWalkScale(bus) === 1 && near(g.stations.catchmentRadius(bus), CATCHMENT_RADIUS.bus), 'bus stops keep their own reach in town');
  void big;
});

// ------------------------------------------------------------------ 3. standing in town: monthly, with hysteresis, no flicker
section(3, 'standing in town: built and month ends, with hysteresis', () => {
  const g = flat(), t = town(g, 'Edge', 256, 256, 3200, 120, 80);
  const st = railStation(g, 256, 258, Math.PI / 2, 7, 0, { trackType: 'lightrail', level: 'elevated', style: 'none' })!;
  check(st.city === true, `a light-rail station in a town of ${t.pop}: in town from the start`);
  const v0 = g.stations.walkVersion;
  const flips: string[] = [];
  let was = st.city === true;
  const month = (pop: number) => {
    t.pop = pop; g.stations.updateCity();
    const now = st.city === true;
    if (now !== was) flips.push(`${pop}:${now}`);
    was = now;
  };
  // buildings come and go around the threshold: no change while above leavePop
  for (const p of [2950, 3050, 2700, 2900, 3100, 2650, 3000]) month(p);
  check(flips.length === 0 && st.city === true && g.stations.walkVersion === v0, `between ${CITY_STATION.leavePop} and ${CITY_STATION.pop} residents nothing changes (no flicker, no catchment work)`);
  month(2500);
  check(st.city === undefined && g.stations.walkVersion > v0, 'below leavePop: out of town (the catchments are shared out again)');
  for (const p of [2700, 2950, 2650, 2990]) month(p);
  check(flips.length === 1, `back above leavePop but below ${CITY_STATION.pop}: still out of town (${flips.join(', ')})`);
  month(3000);
  check(st.city === true && flips.length === 2, 'from the town\'s threshold on: in town again');
  // distance: within core x 1.15 stays, beyond goes; a fresh station needs to be within the core
  const core = g.towns.maxRadius(t);
  check(g.stations.cityAt(t.x + core * 1.1, t.z, t, true) && !g.stations.cityAt(t.x + core * 1.1, t.z, t, false) && !g.stations.cityAt(t.x + core * 1.2, t.z, t, true),
    `the core radius (${fmt(core, 1)} units): kept to 1.15x it, entered within it`);
  // the month end of the running game decides it (not the walking code), and a rebuild keeps it
  t.pop = 2500;
  const day0 = g.day;
  while (g.day % 30 !== 0 || g.day === day0) g.stepTick();
  check(st.city === undefined, 'the month end of the running game takes the decision');
  // a rebuild in place (planRail ignoring the station: planUpgrade, relevel, move) keeps the standing's hysteresis
  const r = st.rail!, again = (pop: number) => { t.pop = pop; return g.stations.planRail(r.x, r.z, r.angle, r.length, r.tracks, 0, { ignoreStation: st.id, trackType: r.trackType, level: r.level, style: r.style }).city === true; };
  const outThen = again(2900);
  t.pop = 3100; g.stations.updateCity();
  const inThen = again(2800);
  check(!outThen && inThen, `a rebuild keeps the standing between the thresholds (out of town at 2,900: ${outThen}; in town at 2,800: ${inThen})`);
});

// ------------------------------------------------------------------ 4. saved: exact replay after loading
section(4, 'saved: a loaded game replays exactly', () => {
  const g = flat(2), t = town(g, 'Replay City', 256, 256, 9000, 160, 96, 7);
  const me = g.ais[0].companyId;
  const sts = [-60, -30, 0, 30, 60].map((dx) => railStation(g, 256 + dx, 256, Math.PI / 2, 7, me, { trackType: 'lightrail', style: 'shelter' }));
  check(sts.every((s) => s?.city === true), 'replay: five in-city light-rail stations');
  const lid = sts.every(Boolean) ? cityLine(g, me, sts as Station[], 'lrv_b', 2) : -1;
  check(lid >= 0, 'replay: the city line runs');
  g.aiEnabled = false;
  for (let d = 0; d < 40; d++) for (let i = 0; i < g.ticksPerDay; i++) g.stepTick();
  // a standing changes at the next month end in both games: the town shrinks below leavePop
  t.pop = 2400;
  const loaded = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  loaded.aiEnabled = false;
  check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), 'replay: the loaded game serializes as the original');
  for (const w of [g, loaded]) for (let d = 0; d < 50; d++) for (let i = 0; i < w.ticksPerDay; i++) w.stepTick();
  const a = JSON.stringify(serialize(g)), b = JSON.stringify(serialize(loaded));
  const st0 = g.stations.get(sts[2]!.id)!, st1 = loaded.stations.get(sts[2]!.id)!;
  check(st0.city === undefined && st1.city === undefined && st0.catchPop === st1.catchPop, `replay: both decide the same at the month end (${st0.city}/${st1.city}), the same catchment (${fmt(st0.catchPop, 2)})`);
  check(a === b, `replay: 50 days on, the original and the loaded game are identical (${a.length} chars)`);
  if (a !== b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { console.log('  first difference: ' + a.slice(Math.max(0, i - 120), i + 80) + '\n  vs ' + b.slice(Math.max(0, i - 120), i + 80)); break; } }
});

// ------------------------------------------------------------------ 5. two crossing city lines become one interchange
/**
 * Two companies' city lines crossing in a town (as in Presholm): A's light rail east-west at street level, B's subway
 * north-south beneath it. 'near': B's station within an ordinary transfer walk of A's (TRANSFER_RANGE); 'walk': 210 m
 * from it (beyond that, within the in-city link range); 'far': B's line crosses midway between two of A's stations,
 * its station 260 m from the nearest (A's line passes 65 m from it).
 */
function crossing(gap: 'near' | 'walk' | 'far', pop = 14000, demand = 1) {
  const g = flat(2), t = town(g, 'Cross City', 256, 256, pop, 224, 160, 7);
  const [A, B] = g.ais.map((ai) => ai.companyId);
  const ax = gap === 'far' ? [-90, -30, 30, 90] : [-80, -40, 0, 40, 80], bx = gap === 'near' ? 262 : gap === 'walk' ? 276 : 256, bz = gap === 'near' ? 8 : 14;
  const a = ax.map((dx) => railStation(g, 256 + dx, 256, Math.PI / 2, 7, A, { trackType: 'lightrail', style: 'shelter' }));
  const b = [-64, -32, bz, bz + 32].map((dz) => railStation(g, bx, 256 + dz, 0, 12, B, { trackType: 'metro', level: 'underground', style: 'none' }));
  check(a.every(Boolean) && b.every(Boolean), `crossing (${gap}): both lines' stations built`);
  const la = a.every(Boolean) ? cityLine(g, A, a as Station[], 'lrv_b', 2) : -1;
  const lb = b.every(Boolean) ? cityLine(g, B, b as Station[], 'metro_c', 2, 'metro') : -1;
  check(la >= 0 && lb >= 0, `crossing (${gap}): both city lines run`);
  // not linked to start with (built by two companies at different times)
  for (const x of a) for (const y of b) if (x && y && x.links.includes(y.id)) g.stations.unlink(x.id, y.id);
  g.aiEnabled = false;
  for (let d = 0; d < 60; d++) for (let i = 0; i < g.ticksPerDay; i++) g.stepTick();
  // (a test lever: `demand` times the town's trips between its districts, where an interchange stop should pay)
  if (demand !== 1) for (let i = 0; i < g.demand.od.length; i++) g.demand.od[i] *= demand;
  return { g, t, A, B, a: a as Station[], b: b as Station[], la, lb };
}
section(5, 'two crossing city lines of two companies become one interchange', () => {
  for (const gap of ['near', 'walk', 'far'] as const) {
    const f = crossing(gap, gap === 'far' ? 24000 : 14000, gap === 'far' ? 4 : 1), { g, a, b } = f, ai = g.aiOf(f.A)!;
    if (f.la < 0 || f.lb < 0) continue;
    const near0 = a.map((x) => ({ x, d: g.stations.gap(x, b[2]) })).sort((p, q) => p.d - q.d)[0];
    const met = () => g.stations.all().some((s) => s.owner === f.A && s.rail && b.some((y) => g.stations.complex(s.id).includes(y.id)));
    check(!met() && !g.lines.nextHop(a[0].id, b[0].id), `${gap}: the lines start without an interchange (stations ${fmt(near0.d * 10, 0)} m apart, no route between them)`);
    const money0 = g.company(f.A).economy.money, stations0 = g.stations.map.size;
    runNetworkTask(ai, 'citylink');
    console.log(`  ${gap}: ${ai.log.slice(-1).join(' | ')}; trips ${fmt(networkProfile.decisions['citylink.maxTrips'] ?? 0, 2)} a month`);
    check(met(), `${gap}: one interchange now (links ${stat(ai, 'netCityLinks')}, stops ${stat(ai, 'netCityStops')})`);
    if (gap !== 'far') check(g.stations.map.size === stations0 && g.company(f.A).economy.money === money0 && near0.x.links.includes(b[2].id),
      `${gap}: ${gap === 'near' ? 'linked' : 'linked across the in-city range'} for transfers, nothing built, nothing spent`);
    else {
      const stop = g.stations.all().find((s) => s.owner === f.A && s.rail && !a.includes(s));
      check(!!stop && g.lines.get(f.la)!.stops.includes(stop.id) && stop.links.includes(b[2].id) && g.stations.gap(stop, b[2]) <= TRANSFER_RANGE && stop.city === true,
        `far: a stop of A's line beside B's station, on A's line, linked, in town (${stop?.name}, ${fmt((stop ? g.stations.gap(stop, b[2]) : -1) * 10, 0)} m)`);
    }
    g.lines.rebuild();
    check(!!g.lines.nextHop(a[0].id, b[0].id), `${gap}: passengers route between the two lines now`);
    if (gap === 'walk') check(g.stations.linkRange(near0.x, b[2]) === CITY_TRANSFER_RANGE && g.stations.canLink(near0.x.id, b[2].id) === 'Already linked'
      && g.stations.linkRange(a[0], a[0]) === CITY_TRANSFER_RANGE, 'walk: in-city stations link up to the longer in-city range');
  }
  // an interchange stop is built only where its trips repay it: at the town's own demand this one does not
  {
    const f = crossing('far', 24000), { g, a } = f, ai = g.aiOf(f.A)!;
    const money0 = g.company(f.A).economy.money, stations0 = g.stations.map.size;
    if (f.la >= 0 && f.lb >= 0) runNetworkTask(ai, 'citylink');
    console.log(`  far, the town's own demand: ${ai.log.slice(-1).join('')}`);
    check(g.stations.map.size === stations0 && g.company(f.A).economy.money === money0 && !a.some((x) => g.stations.complex(x.id).length > 1), 'far: no stop where its trips would not repay it (an incentive, no rule)');
  }
  // never into a company without mutual open access
  {
    const f = crossing('near'), { g } = f, ai = g.aiOf(f.A)!;
    g.aiOf(f.B)!.config.accessPolicy = 'ask'; g.refreshAccess();
    if (f.la >= 0 && f.lb >= 0) runNetworkTask(ai, 'citylink');
    check(!f.a[2].links.includes(f.b[2].id), 'a company without mutual open access is never linked into');
  }
});

// ------------------------------------------------------------------ 6. a new city line stops beside an existing station
section(6, 'a new city line stops beside an existing station of a crossing line', () => {
  // The same population is uneconomic when spread over a wider walking area; a denser district
  // supplies the profitable interchange case without increasing residents or bypassing quotes.
  for (const height of [160, 96]) {
  const g = flat(2), t = town(g, 'Wide City', 256, 256, 14000, 224, height, 7);
  const [A, B] = g.ais.map((ai) => ai.companyId);
  // B's subway runs north-south across the town's long (east-west) axis, its central station 6 units east of the centre
  // (its central station's platforms end 10 units north of the axis: the street-level corridor along the axis stays free)
  const b = [-64, -32, 16, 48].map((dz) => railStation(g, 262, 256 + dz, 0, 12, B, { trackType: 'metro', level: 'underground', style: 'none' }));
  const lb = b.every(Boolean) ? cityLine(g, B, b as Station[], 'metro_c', 2, 'metro') : -1;
  check(lb >= 0, 'anchor: the crossing line runs');
  for (let d = 0; d < 30; d++) for (let i = 0; i < g.ticksPerDay; i++) g.stepTick();
  const ai = g.aiOf(A)!;
  g.aiEnabled = true;
  for (const c of g.ais) c.state.cooldown = 1e9;
  const capitalSpent = () => {
    const e = g.company(A).economy;
    return -e.yearTotals.reduce((n, y) => n + y.v.construction + y.v.vehicles, e.thisYear.construction + e.thisYear.vehicles);
  };
  const stationCount = g.stations.map.size, capital = capitalSpent();
  check(ai.startProject('lightrail', [t.id]), 'anchor: a light-rail project starts');
  let ticks = 0;
  while (ai.busy && ticks++ < 160000) g.stepTick();
  const line = g.lines.all().find((l) => l.owner === A && l.kind === 'rail');
  console.log('  ' + ai.log.slice(-3).join(' | '));
  if (height === 160) {
    check(!line && ai.log.some(text => text.includes('not profitable')) && g.stations.map.size === stationCount
      && capitalSpent() === capital, 'anchor: diffuse districts reject the unprofitable native quote without paying for a new line');
    continue;
  }
  check(!!line && capitalSpent() > capital, 'anchor: the denser district pays for a profitable new city line');
  if (line && lb >= 0) {
    const ours = [...new Set(line.stops)].map((id) => g.stations.get(id)!), theirs = b as Station[];
    // (one of its stops beside one of B's stations, linked: one interchange of the two lines)
    const pairs = ours.flatMap((s) => theirs.filter((y) => s.links.includes(y.id)).map((y) => ({ s, y, gap: g.stations.gap(s, y) })));
    check(pairs.length >= 1 && pairs.every((p) => p.gap <= g.stations.linkRange(p.s, p.y)), `anchor: it stops beside the crossing line's station and links to it (${pairs.map((p) => `${p.s.name} - ${p.y.name} ${fmt(p.gap * 10, 0)} m`).join(', ') || 'none'})`);
    g.lines.rebuild();
    check(!!g.lines.nextHop(ours[0].id, theirs[0].id) && !!g.lines.nextHop(theirs[theirs.length - 1].id, ours[ours.length - 1].id), 'anchor: passengers change between the two lines there');
    check(ours.every((s) => s.city === true || !g.stations.cityAt(s.x, s.z, t)), 'anchor: its stops in the core walk half as far');
  }
  }
});

// ------------------------------------------------------------------ 7. the AI still builds city railways in large towns
section(7, 'the AI still builds city railways in large towns', () => {
  for (const mode of ['lightrail', 'metro'] as const) {
    const g = flat(1), t = town(g, 'Metropolis', 256, 256, 14000, 192, 96, 7), ai = g.ais[0];
    g.aiEnabled = true;
    check(ai.startProject(mode, [t.id]), `${mode}: a project starts`);
    let ticks = 0;
    while (ai.busy && ticks++ < 160000) g.stepTick();
    const line = g.lines.all().find((l) => l.owner === ai.companyId && l.kind === 'rail');
    console.log('  ' + ai.log.slice(-2).join(' | '));
    check(!!line && line.vehicles.length > 0, `${mode}: the AI opens a city railway on the numbers (no forced build)`);
    if (!line) continue;
    const sts = [...new Set(line.stops)].map((id) => g.stations.get(id)!);
    const inCity = sts.filter((s) => s.city === true);
    const gaps = sts.slice(1).map((s, i) => Math.hypot(s.x - sts[i].x, s.z - sts[i].z));
    console.log(`  ${mode}: ${sts.length} stations (${inCity.length} in town), gaps ${gaps.map((d) => fmt(d * 10, 0)).join('/')} m, levels ${[...new Set(sts.map((s) => s.rail?.level))].join('/')}`);
    check(inCity.length >= 3 && sts.every((s) => railPartMode(s.rail!) === mode), `${mode}: its stops in town walk half as far`);
    for (const c of g.ais) c.monthly = () => {};
    g.aiEnabled = false;
    for (let d = 0; d < 400; d++) for (let i = 0; i < g.ticksPerDay; i++) g.stepTick();
    console.log(`  ${mode}: revenue ${fmt((line.incomeLast + line.incomeYear) / 1e6, 2)}M in its first year and a bit, running ${fmt((line.costLast + line.costYear) / 1e6, 2)}M`);
    check(line.incomeLast + line.incomeYear > (line.costLast + line.costYear), `${mode}: it carries its passengers at a running profit`);
  }
});

// ------------------------------------------------------------------ 8. station types merge: main line, metro, light rail
section(8, 'stations of every type merge: main line, metro and light rail', () => {
  // (in a town's core: main line at street level along the corridor, a subway under it, light rail on a viaduct beside)
  const g = flat(), t = town(g, 'Junction City', 256, 256, 9000, 192, 128, 7);
  const main = railStation(g, 236, 256, Math.PI / 2, 8, 0, { trackType: 'standard', style: 'none' });
  const metro = railStation(g, 242, 262, 0, 12, 0, { trackType: 'metro', level: 'underground', style: 'none' });
  const light = railStation(g, 262, 254, Math.PI / 2, 7, 0, { trackType: 'lightrail', level: 'elevated', style: 'none' });
  check(!!main && !!metro && !!light, 'types: a main-line, a metro and a light-rail station in the core');
  if (!main || !metro || !light) return;
  const reach = (st: Station) => g.stations.catchmentRadius(st) / (CATCHMENT_RADIUS.rail * (1 + styleOf(st.rail!.style).catchBonus));
  for (const [a, b] of [[main, metro], [main, light], [metro, light]] as const) {
    const c = canMerge(g, a.id, b.id);
    check(c.ok, `types: ${railPartMode(a.rail!)} + ${railPartMode(b.rail!)} may merge (${c.kind}: ${c.reason})`);
    const res = mergeStations(g, a.id, b.id);
    check(!res.error && g.stations.complex(a.id).includes(b.id), `types: ${railPartMode(a.rail!)} + ${railPartMode(b.rail!)} merged into one station (${res.kind}${res.error ? ': ' + res.error : ''})`);
  }
  const parts = stationComplex(g, main.id).parts;
  check(parts.length === 3 && [main, metro, light].every((s) => parts.includes(s.id)), `types: one interchange of three parts (${parts.map((id) => g.stations.get(id)?.name).join(', ')})`);
  check(railPartMode(main.rail!) === 'mainline' && railPartMode(metro.rail!) === 'metro' && railPartMode(light.rail!) === 'lightrail', 'types: every part keeps its own type');
  check(reach(main) === 1 && reach(metro) === CITY_WALK_SCALE && reach(light) === CITY_WALK_SCALE, `types: every part keeps its own reach (main line full, metro and light rail half: ${[main, metro, light].map((s) => fmt(reach(s), 2)).join('/')})`);
  // side by side on one level, parallel (out on open land west of the town): the same type unites as one part, two
  // types stay two parts of one station
  const a1 = railStation(g, 110, 200, Math.PI / 2, 7, 0, { trackType: 'lightrail', style: 'none' });
  const a2 = a1 && railStation(g, 110, 200 + a1.rail!.width + 1, Math.PI / 2, 7, 0, { trackType: 'lightrail', style: 'none' });
  const b1 = railStation(g, 110, 300, Math.PI / 2, 8, 0, { trackType: 'standard', style: 'none' });
  const b2 = b1 && railStation(g, 110, 300 + b1.rail!.width + 1, Math.PI / 2, 7, 0, { trackType: 'lightrail', style: 'none' });
  if (a1 && a2) {
    const c = canMerge(g, a1.id, a2.id), res = c.ok ? mergeStations(g, a1.id, a2.id) : null;
    check(c.kind === 'rebuild' && !res?.error && !g.stations.get(a2.id) && a1.rail!.tracks === 4, `types: two light-rail stations side by side become one part (${c.kind}: ${c.reason})`);
  } else check(false, 'types: two light-rail stations side by side');
  if (b1 && b2) {
    const c = canMerge(g, b1.id, b2.id), res = c.ok ? mergeStations(g, b1.id, b2.id) : null;
    check(c.ok && c.kind === 'complex' && !res?.error && g.stations.complex(b1.id).includes(b2.id) && railPartMode(b2.rail!) === 'lightrail' && railPartMode(b1.rail!) === 'mainline' && reach(b2) === railWalkScale(b2) && reach(b1) === 1,
      `types: a light-rail station beside a main-line one merges as a second part with its own type and reach (${c.kind}: ${c.reason})`);
  } else check(false, 'types: a main-line and a light-rail station side by side');
  void t;
});

console.log(`\n${fmt((performance.now() - T0) / 1000, 1)} s`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
