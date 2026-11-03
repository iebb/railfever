// Small durable surveys used by main-line opening; native construction remains atomic and permission checked.
import type { Game } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import { walkingPopulation, planWalkingCatchment } from './catchment';
import { buildDepotOnLine, alignCorridor, newProfileCursor, stepProfileCursor, newConflictCursor, stepConflictCursor, planningStep,
  type P2, type OPoint, type RoutePlan, type ProfileCursor, type ConflictCursor, type ChainProfile } from './routing';
import { TRACK_TYPES } from './constants';
import { buildSideDepot } from './depot-sites';

function accessSafe(plan: StationPlan): boolean {
  return plan.roadAccess && !plan.access?.tracks.some(t => t.sections.some(s => s.type === 'bridge'
    && (t.start.kind === 'free' && s.s0 <= .1 || t.end.kind === 'free' && s.s1 >= t.len - .1)));
}
export interface CentreStationCursor {
  version: 1; phase: 'position' | 'quote' | 'score' | 'directionDone' | 'radiusDone' | 'done';
  town: Town; toward: P2; length: number; owner: number; level: 'ground' | 'elevated' | 'underground';
  a0: number; radius: number; direction: number; angle: number; x: number; z: number;
  plan: StationPlan | null; best: StationPlan | null; population: number;
}
export function newCentreStationCursor(town: Town, toward: P2, length: number, owner: number,
  level: CentreStationCursor['level'] = 'underground'): CentreStationCursor {
  return { version: 1, phase: 'position', town, toward, length, owner, level,
    a0: Math.atan2(toward.x - town.x, toward.z - town.z), radius: 0, direction: 0, angle: 0, x: 0, z: 0,
    plan: null, best: null, population: 0 };
}
export function stepCentreStationCursor(g: Game, t: CentreStationCursor): IteratorResult<void, StationPlan | null> {
  const radii = [0, 7, 14], angles = [0, .25, -.25];
  while (true) {
    if (t.phase === 'done') return { done: true, value: t.best };
    if (t.phase === 'position') {
      const radius = radii[t.radius], directions = radius ? [0, Math.PI / 2, Math.PI, -Math.PI / 2] : [0];
      if (t.direction >= directions.length) { t.phase = 'radiusDone'; continue; }
      t.x = t.town.x + Math.sin(t.a0 + directions[t.direction]) * radius;
      t.z = t.town.z + Math.cos(t.a0 + directions[t.direction]) * radius; t.angle = 0; t.phase = 'quote';
    }
    if (t.phase === 'quote') {
      if (t.angle >= angles.length) { t.phase = 'directionDone'; return { done: false, value: undefined }; }
      const angle = Math.atan2(t.toward.x - t.x, t.toward.z - t.z) + angles[t.angle];
      t.plan = g.stations.planRail(t.x, t.z, angle, t.length, 2, t.owner,
        { level: t.level, depth: 2.4, height: 1.5, ...(t.level !== 'ground' ? { entrances: 4 } : {}) });
      t.phase = 'score'; return { done: false, value: undefined };
    }
    if (t.phase === 'score') {
      const p = t.plan;
      if (p?.ok && !p.join && accessSafe(p)) {
        const pop = walkingPopulation(g, planWalkingCatchment(g, p));
        if (pop > t.population) { t.population = pop; t.best = p; }
      }
      t.angle++; t.phase = 'quote';
    }
    if (t.phase === 'directionDone') { t.direction++; t.phase = 'position'; }
    if (t.phase === 'radiusDone') {
      if (t.best || ++t.radius >= radii.length) t.phase = 'done';
      else { t.direction = 0; t.phase = 'position'; }
    }
  }
}

export interface RailDepotCursor {
  version: 1; phase: 'scanPause' | 'scan' | 'sort' | 'candidate' | 'build' | 'next' | 'done';
  edges: number[]; x: number; z: number; maxDistance: number; owner: number;
  entries?: Map<number, 1 | -1>; reserved?: P2[]; sections: readonly ('ground' | 'bridge' | 'tunnel')[];
  index: number; candidates: { id: number; s: number; d: number }[]; tries: number; result: number;
}
export function newRailDepotCursor(edges: number[], x: number, z: number, maxDistance: number, owner: number,
  entries?: Map<number, 1 | -1>, reserved?: P2[], sections: RailDepotCursor['sections'] = ['ground']): RailDepotCursor {
  return { version: 1, phase: 'scanPause', edges, x, z, maxDistance, owner, entries, reserved, sections,
    index: 0, candidates: [], tries: 0, result: -1 };
}
export function stepRailDepotCursor(g: Game, t: RailDepotCursor): IteratorResult<void, number> {
  const net = g.world.net;
  while (true) {
    if (t.phase === 'done') return { done: true, value: t.result };
    if (t.phase === 'scanPause') {
      if (t.index >= t.edges.length) { t.phase = 'sort'; continue; }
      t.phase = 'scan'; return { done: false, value: undefined };
    }
    if (t.phase === 'scan') {
      const e = net.edges.get(t.edges[t.index++]);
      if (e && e.kind === 'rail' && e.owner === t.owner && e.station < 0 && e.depot < 0 && e.len >= 8) {
        const p = { x: 0, y: 0, z: 0 };
        for (let s = 3; s <= e.len - 3; s += 5) {
          if (!t.sections.includes(net.sectionAt(e, s))) continue;
          net.pointAt(e, s, p); const d = Math.hypot(p.x - t.x, p.z - t.z);
          if (d <= t.maxDistance) t.candidates.push({ id: e.id, s, d });
        }
      }
      t.phase = 'scanPause';
    }
    if (t.phase === 'sort') { t.candidates.sort((a, b) => a.d - b.d || a.id - b.id); t.index = 0; t.phase = 'candidate'; }
    if (t.phase === 'candidate') {
      if (t.index >= t.candidates.length) { t.phase = 'done'; continue; }
      const c = t.candidates[t.index];
      if (!net.edges.has(c.id) || t.entries && !t.entries.has(c.id)) { t.index++; continue; }
      t.phase = 'build'; return { done: false, value: undefined };
    }
    if (t.phase === 'build') {
      const c = t.candidates[t.index], dir = t.entries?.get(c.id);
      const depot = net.sectionAt(net.edges.get(c.id)!, c.s) !== 'ground'
        ? buildSideDepot(g, c.id, c.s, t.owner, { dir, reserved: t.reserved })
        : buildDepotOnLine(g, c.id, c.s, t.owner, dir === undefined ? undefined : { dir, side: -1, reserved: t.reserved });
      if (depot >= 0) { t.result = depot; t.phase = 'done'; continue; }
      if (++t.tries >= 12) { t.phase = 'done'; continue; }
      t.phase = 'next'; return { done: false, value: undefined };
    }
    if (t.phase === 'next') { t.index++; t.phase = 'candidate'; }
  }
}

