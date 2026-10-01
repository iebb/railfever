// Save games (format v2): the free-form world, network, companies, AI and vehicles as compressed JSON.
import { Game } from './game';
import { World, Building, Tree } from './world';
import type { NNode, NEdge, Crossing, Section } from './network';
import type { Town } from './towns';
import type { Station, WaitGroup } from './stations';
import type { Depot } from './build-ops';
import type { Line } from './lines';
import { Economy, Company } from './economy';
import { AIController } from './ai';
import { Train, TSeg, makeSeg } from './train';
import { RoadVehicle, RSeg, RCont, makeLaneSeg, makeConn } from './roadvehicle';
import { makeCurve } from './network';
import { MODEL_BY_ID } from './vehicle-types';
import { KMH_TO_UPS } from './constants';
import type { Vehicle, CargoGroup } from './vehicle';

const VERSION = 2;

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
  v.cargo.clear();
  for (const c of list) {
    const k = c.from + ':' + c.alight + ':' + c.dest;
    const o = v.cargo.get(k);
    if (o) { o.day = (o.day * o.count + c.day * c.count) / Math.max(1, o.count + c.count); o.count += c.count; }
    else v.cargo.set(k, { ...c });
  }
}

function baseOf(v: Vehicle) {
  return {
    id: v.id, owner: v.owner, name: v.name, lineId: v.lineId, stopIndex: v.stopIndex, cargo: cargoOf(v), load: v.load,
    state: v.state, status: v.status, profitYear: v.profitYear, profitLast: v.profitLast, incomeYear: v.incomeYear,
    boughtDay: v.boughtDay, value: v.value, stateTime: v.stateTime, homeX: v.homeX, homeZ: v.homeZ, delivered: v.delivered,
  };
}
function restoreBase(v: Vehicle, d: any) {
  v.owner = d.owner; v.name = d.name; v.lineId = d.lineId; v.stopIndex = d.stopIndex; restoreCargo(v, d.cargo ?? []);
  v.load = d.load; v.state = d.state; v.status = d.status; v.profitYear = d.profitYear; v.profitLast = d.profitLast;
  v.incomeYear = d.incomeYear; v.boughtDay = d.boughtDay; v.value = d.value; v.stateTime = d.stateTime ?? 0;
  v.homeX = d.homeX ?? v.homeX; v.homeZ = d.homeZ ?? v.homeZ; v.delivered = d.delivered ?? 0;
}

function trainOf(t: Train) {
  return {
    ...baseOf(t), type: 'train', cars: t.cars.map((c) => c.id), depotId: t.depotId,
    segs: t.segs.map((s) => (s.e < 0 ? [-1, s.dir, s.len] : [s.e, s.dir])), headSeg: t.headSeg, headPos: t.headPos,
    pending: t.pending.map((s) => [s.e, s.dir]), speed: t.speed, waitTime: t.waitTime, retryTimer: t.retryTimer,
    loadTimer: t.loadTimer, routeTarget: t.routeTarget, atStation: t.atStation, reversed: t.reversed, blockedBy: t.blockedBy,
    failCount: t.failCount,
  };
}

