import type { Game } from './game';
import type { Train } from './train';
import { MODEL_BY_ID } from './vehicle-types';
import { plannerWalkSnapshot } from './catchment';
import { isPlannerInput, savePlannerInput, loadPlannerInput, type PlannerInputPayload } from './ai-task-inputs';

/** A live routing Map iterator restarts at its first new entry when rebuild clears/refills that Map. */
export interface SelectionRoutingEpoch { selectionRoutingEpoch: number }
/** Config and focus are separate retained identities; assigning config/focus can replace either one. */
export interface PlannerTaskScope { company: number; config: object; focus: object; project?: object }
type NativeKind = 'station' | 'stationStop' | 'rail' | 'line' | 'model' | 'edge' | 'node' | 'managed' | 'routing' | 'depot' | 'town' | 'config' | 'focus' | 'project' | 'trainCars';
type NativeRef = { native: NativeKind; id: number | string };
type Scalar = 'undefined' | 'NaN' | 'Infinity' | '-Infinity' | '-0' | 'hole';
type Value = null | boolean | string | number | { scalar: Scalar } | { ref: number } | NativeRef;
type RecordData =
  | { kind: 'object'; nullPrototype: boolean; entries: [string, Value][] }
  | { kind: 'array'; values: Value[] }
  | { kind: 'map'; entries: [Value, Value][] }
  | { kind: 'set'; values: Value[] }
  | { kind: 'float32' | 'float64'; values: Value[] }
  | { kind: 'routingEpoch' | 'demandEpoch'; current: boolean }
  | { kind: 'plannerInput'; input: PlannerInputPayload };
export interface PlannerTaskData { version: 1; root: Value; records: RecordData[] }

/**
 * Saved planner inputs are a graph, not a tree. Current native objects bind by ID; a replaced native object stays
 * detached data, with every alias to it preserved. That distinction keeps stale station/line identity guards honest.
 * Records may contain scalar data and the collections below, never Game/vehicle instances, functions or generators.
 */
