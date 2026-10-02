// Station building styles: what serves passengers at a rail station's platforms: a building beside them, a
// concourse over the tracks, a head building across the buffer ends, a halt's shelters, or nothing (ramps to the
// street; street entrances only for stations below or above the street). A building is optional at every level
// and widens the catchment (catchBonus). A registry, so styles can be added later (an entry here + a renderer
// builder) without changing the save format: RailPart.style holds the id and unknown ids fall back to 'classic'.
import type { StationLevel, RailMode } from './stations';

/**
 * Where the passenger building goes: 'side' beside the platforms (its street side faces away from the tracks),
 * 'over' a concourse across the tracks with entrances on both sides (either side gives road access), 'end' a
 * head building across the buffer ends of a terminus, 'none' no building (a ramp at a platform end to the
 * street, a ticket machine).
 */
export type StylePlacement = 'side' | 'over' | 'end' | 'none';

export interface StationBuildingStyle {
  id: string;
  name: string;
  desc: string;
  /** station levels it is built at */
  levels: StationLevel[];
  /** available from / until (years) */
  from: number; to?: number;
  /** platform tracks it suits */
  minTracks: number; maxTracks: number;
  placement: StylePlacement;
  /**
   * Building size (units) for platforms `length` long, `tracks` station tracks and a track area `width` wide:
   * w along the tracks and d across them ('side', 'over': d spans the tracks and both entrance pavilions), or
   * w across the tracks and d along the axis beyond the buffers ('end').
   */
  size(length: number, tracks: number, width: number): { w: number; d: number };
  /** building price as a share of the station's base price (see Stations.planRail) */
  cost: number;
  /** waiting comfort: a small bonus to the station's rating target */
  rating: number;
  /** a building draws people from further away: catchment radius x (1 + catchBonus) */
  catchBonus: number;
}

/** Today's building beside the platforms (also the size of the brick and modern buildings). */
const sideSize = (length: number, tracks: number) => ({ w: Math.min(3.6, Math.max(1.6, 1.2 + length * 0.12 + tracks * 0.2)), d: Math.min(1.3, 0.8 + tracks * 0.08) });

/** Width of one entrance pavilion of a concourse station (beside the outermost platform). */
export const CONCOURSE_PAVILION = 1.1;

export const STATION_STYLES: Record<string, StationBuildingStyle> = {
  none: {
    id: 'none', name: 'No building', desc: 'Platforms only: a ramp at the platform end to the street and a ticket machine',
    levels: ['ground', 'elevated', 'underground'], from: 1830, minTracks: 1, maxTracks: 8, placement: 'none',
    size: () => ({ w: 0, d: 0 }), cost: 0, rating: 0, catchBonus: 0,
  },
  shelter: {
    id: 'shelter', name: 'Halt', desc: 'Shelters and a small canopy beside the platform: country halts and light-rail stops',
    levels: ['ground', 'elevated'], from: 1830, minTracks: 1, maxTracks: 2, placement: 'side',
    size: (length) => ({ w: Math.min(2.2, Math.max(1.0, length * 0.18)), d: 0.55 }), cost: 0.15, rating: 0.01, catchBonus: 0,
  },
  classic: {
    id: 'classic', name: 'Station building', desc: 'A station building beside the platforms with a forecourt on the street',
    levels: ['ground', 'elevated', 'underground'], from: 1830, minTracks: 1, maxTracks: 8, placement: 'side',
    size: sideSize, cost: 1, rating: 0.03, catchBonus: 0.2,
  },
  brick: {
    id: 'brick', name: 'Brick station', desc: 'A gabled brick building of the early railway age',
    levels: ['ground', 'elevated', 'underground'], from: 1830, to: 1960, minTracks: 1, maxTracks: 8, placement: 'side',
    size: (length, tracks) => { const s = sideSize(length, tracks); return { w: Math.min(4, s.w * 1.1), d: s.d }; }, cost: 1.1, rating: 0.03, catchBonus: 0.2,
  },
  modern: {
    id: 'modern', name: 'Modern station', desc: 'Glass and steel beside the platforms',
    levels: ['ground', 'elevated', 'underground'], from: 1955, minTracks: 1, maxTracks: 8, placement: 'side',
    size: sideSize, cost: 1.2, rating: 0.04, catchBonus: 0.25,
  },
  concourse: {
    id: 'concourse', name: 'Concourse station', desc: 'A concourse bridging the tracks with entrances on both sides (bridge-station style)',
    levels: ['ground', 'elevated'], from: 1960, minTracks: 2, maxTracks: 8, placement: 'over',
    size: (length, _tracks, width) => ({ w: Math.min(4.2, Math.max(1.8, 1.4 + length * 0.1)), d: width + 2 * CONCOURSE_PAVILION }), cost: 1.8, rating: 0.05, catchBonus: 0.25,
  },
  terminal: {
    id: 'terminal', name: 'Terminal', desc: 'A head building across the buffer ends and a train shed over the platforms (big termini)',
    levels: ['ground'], from: 1840, minTracks: 4, maxTracks: 8, placement: 'end',
    size: (_length, _tracks, width) => ({ w: width + 1.2, d: 2.2 }), cost: 2.4, rating: 0.05, catchBonus: 0.3,
  },
};

/** The style of an id (unknown or missing ids: 'classic'). */
export function styleOf(id?: string): StationBuildingStyle { return (id && STATION_STYLES[id]) || STATION_STYLES.classic; }

/** Styles that can be built at a level for a number of platform tracks in a year. */
export function stylesFor(level: StationLevel, tracks: number, year: number): StationBuildingStyle[] {
  return Object.values(STATION_STYLES).filter((s) => s.levels.includes(level) && tracks >= s.minTracks && tracks <= s.maxTracks && year >= s.from && (s.to === undefined || year < s.to));
}

/**
 * A fitting style for a new station: stations below or above the street need no building (street entrances,
 * 'none'), halts and light rail get shelters, early main-line stations brick, later ones a building of their
 * time; big towns a concourse. A terminal building is chosen deliberately (it needs a terminus end). A building
 * is optional everywhere: it costs more and draws people from further away (catchBonus).
 */
export function defaultStationStyle(year: number, tracks: number, level: StationLevel, mode: RailMode, townPop: number): string {
  if (level !== 'ground') return 'none';
  const ok = (id: string) => stylesFor(level, tracks, year).some((s) => s.id === id);
  if (mode === 'lightrail') return ok('shelter') ? 'shelter' : 'none';
  if (mode === 'metro') return ok('modern') ? 'modern' : 'classic';
  if (tracks <= 1 && townPop < 1500 && ok('shelter')) return 'shelter';
  if (townPop >= 8000 && tracks >= 2 && ok('concourse')) return 'concourse';
  if (ok('brick') && year < 1900) return 'brick';
  if (ok('modern') && year >= 1965) return 'modern';
  return 'classic';
}
