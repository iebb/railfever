// Operating costs. Per vehicle and month: a fixed overhead (30% of its models' `running`: depots, insurance,
// administration — also while it stands in a depot), crew wages for its time in service (a driver per train, bus or
// tram, a fireman on steam, conductors on long-distance trains), vehicle maintenance per car-km rising with speed
// plus time-based upkeep, and energy from the physics: traction energy at the wheels / efficiency (electric 0.85,
// diesel 0.35, steam 0.07), hotel load, regenerative braking on electric stock, at era prices. Tracks: a base
// maintenance per unit (wire upkeep when electrified) plus wear per train passage (axle load x (v/160)^2),
// recorded per edge and billed monthly to the owner; track-access usage is metered by that wear.
//
// Calibration: under its kind's typical duty (in service all year, stops at the usual spacing) a consist costs
// about what its models' `running` said (the time-based upkeep takes the remainder, at least 10%), so the old
// balance holds while costs follow use: idle vehicles cost the overhead, fast and far-running ones pay energy,
// maintenance and wear. Distances: 1 km = 100 units, run at real speed in sim seconds (a game year is YEAR_S).
import type { Game } from './game';
import type { Vehicle } from './vehicle';
import { aeroOf } from './vehicle-types';
import type { VehicleModel } from './vehicle-types';
import type { NEdge } from './network';
import { TRACK_TYPES, ROAD_TYPES, DAY_SECONDS, DAYS_PER_MONTH, MONTHS_PER_YEAR, UNIT_M, MAIL_UNIT_T } from './constants';
import { simNow } from './fares';

/** Sim seconds in a game year (a vehicle in service all year runs this long). */
export const YEAR_S = DAY_SECONDS * DAYS_PER_MONTH * MONTHS_PER_YEAR;
/** Fixed overhead: this share of the models' yearly `running`, every month, in service or not. */
export const OVERHEAD_SHARE = 0.3;
/** Time-based vehicle upkeep at least this share of `running` (per year in service). */
export const TIME_MAINT_MIN = 0.1;
/** Wages per crew member for a year in service (1980 wages). */
export const CREW_PER_YEAR = 12_500;
/** Maintenance per car unit and km at 160 km/h (loco 2, steam loco 3, coach 1, EMU car 1.15, HSR car 1.35, bus 0.8). */
export const MAINT_PER_CAR_KM = 400;
/** Energy prices per kWh of source energy (electricity at the substation, diesel fuel, coal) in 1980; see ERA_INDEX. */
export const ENERGY_PRICE = { electric: 100, diesel: 65, steam: 20 };
/** Wheel energy / source energy. */
export const EFFICIENCY = { electric: 0.85, diesel: 0.35, steam: 0.07 };
/** Electric stock feeds back this share of its braking energy (about 20% of the traction energy in stop-and-go service). */
export const REGEN_SHARE = 0.3;
/** Mass of a passenger (tonnes). */
export const PAX_T = 0.075;
/** A vehicle's load in passenger masses (PAX_T): its passengers and its mail (MAIL_UNIT_T a unit). */
export function loadOf(v: { load: number; mailLoad: number }): number { return v.mailLoad ? v.load + (v.mailLoad * MAIL_UNIT_T) / PAX_T : v.load; }
/** Track wear per unit of track per passage of one axle-load unit (16 t) at 160 km/h. */
export const WEAR_RATE = 0.25;
/** Base track maintenance (per unit and year) as a share of TRACK_TYPES.maintPerUnit (the rest comes from wear). */
export const TRACK_BASE_SHARE = 0.75;
/** Minimum base maintenance relative to plain track; wired aliases share catenary upkeep. */
export const TRACK_TYPE_FACTOR: Record<string, number> = { standard: 1, electric: 1.25, highspeed: 1.25, metro: 1.25, lightrail: 1.25 };

