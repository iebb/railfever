// Cargo routing: the heap Dijkstra of Lines.rebuild gives exactly the tables of the former sort-based search (seeds
// 7 / 23 / 51 with AI networks); games without mail vehicles have no mail tables or mail state; where every vehicle of a
// transfer complex carries both cargoes mail shares the passenger tables (the same Map objects); a mail fleet of its
// own (passenger-only trains beside mixed ones, mail-only trains) gets tables of its own, equal to an independent mail
// search; rebuild timing.
// npx esbuild scripts/cargoroute.ts --bundle --platform=node --format=esm --outfile=$S/cargoroute.mjs && node $S/cargoroute.mjs [seeds]
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { routeTables, routeGraph, type RouteEdge, type Hop } from '../src/game/lines';
import { lineTable, mailFleet, spacingSchedule, TRANSFER_PENALTY_S, PLATFORM_CHANGE_S } from '../src/game/patterns';
import { WALK_LINE } from '../src/game/stations';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { fails, check, fmt, placeAndConnect, depotBehind, addBusStop, roadDepotNear, Train, RoadVehicle } from './lib';
import { RNG } from '../src/game/rng';

if (!process.argv[1]?.endsWith('cargoroute.mjs')) throw new Error('bundle this test as cargoroute.mjs');
const seeds = (process.argv[2] ?? '7,23,51').split(',').map(Number);
const M = (id: string) => MODEL_BY_ID.get(id)!;

/** The former routing search (a sorted array as the open list), kept as the reference for the heap. */
function referenceTables(edges: Map<number, RouteEdge[]>, sources: Iterable<number>): Map<number, Map<number, Hop>> {
  const out = new Map<number, Map<number, Hop>>();
  for (const src of sources) {
    const table = new Map<number, Hop>();
    const best = new Map<number, number>([[src, 0]]);
    const first = new Map<number, { line: number; alight: number }>();
    const rode = new Map<number, boolean>([[src, false]]);
    const walked = new Map<number, boolean>([[src, false]]);
    const open: [number, number][] = [[0, src]];
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [c, u] = open.shift()!;
      if (c > (best.get(u) ?? Infinity)) continue;
      for (const e of edges.get(u) ?? []) {
        const transfer = e.line !== WALK_LINE && rode.get(u) ? TRANSFER_PENALTY_S + (walked.get(u) ? 0 : PLATFORM_CHANGE_S) : 0;
        const nc = c + e.cost + transfer;
        if (nc < (best.get(e.to) ?? Infinity)) {
          best.set(e.to, nc);
          first.set(e.to, u === src ? { line: e.line, alight: e.to } : first.get(u)!);
          rode.set(e.to, !!rode.get(u) || e.line !== WALK_LINE);
          walked.set(e.to, e.line === WALK_LINE);
          open.push([nc, e.to]);
        }
      }
    }
    const legs = new Map<number, { line: number; cost: number }[]>();
    for (const e of edges.get(src) ?? []) {
      let a = legs.get(e.to);
      if (!a) { a = []; legs.set(e.to, a); }
      const o = a.find((x) => x.line === e.line);
      if (o) o.cost = Math.min(o.cost, e.cost); else a.push({ line: e.line, cost: e.cost });
    }
    for (const [d, f] of first) {
      if (d === src || !rode.get(d)) continue;
      const hop: Hop = { line: f.line, alight: f.alight, cost: best.get(d)! };
      const leg = legs.get(f.alight);
      if (leg && leg.length > 1) {
        const own = leg.find((x) => x.line === f.line);
        const lim = (own ? own.cost : Math.min(...leg.map((x) => x.cost))) * 1.15 + 10;
        const alt = leg.filter((x) => x.line !== f.line && x.cost <= lim).map((x) => x.line);
        if (alt.length) hop.lines = [f.line, ...alt];
      }
      table.set(d, hop);
    }
    out.set(src, table);
  }
  return out;
}

