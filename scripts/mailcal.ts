// Mail calibration, on two kinds of railway:
//  - single lines: an intercity railway (the economy test's site choice: the best pair of towns 80-160 units apart) run
//    by one train of the era with a mail van and three coaches, seeds 7 / 23 / 51, starting 1950 and 2000, three years;
//  - AI networks: two rail-focused AI companies from 1950 (aimail's natural games: seeds 5 / 7 / 11 / 23 / 51 / 61, five
//    years), which add vans where their mail forecasts pay, in towns with their bus networks and frequent trains.
// Over the last year, total line income and the vans' load against the coaches travelling with them.
// Anchors (mail plan): mail about 15-33% of rail passenger revenue, a van per 3-5 coaches. The two kinds of line differ
// on the passenger side: a single line is its stations' only destination, so the passengers' local capture sends their
// local trips (at least 60% of the full rate, demand.ts localCapture) and the car feeders onto it, while in a network
// those trips stay in town by bus and the railway carries the trips between towns, as it carries all mail; a station's
// passengers are also shared with the bus stops around it, its mail only with other mail stations. The same mail is
// therefore about three times the share of passenger income on a network's railway (2.7's AI railways run their
// coaches 5-25% full). The targets:
//  - single lines: 15-35% on average in 1950, 10-30% in 2000, each route 10-45% / 8-40%; vans 0.33-2x the coaches'
//    load each, 0.4-1.5x on average (the coaches also carry the local trips); mail delivered both ways, at most 5% of
//    it lost, queues under their caps.
//  - AI lines with vans and a passenger service (coaches at least 5% full; lines without one run for their mail and
//    are only reported): 20-70% of their passenger income together; vans 0.33-2.5x the coaches' load each, within
//    +-50% on average. Each line: 10-100% of the passenger income on mail-equipped trains where their coaches run at least 10% full (below
//    that, a few passengers set the share, not the mail); every line earns 0.5-1.5x as much per mail unit as per
//    passenger fare paid in the same year (mail priced like the passengers it travels with).
// Mail scales with MAIL_PER_PAX (constants.ts): prints the range of it that every target allows, and its middle (the AI
// lines only roughly: their vans follow their forecasts). MAIL_FEEDER.share sets the networks against the single lines.
// npx esbuild scripts/mailcal.ts --bundle --platform=node --format=esm --outfile=$S/mailcal.mjs && node $S/mailcal.mjs [seeds] [years] [--ai=5,7,11,23,51,61] [--aiyears=5] [--part=all|single|ai] [--json=path]
import { writeFileSync } from 'node:fs';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { MAIL_PER_PAX } from '../src/game/constants';
import { mailQueueCap } from '../src/game/mail';
import { mailVans } from '../src/game/ai-mail';
import type { CargoGroup, MailGroup } from '../src/game/vehicle';
import { WALK_LINE } from '../src/game/stations';
import { fails, check, fmt, placeAndConnect, depotBehind, Train } from './lib';

if (!process.argv[1]?.endsWith('mailcal.mjs')) throw new Error('bundle this test as mailcal.mjs');
const args = process.argv.slice(2).filter((s) => !s.startsWith('--'));
const seeds = (args[0] ?? '7,23,51').split(',').map(Number), YEARS = Number(args[1] ?? 3);
const opt = (name: string) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
const json = opt('json'), part = opt('part') ?? 'all';
const aiSeeds = (opt('ai') ?? '5,7,11,23,51,61').split(',').map(Number), AI_YEARS = Number(opt('aiyears') ?? 5);
const M = (id: string) => MODEL_BY_ID.get(id)!;
type Band = [number, number];
/** Mail income / passenger income: single lines by start year (the mean of the routes, and each route), AI lines with vans (together, each). */
const MEAN: Record<number, Band> = { 1950: [0.15, 0.35], 2000: [0.1, 0.3] };
const ROUTE: Record<number, Band> = { 1950: [0.1, 0.45], 2000: [0.08, 0.4] };
const AI_MEAN: Band = [0.2, 0.7], AI_LINE: Band = [0.1, 1];
/** The vans' load / the coaches' load: single lines (the geometric mean, each route), AI lines (the geometric mean, each line). */
const VAN_MEAN: Band = [0.4, 1.5], VAN_ROUTE: Band = [0.33, 2], AI_VAN_MEAN: Band = [0.5, 1.5], VAN_LINE: Band = [0.33, 2.5];
/** An AI line with vans whose coaches run less full than this has no passenger service to weigh its mail against. */
const MIN_COACH_LOAD = 0.05;
/** The per-line share band needs a real passenger service: coaches at least this full (else nearly empty coaches set it). */
const LINE_SHARE_LOAD = 0.1;
/** Income per paid mail leg / income per paid passenger leg, on every AI line with vans. */
const AI_UNIT_PRICE: Band = [0.5, 1.5];
/** The share of its posted mail a route may lose (queues overflowing, no route). */
const MAX_LOST = 0.05;

