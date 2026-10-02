// Builders for the merged world material: typed-array builder with a per-vertex atlas cell and shadow-cast flag,
// world-scaled texture helpers, and a fast geometry merger for super-chunks.
import * as THREE from 'three';
import { srgbToLinear } from './geo';

const lin = new Map<number, [number, number, number]>();
/** Hex colour (sRGB) -> linear RGB, cached. */
function linear(c: number): [number, number, number] {
  let v = lin.get(c);
  if (!v) {
    v = [srgbToLinear(((c >> 16) & 255) / 255), srgbToLinear(((c >> 8) & 255) / 255), srgbToLinear((c & 255) / 255)];
    if (lin.size > 4096) lin.clear();
    lin.set(c, v);
  }
  return v;
}

/**
 * World-material geometry builder with growable typed arrays (position, normal, colour, uv, atlas cell,
 * shadow-cast flag, seed). `cell` selects the atlas cell, `cast` (0/1) whether faces cast shadows.
 * API-compatible with the parts of GeoBuilder the static builders use.
 */
export class WB {
  private cap = 0;
  private n = 0;
  pos = new Float32Array(0);
  nrm = new Float32Array(0);
  col = new Float32Array(0);
  uvs = new Float32Array(0);
  cells = new Float32Array(0);
  casts = new Float32Array(0);
  seeds = new Float32Array(0);
  idx: number[] = [];
  cell = 0;
  cast = 1;
  /** per-face random seed (facade window lighting) */
  seed = 0;
  private cr = 1; private cg = 1; private cb = 1;
  private anyCast = false;

  /** Clear for reuse (keeps the allocated buffers). */
  reset(): this {
    this.n = 0; this.idx.length = 0;
    this.cell = 0; this.cast = 1; this.seed = 0; this.anyCast = false;
    this.cr = this.cg = this.cb = 1;
    return this;
  }

  get vertexCount() { return this.n; }
  get empty() { return this.idx.length === 0; }
  /** Any vertex that casts shadows? */
  get casting() { return this.anyCast; }