/** First difference between two routing tables (sources, destinations and their order, every hop field), or null. */
function difference(a: Map<number, Map<number, Hop>>, b: Map<number, Map<number, Hop>>): string | null {
  const sa = [...a.keys()], sb = [...b.keys()];
  if (sa.join() !== sb.join()) return `sources differ (${sa.length} vs ${sb.length})`;
  for (const s of sa) {
    const ta = a.get(s)!, tb = b.get(s)!;
    const da = [...ta.keys()], db = [...tb.keys()];
    if (da.join() !== db.join()) return `station ${s}: destinations differ (${da.length} vs ${db.length})`;
    for (const d of da) {
      const x = ta.get(d)!, y = tb.get(d)!;
      if (x.line !== y.line || x.alight !== y.alight || x.cost !== y.cost || (x.lines ?? []).join() !== (y.lines ?? []).join())
        return `station ${s} -> ${d}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
    }
  }
  return null;
}
const hops = (t: Map<number, Map<number, Hop>>) => [...t.values()].reduce((n, m) => n + m.size, 0);

/** Run with stepTick to a day. */
function runTo(g: Game, day: number) { while (g.day < day) for (let k = 0; k < TICKS_PER_DAY; k++) g.stepTick(); }

function timing(edges: Map<number, RouteEdge[]>): { heap: number; ref: number } {
  const time = (f: () => void) => { let best = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); } return best; };
  return { heap: time(() => routeTables(edges, edges.keys())), ref: time(() => referenceTables(edges, edges.keys())) };
}

// ---- random graphs with many equal costs: the heap pops ties in insertion order, as the stable sort did
{
  const r = new RNG(4711);
  let cases = 0, bad: string | null = null;
  for (let k = 0; k < 400 && !bad; k++) {
    const n = 5 + r.int(60), edges = new Map<number, RouteEdge[]>();
    const add = (a: number, e: RouteEdge) => { let arr = edges.get(a); if (!arr) { arr = []; edges.set(a, arr); } arr.push(e); };
    const lines = 1 + r.int(8);
    for (let l = 1; l <= lines; l++) {
      // a line: a random path of stations, edges between every pair along it (as line tables give), small integer costs
      const len = 2 + r.int(Math.min(8, n - 1)), path: number[] = [];
      while (path.length < len) { const s = r.int(n); if (!path.includes(s)) path.push(s); }
      for (let i = 0; i < len; i++) for (let j = 0; j < len; j++) if (i !== j) add(path[i], { to: path[j], line: l, cost: 10 * (1 + r.int(4)) * Math.abs(i - j) });
    }
    for (let w = r.int(6); w > 0; w--) { const a = r.int(n), b = r.int(n); if (a !== b) { add(a, { to: b, line: WALK_LINE, cost: 30 }); add(b, { to: a, line: WALK_LINE, cost: 30 }); } }
    bad = difference(routeTables(edges, edges.keys()), referenceTables(edges, edges.keys()));
    cases++;
  }
  console.log(`random graphs: ${cases} compared`);
  check(!bad, `random graphs with ties: heap Dijkstra equals the sort-based search${bad ? ' — ' + bad : ''}`);
}

// ---- AI networks: identical tables, no mail state without mail vehicles
const timings: { heap: number; ref: number; sources: number; hops: number }[] = [];
let aiGame: Game | null = null;
for (const seed of seeds) {
  const g = Game.create({ size: 512, seed, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  for (const day of [300, 600, 900]) {
    runTo(g, day);
    const { edges } = routeGraph(g, 'pax');
    const heap = routeTables(edges, edges.keys()), ref = referenceTables(edges, edges.keys());
    const diff = difference(heap, ref), live = difference(heap, g.lines.routing);
    console.log(`seed ${seed} day ${day}: ${g.lines.map.size} lines, ${g.vehicles.map.size} vehicles, ${heap.size} sources, ${hops(heap)} hops`);
    check(!diff, `seed ${seed} day ${day}: heap Dijkstra equals the sort-based search${diff ? ' — ' + diff : ''}`);
    check(!live, `seed ${seed} day ${day}: the game's routing equals the search${live ? ' — ' + live : ''}`);
    check(g.lines.mailRouting.size === 0 && g.lines.mailStations.size === 0 && !g.lines.mailActive, `seed ${seed} day ${day}: no mail tables without mail vehicles`);
    check([...g.lines.map.values()].every((l) => mailFleet(g, l) === 'none' && !l.mail), `seed ${seed} day ${day}: no line carries mail`);
    check([...g.stations.map.values()].every((st) => !st.mail) && g.mail.toJSON() === null, `seed ${seed} day ${day}: no station mail state, mail's random stream unused`);
    check(g.economy.months.every((m) => m.v.mailIncome === 0) && !('mailIncome' in (JSON.parse(JSON.stringify(g.economy)).current)), `seed ${seed} day ${day}: no mail income; saves leave the zero category out`);
  }
  const { edges } = routeGraph(g, 'pax');
  const t = timing(edges);
  timings.push({ ...t, sources: edges.size, hops: hops(g.lines.routing) });
  console.log(`  routing search: heap ${fmt(t.heap, 2)} ms, sort-based ${fmt(t.ref, 2)} ms (${edges.size} sources)`);
  // Modern city units cannot take vans. Select a real locomotive service from the tested networks.
  if (!aiGame && g.vehicles.all().some((v) => v instanceof Train && v.cars.some((c) => c.kind === 'loco'))) aiGame = g;
}
const heapMs = timings.reduce((a, t) => a + t.heap, 0), refMs = timings.reduce((a, t) => a + t.ref, 0);
console.log(`routing search total: heap ${fmt(heapMs, 1)} ms, sort-based ${fmt(refMs, 1)} ms (${fmt(refMs / Math.max(0.01, heapMs), 1)}x)`);
check(heapMs <= refMs * 1.25 + 2, `the heap search is not slower than the sort-based one (${fmt(heapMs, 1)} vs ${fmt(refMs, 1)} ms)`);

// ---- mail on AI networks: a van for each locomotive-hauled train when it next stands at a platform (complexes whose
// trains all get one share the passenger tables; the others route mail on their own)
check(!!aiGame, 'the seeded AI networks include a locomotive-hauled service for mail routing');
if (aiGame) {
  const g = aiGame, done = new Set<number>(), hauled = g.vehicles.all().filter((v): v is Train => v instanceof Train && v.cars.some((c) => c.kind === 'loco'));
  let added = 0;
  for (let k = 0; k < 120 * TICKS_PER_DAY && done.size < hauled.length; k++) {
    g.stepTick();
    for (const v of hauled) {
      if (done.has(v.id) || v.state !== 'loading') continue;
      done.add(v.id);
      // a van in place of the first coach, no longer than it (the train still fits its platforms)
      const made = v.madeUp;
      const i = made.findIndex((c) => c.kind === 'wagon' && !c.mail);
      const van = ['van_ic', 'van_steel', 'van_wood'].map(M).find((m) => i >= 0 && m.length <= made[i].length + 1e-9 && m.intro <= g.year && m.retire >= g.year);
      if (!van) continue;
      const cars = [...made]; cars[i] = van;
      const err = g.vehicles.recompose(v, cars);
      if (!err) added++; else console.log(`  recompose ${v.name} (${v.cars.map((c) => c.id).join(',')}, reversed ${v.reversed}): ${err}`);
    }
  }
  console.log(`AI network: vans added to ${added} of ${hauled.length} locomotive-hauled trains at platforms`);
  check(added > 0, 'vans added to AI trains at platforms (recompose while loading)');
  const { edges } = routeGraph(g, 'mail');
  const mail = routeTables(edges, edges.keys());
  let compared = 0, shared = 0;
  for (const [src, table] of g.lines.mailRouting) {
    const ref = mail.get(src);
    compared++;
    if (g.lines.routing.get(src) === table) shared++;
    const d = ref ? difference(new Map([[src, table]]), new Map([[src, ref]])) : 'no independent table';
    if (d) { check(false, `mail routing from ${src} equals an independent mail search — ${d}`); break; }
  }
  for (const [src, ref] of mail) if (ref.size && !g.lines.mailRouting.has(src)) { check(false, `mail routing has station ${src} (${ref.size} destinations)`); break; }
  console.log(`  mail routing: ${compared} sources (${shared} sharing the passenger tables), ${g.lines.mailStations.size} mail stations`);
  check(compared > 0 && g.lines.mailActive, 'mail routing on the AI network');
  let income = 0;
  for (let d = 0; d < 300; d++) {
    runTo(g, g.day + 1);
    if (g.day % 30 === 0) income += g.companies.reduce((a, c) => a + (c.economy.months[c.economy.months.length - 1]?.v.mailIncome ?? 0), 0);
  }
  console.log(`  300 days on: mail income ${fmt(income / 1000, 1)}k, mail delivered ${g.vehicles.all().reduce((a, v) => a + v.mailDelivered, 0)} units`);
  check(income > 0, 'AI trains with vans earn mail income');
}

// ---- a line of our own: mixed trains share the passenger tables; a passenger-only or mail-only train does not
{
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {})!;
  check(!!pr, 'player railway');
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const mixed: VehicleModel[] = [M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')];
  for (let i = 0; i < 2; i++) check(g.vehicles.buyTrain(dep, mixed, line.id) instanceof Train, `mixed train ${i + 1} bought`);
  check(mailFleet(g, line) === 'all' && lineTable(g, line, 'mail') === lineTable(g, line), 'every train carries both: the mail table is the passenger table');
  check(g.lines.mailRouting.get(pr.A.id) === g.lines.routing.get(pr.A.id) && !!g.lines.mailRouting.get(pr.A.id)?.get(pr.B.id), 'mixed trains: mail shares the passenger routing (the same tables)');
  check(g.lines.mailServed(pr.A.id) && g.lines.mailServed(pr.B.id), 'both stations are mail stations');
  // a second railway elsewhere without mail: a part of the network of its own (the first keeps sharing)
  const pr2 = placeAndConnect(g, 60, 200, 0, new Set([pr.TA.id, pr.TB.id]), 1, () => {});
  if (pr2) {
    const l2 = g.lines.create('rail', 0);
    l2.stops = [pr2.A.id, pr2.B.id];
    g.vehicles.buyTrain(depotBehind(g, pr2.A, pr2.B, 0), [M('diesel_b'), M('coach_ic'), M('coach_ic')], l2.id);
    check(!g.lines.mailServed(pr2.A.id) && !g.lines.mailRouting.has(pr2.A.id), 'a railway without vans has no mail routing');
    check(g.lines.mailRouting.get(pr.A.id) === g.lines.routing.get(pr.A.id), 'the separate mixed railway still shares the passenger tables');
  } else console.log('  (no site for a second railway)');
  // a town bus without mail calling at (or walking distance from) the station: that part routes mail on its own
  const TA = pr.TA, near: [number, number][] = [];
  for (const e of g.towns.streets(TA, 0)) for (let s = 1; s < e.len; s += 2) {
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, s, p);
    const d = Math.hypot(p.x - pr.A.x, p.z - pr.A.z);
    if (d < 4 || d > 16) continue;
    const bp = g.stations.planBusStop(p.x, p.z, 0);
    if (bp.ok && (bp.join?.id === pr.A.id || bp.links.some((st) => st.id === pr.A.id))) near.push([p.x, p.z]);
  }
  const s1 = near.length ? addBusStop(g, near[0][0], near[0][1], 0) : -1;
  const s1st = s1 >= 0 ? g.stations.get(s1) : undefined;
  if (s1st && (s1 === pr.A.id || s1st.links.includes(pr.A.id))) {
    let far: [number, number] | null = null;
    for (const e of g.towns.streets(TA, 0)) {
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, e.len / 2, p);
      const d = Math.hypot(p.x - pr.A.x, p.z - pr.A.z);
      if (d >= 22 && d <= 40 && g.stations.planBusStop(p.x, p.z, 0).ok && !g.stations.planBusStop(p.x, p.z, 0).join) { far = [p.x, p.z]; break; }
    }
    const s2 = far ? addBusStop(g, far[0], far[1], 0) : -1;
    const bd = far ? roadDepotNear(g, far[0], far[1], 0) : -1;
    if (s2 >= 0 && bd >= 0) {
      const bl = g.lines.create('road', 0);
      bl.stops = [s1, s2];
      check(g.vehicles.buyRoad(bd, M('bus_c'), bl.id) instanceof RoadVehicle, 'a town bus to the station');
      const own = g.lines.mailRouting.get(pr.A.id);
      check(!!own && own !== g.lines.routing.get(pr.A.id) && !!own.get(pr.B.id), `a passenger-only bus in the transfer complex (${s1 === pr.A.id ? 'at the station' : 'a linked stop'}): mail routed on its own, still to the other end`);
      check(!g.lines.mailServed(s2), 'the bus stop is no mail station');
      const { edges } = routeGraph(g, 'mail');
      const d = difference(new Map([...g.lines.mailRouting]), routeTables(edges, [...g.lines.mailRouting.keys()]));
      check(!d, `the complex's mail routing equals an independent mail search${d ? ' — ' + d : ''}`);
      g.lines.delete(bl.id);
      check(g.lines.mailRouting.get(pr.A.id) === g.lines.routing.get(pr.A.id), 'without the bus line the complex shares the passenger tables again');
    } else console.log('  (no site for the town bus)');
  } else console.log('  (no bus stop site at the station)');
  const plain = g.vehicles.buyTrain(dep, [M('diesel_b'), M('coach_ic'), M('coach_ic')], line.id) as Train;
  check(mailFleet(g, line) === 'some' && lineTable(g, line, 'mail') !== lineTable(g, line), 'a passenger-only train beside them: the mail table is its own');
  check(lineTable(g, line).pats[0]?.n === 3 && lineTable(g, line, 'mail').pats[0]?.n === 2, 'passenger timetable over 3 trains, mail over the 2 with vans');
  const own = g.lines.mailRouting.get(pr.A.id);
  check(!!own && own !== g.lines.routing.get(pr.A.id) && !!own.get(pr.B.id), 'mail routing of its own, still reaching the other end');
  const mailTrain = g.vehicles.buyTrain(dep, [M('diesel_b'), M('van_ic'), M('van_ic')], line.id) as Train;
  check(mailTrain.mailOnly && !mailTrain.carries('pax') && mailTrain.carries('mail'), 'a mail train carries mail only');
  check(lineTable(g, line).pats[0]?.n === 3 && lineTable(g, line, 'mail').pats[0]?.n === 3, 'the mail train counts for mail, not for passengers');
  check(g.lines.fleetSize(line.id, 'pax') === 3 && g.lines.fleetSize(line.id, 'mail') === 3, 'fleet sizes per cargo');
  runTo(g, g.day + 200);
  const sched = spacingSchedule(g, mailTrain);
  check(!!sched && !!line.spacing?.['m0'] && sched.vehicles === 1, 'the mail train keeps its own spacing clock (key m0, 1 mail-only train)');
  check(!!spacingSchedule(g, plain) && spacingSchedule(g, plain)!.vehicles === 3, 'passenger spacing over the three trains with seats');
  // the mixed trains go: mail rides the mail train only
  for (const v of g.vehicles.all()) if (v !== plain && v !== mailTrain) g.vehicles.sell(v.id);
  check(mailFleet(g, line) === 'some' && !!g.lines.mailRouting.get(pr.A.id)?.get(pr.B.id), 'mail routes by the mail train');
  runTo(g, g.day + 400);
  const { edges } = routeGraph(g, 'mail');
  const d = difference(new Map([...g.lines.mailRouting].filter(([s]) => edges.has(s))), routeTables(edges, [...g.lines.mailRouting.keys()].filter((s) => edges.has(s))));
  check(!d, `mail routing equals an independent mail search${d ? ' — ' + d : ''}`);
  const st = g.stations.get(pr.A.id)!;
  console.log(`player line, 200 days: mail waiting at ${st.name} ${st.mail?.total ?? 0}, loaded ${line.mail?.month ?? 0}+${line.mail?.last ?? 0}, mail train ${mailTrain.mailLoad}/${mailTrain.mailCapacity} delivered ${mailTrain.mailDelivered}, passengers ${mailTrain.load}`);
  check(mailTrain.load === 0 && mailTrain.delivered === 0 && mailTrain.mailDelivered > 0, 'the mail train delivers mail and no passengers');
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
