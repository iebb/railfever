// Planar cubic Bezier math and sampled curves.

export interface Bez { x0: number; z0: number; x1: number; z1: number; x2: number; z2: number; x3: number; z3: number }
export interface V2 { x: number; z: number }
export interface Vec3Like { x: number; y: number; z: number }

export function bezPoint(b: Bez, t: number, out: V2 = { x: 0, z: 0 }): V2 {
  const u = 1 - t;
  const a = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, d = t * t * t;
  out.x = a * b.x0 + c1 * b.x1 + c2 * b.x2 + d * b.x3;
  out.z = a * b.z0 + c1 * b.z1 + c2 * b.z2 + d * b.z3;
  return out;
}

export function bezDeriv(b: Bez, t: number, out: V2 = { x: 0, z: 0 }): V2 {
  const u = 1 - t;
  out.x = 3 * u * u * (b.x1 - b.x0) + 6 * u * t * (b.x2 - b.x1) + 3 * t * t * (b.x3 - b.x2);
  out.z = 3 * u * u * (b.z1 - b.z0) + 6 * u * t * (b.z2 - b.z1) + 3 * t * t * (b.z3 - b.z2);
  return out;
}

/** Split a Bezier at parameter t (de Casteljau). */
export function bezSplit(b: Bez, t: number): [Bez, Bez] {
  const lerp = (a: number, c: number) => a + (c - a) * t;
  const x01 = lerp(b.x0, b.x1), z01 = lerp(b.z0, b.z1);
  const x12 = lerp(b.x1, b.x2), z12 = lerp(b.z1, b.z2);
  const x23 = lerp(b.x2, b.x3), z23 = lerp(b.z2, b.z3);
  const x012 = lerp(x01, x12), z012 = lerp(z01, z12);
  const x123 = lerp(x12, x23), z123 = lerp(z12, z23);
  const xm = lerp(x012, x123), zm = lerp(z012, z123);
  return [
    { x0: b.x0, z0: b.z0, x1: x01, z1: z01, x2: x012, z2: z012, x3: xm, z3: zm },
    { x0: xm, z0: zm, x1: x123, z1: z123, x2: x23, z2: z23, x3: b.x3, z3: b.z3 },
  ];
}

export function bezReverse(b: Bez): Bez {
  return { x0: b.x3, z0: b.z3, x1: b.x2, z1: b.z2, x2: b.x1, z2: b.z1, x3: b.x0, z3: b.z0 };
}

/** Straight line as a Bezier. */
export function bezLine(ax: number, az: number, bx: number, bz: number): Bez {
  return { x0: ax, z0: az, x1: ax + (bx - ax) / 3, z1: az + (bz - az) / 3, x2: ax + ((bx - ax) * 2) / 3, z2: az + ((bz - az) * 2) / 3, x3: bx, z3: bz };
}

/** Bezier from endpoints with unit tangents and handle lengths. */
export function bezFromTangents(ax: number, az: number, tax: number, taz: number, bx: number, bz: number, tbx: number, tbz: number, ka: number, kb: number): Bez {
  return { x0: ax, z0: az, x1: ax + tax * ka, z1: az + taz * ka, x2: bx - tbx * kb, z2: bz - tbz * kb, x3: bx, z3: bz };
}