function roadOf(v: RoadVehicle) {
  return {
    ...baseOf(v), type: 'road', model: v.model?.id ?? null, ambient: v.ambient, depotId: v.depotId,
    seg: v.seg ? rsegD(v.seg) : null, pos: v.pos, trail: v.trail.map(rsegD), ahead: v.ahead.map(rsegD),
    route: v.route.map((r) => [r.edge, r.dir]), speed: v.speed, loadTimer: v.loadTimer, retryTimer: v.retryTimer,
    junctionWait: v.junctionWait, stuck: v.stuck, ttl: v.ttl, rng: v.rng.state, style: v.style, tint: v.tint, cruise: v.cruise,
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

export function serialize(g: Game): any {
  const w = g.world;
  const net = w.net;
  const trees = new Float32Array(w.trees.length * 5);
  w.trees.forEach((t, i) => {
    if (!t) { trees[i * 5] = NaN; return; }
    trees.set([t.x, t.z, t.s, t.type, t.tint], i * 5);
  });
  const V = g.vehicles as any;
  return {
    version: VERSION,
    options: g.options, day: g.day, dayFrac: g.dayFrac, visualTime: g.visualTime, rng: g.rng.state, aiEnabled: g.aiEnabled,
    companies: g.companies.map((c) => ({ id: c.id, name: c.name, color: c.color, ai: c.ai, economy: JSON.parse(JSON.stringify(c.economy)) })),
    ais: g.ais.map((a) => a.toJSON()),
    world: {
      size: w.size, h: f32enc(w.h), lock: b64(w.lock), trees: f32enc(trees),
      buildings: [...w.buildings.values()], nextBuildingId: w.nextBuildingId,
    },
    net: {
      nodes: [...net.nodes.values()],
      edges: [...net.edges.values()].map((e) => ({ ...e, prof: f32enc(e.prof) })),
      crossings: [...net.crossings.values()],
      nextNode: net.nextNode, nextEdge: net.nextEdge, nextCrossing: net.nextCrossing,
    },
    towns: g.towns.list.map((t) => ({ ...t, buildings: [...t.buildings] })),
    stations: [...g.stations.map.values()].map((s) => ({ ...s, waiting: [...s.waiting.values()] })),
    stationsNextId: g.stations.nextId,
    depots: [...g.depots.map.values()], depotsNextId: g.depots.nextId,
    lines: [...g.lines.map.values()], linesNextId: g.lines.nextId,
    vehicles: [...g.vehicles.map.values()].map((v) => (v instanceof Train ? trainOf(v) : roadOf(v as RoadVehicle))),
    ambient: g.vehicles.ambient.map(roadOf),
    vehiclesNextId: g.vehicles.nextId, nextAmbientId: g.vehicles.nextAmbientId, ambientEnabled: g.vehicles.ambientEnabled,
    vrng: V.rng?.state, ambientTimer: V.ambientTimer,
    firstArrival: [...g.firstArrival],
    news: g.news.slice(-40),
  };
}

// ------------------------------------------------------------------------------ deserialize

export function deserialize(d: any): Game {
  if (!d || d.version !== VERSION) throw new Error('Unsupported save version (this game uses format ' + VERSION + ')');
  const wd = d.world;
  const w = new World(wd.size);
  w.h.set(f32dec(wd.h).subarray(0, w.h.length));
  w.lock.set(unb64(wd.lock).subarray(0, w.lock.length));
  // trees keep their ids (index)
  const tr = f32dec(wd.trees);
  for (let i = 0; i < tr.length / 5; i++) {
    if (isNaN(tr[i * 5])) { w.trees[i] = null; w.freeTrees.push(i); continue; }
    const t: Tree = { x: tr[i * 5], z: tr[i * 5 + 1], s: tr[i * 5 + 2], type: tr[i * 5 + 3], tint: tr[i * 5 + 4] };
    w.trees[i] = t;
    w.treeGrid.insert(i, t.x, t.z, t.x, t.z);
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
    const e: NEdge = { ...ed, bez: { ...ed.bez }, prof: f32dec(ed.prof), sections: (ed.sections as Section[]).map((s) => ({ ...s })) };
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
  w.dirtyObj.clear(); w.dirtyTerrain.clear();

  const g = new Game({ ...d.options }, w);
  g.day = d.day; g.dayFrac = d.dayFrac; g.visualTime = d.visualTime; g.rng.state = d.rng;
  g.aiEnabled = d.aiEnabled ?? true;
  // companies and AI
  g.companies = (d.companies as any[]).map((c) => {
    const eco = Object.assign(new Economy(), c.economy);
    return { id: c.id, name: c.name, color: c.color, ai: c.ai, economy: eco } as Company;
  });
  g.ais = [];
  for (const c of g.companies) {
    if (!c.ai) continue;
    const ai = new AIController(g, c.id);
    const data = (d.ais as any[] ?? []).find((a) => a && a.companyId === c.id);
    if (data) { try { ai.load(data); } catch (e) { console.warn('AI state could not be restored', e); } }
    g.ais.push(ai);
  }
  // towns, stations, depots, lines
  g.towns.list = (d.towns as any[]).map((t) => ({ ...t, buildings: new Set<number>(t.buildings) } as Town));
  for (const s of d.stations as any[]) {
    const st: Station = { ...s, rail: s.rail ? { ...s.rail, edges: [...s.rail.edges] } : null, stops: s.stops.map((p: any) => ({ ...p })), waiting: new Map() };
    st.waitingTotal = 0;
    for (const wg of s.waiting as WaitGroup[]) g.stations.addWaiting(st, wg.line, wg.alight, wg.dest, wg.count);
    g.stations.map.set(st.id, st);
  }
  g.stations.nextId = d.stationsNextId;
  for (const dp of d.depots as Depot[]) g.depots.map.set(dp.id, { ...dp });
  g.depots.nextId = d.depotsNextId;
  for (const l of d.lines as Line[]) g.lines.map.set(l.id, { ...l, stops: [...l.stops], vehicles: [...l.vehicles] });
  g.lines.nextId = d.linesNextId;
  g.firstArrival = new Set(d.firstArrival ?? []);
  g.news = (d.news ?? []).map((n: any) => ({ ...n }));

  // vehicles
  const V = g.vehicles;
  const tseg = (x: number[], t: Train): TSeg | null => {
    if (x[0] < 0) { const dp = g.depots.get(t.depotId); return dp ? depotSeg(g, dp, x[2] ?? t.length + 0.3) : null; }
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
    restoreBase(r, vd);
    r.rng.state = vd.rng; r.style = vd.style; r.tint = vd.tint; r.cruise = vd.cruise; r.ttl = vd.ttl;
    r.speed = vd.speed; r.loadTimer = vd.loadTimer; r.retryTimer = vd.retryTimer; r.junctionWait = vd.junctionWait; r.stuck = vd.stuck;
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
      restoreBase(t, vd);
      t.speed = vd.speed; t.waitTime = vd.waitTime ?? 0; t.retryTimer = vd.retryTimer ?? 0; t.loadTimer = vd.loadTimer ?? 0;
      t.routeTarget = vd.routeTarget; t.atStation = vd.atStation; t.reversed = !!vd.reversed; t.blockedBy = vd.blockedBy ?? 0;
      t.failCount = vd.failCount ?? 0;
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
      }
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
  V.ambient = (d.ambient as any[] ?? []).map(makeRoad).filter((a) => a.seg);
  // routing tables; keep the saved catchment populations until the next monthly update
  const catchPop = new Map((d.stations as any[]).map((s) => [s.id, s.catchPop]));
  g.lines.rebuild();
  for (const st of g.stations.map.values()) { const c = catchPop.get(st.id); if (typeof c === 'number') st.catchPop = c; }
  if (!d.ambient) V.manageAmbient();
  w.dirtyObj.clear(); w.dirtyTerrain.clear();
  return g;
}

// ------------------------------------------------------------------------------ storage

async function gzip(text: string): Promise<string> {
  if (typeof CompressionStream === 'undefined') return 'raw:' + text;
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  return 'gz:' + b64(buf);
}
async function gunzip(data: string): Promise<string> {
  if (data.startsWith('raw:')) return data.slice(4);
  if (!data.startsWith('gz:')) return data;
  const u8 = unb64(data.slice(3));
  const ds = new Blob([u8 as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(ds).text();
}

export interface SlotInfo { slot: string; name: string; date: string; saved: number; money: number }

const PREFIX = 'railfever.save.';

export async function saveToSlot(g: Game, slot: string, name: string): Promise<void> {
  const data = await gzip(JSON.stringify(serialize(g)));
  const meta: SlotInfo = { slot, name, date: g.dateString(), saved: Date.now(), money: g.economy.money };
  try {
    localStorage.setItem(PREFIX + slot, data);
  } catch (e) {
    // quota: drop the autosave to make room and retry once
    if (slot !== 'autosave' && localStorage.getItem(PREFIX + 'autosave')) { deleteSlot('autosave'); localStorage.setItem(PREFIX + slot, data); }
    else throw e;
  }
  localStorage.setItem(PREFIX + slot + '.meta', JSON.stringify(meta));
}

export async function loadFromSlot(slot: string): Promise<Game> {
  const data = localStorage.getItem(PREFIX + slot);
  if (!data) throw new Error('Empty slot');
  return deserialize(JSON.parse(await gunzip(data)));
}

export function listSlots(): SlotInfo[] {
  const out: SlotInfo[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(PREFIX) && k.endsWith('.meta')) {
      try { out.push(JSON.parse(localStorage.getItem(k)!)); } catch { /* ignore */ }
    }
  }
  return out.sort((a, b) => b.saved - a.saved);
}

export function deleteSlot(slot: string) {
  localStorage.removeItem(PREFIX + slot);
  localStorage.removeItem(PREFIX + slot + '.meta');
}

export async function exportToFile(g: Game): Promise<Blob> {
  const data = await gzip(JSON.stringify(serialize(g)));
  return new Blob([data], { type: 'application/octet-stream' });
}

export async function importFromText(text: string): Promise<Game> {
  return deserialize(JSON.parse(await gunzip(text.trim())));
}
