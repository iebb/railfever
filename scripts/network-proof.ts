// Default: bounded observer contract checks. Explicit --natural: predeclared unforced six-year cohort.
// node network-proof.mjs --natural [--balanced [--compare=literal-final.json]] [--out=/outside/repo]
// node network-proof.mjs --snapshots=world-a.json,world-b.json --out=/outside/repo [--source-label=revision]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { buildRailDepot, nodeSnap } from '../src/game/routing';
import { observeNetwork, networkSnapshot, inspectDetachedRoutes } from './network-observer';
import { flatGame, station, endNode, loco } from './stationlib';
import { check, fails, build, railOpts, free, checkReservations, checkNaN } from './lib';

export const NETWORK_COHORT = { seeds: [5, 11, 23], years: 6, size: 512, towns: 12, startYear: 1985,
  aiConfigs: Array.from({ length: 3 }, () => ({ focus: { rail: 2.5, road: 0.8, tram: 0.5 } })), acquisitions: false };
const save = (g: Game) => JSON.stringify(serialize(g));
const board = (t: Train, st: Parameters<Train['serveStation']>[0]) => (t as unknown as { boardStation(station: Parameters<Train['serveStation']>[0]): number }).boardStation(st);

/** Paid native track/stock; direct passenger calls isolate classification from arrival scheduling. */
function transferFixture(walking: boolean) {
  const g = flatGame();
  g.aiEnabled = false;
  const rival = g.addAICompany({ accessPolicy: 'open' }).id;
  g.setAccessPolicy(0, 'open');
  const z = 110, A = station(g, 35, z, Math.PI / 2, 10, 1)!, H = station(g, 120, z, Math.PI / 2, 10, 1)!;
  const Q = walking ? station(g, 120, z + 8, Math.PI / 2, 10, 1, rival)! : H;
  const B = station(g, 215, walking ? z + 8 : z, Math.PI / 2, 10, 1, rival)!;
  if (!A || !H || !Q || !B) throw Error('Native transfer fixture stations failed');
  check(!!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, H, 0, false), 'rail'), railOpts(0)), 'observer fixture: paid source track');
  check(!!build(g, nodeSnap(g, endNode(g, Q, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(rival)), 'observer fixture: paid receiving track');
  if (walking) check(g.stations.isSameStationComplex(H.id, Q.id) || g.stations.link(H.id, Q.id) === null, 'observer fixture: real native walking link');
  const a = g.lines.create('rail', 0), b = g.lines.create('rail', rival);
  a.stops = [A.id, H.id]; b.stops = [Q.id, B.id];
  const da = buildRailDepot(g, A, 0, { x: 1, z: 0 }), db = buildRailDepot(g, B, rival, { x: -1, z: 0 });
  const ta = g.vehicles.buyTrain(da, loco(), a.id), tb = g.vehicles.buyTrain(db, loco(), b.id);
  if (!(ta instanceof Train) || !(tb instanceof Train)) throw Error(`Native transfer fixture stock failed: ${ta}/${tb}`);
  g.lines.rebuild();
  ta.stopIndex = 1; tb.stopIndex = 0;
  check(ta.value > 0 && tb.value > 0 && g.company(rival).economy.current.vehicles < 0,
    'observer fixture: trains are normally purchased and charged');
  return { g, A, H, Q, B, a, b, ta, tb };
}
function classificationChecks() {
  for (const walking of [false, true]) {
    const f = transferFixture(walking), { g, A, H, Q, B, ta, tb } = f;
    const observed = observeNetwork(g);
    ta.cargo.set('native-transfer-probe', { from: A.id, alight: H.id, dest: B.id, count: 6, day: g.day }); ta.load = 6;
    const routed = g.lines.nextHop(H.id, B.id);
    check(!!routed, 'observer fixture: native passenger routing connects both paid services');
    ta.serveStation(H, 0.03);
    check(observed.counters.handoffEnqueued === 6 && Q.waitingTotal === 6,
      `observer: ${walking ? 'walking' : 'same-station'} native alighting really enqueues the next ride`);
    const before = observed.counters.confirmedRailTransfers;
    check(before === 0, 'observer: queued transfer is not counted as boarded');
    const picked = board(tb, Q);
    check(picked === 6 && observed.counters.confirmedRailTransfers === 6 && observed.counters.confirmedCrossCompanyRailTransfers === 6,
      'observer: only actual second native boarding confirms six cross-line/cross-company riders');
    check([...observed.transfers.values()].some(t => t.walked === walking && t.fromOwner === ta.owner && t.toOwner === tb.owner && t.count === 6),
      'observer: actual vehicle owners and walking/same-physical-station classification retained');
    const delivered = tb.delivered; tb.serveStation(B, 0.03);
    check(tb.delivered - delivered === 6 && observed.deliveries.get(`${tb.owner}:${tb.lineId}`) === 6, 'observer: receiving service really delivers its boarded passengers through native alighting');
    const snapshot = networkSnapshot(g, observed);
    check(walking ? snapshot.sharedPhysicalStations.length === 0 && snapshot.sharedPublicComplexes.length === 1 && snapshot.physicalComponents.length === 2
      : snapshot.sharedPhysicalStations.length === 1 && snapshot.physicalComponents.length === 1,
      'observer: public transfer complex and physical track component remain distinct');
    const beforeReport = save(g);
    const routes = inspectDetachedRoutes(beforeReport);
    check(routes.calls.length >= 4 && routes.calls.every(c => c.ok) && routes.omitted === 0,
      'observer: detached native full-consist routes work in both directions');
    check(save(g) === beforeReport, 'observer: detached report leaves live world byte-exact');
    // A native-generated/untracked group mixed into a known incoming cohort is deliberately not attributed.
    tb.cargo.clear(); tb.load = 0;
    ta.cargo.set('mixed-probe', { from: A.id, alight: H.id, dest: B.id, count: 4, day: g.day }); ta.load = 4;
    ta.serveStation(H, 0.03);
    const w = [...Q.waiting.values()][0];
    g.stations.addWaiting(Q, w.line, w.alight, w.dest, 3, 0, w.t, (w.transfers ?? 0) * 3 / w.count, w.rail ?? 0, w.ic ?? 0);
    const confirmed = observed.counters.confirmedRailTransfers;
    check(board(tb, Q) === 7 && observed.counters.confirmedRailTransfers === confirmed,
      'observer: mixed unknown provenance never invents confirmed transfer boardings');
    // Rerouting invalidates disposable provenance, even if the new route retains its old native queue shape.
    tb.cargo.clear(); tb.load = 0;
    ta.cargo.set('reroute-probe', { from: A.id, alight: H.id, dest: B.id, count: 2, day: g.day }); ta.load = 2;
    ta.serveStation(H, 0.03); g.lines.rebuild();
    check(board(tb, Q) === 2 && observed.counters.confirmedRailTransfers === confirmed,
      'observer: a route rebuild cannot retain guessed queue history');
    f.b.patterns = [{ id: 77, name: 'Invalid flags fall back natively', kind: 'local', stops: [false, false], ids: [...f.b.stops] }]; tb.pattern = 77;
    const fallback = inspectDetachedRoutes(save(g));
    check(fallback.calls.filter(c => c.line === f.b.id).length === 2 && fallback.calls.filter(c => c.line === f.b.id).every(c => c.ok),
      'observer: detached routing uses the native fewer-than-two-stations pattern fallback');
    f.b.stops = [Q.id, B.id, Q.id, B.id];
    f.b.patterns[0].stops = [true, false, true, true]; f.b.patterns[0].ids = [...f.b.stops];
    const repeated = inspectDetachedRoutes(save(g));
    check(repeated.calls.filter(c => c.line === f.b.id).length === 2 && repeated.calls.filter(c => c.line === f.b.id).every(c => c.ok),
      'observer: adjacent repeated short-turn calls retain actual next distinct native station');
    while (g.day < 240) g.update(0.25);
    const connected = networkSnapshot(g, observed);
    check(connected.railServiceByPublicComplex.operatingLines.length === 2
      && connected.railServiceByPublicComplex.components.length === 1
      && connected.railServiceByPublicComplex.components[0].lines.length === 2,
      'observer: both actually operating rail lines belong to one public service component');
    check(connected.railServiceByPhysicalStation.components.length === (walking ? 2 : 1)
      && connected.physicalComponents.length === (walking ? 2 : 1),
      'observer: walking joins service components without inventing a physical rail join');
    const json = save(g); observed.dispose();
    check(save(g) === json && !Object.hasOwn(g, 'recordStop') && !Object.hasOwn(ta, 'serveStation'), 'observer: disposal restores native methods without world changes');
  }
}

function rekeyChecks() {
  const f = transferFixture(false), literal = deserialize(JSON.parse(save(f.g)));
  const twin: typeof f = { g: literal, A: literal.stations.get(f.A.id)!, H: literal.stations.get(f.H.id)!,
    Q: literal.stations.get(f.Q.id)!, B: literal.stations.get(f.B.id)!, a: literal.lines.get(f.a.id)!, b: literal.lines.get(f.b.id)!,
    ta: literal.vehicles.get(f.ta.id) as Train, tb: literal.vehicles.get(f.tb.id) as Train };
  const observed = observeNetwork(f.g);
  check(save(f.g) === save(literal), 'observer rekey: independent native paid fixture initially byte-exact');
  const both = <T>(act: (world: typeof f) => T): T => {
    const result = act(f), plain = act(twin);
    check(save(f.g) === save(literal), 'observer rekey: complete native world equals literal before counter comparisons');
    check(JSON.stringify(result) === JSON.stringify(plain), 'observer rekey: native return/result equals literal');
    return result;
  };
  const enqueue = (count: number) => both(({ g, A, H, B, ta }) => {
    // Declared passenger fixture, as in classificationChecks; native paid vehicles perform the handoff.
    ta.cargo.clear(); ta.cargo.set('rekey-probe', { from: A.id, alight: H.id, dest: B.id, count, day: g.day }); ta.load = count;
    ta.serveStation(H, 0.03);
    return [...H.waiting.values()].find(w => w.line === f.b.id)?.count;
  });
  const deliver = () => both(({ tb, B }) => tb.serveStation(B, 0.03));

  enqueue(12);
  check(both(({ g, H, b }) => {
    const group = [...H.waiting.values()].find(w => w.line === b.id)!;
    g.stations.rekeyWaiting(H);
    return H.waiting.size === 1 && [...H.waiting.values()][0] === group && group.count === 12;
  }), 'observer rekey: native no-op retains the exact live twelve-rider group');
  check(both(({ tb, H }) => board(tb, H)) === 12 && observed.counters.confirmedRailTransfers === 12,
    'observer rekey: native no-op cannot erase twelve confirmed second boardings');
  deliver();

  enqueue(6);
  both(({ g, H, A, a, ta }) => g.stations.addWaiting(H, a.id, A.id, A.id, ta.capacity + 3));
  check(both(({ g, H, b, ta }) => {
    const group = [...H.waiting.values()].find(w => w.line === b.id)!;
    const taken = board(ta, H); // Partial boarding of the OTHER line invokes native rekeyWaiting.
    return taken === ta.capacity && [...H.waiting.values()].includes(group) && group.count === 6
      && [...H.waiting.values()].some(w => w.line === ta.lineId && w.count === 3);
  }), 'observer rekey: unrelated native partial boarding leaves the known transfer object/count unchanged');
  check(both(({ tb, H }) => board(tb, H)) === 6 && observed.counters.confirmedRailTransfers === 18,
    'observer rekey: unrelated partial boarding cannot erase six known rail transfers');
  deliver();

  enqueue(12);
  both(({ tb, Q, B, g }) => {
    const count = tb.capacity - 4;
    tb.cargo.set('declared-room-fixture', { from: Q.id, alight: B.id, dest: B.id, count, day: g.day }); tb.load = count;
  });
  check(both(({ tb, H }) => board(tb, H)) === 4 && observed.counters.confirmedRailTransfers === 22,
    'observer rekey: actual partial boarding captures four before native queue rekey');
  check(both(({ H, b }) => [...H.waiting.values()].find(w => w.line === b.id)!.count) === 8,
    'observer rekey: remaining known cohort is CURRENTLY eight, not its older twelve-rider ceiling');
  deliver();
  both(({ g, H, b }) => {
    const known = [...H.waiting.values()].find(w => w.line === b.id)!;
    g.stations.addWaiting(H, known.line, known.alight, known.dest, 2, 0, known.t, 4, known.rail ?? 0, known.ic ?? 0);
    const unknown = [...H.waiting.values()].find(w => w.line === b.id && w !== known)!;
    // Controlled stale-class metadata, not a native-emergence claim: native rekey itself must merge
    // the two unknown riders into the surviving known object. No provenance internals are accessed.
    unknown.transfers = (known.transfers ?? 0) * unknown.count / known.count;
    g.stations.rekeyWaiting(H);
    return known.count;
  });
  check(both(({ H, b }) => [...H.waiting.values()].filter(w => w.line === b.id).map(w => w.count)).join(',') === '10',
    'observer rekey: real native merge changes the surviving eight-rider object to ten');
  check(both(({ tb, H }) => board(tb, H)) === 10 && observed.counters.confirmedRailTransfers === 22,
    'observer rekey: partial12→8 then merge2→10 never inherits the old twelve-rider provenance ceiling');
  deliver();

  enqueue(3);
  both(({ g, H, b }) => {
    const group = [...H.waiting.values()].find(w => w.line === b.id)!;
    group.rail = (group.rail ?? 0) + 1; // Explicit changed-signature negative.
    g.stations.rekeyWaiting(H);
  });
  check(both(({ tb, H }) => board(tb, H)) === 3 && observed.counters.confirmedRailTransfers === 22,
    'observer rekey: changed fare signature remains unattributed after native key movement');
  deliver();

  enqueue(3);
  check(both(({ g, H, b }) => {
    const [key, group] = [...H.waiting].find(([, w]) => w.line === b.id)!;
    group.transfers = (group.transfers ?? 0) + group.count * 2;
    g.stations.rekeyWaiting(H);
    return H.waiting.get(key) !== group && [...H.waiting.values()].includes(group) && group.count === 3;
  }), 'observer rekey: nonmerging native key movement preserves the same object/count/signature');
  check(both(({ tb, H }) => board(tb, H)) === 3 && observed.counters.confirmedRailTransfers === 25,
    'observer rekey: unchanged unmerged riders retain their known origin across a native key move');
  deliver();
  const final = save(f.g); observed.dispose();
  check(save(f.g) === final && final === save(literal), 'observer rekey: final full world and disposal remain byte-exact');
}

function movementChecks() {
  const { g } = transferFixture(false), observed = observeNetwork(g);
  while (g.day < 240) g.update(0.25);
  const report = networkSnapshot(g, observed), summary = observed.summary();
  check(report.companies.some(c => c.operatingTrains.length > 0) && observed.calls.size > 0,
    'observer: a fully native operating window records genuine paid train calls');
  check(summary.edges.some(e => e.trains.length > 0) && summary.operatorKm.some(x => x.foreignKm > 0),
    'observer: actual native whole-edge passages identify trains and foreign rail use');
  check(report.observedUsedJoins.some(j => j.kind === 'ownership-seam')
    && report.observedUsedJoins.every(j => j.arms.every(id => g.world.net.edges.get(id)?.depot === -1)),
    'observer: actually traversed owner seam is a physical join; depot throat is not a branch');
  observed.dispose();
  const crossing = flatGame();
  check(!!build(crossing, free(crossing, 25, 60), free(crossing, 225, 60), railOpts(0, 1, { crossing: 'level' }))
    && !!build(crossing, free(crossing, 128, 20), free(crossing, 128, 95), railOpts(0, 1, { crossing: 'level' })),
    'observer: native paid diamond crossing fixture builds');
  const diamond = networkSnapshot(crossing);
  check(crossing.world.net.crossings.size > 0 && diamond.physicalComponents.length === 2 && diamond.observedUsedJoins.length === 0,
    'observer: a diamond crossing cannot invent a physical rail connection');
}
function neutralityChecks() {
  const make = () => Game.create({ size: 384, seed: 5, towns: 9, hilliness: 'hilly', water: 'medium', startYear: 1985, aiCompanies: 3 });
  const literal = make(), watched = make(), observed = observeNetwork(watched);
  check(save(literal) === save(watched), 'observer: independent native fresh worlds initially match');
  let monthlyExact = true;
  for (let day = 1; day <= 120; day++) {
    while (literal.day < day) literal.stepTick();
    while (watched.day < day) watched.stepTick();
    if (day % 30 === 0) {
      networkSnapshot(watched, observed);
      monthlyExact &&= save(literal) === save(watched);
    }
  }
  check(monthlyExact && save(literal) === save(watched), 'observer: absent/present native AI worlds are byte-exact at all four monthly checkpoints and final');
  const detached = deserialize(JSON.parse(save(watched))), replay = observeNetwork(detached);
  let exact = true;
  for (let i = 0; i < 128; i++) { watched.stepTick(); detached.stepTick(); exact &&= save(watched) === save(detached); }
  check(exact, 'observer: JSON-detached cold save replays every one of128native ticks exactly');
  observed.dispose(); replay.dispose();
}

function forwardingChecks() {
  const { g, ta, H } = transferFixture(false), marker = {}, thrown = new Error('observer native throw');
  const original = g.recordStop;
  let callCount = 0, throwNow = false, exactArgs = true;
  g.recordStop = function(...args: Parameters<Game['recordStop']>) {
    callCount++; exactArgs &&= this === g && args.length === 2 && args[0] === ta && args[1] === H;
    if (throwNow) throw thrown;
    return marker;
  };
  const observed = observeNetwork(g);
  check((g.recordStop as unknown as (...args: unknown[]) => unknown)(ta, H) === marker && callCount === 1 && exactArgs,
    'observer: original this/argument identities/return are preserved exactly once');
  throwNow = true; let error: unknown;
  try { g.recordStop(ta, H); } catch (e) { error = e; }
  check(error === thrown && callCount === 2 && exactArgs, 'observer: original throw identity propagates without retry');
  observed.dispose(); delete (g as unknown as { recordStop?: unknown }).recordStop;
  check(g.recordStop === original, 'observer: inherited native function restored after custom-reader control');

  const f = transferFixture(false), stations = f.g.stations, nativeRekey = stations.rekeyWaiting;
  const descriptor = Object.getOwnPropertyDescriptor(stations, 'rekeyWaiting'), extra = {}, rekeyMarker = {}, rekeyThrow = new Error('observer rekey throw');
  let rekeys = 0, failRekey = false, rekeyArgs = true;
  const forward = function(this: typeof stations, ...args: Parameters<typeof stations.rekeyWaiting>) {
    const passed: unknown[] = args;
    rekeys++; rekeyArgs &&= this === stations && passed.length === 2 && passed[0] === f.H && passed[1] === extra;
    if (failRekey) throw rekeyThrow;
    nativeRekey.apply(this, args);
    return rekeyMarker;
  };
  Object.defineProperty(stations, 'rekeyWaiting', { configurable: true, writable: true, value: forward });
  const rekeyObserved = observeNetwork(f.g);
  try {
    f.ta.cargo.set('throw-probe', { from: f.A.id, alight: f.H.id, dest: f.B.id, count: 2, day: f.g.day }); f.ta.load = 2;
    f.ta.serveStation(f.H, 0.03);
    const call = stations.rekeyWaiting as unknown as (...args: unknown[]) => unknown, before = save(f.g);
    check(call.call(stations, f.H, extra) === rekeyMarker && rekeys === 1 && rekeyArgs,
      'observer rekey: native delegate this/all arguments/return are forwarded exactly once');
    check(save(f.g) === before, 'observer rekey: forwarding a native no-op changes no saved state');
    failRekey = true; let caught: unknown;
    try { call.call(stations, f.H, extra); } catch (e) { caught = e; }
    check(caught === rekeyThrow && rekeys === 2 && rekeyArgs, 'observer rekey: original throw identity propagates once without retry');
    check(save(f.g) === before, 'observer rekey: throwing delegate leaves the native queue/world untouched');
    check(board(f.tb, f.H) === 2 && rekeyObserved.counters.confirmedRailTransfers === 0,
      'observer rekey: an incomplete throwing rekey does not restore guessed provenance');
  } finally {
    rekeyObserved.dispose();
    check(stations.rekeyWaiting === forward, 'observer rekey: disposal restores the original own delegate');
    if (descriptor) Object.defineProperty(stations, 'rekeyWaiting', descriptor);
    else delete (stations as unknown as { rekeyWaiting?: unknown }).rekeyWaiting;
  }
  check(stations.rekeyWaiting === nativeRekey, 'observer rekey: forwarding fixture restores native inherited method');
}

function snapshots() {
  const paths = process.argv.find(a => a.startsWith('--snapshots='))!.slice(12).split(',');
  const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (out) mkdirSync(out, { recursive: true });
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  for (const path of paths) {
    const input = readFileSync(path, 'utf8');
    const literal = deserialize(JSON.parse(input)), g = deserialize(JSON.parse(input));
    const initial = save(g), start = g.day, observed = observeNetwork(g);
    const monthly: { day: number; exact: boolean; hash: string; safety: string[]; network: ReturnType<typeof networkSnapshot> }[] = [];
    let exact = save(literal) === initial;
    const initialSettings = { aiEnabled: g.aiEnabled, ambientEnabled: g.vehicles.ambientEnabled, acquisitions: g.aiAcquisitions };
    const started = performance.now();
    console.log(`START snapshot seed${g.options.seed} day${start} ->${start + 360}; Node${process.version}; ${Buffer.byteLength(input)}B input SHA${hash(input)}`);
    for (let next = start + 30; next <= start + 360; next += 30) {
      while (literal.day < next) literal.update(0.25);
      while (g.day < next) g.update(0.25);
      const a = save(literal), b = save(g), match = a === b;
      exact &&= match;
      const safety = checkReservations(g);
      monthly.push({ day: g.day, exact: match, hash: hash(b), safety, network: networkSnapshot(g, observed) });
      console.log(`  seed${g.options.seed} day${g.day}: exact=${match}, calls=${observed.calls.size}, confirmed rail transfers=${observed.counters.confirmedRailTransfers}, ${((performance.now() - started) / 1000).toFixed(1)}s`);
      if (out) writeFileSync(join(out, `seed-${g.options.seed}-progress.json`), JSON.stringify({ input: path, inputSHA256: hash(input), monthly, elapsedSeconds: (performance.now() - started) / 1000 }, null, 2));
      if (!match) throw Error(`Observer changes native full save at seed${g.options.seed}/day${g.day}`);
    }
    const full = save(g), unobserved = save(literal), summary = networkSnapshot(g, observed);
    exact &&= full === unobserved;
    const report = { sourceLabel: process.argv.find(a => a.startsWith('--source-label='))?.slice(15) ?? 'record source revision externally', input: path, inputSHA256: hash(input), inputBytes: Buffer.byteLength(input), options: g.options,
      initialSettings, finalSettings: { aiEnabled: g.aiEnabled, ambientEnabled: g.vehicles.ambientEnabled, acquisitions: g.aiAcquisitions },
      startDay: start, endDay: g.day, fixedDays: 360, runtime: process.version, exact, monthly, summary, observations: observed.summary(),
      finalBytes: Buffer.byteLength(full), finalSHA256: hash(full), routes: inspectDetachedRoutes(full), elapsedSeconds: (performance.now() - started) / 1000 };
    if (out) {
      writeFileSync(join(out, `seed-${g.options.seed}-observed-final.json`), full);
      writeFileSync(join(out, `seed-${g.options.seed}-literal-final.json`), unobserved);
      writeFileSync(join(out, `seed-${g.options.seed}-operating-report.json`), JSON.stringify(report, null, 2));
    } else console.log(JSON.stringify(report));
    check(exact, `seed${g.options.seed}: every monthly/final native fullsave equals the unobserved twin`);
    check(monthly.every(m => m.safety.length === 0), `seed${g.options.seed}: native reservations remain safe at all12checkpoints`);
    check(report.routes.omitted === 0, `seed${g.options.seed}: detached route report is complete`);
    console.log(`CLEAR snapshot seed${g.options.seed}: exact=${exact}, finalSHA${report.finalSHA256}, ${(report.elapsedSeconds).toFixed(1)}s`);
    observed.dispose();
  }
}

function natural() {
  const balanced = process.argv.includes('--balanced');
  const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (out) mkdirSync(out, { recursive: true });
  // Fixed seeds/window were declared before observing outcomes. Balanced complements the existing focused cohort.
  const seeds = balanced ? [5] : NETWORK_COHORT.seeds;
  for (const seed of seeds) {
    // Balanced mode reproduces the original literal runner's option insertion order; every cohort uses exact ticks.
    const options = balanced ? { seed, size: 512, towns: 12, startYear: 1985, hilliness: 'hilly' as const, water: 'medium' as const, aiCompanies: 5 }
      : { size: 512, seed, towns: 12, hilliness: 'hilly' as const, water: 'medium' as const, startYear: 1985, aiConfigs: NETWORK_COHORT.aiConfigs };
    const g = Game.create(options);
    if (!balanced) g.aiAcquisitions = NETWORK_COHORT.acquisitions;
    const observed = observeNetwork(g), monthly: { day: number; reservations: string[]; nonFinite: string | null; network: ReturnType<typeof networkSnapshot> }[] = [];
    let day = -1;
    const started = performance.now();
    while (g.day < 6 * 360) {
      g.stepTick();
      if (g.day !== day) {
        day = g.day;
        if (day > 0 && day % 30 === 0) monthly.push({ day, reservations: checkReservations(g), nonFinite: checkNaN(g), network: networkSnapshot(g, observed) });
        if (out && day > 0 && day % 360 === 0) writeFileSync(join(out, `seed-${seed}-day-${day}.json`), save(g));
      }
    }
    const full = save(g), summary = networkSnapshot(g, observed), routes = inspectDetachedRoutes(full);
    const comparison = process.argv.find(a => a.startsWith('--compare='))?.slice(10);
    const reference = comparison ? readFileSync(comparison, 'utf8') : undefined;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const report = { config: options, acquisitions: g.aiAcquisitions, years: 6, node: process.version, forceBuild: false,
      summary, observations: observed.summary(), routes, monthly, operatingSeconds: (performance.now() - started) / 1000,
      finalBytes: Buffer.byteLength(full), finalSHA256: hash(full),
      literalReference: reference === undefined ? null : { file: comparison, bytes: Buffer.byteLength(reference), sha256: hash(reference), exact: reference === full },
      allStockCallsRoutable: routes.omitted === 0 && routes.calls.every(c => c.ok),
      allOriginalAIHaveOperatingRail: summary.companies.every(c => !c.defunct && c.operatingTrains.length > 0) };
    console.log(JSON.stringify(report));
    if (out) { writeFileSync(join(out, `seed-${seed}-final.json`), full); writeFileSync(join(out, `seed-${seed}-report.json`), JSON.stringify(report, null, 2)); }
    if (reference !== undefined) check(reference === full, `seed${seed}: complete native final save equals the frozen literal reference`);
    check(monthly.every(m => m.reservations.length === 0 && m.nonFinite === null), `seed${seed}: all monthly native reservation and finite-position checks pass`);
    check(routes.omitted === 0, `seed${seed}: route inspection covers all actual stock/pattern call classes`);
    check(routes.calls.every(c => c.ok), `seed${seed}: every actual stock/pattern directed call has a legal full-consist route`);
    check(g.ais.every(ai => !(ai as unknown as { errorLogged: boolean }).errorLogged), `seed${seed}: no native AI errors`);
    // Economic emergence is reported candidly, never forced by an outcome-derived minimum or hidden seed filter.
    observed.dispose();
  }
}

if (process.argv.some(a => a.startsWith('--compare=')) && (!process.argv.includes('--natural') || !process.argv.includes('--balanced'))) throw Error('--compare requires --natural --balanced');
if (process.argv.some(a => a.startsWith('--snapshots='))) snapshots();
else if (process.argv.includes('--natural')) natural();
else { classificationChecks(); rekeyChecks(); movementChecks(); forwardingChecks(); neutralityChecks(); }
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