type Source = 'electric' | 'diesel' | 'steam';
/** Price / wage indices by year (1980 = 1), interpolated. */
const ERA_INDEX: Record<Source | 'wage', [number, number][]> = {
  electric: [[1880, 1.8], [1920, 1.3], [1950, 1.0], [1980, 1.0], [2000, 0.9], [2022, 1.15], [2100, 1.2]],
  diesel: [[1880, 0.7], [1950, 0.55], [1972, 0.5], [1974, 0.9], [1980, 1.0], [1985, 0.95], [1987, 0.6], [2000, 0.6], [2005, 0.85], [2008, 1.1], [2014, 1.05], [2016, 0.75], [2022, 1.0], [2100, 1.2]],
  steam: [[1880, 0.8], [1945, 1.0], [1980, 1.0], [2100, 1.3]],
  wage: [[1880, 0.55], [1920, 0.7], [1950, 0.85], [1980, 1.0], [2000, 1.1], [2025, 1.2], [2100, 1.4]],
};
export function eraIndex(kind: Source | 'wage', year: number): number {
  const t = ERA_INDEX[kind];
  if (year <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (year <= t[i][0]) { const [y0, a] = t[i - 1], [y1, b] = t[i]; return a + ((b - a) * (year - y0)) / (y1 - y0); }
  return t[t.length - 1][1];
}
/** Price of one kWh of the source energy (game money) in `year`. */
export function energyPrice(src: Source, year: number): number { return ENERGY_PRICE[src] * eraIndex(src, year); }

// ------------------------------------------------------------------------------ consists (physics for estimates)
/** What the cost model needs to know about a train or road vehicle. */
export interface Consist {
  /** empty mass (t), installed power (kW), top speed (km/h), length (m), seats */
  mass: number; power: number; vmax: number; lengthM: number; seats: number;
  /** maintenance car units, axles and axle-load units (sum of axle loads / 16 t) */
  carUnits: number; axles: number; axleUnits: number;
  traction: Source;
  road: boolean;
  /** aerodynamic coefficient (N per (m/s)^2) and hotel load (kW) */
  aero: number; auxKw: number;
  /** driven mass (t): adhesion limit of a locomotive-hauled train */
  drivenMass: number;
  /** crew needed (by era): see crewCount */
  kind: 'bus' | 'coach' | 'tram' | 'metro' | 'commuter' | 'hsr' | 'loco';
  steam: boolean; coaches: number; cars: number;
  /** yearly `running` of the models */
  running: number;
}

const consistCache = new Map<string, Consist>();

/** Cars of a model for maintenance (an EMU counts each of its cars). */
function carUnitsOf(m: VehicleModel): number {
  if (m.kind === 'loco') return m.traction === 'steam' ? 3 : 2;
  if (m.kind === 'wagon') return 1;
  if (m.kind === 'emu') return (m.unitCars ?? 1) * (m.speed >= 200 ? 1.35 : 1.15);
  if (m.kind === 'tram') return 1 + 0.35 * ((m.sections ?? 1) - 1);
  return 0.8;
}
function axlesOf(m: VehicleModel): number {
  if (m.kind === 'loco') return m.weight >= 100 ? 6 : 4;
  if (m.kind === 'wagon') return 4;
  if (m.kind === 'emu') return 4 * (m.unitCars ?? 1);
  if (m.kind === 'tram') return 2 * (m.sections ?? 1) + 2;
  return 2;
}

/** The cost-relevant physics of a consist (cached by its models). */
export function consistOf(models: VehicleModel[]): Consist {
  const key = models.map((m) => m.id).join(',');
  const hit = consistCache.get(key);
  if (hit) return hit;
  let mass = 0, power = 0, vmax = Infinity, len = 0, seats = 0, carUnits = 0, axles = 0, axleUnits = 0, aux = 0, driven = 0, running = 0, coaches = 0, cars = 0;
  let traction: Source = 'diesel', steam = false, electric = false, road = false, emu = false, tram = false, coach = false;
  for (const m of models) {
    mass += m.weight; power += m.power; vmax = Math.min(vmax, m.speed); len += m.length * UNIT_M; seats += m.capacity; running += m.running;
    carUnits += carUnitsOf(m);
    const ax = axlesOf(m);
    axles += ax; axleUnits += ax * Math.min(2, m.weight / ax / 16);
    if (m.power > 0) driven += m.weight;
    if (m.traction === 'steam') steam = true;
    if (m.traction === 'electric') electric = true;
    if (m.kind === 'bus') { road = true; if (m.style === 'coach') coach = true; }
    if (m.kind === 'tram') { road = true; tram = true; }
    if (m.kind === 'emu') emu = true;
    if (m.kind === 'wagon') coaches++;
    cars += m.kind === 'emu' ? m.unitCars ?? 1 : 1;
    // hotel load: heating, air conditioning, lighting, doors
    aux += m.kind === 'wagon' ? 15 : m.kind === 'emu' ? (m.unitCars ?? 1) * (m.speed >= 200 ? 22 : 12) : m.kind === 'bus' ? 5 : m.kind === 'tram' ? 4 + 3 * (m.sections ?? 1) : 0;
  }
  if (!isFinite(vmax)) vmax = 60;
  traction = steam ? 'steam' : electric ? 'electric' : 'diesel';
  const fast = vmax >= 200;
  // aerodynamics (as the train physics: vehicle-types aeroOf): the leading vehicle's nose, a term per unit of length
  let aero = tram ? 2.5 + 0.02 * len : 3.2;
  if (!road && models.length) { aero = aeroOf(models[0]).nose; for (const m of models) aero += aeroOf(m).len * m.length; }
  const kind: Consist['kind'] = tram ? 'tram' : road ? (coach ? 'coach' : 'bus') : emu ? (fast ? 'hsr' : vmax <= 115 ? 'metro' : 'commuter') : fast && electric ? 'hsr' : 'loco';
  const c: Consist = { mass, power, vmax, lengthM: len, seats, carUnits, axles, axleUnits, traction, road, aero, auxKw: aux, drivenMass: emu || road ? mass : driven, kind, steam, coaches, cars, running };
  consistCache.set(key, c);
  return c;
}

/** Running resistance (N) at v (m/s) for a total mass (kg): Davis m (a0 + a1 v) + c v^2 (road: tyres + aero). */
export function resistanceN(c: Consist, massKg: number, v: number): number {
  if (c.road) return massKg * (c.kind === 'tram' ? 0.02 + 0.0002 * v : 0.08 + 0.0006 * v) + c.aero * v * v;
  return massKg * (0.0075 + 0.0002 * v) + c.aero * v * v;
}
/** Average acceleration (m/s^2) up to top speed: power-limited (constant power), adhesion-capped. */
export function accelOf(c: Consist, massKg: number): number {
  const v = Math.max(5, c.vmax / 3.6);
  const cap = c.road ? 1.1 : c.kind === 'loco' ? Math.min(0.9, (0.26 * 9.81 * c.drivenMass * 1000) / massKg) : 0.9;
  const resist = resistanceN(c, massKg, v * 0.6) / massKg;
  return Math.max(0.08, Math.min(cap, (2 * 0.9 * c.power * 1000) / (massKg * v)) - resist);
}
/** Service braking (m/s^2). */
export function brakeOf(c: Consist): number { return c.road ? 1.2 : c.vmax >= 250 ? 0.55 : 0.7; }

export interface HopEstimate { t: number; vPeak: number; wheelJ: number; brakeJ: number; auxJ: number }
/**
 * One stop-to-stop hop of `dM` metres from standstill to standstill: running time (s), peak speed (m/s), energy at
 * the wheels, energy dissipated braking and hotel energy (J). `vCapKmh` caps the speed (track / road limits).
 */
export function hopEstimate(c: Consist, dM: number, loadPax = 0, vCapKmh = Infinity): HopEstimate {
  const m = (c.mass + loadPax * PAX_T) * 1000 * 1.06; // rotating masses
  const vmax = Math.max(1, Math.min(c.vmax, vCapKmh) / 3.6);
  const a = accelOf(c, m), b = brakeOf(c);
  const D = Math.max(1, dM);
  let vp = vmax, t: number, dc = 0;
  if (D >= (vmax * vmax) / (2 * a) + (vmax * vmax) / (2 * b)) { dc = D - (vmax * vmax) / (2 * a) - (vmax * vmax) / (2 * b); t = D / vmax + vmax / (2 * a) + vmax / (2 * b); }
  else { vp = Math.sqrt((2 * D * a * b) / (a + b)); t = vp / a + vp / b; }
  const da = (vp * vp) / (2 * a), dd = (vp * vp) / (2 * b);
  const ke = 0.5 * m * vp * vp;
  const rAcc = resistanceN(c, m, vp * 0.6), rDec = resistanceN(c, m, vp * 0.6), rCruise = resistanceN(c, m, vp);
  const wheelJ = ke + rAcc * da + rCruise * dc;
  const brakeJ = Math.max(0, ke - rDec * dd);
  return { t, vPeak: vp, wheelJ, brakeJ, auxJ: c.auxKw * 1000 * t };
}

/** Source energy (kWh) and its cost for wheel / braking / hotel energy (J) of a consist. */
export function energyCost(c: Consist, wheelJ: number, brakeJ: number, auxJ: number, year: number): { kwh: number; cost: number } {
  let J: number;
  if (c.traction === 'electric') J = Math.max(0.15 * wheelJ, wheelJ - REGEN_SHARE * EFFICIENCY.electric * brakeJ) / EFFICIENCY.electric + auxJ / 0.95;
  else J = (wheelJ + auxJ) / EFFICIENCY[c.traction];
  const kwh = Math.max(0, J) / 3.6e6;
  return { kwh, cost: kwh * energyPrice(c.traction, year) };
}

/** Crew on board: a driver; a fireman on steam; conductors on long-distance trains (and on early suburban units). */
export function crewCount(c: Consist, year: number): number {
  if (c.road) return 1;
  let n = 1 + (c.steam ? 1 : 0);
  if (c.kind === 'hsr') n += 1 + Math.floor(c.cars / 8);
  else if (c.kind === 'loco') n += c.coaches >= 3 ? Math.ceil(c.coaches / 5) : 0;
  else if (year < 1975) n += 1; // one-person operation of multiple units from the 1970s
  return n;
}

/** Maintenance factor of running speed: 1 at 160 km/h, 0.35 + 0.65 (v/160)^2 (wheels, bogies, pantographs, brakes). */
export function maintSpeed(kmh: number): number { const r = kmh / 160; return 0.35 + 0.65 * r * r; }
/** Track wear factor of speed: (v/160)^2, at least 0.25 (slow traffic still wears the track). */
export function wearSpeed(kmh: number): number { const r = kmh / 160; return Math.max(0.25, r * r); }

/** Usual stop spacing (km) of a consist's kind (the typical duty the calibration assumes). */
export function typicalHopKm(c: Consist): number {
  switch (c.kind) {
    case 'bus': return 0.25;
    case 'tram': return 0.3;
    case 'coach': return 2;
    case 'metro': return 0.5;
    case 'commuter': return 1;
    case 'hsr': return 8;
    default: return c.vmax >= 180 ? 3 : 1.2;
  }
}
/** Usual speed limit of the way (km/h): town streets, country roads, track. */
function typicalCap(c: Consist): number { return c.kind === 'bus' || c.kind === 'tram' ? 50 : c.kind === 'coach' ? 90 : Infinity; }

interface Calib { consist: Consist; timeMaintPerS: number; typical: { km: number; crew: number; maint: number; energy: number; time: number } }
const calibCache = new Map<string, Calib>();
/** Moving share of the time in service under the typical duty (the rest: dwelling, waiting at signals). */
const MOVING = 0.8;
const DWELL = { rail: 8, road: 5 };

/**
 * Typical year of a consist (1980 prices and wages): in service all year, stops at its kind's spacing, half full.
 * The time-based upkeep is what is left of (1 - OVERHEAD_SHARE) x running after crew, distance maintenance and
 * energy, at least TIME_MAINT_MIN x running.
 */
export function calibration(models: VehicleModel[]): Calib {
  const key = models.map((m) => m.id).join(',');
  const hit = calibCache.get(key);
  if (hit) return hit;
  const c = consistOf(models);
  const hop = hopEstimate(c, typicalHopKm(c) * 1000, c.seats * 0.5, typicalCap(c));
  const per = hop.t / MOVING + (c.road ? DWELL.road : DWELL.rail);
  const hops = YEAR_S / per;
  const km = hops * typicalHopKm(c);
  const crew = crewCount(c, 1980) * CREW_PER_YEAR;
  const maint = MAINT_PER_CAR_KM * c.carUnits * maintSpeed(c.vmax) * km;
  const energy = energyCost(c, hop.wheelJ * hops, hop.brakeJ * hops, c.auxKw * 1000 * YEAR_S, 1980).cost;
  const time = Math.max(TIME_MAINT_MIN * c.running, (1 - OVERHEAD_SHARE) * c.running - crew - maint - energy);
  const r: Calib = { consist: c, timeMaintPerS: time / YEAR_S, typical: { km, crew, maint, energy, time } };
  calibCache.set(key, r);
  return r;
}

// ------------------------------------------------------------------------------ per-vehicle usage and monthly costs
/** A month's operating costs of one vehicle (also kept as `Vehicle.opLast` for the UI). */
export interface OpCost { overhead: number; crew: number; energy: number; maint: number; total: number; km: number; kwh: number; hours: number }

/** The models of a vehicle (train cars, or the bus / tram model). */
export function modelsOf(v: Vehicle): VehicleModel[] {
  const a = v as unknown as { cars?: VehicleModel[]; model?: VehicleModel | null };
  return a.cars ?? (a.model ? [a.model] : []);
}

/** Physics accounting fields of a train (integrated by train.ts, read and reset here monthly). */
interface Physics { tractionJ?: number; regenJ?: number; auxJ?: number; km?: number; hours?: number }

/**
 * Take a vehicle's usage since the last charge: service time (s), distance (km) and energy (J at the wheels,
 * dissipated braking, hotel), from the train physics when it provides them, else from the stop-to-stop odometer
 * kept in Vehicle (serveStation). Resets the counters.
 */
function takeUsage(g: Game, v: Vehicle, c: Consist): { sec: number; km: number; wheelJ: number; brakeJ: number; auxJ: number } {
  const now = simNow(g);
  let sec = v.opSec;
  const onMap = !!(v as unknown as { onMap?: boolean }).onMap;
  if (onMap) { if (v.opMark >= 0) sec += Math.max(0, now - v.opMark); v.opMark = now; } else v.opMark = -1;
  let km = v.opDist / 100, wheelJ = v.opJ, brakeJ = v.opBrakeJ, auxJ = c.auxKw * 1000 * sec;
  const p = v as unknown as Physics;
  if (typeof p.tractionJ === 'number' && typeof p.km === 'number') {
    km = p.km; wheelJ = p.tractionJ; brakeJ = p.regenJ ?? 0;
    if (typeof p.auxJ === 'number') auxJ = p.auxJ;
    p.km = 0; p.tractionJ = 0; p.regenJ = 0; p.auxJ = 0;
    if (typeof p.hours === 'number') p.hours = 0;
  }
  v.opSec = 0; v.opDist = 0; v.opJ = 0; v.opBrakeJ = 0;
  return { sec, km, wheelJ, brakeJ, auxJ };
}

/** This month's operating costs of a vehicle (takes and resets its usage counters). */
export function vehicleMonth(g: Game, v: Vehicle): OpCost {
  const models = modelsOf(v);
  const zero: OpCost = { overhead: 0, crew: 0, energy: 0, maint: 0, total: 0, km: 0, kwh: 0, hours: 0 };
  if (!models.length) return zero;
  const cal = calibration(models), c = cal.consist, year = g.year;
  const u = takeUsage(g, v, c);
  const overhead = (OVERHEAD_SHARE * c.running) / MONTHS_PER_YEAR;
  const crew = (crewCount(c, year) * CREW_PER_YEAR * eraIndex('wage', year) * u.sec) / YEAR_S;
  const maint = MAINT_PER_CAR_KM * c.carUnits * maintSpeed(c.vmax) * u.km + cal.timeMaintPerS * u.sec;
  const en = energyCost(c, u.wheelJ, u.brakeJ, u.auxJ, year);
  const total = overhead + crew + maint + en.cost;
  return { overhead, crew, energy: en.cost, maint, total, km: u.km, kwh: en.kwh, hours: u.sec / 3600 };
}

/** Month end: every vehicle's overhead, crew, maintenance and energy, booked to its owner and its line. */
export function chargeVehicles(g: Game) {
  for (const v of g.vehicles.map.values()) {
    const c = vehicleMonth(g, v);
    v.opLast = c;
    if (!(c.total > 0)) continue;
    const eco = g.company(v.owner).economy;
    eco.spend(c.overhead, 'running', true);
    eco.spend(c.crew, 'crew', true);
    eco.spend(c.maint, 'vehicleMaint', true);
    eco.spend(c.energy, 'energy', true);
    v.profitYear -= c.total;
    const l = v.line;
    if (l) {
      l.costYear += c.total;
      if (l.kind === 'rail') g.ais.find((a) => a.companyId === v.owner)?.railPolicy.operating(l.id, -c.total);
    }
  }
}

/**
 * Odometer for vehicles without train physics (road vehicles, and trains until the physics provides energy):
 * called when the vehicle serves a station; adds the service time since the last call and, for a hop from another
 * station, its distance (straight line x detour) and an energy estimate.
 */
export function noteServe(g: Game, v: Vehicle, stationId: number, x: number, z: number) {
  const now = simNow(g);
  if (v.opMark >= 0) v.opSec += Math.max(0, now - v.opMark);
  v.opMark = now;
  if (v.opLastSt >= 0 && v.opLastSt !== stationId) {
    const from = g.stations.get(v.opLastSt);
    const models = modelsOf(v);
    if (from && models.length) {
      const c = consistOf(models);
      const d = Math.hypot(from.x - x, from.z - z) * (c.road ? 1.3 : 1.15);
      const h = hopEstimate(c, d * UNIT_M, loadOf(v), c.road ? (c.kind === 'coach' ? 90 : 50) : Infinity);
      v.opDist += d;
      v.opJ += h.wheelJ;
      v.opBrakeJ += h.brakeJ;
    }
  }
  v.opLastSt = stationId;
}

// ------------------------------------------------------------------------------ track maintenance and wear
/** Base maintenance per unit and year of a wire state (TRACK_BASE_SHARE of maintPerUnit). */
export function trackBasePerUnit(type: string): number {
  const std = TRACK_TYPES.standard.maintPerUnit;
  const per = Math.max(TRACK_TYPES[type]?.maintPerUnit ?? std, (TRACK_TYPE_FACTOR[type] ?? 0) * std);
  return per * TRACK_BASE_SHARE;
}

/** Yearly base maintenance of a rail or road edge (rail: wire state, structures 3x / tunnels 4x on top; without wear). */
export function trackMaintenance(e: NEdge): number {
  const per = e.kind === 'rail' ? trackBasePerUnit(e.type) : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).maintPerUnit;
  let c = e.len * per;
  for (const s of e.sections) c += (s.s1 - s.s0) * per * (s.type === 'tunnel' ? 4 : 3);
  return c;
}