export interface CentralRouteCursor {
  version: 1; phase: 'align' | 'profile' | 'conflict' | 'done';
  pair: { a: StationPlan; b: StationPlan }; hub: Station | null; hubB: Station | null;
  lead: number; tracks: number; type: string; way: OPoint[]; minR: number;
  profile: ProfileCursor | null; prof: ChainProfile | null; conflict: ConflictCursor | null;
  exclude: Set<number>; result: RoutePlan | string | null;
}
export function newCentralRouteCursor(pair: CentralRouteCursor['pair'], hub: Station | null, hubB: Station | null,
  lead: number, tracks: number, type: string): CentralRouteCursor {
  return { version: 1, phase: 'align', pair, hub, hubB, lead, tracks, type, way: [], minR: Infinity,
    profile: null, prof: null, conflict: null, exclude: new Set(), result: null };
}
export function stepCentralRouteCursor(g: Game, t: CentralRouteCursor): IteratorResult<void, RoutePlan | string> {
  const finish = (result: RoutePlan | string) => { t.phase = 'done'; t.result = result; return { done: true as const, value: result }; };
  while (true) {
    if (t.phase === 'done') return finish(t.result!);
    if (t.phase === 'align') {
      const { pair, hub, hubB } = t;
      const sa = hub && Math.sin(pair.a.angle) * (pair.b.x - pair.a.x) + Math.cos(pair.a.angle) * (pair.b.z - pair.a.z) < 0 ? -1 : 1;
      const sb = hubB && Math.sin(pair.b.angle) * (pair.a.x - pair.b.x) + Math.cos(pair.b.angle) * (pair.a.z - pair.b.z) < 0 ? -1 : 1;
      const da = { x: Math.sin(pair.a.angle) * sa, z: Math.cos(pair.a.angle) * sa }, db = { x: Math.sin(pair.b.angle) * sb, z: Math.cos(pair.b.angle) * sb };
      const fa = { x: pair.a.x + da.x * pair.a.length / 2, z: pair.a.z + da.z * pair.a.length / 2 };
      const fb = { x: pair.b.x + db.x * pair.b.length / 2, z: pair.b.z + db.z * pair.b.length / 2 };
      const from = { x: fa.x + da.x * t.lead, z: fa.z + da.z * t.lead, tx: da.x, tz: da.z };
      const to = { x: fb.x + db.x * t.lead, z: fb.z + db.z * t.lead, tx: -db.x, tz: -db.z };
      const aligned = alignCorridor([from, to], from, to); if (aligned.minR < 14) return finish('central approach curve');
      t.way = [...aligned.way, { ...fb, tx: -db.x, tz: -db.z }]; t.minR = aligned.minR;
      t.exclude = new Set([...(hub?.rail?.edges ?? []), ...(hubB?.rail?.edges ?? [])]);
      t.profile = newProfileCursor([{ ...fa, tx: da.x, tz: da.z }, ...t.way], t.tracks, pair.a.y, pair.b.y, 'rail', t.exclude,
        false, undefined, t.type, 256, (.035 / TRACK_TYPES.standard.maxGrade) * (pair.a.level === 'underground' || pair.b.level === 'underground' ? .95 : .85));
      t.phase = 'profile';
    }
    if (t.phase === 'profile') {
      const r = planningStep('terrain fit', () => stepProfileCursor(g, t.profile!)); if (!r.done) return { done: false, value: undefined };
      if (!r.value) return finish('central clearance');
      t.prof = r.value; t.profile = null; t.conflict = newConflictCursor(r.value, 'rail', t.tracks, t.exclude, 40, true); t.phase = 'conflict';
    }
    if (t.phase === 'conflict') {
      const r = planningStep('conflicts', () => stepConflictCursor(g, t.conflict!)); if (!r.done) return { done: false, value: undefined };
      if (r.value) return finish('central clearance');
      return finish({ way: t.way, prof: t.prof!, minR: t.minR, expanded: 0 });
    }
  }
}
