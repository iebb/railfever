// Disposable reachability over the owned, immutable first-hop tables of one synchronous quote.
import type { Hop } from './lines';

export interface ForecastReachIndex {
  hasFrom(from: number): boolean;
  has(from: number, to: number): boolean;
}

/** A false answer proves the chosen hop chain never boards this line. True answers may include cycles. */
export function forecastReachIndex(tables: ReadonlyMap<number, ReadonlyMap<number, Readonly<Pick<Hop, 'line' | 'alight'>>>>,
  targets: Iterable<number>, line: number): ForecastReachIndex | undefined {
  const rows = [...tables], destinations = [...new Set(targets)], width = rows.length;
  // This optional index must not allocate an unbounded matrix for a large existing network.
  if (width > 1_048_576 || destinations.length > 1_048_576 || width * destinations.length > 1_048_576) return undefined;
  const index = new Map(rows.map(([id], i) => [id, i])), columns = new Map(destinations.map((id, i) => [id, i]));
  const mask = new Uint8Array(width * destinations.length), origins = new Uint8Array(width);
  const heads = new Int32Array(width), links = new Int32Array(width), queue = new Int32Array(width);
  for (let column = 0; column < destinations.length; column++) {
    const offset = column * width;
    heads.fill(-1); let end = 0;
    for (let i = 0; i < width; i++) {
      const hop = rows[i][1].get(destinations[column]);
      if (!hop) continue;
      if (hop.line === line) { mask[offset + i] = origins[i] = 1; queue[end++] = i; }
      const next = index.get(hop.alight);
      if (next !== undefined) { links[i] = heads[next]; heads[next] = i; }
    }
    // Each station has one chosen first hop for this destination. Follow its reverse edges once,
    // retaining all possible users of the line even when the original journey later proves cyclic.
    for (let at = 0; at < end; at++) for (let previous = heads[queue[at]]; previous >= 0; previous = links[previous]) {
      if (mask[offset + previous]) continue;
      mask[offset + previous] = origins[previous] = 1; queue[end++] = previous;
    }
  }
  return {
    hasFrom(from) { const i = index.get(from); return i !== undefined && !!origins[i]; },
    has(from, to) { const i = index.get(from), j = columns.get(to); return i !== undefined && j !== undefined && !!mask[j * width + i]; },
  };
}
