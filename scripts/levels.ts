// Construction levels and electric traction (game layer): an underground metro line at constant depth under a
// town, an elevated line over its streets, a ramp from ground track down into a tunnel and one up out of an
// underground station, a metro shuttle between underground stations, electrification of standard track, which
// vehicles may use which track (EMUs, electric traction), and a save round trip.
// npx esbuild scripts/levels.ts --bundle --platform=node --format=esm --outfile=$S/levels.mjs && node $S/levels.mjs [seed]
import { scenario } from './sectionlib';
import { verticalCounts } from './section-structurelib';
import { Game } from '../src/game/game';
import { planEdge, commitProposal, Proposal } from '../src/game/construction';
import { electrify } from '../src/game/build-ops';
import { TRACK_TYPES, ELECTRIFY } from '../src/game/constants';
import { MODEL_BY_ID, VehicleModel } from '../src/game/vehicle-types';
import { profAt, NEdge } from '../src/game/network';
import { trackAllows } from '../src/game/train';
import { stationEnds, nodeSnap, depotAtEnd } from '../src/game/routing';
import { serialize, deserialize } from '../src/game/save';
import { fails, check, fmt, free, railOpts, Train } from './lib';

const seed = Number(process.argv[2] ?? 7);
const g = Game.create({ size: 512, seed, towns: 8, hilliness: 'hilly', water: 'medium', startYear: 1990 });
g.economy.money = 2e9;
const w = g.world, net = w.net;
const M = (v: number) => fmt(v / 1e6, 2) + ' M';
const share = (p: Proposal, type: 'bridge' | 'tunnel') => {
  let l = 0, L = 0;
  for (const tp of p.tracks) { L += tp.len; for (const s of tp.sections) if (s.type === type) l += s.s1 - s.s0; }
  return l / (L || 1);
};
const newEdges = (from: number) => [...net.edges.values()].filter((e) => e.id >= from && e.kind === 'rail' && e.station < 0 && e.depot < 0);
const bridgedStreets = () => [...net.edges.values()].filter((e) => e.kind === 'road' && e.sections.some((s) => s.type === 'bridge')).length;
/** The flattest dry line through (cx, cz) from t0 to t1 along an angle (not within 0.6 rad of `avoid`), and its relief. */
const flattest = (cx: number, cz: number, t0: number, t1: number, avoid: number[] = []): { a: number; v: number } => {
  let best = 0, bs = Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const off = (b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    if (avoid.some((b) => off(b) < 0.6 || Math.abs(off(b) - Math.PI) < 0.6)) continue;
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let t = t0; t <= t1; t += 2) {
      const x = cx + Math.sin(a) * t, z = cz + Math.cos(a) * t, h = w.heightAt(x, z);
      if (!w.inside(x, z, 10) || h < 0.4) { ok = false; break; }
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    if (ok && mx - mn < bs) { bs = mx - mn; best = a; }
  }
  return { a: best, v: bs };
};
// a town with two flat lines through its centre (on a hill neither a viaduct nor a tunnel can follow the ground)
let T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0], L = 20, aU = 0, aE = Math.PI / 2;
pick: for (const town of [...g.towns.list].sort((a, b) => b.pop - a.pop).slice(0, 4)) {
  for (let len = Math.min(36, town.radius * 0.8); len >= 20; len -= 4) {
    const u = flattest(town.x, town.z, -len, len), e = flattest(town.x, town.z, -len, len, [u.a]);
    if (u.v <= 2.5 && e.v <= 2.5) { T = town; L = len; aU = u.a; aE = e.a; break pick; }
  }
}
console.log(`${T.name}: ${T.pop} people, radius ${fmt(T.radius, 0)}; lines ${fmt(2 * L, 0)} units`);

