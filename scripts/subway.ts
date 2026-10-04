// Subways (underground-only lines): a player-built subway between underground stations with an underground depot (no
// portals, nothing demolished above it, trains run); what the choice costs (a dense centre: underground cheaper than a
// line on the ground that demolishes; open land: the ground cheaper); subways crossing at different depths and the
// clearances below ground (stations, depots, tunnels at the same depth); an exact save/load replay with trains in an
// underground depot and in tunnels; the AI choosing an underground-only city railway in a dense centre and a surface
// one in open land; and extending a line underground from its terminus (subway.ts, for growing city lines).
// npx esbuild scripts/subway.ts --bundle --platform=node --format=esm --outfile=$S/subway.mjs && (cd $S && node subway.mjs)
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { planEdge, commitProposal, BuildOptions, Proposal } from '../src/game/construction';
import { RAIL } from '../src/game/constants';
import { profAt, NEdge } from '../src/game/network';
import { stationEnds, nodeSnap, depotAtEnd } from '../src/game/routing';
import { connectStationThroat, finishDoubleTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { outAndBack, linearStops } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { serialize, deserialize } from '../src/game/save';
import { UNDERGROUND_DEPOT } from '../src/game/build-ops';
import { demolitionCost, landValue } from '../src/game/demolition';
import { planSubwayYard, buildSubwayYard, planSubwayExtension, commitSubwayExtension, surfaceDemolition } from '../src/game/subway';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import { fails, check, fmt, checkReservations, checkNaN, Train } from './lib';

if (!process.argv[1]?.endsWith('subway.mjs')) throw new Error('bundle this test as subway.mjs');
const T0 = performance.now();
const M = (v: number) => fmt(v / 1e6, 2) + ' M';
const ME = 0;

// ------------------------------------------------------------------------------------ fixtures
function flatGame(ais = 0): Game {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    ...(ais ? { aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) } : {}) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  g.economy.money = 2e9;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(4), [], 'street', -1);
}
function newTown(g: Game, name: string, x: number, z: number, radius: number): Town {
  const t = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius, buildings: new Set<number>(), nextGrowthDay: 1e9, hasChurch: false,
    passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 } as unknown as Town;
  g.towns.list.push(t);
  return t;
}
/**
 * A dense quarter: 8-storey blocks of flats on a street grid turned by `rot` (no street runs along its axis), every
 * block built up around a courtyard, `size` units across, `pop` residents.
 */
function denseQuarter(g: Game, name: string, cx: number, cz: number, pop: number, size: number, rot: number): Town {
  const t = newTown(g, name, cx, cz, size * 0.6);
  const c = Math.cos(rot), s = Math.sin(rot), half = size / 2, step = 8;
  const P = (u: number, v: number) => ({ x: cx + u * c - v * s, z: cz + u * s + v * c });
  for (let v = -half; v <= half; v += step) for (let u = -half; u + step <= half; u += step) { const a = P(u, v), b = P(u + step, v); road(g, a.x, a.z, b.x, b.z); }
  for (let u = -half; u <= half; u += step) for (let v = -half; v + step <= half; v += step) { const a = P(u, v), b = P(u, v + step); road(g, a.x, a.z, b.x, b.z); }
  const lots: { x: number; z: number }[] = [];
  for (let v = -half; v < half; v += step) for (let u = -half; u < half; u += step) for (const du of [1.6, 3.2, 4.8, 6.4]) for (const dv of [1.6, 3.2, 4.8, 6.4]) {
    if (du > 1.7 && du < 6.3 && dv > 1.7 && dv < 6.3) continue;
    const p = P(u + du, v + dv);
    if (Math.hypot(p.x - cx, p.z - cz) <= half) lots.push(p);
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    t.buildings.add(g.world.addBuilding({ townId: t.id, x: p.x, z: p.z, angle: rot, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 }).id);
  });
  t.pop = pop;
  g.demand.rebuild();
  return t;
}
/**
 * A dense centre on an east-west street grid (cross streets only at its ends and 32 units out): rows of 8-storey
 * flats packed between the streets, so a line through it on the ground or on a viaduct takes buildings wherever it runs.
 */
