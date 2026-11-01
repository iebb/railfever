// Access-street curve refusal may precede terrain work; passing surveys retain full construction checks.
import { planEdge, commitProposal, type Proposal } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { flatGame, check, done } from './stationlib';
import { build, free, roadOpts } from './lib';
import { terrainFit } from './terrainfit';

function need(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const snapshot = (g: ReturnType<typeof flatGame>) => JSON.stringify(serialize(g));
const g = flatGame(128); g.aiEnabled = false;
const start = free(g, 20, 30), end = free(g, 40, 30), opts = roadOpts(0, 'street');
const original = snapshot(g), literal = planEdge(g, start, end, opts);
need(literal.ok, literal.errors.join(', '));
let calls = 0;
const refused = planEdge(g, start, end, opts, curve => { calls++; return !(curve.x0 < 30 && curve.x3 > 30); });
check(calls === 1 && !refused.ok && !!commitProposal(g, refused) && snapshot(g) === original,
  'a street through the reserved station axis refuses before construction without spending or mutation');
let passedCurve = '';
const accepted = planEdge(g, start, end, opts, curve => { passedCurve = JSON.stringify(curve); return true; });
check(JSON.stringify(accepted) === JSON.stringify(literal) && passedCurve === JSON.stringify(literal.tracks[0].bez)
  && snapshot(g) === original, 'passing the final fitted road curve retains the complete native quote and query purity');

// An admitted curve is not permission to excavate a neighbouring road's supporting ground.
need(build(g, free(g, 15, 60), free(g, 110, 60), roadOpts(0, 'street'), 'retained street'), 'paid retained street');
const cutting = roadOpts(0, 'street', { heightOffset: -0.7 });
const unsupported = planEdge(g, free(g, 20, 61.3), free(g, 100, 61.3), cutting);
const guarded = planEdge(g, free(g, 20, 61.3), free(g, 100, 61.3), cutting, () => true);
check(!unsupported.ok && unsupported.errors.some(e => /another height/.test(e))
  && JSON.stringify(guarded) === JSON.stringify(unsupported), 'a passing curve still receives the complete native formation-support refusal');

// A lawful paid street lies left of the prospective platforms. A right-side forecourt cannot reach it
// through those platforms; the left-side forecourt has a short lawful connection.
const f = flatGame(128); f.aiEnabled = false;
need(build(f, free(f, 52, 20), free(f, 52, 108), roadOpts(0, 'street'), 'access target'), 'paid access target');
const station = f.stations.planRail(60, 60, 0, 10, 2, 0, { buildingSide: 1, style: 'none' });
need(station.ok, station.error ?? 'native prospective station');
const access = (fx: number): Proposal | null => (f.stations as any).planAccessStreet(fx, 60, station, 0);
const before = snapshot(f), blocked = access(68), allowed = access(56);
check(blocked === null && !!allowed?.ok && snapshot(f) === before,
  'native access rejects a platform crossing and quotes a clear alternative without changing the world');

// A custom terrain reader is observable. Its interior sample must still execute on the literal path,
// even though the native early curve predicate would discard this street.
const heightAt = f.world.heightAt;
let sawInterior = false;
f.world.heightAt = function(x, z) {
  if (x > 58 && x < 62) { sawInterior = true; throw new Error('interior terrain reader'); }
  return heightAt.call(this, x, z);
};
let message = '';
try { access(68); } catch (error) { message = (error as Error).message; }
finally { f.world.heightAt = heightAt; }
check(sawInterior && message === 'interior terrain reader' && snapshot(f) === before,
  'a custom terrain evaluator retains its literal interior reads and exception behavior');

need(allowed?.ok, 'lawful access quote');
const cash = f.economy.money;
need(!commitProposal(f, allowed), 'paid lawful access construction');
const fit = terrainFit(f);
check(f.economy.money === cash - allowed.cost && fit.covered === 0 && fit.floating === 0,
  'accepted access pays its quote and leaves all native road formations grounded');
const cold = deserialize(JSON.parse(snapshot(f)));
let exact = snapshot(f) === snapshot(cold);
for (let tick = 0; tick < 128; tick++) { f.stepTick(); cold.stepTick(); exact &&= snapshot(f) === snapshot(cold); }
check(exact, 'paid access construction resumes exactly from an independent cold save');
done();
