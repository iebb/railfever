// Save games (v3): a tick-consistent dynamic snapshot and immutable lossless world chunks.
import { GAME_VERSION } from './version';
import { Game, TICKS_PER_DAY } from './game';
import { World, Building, Tree, SAVE_VERTICES, SAVE_TREES } from './world';
import type { NNode, NEdge, Crossing, Section } from './network';
import type { Town } from './towns';
import type { Station, WaitGroup } from './stations';
import { restoreStation } from './stations';
import type { Depot } from './build-ops';
import { Lines, Line } from './lines';
import { Economy, Company } from './economy';
import { AIController } from './ai';
import { Train, TSeg, makeSeg } from './train';
import { RoadVehicle, RSeg, RCont, makeLaneSeg, makeConn } from './roadvehicle';
import { makeCurve } from './network';
import { MODEL_BY_ID } from './vehicle-types';
import { KMH_TO_UPS, trackTypeOf } from './constants';
import { cargoGroups, type Vehicle, type CargoGroup } from './vehicle';
import { fareGroupKey, changeClass } from './fares';
import { putSave, putSaveOnce, getSave, deleteSave, listSaves, migrateLegacy } from './storage';
import type { StoredSave } from './storage';
import { saveOps, loadOps } from './opcosts';
import { canonicalizeLines } from './patterns';
import { saveNetwork, loadNetwork } from './ai-network';
import { migrateElectricTrains } from './migrate';
import { walkRoadsChanged } from './catchment';
import { stationMailJSON, restoreStationMail, restoreMail, restoreMailQueue } from './mail';

const VERSION = 3;
/** Save formats this build reads (v2: older single-record saves). */
const READABLE = [2, VERSION];
const TREE_CHUNK = SAVE_TREES;

/** Self-contained so the same codec runs in a Blob worker in the one-file offline build. */
export function saveCodec() {
  const base64 = (a: Uint8Array) => {
    let s = '';
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const packFloats = (a: Float32Array, stride = 0) => {
    const words = new Uint32Array(a.buffer, a.byteOffset, a.length), n = a.length, out = new Uint8Array(n * 4);
    let prev = 0, prev2 = 0;
    for (let i = 0; i < n; i++) {
      const prediction = stride && i > stride ? prev + words[i - stride] - words[i - stride - 1] : 2 * prev - prev2;
      const v = words[i], x = (v - prediction) >>> 0; prev2 = prev; prev = v;
      for (let b = 0; b < 4; b++) out[b * n + i] = x >>> (b * 8);
    }
    return out;
  };
  const unpackFloats = (a: Uint8Array, stride = 0) => {
    if (a.length % 4) throw new Error('Invalid float chunk');
    const n = a.length / 4, out = new Float32Array(n), words = new Uint32Array(out.buffer);
    let prev = 0, prev2 = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let b = 0; b < 4; b++) x |= a[b * n + i] << (b * 8);
      const prediction = stride && i > stride ? prev + words[i - stride] - words[i - stride - 1] : 2 * prev - prev2;
      const v = (x + prediction) >>> 0;
      words[i] = v; prev2 = prev; prev = v;
    }
    return out;
  };
  const zip = async (a: Uint8Array): Promise<Uint8Array | string> => {
    if (typeof CompressionStream === 'undefined') return 'b64:' + base64(a);
    const stream = new Blob([a as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const encode = async (kind: string, raw: Float32Array | Uint8Array | unknown, stride = 0) => {
    const a = kind === 'json' ? new TextEncoder().encode(JSON.stringify(raw))
      : kind === 'lock' ? raw as Uint8Array : packFloats(raw as Float32Array, stride);
    return zip(a);
  };
  const unpackNodes = (p: any, start = 0, end = p.kind.length) => {
    const nodes = [];
    for (let i = start; i < Math.min(end, p.kind.length); i++) {
      const at = i * 8, a = p.values;
      const n: any = { id: a[at], kind: p.kind[i], x: a[at + 1], y: a[at + 2], z: a[at + 3], dx: a[at + 4], dz: a[at + 5],
        edges: Array.from(p.edgeIds.subarray(p.edgeOffsets[i], p.edgeOffsets[i + 1])), signal: a[at + 6], owner: a[at + 7] };
      if (p.signalKind[i] !== undefined) n.signalKind = p.signalKind[i];
      if (p.signalPass[i] !== undefined) n.signalPass = p.signalPass[i];
      nodes.push(n);
    }
    return nodes;
  };
  // The snapshot packs nodes and concatenates profiles to avoid thousands of object/buffer clones.
  // Stored JSON still uses ordinary node records and the v2 byte-plane profile representation.
  const profiles = (d: any) => {
    if (!Array.isArray(d.world.buildings)) {
      const { fields, values } = d.world.buildings;
      d.world.buildings = [];
      for (let at = 0; at < values.length; at += fields.length) {
        const b: Record<string, number> = {};
        fields.forEach((key: string, i: number) => { b[key] = values[at + i]; });
        d.world.buildings.push(b);
      }
    }
    if (!Array.isArray(d.net.nodes) && d.net.nodes) d.net.nodes = unpackNodes(d.net.nodes);
    for (const e of d.net.edges) {
      if (d.net.profiles) e.prof = d.net.profiles.subarray(e.prof[0], e.prof[0] + e.prof[1]);
      if (!(e.prof instanceof Float32Array)) continue;
      const src = new Uint8Array(e.prof.buffer, e.prof.byteOffset, e.prof.byteLength), n = e.prof.length, out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) out[b * n + i] = src[i * 4 + b];
      e.prof = base64(out);
    }
    delete d.net.profiles;
    return d;
  };
  return { base64, packFloats, unpackFloats, encode, profiles, unpackNodes };
}
const codec = saveCodec();

interface SaveChunk {
  key: string; kind: 'h' | 'lock' | 'trees'; raw: Float32Array | Uint8Array; stride: number;
  text?: string; encoded?: Promise<Uint8Array | string>;
}
interface WorldCache { h: SaveChunk[]; lock: SaveChunk[]; trees: SaveChunk[]; heights: number[]; treeVersions: number[]; prefix: string; revision: number }
const worldCaches = new WeakMap<World, WorldCache>();
export const saveStats = { copiedChunks: 0, encodedChunks: 0, snapshots: 0, lastSnapshotMs: 0, lastPostMs: 0, lastEncodeMs: 0 };

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const n = Math.floor(a.byteLength / 4), aw = new Uint32Array(a.buffer, a.byteOffset, n), bw = new Uint32Array(b.buffer, b.byteOffset, n);
  for (let i = 0; i < n; i++) if (aw[i] !== bw[i]) return false;
  const au = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bu = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = n * 4; i < au.length; i++) if (au[i] !== bu[i]) return false;
  return true;
}
function worldChunks(w: World): WorldCache {
  let c = worldCaches.get(w);
  if (!c) {
    c = { h: [], lock: [], trees: [], heights: [], treeVersions: [], prefix: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), revision: 0 };
    worldCaches.set(w, c);
  }
  const chunk = (kind: SaveChunk['kind'], raw: SaveChunk['raw']): SaveChunk => {
    saveStats.copiedChunks++;
    return { key: c!.prefix + '/' + kind + '/' + c!.revision++, kind, raw, stride: kind === 'h' ? w.size + 1 : 0 };
  };
  for (let i = 0, at = 0; at < w.h.length; i++, at += SAVE_VERTICES) {
    if (c.heights[i] !== w.saveHeightVersions[i]) {
      const a = w.h.subarray(at, at + SAVE_VERTICES);
      if (!c.h[i] || !sameBytes(a, c.h[i].raw)) c.h[i] = chunk('h', a.slice());
      c.heights[i] = w.saveHeightVersions[i];
    }
    // Some network/station writers change lock bytes directly. Comparing words is cheap, and avoids
    // guessed invalidations or re-deriving historical locks that are not exactly reproducible.
    const a = w.lock.subarray(at, at + SAVE_VERTICES);
    if (!c.lock[i] || !sameBytes(a, c.lock[i].raw)) c.lock[i] = chunk('lock', a.slice());
  }
  for (let at = 0, i = 0; at < w.trees.length; at += TREE_CHUNK, i++) {
    const n = Math.min(TREE_CHUNK, w.trees.length - at), prev = c.trees[i]?.raw as Float32Array | undefined;
    if (prev?.length === n * 5 && c.treeVersions[i] === (w.saveTreeVersions[i] ?? 0)) continue;
    let changed = !prev || prev.length !== n * 5;
    if (!changed) for (let j = 0; j < n; j++) {
      const t = w.trees[at + j];
      if (t ? Math.fround(t.x) !== prev![j] || Math.fround(t.z) !== prev![n + j] || Math.fround(t.s) !== prev![2 * n + j] || t.type !== prev![3 * n + j] || Math.fround(t.tint) !== prev![4 * n + j] : !Number.isNaN(prev![j])) { changed = true; break; }
    }
    if (changed) {
      const a = new Float32Array(n * 5);
      for (let j = 0; j < n; j++) {
        const t = w.trees[at + j];
        if (!t) { a[j] = NaN; continue; }
        a[j] = t.x; a[n + j] = t.z; a[2 * n + j] = t.s; a[3 * n + j] = t.type; a[4 * n + j] = t.tint;
      }
      c.trees[i] = chunk('trees', a);
    }
    c.treeVersions[i] = w.saveTreeVersions[i] ?? 0;
  }
  c.trees.length = c.treeVersions.length = Math.ceil(w.trees.length / TREE_CHUNK);
  return c;
}
function chunkWorld(w: World, c: WorldCache, value: (chunk: SaveChunk) => unknown) {
  return { encoding: 'predict32-chunks', vertices: SAVE_VERTICES, treeChunk: TREE_CHUNK, treeCount: w.trees.length,
    h: c.h.map(value), lock: c.lock.map(value), trees: c.trees.map(value) };
}
/**
 * Key order of a rail part in saves (as Stations.commitRail builds it). A part restored from a save gains optional keys
 * it was saved without (a forecourt added by a later restyle, say) in another position than the running game's part
 * had them, so parts are written in this order whatever order their object has: a loaded game saves exactly alike.
 */
