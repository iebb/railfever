// Signal semantics: placing and cycling signals on plain track, one-way signals blocking routes in one
// direction, and no capture of a neighbouring parallel track's signal.
// npx esbuild scripts/signals.ts --bundle --platform=node --format=esm --outfile=$S/signals.mjs && node $S/signals.mjs
import { Game } from '../src/game/game';
import { toggleSignal } from '../src/game/build-ops';
import { railNext } from '../src/game/train';
import { fails, check, build, free, railOpts } from './lib';

const g = Game.create({ size: 192, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
g.economy.money = 1e8;
const net = g.world.net;
// a straight double track (two parallel edges 0.45 apart) through open land
const p = build(g, free(g, 40, 90), free(g, 150, 90), railOpts(0, 2), 'double track');
check(p && p.tracks.length === 2, 'double track built');
const [t0, t1] = [...net.edges.values()].filter((e) => e.kind === 'rail');
// a signal in the middle of the first track
const mid = (e: typeof t0) => { const q = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, q); return q; };
const m0 = mid(t0), m1 = mid(t1);
check(!toggleSignal(g, m0.x, m0.z, 0), 'signal placed');
const s0 = net.nearestNode(m0.x, m0.z, 0.3, 'rail', (n) => n.signal > 0);
check(s0 && s0.signal === 1 && s0.edges.length === 2, 'two-way signal on a node splitting the track');
// clicking the parallel track must place a new signal there, not cycle the neighbour's
check(!toggleSignal(g, m1.x, m1.z, 0), 'second signal placed');
check(s0!.signal === 1, 'neighbouring signal untouched');
const s1 = net.nearestNode(m1.x, m1.z, 0.3, 'rail', (n) => n.signal > 0 && n.id !== s0!.id);
check(!!s1, 'signal on the parallel track');
// cycling: 1 (two-way) -> 2 -> 3 -> 0
const cyc: number[] = [];
for (let i = 0; i < 4; i++) { toggleSignal(g, s0!.x, s0!.z, 0); cyc.push(s0!.signal); }
check(cyc.join(',') === '2,3,0,1', `signal cycles 2,3,0,1 (got ${cyc.join(',')})`);
// one-way: trains may pass in one direction only
const [ea, eb] = s0!.edges.map((id) => net.edges.get(id)!);
const passes = (from: typeof ea, to: typeof eb) => {
  const dir = from.b === s0!.id ? 1 : -1; // travel towards the signal node
  return railNext(g, from, dir, 0).some((c) => c.edge.id === to.id);
};
s0!.signal = 2;
const ab = passes(ea, eb), ba = passes(eb, ea);
check(ab !== ba, `one-way signal lets trains pass in exactly one direction (${ab}/${ba})`);
s0!.signal = 3;
check(passes(ea, eb) === ba && passes(eb, ea) === ab, 'the other one-way setting reverses it');
s0!.signal = 1;
check(passes(ea, eb) && passes(eb, ea), 'two-way signal lets trains pass both ways');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
