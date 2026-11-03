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

/** Exact, JSON-safe continuation of an already-started coarse search. Unknown states remain implicit
 * Infinity/-1/zero, and discovered Float32 values retain their exact numeric values after JSON loading. */
export interface CorridorKernelState {
  version: 1;
  dimensions: [number, number, number];
  cells: number[];
  states: number[];
  heap: { f: number[]; v: number[] };
  parallel: number[] | null;
  expanded: number;
  state: 'running' | 'done' | 'failed';
  path: P2[] | null;
}

/** A private immutable save payload; the runtime frontier remains authoritative. */
export interface PackedCorridorKernelState extends Omit<CorridorKernelState, 'dimensions' | 'cells' | 'states' | 'heap' | 'parallel'> {
  packed: Uint8Array;
}
export interface CorridorFrontierView {
  dimensions: [number, number, number]; cells: number[]; info: Uint8Array; height: Float32Array;
  states: number[]; cost: Float32Array; parent: Int32Array; closed: Uint8Array;
  heap: { f: number[]; v: number[] }; parallel: number[] | null; parallelValues: Uint8Array | null;
}

/** Self-contained for the inline worker too. Counts and all numeric fields have explicit little-endian widths. */
export function corridorFrontierCodec() {
  const MAGIC = 0x46524331, VERSION = 1, LITTLE_ENDIAN = 0x4c45, HEADER = 48;
  const sizeOf = (cells: number, states: number, heap: number, parallel: number) => HEADER + cells * 9 + states * 13 + heap * 12 + parallel * 5;
  function pack(v: CorridorFrontierView): Uint8Array {
    const nc = v.cells.length, ns = v.states.length, nh = v.heap.v.length, np = v.parallel?.length ?? 0;
    const length = sizeOf(nc, ns, nh, np);
    if (![nc, ns, nh, np].every(n => Number.isInteger(n) && n >= 0 && n < 0xffffffff)
      || !Number.isSafeInteger(length) || length > 0x7fffffff || nh !== v.heap.f.length) throw new Error('Invalid frontier dimensions');
    const bytes = new Uint8Array(length), d = new DataView(bytes.buffer);
    d.setUint32(0, MAGIC, true); d.setUint16(4, VERSION, true); d.setUint16(6, LITTLE_ENDIAN, true);
    v.dimensions.forEach((x, i) => d.setFloat64(8 + i * 8, x, true));
    [nc, ns, nh, v.parallel === null ? 0xffffffff : np].forEach((n, i) => d.setUint32(32 + i * 4, n, true));
    let at = HEADER;
    for (const i of v.cells) { d.setUint32(at, i, true); d.setUint8(at + 4, v.info[i]); d.setFloat32(at + 5, v.height[i], true); at += 9; }
    for (const i of v.states) { d.setUint32(at, i, true); d.setFloat32(at + 4, v.cost[i], true); d.setInt32(at + 8, v.parent[i], true); d.setUint8(at + 12, v.closed[i]); at += 13; }
    for (let i = 0; i < nh; i++) { d.setFloat64(at, v.heap.f[i], true); d.setInt32(at + 8, v.heap.v[i], true); at += 12; }
    for (const i of v.parallel ?? []) { d.setUint32(at, i, true); d.setUint8(at + 4, v.parallelValues![i]); at += 5; }
    return bytes;
  }
  function unpack(packed: PackedCorridorKernelState): CorridorKernelState {
    const bytes = packed.packed;
    if (packed.version !== 1 || Object.getPrototypeOf(bytes) !== Uint8Array.prototype || bytes.byteLength < HEADER) throw new Error('Invalid packed frontier');
    if (!Number.isSafeInteger(packed.expanded) || packed.expanded < 0 || !['running', 'done', 'failed'].includes(packed.state))
      throw new Error('Invalid packed frontier progress');
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (d.getUint32(0, true) !== MAGIC || d.getUint16(4, true) !== VERSION || d.getUint16(6, true) !== LITTLE_ENDIAN)
      throw new Error('Incompatible packed frontier');
    const dimensions = [0, 1, 2].map(i => d.getFloat64(8 + i * 8, true)) as [number, number, number];
    if (!dimensions.every(x => Number.isFinite(x) && x > 0) || !Number.isInteger(dimensions[1]) || !Number.isInteger(dimensions[2]))
      throw new Error('Invalid packed frontier dimensions');
    const nc = d.getUint32(32, true), ns = d.getUint32(36, true), nh = d.getUint32(40, true), parallelCount = d.getUint32(44, true);
    const np = parallelCount === 0xffffffff ? 0 : parallelCount;
    if (sizeOf(nc, ns, nh, np) !== bytes.byteLength) throw new Error('Invalid packed frontier counts');
    const N = dimensions[1] * dimensions[1], S = N * 8 * dimensions[2];
    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(S) || nc > N || ns > S || np > N * 4) throw new Error('Invalid packed frontier bounds');
    const cells: number[] = [], states: number[] = [], heap = { f: [] as number[], v: [] as number[] }, parallel = parallelCount === 0xffffffff ? null : [] as number[];
    let at = HEADER;
    for (let k = 0; k < nc; k++) { const i = d.getUint32(at, true); if (i >= N) throw new Error('Invalid frontier cell'); cells.push(i, d.getUint8(at + 4), d.getFloat32(at + 5, true)); at += 9; }
    for (let k = 0; k < ns; k++) {
      const i = d.getUint32(at, true), parent = d.getInt32(at + 8, true);
      if (i >= S || parent < -1 || parent >= S) throw new Error('Invalid frontier state');
      states.push(i, d.getFloat32(at + 4, true), parent, d.getUint8(at + 12)); at += 13;
    }
    for (let k = 0; k < nh; k++) { const i = d.getInt32(at + 8, true); if (i < 0 || i >= S) throw new Error('Invalid frontier heap'); heap.f.push(d.getFloat64(at, true)); heap.v.push(i); at += 12; }
    for (let k = 0; k < np; k++) { const i = d.getUint32(at, true); if (i >= N * 4) throw new Error('Invalid frontier parallel cell'); parallel!.push(i, d.getUint8(at + 4)); at += 5; }
    return { version: 1, dimensions, cells, states, heap, parallel, expanded: packed.expanded, state: packed.state, path: packed.path };
  }
  return { pack, unpack };
}