const RAIL_PART_KEYS = ['x', 'z', 'y', 'angle', 'length', 'tracks', 'trackOffsets', 'platforms', 'edges', 'through', 'throughOffsets',
  'throughEdges', 'width', 'throughMode', 'trackType', 'mode', 'platformStyle', 'psd', 'style', 'forecourt2', 'building', 'level', 'underground',
  'depth', 'height', 'entrances', 'piers', 'forecourt', 'cost', 'alignment', 'groups', 'native'];
/**
 * Key order of a waiting group in saves: merging groups adds `transfers` and `rail` (the journey's rail fares so far)
 * in whichever order the passengers came, a loaded group in the order it is restored: written in this order alike.
 */
const WAIT_KEYS = ['line', 'alight', 'dest', 'count', 't', 'transfers', 'rail'];
function waitJSON(w: object): object {
  const src = w as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const k of WAIT_KEYS) if (k in src) out[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
  return out;
}
function railPartJSON(r: object): object {
  const src = r as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const k of RAIL_PART_KEYS) if (k in src) out[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
  return out;
}

/** Synchronous single-JSON form for tests/tools; autosaves use captureSave and worker encoding. */
export function serialize(g: Game): any {
  const c = worldChunks(g.world);
  return serializeState(g, chunkWorld(g.world, c, (t) => t.text ??= b64(t.kind === 'lock' ? t.raw : codec.packFloats(t.raw as Float32Array, t.stride))));
}
/** Everything is detached from the live game in this call, before any await or worker work. */
export function captureSave(g: Game) {
  const start = performance.now(), c = worldChunks(g.world);
  const state = cloneState(serializeState(g, chunkWorld(g.world, c, (t) => t.key), true));
  const chunks = [...c.h, ...c.lock, ...c.trees];
  const meta = { date: g.dateString(), saved: Date.now(), money: g.economy.money, format: VERSION, game: GAME_VERSION };
  saveStats.snapshots++; saveStats.lastSnapshotMs = performance.now() - start;
  return { state, chunks, meta };
}
/** Save entities are plain enumerable records. Copying those directly avoids structuredClone's
 * extra serialization pass; packed buffers were already copied by serializeState. */
function cloneState(value: any): any {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(cloneState);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = cloneState(value[key]);
  return out;
}
const BUILDING_FIELDS = ['id', 'townId', 'x', 'z', 'angle', 'w', 'd', 'type', 'floors', 'pop', 'seed', 'y', 'built'] as const;
function buildingRecords(w: World, binary: boolean) {
  if (binary) {
    const values = new Float64Array(w.buildings.size * BUILDING_FIELDS.length);
    let at = 0;
    for (const b of w.buildings.values()) for (const key of BUILDING_FIELDS) values[at++] = b[key];
    return { fields: BUILDING_FIELDS, values };
  }
  return [...w.buildings.values()].map((b) => Object.fromEntries(BUILDING_FIELDS.map((key) => [key, b[key]])));
}
function nodeRecord(n: NNode) {
  return { id: n.id, kind: n.kind, x: n.x, y: n.y, z: n.z, dx: n.dx, dz: n.dz, edges: n.edges.slice(), signal: n.signal, owner: n.owner,
    ...(n.signalKind === undefined ? {} : { signalKind: n.signalKind }), ...(n.signalPass === undefined ? {} : { signalPass: n.signalPass }) };
}
function packNodes(nodes: NNode[]) {
  const values = new Float64Array(nodes.length * 8), edgeOffsets = new Uint32Array(nodes.length + 1);
  const edgeIds = new Float64Array(nodes.reduce((n, p) => n + p.edges.length, 0));
  let at = 0, edge = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    values[at++] = n.id; values[at++] = n.x; values[at++] = n.y; values[at++] = n.z;
    values[at++] = n.dx; values[at++] = n.dz; values[at++] = n.signal; values[at++] = n.owner;
    edgeOffsets[i] = edge; edgeIds.set(n.edges, edge); edge += n.edges.length;
  }
  edgeOffsets[nodes.length] = edge;
  return { values, edgeOffsets, edgeIds, kind: nodes.map((n) => n.kind), signalKind: nodes.map((n) => n.signalKind), signalPass: nodes.map((n) => n.signalPass) };
}