function packedGrid(g: Game, name: string, x: number, z: number, pop: number, width: number, height: number): Town {
  const t = newTown(g, name, x, z, Math.max(width, height) * 0.6);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) if (rx === xs[0] || rx === xs[xs.length - 1] || Math.abs(rx - x) === 32) for (let i = 1; i < zs.length; i++) road(g, rx, zs[i - 1], rx, zs[i]);
  const lots: { x: number; z: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) for (const dz of [1.1, 2.9, 4.7, 6.5]) lots.push({ x: rx, z: rz + dz });
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    t.buildings.add(g.world.addBuilding({ townId: t.id, x: p.x, z: p.z, angle: 0, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 }).id);
  });
  t.pop = pop;
  g.demand.rebuild();
  return t;
}
/** A village along one street (two-storey houses, no cross streets): open land around it. */
function village(g: Game, name: string, cx: number, cz: number, pop: number, length: number): Town {
  const t = newTown(g, name, cx, cz, length * 0.6);
  for (let x = cx - length / 2; x + 8 <= cx + length / 2; x += 8) road(g, x, cz, x + 8, cz);
  const lots: { x: number; z: number; a: number }[] = [];
  for (let x = cx - length / 2 + 2; x < cx + length / 2 - 1; x += 3) for (const side of [-1, 1]) lots.push({ x, z: cz + side * 1.3, a: side > 0 ? Math.PI : 0 });
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    t.buildings.add(g.world.addBuilding({ townId: t.id, x: p.x, z: p.z, angle: p.a, w: 1.1, d: 1.0, type: 1, floors: 2, pop: count, seed: i, y: 4, built: 0 }).id);
  });
  t.pop = pop;
  g.demand.rebuild();
  return t;
}
const sub = (o: Partial<BuildOptions> = {}): BuildOptions => ({ kind: 'rail', type: 'metro', tracks: 2, heightOffset: 0, crossing: 'auto', owner: ME, level: 'underground', subway: true, levelDepth: 2.2, ...o });
const free = (g: Game, x: number, z: number) => ({ kind: 'free' as const, x, z, y: g.world.heightAt(x, z) });
/** Edges fully in tunnel (one section end to end): a subway has no portal anywhere. */
const inTunnel = (e: NEdge) => e.sections.length === 1 && e.sections[0].type === 'tunnel' && e.sections[0].s0 < 0.01 && e.sections[0].s1 > e.len - 0.01;
const tunnelShare = (p: Proposal) => { let l = 0, L = 0; for (const tp of p.tracks) { L += tp.len; for (const s of tp.sections) if (s.type === 'tunnel') l += s.s1 - s.s0; } return l / (L || 1); };
/** Count arrivals at each station over `days` (a train starting to load). */
function runArrivals(g: Game, days: number, each?: () => void): Map<number, number> {
  const arr = new Map<number, number>(), last = new Map<number, string>();
  const end = g.day + days;
  while (g.day < end) {
    g.stepTick();
    each?.();
    for (const v of g.vehicles.all()) if (v instanceof Train) {
      const k = v.state + ':' + v.atStation;
      if (last.get(v.id) !== k && v.state === 'loading') arr.set(v.atStation, (arr.get(v.atStation) ?? 0) + 1);
      last.set(v.id, k);
    }
  }
  return arr;
}
const saved = (g: Game) => JSON.stringify(serialize(g));
function identical(a: string, b: string, label: string): boolean {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  check(false, `${label}: JSON differs at character ${i} (${a.length} vs ${b.length} chars)`);
  console.log(`    original: ${a.slice(Math.max(0, i - 100), i + 100)}\n    loaded:   ${b.slice(Math.max(0, i - 100), i + 100)}`);
  return false;
}