// ---- 1. a metro line underground at constant depth beneath the town (no demolition, streets untouched)
{
  const opts = railOpts(0, 2, { type: 'electric', level: 'underground', levelDepth: 2.2 });
  const ux = Math.sin(aU), uz = Math.cos(aU);
  const p = planEdge(g, free(g, T.x - ux * L, T.z - uz * L), free(g, T.x + ux * L, T.z + uz * L), opts);
  check(p.ok, `underground line planned (${p.errors.join(', ')})`);
  const tun = share(p, 'tunnel');
  let dmin = Infinity, dmax = -Infinity;
  const tp = p.tracks[0];
  for (let s = 4; s < tp.len - 4; s += 2) {
    const f = s / tp.len, x = tp.bez.x0 + (tp.bez.x3 - tp.bez.x0) * f, z = tp.bez.z0 + (tp.bez.z3 - tp.bez.z0) * f;
    const d = w.heightAt(x, z) - profAt(tp.prof, tp.len, s);
    dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
  }
  console.log(`  underground: ${fmt(tp.len, 0)} units, ${fmt(tun * 100, 0)} % in tunnel, depth ${fmt(dmin * 10, 0)}-${fmt(dmax * 10, 0)} m, ` +
    `${p.crossings.length} crossings (${[...new Set(p.crossings.map((c) => c.mode))].join('/')}), ${p.demolish.length} buildings demolished, cost ${M(p.cost)} (tunnels ${M(p.stats.costSplit!.tunnels)})`);
  check(tun > 0.97, 'the underground line is in tunnel along its whole length');
  check(dmin > 1.4 && dmax < 3 && dmax - dmin < 1.2, `constant depth below the town (${fmt(dmin, 2)}..${fmt(dmax, 2)} units)`);
  check(p.demolish.length === 0, 'nothing demolished above the tunnel');
  check(p.crossings.every((c) => c.mode === 'under'), 'the streets above are crossed underneath');
  check(p.stats.maxGrade <= TRACK_TYPES.metro.maxGrade + 1e-6, `within the metro grade (${fmt(p.stats.maxGrade * 100, 1)} %)`);
  const before = bridgedStreets(), e0 = net.nextEdge;
  check(commitProposal(g, p) === null, 'underground line built');
  check(bridgedStreets() === before, 'no street turned into a bridge over the tunnel');
  check(newEdges(e0).every((e) => e.type === 'electric' && e.sections.length > 0 && e.sections.every((s) => s.type === 'tunnel')), 'metro edges, tunnel sections');
}

// ---- 2. an elevated line over the streets (one viaduct, crossing over roads and the subway)
{
  const opts = railOpts(0, 2, { type: 'electric', level: 'elevated', levelHeight: 1.5 });
  const ux = Math.sin(aE), uz = Math.cos(aE);
  const p = planEdge(g, free(g, T.x - ux * L, T.z - uz * L), free(g, T.x + ux * L, T.z + uz * L), opts);
  check(p.ok, `elevated line planned (${p.errors.join(', ')})`);
  const via = share(p, 'bridge');
  console.log(`  elevated: ${fmt(p.tracks[0].len, 0)} units, ${fmt(via * 100, 0)} % on viaduct, ${p.crossings.length} crossings (${[...new Set(p.crossings.map((c) => c.mode))].join('/')}), ` +
    `${p.demolish.length} tall buildings in the way, cost ${M(p.cost)} (viaducts ${M(p.stats.costSplit!.bridges)})`);
  const inner = p.tracks.every((tp) => tp.sections.some((q) => q.type === 'bridge' && q.s0 <= 4 && q.s1 >= tp.len - 4));
  check(via > 0.9 && inner, 'the elevated line is one viaduct (free ends aside)');
  check(p.crossings.length > 0 && p.crossings.every((c) => c.mode === 'over'), 'roads (and the subway) are crossed over');
  const e0 = net.nextEdge;
  check(commitProposal(g, p) === null, 'elevated line built');
  check(newEdges(e0).every((e) => e.sections.every((s) => s.type === 'bridge')), 'bridge sections only');
}

