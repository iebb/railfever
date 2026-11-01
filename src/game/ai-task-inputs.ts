import type { Game } from './game';

export type PlannerInputArray = Float32Array | Uint8Array;
/** Only privately detached, permanently immutable planner arrays may enter this codec. */
export interface PlannerInput<T extends PlannerInputArray = PlannerInputArray> { readonly value: T }
interface EncodedInput { kind: 'float32' | 'uint8'; bytes: string }
export type PlannerInputPayload = { ref: string } | { inline: EncodedInput };
export type PlannerInputEntry = { key: string; kind: 'bytes'; bytes: string }
  | { key: string; kind: 'array'; arrayKind: EncodedInput['kind']; parts: string[] };
interface Capture { byIdentity: WeakMap<object, string>; buckets: Map<string, PlannerInputEntry[]>; inputs: PlannerInputEntry[] }
interface Restore { entries: Map<string, PlannerInputEntry>; decoded: Map<string, PlannerInput> }
const branded = new WeakSet<object>(), wrappers = new WeakMap<object, PlannerInput>();
const encoded = new WeakMap<object, EncodedInput>();
const captures = new WeakMap<Game, Capture>(), restores = new WeakMap<Game, Restore>();
const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

export function retainPlannerInput<T extends PlannerInputArray>(value: T): PlannerInput<T> {
  if (Object.getPrototypeOf(value) !== Float32Array.prototype && Object.getPrototypeOf(value) !== Uint8Array.prototype)
    throw new Error('Unsupported immutable planner input');
  let wrapper = wrappers.get(value);
  if (!wrapper) { wrapper = Object.freeze({ value }); wrappers.set(value, wrapper); branded.add(wrapper); }
  return wrapper as PlannerInput<T>;
}
export function isPlannerInput(value: object): value is PlannerInput { return branded.has(value); }
function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (native) return native(text);
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function encode(input: PlannerInput): EncodedInput {
  let saved = encoded.get(input.value); if (saved) return saved;
  const array = input.value;
  let bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  if (array instanceof Float32Array && !littleEndian) {
    bytes = bytes.slice(); for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  }
  saved = Object.freeze({ kind: array instanceof Float32Array ? 'float32' : 'uint8', bytes: base64(bytes) });
  encoded.set(array, saved); return saved;
}
/** Prepare lossless derived bytes inside the planner's existing capture unit, before a save can observe it. */
export function preparePlannerInput(input: PlannerInput): void { encode(input); }
/** A content bucket, not an equality claim: complete bytes are compared before any input is shared. */
function bucket(input: EncodedInput): string {
  let hash = 2166136261;
  const text = input.bytes, step = Math.max(1, Math.floor(text.length / 2048));
  for (let i = 0; i < text.length; i += step) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${input.kind}:${text.length}:${(hash >>> 0).toString(16)}`;
}
function intern(context: Capture, prefix: string, item: Omit<Extract<PlannerInputEntry, { kind: 'bytes' }>, 'key'>
  | Omit<Extract<PlannerInputEntry, { kind: 'array' }>, 'key'>): string {
  const matches = context.buckets.get(prefix) ?? [];
  let entry = matches.find(entry => entry.kind === 'bytes' && item.kind === 'bytes' ? entry.bytes === item.bytes
    : entry.kind === 'array' && item.kind === 'array' && entry.arrayKind === item.arrayKind && entry.parts.length === item.parts.length
      && entry.parts.every((key, i) => key === item.parts[i]));
  if (!entry) {
    entry = { key: `${prefix}:${matches.length}`, ...item }; matches.push(entry);
    context.buckets.set(prefix, matches); context.inputs.push(entry);
  }
  return entry.key;
}
export function savePlannerInput(g: Game, input: PlannerInput): PlannerInputPayload {
  if (!isPlannerInput(input)) throw new Error('Planner input was not retained as immutable');
  const context = captures.get(g);
  const known = context?.byIdentity.get(input.value); if (known) return { ref: known };
  const data = encode(input);
  if (!context) return { inline: data };
  // 48 KiB is divisible by both three and four: encoded chunks align exactly on bytes and Float32 words.
  // Nearby immutable terrain revisions therefore share all unaffected chunks, not merely identical whole maps.
  const parts: string[] = [];
  for (let i = 0; i < data.bytes.length; i += 65536) {
    const bytes = data.bytes.slice(i, i + 65536);
    parts.push(intern(context, `bytes:${bucket({ kind: 'uint8', bytes })}`, { kind: 'bytes', bytes }));
  }
  const key = intern(context, `array:${bucket(data)}`, { kind: 'array', arrayKind: data.kind, parts });
  context.byIdentity.set(input.value, key); return { ref: key };
}
function decode(input: EncodedInput): PlannerInput {
  if (input.kind !== 'float32' && input.kind !== 'uint8' || typeof input.bytes !== 'string') throw new Error('Invalid immutable planner input');
  let bytes = fromBase64(input.bytes);
  if (input.kind === 'uint8') { const result = retainPlannerInput(bytes); encoded.set(bytes, input); return result; }
  if (bytes.byteLength % 4) throw new Error('Invalid immutable planner Float32 input');
  if (!littleEndian) { bytes = bytes.slice(); for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse(); }
  const array = bytes.byteOffset % 4 ? new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const result = retainPlannerInput(array); encoded.set(array, input); return result;
}
export function loadPlannerInput(g: Game, payload: PlannerInputPayload): PlannerInput {
  if ('inline' in payload) return decode(payload.inline);
  const context = restores.get(g), input = context?.entries.get(payload.ref);
  if (!input || !context) throw new Error('Missing immutable planner input');
  let value = context.decoded.get(payload.ref);
  if (!value) {
    if (input.kind !== 'array') throw new Error('Invalid immutable planner array');
    const parts = input.parts.map(key => {
      const part = context.entries.get(key); if (part?.kind !== 'bytes') throw new Error('Missing immutable planner byte chunk');
      return part.bytes;
    });
    value = decode({ kind: input.arrayKind, bytes: parts.join('') }); context.decoded.set(payload.ref, value);
  }
  return value;
}
/** Nested/reentrant saves own their own table. No retained process context is authoritative. */
export function withPlannerInputCapture<T>(g: Game, capture: () => T): { value: T; inputs?: PlannerInputEntry[] } {
  const before = captures.get(g), context: Capture = { byIdentity: new WeakMap(), buckets: new Map(), inputs: [] };
  captures.set(g, context);
  try { const value = capture(); return { value, ...(context.inputs.length ? { inputs: context.inputs } : {}) }; }
  finally { if (before) captures.set(g, before); else captures.delete(g); }
}
/** Install the complete table before any AI task graph is restored, and detach it on every exit path. */
export function withPlannerInputRestore<T>(g: Game, inputs: PlannerInputEntry[] | undefined, restore: () => T): T {
  const before = restores.get(g), entries = new Map<string, PlannerInputEntry>();
  for (const input of inputs ?? []) {
    if (typeof input.key !== 'string' || entries.has(input.key)) throw new Error('Invalid planner input table');
    entries.set(input.key, input);
  }
  restores.set(g, { entries, decoded: new Map() });
  try { return restore(); }
  finally { if (before) restores.set(g, before); else restores.delete(g); }
}