// ------------------------------------------------------------------------------------ 1. a player's subway
console.log('1. a subway under a dense quarter: underground stations, tunnels, an underground depot, trains');
const g = flatGame();
const Q = denseQuarter(g, 'Old Town', 256, 256, 14000, 96, Math.PI / 4);
const net = g.world.net;
const sts: Station[] = [];
let demolishedByStations = 0;
for (const x of [220, 244, 268, 292]) {
  const before = g.world.buildings.size;
  let st: Station | null = null;
  for (const dz of [0, 2, -2, 4, -4]) {
    const pl = g.stations.planRail(x, 256 + dz, Math.PI / 2, 12, 2, ME, { level: 'underground', trackType: 'metro', depth: 2.2, style: 'none' });
    if (!pl.ok) continue;
    const id = g.stations.nextId;
    if (!g.stations.commitRail(pl, ME)) { st = g.stations.get(id)!; break; }
  }
  check(!!st, `underground station at x ${x}`);
  if (st) sts.push(st);
  demolishedByStations += before - g.world.buildings.size;
}
const buildings0 = g.world.buildings.size;
const ends = (st: Station, east: boolean) => stationEnds(g, st).map((e) => (Math.sin(st.rail!.angle) > 0 === east ? e.front : e.back));
const e0 = net.nextEdge;
let avoided = 0, demolished = 0, linkCost = 0;
for (let i = 0; i + 1 < sts.length; i++) {
  const p = planEdge(g, nodeSnap(g, ends(sts[i], true)[0], 'rail'), nodeSnap(g, ends(sts[i + 1], false)[0], 'rail'), sub({ levelDepth: sts[i].rail!.depth }));
  check(p.ok, `subway ${sts[i].name} - ${sts[i + 1].name} planned (${p.errors.join(', ')})`);
  check(tunnelShare(p) > 0.999 && p.tracks.length === 2, 'double track, in tunnel the whole way');
  avoided += p.stats.avoided?.buildings ?? 0; demolished += p.demolish.length; linkCost += p.cost;
  check(!p.stats.costSplit?.demolition && !p.stats.costSplit?.earthworks, 'no demolition or earthworks in its bill');
  if (p.ok) check(commitProposal(g, p) === null, 'subway built');
}
console.log(`  ${sts.length} stations (${demolishedByStations} buildings made way for entrances); tunnels ${M(linkCost)}, ${demolished} buildings demolished, ${avoided} kept that a line on the ground would take`);
check(demolished === 0 && avoided > 20, 'the subway demolishes nothing; the buildings above it stay');
// the depot underground beyond the last station (a stub in tunnel and a cavern), the throat's turnout onto it
const last = sts[sts.length - 1];
const out = ends(last, true)[0], on = net.nodes.get(out)!;
const yard = planSubwayYard(g, { x: on.x, y: on.y, z: on.z, dx: Math.sin(last.rail!.angle), dz: Math.cos(last.rail!.angle), node: out }, ME, { type: 'metro' });
check(yard.ok, `underground yard planned (${yard.error ?? M(yard.cost)})`);
const dep = buildSubwayYard(g, out, yard, ME, 'metro');
const D = g.depots.get(dep);
check(!!D && D.level === 'underground' && (D.depth ?? 0) > 1.5, `underground depot built (${D ? `${fmt((D.depth ?? 0) * 10, 0)} m deep, ${M(D.cost ?? 0)}` : 'none'})`);
connectStationThroat(g, last.id, ME);
// (a depot can also sit right at an underground station's throat: planned at the first station's free west end)
{
  const w0 = net.nodes.get(ends(sts[0], false)[0])!;
  const tp = g.depots.plan('rail', w0.x - Math.sin(sts[0].rail!.angle) * 2.2, w0.z - Math.cos(sts[0].rail!.angle) * 2.2, 0, ME);
  check(tp.ok && tp.level === 'underground' && tp.snapNode === w0.id && !tp.demolish.length, `an underground depot fits at a station's throat (${tp.error ?? M(tp.cost)})`);
}
const lineEdges = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0 && e.depot < 0).map((e) => e.id);
finishDoubleTrack(g, lineEdges, ME);
check(g.world.buildings.size === buildings0, 'tunnels, depot and throat demolished nothing');
const subwayEdges = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0);
check(subwayEdges.length > 0 && subwayEdges.every(inTunnel), `no portal anywhere: every new edge in tunnel end to end (${subwayEdges.filter((e) => !inTunnel(e)).length} not)`);
const line = g.lines.create('rail', ME);
line.stops = outAndBack(sts.map((s) => s.id));
autoSignalLine(g, line.id, ME);
const trains: Train[] = [];
for (let i = 0; i < 2; i++) { const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('metro_b')!], line.id); check(t instanceof Train, `metro train ${i + 1} bought at the underground depot (${typeof t === 'string' ? t : t.name})`); if (t instanceof Train) trains.push(t); }
let hidden = 0;
const q = { x: 0, y: 0, z: 0 };
const arr = runArrivals(g, 150, () => { for (const t of trains) if (t.onMap) { const at = t.pointBehind(0, q); if (at && t.hiddenAt(at.seg, at.sp)) hidden++; } });
console.log(`  arrivals: ${sts.map((s) => `${s.name.replace(/^Old Town /, '')} ${arr.get(s.id) ?? 0}`).join(', ')}; hidden underground ${hidden} ticks; ${trains.map((t) => `${t.state} "${t.status}"`).join(' | ')}`);
check(sts.every((s) => (arr.get(s.id) ?? 0) >= 1) && [...arr.values()].reduce((a, b) => a + b, 0) >= 8, 'the trains serve every station from the underground depot');
check(hidden > 0, 'the trains run hidden in the tunnels');
check(checkReservations(g).length === 0 && !checkNaN(g), 'consistent reservations, no NaN');

