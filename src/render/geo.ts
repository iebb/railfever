// Procedural geometry builder producing merged, vertex-coloured BufferGeometry.
import * as THREE from 'three';

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] | null = null;
  extra: Map<string, { size: number; data: number[] }> = new Map();
  idx: number[] = [];
  private cr = 1; private cg = 1; private cb = 1;

  constructor(withUv = false) { if (withUv) this.uv = []; }

  get vertexCount() { return this.pos.length / 3; }
  get empty() { return this.idx.length === 0; }

  color(c: number | THREE.Color, mul = 1): this {
    if (typeof c === 'number') {
      this.cr = (((c >> 16) & 255) / 255) * mul;
      this.cg = (((c >> 8) & 255) / 255) * mul;
      this.cb = ((c & 255) / 255) * mul;
    } else { this.cr = c.r * mul; this.cg = c.g * mul; this.cb = c.b * mul; }
    // convert sRGB -> linear for vertex colours
    this.cr = srgbToLinear(this.cr); this.cg = srgbToLinear(this.cg); this.cb = srgbToLinear(this.cb);
    return this;
  }
  colorRGB(r: number, g: number, b: number): this {
    this.cr = srgbToLinear(r); this.cg = srgbToLinear(g); this.cb = srgbToLinear(b);
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.cr, this.cg, this.cb);
    if (this.uv) this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  attr(name: string, size: number, ...vals: number[]) {
    let a = this.extra.get(name);
    if (!a) { a = { size, data: [] }; this.extra.set(name, a); }
    a.data.push(...vals);
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
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // our convention: CCW when viewed from the normal side => normal = (p1-p0) x (p3-p0) flipped?
    // Points are given counter-clockwise looking at the front face, three uses CCW front faces:
    // with right-handed coords cross(p1-p0, p3-p0) points towards the viewer.
    const [u0, v0, u1, v1] = uv ?? [0, 0, 1, 1];
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
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const a = this.vertex(x0, y0, z0, nx, ny, nz);
    const b = this.vertex(x1, y1, z1, nx, ny, nz);
    const c = this.vertex(x2, y2, z2, nx, ny, nz);
    this.idx.push(a, b, c);
  }

  /**
   * Oriented box. (cx,cy,cz) is the centre of the bottom face, (fx,fz) the unit forward
   * direction (local +z), size w (local x), h (y), d (local z).
   */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, fx = 0, fz = 1, skipBottom = true) {
    const rx = fz, rz = -fx; // right vector (local +x)
    const hw = w / 2, hd = d / 2;
    const p = (lx: number, ly: number, lz: number): [number, number, number] => [cx + rx * lx + fx * lz, cy + ly, cz + rz * lx + fz * lz];
    const c = [
      p(-hw, 0, -hd), p(hw, 0, -hd), p(hw, 0, hd), p(-hw, 0, hd),
      p(-hw, h, -hd), p(hw, h, -hd), p(hw, h, hd), p(-hw, h, hd),
    ];
    const q = (a: number, b: number, cc: number, dd: number) => this.quad(...c[a], ...c[b], ...c[cc], ...c[dd]);
    q(4, 7, 6, 5); // top
    q(3, 2, 6, 7); // front (+z)
    q(1, 0, 4, 5); // back
    q(2, 1, 5, 6); // right
    q(0, 3, 7, 4); // left
    if (!skipBottom) q(0, 1, 2, 3);
  }

  /** Axis-aligned box given min/max. */
  aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, 0, 1);
  }

  /** Vertical cylinder (low poly). */
  cylinder(cx: number, cy: number, cz: number, r: number, h: number, seg = 6, rTop = r, cap = true) {
    const base = this.vertexCount;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const ny = (r - rTop) / h;
      const l = Math.hypot(1, ny);
      this.vertex(cx + c * r, cy, cz + s * r, c / l, ny / l, s / l);
      this.vertex(cx + c * rTop, cy + h, cz + s * rTop, c / l, ny / l, s / l);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    if (cap && rTop > 0.0001) {
      const ctr = this.vertex(cx, cy + h, cz, 0, 1, 0);
      const ring: number[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push(this.vertex(cx + Math.cos(a) * rTop, cy + h, cz + Math.sin(a) * rTop, 0, 1, 0));
      }
      for (let i = 0; i < seg; i++) this.idx.push(ctr, ring[(i + 1) % seg], ring[i]);
    }
  }

  /** Cylinder between two points (e.g. horizontal axles, bars). */
  tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg = 6) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const tx = dx / len, ty = dy / len, tz = dz / len;
    // perpendicular basis
    let ux = -tz, uy = 0, uz = tx;
    if (Math.abs(ty) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const base = this.vertexCount;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
      this.vertex(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz);
      this.vertex(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.idx.push(a, a + 3, a + 1, a, a + 2, a + 3); }
    l = 0;
  }

  /**
   * Extrude a 2D profile (in the plane perpendicular to the path, x = lateral right, y = up)
   * along a path of points with horizontal tangents. pts: [x,y,z,...]
   */
  extrude(pts: ArrayLike<number>, profile: [number, number][], closed = false) {
    const n = pts.length / 3;
    if (n < 2) return;
    const m = profile.length;
    // per-segment-edge normals for flat shading of the profile faces
    for (let k = 0; k < m - 1 + (closed ? 1 : 0); k++) {
      const [ax, ay] = profile[k];
      const [bx, by] = profile[(k + 1) % m];
      // edge normal in profile space (pointing outward to the right-hand side of the edge a->b)
      let enx = by - ay, eny = -(bx - ax);
      const el = Math.hypot(enx, eny) || 1;
      enx /= el; eny /= el;
      const base = this.vertexCount;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        let tx = pts[i1 * 3] - pts[i0 * 3], tz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const rx = -tz, rz = tx; // right
        const px = pts[i * 3], py = pts[i * 3 + 1], pz = pts[i * 3 + 2];
        const nx = rx * enx, ny = eny, nz = rz * enx;
        this.vertex(px + rx * ax, py + ay, pz + rz * ax, nx, ny, nz);
        this.vertex(px + rx * bx, py + by, pz + rz * bx, nx, ny, nz);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }

  /** Flat ribbon along a path (y offset added), with lateral half width. */
  ribbon(pts: ArrayLike<number>, half: number, yOff: number, offset = 0) {
    const n = pts.length / 3;
    if (n < 2) return;
    const base = this.vertexCount;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = pts[i1 * 3] - pts[i0 * 3], tz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const rx = -tz, rz = tx;
      const px = pts[i * 3], py = pts[i * 3 + 1] + yOff, pz = pts[i * 3 + 2];
      this.vertex(px + rx * (offset - half), py, pz + rz * (offset - half), 0, 1, 0);
      this.vertex(px + rx * (offset + half), py, pz + rz * (offset + half), 0, 1, 0);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [name, a] of this.extra) g.setAttribute(name, new THREE.Float32BufferAttribute(a.data, a.size));
    const vc = this.pos.length / 3;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Merge multiple geometries of identical attribute layout. */
export function mergeInto(target: GeoBuilder, src: GeoBuilder) {
  const off = target.vertexCount;
  target.pos.push(...src.pos);
  target.nrm.push(...src.nrm);
  target.col.push(...src.col);
  if (target.uv && src.uv) target.uv.push(...src.uv);
  for (const i of src.idx) target.idx.push(i + off);
}