export function savePlannerTask<T>(g: Game, managed: ReadonlyMap<number, object>, task: T, scope?: PlannerTaskScope): PlannerTaskData {
  const native = new Map<object, NativeRef>();
  for (const [id, station] of g.stations.map) {
    native.set(station, { native: 'station', id });
    station.stops.forEach((stop, index) => native.set(stop, { native: 'stationStop', id: `${id}:${index}` }));
    if (station.rail) native.set(station.rail, { native: 'rail', id });
  }
  for (const [id, line] of g.lines.map) native.set(line, { native: 'line', id });
  for (const [id, model] of MODEL_BY_ID) native.set(model, { native: 'model', id });
  // Train construction retains the supplied consist array. Later fleet purchases must retain that alias too.
  // loadNetwork restores shared consists onto the lowest train ID after AI task decoding, so bind that member.
  for (const vehicle of g.vehicles.map.values()) if (vehicle.kind === 'train') {
    const cars = (vehicle as Train).cars, existing = native.get(cars);
    if (!existing || vehicle.id < Number(existing.id)) native.set(cars, { native: 'trainCars', id: vehicle.id });
  }
  for (const [id, edge] of g.world.net.edges) native.set(edge, { native: 'edge', id });
  for (const [id, node] of g.world.net.nodes) native.set(node, { native: 'node', id });
  for (const [id, depot] of g.depots.map) native.set(depot, { native: 'depot', id });
  for (const town of g.towns.list) native.set(town, { native: 'town', id: town.id });
  for (const [id, info] of managed) native.set(info, { native: 'managed', id });
  for (const [id, table] of g.lines.routing) native.set(table, { native: 'routing', id });
  if (scope) {
    native.set(scope.config, { native: 'config', id: scope.company });
    native.set(scope.focus, { native: 'focus', id: scope.company });
    if (scope.project) native.set(scope.project, { native: 'project', id: scope.company });
  }
  const records: RecordData[] = [], seen = new Map<object, number>(), immutableInputs = new Map<string, number>();
  const encode = (value: unknown): Value => {
    if (value === undefined) return { scalar: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (Object.is(value, -0)) return { scalar: '-0' };
      return Number.isFinite(value) ? value : { scalar: String(value) as Scalar };
    }
    if (typeof value !== 'object') throw new Error(`Unsupported planner task value: ${typeof value}`);
    const binding = native.get(value);
    if (binding) return binding;
    const known = seen.get(value);
    if (known !== undefined) return { ref: known };
    if (isPlannerInput(value)) {
      // Immutable equal inputs deliberately share authority. Canonicalize them before assigning graph IDs too:
      // the invocation-local restore table returns one shared wrapper for content-equal input payloads.
      const input = savePlannerInput(g, value), key = JSON.stringify(input), old = immutableInputs.get(key);
      if (old !== undefined) { seen.set(value, old); return { ref: old }; }
      const id = records.length;
      seen.set(value, id); immutableInputs.set(key, id); records.push({ kind: 'plannerInput', input });
      return { ref: id };
    }
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Unsupported planner symbol properties');
    const id = records.length;
    seen.set(value, id);
    // Reserve the graph ID before walking children, including self-referential detached records.
    records.push({ kind: 'object', nullPrototype: false, entries: [] });
    const walk = plannerWalkSnapshot(value);
    const routingEpoch = Object.getOwnPropertyDescriptor(value, 'selectionRoutingEpoch');
    const demandEpoch = Object.getOwnPropertyDescriptor(value, 'selectionDemandEpoch');
    if (walk) {
      records[id] = { kind: 'object', nullPrototype: false, entries: [['segments', encode(walk.segments)], ['buildings', encode(walk.buildings)]] };
    } else if (routingEpoch) {
      if (Object.keys(value).length !== 1 || !('value' in routingEpoch) || typeof routingEpoch.value !== 'number') throw new Error('Invalid planner routing epoch');
      records[id] = { kind: 'routingEpoch', current: routingEpoch.value === g.lines.version };
    } else if (demandEpoch) {
      if (Object.keys(value).length !== 1 || !('value' in demandEpoch) || typeof demandEpoch.value !== 'number') throw new Error('Invalid planner demand epoch');
      records[id] = { kind: 'demandEpoch', current: demandEpoch.value === g.demand.version };
    } else if (value instanceof Map) {
      if (Object.getPrototypeOf(value) !== Map.prototype || Object.keys(value).length) throw new Error('Unsupported planner Map properties');
      records[id] = { kind: 'map', entries: [...value].map(([key, item]) => [encode(key), encode(item)]) };
    } else if (value instanceof Set) {
      if (Object.getPrototypeOf(value) !== Set.prototype || Object.keys(value).length) throw new Error('Unsupported planner Set properties');
      records[id] = { kind: 'set', values: [...value].map(encode) };
    } else if (value instanceof Float32Array || value instanceof Float64Array) {
      if (Object.getPrototypeOf(value) !== Float32Array.prototype && Object.getPrototypeOf(value) !== Float64Array.prototype) throw new Error('Unsupported planner typed array class');
      records[id] = { kind: value instanceof Float32Array ? 'float32' : 'float64', values: Array.from(value).map(encode) };
    } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      throw new Error('Unsupported planner typed array');
    } else if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('Unsupported planner array class');
      if (Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error('Unsupported planner array properties');
      records[id] = { kind: 'array', values: Array.from({ length: value.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property) return { scalar: 'hole' };
        if (!('value' in property)) throw new Error('Unsupported planner array accessor');
        return encode(property.value);
      }) };
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Unsupported planner task class');
      const entries = Object.keys(value).map((key): [string, Value] => {
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in property)) throw new Error('Unsupported planner record accessor');
        return [key, encode(property.value)];
      });
      records[id] = { kind: 'object', nullPrototype: prototype === null, entries };
    }
    return { ref: id };
  };
  return { version: 1, root: encode(task), records };
}