// ------------------------------------------------------------------------------------ 2. what it costs
console.log('2. costs: a dense centre against open land');
{
  // a line through the quarter's blocks (no street crossings inside them) on the ground and in a subway
  const h = flatGame();
  const B = newTown(h, 'Block', 256, 256, 40);
  for (let x = 216; x <= 296; x += 2) for (let z = 248; z <= 264; z += 2) B.buildings.add(h.world.addBuilding({ townId: B.id, x, z, angle: 0, w: 1.4, d: 1.4, type: 4, floors: 6, pop: 22, seed: x * 7 + z, y: 4, built: 0 }).id);
  for (const z of [244, 268]) road(h, 210, z, 302, z);
  B.pop = [...B.buildings].reduce((n, id) => n + (h.world.buildings.get(id)?.pop ?? 0), 0);
  h.demand.rebuild();
  const any = h.world.buildings.get([...B.buildings][0])!;
  const a = free(h, 222, 256), b = free(h, 290, 256);
  const ground = planEdge(h, a, b, { kind: 'rail', type: 'metro', tracks: 2, heightOffset: 0, crossing: 'auto', owner: ME });
  const under = planEdge(h, a, b, sub());
  const cs = ground.stats.costSplit!;
  console.log(`  dense centre (${fmt(landValue(h, any), 1)}x land value, ${fmt(demolitionCost(h, any) / 1000, 0)}k a block of 22): ground ${M(ground.cost)} (track ${M(cs.track)}, earthworks ${M(cs.earthworks)}, demolition ${M(cs.demolition ?? 0)}: ${ground.demolish.length} buildings) / subway ${M(under.cost)} (tunnels ${M(under.stats.costSplit!.tunnels)}, keeps ${under.stats.avoided?.buildings ?? 0} buildings worth ${M(under.stats.avoided?.cost ?? 0)})`);
  check(ground.ok && under.ok, `both planned (${[...ground.errors, ...under.errors].join(', ')})`);
  check(under.cost < ground.cost, 'in a dense centre the subway is cheaper than a line on the ground that demolishes');
  check(under.stats.costSplit!.tunnels > cs.track * 4, 'tunnel costs far more per unit than track on the ground');
  check(landValue(h, any) > 3, 'dense centre: land value at its height');
  // open land: the same line in the fields
  const o1 = free(h, 222, 120), o2 = free(h, 290, 120);
  const og = planEdge(h, o1, o2, { kind: 'rail', type: 'metro', tracks: 2, heightOffset: 0, crossing: 'auto', owner: ME }), ou = planEdge(h, o1, o2, sub());
  console.log(`  open land: ground ${M(og.cost)} / subway ${M(ou.cost)}`);
  check(og.ok && ou.ok && og.cost * 3 < ou.cost, 'in open land track on the ground is much cheaper');
  // a village's houses are cheap to clear (land value 1x), a dense centre's flats dear
  const V = village(h, 'Village', 256, 400, 120, 40);
  const house = h.world.buildings.get([...V.buildings][0])!;
  check(landValue(h, house) < 1.2, `village land value about 1x (${fmt(landValue(h, house), 2)})`);
  const sd = surfaceDemolition(h, [{ x: 222, z: 256 }, { x: 290, z: 256 }]);
  check(sd.buildings.length > 0 && Math.abs(sd.cost - (cs.demolition ?? 0)) < (cs.demolition ?? 0) * 0.6, `surfaceDemolition estimates the ground line's demolition (${M(sd.cost)} for ${sd.buildings.length})`);
}