// ------------------------------------------------------------------------------ binary helpers

function b64(arr: ArrayBufferView): string {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
/** Float32 array -> base64 with byte-plane shuffling (compresses smooth fields much better). */
function f32enc(a: Float32Array): string {
  const src = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const n = a.length, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) out[b * n + i] = src[i * 4 + b];
  return b64(out);
}
function f32dec(s: string): Float32Array {
  const u8 = unb64(s);
  const n = u8.length >> 2, out = new Float32Array(n);
  const dst = new Uint8Array(out.buffer);
  for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) dst[i * 4 + b] = u8[b * n + i];
  return out;
}

// ------------------------------------------------------------------------------ vehicles

type RSegD = [number, number, number, number, number, number, number | null];
const rsegD = (s: RSeg): RSegD => [s.kind === 'lane' ? 0 : 1, s.e, s.dir, s.node, s.from, s.fromDir, s.stopAt ?? null];

function cargoOf(v: Vehicle) { return [...v.cargo.values()]; }
function restoreCargo(v: Vehicle, list: CargoGroup[]) {
  v.cargo = cargoGroups(list.map((c) => ({ ...c })));
}

function baseOf(v: Vehicle) {
  return {
    id: v.id, owner: v.owner, name: v.name, lineId: v.lineId, stopIndex: v.stopIndex, cargo: cargoOf(v), load: v.load,
    state: v.state, status: v.status, profitYear: v.profitYear, profitLast: v.profitLast, incomeYear: v.incomeYear,
    boughtDay: v.boughtDay, value: v.value, stateTime: v.stateTime, homeX: v.homeX, homeZ: v.homeZ, delivered: v.delivered,
    // ops: service pattern, overtaking hold, odometer and last month's costs, train energy counters (opcosts.ts)
    pattern: v.pattern ?? null, holdTime: v.holdTime, ops: [v.opSec, v.opDist, v.opJ, v.opBrakeJ, v.opMark, v.opLastSt], opLast: v.opLast,
    phys: physOf(v),
    spacing: v.spacing,
    // mail aboard and delivered (only once the vehicle has carried mail: other saves are as before)
    ...(v.mailCargo.size || v.mailLoad || v.mailDelivered ? { mail: [...v.mailCargo.values()].map((c) => ({ ...c })), mailLoad: v.mailLoad, mailDelivered: v.mailDelivered } : {}),
  };
}
/** Energy counters a train's physics keeps between the monthly charges (if it has them). */
function physOf(v: Vehicle): number[] | null {
  const p = v as unknown as { tractionJ?: number; regenJ?: number; auxJ?: number; km?: number; hours?: number };
  return typeof p.tractionJ === 'number' ? [p.tractionJ, p.regenJ ?? 0, p.auxJ ?? 0, p.km ?? 0, p.hours ?? 0] : null;
}
function restoreBase(g: Game, v: Vehicle, d: any) {
  v.owner = d.owner; v.name = d.name; v.lineId = d.lineId; v.stopIndex = d.stopIndex; restoreCargo(v, d.cargo ?? []);
  v.load = d.load; v.state = d.state; v.status = d.status; v.profitYear = d.profitYear; v.profitLast = d.profitLast;
  v.incomeYear = d.incomeYear; v.boughtDay = d.boughtDay; v.value = d.value; v.stateTime = d.stateTime ?? 0;
  v.homeX = d.homeX ?? v.homeX; v.homeZ = d.homeZ ?? v.homeZ; v.delivered = d.delivered ?? 0;
  if (typeof d.pattern === 'number') v.pattern = d.pattern;
  v.holdTime = d.holdTime ?? 0;
  v.restoreSpacing(d.spacing);
  if (Array.isArray(d.ops)) [v.opSec, v.opDist, v.opJ, v.opBrakeJ, v.opMark, v.opLastSt] = (d.ops as number[]).map((x) => Number(x) || 0);
  else v.opMark = -1;
  v.opLast = d.opLast ? { ...d.opLast } : null;
  if (Array.isArray(d.mail)) restoreMail(g, v, d.mail);
  v.mailLoad = Number(d.mailLoad) || 0; v.mailDelivered = Number(d.mailDelivered) || 0;
  if (Array.isArray(d.phys)) {
    const p = v as unknown as Record<string, number>;
    ['tractionJ', 'regenJ', 'auxJ', 'km', 'hours'].forEach((k, i) => { p[k] = Number(d.phys[i]) || 0; });
  }
}

function trainOf(t: Train) {
  return {
    ...baseOf(t), type: 'train', cars: t.cars.map((c) => c.id), depotId: t.depotId,
    segs: t.segs.map((s) => (s.e < 0 ? [-1, s.dir, s.len, s.depot] : [s.e, s.dir])), headSeg: t.headSeg, headPos: t.headPos,
    pending: t.pending.map((s) => [s.e, s.dir]), speed: t.speed, waitTime: t.waitTime, retryTimer: t.retryTimer,
    loadTimer: t.loadTimer, routeTarget: t.routeTarget, atStation: t.atStation, reversed: t.reversed, blockedBy: t.blockedBy,
    failCount: t.failCount, stuckTime: t.stuckTime, grade: t.grade,
    backoff: t.backoff ? { waitFor: [...t.backoff.waitFor], clear: [...t.backoff.clear] } : null,
  };
}

function roadOf(v: RoadVehicle) {
  return {
    ...baseOf(v), type: 'road', model: v.model?.id ?? null, ambient: v.ambient, depotId: v.depotId,
    seg: v.seg ? rsegD(v.seg) : null, pos: v.pos, trail: v.trail.map(rsegD), ahead: v.ahead.map(rsegD),
    route: v.route.map((r) => [r.edge, r.dir]), speed: v.speed, loadTimer: v.loadTimer, retryTimer: v.retryTimer,
    junctionWait: v.junctionWait, stuck: v.stuck, ttl: v.ttl, rng: v.rng.state, style: v.style, tint: v.tint, cruise: v.cruise,
    grade: v.grade, gradeTimer: v.gradeTimer, retryWait: v.retryWait, needsReplan: v.needsReplan,
  };
}

/** Virtual track behind a depot's inner end (mirrors train.ts). */
function depotSeg(g: Game, dp: Depot, length: number): TSeg | null {
  const net = g.world.net;
  const stub = net.edges.get(dp.edge);
  const inner = stub ? net.nodes.get(stub.a) : undefined;
  if (!inner) return null;
  const fx = Math.sin(dp.angle), fz = Math.cos(dp.angle);
  const c = makeCurve([inner.x - fx * length, inner.y, inner.z - fz * length, inner.x, inner.y, inner.z]);
  return { e: -1, dir: 1, curve: c, len: c.len, res: [], limit: 25 * KMH_TO_UPS, tunnels: [], depot: dp.id };
}