/** Wear (money) of one passage of a consist over `units` of track at `kmh`: axle-load units x (v/160)^2. */
export function passageWear(c: Consist, loadPax: number, units: number, kmh: number): number {
  const loadUnits = c.axles > 0 ? (loadPax * PAX_T) / 16 : 0;
  return WEAR_RATE * units * (c.axleUnits + loadUnits) * wearSpeed(kmh);
}
/** Wear of a reference passage (14 axle-load units at 120 km/h): access usage is metered in such units. */
const REF_WEAR_PER_UNIT = WEAR_RATE * 14 * wearSpeed(120);

interface OpsState { wear: Map<number, number>; wearOwner: Map<number, number>; lastWear: Record<number, number> }
const states = new WeakMap<Game, OpsState>();
function state(g: Game): OpsState {
  let s = states.get(g);
  if (!s) {
    s = { wear: new Map(), wearOwner: new Map(), lastWear: {} };
    states.set(g, s);
    const st = s;
    // wear follows edges that are split
    g.world.net.onSplit.push((old, e1, e2) => {
      const w = st.wear.get(old.id);
      if (w === undefined) return;
      const o = st.wearOwner.get(old.id) ?? old.owner;
      st.wear.delete(old.id); st.wearOwner.delete(old.id);
      const f = old.len > 0 ? e1.len / old.len : 0.5;
      st.wear.set(e1.id, (st.wear.get(e1.id) ?? 0) + w * f); st.wearOwner.set(e1.id, o);
      st.wear.set(e2.id, (st.wear.get(e2.id) ?? 0) + w * (1 - f)); st.wearOwner.set(e2.id, o);
    });
  }
  return s;
}