// ------------------------------------------------------------------------------------ 3. below ground: depths and clearances
console.log('3. subways crossing at different depths; clearances below ground');
{
  const h = flatGame();
  const hn = h.world.net;
  const A = planEdge(h, free(h, 100, 200), free(h, 180, 200), sub({ tracks: 1, levelDepth: 1.6 }));
  check(A.ok && commitProposal(h, A) === null, `subway A east-west at 16 m (${A.errors.join(', ')})`);
  const B = planEdge(h, free(h, 140, 160), free(h, 140, 240), sub({ tracks: 1, levelDepth: 1.6 }));
  const c = B.crossings[0], eA = c ? hn.edges.get(c.edge)! : null;
  const dy = c && eA ? Math.abs(profAt(B.tracks[0].prof, B.tracks[0].len, c.sNew) - hn.heightAtS(eA, c.sOld)) : 0;
  console.log(`  B north-south at the same depth: ${B.ok ? 'ok' : B.errors[0]}, crossing ${c?.mode ?? '-'} with ${fmt(dy * 10, 1)} m between them`);
  check(B.ok && !!c && (c.mode === 'under' || c.mode === 'over') && dy >= RAIL.clearance - 0.01, 'subways at the same depth cross over or under each other with the clearance');
  check(B.ok && commitProposal(h, B) === null, 'subway B built');
  const C = planEdge(h, free(h, 110, 200.3), free(h, 170, 200.3), sub({ tracks: 1, levelDepth: 1.6 }));
  check(!C.ok && C.errors.some((e) => /tunnel/i.test(e)), `a tunnel beside another at the same depth is refused (${C.errors[0] ?? 'planned'})`);
  const C2 = planEdge(h, free(h, 110, 200.3), free(h, 135, 200.3), sub({ tracks: 1, levelDepth: 2.9 }));
  check(C2.ok, `the same alignment 13 m deeper passes beneath it (${C2.errors[0] ?? 'ok'})`);
  // an underground station: a subway passes under it with the clearance, or dives under it by itself
  const sp = h.stations.planRail(140, 300, Math.PI / 2, 12, 2, ME, { level: 'underground', trackType: 'metro', depth: 1.6, style: 'none' });
  const sid = h.stations.nextId;
  check(sp.ok && !h.stations.commitRail(sp, ME), `underground station for the clearance checks (${sp.error ?? 'ok'})`);
  const S = h.stations.get(sid)!;
  const box = h.stations.undergroundNear(S.x, S.z, 1).find((q) => q.station === S.id)!;
  const deep = planEdge(h, free(h, 140, 270), free(h, 140, 330), sub({ tracks: 1, levelDepth: 3 }));
  const under = (p: Proposal, s: number) => profAt(p.tracks[0].prof, p.tracks[0].len, s);
  const mid = (p: Proposal) => under(p, p.tracks[0].len / 2);
  check(deep.ok && mid(deep) + RAIL.clearance <= box.y0 + 1e-3, `a deeper subway passes under the station box (${deep.errors[0] ?? fmt((box.y0 - mid(deep)) * 10, 1) + ' m below its floor'})`);
  const dive = planEdge(h, free(h, 140, 262), free(h, 140, 338), sub({ tracks: 1, levelDepth: 1.6 }));
  check(dive.ok && mid(dive) + RAIL.clearance <= box.y0 + 1e-3, `one at the station's depth dives beneath it by itself (${dive.errors[0] ?? fmt((box.y0 - mid(dive)) * 10, 1) + ' m below'})`);
  // (a stub ending 5 units short of the box at its depth: no room to dive beneath it from there)
  const lead = planEdge(h, free(h, 140, 270), free(h, 140, 294), sub({ tracks: 1, levelDepth: 1.6 }));
  check(lead.ok && commitProposal(h, lead) === null, 'a tunnel ending just short of the station');
  const tip = hn.nearestNode(140, 294, 0.1, 'rail', (n) => n.edges.length === 1)!;
  const blocked = planEdge(h, nodeSnap(h, tip.id, 'rail'), free(h, 140, 306), sub({ tracks: 1, levelDepth: 1.6 }));
  check(!blocked.ok && blocked.errors.some((e) => /underground station|too steep|clear/i.test(e)), `no room to dive from there: refused (${blocked.errors[0] ?? 'planned'})`);
  // an underground depot: clear of tunnels at its depth, and tunnels clear of it
  const stub = planEdge(h, free(h, 220, 160), free(h, 232, 160), sub({ tracks: 1, levelDepth: 1.8 }));
  check(stub.ok && commitProposal(h, stub) === null, 'a stub for a depot');
  const end = hn.nearestNode(232, 160, 0.1, 'rail', (n) => n.edges.length === 1)!;
  const did = depotAtEnd(h, end.id, ME), dp = h.depots.get(did);
  check(!!dp && dp.level === 'underground', 'a depot at the end of a tunnel is built underground');
  if (dp) {
    const across = planEdge(h, free(h, 234.2, 140), free(h, 234.2, 180), sub({ tracks: 1, levelDepth: 1.8 }));
    check(!across.ok || Math.abs(under(across, 20) - dp.y) >= 1.2, `a subway at the depot's depth must keep clear (${across.ok ? 'dived ' + fmt((dp.y - under(across, 20)) * 10, 0) + ' m' : across.errors[0]})`);
    const below = planEdge(h, free(h, 234.2, 140), free(h, 234.2, 180), sub({ tracks: 1, levelDepth: 3 }));
    check(below.ok, `a deeper subway passes under the depot (${below.errors[0] ?? 'ok'})`);
    const surface = planEdge(h, free(h, 234.2, 140), free(h, 234.2, 180), { kind: 'rail', type: 'metro', tracks: 1, heightOffset: 0, crossing: 'auto', owner: ME });
    check(surface.ok, `track on the ground passes over the depot (${surface.errors[0] ?? 'ok'})`);
    const clash = h.depots.plan('rail', 160, 200, Math.PI / 2, ME, { level: 'underground', depth: 2 });
    check(!clash.ok && /tunnel|track/i.test(clash.error ?? ''), `an underground depot on a tunnel at its depth is refused (${clash.error ?? 'planned'})`);
    const surfaceDepot = h.depots.plan('rail', 160, 200, Math.PI / 2, ME, { level: 'surface' });
    check(surfaceDepot.ok, `a surface depot above the subway is fine (${surfaceDepot.error ?? 'ok'})`);
  }
}