// ------------------------------------------------------------------------------ serialize

function serializeState(g: Game, world: any, binaryProfiles = false): any {
  const w = g.world, net = w.net;
  const edges = [...net.edges.values()];
  const profiles = binaryProfiles ? new Float32Array(edges.reduce((n, e) => n + e.prof.length, 0)) : null;
  let profileAt = 0;
  const V = g.vehicles as any;
  return {
    version: VERSION, game: GAME_VERSION,
    options: g.options, tick: g.tick, day: g.day, dayFrac: g.dayFrac, visualTime: g.visualTime, rng: g.rng.state, aiEnabled: g.aiEnabled,
    // companies (defunct flags, economies), AI states and configs, track access agreements and rates
    ...g.saveCompanies(),
    // Save owed walking population work independently of the scheduled demand publication flag.
    // Priming a cold cache retains this work; native monthly/service refresh keeps its timing.
    catchmentDirty: g.lines.catchmentDirty,
    ...((g.stations.catchmentInputsChanged() || g.stations.catchmentPopulationPending)
      ? { catchmentInputsDirty: true } : {}),
    shares: g.shares.toJSON(),
    aiNetwork: saveNetwork(g),
    ...(g.deadlockScan ? { deadlockScan: structuredClone(g.deadlockScan) } : {}),
    world: {
      ...world, size: w.size, freeTrees: w.freeTrees.slice(),
      buildings: buildingRecords(w, binaryProfiles), nextBuildingId: w.nextBuildingId,
    },
    net: {
      nodes: binaryProfiles ? packNodes([...net.nodes.values()]) : [...net.nodes.values()].map(nodeRecord),
      edges: edges.map((e) => {
        if (!profiles) return { ...e, prof: f32enc(e.prof) };
        const prof = [profileAt, e.prof.length]; profiles.set(e.prof, profileAt); profileAt += e.prof.length;
        return { ...e, prof };
      }),
      ...(profiles ? { profiles } : {}),
      crossings: [...net.crossings.values()],
      nextNode: net.nextNode, nextEdge: net.nextEdge, nextCrossing: net.nextCrossing,
      // changes the vehicles have not taken in yet (flushed at the start of the next update)
      dirtyNodes: [...net.dirtyNodes], dirtyEdges: [...net.dirtyEdges],
    },
    networkDirty: !!(g as any).networkDirty,
    // A street edit still awaiting its network flush must invalidate catchments at that flush, not on load.
    catchmentRoadsDirty: g.lines.catchmentRoadsDirty || (!!(g as any).networkDirty && walkRoadsChanged(g)),
    // towns (with their street grid) and their growth cache, so a loaded game grows exactly alike
    towns: g.towns.list.map((t) => ({ ...t, buildings: [...t.buildings], growth: g.towns.cacheOf(t) })),
    stations: [...g.stations.map.values()].map((s) => ({ ...s, rail: s.rail ? railPartJSON(s.rail) : s.rail, waiting: [...s.waiting.values()].map(waitJSON),
      ...(s.mail ? { mail: stationMailJSON(s.mail) } : {}) })),
    stationsNextId: g.stations.nextId,
    // the buildings of the last catchment share-out (the shares are worked out alike after loading)
    catchMaxB: g.stations.catchMaxB,
    ...(g.stations.emptyCatchmentCold ? { catchmentEmptyCold: true } : {}),
    depots: [...g.depots.map.values()], depotsNextId: g.depots.nextId,
    lines: [...g.lines.map.values()], linesNextId: g.lines.nextId,
    // ops: line ids merged into others as service patterns; this month's track wear; save format of the ops data
    linesRedirect: [...g.lines.redirect], ops: saveOps(g), opsVersion: 1,
    // mail's random stream (once mail has used it)
    ...(g.mail.toJSON() ? { mail: g.mail.toJSON() } : {}),
    vehicles: [...g.vehicles.map.values()].map((v) => (v instanceof Train ? trainOf(v) : roadOf(v as RoadVehicle))),
    ambient: g.vehicles.ambient.map(roadOf),
    vehiclesNextId: g.vehicles.nextId, nextAmbientId: g.vehicles.nextAmbientId, ambientEnabled: g.vehicles.ambientEnabled,
    vrng: V.rng?.state, ambientTimer: V.ambientTimer,
    // vehicles still to re-plan after the last network change (a few per tick), and vehicle/line news timers
    replanQueue: [...(V.replanQueue ?? [])], lostSince: [...((g as any).lostSince ?? new Map()).entries()],
    ...((g as any).congestionTold?.size ? { congestionTold: [...(g as any).congestionTold.entries()] } : {}),
    firstArrival: [...g.firstArrival],
    news: g.news.slice(-40),
  };
}

// ------------------------------------------------------------------------------ deserialize

