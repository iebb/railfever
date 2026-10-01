// Uniform grid spatial index for objects with axis-aligned bounding boxes.

export class SpatialGrid {
  private cells = new Map<number, number[]>();
  private boxes = new Map<number, [number, number, number, number]>();
  constructor(public cell: number, private cols = 100000) {}

  private key(cx: number, cz: number) { return cz * this.cols + cx; }

  insert(id: number, x0: number, z0: number, x1: number, z1: number) {
    if (this.boxes.has(id)) this.remove(id);
    this.boxes.set(id, [x0, z0, x1, z1]);
    const c = this.cell;
    for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++) for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
      const k = this.key(cx, cz);
      let a = this.cells.get(k);
      if (!a) { a = []; this.cells.set(k, a); }
      a.push(id);
    }
  }

  remove(id: number) {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    const c = this.cell;
    for (let cz = Math.floor(b[1] / c); cz <= Math.floor(b[3] / c); cz++) for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++) {
      const k = this.key(cx, cz);
      const a = this.cells.get(k);
      if (!a) continue;
      const i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1); // keep insertion order (deterministic queries, also after save/load)
      if (!a.length) this.cells.delete(k);
    }
  }

  /** Unique ids whose box intersects the query box. */
  query(x0: number, z0: number, x1: number, z1: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const c = this.cell;
    for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++) for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
      const a = this.cells.get(this.key(cx, cz));
      if (!a) continue;
      for (const id of a) {
        if (seen.has(id)) continue;
        seen.add(id);
        const b = this.boxes.get(id)!;
        if (b[0] <= x1 && b[2] >= x0 && b[1] <= z1 && b[3] >= z0) out.push(id);
      }
    }
    return out;
  }

  box(id: number) { return this.boxes.get(id); }
  clear() { this.cells.clear(); this.boxes.clear(); }
}
