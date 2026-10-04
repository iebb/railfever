// Mail demand map: bounded tonnes, zero carried without vans, service growth, pure reads, version caching,
// and the real MapModes update/toggle paths with a headless overlay (no browser or renderer needed).
// Bundle as mailview.mjs with esbuild --bundle --platform=node --format=esm, then run with node.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { mailView, type MailView } from '../src/game/mail-view';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { MapModes, servedColor, servedDash } from '../src/ui/mapmodes';
import type { Arc, ShareRing } from '../src/render/overlay';
import { fails, check, fmt, placeAndConnect, depotBehind, Train } from './lib';

if (!process.argv[1]?.endsWith('mailview.mjs')) throw new Error('bundle this test as mailview.mjs');
const M = (id: string) => MODEL_BY_ID.get(id)!;
const runDays = (g: Game, days: number) => { for (let d = 0; d < days; d++) for (let k = 0; k < TICKS_PER_DAY; k++) g.stepTick(); };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));

function bounded(v: MailView, label: string) {
  const valid = (p: { potential: number; carried: number; share: number }) =>
    Number.isFinite(p.potential) && Number.isFinite(p.carried) && Number.isFinite(p.share) &&
    p.potential >= 0 && p.carried >= 0 && p.carried <= p.potential + 1e-9 && p.share >= 0 && p.share <= 1 &&
    close(p.share, p.potential > 0 ? p.carried / p.potential : 0);
  check(v.towns.every(valid) && v.pairs.every(valid) && v.carried <= v.potential + 1e-9, `${label}: carried <= potential and shares in 0..1`);
  // (a town's carried mail also counts mail for towns beyond its lines, handed over where they end: MAIL_CAPTURE)
  check(close(v.potential, v.pairs.reduce((n, p) => n + p.potential, 0)) && v.pairs.reduce((n, p) => n + p.carried, 0) <= v.carried + 1e-9, `${label}: pairs count both directions once, carrying at most what the towns send`);
  check(close(v.potential, v.towns.reduce((n, t) => n + t.potential, 0)) && close(v.carried, v.towns.reduce((n, t) => n + t.carried, 0)), `${label}: outgoing town totals match the network`);
}

function footprint(g: Game) {
  return JSON.stringify({
    save: serialize(g), rng: g.rng.state, mail: g.mail.toJSON(),
    versions: [g.networkVersion, g.lines.version, g.demand.version, g.stations.catchVersion, g.stations.walkVersion],
    catchmentDirty: g.lines.catchmentDirty,
    routing: [...g.lines.mailRouting].map(([id, table]) => [id, [...table]]),
    terrain: [...g.world.dirtyTerrain], objects: [...g.world.dirtyObj],
  });
}

// Disabled reads do not even inspect the game, including before the first enabled query.
let touched = 0;
const unreadable = new Proxy({} as Game, { get() { touched++; throw new Error('disabled mail view read game data'); } });
for (let i = 0; i < 300; i++) check(mailView(unreadable, false) === null, 'disabled provider returns null');
check(touched === 0, 'no game reads or data work while disabled');

const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
g.economy.money = 1e9;
const virginBefore = footprint(g), virgin = mailView(g);
check(virgin.potential > 0 && virgin.pairs.length > 0 && virgin.towns.every((t) => t.potential > 0), 'towns without stations still show potential mail');
check(virgin.carried === 0 && virgin.towns.every((t) => t.share === 0) && virgin.pairs.every((p) => p.share === 0), 'empty network: exactly 0% carried');
check(footprint(g) === virginBefore && g.mail.toJSON() === null && g.towns.list.every((t) => !t.mail), 'view reads create no mail state and consume no randomness');
bounded(virgin, 'empty network');

