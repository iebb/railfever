// Mail calibration: an intercity railway (the economy test's site choice: the best pair of towns 80-160 units apart)
// run by one train of the era with a mail van and three coaches, seeds 7 / 23 / 51, starting 1950 and 2000, three
// years. Over the last year: mail income as a share of passenger income (targets 15-35% in 1950, 10-30% in 2000; the
// era makes 2000 post about 1.35x the mail of 1950), the van's load against the coaches' (within +-50%), and mail queues
// under their caps. Prints a suggested MAIL_PER_PAX (constants.ts) for the middle of the bands.
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
/** Target share bands (mail income / passenger income) by start year. */
const BANDS: Record<number, [number, number]> = { 1950: [0.15, 0.35], 2000: [0.1, 0.3] };

interface Result { seed: number; year: number; route: string; pax: number; mail: number; share: number; vanLoad: number; coachLoad: number; ratio: number; posted: number; delivered: number; lost: number; maxQueue: number; cap: number }
const results: Result[] = [];

function consist(year: number): VehicleModel[] {
  const loco = year < 1950 ? 'steam_b' : year < 1968 ? 'diesel_a' : 'diesel_b';
  const coach = year < 1935 ? 'coach_wood' : year < 1975 ? 'coach_steel' : 'coach_ic';
  const van = year < 1935 ? 'van_wood' : year < 1975 ? 'van_steel' : 'van_ic';
  return [M(loco), M(van), M(coach), M(coach), M(coach)];
}

for (const year of [1950, 2000]) for (const seed of seeds) {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: year });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {});
  if (!pr) { console.log(`seed ${seed} ${year}: no railway site`); continue; }
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const t = g.vehicles.buyTrain(depotBehind(g, pr.A, pr.B, 0), consist(year), line.id);
  if (!(t instanceof Train)) { console.log(`seed ${seed} ${year}: ${t}`); continue; }
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
    if (d >= (YEARS - 1) * 360 && (d + 1) % 30 === 0) for (const id of line.stops) {
      const m = g.stations.get(id)!.mail;
      if (m) { posted += m.genLast; delivered += m.arrivedLast; lost += m.lostLast; }
    }
  }
  const mail = line.mail?.incomeLast ?? 0, pax = line.incomeLast - mail;
  const r: Result = { seed, year, route: `${pr.TA.name}(${pr.TA.pop})-${pr.TB.name}(${pr.TB.pop}) ${fmt(Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), 0)} u`,
    pax, mail, share: pax > 0 ? mail / pax : 0, vanLoad: n ? van / n : 0, coachLoad: n ? coach / n : 0, ratio: coach > 0 ? van / coach : 0, posted, delivered, lost, maxQueue, cap };
  results.push(r);
  console.log(`${year} seed ${seed} ${r.route}: passengers ${fmt(pax / 1000, 1)}k, mail ${fmt(mail / 1000, 1)}k (${fmt(100 * r.share, 1)}%); loads van ${fmt(100 * r.vanLoad, 1)}% coaches ${fmt(100 * r.coachLoad, 1)}% (x${fmt(r.ratio, 2)}); last year posted ${posted}, delivered ${delivered}, lost ${lost} units; queue max ${maxQueue} (cap ${cap})`);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const gmean = (xs: number[]) => Math.exp(mean(xs.map((x) => Math.log(Math.max(1e-9, x)))));
const byYear = (y: number) => results.filter((r) => r.year === y);
// Mail scales with MAIL_PER_PAX (x k): the share bands and the van load band (0.5-1.5 x the coaches) each allow a
// range of k; the suggestion is the middle (geometric) of the range all of them allow.
let kMin = 0, kMax = Infinity;
for (const y of [1950, 2000]) {
  const rs = byYear(y);
  if (!rs.length) continue;
  const s = mean(rs.map((r) => r.share)), ratio = gmean(rs.map((r) => r.ratio));
  console.log(`${y}: mean mail share ${fmt(100 * s, 1)}% (band ${BANDS[y].map((b) => fmt(100 * b, 0)).join('-')}%), van/coach load x${fmt(ratio, 2)}`);
  if (s > 0) { kMin = Math.max(kMin, BANDS[y][0] / s); kMax = Math.min(kMax, BANDS[y][1] / s); }
  if (ratio > 0) { kMin = Math.max(kMin, 0.5 / ratio); kMax = Math.min(kMax, 1.5 / ratio); }
  check(s >= BANDS[y][0] && s <= BANDS[y][1], `${y}: mail ${fmt(100 * s, 1)}% of passenger income within ${BANDS[y].map((b) => fmt(100 * b, 0)).join('-')}%`);
  check(ratio >= 0.5 && ratio <= 1.5, `${y}: the van runs within +-50% of the coaches' load (x${fmt(ratio, 2)})`);
}
for (const r of results) check(r.maxQueue <= r.cap, `${r.year} seed ${r.seed}: mail queues stay under their cap (${r.maxQueue} <= ${r.cap})`);
check(results.every((r) => r.mail > 0 && r.delivered > 0), 'every railway carries mail');
const k = kMin <= kMax && kMin > 0 ? Math.sqrt(kMin * kMax) : kMin > 0 ? kMin : 1;
console.log(`MAIL_PER_PAX within the targets: ${fmt(MAIL_PER_PAX * kMin, 2)} .. ${fmt(MAIL_PER_PAX * kMax, 2)}${kMin > kMax ? ' (none: the targets conflict)' : ''}`);
console.log(`suggested MAIL_PER_PAX ${fmt(MAIL_PER_PAX * k, 2)} (now ${MAIL_PER_PAX}; x${fmt(k, 2)})`);
if (json) writeFileSync(json, JSON.stringify({ MAIL_PER_PAX, suggested: MAIL_PER_PAX * k, results }, null, 2) + '\n');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
