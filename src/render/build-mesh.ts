// Builders for the merged world material: GeoBuilder plus a per-vertex atlas cell and shadow-cast flag,
// world-scaled texture helpers, and a fast geometry merger for super-chunks.
import * as THREE from 'three';
import { GeoBuilder } from './geo';

/** World-material geometry builder. `cell` selects the atlas cell, `cast` (0/1) whether faces cast shadows. */
export class WB extends GeoBuilder {
  cells: number[] = [];
  casts: number[] = [];
  seeds: number[] = [];
  cell = 0;
  cast = 1;
  /** per-face random seed (facade window lighting) */
  seed = 0;
  constructor() { super(true); }

  /** Select atlas cell and colour (and optionally the shadow-cast flag) for the following faces. */
  use(cell: number, color: number, cast?: number): this {
    this.cell = cell;
    this.color(color);
    if (cast !== undefined) this.cast = cast;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.cells.push(this.cell);
    this.casts.push(this.cast);
    this.seeds.push(this.seed);
    return super.vertex(x, y, z, nx, ny, nz, u, v);
  }

  build(): THREE.BufferGeometry {
    const g = super.build();
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(this.cells, 1));
    g.setAttribute('aCast', new THREE.Float32BufferAttribute(this.casts, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seeds, 1));
    return g;
  }

  /** Any vertex that casts shadows? */
  get casting() { for (const c of this.casts) if (c) return true; return false; }

  /**
   * Oriented box with world-scaled uvs (sc = units per texture repeat). Same frame as GeoBuilder.box:
   * (cx,cy,cz) bottom centre, forward (fx,fz) = local z (depth d), local x = (fz,-fx) (width w).
   */
  tbox(cx: number, cy: number, cz: number, w: number, h: number, d: number, fx = 0, fz = 1, sc = 1, bottom = false, top = true) {
    const rx = fz, rz = -fx;
    const hw = w / 2, hd = d / 2;
    const p = (lx: number, ly: number, lz: number): [number, number, number] => [cx + rx * lx + fx * lz, cy + ly, cz + rz * lx + fz * lz];
    const c = [
      p(-hw, 0, -hd), p(hw, 0, -hd), p(hw, 0, hd), p(-hw, 0, hd),
      p(-hw, h, -hd), p(hw, h, -hd), p(hw, h, hd), p(-hw, h, hd),
    ];
    const v0 = cy / sc, v1 = (cy + h) / sc;
    const o = ((cx * 7.31 + cz * 3.17) % 1 + 1) % 1;
    const q = (a: number, b: number, cc: number, dd: number, uv: [number, number, number, number]) => this.quad(...c[a], ...c[b], ...c[cc], ...c[dd], uv);
    if (top) q(4, 7, 6, 5, [o, o, o + d / sc, o + w / sc]);
    q(3, 2, 6, 7, [o, v0, o + w / sc, v1]);
    q(1, 0, 4, 5, [o, v0, o + w / sc, v1]);
    q(2, 1, 5, 6, [o, v0, o + d / sc, v1]);
    q(0, 3, 7, 4, [o, v0, o + d / sc, v1]);
    if (bottom) q(0, 1, 2, 3, [o, o, o + w / sc, o + d / sc]);
  }

  /** Vertical wall quad from bottom points a..b (heights per end) facing (nx,nz), world-scaled uvs. */
  twall(ax: number, az: number, bx: number, bz: number, y0a: number, y1a: number, y0b: number, y1b: number, nx: number, nz: number, sc = 1, u0 = 0) {
    const len = Math.hypot(bx - ax, bz - az);
    const cx = -(bz - az), cz = bx - ax;
    const ua = u0 / sc, ub = (u0 + len) / sc;
    if (cx * nx + cz * nz > 0) {
      const a = this.vertex(ax, y0a, az, nx, 0, nz, ua, y0a / sc), b = this.vertex(bx, y0b, bz, nx, 0, nz, ub, y0b / sc);
      const c2 = this.vertex(bx, y1b, bz, nx, 0, nz, ub, y1b / sc), d = this.vertex(ax, y1a, az, nx, 0, nz, ua, y1a / sc);
      this.idx.push(a, b, c2, a, c2, d);
    } else {
      const a = this.vertex(bx, y0b, bz, nx, 0, nz, ub, y0b / sc), b = this.vertex(ax, y0a, az, nx, 0, nz, ua, y0a / sc);
      const c2 = this.vertex(ax, y1a, az, nx, 0, nz, ua, y1a / sc), d = this.vertex(bx, y1b, bz, nx, 0, nz, ub, y1b / sc);
      this.idx.push(a, b, c2, a, c2, d);
    }
  }

  /** Triangle with explicit uvs; winding fixed so the face normal points towards (wx,wy,wz). */
  ttri(ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number, wx: number, wy: number, wz: number) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nx * wx + ny * wy + nz * wz >= 0) {
      const a = this.vertex(ax, ay, az, nx, ny, nz, au, av), b = this.vertex(bx, by, bz, nx, ny, nz, bu, bv), c = this.vertex(cx, cy, cz, nx, ny, nz, cu, cv);
      this.idx.push(a, b, c);
    } else {
      const a = this.vertex(ax, ay, az, -nx, -ny, -nz, au, av), b = this.vertex(cx, cy, cz, -nx, -ny, -nz, cu, cv), c = this.vertex(bx, by, bz, -nx, -ny, -nz, bu, bv);
      this.idx.push(a, b, c);
    }
  }

  /** Horizontal (upward) triangle with planar world uvs. */
  ptri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, sc = 1) {
    this.ttri(ax, ay, az, ax / sc, az / sc, bx, by, bz, bx / sc, bz / sc, cx, cy, cz, cx / sc, cz / sc, 0, 1, 0);
  }
}

/** Concatenate geometries that share the same attribute layout (index offsets applied). */
export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const list = geos.filter((g) => g && g.getAttribute('position') && g.getAttribute('position').count > 0);
  if (!list.length) return null;
  const out = new THREE.BufferGeometry();
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.getAttribute('position').count; ni += g.index ? g.index.count : 0; }
  for (const name of Object.keys(list[0].attributes)) {
    const a0 = list[0].getAttribute(name) as THREE.BufferAttribute;
    const arr = new Float32Array(nv * a0.itemSize);
    let off = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      if (!a) { off += g.getAttribute('position').count * a0.itemSize; continue; }
      arr.set(a.array as Float32Array, off);
      off += a.array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a0.itemSize));
  }
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let io = 0, vo = 0;
  for (const g of list) {
    const ix = g.index!;
    const src = ix.array;
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
    io += src.length;
    vo += g.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}