interface End { name: string; posted: number; delivered: number }
interface Result {
  seed: number; year: number; route: string; pax: number; mail: number; share: number; vanLoad: number; coachLoad: number; ratio: number;
  posted: number; delivered: number; lost: number; maxQueue: number; cap: number; ends: End[];
  /** last year: passengers boarded and mail units loaded on the line */
  boardings: number; units: number;
}
const results: Result[] = [];
interface AiResult {
  seed: number; line: string; trains: number; vans: number; pax: number; mail: number; share: number; vanLoad: number; coachLoad: number; ratio: number;
  boardings: number; units: number; paidPassengers: number; paidMail: number;
  equippedPaxIncome: number; equippedShare: number;
}
const aiResults: AiResult[] = [];
/** Income per passenger boarding and per mail unit loaded, and mail units per boarding. */
const perUnit = (r: { pax: number; mail: number; boardings: number; units: number }) =>
  `per boarding ${fmt(r.pax / Math.max(1, r.boardings), 0)}, per mail unit ${fmt(r.mail / Math.max(1, r.units), 0)}, ${fmt(r.units / Math.max(1, r.boardings), 3)} mail units per boarding`;

function consist(year: number): VehicleModel[] {
  const loco = year < 1950 ? 'steam_b' : year < 1968 ? 'diesel_a' : 'diesel_b';
  const coach = year < 1935 ? 'coach_wood' : year < 1975 ? 'coach_steel' : 'coach_ic';
  const van = year < 1935 ? 'van_wood' : year < 1975 ? 'van_steel' : 'van_ic';
  return [M(loco), M(van), M(coach), M(coach), M(coach)];
}
const pct = (x: number) => fmt(100 * x, 1) + '%';
const band = (b: Band, f = (x: number) => fmt(100 * x, 0)) => `${f(b[0])}-${f(b[1])}`;
const ratioBand = (b: Band) => band(b, (x) => fmt(x, 2));
const within = (x: number, b: Band) => x >= b[0] && x <= b[1];

