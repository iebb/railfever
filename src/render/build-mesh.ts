// Builders for the merged world material: typed-array builder with a per-vertex atlas cell and shadow-cast flag,
// world-scaled texture helpers, and a fast geometry merger for super-chunks.
import * as THREE from 'three';
import { srgbToLinear } from './geo';
import { cellAverages, FACADE_CELL0, WC } from './textures';

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

/** Growable index buffer (typed, reused across builds: no garbage from array growth). push takes 3 or 6 indices. */
export class IndexBuf {
  a = new Uint32Array(0);
  length = 0;
  /** discard pushes (builder switched off) */
  off = false;
  push(i0: number, i1: number, i2: number, i3?: number, i4?: number, i5?: number) {
    if (this.off) return;
    let n = this.length;
    if (n + 6 > this.a.length) { const b = new Uint32Array(Math.max(4096, this.a.length * 2)); b.set(this.a.subarray(0, n)); this.a = b; }
    const A = this.a;
    A[n++] = i0; A[n++] = i1; A[n++] = i2;
    if (i3 !== undefined) { A[n++] = i3; A[n++] = i4!; A[n++] = i5!; }
    this.length = n;
  }
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
  idx = new IndexBuf();
  cell = 0;
  cast = 1;
  /** per-face random seed (facade window lighting) */
  seed = 0;
  private cr = 1; private cg = 1; private cb = 1;
  private anyCast = false;

  /** Clear for reuse (keeps the allocated buffers). */
  reset(off = false): this {
    this.n = 0; this.idx.length = 0;
    this.cell = 0; this.cast = 1; this.seed = 0; this.anyCast = false;
    this.cr = this.cg = this.cb = 1;
    this.off = off; this.idx.off = off;
    return this;
  }

  /** Switched off: geometry is computed by the callers but nothing is stored (empty result). */
  off = false;

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
    if (this.off) return 0;
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