/** Identical Float32 costs, heap tie order and budget accounting in workers and synchronous fallback. */
export function createCorridorKernel(snapshot: CorridorSnapshot, continuation?: CorridorKernelState | PackedCorridorKernelState,
  codecFactory: typeof corridorFrontierCodec = corridorFrontierCodec) {
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const MIN_RUN = 2, FIELD_CELL = 16;
  const frontierCodec = codecFactory();
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
    private knownCells: number[] = [];
    private knownStates: number[] = [];
    private knownParallel: number[] = [];
    private packedBytes: Uint8Array | null = null;
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
      this.gcost[st] = 0; this.knownStates.push(st);
      this.heap.push(st, this.heur(s0));
    }

    /** Copy the actual frontier, never rerun earlier slices against a newer world. */
    record(): CorridorKernelState {
      const cells: CorridorKernelState['cells'] = [], states: CorridorKernelState['states'] = [];
      for (const i of this.knownCells) cells.push(i, this.info[i], this.hgt[i]);
      for (const i of this.knownStates)
        states.push(i, this.gcost[i], this.parent[i], this.closed[i]);
      const parallel: CorridorKernelState['parallel'] = this.par ? [] : null;
      if (this.par) for (const i of this.knownParallel) parallel!.push(i, this.par[i]);
      return { version: 1, dimensions: [this.C, this.n, this.runs], cells, states,
        heap: { f: [...this.heap.f], v: [...this.heap.v] }, parallel, expanded: this.expanded,
        state: this.state, path: this.path?.map(p => ({ ...p })) ?? null };
    }

    /** Derived bytes are private and immutable. Public record() copies are never cached. */
    packedRecord(): PackedCorridorKernelState {
      this.packedBytes ??= frontierCodec.pack({ dimensions: [this.C, this.n, this.runs], cells: this.knownCells, info: this.info,
        height: this.hgt, states: this.knownStates, cost: this.gcost, parent: this.parent, closed: this.closed,
        heap: this.heap, parallel: this.par ? this.knownParallel : null, parallelValues: this.par });
      return { version: 1, packed: this.packedBytes, expanded: this.expanded, state: this.state, path: this.path?.map(p => ({ ...p })) ?? null };
    }

    restore(input: CorridorKernelState | PackedCorridorKernelState) {
      this.packedBytes = null;
      const saved = 'packed' in input ? frontierCodec.unpack(input) : input;
      if (saved.version !== 1 || saved.dimensions[0] !== this.C || saved.dimensions[1] !== this.n || saved.dimensions[2] !== this.runs)
        throw new Error('Incompatible corridor continuation');
      this.info.fill(0); this.hgt.fill(0); this.gcost.fill(Infinity); this.parent.fill(-1); this.closed.fill(0);
      this.knownCells = []; this.knownStates = []; this.knownParallel = [];
      for (let k = 0; k < saved.cells.length; k += 3) { const i = saved.cells[k]; this.knownCells.push(i); this.info[i] = saved.cells[k + 1]; this.hgt[i] = saved.cells[k + 2]; }
      for (let k = 0; k < saved.states.length; k += 4) { const i = saved.states[k]; this.knownStates.push(i); this.gcost[i] = saved.states[k + 1]; this.parent[i] = saved.states[k + 2]; this.closed[i] = saved.states[k + 3]; }
      this.heap.f = [...saved.heap.f]; this.heap.v = [...saved.heap.v];
      this.par = saved.parallel ? new Uint8Array(this.n * this.n * 4) : null;
      if (saved.parallel) for (let k = 0; k < saved.parallel.length; k += 2) { const i = saved.parallel[k]; this.knownParallel.push(i); this.par![i] = saved.parallel[k + 1]; }
      this.field = this.par ? this.snapshot.field ?? null : null;
      this.expanded = saved.expanded; this.state = saved.state;
      this.path = saved.path?.map(p => ({ ...p })) ?? null;
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
      this.info[v] = f; this.knownCells.push(v);
      return f;
    }

    /** Run up to `budget` expansions; returns the state. */
    step(budget: number): 'running' | 'done' | 'failed' {
      this.packedBytes = null;
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
          if (!Number.isFinite(this.gcost[ns])) this.knownStates.push(ns);
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
        this.knownParallel.push(k);
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
  const kernel = new Kernel(snapshot);
  if (continuation) kernel.restore(continuation);
  return kernel;
}
