// Vehicle catalogue.

/**
 * loco / wagon: heavy rail (locomotive-hauled), emu: electric multiple units (bought as whole units, every car
 * powered), bus and tram: road vehicles.
 */
export type ModelKind = 'loco' | 'wagon' | 'emu' | 'bus' | 'tram';
/** How a vehicle is powered (wagons: none). Electric rail vehicles need electrified track. */
export type Traction = 'steam' | 'diesel' | 'electric' | 'none';

export interface VehicleModel {
  id: string;
  name: string;
  kind: ModelKind;
  intro: number;
  retire: number;
  speed: number;     // km/h
  capacity: number;  // passengers (emu: the whole unit)
  power: number;     // kW (emu: the whole unit)
  weight: number;    // tonnes (emu: the whole unit)
  cost: number;      // emu: the whole unit
  running: number;   // per year
  length: number;    // world units (1 = 10 m; emu: the whole unit)
  style: string;
  color: number;
  traction: Traction;
  /** trams and light-rail vehicles: articulated body sections (1 = single car) */
  sections?: number;
  /** emu: cars in one unit (all powered; the unit's length, capacity and power are the totals) */
  unitCars?: number;
  /**
   * Rail: track types it may run on (TRACK_TYPES ids). None listed: heavy rail (standard / electric /
   * highspeed). Electric traction also needs electrified track.
   */
  tracks?: string[];
  /**
   * Rail: aerodynamic drag coefficients c (N per (m/s)^2): `nose` when it leads the train, `len` per unit (10 m)
   * of its length (default by kind, traction and speed, see aeroOf).
   */
  aero?: { nose: number; len: number };
  /** Hotel load (kW): heating, air conditioning, lighting, doors (default by kind, see auxKwOf). */
  auxKw?: number;
}

/**
 * Aerodynamic drag of a rail vehicle (N per (m/s)^2, the c of Davis' c v^2): its nose when it leads, and per unit
 * of length — streamlined high-speed stock low, steam and old stock high; not proportional to mass. A 200 m
 * conventional train about 7, a 200 m high-speed set about 6.
 */
export function aeroOf(m: VehicleModel): { nose: number; len: number } {
  if (m.aero) return m.aero;
  const fast = m.speed >= 200;
  if (m.kind === 'wagon') return { nose: 0, len: m.speed >= 250 ? 0.27 : m.speed >= 180 ? 0.3 : m.speed >= 130 ? 0.34 : 0.42 };
  if (m.kind === 'emu') return fast ? { nose: 1.2, len: 0.28 } : { nose: 2.5, len: 0.32 };
  if (m.traction === 'steam') return { nose: 4, len: 0.5 };
  return fast ? { nose: 1.2, len: 0.3 } : m.speed >= 140 ? { nose: 2.2, len: 0.33 } : { nose: 2.8, len: 0.36 };
}

/** Hotel load of a vehicle (kW): coaches 15, multiple units 12 per car (high-speed 22), buses and trams. */
export function auxKwOf(m: VehicleModel): number {
  if (m.auxKw !== undefined) return m.auxKw;
  if (m.kind === 'wagon') return 15;
  if (m.kind === 'emu') return (m.unitCars ?? 1) * (m.speed >= 200 ? 22 : 12);
  if (m.kind === 'bus') return 5;
  if (m.kind === 'tram') return 4 + 3 * (m.sections ?? 1);
  return 0;
}

/** Track types of heavy rail (locomotives and coaches) when a model lists none. */
export const HEAVY_RAIL_TRACKS = ['standard', 'electric', 'highspeed'];

