// Save games: serialisation to compressed JSON.
import { Game } from './game';
import { World, Building, Structure, Depot } from './world';
import type { Town } from './towns';
import type { Station } from './stations';
import type { Line } from './lines';
import { Train, TSeg, makeTileSeg, makeStructSeg, makeDepotSeg } from './train';
import { RoadVehicle, RSeg, makeRoadSeg, makeRoadStructSeg, makeRoadDepotSeg } from './roadvehicle';
import { MODEL_BY_ID } from './vehicle-types';
import { clearGeomCaches } from './geom';
import { Vehicle } from './vehicle';

const VERSION = 1;

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
function fill<T extends Int16Array | Int32Array | Uint8Array | Uint32Array>(dst: T, src: string) {
  const u8 = unb64(src);
  new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(u8.subarray(0, dst.byteLength));
}

interface SegData { t: number; a: number; b: number; sid: number; rev: boolean; stop?: boolean }
const segData = (s: TSeg | RSeg): SegData => ({ t: s.t, a: s.a, b: s.b, sid: s.sid, rev: s.rev, ...('stop' in s && s.stop ? { stop: true } : {}) });

export function serialize(g: Game): any {
  const w = g.world;
  const vehicles: any[] = [];
  for (const v of g.vehicles.map.values()) {
    const base = {
      id: v.id, name: v.name, lineId: v.lineId, stopIndex: v.stopIndex, cargo: [...v.cargo.values()], load: v.load,
      state: v.state, status: v.status, profitYear: v.profitYear, profitLast: v.profitLast, incomeYear: v.incomeYear,
      boughtDay: v.boughtDay, value: v.value, delivered: v.delivered,
    };
    if (v instanceof Train) {
      vehicles.push({
        ...base, type: 'train', cars: v.cars.map((c) => c.id), depotId: v.depotId, segs: v.segs.map(segData), headSeg: v.headSeg, headPos: v.headPos,
        pending: v.pending.map(segData), speed: v.speed, routeTarget: v.routeTarget, atStation: v.atStation, loadTimer: v.loadTimer, reversed: v.reversed,
      });
    } else if (v instanceof RoadVehicle) {
      vehicles.push({
        ...base, type: 'road', model: v.model?.id, depotId: v.depotId, seg: v.seg ? segData(v.seg) : null, prev: v.prev ? segData(v.prev) : null,
        pos: v.pos, speed: v.speed, route: v.route.map(segData), routeTarget: v.routeTarget, loadTimer: v.loadTimer,
      });
    }
  }
  return {
    version: VERSION,
    options: g.options, day: g.day, dayFrac: g.dayFrac, visualTime: g.visualTime, rng: g.rng.state,
    world: {
      size: w.size, hgt: b64(w.hgt), rail: b64(w.rail), road: b64(w.road), roadOwner: b64(w.roadOwner), building: b64(w.building),
      station: b64(w.station), stationKind: b64(w.stationKind), depot: b64(w.depot), trees: b64(w.trees), signal: b64(w.signal),
      span: b64(w.span), townOf: b64(w.townOf),
      buildings: w.buildings, structures: [...w.structures.values()], depots: [...w.depots.values()],
      nextStructureId: w.nextStructureId, nextDepotId: w.nextDepotId,
    },
    towns: g.towns.list.map((t) => ({ ...t, buildings: [...t.buildings] })),
    stations: [...g.stations.map.values()].map((s) => ({ ...s, waiting: [...s.waiting.values()] })),
    stationsNextId: g.stations.nextId,
    lines: [...g.lines.map.values()], linesNextId: g.lines.nextId,
    vehicles, vehiclesNextId: g.vehicles.nextId,
    economy: {
      money: g.economy.money, loan: g.economy.loan, maxLoan: g.economy.maxLoan, current: g.economy.current, months: g.economy.months,
      yearTotals: g.economy.yearTotals, thisYear: g.economy.thisYear,
    },
    firstArrival: [...g.firstArrival],
    news: g.news.slice(-40),
  };
}