  private grow(need: number) {
    const cap = Math.max(1024, need, this.cap * 2);
    const g = (a: Float32Array, k: number) => { const b = new Float32Array(cap * k); b.set(a.subarray(0, this.n * k)); return b; };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 3); this.col = g(this.col, 3); this.uvs = g(this.uvs, 2);
    this.cells = g(this.cells, 1); this.casts = g(this.casts, 1); this.seeds = g(this.seeds, 1);
    this.cap = cap;
  }

  color(c: number | THREE.Color, mul = 1): this {
    if (typeof c === 'number') {
      if (mul === 1) { const v = linear(c); this.cr = v[0]; this.cg = v[1]; this.cb = v[2]; }
      else { this.cr = srgbToLinear((((c >> 16) & 255) / 255) * mul); this.cg = srgbToLinear((((c >> 8) & 255) / 255) * mul); this.cb = srgbToLinear(((c & 255) / 255) * mul); }
    } else { this.cr = srgbToLinear(c.r * mul); this.cg = srgbToLinear(c.g * mul); this.cb = srgbToLinear(c.b * mul); }
    return this;
  }

  /** Select atlas cell and colour (and optionally the shadow-cast flag) for the following faces. */
  use(cell: number, color: number, cast?: number): this {
    this.cell = cell;
    this.color(color);
    if (cast !== undefined) this.cast = cast;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    const i = this.n;
    if (i >= this.cap) this.grow(i + 1);
    const i3 = i * 3, i2 = i * 2;
    const P = this.pos, N = this.nrm, C = this.col;
    P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
    N[i3] = nx; N[i3 + 1] = ny; N[i3 + 2] = nz;
    C[i3] = this.cr; C[i3 + 1] = this.cg; C[i3 + 2] = this.cb;
    this.uvs[i2] = u; this.uvs[i2 + 1] = v;
    this.cells[i] = this.cell; this.casts[i] = this.cast; this.seeds[i] = this.seed;
    if (this.cast) this.anyCast = true;
    this.n = i + 1;
    return i;
  }

  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }

  /** Quad from 4 points in CCW order (seen from the front). Normal is computed. */
  quad(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number, x3: number, y3: number, z3: number,
    uv?: [number, number, number, number],
  ) {
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x3 - x0, vy = y3 - y0, vz = z3 - z0;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const u0 = uv ? uv[0] : 0, v0 = uv ? uv[1] : 0, u1 = uv ? uv[2] : 1, v1 = uv ? uv[3] : 1;
    const a = this.vertex(x0, y0, z0, nx, ny, nz, u0, v0);
    const b = this.vertex(x1, y1, z1, nx, ny, nz, u1, v0);
    const c = this.vertex(x2, y2, z2, nx, ny, nz, u1, v1);
    const d = this.vertex(x3, y3, z3, nx, ny, nz, u0, v1);
    this.idx.push(a, b, c, a, c, d);
  }

  triangle(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const a = this.vertex(x0, y0, z0, nx, ny, nz), b = this.vertex(x1, y1, z1, nx, ny, nz), c = this.vertex(x2, y2, z2, nx, ny, nz);
    this.idx.push(a, b, c);
  }

  /** Oriented box (as GeoBuilder.box): bottom centre, forward (fx,fz) = local z. */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, fx = 0, fz = 1, skipBottom = true) {
    const rx = fz, rz = -fx;
    const hw = w / 2, hd = d / 2;
    const px = (lx: number, lz: number) => cx + rx * lx + fx * lz, pz = (lx: number, lz: number) => cz + rz * lx + fz * lz;
    const X = [px(-hw, -hd), px(hw, -hd), px(hw, hd), px(-hw, hd)], Z = [pz(-hw, -hd), pz(hw, -hd), pz(hw, hd), pz(-hw, hd)];
    const y0 = cy, y1 = cy + h;
    const q = (a: number, ya: number, b: number, yb: number, c: number, yc: number, e: number, ye: number) =>
      this.quad(X[a], ya, Z[a], X[b], yb, Z[b], X[c], yc, Z[c], X[e], ye, Z[e]);
    q(0, y1, 3, y1, 2, y1, 1, y1); // top
    q(3, y0, 2, y0, 2, y1, 3, y1); // front (+z)
    q(1, y0, 0, y0, 0, y1, 1, y1); // back
    q(2, y0, 1, y0, 1, y1, 2, y1); // right
    q(0, y0, 3, y0, 3, y1, 0, y1); // left
    if (!skipBottom) q(0, y0, 1, y0, 2, y0, 3, y0);
  }

  /** Vertical cylinder (low poly). */
  cylinder(cx: number, cy: number, cz: number, r: number, h: number, seg = 6, rTop = r, cap = true) {
    const base = this.n;
    const ny = (r - rTop) / h, l = Math.sqrt(1 + ny * ny);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      this.vertex(cx + c * r, cy, cz + s * r, c / l, ny / l, s / l);
      this.vertex(cx + c * rTop, cy + h, cz + s * rTop, c / l, ny / l, s / l);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    if (cap && rTop > 0.0001) {
      const ctr = this.vertex(cx, cy + h, cz, 0, 1, 0);
      const ring: number[] = [];
      for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(this.vertex(cx + Math.cos(a) * rTop, cy + h, cz + Math.sin(a) * rTop, 0, 1, 0)); }
      for (let i = 0; i < seg; i++) this.idx.push(ctr, ring[(i + 1) % seg], ring[i]);
    }
  }

  /** Cylinder between two points (bars, wires). */
  tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg = 6) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const tx = dx / len, ty = dy / len, tz = dz / len;
    let ux = -tz, uy = 0, uz = tx;
    if (Math.abs(ty) > 0.9) { ux = 1; uy = 0; uz = 0; }
    const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= l; uy /= l; uz /= l;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const base = this.n;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
      this.vertex(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz);
      this.vertex(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.idx.push(a, a + 3, a + 1, a, a + 2, a + 3); }
  }

  /** Geometry with exact-size attribute copies (no bounding volumes unless asked). */
  build(bounds = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    const at = (a: Float32Array, k: number) => new THREE.BufferAttribute(a.slice(0, n * k), k);
    g.setAttribute('position', at(this.pos, 3));
    g.setAttribute('normal', at(this.nrm, 3));
    g.setAttribute('color', at(this.col, 3));
    g.setAttribute('uv', at(this.uvs, 2));
    g.setAttribute('aCell', at(this.cells, 1));
    g.setAttribute('aCast', at(this.casts, 1));
    g.setAttribute('aSeed', at(this.seeds, 1));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    if (bounds) { g.computeBoundingSphere(); g.computeBoundingBox(); }
    return g;
  }

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
    if (y1a < y0a) y1a = y0a;
    if (y1b < y0b) y1b = y0b;
    if (y1a - y0a + y1b - y0b < 1e-5) return;
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
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 2e-6) return; // degenerate sliver (orientation would be arbitrary)
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
  // bounds in one pass over the positions; the sphere encloses the box
  const P = out.getAttribute('position').array as Float32Array;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  out.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  out.boundingSphere = out.boundingBox.getBoundingSphere(new THREE.Sphere());
  return out;
}
