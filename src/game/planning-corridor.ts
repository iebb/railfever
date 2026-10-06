// The coarse heading-aware corridor search, isolated from mutable game state and browser APIs.
// Everything executed by the worker is inside this factory so its compiled source is self-contained.
import type { CorridorOpts, OPoint, P2, RailField } from './routing';

export interface CorridorSnapshot {
  revision: string;
  size: number;
  terrainId: string;
  h: Float32Array;
  lock: Uint8Array;
  waterLimit: number;
  forbid: { x: number; z: number; a: number; w: number; d: number; r: number }[];
  field?: RailField;
  from: OPoint;
  to: OPoint;
  opts: CorridorOpts;
  grade: number;
}
export interface CorridorReply {
  steps: { state: 'running' | 'done' | 'failed'; expanded: number }[];
  path: P2[] | null;
  expanded: number;
}

/** Identical Float32 costs, heap tie order and budget accounting in workers and synchronous fallback. */
export function createCorridorKernel(snapshot: CorridorSnapshot) {
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const MIN_RUN = 2, FIELD_CELL = 16;
  class Heap {
    f: number[] = []; v: number[] = [];
    get size() { return this.v.length; }
    push(val: number, pri: number) {
      const f = this.f, v = this.v;
      let i = v.length; f.push(pri); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (f[p] <= pri) break; f[i] = f[p]; v[i] = v[p]; i = p; }
      f[i] = pri; v[i] = val;
    }
    pop(): number {
      const f = this.f, v = this.v, top = v[0];
      const lf = f.pop()!, lv = v.pop()!;
      const n = v.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && f[c + 1] < f[c]) c++;
          if (f[c] >= lf) break;
          f[i] = f[c]; v[i] = v[c]; i = c;
        }
        f[i] = lf; v[i] = lv;
      }
      return top;
    }
  }

  function nearestDir(tx: number, tz: number) {
    let bd = 0, bv = -2;
    DIRS.forEach(([dx, dz], i) => { const v = (dx * tx + dz * tz) / Math.hypot(dx, dz); if (v > bv) { bv = v; bd = i; } });
    return bd;
  }

  function distToRect(px: number, pz: number, cx: number, cz: number, a: number, hw: number, hd: number): number {
    const dx = px - cx, dz = pz - cz;
    const fx = Math.sin(a), fz = Math.cos(a);
    const rx = fz, rz = -fx;
    const lx = Math.abs(dx * rx + dz * rz) - hw, lz = Math.abs(dx * fx + dz * fz) - hd;
    const ox = Math.max(lx, 0), oz = Math.max(lz, 0);
    return Math.hypot(ox, oz);
  }

  function parallelRailAt(f: RailField, x: number, z: number, tx: number, tz: number, minOff = 3, maxOff = 30, cosMin = 0.906, maxAhead = 12): boolean {
    const r = Math.max(maxOff, maxAhead);
    const cx0 = Math.floor((x - r) / FIELD_CELL), cx1 = Math.floor((x + r) / FIELD_CELL), cz0 = Math.floor((z - r) / FIELD_CELL), cz1 = Math.floor((z + r) / FIELD_CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const a = f.cells.get(cx * 65536 + cz);
      if (!a) continue;
      for (const i of a) {
        const dx = f.x[i] - x, dz = f.z[i] - z;
        const along = dx * tx + dz * tz, off = Math.abs(dx * tz - dz * tx);
        if (off < minOff || off > maxOff || Math.abs(along) > maxAhead) continue;
        if (Math.abs(f.tx[i] * tx + f.tz[i] * tz) >= cosMin) return true;
      }
    }
    return false;
  }

  class Kernel {
    readonly C: number;
    readonly n: number;
    private info: Uint8Array;   // per vertex: 1 known, 2 water, 4 building, 8 network, 16 forbidden
    private hgt: Float32Array;
    private gcost: Float32Array;
    private parent: Int32Array;
    private closed: Uint8Array;
    private heap = new Heap();
    private goal: number;
    private goalDirs: Set<number>;
    private forbid: { x: number; z: number; a: number; w: number; d: number; r: number }[] = [];
    private lead: number;
    private startV = -1;
    private minRun: number;
    private runs: number;
    /** per vertex and axis (heading mod 180°): 0 unknown, 1 clear, 2 existing rail alongside */
    private par: Uint8Array | null = null;
    private field: RailField | null = null;
    expanded = 0;
    state: 'running' | 'done' | 'failed' = 'running';
    path: P2[] | null = null;

    private from: OPoint;
    private to: OPoint;
    private opts: CorridorOpts;

    constructor(private snapshot: CorridorSnapshot) {
      const { from, to, opts, size } = snapshot;
      this.from = from; this.to = to; this.opts = opts;
      this.C = opts.cell ?? Math.max(4, Math.ceil(size / 96));
      // Two 45-degree corners share a straight: each needs R*tan(22.5 degrees).
      this.minRun = opts.minR ? Math.max(MIN_RUN, Math.ceil(2 * opts.minR * Math.tan(Math.PI / 8) / this.C)) : MIN_RUN;
      this.runs = Math.max(4, this.minRun + 1);
      this.n = Math.floor(size / this.C) + 1;
      const N = this.n * this.n;
      this.info = new Uint8Array(N);
      this.hgt = new Float32Array(N);
      this.gcost = new Float32Array(N * 8 * this.runs).fill(Infinity);
      this.parent = new Int32Array(N * 8 * this.runs).fill(-1);
      this.closed = new Uint8Array(N * 8 * this.runs);
      this.forbid = snapshot.forbid;
      this.lead = opts.lead ?? 10;
      const s0 = this.vertex(from.x + from.tx * this.lead, from.z + from.tz * this.lead);
      this.startV = s0;
      this.goal = this.vertex(to.x - to.tx * this.lead, to.z - to.tz * this.lead);
      // arrival headings within ~50 degrees of the goal tangent
      this.goalDirs = new Set();
      DIRS.forEach(([dx, dz], i) => { if ((dx * to.tx + dz * to.tz) / Math.hypot(dx, dz) > 0.64) this.goalDirs.add(i); });
      const h0 = nearestDir(from.tx, from.tz);
      const st = (s0 * 8 + h0) * this.runs + 1;
      this.gcost[st] = 0;
      this.heap.push(st, this.heur(s0));
    }

    private vertex(x: number, z: number) {
      const i = Math.max(1, Math.min(this.n - 2, Math.round(x / this.C))), j = Math.max(1, Math.min(this.n - 2, Math.round(z / this.C)));
      return j * this.n + i;
    }
    private heur(v: number) {
      const gx = (v % this.n) * this.C, gz = Math.floor(v / this.n) * this.C;
      const tx = (this.goal % this.n) * this.C, tz = Math.floor(this.goal / this.n) * this.C;
      return Math.hypot(gx - tx, gz - tz);
    }

    private probe(v: number) {
      if (this.info[v]) return this.info[v];
      const C = this.C;
      const cx = (v % this.n) * C, cz = Math.floor(v / this.n) * C;
      let f = 1, hs = 0, hn = 0, water = 0;
      const r = Math.ceil(C / 2), size = this.snapshot.size;
      for (let z = cz - r; z <= cz + r; z++) for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || z < 0 || x > size || z > size) continue;
        const k = z * (size + 1) + x, h = this.snapshot.h[k];
        hs += h; hn++;
        if (h < this.snapshot.waterLimit) water++;
        if (Math.abs(x - cx) <= 1 && Math.abs(z - cz) <= 1) {
          if (this.snapshot.lock[k] & 2) f |= 4;
          if (this.snapshot.lock[k] & 1) f |= 8;
        }
      }
      this.hgt[v] = hn ? hs / hn : 0;
      if (water * 2 > hn) f |= 2;
      if (!(cx >= 5 && cz >= 5 && cx <= this.snapshot.size - 5 && cz <= this.snapshot.size - 5)) f |= 16;
      for (const fb of this.forbid) {
        if (Math.abs(cx - fb.x) > fb.r || Math.abs(cz - fb.z) > fb.r) continue;
        if (distToRect(cx, cz, fb.x, fb.z, fb.a, fb.w, fb.d) <= 0) { f |= 16; break; }
      }
      for (const a of this.opts.avoid ?? []) {
        const dx = a.x1 - a.x0, dz = a.z1 - a.z0, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((cx - a.x0) * dx + (cz - a.z0) * dz) / l2));
        if (Math.hypot(a.x0 + dx * t - cx, a.z0 + dz * t - cz) < a.r) { f |= 16; break; }
      }
      this.info[v] = f;
      return f;
    }

    /** Run up to `budget` expansions; returns the state. */
    step(budget: number): 'running' | 'done' | 'failed' {
      return this.expand(budget);
    }

    private expand(budget: number): 'running' | 'done' | 'failed' {
      if (this.state !== 'running') return this.state;
      const n = this.n, C = this.C;
      const grade = this.snapshot.grade;
      const bcost = this.opts.buildingCost ?? 1, sc = this.opts.slopeCost ?? 1;
      const maxExpand = this.opts.maxExpand ?? 250000;
      while (budget-- > 0) {
        if (!this.heap.size) { this.state = 'failed'; return this.state; }
        const s = this.heap.pop();
        if (this.closed[s]) continue;
        this.closed[s] = 1;
        const vh = Math.floor(s / this.runs), u = vh >> 3, h = vh & 7, run = s % this.runs;
        if (u === this.goal && this.goalDirs.has(h)) { this.finish(s); return this.state; }
        if (++this.expanded > maxExpand) { this.state = 'failed'; return this.state; }
        const ux = u % n, uz = Math.floor(u / n);
        this.probe(u);
        const hu = this.hgt[u];
        const nearStation = this.opts.approachLength && (this.heur(u) < this.opts.approachLength || Math.hypot(ux * C - this.from.x, uz * C - this.from.z) < this.opts.approachLength);
        for (const dt of [0, 1, -1]) {
          if (dt && run < (nearStation ? MIN_RUN : this.minRun)) continue;
          const di = (h + dt + 8) & 7;
          const vx = ux + DIRS[di][0], vz = uz + DIRS[di][1];
          if (vx < 1 || vz < 1 || vx >= n - 1 || vz >= n - 1) continue;
          const v = vz * n + vx;
          const ns = (v * 8 + di) * this.runs + (dt ? 0 : Math.min(this.runs - 1, run + 1));
          if (this.closed[ns]) continue;
          const f = this.probe(v);
          if (f & 16 && v !== this.goal && u !== this.startV) continue;
          const d = (di & 1 ? Math.SQRT2 : 1) * C;
          let c = d;
          const dh = Math.abs(this.hgt[v] - hu);
          c += (dh * 2 + Math.max(0, dh - grade * d) * 14) * sc;
          if (f & 2) c += d * 4.5;
          if (f & 4) c += 22 * bcost;
          if (f & 8) c += 9;
          if (dt) c += C * 0.8;
          if (this.opts.parallel && this.alongside(v, di)) c += d * this.opts.parallel;
          const nc = this.gcost[s] + c;
          if (nc >= this.gcost[ns]) continue;
          this.gcost[ns] = nc;
          this.parent[ns] = s;
          this.heap.push(ns, nc + this.heur(v));
        }
      }
      return this.state;
    }

    run(budget: number): CorridorReply {
      const steps: CorridorReply['steps'] = [];
      do { steps.push({ state: this.step(budget), expanded: this.expanded }); } while (this.state === 'running');
      return { steps, path: this.path, expanded: this.expanded };
    }

    /** Does existing rail run alongside a vertex at heading `di` (3–30 units off, within ~25°)? Cached per axis. */
    private alongside(v: number, di: number): boolean {
      if (!this.par) { this.par = new Uint8Array(this.n * this.n * 4); this.field = this.snapshot.field!; }
      const k = v * 4 + (di & 3);
      if (!this.par[k]) {
        const [dx, dz] = DIRS[di], l = Math.hypot(dx, dz);
        this.par[k] = parallelRailAt(this.field!, (v % this.n) * this.C, Math.floor(v / this.n) * this.C, dx / l, dz / l) ? 2 : 1;
      }
      return this.par[k] === 2;
    }

    private finish(s: number) {
      const verts: P2[] = [];
      let lastH = -1;
      // keep only the turn vertices of the grid path
      const chain: number[] = [];
      for (let q = s; q >= 0; q = this.parent[q]) chain.push(q);
      chain.reverse();
      for (let i = 0; i < chain.length; i++) {
        const vh = Math.floor(chain[i] / this.runs), v = vh >> 3, h = vh & 7;
        const nh = i + 1 < chain.length ? Math.floor(chain[i + 1] / this.runs) & 7 : -2;
        if (i === 0 || i === chain.length - 1 || nh !== h) verts.push({ x: (v % this.n) * this.C, z: Math.floor(v / this.n) * this.C });
        lastH = h;
      }
      void lastH;
      const L = this.lead;
      this.path = [
        { x: this.from.x, z: this.from.z }, { x: this.from.x + this.from.tx * L, z: this.from.z + this.from.tz * L },
        ...verts.slice(1, -1),
        { x: this.to.x - this.to.tx * L, z: this.to.z - this.to.tz * L }, { x: this.to.x, z: this.to.z },
      ];
      this.state = 'done';
    }
  }
  return new Kernel(snapshot);
}