// ------------------------------------------------------------------------------------ 4. save and load
console.log('4. exact save/load replay with trains in the underground depot and in the tunnels');
{
  const held = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('metro_b')!], null);
  check(held instanceof Train, 'a third train waits in the underground depot');
  let saves = 0, inDepot = 0, inTunnel = 0;
  for (let k = 0; k < 6; k++) {
    for (let i = 0; i < 37 + k * 53; i++) g.stepTick();
    const ts = g.vehicles.all().filter((v): v is Train => v instanceof Train);
    inDepot += ts.filter((t) => !t.onMap || t.segs.some((s) => s.e < 0)).length;
    inTunnel += ts.filter((t) => { if (!t.onMap) return false; const at = t.pointBehind(0, q); return !!at && t.hiddenAt(at.seg, at.sp); }).length;
    const json = saved(g), loaded = deserialize(JSON.parse(json));
    if (!identical(json, saved(loaded), `save ${k + 1}: exact round trip`)) break;
    let ok = true;
    for (let d = 0; d < 6 && ok; d++) {
      for (let i = 0; i < TICKS_PER_DAY; i++) { g.stepTick(); loaded.stepTick(); }
      ok = identical(saved(g), saved(loaded), `save ${k + 1}, day ${d + 1}`);
    }
    if (ok) saves++;
  }
  console.log(`  ${saves} saves replayed exactly for 6 days each (trains in the depot ${inDepot}, hidden in tunnels ${inTunnel})`);
  check(saves === 6 && inDepot > 0 && inTunnel > 0, 'saves with trains in the underground depot and in tunnels replay exactly');
  const back = deserialize(JSON.parse(saved(g)));
  const bd = back.depots.get(dep);
  check(!!bd && bd.level === 'underground' && bd.cost === D?.cost && bd.depth === D?.depth, 'the underground depot loads as it was');
}