// ---- 3. an underground station beside the subway, and a line leaving it at its level
{
  let built = -1;
  const ux = Math.sin(aU), uz = Math.cos(aU);
  for (const [lat, along] of [[16, -8], [-16, -8], [20, 6], [-20, 6], [24, -14], [-24, -14]] as const) {
    const plan = g.stations.planRail(T.x + uz * lat + ux * along, T.z - ux * lat + uz * along, aU, 8, 2, 0, { level: 'underground', trackType: 'electric', mode: 'metro' } as never);
    if (!plan.ok) continue;
    const id = g.stations.nextId;
    if (!g.stations.commitRail(plan, 0)) { built = id; break; }
  }
  check(built >= 0, 'underground station built');
  const st = built >= 0 ? g.stations.get(built)! : null;
  if (st?.rail) {
    // from the platform end whose way on stays under dry land
    const fx = Math.sin(st.rail.angle), fz = Math.cos(st.rail.angle);
    const cand = stationEnds(g, st).flatMap((e) => [e.front, e.back]).map((id) => net.nodes.get(id)!).map((n) => {
      const out = (n.x - st.rail!.x) * fx + (n.z - st.rail!.z) * fz > 0 ? 1 : -1;
      let dry = 0;
      for (let t = 2; t <= 30; t += 2) if (w.heightAt(n.x + fx * out * t, n.z + fz * out * t) > 0.5) dry++;
      return { n, out, dry };
    }).sort((a, b) => b.dry - a.dry);
    const { n, out } = cand[0];
    const p = planEdge(g, nodeSnap(g, n.id, 'rail'), free(g, n.x + fx * out * 30, n.z + fz * out * 30), railOpts(0, 1, { type: 'electric', level: 'underground', levelDepth: st.rail.depth ?? 2.2 }));
    console.log(`  station ${st.name}: platforms ${fmt((st.rail.depth ?? 0) * 10, 0)} m down; line from it ${fmt(share(p, 'tunnel') * 100, 0)} % in tunnel (${p.errors.join(', ') || 'ok'})`);
    check(p.ok && share(p, 'tunnel') > 0.9, 'a line leaves the underground station underground');
  }
}

