// Small retained-curve relevel fixture. Bundle as native-relevel.mjs.
import { flatGame, check, done } from './stationlib';
import { bezLine, bezOffset, bezDeriv, type Bez } from '../src/game/geom';
import { planStationOnTrack, commitStationOnTrack, planRelevel, commitRelevel } from '../src/game/trackops';
import { stationPose } from '../src/game/station-geometry';
import { relevelBoundaryError } from '../src/game/station-relevel';
import { serialize, deserialize } from '../src/game/save';
import { checkReservations } from './lib';
const json = (g: ReturnType<typeof flatGame>) => JSON.stringify(serialize(g));
const curve: Bez = { x0: 70, z0: 70, x1: 70, z1: 100, x2: 100, z2: 130, x3: 130, z3: 130 };
function fixture(foreign = false) {
  const g = flatGame(256), net = g.world.net, rails = [];
  if (foreign) { g.addAICompany({ startMoney: 30e6 }); g.aiEnabled = false; }
  const owner = foreign ? g.ais[0].companyId : 0;
  for (let i = 0; i < 2; i++) {
    const c = bezOffset(curve, i * .5), ad = bezDeriv(c, 0), bd = bezDeriv(c, 1);
    const a = net.addNode('rail', c.x0, 3.1, c.z0, ad.x, ad.z, owner), b = net.addNode('rail', c.x3, 3.1, c.z3, bd.x, bd.z, owner);
    a.signal = 2; a.signalKind = 'block'; a.signalPass = true; b.signal = 1;
    rails.push(net.addEdge('rail', a.id, b.id, c, new Float32Array(100).fill(3.1), [], i ? 'standard' : 'electric', owner));
    for (const [n, ux, uz] of [[a, 0, -1], [b, 1, 0]] as const) {
      let prev = n;
      for (const length of [30, 8]) {
        const next = net.addNode('rail', prev.x + ux * length, 3.1, prev.z + uz * length, ux, uz, owner);
        net.addEdge('rail', prev.id, next.id, bezLine(prev.x, prev.z, next.x, next.z), new Float32Array(length + 1).fill(3.1), [], i ? 'standard' : 'electric', owner);
        prev = next;
      }
    }
  }
  const a = net.addNode('road', 70, 3, 115, 0, 0, -1), b = net.addNode('road', 104, 3, 144, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(46).fill(3), [], 'street', -1);
  const p = planStationOnTrack(g, rails[0].id, rails[0].len / 2, { length: 20, tracks: 2, reuseTrack: true, style: 'modern' }, owner);
  check(p.ok, 'native curved fixture station quote fits: ' + p.error);
  const built = commitStationOnTrack(g, p), st = g.stations.get(built.station)!;
  check(!built.error && !!st?.rail?.native, 'native curved station committed');
  return { g, st };
}
for (const level of ['elevated', 'underground', 'ground'] as const) {
  const { g, st } = fixture(), net = g.world.net, r = st.rail!, saved = json(g);
  const geometry = JSON.stringify(r.alignment!.tracks.map(t => ({ offset: t.offset, length: t.length, knots: t.knots, pieces: t.pieces.map(p => ({ curve: p.curve, length: p.length })) })));
  const groups = JSON.stringify(r.groups), ends = g.stations.trackEnds(st, true).map(t => ({ ...t }));
  const edges = new Map([...net.edges].map(([id, e]) => [id, JSON.stringify({ a: e.a, b: e.b, bez: e.bez, len: e.len, type: e.type, owner: e.owner, signal: [net.nodes.get(e.a)!.signal, net.nodes.get(e.b)!.signal] })]));
  const cash = g.economy.money, p = planRelevel(g, [r.edges[0]], level, 0);
  console.log('native level quote', level, JSON.stringify({ ok: p.ok, error: p.error, edges: p.edges.length, stations: p.stations.length, cost: p.cost, ramps: p.ramps }));
  check(json(g) === saved, 'native relevel quote is exactly pure: ' + level);
  check(p.ok && p.stations[0]?.plan.alignment?.tracks.length === 2, 'quote retains both curved physical tracks: ' + level);
  if (!p.ok) continue;
  check(!relevelBoundaryError(g, p), 'all quoted ends join unchanged outer profiles: ' + level);
  if (level !== 'ground') check(p.edges.length > r.edges.length, 'all double-track approaches are included and priced: ' + level);
  const busy = g.vehicles.isEdgeBusy.bind(g.vehicles), occupied = p.edges.find(e => !r.edges.includes(e.id))?.id;
  if (occupied !== undefined) {
    g.vehicles.isEdgeBusy = id => id === occupied || busy(id);
    check(commitRelevel(g, p, { waitForTrains: true }) === 'busy' && json(g) === saved, 'busy approach refuses without spending or edits: ' + level);
    g.vehicles.isEdgeBusy = busy;
  }
  check(!commitRelevel(g, p, { waitForTrains: true }), 'native curved level change commits: ' + level);
  check(Math.abs(cash - g.economy.money - p.cost) < .01, 'payer spends the complete native facility and structure quote: ' + level);
  check(r.native && r.level === level && JSON.stringify(r.groups) === groups && JSON.stringify(g.stations.trackEnds(st, true)) === JSON.stringify(ends), 'group identity and endpoints preserved: ' + level);
  check(JSON.stringify(r.alignment!.tracks.map(t => ({ offset: t.offset, length: t.length, knots: t.knots, pieces: t.pieces.map(p => ({ curve: p.curve, length: p.length })) }))) === geometry, 'exact curved XY and unequal arc lengths survive: ' + level);
  check([...edges].every(([id, data]) => { const e = net.edges.get(id)!; return JSON.stringify({ a: e.a, b: e.b, bez: e.bez, len: e.len, type: e.type, owner: e.owner, signal: [net.nodes.get(e.a)!.signal, net.nodes.get(e.b)!.signal] }) === data; }), 'all rail owners, wires, geometry, nodes and signals retained: ' + level);
  check(r.alignment!.tracks.every(t => t.pieces.every(p => p.profile.every(y => y === r.y))), 'saved alignment is at the actual new platform height: ' + level);
  const pose = stationPose(r, r.trackOffsets[0], r.length / 2);
  check(Math.abs(pose.y - r.y) < .001 && (level === 'ground' || r.entrances.length > 0), 'curved platform surfaces and real level entrances agree: ' + level);
  const loaded = deserialize(JSON.parse(json(g))); check(json(loaded) === json(g), 'native level change round-trips exactly: ' + level);
  for (let t = 0; t < 32; t++) { g.stepTick(); loaded.stepTick(); }
  check(json(g) === json(loaded) && !checkReservations(g).length, '32 actual ticks replay and reservations remain lawful: ' + level);
  const physical = new Map([...net.edges].map(([id, e]) => [id, JSON.stringify({ ...e, station: -1, version: 0 })]));
  check(!g.stations.removeStation(st.id) && [...physical].every(([id, data]) => JSON.stringify({ ...net.edges.get(id), station: -1, version: 0 }) === data), 'removing facility leaves paid relevelled running rail in place: ' + level);
}
{
  const { g, st } = fixture(), net = g.world.net, end = g.stations.trackEnds(st)[0].front, n = net.nodes.get(end)!;
  const other = net.addNode('rail', n.x + 10, n.y, n.z + 8, 1, 1, 0);
  net.addEdge('rail', n.id, other.id, bezLine(n.x, n.z, other.x, other.z), new Float32Array(15).fill(n.y), [], 'electric', 0);
  const before = json(g), p = planRelevel(g, st.rail!.edges, 'underground', 0);
  check(!p.ok && /approach ramps|connecting tracks/.test(p.error ?? '') && json(g) === before, 'unselected junction arm rejects missing ramps before edits');
}
{
  const { g, st } = fixture(), p = planRelevel(g, st.rail!.edges, 'elevated', 0);
  const own = new Set(st.rail!.edges), stripped = { ...p, edges: p.edges.filter(e => own.has(e.id)) };
  check(!!relevelBoundaryError(g, stripped), 'outside old profile cannot be overridden by a moved platform node');
}
{
  const { g, st } = fixture(), net = g.world.net, first = planRelevel(g, st.rail!.edges, 'elevated', 0);
  const changed = first.edges.find(p => !st.rail!.edges.includes(p.id))!, e = net.edges.get(changed.id)!;
  const s = e.len * .4, point = { x: 0, y: 0, z: 0 }, tangent = { x: 0, y: 0, z: 0 }; net.pointAt(e, s, point, tangent);
  const index = Math.floor(s), f = s - index, y = changed.prof[index] * (1 - f) + changed.prof[index + 1] * f + .25;
  const norm = Math.hypot(tangent.x, tangent.z), ux = -tangent.z / norm, uz = tangent.x / norm;
  const a = net.addNode('road', point.x - ux * 3, y, point.z - uz * 3, ux, uz, -1), b = net.addNode('road', point.x + ux * 3, y, point.z + uz * 3, ux, uz, -1);
  net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(7).fill(y), [{ s0: 0, s1: 6, type: 'bridge' }], 'street', -1);
  const before = json(g), p = planRelevel(g, st.rail!.edges, 'elevated', 0);
  check(!net.crossings.size && !p.ok && /crosses at the new height/.test(p.error ?? '') && json(g) === before,
    'a formerly separated overpass along an added ramp is checked without a crossing record');
}
{
  const g = flatGame(256), net = g.world.net;
  const edge = (x0: number, z0: number, x1: number, z1: number) => {
    const a = net.addNode('rail', x0, 3.1, z0, x1 - x0, z1 - z0, 0), b = net.addNode('rail', x1, 3.1, z1, x1 - x0, z1 - z0, 0);
    return net.addEdge('rail', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(61).fill(3.1), [], 'electric', 0);
  };
  const a = edge(70, 100, 130, 100), b = edge(100, 70, 100, 130), id = net.nextCrossing++;
  net.crossings.set(id, { id, kind: 'diamond', e1: a.id, s1: 30, e2: b.id, s2: 30, x: 100, z: 100 });
  const p = planRelevel(g, [a.id, b.id], 'elevated', 0);
  check(p.ok && !p.crossings.includes(id) && !commitRelevel(g, p) && net.crossings.has(id), 'both raised diamond rails keep the native reserved crossing');
}
{
  const { g, st } = fixture(true), owner = st.owner, net = g.world.net;
  const owners = new Map([...net.edges].map(([id, e]) => [id, e.owner]));
  const beforeOwner = g.company(owner).economy.money, beforePlayer = g.economy.money;
  const quote = planRelevel(g, [st.rail!.edges[0]], 'elevated', 0);
  check(quote.ok, 'player may quote a permitted foreign retained curved station: ' + quote.error);
  if (quote.ok) {
    check(!commitRelevel(g, quote), 'player-paid foreign native level change commits');
    check(st.owner === owner && [...owners].every(([id, who]) => net.edges.get(id)?.owner === who), 'foreign native facility and every physical rail retain ownership');
    check(g.company(owner).economy.money === beforeOwner && beforePlayer - g.economy.money === quote.cost, 'player alone pays the complete curved foreign station and approach quote');
    check(json(deserialize(serialize(g))) === json(g), 'foreign native level change saves exactly');
  }
}
done();
