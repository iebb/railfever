// Mail calibration: an intercity railway (the economy test's site choice: the best pair of towns 80-160 units apart)
// run by one train of the era with a mail van and three coaches, seeds 7 / 23 / 51, starting 1950 and 2000, three
// years (too sparse a service for the car feeders and the mail feeders: those follow the same rules, scripts/mail.ts).
// Over the last year, for every route and on average:
//  - mail income as a share of passenger income. Anchors (mail plan): mail about 15-33% of rail passenger revenue
//    mid-century, a van per 3-5 coaches. On average 15-35% (1950) and 10-30% (2000). Each route 10-45% (1950) and
//    8-40% (2000): routes differ more for mail than for passengers, as towns post 0.75-1.3x per head by their size
//    (business mail: mail.ts townMailFactor) and a line between two towns reaches 0.6-0.9x of their mail (the share of
//    it those towns receive: MAIL_CAPTURE), so a route may be about 0.6-1.5x the mean.
//  - the van's load against the coaches': on average within +-50%, each route 0.33-2x (the same spread).
//  - mail delivered both ways, at most 5% of it lost, queues under their caps.
// Mail scales with MAIL_PER_PAX (constants.ts): prints the range of it that every target allows, and its middle.
// npx esbuild scripts/mailcal.ts --bundle --platform=node --format=esm --outfile=$S/mailcal.mjs && node $S/mailcal.mjs [seeds] [years] [--json=path]
import { writeFileSync } from 'node:fs';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { MAIL_PER_PAX } from '../src/game/constants';
import { mailQueueCap } from '../src/game/mail';
import { fails, check, fmt, placeAndConnect, depotBehind, Train } from './lib';

if (!process.argv[1]?.endsWith('mailcal.mjs')) throw new Error('bundle this test as mailcal.mjs');
const args = process.argv.slice(2).filter((s) => !s.startsWith('--'));
const seeds = (args[0] ?? '7,23,51').split(',').map(Number), YEARS = Number(args[1] ?? 3);
const json = process.argv.find((s) => s.startsWith('--json='))?.slice(7);
const M = (id: string) => MODEL_BY_ID.get(id)!;
type Band = [number, number];
/** Mail income / passenger income by start year: the mean of the routes, and each route. */
const MEAN: Record<number, Band> = { 1950: [0.15, 0.35], 2000: [0.1, 0.3] };
const ROUTE: Record<number, Band> = { 1950: [0.1, 0.45], 2000: [0.08, 0.4] };
/** The van's load / the coaches' load: the (geometric) mean of the routes, and each route. */
const VAN_MEAN: Band = [0.5, 1.5], VAN_ROUTE: Band = [0.33, 2];
/** The share of its posted mail a route may lose (queues overflowing, no route). */
const MAX_LOST = 0.05;

interface End { name: string; posted: number; delivered: number }
interface Result {
  seed: number; year: number; route: string; pax: number; mail: number; share: number; vanLoad: number; coachLoad: number; ratio: number;
  posted: number; delivered: number; lost: number; maxQueue: number; cap: number; ends: End[];
}
const results: Result[] = [];

function consist(year: number): VehicleModel[] {
  const loco = year < 1950 ? 'steam_b' : year < 1968 ? 'diesel_a' : 'diesel_b';
  const coach = year < 1935 ? 'coach_wood' : year < 1975 ? 'coach_steel' : 'coach_ic';
  const van = year < 1935 ? 'van_wood' : year < 1975 ? 'van_steel' : 'van_ic';
  return [M(loco), M(van), M(coach), M(coach), M(coach)];
}
const pct = (x: number) => fmt(100 * x, 1) + '%';
const band = (b: Band, f = (x: number) => fmt(100 * x, 0)) => `${f(b[0])}-${f(b[1])}`;
const within = (x: number, b: Band) => x >= b[0] && x <= b[1];

