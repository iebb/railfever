// Fuzz test: random construction, bulldozing, signals, stations, depots, lines, vehicles (mail vans, mail trucks and
// postbuses among them), recomposed trains, terraforming, tram tracks / tram depots / trams and save/load round trips
// while simulating; checks network / vehicle / passenger and mail invariants (incl. tram edges) after every step.
// npx esbuild scripts/fuzz.ts --bundle --platform=node --format=esm --outfile=$S/fuzz.mjs && node $S/fuzz.mjs [seed] [steps]
import { Game } from '../src/game/game';
import { planEdge, commitProposal, findSnap, Snap } from '../src/game/construction';
import { toggleSignal, bulldoze, terraformBrush, addTramTracks, removeTramTracks, roadPath, tramUsable } from '../src/game/build-ops';
import { tramDepotGen, pathPoints } from '../src/game/ai-tram';
import { runGen } from '../src/game/routing';
import { availableModels, type VehicleModel } from '../src/game/vehicle-types';
import { buildRailDepot, buildRoadDepot } from '../src/game/routing';
import { RNG } from '../src/game/rng';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { checkReservations, checkNaN, fmt } from './lib';

const seed = Number(process.argv[2] ?? 1), STEPS = Number(process.argv[3] ?? 500);
const r = new RNG(seed * 7919 + 3);
let g = Game.create({ size: 256, seed, towns: 6, hilliness: 'hilly', water: 'medium', startYear: 1960 });
g.economy.money = 1e9;

