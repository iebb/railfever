// Focused city discovery and native connected growth checks. Bundle as city-expansion.mjs.
import { flat, newTown, district, cityLine, linePath, M } from './linegrow-fixtures';
import { growLine, growTask, cityStationRadius, type GrowHost, type GrowCursor, type GrowOption } from '../src/game/ai-grow';
import { urbanDistricts } from '../src/game/ai-urban';
import { Train, depotReaches } from '../src/game/train';
import { replaceLineStops } from '../src/game/line-edit';
import { linePatterns } from '../src/game/patterns';
import { railPartMode } from '../src/game/stations';
import { walkingCatchment } from '../src/game/catchment';
import { serialize, deserialize } from '../src/game/save';
import { demolitionCost } from '../src/game/demolition';
import { check, fails, checkReservations } from './lib';
import type { Game } from '../src/game/game';
import type { AIController } from '../src/game/ai';
function host(g: Game, ai: AIController): GrowHost {
  const me = ai.companyId, eco = g.company(me).economy;
  return { g, ai, me, note: s => ai.log.push(s), news() {}, considered() {}, succeed() {}, cared: () => false, careFor() {},
    stat: (k, n = 1) => { (ai.stats as any)[k] = ((ai.stats as any)[k] ?? 0) + n; },
    canSpend: cost => { while (eco.money < cost + 300_000 && eco.borrow()) {} return eco.money >= cost; },
    affordable: cost => cost <= ai.available(), managed: () => (ai as any).lines,
    fleet: l => ({ ours: l.vehicles.filter(id => g.vehicles.get(id)?.owner === me), others: l.vehicles.filter(id => g.vehicles.get(id)?.owner !== me).length }),
    setStops: (l, stops) => replaceLineStops(g, l, stops), signal: () => 0, canon() {}, mayAlter: () => true, consent: () => true, demolitionOk: () => true,
    compensate: (ids, residents) => { for (const cost of residents?.map(b => b.cost) ?? ids.flatMap(id => { const b = g.world.buildings.get(id); return b ? [demolitionCost(g, b)] : []; })) eco.spend(cost, 'construction', true); },
    localOnly: (l, sid) => { for (const p of linePatterns(l)) if (p.kind !== 'local') l.stops.forEach((s, i) => { if (s === sid) p.stops[i] = false; }); },
  };
}
type Item = { ids: number[]; grow?: GrowCursor };
function step(h: GrowHost, item: Item) { const gen = growTask(h, item); while (!gen.next().done) {} }
function finish(h: GrowHost, item: Item) { for (let i = 0; item.grow && i < 40; i++) step(h, item); check(!item.grow, 'bounded growth work finishes'); }
const saved = (g: Game) => JSON.stringify(serialize(g));
function differences(a: any, b: any, path = ''): any[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [{ path, a, b }];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => differences(a[k], b[k], path + '/' + k));
}
function fixture(model = 'lrv_b', pop = 40000) {
  const { g, ai, me } = flat(), town = newTown(g, 'District City', 220, 256);
  for (const company of g.companies) company.hqTown = town.id;
  district(g, town, 145, 217, 256, 64, pop);
  const { line, sts, depot } = cityLine(g, me, [160, 200], 256, 'west', 'tail', 0);
  // The station styles are metadata on the same native wired geometry and platforms.
  for (const st of sts) { st.rail!.mode = 'mainline'; st.rail!.trackType = 'electric'; }
  for (let i = 0; i < 3; i++) check(g.vehicles.buyTrain(depot, [M(model)], line.id) instanceof Train, 'actual city-compatible unit purchased');
  (ai as any).adoptLines(); g.onNetworkChanged(); g.lines.rebuild();
  district(g, town, 270, 350, 256, 64, pop);
  for (let i = 0; i < 2; i++) g.stepTick();
  return { g, ai, me, town, line, sts, depot, h: host(g, ai) };
}