export function startTangent(b: Bez): V2 {
  let x = b.x1 - b.x0, z = b.z1 - b.z0;
  if (Math.hypot(x, z) < 1e-6) { x = b.x2 - b.x0; z = b.z2 - b.z0; }
  if (Math.hypot(x, z) < 1e-6) { x = b.x3 - b.x0; z = b.z3 - b.z0; }
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}
export function endTangent(b: Bez): V2 {
  let x = b.x3 - b.x2, z = b.z3 - b.z2;
  if (Math.hypot(x, z) < 1e-6) { x = b.x3 - b.x1; z = b.z3 - b.z1; }
  if (Math.hypot(x, z) < 1e-6) { x = b.x3 - b.x0; z = b.z3 - b.z0; }
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

/** Arc-length table: dense parameter samples. */
export interface ArcTable { t: Float32Array; s: Float32Array; len: number }

export function arcTable(b: Bez, n?: number): ArcTable {
  const chord = Math.hypot(b.x3 - b.x0, b.z3 - b.z0) + Math.hypot(b.x1 - b.x0, b.z1 - b.z0) + Math.hypot(b.x2 - b.x3, b.z2 - b.z3);
  const N = n ?? Math.max(16, Math.min(2000, Math.ceil(chord / 0.15)));
  const t = new Float32Array(N + 1), s = new Float32Array(N + 1);
  const p = { x: 0, z: 0 };
  let px = b.x0, pz = b.z0, acc = 0;
  for (let i = 1; i <= N; i++) {
    const tt = i / N;
    bezPoint(b, tt, p);
    acc += Math.hypot(p.x - px, p.z - pz);
    px = p.x; pz = p.z;
    t[i] = tt; s[i] = acc;
  }
  return { t, s, len: acc };
}

/** Parameter t at arc length s. */
export function tAtS(tab: ArcTable, s: number): number {
  const S = tab.s;
  if (s <= 0) return 0;
  if (s >= tab.len) return 1;
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const f = (s - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
  return tab.t[lo] + (tab.t[hi] - tab.t[lo]) * f;
}

/** Minimum radius of curvature (horizontal) of a Bezier. */
export function bezMinRadius(b: Bez, n = 32): number {
  let minR = Infinity;
  const d1 = { x: 0, z: 0 };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    bezDeriv(b, t, d1);
    const u = 1 - t;
    // second derivative
    const ddx = 6 * u * (b.x2 - 2 * b.x1 + b.x0) + 6 * t * (b.x3 - 2 * b.x2 + b.x1);
    const ddz = 6 * u * (b.z2 - 2 * b.z1 + b.z0) + 6 * t * (b.z3 - 2 * b.z2 + b.z1);
    const sp = Math.hypot(d1.x, d1.z);
    if (sp < 1e-6) continue;
    const k = Math.abs(d1.x * ddz - d1.z * ddx) / (sp * sp * sp);
    if (k > 1e-9) minR = Math.min(minR, 1 / k);
  }
  return minR;
}

/** Offset a Bezier laterally (right of travel = positive), keeping end tangents. */
export function bezOffset(b: Bez, off: number): Bez {
  if (Math.abs(off) < 1e-9) return { ...b };
  const ta = startTangent(b), tb = endTangent(b);
  // right vector of tangent (tx,tz) is (-tz, tx)
  const ax = b.x0 - ta.z * off, az = b.z0 + ta.x * off;
  const bx = b.x3 - tb.z * off, bz = b.z3 + tb.x * off;
  // length ratio estimated from the offset of sampled points
  const p = { x: 0, z: 0 }, d = { x: 0, z: 0 };
  let lc = 0, lo = 0, pcx = b.x0, pcz = b.z0, pox = ax, poz = az;
  const N = 24;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    bezPoint(b, t, p);
    bezDeriv(b, t, d);
    const l = Math.hypot(d.x, d.z) || 1;
    const ox = p.x - (d.z / l) * off, oz = p.z + (d.x / l) * off;
    lc += Math.hypot(p.x - pcx, p.z - pcz);
    lo += Math.hypot(ox - pox, oz - poz);
    pcx = p.x; pcz = p.z; pox = ox; poz = oz;
  }
  const r = lc > 1e-6 ? lo / lc : 1;
  const ka = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) * r;
  const kb = Math.hypot(b.x3 - b.x2, b.z3 - b.z2) * r;
  return bezFromTangents(ax, az, ta.x, ta.z, bx, bz, tb.x, tb.z, ka, kb);
}

/** Closest point on a polyline (xz samples) to a point. Returns index fraction & distance. */
export function closestOnPolyline(px: number, pz: number, xs: ArrayLike<number>, stride: number, n: number): { i: number; f: number; d: number } {
  let best = Infinity, bi = 0, bf = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = xs[i * stride], az = xs[i * stride + 2], bx = xs[(i + 1) * stride], bz = xs[(i + 1) * stride + 2];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let f = l2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const qx = ax + dx * f, qz = az + dz * f;
    const d = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (d < best) { best = d; bi = i; bf = f; }
  }
  return { i: bi, f: bf, d: Math.sqrt(best) };
}

/** Intersection of segments AB and CD (2D). Returns params (u along AB, v along CD) or null. */
export function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const u = (qx * sz - qz * sx) / den;
  const v = (qx * rz - qz * rx) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, v];
}

export function angleBetween(ax: number, az: number, bx: number, bz: number): number {
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1))));
}