const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {})!;
check(!!pr, 'two-town railway built');
if (!pr) throw new Error('no railway fixture');
const dep = depotBehind(g, pr.A, pr.B, 0), line = g.lines.create('rail', 0);
line.stops = [pr.A.id, pr.B.id];
const cars = [M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')];
const train = g.vehicles.buyTrain(dep, cars, line.id) as Train;
check(train instanceof Train, 'passenger train bought');
g.lines.flushCatchment();
const plainBefore = footprint(g), plain = mailView(g);
check(plain !== virgin && plain.carried === 0 && plain.pairs.every((p) => p.share === 0), 'passenger service alone carries 0% of mail');
check(footprint(g) === plainBefore && [...g.stations.map.values()].every((st) => !st.mail), 'passenger-only reads keep station mail lazy');
bounded(plain, 'passenger railway');

const withVan = [cars[0], M('van_ic'), ...cars.slice(1)];
check(g.vehicles.recompose(train, withVan) === null && train.mailCapacity === 80, 'a mail van added in the depot');
g.lines.flushCatchment();
const vanBefore = footprint(g), vans = mailView(g);
const pair = vans.pairs.find((p) => p.a === Math.min(pr.TA.id, pr.TB.id) && p.b === Math.max(pr.TA.id, pr.TB.id));
check(vans !== plain && vans.carried > plain.carried && !!pair && pair.share > 0, 'adding a van invalidates the cache and raises the carried share');
{
  // a line to one town carries its stations' mail for towns beyond it too (the capture floor): the towns count all of
  // it (up to their potential), the pair only its own
  const ends = [pr.TA.id, pr.TB.id].map((id) => vans.towns.find((t) => t.id === id)!);
  const posted = (id: number) => [...g.stations.map.values()].filter((st) => st.townId === id && g.mail.accepts(st)).reduce((n, st) => n + g.mail.rate(st) * 30 * 0.1, 0);
  console.log(`one van line: ${ends.map((t) => `${g.towns.list[t.id].name} ${fmt(100 * t.share, 1)}% of its mail carried`).join(', ')}; the pair ${fmt(100 * (pair?.share ?? 0), 1)}%`);
  check(!!pair && ends.every((t) => t.share > 0 && Math.abs(t.carried - Math.min(t.potential, posted(t.id))) < 1e-9 * Math.max(1, t.carried)) && vans.carried >= pair.carried - 1e-9,
    'the towns at the ends count all the mail their stations post, for towns beyond the line too');
}
check(footprint(g) === vanBefore && [...g.stations.map.values()].every((st) => !st.mail), 'forecasting the van service does not create station mail');
bounded(vans, 'van service');
check(g.vehicles.recompose(train, cars) === null, 'van removed again in the depot');
g.lines.flushCatchment();
check(mailView(g).carried === 0, 'removing the last van clears the carried share immediately');
check(g.vehicles.recompose(train, withVan) === null, 'van restored');
runDays(g, 360);
const activeBefore = footprint(g), active = mailView(g);
check(active !== vans && active.carried > 0 && train.mailDelivered > 0, 'the running service carries mail and the daily cache updates');
check(footprint(g) === activeBefore, 'reading a running mail network leaves simulation state unchanged');
bounded(active, 'running mail service');
console.log(`mail map: ${fmt(active.potential, 1)} t/mo potential, ${fmt(active.carried, 1)} t/mo carried (${fmt(100 * active.carried / active.potential, 2)}%); van delivered ${fmt(train.mailDelivered * 0.1, 1)} t`);

// Instrument the core read APIs: unchanged versions must bypass all population / route / rate calculations.
let queries = 0;
for (const name of ['townShares', 'accepts', 'mailPop', 'weights', 'rate'] as const) {
  const fn = g.mail[name];
  (g.mail as any)[name] = (...args: any[]) => { queries++; return (fn as any).apply(g.mail, args); };
}
for (let i = 0; i < 300; i++) check(mailView(g) === active, 'unchanged versions reuse the same view');
check(queries === 0, 'cache hits do no mail model work');
g.lines.rebuild(false);
const changed = mailView(g);
check(changed !== active && queries > 0, 'routing version invalidates the cached view');
const afterRebuild = queries;
check(mailView(g) === changed && queries === afterRebuild, 'the rebuilt view is cached too');

// Exercise the actual UI update paths; replace only DOM card construction and GPU drawing with small sinks.
let arcs: Arc[] | null = null, rings: ShareRing[] | null = null, draws = 0, mailCards = 0, paxCards = 0;
const townInfo = new Map<number, string>();
const modes = Object.create(MapModes.prototype) as MapModes;
Object.assign(modes, {
  mode: 'none', demandLayer: 'pax', demand: null, mailDemand: null, demandT: 0, shares: new Map(),
  card: { style: {} }, onChange: () => {},
  ui: {
    game: g, sound: () => {}, minimap: { setMapMode: () => {} },
    renderer: {
      labels: { townInfo },
      overlay: {
        setArcs: (v: Arc[] | null) => { arcs = v; draws++; },
        setShareRings: (v: ShareRing[] | null) => { rings = v; draws++; },
        setCatchments: () => { draws++; }, setDim: () => {},
      },
    },
  },
  renderMailCard: () => { mailCards++; }, renderDemandCard: () => { paxCards++; },
});
let q0 = queries;
for (let i = 0; i < 300; i++) modes.update(1 / 60);
check(queries === q0 && draws === 0, 'closed map does no mail queries or overlay work');
modes.set('demand');
modes.update(1);
check(queries === q0 && paxCards === 1 && modes.mailDemand === null, 'Passengers layer does no mail view work');
modes.setDemandLayer('mail');
check(mailCards === 1 && modes.mailDemand !== null && !!arcs?.length && rings?.length === g.towns.list.length, 'Mail toggle draws town-pair arcs and town rings');
check([...townInfo.values()].every((s) => /^\d+% carried · [\d,.]+ t\/mo$/.test(s)), 'mail town labels show percent carried and tonnes per month');
check(arcs!.every((a) => {
  const p = modes.mailDemand!.pairs.find((p) => {
    const A = g.towns.list[p.a], B = g.towns.list[p.b];
    return A.x === a.ax && A.z === a.az && B.x === a.bx && B.z === a.bz;
  });
  return !!p && a.color === servedColor(p.share) && a.dash === servedDash(p.share);
}), 'mail arcs reuse passenger colours and dash cues');
check(modes.demand?.regions.length === 0 && modes.demand?.pairs.length === modes.mailDemand!.pairs.length, 'minimap receives the same mail town pairs');
q0 = queries;
const d0 = draws;
for (let i = 0; i < 300; i++) modes.update(1 / 60);
check(queries === q0 && draws === d0 && mailCards === 1, 'Mail layer does not recompute or redraw on unchanged frames');
modes.setDemandLayer('pax');
check(modes.mailDemand === null && rings === null && paxCards === 2 && [...townInfo.values()].every((s) => s.includes('% served')), 'Passengers toggle clears mail rings and restores passenger labels');
check(queries === q0, 'switching back to Passengers performs no mail queries');
modes.set('none');
check(arcs === null && rings === null && townInfo.size === 0 && modes.shares.size === 0, 'closing the demand map clears its overlay and labels');
runDays(g, 1); // Make every enabled cache stale while the layer is off.
q0 = queries;
for (let i = 0; i < 300; i++) modes.update(1 / 60);
check(mailView(g, false) === null && queries === q0, 'no mail view work while off, even after versions change');

// A UI read once per day must not alter continuation or random streams after loading.
const replay = deserialize(serialize(g));
let same = true;
for (let day = 0; day < 90; day++) {
  mailView(g);
  runDays(g, 1); runDays(replay, 1);
  if (day % 30 === 29 && JSON.stringify(serialize(g)) !== JSON.stringify(serialize(replay))) same = false;
}
check(same, '90-day exact replay is unchanged by reading the mail view every day');
bounded(mailView(g), 'replayed service');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