// ------------------------------------------------------------------------------------ 5. the AI's choice
console.log('5. the AI: an underground-only city railway in a dense centre, a surface one in open land');
type Econ = { mode: string; level: string; total: number; net: number; ret: number };
function aiCity(build: (g: Game) => Town, mode: 'lightrail' | 'metro', force = false) {
  const h = flatGame(1), T = build(h), ai = h.ais[0], econs: Econ[] = [];
  const proto = AIController.prototype as unknown as { urbanEconomics: (...a: unknown[]) => { total: number; net: number } };
  const orig = proto.urbanEconomics;
  proto.urbanEconomics = function (this: unknown, ...a: unknown[]) {
    const r = orig.apply(this, a);
    if (a[5] !== undefined) econs.push({ mode: String(a[1]), level: String(a[2]), total: r.total, net: r.net, ret: r.net / r.total });
    return r;
  };
  const buildings = h.world.buildings.size;
  AIController.forceBuild = force;
  h.aiEnabled = true;
  try {
    check(ai.startProject(mode, [T.id]), `${mode} project in ${T.name} starts`);
    let ticks = 0;
    while (ai.busy && ticks++ < 200000) h.stepTick();
  } finally { proto.urbanEconomics = orig; AIController.forceBuild = false; }
  for (const c of h.ais) c.monthly = () => {};
  h.aiEnabled = false;
  return { h, T, ai, econs, buildings };
}
{
  const r = aiCity((h) => denseQuarter(h, 'Hightown', 256, 256, 14000, 120, Math.PI / 4), 'lightrail');
  const { h, ai, econs } = r;
  const l = h.lines.all()[0];
  const stops = l ? linearStops(l.stops) ?? [] : [];
  const levels = stops.map((id) => h.stations.get(id)?.rail?.level);
  const deps = [...h.depots.map.values()];
  const rails = [...h.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0);
  console.log(`  dense centre: ${ai.log.slice(-1)[0]}`);
  console.log(`  compared: ${econs.map((e) => `${e.level} ${M(e.total)} ${fmt(e.ret, 3)}`).join(', ')}`);
  check(!!l && levels.length >= 4 && levels.every((v) => v === 'underground'), `an underground light-rail-style line (${levels.join(', ')})`);
  check(deps.length === 1 && deps[0].level === 'underground', 'its depot is underground');
  check(rails.length > 0 && rails.every(inTunnel), `no portal or ramp: all its track in tunnel (${rails.filter((e) => !inTunnel(e)).length} not)`);
  const best = econs.filter((e) => e.ret * (e.level === 'underground' ? 15 : 9) >= 1).sort((a, b) => b.ret - a.ret)[0];
  check(!best || best.level === 'underground', 'the underground plan was the best return of those that repay themselves');
  const arr = runArrivals(h, 120);
  check(stops.every((id) => (arr.get(id) ?? 0) >= 1), `its trains run: every station served (${stops.map((id) => arr.get(id) ?? 0).join('/')})`);
  check(checkReservations(h).length === 0, 'consistent reservations');
}
{
  // a viaduct would do here too, taking rows of flats: it costs more and returns less than the subway (built even if
  // neither repaid itself in time, as forecasts move: the comparison is the point here)
  const r = aiCity((h) => packedGrid(h, 'Rowhurst', 256, 256, 28000, 120, 80), 'lightrail', true);
  const { h, ai, econs } = r;
  const l = h.lines.all()[0];
  const levels = (l ? linearStops(l.stops) ?? [] : []).map((id) => h.stations.get(id)?.rail?.level);
  const ug = econs.filter((e) => e.level === 'underground'), el = econs.filter((e) => e.level === 'elevated');
  console.log(`  dense rows: ${ai.log.slice(-1)[0]}`);
  console.log(`  compared: ${econs.map((e) => `${e.level} ${M(e.total)} ${fmt(e.ret, 3)}`).join(', ')}`);
  check(el.length > 0 && ug.length > 0, 'a viaduct and a subway were both planned');
  check(levels.length >= 4 && levels.every((v) => v === 'underground'), `the subway was built (${levels.join(', ')})`);
  check(el.length > 0 && ug.length > 0 && Math.min(...ug.map((e) => e.total)) < Math.min(...el.map((e) => e.total)), 'the subway costs less than the viaduct taking the buildings');
  check(el.length > 0 && ug.length > 0 && Math.max(...ug.map((e) => e.ret)) > Math.max(...el.map((e) => e.ret)), 'and returns more on its cost');
  check(h.depots.all().every((d) => d.level === 'underground'), 'its depot underground too');
}
{
  const r = aiCity((h) => village(h, 'Fieldside', 256, 256, 700, 110), 'lightrail', true);
  const { h, ai, econs } = r;
  const l = h.lines.all()[0];
  const stops = l ? linearStops(l.stops) ?? [] : [];
  const levels = stops.map((id) => h.stations.get(id)?.rail?.level);
  console.log(`  open land: ${ai.log.slice(-1)[0]}`);
  console.log(`  compared: ${econs.map((e) => `${e.level} ${M(e.total)} ${fmt(e.ret, 3)}`).join(', ')}`);
  check(!!l && levels.length >= 3 && levels.every((v) => v !== 'underground'), `a surface line in open land (${levels.join(', ')})`);
  const ug = econs.filter((e) => e.level === 'underground'), other = econs.filter((e) => e.level !== 'underground');
  check(!ug.length || (other.length > 0 && Math.min(...other.map((e) => e.total)) < Math.min(...ug.map((e) => e.total))), 'the surface plans cost less than the underground ones');
}