// ---- single lines
if (part !== 'ai') for (const year of [1950, 2000]) for (const seed of seeds) {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: year });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {});
  if (!pr) { console.log(`seed ${seed} ${year}: no railway site`); continue; }
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const t = g.vehicles.buyTrain(depotBehind(g, pr.A, pr.B, 0), consist(year), line.id);
  if (!(t instanceof Train)) { console.log(`seed ${seed} ${year}: ${t}`); continue; }
  const ends: End[] = line.stops.map((id) => ({ name: g.towns.list[g.stations.get(id)!.townId]?.name ?? `station ${id}`, posted: 0, delivered: 0 }));
  let van = 0, coach = 0, n = 0, maxQueue = 0, cap = 0, posted = 0, delivered = 0, lost = 0, boardings = 0, units = 0;
  for (let d = 0; d < YEARS * 360; d++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) {
      g.stepTick();
      if (d >= (YEARS - 1) * 360 && k % 20 === 0 && t.state === 'running') { n++; van += t.mailLoad / t.mailCapacity; coach += t.load / t.capacity; }
    }
    for (const id of line.stops) {
      const st = g.stations.get(id)!;
      if (st.mail) { maxQueue = Math.max(maxQueue, st.mail.total); cap = Math.max(cap, mailQueueCap(g, st)); }
    }
    if (d >= (YEARS - 1) * 360 && (d + 1) % 30 === 0) {
      boardings += line.passLast; units += line.mail?.last ?? 0;
      line.stops.forEach((id, i) => {
        const m = g.stations.get(id)!.mail;
        if (!m) return;
        posted += m.genLast; delivered += m.arrivedLast; lost += m.lostLast;
        ends[i].posted += m.genLast; ends[i].delivered += m.arrivedLast;
      });
    }
  }
  const mail = line.mail?.incomeLast ?? 0, pax = line.incomeLast - mail;
  const r: Result = {
    seed, year, route: `${pr.TA.name}(${pr.TA.pop})-${pr.TB.name}(${pr.TB.pop}) ${fmt(Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), 0)} u`,
    pax, mail, share: pax > 0 ? mail / pax : 0, vanLoad: n ? van / n : 0, coachLoad: n ? coach / n : 0, ratio: coach > 0 ? van / coach : 0,
    posted, delivered, lost, maxQueue, cap, ends, boardings, units,
  };
  results.push(r);
  console.log(`${year} seed ${seed} ${r.route}: passengers ${fmt(pax / 1000, 1)}k, mail ${fmt(mail / 1000, 1)}k (${pct(r.share)}); loads van ${pct(r.vanLoad)} coaches ${pct(r.coachLoad)} (x${fmt(r.ratio, 2)}); last year posted ${posted} (${ends.map((e) => `${e.name} ${e.posted}`).join(', ')}), delivered ${delivered}, lost ${lost} units; queue max ${maxQueue} (cap ${cap}); ${perUnit(r)}`);
  const tag = `${year} seed ${seed}`;
  check(within(r.share, ROUTE[year]), `${tag}: mail ${pct(r.share)} of passenger income within ${band(ROUTE[year])}%`);
  check(within(r.ratio, VAN_ROUTE), `${tag}: the van runs at ${ratioBand(VAN_ROUTE)}x the coaches' load (x${fmt(r.ratio, 2)})`);
  check(ends.every((e) => e.posted > 0 && e.delivered > 0), `${tag}: mail is posted and delivered at both ends (${ends.map((e) => `${e.name} ${e.posted} / ${e.delivered}`).join(', ')})`);
  check(r.lost <= MAX_LOST * Math.max(1, r.posted), `${tag}: at most ${fmt(100 * MAX_LOST, 0)}% of the mail lost (${r.lost} of ${r.posted})`);
  check(r.maxQueue <= r.cap, `${tag}: mail queues stay under their cap (${r.maxQueue} <= ${r.cap})`);
}

/** Observe fare booking without changing simulation or pricing. Cargo is captured by recordStop before unloading;
 * onIncome runs after the fare has been booked. Previous mail legs are paid on the delivering call as well. */