/**
 * A train has passed a whole track edge (train.ts meterTrack): its wear is recorded for the owner's monthly bill,
 * and the passage is metered for track access in reference-wear units (a fast, heavy train counts for more).
 */
export function trackPassage(g: Game, t: Vehicle & { cars: VehicleModel[]; speed: number }, e: NEdge, units: number) {
  if (e.owner < 0 || e.depot >= 0) return;
  const c = consistOf(t.cars);
  const kmh = t.speed * 36;
  const w = passageWear(c, loadOf(t), units, kmh);
  const s = state(g);
  s.wear.set(e.id, (s.wear.get(e.id) ?? 0) + w);
  s.wearOwner.set(e.id, e.owner);
  g.recordTrackUse(t.owner, e, units * Math.max(0.2, Math.min(20, w / Math.max(1e-9, REF_WEAR_PER_UNIT * units))));
}

/** Track wear recorded this month on an edge (money). */
export function monthWear(g: Game, edgeId: number): number { return states.get(g)?.wear.get(edgeId) ?? 0; }

/**
 * Month end (Game.billAccess): every owner pays the wear on its edges ('trackWear'); returns the wear per edge so
 * the access fees can share it out, and starts a new month.
 */
export function billTrackWear(g: Game): Map<number, number> {
  const s = state(g);
  const out = s.wear;
  const last: Record<number, number> = {};
  for (const [id, w] of out) {
    if (!(w > 0)) continue;
    const owner = g.world.net.edges.get(id)?.owner ?? s.wearOwner.get(id) ?? -1;
    const co = g.companies[owner];
    if (!co || co.defunct) continue;
    co.economy.spend(w, 'trackWear', true);
    last[owner] = (last[owner] ?? 0) + w;
  }
  s.wear = new Map(); s.wearOwner = new Map(); s.lastWear = last;
  return out;
}
/** Track wear each company paid last month. */
export function lastMonthWear(g: Game, owner: number): number { return states.get(g)?.lastWear[owner] ?? 0; }

