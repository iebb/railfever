import type { TripSnapshotData, SnapshotTripInputs } from './demand';
import { snapshotTrips } from './demand';
import { retainPlannerInput, preparePlannerInput, type PlannerInput } from './ai-task-inputs';

type CapturedValues = number[] | PlannerInput<Float32Array>;
export interface SelectionDemandSnapshot extends Omit<TripSnapshotData, 'od' | 'ld' | 'big' | 'attract'> {
  od: CapturedValues; ld: CapturedValues; big: CapturedValues; attract: CapturedValues;
}

/** Take ownership of detached demand inputs. Native Float32 tables retain every value in private immutable bytes. */
export function selectionDemandSnapshot(snapshot: TripSnapshotData): SelectionDemandSnapshot {
  const retain = (values: number[]): CapturedValues => {
    const copy = new Float32Array(values);
    // Public/custom DTOs may contain doubles. Preserve those exactly rather than silently quantizing them.
    for (let i = 0; i < values.length; i++)
      if (!Object.hasOwn(values, i) || !Object.is(copy[i], values[i])) return values;
    const input = retainPlannerInput(copy); preparePlannerInput(input); return input;
  };
  return { ...snapshot, od: retain(snapshot.od), ld: retain(snapshot.ld), big: retain(snapshot.big), attract: retain(snapshot.attract) };
}

/** Views only: no per-row array copy, retained cache, mutable-world reference or change to evaluator arithmetic. */
export function selectionDemandInputs(snapshot: SelectionDemandSnapshot): SnapshotTripInputs {
  const values = (input: CapturedValues) => Array.isArray(input) ? input : input.value;
  return { ...snapshot, od: values(snapshot.od), ld: values(snapshot.ld), big: values(snapshot.big), attract: values(snapshot.attract) };
}

/** Next regional row, and the actual demand inputs captured before the first yield. */
export interface SelectionDemand {
  towns: number; row: number; snapshot: SelectionDemandSnapshot; matrix: number[];
}

/** Consume the previously yielded row. The caller still yields once per region, including cache hits. */
export function selectionDemandRow(c: SelectionDemand): void {
  const input = selectionDemandInputs(c.snapshot), R = input.regions, a = R[c.row].town, nt = c.towns;
  if (a < 0 || a >= nt) return;
  for (let q = 0; q < R.length; q++) {
    const b = R[q].town;
    if (q === c.row || b < 0 || b >= nt) continue;
    const t = snapshotTrips(input, c.row, q, a === b ? 'city' : 'intercity');
    c.matrix[a * nt + b] += t;
    if (a !== b) c.matrix[b * nt + a] += t;
  }
}