// ------------------------------------------------------------------------------------ 6. extending a line underground
console.log('6. extending the subway underground from its terminus (subway.ts planSubwayExtension)');
{
  const first = sts[0], west = -1;
  const T = first.rail!;
  const x = first.x + Math.sin(T.angle) * west * 26, z = first.z + Math.cos(T.angle) * west * 26 + 3;
  const plan = planSubwayExtension(g, first.id, x, z, ME, {});
  console.log(`  ${plan.ok ? `planned: ${M(plan.cost)} (station ${M(plan.costSplit.station)}, tunnels ${M(plan.costSplit.tunnels)}), ${fmt(plan.tunnelLength, 1)} units of tunnel, ${plan.tracks} tracks` : plan.error}`);
  check(plan.ok && plan.station?.level === 'underground' && plan.tracks === 2, 'an underground extension planned from the terminus');
  const b0 = g.world.buildings.size, e1 = net.nextEdge;
  const res = commitSubwayExtension(g, plan);
  check(res.error === null && res.station >= 0, `extension built (${res.error ?? 'ok'})`);
  const extra = [...net.edges.values()].filter((e) => e.id >= e1 && e.kind === 'rail' && e.station < 0);
  check(extra.length > 0 && extra.every(inTunnel), 'its tunnel has no portal');
  check(g.world.buildings.size >= b0 - plan.demolish.length, 'nothing demolished beyond its entrances');
  if (!res.error) {
    line.stops = outAndBack([res.station, ...sts.map((s) => s.id)]);
    g.lines.rebuild();
    for (const vid of line.vehicles) g.vehicles.get(vid)?.onLineChanged();
    const arr = runArrivals(g, 150);
    check((arr.get(res.station) ?? 0) >= 1, `trains reach the new terminus (${arr.get(res.station) ?? 0} arrivals)`);
  }
  const far = planSubwayExtension(g, sts[sts.length - 1].id, sts[sts.length - 1].x + 30, sts[sts.length - 1].z, ME);
  check(!far.ok, `an end with the depot beyond it is not free (${far.error})`);
}

console.log(`\n(${fmt((performance.now() - T0) / 1000, 1)} s)`);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
void UNDERGROUND_DEPOT;
