// Exact repeated access-road proposals reuse geometry, never a candidate's native acceptance decision.
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import type { Proposal } from '../src/game/construction';
import type { StationOpts } from '../src/game/stations';
import { flatGame, check, done } from './stationlib';
import { build, free, roadOpts, checkReservations } from './lib';

function need(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const g = Game.create({ size: 512, seed: 23, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
const saved = (game: Game) => JSON.stringify(serialize(game));
const start = saved(g), stations = g.stations as any, native = stations.planAccessStreet;
let repeats = 0, reused = true, isolated = true, accepted = 0;
const previous = new Map<string, Proposal>();
stations.planAccessStreet = function(...args: any[]) {
  const seen = new Map<string, Proposal>(), accept = args[8];
  args[8] = (proposal: Proposal) => {
    const key = JSON.stringify([proposal.tracks.map(t => [t.start, t.end]), proposal.opts]);
    const prior = seen.get(key);
    if (prior) { repeats++; reused &&= prior === proposal; }
    else { isolated &&= previous.get(key) !== proposal; seen.set(key, proposal); }
    // Preserve the real joint formation/demolition acceptance for every candidate, including repeats.
    const result = !accept || accept(proposal); accepted += +result;
    return result;
  };
  const result = native.apply(this, args);
  for (const [key, proposal] of seen) previous.set(key, proposal);
  return result;
};
// Original seed23 observer inputs from native days35/322, applied to the unchanged initial native map.
// These pure quote inputs do not claim to reproduce the historical day322 world or AI trajectory.
const angle = 3.0477939382275285;
const urban: StationOpts = { aiSurvey: true, trackType: 'electric', mode: 'lightrail', level: 'ground', depth: 2.2, height: 1.5 };
const inputs: [number, number, number, number, number, number, StationOpts?][] = [
  [438.9174070594199, 101.58002916464781, -.7072383124885793, 10, 2, 2],
  [295.1575156904732, 245.98170938313515, angle, 7, 2, 2, urban],
  [294.8765319927864, 248.9685217578307, angle, 7, 2, 2, urban],
  [295.29800753931653, 244.4883031957874, angle, 7, 2, 2, urban],
  [294.73604014394306, 250.46192794517845, angle, 7, 2, 2, urban],
  [297.358554655686, 222.58501244802028, angle, 7, 2, 2, urban],
  [297.4990465045294, 221.0916062606725, angle, 7, 2, 2, urban],
  [297.2180628068426, 224.07841863536805, angle, 7, 2, 2, urban],
];
const quotes = inputs.map(args => g.stations.planRail(...args));
const again = inputs.map(args => g.stations.planRail(...args));
check(repeats > 0, 'native access search actually revisits exact road snaps after the six-candidate cap');
check(reused, 'every repeated native snap uses the same full proposal within its synchronous access search');
check(isolated, 'separate native access searches never share mutable proposal objects');
check(accepted === 0 && quotes.some(p => !p.ok), 'repeated physical refusals still run every native combined formation acceptance');
check(JSON.stringify(quotes) === JSON.stringify(again), 'warm native full quotes, refusal errors and candidate choices remain byte-identical');
check(saved(g) === start, 'repeated native road/access/support quotes preserve the complete serialized world');
const clone = deserialize(JSON.parse(start)), cold = inputs.map(args => clone.stations.planRail(...args));
check(JSON.stringify(cold) === JSON.stringify(quotes) && saved(clone) === start, 'cold native full quotes and saved state match warm results exactly');

const f = flatGame(256); f.aiEnabled = false;
need(build(f, free(f, 20, 140), free(f, 220, 140), roadOpts(0, 'street'), 'native access street'), 'native funded public road');
const quote = () => f.stations.planRail(120, 128, Math.PI / 2, 10, 2, 0);
const plan = quote(); need(plan.ok && plan.access, plan.error ?? 'native payable station access');
const full = JSON.stringify(plan), state = saved(f);
plan.access.tracks[0].prof[0] += 10; plan.access.errors.push('caller mutation'); plan.access.demolish.push(-123);
check(JSON.stringify(quote()) === full && saved(f) === state, 'mutating a returned access proposal cannot corrupt a later native quote or saved world');
const valid = quote(); need(!f.stations.commitRail(valid, 0), 'native station and quoted access commit');
const replay = deserialize(serialize(f)); let exact = true;
for (let tick = 0; tick < 128; tick++) { f.stepTick(); replay.stepTick(); exact &&= saved(f) === saved(replay); }
check(exact && !checkReservations(f).length && !checkReservations(replay).length, 'native priced access construction continues with exact saved replay and legal reservations');
const out = process.argv.find(a => a.startsWith('--quotes='))?.slice('--quotes='.length);
if (out) writeFileSync(out, JSON.stringify({ quotes, flat: full }));
console.log('native repeated access observations', JSON.stringify({ repeats, accepted }));
done();
