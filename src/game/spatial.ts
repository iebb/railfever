// Uniform grid spatial index for objects with axis-aligned bounding boxes.

export type SpatialBox = readonly [number, number, number, number];
export interface RegionSnapshot { ids: number[]; values: number[]; version: number }

/** Numeric, event-driven stamps for 32-unit regions. No object queries or signatures on reads. */
export class RegionVersions {
  constructor(readonly cell = 32) {}
  version = 0;
  private all = 0;
  private cells = new Map<number, number>();
  get fallbackVersion() { return this.all; }
  static ids(box: SpatialBox, cell = 32): number[] {
    const ids: number[] = [];
    for (let z = Math.ceil(box[1] / cell) - 1; z <= Math.floor(box[3] / cell); z++)
      for (let x = Math.ceil(box[0] / cell) - 1; x <= Math.floor(box[2] / cell); x++) ids.push(z * 100000 + x);
    return ids;
  }
  /** Unknown attribution (including a bulk replacement) safely invalidates every region. */
  bump(box?: SpatialBox) {
    if (!box || !box.every(Number.isFinite)) { this.all = ++this.version; this.cells.clear(); return; }
    const v = ++this.version;
    // Terrain preparation can touch thousands of vertices: stamp directly without a temporary ID array.
    const x0 = Math.ceil(box[0] / this.cell) - 1, x1 = Math.floor(box[2] / this.cell);
    const z0 = Math.ceil(box[1] / this.cell) - 1, z1 = Math.floor(box[3] / this.cell);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells.set(z * 100000 + x, v);
  }
  private at(id: number) { return this.cells.get(id) ?? this.all; }
  snapshot(ids: number[]): RegionSnapshot { return { ids, values: ids.map((id) => this.at(id)), version: this.version }; }
  refresh(s: RegionSnapshot) {
    for (let i = 0; i < s.ids.length; i++) s.values[i] = this.at(s.ids[i]);
    s.version = this.version;
  }
  unchanged(s: RegionSnapshot): boolean {
    if (s.version === this.version) return true;
    for (let i = 0; i < s.ids.length; i++) if (s.values[i] !== this.at(s.ids[i])) return false;
    s.version = this.version;
    return true;
  }
}

interface GridEntry {
  id: number;
  box: [number, number, number, number];
  x0: number;
  z0: number;
  cell: number;
  cx: number;
  cz: number;
}

export class SpatialGrid {
  private cells = new Map<number, GridEntry[]>();
  private boxes = new Map<number, GridEntry>();
  constructor(public cell: number, private cols = 100000,
    private onChange?: (id: number, box: SpatialBox | undefined, added: boolean) => void) {}

  private key(cx: number, cz: number) { return cz * this.cols + cx; }

  insert(id: number, x0: number, z0: number, x1: number, z1: number) {
    if (this.boxes.has(id)) this.remove(id);
    const entry: GridEntry = { id, box: [x0, z0, x1, z1], x0, z0, cell: 0, cx: 0, cz: 0 };
    this.boxes.set(id, entry);
    this.onChange?.(id, [x0, z0, x1, z1], true);
    const c = this.cell;
    entry.cell = c; entry.cx = Math.floor(x0 / c); entry.cz = Math.floor(z0 / c);
    for (let cz = entry.cz; cz <= Math.floor(z1 / c); cz++) for (let cx = entry.cx; cx <= Math.floor(x1 / c); cx++) {
      const k = this.key(cx, cz);
      let a = this.cells.get(k);
      if (!a) { a = []; this.cells.set(k, a); }
      a.push(entry);
    }
  }

  remove(id: number) {
    const entry = this.boxes.get(id);
    if (!entry) return;
    const b = entry.box;
    this.onChange?.(id, b, false);
    this.boxes.delete(id);
    const c = this.cell;
    for (let cz = Math.floor(b[1] / c); cz <= Math.floor(b[3] / c); cz++) for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++) {
      const k = this.key(cx, cz);
      const a = this.cells.get(k);
      if (!a) continue;
      const i = a.indexOf(entry);
      if (i >= 0) a.splice(i, 1); // keep insertion order (deterministic queries, also after save/load)
      if (!a.length) this.cells.delete(k);
    }
  }

  /** Unique ids whose box intersects the query box (in the order of the first cell they appear in). */
  query(x0: number, z0: number, x1: number, z1: number): number[] {
    const out: number[] = [];
    const c = this.cell;
    const qx0 = Math.floor(x0 / c), qz0 = Math.floor(z0 / c), qx1 = Math.floor(x1 / c), qz1 = Math.floor(z1 / c);
    for (let cz = qz0; cz <= qz1; cz++) for (let cx = qx0; cx <= qx1; cx++) {
      const a = this.cells.get(this.key(cx, cz));
      if (!a) continue;
      for (const entry of a) {
        const b = entry.box;
        if (b[0] > x1 || b[2] < x0 || b[1] > z1 || b[3] < z0) continue;
        // an object spanning several cells is reported from the first of them inside the query (no set needed)
        // box() and cell retain their writable legacy API. Reuse the insertion coordinates only
        // while those inputs match; direct edits keep the original query's first-cell semantics.
        const cached = c === entry.cell && b[0] === entry.x0 && b[1] === entry.z0;
        const bx = cached ? entry.cx : Math.floor(b[0] / c), bz = cached ? entry.cz : Math.floor(b[1] / c);
        if (cx !== Math.max(bx, qx0) || cz !== Math.max(bz, qz0)) continue;
        out.push(entry.id);
      }
    }
    return out;
  }

  box(id: number) { return this.boxes.get(id)?.box; }
  clear() { this.onChange?.(-1, undefined, false); this.cells.clear(); this.boxes.clear(); }
}