function paidUnits(g: Game, fromDay: number, toDay: number) {
  type Paid = { passengers: number; mail: number; paxIncome: number; mailIncome: number; equippedPaxIncome: number };
  const totals = new Map<number, Paid>();
  const entry = (id: number) => { const v = totals.get(id) ?? { passengers: 0, mail: 0, paxIncome: 0, mailIncome: 0, equippedPaxIncome: 0 }; totals.set(id, v); return v; };
  type Call = { cargo: Set<CargoGroup>; mail: MailGroup[]; delivered: number; income: Map<number, number>; observed: boolean };
  const calls = new Map<number, Call>(), record = g.recordStop.bind(g), income = g.onIncome.bind(g);
  let incomplete = 0;
  g.recordStop = (v, st) => {
    record(v, st);
    if (g.day < fromDay || g.day >= toDay) return;
    const mail = [...v.mailCargo.values()].filter(c => {
      if (c.alight !== st.id) return false;
      if (c.dest === st.id) return true;
      const hop = g.lines.mailNextHop(st.id, c.dest);
      return hop?.line === WALK_LINE && hop.alight === c.dest;
    });
    calls.set(v.id, { cargo: new Set(v.cargo.values()), mail, delivered: v.mailDelivered,
      income: new Map(g.lines.all().map(l => [l.id, l.mail?.incomeYear ?? 0])), observed: false });
  };
  g.onIncome = (amount, v, st) => {
    income(amount, v, st);
    if (g.day < fromDay || g.day >= toDay) return;
    const call = calls.get(v.id), line = v.line;
    if (!call) { incomplete++; return; }
    if (v.mailDelivered === call.delivered) {
      if (line?.kind !== 'rail' || line.owner <= 0) return;
      const aboard = new Set(v.cargo.values());
      const count = [...call.cargo].filter(c => !aboard.has(c)).reduce((n, c) => n + c.count, 0);
      entry(line.id).passengers += count; entry(line.id).paxIncome += amount;
      if (v.mailCapacity > 0) entry(line.id).equippedPaxIncome += amount;
      call.cargo = aboard;
      return;
    }
    if (call.observed) return;
    call.observed = true;
    if (call.mail.reduce((n, c) => n + c.count, 0) !== v.mailDelivered - call.delivered) incomplete++;
    const add = (id: number, count: number) => { const l = g.lines.get(id); if (l?.kind === 'rail' && l.owner > 0) entry(l.id).mail += count; };
    for (const c of call.mail) {
      const from = g.stations.get(c.from), dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
      if (line && dist > 0) add(line.id, c.count);
      for (const leg of c.legs) if (leg[3] > 0) add(leg[1], c.count);
    }
    for (const l of g.lines.all()) if (l.kind === 'rail' && l.owner > 0) {
      entry(l.id).mailIncome += (l.mail?.incomeYear ?? 0) - (call.income.get(l.id) ?? 0);
    }
  };
  const get = (id: number) => [...totals].filter(([key]) => g.lines.get(key)?.id === id).reduce((out, [, p]) => ({
    passengers: out.passengers + p.passengers, mail: out.mail + p.mail,
    paxIncome: out.paxIncome + p.paxIncome, mailIncome: out.mailIncome + p.mailIncome,
    equippedPaxIncome: out.equippedPaxIncome + p.equippedPaxIncome,
  }), { passengers: 0, mail: 0, paxIncome: 0, mailIncome: 0, equippedPaxIncome: 0 });
  return { get, complete: () => incomplete === 0 };
}

