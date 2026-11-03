// Positive HSR construction/replay proof, using aiops.ts's existing controlled fixture.
// Its 300M balance and forceBuild bypass are NOT evidence of affordability or payback.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { railPartMode } from '../src/game/stations';
import { platformChoices } from '../src/game/rail-platforms';
import type { Town } from '../src/game/towns';
import { checkReservations, checkNaN } from './lib';
import { terrainFit, fitLine } from './terrainfit';

let checks = 0;
function check(ok: unknown, label: string): asserts ok { assert(ok, label); checks++; }
const saved = (g: Game) => JSON.stringify(serialize(g));
const MAX_PAIRS = 5, MAX_PROJECT_DAYS = 180, MAX_CHECKPOINTS = 256, OPERATING_TICKS = 128;

const g = Game.create({ size: 768, seed: 11, towns: 16, hilliness: 'flat', water: 'low', startYear: 2000,
  aiConfigs: [{ startMoney: 300_000_000 }] });
g.aiAcquisitions = false;
const owner = g.ais[0].companyId;
(g.ais[0] as any).state.cooldown = 1e9;
let h = deserialize(JSON.parse(saved(g)));
const beforeFit = terrainFit(g);

// Keep exactly the original aiops candidate order, distance range and five-pair cap.
const towns = [...g.towns.list].sort((a, b) => b.pop - a.pop), pairs: [Town, Town][] = [];
for (const a of towns) for (const b of towns) {
  if (a.id >= b.id || Math.min(a.pop, b.pop) < 1500) continue;
  const distance = Math.hypot(a.x - b.x, a.z - b.z);
  if (distance >= 400 && distance <= 520) pairs.push([a, b]);
}
pairs.sort((a, b) => b[0].pop * b[1].pop - a[0].pop * a[1].pop);
check(pairs.length > 0, 'existing native HSR fixture has eligible town pairs');

function frame(world: Game) {
  const ai = world.ais[0] as any;
  let task = ai.railOpening;
  while (task?.child) task = task.child;
  return { ai, task, phase: task?.phase ?? 'done' };
}
/** Small native action ledger for EVERY fixed tick; full world equality is checked at saved boundaries below. */
function ledger(world: Game) {
  const { ai, task, phase } = frame(world);
  return JSON.stringify({ tick: world.tick, day: world.day, rng: world.rng.state, busy: ai.busy, phase,
    state: ai.state, project: ai.project, watch: ai.watch, stats: ai.stats,
    progress: task && { units: task.units, end: task.end, station: task.paid?.index, chain: task.chain?.phase,
      waypoint: task.chain?.index, depot: task.depot?.search, depotPhase: task.depot?.cursor?.phase, buy: task.buyIndex },
    economy: world.company(owner).economy.toJSON(),
    stations: [...world.stations.map.values()].filter(s => s.owner === owner).map(s => ({ id: s.id, rail: s.rail })),
    edges: [...world.world.net.edges.values()].filter(e => e.owner === owner).map(e => ({ id: e.id, a: e.a, b: e.b,
      kind: e.kind, type: e.type, len: e.len, station: e.station, depot: e.depot, sections: e.sections })),
    depots: [...world.depots.map.values()].filter(d => d.owner === owner),
    lines: [...world.lines.map.values()].filter(l => l.owner === owner),
    trains: world.vehicles.trains().filter(t => t.owner === owner).map(t => ({ id: t.id, cars: t.cars.map(c => c.id),
      line: t.line, depot: t.depotId, pattern: t.pattern, stop: t.stopIndex, state: t.state, speed: t.speed, onMap: t.onMap })) });
}
/** A native payment/asset change must also become a cold full-world checkpoint, even within one phase. */
function actions(world: Game) {
  const economy = world.company(owner).economy;
  return JSON.stringify({ construction: economy.thisYear.construction, vehicles: economy.thisYear.vehicles, loan: economy.loan,
    stations: [...world.stations.map.values()].filter(s => s.owner === owner).map(s => s.id),
    edges: [...world.world.net.edges.values()].filter(e => e.owner === owner).map(e => [e.id, e.type]),
    depots: [...world.depots.map.values()].filter(d => d.owner === owner).map(d => d.id),
    lines: [...world.lines.map.values()].filter(l => l.owner === owner).map(l => [l.id, l.stops, l.vehicles]) });
}

let checkpoints = 0, ticks = 0;
const phases = new Set<string>(), paidPhases = new Set<string>(), witnesses = new Set<string>();
function checkpoint(label: string) {
  check(++checkpoints <= MAX_CHECKPOINTS, 'native HSR checkpoint inventory stays bounded');
  const bytes = saved(g);
  check(bytes === saved(h), `${label}: complete live/cold world equality`);
  h = deserialize(JSON.parse(bytes));
  check(bytes === saved(h) && bytes === saved(g), `${label}: immediate JSON reload is exact and leaves the live world untouched`);
  check(!checkReservations(g).length && !checkNaN(g), `${label}: native positions and reservations are valid`);
}