for (const year of [1950, 2000]) for (const seed of seeds) {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: year });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {});
  if (!pr) { console.log(`seed ${seed} ${year}: no railway site`); continue; }
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const t = g.vehicles.buyTrain(depotBehind(g, pr.A, pr.B, 0), consist(year), line.id);
  if (!(t instanceof Train)) { console.log(`seed ${seed} ${year}: ${t}`); continue; }
  const ends: End[] = line.stops.map((id) => ({ name: g.towns.list[g.stations.get(id)!.townId]?.name ?? `station ${id}`, posted: 0, delivered: 0 }));
  let van = 0, coach = 0, n = 0, maxQueue = 0, cap = 0, posted = 0, delivered = 0, lost = 0;
  for (let d = 0; d < YEARS * 360; d++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) {
      g.stepTick();
      if (d >= (YEARS - 1) * 360 && k % 20 === 0 && t.state === 'running') { n++; van += t.mailLoad / t.mailCapacity; coach += t.load / t.capacity; }
    }
    for (const id of line.stops) {
      const st = g.stations.get(id)!;
      if (st.mail) { maxQueue = Math.max(maxQueue, st.mail.total); cap = Math.max(cap, mailQueueCap(g, st)); }
    }
    if (d >= (YEARS - 1) * 360 && (d + 1) % 30 === 0) line.stops.forEach((id, i) => {
      const m = g.stations.get(id)!.mail;
      if (!m) return;
      posted += m.genLast; delivered += m.arrivedLast; lost += m.lostLast;
      ends[i].posted += m.genLast; ends[i].delivered += m.arrivedLast;
    });
  }
  const mail = line.mail?.incomeLast ?? 0, pax = line.incomeLast - mail;
  const r: Result = {
    seed, year, route: `${pr.TA.name}(${pr.TA.pop})-${pr.TB.name}(${pr.TB.pop}) ${fmt(Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), 0)} u`,
    pax, mail, share: pax > 0 ? mail / pax : 0, vanLoad: n ? van / n : 0, coachLoad: n ? coach / n : 0, ratio: coach > 0 ? van / coach : 0,
    posted, delivered, lost, maxQueue, cap, ends,
  };
  results.push(r);
  console.log(`${year} seed ${seed} ${r.route}: passengers ${fmt(pax / 1000, 1)}k, mail ${fmt(mail / 1000, 1)}k (${pct(r.share)}); loads van ${pct(r.vanLoad)} coaches ${pct(r.coachLoad)} (x${fmt(r.ratio, 2)}); last year posted ${posted} (${ends.map((e) => `${e.name} ${e.posted}`).join(', ')}), delivered ${delivered}, lost ${lost} units; queue max ${maxQueue} (cap ${cap})`);
  const tag = `${year} seed ${seed}`;
  check(within(r.share, ROUTE[year]), `${tag}: mail ${pct(r.share)} of passenger income within ${band(ROUTE[year])}%`);
  check(within(r.ratio, VAN_ROUTE), `${tag}: the van runs at ${band(VAN_ROUTE, (x) => fmt(x, 2))}x the coaches' load (x${fmt(r.ratio, 2)})`);
  check(ends.every((e) => e.posted > 0 && e.delivered > 0), `${tag}: mail is posted and delivered at both ends (${ends.map((e) => `${e.name} ${e.posted} / ${e.delivered}`).join(', ')})`);
  check(r.lost <= MAX_LOST * Math.max(1, r.posted), `${tag}: at most ${fmt(100 * MAX_LOST, 0)}% of the mail lost (${r.lost} of ${r.posted})`);
  check(r.maxQueue <= r.cap, `${tag}: mail queues stay under their cap (${r.maxQueue} <= ${r.cap})`);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const gmean = (xs: number[]) => Math.exp(mean(xs.map((x) => Math.log(Math.max(1e-9, x)))));
// Mail scales with MAIL_PER_PAX (x k, while vans have room): every band allows a range of k; the suggestion is the
// middle (geometric) of the range all of them allow.
let kMin = 0, kMax = Infinity;
const allow = (x: number, b: Band) => { if (x > 0) { kMin = Math.max(kMin, b[0] / x); kMax = Math.min(kMax, b[1] / x); } };
for (const r of results) { allow(r.share, ROUTE[r.year]); allow(r.ratio, VAN_ROUTE); }
for (const y of [1950, 2000]) {
  const rs = results.filter((r) => r.year === y);
  if (!rs.length) continue;
  const s = mean(rs.map((r) => r.share)), ratio = gmean(rs.map((r) => r.ratio)), tag = String(y);
  console.log(`${tag}: mean mail share ${pct(s)} (band ${band(MEAN[y])}%; routes ${rs.map((r) => pct(r.share)).join(' / ')}), van/coach load x${fmt(ratio, 2)} (routes ${rs.map((r) => fmt(r.ratio, 2)).join(' / ')})`);
  allow(s, MEAN[y]); allow(ratio, VAN_MEAN);
  check(within(s, MEAN[y]), `${tag}: mail ${pct(s)} of passenger income on average within ${band(MEAN[y])}%`);
  check(within(ratio, VAN_MEAN), `${tag}: the van runs within +-50% of the coaches' load on average (x${fmt(ratio, 2)})`);
}
check(results.length === 2 * seeds.length && results.every((r) => r.mail > 0 && r.delivered > 0), 'every railway carries mail');
const k = kMin <= kMax && kMin > 0 ? Math.sqrt(kMin * kMax) : kMin > 0 ? kMin : 1;
console.log(`MAIL_PER_PAX within the targets: ${fmt(MAIL_PER_PAX * kMin, 3)} .. ${fmt(MAIL_PER_PAX * kMax, 3)}${kMin > kMax ? ' (none: the targets conflict)' : ''}`);
console.log(`suggested MAIL_PER_PAX ${fmt(MAIL_PER_PAX * k, 3)} (now ${MAIL_PER_PAX}; x${fmt(k, 2)})`);
if (json) writeFileSync(json, JSON.stringify({ MAIL_PER_PAX, suggested: MAIL_PER_PAX * k, results }, null, 2) + '\n');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