export const MODELS: VehicleModel[] = [
  { id: 'steam_a', name: 'Pioneer 2-6-0', kind: 'loco', intro: 1880, retire: 1945, speed: 75, capacity: 0, power: 750, weight: 68, cost: 260_000, running: 42_000, length: 1.9, style: 'steam', traction: 'steam', color: 0x2b3a2f },
  { id: 'steam_b', name: 'Mountaineer 4-6-2', kind: 'loco', intro: 1925, retire: 1965, speed: 115, capacity: 0, power: 1500, weight: 105, cost: 480_000, running: 62_000, length: 2.4, style: 'steam', traction: 'steam', color: 0x1d3557 },
  { id: 'diesel_a', name: 'DL-600 Diesel', kind: 'loco', intro: 1950, retire: 2000, speed: 120, capacity: 0, power: 1400, weight: 88, cost: 640_000, running: 55_000, length: 1.8, style: 'diesel', traction: 'diesel', color: 0xb5452b },
  { id: 'diesel_b', name: 'Cascade CC Diesel', kind: 'loco', intro: 1968, retire: 2030, speed: 150, capacity: 0, power: 2500, weight: 112, cost: 980_000, running: 78_000, length: 2.1, style: 'diesel', traction: 'diesel', color: 0x2a6f97 },
  { id: 'hst', name: 'InterCity 200', kind: 'loco', intro: 1978, retire: 2050, speed: 200, capacity: 0, power: 3400, weight: 70, cost: 1_600_000, running: 105_000, length: 2.0, style: 'hst', traction: 'diesel', color: 0xf2c14e },
  { id: 'bullet', name: 'Velocity HS', kind: 'loco', intro: 1998, retire: 2100, speed: 280, capacity: 0, power: 6200, weight: 66, cost: 2_600_000, running: 150_000, length: 2.6, style: 'bullet', traction: 'electric', color: 0xeeeeee },

  { id: 'coach_wood', name: 'Wooden Coach', kind: 'wagon', intro: 1870, retire: 1955, speed: 100, capacity: 40, power: 0, weight: 24, cost: 60_000, running: 6_000, length: 1.7, style: 'coach_wood', traction: 'none', color: 0x7a3b22 },
  { id: 'coach_steel', name: 'Steel Coach', kind: 'wagon', intro: 1935, retire: 1995, speed: 150, capacity: 56, power: 0, weight: 32, cost: 110_000, running: 9_000, length: 2.3, style: 'coach_steel', traction: 'none', color: 0x2e5e3e },
  { id: 'coach_ic', name: 'InterCity Coach', kind: 'wagon', intro: 1975, retire: 2060, speed: 200, capacity: 64, power: 0, weight: 35, cost: 175_000, running: 12_000, length: 2.6, style: 'coach_ic', traction: 'none', color: 0xf2f2f2 },
  { id: 'coach_hs', name: 'Velocity Coach', kind: 'wagon', intro: 1998, retire: 2100, speed: 300, capacity: 72, power: 0, weight: 38, cost: 260_000, running: 16_000, length: 2.5, style: 'coach_hs', traction: 'none', color: 0xeeeeee },

  { id: 'bus_a', name: 'Classic Omnibus', kind: 'bus', intro: 1920, retire: 1975, speed: 55, capacity: 30, power: 60, weight: 6, cost: 90_000, running: 14_000, length: 1.0, style: 'bus_old', traction: 'diesel', color: 0xc0392b },
  { id: 'bus_b', name: 'City Liner', kind: 'bus', intro: 1958, retire: 2010, speed: 75, capacity: 45, power: 150, weight: 10, cost: 145_000, running: 20_000, length: 1.2, style: 'bus', traction: 'diesel', color: 0x2d7dd2 },
  { id: 'bus_c', name: 'Metro Articulated', kind: 'bus', intro: 1985, retire: 2060, speed: 80, capacity: 85, power: 220, weight: 16, cost: 270_000, running: 32_000, length: 1.8, style: 'bus_artic', traction: 'diesel', color: 0x27ae60 },
  { id: 'bus_d', name: 'e-Liner', kind: 'bus', intro: 2008, retire: 2100, speed: 95, capacity: 62, power: 250, weight: 12, cost: 330_000, running: 21_000, length: 1.25, style: 'bus_modern', traction: 'electric', color: 0x16a085 },
  // long-distance coaches (buses for intercity lines over the country roads): faster and more powerful,
  // fewer seats than town buses, dearer to buy and run
  { id: 'coach_a', name: 'Touring Coach', kind: 'bus', intro: 1930, retire: 1975, speed: 80, capacity: 35, power: 110, weight: 8, cost: 160_000, running: 24_000, length: 1.2, style: 'coach', traction: 'diesel', color: 0x8e5a2b },
  { id: 'coach_b', name: 'Highway Cruiser', kind: 'bus', intro: 1960, retire: 2005, speed: 100, capacity: 45, power: 210, weight: 12, cost: 240_000, running: 30_000, length: 1.25, style: 'coach', traction: 'diesel', color: 0x3a6ea5 },
  { id: 'coach_c', name: 'Express Liner', kind: 'bus', intro: 1990, retire: 2050, speed: 110, capacity: 50, power: 290, weight: 14, cost: 340_000, running: 35_000, length: 1.3, style: 'coach', traction: 'diesel', color: 0xd35400 },
  { id: 'coach_d', name: 'Skyline Express', kind: 'bus', intro: 2010, retire: 2100, speed: 120, capacity: 55, power: 340, weight: 15, cost: 430_000, running: 39_000, length: 1.4, style: 'coach', traction: 'diesel', color: 0x6c3483 },

  // trams: run on road edges with tram tracks (edge.tram), bought at tram depots; styles for the renderer
  { id: 'tram_a', name: 'Electric Streetcar', kind: 'tram', intro: 1890, retire: 1955, speed: 40, capacity: 48, power: 60, weight: 14, cost: 130_000, running: 15_000, length: 1.6, style: 'tram_early', traction: 'electric', color: 0x9b2d20, sections: 1 },
  { id: 'tram_b', name: 'PCC Streamliner', kind: 'tram', intro: 1936, retire: 1990, speed: 60, capacity: 75, power: 170, weight: 18, cost: 220_000, running: 22_000, length: 1.8, style: 'tram_pcc', traction: 'electric', color: 0xe0b33a, sections: 1 },
  { id: 'tram_c', name: 'Articulated GT8', kind: 'tram', intro: 1958, retire: 2015, speed: 70, capacity: 135, power: 300, weight: 30, cost: 380_000, running: 30_000, length: 2.7, style: 'tram_artic', traction: 'electric', color: 0xf2e8d5, sections: 3 },
  { id: 'tram_d', name: 'Low-floor LRV', kind: 'tram', intro: 1994, retire: 2100, speed: 75, capacity: 190, power: 420, weight: 38, cost: 580_000, running: 38_000, length: 3.0, style: 'tram_modern', traction: 'electric', color: 0x1f6fb2, sections: 5 },
  { id: 'tram_e', name: 'CityLink XL', kind: 'tram', intro: 2012, retire: 2100, speed: 80, capacity: 250, power: 560, weight: 50, cost: 760_000, running: 46_000, length: 3.4, style: 'tram_modern', traction: 'electric', color: 0xc8102e, sections: 7 },

  // electric multiple units: whole units (length, capacity, power and price for the unit), all cars powered
  // metro: city subways and elevated lines, through-running onto electrified suburban lines
  { id: 'metro_a', name: 'Steel Metro (4 cars)', kind: 'emu', intro: 1960, retire: 2005, speed: 80, capacity: 300, power: 1600, weight: 120, cost: 1_150_000, running: 70_000, length: 5.2, style: 'metro_steel', traction: 'electric', color: 0xb8bcc2, unitCars: 4, tracks: ['metro', 'electric'] },
  { id: 'metro_b', name: 'Stainless Metro (6 cars)', kind: 'emu', intro: 1981, retire: 2035, speed: 100, capacity: 480, power: 2900, weight: 170, cost: 1_900_000, running: 95_000, length: 7.8, style: 'metro_stainless', traction: 'electric', color: 0xd9dde2, unitCars: 6, tracks: ['metro', 'electric'] },
  { id: 'metro_c', name: 'Metro 2000 (6 cars)', kind: 'emu', intro: 2000, retire: 2100, speed: 110, capacity: 520, power: 3400, weight: 160, cost: 2_400_000, running: 100_000, length: 7.8, style: 'metro_modern', traction: 'electric', color: 0x2e86de, unitCars: 6, tracks: ['metro', 'electric'] },
  // commuter: suburban electric lines, through-running onto metro lines
  { id: 'emu_a', name: 'Commuter EMU (4 cars)', kind: 'emu', intro: 1962, retire: 2010, speed: 110, capacity: 320, power: 1900, weight: 150, cost: 1_350_000, running: 80_000, length: 6.4, style: 'emu_60s', traction: 'electric', color: 0x6a8f3a, unitCars: 4, tracks: ['electric', 'metro'] },
  { id: 'emu_b', name: 'Suburban EMU (6 cars)', kind: 'emu', intro: 1985, retire: 2040, speed: 120, capacity: 500, power: 3300, weight: 215, cost: 2_200_000, running: 110_000, length: 9.6, style: 'emu_80s', traction: 'electric', color: 0xf0f0ec, unitCars: 6, tracks: ['electric', 'metro'] },
  { id: 'emu_c', name: 'Commuter EMU 2010 (6 cars)', kind: 'emu', intro: 2010, retire: 2100, speed: 130, capacity: 540, power: 3900, weight: 200, cost: 2_800_000, running: 115_000, length: 9.6, style: 'emu_modern', traction: 'electric', color: 0x1b4f72, unitCars: 6, tracks: ['electric', 'metro'] },
  // high-speed trainsets (6 cars) by era: all axles powered, streamlined; electric, on high-speed (or
  // electrified main-line) track. Power for 6 cars of their prototypes; drag low and rising little with length.
  { id: 'hsr_a', name: 'Bullet Express 0 (6 cars)', kind: 'emu', intro: 1964, retire: 2008, speed: 210, capacity: 460, power: 4400, weight: 360, cost: 5_200_000, running: 260_000, length: 11, style: 'hsr_0', traction: 'electric', color: 0xf4f4f0, unitCars: 6, tracks: ['highspeed', 'electric'], aero: { nose: 2.0, len: 0.32 } },
  { id: 'hsr_b', name: 'Intercity HS 270 (6 cars)', kind: 'emu', intro: 1981, retire: 2025, speed: 270, capacity: 420, power: 6300, weight: 330, cost: 6_800_000, running: 300_000, length: 11, style: 'hsr_1', traction: 'electric', color: 0xe86a1c, unitCars: 6, tracks: ['highspeed', 'electric'], aero: { nose: 1.5, len: 0.3 } },
  { id: 'hsr_c', name: 'Velocity 300 (6 cars)', kind: 'emu', intro: 1997, retire: 2040, speed: 300, capacity: 460, power: 7000, weight: 280, cost: 8_400_000, running: 330_000, length: 11, style: 'hsr_2', traction: 'electric', color: 0x3d5a80, unitCars: 6, tracks: ['highspeed', 'electric'], aero: { nose: 1.1, len: 0.28 } },
  { id: 'hsr_d', name: 'Velocity 350 (6 cars)', kind: 'emu', intro: 2008, retire: 2060, speed: 350, capacity: 480, power: 8800, weight: 300, cost: 10_500_000, running: 360_000, length: 11, style: 'hsr_3', traction: 'electric', color: 0xd9dde2, unitCars: 6, tracks: ['highspeed', 'electric'], aero: { nose: 0.9, len: 0.26 } },
  { id: 'hsr_e', name: 'Velocity 400 (6 cars)', kind: 'emu', intro: 2025, retire: 2100, speed: 400, capacity: 480, power: 10500, weight: 290, cost: 13_000_000, running: 390_000, length: 11, style: 'hsr_4', traction: 'electric', color: 0xb3002d, unitCars: 6, tracks: ['highspeed', 'electric'], aero: { nose: 0.8, len: 0.24 } },
  // light rail: articulated vehicles for light-rail track, also on metro track
  { id: 'lrv_a', name: 'Light Rail Vehicle (2 sections)', kind: 'emu', intro: 1978, retire: 2030, speed: 80, capacity: 160, power: 600, weight: 38, cost: 900_000, running: 50_000, length: 2.8, style: 'lrv', traction: 'electric', color: 0xe67e22, unitCars: 2, sections: 2, tracks: ['lightrail', 'metro'] },
  { id: 'lrv_b', name: 'Light Rail Vehicle (3 sections)', kind: 'emu', intro: 2000, retire: 2100, speed: 80, capacity: 240, power: 900, weight: 50, cost: 1_250_000, running: 60_000, length: 3.4, style: 'lrv_modern', traction: 'electric', color: 0x8e44ad, unitCars: 3, sections: 3, tracks: ['lightrail', 'metro'] },
];

export const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function availableModels(year: number, kind: ModelKind): VehicleModel[] {
  return MODELS.filter((m) => m.kind === kind && m.intro <= year && m.retire >= year);
}

/** Track types a rail model may run on (its own list, or heavy rail). */
export function modelTracks(m: VehicleModel): string[] { return m.tracks ?? HEAVY_RAIL_TRACKS; }