function invariants(): string[] {
  const errs: string[] = [];
  const net = g.world.net;
  for (const n of net.nodes.values()) {
    if (!isFinite(n.x) || !isFinite(n.y) || !isFinite(n.z)) errs.push(`node ${n.id} NaN`);
    if (!n.edges.length) errs.push(`node ${n.id} without edges`);
    for (const eid of n.edges) { const e = net.edges.get(eid); if (!e) errs.push(`node ${n.id} lists missing edge ${eid}`); else if (e.a !== n.id && e.b !== n.id) errs.push(`node ${n.id} lists edge ${eid} not attached to it`); }
    if (n.signal && n.edges.length !== 2) errs.push(`signal on node ${n.id} with ${n.edges.length} edges`);
  }
  for (const e of net.edges.values()) {
    const a = net.nodes.get(e.a), b = net.nodes.get(e.b);
    if (!a || !b) { errs.push(`edge ${e.id} with missing node`); continue; }
    if (!a.edges.includes(e.id) || !b.edges.includes(e.id)) errs.push(`edge ${e.id} not listed by its nodes`);
    if (!isFinite(e.len) || e.len <= 0) errs.push(`edge ${e.id} bad length ${e.len}`);
    if (e.prof.some((y) => !isFinite(y))) errs.push(`edge ${e.id} NaN profile`);
    if (e.station >= 0 && !g.stations.get(e.station)?.rail?.edges.includes(e.id)) errs.push(`edge ${e.id} claims station ${e.station}`);
    if (e.depot >= 0 && g.depots.get(e.depot)?.edge !== e.id) errs.push(`edge ${e.id} claims depot ${e.depot}`);
    if (e.tram && (e.kind !== 'road' || e.tramOwner === undefined || e.tramOwner < 0 || e.tramOwner >= g.companies.length)) errs.push(`edge ${e.id} bad tram tracks (${e.kind}, owner ${e.tramOwner})`);
    if (!e.tram && e.tramOwner !== undefined) errs.push(`edge ${e.id} tram owner without tracks`);
  }
  for (const c of net.crossings.values()) if (!net.edges.has(c.e1) || !net.edges.has(c.e2)) errs.push(`crossing ${c.id} references a missing edge`);
  for (const st of g.stations.map.values()) {
    for (const eid of st.rail?.edges ?? []) if (!net.edges.has(eid)) errs.push(`station ${st.id} lists missing edge ${eid}`);
    for (const p of st.stops) if (!net.edges.get(p.edge) || net.edges.get(p.edge)!.kind !== 'road') errs.push(`stop of station ${st.id} on missing road ${p.edge}`);
    if (st.waitingTotal < 0) errs.push(`station ${st.id} negative waiting`);
    if (st.mail) {
      let sum = 0;
      for (const w of st.mail.waiting.values()) { sum += w.count; if (!(w.count > 0) || !isFinite(w.t)) errs.push(`station ${st.id} bad mail group ${JSON.stringify(w)}`); }
      if (Math.abs(sum - st.mail.total) > 1e-6 || st.mail.total < 0) errs.push(`station ${st.id} mail total ${st.mail.total} vs groups ${sum}`);
      if (!(st.mail.rating >= 0 && st.mail.rating <= 1)) errs.push(`station ${st.id} mail rating ${st.mail.rating}`);
    }
  }
  for (const d of g.depots.map.values()) {
    if (!net.edges.has(d.edge) || !net.nodes.has(d.node)) errs.push(`depot ${d.id} lost its track`);
    else if ((d.kind === 'tram') !== !!net.edges.get(d.edge)!.tram) errs.push(`depot ${d.id} (${d.kind}) stub tram flag wrong`);
  }
  for (const l of g.lines.map.values()) {
    for (const s of l.stops) if (!g.stations.get(s)) errs.push(`line ${l.id} stop ${s} missing`);
    for (const v of l.vehicles) if (g.vehicles.get(v)?.lineId !== l.id) errs.push(`line ${l.id} vehicle ${v} not on the line`);
    for (const v of l.vehicles) { const rv = g.vehicles.get(v); if (rv instanceof RoadVehicle && (l.kind === 'tram') !== rv.isTram) errs.push(`line ${l.id} (${l.kind}) runs ${rv.name}`); }
  }
  for (const v of g.vehicles.map.values()) {
    if (v.lineId != null && !g.lines.get(v.lineId)?.vehicles.includes(v.id)) errs.push(`${v.name} line ${v.lineId} does not list it`);
    if (v.load < 0 || v.load > v.capacity + 1e-6) errs.push(`${v.name} load ${v.load}/${v.capacity}`);
    if (v.mailLoad < 0 || v.mailLoad > v.mailCapacity + 1e-6) errs.push(`${v.name} mail ${v.mailLoad}/${v.mailCapacity}`);
    let mail = 0;
    for (const c of v.mailCargo.values()) { mail += c.count; if (!(c.count > 0) || !isFinite(c.t0)) errs.push(`${v.name} bad mail group ${JSON.stringify(c)}`); }
    if (Math.abs(mail - v.mailLoad) > 1e-6) errs.push(`${v.name} mail groups ${mail} vs load ${v.mailLoad}`);
    if (v instanceof Train) {
      for (const s of v.segs) if (s.e >= 0 && !net.edges.has(s.e)) errs.push(`${v.name} on missing edge ${s.e}`);
      if (v.segs.length && (v.headSeg < 0 || v.headSeg >= v.segs.length)) errs.push(`${v.name} bad headSeg`);
    } else if (v instanceof RoadVehicle && v.seg && !net.edges.has(v.seg.e)) errs.push(`${v.name} on missing road ${v.seg.e}`);
    else if (v instanceof RoadVehicle && v.isTram && v.seg && v.seg.kind === 'lane' && !tramUsable(g, net.edges.get(v.seg.e)!, v.owner)) errs.push(`${v.name} off the tram tracks (edge ${v.seg.e})`);
  }
  for (const a of g.vehicles.ambient) if (a.seg && !net.edges.has(a.seg.e)) errs.push(`town car on missing road ${a.seg.e}`);
  errs.push(...checkReservations(g));
  const nan = checkNaN(g);
  if (nan) errs.push(nan);
  return errs;
}