// ---- 4. on open flat land (an empty map): ramps into and out of tunnels, a metro shuttle, electrification
const h = Game.create({ size: 256, seed: 4, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 });
h.economy.money = 1e9;
{
  const hw = h.world;
  for (let z = 0; z <= hw.size; z++) for (let x = 0; x <= hw.size; x++) hw.h[hw.vi(x, z)] = 3 + Math.sin(x * 0.05) * 0.4;
  hw.heightsVersion++;
  for (let i = 0; i < hw.trees.length; i++) if (hw.trees[i]) hw.removeTreesNear(hw.trees[i]!.x, hw.trees[i]!.z, 0.1);
}
const hn = h.world.net;
const hEdges = (from: number) => [...hn.edges.values()].filter((e) => e.id >= from && e.kind === 'rail' && e.station < 0 && e.depot < 0);
{
  // ground track, then down a ramp into a tunnel; a depot at the far end; metro units bought there
  const e0 = hn.nextEdge;
  const pg = planEdge(h, free(h, 40, 128), free(h, 70, 128), railOpts(0, 1, { type: 'electric' }));
  check(pg.ok && commitProposal(h, pg) === null, `ground metro track (${pg.errors.join(', ')})`);
  const ge = hEdges(e0)[0];
  const inner = hn.nodes.get(ge.a)!.x > hn.nodes.get(ge.b)!.x ? ge.a : ge.b, outer = inner === ge.a ? ge.b : ge.a;
  const p = planEdge(h, nodeSnap(h, inner, 'rail'), free(h, 120, 128), railOpts(0, 1, { type: 'electric', level: 'underground' }));
  const secs = p.tracks[0]?.sections ?? [];
  const tun = secs.find((q) => q.type === 'tunnel');
  console.log(`  ramp down: ${fmt(tun?.s0 ?? 0, 0)} units to the portal, then tunnel; max grade ${fmt(p.stats.maxGrade * 100, 1)} %; sections ${secs.map((q) => `${q.type} ${fmt(q.s0, 0)}-${fmt(q.s1, 0)}`).join(', ')} of ${fmt(p.tracks[0]?.len ?? 0, 0)}`);
  check(p.ok, `ramp down to the tunnel planned (${p.errors.join(', ')})`);
  check(!!tun && tun.s0 > 10 && tun.s0 < 30 && p.tracks[0].len - tun.s1 < 1 && secs.length === 1, 'a ramp from the ground track, then tunnel to the end');
  check(p.stats.maxGrade <= TRACK_TYPES.metro.maxGrade + 1e-6, 'ramp within the grade');
  check(commitProposal(h, p) === null, 'ramp built');
  const dep = depotAtEnd(h, outer, 0);
  check(dep >= 0, 'depot at the end of the ground track');
  if (dep >= 0) {
    const mb = MODEL_BY_ID.get('metro_b')!;
    const t = h.vehicles.buyTrain(dep, [mb, mb], null);
    check(t instanceof Train && t.capacity === mb.capacity * 2, `two coupled metro units bought (${typeof t === 'string' ? t : t.capacity + ' passengers'})`);
    const bad = h.vehicles.buyTrain(dep, [mb, MODEL_BY_ID.get('coach_ic')!], null);
    check(typeof bad === 'string', `a metro unit does not couple with a coach (${bad})`);
  }
}
{
  // two underground metro stations joined by a tunnel, a ramp up to a depot on the surface, a train between them
  const ids: number[] = [];
  for (const x of [80, 130]) {
    const plan = h.stations.planRail(x, 60, Math.PI / 2, 8, 1, 0, { level: 'underground', trackType: 'electric', mode: 'metro' } as never);
    const id = h.stations.nextId;
    if (plan.ok && !h.stations.commitRail(plan, 0)) ids.push(id);
    else console.log(`  station at ${x}: ${plan.error ?? 'commit failed'}`);
  }
  check(ids.length === 2, 'two underground metro stations');
  if (ids.length === 2) {
    const [A, B] = ids.map((id) => h.stations.get(id)!);
    const ends = (st: typeof A) => { const e = stationEnds(h, st)[0]; return [e.front, e.back].map((id) => hn.nodes.get(id)!).sort((p, q) => p.x - q.x); };
    const [, aE2] = ends(A), [bW, bE] = ends(B);
    const link = planEdge(h, nodeSnap(h, aE2.id, 'rail'), nodeSnap(h, bW.id, 'rail'), railOpts(0, 1, { type: 'electric', level: 'underground', levelDepth: A.rail!.depth }));
    check(link.ok && share(link, 'tunnel') > 0.95 && commitProposal(h, link) === null, `tunnel between the stations (${link.errors.join(', ')})`);
    const e1 = hn.nextEdge;
    const up = planEdge(h, nodeSnap(h, bE.id, 'rail'), free(h, bE.x + 50, 60), railOpts(0, 1, { type: 'electric' }));
    const upSec = up.tracks[0]?.sections ?? [];
    console.log(`  ramp up: ${upSec.map((q) => `${q.type} ${fmt(q.s0, 0)}-${fmt(q.s1, 0)}`).join(', ')} of ${fmt(up.tracks[0]?.len ?? 0, 0)}, max grade ${fmt(up.stats.maxGrade * 100, 1)} %`);
    check(up.ok && upSec.length === 1 && upSec[0].type === 'tunnel' && upSec[0].s0 < 0.5 && up.tracks[0].len - upSec[0].s1 > 8 && commitProposal(h, up) === null, `a ramp up from the underground station to the surface (${up.errors.join(', ')})`);
    const top = hEdges(e1).map((e) => [e.a, e.b]).flat().map((id) => hn.nodes.get(id)!).filter((n) => n.edges.length === 1).sort((p, q) => q.x - p.x)[0];
    const dep = top ? depotAtEnd(h, top.id, 0) : -1;
    check(dep >= 0, 'depot on the surface');
    const l = h.lines.create('rail', 0);
    l.stops = [A.id, B.id];
    const mb = MODEL_BY_ID.get('metro_b')!;
    const t = dep >= 0 ? h.vehicles.buyTrain(dep, [mb], l.id) : 'no depot';
    check(t instanceof Train, `metro train bought (${typeof t === 'string' ? t : t.name})`);
    if (t instanceof Train) {
      let arrivals = 0, last = '', hidden = 0;
      const q = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 4 * 300; i++) {
        h.update(0.25);
        if (t.onMap) { const at = t.pointBehind(0, q); if (at && t.hiddenAt(at.seg, at.sp)) hidden++; }
        if (t.state === 'loading' && last !== 'loading') arrivals++;
        last = t.state;
      }
      console.log(`  metro shuttle: ${arrivals} stops, in the tunnel ${hidden} ticks, state ${t.state} "${t.status}"`);
      check(arrivals >= 4 && hidden > 0, 'the metro train shuttles underground between the stations');
    }
  }
}