export function loadPlannerTask<T>(g: Game, managed: ReadonlyMap<number, object>, data: PlannerTaskData, scope?: PlannerTaskScope): T {
  if (data?.version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported planner task data');
  const objects: unknown[] = data.records.map(record => {
    switch (record.kind) {
      case 'object': return record.nullPrototype ? Object.create(null) : {};
      case 'array': return new Array(record.values.length);
      case 'map': return new Map();
      case 'set': return new Set();
      case 'float32': return new Float32Array(record.values.length);
      case 'float64': return new Float64Array(record.values.length);
      case 'routingEpoch': return { selectionRoutingEpoch: record.current ? g.lines.version : -1 };
      case 'demandEpoch': return { selectionDemandEpoch: record.current ? g.demand.version : -1 };
      case 'plannerInput': return loadPlannerInput(g, record.input);
      default: throw new Error('Unsupported planner record');
    }
  });
  const decode = (value: Value): any => {
    if (!value || typeof value !== 'object') return value;
    if ('ref' in value) {
      if (!Number.isSafeInteger(value.ref) || value.ref < 0 || value.ref >= objects.length) throw new Error('Invalid planner graph reference');
      return objects[value.ref];
    }
    if ('scalar' in value) {
      switch (value.scalar) {
        case 'undefined': case 'hole': return undefined;
        case '-0': return -0;
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        default: throw new Error('Unsupported planner scalar');
      }
    }
    const id = value.id;
    let current: unknown;
    switch (value.native) {
      case 'station': current = g.stations.get(Number(id)); break;
      case 'stationStop': { const [station, index] = String(id).split(':').map(Number); current = g.stations.get(station)?.stops[index]; break; }
      case 'rail': current = g.stations.get(Number(id))?.rail; break;
      case 'line': current = g.lines.map.get(Number(id)); break;
      case 'model': current = MODEL_BY_ID.get(String(id)); break;
      case 'trainCars': {
        const vehicle = g.vehicles.map.get(Number(id));
        if (vehicle?.kind === 'train') current = (vehicle as Train).cars;
        break;
      }
      case 'edge': current = g.world.net.edges.get(Number(id)); break;
      case 'node': current = g.world.net.nodes.get(Number(id)); break;
      case 'depot': current = g.depots.get(Number(id)); break;
      case 'town': current = g.towns.list.find(town => town.id === Number(id)); break;
      case 'managed': current = managed.get(Number(id)); break;
      case 'routing': current = g.lines.routing.get(Number(id)); break;
      case 'config': current = scope?.company === id ? scope.config : undefined; break;
      case 'focus': current = scope?.company === id ? scope.focus : undefined; break;
      case 'project': current = scope?.company === id ? scope.project : undefined; break;
      default: throw new Error('Unsupported planner native reference');
    }
    if (current === undefined || current === null) throw new Error(`Missing planner ${value.native} reference ${id}`);
    return current;
  };
  data.records.forEach((record, index) => {
    const target: any = objects[index];
    switch (record.kind) {
      case 'object': for (const [key, value] of record.entries) Object.defineProperty(target, key, { value: decode(value), enumerable: true, configurable: true, writable: true }); break;
      case 'array': record.values.forEach((value, at) => { if (!(value && typeof value === 'object' && 'scalar' in value && value.scalar === 'hole')) target[at] = decode(value); }); break;
      case 'map': for (const [key, value] of record.entries) target.set(decode(key), decode(value)); break;
      case 'set': for (const value of record.values) target.add(decode(value)); break;
      case 'float32': case 'float64': record.values.forEach((value, at) => { target[at] = decode(value); }); break;
      case 'routingEpoch': case 'demandEpoch': case 'plannerInput': break;
    }
  });
  return decode(data.root);
}
