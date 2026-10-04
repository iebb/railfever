// What demolishing a building costs: the works plus compensation for the homes, valued by the land beneath.
import type { Game } from './game';
import type { World, Building } from './world';

/**
 * Demolition (compulsory purchase) of a building: `base` for the works plus `perResident` per resident for their homes,
 * times the land value where it stands. Land is dear in the dense core of a big town (bid rent): the value rises from
 * 1x to `max` with the residents per square unit around the building (from `density0` to `density1`, counted over the
 * `cell`-unit squares whose centres lie within `radius` of its square) and with the size of its town (from `townPop0`
 * to `townPop1` residents). Villages, suburbs and small towns stay at about 1x; the centres of towns of 6000 and more
 * reach 4x. A surface railway through such a centre takes whole blocks of flats, which a subway avoids: with tunnels
 * about 7x ground track, a dense centre is where an underground line comes out cheaper.
 */
export const DEMOLITION = { base: 6000, perResident: 2500, radius: 8, cell: 4, density0: 0.5, density1: 1.8, townPop0: 2000, townPop1: 6000, max: 4 };

interface Memo { version: number; cells: Map<number, number>; value: Map<number, [number, number]> }
const memo = new WeakMap<World, Memo>();

function memoOf(w: World): Memo {
  const version = w.lotVersions.version;
  let m = memo.get(w);
  if (!m || m.version !== version) { m = { version, cells: new Map(), value: new Map() }; memo.set(w, m); }
  return m;
}

/** Residents of the buildings whose centres lie in square (i, j) of the land-value grid (cached until a building changes). */
function cellPop(w: World, m: Memo, i: number, j: number): number {
  const key = j * 100000 + i;
  let v = m.cells.get(key);
  if (v === undefined) {
    const C = DEMOLITION.cell, x0 = i * C, z0 = j * C;
    v = 0;
    for (const id of w.bgrid.query(x0 - 2, z0 - 2, x0 + C + 2, z0 + C + 2)) {
      const b = w.buildings.get(id);
      if (b && b.x >= x0 && b.x < x0 + C && b.z >= z0 && b.z < z0 + C) v += b.pop;
    }
    m.cells.set(key, v);
  }
  return v;
}

/** Residents per square unit around a point (the land-value grid's squares within DEMOLITION.radius). */
export function residentDensity(w: World, x: number, z: number): number {
  const D = DEMOLITION, C = D.cell, m = memoOf(w);
  const ci = Math.floor(x / C), cj = Math.floor(z / C), r = Math.ceil(D.radius / C);
  let pop = 0, n = 0;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    if (Math.hypot(i - ci, j - cj) * C > D.radius) continue;
    pop += cellPop(w, m, i, j); n++;
  }
  return pop / Math.max(1, n * C * C);
}

/** Land value factor (1..DEMOLITION.max) at a point in a town of `townPop` residents. */
export function landValueAt(w: World, x: number, z: number, townPop: number): number {
  const D = DEMOLITION;
  const kd = Math.max(0, Math.min(1, (residentDensity(w, x, z) - D.density0) / (D.density1 - D.density0)));
  const kt = Math.max(0, Math.min(1, (townPop - D.townPop0) / (D.townPop1 - D.townPop0)));
  return 1 + (D.max - 1) * kd * kt;
}

/** Land value factor at a building (memoized until a building changes anywhere, or its town's size does). */
export function landValue(g: Game, b: Building): number {
  const w = g.world, m = memoOf(w), townPop = g.towns.list[b.townId]?.pop ?? 0;
  const c = m.value.get(b.id);
  if (c && c[0] === townPop) return c[1];
  const v = landValueAt(w, b.x, b.z, townPop);
  m.value.set(b.id, [townPop, v]);
  return v;
}

/** Money to demolish a building (the works and the residents' homes at the land value there). */
export function demolitionCost(g: Game, b: Building): number {
  return DEMOLITION.base + b.pop * DEMOLITION.perResident * landValue(g, b);
}

/** Money to demolish these buildings (ids of buildings that are gone count nothing). */
export function demolitionTotal(g: Game, ids: Iterable<number>): number {
  let c = 0;
  for (const id of ids) { const b = g.world.buildings.get(id); if (b) c += demolitionCost(g, b); }
  return c;
}
