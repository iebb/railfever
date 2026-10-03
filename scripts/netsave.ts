// Exact save replay during budgeted network work, with real fixed-step AI games.
// Bundle as netsave.mjs; optional args: seeds (default 5,7,23), years, size, AI count.
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { networkPlanner, networkProfile, runNetworkTask, saveNetwork } from '../src/game/ai-network';

const seeds = (process.argv[2] ?? '5,7,23').split(',').map(Number);
const years = Number(process.argv[3] ?? 2), size = Number(process.argv[4] ?? 512), count = Number(process.argv[5] ?? 3);
let failures = 0;
for (const seed of seeds) {
  const g = Game.create({ size, seed, towns: Math.round(size / 42), hilliness: 'hilly', water: 'medium', startYear: 1985,
    aiConfigs: Array.from({ length: count }, () => ({ focus: { rail: 1.5, road: 1.5, tram: 0.8 } })) });
  g.aiAcquisitions = false;
  const replays: { g: Game; at: number; end: number; mid: boolean }[] = [];
  const open = new Map<number, { task: string; day: number }>(), lengths: Record<string, number[]> = {};
  const units: Record<string, number> = {};
  let nextSave = 37, lastDay = -1, days = 0, flight = 0, saves = 0, matched = 0, midSaves = 0, maxBytes = 0, deliberate = false;
  const end = years * 360;
  while (g.day < end || replays.length) {
    const before = Object.fromEntries(Object.entries(networkProfile.tasks).map(([k, p]) => [k, p.steps]));
    g.stepTick();
    if (g.day <= end) for (const [k, p] of Object.entries(networkProfile.tasks)) units[k] = (units[k] ?? 0) + p.steps - (before[k] ?? 0);
    for (let i = replays.length - 1; i >= 0; i--) {
      const r = replays[i];
      r.g.stepTick();
      if (g.tick !== r.g.tick) throw new Error('lockstep tick mismatch');
      if (g.day >= r.end) {
        const a = serialize(g), b = serialize(r.g);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
          console.error(`FAIL seed ${seed}, saved day ${r.at}${r.mid ? ' mid-job' : ''}: after 120 days keys ${keys.join(', ')} differ`);
          if (keys.includes('ais')) {
            const x = JSON.stringify(a.ais), y = JSON.stringify(b.ais);
            let at = 0; while (x[at] === y[at]) at++;
            console.error('  AI difference', x.slice(Math.max(0, at - 90), at + 180), 'vs', y.slice(Math.max(0, at - 90), at + 180));
          }
          const x = JSON.stringify(a.aiNetwork), y = JSON.stringify(b.aiNetwork);
          if (x !== y) { let at = 0; while (x[at] === y[at]) at++; console.error('  network difference', x.slice(Math.max(0, at - 90), at + 180), 'vs', y.slice(Math.max(0, at - 90), at + 180)); }
          failures++;
        } else matched++;
        replays.splice(i, 1);
      }
    }
    if (g.day === lastDay) continue;
    lastDay = g.day;
    if (g.day <= end) {
      days++;
      let any = false;
      for (const ai of g.ais) {
        const task = networkPlanner(ai)?.task ?? null, old = open.get(ai.companyId);
        any ||= !!task;
        if (old && old.task !== task) { (lengths[old.task] ??= []).push(g.day - old.day); open.delete(ai.companyId); }
        if (task && !open.has(ai.companyId)) open.set(ai.companyId, { task, day: g.day });
      }
      if (any) flight++;
    }
    // Companies can plan projects back to back for most of a run, and a save while a project is under way cannot
    // replay exactly (loading abandons it). From day 200 until the deliberate mid-job save, hold off new projects
    // here and in every snapshot still being compared: the same input at the same tick, so replays stay exact.
    if (!deliberate && g.day >= 200 && g.day < end) for (const game of [g, ...replays.map((r) => r.g)]) for (const ai of game.ais) ai.state.cooldown = Math.max(ai.state.cooldown, 2);
    if (g.day >= end || g.ais.some((a) => a.busy)) continue;
    // Deliberately save a prepared job even if all the natural jobs so far fitted in one daily call.
    let forcedSave = false;
    if (!deliberate && g.day >= 200 && !g.ais.some((a) => networkPlanner(a)?.task)) {
      runNetworkTask(g.ais[0], 'decommission', 1);
      // Earlier snapshots see the same deliberate input while they are still being compared.
      for (const r of replays) runNetworkTask(r.g.ais[0], 'decommission', 1);
      deliberate = true; forcedSave = true;
    }
    const mid = g.ais.some((a) => !!networkPlanner(a)?.task);
    if (g.day < nextSave && !forcedSave && !(mid && midSaves === 0)) continue;
    const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
    if (JSON.stringify(serialize(loaded)) !== data) { console.error(`FAIL seed ${seed} immediate round trip on day ${g.day}`); failures++; }
    replays.push({ g: loaded, at: g.day, end: g.day + 120, mid });
    saves++; if (mid) midSaves++;
    maxBytes = Math.max(maxBytes, JSON.stringify(saveNetwork(g)).length);
    if (g.day >= nextSave) nextSave = (Math.floor(g.day / 37) + 1) * 37;
  }
  for (const o of open.values()) (lengths[o.task] ??= []).push(end + 1 - o.day);
  const distribution = (a: number[]) => {
    const hist = new Map<number, number>(); for (const d of a) hist.set(d, (hist.get(d) ?? 0) + 1);
    return [...hist].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}d:${n}`).join('/');
  };
  const total = Object.values(units).reduce((a, b) => a + b, 0);
  console.log(`seed ${seed}: ${matched}/${saves} exact 120-day replays, ${midSaves} mid-job; in flight ${flight}/${days} days (${(100 * flight / days).toFixed(1)}%); planner state max ${maxBytes} bytes`);
  console.log(`  in-flight job lengths: ${Object.entries(lengths).sort().map(([t, a]) => `${t} [${distribution(a)}]`).join('; ') || 'all jobs finished within a daily call'}`);
  console.log(`  work units: ${Object.entries(units).sort().map(([t, n]) => `${t} ${n} (${(100 * n / total).toFixed(1)}%)`).join(', ')}`);
  if (!midSaves) { console.error(`FAIL seed ${seed}: no mid-job save was checked`); failures++; }
}
console.log(failures ? `${failures} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
