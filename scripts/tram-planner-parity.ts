// Compare a native project's unchanged-world route and spending with an unchanged ai-tram.ts oracle bundle.
// Bundle as tram-planner-parity.mjs; an optional --oracle=<module> exports Game, TramPlanner and serialize.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { TramPlanner } from '../src/game/ai-tram';
import { serialize, deserialize } from '../src/game/save';
export { Game, TramPlanner, serialize };

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  function build(C: typeof Game, P: typeof TramPlanner, encode: typeof serialize) {
    const g = C.create({ size: 384, seed: 11, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1965, aiCompanies: 1 });
    g.aiEnabled = false; g.company(1).economy.money = 20_000_000;
    const planner = new P(g, 1); assert(planner.start());
    let result = 'running', units = 0, maxMs = 0, quoteMs = 0;
    const actions: { unit: number; assets: string; money: number }[] = [];
    let assets = '';
    while (result === 'running' && units++ < 2000) {
      const stage = planner.record()?.continuation?.task?.stage;
      const start = performance.now(); result = planner.step(1); const ms = performance.now() - start;
      maxMs = Math.max(maxMs, ms); if (stage === 'quote') quoteMs = ms;
      const p = planner.project;
      const next = `${p?.edges.length},${p?.stations.length},${p?.stops.length},${p?.depot},${p?.line},${g.vehicles.map.size}`;
      if (next !== assets) { actions.push({ unit: units, assets: next, money: g.company(1).economy.money }); assets = next; }
    }
    assert.equal(result, 'done', planner.reason);
    return { text: JSON.stringify(encode(g)), units, maxMs, quoteMs, actions };
  }
  const current = build(Game, TramPlanner, serialize);
  const arg = process.argv.find(a => a.startsWith('--oracle='));
  if (arg) {
    const old = await import(pathToFileURL(arg.slice(9)).href), before = build(old.Game, old.TramPlanner, old.serialize);
    if (before.text !== current.text) {
      let i = 0; while (i < Math.min(before.text.length, current.text.length) && before.text[i] === current.text[i]) i++;
      throw new Error(`Native unchanged-world build differs at ${i}: ${current.text.slice(i - 60, i + 140)} / ${before.text.slice(i - 60, i + 140)}`);
    }
    console.log(`PASS exact unchanged-world native route, construction price, depot, fleet and saved world; work units ${before.units} -> ${current.units}`);
    console.log('Native work boundaries (track, stations, added stops, depot, line, vehicles):', JSON.stringify({ before: before.actions, current: current.actions }));
  }
  console.log(`Native project maximum unit ${current.maxMs.toFixed(2)}ms, fare forecast ${current.quoteMs.toFixed(2)}ms`);
  assert(current.maxMs < 30, 'native tram work remains below the 30ms slice limit');
  const fixture = process.argv.find(a => a.startsWith('--fixture='));
  if (fixture) {
    const g = deserialize(JSON.parse(readFileSync(fixture.slice(10), 'utf8'))); g.aiEnabled = false;
    const planner = new TramPlanner(g, 2); assert(planner.start(1), 'retained native Fairholm world can survey another tram project');
    let result = 'running', units = 0, maxMs = 0, quoteMs = -1;
    while (result === 'running' && units++ < 2000) {
      const stage = planner.record()?.continuation?.task?.stage;
      const start = performance.now(); result = planner.step(1); const ms = performance.now() - start;
      maxMs = Math.max(maxMs, ms); if (stage === 'quote') quoteMs = ms;
    }
    assert.notEqual(result, 'running', 'retained-world search finishes within its work budget');
    assert(quoteMs >= 0, 'retained-world timing includes its native economic forecast');
    assert(maxMs < 30, 'retained-world native tram work remains below the 30ms slice limit');
    console.log(`Retained world: ${result} in ${units} units; maximum ${maxMs.toFixed(2)}ms, fare forecast ${quoteMs.toFixed(2)}ms (${planner.reason || 'opened'})`);
  }
}
