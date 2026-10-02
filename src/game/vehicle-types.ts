// Vehicle catalogue.

export type ModelKind = 'loco' | 'wagon' | 'bus' | 'tram';

export interface VehicleModel {
  id: string;
  name: string;
  kind: ModelKind;
  intro: number;
  retire: number;
  speed: number;     // km/h
  capacity: number;  // passengers
  power: number;     // kW
  weight: number;    // tonnes
  cost: number;
  running: number;   // per year
  length: number;    // world units (1 = 10 m)
  style: string;
  color: number;
  /** trams: articulated body sections (1 = single car) */
  sections?: number;
}

export const MODELS: VehicleModel[] = [
  { id: 'steam_a', name: 'Pioneer 2-6-0', kind: 'loco', intro: 1880, retire: 1945, speed: 75, capacity: 0, power: 750, weight: 68, cost: 260_000, running: 42_000, length: 1.9, style: 'steam', color: 0x2b3a2f },
  { id: 'steam_b', name: 'Mountaineer 4-6-2', kind: 'loco', intro: 1925, retire: 1965, speed: 115, capacity: 0, power: 1500, weight: 105, cost: 480_000, running: 62_000, length: 2.4, style: 'steam', color: 0x1d3557 },
  { id: 'diesel_a', name: 'DL-600 Diesel', kind: 'loco', intro: 1950, retire: 2000, speed: 120, capacity: 0, power: 1400, weight: 88, cost: 640_000, running: 55_000, length: 1.8, style: 'diesel', color: 0xb5452b },
  { id: 'diesel_b', name: 'Cascade CC Diesel', kind: 'loco', intro: 1968, retire: 2030, speed: 150, capacity: 0, power: 2500, weight: 112, cost: 980_000, running: 78_000, length: 2.1, style: 'diesel', color: 0x2a6f97 },
  { id: 'hst', name: 'InterCity 200', kind: 'loco', intro: 1978, retire: 2050, speed: 200, capacity: 0, power: 3400, weight: 70, cost: 1_600_000, running: 105_000, length: 2.0, style: 'hst', color: 0xf2c14e },
  { id: 'bullet', name: 'Velocity HS', kind: 'loco', intro: 1998, retire: 2100, speed: 280, capacity: 0, power: 6200, weight: 66, cost: 2_600_000, running: 150_000, length: 2.6, style: 'bullet', color: 0xeeeeee },

  { id: 'coach_wood', name: 'Wooden Coach', kind: 'wagon', intro: 1870, retire: 1955, speed: 100, capacity: 40, power: 0, weight: 24, cost: 60_000, running: 6_000, length: 1.7, style: 'coach_wood', color: 0x7a3b22 },
  { id: 'coach_steel', name: 'Steel Coach', kind: 'wagon', intro: 1935, retire: 1995, speed: 150, capacity: 56, power: 0, weight: 32, cost: 110_000, running: 9_000, length: 2.3, style: 'coach_steel', color: 0x2e5e3e },
  { id: 'coach_ic', name: 'InterCity Coach', kind: 'wagon', intro: 1975, retire: 2060, speed: 200, capacity: 64, power: 0, weight: 35, cost: 175_000, running: 12_000, length: 2.6, style: 'coach_ic', color: 0xf2f2f2 },
  { id: 'coach_hs', name: 'Velocity Coach', kind: 'wagon', intro: 1998, retire: 2100, speed: 300, capacity: 72, power: 0, weight: 38, cost: 260_000, running: 16_000, length: 2.5, style: 'coach_hs', color: 0xeeeeee },

  { id: 'bus_a', name: 'Classic Omnibus', kind: 'bus', intro: 1920, retire: 1975, speed: 55, capacity: 30, power: 60, weight: 6, cost: 90_000, running: 14_000, length: 1.0, style: 'bus_old', color: 0xc0392b },
  { id: 'bus_b', name: 'City Liner', kind: 'bus', intro: 1958, retire: 2010, speed: 75, capacity: 45, power: 150, weight: 10, cost: 145_000, running: 20_000, length: 1.2, style: 'bus', color: 0x2d7dd2 },
  { id: 'bus_c', name: 'Metro Articulated', kind: 'bus', intro: 1985, retire: 2060, speed: 80, capacity: 85, power: 220, weight: 16, cost: 270_000, running: 32_000, length: 1.8, style: 'bus_artic', color: 0x27ae60 },
  { id: 'bus_d', name: 'e-Liner', kind: 'bus', intro: 2008, retire: 2100, speed: 95, capacity: 62, power: 250, weight: 12, cost: 330_000, running: 21_000, length: 1.25, style: 'bus_modern', color: 0x16a085 },
  // long-distance coaches (buses for intercity lines over the country roads): faster and more powerful,
  // fewer seats than town buses, dearer to buy and run
  { id: 'coach_a', name: 'Touring Coach', kind: 'bus', intro: 1930, retire: 1975, speed: 80, capacity: 35, power: 110, weight: 8, cost: 160_000, running: 24_000, length: 1.2, style: 'coach', color: 0x8e5a2b },
  { id: 'coach_b', name: 'Highway Cruiser', kind: 'bus', intro: 1960, retire: 2005, speed: 100, capacity: 45, power: 210, weight: 12, cost: 240_000, running: 30_000, length: 1.25, style: 'coach', color: 0x3a6ea5 },
  { id: 'coach_c', name: 'Express Liner', kind: 'bus', intro: 1990, retire: 2050, speed: 110, capacity: 50, power: 290, weight: 14, cost: 340_000, running: 35_000, length: 1.3, style: 'coach', color: 0xd35400 },
  { id: 'coach_d', name: 'Skyline Express', kind: 'bus', intro: 2010, retire: 2100, speed: 120, capacity: 55, power: 340, weight: 15, cost: 430_000, running: 39_000, length: 1.4, style: 'coach', color: 0x6c3483 },

  // trams: run on road edges with tram tracks (edge.tram), bought at tram depots; styles for the renderer
  { id: 'tram_a', name: 'Electric Streetcar', kind: 'tram', intro: 1890, retire: 1955, speed: 40, capacity: 48, power: 60, weight: 14, cost: 130_000, running: 15_000, length: 1.6, style: 'tram_early', color: 0x9b2d20, sections: 1 },
  { id: 'tram_b', name: 'PCC Streamliner', kind: 'tram', intro: 1936, retire: 1990, speed: 60, capacity: 75, power: 170, weight: 18, cost: 220_000, running: 22_000, length: 1.8, style: 'tram_pcc', color: 0xe0b33a, sections: 1 },
  { id: 'tram_c', name: 'Articulated GT8', kind: 'tram', intro: 1958, retire: 2015, speed: 70, capacity: 135, power: 300, weight: 30, cost: 380_000, running: 30_000, length: 2.7, style: 'tram_artic', color: 0xf2e8d5, sections: 3 },
  { id: 'tram_d', name: 'Low-floor LRV', kind: 'tram', intro: 1994, retire: 2100, speed: 75, capacity: 190, power: 420, weight: 38, cost: 580_000, running: 38_000, length: 3.0, style: 'tram_modern', color: 0x1f6fb2, sections: 5 },
  { id: 'tram_e', name: 'CityLink XL', kind: 'tram', intro: 2012, retire: 2100, speed: 80, capacity: 250, power: 560, weight: 50, cost: 760_000, running: 46_000, length: 3.4, style: 'tram_modern', color: 0xc8102e, sections: 7 },
];

export const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function availableModels(year: number, kind: ModelKind): VehicleModel[] {
  return MODELS.filter((m) => m.kind === kind && m.intro <= year && m.retire >= year);
}