const originalForceBuild = AIController.forceBuild;
let opened = false, attempts = 0;
try {
  AIController.forceBuild = true;
  for (const [a, b] of pairs.slice(0, MAX_PAIRS)) {
    attempts++;
    check((g.ais[0] as any).startProject('hsr', [a.id, b.id]) && (h.ais[0] as any).startProject('hsr', [a.id, b.id]),
      'same existing candidate starts in both native worlds');
    const seen = new Set<string>();
    checkpoint(`pair ${attempts}: synchronous handoff`);
    let previousActions = actions(g), projectTicks = 0;
    while (g.ais[0].busy) {
      check(projectTicks++ < MAX_PROJECT_DAYS * g.ticksPerDay, 'native HSR planning/construction terminates within the declared bound');
      g.stepTick(); h.stepTick(); ticks++;
      check(ledger(g) === ledger(h), `tick ${g.tick}: native actions, payments and busy state match`);
      check(!checkReservations(g).length && !checkNaN(g), `tick ${g.tick}: native HSR movement and reservations stay valid`);
      const { task, phase } = frame(g), action = actions(g), newPhase = !seen.has(phase);
      phases.add(phase);
      if (task?.paid) {
        paidPhases.add(phase);
        if (phase === 'stationAccess' && g.stations.all().some(s => s.owner === owner)) witnesses.add('station payment');
        if (phase === 'chainWork' && [...g.world.net.edges.values()].some(e => e.id >= task.chainInputs?.e0
          && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0)) witnesses.add('paid chain');
        if (g.depots.all().some(d => d.owner === owner)) witnesses.add('paid depot');
        if (phase === 'fleetStart' && task.timetable?.line) witnesses.add('wired timetable');
        if (phase === 'fleetBuy' && g.vehicles.trains().some(t => t.owner === owner)) witnesses.add('paid HSR stock');
      }
      if (newPhase || action !== previousActions) {
        checkpoint(`pair ${attempts}, day ${g.day}, ${phase}${action !== previousActions ? ' payment/asset change' : ''}`);
        seen.add(phase);
      }
      previousActions = action;
    }
    check(!h.ais[0].busy, 'both native HSR openings finish on exactly the same tick');
    console.log(`candidate ${attempts}: ${a.name}–${b.name}, ${projectTicks} exact fixed ticks, ${g.ais[0].log.at(-1)}`);
    if ([...g.lines.map.values()].some(l => l.owner === owner && l.kind === 'rail')) { opened = true; break; }
  }
  check(opened, 'one of the original five native candidates really opens a high-speed railway');
  checkpoint('completed positive HSR opening');
  const line = [...g.lines.map.values()].find(l => l.owner === owner && l.kind === 'rail')!;
  const stations = [...new Set(line.stops)].map(id => g.stations.get(id)!);
  const trains = line.vehicles.map(id => g.vehicles.get(id)).filter((t): t is Train => t instanceof Train);
  check(stations.length === 2 && stations.every(s => s.rail?.trackType === 'electric' && railPartMode(s.rail) === 'mainline'),
    'paid HSR opening retains both wired mainline platforms');
  check(trains.length > 0 && trains.every(t => t.cars[0].id.startsWith('hsr')), 'native HSR units are actually purchased');
  const firstPattern = line.patterns?.[0]?.id ?? 0;
  check(trains.every(t => line.stops.every((_, i) => platformChoices(g, line, t.pattern ?? firstPattern, i).length > 0)),
    'actual full-consist HSR stock has a lawful platform at every timetable call');
  const economy = g.company(owner).economy, stockPrice = trains.reduce((n, t) => n + t.madeUp.reduce((s, c) => s + c.cost, 0), 0);
  check(economy.thisYear.construction < 0 && -economy.thisYear.vehicles === stockPrice && economy.money < 300_000_000,
    'native construction and the complete purchased HSR stock are really charged');
  for (const witness of ['station payment', 'paid chain', 'paid depot', 'wired timetable', 'paid HSR stock'])
    check(witnesses.has(witness), `cold paid construction actually witnesses ${witness}`);
  for (const phase of ['stationCheck', 'stationAccess', 'chainWork', 'depotSearch', 'accessPair', 'fleetStart', 'fleetBuy'])
    check(paidPhases.has(phase), `positive HSR cold replay covers paid ${phase}`);
  const fit = terrainFit(g);
  check(fit.station === 0 && fit.covered <= beforeFit.covered && fit.floating <= beforeFit.floating,
    `native HSR construction introduces no actual-width support failures: ${fitLine(fit)}`);
  for (let tick = 1; tick <= OPERATING_TICKS; tick++) {
    g.stepTick(); h.stepTick();
    check(ledger(g) === ledger(h) && !checkReservations(g).length && !checkNaN(g), `operating tick ${tick}: exact native HSR ledger and safety`);
    if (tick === 64 || tick === OPERATING_TICKS) checkpoint(`operating tail ${tick}`);
  }
  check(trains.some(t => t.onMap) && trains.every(t => t.state !== 'noroute'), 'paid HSR stock enters its real railway without invalid routes');
  console.log(`positive HSR: ${attempts} candidate(s), ${ticks} fixed ticks, ${phases.size} phases (${paidPhases.size} paid), ${checkpoints} complete cold checkpoints, ${OPERATING_TICKS} operating ticks`);
  console.log(`support: ${fitLine(fit)}`);
  console.log(`ALL CHECKS PASSED (${checks})`);
} finally {
  AIController.forceBuild = originalForceBuild;
}