export function deserialize(d: any): Game {
  if (d.version !== VERSION) throw new Error('Unsupported save version');
  clearGeomCaches();
  const wd = d.world;
  const w = new World(wd.size);
  fill(w.hgt, wd.hgt); fill(w.rail, wd.rail); fill(w.road, wd.road); fill(w.roadOwner, wd.roadOwner);
  fill(w.building, wd.building); fill(w.station, wd.station); fill(w.stationKind, wd.stationKind); fill(w.depot, wd.depot);
  fill(w.trees, wd.trees); fill(w.signal, wd.signal); fill(w.span, wd.span); fill(w.townOf, wd.townOf);
  w.buildings = wd.buildings as (Building | null)[];
  w.freeBuildingIds = [];
  w.buildings.forEach((b, i) => { if (!b) w.freeBuildingIds.push(i); });
  for (const s of wd.structures as Structure[]) {
    w.structures.set(s.id, s);
    w.heads.set(w.idx(s.ax, s.az) * 4 + s.dir, s.id);
    w.heads.set(w.idx(s.bx, s.bz) * 4 + ((s.dir + 2) % 4), s.id);
  }
  for (const dp of wd.depots as Depot[]) w.depots.set(dp.id, dp);
  w.nextStructureId = wd.nextStructureId;
  w.nextDepotId = wd.nextDepotId;
  w.dirtyObj.clear(); w.dirtyTerrain.clear();

  const g = new Game(d.options, w);
  g.day = d.day; g.dayFrac = d.dayFrac; g.visualTime = d.visualTime; g.rng.state = d.rng;
  g.towns.list = (d.towns as any[]).map((t) => ({ ...t, buildings: new Set<number>(t.buildings) } as Town));
  for (const s of d.stations as any[]) {
    const st: Station = { ...s, waiting: new Map() };
    for (const wg of s.waiting) st.waiting.set(wg.line + ':' + wg.alight + ':' + wg.dest, wg);
    g.stations.map.set(st.id, st);
  }
  g.stations.nextId = d.stationsNextId;
  for (const l of d.lines as Line[]) g.lines.map.set(l.id, l);
  g.lines.nextId = d.linesNextId;
  Object.assign(g.economy, d.economy);
  g.firstArrival = new Set(d.firstArrival);
  g.news = d.news ?? [];

  const V = g.vehicles;
  const tseg = (s: SegData): TSeg | null => {
    if (s.sid === -1) {
      if (!w.inBounds(w.tx(s.t), w.tz(s.t)) || !(w.railExits(s.t, s.a) & (1 << s.b))) return null;
      return makeTileSeg(g, s.t, s.a, s.b);
    }
    if (s.sid >= 0) { const st = w.structures.get(s.sid); return st ? makeStructSeg(g, st, !s.rev) : null; }
    return null;
  };
  const rseg = (s: SegData | null): RSeg | null => {
    if (!s) return null;
    let r: RSeg | null = null;
    if (s.sid === -1) {
      if (!w.road[s.t]) return null;
      r = makeRoadSeg(g, s.t, s.a, s.b);
    } else if (s.sid >= 0) { const st = w.structures.get(s.sid); r = st ? makeRoadStructSeg(g, st, !s.rev) : null; }
    if (r && s.stop) r.stop = true;
    return r;
  };
  for (const vd of d.vehicles as any[]) {
    let v: Vehicle;
    if (vd.type === 'train') {
      const cars = (vd.cars as string[]).map((id) => MODEL_BY_ID.get(id)!).filter(Boolean);
      const t = new Train(g, vd.id, cars, vd.depotId);
      t.speed = vd.speed; t.routeTarget = vd.routeTarget; t.atStation = vd.atStation; t.loadTimer = vd.loadTimer; t.reversed = vd.reversed;
      let ok = true;
      const segs: TSeg[] = [];
      for (const s of vd.segs as SegData[]) {
        if (s.sid === -2) {
          const dp = w.depots.get(vd.depotId);
          if (!dp) { ok = false; break; }
          segs.push(makeDepotSeg(g, dp, t.length + 0.2));
          continue;
        }
        const x = tseg(s);
        if (!x) { ok = false; break; }
        segs.push(x);
      }
      const pending: TSeg[] = [];
      for (const s of vd.pending as SegData[]) { const x = tseg(s); if (!x) break; pending.push(x); }
      if (ok && segs.length) {
        t.segs = segs; t.headSeg = Math.min(vd.headSeg, segs.length - 1); t.headPos = vd.headPos; t.pending = pending;
        for (const s of segs) if (s.res >= 0) V.setRes(s.res, t.id);
      }
      v = t;
      Object.assign(v, { state: ok && segs.length ? vd.state : 'depot' });
    } else {
      const model = MODEL_BY_ID.get(vd.model) ?? null;
      const r = new RoadVehicle(g, vd.id, model, vd.depotId, false);
      r.seg = rseg(vd.seg); r.prev = rseg(vd.prev); r.pos = vd.pos; r.speed = vd.speed;
      r.route = (vd.route as SegData[]).map(rseg).filter((x): x is RSeg => !!x);
      r.routeTarget = vd.routeTarget; r.loadTimer = vd.loadTimer;
      v = r;
      Object.assign(v, { state: r.seg ? vd.state : 'depot' });
    }
    v.name = vd.name; v.lineId = vd.lineId; v.stopIndex = vd.stopIndex; v.load = vd.load;
    for (const c of vd.cargo) v.cargo.set(c.from + ':' + c.alight + ':' + c.dest, c);
    v.status = vd.status; v.profitYear = vd.profitYear; v.profitLast = vd.profitLast; v.incomeYear = vd.incomeYear;
    v.boughtDay = vd.boughtDay; v.value = vd.value; v.delivered = vd.delivered ?? 0;
    V.map.set(v.id, v);
  }
  V.nextId = d.vehiclesNextId;
  g.lines.rebuild();
  V.manageAmbient();
  return g;
}

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
  localStorage.setItem(PREFIX + slot, data);
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