export function deserialize(d: any): Game {
  if (!d) throw new Error('Not a Railfever save');
  const why = saveIncompatibility({ version: d.version, game: d.game });
  if (why || d.version === undefined) throw new Error(why ?? 'Not a Railfever save');
  const wd = d.world;
  const w = new World(wd.size);
  let tr: Float32Array;
  if (d.version === 2) {
    w.h.set(f32dec(wd.h).subarray(0, w.h.length));
    w.lock.set(unb64(wd.lock).subarray(0, w.lock.length));
    tr = f32dec(wd.trees);
  } else {
    if (wd.encoding !== 'predict32-chunks' || wd.vertices !== SAVE_VERTICES || wd.treeChunk !== TREE_CHUNK)
      throw new Error('Unsupported world chunk encoding');
    const floats = (x: string | Uint8Array, stride = 0) => codec.unpackFloats(typeof x === 'string' ? unb64(x) : x, stride);
    let at = 0;
    for (const chunk of wd.h) { const a = floats(chunk, w.size + 1); w.h.set(a, at); at += a.length; }
    if (at !== w.h.length) throw new Error('Incomplete heightmap');
    at = 0;
    for (const chunk of wd.lock) { const a = typeof chunk === 'string' ? unb64(chunk) : chunk; w.lock.set(a, at); at += a.length; }
    if (at !== w.lock.length) throw new Error('Incomplete lock grid');
    tr = new Float32Array(wd.treeCount * 5);
    at = 0;
    for (const chunk of wd.trees) {
      const a = floats(chunk), n = a.length / 5;
      for (let i = 0; i < n; i++) for (let f = 0; f < 5; f++) tr[(at + i) * 5 + f] = a[f * n + i];
      at += n;
    }
    if (at !== wd.treeCount) throw new Error('Incomplete trees');
  }
  // trees keep their ids (index)
  for (let i = 0; i < tr.length / 5; i++) {
    if (isNaN(tr[i * 5])) { w.trees[i] = null; w.freeTrees.push(i); continue; }
    const t: Tree = { x: tr[i * 5], z: tr[i * 5 + 1], s: tr[i * 5 + 2], type: tr[i * 5 + 3], tint: tr[i * 5 + 4] };
    w.trees[i] = t;
    w.indexSavedTree(i, t);
    w.treeGrid.insert(i, t.x, t.z, t.x, t.z);
  }
  if (Array.isArray(wd.freeTrees)) {
    const holes = new Set(w.freeTrees);
    if (wd.freeTrees.length !== holes.size || new Set(wd.freeTrees).size !== holes.size || wd.freeTrees.some((id: number) => !holes.has(id)))
      throw new Error('Invalid free tree ids');
    w.freeTrees = wd.freeTrees.slice();
  }
  for (const b0 of wd.buildings as Building[]) {
    const b = { ...b0 };
    w.buildings.set(b.id, b);
    const r = Math.hypot(b.w, b.d) / 2;
    w.bgrid.insert(b.id, b.x - r, b.z - r, b.x + r, b.z + r);
  }
  w.nextBuildingId = wd.nextBuildingId;
  // network
  const net = w.net;
  for (const n of d.net.nodes as NNode[]) {
    const nn: NNode = { ...n, edges: [...n.edges] };
    net.nodes.set(nn.id, nn);
    net.nodeGrid.insert(nn.id, nn.x, nn.z, nn.x, nn.z);
  }
  for (const ed of d.net.edges as any[]) {
    const e: NEdge = { ...ed, bez: { ...ed.bez }, prof: f32dec(ed.prof), sections: ((ed.sections ?? []) as Section[]).map((s) => ({ ...s })) };
    if (e.kind === 'rail') e.type = trackTypeOf(e.type);
    net.edges.set(e.id, e);
    const geo = net.geo(e);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < geo.n; i++) {
      const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    net.grid.insert(e.id, x0 - 1, z0 - 1, x1 + 1, z1 + 1);
  }
  for (const c of d.net.crossings as Crossing[]) net.crossings.set(c.id, { ...c });
  net.nextNode = d.net.nextNode; net.nextEdge = d.net.nextEdge; net.nextCrossing = d.net.nextCrossing;
  for (const id of (d.net.dirtyNodes ?? []) as number[]) net.dirtyNodes.add(id);
  for (const id of (d.net.dirtyEdges ?? []) as number[]) net.dirtyEdges.add(id);
  w.dirtyObj.clear(); w.dirtyTerrain.clear();

  const g = new Game({ ...d.options }, w);
  g.tick = Number.isSafeInteger(d.tick) && d.tick >= 0 ? d.tick : Math.max(0,
    (d.day ?? 0) * TICKS_PER_DAY + Math.min(TICKS_PER_DAY - 1, Math.max(0, Math.floor((d.dayFrac ?? 0) * TICKS_PER_DAY + 1e-6))));
  g.rng.state = d.rng;
  g.aiEnabled = d.aiEnabled ?? true;
  g.deadlockScan = d.deadlockScan ? structuredClone(d.deadlockScan) : null;
  // companies and access agreements (the AI controllers are restored at the end, once everything exists)
  g.restoreCompanies(d);
  g.shares.load(d.shares);
  // towns, stations, depots, lines
  g.towns.list = (d.towns as any[]).map((t) => {
    const { growth, ...rest } = t;
    const town = { ...rest, buildings: new Set<number>(t.buildings) } as Town;
    // Direct in-memory round trips must own their mutable street-planning arrays too.
    // Sharing a grid lets one game's failed-street search alter the other's next growth step.
    if (t.grid) town.grid = structuredClone(t.grid);
    if (t.mail) town.mail = { ...t.mail };
    g.towns.restoreCache(town, growth);
    return town;
  });
  for (const s of d.stations as any[]) {
    // station fields (levels, entrances, transfer links, road access) with defaults for older saves
    const st: Station = restoreStation(s);
    // daily() adds onPlat after its other sampling fields; preserve that insertion order in an early save.
    if (st.onPlat === undefined) delete st.onPlat;
    st.waitingTotal = 0;
    for (const wg of s.waiting as WaitGroup[]) g.stations.addWaiting(st, wg.line, wg.alight, wg.dest, wg.count, 0, wg.t, wg.transfers ?? 0, wg.rail ?? 0);
    if (s.mail) {
      st.mail = restoreStationMail(s.mail);
      restoreMailQueue(g, st, s.mail.waiting ?? []);
    }
    g.stations.map.set(st.id, st);
  }
  g.stations.nextId = d.stationsNextId;
  for (const dp of d.depots as Depot[]) g.depots.map.set(dp.id, { ...dp });
  g.depots.nextId = d.depotsNextId;
  for (const l of d.lines as Line[]) g.lines.map.set(l.id, Lines.restore(l));
  g.lines.nextId = d.linesNextId;
  for (const [k, r] of (d.linesRedirect ?? []) as [number, { line: number; pattern: number }][]) g.lines.redirect.set(k, { line: r.line, pattern: r.pattern });
  try { loadOps(g, d.ops); } catch (e) { console.warn('Save load: loadOps failed', e); }
  g.mail.load(d.mail);
  g.firstArrival = new Set(d.firstArrival ?? []);
  g.news = (d.news ?? []).map((n: any) => ({ ...n }));

  // vehicles
  const V = g.vehicles;
  const tseg = (x: number[], t: Train): TSeg | null => {
    if (x[0] < 0) {
      const dp = g.depots.get(x[3] ?? t.depotId);
      const sg = dp ? depotSeg(g, dp, x[2] ?? t.length + 0.3) : null;
      // keep the saved length exactly (rebuilding the curve can differ in the last bit)
      if (sg) { sg.dir = x[1]; if (typeof x[2] === 'number') sg.len = x[2]; }
      return sg;
    }
    const e = net.edges.get(x[0]);
    return e ? makeSeg(g, e, x[1]) : null;
  };
  const rseg = (x: RSegD | null): RSeg | null => {
    if (!x) return null;
    const e = net.edges.get(x[1]);
    if (!e) return null;
    const lane = makeLaneSeg(g, e, x[2]);
    if (x[0] === 0) { if (x[6] !== null && x[6] !== undefined) lane.stopAt = x[6]; return lane; }
    const fe = net.edges.get(x[4]);
    if (!fe) return null;
    return makeConn(makeLaneSeg(g, fe, x[5]), lane, x[3]) ?? lane;
  };
  const makeRoad = (vd: any): RoadVehicle => {
    const model = vd.model ? MODEL_BY_ID.get(vd.model) ?? null : null;
    const r = new RoadVehicle(g, vd.id, model, vd.depotId, !!vd.ambient, 1);
    restoreBase(g, r, vd);
    r.rng.state = vd.rng; r.style = vd.style; r.tint = vd.tint; r.cruise = vd.cruise; r.ttl = vd.ttl;
    r.speed = vd.speed; r.loadTimer = vd.loadTimer; r.retryTimer = vd.retryTimer; r.junctionWait = vd.junctionWait; r.stuck = vd.stuck;
    r.grade = vd.grade ?? 0; r.gradeTimer = vd.gradeTimer ?? 0; r.retryWait = vd.retryWait ?? 2; r.needsReplan = !!vd.needsReplan;
    const seg = rseg(vd.seg);
    if (seg) {
      r.seg = seg; r.pos = vd.pos;
      r.trail = (vd.trail as RSegD[]).map(rseg).filter((s): s is RSeg => !!s);
      const ahead: RSeg[] = [];
      for (const a of vd.ahead as RSegD[]) { const s = rseg(a); if (!s) break; ahead.push(s); }
      r.ahead = ahead;
      r.route = (vd.route as number[][]).map((q) => ({ edge: q[0], dir: q[1] } as RCont));
    } else if (!r.ambient && vd.seg) {
      r.state = 'depot'; r.status = 'Returned to depot';
    }
    return r;
  };
  for (const vd of d.vehicles as any[]) {
    let v: Vehicle;
    if (vd.type === 'train') {
      const cars = (vd.cars as string[]).map((id) => MODEL_BY_ID.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
      const t = new Train(g, vd.id, cars, vd.depotId);
      restoreBase(g, t, vd);
      t.speed = vd.speed; t.waitTime = vd.waitTime ?? 0; t.retryTimer = vd.retryTimer ?? 0; t.loadTimer = vd.loadTimer ?? 0;
      t.routeTarget = vd.routeTarget; t.atStation = vd.atStation; t.reversed = !!vd.reversed; t.blockedBy = vd.blockedBy ?? 0;
      t.failCount = vd.failCount ?? 0;
      t.stuckTime = vd.stuckTime ?? 0; t.grade = vd.grade ?? 0;
      t.backoff = vd.backoff ? { waitFor: [...vd.backoff.waitFor], clear: [...vd.backoff.clear] } : null;
      const segs: TSeg[] = [];
      let ok = true;
      for (const x of vd.segs as number[][]) { const s = tseg(x, t); if (!s) { ok = false; break; } segs.push(s); }
      if (ok && segs.length) {
        t.segs = segs;
        t.headSeg = Math.max(0, Math.min(vd.headSeg, segs.length - 1));
        t.headPos = Math.min(vd.headPos, segs[t.headSeg].len);
        const pending: TSeg[] = [];
        for (const x of vd.pending as number[][]) { const s = tseg(x, t); if (!s) break; pending.push(s); }
        t.pending = pending;
      } else if (vd.segs.length) {
        t.segs = []; t.pending = []; t.speed = 0; t.state = 'depot'; t.status = 'Returned to depot';
      } else { t.headSeg = vd.headSeg ?? 0; t.headPos = vd.headPos ?? 0; }
      v = t;
    } else v = makeRoad(vd);
    V.map.set(v.id, v);
  }
  // rebuild reservations from the trains' paths
  for (const t of V.trains()) for (const s of t.segs) for (const r of s.res) V.setRes(r, t.id);
  V.nextId = d.vehiclesNextId;
  V.nextAmbientId = d.nextAmbientId ?? V.nextAmbientId;
  V.ambientEnabled = d.ambientEnabled ?? true;
  const VA = V as any;
  if (typeof d.vrng === 'number' && VA.rng) VA.rng.state = d.vrng;
  if (typeof d.ambientTimer === 'number') VA.ambientTimer = d.ambientTimer;
  if (Array.isArray(d.replanQueue)) VA.replanQueue = (d.replanQueue as number[]).slice();
  if (Array.isArray(d.lostSince)) (g as any).lostSince = new Map(d.lostSince as [number, number][]);
  if (Array.isArray(d.congestionTold)) (g as any).congestionTold = new Map(d.congestionTold as [number, number][]);
  V.ambient = (d.ambient as any[] ?? []).map(makeRoad).filter((a) => a.seg);
  if (!d.opsVersion) {
    try { migrateElectricTrains(g); } catch (e) { console.warn('Save load: electric train migration failed', e); }
  }
  // older maps: town streets ending on a bridge are cut back to the ground (9i). Current saves keep their network as
  // saved (towns tidy their bridge ends as they grow): tidying here would make a loaded game differ from the running one.
  if (!d.opsVersion) try { g.towns.tidyBridgeEnds(); } catch (e) { console.warn('Save load: tidyBridgeEnds failed', e); }
  // routing tables; keep the saved catchment populations until the next monthly update
  const catchPop = new Map((d.stations as any[]).map((s) => [s.id, s.catchPop]));
  g.stations.catchMaxB = typeof d.catchMaxB === 'number' ? d.catchMaxB : 0;
  // Saved platform preferences are restored verbatim; loading routing tables is not a route edit.
  try { g.lines.rebuild(true, false); } catch (e) { console.warn('Save load: rebuild failed', e); }
  // Restore derived walking dependencies and shares at the saved building horizon. A cold share cache would
  // slice a pending refresh while the running game's warm cache commits it immediately.
  // A pending share-out retains its next-tick road-access refresh; don't apply it early. Prime with saved access.
  const S = g.stations as any, accessVersion = S.accessVersion;
  S.accessVersion = net.version;
  // A brand-new empty network has not run its first share-out. Historical horizon zero can also
  // be warm, so preserve the explicit cold hint instead of conflating the two states.
  if (!(d.catchmentEmptyCold === true && g.stations.map.size === 0 && d.catchMaxB === 0))
    g.stations.restoreCatchmentShares(d.catchMaxB, !!d.catchmentDirty || !!d.catchmentRoadsDirty || !!d.catchmentInputsDirty);
  S.accessVersion = accessVersion;
  // Rebuilding routing re-adds waiting groups; retain their saved transfer counts, including explicit zeroes.
  for (const s of d.stations as any[]) for (const wg of s.waiting as WaitGroup[]) {
    const restored = g.stations.get(s.id)?.waiting.get(fareGroupKey(wg.line, wg.alight, wg.dest, wg.rail ?? 0, changeClass(wg.transfers, wg.count)));
    if (restored && restored.count === wg.count && wg.transfers !== undefined) restored.transfers = wg.transfers;
  }
  for (const st of g.stations.map.values()) { const c = catchPop.get(st.id); if (typeof c === 'number') st.catchPop = c; }
  g.lines.catchmentDirty = !!d.catchmentDirty;
  g.lines.catchmentRoadsDirty = !!d.catchmentRoadsDirty;
  // older saves: lines whose stops are a subset of another line's become its service patterns (9k)
  if (!d.opsVersion) {
    try { for (const n of canonicalizeLines(g, undefined, { sameOwnerOnly: true })) g.postNews(n.text, 'info'); }
    catch (e) { console.warn('Save load: canonicalizeLines failed', e); }
  }
  // AI companies (an interrupted project is cleaned up now that stations, lines and vehicles exist)
  try { g.restoreAIs(d); } catch (e) { console.warn('Save load: restoreAIs failed', e); }
  try { loadNetwork(g, d.aiNetwork); } catch (e) { console.warn('Save load: loadNetwork failed', e); }
  // Saved road shapes restore after the first share-cache prime. Align their disposable input
  // versions too; retain any genuinely pending population work for the next simulation tick.
  if (!(d.catchmentEmptyCold === true && g.stations.map.size === 0 && d.catchMaxB === 0))
    g.stations.restoreCatchmentShares(d.catchMaxB, g.lines.catchmentDirty || g.lines.catchmentRoadsDirty || !!d.catchmentInputsDirty);
  if (!d.ambient) V.manageAmbient();
  // network changes made just before saving reach the vehicles at the next update, as they would have
  if (d.networkDirty) (g as any).networkDirty = true;
  // Upgrades can remove old road ends or add wire: refresh saved paths before this game can be re-saved.
  if (!d.opsVersion) {
    try { g.flushNetworkChanges(); } catch (e) { console.warn('Save load: refresh upgraded paths failed', e); }
  }
  // Keep chunks dirtied by the old-save upgrades (in particular the new overhead wire).
  if (d.opsVersion) w.dirtyObj.clear();
  w.dirtyTerrain.clear();
  return g;
}

// ------------------------------------------------------------------------------ storage

/** No external URL or asset: this source is embedded in the final standalone HTML. */
export function saveWorkerSource(): string {
  return `const codec = (${saveCodec.toString()})();
    self.onmessage = async ({data: {id, kind, raw, stride}}) => {
      try {
        let data;
        if (kind === 'file') {
          const text = (x) => typeof x === 'string' ? x : 'gz:' + codec.base64(x);
          data = 'rf3:' + JSON.stringify({version: 3, game: ${JSON.stringify(GAME_VERSION)}, data: text(raw.data), parts: raw.parts.map(p => [p.key, text(p.data)])});
        } else data = await codec.encode(kind, kind === 'json' ? codec.profiles(raw) : raw, stride);
        self.postMessage({id, data}, data instanceof Uint8Array ? [data.buffer] : []);
      } catch (e) { self.postMessage({id, error: String(e && e.message || e)}); }
    };`;
}
let worker: Worker | null = null, workerUnavailable = false, jobId = 0;
const jobs = new Map<number, { resolve: (v: Uint8Array | string) => void; reject: (e: Error) => void }>();
function getWorker(): Worker | null {
  if (worker || workerUnavailable) return worker;
  if (typeof Worker === 'undefined') { workerUnavailable = true; return null; }
  try {
    const url = URL.createObjectURL(new Blob([saveWorkerSource()], { type: 'text/javascript' }));
    try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    worker.onmessage = (e: MessageEvent) => {
      const job = jobs.get(e.data.id); if (!job) return;
      jobs.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.data);
    };
    worker.onerror = () => {
      worker?.terminate(); worker = null; workerUnavailable = true;
      for (const job of jobs.values()) job.reject(new Error('Save worker unavailable'));
      jobs.clear();
    };
  } catch { workerUnavailable = true; worker = null; }
  return worker;
}
async function encodeValue(kind: string, raw: any, stride = 0): Promise<Uint8Array | string> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<Uint8Array | string>((resolve, reject) => {
        const id = ++jobId; jobs.set(id, { resolve, reject });
        // Only copied chunks are transferable: cached snapshots must remain immutable/reusable.
        const start = performance.now();
        try {
          const value = kind === 'json' ? { ...raw,
            world: { ...raw.world, buildings: { ...raw.world.buildings, values: raw.world.buildings.values.slice() } },
            net: { ...raw.net, profiles: raw.net.profiles.slice(), nodes: { ...raw.net.nodes,
              values: raw.net.nodes.values.slice(), edgeIds: raw.net.nodes.edgeIds.slice(), edgeOffsets: raw.net.nodes.edgeOffsets.slice() } },
          } : kind === 'file' ? raw : raw.slice();
          const transfer = ArrayBuffer.isView(value) ? [value.buffer as ArrayBuffer]
            : kind === 'json' ? [value.world.buildings.values.buffer, value.net.profiles.buffer,
              value.net.nodes.values.buffer, value.net.nodes.edgeIds.buffer, value.net.nodes.edgeOffsets.buffer] : [];
          w.postMessage({ id, kind, raw: value, stride }, transfer);
          saveStats.lastPostMs += performance.now() - start;
        } catch (e) { jobs.delete(id); reject(e as Error); }
      });
    } catch { /* file:// policies can forbid Blob workers: use the sliced fallback below */ }
  }
  // One chunk per task if workers are unavailable. Capture already detached all mutable game data.
  await new Promise<void>((r) => setTimeout(r, 0));
  if (kind === 'file') {
    const text = (x: Uint8Array | string) => typeof x === 'string' ? x : 'gz:' + b64(x);
    return 'rf3:' + JSON.stringify({ version: VERSION, game: GAME_VERSION, data: text(raw.data), parts: raw.parts.map((p: any) => [p.key, text(p.data)]) });
  }
  if (kind === 'json') {
    const d = { ...raw, world: { ...raw.world, buildings: [] as any[] },
      net: { ...raw.net, nodes: [] as any[], edges: raw.net.edges.map((e: any) => ({ ...e })) } };
    const { fields, values } = raw.world.buildings;
    for (let at = 0; at < values.length; at += 500 * fields.length) {
      const batch = { world: { buildings: { fields, values: values.subarray(at, at + 500 * fields.length) } }, net: { edges: [] } };
      d.world.buildings.push(...codec.profiles(batch).world.buildings);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    for (let at = 0; at < raw.net.nodes.kind.length; at += 500) {
      d.net.nodes.push(...codec.unpackNodes(raw.net.nodes, at, at + 500));
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    for (let at = 0; at < d.net.edges.length; at += 100) {
      codec.profiles({ world: { buildings: [] }, net: { edges: d.net.edges.slice(at, at + 100), profiles: raw.net.profiles } });
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    delete d.net.profiles;
    return codec.encode('json', d);
  }
  return codec.encode(kind, raw, stride);
}

export async function encodeSnapshot(snapshot: ReturnType<typeof captureSave>): Promise<StoredSave> {
  const start = performance.now(); saveStats.lastPostMs = 0;
  const parts = snapshot.chunks.map(async (t) => {
    if (!t.encoded) {
      saveStats.encodedChunks++;
      t.encoded = encodeValue(t.kind, t.raw, t.stride).catch((e) => { t.encoded = undefined; throw e; });
    }
    return { key: t.key, data: await t.encoded };
  });
  const data = await encodeValue('json', snapshot.state);
  const encoded = await Promise.all(parts);
  saveStats.lastEncodeMs = performance.now() - start;
  return { slot: '', meta: snapshot.meta, data, partKeys: encoded.map((p) => p.key), parts: encoded };
}
async function decodeBytes(data: Uint8Array | string): Promise<Uint8Array> {
  if (typeof data === 'string') {
    if (data.startsWith('b64:')) return unb64(data.slice(4));
    if (!data.startsWith('gz:')) throw new Error('Invalid compressed chunk');
    data = unb64(data.slice(3));
  }
  if (typeof DecompressionStream === 'undefined') throw new Error('Browser cannot decompress this save');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function recordState(rec: StoredSave): Promise<any> {
  const text = typeof rec.data === 'string' && !rec.data.startsWith('b64:') ? await gunzip(rec.data)
    : new TextDecoder().decode(await decodeBytes(rec.data));
  const d = JSON.parse(text);
  if (rec.partKeys) {
    const parts = new Map((rec.parts ?? []).map((p) => [p.key, p.data]));
    const refs = [...d.world.h, ...d.world.lock, ...d.world.trees];
    if (refs.length !== rec.partKeys.length || refs.some((k, i) => k !== rec.partKeys![i])) throw new Error('Invalid save manifest');
    for (const field of ['h', 'lock', 'trees']) d.world[field] = await Promise.all(d.world[field].map(async (key: string) => {
      const data = parts.get(key); if (data === undefined) throw new Error('Missing save chunk: ' + key);
      return decodeBytes(data);
    }));
  }
  return d;
}
/** A resumed game reuses the stored compressed chunks too, so its first autosave only writes state.
 * Verify bytes against the restored world: load-time upgrades may have changed individual chunks.
 * Imported files get fresh keys, so their untrusted identifiers cannot alias another stored save. */
function reuseLoadedParts(g: Game, d: any, rec: StoredSave, keepKeys: boolean) {
  if (d.version !== VERSION || !rec.partKeys || !rec.parts) return;
  const c = worldChunks(g.world), encoded = new Map(rec.parts.map((p) => [p.key, p.data]));
  let index = 0;
  for (const [field, chunks] of [['h', c.h], ['lock', c.lock], ['trees', c.trees]] as const) {
    for (let i = 0; i < chunks.length; i++, index++) {
      const chunk = chunks[i], source = d.world[field][i], key = rec.partKeys[index];
      if (!source || !encoded.has(key)) continue;
      const bytes = typeof source === 'string' ? unb64(source) : source;
      const raw = field === 'lock' ? bytes : codec.unpackFloats(bytes, chunk.stride);
      if (!sameBytes(raw, chunk.raw)) continue;
      if (keepKeys) chunk.key = key;
      chunk.encoded = Promise.resolve(encoded.get(key)!);
    }
  }
}

async function gunzipBytes(u8: Uint8Array): Promise<string> {
  const ds = new Blob([u8 as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(ds).text();
}
/** Text form used by older exported files and localStorage saves. */
async function gunzip(data: string): Promise<string> {
  if (data.startsWith('raw:')) return data.slice(4);
  if (!data.startsWith('gz:')) return data;
  return gunzipBytes(unb64(data.slice(3)));
}

export interface SlotInfo { slot: string; name: string; date: string; saved: number; money: number; format?: number; game?: string }

/** Why a save can't be read by this build, or null. Saves without a marker are older ones this build reads. */
export function saveIncompatibility(info: { format?: unknown; version?: unknown; game?: unknown } | null | undefined): string | null {
  const format = info?.format ?? info?.version;
  if (format === undefined || (typeof format === 'number' && READABLE.includes(format))) return null;
  const by = typeof info?.game === 'string' ? `Railfever v${info.game}` : typeof format === 'number' && format > VERSION ? 'a newer version of Railfever' : 'an older version of Railfever';
  return `Incompatible with v${GAME_VERSION}: save from ${by}.`;
}

let slotCache: SlotInfo[] = [];
async function refreshSlots() {
  const all = await listSaves();
  slotCache = all.map((r) => r.meta as SlotInfo).filter((m) => !!m && typeof m === 'object' && typeof m.slot === 'string').sort((a, b) => b.saved - a.saved);
}
/** Resolves once the saved slots are known (IndexedDB is asynchronous; old localStorage saves are migrated). */
export const slotsReady: Promise<void> = (async () => {
  try { await migrateLegacy(); } catch (e) { console.warn('legacy save migration unavailable', e); }
  try { await refreshSlots(); } catch (e) { console.warn('save storage unavailable', e); }
})();

const slotWrites = new Map<string, Promise<void>>();
/** Capture now, then serialize writes to a slot so a slow older snapshot cannot overwrite a newer one. */
export function saveToSlot(g: Game, slot: string, name: string): Promise<void> {
  const snapshot = captureSave(g);
  const previous = slotWrites.get(slot) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const rec = await encodeSnapshot(snapshot);
    const meta: SlotInfo = { slot, name, ...snapshot.meta };
    await putSave({ ...rec, slot, meta });
    slotCache = [meta, ...slotCache.filter((s) => s.slot !== slot)].sort((a, b) => b.saved - a.saved);
  });
  slotWrites.set(slot, write);
  write.then(() => { if (slotWrites.get(slot) === write) slotWrites.delete(slot); }, () => { if (slotWrites.get(slot) === write) slotWrites.delete(slot); });
  return write;
}

async function backupRecord(rec: StoredSave, slot: string, name: string, once: boolean): Promise<void> {
  const old = rec.meta as Partial<SlotInfo> | null;
  const meta: SlotInfo = { slot, name, date: old?.date ?? '', saved: old?.saved ?? Date.now(), money: old?.money ?? 0, format: old?.format, game: old?.game };
  const backup: StoredSave = { ...rec, slot, data: typeof rec.data === 'string' ? rec.data : rec.data.slice(), meta };
  if (once) await putSaveOnce(backup);
  else await putSave(backup);
  await refreshSlots();
}

/** Copy the stored bytes, including saves that cannot be parsed or loaded. */
export async function backupSlot(source: string, slot: string, name: string): Promise<void> {
  await slotsReady;
  const rec = await getSave(source);
  if (rec) await backupRecord(rec, slot, name, false);
}

export async function loadFromSlot(slot: string): Promise<Game> {
  await slotsReady;
  const rec = await getSave(slot);
  if (!rec) throw new Error('Empty slot');
  const d = await recordState(rec);
  if (slot === 'autosave' && d && !d.opsVersion) await backupRecord(rec, 'autosave-v2.3', 'Autosave (v2.3 backup)', true);
  const g = deserialize(d);
  reuseLoadedParts(g, d, rec, true);
  return g;
}

/** Known save slots, newest first (complete once `slotsReady` has resolved). */
export function listSlots(): SlotInfo[] { return slotCache.slice(); }

export function deleteSlot(slot: string) {
  slotCache = slotCache.filter((s) => s.slot !== slot);
  deleteSave(slot).catch((e) => console.warn('delete failed', e));
}

export async function exportToFile(g: Game): Promise<Blob> {
  const rec = await encodeSnapshot(captureSave(g));
  return new Blob([await encodeValue('file', rec) as string], { type: 'application/octet-stream' });
}

export async function importFromText(text: string): Promise<Game> {
  text = text.trim();
  if (!text.startsWith('rf3:')) return deserialize(JSON.parse(await gunzip(text)));
  const file = JSON.parse(text.slice(4));
  if (file.version !== VERSION || !Array.isArray(file.parts)) throw new Error(saveIncompatibility({ version: file.version, game: file.game }) ?? 'Not a Railfever save file');
  const parts = file.parts.map(([key, data]: [string, string]) => ({ key, data }));
  const rec: StoredSave = { slot: '', meta: null, data: file.data, parts, partKeys: parts.map((p: any) => p.key) };
  const d = await recordState(rec), g = deserialize(d);
  reuseLoadedParts(g, d, rec, false);
  return g;
}