// ------------------------------------------------------------------------------ estimates (AI route evaluation, UI)
export interface KmCost {
  /** per km (100 units) at cruise speed: energy, maintenance (distance + time-based), crew, track wear */
  energy: number; maint: number; crew: number; wear: number;
  /** energy + maint + crew + wear (the overhead is a fixed cost per month, see overheadPerYear) */
  variable: number; overheadPerYear: number;
  kwhPerKm: number; kwhPerSeatKm: number;
}
/**
 * Operating cost per train-km of a consist cruising at `kmh` (no stops; `load` = share of seats taken): energy from
 * the running resistance and hotel load, maintenance, crew and time-based upkeep for the time a km takes, track wear.
 */
export function estimateCostPerTrainKm(models: VehicleModel[], kmh: number, year = 1980, load = 0.6): KmCost {
  const cal = calibration(models), c = cal.consist;
  const v = Math.max(1, Math.min(kmh, c.vmax)) / 3.6;
  const m = (c.mass + c.seats * load * PAX_T) * 1000;
  const secPerKm = 1000 / v;
  const en = energyCost(c, resistanceN(c, m, v) * 1000, 0, c.auxKw * 1000 * secPerKm, year);
  const maint = MAINT_PER_CAR_KM * c.carUnits * maintSpeed(v * 3.6) + cal.timeMaintPerS * secPerKm;
  const crew = (crewCount(c, year) * CREW_PER_YEAR * eraIndex('wage', year) * secPerKm) / YEAR_S;
  const wear = c.road ? 0 : passageWear(c, c.seats * load, 100, v * 3.6);
  return {
    energy: en.cost, maint, crew, wear, variable: en.cost + maint + crew + wear, overheadPerYear: OVERHEAD_SHARE * c.running,
    kwhPerKm: en.kwh, kwhPerSeatKm: c.seats > 0 ? en.kwh / c.seats : 0,
  };
}

