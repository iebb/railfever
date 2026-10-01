// Core constants shared by simulation and rendering.

/** World-space height of one terrain level. */
export const HSTEP = 0.2;
/** World y of the water surface. */
export const WATER_Y = HSTEP * 0.35;
/** Real seconds per in-game day at 1x speed. */
export const DAY_SECONDS = 2.0;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
/** Conversion factor: km/h -> tiles per (game) second. */
export const KMH_TO_TPS = 1 / 40;

// Directions: 0 = N (-z), 1 = E (+x), 2 = S (+z), 3 = W (-x)
export const DX = [0, 1, 0, -1];
export const DZ = [-1, 0, 1, 0];
export const OPP = [2, 3, 0, 1];
export const DIR_NAMES = ['N', 'E', 'S', 'W'];

// Tile corners: 0 = NW, 1 = NE, 2 = SE, 3 = SW
export const CORNER_DX = [0, 1, 1, 0];
export const CORNER_DZ = [0, 0, 1, 1];
/** The two corners belonging to each edge (indexed by direction). */
export const EDGE_CORNERS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0]];

// Rail pieces: each connects two edges of a tile.
// 0 = N-S, 1 = E-W, 2 = N-E, 3 = E-S, 4 = S-W, 5 = W-N
export const PIECE_EDGES: [number, number][] = [[0, 2], [1, 3], [0, 1], [1, 2], [2, 3], [3, 0]];
export const PIECE_COUNT = 6;
/** pieceOf[a*4+b] -> piece index connecting edges a and b (or -1). */
export const PIECE_OF: number[] = (() => {
  const t = new Array(16).fill(-1);
  PIECE_EDGES.forEach(([a, b], i) => { t[a * 4 + b] = i; t[b * 4 + a] = i; });
  return t;
})();
export function pieceOf(a: number, b: number): number { return PIECE_OF[a * 4 + b]; }
export function isStraightPiece(p: number): boolean { return p === 0 || p === 1; }

/** Edge midpoint offsets within a tile (0..1). */
export const EDGE_MID_X = [0.5, 1, 0.5, 0];
export const EDGE_MID_Z = [0, 0.5, 1, 0.5];

export const RAIL_TOP = 0.085;   // rail top above ground
export const ROAD_TOP = 0.03;    // road surface above ground
export const LANE_OFFSET = 0.115;

export const STATION_RADIUS_RAIL = 4;
export const STATION_RADIUS_BUS = 3;
