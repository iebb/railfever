// Bidirectional single track must reserve across a diamond to its next passing place.
import { autoSignalLine, setSignal } from '../src/game/signals';
import { connectStationThroat } from '../src/game/trackops';
import { Train, deadlockCycles, makeSeg, CROSS_BASE } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { checkReservations, fails } from './lib';
import { flatGame, station, endNode, build, railOpts, nodeSnap, free, loco, depotFor, check, done } from './stationlib';

function fixture() {
  const g = flatGame(256); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  g.addAICompany({ startMoney: 50_000_000 });
  const A = station(g, 20, 128, Math.PI / 2, 12, 2)!;
  const B = station(g, 236, 128, Math.PI / 2, 12, 2)!;
  if (!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
    nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts())) throw new Error('main track');
  for (const st of [A, B]) connectStationThroat(g, st.id, 0);
  const before = g.world.net.nextEdge;
  if (!build(g, free(g, 128, 32), free(g, 128, 224), railOpts(1, 1, { crossing: 'level' }))) throw new Error('crossing track');
  const crossTrack = [...g.world.net.edges.values()].find(e => e.id >= before && e.owner === 1)!;
  // A rival's manually placed signal is outside the line's signalling authority.
  if (setSignal(g, crossTrack.id, 20, 'oneway', true, 1, { pass: true })) throw new Error('rival signal');
  const foreign = () => JSON.stringify([...g.world.net.nodes.values()].filter(n => n.owner === 1 && n.signal));
  const foreignBefore = foreign(), depots = [depotFor(g, A, B), depotFor(g, B, A)];
  const l = g.lines.create('rail', 0); l.stops = [A.id, B.id]; g.lines.rebuild();
  return { g, A, B, l, depots, foreign, foreignBefore };
}

for (const removed of [false, true]) {
  const f = fixture(), { g, l } = f, net = g.world.net;
  const label = removed ? 'removed diamond' : 'live diamond';
  check([...net.crossings.values()].some(c => c.kind === 'diamond'), `${label}: native crossing exists before signalling`);
  const plan = autoSignalLine(g, l.id, 0);
  check(plan.signals.filter(s => s.role === 'starter').length >= 4,
    `${label}: normal platform starters remain protected`);
  check(plan.signals.every(s => s.role !== 'approach'), `${label}: single section has no interior approach boundary`);
  check(f.foreign() === f.foreignBefore, `${label}: rival manual signals remain unchanged`);
  if (removed) {
    // Removing the crossing railway must not leave newly generated holding boundaries on the main.
    for (const e of [...net.edges.values()]) if (e.owner === 1) net.removeEdge(e.id);
    g.onNetworkChanged(); autoSignalLine(g, l.id, 0);
    check(!net.crossings.size, 'removed diamond: crossing and its conflict resources are gone');
  } else {
    check([...net.crossings.values()].every(c => c.kind !== 'diamond'
      || [c.e1, c.e2].every(id => makeSeg(g, net.edges.get(id)!, 1).res.includes(CROSS_BASE + c.id))),
    'live diamond: both movements retain every shared crossing resource');
  }
  const trains = f.depots.map(d => g.vehicles.buyTrain(d, loco(), l.id) as Train);
  trains[1].stopIndex = 1;
  const calls = trains.map(() => new Set<number>()), previous = new Map<number, string>();
  let cycles = 0, reservations = true, replayed = false, exact = true;
  for (let tick = 0; tick < 360 * g.ticksPerDay; tick++) {
    g.stepTick();
    for (const [i, t] of trains.entries()) {
      if (t.state === 'loading' && previous.get(t.id) !== 'loading') calls[i].add(t.atStation);
      previous.set(t.id, t.state);
    }
    if (g.tick % g.ticksPerDay === 0) {
      cycles += deadlockCycles(g, 20).length;
      reservations &&= checkReservations(g).length === 0;
    }
    if (!replayed && g.day >= 60 && trains.some(t => t.state === 'waiting')) {
      const h = deserialize(JSON.parse(JSON.stringify(serialize(g))));
      for (let k = 0; k < 80; k++) {
        g.stepTick(); h.stepTick();
        exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(h));
      }
      replayed = true;
    }
  }
  console.log(`${label}: calls ${calls.map(c => [...c].join('/')).join(', ')}, cycle samples ${cycles}`);
  check(calls.every(c => c.has(f.A.id) && c.has(f.B.id)), `${label}: both native opposing trains call at both termini`);
  check(cycles === 0, `${label}: opposing trains never enter a mutual reservation cycle`);
  check(reservations, `${label}: reservation ownership remains consistent`);
  check(replayed && exact, `${label}: a saved physical queue replays every fixed tick exactly`);
}

{
  const f = fixture(), { g, l } = f, net = g.world.net;
  const crossing = [...net.crossings.values()].find(c => c.kind === 'diamond')!;
  const main = net.edges.get(crossing.e1)!.owner === 0 ? net.edges.get(crossing.e1)! : net.edges.get(crossing.e2)!;
  check(setSignal(g, main.id, 20, 'oneway', true, 0) === null, 'directional diamond: native one-way running direction established');
  const plan = autoSignalLine(g, l.id, 0);
  check(plan.signals.some(s => s.role === 'approach' && !s.pass), 'directional diamond: legal facing approach remains');
  check([...net.crossings.values()].every(c => [c.e1, c.e2].every(id => makeSeg(g, net.edges.get(id)!, 1).res.includes(CROSS_BASE + c.id))),
    'directional diamond: approach signals retain crossing conflict resources');
  check(f.foreign() === f.foreignBefore, 'directional diamond: foreign manual signal is preserved');
  check(checkReservations(g).length === 0, 'directional diamond: automatic signalling leaves reservations consistent');
}

if (!fails.length) console.log('bidirectional and directional diamond signalling checked');
done();