{
  const f = fixture(), { g, h, line, sts, town } = f;
  check(!!growLine(h, line), 'wired mainline with actual city passenger units is eligible');
  const covered = new Set(sts.flatMap(s => [...walkingCatchment(g, s).buildings.keys()])), before = saved(g);
  const targets = urbanDistricts(g, town.id, 203.5, 256, 1, 0, 18, 7, cityStationRadius(g, 203.5, 256, 'lightrail'), covered);
  check(targets.some(t => t.gap > 45 && t.pop > 0), 'occupied district is found beyond an empty opening station');
  check(saved(g) === before, 'district geometry probes are pure');
  check(urbanDistricts(g, town.id, 203.5, 256, 1, 0, 18, 7, cityStationRadius(g, 203.5, 256, 'lightrail'), town.buildings).length === 0,
    'already reached buildings do not create district targets');
  const item: Item = { ids: [line.id], grow: { at: 0 } }; step(h, item);
  console.log('discovered', JSON.stringify(item.grow?.opts));
  check(item.grow?.opts?.some(o => o.kind === 'ext' && (o.gap ?? 0) > 45), 'saved native survey retains the distant district continuation');
  check(['ground', 'elevated', 'underground'].every(level => item.grow?.opts?.some(o => o.level === level)), 'ground terminus quotes all native levels');
  check(item.grow?.opts?.filter(o => o.kind === 'ext').every(o => o.mode === 'lightrail'), 'new parts use actual light-rail half reach');
  finish(h, item);
  console.log('native automatic growth', JSON.stringify({ path: linePath(line), log: f.ai.log.slice(-3) }));
  check(linePath(line).length > 2 && g.lines.map.size === 1, 'native economics builds a continuation of the same company line');
  check(sts.every(s => railPartMode(s.rail!) === 'mainline'), 'existing mainline station parts retain their styles');
  check(linePath(line).slice(2).every(id => railPartMode(g.stations.get(id)!.rail!) === 'lightrail'), 'built city parts retain the quoted style');
  check(linePath(line).every(id => depotReaches(g, g.depots.get(f.depot)!, id, [M('lrv_b')])), 'actual own depot serves every changed call');
  const loaded = deserialize(JSON.parse(saved(g))); check(saved(loaded) === saved(g), 'connected city growth saves exactly');
  if (saved(loaded) !== saved(g)) console.log('save fields differing', JSON.stringify(differences(serialize(g), serialize(loaded)).slice(0, 12)));
  for (let t = 0; t < 32; t++) { g.stepTick(); loaded.stepTick(); }
  check(saved(loaded) === saved(g) && !checkReservations(g).length, '32 actual operation ticks replay with lawful reservations');
}

for (const level of ['elevated', 'underground'] as const) {
  const f = fixture(level === 'underground' ? 'metro_a' : 'lrv_b', 70000), { g, line, h, sts } = f;
  const option: GrowOption = { kind: 'ext', end: 1, n: 1, turn: .2, level, mode: level === 'underground' ? 'metro' : 'lightrail', gap: 76, pop: 70000 };
  const item: Item = { ids: [line.id], grow: { at: 1, opts: [option] } }, eco = g.company(f.me).economy;
  const construction = eco.thisYear.construction;
  step(h, item); console.log('mixed-level valuation', level, item.grow?.best);
  check(!!item.grow?.best && !item.grow.best.fleet, 'native higher-level marginal receipts repay full capital: ' + level);
  // Resume midway through actual construction with the saved cursor, not a fresh search.
  step(h, item);
  const loaded = deserialize(JSON.parse(saved(g))), cloneItem: Item = JSON.parse(JSON.stringify(item));
  const cloneHost = host(loaded, loaded.aiOf(f.me)!);
  finish(h, item); finish(cloneHost, cloneItem);
  console.log('native mixed-level growth', level, JSON.stringify({ path: linePath(line), log: f.ai.log.slice(-2), spent: construction - eco.thisYear.construction }));
  check(linePath(line).length === 3 && g.lines.map.size === 1, 'paid mixed-level native continuation completes: ' + level);
  const last = g.stations.get(linePath(line).at(-1)!)!;
  check(last.rail?.level === level && railPartMode(last.rail!) === option.mode && sts.every(s => s.rail!.level === 'ground'), 'old and new parts keep their actual levels/styles: ' + level);
  check(construction - eco.thisYear.construction > 0, 'mixed-level works pay native construction costs: ' + level);
  check(saved(loaded) === saved(g), 'saved mixed-level construction resumes exactly: ' + level);
  if (saved(loaded) !== saved(g)) console.log('construction fields differing', level, JSON.stringify(differences(serialize(g), serialize(loaded)).slice(0, 12)));
}

{
  const f = fixture('lrv_b', 1), before = f.line.stops.join(), cash = f.g.company(f.me).economy.money;
  finish(f.h, { ids: [f.line.id], grow: { at: 1, opts: [{ kind: 'ext', end: 1, n: 1, turn: 0, mode: 'lightrail', level: 'elevated', gap: 100, pop: 1 }] } });
  check(f.line.stops.join() === before && f.g.company(f.me).economy.money === cash, 'unpaid district does not build or borrow');
}

{
  const f = fixture(), ai = f.ai as any;
  replaceLineStops(f.g, f.line, [f.sts[0].id, f.sts[1].id]);
  f.sts[1].townId = -1; f.g.lines.rebuild();
  for (const count of [3, 4, 5]) for (const mode of ['metro', 'lightrail']) {
    const layout = ai.urbanLayout(f.town, mode, undefined, count, 7);
    const t = layout.targets[0], x = layout.x + Math.sin(layout.angle) * t, z = layout.z + Math.cos(layout.angle) * t;
    check(layout.interchanges.some((s: any) => s.id === f.sts[0].id) && Math.hypot(x - f.sts[0].x, z - f.sts[0].z) <= 5.01,
      'single own served hub anchors the actual opening stage: ' + mode + '/' + count);
  }
}
console.log(fails.length ? `${fails.length} CHECKS FAILED` : 'ALL CITY EXPANSION CHECKS PASSED'); process.exitCode = fails.length ? 1 : 0;