// ---- AI networks: every AI line with vans over the last year
if (part !== 'single') for (const seed of aiSeeds) {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950,
    aiConfigs: Array.from({ length: 2 }, () => ({ focus: { rail: 2.5, road: 1.2, tram: 0.5 } })) });
  g.aiAcquisitions = false;
  const paid = paidUnits(g, (AI_YEARS - 1) * 360, AI_YEARS * 360);
  const loads = new Map<number, { van: number; coach: number; n: number }>(), volume = new Map<number, { boardings: number; units: number }>();
  for (let d = 0; d < AI_YEARS * 360; d++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) {
      g.stepTick();
      if (d >= (AI_YEARS - 1) * 360 && k % 20 === 0) for (const t of g.vehicles.trains()) {
        if (t.owner <= 0 || !t.line || !(t.mailCapacity > 0) || !(t.capacity > 0) || t.state !== 'running') continue;
        const e = loads.get(t.line.id) ?? { van: 0, coach: 0, n: 0 };
        e.van += t.mailLoad / t.mailCapacity; e.coach += t.load / t.capacity; e.n++;
        loads.set(t.line.id, e);
      }
    }
    if (d >= (AI_YEARS - 1) * 360 && (d + 1) % 30 === 0) for (const l of g.lines.all()) if (l.owner > 0 && l.kind === 'rail') {
      const v = volume.get(l.id) ?? { boardings: 0, units: 0 };
      v.boardings += l.passLast; v.units += l.mail?.last ?? 0;
      volume.set(l.id, v);
    }
  }
  for (const l of g.lines.all()) {
    const e = loads.get(l.id);
    if (l.kind !== 'rail' || l.owner <= 0 || !e || !l.mail || !(l.mail.incomeLast > 0)) continue;
    const trains = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train);
    const mail = l.mail.incomeLast, pax = l.incomeLast - mail;
    const receipts = paid.get(l.id);
    const r: AiResult = {
      seed, line: l.name, trains: trains.length, vans: trains.reduce((n, t) => n + mailVans(t).length, 0), pax, mail, share: pax > 0 ? mail / pax : 0,
      vanLoad: e.van / e.n, coachLoad: e.coach / e.n, ratio: e.coach > 0 ? e.van / e.coach : 0,
      boardings: volume.get(l.id)?.boardings ?? 0, units: volume.get(l.id)?.units ?? 0,
      paidPassengers: receipts.passengers, paidMail: receipts.mail,
      equippedPaxIncome: receipts.equippedPaxIncome, equippedShare: receipts.equippedPaxIncome > 0 ? mail / receipts.equippedPaxIncome : 0,
    };
    aiResults.push(r);
    const served = r.coachLoad >= MIN_COACH_LOAD;
    console.log(`AI seed ${seed} ${r.line}: ${r.trains} trains, ${r.vans} vans; passengers ${fmt(pax / 1000, 1)}k, mail ${fmt(mail / 1000, 1)}k (${pct(r.share)}); loads van ${pct(r.vanLoad)} coaches ${pct(r.coachLoad)} (x${fmt(r.ratio, 2)}); ${perUnit(r)}${served ? '' : ' (coaches nearly empty: not weighed)'}`);
    const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    check(paid.complete() && !!receipts && close(receipts.paxIncome, pax) && close(receipts.mailIncome, mail),
      `AI seed ${seed} ${r.line}: paid units cover the same annual passenger and mail receipts`);
    check(Number.isFinite(r.equippedPaxIncome) && r.equippedPaxIncome >= 0 && r.equippedPaxIncome <= pax + 1e-6 * Math.max(1, pax),
      `AI seed ${seed} ${r.line}: mail-equipped passenger receipts are a subset of the full annual receipts`);
    if (r.paidMail > 0 && r.paidPassengers > 0) {
      const price = (r.mail / r.paidMail) / (r.pax / r.paidPassengers);
      const old = (r.mail / Math.max(1, r.units)) / (r.pax / Math.max(1, r.boardings));
      console.log(`  paid passengers ${r.paidPassengers}, paid mail legs ${r.paidMail}; per paid passenger ${fmt(r.pax / r.paidPassengers, 0)}, per paid mail leg ${fmt(r.mail / r.paidMail, 0)}; price x${fmt(price, 3)} (boarding/loading cohorts x${fmt(old, 3)})`);
      check(within(price, AI_UNIT_PRICE), `AI seed ${seed} ${r.line}: income per paid mail leg ${ratioBand(AI_UNIT_PRICE)}x that per paid passenger leg (x${fmt(price, 2)})`);
    }
    if (!served) continue;
    // Load samples include only mail-equipped trains. A line can profitably remove an underused van from one
    // train; match this per-line calibration to that same cohort while retaining the whole-line aggregate below.
    console.log(`  mail-equipped trains: passenger receipts ${fmt(r.equippedPaxIncome / 1000, 1)}k, mail share ${pct(r.equippedShare)}; whole-line share ${pct(r.share)}`);
    if (r.coachLoad >= LINE_SHARE_LOAD) check(within(r.equippedShare, AI_LINE), `AI seed ${seed} ${r.line}: mail ${pct(r.equippedShare)} of mail-equipped passenger income within ${band(AI_LINE)}%`);
    check(within(r.ratio, VAN_LINE), `AI seed ${seed} ${r.line}: the vans run at ${ratioBand(VAN_LINE)}x the coaches' load (x${fmt(r.ratio, 2)})`);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const gmean = (xs: number[]) => Math.exp(mean(xs.map((x) => Math.log(Math.max(1e-9, x)))));
