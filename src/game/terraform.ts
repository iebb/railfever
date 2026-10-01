// Terrain modification helpers shared by construction, towns and the terraform tool.
import { World } from './world';
import { CORNER_DX, CORNER_DZ } from './constants';

/** A corner is locked if any tile around it carries construction. */
export function cornerLocked(w: World, cx: number, cz: number, ignore?: Set<number>): boolean {
  for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
    const x = cx + dx, z = cz + dz;
    if (!w.inBounds(x, z)) continue;
    const t = w.idx(x, z);
    if (ignore && ignore.has(t)) continue;
    if (!w.isEmpty(t) || w.span[t] >= 0) return true;
  }
  return false;
}

/** Can all corners of the tile be set to `level` without disturbing construction? */
export function canLevelTile(w: World, x: number, z: number, level: number, ignore?: Set<number>): boolean {
  for (let c = 0; c < 4; c++) {
    const cx = x + CORNER_DX[c], cz = z + CORNER_DZ[c];
    if (w.cornerH(cx, cz) !== level && cornerLocked(w, cx, cz, ignore)) return false;
  }
  return true;
}

/** Number of level-steps needed to level a tile. */
export function levelCost(w: World, x: number, z: number, level: number): number {
  let n = 0;
  for (let c = 0; c < 4; c++) n += Math.abs(w.corner(x, z, c) - level);
  return n;
}

export function levelTile(w: World, x: number, z: number, level: number) {
  for (let c = 0; c < 4; c++) w.setCorner(x + CORNER_DX[c], z + CORNER_DZ[c], level);
}