export interface YearEstimate { total: number; overhead: number; crew: number; maint: number; energy: number; km: number; trips: number; trackWearPerUnit: number }
/**
 * Yearly operating cost of a vehicle in service all year on a line with stops every `hopUnits` (straight line;
 * `load` share of seats; speed capped by `capKmh`): for route evaluation (AI) and the UI. `trackWearPerUnit` is the
 * wear one such vehicle causes per unit of its track per year (billed to the track owner).
 */
export function estimateVehicleYear(models: VehicleModel[], hopUnits: number, year = 1980, load = 0.5, capKmh = Infinity): YearEstimate {
  const cal = calibration(models), c = cal.consist;
  const dM = Math.max(10, hopUnits * UNIT_M * (c.road ? 1.3 : 1.15));
  const hop = hopEstimate(c, dM, c.seats * load, Math.min(capKmh, typicalCap(c)));
  const per = hop.t / MOVING + (c.road ? DWELL.road : DWELL.rail);
  const trips = YEAR_S / per;
  const km = (trips * dM) / 1000;
  const overhead = OVERHEAD_SHARE * c.running;
  const crew = crewCount(c, year) * CREW_PER_YEAR * eraIndex('wage', year);
  const maint = MAINT_PER_CAR_KM * c.carUnits * maintSpeed(c.vmax) * km + cal.timeMaintPerS * YEAR_S;
  const energy = energyCost(c, hop.wheelJ * trips, hop.brakeJ * trips, c.auxKw * 1000 * YEAR_S, year).cost;
  const trackWearPerUnit = c.road ? 0 : (passageWear(c, c.seats * load, 1, (hop.vPeak * 3.6) * 0.8) * trips * dM) / UNIT_M / Math.max(1, hopUnits);
  return { total: overhead + crew + maint + energy, overhead, crew, maint, energy, km, trips, trackWearPerUnit };
}

// ------------------------------------------------------------------------------ save
/** Track wear of the month so far (save games). */
export function saveOps(g: Game): { wear: [number, number, number][]; lastWear: Record<number, number> } {
  const s = state(g);
  return { wear: [...s.wear].map(([id, w]) => [id, w, s.wearOwner.get(id) ?? -1]), lastWear: { ...s.lastWear } };
}
export function loadOps(g: Game, d: any) {
  const s = state(g);
  s.wear = new Map(); s.wearOwner = new Map(); s.lastWear = {};
  if (!d) return;
  for (const [id, w, o] of (d.wear ?? []) as [number, number, number][]) { s.wear.set(id, Number(w) || 0); s.wearOwner.set(id, o); }
  if (d.lastWear) for (const [k, v] of Object.entries(d.lastWear)) s.lastWear[Number(k)] = Number(v) || 0;
}