// ---- 5. electrification and which vehicles may use which track
const e5 = hn.nextEdge;
{
  const p = planEdge(h, free(h, 40, 170), free(h, 120, 170), railOpts(0, 2));
  check(p.ok && commitProposal(h, p) === null, `standard double track built (${p.errors.join(', ')})`);
}
const std = hEdges(e5);
const mm = (...ids: string[]): VehicleModel[] => ids.map((id) => MODEL_BY_ID.get(id)!);
const on = (cars: VehicleModel[], type: string) => trackAllows(cars, { ...std[0], type } as NEdge);
check(std.length === 2 && !on(mm('metro_b'), 'standard'), 'a metro EMU cannot use unelectrified track');
check(!on(mm('bullet'), 'standard') && on(mm('bullet'), 'electric'), 'electric traction needs overhead wire');
// metro and light-rail track are rails like any other: steam and diesel stock may use every rail track type
check(on(mm('diesel_b', 'coach_ic'), 'standard') && on(mm('diesel_b', 'coach_ic'), 'electric') && on(mm('diesel_b', 'coach_ic'), 'metro') && on(mm('steam_b'), 'lightrail'), 'steam and diesel run on every rail track type');
check(on(mm('metro_b'), 'metro') && on(mm('metro_b'), 'electric') && on(mm('emu_b'), 'metro') && on(mm('emu_b'), 'electric'), 'metro and commuter EMUs run on each other\'s track (through services)');
check(on(mm('lrv_b'), 'lightrail') && on(mm('lrv_b'), 'metro') && on(mm('lrv_b'), 'electric') && !on(mm('lrv_b'), 'standard'), 'light rail vehicles on every electrified rail track (not on unelectrified track)');
const len = std.reduce((s, e) => s + e.len, 0);
const dry = electrify(h, std.map((e) => e.id), 0, true);
check(dry.error === null && dry.changed === 2 && Math.abs(dry.cost - Math.round(len * ELECTRIFY.costPerUnit)) <= 1, `electrification priced per unit (${M(dry.cost)} for ${fmt(len, 0)} units)`);
const money = h.economy.money;
const r = electrify(h, std.map((e) => e.id), 0);
check(r.error === null && std.every((e) => hn.edges.get(e.id)?.type === 'electric') && Math.abs(money - h.economy.money - r.cost) < 1, 'standard track electrified');
check(std.every((e) => on(mm('metro_b'), hn.edges.get(e.id)!.type)), 'the metro EMU may use it now');
check(electrify(h, std.map((e) => e.id), 0, true).error !== null, 'already electrified');

// ---- 6. save round trip
{
  const tally = (gg: Game) => {
    const t: Record<string, number> = {};
    for (const e of gg.world.net.edges.values()) if (e.kind === 'rail') { t[e.type] = (t[e.type] ?? 0) + 1; for (const s of e.sections) t[s.type] = (t[s.type] ?? 0) + 1; }
    const trains = [...gg.vehicles.map.values()].filter((v) => v instanceof Train).map((v) => (v as Train).cars.map((c) => c.id).join('+'));
    return JSON.stringify({ t, trains });
  };
  for (const gg of [g, h]) {
    const g2 = deserialize(JSON.parse(JSON.stringify(serialize(gg))));
    const a = tally(gg), b = tally(g2);
    console.log(`  saved: ${a}`);
    check(a === b, 'save round trip keeps track types, levels and EMU trains');
  }
}
scenario('shared curved vertical formations grow without level drift and replay exactly',verticalCounts);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