  /**
   * Geometry with exact-size, compact attribute copies (no bounding volumes unless asked): float
   * positions and uvs, byte normals and (linear) colours, byte cell / cast flags, 16-bit seeds.
   */
  build(bounds = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    const nrm = new Int8Array(n * 3), col = new Uint8Array(n * 3);
    const N = this.nrm, C = this.col;
    for (let i = 0; i < n * 3; i++) {
      nrm[i] = Math.round(N[i] * 127);
      const c = C[i] * 255;
      col[i] = c >= 255 ? 255 : c <= 0 ? 0 : Math.round(c);
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs.slice(0, n * 2), 2));
    const cell = new Uint8Array(n), cast = new Uint8Array(n), seed = new Uint16Array(n);
    for (let i = 0; i < n; i++) { cell[i] = this.cells[i]; cast[i] = this.casts[i]; seed[i] = this.seeds[i]; }
    g.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
    g.setAttribute('aCast', new THREE.BufferAttribute(cast, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const ix = this.idx.a.subarray(0, this.idx.length);
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? ix.slice() : new Uint16Array(ix), 1));
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
    if (l < 2e-5) return; // degenerate sliver (invisible; its orientation would not survive float32 positions)
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
    const Ctor = a0.array.constructor as new (n: number) => THREE.TypedArray;
    const arr = new Ctor(nv * a0.itemSize);
    let off = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      if (!a) { off += g.getAttribute('position').count * a0.itemSize; continue; }
      arr.set(a.array as ArrayLike<number>, off);
      off += a.array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
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

// ------------------------------------------------------------------------------ far LOD parts

/** Compact far-LOD geometry: positions, byte normals, baked linear byte colours, night glow; 32-bit indices. */
export interface FarPart { pos: Float32Array; nrm: Int8Array; col: Uint8Array; glow: Uint8Array; idx: Uint32Array; nv: number; ni: number }

let remap = new Int32Array(0);

/**
 * Simplified compact copy of world-material geometries for distant views: drops tiny triangles and low
 * vertical strips of ground pieces (kerbs, skirts, verges), bakes the cell's average colour into the
 * vertex colour and marks lamp / facade vertices for night glow.
 */
export function farPart(geos: (THREE.BufferGeometry | null)[]): FarPart | null {
  let NV = 0, NI = 0;
  for (const g of geos) if (g && g.index) { NV += g.getAttribute('position').count; NI += g.index.count; }
  if (!NI) return null;
  const pos = new Float32Array(NV * 3), nrm = new Int8Array(NV * 3), col = new Uint8Array(NV * 3), glow = new Uint8Array(NV);
  const idx = new Uint32Array(NI);
  const avg = cellAverages();
  let nv = 0, ni = 0;
  for (const g of geos) {
    if (!g || !g.index) continue;
    const P = g.getAttribute('position').array as Float32Array;
    const na = g.getAttribute('normal') as THREE.BufferAttribute, ca = g.getAttribute('color') as THREE.BufferAttribute;
    const N = na.array as ArrayLike<number>, C = ca.array as ArrayLike<number>;
    const nk = na.normalized ? 1 : 127, ck = ca.normalized ? 1 / 255 : 1;
    const CE = g.getAttribute('aCell').array as ArrayLike<number>, CA = g.getAttribute('aCast').array as ArrayLike<number>;
    const I = g.index.array;
    const cnt = g.getAttribute('position').count;
    if (remap.length < cnt) remap = new Int32Array(Math.max(cnt, remap.length * 2));
    remap.fill(-1, 0, cnt);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
      const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l2 = nx * nx + ny * ny + nz * nz;
      if (l2 < 9e-6) continue; // area < 0.0015
      if (CA[a] < 0.5 && ny * ny < 0.12 * l2) {
        const y0 = Math.min(ay, P[b * 3 + 1], P[c * 3 + 1]), y1 = Math.max(ay, P[b * 3 + 1], P[c * 3 + 1]);
        if (y1 - y0 < 0.07) continue; // low vertical strip of a ground piece
      }
      for (const v of [a, b, c]) {
        let m = remap[v];
        if (m < 0) {
          m = remap[v] = nv++;
          pos[m * 3] = P[v * 3]; pos[m * 3 + 1] = P[v * 3 + 1]; pos[m * 3 + 2] = P[v * 3 + 2];
          nrm[m * 3] = Math.round(N[v * 3] * nk); nrm[m * 3 + 1] = Math.round(N[v * 3 + 1] * nk); nrm[m * 3 + 2] = Math.round(N[v * 3 + 2] * nk);
          const cell = Math.round(CE[v]);
          const k = (cell < 64 ? cell : 0) * 3;
          col[m * 3] = Math.min(255, Math.round(C[v * 3] * ck * avg[k] * 255));
          col[m * 3 + 1] = Math.min(255, Math.round(C[v * 3 + 1] * ck * avg[k + 1] * 255));
          col[m * 3 + 2] = Math.min(255, Math.round(C[v * 3 + 2] * ck * avg[k + 2] * 255));
          glow[m] = cell === WC.LAMP ? 255 : cell >= FACADE_CELL0 ? 90 : 0;
        }
        idx[ni++] = m;
      }
    }
  }
  if (!ni) return null;
  return { pos: pos.slice(0, nv * 3), nrm: nrm.slice(0, nv * 3), col: col.slice(0, nv * 3), glow: glow.slice(0, nv), idx: idx.slice(0, ni), nv, ni };
}

/** One geometry from far parts (bounds included). */
export function concatFar(parts: (FarPart | null)[]): THREE.BufferGeometry | null {
  let nv = 0, ni = 0;
  for (const p of parts) if (p) { nv += p.nv; ni += p.ni; }
  if (!ni) return null;
  const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 3), col = new Uint8Array(nv * 3), glow = new Uint8Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    if (!p) continue;
    pos.set(p.pos, vo * 3); nrm.set(p.nrm, vo * 3); col.set(p.col, vo * 3); glow.set(p.glow, vo);
    const I = p.idx;
    for (let i = 0; i < I.length; i++) idx[io + i] = I[i] + vo;
    vo += p.nv; io += p.ni;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}