// Mail scales with MAIL_PER_PAX (x k, while vans have room): every band allows a range of k; the suggestion is the
// middle (geometric) of the range all of them allow.
let kMin = 0, kMax = Infinity;
const allow = (x: number, b: Band) => { if (x > 0) { kMin = Math.max(kMin, b[0] / x); kMax = Math.min(kMax, b[1] / x); } };
if (part !== 'ai') {
  for (const r of results) { allow(r.share, ROUTE[r.year]); allow(r.ratio, VAN_ROUTE); }
  for (const y of [1950, 2000]) {
    const rs = results.filter((r) => r.year === y);
    if (!rs.length) continue;
    const s = mean(rs.map((r) => r.share)), ratio = gmean(rs.map((r) => r.ratio));
    console.log(`${y}: mean mail share ${pct(s)} (band ${band(MEAN[y])}%; routes ${rs.map((r) => pct(r.share)).join(' / ')}), van/coach load x${fmt(ratio, 2)} (routes ${rs.map((r) => fmt(r.ratio, 2)).join(' / ')})`);
    allow(s, MEAN[y]); allow(ratio, VAN_MEAN);
    check(within(s, MEAN[y]), `${y}: mail ${pct(s)} of passenger income on average within ${band(MEAN[y])}%`);
    check(within(ratio, VAN_MEAN), `${y}: the van runs at ${ratioBand(VAN_MEAN)}x the coaches' load on average (x${fmt(ratio, 2)})`);
  }
  check(results.length === 2 * seeds.length && results.every((r) => r.mail > 0 && r.delivered > 0), 'every railway carries mail');
}
if (part !== 'single') {
  const weighed = aiResults.filter((r) => r.coachLoad >= MIN_COACH_LOAD);
  // together: the mail of all of them against all their passenger income
  const s = weighed.reduce((a, r) => a + r.mail, 0) / Math.max(1, weighed.reduce((a, r) => a + r.pax, 0)), ratio = gmean(weighed.map((r) => r.ratio));
  console.log(`AI lines with vans: ${aiResults.length}, ${weighed.length} with a passenger service; mail ${pct(s)} of their passenger income (band ${band(AI_MEAN)}%; lines ${weighed.map((r) => pct(r.share)).join(' / ')}), van/coach load x${fmt(ratio, 2)} (lines ${weighed.map((r) => fmt(r.ratio, 2)).join(' / ')})`);
  check(weighed.length >= Math.ceil(aiSeeds.length / 2), `AI lines with vans and a passenger service in at least half the games (${weighed.length} in ${aiSeeds.length})`);
  if (weighed.length) {
    for (const r of weighed) { if (r.coachLoad >= LINE_SHARE_LOAD) allow(r.equippedShare, AI_LINE); allow(r.ratio, VAN_LINE); }
    allow(s, AI_MEAN); allow(ratio, AI_VAN_MEAN);
    check(within(s, AI_MEAN), `AI lines: mail ${pct(s)} of their passenger income within ${band(AI_MEAN)}%`);
    check(within(ratio, AI_VAN_MEAN), `AI lines: the vans run within +-50% of the coaches' load on average (x${fmt(ratio, 2)})`);
  }
}
const k = kMin <= kMax && kMin > 0 ? Math.sqrt(kMin * kMax) : kMin > 0 ? kMin : 1;
console.log(`MAIL_PER_PAX within the targets: ${fmt(MAIL_PER_PAX * kMin, 3)} .. ${fmt(MAIL_PER_PAX * kMax, 3)}${kMin > kMax ? ' (none: the targets conflict)' : ''}`);
console.log(`suggested MAIL_PER_PAX ${fmt(MAIL_PER_PAX * k, 3)} (now ${MAIL_PER_PAX}; x${fmt(k, 2)})`);
if (json) writeFileSync(json, JSON.stringify({ MAIL_PER_PAX, suggested: MAIL_PER_PAX * k, results, aiResults }, null, 2) + '\n');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