const near = (x: number, z: number, d: number) => ({ x: Math.max(4, Math.min(g.world.size - 4, x + (r.next() - 0.5) * 2 * d)), z: Math.max(4, Math.min(g.world.size - 4, z + (r.next() - 0.5) * 2 * d)) });
const counts = new Map<string, number>();
const did = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
let errors = 0;
const T0 = performance.now();
for (let step = 0; step < STEPS; step++) {
  const town = g.towns.list[r.int(g.towns.list.length)];
  const k = r.next();
  let op = '';
  try {
    if (k < 0.26) {
      op = 'edge';
      const kind = r.chance(0.55) ? 'rail' : 'road';
      const a = near(town.x, town.z, town.radius + 15), b = near(a.x, a.z, 25);
      const sa: Snap = findSnap(g, kind, a.x, a.z, 1.5), sb: Snap = findSnap(g, kind, b.x, b.z, 1.5);
      const p = planEdge(g, sa, sb, { kind, type: kind === 'rail' ? (r.chance(0.8) ? 'standard' : 'highspeed') : r.chance(0.5) ? 'road' : 'street', tracks: kind === 'rail' ? 1 + r.int(2) : 1, heightOffset: r.chance(0.2) ? (r.next() - 0.5) * 6 : 0, crossing: r.pick(['auto', 'auto', 'over', 'under', 'level'] as const), owner: 0, tram: kind === 'road' && r.chance(0.25) });
      if (p.ok && !commitProposal(g, p)) did('built ' + kind);
    } else if (k < 0.33) {
      op = 'station';
      const a = near(town.x, town.z, town.radius + 10);
      const p = g.stations.planRail(a.x, a.z, r.next() * Math.PI * 2, 8 + r.int(10), 1 + r.int(3), 0);
      if (p.ok && !g.stations.commitRail(p, 0)) did('station');
    } else if (k < 0.39) {
      op = 'bus stop';
      const streets = g.towns.streets(town, 0);
      if (streets.length) {
        const e = streets[r.int(streets.length)];
        const p = { x: 0, y: 0, z: 0 };
        g.world.net.pointAt(e, r.next() * e.len, p);
        if (!g.stations.commitBusStop(p.x, p.z, 0)) did('bus stop');
      }
    } else if (k < 0.44) {
      op = 'depot';
      const sts = g.stations.all().filter((s) => s.rail);
      if (r.chance(0.5) && sts.length) { if (buildRailDepot(g, sts[r.int(sts.length)], 0) >= 0) did('rail depot'); }
      else if (buildRoadDepot(g, town.x + (r.next() - 0.5) * 20, town.z + (r.next() - 0.5) * 20, 0, 10) >= 0) did('road depot');
    } else if (k < 0.5) {
      op = 'signal';
      const rails = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0);
      if (rails.length) {
        const e = rails[r.int(rails.length)];
        const p = { x: 0, y: 0, z: 0 };
        g.world.net.pointAt(e, r.next() * e.len, p);
        if (!toggleSignal(g, p.x, p.z, 0)) did('signal');
      }
    } else if (k < 0.57) {
      op = 'bulldoze';
      const a = near(town.x, town.z, town.radius + 12);
      const w = r.chance(0.5) ? 0 : 1 + r.next() * 4;
      const res = bulldoze(g, a.x, a.z, a.x + w, a.z + w, 0, false);
      if (res.changed) did('bulldoze');
    } else if (k < 0.6) {
      op = 'terraform';
      const a = near(town.x, town.z, town.radius + 20);
      if (!terraformBrush(g, a.x, a.z, 1 + r.next() * 3, r.pick(['raise', 'lower', 'level'] as const), g.world.heightAt(a.x, a.z), 0).error) did('terraform');
    } else if (k < 0.72) {
      op = 'line';
      const kind = r.pick(['rail', 'road', 'tram'] as const);
      const sts = g.stations.all().filter((s) => (kind === 'rail' ? !!s.rail : kind === 'tram' ? g.stations.tramStops(s, 0).length > 0 : s.stops.length > 0));
      if (sts.length >= 2) {
        const l = g.lines.all().find((x) => x.kind === kind && r.chance(0.6)) ?? g.lines.create(kind, 0);
        const s = sts[r.int(sts.length)];
        if (l.stops[l.stops.length - 1] !== s.id) l.stops.push(s.id);
        if (r.chance(0.15) && l.stops.length > 2) l.stops.splice(r.int(l.stops.length), 1);
        g.lines.rebuild();
        for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
        did('line edit');
      }
    } else if (k < 0.81) {
      op = 'buy';
      const deps = g.depots.all();
      if (deps.length) {
        const dp = deps[r.int(deps.length)];
        const lines = g.lines.all().filter((l) => l.kind === dp.kind);
        const line = lines.length && r.chance(0.85) ? lines[r.int(lines.length)].id : null;
        if (dp.kind === 'rail') {
          const loco = r.pick(availableModels(g.year, 'loco')), wag = r.pick(availableModels(g.year, 'wagon'));
          if (typeof g.vehicles.buyTrain(dp.id, [loco, ...Array(1 + r.int(4)).fill(wag)], line) !== 'string') did('buy train');
        } else if (dp.kind === 'tram') {
          const trams = availableModels(g.year, 'tram');
          if (trams.length && typeof g.vehicles.buyRoad(dp.id, r.pick(trams), line) !== 'string') did('buy tram');
        } else if (typeof g.vehicles.buyRoad(dp.id, r.pick(availableModels(g.year, 'bus')), line) !== 'string') did('buy bus');
      }
    } else if (k < 0.84) {
      op = 'recompose';
      // a train made up anew: its locomotive(s), 0-2 mail vans, coaches (or units), sometimes something odd
      const ts = g.vehicles.trains();
      if (ts.length) {
        const t = ts[r.int(ts.length)], made = t.madeUp, head = made.filter((c) => c.kind === 'loco' || c.kind === 'emu');
        const vans = availableModels(g.year, 'wagon', true), coaches = availableModels(g.year, 'wagon', false);
        const cars: VehicleModel[] = head[0]?.kind === 'emu' ? head.slice(0, 1 + r.int(2))
          : [...head.slice(0, 1), ...Array.from({ length: vans.length ? r.int(3) : 0 }, () => r.pick(vans)), ...Array.from({ length: coaches.length ? r.int(4) : 0 }, () => r.pick(coaches))];
        if (r.chance(0.1)) cars.reverse();
        if (!g.vehicles.recompose(t, cars)) did('recompose');
      }
    } else if (k < 0.89) {
      op = 'sell';
      const vs = g.vehicles.all();
      if (vs.length) { g.vehicles.sell(vs[r.int(vs.length)].id); did('sell'); }
    } else if (k < 0.92) {
      op = 'delete';
      if (r.chance(0.5)) { const ls = g.lines.all(); if (ls.length) { g.lines.delete(ls[r.int(ls.length)].id); did('delete line'); } }
      else { const sts = g.stations.all(); if (sts.length && !g.stations.removeStation(sts[r.int(sts.length)].id)) did('remove station'); }
    } else if (k < 0.935) {
      op = 'save/load';
      g = deserialize(JSON.parse(JSON.stringify(serialize(g))));
      did('save/load');
    } else if (k < 0.99) {
      op = 'tram';
      const kk = r.next();
      if (kk < 0.5) {
        // tracks along streets between two points of the town (sometimes a stop on them)
        const streets = g.towns.streets(town, 0);
        const ea = streets[r.int(Math.max(1, streets.length))], eb = streets[r.int(Math.max(1, streets.length))];
        const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
        if (ea && eb) { g.world.net.pointAt(ea, ea.len / 2, a); g.world.net.pointAt(eb, eb.len / 2, b); }
        const path = ea && eb ? roadPath(g, a.x, a.z, b.x, b.z, 80) : null;
        if (path && !addTramTracks(g, path, 0).error) did('tram tracks');
        if (path && r.chance(0.6)) {
          const pts = pathPoints(g, path);
          const q = pts[r.int(pts.length)];
          if (q && !g.stations.commitBusStop(q.x, q.z, 0)) did('tram stop');
        }
      } else if (kk < 0.7) {
        const mine = [...g.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === 0 && e.depot < 0);
        if (mine.length && !removeTramTracks(g, [mine[r.int(mine.length)].id], 0).error) did('remove tram tracks');
      } else {
        const mine = [...g.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === 0 && e.depot < 0);
        if (mine.length) {
          const pts = pathPoints(g, [mine[r.int(mine.length)].id]);
          if (pts.length > 6 && runGen(tramDepotGen(g, pts, [], 0)) >= 0) did('tram depot');
        }
      }
    } else if (k < 0.995) {
      op = 'save/load (tram)';
      g = deserialize(JSON.parse(JSON.stringify(serialize(g))));
      did('save/load');
    }
    for (let i = 0; i < 12; i++) g.update(0.25);
    const errs = invariants();
    if (errs.length) { errors++; console.log(`step ${step} (${op}): ${errs.slice(0, 5).join('; ')}`); if (errors > 8) break; }
  } catch (e) {
    errors++;
    console.log(`step ${step} (${op}) EXCEPTION`, (e as Error).stack?.split('\n').slice(0, 6).join('\n'));
    if (errors > 8) break;
  }
}
const states = new Map<string, number>();
for (const v of g.vehicles.all()) states.set(v.kind + ':' + v.state, (states.get(v.kind + ':' + v.state) ?? 0) + 1);
console.log(`seed ${seed}: ${STEPS} steps in ${fmt((performance.now() - T0) / 1000, 1)} s, day ${g.day}; ` + [...counts].map(([k2, v]) => `${k2} ${v}`).join(', '));
console.log(`  network ${g.world.net.edges.size} edges, ${g.world.net.crossings.size} crossings, ${g.stations.map.size} stations, ${g.lines.map.size} lines, ${g.vehicles.map.size} vehicles (${[...states].map(([k2, v]) => `${k2}=${v}`).join(' ')}), delivered ${g.vehicles.all().reduce((a, v) => a + v.delivered, 0)}`);
console.log(errors ? `\n${errors} STEPS WITH ERRORS` : '\nALL INVARIANTS HELD');
process.exitCode = errors ? 1 : 0;
