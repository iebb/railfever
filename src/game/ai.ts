// AI competitors: companies that plan and build bus networks, tram lines and intercity railways using the same
// construction API as the player (findSnap / planEdge / commitProposal, stations, depots, lines, vehicles).
// Each company has a configuration (activeness, focus, risk, track access policy and multiplier); it may run
// trains on other companies' railways under a track access agreement, and buy struggling rivals.
import type { Game, AccessPolicy } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import { planStationUpgrade, commitStationUpgrade, relocateStation, railModeOf, railPartMode, stationLayout, CITY_WALK_SCALE, STATION_UPKEEP_FACTOR } from './stations';
import { defaultStationStyle } from './station-styles';
import { finishDoubleTrack, DoublePlan, DoubleEnd, DoubleResult, FinishOpts, Step } from './trackops';
import { electrify, UNDERGROUND_DEPOT } from './build-ops';
import * as Signals from './signals';
import * as Trackops from './trackops';
import type { NEdge, Section } from './network';
import type { Line } from './lines';
import { linearStops, outAndBack } from './lines';
import { WATER_Y, TRACK_TYPES, UNIT_M, RAIL, PSTEP, NetKind, URBAN_PAYBACK, URBAN_DEMAND, ELECTRIFY, discountedPayback, trackTypeOf } from './constants';
import { distToRect } from './world';
import { planEdge, commitProposal, findSnap, BuildOptions, Snap, Proposal, fitCurve, structureFactor, curveSpeed, SHARED_TRACK } from './construction';
import { Train, depotReaches, depotServes, consistRule, findRailRoute, railNext, lineCongestion, lineCompatibility, platformDepartureFrontiers } from './train';
import { RoadVehicle, roadDepotReaches } from './roadvehicle';
import { RNG } from './rng';
import { Economy } from './economy';
import { availableModels, VehicleModel, MODEL_BY_ID, carriesMail } from './vehicle-types';
import { estimateLegFare, estimateLegTime } from './fares';
import { type ForecastSite } from './demand';
import { walkSitePop, walkLimit, planWalkingCatchment, walkingCatchment, walkingPopulation, pointWalkingCatchment, pedestrianRoad, stopSiteWalkingCatchment } from './catchment';
import { suggestExpress, addPattern, setVehiclePattern, canonicalizeLines } from './patterns';
import * as Patterns from './patterns';
import { platformPreference, platformChoices } from './rail-platforms';
import { estimateVehicleYear, trackBasePerUnit, YEAR_S } from './opcosts';
import { endTangent, bezFromTangents, bezMinRadius, bezPoint, arcTable, tAtS } from './geom';
import { DRY_MIN, TUNNEL_LINING, applyEarthworks } from './terraform';
import { TramPlanner } from './ai-tram';
import { networkDaily, scheduleNetworkTask, networkOptions, XLINK_REACH } from './ai-network';
import { planSubwayYard, buildSubwayYard, surfaceDemolition, subwayCostPerUnit, type SubwayYardPlan } from './subway';
import { RailPolicy } from './ai-rail';
import { MailPolicy, projectMail, keepMailVans, mailVanLength } from './ai-mail';
import { offloadMail } from './mail';
import { DoubleJob, newDoubleJob, doubleJobStep, lineIsDouble, congestionReturn, upgradeRoute } from './dualtrack';
// capacity-integration: shared fleet agreement and a single upgrade adapter for the track-rights branch.
import { usesSharedRail, sharedCapacityPlan, sharedTrainAllowed, marginalSharedConsist, priceSharedProject } from './ai-capacity';
import { relieveSharedCapacity, sharedCapacityWork } from './ai-capacity-works';
import { initialSecondTrackCost, initialTrackChoice, initialTrackFinancing, layInitialDoubleTrack, openingThroatBaseline, openingThroatReturn, openingSignalPlan, openingFundingBaseline, openingFundingAppraisal } from './ai-initial-track';
import { urbanTrunks } from './ai-urban';
import {
  OPoint, P2, ChainProfile, ChainResult, SiteOpts, RoutePlan, biarcJunction, corridorFree, sitePop, trackClassOf, alignCorridor, routeConflictAt, chainProfile, chainProfileGen, routeConflictGen, routeGen, routeCurveSpeed, estimateChainCost, stationEnds, corridorOverlap, routeAlongside, planningProbe,
  buildRailDepot, buildDepotOnLine, removeEdges, nodeSnap, nodeAt, nodeTangent, sidingType, depotAtEnd, depotFits, leadsMeet,
} from './routing';

export * from './routing';

// Corridor expansions are independent of the slice size; keep terrain probes in short batches too.
const AI_ROUTE_WORK = 1024;
/** Present value of a year's surplus over the civil investment horizon, at the company's borrowing rate. */
const urbanPayback = (mode: 'metro' | 'lightrail', rate: number) => discountedPayback(URBAN_PAYBACK[mode], rate);
const AI_SITE_WORK = 64;

/** A paid opening train starts at a served call its actual depot/consist can reach and leave lawfully. */
export function openingRailCall(g: Game, t: Train, preferredStation = -1): number {
  const l = t.line, dp = g.depots.get(t.depotId), stub = dp && g.world.net.edges.get(dp.edge);
  if (!l || !dp || !stub || dp.kind !== 'rail' || stub.kind !== 'rail' || dp.owner !== t.owner
    || g.lines.operateError(l, t.owner)) return -1;
  const pattern = Patterns.patternOf(l, t.pattern)?.id ?? l.patterns?.[0]?.id ?? 0, indices = Patterns.patternStops(l, pattern);
  // The next-hop route alone cannot prove a later foreign call fits the same actual fleet/pattern.
  // Native platform choices prove lawful incoming/outgoing full-fit paths at every served occurrence.
  if (indices.some(index => !platformChoices(g, l, pattern, index).length)) return -1;
  indices.sort((a, b) => Number(l.stops[b] === preferredStation) - Number(l.stops[a] === preferredStation) || a - b);
  for (const index of indices) {
    const saved = platformPreference(l, t.pattern, index), onward = l.stops[Patterns.nextStopIndex(l, t.pattern, index)];
    if (findRailRoute(g, [{ edge: stub, dir: 1 }], l.stops[index], t.owner, t.id, 60000, false, t.rule, false,
      { preferred: saved?.group, manual: saved?.manual, length: t.length, onward })) return index;
  }
  return -1;
}
// At eight units/day this leaves six days of the 60-day planning target for choosing a project.
const AI_RAIL_PLAN_UNITS = 432;
/**
 * City railways (citycatch): in-city stops walk half as far (stations.ts CITY_WALK_SCALE), so between the end
 * stations they may stand this many of their walking reaches apart (walkLimit('rail') x CITY_WALK_SCALE), never closer
 * than their platforms and a short block of track allow; the end gaps keep the crossovers' throat. urbanStep weighs
 * that against the wider spacing; an opening stage keeps the stop count capital allows (more stops would only make
 * it unaffordable: extensions follow retained profit).
 */
const CITY_SPACING = { metro: 1.35, lightrail: 1.2 };
/** Street entrances an in-city stop below or above the street asks for (both platform ends and both sides; planRail). */
const CITY_ENTRANCES = 4;
/**
 * A served rail station of the town (of any line, ours or one we may use) within this distance of a city railway's
 * axis is offered as an interchange: one alignment stops right beside or under it (citycatch). The forecast (its
 * transfers and its shared walkers) and the costs decide between that alignment and the one ignoring it.
 */
const CITY_ANCHOR_SIDE = 12;

interface AISiteEvaluation { plan: StationPlan | null; caught?: number }
const aiSiteMemo = new WeakMap<Game, { version: string; sites: Map<string, AISiteEvaluation>; pop: Map<string, number> }>();
function aiSites(g: Game) {
  const w = g.world;
  const version = `${w.net.version}:${w.heightsVersion}:${w.lotVersions.version}:${g.stations.walkVersion}:${g.lines.version}:${g.networkVersion}:${g.depots.nextId}`;
  let c = aiSiteMemo.get(g);
  if (!c || c.version !== version) {
    c = { version, sites: new Map(), pop: new Map() }; aiSiteMemo.set(g, c);
  }
  return c;
}

/** The exact ground-platform terrain rejection in planRail, before its building/access-road searches. */
function aiSiteTerrain(g: Game, x: number, z: number, fx: number, fz: number, length: number, width: number): boolean {
  let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
  for (let a = -0.5; a <= 0.5; a += 0.125) for (let b = -0.5; b <= 0.5; b += 0.25) {
    const px = x + fx * length * a + fz * width * b, pz = z + fz * length * a - fx * width * b;
    if (!g.world.inside(px, pz, 2)) return false;
    const h = g.world.heightAt(px, pz);
    if (h < 0.1) return false;
    sum += h; cnt++; mn = Math.min(mn, h); mx = Math.max(mx, h);
    if (mx - mn > 3) return false;
  }
  return Math.max(0.3, sum / cnt) - 0.1 >= DRY_MIN - 0.005;
}

/** Dense streets and long country roads make the station's forecourt search heavier. Charge by geometry,
 * never measured time, so those plans get a unit of their own on every machine and with warm caches. */
function aiSiteEffort(g: Game, x: number, z: number, length: number): number {
  const r = length / 2 + 40;
  let roads = 0;
  for (const e of g.world.net.edgesNear(x - r, z - r, x + r, z + r)) {
    if (e.kind !== 'road' || e.depot >= 0) continue;
    roads += e.len;
    if (roads >= 200) return 2;
  }
  return 1;
}

/** AI variants of the routing jobs: identical choices, with pauses inside segment retries and site scoring. */
function aiTerrRef(g: Game, x: number, z: number, tx: number, tz: number, tracks: number): number {
  const w = g.world;
  let h = w.heightAt(x, z);
  if (tracks > 1) {
    const o = ((tracks - 1) / 2) * RAIL.spacing;
    h = Math.max(h, w.heightAt(x - tz * o, z + tx * o), w.heightAt(x + tz * o, z - tx * o));
  }
  return h;
}

function aiProfileAt(prof: ChainProfile, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < prof.x.length; i++) { const d = (prof.x[i] - x) ** 2 + (prof.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return prof.y[best];
}

function* aiBuildSegment(g: Game, start: Snap, end: Snap, opts: BuildOptions, endY: number | null, res: ChainResult, log?: (s: string) => void): Generator<void, Proposal | null> {
  const tries: Partial<BuildOptions>[] = (opts.designSpeed ?? (opts.type === 'highspeed' ? 180 : 0)) > 160 ? [{}, { crossing: 'over' }, { crossing: 'under' }] : [{}, { crossing: 'level' }, { crossing: 'over' }, { crossing: 'under' }];
  let last: Proposal | null = null;
  const cl = Math.hypot(end.x - start.x, end.z - start.z) || 1;
  let firstErr = '';
  for (const useH of endY !== null ? (opts.designSpeed ?? (opts.type === 'highspeed' ? 180 : 0)) > 160 ? [true] : [true, false] : [false]) {
    if (!useH && endY !== null && last) firstErr = last.errors.join(', ') + ` (crossings ${last.crossings.map((c) => c.mode).join('/')})`;
    for (const t of tries) {
      const o: BuildOptions = { ...opts, ...t };
      if (useH && endY !== null && end.kind === 'free') {
        const tr = aiTerrRef(g, end.x, end.z, (end.x - start.x) / cl, (end.z - start.z) / cl, start.group && start.group.length > 1 ? start.group.length : opts.tracks);
        o.heightOffset = endY - tr;
        if (Math.abs(o.heightOffset) < 1e-3) o.heightOffset = 1e-3;
      } else o.heightOffset = 0;
      const p = planEdge(g, start, end, o);
      last = p;
      yield;
      if (!p.ok) continue;
      if (p.warnings.includes('Not enough money')) { res.error = 'Not enough money'; return null; }
      const err = commitProposal(g, p);
      if (err) { res.error = err; return null; }
      if (firstErr) (res.notes ??= []).push(`end height relaxed: ${firstErr}`);
      res.cost += p.cost;
      res.edges += p.tracks.length;
      res.bridges += p.stats.bridges;
      res.tunnels += p.stats.tunnels;
      res.built += p.stats.len;
      return p;
    }
  }
  res.error = last ? last.errors.join(', ') : 'Cannot build';
  if (last && log) {
    const net = g.world.net;
    const sn = start.kind === 'node' ? net.nodes.get(start.node!) : undefined;
    log(`segment failed: ${res.error} (start y ${sn?.y.toFixed(2)}, end y ${endY?.toFixed(2)}, crossings ${last.crossings.map((c) => { const e = net.edges.get(c.edge)!; return `${c.mode}@${c.sNew.toFixed(1)}/${last!.tracks[c.track].len.toFixed(1)} ${e.kind}${e.owner} #${e.id} y${net.heightAtS(e, c.sOld).toFixed(2)} ${net.sectionAt(e, c.sOld)}`; }).join(', ')})`);
  }
  return null;
}

function aiGroupCentre(g: Game, nodeId: number, kind: NetKind, tracks: number): P2 {
  const n = g.world.net.nodes.get(nodeId)!;
  if (kind !== 'rail' || tracks < 2) return { x: n.x, z: n.z };
  const grp = nodeSnap(g, nodeId, kind).group ?? [nodeId];
  if (grp.length < 2) return { x: n.x, z: n.z };
  const N = Math.min(tracks, grp.length);
  const idx = Math.max(0, grp.indexOf(nodeId));
  const lo = Math.max(0, Math.min(grp.length - N, idx - Math.floor((N - 1) / 2)));
  let x = 0, z = 0;
  for (const id of grp.slice(lo, lo + N)) { const m = g.world.net.nodes.get(id)!; x += m.x; z += m.z; }
  return { x: x / N, z: z / N };
}

function* aiChainGen(g: Game, startNode: number, way: OPoint[], opts: BuildOptions, goalNode: number | null, prof: ChainProfile | null, log?: (s: string) => void): Generator<void, ChainResult> {
  const net = g.world.net;
  const res: ChainResult = { ok: false, cost: 0, endNode: startNode, edges: 0, bridges: 0, tunnels: 0, built: 0 };
  let cur = startNode;
  /** Build one arc from the current node to q (free point or the goal node); updates `cur`. */
  const step = function* (q: P2, goal: boolean, allowSplit: boolean): Generator<void, boolean> {
    const st = nodeSnap(g, cur, opts.kind);
    const en: Snap = goal ? nodeSnap(g, goalNode!, opts.kind) : { kind: 'free', x: q.x, z: q.z, y: g.world.heightAt(q.x, q.z) };
    const endY = goal || !prof ? null : aiProfileAt(prof, q.x, q.z);
    const before = res.error;
    const p = yield* aiBuildSegment(g, st, en, opts, endY, res, allowSplit && !goal ? undefined : log);
    if (p) {
      if (goal) { cur = goalNode!; return true; }
      // the new end node (one member of the group for multi-track)
      const tp = p.tracks[Math.floor((p.tracks.length - 1) / 2)];
      const nn = nodeAt(g, opts.kind, tp.bez.x3, tp.bez.z3);
      if (!nn) { res.error = 'End node missing'; return false; }
      cur = nn.id;
      return true;
    }
    if (!allowSplit || goal || res.error === 'Not enough money') return false;
    // split the arc at its middle and try both halves
    const c = aiGroupCentre(g, cur, opts.kind, opts.tracks);
    const t = nodeTangent(g, cur, q);
    const L = Math.hypot(q.x - c.x, q.z - c.z);
    if (L < 4) return false;
    const ux = (q.x - c.x) / L, uz = (q.z - c.z) / L;
    const dp = t.tx * ux + t.tz * uz;
    const tq = { tx: 2 * dp * ux - t.tx, tz: 2 * dp * uz - t.tz };
    const m = biarcJunction({ x: c.x, z: c.z, ...t }, { x: q.x, z: q.z, ...tq });
    res.error = before;
    if (!m) return false;
    return (yield* step(m, false, false)) && (yield* step(q, false, false));
  };
  /**
   * A segment end on (or right next to) a crossing would sit on the crossed edge: end it a little
   * earlier, moving back along the planned route (so curves keep their radius).
   */
  const clearOfCrossings = (q: P2, from: P2): P2 => {
    if (!prof || !prof.crossings.length) return q;
    const near = (p: P2) => prof!.crossings.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 1.8);
    if (!near(q)) return q;
    let k = 0, bd = Infinity;
    for (let i = 0; i < prof.x.length; i++) { const d = (prof.x[i] - q.x) ** 2 + (prof.z[i] - q.z) ** 2; if (d < bd) { bd = d; k = i; } }
    for (let i = k - 1; i > 0; i--) {
      const p = { x: prof.x[i], z: prof.z[i] };
      if (Math.hypot(p.x - from.x, p.z - from.z) < 3) break;
      if (prof.s[k] - prof.s[i] >= 2.2 && !near(p)) return p;
    }
    return q;
  };
  const yEnd = prof ? prof.y[prof.y.length - 1] : 0;
  // Keep the short tangent transitions that were radius-checked during route planning.
  const minLeg = 1.2;
  for (let i = 0; i < way.length; i++) {
    const n = net.nodes.get(cur);
    if (!n) { res.error = 'Lost the chain'; return res; }
    const wp = way[i];
    const isGoal = i === way.length - 1 && goalNode !== null;
    const c = aiGroupCentre(g, cur, opts.kind, opts.tracks);
    const t0 = nodeTangent(g, cur, wp);
    const a: OPoint = { x: c.x, z: c.z, tx: t0.tx, tz: t0.tz };
    // the last segment ended off the planned heights: re-plan the rest of the profile from here
    if (prof && i > 0 && Math.abs(n.y - aiProfileAt(prof, c.x, c.z)) > 0.12) {
      const ex = new Set<number>(n.edges);
      if (goalNode !== null) for (const id of nodeSnap(g, goalNode, opts.kind).group ?? [goalNode]) for (const e of net.nodes.get(id)?.edges ?? []) ex.add(e);
      for (const id of nodeSnap(g, cur, opts.kind).group ?? [cur]) for (const e of net.nodes.get(id)?.edges ?? []) ex.add(e);
      yield;
      const np = yield* chainProfileGen(g, [a, ...way.slice(i)], opts.tracks, n.y, yEnd, opts.kind, ex, false, undefined, opts.type, 256, opts.designGrade ? opts.designGrade / (TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).maxGrade * 0.85 : 0.85, (opts.designSpeed ?? (opts.type === 'highspeed' ? 180 : 0)) > 160);
      if (!np) { res.error = 'Too steep: the route left its planned heights'; log?.(`re-plan of heights failed at waypoint ${i}`); return res; }
      prof = np;
    }
    const L = Math.hypot(wp.x - a.x, wp.z - a.z);
    if (L < minLeg && !isGoal) continue;
    const ux = (wp.x - a.x) / L, uz = (wp.z - a.z) / L;
    const straight = a.tx * ux + a.tz * uz > 0.9995 && wp.tx * ux + wp.tz * uz > 0.9995;
    const pts: { p: P2; goal: boolean }[] = [];
    if (!straight) {
      const j = biarcJunction(a, wp);
      if (j && Math.hypot(j.x - a.x, j.z - a.z) > minLeg && Math.hypot(wp.x - j.x, wp.z - j.z) > minLeg) pts.push({ p: j, goal: false });
    }
    pts.push({ p: wp, goal: isGoal });
    for (const q of pts) {
      if (!(yield* step(q.goal ? q.p : clearOfCrossings(q.p, net.nodes.get(cur) ?? q.p), q.goal, true))) return res;
      yield;
    }
  }
  res.ok = true;
  res.endNode = cur;
  return res;
}

/** An access street must end on land. A new bridge dead end is removed by network maintenance and cannot
 * support a station forecourt; an existing public bridge with through road access remains usable. */
function stationAccessSafe(plan: StationPlan): boolean {
  return plan.roadAccess && !plan.access?.tracks.some((t) => t.sections.some((s) => s.type === 'bridge'
    && (t.start.kind === 'free' && s.s0 <= 0.1 || t.end.kind === 'free' && s.s1 >= t.len - 0.1)));
}

function* aiStationSiteGen(g: Game, town: Town, toward: P2, o: SiteOpts): Generator<void, StationPlan | null> {
  const dirA = Math.atan2(toward.x - town.x, toward.z - town.z);
  const front = o.front ?? 16, back = o.back ?? 9;
  let best: StationPlan | null = null, bestScore = Infinity;
  const maxR = o.maxR ?? town.radius + 14;
  let n = 0, plans = 0, bestR = Infinity;
  const width = stationLayout(o.tracks).width;
  for (let r = 4; r <= maxR; r += 3) {
    if (o.quick && o.prefY === undefined && r > bestR + 9) break;
    for (const da of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2]) {
      const pa = dirA + da;
      const x = town.x + Math.sin(pa) * r, z = town.z + Math.cos(pa) * r;
      if (!g.world.inside(x, z, 8)) continue;
      // the platform axis should point at the target from where the station actually is
      const dirP = Math.atan2(toward.x - x, toward.z - z);
      for (const aa of [0, 0.15, -0.15, 0.35, -0.35]) {
        // short steps: a pause after a few plans (quick rejections count little)
        if ((n += 1) >= AI_SITE_WORK) { n = 0; plans = 0; yield; }
        const ang = dirA + aa;
        const off = Math.abs(Math.atan2(Math.sin(ang - dirP), Math.cos(ang - dirP)));
        if (off > 0.75) continue;
        const fx = Math.sin(ang), fz = Math.cos(ang);
        if (!aiSiteTerrain(g, x, z, fx, fz, o.length, width)) continue;
        // cheap rejections before the full plan: a street or track across the platform, a blocked throat
        let blocked = false;
        for (const t of [-0.5, -0.25, 0, 0.25, 0.5]) if (g.world.net.nearestEdge(x + fx * o.length * t, z + fz * o.length * t, 1.1)) { blocked = true; break; }
        // (half the station's width at least: platforms between the tracks)
        if (blocked || !corridorFree(g, x, z, fx, fz, o.length / 2 + 0.5, o.length / 2 + front, 0.5 + 0.25 * (o.tracks - 1))) continue;
        // the caller's condition on the site first (planning the station is costly)
        if (o.accept && !o.accept({ x, z, angle: ang, length: o.length } as StationPlan)) continue;
        // Charge the same work on a hit: a loaded game has cold derived caches but identical ticks.
        const effort = aiSiteEffort(g, x, z, o.length);
        if (plans + effort > 2) { n = 0; plans = 0; yield; }
        const cache = aiSites(g), key = `${x}:${z}:${ang}:${o.length}:${o.tracks}:${o.owner}`;
        let evaluation = cache.sites.get(key);
        if (!evaluation) {
          const plan = g.stations.planRail(x, z, ang, o.length, o.tracks, o.owner);
          // Rejected previews often contain a full access proposal. Retain just the rejection; keep the
          // useful-site cache bounded so profiling does not trade cheap re-evaluations for GC pauses.
          evaluation = { plan: plan.ok && !plan.join && stationAccessSafe(plan) ? plan : null };
          if (cache.sites.size >= 256) cache.sites.clear();
          cache.sites.set(key, evaluation);
        }
        const plan = evaluation.plan;
        n += 8;
        plans += effort;
        if (plans >= 2 || n >= AI_SITE_WORK) { n = 0; plans = 0; yield; }
        if (!plan) continue;
        const hw = plan.layout.width / 2;
        if (!corridorFree(g, x, z, fx, fz, o.length / 2 + 0.5, o.length / 2 + front, hw)) continue;
        if (o.accept && !o.accept(plan)) continue;
        const backFree = corridorFree(g, x, z, -fx, -fz, o.length / 2 + 0.5, o.length / 2 + back, 0.6);
        // beyond the lead the line should not have to run alongside a road or track
        let alongside = 0;
        for (let t = o.length / 2 + front; t <= o.length / 2 + front + 14; t += 2) {
          const ne = g.world.net.nearestEdge(x + fx * t, z + fz * t, 3);
          if (!ne) continue;
          const d = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0 };
          g.world.net.pointAt(ne.edge, ne.s, q, d);
          if (Math.abs(d.x * fx + d.z * fz) / (Math.hypot(d.x, d.z) || 1) > 0.8) alongside++;
        }
        // Site population does not depend on platform angle. Cache it across the five orientations.
        // people in the station's catchment (the access road comes with it), those within a short walk of the
        // platforms counting double (central sites on the levelled town ground connect best)
        planningProbe.observe?.('station catchment', true);
        // Revalidate the memo after a yield/network edit; the chosen site is always replanned before commit.
        const scoreCache = aiSites(g), pointKey = `${x}:${z}`;
        const caught = evaluation.caught !== undefined && scoreCache === cache ? evaluation.caught : walkingPopulation(g, planWalkingCatchment(g, plan));
        if (scoreCache === cache) evaluation.caught = caught;
        planningProbe.observe?.('station catchment', false);
        planningProbe.observe?.('walkSitePop', true);
        let pointPop = scoreCache.pop.get(pointKey);
        if (pointPop === undefined) { pointPop = walkSitePop(g, x, z, 'mainline'); scoreCache.pop.set(pointKey, pointPop); }
        const pop = caught + pointPop * 0.25;
        planningProbe.observe?.('walkSitePop', false);
        // A covered resident's recurring trips matter more than a small saving on a remote station site.
        let score = plan.cost / 20000 + plan.demolish.length * 6 - pop / 8 + Math.abs(aa) * 20 + off * 25 + (backFree ? 0 : 40) + r * 0.3 + alongside * 12;
        if (o.prefY !== undefined) score += Math.max(0, Math.abs(plan.y - o.prefY) - (o.tolY ?? 1)) * 60;
        if (score < bestScore) { bestScore = score; best = plan; bestR = r; }
        if ((n += 8) >= AI_SITE_WORK) { n = 0; plans = 0; yield; }
      }
    }
  }
  return best;
}

function* aiRailPairGen(g: Game, A: Town, B: Town, o: SiteOpts, detour = 1.15): Generator<void, { a: StationPlan; b: StationPlan } | null> {
  const grade = 0.035 * 0.8; // Main-line trains choose gentle grades within the common track's limit.
  const lead = (o.front ?? 16) - 2;
  const heights = (p: StationPlan, q: StationPlan) => Math.abs(p.y - q.y) <= grade * Math.hypot(p.x - q.x, p.z - q.z) * detour;
  const minPop = (t: Town) => Math.min(t.pop * 0.3, 400);
  const d = Math.hypot(A.x - B.x, A.z - B.z);
  const aligned = (p: StationPlan, q: StationPlan) => { const a = Math.atan2(q.x - p.x, q.z - p.z) - p.angle, off = Math.abs(Math.atan2(Math.sin(a), Math.cos(a))); return Math.min(off, Math.PI - off) <= 0.3; };
  // B's platforms face A's station so that the two leads line up; then A's are aligned with B's
  const pa = yield* aiStationSiteGen(g, A, B, o);
  if (pa) {
    const pb = yield* aiStationSiteGen(g, B, pa, { ...o, accept: (q) => leadsMeet(pa, q, lead) });
    if (pb) {
      if (!aligned(pa, pb)) {
        const pa2 = yield* aiStationSiteGen(g, A, pb, { ...o, accept: (q) => leadsMeet(q, pb, lead) });
        if (pa2 && heights(pa2, pb)) return { a: pa2, b: pb };
      }
      if (heights(pa, pb)) return { a: pa, b: pb };
      // height-matched sites on either side, keeping a useful catchment
      const pb2 = yield* aiStationSiteGen(g, B, pa, { ...o, prefY: pa.y, tolY: grade * d * 0.9, accept: (q) => leadsMeet(pa, q, lead) });
      if (pb2 && heights(pa, pb2) && sitePop(g, pb2.x, pb2.z, o.length, pb2.angle) >= minPop(B)) return { a: pa, b: pb2 };
      const pa3 = yield* aiStationSiteGen(g, A, pb, { ...o, prefY: pb.y, tolY: grade * d * 0.9, accept: (q) => leadsMeet(q, pb, lead) });
      if (pa3 && heights(pa3, pb) && sitePop(g, pa3.x, pa3.z, o.length, pa3.angle) >= minPop(A)) return { a: pa3, b: pb };
    }
  }
  // the other way round: B's best site first, then an A site whose lead meets it
  const qb = yield* aiStationSiteGen(g, B, A, o);
  if (!qb) return null;
  const qa = yield* aiStationSiteGen(g, A, qb, { ...o, accept: (q) => leadsMeet(q, qb, lead) });
  if (qa && heights(qa, qb)) return { a: qa, b: qb };
  const qa2 = yield* aiStationSiteGen(g, A, qb, { ...o, prefY: qb.y, tolY: grade * d * 0.9, accept: (q) => leadsMeet(q, qb, lead) });
  if (qa2 && heights(qa2, qb) && sitePop(g, qa2.x, qa2.z, o.length, qa2.angle) >= minPop(A)) return { a: qa2, b: qb };
  return null;
}


/** The double-track preview algorithm, sliced per turnout candidate and per planEdge call. */
interface aiDoubleSample { u: number; x: number; z: number; y: number; tx: number; tz: number; edge: number; s: number }

const aiDoubleRailOpts = (owner: number, extra: Partial<BuildOptions> = {}): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra });
/** Track type of a chain of track (its first edge's; standard if unknown). */
const aiDoubleLineType = (g: Game, steps: Step[]): string => (steps.length ? g.world.net.edges.get(steps[0].edge)?.type : undefined) ?? 'standard';

/** Length of a turnout from one track to a parallel one at the standard spacing. */
const aiDoubleTURNOUT = 8;
/** Longest segment of a new parallel track (keeps it at the old track's heights). */
const aiDoubleSEG = 8;

// ------------------------------------------------------------------ track helpers

/** Samples (about every 0.25-0.5 units) along a track: position, height, unit tangent in travel direction. */
function aiDoubleSampleSteps(g: Game, steps: Step[]): aiDoubleSample[] {
  const net = g.world.net;
  const out: aiDoubleSample[] = [];
  let u = 0;
  for (const st of steps) {
    const e = net.edges.get(st.edge);
    if (!e) continue;
    const geo = net.geo(e);
    for (let k = 0; k < geo.n; k++) {
      const i = st.dir > 0 ? k : geo.n - 1 - k;
      if (out.length && k === 0) continue;
      const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
      if (out.length) { const p = out[out.length - 1]; u += Math.hypot(x - p.x, z - p.z); }
      out.push({ u, x, z, y: geo.pts[i * 3 + 1], tx: geo.tan[i * 2] * st.dir, tz: geo.tan[i * 2 + 1] * st.dir, edge: e.id, s: geo.cum[i] });
    }
  }
  return out;
}

/** Interpolated sample at distance u along a sampled track. */
function aiDoubleSampleAt(S: aiDoubleSample[], u: number): aiDoubleSample {
  if (u <= S[0].u) return S[0];
  if (u >= S[S.length - 1].u) return S[S.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].u <= u) lo = m; else hi = m; }
  const a = S[lo], b = S[hi], f = (u - a.u) / Math.max(1e-9, b.u - a.u);
  const tx = a.tx + (b.tx - a.tx) * f, tz = a.tz + (b.tz - a.tz) * f, tl = Math.hypot(tx, tz) || 1;
  const same = a.edge === b.edge;
  return { u, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, y: a.y + (b.y - a.y) * f, tx: tx / tl, tz: tz / tl, edge: same || f < 0.5 ? a.edge : b.edge, s: same ? a.s + (b.s - a.s) * f : f < 0.5 ? a.s : b.s };
}

/** Nearest sample of a track to a point (index and distance). */
function aiDoubleNearestSample(S: aiDoubleSample[], x: number, z: number): { i: number; d: number } {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < S.length; i++) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { i: bi, d: Math.sqrt(bd) };
}

/** Continue a track from edge e (travelled in direction d) through edges of `set`, the straightest way. */
function aiDoubleExtend(g: Game, e: NEdge, d: number, set: Set<number>, exclude: Set<number>, visited: Set<number>): Step[] {
  const net = g.world.net;
  const out: Step[] = [];
  let cur = e, cd = d;
  for (let guard = 0; guard < 10000; guard++) {
    const conts = net.nextRail(cur, cd).filter((c) => set.has(c.edge.id) && !exclude.has(c.edge.id) && !visited.has(c.edge.id));
    if (!conts.length) break;
    const geo = net.geo(cur), i = cd > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * cd, tz = geo.tan[i * 2 + 1] * cd;
    let best = conts[0], bd = -Infinity;
    for (const c of conts) {
      const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz;
      if (dot > bd) { bd = dot; best = c; }
    }
    out.push({ edge: best.edge.id, dir: best.dir });
    visited.add(best.edge.id);
    cur = best.edge; cd = best.dir;
  }
  return out;
}

/** The track through `seed` within `set` (both ways), in seed's +s direction. */
function aiDoubleWalkTrack(g: Game, seed: NEdge, set: Set<number>, exclude: Set<number> = new Set()): Step[] {
  const visited = new Set<number>([seed.id]);
  const fwd = aiDoubleExtend(g, seed, 1, set, exclude, visited);
  const bwd = aiDoubleExtend(g, seed, -1, set, exclude, visited);
  return [...bwd.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })), { edge: seed.id, dir: 1 }, ...fwd];
}

const aiDoubleStartNode = (g: Game, s: Step) => { const e = g.world.net.edges.get(s.edge)!; return s.dir > 0 ? e.a : e.b; };
const aiDoubleEndNode = (g: Game, s: Step) => { const e = g.world.net.edges.get(s.edge)!; return s.dir > 0 ? e.b : e.a; };

const aiDoubleNodeSnapOf = (g: Game, id: number): Snap => { const n = g.world.net.nodes.get(id)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; };

interface aiDoubleSPt { x: number; z: number; y: number; tx: number; tz: number; edge?: number; s?: number; node?: number }

/** Price of the two turnouts of a connection (plus its track). */
const aiDoubleTURNOUT_COST = 15000;

function aiDoubleConnectS(g: Game, owner: number, a: aiDoubleSPt, b: aiDoubleSPt, tracks: Set<number>, dry: boolean, type?: string): { error: string | null; cost: number } {
  const net = g.world.net, w = g.world;
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  if (L < 2) return { error: 'too short', cost: 0 };
  // the wire state of what it connects (plain track first)
  const typeAt = (q: aiDoubleSPt): string | undefined => {
    if (q.edge !== undefined) return net.edges.get(q.edge)?.type;
    const n = q.node !== undefined ? net.nodes.get(q.node) : undefined;
    const es = (n?.edges ?? []).map((id) => net.edges.get(id)!).filter(Boolean);
    return (es.find((e) => TRACK_TYPES[e.type]?.electrified) ?? es.find((e) => e.station < 0 && e.depot < 0) ?? es[0])?.type;
  };
  const ttype = [type, typeAt(a), typeAt(b)].some((t) => t && TRACK_TYPES[t]?.electrified) ? 'electric' : type ?? typeAt(b) ?? typeAt(a) ?? 'standard';
  const tt = TRACK_TYPES[ttype] ?? TRACK_TYPES.standard;
  const sa = a.tx * dx + a.tz * dz >= 0 ? 1 : -1, sb = b.tx * dx + b.tz * dz >= 0 ? 1 : -1;
  const bez = bezFromTangents(a.x, a.z, a.tx * sa, a.tz * sa, b.x, b.z, b.tx * sb, b.tz * sb, L * 0.38, L * 0.38);
  if (bezMinRadius(bez, 32) < tt.minRadius) return { error: 'curve too tight', cost: 0 };
  if (Math.abs(b.y - a.y) > tt.maxGrade * L + 0.02) return { error: 'too steep', cost: 0 };
  const p = { x: 0, z: 0 }, p2 = { x: 0, z: 0 }, dq = { x: 0, y: 0, z: 0 }, pq = { x: 0, y: 0, z: 0 };
  for (let i = 2; i <= 14; i++) {
    bezPoint(bez, i / 16, p);
    bezPoint(bez, (i + 0.5) / 16, p2);
    const tl = Math.hypot(p2.x - p.x, p2.z - p.z) || 1, ctx = (p2.x - p.x) / tl, ctz = (p2.z - p.z) / tl;
    for (const e of net.edgesNear(p.x - 1, p.z - 1, p.x + 1, p.z + 1)) {
      if (tracks.has(e.id)) continue;
      if (a.node !== undefined && (e.a === a.node || e.b === a.node)) continue;
      if (b.node !== undefined && (e.a === b.node || e.b === b.node)) continue;
      const ne = net.nearestEdge(p.x, p.z, net.halfWidth(e) + 0.36, undefined, (q) => q.id === e.id);
      if (!ne) continue;
      // a track running alongside may be as close as the usual track spacing
      if (e.kind === 'rail') {
        net.pointAt(e, ne.s, pq, dq);
        const dl = Math.hypot(dq.x, dq.z) || 1;
        if (Math.abs((dq.x * ctx + dq.z * ctz) / dl) > 0.97 && Math.hypot(pq.x - p.x, pq.z - p.z) >= RAIL.spacing - 0.06) continue;
      }
      if (Math.abs(net.heightAtS(e, ne.s) - (a.y + (b.y - a.y) * (i / 16))) < RAIL.clearance) return { error: e.kind === 'rail' ? 'other track in the way' : 'road in the way', cost: 0 };
    }
  }
  for (const c of net.crossings.values()) if ((tracks.has(c.e1) || tracks.has(c.e2)) && Math.hypot(c.x - (a.x + b.x) / 2, c.z - (a.z + b.z) / 2) < L / 2 + 1.5) return { error: 'level crossing in the way', cost: 0 };
  // Nodes carry no section flag: inspect their incident parent rails too (station insertion lays node-to-node
  // fans). Determine the sections and their price before a dry run returns, so preview and commit agree.
  const secOf = (q: aiDoubleSPt): 'ground' | Section['type'] => {
    if (q.edge !== undefined) { const e = net.edges.get(q.edge); return e ? net.sectionAt(e, q.s ?? 0) : 'ground'; }
    const n = q.node !== undefined ? net.nodes.get(q.node) : undefined;
    const es = (n?.edges ?? []).map((id) => net.edges.get(id)!).filter((e) => e?.kind === 'rail');
    const at = (e: NEdge) => net.sectionAt(e, e.a === n!.id ? 0 : e.len);
    const e = es.find((e) => tracks.has(e.id) && at(e) !== 'ground') ?? es.find((e) => tracks.has(e.id)) ?? es[0];
    return e ? at(e) : 'ground';
  };
  const secA = secOf(a), secB = secOf(b);
  const inherited = secA === secB ? secA : secA === 'ground' ? secB : secB === 'ground' ? secA : 'ground';
  const tab = arcTable(bez), K = Math.max(1, Math.ceil(tab.len / 0.25));
  const sections: Section[] = [];
  let price = 2 * aiDoubleTURNOUT_COST;
  for (let i = 0; i < K; i++) {
    const s0 = tab.len * i / K, s1 = tab.len * (i + 1) / K, s = (s0 + s1) / 2;
    bezPoint(bez, tAtS(tab, s), p);
    const y = a.y + (b.y - a.y) * s / tab.len, terrain = w.heightAt(p.x, p.z), depth = terrain - y;
    // Even a legacy ground parent cannot make a deep connecting piece an open cutting. Low land requires a
    // bridge or a covered tunnel; a shallow formation below the water line cannot be built at this height.
    const sec = inherited !== 'ground' ? inherited : depth >= TUNNEL_LINING.rail + TUNNEL_LINING.cover ? 'tunnel' : y - terrain > 1.4 || terrain < DRY_MIN ? 'bridge' : 'ground';
    if (sec !== 'tunnel' && y - 0.1 < DRY_MIN - 0.005) return { error: 'Below water line: raise or tunnel', cost: 0 };
    if (sec === 'bridge' && depth > 0.2) return { error: 'Hill blocks bridge: use tunnel', cost: 0 };
    price += (s1 - s0) * tt.costPerUnit * (sec === 'ground' ? 1 : structureFactor('rail', sec, Math.abs(depth)));
    if (sec === 'ground') continue;
    const last = sections[sections.length - 1];
    if (last && last.type === sec && Math.abs(last.s1 - s0) < 0.001) last.s1 = s1;
    else sections.push({ s0, s1, type: sec });
  }
  const cost = Math.round(price);
  if (dry) return { error: null, cost };
  for (const q of [a, b]) if (q.edge !== undefined && g.vehicles.isEdgeBusy(q.edge)) return { error: 'train in the way', cost };
  const eco = g.company(owner).economy;
  if (!eco.canAfford(cost)) return { error: 'Not enough money', cost };
  const nodeOf = (q: aiDoubleSPt): number | null => {
    if (q.node !== undefined) return net.nodes.has(q.node) ? q.node : null;
    const e = net.edges.get(q.edge!);
    if (!e) return null;
    if (q.s! < 0.3 || q.s! > e.len - 0.3) return q.s! < 0.3 ? e.a : e.b;
    const r = net.splitEdge(e.id, q.s!);
    return r ? r.node.id : null;
  };
  const na = nodeOf(a);
  const nb = na === null ? null : nodeOf(b);
  if (na === null || nb === null) return { error: 'cannot split the track', cost };
  const A = net.nodes.get(na)!, B = net.nodes.get(nb)!;
  const curve = { ...bez, x0: A.x, z0: A.z, x3: B.x, z3: B.z }, len = arcTable(curve).len;
  const m = Math.max(2, Math.ceil(len / PSTEP) + 1);
  const prof = new Float32Array(m);
  for (let i = 0; i < m; i++) prof[i] = A.y + (B.y - A.y) * Math.min(i * PSTEP, len) / len;
  const e = net.addEdge('rail', na, nb, curve, prof, sections.map((s) => ({ ...s, s0: s.s0 * len / tab.len, s1: s.s1 * len / tab.len })), ttype, owner);
  applyEarthworks(w, [e]);
  for (let i = 0; i <= 8; i++) {
    const s = e.len * i / 8;
    if (net.sectionAt(e, s) !== 'ground') continue;
    bezPoint(curve, tAtS(net.table(e), s), p); w.removeTreesNear(p.x, p.z, 0.8);
  }
  eco.spend(cost, 'construction');
  g.onNetworkChanged();
  return { error: null, cost };
}

function aiDoubleChainOf(g: Game, edgeIds: number[], owner: number): { steps: Step[]; error?: string } {
  const net = g.world.net;
  const ids = [...new Set(edgeIds)].filter((id) => net.edges.has(id));
  if (!ids.length) return { steps: [], error: 'No track selected' };
  for (const id of ids) {
    const e = net.edges.get(id)!;
    if (e.kind !== 'rail') return { steps: [], error: 'Only railway track can be doubled' };
    if (e.owner !== owner) return { steps: [], error: 'Not your track' };
    if (e.station >= 0 || e.depot >= 0) return { steps: [], error: 'Cannot double platform or depot tracks' };
  }
  const set = new Set(ids);
  const steps = aiDoubleWalkTrack(g, net.edges.get(ids[0])!, set);
  if (steps.length !== ids.length) return { steps: [], error: 'Track not continuous' };
  if (ids.length > 1) {
    const iLast = steps.findIndex((s) => s.edge === ids[ids.length - 1]), iFirst = steps.findIndex((s) => s.edge === ids[0]);
    if (iLast < iFirst) return { steps: steps.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })) };
  }
  return { steps };
}

/** Distance from a point to a sampled track (projected onto the nearest sample segments). */
function aiDoubleDistToTrack(S: aiDoubleSample[], x: number, z: number): number {
  const i = aiDoubleNearestSample(S, x, z).i;
  let d = Math.hypot(S[i].x - x, S[i].z - z);
  for (const j of [i - 1, i]) {
    if (j < 0 || j + 1 >= S.length) continue;
    const a = S[j], b = S[j + 1], vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz;
    if (l2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
    d = Math.min(d, Math.hypot(a.x + vx * t - x, a.z + vz * t - z));
  }
  return d;
}

/**
 * Plan a second track beside a chain of single-track edges, `RAIL.spacing` to the given side (+1 right of the
 * direction from the first listed edge to the last). Bridges and tunnels get parallel structures (the planner's
 * shared-formation discount applies); at each end the new track either runs into a free platform end of a station
 * there or joins the old track with a turnout (short of switches whose branches leave on that side). Nothing is
 * built; errors say where along the line a piece cannot be built (try the other side).
 */
function* aiPlanDoubleTrack(g: Game, edgeIds: number[], side: 1 | -1, owner: number): Generator<void, DoublePlan> {
  const net = g.world.net;
  const plan: DoublePlan = { ok: true, errors: [], warnings: [], cost: 0, owner, side, steps: [], length: 0, points: [], start: { kind: 'turnout', u: 0, node: -1 }, end: { kind: 'turnout', u: 0, node: -1 }, proposals: [] };
  const fail = (m: string) => { plan.ok = false; if (!plan.errors.includes(m)) plan.errors.push(m); return plan; };
  const ch = aiDoubleChainOf(g, edgeIds, owner);
  if (ch.error) return fail(ch.error);
  plan.steps = ch.steps;
  yield;
  const S = aiDoubleSampleSteps(g, ch.steps);
  yield;
  const U = S[S.length - 1].u;
  plan.length = U;
  const sp = RAIL.spacing;
  const nrm = (q: { tx: number; tz: number }) => ({ x: -q.tz * side, z: q.tx * side });
  const m10 = (u: number) => Math.round(u * 10);
  const chainSet = new Set(ch.steps.map((s) => s.edge));
  // branches leaving on the new track's side (judged a few units along them, as turnouts join tangentially):
  // near an end the new track stops short of them, elsewhere they are in the way
  let uMin = 0, uMax = U;
  const pt = { x: 0, y: 0, z: 0 };
  for (let i = 0; i + 1 < ch.steps.length; i++) {
    const nid = aiDoubleEndNode(g, ch.steps[i]);
    const n = net.nodes.get(nid)!;
    const q = S[aiDoubleNearestSample(S, n.x, n.z).i], nv = nrm(q);
    for (const eid of n.edges) {
      if (chainSet.has(eid)) continue;
      const e = net.edges.get(eid)!;
      const d = Math.min(e.len, 3);
      net.pointAt(e, e.a === nid ? d : e.len - d, pt);
      if ((pt.x - n.x) * nv.x + (pt.z - n.z) * nv.z <= 0.12) continue;
      if (q.u < U * 0.4) uMin = Math.max(uMin, q.u + 1.5);
      else if (q.u > U * 0.6) uMax = Math.min(uMax, q.u - 1.5);
      else return fail(`Branch on this side at ${m10(q.u)} m`);
    }
  }
  const offAt = (u: number) => { const q = aiDoubleSampleAt(S, u), nv = nrm(q); return { u, x: q.x + nv.x * sp, z: q.z + nv.z * sp, y: q.y, tx: q.tx, tz: q.tz }; };
  const onMain = (u: number): aiDoubleSPt => { const q = aiDoubleSampleAt(S, u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
  const isSwitchNear = (u: number) => { const q = aiDoubleSampleAt(S, u); return [...net.nodeGrid.query(q.x - 1.5, q.z - 1.5, q.x + 1.5, q.z + 1.5)].some((id) => { const n = net.nodes.get(id); return !!n && n.kind === 'rail' && n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.5; }); };
  // the ends: into a free platform end beside the track's own, else a turnout
  const endOf = function* (atStart: boolean): Generator<void, { end: DoubleEnd; inner: number; err?: string } | null> {
    const limit = atStart ? uMin : U - uMax;
    if (limit === 0) {
      const nid = atStart ? aiDoubleStartNode(g, ch.steps[0]) : aiDoubleEndNode(g, ch.steps[ch.steps.length - 1]);
      const n = net.nodes.get(nid)!;
      const q = atStart ? S[0] : S[S.length - 1];
      const nv = nrm(q);
      const stEdge = n.edges.map((id) => net.edges.get(id)!).find((e) => e && e.station >= 0);
      if (stEdge) {
        const st = g.stations.get(stEdge.station);
        let best = -1, bl = Infinity;
        for (const t of st ? g.stations.trackEnds(st) : []) for (const cand of [t.front, t.back]) {
          const m = net.nodes.get(cand);
          if (!m || cand === nid || m.edges.length !== 1) continue;
          const dx = m.x - n.x, dz = m.z - n.z, lat = dx * nv.x + dz * nv.z, along = dx * q.tx + dz * q.tz;
          if (Math.abs(along) < 0.3 && lat > 0.3 && lat < 1.7 && lat < bl) { bl = lat; best = cand; }
        }
        if (best >= 0) {
          const len = Math.max(7, Math.min(14, Math.sqrt(60 * Math.abs(bl - sp)) + 4));
          const inner = atStart ? len : U - len;
          const m = net.nodes.get(best)!, o = offAt(inner);
          const r = aiDoubleConnectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: q.tx, tz: q.tz, node: best }, o, chainSet, true);
          yield;
          if (!r.error) return { end: { kind: 'platform', u: atStart ? 0 : U, node: best }, inner };
        }
      }
    }
    let why = '';
    for (const T of [aiDoubleTURNOUT, aiDoubleTURNOUT + 3, aiDoubleTURNOUT + 7]) for (let d = Math.max(2, limit + 0.5); d <= limit + 26; d += 1) {
      const u = atStart ? d : U - d, u2 = atStart ? u + T : u - T;
      if (u2 < 0 || u2 > U || (atStart ? u2 > U / 2 : u2 < U / 2)) break;
      if (isSwitchNear(u)) continue;
      const r = aiDoubleConnectS(g, owner, onMain(u), offAt(u2), chainSet, true);
      yield;
      if (!r.error) return { end: { kind: 'turnout', u, node: -1 }, inner: u2 };
      why = r.error;
    }
    return { end: { kind: 'turnout', u: 0, node: -1 }, inner: NaN, err: why || 'no room' };
  };
  const a = yield* endOf(true), b = yield* endOf(false);
  if (!a || isNaN(a.inner)) return fail(`No room for start turnout: ${a?.err ?? ''}`);
  if (!b || isNaN(b.inner)) return fail(`No room for end turnout: ${b?.err ?? ''}`);
  plan.start = a.end; plan.end = b.end;
  const uS = a.inner, uE = b.inner;
  if (uE - uS < 3) return fail('Too short to double');
  // where the new track crosses other roads and tracks: no segment ends there
  const cross: number[] = [];
  for (let i = 0; i < S.length - 1; i += 2) {
    if (i % 32 === 0) yield;
    const p = S[i], q = S[Math.min(S.length - 1, i + 2)];
    const np = nrm(p), nq = nrm(q);
    const ax = p.x + np.x * sp, az = p.z + np.z * sp, bx = q.x + nq.x * sp, bz = q.z + nq.z * sp;
    for (const e of net.edgesNear(Math.min(ax, bx) - 0.5, Math.min(az, bz) - 0.5, Math.max(ax, bx) + 0.5, Math.max(az, bz) + 0.5)) {
      if (chainSet.has(e.id)) continue;
      const ge = net.geo(e);
      for (let j = 0; j < ge.n - 1; j++) {
        const cx = ge.pts[j * 3], cz = ge.pts[j * 3 + 2], dx = ge.pts[j * 3 + 3], dz = ge.pts[j * 3 + 5];
        const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((cx - ax) * sz - (cz - az) * sx) / den, v = ((cx - ax) * rz - (cz - az) * rx) / den;
        if (t >= 0 && t <= 1 && v >= 0 && v <= 1) cross.push(p.u + (q.u - p.u) * t);
      }
    }
  }
  // (segment ends keep 4.5 units from crossings, so the track can meet a level crossing's height)
  const CR = 4.5;
  const blocked = (u: number) => cross.find((c) => Math.abs(c - u) < CR);
  const us: number[] = [uS];
  for (let guard = 0; guard < 2000; guard++) {
    const u = us[us.length - 1];
    if (u >= uE - 1e-6) break;
    let nx = u + aiDoubleSEG >= uE - 3 ? uE : u + aiDoubleSEG;
    const c = nx < uE ? blocked(nx) : undefined;
    if (c !== undefined) nx = c - CR - u >= 2 ? c - CR : Math.min(uE, c + CR);
    if (nx >= uE - 1.5) nx = uE;
    us.push(nx);
  }
  // segment ends on the parallel line with its exact direction; every segment is laid node to node (the planner's
  // curve between the two directions), split where that curve would stray from the parallel line
  const pts = [offAt(us[0])];
  const queue = us.slice(1);
  const pb = { x: 0, z: 0 };
  for (let guard = 0; queue.length && guard < 4000; guard++) {
    yield;
    const A = pts[pts.length - 1], B = offAt(queue[0]);
    const bez = fitCurve({ x: A.x, z: A.z, tx: A.tx, tz: A.tz, fixed: true, y: null }, { x: B.x, z: B.z, tx: B.tx, tz: B.tz, fixed: true, y: null });
    let dev = 0;
    for (let i = 1; i < 8; i++) { bezPoint(bez, i / 8, pb); dev = Math.max(dev, Math.abs(aiDoubleDistToTrack(S, pb.x, pb.z) - sp)); }
    if (dev > 0.03 && queue[0] - A.u > 1.5) { queue.unshift((A.u + queue[0]) / 2); continue; }
    pts.push(B);
    queue.shift();
  }
  plan.points = pts;
  // plan every segment between temporary nodes (removed again)
  const tmp = pts.map((p) => net.addNode('rail', p.x, p.y, p.z, -p.tx, -p.tz, owner));
  // Reserve the same node IDs as the synchronous planner, but expose temporary nodes only during a planEdge
  // call. Other jobs and save/load must never see the preview's unconnected nodes between work units.
  const detach = () => { for (const n of tmp) { net.nodes.delete(n.id); net.nodeGrid.remove(n.id); } };
  detach();
  try {
    for (let k = 0; k + 1 < pts.length; k++) {
      let prop: Proposal;
      try {
        for (const n of tmp) { net.nodes.set(n.id, n); net.nodeGrid.insert(n.id, n.x, n.z, n.x, n.z); }
        prop = planEdge(g, aiDoubleNodeSnapOf(g, tmp[k].id), aiDoubleNodeSnapOf(g, tmp[k + 1].id), aiDoubleRailOpts(owner, { type: aiDoubleLineType(g, plan.steps) }));
      } finally { detach(); }
      plan.proposals.push(prop);
      if (!prop.ok) fail(`New track (${m10(pts[k].u)}-${m10(pts[k + 1].u)} m of ${m10(U)} m): ${prop.errors[0] ?? 'cannot build'}`);
      yield;
    }
  } finally {
    detach();
    net.version += tmp.length; // the synchronous planner's removeNode calls advance the version once per node
  }
  const conn = (e: DoubleEnd, inner: number) => {
    const o = offAt(inner);
    if (e.kind === 'platform') { const m = net.nodes.get(e.node)!; return aiDoubleConnectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: o.tx, tz: o.tz, node: e.node }, o, chainSet, true).cost; }
    return aiDoubleConnectS(g, owner, onMain(e.u), o, chainSet, true).cost;
  };
  const startCost = conn(plan.start, uS);
  yield;
  const endCost = conn(plan.end, uE);
  yield;
  plan.cost = Math.round(plan.proposals.reduce((s, p) => s + p.cost, 0) + startCost + endCost);
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  return plan;
}


/** Double-track construction with one preview or commit per unit and exact rollback accounting. */
function aiDoubleTrackSplits(g: Game, lists: Step[][]): () => void {
  const net = g.world.net;
  const f = (old: NEdge, e1: NEdge, e2: NEdge) => {
    for (const L of lists) {
      const i = L.findIndex((s) => s.edge === old.id);
      if (i < 0) continue;
      const d = L[i].dir;
      L.splice(i, 1, ...(d > 0 ? [{ edge: e1.id, dir: 1 }, { edge: e2.id, dir: 1 }] : [{ edge: e2.id, dir: -1 }, { edge: e1.id, dir: -1 }]));
    }
  };
  net.onSplit.push(f);
  return () => { net.onSplit = net.onSplit.filter((x) => x !== f); };
}

function aiDoubleRefund(g: Game, owner: number, before: number) {
  const eco = g.company(owner).economy;
  const spent = before - eco.money;
  if (spent > 0) eco.spend(-spent, 'construction', true);
}

function* aiCommitDoubleTrack(g: Game, plan: DoublePlan, finish = true, opts: FinishOpts = {}, record: (edges: number[]) => void = () => {}): Generator<void, DoubleResult> {
  const net = g.world.net;
  const owner = plan.owner;
  const res: DoubleResult = { error: null, cost: 0, edges: [], signals: 0, crossovers: 0 };
  if (!plan.ok) { res.error = plan.errors[0] ?? 'Cannot build'; return res; }
  const eco = g.company(owner).economy;
  if (!eco.canAfford(plan.cost)) { res.error = 'Not enough money'; return res; }
  for (const s of plan.steps) if (!net.edges.has(s.edge)) { res.error = 'The track changed, plan again'; return res; }
  for (const e of [plan.start, plan.end]) if (e.kind === 'platform' && net.nodes.get(e.node)?.edges.length !== 1) { res.error = 'The track changed, plan again'; return res; }
  let paid = 0;
  const added = new Set<number>();
  const split = (old: NEdge, e1: NEdge, e2: NEdge) => { if (added.delete(old.id)) { added.add(e1.id); added.add(e2.id); } };
  net.onSplit.push(split);
  let hideUnused = () => {};
  let restoreUnused = () => {};
  const main = plan.steps.map((s) => ({ ...s }));
  const untrack = aiDoubleTrackSplits(g, [main]);
  const created = () => [...added].filter((id) => net.edges.has(id) && !main.some((s) => s.edge === id)).sort((a, b) => a - b);
  // Operating income and other companies' construction continue between units; track only this transaction.
  const mutate = <T>(f: () => T, countCost = true): T => {
    const e0 = net.nextEdge, before = eco.money;
    restoreUnused();
    try { return f(); } finally {
      for (let id = e0; id < net.nextEdge; id++) if (net.edges.has(id)) added.add(id);
      if (countCost) paid += before - eco.money;
      hideUnused();
      record(created());
    }
  };
  const rollback = (why: string) => {
    for (const id of created()) net.removeEdge(id);
    aiDoubleRefund(g, owner, eco.money + paid);
    g.onNetworkChanged();
    res.error = why;
    return res;
  };
  try {
    const pts = plan.points;
    const nodes = pts.map((p) => net.addNode('rail', p.x, p.y, p.z, -p.tx, -p.tz, owner).id);
    const first = net.nodes.get(nodes[0])!;
    const nodeRecords = nodes.map((id) => net.nodes.get(id)!);
    hideUnused = () => { for (const n of nodeRecords) if (!n.edges.length) { net.nodes.delete(n.id); net.nodeGrid.remove(n.id); } };
    restoreUnused = () => { for (const n of nodeRecords) if (!n.edges.length && !net.nodes.has(n.id)) { net.nodes.set(n.id, n); net.nodeGrid.insert(n.id, n.x, n.z, n.x, n.z); } };
    const dropNodes = () => { restoreUnused(); for (const id of nodes) { const n = net.nodes.get(id); if (n && !n.edges.length) net.removeNode(id); } };
    hideUnused();
    for (let k = 0; k + 1 < pts.length; k++) {
      let ok = false;
      for (const extra of [{}, { crossing: 'level' as const }, { crossing: 'over' as const }, { crossing: 'under' as const }]) {
        let prop: Proposal;
        restoreUnused();
        try { prop = planEdge(g, aiDoubleNodeSnapOf(g, nodes[k]), aiDoubleNodeSnapOf(g, nodes[k + 1]), aiDoubleRailOpts(owner, { type: aiDoubleLineType(g, plan.steps), ...extra })); }
        finally { hideUnused(); }
        yield;
        if (!prop.ok) continue;
        const error = mutate(() => commitProposal(g, prop));
        yield;
        if (error) continue;
        ok = true;
        break;
      }
      if (!ok) { const r = rollback(`Build failed at ${Math.round(pts[k].u * 10)} m: ground or network changed`); dropNodes(); return r; }
    }
    const cur = nodes[nodes.length - 1];
    const tracks = () => new Set<number>([...main.map((s) => s.edge), ...created()]);
    const nodePt = (id: number, t: { tx: number; tz: number }): aiDoubleSPt => { const n = net.nodes.get(id)!; return { x: n.x, z: n.z, y: n.y, tx: t.tx, tz: t.tz, node: id }; };
    const mainPt = (u: number): aiDoubleSPt => { const q = aiDoubleSampleAt(aiDoubleSampleSteps(g, main), u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
    const last = pts[pts.length - 1];
    const r1 = mutate(() => plan.end.kind === 'platform' ? aiDoubleConnectS(g, owner, nodePt(cur, last), nodePt(plan.end.node, last), tracks(), false) : aiDoubleConnectS(g, owner, nodePt(cur, last), mainPt(plan.end.u), tracks(), false));
    yield;
    if (r1.error) { const r = rollback(`End connection: ${r1.error}`); dropNodes(); return r; }
    const r2 = mutate(() => plan.start.kind === 'platform' ? aiDoubleConnectS(g, owner, nodePt(plan.start.node, pts[0]), nodePt(first.id, pts[0]), tracks(), false) : aiDoubleConnectS(g, owner, mainPt(plan.start.u), nodePt(first.id, pts[0]), tracks(), false));
    yield;
    if (r2.error) { const r = rollback(`Start connection: ${r2.error}`); dropNodes(); return r; }
    res.edges = created();
    res.cost = Math.round(paid);
    g.onNetworkChanged();
    if (finish) {
      yield;
      const f = mutate(() => finishDoubleTrack(g, [...main.map((s) => s.edge), ...res.edges], owner, opts), false);
      res.signals = f.signals; res.crossovers = f.crossovers;
      if (f.error) res.finishError = f.error;
      res.cost += f.cost;
    }
    return res;
  } finally {
    hideUnused();
    untrack();
    net.onSplit = net.onSplit.filter((f) => f !== split);
  }
}

export const AI_NAMES = [
  'Northern Star Rail', 'Blue Valley Transit', 'Crimson Express', 'Evergreen Lines', 'Violet Coast Railways',
  'Teal Harbour Transport', 'Rosewood Tramways', 'Silverline Metro', 'Golden Arrow Rail', 'Amber Hills Transit',
];

// ============================================================================ configuration

export interface AIConfig {
  /** 0.25 (passive) … 2 (aggressive): how often it starts projects, work per day, how far it borrows and expands */
  activeness: number;
  /** relative preference for railways, buses (and country roads) and trams; 0 = never */
  focus: { rail: number; road: number; tram: number };
  /** 0 … 1: loan appetite and the payback it accepts (0 cautious, 1 bold); bold companies also buy rivals */
  risk: number;
  /** cash at the start (the first 5M of it is borrowed) */
  startMoney: number;
  /** 0 … 3: weight of other companies' usage when they share the maintenance of this company's network (see Game) */
  accessMultiplier: number;
  /** sharing the network: open (default: anyone not blocked, no requests), judge requests (cautious companies refuse competitors), or always yes / no */
  accessPolicy: AccessPolicy;
}

/** AI companies share their tracks openly by default: everyone may use them, at a 1x usage share. */
export const DEFAULT_AI_CONFIG: AIConfig = { activeness: 1, focus: { rail: 1, road: 1, tram: 1 }, risk: 0.5, startMoney: 5_000_000, accessMultiplier: 1, accessPolicy: 'open' };

/** Ready-made personalities for the new-game and company screens. */
export const AI_PRESETS: { id: string; name: string; hint: string; config: AIConfig }[] = [
  { id: 'balanced', name: 'Balanced', hint: 'Rail, bus and tram equally', config: DEFAULT_AI_CONFIG },
  { id: 'cautious', name: 'Cautious', hint: 'Rare builds; avoids debt', config: { activeness: 0.35, focus: { rail: 1, road: 1, tram: 1 }, risk: 0.15, startMoney: 4_000_000, accessMultiplier: 1, accessPolicy: 'open' } },
  { id: 'aggressive', name: 'Aggressive', hint: 'Fast expansion with loans; buys struggling rivals', config: { activeness: 1.6, focus: { rail: 1.2, road: 1, tram: 1 }, risk: 0.85, startMoney: 8_000_000, accessMultiplier: 1, accessPolicy: 'open' } },
  { id: 'rail', name: 'Rail baron', hint: 'Intercity railways first', config: { activeness: 1.1, focus: { rail: 3, road: 0.4, tram: 0.3 }, risk: 0.6, startMoney: 6_000_000, accessMultiplier: 1, accessPolicy: 'open' } },
  { id: 'bus', name: 'Bus operator', hint: 'Intercity coaches and town buses', config: { activeness: 1, focus: { rail: 0.25, road: 3, tram: 0.6 }, risk: 0.4, startMoney: 4_000_000, accessMultiplier: 1, accessPolicy: 'open' } },
  { id: 'tram', name: 'Tram builder', hint: 'Trams in large towns', config: { activeness: 1, focus: { rail: 0.4, road: 0.7, tram: 3 }, risk: 0.5, startMoney: 5_000_000, accessMultiplier: 1, accessPolicy: 'open' } },
];

const clamp = (x: number, a: number, b: number) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : a);

/** A complete, clamped configuration (missing fields from `base`). */
export function normalizeAIConfig(c?: Partial<AIConfig> | null, base: AIConfig = DEFAULT_AI_CONFIG): AIConfig {
  const f = { ...base.focus, ...(c?.focus ?? {}) };
  return {
    activeness: clamp(c?.activeness ?? base.activeness, 0.25, 2),
    focus: { rail: clamp(f.rail, 0, 5), road: clamp(f.road, 0, 5), tram: clamp(f.tram, 0, 5) },
    risk: clamp(c?.risk ?? base.risk, 0, 1),
    startMoney: clamp(c?.startMoney ?? base.startMoney, 0, 1e9),
    accessMultiplier: clamp(c?.accessMultiplier ?? base.accessMultiplier, 0, 3),
    accessPolicy: c?.accessPolicy === 'open' || c?.accessPolicy === 'ask' || c?.accessPolicy === 'auto-approve' || c?.accessPolicy === 'auto-reject' ? c.accessPolicy : base.accessPolicy,
  };
}

// ============================================================================ vehicles

/**
 * A model's yearly operating cost in typical service (opcosts estimateVehicleYear: overhead, crew, maintenance,
 * energy), for choosing between models; cached per model and year.
 */
const yearCosts = new Map<string, number>();
/**
 * AIController.serviceYear results (route evaluation), per game, by model set, exact size and year: a pure cache. (It
 * was one map for all games, keyed by distances rounded to 4 units: a value was the first query's of its bucket, so
 * an earlier game in the same tab, or the queries before a save, changed a game's later choices.)
 */
const serviceMemo = new WeakMap<Game, Map<string, { seats: number; perPax: number; running: number; trackUpkeep: number; headway: number; kmh: number }>>();
type TownDemand = { pair: (a: number, b: number) => number; local: (t: number) => number };
const townDemandMemo = new WeakMap<Game, { key: string; value: TownDemand }>();
export function modelYearCost(m: VehicleModel, year: number): number {
  const k = m.id + ':' + year;
  let c = yearCosts.get(k);
  if (c === undefined) {
    const hop = m.kind === 'bus' ? (m.style === 'coach' ? 120 : 22) : m.kind === 'tram' ? 25 : 150;
    try { c = estimateVehicleYear([m], hop, year, 0.5).total; } catch { c = m.running; }
    if (!(c >= 0)) c = m.running;
    yearCosts.set(k, c);
  }
  return c;
}

/** A long-distance coach for the year (the fastest value for money); a town bus when there are none. */
export function pickCoach(year: number): VehicleModel | null {
  const coaches = availableModels(year, 'bus', false).filter((m) => m.style === 'coach');
  const value = (m: VehicleModel) => (m.capacity * m.speed) / (m.cost + modelYearCost(m, year) * 8);
  return coaches.sort((a, b) => value(b) - value(a))[0] ?? pickBus(year);
}

/** Coaches that fit a platform behind a locomotive (1..5). */
export function coachesFitting(platform: number, loco: VehicleModel, wag: VehicleModel): number {
  return Math.max(1, Math.min(5, Math.floor((platform - 0.8 - loco.length) / (wag.length + 0.1))));
}

/** Coaches of a new AI train: short at opening (2, or 3 between big towns); trains grow when passengers pile up. */
export function openingCoaches(popA: number, popB: number): number { return Math.sqrt(Math.max(0, popA * popB)) >= 4500 ? 3 : 2; }

/**
 * Platform length (units) of a new AI railway's stations by demand: 8–10, 12 only for heavy demand (10 where the
 * trains of `year` need it for a locomotive and two coaches).
 */
export function aiPlatformLength(popA: number, popB: number, year?: number): number {
  const d = Math.sqrt(Math.max(0, popA * popB));
  const L = d < 1200 ? 8 : d < 4500 ? 10 : 12;
  // room for a locomotive and two coaches of the day at least
  if (L < 10 && year !== undefined && (pickTrain(year, L, 100, 2)?.length ?? 0) < 3) return 10;
  return L;
}

/**
 * Rail vehicles for the year: a cost-efficient locomotive (the fastest on long lines) and `coaches` coaches
 * (at most what the platform takes).
 */
export function pickTrain(year: number, platform: number, lineLen: number, coaches = 2, electric = false): VehicleModel[] | null {
  // (electric locomotives only on electrified track: they could not leave the depot on the others)
  const locos = availableModels(year, 'loco').filter((m) => electric || m.traction !== 'electric'), wagons = availableModels(year, 'wagon', false);
  if (!locos.length || !wagons.length) return null;
  const value = (m: VehicleModel) => (Math.min(m.speed, lineLen > 220 ? 300 : 150) * (0.5 + m.power / 5000)) / (m.cost + modelYearCost(m, year) * 8);
  const loco = [...locos].sort((a, b) => value(b) - value(a))[0];
  const fit = wagons.filter((w) => w.speed >= Math.min(loco.speed, 150));
  const wag = (fit.length ? fit : wagons).sort((a, b) => b.capacity - a.capacity)[0];
  const n = Math.max(1, Math.min(coachesFitting(platform, loco, wag), coaches));
  return [loco, ...Array<VehicleModel>(n).fill(wag)];
}

export function pickBus(year: number, townPop = 3000): VehicleModel | null {
  const buses = availableModels(year, 'bus', false).filter((m) => m.style !== 'coach');
  // small towns: smaller buses
  const value = (m: VehicleModel) => (Math.min(m.capacity, townPop / 40) * Math.min(m.speed, 60)) / (m.cost + modelYearCost(m, year) * 8);
  return buses.sort((a, b) => value(b) - value(a))[0] ?? null;
}

export interface AIStats {
  railStations: number; busStops: number; track: number; road: number; bridges: number; tunnels: number;
  lines: number; vehicles: number; failed: number; spent: number; sold: number;
  /** tram lines opened, railways run under track access, companies bought */
  trams: number; shared: number; acquired: number;
  /** railways started from one of our stations (network extensions), lines upgraded to double track, block signals */
  reused: number; doubled: number; signals: number;
  /** passing loops laid on the open line (lines that could only be doubled in parts) */
  loops: number;
  /** walking transfers set up between a new station or stop and stations nearby (transfer complexes) */
  transfers: number;
  /** the most stations on one of our railway lines (3+: lines through several towns) */
  multiTown: number;
  /** ring (loop) lines opened */
  rings: number;
  /** other companies' lines joined as an operator (instead of a parallel line of our own) */
  joined: number;
  /** urban railways opened (metro / light rail), through services set up, track electrified (units) */
  urban: number; through: number; electrified: number;
  /** long-distance coach lines opened */
  coaches: number;
  /** track units: laid as a second track (upgrades), and of other companies' railways our trains run on */
  trackDouble: number; trackShared: number;
  /** stations rebuilt bigger (more platforms, through tracks, longer platforms), stations merged into one */
  grown: number; merged: number;
  /** railways joined at an existing station of the town (no second station), side-by-side single tracks
   * paired into a double track, junctions between lines */
  joinedStations: number; paired: number; connections: number;
  /** dead-end stubs of ours taken up (track units) */
  stubs: number;
  /** high-speed railways opened, lines given an express pattern, cross-city links (underground through a big town) */
  hsr: number; express: number; crossCity: number;
}

type ProjectKind = 'rail' | 'bus' | 'road' | 'tram' | 'share' | 'coach' | 'double' | 'metro' | 'lightrail' | 'hsr' | 'crosscity';

interface Project {
  kind: ProjectKind;
  towns: number[];
  stations: number[];
  edges: number[];
  depots: number[];
  line: number;
  /** Final timetable being opened/merged; lifecycle ownership remains in `line`. Saved with this project. */
  openingLine?: number;
  started: number;
  /** Completed selection survey; construction proves its sites, yard, fleet and economics again. */
  urbanLayout?: UrbanLayout;
  /** Earlier local survey heading, repriced as an additional smaller-stage alternative. */
  urbanHeading?: { angle: number; stops: number };
  /** share: the network owner whose access agreement this project signed (-1: none) */
  access?: number;
  /** construction started (a failure then cost money; failed plans are retried sooner) */
  built?: boolean;
  /** Joint tunnel: partner's work is reserved too; ownership and construction debits survive save cleanup. */
  joint?: { partner: number; spent: [number, number]; share: number };
}

type UrbanLevel = 'ground' | 'elevated' | 'underground';
interface UrbanYard { index: number; dir: number; x: number; z: number; cost: number; track: number; straight: boolean; under?: SubwayYardPlan }
interface UrbanTask {
  town: number; mode: 'metro' | 'lightrail';
  layout: UrbanLayout;
  maxStops?: number; skipped?: boolean;
  /** A rejected selection layout retries the ordinary full survey before any construction. */
  fromHandoff?: boolean;
  candidates: { a: number; lat: number; lv: UrbanLevel; trim?: boolean; targets?: number[] }[];
  stage: 'sites' | 'links' | 'yardUnder' | 'yardRamp' | 'evaluate' | 'approve' | 'stations' | 'buildLinks' | 'buildTail' | 'buildYard' | 'throat' | 'finish' | 'line' | 'fleet' | 'transfers' | 'open';
  candidate: number; target: number; offset: number; tries: number; previous: number;
  got: StationPlan[]; link: number; links: number; yardAt: number; yard: UrbanYard | null;
  plans: StationPlan[]; angle: number; level: UrbanLevel; connectionCost?: number; plannedYard?: UrbanYard;
  bestReturn: number; bestPays: boolean; paid: boolean; alignment: string; more: number;
  siteRejects: [string, number][]; linkRejects: [string, number][];
  at: number; stations: number[]; doubleEdges: number[]; depot: number; end: number;
  /** The built tail's end (or the platform end for a straight yard), saved before building its branch. */
  fork?: number;
  estimate?: ReturnType<AIController['urbanEconomics']>;
  unit?: string;
  finish?: Trackops.FinishResult;
  bought: number;
}
interface UrbanLayout {
  x: number; z: number; angle: number; spacing: number; step: number; end: number; L: number; platform: number;
  targets: number[]; interchanges: number[];
  /** Actual centres on a through alignment; absent for legacy/local layouts. */
  towns?: number[];
}
type UrbanQuote = UrbanLayout & { quote?: ReturnType<AIController['urbanEconomics']> };
interface UrbanSurvey {
  maxStops: number; unit: string; trials: { layout: UrbanLayout; level: UrbanLevel; count: number }[];
  trial: number; site: number; offset: number; sites: (StationPlan | ForecastSite)[];
  best: UrbanQuote; stageBest: UrbanQuote; bestReturn: number; stageReturn: number; stageCount: number;
}
interface AccessTask { station: number; stage: 'road' | 'roadCommit' | 'rebuild' | 'rebuildCommit'; side: number; road?: Proposal; plan?: StationPlan }

/** Task plans save ids rather than live station references, and profiles as ordinary JSON arrays. */
function saveTaskProposal(p: Proposal) {
  return { ...p, tracks: p.tracks.map((t) => ({ ...t, prof: [...t.prof] })) };
}
function loadTaskProposal(p: ReturnType<typeof saveTaskProposal>): Proposal {
  return { ...p, opts: p.opts.kind === 'rail' ? { ...p.opts, type: trackTypeOf(p.opts.type) } : { ...p.opts },
    tracks: p.tracks.map((t) => ({ ...t, prof: Float32Array.from(t.prof) })) };
}
function saveTaskStation(p: StationPlan) {
  const { buildingCands: _, ...plain } = p as StationPlan & { buildingCands?: unknown };
  return { ...plain, join: p.join?.id ?? null, links: p.links.map((s) => s.id), access: p.access ? saveTaskProposal(p.access) : null };
}
function loadTaskStation(g: Game, p: ReturnType<typeof saveTaskStation>): StationPlan {
  // A stop removed while planning can leave a stale reference; retain its id just as the running plan does.
  const ref = (id: number) => g.stations.get(id) ?? { id } as Station;
  const mode = p.mode ?? railModeOf(p.trackType), trackType = trackTypeOf(p.trackType);
  // Pending v29 plans also migrate their legacy style track, before they lay any platform edges.
  const city = trackType !== p.trackType && p.city === undefined && mode !== 'mainline'
    && g.stations.cityAt(p.x, p.z, g.towns.nearest(p.x, p.z));
  return { ...p, trackType, mode, ...(city ? { city: true } : {}), join: p.join === null ? null : ref(p.join),
    links: p.links.map(ref), access: p.access ? loadTaskProposal(p.access) : null };
}

export interface LineInfo {
  /** bus: town buses or long-distance coaches (two towns) */
  kind: 'rail' | 'bus' | 'tram'; towns: number[]; depot: number; maxVehicles: number; opened: number; lastSold?: number;
  /** trains run on this company's network under a track access agreement */
  shared?: number;
  /** rail: upgraded to double track with block signals; day of the last failed upgrade */
  double?: boolean; upgradeFailed?: number;
  /** Geometric failure permits a congestion cut; cash/occupied track only defers the upgrade. Saved for retries. */
  doubleImpossible?: boolean; upgradeRetry?: number;
  /** Physically paired legs whose crossovers/signals need another attempt. */
  doubleFinish?: number[];
  /** Observed annual congestion loss supporting completion of temporary loops; ages out with demand changes. */
  doubleValue?: number; doubleSince?: number;
  /** rail: passing loops laid on the open line (where the whole track could not be doubled) */
  loops?: number;
  /** rail: towns along the line where a station on the track could not be planned */
  triedStops?: number[];
  /** rail: another company's line we run trains on too (one of its operators), not a line of ours */
  joined?: boolean;
  /** rail: how far the congestion response got (1 signals, 2 loops / double track, 3 fewer trains) and when */
  congestion?: number; congestionDay?: number;
  /** rail: an urban railway (metro / light rail) through one town */
  urban?: 'metro' | 'lightrail';
  /** rail: a high-speed railway (HSR units on a wide, wired alignment) */
  hsr?: boolean;
  /** rail: day an express pattern was added (patterns.ts); stations the line had when it was last looked at for one */
  express?: number; expressLook?: number;
  /** rail: day the line was electrified (its trains may then be electric), or minus the day it was last looked at */
  electric?: number;
  /** rail: a direct service across two companies' networks (ai-network.ts xlink): its operators' trains together stay
   * within the lead operator's maxVehicles, as the track it shares with both companies' lines allows */
  across?: boolean;
  /** rail mail: day of the last annual van review */
  mailLook?: number;
}

/** A place on a station's approach track where a new line can join it (see approachJunctions). */
interface JunctionSite { edge: number; s: number; x: number; z: number; y: number; tx: number; tz: number; owner: number; chain: number[]; dist: number }

export interface AIState {
  phase: string;
  cooldown: number;
  projects: number;
  /** Next detailed city opportunity; rotating the search keeps other construction moving. */
  urbanSearchCursor?: number;
  rng?: number;
  failed?: [string, number][];
  stats?: AIStats;
  lines?: [number, LineInfo][];
  project?: Project | null;
  /** day of the last company acquisition */
  lastAcq?: number;
  /** a corridor to continue: our station (the end of a line) and the town beyond it */
  corridor?: [number, number];
  /** a through service being planned after a city railway opened (resumed after loading: AIController.throughJob) */
  through?: ThroughJob;
  doubleJob?: DoubleJob;
}

/** The through-service follow-up of a city railway: its line, the station at its depot end, its style, the cursor. */
export interface ThroughJob { line: number; end: number; mode: 'metro' | 'lightrail'; at: number }

/** Optional members of the tram planner used here (see ai-tram.ts). */
interface TramPlannerExt {
  project?: { town: number; line: number; depot: number } | null;
  status?: string;
  reason?: string;
  candidates?(): Town[];
  record?(): unknown;
}
const tramExt = (t: TramPlanner) => t as unknown as TramPlannerExt;

const LEAD = 20;
/**
 * (linegrow) A city railway's depot ramp branches off a straight tail this long (units) beyond a terminus's outer
 * platform track: the line can later run on from the tail's end and the other track's (ai-grow.ts terminusOf).
 */
export const URBAN_TAIL = 4;
/** Smallest town that gets an AI bus network. */
const BUS_MIN_POP = 1500;

/**
 * An AI company. Plans one project at a time (a bus network or a tram line in a large town, an intercity
 * railway, trains on another company's railway, or a country road) as an incremental job; `work()` spreads
 * its work units over the day, `monthly()` manages loans, vehicles, track access
 * and acquisitions. Uses only the public construction API. `config` may be changed at any time.
 */
export class AIController {
  readonly railPolicy: RailPolicy;
  readonly mailPolicy: MailPolicy;
  state: AIState = { phase: 'idle', cooldown: 10, projects: 0, urbanSearchCursor: 0 };
  stats: AIStats = {
    railStations: 0, busStops: 0, track: 0, road: 0, bridges: 0, tunnels: 0, lines: 0, vehicles: 0, failed: 0, spent: 0, sold: 0, trams: 0, shared: 0, acquired: 0,
    reused: 0, doubled: 0, signals: 0, loops: 0, transfers: 0, multiTown: 0, rings: 0, joined: 0, urban: 0, through: 0, electrified: 0, trackDouble: 0, trackShared: 0, coaches: 0,
    grown: 0, merged: 0, joinedStations: 0, paired: 0, connections: 0, stubs: 0, hsr: 0, express: 0, crossCity: 0,
  };
  private cfg: AIConfig;
  /** the company's settings (assigning normalizes: missing fields from the defaults, values clamped) */
  get config(): AIConfig { return this.cfg; }
  set config(c: AIConfig) { this.cfg = normalizeAIConfig(c); }
  /** debugging: note work units slower than slowMs */
  static profile = false;
  /** (profiling) the best options of the last project choice */
  lastOptions: { kind: string; towns: number[]; score: number }[] = [];
  static slowMs = 8;
  /** tests: build forced projects even when the estimate says they would not pay */
  static forceBuild = false;
  /** Minimum town population for a separate underground cross-city joining project. */
  static centrePop = 5000;
  /**
   * Search from the same town size at which the fare/demand model recognises a dense centre.
   * The forecast and full investment quote decide whether a railway is worth building there.
   */
  static urbanPop = URBAN_DEMAND.minPop;
  log: string[] = [];
  /** the company was bought: the controller does nothing any more */
  disposed = false;
  private rng: RNG;
  private failed = new Map<string, number>();
  private lines = new Map<number, LineInfo>();
  private project: Project | null = null;
  private job: Generator<void, void> | null = null;
  private urbanTask: UrbanTask | null = null;
  private urbanSurvey: UrbanSurvey | null = null;
  private accessTask: AccessTask | null = null;
  private errorLogged = false;
  private tram: TramPlanner | null = null;
  private lastAcq = -1e9;
  /** trains to replace by longer ones: [train, depot, car model ids] */
  private relengthen: [number, number, string[]][] = [];
  private readonly splitListener = (old: NEdge, e1: NEdge, e2: NEdge) => {
    const p = this.project;
    if (!p) return;
    const i = p.edges.indexOf(old.id);
    if (i >= 0) p.edges.splice(i, 1, e1.id, e2.id);
    // the halves of track the project did not lay (cut in two by its works): never its own (track, abandon)
    else { this.splitPieces.add(e1.id); this.splitPieces.add(e2.id); }
  };
  /** Pieces of older track split during the current project (provenance: abandoning it leaves them alone). */
  private splitPieces = new Set<number>();

  constructor(public game: Game, public companyId: number, config?: Partial<AIConfig>) {
    this.railPolicy = new RailPolicy(this);
    this.mailPolicy = new MailPolicy(this);
    this.cfg = normalizeAIConfig(config);
    this.rng = new RNG((game.options.seed * 977 + companyId * 7919) >>> 0);
    this.state.urbanSearchCursor = companyId - 1;
    this.state.cooldown = Math.round((2 + companyId % 5) / this.config.activeness);
    game.world.net.onSplit.push(this.splitListener);
  }

  private get eco(): Economy { return this.game.company(this.companyId).economy; }
  private get name() { return this.game.company(this.companyId).name; }

  /** Actual services, including our trains on a partner's line; empty drafts do not count. */
  private operatingTowns(): Set<number> {
    const g = this.game, towns = new Set<number>();
    for (const l of g.lines.map.values()) if (l.vehicles.some(id => g.vehicles.get(id)?.owner === this.companyId))
      for (const id of l.stops) { const town = g.stations.get(id)?.townId; if (town !== undefined && town >= 0) towns.add(town); }
    return towns;
  }

  /** The ordinary bus planner can join this actual rail station at one of its street-stop candidates. */
  private busInterchange(T: Town): number | undefined {
    const g = this.game, q = { x: 0, y: 0, z: 0 };
    for (const e of g.towns.streets(T, 0)) {
      if (e.len < 4) continue;
      g.world.net.pointAt(e, e.len / 2, q);
      const plan = g.stations.planBusStop(q.x, q.z, this.companyId), st = plan.join;
      if (plan.ok && st?.rail && st.townId === T.id && g.lines.stationServed(st.id)) return st.id;
    }
    return undefined;
  }

  /** Work units per game day (more for active companies). */
  get budget(): number { return Math.max(3, Math.min(16, Math.round(8 * Math.pow(this.config.activeness, 0.6)))); }

  /** Share of the credit line the company is willing to use. */
  get loanAppetite(): number { const c = this.config; return clamp(0.35 + 0.5 * c.risk + 0.12 * (c.activeness - 1), 0.15, 0.95); }

  /** Money that can be committed: cash plus unused credit (within the appetite), minus a safety reserve. */
  available(): number {
    const e = this.eco;
    return e.money + Math.max(0, e.maxLoan * this.loanAppetite - e.loan) - 1_000_000 - this.game.maintenanceOf(this.companyId) * 0.5;
  }

  /** What the company is doing (for the UI). */
  get phase(): string { return this.disposed ? 'bought' : this.state.phase; }

  private tramPlanner(): TramPlanner {
    if (!this.tram) {
      const tp = new TramPlanner(this.game, this.companyId);
      // the planner picks its town from our candidates (failures remembered in our saved state, so a loaded game
      // chooses alike)
      (tp as unknown as { candidates: () => Town[] }).candidates = () => this.tramCandidates();
      this.tram = tp;
    }
    return this.tram;
  }

  /** Towns for a tram line: big enough, no tram line of ours yet, not failed recently (biggest first). */
  private tramCandidates(): Town[] {
    const g = this.game, served = new Set<number>();
    for (const l of g.lines.map.values()) {
      if (l.owner !== this.companyId || l.kind !== 'tram') continue;
      for (const s of l.stops) { const st = g.stations.get(s); if (st && st.townId >= 0) served.add(st.townId); }
    }
    const hq = !this.operatingTowns().size ? g.headquartersOf(this.companyId)?.id : undefined;
    return g.towns.list.filter((t) => t.pop >= TramPlanner.minPop && !served.has(t.id) && !this.isFailed('tram' + t.id) && this.localRoom(t))
      .sort((a, b) => Number(b.id === hq) - Number(a.id === hq) || b.pop - a.pop || a.id - b.id);
  }

  /** Is there room for a rail depot behind a planned station (stub or switch for multi-track)? */
  private depotSiteFor(plan: StationPlan, toward: P2, tracks: number): boolean {
    const g = this.game;
    const ax = Math.sin(plan.angle), az = Math.cos(plan.angle);
    const sgn = ax * (toward.x - plan.x) + az * (toward.z - plan.z) > 0 ? -1 : 1;
    const bx = ax * sgn, bz = az * sgn;
    const back = { x: plan.x + bx * plan.length / 2, z: plan.z + bz * plan.length / 2 };
    const lens = tracks > 1 ? [18, 22, 26] : [5, 8, 11, 15, 20];
    for (const L of lens) {
      const x = back.x + bx * L, z = back.z + bz * L;
      // single track can fall back to a siding off the line, so only the double-track stub needs level ground
      if (g.world.inside(x, z, 8) && depotFits(g, x, z, -bx, -bz, this.companyId, 30, tracks > 1 ? plan.y : undefined)) return true;
    }
    return false;
  }

  private note(s: string) {
    this.log.push(`${this.game.dateString()}: ${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  private onError(e: unknown) {
    if (!this.errorLogged) { this.errorLogged = true; console.warn(`AI ${this.name}:`, e); }
    this.note('error: ' + String((e as Error)?.message ?? e));
    try { this.cancelJob(); } catch { /* ignore */ }
    this.state.phase = 'idle';
    this.state.cooldown = 30;
  }

  /** Keep a config edited from outside (UI) within range. */
  private checkConfig() {
    const c = this.config;
    const ok = (x: unknown, a: number, b: number) => typeof x === 'number' && x >= a && x <= b;
    if (!c || !ok(c.activeness, 0.25, 2) || !ok(c.risk, 0, 1) || !c.focus || !ok(c.focus.rail, 0, 5) || !ok(c.focus.road, 0, 5) || !ok(c.focus.tram, 0, 5) || !ok(c.startMoney, 0, 1e9) || !ok(c.accessMultiplier, 0, 3) || !['open', 'ask', 'auto-approve', 'auto-reject'].includes(c.accessPolicy)) {
      this.config = c; // the setter normalizes (a field changed in place)
    }
  }

  /** Called once per game day while AI is enabled. */
  daily() {
    if (this.disposed) return;
    this.checkConfig();
    try {
      this.railPolicy.daily();
      if (networkOptions.enabled) this.manageSharedCapacity();
      if (this.cooperationReserved()) return;
      if (this.railPolicy.deepTrouble) this.recoverCash();
      if (this.relengthen.length) this.replaceTrains();
      // a project's work units run spread over the day (see work)
      if (this.job) return;
      // the network it has: stations grown, tracks paired and joined, lines merged or closed (ai-network.ts)
      networkDaily(this);
      if (this.railPolicy.deepTrouble) { this.state.phase = 'cutting operating costs'; return; }
      // Other construction can remove or isolate a forecourt street. Restore passenger access before
      // investing in another route, with a retry interval when no affordable repair fits.
      for (const st of this.game.stations.map.values()) {
        if (st.owner !== this.companyId || !st.rail || (this.accessCare.get(st.id) ?? -1) > this.game.day
          || this.game.stations.hasAccess(st)) continue;
        this.accessCare.set(st.id, this.game.day + 90);
        this.state.phase = `restoring road access at ${st.name}`;
        this.accessTask = { station: st.id, stage: 'road', side: 0 };
        this.job = this.accessRepairJob(st.id);
        return;
      }
      if (this.state.cooldown > 0) { this.state.cooldown--; return; }
      this.state.phase = 'evaluating projects';
      this.job = this.chooseProject();
    } catch (e) { this.onError(e); }
  }

  /**
   * The current project's work units, `budget` per game day spread evenly over the day (each company at its
   * own phase), so planning never stalls a frame: called with integer ticks within the day before and after
   * the step (the final tick ends at TICKS_PER_DAY).
   */
  work(t0: number, t1: number) {
    if (this.disposed) return;
    this.mailPolicy.step();
    const n = this.budget, phase = (this.companyId * 37) % 100, perDay = this.game.ticksPerDay;
    const allowance = (tick: number) => Math.floor((tick * n * 100 + phase * perDay) / (perDay * 100));
    let units = allowance(t1) - allowance(t0);
    try {
      // capacity-integration: saved corridor works get one construction unit, also while no project is running.
      if (units > 0 && networkOptions.enabled && !this.cooperationReserved() && sharedCapacityWork(this)) units--;
      for (; units > 0 && this.job; units--) {
        const t0 = AIController.profile ? performance.now() : 0;
        const active: Generator<void, void> = this.job;
        if (active.next().done && this.job === active) this.job = null;
        if (AIController.profile) { const dt = performance.now() - t0; if (dt > AIController.slowMs) this.note(`slow step ${dt.toFixed(1)} ms in "${this.state.phase}"`); }
      }
      if (!this.job && this.project) this.endProject();
    } catch (e) { this.onError(e); }
  }

  /** Called once per game month while AI is enabled. */
  monthly() {
    if (this.disposed) return;
    this.checkConfig();
    try { if (!this.cooperationReserved() && !this.project?.joint) this.manage(); } catch (e) { this.onError(e); }
  }

  /** The company was bought: stop and remove a half-built project. */
  dispose() {
    if (this.disposed) return;
    try { this.cancelJob(); } catch { /* ignore */ }
    this.disposed = true;
    this.state.phase = 'bought';
    const ls = this.game.world.net.onSplit, i = ls.indexOf(this.splitListener);
    if (i >= 0) ls.splice(i, 1);
  }

  /** Debug/test hook: start a specific project now (returns false if busy); rail from our station `hub` in towns[0]. */
  startProject(kind: 'rail' | 'bus' | 'road' | 'tram' | 'coach' | 'metro' | 'lightrail' | 'hsr' | 'crosscity', towns: number[], hub = -1): boolean {
    if (this.job || this.disposed || this.cooperationReserved()) return false;
    if (kind === 'crosscity' && this.game.ais.some((ai) => ai !== this && ai.project?.kind === 'crosscity' && ai.project.towns.includes(towns[0]))) return false;
    const g = this.game, T = towns.map((id) => g.towns.list[id]);
    if (kind === 'tram') return this.startTram(towns[0]);
    this.project = { kind, towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = kind === 'rail' || kind === 'hsr' ? this.railJob(T[0], T[1], hub, kind === 'hsr' ? 'highspeed' : 'standard') : kind === 'bus' ? this.busJob(T[0]) : kind === 'coach' ? this.coachJob(T[0], T[1])
      : kind === 'metro' || kind === 'lightrail' ? this.urbanJob(T[0], kind) : kind === 'crosscity' ? this.crossCityJob(T[0]) : this.roadJob(T[0], T[1]);
    this.state.projects++;
    return true;
  }

  /** Debug/test hook: run trains on `owner`'s railway between its stations a and b (track access). */
  startShare(owner: number, a: number, b: number, joinLine = -1): boolean {
    if (this.job || this.disposed) return false;
    this.project = { kind: 'share', towns: [], stations: [], edges: [], depots: [], line: -1, started: this.game.day };
    this.job = this.shareJob(owner, a, b, joinLine);
    this.state.projects++;
    return true;
  }

  /**
   * Debug/test hook: lay the second track of one of our single-track railway lines now (all of it, or passing
   * loops where that is not possible); true if anything was built.
   */
  upgradeLine(lineId: number): boolean {
    const l = this.game.lines.get(lineId), info = this.lines.get(lineId);
    if (!l || !info || info.kind !== 'rail' || info.double || this.job) return false;
    const job = this.doubleGen(l, info);
    while (!job.next().done) { /* run to the end */ }
    return !!info.double || !!info.loops;
  }

  /** Is a project in progress? */
  get busy() { return !!this.job; }

  /** Lines this controller runs (for the UI / tests). */
  managedLines(): number[] { return [...this.lines.keys()]; }
  railLineInfo(id: number): LineInfo | undefined { return this.lines.get(id); }
  railNote(text: string) { this.note(text); }

  // ---------------------------------------------------------------- choosing projects
  private pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
  private isFailed(key: string) { const d = this.failed.get(key); return d !== undefined && d > this.game.day; }
  private markFailed(key: string, days: number) { this.failed.set(key, this.game.day + days); this.stats.failed++; }

  /** Recent railway failures per town (from the failed town pairs). */
  private railTownFailures(): Map<number, number> {
    const m = new Map<number, number>();
    for (const [k, d] of this.failed) {
      if (d <= this.game.day) continue;
      const r = /^(\d+)-(\d+)$/.exec(k);
      if (!r) continue;
      for (const t of [Number(r[1]), Number(r[2])]) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }

  /** Trips per month between towns (both ways) and within a town, from the regional demand model. */
  private *townDemand(): Generator<void, TownDemand> {
    const g = this.game, m = g.demand;
    if (!m.regions.length) m.rebuild();
    const signature = () => `${m.version}:${g.world.nextBuildingId}:${g.world.buildings.size}:`
      + g.towns.list.map((t) => `${t.pop}:${t.radius}:${t.x}:${t.z}`).join('|');
    const key = signature(), nt = g.towns.list.length;
    const cached = townDemandMemo.get(g), hit = cached?.key === key ? cached.value : undefined;
    const snapshot = m.tripSnapshot(), R = snapshot.regions, P = new Float64Array(nt * nt);
    for (let r = 0; r < R.length; r++) {
      // Keep the same work-unit schedule with a warm or cold cache, including after loading a save.
      yield;
      if (hit) continue;
      const a = R[r].town;
      if (a < 0 || a >= nt) continue;
      for (let q = 0; q < R.length; q++) {
        const b = R[q].town;
        if (q === r || b < 0 || b >= nt) continue;
        const t = snapshot.trips(r, q);
        P[a * nt + b] += t;
        if (a !== b) P[b * nt + a] += t;
      }
    }
    if (hit) return hit;
    const value: TownDemand = { pair: (a, b) => P[a * nt + b], local: (t) => P[t * nt + t] };
    townDemandMemo.set(g, { key, value });
    return value;
  }

  /** Bus and tram lines (of all companies) running within a town (coaches to other towns do not count). */
  private localLines(T: Town): number {
    const g = this.game;
    let n = 0;
    for (const l of g.lines.map.values()) {
      if (l.kind === 'rail' || l.stops.length < 2) continue;
      if (l.stops.every((s) => g.stations.get(s)?.townId === T.id)) n++;
    }
    return n;
  }

  /** May one more bus or tram line open in this town? Few early on; more as the town grows and the years pass. */
  private localRoom(T: Town): boolean {
    return this.localLines(T) < 1 + Math.floor(T.pop / 3000) + Math.floor(this.game.day / 1080);
  }

  /** Lines (rail and coach, every company) per town pair (pairKey). */
  private servedPairs(): Map<string, number> {
    const g = this.game, out = new Map<string, number>();
    for (const l of g.lines.map.values()) {
      if (l.kind === 'tram' || l.stops.length < 2) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) { const k = this.pairKey(towns[i], towns[j]); out.set(k, (out.get(k) ?? 0) + 1); }
    }
    return out;
  }

  /** Town pairs (pairKey) connected by other companies' railways. */
  private rivalRailPairs(): Set<string> {
    const g = this.game, out = new Set<string>();
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.owner === this.companyId || l.stops.length < 2) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) out.add(this.pairKey(towns[i], towns[j]));
    }
    return out;
  }

  private *chooseProject(): Generator<void, void> {
    const g = this.game, c = this.config, act = c.activeness, focus = c.focus;
    const avail = this.available();
    const own = [...this.lines.values()];
    const lastInvestment = own.reduce((day, line) => Math.max(day, line.opened), 0);
    const preferredWeight = Math.max(focus.rail * focus.rail, focus.road * focus.road, focus.tram * focus.tram);
    const considers = (weight: number) => g.day - lastInvestment > 360 || weight * weight >= 0.1 * preferredWeight;
    const railLines = own.filter((l) => l.kind === 'rail').length, busLines = own.filter((l) => l.kind === 'bus').length, tramLines = own.filter((l) => l.kind === 'tram').length;
    // don't overbuild: keep the debt serviceable
    const yearNet = this.eco.yearTotals.length ? this.eco.lastYearProfit : 0;
    if (this.eco.loan > this.eco.maxLoan * Math.min(0.97, this.loanAppetite + 0.2) || (own.length >= 3 && yearNet < -1_500_000 * (0.5 + c.risk))) {
      this.state.phase = 'consolidating'; this.state.cooldown = Math.round(90 / Math.sqrt(act)); return;
    }
    // every option is scored by its expected return: yearly revenue from the regional OD demand at distance-based
    // fares, minus running costs and upkeep, over the outlay (focus and network effects on top)
    const opts: { score: number; kind: ProjectKind; towns: number[]; share?: [number, number, number, number]; hub?: number; join?: number; urbanLayout?: UrbanLayout; viable?: boolean }[] = [];
    const operating = this.operatingTowns(), hq = g.headquartersOf(this.companyId)?.id;
    const D = yield* this.townDemand();
    // fares with the value of time (fares.ts): ~60% of the top speed on average, waiting half the headway (by
    // default a service about as often as its one-way run takes)
    // (road projects: what the buses they carry earn, with the bus boarding charge)
    const fareAt = (d: number, kmh: number, headwaySec?: number) => estimateLegFare(d, kmh * 0.6, headwaySec ?? estimateLegTime(d, kmh * 0.6, 0), 1, 1.15, true, true, { mode: 'bus' });
    // return on the outlay, compressed (sqrt) so that cheap projects do not crowd out everything else, plus a
    // little for doing what the company likes; focus weights count squared (personalities differ clearly);
    // existing lines on the same towns share the demand
    const roi = (revenue: number, yearly: number, outlay: number) => Math.sqrt(Math.max(0, (revenue - yearly) / Math.max(1, outlay))) + 0.15;
    const fw = (f: number) => f * f;
    const served = this.servedPairs();
    const share = (a: number, b: number) => 1 / (1 + (served.get(this.pairKey(a, b)) ?? 0));
    // intercity railways: preferably extending our network from a station we have (hubs and branches)
    const railModels = pickTrain(g.year, aiPlatformLength(2000, 2000, g.year), 150, 3) ?? [];
    if (focus.rail > 0 && considers(focus.rail) && avail > 3_000_000 && railModels.length) {
      const townFails = this.railTownFailures();
      const rivals = this.rivalRailPairs();
      const T = g.towns.list;
      railPairs: for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        if (A.pop < 250 || B.pop < 250 || Math.abs(A.x - B.x) > 250 || Math.abs(A.z - B.z) > 250) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 60 || d > 250) continue;
        if (this.isFailed(this.pairKey(A.id, B.id)) || own.some((l) => l.kind === 'rail' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        const trips = D.pair(A.id, B.id);
        // no copy of a rival's railway between the same towns unless demand is large (trains on it under track access are cheaper)
        if (rivals.has(this.pairKey(A.id, B.id)) && trips < 250) continue;
        const freeA = this.hubFor(A, B), freeB = freeA ? null : this.hubFor(B, A);
        const branchA = !freeA && !freeB ? this.branchStation(A, B) : null;
        const branchB = !freeA && !freeB && !branchA ? this.branchStation(B, A) : null;
        const hubA = freeA ?? branchA, hubB = freeB ?? branchB;
        const hub = freeA ?? freeB, joined = branchA ?? branchB;
        const hubRails = [hubA?.rail, hubB?.rail], hubOwners = [hubA?.owner, hubB?.owner];
        const hubsLive = () => [hubA, hubB].every((st, k) => !st || this.railHubLive(st, hubRails[k], hubOwners[k]));
        const len = d * 1.3, L = aiPlatformLength(A.pop, B.pop, g.year);
        const trackCost = len * 13_000;
        const infrastructure = trackCost + (hub || joined ? 1 : 2) * (2 * L * 9000 + 120_000) + 260_000;
        // a corridor alongside existing rail (any owner) mostly shares that line's passengers and its valley:
        // revenue shared, and the project marked down hard (reusing the line is the better option, see shareOptions)
        const overlap = corridorOverlap(g, A.x, A.z, B.x, B.z, Math.min(30, d / 4));
        // two trains of the year (opcosts / fares estimates: their trips, fares by the time they take, running costs
        // and the track's upkeep), carrying what the demand gives
        const models = pickTrain(g.year, L, len, openingCoaches(A.pop, B.pop)) ?? railModels;
        yield;
        if (!hubsLive()) continue railPairs;
        const sites: (ForecastSite | Station)[] = [];
        for (const t of [A, B]) {
          const h = t === A ? hubA : hubB;
          if (h) {
            // Keep station identity and links: this hub is not a competing anonymous stop.
            sites.push(h);
          } else {
            // A ground platform and its leads need space on the approaching side of town.
            // A centre point overstates the walks before a station site has been proved.
            const other = t === A ? B : A, off = Math.min(t.radius / 4, L / 2 + LEAD);
            const x = t.x + (other.x - t.x) * off / d, z = t.z + (other.z - t.z) * off / d;
            sites.push({ x, z, townId: t.id, length: L, tracks: 2, walk: pointWalkingCatchment(g, x, z, 'rail', 0, 8) });
          }
          yield;
          if (!hubsLive()) continue railPairs;
        }
        let score = 0;
        for (const fleet of [1, 2]) {
          const sv = this.serviceYear(models, fleet, d, len);
          yield;
          if (!hubsLive()) continue railPairs;
          const forecast = g.demand.forecastLine(sites, 'mainline', sv.kmh, sv.headway, this.companyId);
          const mail = projectMail(g, sites, models, fleet, sv.kmh, sv.headway, L);
          const revenue = (forecast.revenue * Math.min(1, sv.seats / Math.max(1, forecast.boardings)) + 0.7 * mail.revenue) * share(A.id, B.id) * (1 - 0.5 * overlap);
          const outlay = infrastructure + fleet * (models.reduce((s, m) => s + m.cost, 0) + mail.price);
          if (outlay <= avail) {
            // Conventional civil works have the same long life used by the detailed opening forecast.
            // Rank surplus after the same capital allowance as the opening gate. Otherwise ideal
            // centre walks can keep speculative rail ahead of services that can actually open.
            const amortisation = 0.045 - 0.03 * this.config.risk;
            const years = 1 / (0.03 + amortisation), capital = outlay * 0.03 + infrastructure * amortisation;
            const upkeep = (hub || joined ? 1 : 2) * (20_000 + 2 * L * 500) + 12_000 + trackCost * 0.01;
            if (revenue <= sv.running + mail.yearly + sv.trackUpkeep + upkeep + capital) continue;
            score = Math.max(score, roi(revenue, sv.running + mail.yearly + sv.trackUpkeep + upkeep + capital, outlay) * years / 9);
          }
        }
        score *= Math.max(0.05, 1 - 1.4 * overlap);
        // towns where railways keep failing (no station site in a dense centre, crowded corridors): try others
        score *= Math.pow(0.6, (townFails.get(A.id) ?? 0) + (townFails.get(B.id) ?? 0));
        if (rivals.has(this.pairKey(A.id, B.id))) score *= 0.4;
        // the new line feeds our network: through trains when it continues one of our lines (a multi-town line);
        // from another company's station (open access) our trains continue its line
        // Connection preference is a separate tier; native forecasts price transfers and saved capital.
        // a town beyond (a corridor the line can continue along later)
        if (!hub && !joined && (this.townBeyond(A, B) || this.townBeyond(B, A))) score *= 1.25;
        opts.push({ score: score * (railLines === 0 ? 1.3 : 1) * fw(focus.rail), kind: 'rail', towns: joined ? branchA ? [B.id, A.id] : [A.id, B.id] : hubB ? [B.id, A.id] : [A.id, B.id], hub: hub?.id, join: joined?.id });
      }
    }
    // cross-city links (9k): in a big town where two of our main lines end from different sides, an underground
    // link through a city-centre station joins them into one through line, where the through trips pay for it
    if (focus.rail > 0 && avail > 3_000_000) {
      for (const T of g.towns.list) {
        if (T.pop < AIController.centrePop || this.isFailed('xcity' + T.id)) continue;
        const pair = this.crossCityPair(T);
        if (!pair) continue;
        const [a, b] = pair;
        const e = this.crossCityEconomics(T, a, b);
        if (!e.viable) continue;
        const score = roi(e.revenue * e.share, e.yearly * e.share, e.cost * e.share);
        opts.push({ score: score * fw(focus.rail), kind: 'crosscity', towns: [T.id] });
      }
    }
    // high-speed railways (9j): between big towns far apart, where the long-distance demand pays for the double
    // wide alignments and the costly HSR units (fares by the time saved, running costs at speed; opcosts / fares)
    const hsUnit = focus.rail > 0 && avail > 20_000_000 ? this.hsrUnit() : null;
    if (hsUnit) {
      const T = g.towns.list;
      const PL = Math.max(12, Math.ceil(hsUnit.length + 1));
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        if (A.pop < 2500 || B.pop < 2500) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 170 || d > 480 || this.isFailed('hsr' + this.pairKey(A.id, B.id)) || own.some((l) => l.hsr && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        const len = d * 1.2;
        const sv = this.serviceYear([hsUnit], 2, d, len, 'electric', 0.7);
        yield;
        const sites: ForecastSite[] = [];
        for (const t of [A, B]) {
          sites.push({ x: t.x, z: t.z, townId: t.id, walk: pointWalkingCatchment(g, t.x, t.z, 'rail', 0, 8) });
          yield;
        }
        const forecast = g.demand.forecastLine(sites, 'mainline', sv.kmh, sv.headway);
        const revenue = forecast.revenue * Math.min(1, sv.seats / Math.max(1, forecast.boardings)) * share(A.id, B.id);
        const outlay = len * 2 * TRACK_TYPES.electric.costPerUnit * 1.5 + 2 * (PL * 2 * 12_000 + 300_000) + 2 * hsUnit.cost;
        const score = roi(revenue, sv.running + sv.trackUpkeep * 2 + 120_000, outlay);
        opts.push({ score: score * fw(focus.rail), kind: 'hsr', towns: A.pop >= B.pop ? [A.id, B.id] : [B.id, A.id] });
      }
    }
    // a corridor to continue (the town beyond the end of a line we just opened): a line through several towns
    const cor = this.state.corridor;
    if (cor && focus.rail > 0 && avail > 2_500_000) {
      const st = g.stations.get(cor[0]), C = g.towns.list[cor[1]];
      const B = st ? g.towns.list[st.townId] : undefined;
      if (st && B && C && st.owner === this.companyId && this.hubFor(B, C) === st && !this.isFailed(this.pairKey(B.id, C.id))) {
        // Continuing our network still has its own stations, track and fleet to repay. Prefer its
        // affordable quotation, rather than borrowing the score of an unrelated railway.
        const continuation = opts.find((o) => o.kind === 'rail' && o.hub === st.id && o.score > 0
          && o.towns.includes(B.id) && o.towns.includes(C.id));
        if (continuation) continuation.score *= 1.2;
        else this.state.corridor = undefined;
      } else this.state.corridor = undefined;
    }
    // trains on another company's railway (track access): much cheaper than building
    if (focus.rail > 0 && avail > 1_800_000) this.shareOptions(opts, own, D);
    // long-distance coaches over the country roads between towns
    const coach = pickCoach(g.year);
    if (focus.road > 0 && avail > 900_000 && coach) {
      const T = g.towns.list;
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        if (A.pop < 300 || B.pop < 300 || Math.abs(A.x - B.x) > 220 || Math.abs(A.z - B.z) > 220) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 220 || this.isFailed('coach' + this.pairKey(A.id, B.id))) continue;
        if (own.some((l) => l.kind !== 'tram' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        // no third service between the same towns unless demand is large
        const trips = D.pair(A.id, B.id);
        if ((served.get(this.pairKey(A.id, B.id)) ?? 0) >= (trips > 300 ? 3 : 2)) continue;
        // two coaches of the year (opcosts / fares estimates, as for the railways)
        const sv = this.serviceYear([coach!], 2, d, d * 1.3, 'road');
        const carried = Math.min(D.pair(A.id, B.id) * 0.25 * 12 * share(A.id, B.id), sv.seats);
        const score = roi(carried * sv.perPax, sv.running + 12_000, 700_000);
        opts.push({ score: score * fw(focus.road), kind: 'coach', towns: [A.id, B.id], viable: carried * sv.perPax > sv.running + 12_000 && 700_000 <= avail });
      }
    }
    // town buses in larger towns (between their districts), few lines per town
    if (focus.road > 0 && avail > 900_000) {
      for (const T of g.towns.list) {
        if (T.pop < BUS_MIN_POP || this.isFailed('bus' + T.id) || own.some((l) => l.kind === 'bus' && l.towns.length === 1 && l.towns.includes(T.id)) || !this.localRoom(T)) continue;
        // three buses of the year between the town's districts (opcosts / fares estimates)
        const bm = pickBus(g.year, T.pop);
        const sv = bm ? this.serviceYear([bm], 3, 22, 26, 'street') : null;
        const score = sv ? roi(Math.min(D.local(T.id) * 0.3 * 12, sv.seats) * sv.perPax, sv.running + 15_000, 650_000) : 0;
        opts.push({ score: score * (busLines === 0 ? 1.15 : 1) * fw(focus.road), kind: 'bus', towns: [T.id], hub: this.busInterchange(T),
          viable: !!sv && Math.min(D.local(T.id) * 0.3 * 12, sv.seats) * sv.perPax > sv.running + 15_000 && 650_000 <= avail });
      }
    }
    // Compare affordable stages of a city railway: a small light-rail-style opening first, or a subway where the
    // capacity repays the tunnels over their discounted civil life. Both are ordinary rail (one catchment, fare and forecast model;
    // the style picks track, level, platforms and spacing). Preview uses real pedestrian routes, never a town fraction.
    const pricedOpening = own.length === 0 && opts.some((o) => o.score > 0 && o.viable !== false && (!operating.size && hq !== undefined ? o.towns.includes(hq) : true) && considers(
      o.kind === 'rail' || o.kind === 'share' || o.kind === 'hsr' || o.kind === 'crosscity' ? focus.rail : focus.road));
    // Start from already priced openings. Later selections compare one detailed city opportunity,
    // rather than blocking every route behind a survey of every town and construction style.
    if (!pricedOpening && (focus.rail > 0 || focus.tram > 0) && TRACK_TYPES.electric) {
      const urbanIn = new Map<number, number>();
      for (const l of g.lines.map.values()) {
        if (l.kind !== 'rail') continue;
        const towns = new Set<number>();
        for (const sid of l.stops) { const st = g.stations.get(sid); if (st?.rail && railPartMode(st.rail) !== 'mainline' && st.townId >= 0) towns.add(st.townId); }
        for (const t of towns) urbanIn.set(t, (urbanIn.get(t) ?? 0) + 1);
      }
      const cityOpportunities: { town: Town; mode: 'lightrail' | 'metro' }[] = [];
      for (const T of g.towns.list) {
        if (T.pop < AIController.urbanPop || this.isFailed('urban' + T.id) || own.some((l) => l.urban && l.towns.includes(T.id))) continue;
        if (this.urbanReserved(T.id) || (urbanIn.get(T.id) ?? 0) >= (T.pop >= 6000 ? 3 : 1)) continue;
        for (const mode of ['lightrail', 'metro'] as const) {
          // Price each construction style independently. A failed surface proposal says little
          // about a subway, and population alone does not decide whether its investment pays.
          if (this.isFailed('urban' + mode + T.id)) continue;
          if (!considers(mode === 'metro' ? focus.rail : Math.max(focus.rail, focus.tram))) continue;
          cityOpportunities.push({ town: T, mode });
        }
      }
      const cursor = this.state.urbanSearchCursor ?? this.companyId - 1;
      const home = !operating.size ? cityOpportunities.filter(o => o.town.id === hq) : [];
      const candidates = home.length ? home : cityOpportunities;
      const opportunity = candidates[cursor % Math.max(1, candidates.length)];
      for (const { town: T, mode } of opportunity ? [opportunity] : []) {
          // Advance before yielding so a reload does not endlessly restart the same long valuation.
          this.state.urbanSearchCursor = (cursor + 1) % candidates.length;
          yield;
          const layout = yield* this.urbanStep(T, mode), unit = this.urbanUnit(mode, this.urbanPlatform(mode));
          if (!unit) continue;
          // Reuse the stage's planned entrances and costs. Replacing them with point sites here loses
          // walkers and can reject a profitable alignment before the detailed job gets to prove it.
          const econ = layout.quote;
          const years = urbanPayback(mode, this.eco.interestRate);
          if (!econ || econ.total * 1.05 > this.urbanAvailable() || econ.net * years < econ.total) continue;
          const score = roi(econ.forecast.revenue, econ.yearly + econ.total / years, econ.total) * years / 4.5;
          if (score > 0) {
            const { quote: _, ...handoff } = layout;
            opts.push({ score: score * Math.max(fw(focus.rail), fw(focus.tram)), kind: mode, towns: [T.id],
              urbanLayout: { ...handoff, targets: [...handoff.targets], interchanges: handoff.interchanges.map(s => s.id),
                ...(handoff.towns ? { towns: [...handoff.towns] } : {}) } });
          }
      }
    }
    // tram lines in big towns (ai-tram.ts)
    if (focus.tram > 0 && avail > 1_500_000 && !this.isFailed('tram')) {
      const tp = this.tramPlanner();
      if (tp.available()) {
        const town = tramExt(tp).candidates?.()[0];
        if (town && this.localRoom(town)) {
          const tm = availableModels(g.year, 'tram').sort((a, b) => b.capacity / b.cost - a.capacity / a.cost)[0];
          const sv = tm ? this.serviceYear([tm], 3, 25, 28, 'street') : null;
          const score = sv ? roi(Math.min(D.local(town.id) * 0.45 * 12, sv.seats) * sv.perPax, sv.running + 60_000, 2_200_000) : 0;
          opts.push({ score: score * (tramLines === 0 ? 1.15 : 1) * fw(focus.tram), kind: 'tram', towns: [town.id],
            viable: !!sv && Math.min(D.local(town.id) * 0.45 * 12, sv.seats) * sv.perPax > sv.running + 60_000 && 2_200_000 <= avail });
        }
      }
    }
    // occasionally a country road between neighbouring towns (for coaches)
    if (focus.road > 0 && avail > 2_000_000 && this.rng.chance(Math.min(0.5, 0.15 * act))) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id || this.isFailed('road' + this.pairKey(A.id, B.id))) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 130) continue;
        opts.push({ score: 0.6 * roi(D.pair(A.id, B.id) * 0.2 * 12 * fareAt(d, 90), 80_000, 1_200_000 + d * 4000) * fw(focus.road), kind: 'road', towns: [A.id, B.id],
          viable: D.pair(A.id, B.id) * 0.2 * 12 * fareAt(d, 90) > 80_000 && 1_200_000 + d * 4000 <= avail });
      }
    }
    // a company with a clear favourite saves up for it rather than spending on kinds it barely cares for (unless
    // it has opened nothing for a year)
    const wOf = (k: ProjectKind) => fw(k === 'rail' || k === 'share' || k === 'metro' || k === 'hsr' || k === 'crosscity' ? focus.rail : k === 'lightrail' ? Math.max(focus.rail, focus.tram) : k === 'tram' ? focus.tram : focus.road);
    const wMax = Math.max(fw(focus.rail), fw(focus.road), fw(focus.tram));
    const lastOpened = own.reduce((a, l) => Math.max(a, l.opened), 0);
    const restless = g.day - lastOpened > 360;
    for (let i = opts.length - 1; i >= 0; i--) if (!(opts[i].score > 0) || (!restless && wOf(opts[i].kind) < 0.1 * wMax)) opts.splice(i, 1);
    if (!opts.length) { this.state.phase = 'idle'; this.state.cooldown = Math.round(15 / act); return; }
    // one of the best few, the better ones (squared score) much more likely
    opts.sort((a, b) => b.score - a.score);
    if (AIController.profile) this.lastOptions = opts.map((o) => ({ kind: o.kind, towns: o.towns, score: o.score }));
    // Home openings get first consideration when affordable and viable. Later growth joins actual served facilities.
    const preferred = opts.filter(o => o.viable !== false && (!operating.size && hq !== undefined ? o.towns.includes(hq)
      : (o.hub ?? o.join) !== undefined && g.lines.stationServed((o.hub ?? o.join)!) || !!o.urbanLayout?.interchanges.some(id => g.lines.stationServed(id))));
    const top = (preferred.length ? preferred : opts).slice(0, 4);
    let r = this.rng.next() * top.reduce((a, o) => a + o.score * o.score, 0), pick = top[0];
    for (const o of top) { r -= o.score * o.score; if (r <= 0) { pick = o; break; } }
    if (pick.kind === 'tram') {
      if (!this.startTram(pick.towns[0])) { this.markFailed('tram', 120); this.state.cooldown = 20; }
      return;
    }
    const towns = pick.towns.map((id) => g.towns.list[id]);
    this.project = { kind: pick.kind, towns: pick.towns, stations: [], edges: [], depots: [], line: -1, started: g.day,
      ...(pick.urbanLayout ? { urbanLayout: pick.urbanLayout } : {}) };
    // A reused rail hub stays first; fresh corridors build the HQ station before their other endpoint.
    const originTowns = towns[1]?.id === hq ? [towns[1], towns[0]] : towns;
    const railEnds = pick.kind !== 'rail' && pick.kind !== 'hsr' || pick.hub !== undefined || pick.join !== undefined ? towns
      : towns[1]?.id === hq ? [towns[1], towns[0]]
      : towns[0]?.id === hq || towns[0].pop >= towns[1].pop ? towns : [towns[1], towns[0]];
    this.job = pick.kind === 'rail' ? this.railJob(railEnds[0], railEnds[1], pick.hub ?? -1, 'standard', true, pick.join ?? -1)
      : pick.kind === 'hsr' ? this.railJob(railEnds[0], railEnds[1], -1, 'highspeed')
      : pick.kind === 'crosscity' ? this.crossCityJob(towns[0])
      : pick.kind === 'share' ? this.shareJob(pick.share![0], pick.share![1], pick.share![2], pick.share![3])
      : pick.kind === 'coach' ? this.coachJob(originTowns[0], originTowns[1])
      : pick.kind === 'metro' || pick.kind === 'lightrail' ? this.urbanJob(towns[0], pick.kind)
      : pick.kind === 'bus' ? this.busJob(towns[0]) : this.roadJob(originTowns[0], originTowns[1]);
    this.state.projects++;
  }

  private endProject() {
    const p = this.project;
    this.project = null;
    this.splitPieces.clear();
    this.state.phase = 'idle';
    const act = this.config.activeness;
    this.state.cooldown = p && p.line >= 0 ? Math.round((14 + this.rng.int(21)) / act)
      : p && !p.built ? Math.round((4 + this.rng.int(8)) / Math.sqrt(act)) : Math.round((20 + this.rng.int(20)) / Math.sqrt(act));
  }

  /** Cancel both running work and the saved cursor, even when generator/project cleanup throws. */
  private cancelJob() {
    const double = this.state.doubleJob;
    try { this.job?.return(undefined); if (this.project) this.abandon(this.project); }
    finally {
      const info = double ? this.lines.get(double.line) : undefined;
      if (info && double?.finishFailed?.length) info.doubleFinish = [...new Set(double.finishFailed)];
      this.project = null; this.job = null; this.urbanTask = null; this.urbanSurvey = null; this.accessTask = null; delete this.state.through; delete this.state.doubleJob;
    }
  }

  /** Remove what an unfinished project built. */
  private abandon(p: Project) {
    delete this.state.through;
    const g = this.game;
    if (p.kind === 'tram') { this.tram?.cleanup(); return; }
    // A usable railway survives interruption before its first train is bought; registering a two-stop draft
    // alone does not complete it. Otherwise a failed depot search leaves an empty line attracting upgrades.
    const live = p.line >= 0 ? g.lines.get(p.line) : undefined;
    const stops = live ? [...new Set(live.stops)] : [];
    const depots = [this.lines.get(live?.id ?? -1)?.depot ?? -1, ...p.depots];
    const ready = stops.length >= 2 && depots.some(id => {
      const depot = g.depots.get(id);
      return !!depot && depotServes(g, depot, stops[0], stops[1]) >= 0;
    });
    if (live?.kind === 'rail' && stops.length >= 2 && (live.vehicles.length > 0 || ready)) {
      this.adoptLines(true);
      this.note(`kept ${live.name} after interrupted works`);
      return;
    }
    if (p.line >= 0) {
      const l = g.lines.get(p.line);
      if (l) { for (const vid of [...l.vehicles]) g.vehicles.sell(vid); g.lines.delete(l.id); }
      this.lines.delete(p.line);
    }
    for (const d of p.depots) g.depots.remove(d);
    removeEdges(g, p.edges.filter((id) => g.world.net.edges.get(id)?.owner === this.companyId), this.companyId);
    if (p.joint) {
      removeEdges(g, p.edges.filter((id) => g.world.net.edges.get(id)?.owner === p.joint!.partner), p.joint.partner);
      // Construction is a joint investment: return the partner's contribution on an interrupted/failed build.
      const partner = g.companies[p.joint.partner];
      if (partner && p.joint.spent[1] > 0) partner.economy.spend(-p.joint.spent[1], 'construction', true);
      p.joint.spent[1] = 0;
    }
    for (const s of p.stations) { const st = g.stations.get(s); if (st && st.owner === this.companyId) g.stations.removeStation(s); }
    p.edges = []; p.stations = []; p.depots = [];
    if (p.access !== undefined && p.access >= 0) { g.cancelAccessRequest(this.companyId, p.access); this.endUnusedAccess(p.access); p.access = -1; }
  }

  /** Record edges created since `fromId` (owned by this company) in the current project. */
  private track(fromId: number) {
    const p = this.project, net = this.game.world.net;
    if (!p) return;
    for (let id = fromId; id < net.nextEdge; id++) {
      const e = net.edges.get(id);
      // (the halves of older track that the works cut in two are not the project's: see splitListener)
      if (e && (e.owner === this.companyId || e.owner === p.joint?.partner) && !p.edges.includes(id) && !this.splitPieces.has(id)) p.edges.push(id);
    }
  }

  private borrowFor(amount: number) {
    const e = this.eco;
    while (e.money < amount + 300_000 && e.borrow()) { /* borrow in steps */ }
    return e.money >= amount;
  }

  // ---------------------------------------------------------------- rail
  /**
   * Our rail station in town T whose platform ends towards `toward` are all free (a hub a new line can start from),
   * with its axis pointing roughly that way.
   */
  hubFor(T: Town, toward: P2): Station | null {
    const g = this.game, net = g.world.net, me = this.companyId;
    // ours first; else another AI company's whose network is open to ours and ours to it (mutual open access: our track
    // joins its station; never the player's) — its line can be continued by our trains
    let foreign: Station | null = null;
    for (const st of g.stations.map.values()) {
      if (st.townId !== T.id || !st.rail) continue;
      const mine = st.owner === me;
      if (!mine && (foreign || !this.agrees(st.owner))) continue;
      const r = st.rail, ax = Math.sin(r.angle), az = Math.cos(r.angle);
      const dx = toward.x - st.x, dz = toward.z - st.z, dl = Math.hypot(dx, dz) || 1;
      const along = (ax * dx + az * dz) / dl;
      if (Math.abs(along) < 0.55) continue; // the line would have to turn too sharply
      const ends = stationEnds(g, st).map((e) => (along > 0 ? e.front : e.back));
      if (!ends.length || !ends.every((id) => net.nodes.get(id)?.edges.length === 1)) continue;
      if (mine) return st;
      foreign = st;
    }
    return foreign;
  }

  /** A paid station approached by an existing railway: build a real junction, not a duplicate town terminus. */
  private branchStation(T: Town, toward: P2): Station | null {
    let best: Station | null = null, distance = Infinity;
    for (const st of this.game.stations.map.values()) {
      if (st.townId !== T.id || !st.rail || railPartMode(st.rail) !== 'mainline' || !this.railHubLive(st)
        || !this.game.lines.stationServed(st.id) || !this.approachJunctions(st, toward).length) continue;
      const d = Math.hypot(st.x - toward.x, st.z - toward.z);
      if (d < distance) { best = st; distance = d; }
    }
    return best;
  }

  /**
   * Mutual open access with another AI company: both networks open to each other (never the player, whose track the AI
   * does not alter). The standing consent for joint track works, as the network planner's (ai-network.ts agrees).
   */
  private agrees(other: number): boolean {
    const g = this.game, me = this.companyId, co = g.companies[other];
    return other === me || (other > 0 && !!co?.ai && !co.defunct && g.accessPolicy(me) === 'open' && g.accessPolicy(other) === 'open'
      && g.canUse(me, other) && g.canUse(other, me));
  }

  /** A yielded planner may have kept an object replaced, merged or rebuilt by another controller. */
  private railHubLive(st: Station, rail = st.rail, owner = st.owner, access = true): boolean {
    return this.game.stations.get(st.id) === st && !!st.rail && st.rail === rail && st.owner === owner
      && this.agrees(st.owner) && (!access || this.game.stations.hasAccess(st));
  }

  /** The exact supported own terminus which the final builder may extend; patterned services stay separate. */
  private railExtensionAt(st: Station | null, other = -1): [number, LineInfo] | undefined {
    if (!st || st.owner !== this.companyId) return undefined;
    return [...this.lines].find(([id, info]) => {
      const l = this.game.lines.get(id), path = l && linearStops(l.stops);
      return l?.owner === this.companyId && !l.patterns?.length && !l.operators?.length && info.kind === 'rail'
        && !info.hsr && info.shared === undefined && !info.urban && !!path
        && (path[0] === st.id || path[path.length - 1] === st.id) && !path.includes(other);
    });
  }

  /** Preserve every physical member ID in the proposed through itinerary; complex walking links are not rail links. */
  private railItinerary(a: StationPlan | Station, b: StationPlan | Station, hubA: Station | null, hubB: Station | null) {
    const extA = this.railExtensionAt(hubA, 'id' in b ? b.id : -1), extB = extA ? undefined : this.railExtensionAt(hubB, 'id' in a ? a.id : -1);
    const extension = extA ?? extB, at = extA ? hubA : hubB;
    const foreignA = !extension && hubA?.owner !== this.companyId && hubA ? this.foreignRouteTo(hubA) : null;
    const foreign = foreignA ?? (!extension && hubB?.owner !== this.companyId && hubB ? this.foreignRouteTo(hubB) : null);
    let ids = extension ? linearStops(this.game.lines.get(extension[0])!.stops)! : foreign?.path;
    if (!ids) return { points: [a, b], old: [] as Station[], extension, foreign };
    ids = [...ids];
    if (extension && ids[0] === at?.id) ids.reverse();
    const old = ids.map(id => this.game.stations.get(id)).filter((s): s is Station => !!s);
    const added = extA || foreignA ? b : a;
    if ('id' in added && ids.includes(added.id)) return { points: [a, b], old: [] as Station[], extension: undefined, foreign: null };
    return { points: [...old, added], old, extension, foreign };
  }

  /** Full-body native arrival and return on existing paid legs, without stock allocation or ignored track rights. */
  private quotedRailLeg(a: Station, b: Station, cars: VehicleModel[]): number[] | null {
    const g = this.game, rule = consistRule(cars), length = cars.reduce((n, c) => n + c.length + .1, 0);
    let best: ReturnType<typeof findRailRoute> = null;
    for (const group of g.stations.railTrackGroups(a)) {
      if (group.length < length) continue;
      for (const steps of [group.steps, [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }))]) {
        const frontier = platformDepartureFrontiers(g, steps, this.companyId, rule, length);
        const found = findRailRoute(g, [...frontier.forward, ...frontier.reverse], b.id, this.companyId, -1, 15000, false, rule, true, { length, onward: a.id });
        if (found && (!best || found.cost < best.cost)) best = found;
      }
    }
    return best ? best.conts.map(c => c.edge.id) : null;
  }

  /** Native per-leg operating estimates include intermediate stops instead of pricing one short endpoint hop. */
  private railCycle(cars: VehicleModel[], lengths: number[], speedCap = Infinity) {
    const cap = Math.min(speedCap, ...cars.map(c => c.speed));
    const legs = lengths.map(len => { const year = estimateVehicleYear(cars, len / 1.15, this.game.year, .4, cap); return { len, year, seconds: YEAR_S / year.trips }; });
    const seconds = legs.reduce((n, l) => n + l.seconds, 0), length = lengths.reduce((n, l) => n + l, 0);
    return { seconds, seats: YEAR_S / seconds * cars.reduce((n, c) => n + c.capacity, 0) * .4,
      running: legs.reduce((n, l) => n + l.year.total * l.seconds / seconds, 0),
      wear: legs.reduce((n, l) => n + l.len * l.year.trackWearPerUnit * l.seconds / seconds, 0),
      kmh: length * UNIT_M / 1000 / (seconds / 3600) };
  }

  /** Foreign infrastructure's native sole-user upkeep bound: no free through-running or invented fee discount. */
  private railFeeBound(points: (StationPlan | Station)[], rails: Set<number>): number {
    const g = this.game, owners = new Map<number, number>();
    for (const st of points) if ('id' in st && st.owner !== this.companyId && g.accessMultiplier(st.owner) > 0)
      owners.set(st.owner, (owners.get(st.owner) ?? 0) + g.stationMaintenance(st));
    for (const id of rails) { const e = g.world.net.edges.get(id); if (e && e.owner !== this.companyId && e.owner >= 0 && g.accessMultiplier(e.owner) > 0)
      owners.set(e.owner, (owners.get(e.owner) ?? 0) + g.edgeMaintenance(e)); }
    return [...owners.values()].reduce((n, upkeep) => n + upkeep, 0);
  }

  /** Stations (in order, ending at `st`) of another company's railway line that ends at `st` (out and back), and that line. */
  private foreignPathTo(st: Station): number[] | null { return this.foreignRouteTo(st)?.path ?? null; }
  private foreignRouteTo(st: Station): { line: number; path: number[] } | null {
    for (const l of this.game.lines.map.values()) {
      if (l.kind !== 'rail' || l.owner === this.companyId || l.owner !== st.owner) continue;
      const path = linearStops(l.stops);
      if (!path) continue;
      if (path[path.length - 1] === st.id) return { line: l.id, path };
      if (path[0] === st.id) return { line: l.id, path: path.reverse() };
    }
    return null;
  }

  /**
   * A through station on one of our railway lines where it passes a town without a stop (trackops
   * planStationOnTrack, where there): the line then stops there too (between its neighbouring stations).
   */
  private addIntermediateStation(): boolean {
    const T = Trackops as unknown as {
      planStationOnTrack?: (g: Game, edgeId: number, s: number, o: { length?: number; tracks?: number }, owner: number) => { ok: boolean; error?: string; cost: number };
      commitStationOnTrack?: (g: Game, plan: unknown) => { error: string | null; station: number };
    };
    if (!T.planStationOnTrack || !T.commitStationOnTrack) return false;
    const g = this.game, net = g.world.net, me = this.companyId;
    const q = { x: 0, y: 0, z: 0 };
    // one line per call (routing its stretches is the costly part)
    const rails = [...this.lines].filter(([lid, info]) => info.kind === 'rail' && info.shared === undefined && !!g.lines.get(lid));
    if (!rails.length) return false;
    for (const [lid, info] of [rails[this.rng.int(rails.length)]]) {
      const l = g.lines.get(lid);
      const path = l && l.id === lid ? linearStops(l.stops) : null;
      if (!l || !path) continue;
      const served = new Set(path.map((sid) => g.stations.get(sid)?.townId ?? -1));
      // our track between consecutive stations, and the towns it passes within reach of a station
      for (let i = 0; i + 1 < path.length; i++) {
        const a = g.stations.get(path[i]), b = g.stations.get(path[i + 1]);
        if (!a?.rail || !b?.rail) continue;
        let route: NEdge[] | null = null;
        for (const eid of a.rail.edges) {
          const e = net.edges.get(eid);
          if (!e || route) continue;
          for (const d of [1, -1]) { const r = findRailRoute(g, railNext(g, e, d, me), b.id, me, -1, 20000); if (r) { route = r.conts.map((c) => c.edge); break; } }
        }
        if (!route) continue;
        for (const town of g.towns.list) {
          if (served.has(town.id) || town.pop < 500 || info.triedStops?.includes(town.id)) continue;
          // the nearest point of the line to the town centre (our plain track, away from the stations)
          let best: { e: NEdge; s: number; d: number } | null = null;
          for (const e of route) {
            if (e.owner !== me || e.station >= 0 || e.len < 6) continue;
            for (let s2 = 3; s2 <= e.len - 3; s2 += 3) {
              net.pointAt(e, s2, q);
              const d = Math.hypot(q.x - town.x, q.z - town.z);
              if (!best || d < best.d) best = { e, s: s2, d };
            }
          }
          const reach = walkLimit('rail');
          if (!best || best.d > town.radius + reach || (a.townId === town.id && Math.hypot(a.x - town.x, a.z - town.z) < reach)
            || (b.townId === town.id && Math.hypot(b.x - town.x, b.z - town.z) < reach)) continue;
          net.pointAt(best.e, best.s, q);
          if (walkSitePop(g, q.x, q.z, 'mainline') < 80) continue;
          // two platform tracks: on a single track the station is a passing loop too
          const plan = T.planStationOnTrack(g, best.e.id, best.s, { length: aiPlatformLength(town.pop, Math.max(a.catchPop, b.catchPop), g.year), tracks: 2 }, me);
          if (!plan.ok) { (info.triedStops ??= []).push(town.id); this.note(`no station site at ${town.name} on ${l.name}: ${plan.error ?? ''}`); continue; }
          if (plan.cost > this.available() * 0.3 || !this.borrowFor(plan.cost)) continue;
          const res = T.commitStationOnTrack(g, plan);
          if (res.error === 'busy') return false;
          if (res.station < 0 || !g.stations.get(res.station)) { this.note(`station at ${town.name} on ${l.name} failed: ${res.error ?? ''}`); continue; }
          const np = [...path.slice(0, i + 1), res.station, ...path.slice(i + 1)];
          l.stops = outAndBack(np);
          info.towns = [...new Set([...info.towns, town.id])];
          info.maxVehicles = Math.max(info.maxVehicles, Math.min(6, np.length + 1));
          g.lines.rebuild();
          for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
          const st = g.stations.get(res.station)!;
          this.linkTransfers(st.id);
          this.signalLine(lid);
          this.canonical(lid);
          this.stats.railStations++;
          this.stats.multiTown = Math.max(this.stats.multiTown, np.length);
          g.postNews(`${this.name} opens a station at ${town.name} on ${l.name}.`, 'ai', st.x, st.z);
          this.note(`station ${st.name} on ${l.name}${res.error ? ' (' + res.error + ')' : ''}`);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Trains stuck or waiting long on one of our railway lines: a step of the response each month while it lasts —
   * signals and platforms, then a complete second track valued against recoverable passenger income. Loops
   * are temporary; a cut follows completion or a demonstrated geometric failure, never a cash deferral.
   */
  private relieveCongestion(l: Line, info: LineInfo): boolean {
    // capacity-integration: partners and the lead use the same corridor response, even after canonical merges.
    if (usesSharedRail(this.game, l)) return this.relieveSharedCapacity(l);
    const g = this.game, me = this.companyId;
    const c = lineCongestion(g, l.id);
    if (!info.double && (info.loops || info.doubleValue) && !this.job && g.day >= (info.upgradeRetry ?? 0)) {
      const recent = (info.doubleValue ?? 0) * Math.max(0, 1 - (g.day - (info.doubleSince ?? g.day)) / 720);
      const value = Math.max(recent, congestionReturn(g, l));
      // Loops may relieve the immediate wait. Complete their formation when the still-recent loss estimate
      // pays for its remaining pieces, rather than requiring the congestion detector to fire again.
      if (value > 0 && this.available() > 500_000) { this.startDouble(l, info, value); return true; }
    }
    if (c.level < 2) { if (c.level === 0) info.congestion = undefined; return false; }
    if (g.day - (info.congestionDay ?? -1e9) < 30) return false;
    info.congestionDay = g.day;
    const step = info.congestion ?? 0;
    if (step < 1) {
      info.congestion = 1;
      const n = this.signalLine(l.id);
      this.note(`${l.name} congested: ${n} signals`);
      if (n > 0) return true;
    }
    // trains held for a platform: their station grows first
    if (this.growLineStations(l, true)) { this.note(`${l.name} congested: a station rebuilt bigger`); return true; }
    if (info.double && !lineIsDouble(g, l, me)) { info.double = false; info.doubleImpossible = false; }
    if (!info.double && !this.job && g.day >= (info.upgradeRetry ?? 0)) {
      info.congestion = 2;
      info.upgradeFailed = undefined;
      const value = congestionReturn(g, l);
      // Recovery of fares and waiting/lost passengers pays for the second track. Low cash is a deferral,
      // never evidence that the railway cannot be doubled.
      if (value > 0 && this.available() > 500_000) {
        this.startDouble(l, info, value);
        this.note(`${l.name} congested: second track`);
        return true;
      }
    }
    if (!info.double && (!info.doubleImpossible || this.state.doubleJob?.line === l.id)) return true;
    // still stuck: one train fewer (the newest of ours), and no more than that from now on
    const ours = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train && v.owner === me);
    if (ours.length > 1 && this.railPolicy.fewer(l, 1, 'fewer trains for congestion')) {
      info.maxVehicles = Math.max(1, Math.min(info.maxVehicles, ours.length - 1));
      info.congestion = 3;
      info.lastSold = g.day;
      return true;
    }
    return false;
  }

  // capacity-integration: each operator honours the same agreement; the worst marginal train leaves first.
  private manageSharedCapacity() {
    const g = this.game, me = this.companyId;
    for (const l of [...g.lines.map.values()].sort((a, b) => a.id - b.id)) {
      if (!l.vehicles.some(id => g.vehicles.get(id)?.owner === me) || !usesSharedRail(g, l)) continue;
      // An opening/merge still has temporary route families and bidders. Price its finalized service,
      // never sell a paid opening train between its purchase yield and completion of those same works.
      const p = this.project;
      if (this.job && p?.built && ['rail', 'hsr', 'share', 'metro', 'lightrail'].includes(p.kind)
        && l.owner === me && g.lines.get(p.openingLine ?? p.line)?.id === l.id) continue;
      const plan = sharedCapacityPlan(g, l), cut = plan.withdraw[0];
      if (!cut || cut.owner !== me || plan.lines.some(id => g.lines.get(id)?.capacity?.withdrawn === g.day)) continue;
      const t = g.vehicles.get(cut.train);
      if (!(t instanceof Train)) continue;
      g.vehicles.sell(t.id); this.stats.sold++;
      for (const id of plan.lines) { const s = g.lines.get(id)?.capacity; if (s) s.withdrawn = g.day; }
      const info = this.lines.get(cut.line); if (info) info.lastSold = g.day;
      this.note(`${l.name}: withdrew ${t.name} (${Math.round(cut.value / 1000)}k/year including shared delays)`);
    }
  }

  private relieveSharedCapacity(l: Line): boolean { return relieveSharedCapacity(this, l); }

  // capacity-integration: use the company's ordinary credit/reserve calculation for corridor works.
  capacityFunds(cost: number): boolean { return this.borrowFor(cost); }

  /**
   * How many trains a line can take, all operators together: ours from its settings; another company's by its
   * stations (passing places) on single track.
   */
  lineCapacity(l: Line): number {
    // capacity-integration: the physical corridor and every operator's economic bid determine the shared plan.
    if (usesSharedRail(this.game, l)) return sharedCapacityPlan(this.game, l).limit;
    const own = this.lines.get(l.id);
    if (own && own.shared === undefined) return own.maxVehicles;
    const g = this.game;
    const sts = [...new Set(l.stops)].map((sid) => g.stations.get(sid)).filter((x): x is Station => !!x?.rail);
    const passing = sts.filter((x) => x.rail!.tracks >= 2).length;
    // (a direct service across two companies' networks: the lead operator's plan for all its operators' trains)
    const lead = g.aiOf(l.owner)?.railLineInfo(l.id);
    return Math.max(lead?.across ? 1 : 2, Math.min(6, 1 + passing, lead?.across ? lead.maxVehicles : Infinity));
  }

  // ---------------------------------------------------------------- electrification (9)
  /** The track a line's trains use: the routes between its consecutive stops, and from its depot to its first stop. */
  private lineEdges(l: Line, depot = -1): number[] {
    const g = this.game, me = this.companyId, net = g.world.net, out = new Set<number>();
    const route = (from: { edge: NEdge; dir: number }[], to: number) => { const r = findRailRoute(g, from, to, me, -1, 40000); if (r) for (const c of r.conts) out.add(c.edge.id); return !!r; };
    for (let i = 0; i < l.stops.length; i++) {
      const a = g.stations.get(l.stops[i]), b = g.stations.get(l.stops[(i + 1) % l.stops.length]);
      if (!a?.rail || !b?.rail || a === b) continue;
      // (every platform track of the station: trains may take any of them)
      for (const eid of a.rail.edges) out.add(eid);
      for (const eid of a.rail.edges) {
        const e = net.edges.get(eid);
        if (e && (route(railNext(g, e, 1, me), b.id) || route(railNext(g, e, -1, me), b.id))) break;
      }
    }
    const dp = depot >= 0 ? g.depots.get(depot) : undefined, stub = dp ? net.edges.get(dp.edge) : undefined;
    if (stub && l.stops.length) route([{ edge: stub, dir: 1 }], l.stops[0]);
    return [...out];
  }

  /**
   * A busy main line of ours under the wire (UPDATE 9: electrify busy lines): its route, platforms and depot
   * siding electrified (build-ops electrify, ours or open-access track at our cost) where the electric trains of the
   * year beat the diesels for it; its trains become electric as they are lengthened or replaced. Through services
   * with the electric urban lines can then follow. True when electrified.
   */
  private electrifyLine(l: Line, info: LineInfo): boolean {
    const g = this.game, me = this.companyId;
    info.electric = -g.day;
    if (l.incomeLast < l.costLast * 1.3 + 50_000) return false;
    const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
    if (sts.length < 2) return false;
    const platform = Math.min(...sts.map((s) => s.rail!.length));
    let span = 0;
    for (const s of sts) span = Math.max(span, Math.hypot(s.x - sts[0].x, s.z - sts[0].z));
    const elec = pickTrain(g.year, platform, span * 1.3, 3, true);
    if (!elec || elec[0].traction !== 'electric') return false;
    const edges = this.lineEdges(l, info.depot);
    const dry = electrify(g, edges, me, true);
    if (!dry.changed || dry.cost > this.available() * 0.3 || !this.borrowFor(dry.cost)) return false;
    const res = electrify(g, edges, me);
    if (!res.changed) return false;
    info.electric = g.day;
    this.stats.electrified += Math.round(res.length);
    this.note(`electrified ${l.name} (${Math.round(res.length)} u)`);
    g.postNews(`${this.name} electrifies ${l.name}.`, 'ai', sts[0].x, sts[0].z);
    return true;
  }

  // ---------------------------------------------------------------- service patterns (9j)
  /**
   * An express pattern for a line of 5+ stations whose demand is uneven (the busiest stations see several times the
   * traffic of the middle ones): patterns.ts suggestExpress (termini, interchanges and the busier stations stop,
   * the quieter ones are passed), every other train of ours runs it. Passing tracks follow at the stations it
   * passes (station growth: trains passing without stopping). True when added.
   */
  private addExpress(l: Line, info: LineInfo, vs: { id: number }[]): boolean {
    const g = this.game;
    const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
    // (looked at: again when the line has more stations)
    info.expressLook = sts.length;
    if (sts.length < 5) return false;
    // (uneven: the busiest station sees several times the traffic of the quieter quarter)
    const use = sts.map((s) => s.pickupLast + s.arrivedLast).sort((a, b) => a - b);
    const low = use[Math.floor((use.length - 1) / 4)], top = use[use.length - 1];
    if (!(top > 0) || top < Math.max(1, low) * 3) return false;
    const sug = suggestExpress(g, l);
    if (!sug) return false;
    const np = addPattern(g, l.id, sug.kind, sug.stops, sug.name);
    if (!np) return false;
    let n = 0;
    vs.forEach((v, i) => { if (i % 2 === 1 && !setVehiclePattern(g, v.id, np.id)) n++; });
    info.express = g.day;
    this.stats.express++;
    const skipped = sug.stops.filter((x) => !x).length;
    this.note(`${l.name}: ${np.name} pattern (${n} trains, passing ${skipped} stops)`);
    g.postNews(`${this.name} runs ${np.name.toLowerCase()} trains on ${l.name}, skipping quieter stations.`, 'ai');
    return true;
  }

  // ---------------------------------------------------------------- stations: room to grow
  /** day each of our stations may next be looked at for growth (saved, so a loaded game decides as the original) */
  private stationCare = new Map<number, number>();
  private accessCare = new Map<number, number>();

  /** Directions lines leave a station in (neighbouring stops more than ~35 degrees apart as seen from it). */
  private stationDirections(st: Station): number {
    const g = this.game, bearings: number[] = [];
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail') continue;
      const n = l.stops.length;
      for (let i = 0; i < n; i++) {
        if (l.stops[i] !== st.id) continue;
        for (const j of [i - 1, i + 1]) {
          const o = g.stations.get(l.stops[(j + n) % n]);
          if (!o || o === st) continue;
          const a = Math.atan2(o.x - st.x, o.z - st.z);
          if (!bearings.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.6)) bearings.push(a);
        }
      }
    }
    return bearings.length;
  }

  /**
   * Grow one of our rail stations where the traffic needs it (stations API capacity: platforms mostly occupied,
   * trains waiting for a platform, more lines than platform tracks, trains turning at a terminus; through tracks
   * for trains passing without stopping; longer platforms for longer trains), and junctions served from three
   * directions or more to four platform tracks: rebuilt by planUpgrade (new tracks on the side with room, joined
   * to the throats by turnout ladders, signals again); a halt gets a building of its time with it. Smaller steps
   * when the full one does not fit. True when the station was rebuilt.
   */
  private growStation(st: Station, urgent = false): boolean {
    const g = this.game, r = st.rail;
    if (!r || st.owner !== this.companyId) return false;
    if ((this.stationCare.get(st.id) ?? -1) > g.day + (urgent ? -50 : 0)) return false;
    this.stationCare.set(st.id, g.day + 60);
    const cap = g.stations.capacity(st.id);
    if (!cap) return false;
    const now = { tracks: r.tracks, through: r.through ?? 0, length: r.length };
    let want = cap.recommended ? { ...cap.recommended } : null;
    let why = cap.reason;
    const urban = railPartMode(r) !== 'mainline';
    if (!urban && this.stationDirections(st) >= 3 && r.tracks < 4) {
      want = { ...(want ?? now), tracks: Math.max(want?.tracks ?? 0, 4) };
      why = 'lines from three directions';
    }
    if (!want) return false;
    // (an urban station keeps its pair of side platforms with screen doors: longer platforms only)
    if (urban) want = { ...now, length: want.length };
    const same = (q: typeof now) => q.tracks === now.tracks && q.through === now.through && q.length === now.length;
    const steps = [want, { ...want, tracks: Math.min(want.tracks, now.tracks + 1) }, { ...want, through: now.through }, { ...now, length: want.length }, { ...now, tracks: want.tracks }]
      .filter((q, i, all) => !same(q) && all.findIndex((o) => o.tracks === q.tracks && o.through === q.through && o.length === q.length) === i);
    const T = g.towns.list[st.townId];
    for (const q of steps) {
      const halt = r.style === 'none' || r.style === 'shelter';
      const style = halt && q.tracks > now.tracks ? defaultStationStyle(g.year, q.tracks, r.level ?? 'ground', railPartMode(r), T?.pop ?? 0) : undefined;
      let plan = planStationUpgrade(g, st.id, { ...q, side: 'auto', style: style !== r.style ? style : undefined });
      if (!plan.ok && style) plan = planStationUpgrade(g, st.id, { ...q, side: 'auto' });
      if (!plan.ok) continue;
      if (this.available() < plan.cost * 1.3 + 400_000 || !this.borrowFor(plan.cost)) { this.stationCare.set(st.id, g.day + 90); return false; }
      const err = commitStationUpgrade(g, plan);
      // a train stands in it: soon again
      if (err === 'busy') { this.stationCare.set(st.id, g.day + 5); return false; }
      if (err) continue;
      for (const l of g.lines.map.values()) if (l.owner === this.companyId && l.kind === 'rail' && l.stops.includes(st.id)) this.signalLine(l.id);
      this.stats.grown++;
      const what = [q.tracks !== now.tracks ? `${q.tracks} platform tracks` : '', q.through !== now.through ? `${q.through} through tracks` : '', q.length !== now.length ? `${Math.round(q.length * 10)} m platforms` : ''].filter(Boolean).join(', ');
      this.note(`rebuilt ${st.name}: ${what} (${why})`);
      g.postNews(`${this.name} rebuilds ${st.name} station: ${what}.`, 'ai', st.x, st.z);
      return true;
    }
    // it cannot grow here now: not again for a year
    this.stationCare.set(st.id, g.day + 360);
    return false;
  }

  /** Our stations on a line that need room (see growStation): one rebuilt at most. True when one was. */
  private growLineStations(l: Line, urgent = false): boolean {
    const g = this.game;
    for (const sid of new Set(l.stops)) {
      const st = g.stations.get(sid);
      if (st?.rail && st.owner === this.companyId && this.growStation(st, urgent)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- one station where lines meet
  /**
   * Share of a planned station's catchment population that no existing rail station (any track type; ours, or a
   * network we may use) already covers: a second station in a town only pays where it serves mostly new ground.
   */
  private newCatchShare(plan: StationPlan): number {
    const g = this.game, w = g.world, me = this.companyId;
    const others = [...g.stations.map.values()]
      .filter((st) => st.rail && (st.owner === me || g.canUse(me, st.owner)) && Math.hypot(st.x - plan.x, st.z - plan.z) < 140)
      .flatMap((st) => [...walkingCatchment(g, st).buildings.keys()]);
    if (!others.length) return 1;
    let tot = 0, fresh = 0;
    const covered = new Set(others);
    for (const id of planWalkingCatchment(g, plan).buildings.keys()) {
      const b = w.buildings.get(id);
      if (!b) continue;
      tot += b.pop;
      if (!covered.has(id)) fresh += b.pop;
    }
    return tot ? fresh / tot : 1;
  }

  /** The main-line station of town T (ours first, else an open network's) nearest to a planned site, or null. */
  private townStation(T: Town, near: P2): Station | null {
    const g = this.game, me = this.companyId;
    let best: Station | null = null, bd = Infinity;
    for (const st of g.stations.map.values()) {
      if (st.townId !== T.id || !st.rail || railPartMode(st.rail) !== 'mainline') continue;
      if (st.owner !== me && !this.agrees(st.owner)) continue;
      const d = Math.hypot(st.x - near.x, st.z - near.z) + (st.owner === me ? 0 : 25);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  /**
   * Junction sites on the single track leading out of station S towards `toward`: beyond its throat (14+ units),
   * up to ~90 units out, at ground level, where the track still heads roughly towards `toward`; with the
   * outward tangent, the height and the track's edges (closest to S first).
   */
  private approachJunctions(S: Station, toward: P2): JunctionSite[] {
    const g = this.game, net = g.world.net, r = S.rail;
    if (!r) return [];
    const side = Math.sin(r.angle) * (toward.x - S.x) + Math.cos(r.angle) * (toward.z - S.z) >= 0;
    const out: JunctionSite[] = [];
    const P = { x: 0, y: 0, z: 0 }, D = { x: 0, y: 0, z: 0 };
    const seen = new Set<number>();
    for (const end of stationEnds(g, S)) {
      const nid = side ? end.front : end.back;
      const n0 = net.nodes.get(nid);
      if (!n0) continue;
      for (const eid of n0.edges) {
        let e = net.edges.get(eid);
        if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || seen.has(e.id)) continue;
        let from = nid, dist = 0;
        const chain: number[] = [];
        for (let k = 0; k < 14 && e && dist < 90; k++) {
          seen.add(e.id);
          chain.push(e.id);
          const fwd = e.a === from;
          for (let s0 = 3; s0 <= e.len - 3; s0 += 4) {
            if (dist + s0 < 14) continue;
            const sAt = fwd ? s0 : e.len - s0;
            net.pointAt(e, sAt, P, D);
            const l = Math.hypot(D.x, D.z) || 1, tx = (fwd ? D.x : -D.x) / l, tz = (fwd ? D.z : -D.z) / l;
            if (net.sectionAt(e, sAt) !== 'ground') continue;
            const dx = toward.x - P.x, dz = toward.z - P.z, dl = Math.hypot(dx, dz) || 1;
            if ((tx * dx + tz * dz) / dl < 0.5) continue;
            // A branch can join a directional pair: the initial-capacity adapter supplies its companion lead.
            if (net.edgesNear(P.x - 2, P.z - 2, P.x + 2, P.z + 2).some((o) => o.id !== e!.id && o.kind === 'rail' && !chain.includes(o.id) && !!g.trackUpgradeError(this.companyId, o.owner) && net.nearestEdge(P.x, P.z, 2, 'rail', (q) => q.id === o.id))) continue;
            out.push({ edge: e.id, s: sAt, x: P.x, z: P.z, y: P.y, tx, tz, owner: e.owner, chain: [...chain], dist: dist + s0 });
          }
          dist += e.len;
          const nx = fwd ? e.b : e.a, node = net.nodes.get(nx);
          if (!node || node.edges.length < 2) break;
          // on along the track that leaves most nearly straight on
          const cur: NEdge = e;
          const ex = net.leaveDir(cur, nx), cand = node.edges.map((id) => net.edges.get(id)).filter((q): q is NEdge => !!q && q.id !== cur.id && q.kind === 'rail' && q.station < 0 && q.depot < 0);
          let best: NEdge | undefined, bv = 0.7;
          for (const q of cand) { const d = net.leaveDir(q, nx), v = -(d.x * ex.x + d.z * ex.z); if (v > bv) { bv = v; best = q; } }
          from = nx; e = best;
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /**
   * Where a branch towards `toward` leaves the track at junction J: a point beside the track 12 units out, on a
   * 25-unit curve into J, and the travel direction there towards J (null when the spot is taken).
   */
  private mergePoint(J: JunctionSite, toward: P2): OPoint | null {
    const net = this.game.world.net;
    const nx0 = -J.tz, nz0 = J.tx, sg = nx0 * (toward.x - J.x) + nz0 * (toward.z - J.z) >= 0 ? 1 : -1, nx = nx0 * sg, nz = nz0 * sg;
    const Rm = 25, d = 12, th = Math.asin(d / Rm), h = Rm * (1 - Math.cos(th));
    const x = J.x + J.tx * d + nx * h, z = J.z + J.tz * d + nz * h;
    if (!this.game.world.inside(x, z, 6)) return null;
    const near = net.nearestEdge(x, z, 1.4);
    if (near && !J.chain.includes(near.edge.id)) return null;
    return { x, z, tx: -(J.tx * Math.cos(th) + nx * Math.sin(th)), tz: -(J.tz * Math.cos(th) + nz * Math.sin(th)) };
  }

  /** Does one of our railway lines end at this station (a line through trains could continue from)? */
  private lineEndsAt(stationId: number): boolean {
    const g = this.game;
    for (const [lid, info] of this.lines) {
      if (info.kind !== 'rail' || info.shared !== undefined) continue;
      const l = g.lines.get(lid);
      const path = l && l.id === lid ? linearStops(l.stops) : null;
      if (path && (path[0] === stationId || path[path.length - 1] === stationId)) return true;
    }
    return false;
  }

  /**
   * The town beyond B as seen from A (B roughly between them, so a line A–B can continue there): the biggest,
   * straightest one 50–220 units on; null if none.
   */
  private townBeyond(A: Town, B: Town): Town | null {
    const ux = B.x - A.x, uz = B.z - A.z, ul = Math.hypot(ux, uz) || 1;
    let best: Town | null = null, bs = 0;
    for (const C of this.game.towns.list) {
      if (C === A || C === B || C.pop < 300) continue;
      const vx = C.x - B.x, vz = C.z - B.z, vl = Math.hypot(vx, vz);
      if (vl < 50 || vl > 220) continue;
      const cos = (ux * vx + uz * vz) / (ul * vl);
      if (cos <= 0.7) continue;
      const sc = cos * Math.sqrt(C.pop) / (vl + 50);
      if (sc > bs) { bs = sc; best = C; }
    }
    return best;
  }

  /**
   * A railway between towns A and B: stations with a passing loop (two platform tracks; or our existing station
   * `hubId` in A, extending our network from there), a single-track main line (upgraded to double track when
   * traffic grows, see manage), a depot on a siding (station ends stay free for extensions), and a line with
   * short trains. A line ending at the hub is extended to B (through trains) instead of a new line.
   */
  private *railJob(A: Town, B: Town, hubId = -1, type = 'standard', centre = true, joinId = -1): Generator<void, void> {
    const p = this.project!;
    let hubsLive = () => true;
    const job = this.railPlanJob(A, B, hubId, type, centre, check => { hubsLive = check; }, joinId);
    let units = 0;
    try {
      while (true) {
        if (!hubsLive()) {
          const key = (type === 'highspeed' || p.kind === 'hsr' ? 'hsr' : '') + this.pairKey(A.id, B.id);
          this.note(`railway ${A.name}-${B.name} abandoned: station or track access changed while planning`);
          this.markFailed(key, 360); this.abandon(p); return;
        }
        const r = job.next();
        if (r.done) return;
        if (!p.built && ++units >= AI_RAIL_PLAN_UNITS) {
          const key = (type === 'highspeed' || p.kind === 'hsr' ? 'hsr' : '') + this.pairKey(A.id, B.id);
          this.note(`railway ${A.name}-${B.name} abandoned: planning work limit (${units} units)`);
          this.markFailed(key, 1800);
          this.abandon(p);
          return;
        }
        yield;
      }
    } finally { job.return(undefined); }
  }

  private *railPlanJob(A: Town, B: Town, hubId = -1, type = 'standard', centre = true,
    register?: (check: () => boolean) => void, joinId = -1): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const watched = new Map<Station, { rail: Station['rail']; owner: number; access: boolean }>();
    let itineraryLive = () => true;
    const watch = (st: Station | null | undefined, access = true) => { if (st && !watched.has(st)) watched.set(st, { rail: st.rail, owner: st.owner, access }); };
    register?.(() => itineraryLive() && [...watched].every(([st, before]) => this.railHubLive(st, before.rail, before.owner, before.access)));
    const p = this.project!;
    // A high-speed railway uses main-line stations where they can take it, and wide curves with shallow grades between them.
    const hs = type === 'highspeed' || p.kind === 'hsr', hsUnit = hs ? this.hsrUnit() : null;
    type = hs ? 'electric' : type;
    const key = (hs ? 'hsr' : '') + this.pairKey(A.id, B.id);
    const what = hs ? 'high-speed railway' : 'railway';
    // (the hub may have changed since the project was chosen: no platforms, no hub)
    const hub0 = hubId >= 0 ? g.stations.get(hubId) ?? null : hs ? this.hubFor(A, B) : null;
    const hub = hub0?.rail && (!hs || railPartMode(hub0.rail) === 'mainline' && hub0.rail.length >= (hsUnit?.length ?? Infinity) + 0.4) ? hub0 : null;
    watch(hub);
    this.state.phase = hub ? `planning a railway ${hub.name} - ${B.name}` : `planning ${what} ${A.name} - ${B.name}`;
    const fail = (why: string, days = 900) => { this.note(`${what} ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (hub && !this.railHubLive(hub)) return fail('station or track access changed while planning', 360);
    if (hs && !hsUnit) return fail('no high-speed trains yet', 1800);
    const PLATFORM = hs ? Math.max(12, Math.ceil(hsUnit!.length + 1)) : aiPlatformLength(A.pop, B.pop, g.year), ST = 2, tracks = 1;
    const grade = (hs ? 0.03 : 0.035) * 0.8;
    // Aim above conventional speeds on the trunk; near a stop, a slower curve on HSR track is legal.
    // Derive the speed radius from curveSpeed, keeping margin for the planner's fitted Beziers.
    const speedR = (Math.min(180, hsUnit?.speed ?? 180) / curveSpeed(1, 'highspeed')) ** 2;
    const curve = hs ? { type, minR: Math.max(44, speedR), rmax: Math.max(500, (hsUnit!.speed / curveSpeed(1, type)) ** 2), rgood: speedR, approachR: 44, approachLength: 60, trackClass: 'highspeed' as const, cell: Math.max(12, Math.ceil(g.world.size / 48)) } : { minR: 14 };
    let pr: { a: StationPlan; b: StationPlan } | null = null;
    const asPlan = (st: Station) => { const r = st.rail!; return { ok: true, x: r.x, z: r.z, y: r.y, angle: r.angle, length: r.length, tracks: r.tracks, cost: 0 } as StationPlan; };
    const reach = (a: StationPlan, b: StationPlan) => Math.abs(a.y - b.y) <= grade * Math.hypot(a.x - b.x, a.z - b.z) * 1.15;
    // one station where lines meet: B's station (ours, or an open network's) with its platform ends towards A
    // free takes the line too, rather than a second station in the town
    const hb = joinId >= 0 ? null : this.hubFor(B, hub ?? A);
    let hubB = hb && hb !== hub && hb.rail && railPartMode(hb.rail) === 'mainline' && (!hs || hb.rail.length >= hsUnit!.length + 0.4) ? hb : null;
    watch(hubB);
    if (hubB && !this.railHubLive(hubB)) return fail('station or track access changed while planning', 360);
    if (hub && hub.rail) {
      const pa = asPlan(hub);
      if (hubB && reach(pa, asPlan(hubB)) && leadsMeet(pa, asPlan(hubB), LEAD)) pr = { a: pa, b: asPlan(hubB) };
      else {
        hubB = null; if (hb) watched.delete(hb);
        const pb = yield* aiStationSiteGen(g, B, pa, { tracks: ST, length: PLATFORM, owner, front: LEAD + 2, back: 22, accept: (q) => leadsMeet(pa, q, LEAD), quick: true });
        if (pb && reach(pa, pb)) pr = { a: pa, b: pb };
      }
    } else if (hubB) {
      const pb = asPlan(hubB);
      const pa = yield* aiStationSiteGen(g, A, pb, { tracks: ST, length: PLATFORM, owner, front: LEAD + 2, back: 22, accept: (q) => leadsMeet(q, pb, LEAD), quick: true });
      if (pa && reach(pa, pb)) pr = { a: pa, b: pb };
    }
    if (!pr && !hub) { hubB = null; if (hb) watched.delete(hb); pr = yield* aiRailPairGen(g, A, B, { tracks: ST, length: PLATFORM, owner, front: LEAD + 2, back: 22, quick: true }); }
    if (!pr) return fail('no station sites');
    if (hs && !hub) {
      const existingA = this.townStation(A, pr.a);
      if (existingA && this.newCatchShare(pr.a) < 0.6) {
        // Put the occupied station at the joining end. With both ends occupied and no free platform end,
        // defer the project rather than pay for a duplicate main-line station.
        if (existingA.rail!.length < hsUnit!.length + 0.4 || !hubB && this.townStation(B, pr.b)) return fail('no free approach into the existing stations', 720);
        return yield* this.railJob(B, A, hubB?.id ?? -1, type, centre);
      }
    }
    if (hs) for (const end of ['a', 'b'] as const) {
      if (end === 'a' ? hub : hubB) continue;
      const sp = pr[end], re = g.stations.planRail(sp.x, sp.z, sp.angle, PLATFORM, ST, owner, { trackType: type });
      yield;
      if (!re.ok) return fail('no high-speed station site');
      pr[end] = re;
    }
    // A central alignment is an economic alternative at every town size. Price the reachable pair,
    // including the structures needed to cross its streets, against the existing surface/hub layout.
    let underground = false, preferredRoute: RoutePlan | null = null;
    if (!hs && centre) {
      const base = pr, pairs = [base];
      for (const level of ['ground', 'elevated', 'underground'] as const) {
        const a = hub ? base.a : yield* this.centreStation(A, base.b, PLATFORM, level);
        const b = hubB ? base.b : yield* this.centreStation(B, a ?? base.a, PLATFORM, level);
        if (a && b && reach(a, b) && leadsMeet(a, b, LEAD)) pairs.push({ a, b });
      }
      const routeFor = function* (pair: typeof base): Generator<void, RoutePlan | string> {
        const sa = hub && Math.sin(pair.a.angle) * (pair.b.x - pair.a.x) + Math.cos(pair.a.angle) * (pair.b.z - pair.a.z) < 0 ? -1 : 1;
        const sb = hubB && Math.sin(pair.b.angle) * (pair.a.x - pair.b.x) + Math.cos(pair.b.angle) * (pair.a.z - pair.b.z) < 0 ? -1 : 1;
        const da = { x: Math.sin(pair.a.angle) * sa, z: Math.cos(pair.a.angle) * sa };
        const db = { x: Math.sin(pair.b.angle) * sb, z: Math.cos(pair.b.angle) * sb };
        const fa = { x: pair.a.x + da.x * pair.a.length / 2, z: pair.a.z + da.z * pair.a.length / 2 };
        const fb = { x: pair.b.x + db.x * pair.b.length / 2, z: pair.b.z + db.z * pair.b.length / 2 };
        const from = { x: fa.x + da.x * LEAD, z: fa.z + da.z * LEAD, tx: da.x, tz: da.z };
        const to = { x: fb.x + db.x * LEAD, z: fb.z + db.z * LEAD, tx: -db.x, tz: -db.z };
        // Price a directly fitted through alignment before paying for a full corridor search.
        // The selected geometry is checked again by the ordinary build path; a terrain/clearance
        // rejection leaves the original surface search available, without consuming its work budget.
        const aligned = alignCorridor([from, to], from, to);
        if (aligned.minR < 14) return 'central approach curve';
        const way = [...aligned.way, { ...fb, tx: -db.x, tz: -db.z }];
        const exclude = new Set([...(hub?.rail?.edges ?? []), ...(hubB?.rail?.edges ?? [])]);
        const prof = yield* chainProfileGen(g, [{ ...fa, tx: da.x, tz: da.z }, ...way], tracks, pair.a.y, pair.b.y,
          'rail', exclude, false, undefined, type, 256, (0.035 / TRACK_TYPES.standard.maxGrade) *
            (pair.a.level === 'underground' || pair.b.level === 'underground' ? .95 : .85));
        if (!prof || (yield* routeConflictGen(g, prof, 'rail', tracks, exclude, 40, true))) return 'central clearance';
        return { way, prof, minR: aligned.minR, expanded: 0 };
      };
      let best = -Infinity;
      for (const pair of pairs) {
        const route = yield* routeFor(pair);
        if (typeof route === 'string') continue;
        const len = route.prof.s[route.prof.s.length - 1], dist = Math.hypot(pair.b.x - pair.a.x, pair.b.z - pair.a.z);
        if (len > dist * 1.55 + 25) continue;
        const overlap = routeAlongside(g, route.prof, Math.min(25, len / 5), trackClassOf(type));
        if (overlap > .3) continue;
        const stock = pickTrain(g.year, Math.min(PLATFORM, pair.a.length, pair.b.length), len, openingCoaches(A.pop, B.pop));
        if (!stock) continue;
        const works = estimateChainCost(route.prof, tracks, 'rail', type);
        const infrastructure = works.cost * 1.15 + (hub ? 0 : pair.a.cost) + (hubB ? 0 : pair.b.cost) + 260_000;
        const civilUpkeep = trackBasePerUnit(type) * (works.bridge * 3 + works.tunnel * 4)
          + (hub ? 0 : (20_000 + pair.a.tracks * pair.a.length * 500) * (STATION_UPKEEP_FACTOR[pair.a.level] ?? 1))
          + (hubB ? 0 : (20_000 + pair.b.tracks * pair.b.length * 500) * (STATION_UPKEEP_FACTOR[pair.b.level] ?? 1)) + 12_000;
        for (const fleet of [1, 2]) {
          const sv = this.serviceYear(stock, fleet, dist, len, type, .4);
          const forecast = g.demand.forecastLine([hub ?? pair.a, hubB ?? pair.b], 'mainline', sv.kmh, sv.headway, owner);
          const mail = projectMail(g, [hub ?? pair.a, hubB ?? pair.b], stock, fleet, sv.kmh, sv.headway,
            Math.min(PLATFORM, pair.a.length, pair.b.length));
          const capital = infrastructure + (stock.reduce((n, c) => n + c.cost, 0) + mail.price) * fleet;
          const income = (forecast.revenue * Math.min(1, sv.seats / Math.max(1, forecast.boardings)) + .7 * mail.revenue) * (1 - overlap);
          const net = income - sv.running - mail.yearly - sv.trackUpkeep - civilUpkeep;
          const need = infrastructure * (.045 - .03 * this.config.risk) + capital * .03;
          const score = (net - need) / capital;
          if (capital <= this.available() && net > need && score > best) { best = score; pr = pair; preferredRoute = route; }
          yield;
        }
      }
      underground = pr.a.level === 'underground' || pr.b.level === 'underground';
      if (pr !== base) this.note(`${what} ${A.name}-${B.name}: central ${pr.a.level}/${pr.b.level} alignment pays better than the surface alternative`);
    }
    const planning = this.state.phase;
    this.state.phase = `${planning}: route`;
    const lenA = hub ? hub.rail!.length : PLATFORM, lenB = hubB ? hubB.rail!.length : PLATFORM;
    // the A end faces B: a new station's front, or the hub's free end (the same at B)
    const sa = hub ? (Math.sin(pr.a.angle) * (pr.b.x - pr.a.x) + Math.cos(pr.a.angle) * (pr.b.z - pr.a.z) > 0 ? 1 : -1) : 1;
    const sb = hubB ? (Math.sin(pr.b.angle) * (pr.a.x - pr.b.x) + Math.cos(pr.b.angle) * (pr.a.z - pr.b.z) > 0 ? 1 : -1) : 1;
    const fa = { x: Math.sin(pr.a.angle) * sa, z: Math.cos(pr.a.angle) * sa }, fb = { x: Math.sin(pr.b.angle) * sb, z: Math.cos(pr.b.angle) * sb };
    // Plan from the very platform track the single line will use. Converging from the station centre in a
    // short lead silently changes its tangent and can turn a legal HSR curve into an unbuildable one.
    const laneA = hs ? (hub?.rail?.trackOffsets ?? pr.a.layout.trackOffsets) : [0];
    const laneB = hs ? (hubB?.rail?.trackOffsets ?? pr.b.layout.trackOffsets) : [0];
    const offA = sa > 0 ? Math.max(...laneA) : Math.min(...laneA), offB = sb > 0 ? Math.min(...laneB) : Math.max(...laneB);
    const frontA = { x: pr.a.x + fa.x * lenA / 2 + Math.cos(pr.a.angle) * offA, z: pr.a.z + fa.z * lenA / 2 - Math.sin(pr.a.angle) * offA };
    const frontB = { x: pr.b.x + fb.x * lenB / 2 + Math.cos(pr.b.angle) * offB, z: pr.b.z + fb.z * lenB / 2 - Math.sin(pr.b.angle) * offB };
    const from: OPoint = { x: frontA.x + fa.x * LEAD, z: frontA.z + fa.z * LEAD, tx: fa.x, tz: fa.z };
    const to: OPoint = { x: frontB.x + fb.x * LEAD, z: frontB.z + fb.z * LEAD, tx: -fb.x, tz: -fb.z };
    const avoidA = { x0: frontA.x - fa.x * lenA, z0: frontA.z - fa.z * lenA, x1: from.x - fa.x * 4, z1: from.z - fa.z * 4, r: 4 };
    const avoid = [avoidA, { x0: frontB.x - fb.x * lenB, z0: frontB.z - fb.z * lenB, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 }];
    const start: OPoint = { x: frontA.x, z: frontA.z, tx: fa.x, tz: fa.z };
    // one station where lines meet: where B's main-line station (ours, or an open network's) already serves most
    // of the new station's passengers, the line joins that station's track at a junction on its approach instead
    // (a station of its own only when no junction works)
    let join: { S: Station; J: JunctionSite } | null = null;
    let plan: RoutePlan | string = preferredRoute ?? 'no route';
    const S = hubB ? null : joinId >= 0 ? g.stations.get(joinId) ?? null : this.townStation(B, pr.b);
    if (joinId >= 0 && (!S?.rail || S.townId !== B.id || !this.railHubLive(S))) return fail('joining station or access changed', 360);
    // (a terminus of our own right beside another company's station would duplicate it: join that station's approach
    // where a junction fits, whatever share of the new site's catchment it covers)
    const duplicate = !!S && S.owner !== owner && Math.hypot(S.x - pr.b.x, S.z - pr.b.z) - (S.rail!.length + PLATFORM) / 2 <= XLINK_REACH;
    if (S && (joinId >= 0 || this.newCatchShare(pr.b) < 0.6 || duplicate)) {
      watch(S);
      if (hs && S.rail!.length < hsUnit!.length + 0.4) return fail('existing station platforms too short', 720);
      for (const J of this.approachJunctions(S, frontA).slice(0, 4)) {
        if (J.owner !== owner && !this.agrees(J.owner)) continue;
        const W = this.mergePoint(J, frontA);
        if (!W) continue;
        yield;
        const pj = yield* routeGen(g, from, W, { kind: 'rail', owner, tracks, y0: pr.a.y, y1: J.y, pre: [start], avoid: [avoidA], exclude: new Set(J.chain), ...curve, gradeMargin: (hs ? 0.03 : 0.035) / TRACK_TYPES.standard.maxGrade * (underground ? 0.95 : 0.85), retries: 2, parallel: 3, sliced: true }, AI_ROUTE_WORK);
        if (typeof pj !== 'string') { plan = pj; join = { S, J }; watch(S); break; }
      }
      if (!join && (hs || joinId >= 0)) return fail(`no junction into ${S.name}`, 720);
      if (!join) { watched.delete(S); this.note(`railway ${A.name}-${B.name}: no junction into ${S.name} (a station of its own)`); }
    }
    // (running alongside existing rail costs extra: such a line would mostly share the passengers of the other)
    if (!join && !preferredRoute) plan = yield* routeGen(g, from, to, { kind: 'rail', owner, tracks, y0: pr.a.y, y1: pr.b.y, pre: [start], post: [{ x: frontB.x, z: frontB.z, tx: -fb.x, tz: -fb.z }], avoid, ...curve, gradeMargin: (hs ? 0.03 : 0.035) / TRACK_TYPES.standard.maxGrade * (underground ? 0.95 : 0.85), retries: 3, parallel: 3, sliced: true }, AI_ROUTE_WORK);
    // (an underground centre station the line cannot reach, or pay for: the railway with stations on the ground)
    const ground = function* (self: AIController, why: string): Generator<void, void> { self.note(`${what} ${A.name}-${B.name}: underground station dropped (${why})`); yield* self.railJob(A, B, hubId, type, false, joinId); };
    if (typeof plan === 'string') { if (underground) return yield* ground(this, plan); return fail(plan, plan.startsWith('route runs') ? 720 : 900); }
    const endB = join ? asPlan(join.S) : pr.b;
    this.state.phase = `${planning}: costs`;
    const way = plan.way;
    let prof: ChainProfile | null = plan.prof;
    const len = plan.prof.s[plan.prof.s.length - 1];
    const dist = Math.hypot(pr.a.x - endB.x, pr.a.z - endB.z);
    if (len > dist * 1.55 + 25) return fail('detour too long');
    // a route alongside an existing railway (any owner) would share its passengers: not worth a second track
    // there (reuse it instead: trains on it, or extending its line)
    const alongside = routeAlongside(g, plan.prof, Math.min(25, len / 5), trackClassOf(type));
    if (alongside > 0.3) return fail(`runs alongside an existing railway (${Math.round(alongside * 100)}%)`, 1800);
    yield;
    const big = Math.sqrt(A.pop * B.pop) >= 2500;
    // (trains fit the shortest platforms of the line: a joined station's may be shorter)
    const initialCars = hs ? [hsUnit!] : pickTrain(g.year, Math.min(PLATFORM, hub ? lenA : PLATFORM, hubB ? lenB : join ? join.S.rail!.length : PLATFORM), len, openingCoaches(A.pop, B.pop));
    if (!initialCars) return fail('no trains available');
    let cars: VehicleModel[] = initialCars;
    let nTrains = big ? 2 : 1;
    let trainCost = cars.reduce((a, c) => a + c.cost, 0);
    const est = estimateChainCost(prof, tracks, 'rail', type).cost * 1.15;
    const wireEdges = hs ? [...(hub?.rail?.edges ?? []), ...(hubB?.rail?.edges ?? []), ...(join?.S.rail?.edges ?? []), ...(join?.J.chain ?? [])] : [];
    const wireCost = wireEdges.length ? electrify(g, wireEdges, owner, true).cost : 0;
    const infrastructure = est + wireCost + (hub ? 0 : pr.a.cost) + (hubB || join ? 0 : pr.b.cost) + 260_000;
    const speedCap = hs ? routeCurveSpeed([start, ...way], type, hsUnit!.speed) : Infinity;
    const full = this.railItinerary(hub ?? pr.a, hubB ?? join?.S ?? pr.b, hub, hubB ?? join?.S ?? null);
    for (const st of full.old) watch(st);
    const platform = Math.min(PLATFORM, ...full.points.map(p => 'id' in p ? p.rail?.length ?? 0 : p.length));
    const throughCars = hs ? cars : pickTrain(g.year, platform, len, openingCoaches(A.pop, B.pop));
    const oldLengths: number[] = [], oldRails = new Set<number>();
    let throughFits = !!throughCars;
    if (throughCars) for (let i = 1; i < full.old.length; i++) {
      const leg = this.quotedRailLeg(full.old[i - 1], full.old[i], throughCars);
      if (!leg) { throughFits = false; break; }
      for (const id of leg) oldRails.add(id);
      oldLengths.push(leg.reduce((n, id) => n + (net.edges.get(id)?.len ?? 0), 0));
    }
    const existingFleet = full.extension ? g.lines.get(full.extension[0])!.vehicles.map(id => g.vehicles.get(id))
      .filter((v): v is Train => v instanceof Train && v.owner === owner) : [];
    // An existing electric/HSR or patterned fleet is not promised an unpriced new compatible formation.
    if (existingFleet.some(t => t.rule.wire && !TRACK_TYPES[type]?.electrified || t.length > PLATFORM)) throughFits = false;
    const opening = (fleet: number, through = false) => {
      const stock = through ? throughCars! : cars;
      const points = through ? full.points : [hub ?? pr.a, hubB ?? join?.S ?? pr.b];
      const lengths = through ? [...oldLengths, len] : [len];
      const cycle = this.railCycle(stock, lengths, Math.min(speedCap, TRACK_TYPES[type]?.speed ?? 160)), oldCycles = through ? existingFleet.map(t => this.railCycle(t.cars, lengths, Math.min(speedCap, TRACK_TYPES[type]?.speed ?? 160))) : [];
      const rates = fleet / cycle.seconds + oldCycles.reduce((n, c) => n + 1 / c.seconds, 0);
      const totalFleet = fleet + oldCycles.length;
      const sv = through ? { headway: 2 / rates, kmh: lengths.reduce((n, l) => n + l, 0) * UNIT_M / 1000 / (totalFleet / rates / 3600),
        seats: fleet * cycle.seats + oldCycles.reduce((n, c) => n + c.seats, 0),
        running: fleet * cycle.running + oldCycles.reduce((n, c) => n + c.running, 0),
        trackUpkeep: len * trackBasePerUnit(type) + fleet * cycle.wear + oldCycles.reduce((n, c) => n + c.wear, 0) }
        : this.serviceYear(stock, fleet, dist, len, type, .4, speedCap);
      const forecast = g.demand.forecastLine(points, 'mainline', sv.kmh, sv.headway, owner, through ? full.extension?.[0] : undefined);
      // Existing vans retain their traffic; do not sell it again as revenue of this extension.
      const mail = through && existingFleet.length ? { revenue: 0, potential: 0, yearly: 0, price: 0, cars: stock }
        : projectMail(g, points, stock, fleet, sv.kmh, through ? 2 * cycle.seconds / fleet : sv.headway,
          through ? platform : Math.min(PLATFORM, hub ? lenA : PLATFORM, hubB ? lenB : join ? join.S.rail!.length : PLATFORM));
      const gross = forecast.revenue * Math.min(1, sv.seats / Math.max(1, forecast.boardings)) + .7 * mail.revenue;
      let baselineRevenue = 0, baselineRunning = 0, baselineWear = 0;
      if (through && existingFleet.length) {
        const baseline = existingFleet.map(t => this.railCycle(t.cars, oldLengths));
        const frequency = baseline.reduce((n, c) => n + 1 / c.seconds, 0), seats = baseline.reduce((n, c) => n + c.seats, 0);
        const before = g.demand.forecastLine(full.old, 'mainline', oldLengths.reduce((n, l) => n + l, 0) * UNIT_M / 1000 / (baseline.length / frequency / 3600), 2 / frequency, owner, full.extension![0]);
        baselineRevenue = before.revenue * Math.min(1, seats / Math.max(1, before.boardings));
        baselineRunning = baseline.reduce((n, c) => n + c.running, 0); baselineWear = baseline.reduce((n, c) => n + c.wear, 0);
      }
      const fees = this.railFeeBound(points, through ? oldRails : new Set());
      const delta = gross - baselineRevenue;
      const income = delta > 0 ? delta * (1 - alongside) : delta, running = sv.running - baselineRunning;
      const maint = Math.max(len * trackBasePerUnit(type), sv.trackUpkeep - baselineWear)
        + (hub ? 0 : 40_000) + (hubB || join ? 0 : 40_000) + 12_000 + est * .01 + fees;
      return { sv: { ...sv, running }, forecast, income, maint, mail, net: income - running - mail.yearly - maint,
        total: infrastructure + (stock.reduce((n, c) => n + c.cost, 0) + mail.price) * fleet, cars: stock, through, fees };
    };
    let service = opening(nTrains);
    yield;
    for (const fleet of hs ? [nTrains] : [1, 2]) {
      for (const through of !hs && throughFits && full.old.length >= 2 ? [false, true] : [false]) {
        if (fleet === nTrains && !through) continue;
        const candidate = opening(fleet, through);
        if (candidate.total <= this.available() && candidate.net / candidate.total > service.net / service.total) { nTrains = fleet; service = candidate; }
        yield;
      }
    }
    cars = service.cars; trainCost = cars.reduce((n, c) => n + c.cost, 0);
    if (service.through) {
      const oldLine = g.lines.get(full.extension?.[0] ?? full.foreign!.line)!;
      const identity = () => JSON.stringify([oldLine.stops, oldLine.patterns, oldLine.operators, oldLine.vehicles.map(id => { const t = g.vehicles.get(id); return [id, t?.owner, t instanceof Train ? t.cars.map(c => c.id) : []]; })]);
      const before = identity();
      itineraryLive = () => g.lines.get(oldLine.id) === oldLine && identity() === before;
    }
    const extra = initialSecondTrackCost(prof, type);
    const existing = [...g.lines.map.values()].filter(l => l.kind === 'rail' && l.stops.some(sid => sid === hub?.id || sid === hubB?.id || sid === join?.S.id));
    const junctionTraffic = existing.reduce((n, l) => n + l.vehicles.length / Math.max(120, service.sv.headway * nTrains), 0);
    const initialTraffic = { revenue: service.income, boardings: service.forecast.boardings, seats: service.sv.seats,
      trains: nTrains, headway: service.sv.headway, kmh: service.sv.kmh, blockLength: len, risk: this.config.risk, junctionTraffic };
    // Current recovery uses the fleet this project purchases. Unmet demand belongs to the future-upgrade
    // term, rather than opposing arrivals from hypothetical trains whose capital/running costs are unpaid.
    const finance = initialTrackFinancing(this.eco, service.total + 300_000, extra.cost);
    const choice = initialTrackChoice(initialTraffic, extra.cost, extra.upkeep, finance.annualInterest);
    // Reprice the pair after the formation is built: the standalone quote can overstate its actual cost.
    // The construction callback still reserves the full opening fleet, and the pair must repay its own
    // upkeep and capital; it cannot consume the train budget or rescue a losing service.
    const initialBudget = choice.double ? extra.cost : 0;
    const total = service.total;
    if (total > this.available()) { if (underground) return yield* ground(this, 'too expensive'); return fail('too expensive', 360); }
    yield;
    // rough yearly result: two trains on the single track (passing at the stations), grown to the platform length
    // (trains open short and get longer as passengers pile up; fare model in vehicle.ts); bold companies accept a
    // longer payback
    // (trains grow to the length of platforms rebuilt to 12 units where passengers pile up; fares with the value of
    // time, running costs and track upkeep from the fares / opcosts estimates; carrying what the demand gives)
    const { sv, forecast, income, maint, mail } = service;
    const running = sv.running + mail.yearly;
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    // Conventional railway civil works are long-lived: amortise them over 22–67 years according to risk,
    // with a separate 3% capital/interest allowance. HSR retains its existing investment threshold.
    const amortisation = hs ? 0.075 - 0.05 * this.config.risk : 0.045 - 0.03 * this.config.risk;
    const need = (total - (trainCost + mail.price) * nTrains) * amortisation + total * 0.03;
    if (income - running - maint < need && !AIController.forceBuild) { if (underground) return yield* ground(this, 'not paying'); return fail(`not profitable (${k(income - running - maint)} a year on ${k(total)}, ${k(need)} needed; ${Math.round(forecast.covered)} covered, ${Math.round(sv.headway)}s headway)`, 1500); }
    // ---- build
    this.state.phase = `building railway ${hub ? hub.name : A.name} - ${B.name}`;
    if (!this.borrowFor(total)) return fail('no money', 360);
    p.built = true;
    const spent0 = this.eco.money;
    // This live legacy rail generator cancels on load; no saved cursor resumes this construction baseline.
    const throatFinance = openingThroatBaseline(g, owner);
    if (wireEdges.length) electrify(g, wireEdges, owner);
    const built = new Map<StationPlan, number>();
    for (const sp of [hub ? null : pr.a, hubB || join ? null : pr.b]) {
      if (!sp) continue;
      // a building of its time and town (a halt in a village, a concourse in a city)
      const style = defaultStationStyle(g.year, ST, sp.level ?? 'ground', 'mainline', (sp === pr.a ? A : B).pop);
      const tt = { ...(hs ? { trackType: type } : {}), ...(sp.level && sp.level !== 'ground'
        ? { level: sp.level, depth: sp.depth || undefined, height: sp.height || undefined, entrances: sp.entrances.length } : {}) };
      let re = g.stations.planRail(sp.x, sp.z, sp.angle, PLATFORM, ST, owner, { style, ...tt });
      yield;
      if (!re.ok || !stationAccessSafe(re)) { re = g.stations.planRail(sp.x, sp.z, sp.angle, PLATFORM, ST, owner, tt); yield; }
      const id = g.stations.nextId;
      if (!re.ok || !stationAccessSafe(re) || g.stations.commitRail(re, owner)) return fail('station site taken or no lasting road access', 360);
      p.stations.push(id);
      built.set(sp, id);
      this.track(net.nextEdge - ST);
      const nst = g.stations.get(id);
      yield;
      if (nst) { yield* this.roadAccessGen(nst); this.linkTransfers(id); }
      yield;
    }
    const stA = hub ?? g.stations.get(built.get(pr.a) ?? -1), stB = hubB ?? join?.S ?? g.stations.get(built.get(pr.b) ?? -1);
    if (!stA?.rail || !stB?.rail) return fail('station gone', 360);
    watch(stA, false); watch(stB, false);
    const facing = (st: Station, o: Station) => { const r = st.rail!; return Math.sin(r.angle) * (o.x - st.x) + Math.cos(r.angle) * (o.z - st.z) > 0; };
    // the main line leaves from the platform track with the other one on the same side (travelling A -> B) at both
    // stations, so that a second track can later run straight into the free platforms at both ends
    const outOf = (st: Station, o: Station) => { const r = st.rail!, f = facing(st, o) ? 1 : -1; return { x: Math.sin(r.angle) * f, z: Math.cos(r.angle) * f }; };
    const mainFirst = (ends: number[], t: P2) => {
      const n0 = net.nodes.get(ends[0]), n1 = net.nodes.get(ends[1]);
      if (!n0 || !n1) return ends;
      return (n1.x - n0.x) * -t.z + (n1.z - n0.z) * t.x > 0 ? ends : [ends[1], ends[0], ...ends.slice(2)];
    };
    const oA = outOf(stA, stB), oB = outOf(stB, stA);
    const fAs = mainFirst(stationEnds(g, stA).map((e) => (facing(stA, stB) ? e.front : e.back)), oA);
    const fBs = mainFirst(stationEnds(g, stB).map((e) => (facing(stB, stA) ? e.front : e.back)), { x: -oB.x, z: -oB.z });
    const exclude = new Set<number>([...stA.rail.edges, ...stB.rail.edges]);
    // the planned heights stand when the stations came out at the planned heights
    if (join) for (const id of join.J.chain) exclude.add(id);
    const yB = join ? join.J.y : stB.rail.y;
    if (!prof || Math.abs(stA.rail.y - pr.a.y) > 1e-6 || (!join && Math.abs(stB.rail.y - pr.b.y) > 1e-6)) {
      prof = yield* chainProfileGen(g, [start, ...way], tracks, stA.rail.y, yB, 'rail', exclude, false, undefined, type, 256, (hs ? 0.03 : 0.035) / TRACK_TYPES.standard.maxGrade * (underground ? 0.95 : 0.85), hs);
      if (!prof) return fail('too steep');
      yield;
    }
    if (yield* routeConflictGen(g, prof, 'rail', tracks, exclude, 40, hs)) return fail('route runs along other tracks or roads', 720);
    yield;
    const e0 = net.nextEdge;
    const chain = aiChainGen(g, fAs[0], way, { kind: 'rail', type, tracks, heightOffset: 0, crossing: 'auto', owner, designSpeed: hs ? 180 : undefined, designGrade: hs ? 0.03 : 0.035 }, join ? null : fBs[0], prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    const res = r.value;
    if (!res.ok) return fail('construction failed: ' + (res.error ?? ''), 720);
    if (join) {
      // the last curve into the junction: a turnout in the station's approach track
      const J = join.J, je = net.edges.get(J.edge);
      const sn: Snap = je && J.s > 0.6 && J.s < je.len - 0.6 ? { kind: 'edge', x: J.x, z: J.z, y: J.y, edge: J.edge, s: J.s } : findSnap(g, 'rail', J.x, J.z, 0.3);
      const pj = sn.kind === 'free' ? null : planEdge(g, nodeSnap(g, res.endNode, 'rail'), sn, { kind: 'rail', type: hs ? sidingType(type) : 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner });
      if (!pj || !pj.ok || commitProposal(g, pj)) return fail(`junction into ${join.S.name}: ${pj?.errors[0] ?? 'the track moved'}`, 720);
      this.track(e0);
      this.stats.connections++;
    }
    this.stats.track += res.built; this.stats.bridges += res.bridges; this.stats.tunnels += res.tunnels;
    yield;
    // Use a real complete pair's direction to site a new depot on the outside of its future second rail.
    // Retain only primitive edge/direction hints; the atomic adapter reprices after the depot is committed.
    const pairOptions: { cost: number; entries: Map<number, 1 | -1>; corridor: P2[] }[] = [];
    if (initialBudget) {
      for (const side of [1, -1] as const) {
        // Discard the actual proposal before yielding; only these coordinates and entry directions survive.
        const option = (() => {
          const pair = Trackops.planDoubleTrack(g, upgradeRoute(g, stA.id, stB.id, owner), side, owner);
          if (!pair.ok || !pair.complete || pair.start.kind === 'turnout' || pair.end.kind === 'turnout'
            || Trackops.quoteDoubleTrackCompletion(g, pair).cost > initialBudget * 1.2) return null;
          const entries = new Map(pair.steps.map(s => [s.edge, (-pair.side * s.dir) as 1 | -1]));
          const corridor: P2[] = [];
          for (const proposal of pair.proposals) for (const track of proposal.tracks) {
            const table = arcTable(track.bez), count = Math.ceil(track.len * 2);
            for (let i = 0; i <= count; i++) {
              const point = { x: 0, z: 0 };
              bezPoint(track.bez, tAtS(table, Math.min(i * 0.5, track.len)), point);
              corridor.push(point);
            }
          }
          return { cost: pair.cost, entries, corridor };
        })();
        if (option) pairOptions.push(option);
        yield;
      }
    }
    pairOptions.sort((a, b) => a.cost - b.cost);
    // ---- depot: one of ours that serves both stations, else on a siding off the new line (station ends stay
    // free for extensions), else behind a station. A depot serves the line when its trains reach one station and
    // go on from there to the other (trains leave a siding one way and turn at the first station; a depot behind a
    // platform track that leads nowhere else would strand them): one that does not is taken up again
    const d0 = net.nextEdge;
    let dep = -1, first = -1;
    for (const d of g.depots.map.values()) {
      if (d.owner !== owner || d.kind !== 'rail') continue;
      const f = depotServes(g, d, stA.id, stB.id, hs ? cars : undefined);
      yield;
      if (f >= 0) { dep = d.id; first = f; break; }
    }
    const ownDepot = dep < 0;
    const take = (id: number): boolean => {
      if (id < 0) return false;
      const d = g.depots.get(id), f = d ? depotServes(g, d, stA.id, stB.id, hs ? cars : undefined) : -1;
      if (f >= 0) { dep = id; first = f; return true; }
      this.removeDepotBranch(id);
      return false;
    };
    // A terminal yard feeds either running track after pairing. An interior single-track siding can face
    // against the pair's eventual one-way direction, so prefer the terminal yard for an initial pair.
    if (initialBudget) for (const [st, o] of [[stA, stB], [stB, stA]] as [Station, Station][]) if (dep < 0)
      take(yield* this.depotSwitch(st, { x: o.x - st.x, z: o.z - st.z }));
    for (const pair of pairOptions) for (const st of [stB, stA]) if (dep < 0)
      take(yield* this.depotNearLine([...p.edges], st.x, st.z, 60, pair.entries, pair.corridor));
    for (const st of [stB, stA]) if (dep < 0) take(yield* this.depotNearLine([...p.edges], st.x, st.z, 60));
    for (const [st, o] of [[stB, stA], [stA, stB]] as [Station, Station][]) if (dep < 0) take(yield* this.depotSwitch(st, { x: o.x - st.x, z: o.z - st.z }));
    this.track(d0);
    if (dep < 0) return fail('no depot site that serves both stations', 720);
    if (ownDepot) p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    yield;
    // The opening must have a usable depot and access before optional capacity spending. A two-stop draft
    // is not a service: paying for its second track cannot rescue a formation from which no train can depart.
    for (const st of [stA, stB]) {
      if (st.owner === owner && !g.stations.hasAccess(st)) { yield* this.roadAccessGen(st); yield; }
      if (!g.stations.hasAccess(st)) return fail(`no road access at ${st.name}`, 720);
    }
    // ---- Lay the economic initial pair before any train enters the formation. Reprice the actual geometry,
    // including both junction leads, rather than exempting an unopened line from an upgrade-return gate.
    let initiallyDoubled = false;
    let early: { line: Line; info: LineInfo } | null = null;
    const pairRoute = upgradeRoute(g, stA.id, stB.id, owner);
    if (initialBudget) {
      const line = g.lines.create('rail', owner);
      line.stops = [stA.id, stB.id];
      p.line = line.id;
      const info: LineInfo = { kind: 'rail', towns: [A.id, B.id], depot: dep, maxVehicles: 2, opened: g.day,
        upgradeFailed: g.day };
      this.lines.set(line.id, info);
      early = { line, info };
      g.lines.rebuild();
      const t0 = net.nextEdge;
      const result = layInitialDoubleTrack(g, pairRoute, owner, initialTraffic,
        cost => cost <= initialBudget * 1.2 && this.available() >= cost + (trainCost + mail.price) * nTrains + 300_000 && this.borrowFor(cost),
        undefined, plan => this.initialPairDepot(plan, dep, stA.id, stB.id, hs ? cars : undefined), (trainCost + mail.price) * nTrains + 300_000);
      initiallyDoubled = result.built;
      if (result.built) {
        this.stats.doubled++; this.stats.trackDouble += result.edges.reduce((n, id) => n + (net.edges.get(id)?.len ?? 0), 0);
        this.stats.signals += result.signals;
        this.note(`${what} ${A.name}-${B.name}: double from opening (${k(result.cost)}, ${k(result.choice!.recovered)} recovered/year)`);
      }
      this.track(t0);
      info.double = initiallyDoubled && lineIsDouble(g, line, owner);
      if (info.double) info.maxVehicles = 4;
      this.signalLine(line.id);
      g.stations.refreshAccess();
    }
    // ---- passing loops: the other platform tracks join the main line a little way out
    // Platforms still unused after a complete double upgrade join its approach by the usual turnout ladder.
    for (const [st, ends] of (join ? [[stA, fAs]] : [[stA, fAs], [stB, fBs]]) as [Station, number[]][]) {
      const n0 = net.nodes.get(ends[0]);
      if (!n0) continue;
      const out = { x: Math.sin(st.rail!.angle) * (facing(st, st === stA ? stB : stA) ? 1 : -1), z: Math.cos(st.rail!.angle) * (facing(st, st === stA ? stB : stA) ? 1 : -1) };
      for (let i = 1; i < ends.length; i++) {
        const ni = net.nodes.get(ends[i]);
        if (!ni || ni.edges.length !== 1) continue;
        const t0 = net.nextEdge;
        for (const L of [14, 12, 16]) {
          const sn = findSnap(g, 'rail', n0.x + out.x * L, n0.z + out.z * L, 0.4);
          if (sn.kind !== 'edge') continue;
          const pj = planEdge(g, nodeSnap(g, ends[i], 'rail'), sn, { kind: 'rail', type: sidingType(type), tracks: 1, heightOffset: 0, crossing: 'auto', owner });
          yield;
          if (pj.ok && !commitProposal(g, pj)) break;
        }
        this.track(t0);
        yield;
      }
      // platforms still loose at the line's end (wide high-speed curves need a longer throat): turnout ladders
      // onto the approach (stations API)
      if (ends.slice(1).some((id) => net.nodes.get(id)?.edges.length === 1)) {
        const t0 = net.nextEdge;
        if (st.owner === owner) Trackops.connectStationThroat(g, st.id, owner);
        this.track(t0);
        yield;
      }
    }
    yield;
    // Pair junctions and passing loops may change the directed departure path. Revalidate it before trains.
    first = depotServes(g, dp, stA.id, stB.id, hs ? cars : undefined);
    if (first < 0) return fail('depot no longer serves both stations', 720);
    // Track crossings and the depot approach can alter the station's access street after its platforms
    // were committed. Prove access again on the finished geometry before opening a passenger service.
    for (const st of [stA, stB]) {
      if (st.owner === owner && !g.stations.hasAccess(st)) { yield* this.roadAccessGen(st); yield; }
      if (!g.stations.hasAccess(st)) return fail(`no road access at ${st.name}`, 720);
    }
    // ---- line: extend our line ending at the hub (through trains stopping at every station: a multi-town
    // line A–hub–B, out and back), or a new one
    // (or ours ending at B's station, joined: extended back to A)
    if (!itineraryLive()) return fail('through timetable or stock changed during construction', 360);
    if (service.through && existingFleet.some(t => !this.quotedRailLeg(stA, stB, t.cars)))
      return fail('existing through fleet cannot use the completed branch', 720);
    itineraryLive = () => true; // The builder now changes the exact itinerary it priced.
    const extA = hs || !service.through || !full.extension || full.old.at(-1)?.id !== stA.id ? undefined : full.extension;
    const extB = hs || !service.through || extA ? undefined : full.extension;
    const ext = extA ?? extB, at = extA ? stA : stB, add = extA ? stB : stA;
    let line = ext ? g.lines.get(ext[0])! : early?.line ?? null;
    let extensionLength = 0;
    if (line && ext) {
      let path = linearStops(line.stops)!;
      if (path[0] === at.id) path = path.reverse();
      path = [...path, add.id];
      extensionLength = path.length;
      line.stops = outAndBack(path);
      g.lines.rebuild();
      for (const vid of line.vehicles) g.vehicles.get(vid)?.onLineChanged();
      this.stats.multiTown = Math.max(this.stats.multiTown, path.length);
    } else {
      if (!line) { line = g.lines.create('rail', owner); p.line = line.id; }
      // the first stop is one the depot reaches; from another company's station, our trains run on along its line
      // too (stopping at its stations: a line through several towns on shared track)
      const foreignEnd = hub?.owner !== owner && hub ? hub : (hubB ?? join?.S)?.owner !== owner ? hubB ?? join?.S : null;
      const froute = !hs && service.through && foreignEnd ? full.foreign : null, fpath = froute?.path;
      if (fpath && fpath.length >= 2) {
        line.stops = outAndBack([...fpath, foreignEnd === hub ? stB.id : stA.id]);
        // a through service: the route keeps its letter and numbering (their AS01…, our BS08…)
        g.lines.inheritRoute(line.id, froute!.line);
        this.stats.multiTown = Math.max(this.stats.multiTown, fpath.length + 1);
      } else line.stops = first === stA.id ? [stA.id, stB.id] : [stB.id, stA.id];
      if (early) g.lines.rebuild();
    }
    p.openingLine = line.id;
    // Optional depot-spur crossings are priced against the actual final timetable and departure rails.
    // borrowFor(fleet + 300k) keeps another 300k. Price additional debt against original normal signalling/funding.
    const fleet = mail.cars.reduce((n, c) => n + c.cost, 0) * nTrains, fleetReserve = fleet + 600_000;
    let fundingBaseline: ReturnType<typeof openingFundingBaseline> | undefined;
    const openingReturn = { total, fleet, income, running, maintenance: maint,
      wear: Math.max(0, sv.trackUpkeep - len * trackBasePerUnit(type)), amortisation };
    let repaired = false, finishing = 0;
    for (const st of [stA, stB]) {
      if (ext || !p.stations.includes(stA.id) || !p.stations.includes(stB.id) || st.owner !== owner) continue;
      const signalPlan = openingSignalPlan(g, line, dep, mail.cars, first);
      if (!signalPlan) continue;
      // No yield here: retain this original no-repair debt comparison across both stations/candidate retries.
      const originalFunding = fundingBaseline ??= openingFundingBaseline(this.eco, fleet,
        Signals.autoSignalLine(g, line.id, owner, { preview: true }).cost);
      const t0 = net.nextEdge;
      let approved: ReturnType<typeof openingFundingAppraisal> | undefined;
      const result = Trackops.connectStationThroat(g, st.id, owner, { junctions: true, reserve: fleetReserve, signals: signalPlan,
        approve: (cost, upkeep, finish) => {
          const quote = openingFundingAppraisal(this.eco, originalFunding, cost + finish, this.loanAppetite, this.available());
          approved = quote.affordable && openingThroatReturn(g, throatFinance, p, openingReturn, cost + finish, upkeep, quote.annualInterest)?.pays === true ? quote : undefined;
          return !!approved;
        },
        fund: () => !!approved && this.borrowFor(approved.amount) && this.eco.money >= approved.target });
      this.track(t0);
      if (result.connected) { repaired = true; finishing = result.finishing ?? 0; }
      if (result.failed.length) this.note(`${what} ${st.name}: incomplete throat (${result.failed.join('; ')})`);
    }
    // signals for the new or extended line (before its trains run)
    if (repaired) {
      const exact = openingSignalPlan(g, line, dep, mail.cars, first);
      if (!exact || exact.cost > finishing || this.eco.money < fleetReserve + exact.cost
        || openingThroatReturn(g, throatFinance, p, openingReturn, exact.cost, 0,
          Math.max(0, this.eco.loan - fundingBaseline!.noRepairLoan) * this.eco.interestRate)?.pays !== true)
        return fail('opening signalling exceeds its paid completion reserve', 720);
      const signals = Signals.autoSignalLine(g, [...exact.edges], owner);
      this.stats.signals += signals.placed;
      if (signals.placed !== exact.plan.placed || signals.changed !== exact.plan.changed
        || signals.warnings.some(w => !exact.plan.warnings.includes(w))) return fail('opening signalling cannot be completed safely', 720);
    } else this.signalLine(line.id);
    yield;
    // (building may have cost more than planned: borrow for the trains; a line still without one gets its first
    // train later, see manage, rather than the railway being lost)
    if (repaired) {
      if (this.eco.money < fleetReserve) return fail('paid opening fleet reserve changed before purchase', 720);
    } else this.borrowFor((trainCost + mail.price) * nTrains + 300_000);
    // The actual shared timetable bids with its native full-route forecast, then honours the paid capacity auction.
    priceSharedProject(g, line, { ...forecast, kmh: sv.kmh, headway: sv.headway });
    let bought = 0;
    for (let i = 0; i < nTrains; i++) {
      const openingCars = this.mailPolicy.openingCars(line, mail.cars);
      if (!sharedTrainAllowed(g, line, owner, openingCars)) {
        if (!bought && service.through) return fail('shared capacity cannot admit the priced through fleet', 360);
        break;
      }
      const t = g.vehicles.buyTrain(dep, openingCars, line.id);
      if (typeof t !== 'string') {
        const call = openingRailCall(g, t, first);
        if (call < 0) { g.vehicles.sell(t.id); return fail('depot no longer serves the final timetable', 720); }
        t.stopIndex = call;
        bought++; this.stats.vehicles++;
      }
      yield;
    }
    if (!bought) this.note(`no money for a train on ${line.name} yet`);
    if (!ext) {
      const info: LineInfo = early?.info ?? { kind: 'rail', towns: [A.id, B.id], depot: dep, maxVehicles: 2, opened: g.day };
      info.depot = dep;
      this.lines.set(line.id, info);
    }
    if (initiallyDoubled) {
      const info = this.lines.get(line.id);
      if (info) { info.double = lineIsDouble(g, line, owner); if (info.double) info.maxVehicles = Math.max(4, info.maxVehicles); }
    }
    if (ext) {
      // A refused/cancelled extension retires its added stops through native station cleanup.
      // Its completed-service metadata belongs to the same successful completion boundary.
      ext[1].towns = [...new Set([...ext[1].towns, A.id, B.id])];
      ext[1].maxVehicles = Math.max(ext[1].maxVehicles, Math.min(6, extensionLength + 1));
      p.line = line.id;
    }
    this.stats.lines += ext ? 0 : 1; this.stats.railStations += (hub ? 0 : 1) + (hubB ? 0 : 1);
    if (hubB) this.stats.joinedStations++;
    // the corridor goes on: the town beyond B is the next extension (through B's free platform ends)
    const next = (hub && hub.owner !== owner) || join ? null : this.townBeyond(A, B);
    // the joined station's own lines get their signals again (the junction on its approach)
    if (join) { this.stats.joinedStations++; for (const l2 of g.lines.map.values()) if (l2.owner === owner && l2.id !== line.id && l2.stops.includes(join.S.id)) this.signalLine(l2.id); }
    this.state.corridor = next ? [stB.id, next.id] : undefined;
    if (hub || hubB || join) this.stats.reused++;
    this.stats.spent += Math.max(0, spent0 - this.eco.money) + total - est;
    g.postNews(hub ? `${this.name} extends its railway ${hub.name} to ${stB.name}, ${(len / 100).toFixed(1)} km.`
      : `${this.name} opens a ${what} ${stA.name} to ${stB.name}, ${(len / 100).toFixed(1)} km.`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`${hub ? 'extended railway ' + hub.name + '-' + stB.name + (ext ? ' (line ' + line.name + ')' : '') : 'opened ' + what + ' ' + stA.name + '-' + stB.name}${hubB ? ' (joined at ' + hubB.name + ')' : ''}: ${Math.round(len)} u, ${res.bridges} bridges, ${res.tunnels} tunnels`);
    if (hs) { this.stats.hsr++; const inf = this.lines.get(line.id); if (inf) inf.hsr = true; }
    this.canonical(line.id);
    // a new station of ours beside another company's network: the network planner looks at linking the two soon
    // (direct services across both; ai-network.ts xlink)
    for (const st of [stA, stB]) if (st.owner === owner && [...g.stations.map.values()].some((o) => o.rail && o.owner !== owner && this.agrees(o.owner)
      && Math.hypot(o.x - st.x, o.z - st.z) < 200 && g.stations.gap(o, st) <= XLINK_REACH)) { scheduleNetworkTask(this, 'xlink', 30); break; }
  }

  /**
   * One line per route (9k): a line we just created or changed that is a subset / superset of another line's route
   * becomes one line with service patterns (patterns.ts canonicalizeLines; vehicles keep their owner and run a
   * pattern). Our bookkeeping follows the merge: a line merged away is dropped, what it was (urban, high speed, its
   * towns) carries over to the line that stays (ours, or another company's we now run trains on). Returns the id
   * the line lives on as.
   */
  private canonical(lineId: number): number {
    const g = this.game;
    let id = lineId;
    try {
      for (const n of canonicalizeLines(g, lineId)) {
        this.note(n.text);
        if (n.from === id) id = n.into;
        const from = this.lines.get(n.from);
        this.lines.delete(n.from);
        if (!from) continue;
        const into = this.lines.get(n.into), l = g.lines.get(n.into);
        if (into) {
          into.towns = [...new Set([...into.towns, ...from.towns])];
          into.maxVehicles = Math.max(into.maxVehicles, from.maxVehicles);
          into.urban ??= from.urban; into.hsr ??= from.hsr;
        } else if (l && l.id === n.into) this.lines.set(n.into, { ...from, joined: l.owner !== this.companyId || undefined, shared: l.owner !== this.companyId ? l.owner : from.shared });
      }
    } catch (e) { this.onError(e); }
    return id;
  }

  /**
   * Walking transfers from a new station or stop of ours to the stations nearby (transfer range): rail stations
   * (ours, or of companies whose network we may use, or who may use ours) and our own stops. Passengers then change
   * between the lines of the complex.
   */
  private linkTransfers(id: number) {
    const g = this.game, me = this.companyId;
    try {
      for (const o of g.stations.transferOptions(id)) {
        if (o.linked || o.link !== null) continue;
        const st = g.stations.get(o.id);
        if (!st || (!st.rail && st.owner !== me)) continue;
        // A pedestrian shortcut between neighbouring calls of the same rail service would route its short trips
        // away from the trains. Complexes connect different services, whatever their track types.
        const from = g.stations.get(id);
        if (from?.rail && st.rail && [...g.lines.map.values()].some((l) => l.stops.includes(id) && l.stops.includes(st.id))) continue;
        if (!g.stations.link(id, o.id)) { this.stats.transfers++; this.note(`walking transfer ${g.stations.get(id)?.name ?? ''} - ${st.name}`); }
      }
    } catch (e) { this.note('transfer link failed: ' + String((e as Error)?.message ?? e)); }
  }

  /**
   * A ground station attracts passengers only when it is connected to the roads (stations.ts builds an access
   * street when it can): if it has none, a street from the station building to the nearest road.
   */
  private *accessRepairJob(id: number): Generator<void, void> {
    const st = this.game.stations.get(id);
    if (st) yield* this.roadAccessGen(st);
    this.accessTask = null;
    this.state.phase = 'idle';
  }

  private *roadAccessGen(st: Station): Generator<void, void> {
    const g = this.game, net = g.world.net;
    const task = this.accessTask ??= { station: st.id, stage: 'road', side: 0 };
    const done = () => { this.accessTask = null; };
    while (true) {
      if (!g.stations.get(st.id)?.rail) { done(); return; }
      if (task.stage === 'road') {
        if (g.stations.hasAccess(st)) { done(); return; }
        const b = st.rail!.building;
        const connected = (e: NEdge) => {
          if (!pedestrianRoad(e)) return false;
          const seen = new Set<number>([e.id]), pending = [e];
          let length = 0;
          while (pending.length && seen.size < 48) {
            const road = pending.pop()!; length += road.len;
            if (length >= 20) return true;
            for (const id of [road.a, road.b]) for (const eid of net.nodes.get(id)?.edges ?? []) {
              const next = net.edges.get(eid);
              if (!seen.has(eid) && next && pedestrianRoad(next)) { seen.add(eid); pending.push(next); }
            }
          }
          return false;
        };
        const ne = net.nearestEdge(b.x, b.z, 40, 'road', connected);
        if (ne) {
          const q = { x: 0, y: 0, z: 0 }; net.pointAt(ne.edge, ne.s, q);
          const d = Math.hypot(q.x - b.x, q.z - b.z) || 1, off = Math.max(b.w, b.d) / 2 + 0.8;
          const forecourt = g.stations.forecourt(st);
          const from = forecourt ? findSnap(g, 'road', forecourt.x, forecourt.z, 0.6)
            : { kind: 'free' as const, x: b.x + ((q.x - b.x) / d) * off, z: b.z + ((q.z - b.z) / d) * off, y: 0 };
          const to = findSnap(g, 'road', q.x, q.z, 0.6);
          if (to.kind !== 'free') task.road = planEdge(g, from, to, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.companyId });
        }
        task.stage = 'roadCommit';
      } else if (task.stage === 'roadCommit') {
        const pj = task.road;
        if (pj?.ok && pj.demolish.length <= 1 && pj.cost < this.available() * 0.2 && !commitProposal(g, pj)) {
          g.stations.refreshAccess(true);
          if (g.stations.hasAccess(st)) { this.note(`access road for ${st.name}`); done(); return; }
        }
        delete task.road; task.stage = 'rebuild';
      } else if (task.stage === 'rebuild') {
        if (task.side >= 2) { done(); return; }
        const r = st.rail!;
        task.plan = g.stations.planRail(r.x, r.z, r.angle, r.length, r.tracks, this.companyId, { buildingSide: task.side === 0 ? 1 : -1, ignoreStation: st.id,
          trackType: r.trackType, mode: railPartMode(r), level: r.level, depth: r.depth, height: r.height, style: r.style, platformStyle: r.platformStyle, through: r.through, throughMode: r.throughMode });
        task.stage = 'rebuildCommit';
      } else {
        const plan = task.plan;
        if (plan?.ok && plan.roadAccess && plan.cost <= this.available() * 0.3 && this.borrowFor(plan.cost) && !relocateStation(g, st.id, plan)) {
          this.note(`rebuilt ${st.name} facing a road`); done(); return;
        }
        delete task.plan; task.side++; task.stage = 'rebuild';
      }
      yield;
    }
  }

  /** Prove departure under a candidate pair's right-hand running, before paying for its extra rail. */
  private initialPairDepot(plan: DoublePlan, dep: number, a: number, b: number, cars?: VehicleModel[]): boolean {
    const g = this.game, dp = g.depots.get(dep), stub = dp && g.world.net.edges.get(dp.edge);
    if (!stub) return false;
    // The companion at +(-tz,+tx) carries the plan direction; the original carries the opposite direction.
    const directions = new Map(plan.steps.map(s => [s.edge, -plan.side * s.dir]));
    const stack = [{ edge: stub, dir: 1 }], seen = new Set<string>(), rule = cars ? consistRule(cars) : null;
    while (stack.length && seen.size < 80000) {
      const c = stack.pop()!, key = `${c.edge.id}:${c.dir}`;
      if (seen.has(key) || (directions.has(c.edge.id) && directions.get(c.edge.id) !== c.dir)) continue;
      seen.add(key);
      if (c.edge.station === a || c.edge.station === b) return true;
      stack.push(...railNext(g, c.edge, c.dir, this.companyId, false, rule));
    }
    return false;
  }

  /** A depot on a siding off our edges near (x, z) (as buildDepotNearLine, a try per step). */
  private *depotNearLine(edges: number[], x: number, z: number, maxDist: number, entries?: Map<number, 1 | -1>, reserved?: P2[]): Generator<void, number> {
    const g = this.game, net = g.world.net, owner = this.companyId;
    const cands: { id: number; s: number; d: number }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (const id of edges) {
      yield;
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 8) continue;
      for (let s = 3; s <= e.len - 3; s += 5) {
        if (net.sectionAt(e, s) !== 'ground') continue;
        net.pointAt(e, s, p);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= maxDist) cands.push({ id, s, d });
      }
    }
    cands.sort((a, b) => a.d - b.d || a.id - b.id);
    let tries = 0;
    for (const c of cands) {
      if (!net.edges.has(c.id) || (entries && !entries.has(c.id))) continue;
      yield;
      const dir = entries?.get(c.id);
      const dep = buildDepotOnLine(g, c.id, c.s, owner, dir === undefined ? undefined : { dir, side: -1, reserved });
      if (dep >= 0) return dep;
      if (++tries >= 12) break;
      yield;
    }
    return -1;
  }

  /** Depot for a multi-track terminus: a switch behind the back ends feeding every platform track. */
  private *depotSwitch(st: Station, frontDir: P2): Generator<void, number> {
    const g = this.game, net = g.world.net, owner = this.companyId;
    const r = st.rail!;
    const ax = Math.sin(r.angle), az = Math.cos(r.angle);
    const sgn = ax * frontDir.x + az * frontDir.z > 0 ? -1 : 1; // direction of the back ends
    const bx = ax * sgn, bz = az * sgn;
    const ends = stationEnds(g, st).map((e) => (sgn > 0 ? e.front : e.back));
    const type = sidingType(r.trackType);
    const o = (h: number): BuildOptions => ({ kind: 'rail', type, tracks: 1, heightOffset: h, crossing: 'auto', owner });
    const backC = { x: r.x + bx * r.length / 2, z: r.z + bz * r.length / 2 };
    const e0 = net.nextEdge;
    for (const L of [12, 16, 20]) {
      yield;
      const S = { x: backC.x + bx * L, z: backC.z + bz * L }, D = { x: S.x + bx * 6, z: S.z + bz * 6 };
      if (!g.world.inside(D.x, D.z, 8) || !depotFits(g, D.x, D.z, -bx, -bz, owner, 30, r.y)) continue;
      const n0 = net.nodes.get(ends[0]);
      if (!n0 || n0.edges.length !== 1) return buildRailDepot(g, st, owner, frontDir);
      const p1 = planEdge(g, nodeSnap(g, ends[0], 'rail'), { kind: 'free', x: S.x, z: S.z, y: 0 }, o(r.y - g.world.heightAt(S.x, S.z) || 1e-3));
      yield;
      if (!p1.ok || commitProposal(g, p1)) continue;
      this.track(e0);
      yield;
      const sNode = nodeAt(g, 'rail', S.x, S.z);
      if (!sNode) return -1;
      const p2 = planEdge(g, nodeSnap(g, sNode.id, 'rail'), { kind: 'free', x: D.x, z: D.z, y: 0 }, o(r.y - g.world.heightAt(D.x, D.z) || 1e-3));
      yield;
      if (!p2.ok || commitProposal(g, p2)) { removeEdges(g, [...sNode.edges], owner); continue; }
      this.track(e0);
      yield;
      for (let i = 1; i < ends.length; i++) {
        const p3 = planEdge(g, nodeSnap(g, ends[i], 'rail'), nodeSnap(g, sNode.id, 'rail'), o(0));
        yield;
        if (p3.ok) commitProposal(g, p3);
        this.track(e0);
        yield;
      }
      const dNode = nodeAt(g, 'rail', D.x, D.z);
      const id = dNode ? depotAtEnd(g, dNode.id, owner) : -1;
      if (id >= 0) return id;
      return -1;
    }
    return buildRailDepot(g, st, owner, frontDir);
  }

  /** roadDepotGen's search order, with each site and its commit in separate AI work units. */
  private *roadDepot(x: number, z: number): Generator<void, number> {
    const g = this.game, net = g.world.net, owner = this.companyId;
    for (const maxPop of [0, 30]) {
      for (let r = 2.5; r < 26; r += 1.5) {
        for (let k = 0; k < 12; k++) {
          yield;
          const a = ((k + (r % 2) * 0.5) / 12) * Math.PI * 2;
          const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
          if (!maxPop && g.world.buildingsNear(px, pz, 2.2).some((b) => distToRect(px, pz, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 1.3)) continue;
          const ne = net.nearestEdge(px, pz, 3.6, 'road', (e) => e.depot < 0 && e.station < 0);
          if (!ne || ne.d < 2.1 || net.sectionAt(ne.edge, ne.s) !== 'ground') continue;
          const q = { x: 0, y: 0, z: 0 };
          net.pointAt(ne.edge, ne.s, q);
          const plan = g.depots.plan('road', px, pz, Math.atan2(q.x - px, q.z - pz), owner);
          yield;
          if (!plan.ok || !this.eco.canAfford(plan.cost + 40000)) continue;
          const dem = plan.demolish ?? [];
          if (dem.length > (maxPop ? 1 : 0) || dem.some((id) => (g.world.buildings.get(id)?.pop ?? 0) > maxPop)) continue;
          const id = g.depots.nextId;
          if (g.depots.commit('road', plan, owner)) continue;
          const dp = g.depots.get(id);
          const exit = dp ? net.nodes.get(dp.node) : undefined;
          if (dp && exit && exit.edges.length >= 2) return id;
          if (dp) g.depots.remove(id);
        }
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------- trains on another company's railway
  /** Railways of other companies (that grant access) between two towns we don't connect: [owner, station A, station B]. */
  private shareOptions(opts: { score: number; kind: ProjectKind; towns: number[]; share?: [number, number, number, number]; hub?: number }[], own: LineInfo[], D: { pair: (a: number, b: number) => number }) {
    const g = this.game, me = this.companyId;
    const trainsAt = new Map<number, number>();
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail') continue;
      for (const s of new Set(l.stops)) trainsAt.set(s, (trainsAt.get(s) ?? 0) + l.vehicles.length);
    }
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.owner === me || l.stops.length < 2 || !l.vehicles.length || g.lines.canOperate(l, me)) continue;
      const o = l.owner, co = g.companies[o];
      if (!co || co.defunct || g.accessPolicy(o) === 'auto-reject' || g.isBlocked(o, me) || g.requestsBy(me).some((q) => q.owner === o)) continue;
      // An accessible open line may admit our trains without a station title; stock still pays its native usage fees.
      const joinable = g.lines.partnerPolicy(l) === 'open' && g.canUse(me, o);
      if (!joinable || l.stops.some(id => { const st = g.stations.get(id); return !st || !g.canUse(me, st.owner); })) continue;
      if (l.vehicles.length >= this.lineCapacity(l)) continue;
      const sA = g.stations.get(l.stops[0]);
      if (!sA?.rail) continue;
      let sB: Station | undefined, bd = 0;
      for (const sid of l.stops) { const s = g.stations.get(sid); const d = s ? Math.hypot(s.x - sA.x, s.z - sA.z) : 0; if (s && d > bd) { bd = d; sB = s; } }
      if (!sB?.rail || bd < 60 || bd > 260) continue;
      const A = g.towns.list[sA.townId], B = g.towns.list[sB.townId];
      if (!A || !B || A === B) continue;
      const key = 'share' + o + ':' + this.pairKey(sA.id, sB.id);
      if (this.isFailed(key) || own.some((x) => x.kind === 'rail' && x.towns.includes(A.id) && x.towns.includes(B.id))) continue;
      // a free platform for our train at both ends (each train waits for a free path, so this cannot jam)
      const room = Math.min(sA.rail.tracks, sB.rail.tracks) - Math.max(trainsAt.get(sA.id) ?? 0, trainsAt.get(sB.id) ?? 0);
      if (room < 1) continue;
      // a train and a depot; the fees are our usage share of the line's upkeep (the owner's multiplier)
      const m = g.accessMultiplier(o), upkeep = bd * 1.3 * 330 + 60_000;
      // joining: our train takes its share of the line's passengers (one more train among those running it)
      const part = joinable ? 1 / (l.vehicles.length + 1) * 2 : 1;
      // (one train of the year's models: its fares by the time the trip takes, its running costs; opcosts / fares)
      const sv = this.serviceYear(pickTrain(g.year, Math.min(sA.rail.length, sB.rail.length), bd * 1.3, 2) ?? [], 1, bd, bd * 1.3);
      const net = Math.min(D.pair(A.id, B.id) * 0.3 * 12 * Math.min(1, part), sv.seats) * sv.perPax - sv.running * 0.5 - 100_000 - upkeep * (m / (1 + m));
      const score = Math.sqrt(Math.max(0, net / 1_000_000)) * this.config.focus.rail * this.config.focus.rail;
      opts.push({ score, kind: 'share', towns: [A.id, B.id], hub: sA.id, share: [o, sA.id, sB.id, joinable ? l.id : -1] });
    }
  }

  /** Run our own trains between two stations of another company under a track access agreement. */
  private *shareJob(owner: number, a: number, b: number, joinLine = -1): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net;
    const p = this.project!;
    const stA = g.stations.get(a), stB = g.stations.get(b);
    const oName = g.company(owner).name;
    const key = 'share' + owner + ':' + this.pairKey(a, b);
    const fail = (why: string, days = 1500) => { this.note(`trains on ${oName}'s railway abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (!stA || !stB || !stA.rail || !stB.rail) return fail('stations gone');
    this.state.phase = `negotiating track access with ${oName}`;
    if (!g.hasAccess(me, owner)) {
      const r = g.requestAccess(me, owner, `trains between ${stA.name} and ${stB.name}`);
      if (r === 'pending') {
        this.state.phase = `waiting for track access from ${oName}`;
        p.access = owner;
        while (g.requestsBy(me).some((q) => q.owner === owner)) yield;
      }
      if (!g.hasAccess(me, owner)) return fail(r === 'pending' ? 'access not granted' : 'access ' + r, 3000);
      p.access = owner;
    }
    yield;
    const span = Math.hypot(stA.x - stB.x, stA.z - stB.z);
    const TA = g.towns.list[stA.townId], TB = g.towns.list[stB.townId];
    const cars = pickTrain(g.year, Math.min(stA.rail.length, stB.rail.length), span * 1.25, openingCoaches(TA?.pop ?? 0, TB?.pop ?? 0));
    if (!cars) return fail('no trains available');
    const cost = cars.reduce((s, c) => s + c.cost, 0) + 450_000;
    if (cost > this.available()) return fail('too expensive', 360);
    if (!this.borrowFor(cost)) return fail('no money', 360);
    this.state.phase = `building a depot at ${stA.name}`;
    p.built = true;
    // our depot on a stub behind one of the stations (the line's side stays free)
    const e0 = net.nextEdge;
    // a siding off the owner's line near a station (we may connect to its track: our trains then join the main
    // line instead of waiting behind the owner's platforms), else a stub behind one of the stations
    let dep = -1;
    {
      const q = { x: 0, y: 0, z: 0 };
      for (const st of [stA, stB]) {
        if (dep >= 0) break;
        const cands: { id: number; s: number; d: number }[] = [];
        for (const e of net.edgesNear(st.x - 90, st.z - 90, st.x + 90, st.z + 90)) {
          if (e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 6) continue;
          for (let s = 3; s <= e.len - 3; s += 4) { if (net.sectionAt(e, s) !== 'ground') continue; net.pointAt(e, s, q); const d = Math.hypot(q.x - st.x, q.z - st.z); if (d > 16) cands.push({ id: e.id, s, d }); }
        }
        cands.sort((a, b) => a.d - b.d || a.id - b.id);
        for (const c of cands.slice(0, 16)) { if (!net.edges.has(c.id)) continue; yield; dep = buildDepotOnLine(g, c.id, c.s, me); this.track(e0); if (dep >= 0) break; }
        yield;
      }
    }
    for (const [st, o] of [[stA, stB], [stB, stA]] as [Station, Station][]) {
      if (dep >= 0) break;
      dep = buildRailDepot(g, st, me, { x: o.x - st.x, z: o.z - st.z });
      yield;
    }
    this.track(e0);
    if (dep < 0) return fail('no depot site');
    p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    // trains leave a siding one way: the first stop is a station they reach (they reverse there for the other)
    const ra = depotReaches(g, dp, a), rb = depotReaches(g, dp, b);
    if (!ra && !rb) return fail('stations not reachable');
    yield;
    // an open line of the owner's: our trains join it (no second line on the same route); else a line of ours
    const jl = joinLine >= 0 ? g.lines.get(joinLine) : undefined;
    const joined = !!jl && jl.owner === owner && g.lines.join(jl.id, me) === null;
    let line: Line;
    if (joined) line = jl!;
    else {
      line = g.lines.create('rail', me);
      line.stops = ra ? [a, b] : [b, a];
      p.line = line.id;
    }
    // capacity-integration: a shared-service entrant bids for a path before buying its train.
    if (!sharedTrainAllowed(g, line, me, cars)) { if (joined) g.lines.leave(line.id, me); return fail('shared paths would lose money', 360); }
    const t = g.vehicles.buyTrain(dep, cars, line.id);
    if (typeof t === 'string') { if (joined) g.lines.leave(line.id, me); return fail('could not buy a train: ' + t, 360); }
    const call = openingRailCall(g, t, ra ? a : b);
    if (call < 0) {
      g.vehicles.sell(t.id);
      if (joined) g.lines.leave(line.id, me);
      return fail('depot no longer serves the final timetable', 360);
    }
    t.stopIndex = call;
    this.stats.vehicles++;
    const A = g.towns.list[stA.townId], B = g.towns.list[stB.townId];
    this.lines.set(line.id, { kind: 'rail', towns: [A?.id ?? -1, B?.id ?? -1], depot: dep, maxVehicles: 1, opened: g.day, shared: owner, joined: joined || undefined });
    this.stats.lines++; this.stats.shared++;
    if (joined) this.stats.joined++;
    p.access = -1;
    g.postNews(`${this.name} runs trains on ${oName}’s railway from ${A?.name ?? stA.name} to ${B?.name ?? stB.name}.`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`trains on ${oName}'s railway ${stA.name}-${stB.name}`);
    if (!joined) this.canonical(line.id);
  }

  /** Remove a depot no line of ours uses any more, with the track leading to it up to a junction or foreign track. */
  private removeDepotBranch(depId: number) {
    const g = this.game, net = g.world.net, me = this.companyId;
    for (const x of this.lines.values()) if (x.depot === depId) return;
    const dp = g.depots.get(depId);
    if (!dp || dp.owner !== me) return;
    const exit = dp.node;
    if (g.depots.remove(depId)) return;
    const ids: number[] = [];
    let node = exit;
    for (let k = 0; k < 10; k++) {
      const n = net.nodes.get(node);
      if (!n) break;
      const rest = n.edges.filter((id) => !ids.includes(id));
      if (rest.length !== 1) break;
      const e = net.edges.get(rest[0]);
      if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0) break;
      ids.push(e.id);
      node = e.a === node ? e.b : e.a;
    }
    if (ids.length) removeEdges(g, ids, me);
  }

  /** End access agreements as user that no line of ours relies on any more. */
  private endUnusedAccess(only = -1) {
    const g = this.game, me = this.companyId;
    for (const a of [...g.access]) {
      if (a.user !== me || (only >= 0 && a.owner !== only)) continue;
      // an open network: the agreement only books the fees of whatever we use (trains may pass through)
      if (g.accessPolicy(a.owner) === 'open') continue;
      let used = false;
      for (const l of g.lines.map.values()) {
        if (l.owner !== me) continue;
        if (l.stops.some((s) => g.stations.get(s)?.owner === a.owner)) { used = true; break; }
      }
      if (!used) for (const info of this.lines.values()) if (info.shared === a.owner) { used = true; break; }
      if (!used) { g.endAccess(me, a.owner); this.note(`ended track access to ${g.company(a.owner).name}`); }
    }
  }

  // ---------------------------------------------------------------- bus
  private *busJob(T: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    this.state.phase = `planning buses in ${T.name}`;
    const fail = (why: string) => { this.note(`buses in ${T.name} abandoned: ${why}`); this.markFailed('bus' + T.id, 1200); this.abandon(p); };
    const model = pickBus(g.year, T.pop);
    if (!model) return fail('no buses available');
    // stop candidates on streets: middle of street edges, away from other companies' stops; a stop that joins our
    // rail station in the town comes first (one transfer complex: passengers change between trains and buses)
    const cands: { x: number; z: number; d: number; rail?: boolean }[] = [];
    for (const e of g.towns.streets(T, 0)) {
      if (e.len < 4) continue;
      yield; // one stop candidate per unit, including rejected sites
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || (bp.join && !(bp.join.rail && bp.join.owner === owner && bp.join.townId === T.id))) continue;
      let clash = false;
      for (const st of g.stations.map.values()) if (st.owner !== owner && st.stops.some((s) => Math.hypot(s.x - q.x, s.z - q.z) < 8)) { clash = true; break; }
      if (!clash) cands.push({ x: q.x, z: q.z, d: Math.hypot(q.x - T.x, q.z - T.z), rail: !!bp.join });
    }
    yield;
    if (cands.length < 2) return fail('no stop sites');
    cands.sort((a, b) => (a.rail ? 0 : 1) - (b.rail ? 0 : 1) || a.d - b.d);
    if (cands[0].rail) this.stats.reused++;
    // big towns: a ring line round the centre (4–5 stops, buses circulating one way); else 2–3 stops
    let stops = T.pop >= 2500 ? this.ringStops(T, cands, T.pop >= 5000 ? 5 : 4) : [];
    const ring = stops.length >= 4;
    if (!ring) {
      stops = [cands[0]];
      const nStops = T.pop > 2000 ? 3 : 2;
      for (const c of cands) {
        if (stops.length >= nStops) break;
        if (stops.every((s) => { const d = Math.hypot(s.x - c.x, s.z - c.z); return d > 11 && d < 34; })) stops.push(c);
      }
    }
    if (stops.length < 2) return fail('stops too close');
    const cost = stops.length * 30000 + 120_000 + model.cost * (stops.length + 1);
    if (!this.borrowFor(cost)) return fail('no money');
    this.state.phase = `building buses in ${T.name}`;
    p.built = true;
    yield;
    const ids: number[] = [];
    for (const s of stops) {
      yield;
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) continue;
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (sid >= 0 && !ids.includes(sid)) ids.push(sid);
      if (g.stations.nextId > before) { p.stations.push(before); yield; this.linkTransfers(before); }
      this.stats.busStops++;
      yield;
    }
    if (ids.length < 2) return fail('stops not built');
    const d0 = net.nextEdge;
    const dep = yield* this.roadDepot(stops[0].x, stops[0].z);
    this.track(d0);
    if (dep < 0) return fail('no depot site');
    p.depots.push(dep);
    yield;
    const line = g.lines.create('road', owner);
    line.stops = ids;
    if (ring && ids.length >= 4) { line.loop = true; this.stats.rings++; }
    p.line = line.id;
    const n = Math.min(3, ids.length);
    for (let i = 0; i < n; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') this.stats.vehicles++; yield; }
    this.lines.set(line.id, { kind: 'bus', towns: [T.id], depot: dep, maxVehicles: line.loop ? 6 : 5, opened: g.day });
    this.stats.lines++;
    g.postNews(`${this.name} starts a ${line.loop ? 'circular bus line' : 'bus service'} in ${T.name}.`, 'ai', T.x, T.z);
    this.note(`opened ${line.loop ? 'ring' : 'bus'} line in ${T.name} (${ids.length} stops, ${n} buses)`);
    this.canonical(line.id);
  }

  /**
   * Stops for a ring line round a town centre: one near each of `n` points evenly spaced round the centre (at
   * about half the town radius), a stop at our rail station first when there is one; in order round the ring.
   */
  private ringStops(T: Town, cands: { x: number; z: number; d: number; rail?: boolean }[], n: number): { x: number; z: number; d: number; rail?: boolean }[] {
    const R = Math.max(12, Math.min(26, T.radius * 0.5));
    const out: { x: number; z: number; d: number; rail?: boolean; a: number }[] = [];
    const ang = (c: { x: number; z: number }) => Math.atan2(c.z - T.z, c.x - T.x);
    const a0 = cands[0]?.rail ? ang(cands[0]) : 0;
    if (cands[0]?.rail) out.push({ ...cands[0], a: a0 });
    for (let k = out.length; k < n; k++) {
      const a = a0 + (k * 2 * Math.PI) / n, px = T.x + Math.cos(a) * R, pz = T.z + Math.sin(a) * R;
      let best: (typeof cands)[number] | null = null, bd = 9;
      for (const c of cands) {
        const d = Math.hypot(c.x - px, c.z - pz);
        if (d < bd && out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 11)) { bd = d; best = c; }
      }
      if (best) out.push({ ...best, a: ang(best) });
    }
    if (out.length < Math.min(4, n)) return [];
    // round the ring from the first stop
    const base = out[0].a;
    const rel = (a: number) => ((a - base) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return out.sort((p, q) => rel(p.a) - rel(q.a)).map(({ a: _a, ...c }) => c);
  }

  /**
   * A year of `n` vehicles of `models` shuttling between two stations `dist` apart over a route of `len` units (route
   * evaluation): one-way trips (opcosts estimateVehicleYear: the physics of the hop, dwell), the seats they offer at
   * `load`, the fare per passenger by the time the trip takes (fares.ts: ride + half the headway against the
   * alternative), the vehicles' running costs and the track's upkeep (base by type, plus their wear).
   */
  private serviceYear(models: VehicleModel[], n: number, dist: number, len: number, trackType = 'standard', load = 0.7, speedCap = Infinity): { seats: number; perPax: number; running: number; trackUpkeep: number; headway: number; kmh: number } {
    const g = this.game;
    if (!models.length) return { seats: 0, perPax: 0, running: 0, trackUpkeep: 0, headway: 0, kmh: 0 };
    // (memoised per game, model set, size and year: project choice evaluates many town pairs every few weeks)
    const key = models.map((m) => m.id).join(',') + `|${n}|${dist}|${len}|${trackType}|${load}|${speedCap}|${g.year}`;
    let memo = serviceMemo.get(g);
    if (!memo) serviceMemo.set(g, (memo = new Map()));
    const hit = memo.get(key);
    if (hit) return hit;
    const out = this.serviceYearCalc(models, n, dist, len, trackType, load, speedCap);
    if (memo.size > 4000) memo.clear();
    memo.set(key, out);
    return out;
  }

  private serviceYearCalc(models: VehicleModel[], n: number, dist: number, len: number, trackType: string, load: number, speedCap = Infinity): { seats: number; perPax: number; running: number; trackUpkeep: number; headway: number; kmh: number } {
    const g = this.game;
    const cap = models.reduce((a, c) => a + c.capacity, 0);
    // (road vehicles: 'road' country roads, 'street' in town; no track of their own to keep up)
    const road = trackType === 'road' || trackType === 'street';
    const vcap = Math.min(speedCap, ...models.map((m) => m.speed), road ? (trackType === 'road' ? 90 : 50) : TRACK_TYPES[trackType]?.speed ?? 160);
    const yr = estimateVehicleYear(models, len / 1.15, g.year, load, vcap);
    const hopS = YEAR_S / Math.max(0.1, yr.trips);
    const headway = (2 * hopS) / Math.max(1, n);
    const kmh = (len * UNIT_M) / 1000 / (hopS / 3600);
    // the fare model the vehicles will earn by (receipts: vehicle.ts): rail with its minimum per journey, tram or bus fares
    const perPax = estimateLegFare(dist, kmh, headway, 1, len / Math.max(1, dist), true, true, { mode: road ? (models[0]?.kind === 'tram' ? 'tram' : 'bus') : 'rail' });
    return { seats: n * yr.trips * cap * load, perPax, running: n * yr.total, trackUpkeep: road ? 0 : len * (trackBasePerUnit(trackType) + n * yr.trackWearPerUnit), headway, kmh };
  }

  /**
   * An underground main-line station in the centre of town T (subway style), its platforms pointing at `toward`:
   * the site among a few near the centre with the most people in reach of its entrances, or null.
   */
  private *centreStation(T: Town, toward: P2, PL: number, level: 'ground' | 'elevated' | 'underground' = 'underground'): Generator<void, StationPlan | null> {
    const g = this.game, me = this.companyId;
    const a0 = Math.atan2(toward.x - T.x, toward.z - T.z);
    let best: StationPlan | null = null, bestPop = 0;
    for (const r of [0, 7, 14]) {
      for (const da of r ? [0, Math.PI / 2, Math.PI, -Math.PI / 2] : [0]) {
        const x = T.x + Math.sin(a0 + da) * r, z = T.z + Math.cos(a0 + da) * r;
        for (const aa of [0, 0.25, -0.25]) {
          const angle = Math.atan2(toward.x - x, toward.z - z) + aa;
          const pl = g.stations.planRail(x, z, angle, PL, 2, me, { level, depth: 2.4, height: 1.5, ...(level !== 'ground' ? { entrances: CITY_ENTRANCES } : {}) });
          yield;
          if (!pl.ok || pl.join || !stationAccessSafe(pl)) continue;
          const pop = walkingPopulation(g, planWalkingCatchment(g, pl));
          if (pop > bestPop) { bestPop = pop; best = pl; }
        }
        yield;
      }
      if (best) break;
    }
    return best;
  }

  // ---------------------------------------------------------------- cross-city links (9k)
  private cooperationReserved(): boolean {
    return this.game.ais.some((ai) => ai !== this && ai.project?.joint?.partner === this.companyId);
  }

  private crossCityEconomics(T: Town, a: ReturnType<AIController['cityTermini']>[number], b: ReturnType<AIController['cityTermini']>[number], centre?: StationPlan) {
    const g = this.game, partner = b.st.owner !== this.companyId ? g.aiOf(b.st.owner) : undefined;
    const capacity = (l: Line) => l.vehicles.reduce((n, id) => n + (g.vehicles.get(id)?.capacity ?? 0), 0);
    const usageA = capacity(a.line), usageB = capacity(b.line);
    const share = partner ? (usageA > 0 && usageB > 0 ? usageA / (usageA + usageB) : 0.5) : 1;
    const mid: ForecastSite = { x: (a.st.x + b.st.x) / 2, z: (a.st.z + b.st.z) / 2, townId: T.id,
      walk: pointWalkingCatchment(g, (a.st.x + b.st.x) / 2, (a.st.z + b.st.z) / 2, 'rail', 0, 8) };
    const points = [...a.path.map((id) => g.stations.get(id)!), centre ?? mid, ...[...b.path].reverse().map((id) => g.stations.get(id)!)];
    const cars = [...a.line.vehicles, ...b.line.vehicles].map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train);
    const len = Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z) * 1.2;
    const totalLen = points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - points[i].x, p.z - points[i].z), 0);
    const train = cars[0]?.cars ?? pickTrain(g.year, Math.min(a.st.rail!.length, b.st.rail!.length), totalLen, 2) ?? [];
    const sv = this.serviceYear(train, Math.max(2, cars.length), totalLen, totalLen, 'standard', 0.4);
    const combined = g.demand.forecastLine(points, 'mainline', sv.kmh, sv.headway);
    const old = [a, b].map((end) => {
      const pts = end.path.map((id) => g.stations.get(id)!);
      const d = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.z - pts[i].z), 0);
      const n = Math.max(1, end.line.vehicles.length), service = this.serviceYear(train, n, d, d, 'standard', 0.4);
      return g.demand.forecastLine(pts, 'mainline', service.kmh, service.headway).revenue;
    });
    const electric = cars.some((v) => v.cars.some((m) => m.traction === 'electric'))
      || [a.st, b.st].some((st) => TRACK_TYPES[st.rail!.trackType ?? 'standard']?.electrified);
    const tunnelType = electric ? 'electric' : 'standard';
    const cost = (centre?.cost ?? 2_000_000) + len * TRACK_TYPES[tunnelType].costPerUnit * 8.5 + 100_000;
    const revenue = Math.max(0, combined.revenue - old[0] - old[1]);
    const yearly = len * trackBasePerUnit(tunnelType) * 5 + STATION_UPKEEP_FACTOR.underground * (20_000 + 2 * (centre?.length ?? 12) * 500) + 50_000;
    const net = revenue - yearly;
    const gainA = partner ? combined.revenue * share - old[0] - yearly * share : net;
    const gainB = partner ? combined.revenue * (1 - share) - old[1] - yearly * (1 - share) : 0;
    const viable = this.available() >= cost * share * 1.05 && (!partner || partner.available() >= cost * (1 - share) * 1.05)
      && gainA > 0 && gainA * URBAN_PAYBACK.crosscity >= cost * share
      && (!partner || (gainB > 0 && gainB * URBAN_PAYBACK.crosscity >= cost * (1 - share) && usageA > 0 && usageB > 0
        && g.accessPolicy(partner.companyId) === 'open' && g.accessPolicy(this.companyId) === 'open'));
    return { cost, revenue, yearly, net, share, partner, viable, gainA, gainB };
  }
  /** Our main-line termini in town T (a line of ours ends there, its tracks free on one side): the line, its path, which side is free. */
  private cityTermini(T: Town, owner = this.companyId): { st: Station; line: Line; path: number[]; towns: number[]; side: 1 | -1 }[] {
    const g = this.game, net = g.world.net, out: { st: Station; line: Line; path: number[]; towns: number[]; side: 1 | -1 }[] = [];
    for (const l of g.lines.map.values()) {
      if (l.owner !== owner || l.kind !== 'rail' || l.operators?.length) continue;
      const path = linearStops(l.stops);
      if (!path || path.length < 2 || path.some((id) => { const st = g.stations.get(id); return !st?.rail || railPartMode(st.rail) !== 'mainline'; })) continue;
      for (const [end, p] of [[path[path.length - 1], path], [path[0], [...path].reverse()]] as [number, number[]][]) {
        const st = g.stations.get(end);
        if (!st?.rail || st.townId !== T.id || st.owner !== owner || railPartMode(st.rail) !== 'mainline') continue;
        const ends = stationEnds(g, st);
        const free = (k: 'front' | 'back') => ends.every((e) => net.nodes.get(e[k])?.edges.length === 1);
        const side = free('front') ? 1 : free('back') ? -1 : 0;
        if (!side) continue;
        out.push({ st, line: l, path: p, towns: [...new Set(p.map((id) => g.stations.get(id)?.townId ?? -1).filter((t) => t >= 0))], side });
      }
    }
    return out;
  }

  /** The two termini a cross-city link would join: free ends facing each other, 25-320 units apart, different lines. */
  private crossCityPair(T: Town): [ReturnType<AIController['cityTermini']>[number], ReturnType<AIController['cityTermini']>[number]] | null {
    const g = this.game;
    if (g.ais.some((ai) => ai !== this && ai.project?.kind === 'crosscity' && ai.project.towns.includes(T.id))) return null;
    const ts = this.cityTermini(T);
    if (g.accessPolicy(this.companyId) === 'open') for (const ai of g.ais) {
      if (ai === this || ai.disposed || ai.busy || ai.cooperationReserved() || g.accessPolicy(ai.companyId) !== 'open') continue;
      if (g.canUse(this.companyId, ai.companyId) && g.canUse(ai.companyId, this.companyId)) ts.push(...this.cityTermini(T, ai.companyId));
    }
    ts.sort((a, b) => a.st.id - b.st.id);
    let best: [typeof ts[number], typeof ts[number]] | null = null, bd = Infinity;
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i], b = ts[j];
      if (a.line === b.line || a.st === b.st || (a.st.owner !== this.companyId && b.st.owner !== this.companyId)) continue;
      const d = Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z);
      if (d < 25 || d > 320) continue;
      const fa = { x: Math.sin(a.st.rail!.angle) * a.side, z: Math.cos(a.st.rail!.angle) * a.side }, fb = { x: Math.sin(b.st.rail!.angle) * b.side, z: Math.cos(b.st.rail!.angle) * b.side };
      if ((fa.x * (b.st.x - a.st.x) + fa.z * (b.st.z - a.st.z)) / d < 0.3 || (fb.x * (a.st.x - b.st.x) + fb.z * (a.st.z - b.st.z)) / d < 0.3) continue;
      if (d < bd) { bd = d; best = a.st.owner === this.companyId ? [a, b] : [b, a]; }
    }
    return best;
  }

  /**
   * A cross-city link (9k, like Leipzig's or Zurich's): two of our lines that end at termini on different sides of a
   * big town are joined underground through a new city-centre station (subway style; interchanges with the metro
   * and others nearby by walking links), and run on as one through line X–A–Centre–B–Y.
   */
  private *crossCityJob(T: Town): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net;
    const p = this.project!;
    const fail = (why: string, days = 1800) => { this.note(`cross-city link in ${T.name} abandoned: ${why}`); this.markFailed('xcity' + T.id, days); this.abandon(p); };
    this.state.phase = `planning a cross-city link in ${T.name}`;
    const pair = this.crossCityPair(T);
    if (!pair) return fail('no termini to join');
    const [a, b] = pair;
    const cooperating = b.st.owner !== me ? g.aiOf(b.st.owner) : undefined;
    if (cooperating) p.joint = { partner: cooperating.companyId, spent: [0, 0], share: 0.5 };
    const ra = a.st.rail!, rb = b.st.rail!;
    // the centre station: underground between the termini (towards the town centre), platforms along the link
    const ea = stationEnds(g, a.st).map((e) => (a.side > 0 ? e.front : e.back)), eb = stationEnds(g, b.st).map((e) => (b.side > 0 ? e.front : e.back));
    const na = net.nodes.get(ea[0])!, nb = net.nodes.get(eb[0])!;
    const ang = Math.atan2(nb.x - na.x, nb.z - na.z);
    const PL = Math.max(8, Math.min(12, ra.length, rb.length));
    // track type: electric where either line runs electric trains (multiple units go through too)
    const elec = [a.line, b.line].some((l) => l.vehicles.some((id) => { const v = g.vehicles.get(id); return v instanceof Train && v.cars.some((m) => m.traction === 'electric'); }))
      || [ra, rb].some((r) => TRACK_TYPES[r.trackType ?? 'standard']?.electrified);
    const type = elec ? 'electric' : 'standard';
    let C: StationPlan | null = null, bestPop = -1;
    for (const depth of [1.8, 2.4]) for (const t of [0.5, 0.42, 0.58, 0.35, 0.65]) for (const lat of [0, 5, -5]) {
      if (C) break;
      const mx = na.x + (nb.x - na.x) * t + Math.cos(ang) * lat, mz = na.z + (nb.z - na.z) * t - Math.sin(ang) * lat;
      // (cut and cover under the streets where it can, deeper where it must)
      const pl = g.stations.planRail(mx, mz, ang, PL, 2, me, { level: 'underground', depth, trackType: type });
      yield;
      if (!pl.ok || pl.join) continue;
      // the tunnels must reach the platforms within the grade from both termini
      const grade = TRACK_TYPES.standard.maxGrade * 0.85;
      const da = Math.hypot(mx - na.x, mz - na.z) - PL / 2, db = Math.hypot(mx - nb.x, mz - nb.z) - PL / 2;
      if (Math.abs(pl.y - na.y) > grade * da || Math.abs(pl.y - nb.y) > grade * db) continue;
      const pop = walkingPopulation(g, planWalkingCatchment(g, pl)) - Math.hypot(mx - T.x, mz - T.z);
      if (pop > bestPop) { bestPop = pop; C = pl; }
      yield;
    }
    if (!C) return fail('no site for the centre station (or the tunnels would be too steep)');
    const econ = this.crossCityEconomics(T, a, b, C), partner = econ.partner;
    if ((!econ.viable && (!AIController.forceBuild || partner)) || !this.borrowFor(econ.cost * econ.share)
      || (partner && !partner.borrowFor(econ.cost * (1 - econ.share)))) return fail('not affordable or not paying for both operators', 720);
    if (partner) p.joint = { partner: partner.companyId, spent: [0, 0], share: econ.share };
    this.state.phase = `building a cross-city link in ${T.name}`;
    p.built = true;
    const id = g.stations.nextId;
    if (g.stations.commitRail(C, me)) return fail('station site taken', 720);
    const c = g.stations.get(id);
    if (!c?.rail) return fail('station gone', 720);
    p.stations.push(id);
    if (partner) {
      const contribution = C.cost * (1 - econ.share);
      partner.eco.spend(contribution, 'construction', true); this.eco.spend(-contribution, 'construction', true);
      p.joint!.spent[0] += C.cost - contribution; p.joint!.spent[1] += contribution;
    }
    this.track(net.nextEdge - 2);
    yield;
    // the tunnels: each terminus' free end to the centre platforms (biarc chains under the town)
    const ec = stationEnds(g, c);
    const fwdC = Math.sin(c.rail.angle) * (nb.x - na.x) + Math.cos(c.rail.angle) * (nb.z - na.z) >= 0;
    const cA = ec.map((e) => (fwdC ? e.back : e.front)), cB = ec.map((e) => (fwdC ? e.front : e.back));
    const link = function* (self: AIController, from: number, to: number, owner: number): Generator<void, string | null> {
      const n0 = net.nodes.get(from)!, n1 = net.nodes.get(to)!;
      const t0 = nodeTangent(g, from, n1), t1 = nodeTangent(g, to, n0);
      const way: OPoint[] = [{ x: n1.x, z: n1.z, tx: -t1.tx, tz: -t1.tz }];
      const exclude = new Set<number>([...n0.edges, ...n1.edges]);
      const prof = chainProfile(g, [{ x: n0.x, z: n0.z, tx: t0.tx, tz: t0.tz }, ...way], 1, n0.y, n1.y, 'rail', exclude);
      if (!prof) return 'too steep';
      const e0 = net.nextEdge;
      const e = g.company(owner).economy;
      let before = e.yearTotals.reduce((s, y) => s - y.v.construction, -e.thisYear.construction);
      const account = () => {
        if (!p.joint) return;
        const after = e.yearTotals.reduce((s, y) => s - y.v.construction, -e.thisYear.construction);
        p.joint.spent[owner === me ? 0 : 1] += after - before; before = after;
      };
      const ch = aiChainGen(g, from, way, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner }, to, prof);
      let r = ch.next();
      while (!r.done) { self.track(e0); account(); yield; r = ch.next(); }
      self.track(e0);
      account();
      return r.value.ok ? null : r.value.error ?? 'cannot build';
    };
    const e1 = yield* link(this, ea[0], cA[0], me);
    if (e1) return fail(`tunnel ${a.st.name}-${c.name}: ${e1}`, 1500);
    const e2 = yield* link(this, cB[0], eb[0], partner?.companyId ?? me);
    if (e2) return fail(`tunnel ${c.name}-${b.st.name}: ${e2}`, 1500);
    // the second centre platform joins too (trains pass each other there)
    const throat = (Trackops as unknown as { connectStationThroat?: (g: Game, id: number, owner: number) => unknown }).connectStationThroat;
    if (throat) for (const st of [a.st, c, b.st]) {
      const eco = g.company(st.owner).economy;
      const before = eco.yearTotals.reduce((s, y) => s - y.v.construction, -eco.thisYear.construction);
      const t0 = net.nextEdge; throat(g, st.id, st.owner); this.track(t0);
      if (p.joint) p.joint.spent[st.owner === me ? 0 : 1] +=
        eco.yearTotals.reduce((s, y) => s - y.v.construction, -eco.thisYear.construction) - before;
      yield;
    }
    yield;
    // Settle the actual investment before joining live services. An overrun must still fit each operator's
    // credit appetite and individual return; it cannot be charged forcibly to the other company.
    if (partner && p.joint) {
      const spent = p.joint.spent, total = spent[0] + spent[1], balance = total * econ.share - spent[0];
      if (total * econ.share > econ.gainA * URBAN_PAYBACK.crosscity || total * (1 - econ.share) > econ.gainB * URBAN_PAYBACK.crosscity
        || (balance > 0 && (this.available() < balance || !this.borrowFor(balance)))
        || (balance < 0 && (partner.available() < -balance || !partner.borrowFor(-balance)))) return fail('joint construction exceeded an operator’s budget or payback', 720);
      if (balance > 0) { this.eco.spend(balance, 'construction'); partner.eco.spend(-balance, 'construction', true); }
      else { partner.eco.spend(-balance, 'construction'); this.eco.spend(balance, 'construction', true); }
      p.joint.spent = [total * econ.share, total * (1 - econ.share)];
    }
    // one through line: X ... A - Centre - B ... Y (b's trains join it)
    let l = a.line;
    const lb = b.line;
    const path = [...a.path, c.id, ...[...b.path].reverse()];
    const original = [...l.stops];
    l.stops = outAndBack([...a.path, c.id, b.st.id]);
    g.lines.rebuild();
    const ops = Patterns as unknown as {
      canJoinLines?: (g: Game, a: Line, b: Line) => { ok: boolean; reason?: string };
      joinLines?: (g: Game, a: Line, b: Line, opts: { notify: boolean }) => string | { line: Line };
    };
    if (ops.canJoinLines && ops.joinLines) {
      const check = ops.canJoinLines(g, l, lb);
      if (!check.ok) { l.stops = original; g.lines.rebuild(); return fail(check.reason ?? 'lines cannot be joined'); }
      const joined = ops.joinLines(g, l, lb, { notify: false });
      if (typeof joined === 'string') { l.stops = original; g.lines.rebuild(); return fail(joined); }
      l = joined.line;
      const through = l.patterns?.[0];
      for (const vid of l.vehicles) if (through) setVehiclePattern(g, vid, through.id);
    } else {
      l.stops = outAndBack(path);
      l.patterns = undefined;
      if (partner) l.operators = [...new Set([...(l.operators ?? []), partner.companyId])];
      for (const vid of [...lb.vehicles]) g.vehicles.get(vid)?.setLine(l.id);
      g.lines.delete(lb.id);
      for (const vid of l.vehicles) { const v = g.vehicles.get(vid); if (v) v.pattern = undefined; }
    }
    const owners = partner ? [this, partner] : [this];
    for (const ai of owners) {
      const old = ai.lines.get(a.line.id) ?? ai.lines.get(b.line.id);
      ai.lines.delete(a.line.id); ai.lines.delete(b.line.id);
      if (old) ai.lines.set(l.id, { ...old, towns: [...new Set([...a.towns, ...b.towns, T.id])], maxVehicles: Math.max(4, old.maxVehicles), joined: l.owner !== ai.companyId || undefined });
    }
    if (partner && p.joint) {
      const total = p.joint.spent[0] + p.joint.spent[1];
      // Existing usage-share agreements meter each company's trains on the other's half and station calls.
      g.requestAccess(me, partner.companyId); g.requestAccess(partner.companyId, me);
      partner.stats.crossCity++; partner.note(`joint cross-city link in ${T.name} with ${this.name}: ${Math.round(total * (1 - econ.share) / 1000)}k share`);
    }
    g.lines.rebuild();
    for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
    p.line = l.id;
    this.signalLine(l.id);
    this.linkTransfers(c.id);
    this.stats.crossCity++;
    this.stats.railStations++;
    g.postNews(`${this.name} opens an underground link in ${T.name} through ${l.name} at ${c.name}.`, 'ai', c.x, c.z);
    this.note(`${partner ? 'joint ' : ''}cross-city link in ${T.name}: ${a.st.name} - ${c.name} - ${b.st.name} (${l.name}, ${path.length} stations, ${Math.round(econ.net / 1000)}k/year forecast)`);
    this.canonical(l.id);
  }

  // ---------------------------------------------------------------- urban railways (metro, light rail)
  /** Long-lived city infrastructure can use a little more of the same credit line, in proportion to risk.
   * Quotes still have to repay their entire capital at the borrowing rate; keep the normal cash/upkeep cushion. */
  private urbanAvailable(): number {
    const e = this.eco, appetite = Math.min(0.95, this.loanAppetite + 0.2 * this.config.risk);
    return e.money + Math.max(0, e.maxLoan * appetite - e.loan) - 1_000_000 - this.game.maintenanceOf(this.companyId) * 0.5;
  }
  /** High-speed units of the year (best seats x speed for the money and running costs), or null before there are any. */
  private hsrUnit(): VehicleModel | null {
    const ms = availableModels(this.game.year, 'emu', false).filter((m) => m.id.startsWith('hsr') && (m.tracks ?? []).includes('highspeed'));
    // (speed is what high-speed passengers pay for: the faster units of the year are worth their price)
    const value = (m: VehicleModel) => (m.capacity * Math.pow(m.speed, 1.6)) / (m.cost + modelYearCost(m, this.game.year) * 8);
    return ms.sort((a, b) => value(b) - value(a))[0] ?? null;
  }

  /** Urban rail vehicles for the year in this station style (the biggest that fit the platforms), or null. */
  private urbanUnit(mode: 'metro' | 'lightrail', platform: number): VehicleModel | null {
    const ms = availableModels(this.game.year, 'emu', false).filter((m) => (m.tracks ?? []).includes(mode) && m.length <= platform - 0.4);
    // for metro stations: metro trains first (commuter units also run there, for through services)
    const own = ms.filter((m) => m.id.startsWith(mode === 'metro' ? 'metro_' : 'lrv_'));
    const pool = own.length ? own : ms;
    return pool.sort((a, b) => b.capacity / b.cost - a.capacity / a.cost)[0] ?? null;
  }

  /** Buy platform space for the opening consist, with room at its ends. Longer trains can extend it later. */
  private urbanPlatform(mode: 'metro' | 'lightrail'): number {
    const unit = this.urbanUnit(mode, mode === 'metro' ? 12 : 7);
    return Math.max(4, Math.ceil((unit?.length ?? 6) + 1));
  }

  /** Is a station (of another level for a metro: only an underground one) in the way between two points? */
  private stationOnTheWay(ax: number, az: number, bx: number, bz: number, level: string): boolean {
    const g = this.game, L = Math.hypot(bx - ax, bz - az);
    for (let t = 6; t < L - 6; t += 3) {
      const x = ax + ((bx - ax) * t) / L, z = az + ((bz - az) * t) / L;
      for (const st of g.stations.footprintsNear(x, z, 1.5)) {
        if (!st.rail) { if (level !== 'underground' && st.stops.length) continue; }
        if (level === 'underground' && st.rail?.level !== 'underground') continue;
        return true;
      }
    }
    return false;
  }

  /** The long axis of a town (from its buildings, weighted by residents): unit direction. */
  private townAxis(T: Town): { x: number; z: number } {
    const w = this.game.world;
    let sxx = 0, szz = 0, sxz = 0, W = 0;
    for (const id of T.buildings) {
      const b = w.buildings.get(id);
      if (!b) continue;
      const dx = b.x - T.x, dz = b.z - T.z, k = Math.max(1, b.pop);
      sxx += k * dx * dx; szz += k * dz * dz; sxz += k * dx * dz; W += k;
    }
    if (!W) return { x: 1, z: 0 };
    const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    return { x: Math.cos(a), z: Math.sin(a) };
  }

  private urbanReserved(town: number): boolean {
    return this.game.ais.some((ai) => ai !== this && ai.project && ['metro', 'lightrail'].includes(ai.project.kind) && ai.project.towns.includes(town));
  }

  /**
   * Main-line interchanges belong to the town, irrespective of who owns or operates them. Every rail station walks
   * alike (walkLimit('rail')); the construction style sets the spacing: subway-style stations about three quarters
   * of a walking reach apart, light-rail-style halts a little closer (cheaper stops, slower vehicles), never closer
   * than platforms and turnouts allow. Neighbouring catchments overlap: the forecast shares their buildings.
   */
  private urbanLayout(T: Town, mode: 'metro' | 'lightrail', stepWanted?: number, stopsWanted = 5, platform = mode === 'metro' ? 12 : 7): Omit<UrbanLayout, 'interchanges'> & { interchanges: Station[] } {
    // A light-rail terminus needs two crossover diagonals and their clearances between platforms. The walking
    // reach may shrink, but the 18-unit throat cannot: shorter gaps leave both tracks two-way and trains blocked.
    const end = platform + Math.max(TRACK_TYPES.electric.minRadius * 2 + 2, 18);
    const g = this.game, spacing = Math.max(end, walkLimit('rail') * (mode === 'metro' ? 0.72 : 0.6));
    // in-city stops walk half as far: between the end stations they stand closer together (CITY_SPACING)
    const mid = Math.max(platform + 6, walkLimit('rail') * CITY_WALK_SCALE * CITY_SPACING[mode]);
    const sts = [...g.stations.map.values()].filter((s) => s.townId === T.id && s.rail && railPartMode(s.rail) === 'mainline' && g.lines.stationServed(s.id));
    let pair: Station[] = [], dist = 0;
    for (const a of sts) for (const b of sts) {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (a.id < b.id && d > dist && d <= Math.max(320, T.radius * 3)) { pair = [a, b]; dist = d; }
    }
    const axis = this.townAxis(T);
    const angle = pair.length ? Math.atan2(pair[1].x - pair[0].x, pair[1].z - pair[0].z) : Math.atan2(axis.x, axis.z);
    const offset = mode === 'lightrail' && pair.length ? 5 : 0;
    const x = (pair.length ? (pair[0].x + pair[1].x) / 2 : T.x) - Math.cos(angle) * offset;
    const z = (pair.length ? (pair[0].z + pair[1].z) / 2 : T.z) + Math.sin(angle) * offset;
    // Open a three/four-stop stage when capital is tight; extensions can follow retained operating profit.
    const city = g.stations.cityAt(x, z, T), step = stepWanted ?? (city ? mid : spacing);
    const maxStops = stopsWanted;
    // (about one and a half town radii long: the end gaps keep the throat, the stops between are `step` apart)
    const count = Math.max(3, Math.min(maxStops, 3 + Math.round(Math.max(0, T.radius * 1.5 - spacing * 2) / step)));
    const stagedPair = pair.length && stopsWanted < 5;
    const L = pair.length ? stagedPair ? Math.max(dist, spacing * 2 + step * (stopsWanted - 3)) : dist + spacing * 2
      : spacing * 2 + step * (count - 3);
    const targets = stagedPair ? [-L / 2, ...Array.from({ length: stopsWanted - 2 }, (_, i) =>
      stopsWanted === 3 ? 0 : -L / 2 + spacing + (L - spacing * 2) * i / (stopsWanted - 3)), L / 2]
      : pair.length ? [-dist / 2 - spacing, -dist / 2, dist / 2, dist / 2 + spacing]
      : [-L / 2, ...Array.from({ length: count - 2 }, (_, i) => -L / 2 + spacing + step * i), L / 2];
    // A paired corridor can open between its interchanges before extending beyond them. The old pair
    // branch ignored the requested stage count, so every smaller quote still bought the full line.
    if (pair.length && !stagedPair) for (let t = -dist / 2 + step; t < dist / 2 - step * 0.65; t += step) targets.push(t);
    return { x, z, angle, spacing, step, end, L, platform, targets: targets.sort((a, b) => a - b), interchanges: pair };
  }

  /**
   * The spacing of a city railway's stops between its end stations (citycatch): the closer in-city spacing, or the end
   * gaps' wider one, whichever the forecast on the stops' sites (walks from their entrances' streets at the stops' own
   * reach, stopSiteWalkingCatchment; costs and upkeep of the stations) returns more on over its capital, of those the
   * company can pay for. Closer stops reach more of a town whose stations walk half as far, but every stop costs its
   * building and upkeep: a subway's deep stations may not pay for it.
   */
  private *urbanStep(T: Town, mode: 'metro' | 'lightrail', maxStops = 5, saved = false): Generator<void, ReturnType<AIController['urbanLayout']> & { quote?: ReturnType<AIController['urbanEconomics']> }> {
    const g = this.game, close = this.urbanLayout(T, mode, undefined, maxStops);
    // A model introduced while this survey is pending must not change its quotes only after loading.
    const unit = (saved && this.urbanSurvey?.unit ? MODEL_BY_ID.get(this.urbanSurvey.unit) : undefined)
      ?? this.urbanUnit(mode, this.urbanPlatform(mode));
    if (!unit) return close;
    const plain = (layout: ReturnType<AIController['urbanLayout']>): UrbanLayout => ({ ...layout, interchanges: layout.interchanges.map((s) => s.id) });
    const restore = (layout: UrbanQuote) => ({ ...layout, interchanges: layout.interchanges.map((id) => g.stations.get(id)).filter((s): s is Station => !!s) });
    const fresh = (): UrbanSurvey => {
      const trials: UrbanSurvey['trials'] = [], seen = new Set<string>();
      for (const count of [5, 4, 3].filter((n) => n <= maxStops)) {
        for (const platform of new Set([close.platform, this.urbanPlatform(mode)])) {
          const base = this.urbanLayout(T, mode, undefined, count, platform);
          for (const step of new Set([base.step, base.spacing])) {
            const local = this.urbanLayout(T, mode, step, count, platform);
            const alternatives = [local, ...urbanTrunks(g, T, local.end, count)
              .filter(c => c.targets.length === count && !c.towns.some(id => this.urbanReserved(id)))
              .filter(c => ![...this.lines.values()].some(info => info.urban &&
                c.towns.filter(id => info.towns.includes(id)).length >= 2))
              .map(c => ({ ...local, ...c, interchanges: [] as Station[] }))];
            for (const layout of alternatives) {
              const key = `${platform}:${layout.x}:${layout.z}:${layout.angle}:${layout.targets.join(',')}`;
              if (seen.has(key)) continue;
              seen.add(key);
              for (const level of mode === 'metro' ? ['underground'] as const : ['ground', 'elevated', 'underground'] as const)
                trials.push({ layout: plain(layout), level, count });
            }
          }
        }
      }
      return { maxStops, unit: unit.id, trials, trial: 0, site: 0, offset: 0, sites: [], best: plain(close), stageBest: plain(close),
        bestReturn: -1e30, stageReturn: -1e30, stageCount: trials[0]?.count ?? maxStops };
    };
    const cursor = saved ? this.urbanSurvey ??= fresh() : fresh();
    // Every trial, station adjustment, walk and forecast has a saved cursor when called by urbanJob.
    // Project selection uses the same quotes without retaining a construction cursor.
    while (true) {
      const trial = cursor.trials[cursor.trial];
      if (!trial || trial.count !== cursor.stageCount) {
        // Price every opening stage. A viable five-stop line can still leave too little capital for its
        // trains or the rest of the network; a smaller corridor may return more on the same credit line.
        if (!trial) return restore(cursor.best);
        cursor.stageCount = trial.count; cursor.stageReturn = -1e30;
      }
      const { layout, level } = trial, length = layout.platform;
      if (cursor.site < layout.targets.length) {
        const t = layout.targets[cursor.site], x = layout.x + Math.sin(layout.angle) * t, z = layout.z + Math.cos(layout.angle) * t;
        if (cursor.offset < 5) {
          // At most five fixed native attempts; the saved offset still resumes the next one.
          for (let attempt = 0; attempt < 5 && cursor.offset < 5; attempt++) {
            const d = [0, 1.5, -1.5, 3, -3][cursor.offset++], px = x + Math.sin(layout.angle) * d, pz = z + Math.cos(layout.angle) * d;
            const through = (layout.towns?.length ?? 0) > 1;
            const native = through ? this.urbanSitePlan(T, layout, mode, length, layout.angle, 0, t + d, level,
              cursor.sites[cursor.sites.length - 1] as StationPlan | undefined) : null;
            const plan = through ? (native && typeof native !== 'string' ? native : null)
              : g.stations.planRail(px, pz, layout.angle, length, 2, this.companyId,
                { aiSurvey: true, trackType: 'electric', mode, level, depth: 2.2, height: 1.5,
                  ...(level !== 'ground' && g.stations.cityAt(px, pz, g.towns.nearest(px, pz)) ? { entrances: CITY_ENTRANCES } : {}) });
            if (plan?.ok && !plan.join?.rail) { cursor.sites.push(plan); cursor.site++; cursor.offset = 0; break; }
          }
        } else if ((layout.towns?.length ?? 0) > 1) {
          // A constrained centre corridor cannot borrow demand from an unbuildable virtual stop.
          // Skip this trial in one saved work unit; local alignments retain their broader site search.
          cursor.trial++; cursor.site = cursor.offset = 0; cursor.sites = [];
        } else {
          const scale = g.stations.cityAt(x, z, g.towns.nearest(x, z)) ? CITY_WALK_SCALE : 1;
          cursor.sites.push({ x, z, townId: g.towns.nearest(x, z)?.id ?? T.id, length, tracks: 2,
            walk: level === 'ground' ? pointWalkingCatchment(g, x, z, 'rail', scale - 1, 1.6)
              : stopSiteWalkingCatchment(g, x, z, layout.angle, length, 'rail', scale) });
          cursor.site++; cursor.offset = 0;
        }
      } else {
        const quote = this.urbanEconomics(cursor.sites, mode, level, [unit], 2);
        const ret = quote.total * 1.05 < this.urbanAvailable() ? quote.net / Math.max(1, quote.total) : -1e30;
        if (ret > cursor.stageReturn) { cursor.stageBest = { ...layout, quote }; cursor.stageReturn = ret; }
        if (ret > cursor.bestReturn) { cursor.best = { ...layout, quote }; cursor.bestReturn = ret; }
        cursor.trial++; cursor.site = cursor.offset = 0; cursor.sites = [];
      }
      yield;
    }
  }

  /** The same native platform, access and grade checks used by a through quote and its construction. */
  private urbanSitePlan(T: Town, layout: Pick<UrbanLayout, 'x' | 'z'>, mode: 'metro' | 'lightrail', PL: number,
    ang: number, lat: number, t: number, lv: UrbanLevel, prev?: StationPlan): StationPlan | string | null {
    const g = this.game, me = this.companyId, grade = TRACK_TYPES.electric.maxGrade * 0.8;
    const lim = lv === 'underground' ? { lo: 1.5, hi: 3.8, pref: 2.2 } : { lo: 1.2, hi: 2.8, pref: 1.5 };
    const ux = Math.sin(ang), uz = Math.cos(ang), x = layout.x + ux * t - uz * lat, z = layout.z + uz * t + ux * lat;
    if (!g.world.inside(x, z, 10)) return null;
    // the ground over / under the platforms
    let lo = Infinity, hi = -Infinity;
    for (const k of [-0.5, 0, 0.5]) { const h = g.world.heightAt(x + ux * PL * k, z + uz * PL * k); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const reach = prev ? grade * Math.max(1, Math.hypot(x - prev.x, z - prev.z) - PL - 2) : Infinity;
    let opt: object;
    if (lv === 'underground') {
      // platform height y = lo - depth, depth within the limits, y within reach of the previous platforms
      const under = [...g.stations.map.values()].find((st) => st.townId === T.id && st.rail?.level === 'underground'
        && railPartMode(st.rail) === 'mainline' && Math.hypot(st.x - x, st.z - z) < 10);
      const preferred = under ? Math.max(lim.pref, under.rail!.depth + 1.2) : lim.pref;
      const want = lo - preferred, y = prev ? Math.max(prev.y - reach, Math.min(prev.y + reach, want)) : want;
      const depth = lo - y;
      if (depth < lim.lo || depth > Math.max(lim.hi, preferred)) return null;
      opt = { trackType: 'electric', mode, level: lv, depth };
    } else if (lv === 'elevated') {
      const want = hi + lim.pref, y = prev ? Math.max(prev.y - reach, Math.min(prev.y + reach, want)) : want;
      const height = y - hi;
      if (height < lim.lo || height > lim.hi) return null;
      opt = { trackType: 'electric', mode, level: lv, height };
    } else opt = { trackType: 'electric', mode, level: lv };
    // (an in-city stop below or above the street walks half as far: entrances at both ends and both sides)
    if (lv !== 'ground' && g.stations.cityAt(x, z, g.towns.nearest(x, z))) opt = { ...opt, entrances: CITY_ENTRANCES };
    const pl = g.stations.planRail(x, z, ang, PL, 2, me, { ...opt, aiSurvey: true });
    if (!pl.ok) return pl.error ?? 'invalid platform';
    if (pl.join?.rail) return 'existing rail platforms';
    if (prev && Math.abs(pl.y - prev.y) > reach + 0.05) return 'platform grade';
    if (pl.join) {
      // Keep the existing road service's station identity. The urban railway has its own platforms and
      // a walking complex with that stop, so an abandoned rail project cannot remove a working bus stop.
      pl.links = [...new Set([...pl.links, pl.join])]; pl.join = null;
    }
    // stairs up to a deck (or a ramp's way) must not stand where the line runs on beyond the platform ends
    if (lv !== 'underground') for (const e of pl.entrances) {
      const dx = e.x - pl.x, dz = e.z - pl.z;
      if (Math.abs(dx * ux + dz * uz) > PL / 2 - 0.3 && Math.abs(dx * uz - dz * ux) < pl.footprint.w / 2 + 1.1) return 'entrance on the continuing track';
    }
    // the track from the previous station must not run into another station (at its level)
    if (prev && this.stationOnTheWay(prev.x, prev.z, pl.x, pl.z, lv)) return null;
    return pl;
  }

  /**
   * Stop positions along an alignment (`a`, `lat` beside the layout's axis): with the stop nearest each of the town's
   * existing stations beside the axis (CITY_ANCHOR_SIDE, measured to its platforms) moved onto the point closest to
   * it, so the new stop stands beside or under it (an interchange: linked when the line opens) and its neighbours
   * kept clear of it, when there is such a station; then the layout as it is. The forecast weighs both.
   */
  private urbanVariants(layout: { x: number; z: number; step: number; targets: number[] }, anchors: Station[], a: number, lat: number, PL: number): number[][] {
    const ux = Math.sin(a), uz = Math.cos(a), ox = layout.x - uz * lat, oz = layout.z + ux * lat;
    const along = (x: number, z: number) => (x - ox) * ux + (z - oz) * uz, side = (x: number, z: number) => (x - ox) * uz - (z - oz) * ux;
    const plain = layout.targets, lo = plain[0] - layout.step, hi = plain[plain.length - 1] + layout.step;
    let ts = [...plain];
    const fixed: number[] = [];
    for (const st of anchors) {
      const r = st.rail!, hx = Math.sin(r.angle) * r.length / 2, hz = Math.cos(r.angle) * r.length / 2;
      const s1 = side(r.x - hx, r.z - hz), s2 = side(r.x + hx, r.z + hz);
      let t: number, d: number;
      if (s1 * s2 <= 0) { const f = s1 / ((s1 - s2) || 1); t = along(r.x - hx + 2 * hx * f, r.z - hz + 2 * hz * f); d = 0; }
      else if (Math.abs(s1) < Math.abs(s2)) { t = along(r.x - hx, r.z - hz); d = Math.abs(s1); }
      else { t = along(r.x + hx, r.z + hz); d = Math.abs(s2); }
      if (d > CITY_ANCHOR_SIDE || t < lo || t > hi || fixed.some((f) => Math.abs(f - t) < PL + 6)) continue;
      let k = 0;
      for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[k] - t)) k = i;
      if (Math.abs(ts[k] - t) > layout.step || fixed.includes(ts[k])) continue;
      ts[k] = t; fixed.push(t);
      // (the other stops keep clear of it: a stop closer than its platforms and a block allow goes)
      ts = ts.filter((x, i) => i === k || Math.abs(x - t) >= PL + 6).sort((p, q) => p - q);
    }
    return fixed.length ? [ts, plain] : [plain];
  }

  /**
   * Physics-based operating costs, actual structure upkeep and walking/OD ridership on the proposed stops. Without
   * planned links and yard (choosing projects) the costs are estimated: a line on the ground pays for what it
   * demolishes along its way (at the land value there), an underground line may keep its depot underground (a stub
   * and a cavern instead of a long ramp up to the surface), whichever is cheaper.
   */
  private urbanEconomics(points: (StationPlan | ForecastSite)[], mode: 'metro' | 'lightrail', level: string, cars: VehicleModel[], fleet: number, connectionCost?: number, yardCost?: number, yardLength?: number) {
    const g = this.game, type = TRACK_TYPES.electric;
    const len = points.slice(1).reduce((a, s, i) => a + Math.hypot(s.x - points[i].x, s.z - points[i].z), 0);
    const spacing = len / Math.max(1, points.length - 1);
    const yr = estimateVehicleYear(cars, spacing / 1.15, g.year, 0.4, Math.min(...cars.map((m) => m.speed)));
    const hop = YEAR_S / yr.trips, kmh = spacing * UNIT_M / hop * 3.6;
    // Longer city lines need more trains to retain the short headway that makes their local trips attractive.
    const f0 = Math.max(fleet, Math.min(4, Math.ceil(2 * hop * Math.max(1, points.length - 1) / 120)));
    let ramp = level === 'underground' ? 58 : level === 'elevated' ? 26 : 10;
    const sf = level === 'underground' ? 4.5 : level === 'elevated' ? 3 : 1;
    const upkeepFactor = STATION_UPKEEP_FACTOR[level as keyof typeof STATION_UPKEEP_FACTOR] ?? 1;
    const tf = level === 'underground' ? 5 : level === 'elevated' ? 4 : 1;
    const platform = points[0]?.length ?? this.urbanPlatform(mode);
    const stationCost = points.reduce((a, p) => a + ('cost' in p ? p.cost : (2 * platform * 9000 + 120_000) * sf), 0);
    let yard = yardCost, undergroundYard = false;
    if (yard === undefined) {
      yard = ramp * type.costPerUnit * 3 + 250_000;
      const stub = 10, under = stub * subwayCostPerUnit('electric', 2.2, 1) + UNDERGROUND_DEPOT.base + UNDERGROUND_DEPOT.perDepth * 2.2;
      if (level === 'underground' && under < yard) { yard = under; ramp = stub; undergroundYard = true; }
    } else if (yardLength !== undefined) { ramp = yardLength; undergroundYard = level === 'underground'; }
    const demolition = connectionCost === undefined && level === 'ground' ? surfaceDemolition(g, points, 0.55).cost : 0;
    // Stations already buy their platform tracks. Civil works connect their ends, not their centres.
    const linkLength = points.slice(1).reduce((a, p, i) => a + Math.max(0,
      Math.hypot(p.x - points[i].x, p.z - points[i].z) - ((p.length ?? platform) + (points[i].length ?? platform)) / 2), 0);
    const structure = level === 'underground' ? structureFactor('rail', 'tunnel', 2.2) : level === 'elevated' ? structureFactor('rail', 'bridge', 1.5) : 1;
    const doubleCost = 1 + SHARED_TRACK.materials + (structure - 1) * (1 + SHARED_TRACK.structures);
    // Directional service needs crossover pairs at both termini; the finishing primitive can also
    // provide both pairs at each intermediate station. Price every possible pair and the signals before
    // reserving the fleet: an unfunded second diagonal used to report a misleading "no crossover room".
    const lat = stationLayout(2, 0, 'middle', 'side').trackOffsets;
    const lateral = Math.abs(lat[1] - lat[0]);
    const diagonal = Math.max(5, Math.min(12, Math.sqrt(60 * lateral * Math.min(1, type.minRadius / 12)) + 2));
    const crossoverLength = Math.hypot(diagonal, lateral) * 1.04 * 4 * Math.max(1, points.length - 1);
    const completion = crossoverLength * type.costPerUnit * structure + 4 * Math.max(1, points.length - 1) * 30_000
      + (points.length * 2 + 4 + Math.ceil(len / 50) * 2) * Signals.SIGNAL_COST;
    const works = stationCost + (connectionCost ?? linkLength * (TRACK_TYPES.standard.costPerUnit * doubleCost + 2 * ELECTRIFY.costPerUnit) + demolition) + yard + completion;
    // (citycatch: where the stops' queues fill between trains, as at close city stops that each reach fewer walkers,
    // a train or two more carries more of them: the fleet that repays best over the accepted horizon)
    let best: { total: number; yearly: number; net: number; fleetCost: number; forecast: ReturnType<Game['demand']['forecastLine']>; headway: number; fleet: number } | null = null;
    // A frequent mature fleet is an option, not an opening bill: compare smaller fleets too and
    // retain the best return the company can fund. Six trains must not hide a viable two-train metro.
    for (let f = fleet; f <= f0 + 2; f++) {
      const headway = 2 * hop * Math.max(1, points.length - 1) / f;
      const forecast = g.demand.forecastLine(points, mode, kmh, headway, this.companyId);
      const capacity = f * yr.trips * cars.reduce((a, m) => a + m.capacity, 0) * 0.7;
      forecast.revenue *= Math.min(1, capacity / Math.max(1, forecast.boardings));
      const fleetCost = f * cars.reduce((a, m) => a + m.cost, 0), total = works + fleetCost;
      const yearly = f * yr.total + (len * 2 + ramp + crossoverLength) * (trackBasePerUnit('electric') * tf + f * yr.trackWearPerUnit)
        + points.length * (20000 + 2 * platform * 500) * upkeepFactor + (undergroundYard ? UNDERGROUND_DEPOT.upkeep : 12000);
      const e = { total, yearly, net: forecast.revenue - yearly, fleetCost, forecast, headway, fleet: f };
      const affordable = total * 1.05 <= this.urbanAvailable(), bestAffordable = best && best.total * 1.05 <= this.urbanAvailable();
      if (!best || (affordable && !bestAffordable) || (affordable === bestAffordable
        && (e.net - e.total / urbanPayback(mode, this.eco.interestRate)) / e.total
          > (best.net - best.total / urbanPayback(mode, this.eco.interestRate)) / best.total)) best = e;
      // (a train more only pays while the queues still fill)
      if (forecast.boardings <= 0) break;
    }
    return best!;
  }

  /** Selection hands off only its numerical layout. Changed geometry and prices are never reused. */
  private urbanHandoffLayout(hint: UrbanLayout | undefined, maxStops: number) {
    const g = this.game;
    if (!hint || ![hint.x, hint.z, hint.angle, hint.spacing, hint.step, hint.end, hint.L, hint.platform].every(Number.isFinite)
      || hint.platform <= 0 || hint.targets.length < 3 || hint.targets.length > maxStops
      || !hint.targets.every((t, i) => Number.isFinite(t) && (!i || t > hint.targets[i - 1]))
      || hint.interchanges.some(id => { const st = g.stations.get(id); return !st?.rail || (st.owner !== this.companyId && !g.canUse(this.companyId, st.owner)); })
      || hint.towns?.some(id => !g.towns.list[id])) return null;
    return { ...hint, targets: [...hint.targets], interchanges: hint.interchanges.map(id => g.stations.get(id)!),
      ...(hint.towns ? { towns: [...hint.towns] } : {}) };
  }

  /**
   * A city railway through the core of town T, built in one of the urban construction styles: subway style
   * (underground, metro units) or light-rail style (at grade, on a viaduct or
   * underground, light-rail vehicles): two-track stations with side platforms spaced by walking reach and turnout
   * room, double track between them, a depot beyond one end (a cavern for a subway), directional running with crossovers before
   * the ends, signals, and a line stopping at every station. The result is an ordinary rail line (main-line trains
   * may run through onto it, its trains onto the main line).
   */
  /** Every yield ends a bounded work unit with all continuation data in urbanTask. */
  private *urbanJob(T: Town, mode: 'metro' | 'lightrail', maxStops = 5): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net, p = this.project!;
    const what = mode === 'metro' ? 'subway-style city railway' : 'light-rail-style city railway';
    const fail = (why: string, days = 1500) => { this.note(`${what} in ${T.name} abandoned: ${why}`); this.markFailed('urban' + mode + T.id, days); this.abandon(p); this.urbanTask = null; this.urbanSurvey = null; };
    if (!this.urbanTask) {
      this.state.phase = `planning a ${what} in ${T.name}`;
      if (this.urbanReserved(T.id)) return fail('another urban project is being built', 60);
      maxStops = this.urbanSurvey?.maxStops ?? maxStops;
      const handoff = !this.urbanSurvey ? this.urbanHandoffLayout(p.urbanLayout, maxStops) : null;
      delete p.urbanLayout;
      const layout = handoff ?? (yield* this.urbanStep(T, mode, maxStops, true)), L = layout.L;
      this.urbanSurvey = null;
      const range = (a: number) => { let mn = Infinity, mx = -Infinity; for (let t = -L / 2 - 8; t <= L / 2 + 8; t += 3) { const h = g.world.heightAt(layout.x + Math.sin(a) * t, layout.z + Math.cos(a) * t); mn = Math.min(mn, h); mx = Math.max(mx, h); } return mx - mn; };
      const through = (layout.towns?.length ?? 0) > 1;
      const angles = (layout.interchanges.length || through ? [0] : [0, Math.PI / 2, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3])
        .map((da) => ({ a: layout.angle + da, r: range(layout.angle + da) - (da === 0 ? 0.6 : 0) })).sort((p1, p2) => p1.r - p2.r);
      const lats = layout.interchanges.length || through ? [0, 2, -2] : [0, 5, -5, 10, -10, 15, -15];
      const candidates: UrbanTask['candidates'] = mode === 'metro' ? (layout.interchanges.length ? lats : [0, 5, -5, 10, -10]).flatMap((lat) => angles.map(({ a }) => ({ a, lat, lv: 'underground' as const })))
        : lats.flatMap((lat) => angles.flatMap(({ a }, i) => (i < 3 ? ['ground', 'elevated', 'underground'] as const : ['underground'] as const).map((lv) => ({ a, lat, lv }))));
      const heading = p.urbanHeading;
      if (!through && !layout.interchanges.length && heading && Number.isFinite(heading.angle)
        && Number.isInteger(heading.stops) && heading.stops >= 2
        && layout.targets.length < heading.stops) {
        // The town axis can change while a larger opening is surveyed. Add its earlier heading
        // after the existing bounded search, using new native sites, works, fleet and prices.
        const retainedLats = mode === 'metro' ? [0, 5, -5, 10, -10] : lats;
        const retained = retainedLats.flatMap(lat => (mode === 'metro' ? ['underground'] as const
          : ['ground', 'elevated', 'underground'] as const).map(lv => ({ a: heading.angle, lat, lv })));
        for (const c of retained) if (!candidates.some(q => Math.abs(q.a - c.a) < 1e-9 && q.lat === c.lat && q.lv === c.lv))
          candidates.push(c);
      }
      // Compare an opening stage between the interchanges with the full line's optional outer stops.
      // Both stages must prove their sites, full fleet and investment return before building.
      if (layout.interchanges.length === 2 && layout.targets.length >= 6) {
        const stages = candidates.flatMap((c) => [c, { ...c, trim: true }]);
        candidates.splice(0, candidates.length, ...stages);
      }
      const anchors = [...g.stations.map.values()].filter((st) => !!st.rail && st.townId === T.id && g.lines.stationServed(st.id)
        && (st.owner === me || g.canUse(me, st.owner)) && !layout.interchanges.includes(st));
      const variants = candidates.flatMap((c) => this.urbanVariants({ ...layout, targets: c.trim ? layout.targets.slice(1, -1) : layout.targets }, anchors, c.a, c.lat, layout.platform)
        .map((targets) => ({ ...c, targets: [...targets] })));
      candidates.splice(0, candidates.length, ...variants);
      p.towns = layout.towns ? [T.id, ...layout.towns.filter(id => id !== T.id)] : [T.id];
      this.urbanTask = { town: T.id, mode, maxStops, ...(handoff ? { fromHandoff: true } : {}), layout: { ...layout, interchanges: layout.interchanges.map((s) => s.id) }, candidates,
        stage: 'sites', candidate: 0, target: 0, offset: 0, tries: 0, previous: -1e9, got: [], link: 0, links: 0, yardAt: 0, yard: null,
        plans: [], angle: layout.angle, level: mode === 'metro' ? 'underground' : 'elevated', bestReturn: -1e30, bestPays: false, paid: false, alignment: '', more: 2,
        siteRejects: [], linkRejects: [], at: 0, stations: [], doubleEdges: [], depot: -1, end: -1, bought: 0 };
    }
    const task = this.urbanTask;
    const layout = task.layout, PL = layout.platform ?? (mode === 'metro' ? 12 : 7), SP = layout.spacing, n = layout.targets.length;
    // Infer the same saved relation for urban work begun by an older build, without retaining proposals.
    if (!p.urbanHeading && !layout.interchanges.length && (layout.towns?.length ?? 1) === 1)
      p.urbanHeading = { angle: layout.angle, stops: n };
    const designGrade = TRACK_TYPES.electric.maxGrade;
    const retry = function* (self: AIController, why: string, days = 1500): Generator<void, void> {
      const count = task.maxStops ?? maxStops;
      if (task.fromHandoff && !p.built) {
        self.urbanTask = null; self.urbanSurvey = null;
        yield* self.urbanJob(T, mode, count);
      } else if (count > 3 && n > 3 && !p.built) { self.urbanTask = null; yield* self.urbanJob(T, mode, Math.min(count - 1, n - 1)); }
      else fail(why, days);
    };
    const ground = (x: number, z: number) => g.world.heightAt(x, z);
    const reject = (list: [string, number][], why: string) => { const r = list.find((q) => q[0] === why); if (r) r[1]++; else list.push([why, 1]); };
    const rejectSite = (why: string) => { reject(task.siteRejects, why); return null; };
    const site = (ang: number, lat: number, t: number, lv: UrbanLevel, prev: StationPlan | undefined): StationPlan | null => {
      const plan = this.urbanSitePlan(T, layout, mode, PL, ang, lat, t, lv, prev);
      return typeof plan === 'string' ? rejectSite(plan) : plan;
    };
    const offs = [0];
    for (let d = 1.5; d <= SP * 0.9; d += 1.5) { offs.push(d); if (d <= SP * 0.3) offs.push(-d); }
    const options = (lv: UrbanLevel, st: Pick<StationPlan, 'depth' | 'height'>): BuildOptions => ({ kind: 'rail', type: 'electric', tracks: 2, heightOffset: 0,
      crossing: lv === 'ground' ? 'over' : 'auto', owner: me, designGrade, level: lv, levelDepth: st.depth || undefined, levelHeight: st.height || undefined, subway: lv === 'underground' });
    const yardEnds = (st: StationPlan, angle: number, dir: number, track: number, straight = false) => {
      const ux = Math.sin(angle), uz = Math.cos(angle), off = st.layout.trackOffsets[track];
      const start = { x: st.x + uz * off + ux * st.length / 2 * dir, z: st.z - ux * off + uz * st.length / 2 * dir,
        y: st.y, dx: ux * dir, dz: uz * dir };
      const tail = straight ? 0 : URBAN_TAIL;
      return { start, fork: { ...start, x: start.x + start.dx * tail, z: start.z + start.dz * tail } };
    };
    // Fixed endpoint heights keep the tail level. Its temporary end becomes a free end for commit; the
    // validated profile is retained, including strict subway cover across the whole bore.
    const tailPlan = (start: { x: number; y: number; z: number; dx: number; dz: number; node?: number },
      fork: { x: number; y: number; z: number }, lv: UrbanLevel, st: Pick<StationPlan, 'depth' | 'height'>) =>
      net.withTemporaryNodes('rail', [...(start.node === undefined ? [start] : []), { ...fork, dx: -start.dx, dz: -start.dz }], me, (nodes) => {
        const from = start.node === undefined ? nodes[0].id : start.node, to = nodes[nodes.length - 1].id;
        const pr = planEdge(g, nodeSnap(g, from, 'rail'), { kind: 'node', ...fork, node: to }, { ...options(lv, st), tracks: 1, crossing: 'auto' });
        for (const t of pr.tracks) {
          if (start.node === undefined) t.start = { kind: 'free', x: start.x, y: start.y, z: start.z };
          t.end = { kind: 'free', ...fork };
        }
        return pr;
      });
    const nextCandidate = () => {
      task.candidate++; task.target = task.offset = task.link = task.links = task.yardAt = 0;
      task.previous = -1e9; task.skipped = false; task.got = []; task.yard = null; task.stage = 'sites';
      if (task.tries > 1500) task.stage = 'approve';
    };
    const builtStations = () => task.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
    const ends = (st: Station, ahead: boolean) => {
      const fwd = Math.sin(st.rail!.angle) * Math.sin(task.angle) + Math.cos(st.rail!.angle) * Math.cos(task.angle) >= 0;
      return stationEnds(g, st).map((e) => fwd === ahead ? e.front : e.back);
    };
    const keepFleet = (spend: () => void) => {
      // Completion primitives can retry many turnouts; keep their money checks away from the fleet reserve.
      const reserve = task.estimate!.fleetCost, eco = this.eco;
      eco.money -= reserve;
      try { spend(); } finally { eco.money += reserve; }
    };
    while (true) {
      const c = task.candidates[task.candidate];
      const targets = c?.targets ?? (c?.trim ? layout.targets.slice(1, -1) : layout.targets);
      if (c?.trim) {
        const lat = stationLayout(2, 0, 'middle', 'side').trackOffsets;
        const D = Math.max(5, Math.min(12, Math.sqrt(60 * Math.abs(lat[1] - lat[0]) * Math.min(1, TRACK_TYPES.electric.minRadius / 12)) + 2));
        const gap = PL + 2 * D + 5;
        targets[1] = Math.max(targets[1], targets[0] + gap);
        targets[targets.length - 2] = Math.min(targets[targets.length - 2], targets[targets.length - 1] - gap);
      }
      if (task.stage === 'sites') {
        if (!c) { task.stage = 'approve'; continue; }
        const key = `${c.a}|${c.lat}`;
        if (key !== task.alignment) {
          task.alignment = key;
          if (task.paid && task.more-- <= 0) { task.stage = 'approve'; continue; }
        }
        if (task.target >= targets.length) {
          const gap = (p: StationPlan, q: StationPlan) => Math.hypot(p.x - q.x, p.z - q.z), end = layout.end ?? PL + 18;
          while (task.got.length > Math.min(4, n) && gap(task.got[task.got.length - 2], task.got[task.got.length - 1]) < end - 0.5) task.got.pop();
          if (task.got.length >= 2 && (gap(task.got[0], task.got[1]) < end - 0.5 || gap(task.got[task.got.length - 2], task.got[task.got.length - 1]) < end - 0.5)) { reject(task.siteRejects, 'no throat at an end'); nextCandidate(); }
          else if (task.got.length >= Math.min(4, n)) task.stage = 'links'; else nextCandidate();
          continue;
        }
        if (task.offset >= offs.length) {
          if (task.got.length && (task.skipped || (layout.step ?? SP) >= SP || task.target === targets.length - 1)) task.target = targets.length;
          else { if (task.got.length) task.skipped = true; task.target++; task.offset = 0; }
          continue;
        }
        const t = targets[task.target] + offs[task.offset++];
        const minGap = task.got.length === 1 || task.target === targets.length - 1 ? layout.end ?? PL + 18 : PL + 6;
        if (task.got.length && t - task.previous < minGap) continue;
        task.tries++;
        const pl = site(c.a, c.lat, t, c.lv, task.got[task.got.length - 1]);
        if (pl) {
          const prev = task.got[task.got.length - 1];
          if (c.trim && prev && (task.got.length === 1 || task.target === targets.length - 1)) {
            const lat = Math.abs(pl.layout.trackOffsets[1] - pl.layout.trackOffsets[0]);
            const D = Math.max(5, Math.min(12, Math.sqrt(60 * lat * Math.min(1, TRACK_TYPES.electric.minRadius / 12)) + 2));
            if (Math.hypot(pl.x - prev.x, pl.z - prev.z) - PL < 2 * D + 4) { reject(task.siteRejects, 'terminal crossover clearance'); yield; continue; }
          }
          task.got.push(pl); task.previous = t; task.target++; task.offset = 0;
        }
      } else if (task.stage === 'links') {
        if (task.link + 1 >= task.got.length) { task.stage = c.lv === 'underground' ? 'yardUnder' : 'yardRamp'; continue; }
        const ux = Math.sin(c.a), uz = Math.cos(c.a);
        const end = (p: StationPlan, side: number) => p.layout.trackOffsets.map((off) => ({ x: p.x + uz * off + ux * p.length / 2 * side,
          z: p.z - ux * off + uz * p.length / 2 * side, y: p.y, dx: ux * side, dz: uz * side }));
        const pj = net.withTemporaryNodes('rail', [...end(task.got[task.link], 1), ...end(task.got[task.link + 1], -1)], me, (nodes) => {
          const snap = (ids: number[]): Snap => { const q = net.nodes.get(ids[0])!; return { kind: 'node', x: q.x, y: q.y, z: q.z, node: q.id, group: ids }; };
          return planEdge(g, snap(nodes.slice(0, 2).map((q) => q.id).reverse()), snap(nodes.slice(2).map((q) => q.id)), options(c.lv, task.got[task.link]));
        });
        if (!pj.ok) { reject(task.linkRejects, pj.errors[0] ?? 'unknown track constraint'); nextCandidate(); }
        else { task.links += pj.cost; task.link++; }
      } else if (task.stage === 'yardUnder') {
        if (task.yardAt >= 16) {
          // A subway keeps its yard underground. Compare compact branches as well as the wider ones:
          // demanding an 80-120 m lateral detour can miss a perfectly buildable depot in a hilly town.
          if (task.yard) task.stage = 'evaluate';
          else if (mode === 'metro') { reject(task.linkRejects, 'no underground depot site'); nextCandidate(); }
          else { task.yardAt = 0; task.stage = 'yardRamp'; }
          continue;
        }
        const at = task.yardAt++, index = at < 8 ? 0 : task.got.length - 1, dir = index === 0 ? -1 : 1;
        const st = task.got[index], track = Math.floor(at / 4) % 2 ? st.layout.trackOffsets.length - 1 : 0;
        const { start, fork } = yardEnds(st, c.a, dir, track), tp = tailPlan(start, fork, c.lv, st);
        if (!tp.ok) continue;
        // lat is relative to the way out; turn to this outer track's side at either end, never straight on.
        const lat = [4, 6, 8, 12][at % 4] * (track === 0 ? 1 : -1) * dir;
        const yp = planSubwayYard(g, fork, me, { type: 'electric', depth: st.depth, lat, lengths: [8, 10, 12, 14, 18, 22] });
        const cost = tp.cost + yp.cost;
        if (yp.ok && (!task.yard || cost < task.yard.cost)) task.yard = { index, dir, x: yp.x, z: yp.z, cost, track, straight: false, under: yp };
      } else if (task.stage === 'yardRamp') {
        const scales = [1, 1.25, 0.85, 1.5, 2, 2.5], lats = [12, -12, 24, -24, 36, -36];
        const sideways = 2 * scales.length * lats.length;
        if (task.yardAt >= sideways + 2 * scales.length) {
          if (task.yard) task.stage = 'evaluate'; else { reject(task.linkRejects, 'no depot site'); nextCandidate(); }
          continue;
        }
        const at = task.yardAt++, straight = at >= sideways, offset = straight ? at - sideways : at, width = straight ? 1 : lats.length;
        const index = offset < scales.length * width ? 0 : task.got.length - 1, dir = index === 0 ? -1 : 1;
        const k = scales[Math.floor(offset / width) % scales.length], lat = straight ? 0 : lats[offset % width], st = task.got[index];
        const track = lat < 0 ? st.layout.trackOffsets.length - 1 : 0, ramp = c.lv === 'underground' ? 58 : c.lv === 'elevated' ? 26 : 10;
        const { start, fork } = yardEnds(st, c.a, dir, track, straight);
        const x = fork.x + fork.dx * ramp * k - Math.cos(c.a) * lat, z = fork.z + fork.dz * ramp * k + Math.sin(c.a) * lat;
        if (!g.world.inside(x, z, 8)) continue;
        const pr = net.withTemporaryNodes('rail', [fork], me, (nodes) => planEdge(g, { kind: 'node', x: fork.x, y: fork.y, z: fork.z, node: nodes[0].id },
          { kind: 'free', x, z, y: ground(x, z) }, { kind: 'rail', type: 'electric', tracks: 1, heightOffset: 0, crossing: 'auto', owner: me, designGrade }));
        if (pr.ok) {
          const tp = straight ? null : tailPlan(start, fork, c.lv, st);
          if (tp && !tp.ok) continue;
          const end = pr.tracks[0], tangent = endTangent(end.bez), y = end.prof[end.prof.length - 1];
          if (depotFits(g, x, z, -tangent.x, -tangent.z, me, 0, y)) {
            const dp = g.depots.plan('rail', x + tangent.x * 2.15, z + tangent.z * 2.15, Math.atan2(-tangent.x, -tangent.z), me);
            if (dp.ok) { const cost = (pr.cost + (tp?.cost ?? 0) + dp.cost) * 1.1; if (!task.yard || cost < task.yard.cost) task.yard = { index, dir, x, z, cost, track, straight }; task.stage = 'evaluate'; }
          }
        }
      } else if (task.stage === 'evaluate') {
        const vehicle = this.urbanUnit(mode, PL);
        if (vehicle && task.yard) {
          const e = this.urbanEconomics(task.got, mode, c.lv, [vehicle], 2, task.links, task.yard.cost, task.yard.under?.length);
          const ret = e.net / Math.max(1, e.total), pays = ret * urbanPayback(mode, this.eco.interestRate) >= 1;
          if (e.total * 1.05 < this.urbanAvailable() && ((pays && !task.bestPays) || (pays === task.bestPays && ret > task.bestReturn))) {
            task.bestReturn = ret; task.bestPays = pays; task.plans = task.got; task.angle = c.a; task.level = c.lv; task.connectionCost = task.links; task.plannedYard = task.yard;
          }
          if (task.got.length >= targets.length && pays && e.total * 1.05 < this.urbanAvailable()) task.paid = true;
        }
        nextCandidate();
      } else if (task.stage === 'approve') {
        if (task.plans.length < Math.min(4, n)) return yield* retry(this, 'no station sites' + ([...task.linkRejects, ...task.siteRejects].length ? ` (${[...task.linkRejects, ...task.siteRejects].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => `${why}: ${n}`).join('; ')})` : ''));
        if (layout.interchanges.some((id) => { const st = g.stations.get(id); return !st || !task.plans.some((q) => Math.hypot(q.x - st.x, q.z - st.z) < 14); })) return yield* retry(this, 'no walking interchange at both main-line stations', 360);
        const unit = this.urbanUnit(mode, PL);
        if (!unit) return fail('no vehicles');
        const e = this.urbanEconomics(task.plans, mode, task.level, [unit], 2, task.connectionCost, task.plannedYard?.cost, task.plannedYard?.under?.length);
        if (!AIController.forceBuild && e.net * urbanPayback(mode, this.eco.interestRate) < e.total) return yield* retry(this, `not profitable (${Math.round(e.net / 1000)}k/year on ${Math.round(e.total / 1000)}k over ${URBAN_PAYBACK[mode]} years; ${Math.round(e.forecast.covered)} covered, ${Math.round(e.forecast.boardings)} boardings, ${Math.round(e.forecast.revenue / 1000)}k revenue)`, 360);
        if (e.total * 1.05 > this.urbanAvailable() || !this.borrowFor(e.total * 1.05)) return yield* retry(this, 'too expensive', 720);
        task.estimate = e; task.unit = unit.id; task.at = 0; task.stage = 'stations'; p.built = true;
        this.state.phase = `building a ${what} in ${T.name}`;
      } else if (task.stage === 'stations') {
        if (task.at >= task.plans.length) { if (task.stations.length < Math.min(4, n)) return fail('stations could not be built', 720); task.at = 0; task.stage = 'buildLinks'; continue; }
        const pl = task.plans[task.at++], id = g.stations.nextId, e0 = net.nextEdge;
        if (this.eco.money - pl.cost < task.estimate!.fleetCost || g.stations.commitRail(pl, me)) return fail('station exceeded the funded budget', 720);
        const st = g.stations.get(id);
        if (!st?.rail) return fail('station could not be built', 720);
        p.stations.push(id); task.stations.push(id); this.track(e0);
      } else if (task.stage === 'buildLinks') {
        const sts = builtStations();
        if (task.at + 1 >= sts.length) { task.doubleEdges = p.edges.filter((id) => net.edges.get(id)?.station === -1); task.stage = 'buildTail'; yield; continue; }
        const a = ends(sts[task.at], true), b = ends(sts[task.at + 1], false), r = sts[task.at].rail!, e0 = net.nextEdge;
        const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), options(task.level, r));
        if (!pj.ok || this.eco.money - pj.cost < task.estimate!.fleetCost || commitProposal(g, pj)) return fail(`track ${sts[task.at].name}-${sts[task.at + 1].name}: ${pj.errors[0] ?? 'funded budget exceeded'}`, 720);
        this.track(e0); task.at++;
      } else if (task.stage === 'buildTail') {
        const yard = task.plannedYard!, st = builtStations()[yard.index], head = ends(st, yard.dir > 0)[yard.track], root = net.nodes.get(head);
        if (!root) return fail('lost depot tail', 720);
        task.fork = head;
        if (!yard.straight) {
          const dx = Math.sin(task.angle) * yard.dir, dz = Math.cos(task.angle) * yard.dir;
          const fork = { x: root.x + dx * URBAN_TAIL, z: root.z + dz * URBAN_TAIL, y: root.y }, e0 = net.nextEdge;
          const tp = tailPlan({ ...root, dx, dz, node: head }, fork, task.level, st.rail!);
          if (!tp.ok || this.eco.money - yard.cost < task.estimate!.fleetCost || commitProposal(g, tp)) return fail('depot tail exceeded the funded budget or cannot be built', 720);
          this.track(e0);
          const node = nodeAt(g, 'rail', fork.x, fork.z);
          if (!node) return fail('lost depot tail', 720);
          task.fork = node.id;
        }
        task.stage = 'buildYard';
      } else if (task.stage === 'buildYard') {
        const yard = task.plannedYard!, sts = builtStations(), st = sts[yard.index], outer = ends(st, yard.dir > 0), e0 = net.nextEdge;
        if (this.eco.money - yard.cost < task.estimate!.fleetCost) return fail('depot exceeded the funded budget', 720);
        const fork = task.fork ?? outer[yard.track ?? 0];
        if (yard.under) task.depot = buildSubwayYard(g, fork, yard.under, me, 'electric');
        else {
          const pr = planEdge(g, nodeSnap(g, fork, 'rail'), { kind: 'free', x: yard.x, z: yard.z, y: ground(yard.x, yard.z) }, { kind: 'rail', type: 'electric', tracks: 1, heightOffset: 0, crossing: 'auto', owner: me, designGrade });
          if (pr.ok && !commitProposal(g, pr)) { const node = net.nearestNode(yard.x, yard.z, 0.1, 'rail', (n) => n.edges.length === 1); task.depot = node ? depotAtEnd(g, node.id, me) : -1; }
        }
        this.track(e0);
        if (task.depot < 0) return fail('no depot site', 720);
        p.depots.push(task.depot); task.end = st.id; task.stage = 'throat';
      } else if (task.stage === 'throat') {
        const e0 = net.nextEdge;
        if (task.plannedYard?.straight) keepFleet(() => Trackops.connectStationThroat(g, task.end, me));
        this.track(e0); task.stage = 'finish';
      } else if (task.stage === 'finish') {
        const e0 = net.nextEdge;
        keepFleet(() => { task.finish = finishDoubleTrack(g, task.doubleEdges, me,
          { log: AIController.profile ? (s) => this.note(s) : undefined }); }); this.track(e0);
        if (task.finish?.error) return fail(task.finish.error, 720);
        task.stage = 'line';
      } else if (task.stage === 'line') {
        const line = g.lines.create('rail', me); line.stops = outAndBack(task.stations); p.line = line.id;
        g.lines.rebuild();
        keepFleet(() => this.signalLine(line.id)); task.at = 0; task.stage = 'fleet';
      } else if (task.stage === 'fleet') {
        if (task.at >= task.estimate!.fleet) {
          const towns = [...new Set(task.stations.map(id => g.stations.get(id)?.townId ?? -1).filter(id => id >= 0))];
          const info: LineInfo = { kind: 'rail', towns, depot: task.depot, maxVehicles: Math.max(task.estimate!.fleet, task.stations.length), opened: g.day, double: true, urban: mode };
          this.lines.set(p.line, info); this.stats.lines++; this.stats.urban++; this.stats.railStations += task.stations.length;
          task.at = 0; task.stage = 'transfers'; continue;
        }
        const unit = task.unit ? MODEL_BY_ID.get(task.unit) : this.urbanUnit(mode, PL);
        if (!unit) return fail('no vehicles');
        const train = g.vehicles.buyTrain(task.depot, [unit], p.line);
        if (typeof train === 'string') return fail(`forecast fleet could not be bought: ${train}`, 720);
        task.at++; task.bought++; this.stats.vehicles++;
      } else if (task.stage === 'transfers') {
        if (task.at >= task.stations.length) { task.stage = 'open'; continue; }
        this.linkTransfers(task.stations[task.at++]);
      } else {
        const line = g.lines.get(p.line)!, e = task.estimate!, where = task.level === 'underground' ? 'underground' : task.level === 'elevated' ? 'elevated' : 'at street level';
        g.postNews(`${this.name} opens ${line.name} in ${T.name} with ${task.stations.length} stations, ${where}.`, 'ai', T.x, T.z);
        this.note(`opened ${what} ${line.name} in ${T.name} (${where}): ${task.stations.length} stations, ${task.finish!.signals} signals; ${Math.round(e.forecast.covered)} covered, ${Math.round(e.forecast.transfers)} transfers/year, ${Math.round(e.net / 1000)}k/year forecast`);
        const cid = this.canonical(line.id), end = task.end;
        this.endProject(); this.urbanTask = null;
        if (cid !== line.id) return;
        this.state.through = { line: line.id, end, mode, at: 0 };
        yield;
        yield* this.throughJob();
        return;
      }
      yield;
    }
  }

  /**
   * Through service (mutual through running, as on Fukuoka's subway and JR Chikuhi line): where one of our main
   * lines (or an open network's) ends at a station near the city line's depot end, the two are joined by track there,
   * the main line electrified, and a through line runs commuter units from the main line on into the city. Both are
   * ordinary rail: the units run on main-line and urban track alike, the lines become patterns of one route.
   * The candidates (free platform ends of usable lines' termini) are listed again each work unit in a fixed order
   * and one is tried per unit (cursor state.through.at, saved with the company: a game saved meanwhile resumes
   * alike). The first that plans is built within that unit or not at all (tryThrough): a save never finds it
   * half-built.
   */
  private *throughJob(): Generator<void, void> {
    for (;;) {
      const t = this.state.through;
      if (!t) return;
      const cands = this.throughCandidates(t);
      if (t.at >= cands.length) { delete this.state.through; this.state.phase = 'idle'; return; }
      const c = cands[t.at++];
      this.state.phase = `planning through trains at ${this.game.stations.get(c.term)?.name ?? 'a terminus'}`;
      if (this.tryThrough(t, c)) { delete this.state.through; this.state.phase = 'idle'; return; }
      yield;
    }
  }

  /** Free platform ends of the termini of usable lines near the city line's depot end (same town), in a fixed order. */
  private throughCandidates(t: ThroughJob): { line: number; term: number; node: number }[] {
    const g = this.game, me = this.companyId, net = g.world.net, end = g.stations.get(t.end);
    const out: { line: number; term: number; node: number }[] = [];
    if (!end || !g.lines.get(t.line)) return out;
    const info = this.lines.get(t.line);
    if (!info) return out;
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.id === t.line || g.trackUpgradeError(me, l.owner)) continue;
      const path = linearStops(l.stops);
      if (!path) continue;
      for (const term of [path[0], path[path.length - 1]]) {
        const J = g.stations.get(term);
        if (!J?.rail || J.townId !== end.townId) continue;
        // The connector joins a platform end to the yard lead, rather than either station's centre.
        for (const node of stationEnds(g, J).flatMap((e) => [e.front, e.back])) {
          const n = net.nodes.get(node);
          if (n?.edges.length !== 1) continue;
          const join = this.rampJoin(info.depot, node);
          if (join && Math.hypot(n.x - join.x, n.z - join.z) <= 90) out.push({ line: l.id, term, node });
        }
      }
    }
    return out;
  }

  /**
   * One through-service candidate, built within this work unit or not at all: the connector from the terminus's free
   * platform end to the exact point on our own depot ramp (an edge and a distance along it: never another track
   * passing that spot), checked first for its funds, track access and wiring; then the connector, the main line's
   * wire, the through line checked for its unit over the whole route, the unit, and the lines merged into one route.
   * A failure after the connector removes the connector only (the pieces of the ramp it split stay). True when built.
   */
  private tryThrough(t: ThroughJob, c: { line: number; term: number; node: number }): boolean {
    const g = this.game, me = this.companyId, net = g.world.net;
    const ul = g.lines.get(t.line), l = g.lines.get(c.line), J = g.stations.get(c.term), end = g.stations.get(t.end), info = this.lines.get(t.line);
    const path = l ? linearStops(l.stops) : null, ustops = ul ? linearStops(ul.stops) : null;
    if (!ul || !l || !J || !end || !info || !path || !ustops || net.nodes.get(c.node)?.edges.length !== 1) return false;
    const join = this.rampJoin(info.depot, c.node);
    if (!join) return false;
    const pj = planEdge(g, nodeSnap(g, c.node, 'rail'), { kind: 'edge', x: join.x, y: join.y, z: join.z, edge: join.edge, s: join.s },
      { kind: 'rail', type: 'electric', tracks: 1, heightOffset: 0, crossing: 'auto', owner: me });
    if (!pj.ok) return false;
    // the route: the main line to its terminus, the connector, the city line from the end the connector joins
    const mpath = c.term === path[path.length - 1] ? path : [...path].reverse();
    const upath = ustops[ustops.length - 1] === end.id ? [...ustops].reverse() : ustops;
    // its unit (any rail unit runs on every track type): the biggest electric commuter unit that fits every platform
    const shortest = Math.min(...[...mpath, ...upath].map((id) => g.stations.get(id)?.rail?.length ?? 0));
    const unit = availableModels(g.year, 'emu', false).filter((m) => m.id.startsWith('emu_') && m.traction === 'electric' && m.length <= shortest - 0.4)
      .sort((a, b) => b.capacity - a.capacity)[0] ?? this.urbanUnit(t.mode, shortest);
    if (!unit) return false;
    // the main line's track and platforms to wire (ours, or an open network's at our cost): access and funds first
    const wire = this.lineTrack(path), dry = electrify(g, wire, me, true);
    if (dry.error && dry.error !== 'No unelectrified track here') { this.note(`through service at ${J.name}: ${dry.error}`); return false; }
    const cost = pj.cost + (dry.changed ? dry.cost : 0) + unit.cost;
    if (cost > this.available() || !this.borrowFor(cost)) { this.note(`through service at ${J.name}: not enough money`); return false; }
    // the connector: the edges it lays, not the halves of the ramp it splits
    const t0 = net.nextEdge, pieces = new Set<number>();
    const onSplit = (old: NEdge, e1: NEdge, e2: NEdge) => { if (old.id < t0 || pieces.has(old.id)) { pieces.add(e1.id); pieces.add(e2.id); } };
    net.onSplit.push(onSplit);
    let err: string | null;
    try { err = commitProposal(g, pj); } finally { net.onSplit = net.onSplit.filter((f) => f !== onSplit); }
    if (err) return false;
    const connector: number[] = [];
    for (let id = t0; id < net.nextEdge; id++) if (net.edges.has(id) && !pieces.has(id)) connector.push(id);
    const undo = (why: string) => { removeEdges(g, connector, me); this.note(`through service at ${J.name} given up: ${why}`); return false; };
    if (dry.changed) {
      const el = electrify(g, wire, me);
      if (el.error) return undo(el.error);
      this.stats.electrified += Math.round(el.length);
    }
    const tl = g.lines.create('rail', me);
    tl.stops = outAndBack([...mpath, ...upath]);
    const unfit = lineCompatibility(g, tl.id, [unit]);
    if (unfit) { g.lines.delete(tl.id); return undo(unfit); }
    const tr = g.vehicles.buyTrain(info.depot, [unit], tl.id);
    if (typeof tr === 'string') { g.lines.delete(tl.id); return undo(tr); }
    this.stats.vehicles++; this.stats.through++;
    this.lines.set(tl.id, { kind: 'rail', towns: [...new Set([...info.towns, g.stations.get(mpath[0])?.townId ?? -1])], depot: info.depot, maxVehicles: 2, opened: g.day });
    this.signalLine(tl.id);
    g.postNews(`${this.name} runs through trains from ${g.stations.get(mpath[0])?.name} to ${g.towns.list[end.townId]?.name}’s city railway.`, 'ai', J.x, J.z);
    this.note(`through service ${tl.name} (${tl.stops.length} stops)`);
    // (the city line and the main line become patterns of the through line: one line per route)
    const tid = this.canonical(tl.id), tinfo = this.lines.get(tid);
    if (tinfo) {
      tinfo.urban ??= t.mode;
      const through = g.lines.get(tid)!;
      tinfo.double = lineIsDouble(g, through, me);
      // A single connector between two busy services becomes their shared bottleneck. Its forecast share of
      // annual receipts values an immediate complete upgrade, using the same saved job as a congestion fix.
      const recovery = Math.max(congestionReturn(g, through), (ul.incomeLast + l.incomeLast) * 0.2);
      if (!tinfo.double && recovery * (6 + 12 * this.config.risk) > pj.cost * 2 && this.available() > pj.cost * 2 + 500_000) this.startDouble(through, tinfo, recovery);
    }
    return true;
  }

  /** The track of a line's stations and between them (each pair's route from the first one's platforms). */
  private lineTrack(path: number[]): number[] {
    const g = this.game, me = this.companyId, net = g.world.net, edges = new Set<number>();
    for (let i = 0; i + 1 < path.length; i++) {
      const a = g.stations.get(path[i]), b = g.stations.get(path[i + 1]);
      if (!a?.rail || !b?.rail) continue;
      for (const eid of [...a.rail.edges, ...b.rail.edges]) edges.add(eid);
      for (const eid of a.rail.edges) {
        const e = net.edges.get(eid);
        if (!e) continue;
        const r = findRailRoute(g, railNext(g, e, 1, me), b.id, me, -1, 30000) ?? findRailRoute(g, railNext(g, e, -1, me), b.id, me, -1, 30000);
        if (r) { for (const q of r.conts) edges.add(q.edge.id); break; }
      }
    }
    return [...edges];
  }

  /**
   * Where a through service joins a city line's depot ramp: on the plain track out from the depot to the first switch,
   * a third of the way along (where a tunnel ramp nears the surface) but at least 5 units out (clear of the depot
   * building). Traced from the depot (the station throat and the double-track works split and renumber the ramp's
   * edges after it is built), and returned as that exact edge, distance and height. With an approaching platform,
   * search farther along a sideways cavern lead if its nearer tangent would send the connector into the depot.
   */
  private rampJoin(depotId: number, fromNode?: number): { edge: number; s: number; x: number; y: number; z: number } | null {
    const net = this.game.world.net, d = this.game.depots.get(depotId);
    if (!d) return null;
    const run: { e: NEdge; from: number }[] = [];
    let node = d.node, prev = d.edge, total = 0;
    for (let i = 0; i < 16; i++) {
      const next = (net.nodes.get(node)?.edges ?? []).filter((id) => id !== prev);
      const e = next.length === 1 ? net.edges.get(next[0]) : undefined;
      if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0) break;
      run.push({ e, from: node }); total += e.len;
      prev = e.id; node = e.a === node ? e.b : e.a;
    }
    const first = Math.min(total - 1, Math.max(total / 3, 5));
    if (first < 1) return null;
    const origin = fromNode === undefined ? undefined : net.nodes.get(fromNode);
    const distances = origin ? [first, ...[0.5, 2 / 3, 5 / 6, 1].map((f) => Math.min(total - 1, total * f)).filter((s) => s > first)] : [first];
    for (let want of distances) for (const { e, from } of run) {
      if (want <= e.len) {
        if (e.len < 1.7) break;
        const s = Math.max(0.8, Math.min(e.len - 0.8, from === e.a ? want : e.len - want)), q = { x: 0, y: 0, z: 0 }, tangent = { x: 0, y: 0, z: 0 };
        net.pointAt(e, s, q, tangent);
        const dir = from === e.a ? 1 : -1;
        if (!origin || ((q.x - origin.x) * tangent.x + (q.z - origin.z) * tangent.z) * dir > 0)
          return { edge: e.id, s, x: q.x, y: q.y, z: q.z };
        break;
      }
      want -= e.len;
    }
    return null;
  }

  // ---------------------------------------------------------------- long-distance coaches
  /** A stop for coaches in a town: at our rail station (a transfer hub) or on a central street. */
  private *coachStopGen(T: Town): Generator<void, { x: number; z: number } | null> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    let best: { x: number; z: number; d: number } | null = null;
    for (const e of g.towns.streets(T, 2)) {
      if (e.len < 4) continue;
      yield;
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || (bp.join && !(bp.join.owner === owner && bp.join.townId === T.id))) continue;
      const d = Math.hypot(q.x - T.x, q.z - T.z) - (bp.join?.rail ? 30 : 0);
      if (!best || d < best.d) best = { x: q.x, z: q.z, d };
    }
    return best;
  }

  /** A coach line between two towns over the roads (stops at central streets or our rail stations, a depot, coaches). */
  private *coachJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = 'coach' + this.pairKey(A.id, B.id);
    this.state.phase = `planning coaches ${A.name} - ${B.name}`;
    const fail = (why: string, days = 1500) => { this.note(`coaches ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    const model = pickCoach(g.year);
    if (!model) return fail('no coaches available');
    if (!this.roadConnected(A, B)) return fail('no road between the towns', 720);
    yield;
    const sa = yield* this.coachStopGen(A), sb = yield* this.coachStopGen(B);
    if (!sa || !sb) return fail('no stop sites');
    const cost = 2 * 30_000 + 80_000 + model.cost * 2;
    if (cost > this.available() || !this.borrowFor(cost)) return fail('no money', 360);
    this.state.phase = `building coaches ${A.name} - ${B.name}`;
    p.built = true;
    yield;
    const ids: number[] = [];
    for (const s of [sa, sb]) {
      yield;
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) return fail('stop site taken', 360);
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (g.stations.nextId > before) { p.stations.push(before); yield; this.linkTransfers(before); }
      if (sid < 0 || ids.includes(sid)) return fail('stops not built', 360);
      ids.push(sid);
      this.stats.busStops++;
      yield;
    }
    const d0 = net.nextEdge;
    const dep = yield* this.roadDepot(sa.x, sa.z);
    this.track(d0);
    if (dep < 0) return fail('no depot site', 720);
    p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    yield;
    if (!roadDepotReaches(g, dp, ids[0])) return fail('no road route', 720);
    yield;
    if (!roadDepotReaches(g, dp, ids[1])) return fail('no road route', 720);
    yield;
    const line = g.lines.create('road', owner);
    line.stops = ids;
    p.line = line.id;
    let bought = 0;
    for (let i = 0; i < 2; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') { bought++; this.stats.vehicles++; } yield; }
    if (!bought) return fail('could not buy coaches', 360);
    this.lines.set(line.id, { kind: 'bus', towns: [A.id, B.id], depot: dep, maxVehicles: 4, opened: g.day });
    this.stats.lines++; this.stats.coaches++;
    g.postNews(`${this.name} starts coaches between ${A.name} and ${B.name}.`, 'ai', (A.x + B.x) / 2, (A.z + B.z) / 2);
    this.note(`opened coach line ${A.name}-${B.name} (${Math.round(Math.hypot(A.x - B.x, A.z - B.z))} u, ${bought} coaches)`);
    this.canonical(line.id);
  }

  // ---------------------------------------------------------------- tram (ai-tram.ts does the planning and building)
  private startTram(townId?: number): boolean {
    const g = this.game, tp = this.tramPlanner();
    if (!tp.start(townId)) return false;
    const town = tramExt(tp).project?.town ?? -1;
    this.project = { kind: 'tram', towns: town >= 0 ? [town] : [], stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = this.tramJob(g.towns.list[town]);
    this.state.projects++;
    return true;
  }

  private *tramJob(T: Town | undefined): Generator<void, void> {
    const g = this.game, tp = this.tramPlanner(), x = tramExt(tp);
    const p = this.project!;
    const where = T ? T.name : 'town';
    this.state.phase = `planning trams in ${where}`;
    for (;;) {
      const r = tp.step(1);
      if (r === 'running') { if (x.status) this.state.phase = x.status; yield; continue; }
      if (r === 'failed') {
        this.note(`trams in ${where} abandoned: ${x.reason || 'failed'}`);
        if (T) this.markFailed('tram' + T.id, 720); else this.stats.failed++;
        tp.cleanup();
        return;
      }
      // done: the planner opened a line; we manage it from now on
      const pr = x.project;
      const line = pr ? g.lines.get(pr.line) : undefined;
      if (line) {
        p.line = line.id;
        this.lines.set(line.id, { kind: 'tram', towns: T ? [T.id] : [], depot: pr!.depot, maxVehicles: 4, opened: g.day });
        this.stats.lines++; this.stats.trams++; this.stats.vehicles += line.vehicles.length;
        g.postNews(`${this.name} opens a tram line in ${where}.`, 'ai', T?.x, T?.z);
        this.note(`opened tram line in ${where} (${new Set(line.stops).size} stops, ${line.vehicles.length} trams)`);
        this.canonical(line.id);
      }
      tp.cleanup();
      return;
    }
  }

  // ---------------------------------------------------------------- road
  /** Are two towns connected by roads? (bounded search over the road graph) */
  private roadConnected(A: Town, B: Town): boolean {
    const net = this.game.world.net;
    const start = net.nearestNode(A.x, A.z, A.radius + 6, 'road', (n) => n.edges.length > 0);
    if (!start) return false;
    const seen = new Set<number>([start.id]);
    const queue = [start.id];
    while (queue.length && seen.size < 6000) {
      const id = queue.shift()!;
      const n = net.nodes.get(id)!;
      if (Math.hypot(n.x - B.x, n.z - B.z) < B.radius) return true;
      for (const eid of n.edges) {
        const e = net.edges.get(eid);
        if (!e || e.depot >= 0) continue;
        const o = e.a === id ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); queue.push(o); }
      }
    }
    return false;
  }

  /** Outermost street point of a town in direction u (within a corridor). */
  private townEdge(T: Town, ux: number, uz: number): { x: number; z: number; d: number } | null {
    const net = this.game.world.net;
    let best: { x: number; z: number; d: number } | null = null;
    for (const e of this.game.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 0; i < geo.n; i += 4) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat > 14 || along < 0) continue;
        if (!best || along > best.d) best = { x, z, d: along };
      }
    }
    return best;
  }

  /**
   * Where a country road can leave a town towards direction u: a dead-end street facing that way
   * (extended straight), else a side exit from the outermost street. Returns the join proposal.
   */
  private *townExit(T: Town, ux: number, uz: number): Generator<void, { prop: Proposal; x: number; z: number; tx: number; tz: number } | null> {
    const g = this.game, net = g.world.net;
    const so: BuildOptions = { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.companyId };
    const cands: { sn: Snap; tx: number; tz: number; score: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid)!;
        if (n.edges.length !== 1) continue;
        const along = (n.x - T.x) * ux + (n.z - T.z) * uz, lat = Math.abs((n.x - T.x) * uz - (n.z - T.z) * ux);
        const d = net.leaveDir(e, nid);
        const tx = -d.x, tz = -d.z;
        const facing = tx * ux + tz * uz;
        if (along < -5 || lat > 30 || facing < 0.5) continue;
        cands.push({ sn: { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }, tx, tz, score: along - lat * 0.5 + facing * 20 });
      }
    }
    // side exits from the outermost streets
    const pts: { x: number; z: number; along: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 2; i < geo.n - 2; i += 6) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat < 20 && along > 0) pts.push({ x, z, along });
      }
    }
    pts.sort((p, q) => q.along - p.along);
    for (const q of pts.slice(0, 6)) { const sn = findSnap(g, 'road', q.x, q.z, 0.4); if (sn.kind !== 'free') cands.push({ sn, tx: ux, tz: uz, score: q.along - 1000 }); }
    cands.sort((p, q) => q.score - p.score);
    for (const c of cands.slice(0, 10)) {
      yield;
      const x = c.sn.x + c.tx * 8, z = c.sn.z + c.tz * 8;
      if (!g.world.inside(x, z, 6) || g.world.heightAt(x, z) < WATER_Y + 0.2) continue;
      const pj = planEdge(g, c.sn, { kind: 'free', x, z, y: 0 }, so);
      yield;
      if (pj.ok && pj.demolish.length <= 2 && pj.stats.minRadius >= 3) {
        const end = endTangent(pj.tracks[0].bez);
        return { prop: pj, x, z, tx: end.x, tz: end.z };
      }
    }
    return null;
  }

  private *roadJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = 'road' + this.pairKey(A.id, B.id);
    this.state.phase = `planning road ${A.name} - ${B.name}`;
    const fail = (why: string, days = 3000) => { this.note(`road ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (this.roadConnected(A, B)) return fail('already connected', 1e9);
    yield;
    const d = Math.hypot(B.x - A.x, B.z - A.z);
    const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
    const xa = yield* this.townExit(A, ux, uz), xb = yield* this.townExit(B, -ux, -uz);
    if (!xa || !xb) return fail('no way out of the towns');
    const from: OPoint = { x: xa.x, z: xa.z, tx: xa.tx, tz: xa.tz };
    const to: OPoint = { x: xb.x, z: xb.z, tx: -xb.tx, tz: -xb.tz };
    const gap = (to.x - from.x) * ux + (to.z - from.z) * uz;
    if (gap < 15) return fail('towns touch', 1e9);
    yield;
    const plan = yield* routeGen(g, from, to, {
      kind: 'road', owner, tracks: 1, y0: xa.prop.tracks[0].prof[xa.prop.tracks[0].prof.length - 1], y1: xb.prop.tracks[0].prof[xb.prop.tracks[0].prof.length - 1],
      buildingCost: 3, lead: 6, rmax: 80, rgood: 12, minR: 5, roadJunctions: true,
    }, AI_ROUTE_WORK);
    if (typeof plan === 'string') return fail(plan, plan.startsWith('route runs') ? 1500 : 3000);
    const al = { way: plan.way };
    let prof: ChainProfile | null = plan.prof;
    if (prof.s[prof.s.length - 1] > gap * 2 + 20) return fail('detour too long');
    const est = estimateChainCost(prof, 1, 'road', 'road').cost * 1.2 + xa.prop.cost + xb.prop.cost + 50_000;
    if (est > this.available() * 0.4) return fail('too expensive', 720);
    if (!this.borrowFor(est)) return fail('no money', 360);
    this.state.phase = `building road ${A.name} - ${B.name}`;
    p.built = true;
    const o: BuildOptions = { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: 'auto', owner };
    const e0 = net.nextEdge;
    if (commitProposal(g, xa.prop) || commitProposal(g, xb.prop)) { this.track(e0); return fail('could not join the towns'); }
    this.track(e0);
    const nA = nodeAt(g, 'road', from.x, from.z), nB = nodeAt(g, 'road', to.x, to.z);
    if (!nA || !nB) return fail('could not join the towns');
    yield;
    prof = chainProfile(g, al.way, 1, nA.y, nB.y, 'road', new Set(), true);
    if (!prof) return fail('too steep');
    const chain = aiChainGen(g, nA.id, al.way.slice(1), o, nB.id, prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    if (!r.value.ok) return fail('construction failed: ' + (r.value.error ?? ''));
    this.stats.road += r.value.built + 16;
    this.stats.bridges += r.value.bridges; this.stats.tunnels += r.value.tunnels;
    g.postNews(`${this.name} builds a road between ${A.name} and ${B.name}.`, 'ai', (A.x + B.x) / 2, (A.z + B.z) / 2);
    this.note(`built road ${A.name}-${B.name} (${Math.round(r.value.built + 16)} u)`);
    this.failed.set(key, 1e12); // done for good
    this.project = null;
  }

  // ---------------------------------------------------------------- management
  /** Six months at the debt ceiling: suspend building and free surplus stock before retiring a service. */
  private recoverCash() {
    const g = this.game, e = this.eco;
    if (this.job && !this.project?.joint) {
      this.cancelJob();
      this.note('paused new projects: cash at the loan limit for six months');
    }
    const lines = g.lines.all().sort((a, b) => this.railPolicy.lossOrder(a.id, b.id));
    const surplus = lines.filter((l) => l.kind !== 'rail').flatMap((l) => l.vehicles
      .map((id) => g.vehicles.get(id)).filter((v) => v?.owner === this.companyId).slice(1))
      .sort((a, b) => a!.profitLast - b!.profitLast || b!.id - a!.id);
    for (const v of surplus) {
      if (e.money >= 0) break;
      g.vehicles.sell(v!.id); this.stats.sold++;
      this.note(`sold surplus ${v!.name} during cash recovery`);
    }
    for (const l of lines) {
      if (e.money >= 0) break;
      if (l.kind !== 'rail' || !this.railPolicy.fleet(l).length) continue;
      const s = this.railPolicy.account(l);
      // Shorter consists have had their annual trial; an emergency frequency cut still gets a full year.
      if (s.step >= 1 && g.day - s.lastCut >= 360 && this.railPolicy.fewer(l, this.railPolicy.surplus(l).length, 'fewer trains during cash recovery')) {
        s.step = Math.max(2, s.step); s.lastCut = g.day;
      }
    }
  }

  /** Take over lines of ours that no project registered (bought companies, older saves). */
  private adoptLines(includeProject = false) {
    const g = this.game, me = this.companyId;
    for (const l of g.lines.map.values()) {
      // capacity-integration: canonicalisation can move our stock to another company's line.
      if (this.lines.has(l.id) || (!includeProject && this.project?.line === l.id)) continue;
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v && v.owner === me);
      if (l.owner !== me && !vs.length) continue;
      const dep = vs.length ? (vs[0] as Train | RoadVehicle).depotId : l.kind === 'rail'
        ? [...g.depots.map.values()].find((d) => d.owner === me && d.kind === 'rail' && l.stops.some((sid) => depotReaches(g, d, sid)))?.id ?? -1 : -1;
      if (dep === undefined || dep < 0 || !g.depots.get(dep)) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      const kind = l.kind === 'rail' ? 'rail' : l.kind === 'tram' ? 'tram' : 'bus';
      this.lines.set(l.id, { kind, towns, depot: dep, maxVehicles: kind === 'rail' ? Math.max(1, vs.length) : kind === 'tram' ? Math.max(4, vs.length) : Math.max(5, vs.length),
        opened: this.railPolicy.accounts.get(l.id)?.opened ?? (vs.length ? Math.min(...vs.map((v) => v.boughtDay)) : g.day),
        ...(l.owner !== me ? { joined: true, shared: l.owner } : {}) });
    }
  }

  private manage() {
    const g = this.game, e = this.eco, c = this.config, act = c.activeness;
    // loans: keep a cash cushion, repay when rich (cautious companies repay sooner)
    if (e.money < 500_000) { while (e.money < 1_000_000 && e.borrow()) { /* */ } }
    else if (!this.job && e.money > 3_000_000 * (0.6 + c.risk) && e.loan > 0) { while (e.money > 2_000_000 && e.loan > 0 && e.repay()) { /* */ } }
    this.adoptLines();
    if (this.railPolicy.deepTrouble) this.recoverCash();
    let grew = false;
    for (const [lid, info] of [...this.lines].sort(([a], [b]) => this.railPolicy.lossOrder(a, b))) {
      const l = g.lines.get(lid);
      // (a line merged into another as a service pattern: lines.get follows the redirect to the other line, which is
      // looked after under its own id, if it is ours)
      if (!l || l.id !== lid) { this.lines.delete(lid); continue; }
      // a line we may no longer run (we left its stations, it was closed to us): our vehicles off it
      if (info.joined && !g.lines.canOperate(l, this.companyId)) {
        for (const v of l.vehicles.map((id) => g.vehicles.get(id)).filter((x) => !!x && x.owner === this.companyId)) { g.vehicles.sell(v!.id); this.stats.sold++; }
        g.lines.leave(lid, this.companyId);
        this.lines.delete(lid);
        if (info.shared !== undefined) this.removeDepotBranch(info.depot);
        this.note(`left ${l.name} (no station of ours on it)`);
        continue;
      }
      // our vehicles (a shared line has other operators' too)
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v && v.owner === this.companyId);
      // Older purchases may already be saved at the wrong initial call. Repair only a depot departure;
      // moving bodies, pending routes and their held reservations retain their native destination.
      for (const t of vs) if (t instanceof Train && !t.onMap && !t.backoff && t.state === 'noroute' && !t.pending.length) {
        const call = openingRailCall(g, t);
        if (call >= 0 && call !== t.stopIndex) { t.stopIndex = call; t.onLineChanged(); }
      }
      // a line that lost its stops (track access ended, stations gone): close it (leave it, if it is another's),
      // as we do one we no longer run trains on
      if (new Set(l.stops).size < 2 || (info.kind !== 'rail' && info.joined && !vs.length && g.day - info.opened > 90)) {
        if (info.kind === 'rail') { this.note(`${l.name}: service suspended until its stations are restored`); continue; }
        for (const v of vs) { g.vehicles.sell(v.id); this.stats.sold++; }
        if (info.joined) g.lines.leave(lid, this.companyId); else g.lines.delete(lid);
        this.lines.delete(lid);
        if (info.shared !== undefined) this.removeDepotBranch(info.depot);
        this.note(`${info.joined ? 'left' : 'closed'} ${l.name}`);
        continue;
      }
      if (info.kind === 'rail') {
        this.mailPolicy.manage(l, info);
        const close = this.railPolicy.review(l);
        if (close && info.joined) {
          this.railPolicy.event(l, 'closed', 'left after five losing years and staged cuts');
          for (const v of vs) { g.vehicles.sell(v.id); this.stats.sold++; }
          g.lines.leave(lid, this.companyId); this.lines.delete(lid);
          this.note(`left ${l.name}: five consecutive losing years after service cuts`);
          g.postNews(`${this.name} leaves ${l.name} after five losing years.`, 'ai');
          continue;
        }
        const account = this.railPolicy.account(l);
        if (account.step > 0 || this.railPolicy.deepTrouble) {
          // Allow restoration of a missing minimum service below; no expansion during its annual trial.
          if (vs.length) continue;
        }
      }
      // Signals/platforms, full doubling (or temporary loops), then fewer trains after a proved limitation.
      if (info.kind === 'rail' && this.relieveCongestion(l, info)) continue;
      // an express pattern on a long line of uneven demand (every other train passes the quieter stations)
      if (info.kind === 'rail' && info.shared === undefined && !info.joined && !info.urban && info.express === undefined && vs.length >= 3 && g.day - info.opened > 360
        && (info.expressLook ?? 0) < new Set(l.stops).size && this.addExpress(l, info, vs)) continue;
      // a busy main line under the wire, where electric trains of the year beat the diesels
      if (info.kind === 'rail' && info.shared === undefined && !info.joined && !info.urban && !info.hsr && vs.length >= 3 && g.year >= 1950
        && (info.electric === undefined || (info.electric < 0 && g.day + info.electric > 720)) && this.electrifyLine(l, info)) continue;
      // stations that need room (busy platforms, trains waiting for one, more lines than platforms, junctions):
      // rebuilt bigger before more trains are bought (one station a month)
      if (info.kind === 'rail' && info.shared === undefined && !info.joined && !grew && vs.length && this.growLineStations(l)) { grew = true; continue; }
      // a railway still without trains (money ran short when it opened): its first train
      if (!vs.length && info.kind === 'rail' && g.lines.canOperate(l, this.companyId) && g.depots.get(info.depot)) {
        const sts = l.stops.map((sid) => g.stations.get(sid)).filter((x): x is Station => !!x?.rail);
        const platform = Math.min(...sts.map((x) => x.rail!.length), 99), span = sts.reduce((m, x) => Math.max(m, Math.hypot(x.x - sts[0].x, x.z - sts[0].z)), 0);
        const unit = info.urban ? this.urbanUnit(info.urban, platform) : null;
        const cars = info.urban ? (unit ? [unit] : null) : pickTrain(g.year, platform, span * 1.3, 2);
        const cost = cars ? cars.reduce((a, c) => a + c.cost, 0) : Infinity;
        if (cars && sharedTrainAllowed(g, l, this.companyId, cars) && this.available() > cost + 300_000 && this.borrowFor(cost)) {
          const t = g.vehicles.buyTrain(info.depot, cars, lid);
          if (typeof t !== 'string') {
            const call = openingRailCall(g, t);
            if (call < 0) g.vehicles.sell(t.id);
            else { t.stopIndex = call; this.stats.vehicles++; this.note(`first train on ${l.name}`); }
          }
        }
        continue;
      }
      // Rail service reductions belong to the staged operating-loss policy, even with negative cash.
      for (const v of info.kind === 'rail' ? [] : vs) {
        if (v.age < 2.5 || v.profitLast >= -0.25 * v.runningCost || v.profitYear > 0) continue;
        if (vs.length > 1 || e.money < 0) { g.vehicles.sell(v.id); this.stats.sold++; info.lastSold = g.day; this.note(`sold ${v.name}`); break; }
      }
      // more capacity when passengers pile up on a line that pays (active companies expand sooner): railways
      // first get longer trains (up to the platforms), then more trains
      const grow = Math.sqrt(act);
      if (!vs.length || g.day - (info.lastSold ?? -1e9) < 180) continue;
      const young = g.day - info.opened < 360;
      if (!young && l.incomeLast < l.costLast * 1.2 + 10_000) continue;
      let waiting = 0;
      for (const sid of l.stops) { const st = g.stations.get(sid); if (st) for (const w of st.waiting.values()) if (w.line === lid) waiting += w.count; }
      // passengers who gave up waiting at its stops last month, in the line's share of each stop's queue: on small stops
      // a busy line never shows a long queue, its riders give up instead (Stations.trimWaiting)
      let gaveUp = 0;
      for (const sid of new Set(l.stops)) {
        const st = g.stations.get(sid);
        if (!st || !(st.lostLast > 0)) continue;
        let mine = 0, all = 0;
        for (const w of st.waiting.values()) { all += w.count; if (w.line === lid) mine += w.count; }
        if (all > 0) gaveUp += st.lostLast * mine / all;
      }
      const v0 = vs[0];
      if (waiting + gaveUp < (v0.capacity * 2.5) / grow) continue;
      // (urban lines run their units as they are; main lines lengthen their trains first)
      if (info.kind === 'rail' && !info.urban && vs.every((v) => v instanceof Train && v.cars.some((m) => m.kind === 'loco')) && this.lengthenTrain(l, info, vs as Train[], waiting)) continue;
      // a single-track railway full of trains: lay the second track (block signals, more trains)
      if (info.kind === 'rail' && !usesSharedRail(g, l) && !info.double && vs.length >= info.maxVehicles && g.day >= (info.upgradeRetry ?? 0) && g.day - (info.upgradeFailed ?? -1e9) > 180 && !this.job) {
        this.startDouble(l, info, congestionReturn(g, l));
        continue;
      }
      const fleet = () => info.kind === 'bus' ? Math.min(Math.round(info.maxVehicles * grow), l.stops.length * 2)
        : info.kind === 'tram' ? Math.min(Math.round(info.maxVehicles * grow), 2 + l.stops.length) : info.maxVehicles;
      let maxV = fleet();
      // Price added road capacity with a vehicle of the current year. Repeating an old small model
      // leaves profitable lines crowded even after larger buses or articulated trams are available.
      const roadModel = v0 instanceof RoadVehicle && v0.model && v0.capacity > 0 ? info.kind === 'tram'
        ? availableModels(g.year, 'tram').sort((a, b) => b.capacity / (b.cost + modelYearCost(b, g.year) * 8)
          - a.capacity / (a.cost + modelYearCost(a, g.year) * 8))[0] ?? v0.model
        : (v0.model.style === 'coach' ? pickCoach(g.year) : pickBus(g.year,
          Math.max(...info.towns.map((id) => g.towns.list[id]?.pop ?? 3000), 3000))) ?? v0.model : null;
      // Lost riders can fund another vehicle before losses reach two whole vehicle-loads in one
      // month. Compare their observed fare yield with operating cost and the same eight-year
      // vehicle horizon used in model selection; the street's fleet ceiling still applies.
      const hard = info.kind === 'bus' ? l.stops.length * 2 : 2 + l.stops.length;
      const extraRevenue = gaveUp * Math.max(0, l.incomeLast - (l.mail?.incomeLast ?? 0)) / Math.max(1, l.passLast);
      const extraRunning = Math.max(l.costLast / Math.max(1, l.vehicles.length), roadModel ? modelYearCost(roadModel, g.year) : 0);
      if (roadModel && l.vehicles.length >= maxV && maxV < hard && gaveUp > 0
        && extraRevenue > extraRunning + roadModel.cost / 8) { info.maxVehicles++; maxV = fleet(); }
      // all operators' vehicles count towards what the line can take (no over-saturation of one track)
      const cap = info.joined || (info.kind === 'rail' && usesSharedRail(g, l)) ? this.lineCapacity(l) : maxV;
      if (l.vehicles.length >= cap || this.available() < v0.value * 1.5) continue;
      if (info.kind === 'rail' && v0 instanceof Train) {
        // capacity-integration: an extra train pays its congestion bill to all operators, including ourselves.
        if (!sharedTrainAllowed(g, l, this.companyId, v0.cars, v0.pattern)) continue;
        // a further train on a single track: signals first (starters, passing loops), so trains wait instead of meeting head-on
        if (!info.double && info.shared === undefined) this.signalLine(lid);
        const t = g.vehicles.buyTrain(info.depot, [...v0.cars].sort((a, b) => (a.kind === 'loco' ? -1 : 0) - (b.kind === 'loco' ? -1 : 0)), lid);
        if (typeof t !== 'string') {
          t.pattern = v0.pattern;
          const call = openingRailCall(g, t);
          if (call < 0) g.vehicles.sell(t.id);
          else { t.stopIndex = call; this.stats.vehicles++; this.note(`added a train to ${l.name}`); }
        }
      } else if (v0 instanceof RoadVehicle && v0.model) {
        const model = roadModel ?? v0.model;
        if (!this.borrowFor(model.cost)) continue;
        const b = g.vehicles.buyRoad(info.depot, model, lid);
        if (typeof b !== 'string') { this.stats.vehicles++; this.note(`added a ${info.kind === 'tram' ? 'tram' : 'bus'} to ${l.name}`); }
      }
    }
    if (!this.job && g.access.length) this.endUnusedAccess();
    // a town the line passes: a station on the line there (through station; the line stops at it)
    if (!this.railPolicy.deepTrouble) {
      if (!this.job && this.rng.chance(0.35 * act)) this.addIntermediateStation();
      this.considerAcquisition();
    }
  }

  /** Install the cursor before the generator's first tick, so a save immediately after scheduling also resumes. */
  private startDouble(l: Line, info: LineInfo, value: number) {
    this.game.stations.refreshAccess();
    this.project = { kind: 'double', towns: [...info.towns], stations: [], edges: [], depots: [], line: -1, started: this.game.day, built: true };
    this.state.doubleJob = { ...newDoubleJob(l, this.state.phase), returnValue: value, finishFailed: info.doubleFinish ? [...info.doubleFinish] : undefined };
    info.upgradeFailed = this.game.day;
    if (info.doubleValue === undefined && value > 0) { info.doubleValue = value; info.doubleSince = this.game.day; }
    this.job = this.doubleGen(l, info);
  }

  /**
   * Lengthen the trains of a line up to its platforms: a short train standing at a platform is replaced by one
   * with more coaches (a current locomotive). True while some train is still short (no trains are added then).
   */
  private lengthenTrain(l: Line, info: LineInfo, trains: Train[], waiting: number): boolean {
    if (this.mailPolicy.hasPending(trains)) return true;
    const g = this.game;
    let platform = Infinity, span = 0;
    const s0 = g.stations.get(l.stops[0]);
    for (const sid of l.stops) {
      const st = g.stations.get(sid);
      if (st?.rail) platform = Math.min(platform, st.rail.length);
      if (st && s0) span = Math.max(span, Math.hypot(st.x - s0.x, st.z - s0.z));
    }
    if (!isFinite(platform)) return false;
    let short = false, atPlatform = 0;
    for (const t of trains) {
      // (passenger coaches: mail vans are another cargo's room)
      const n = t.cars.filter((c) => c.kind === 'wagon' && !carriesMail(c)).length;
      const want = Math.min(5, n + (waiting > t.capacity * 4 ? 2 : 1));
      const cars = keepMailVans(t, pickTrain(g.year, platform - mailVanLength(t), span * 1.2, want, (info.electric ?? -1) > 0), platform);
      if (!cars || cars.filter((c) => c.kind === 'wagon' && !carriesMail(c)).length <= n) { if (n < 5) atPlatform++; continue; }
      // capacity-integration: longer trains use the paid path better, provided the extra coaches earn their cost.
      if (marginalSharedConsist(g, l, t, cars) <= 0) continue;
      short = true;
      // replaced by a longer one when it next stands at a platform (see replaceTrains)
      if (!this.relengthen.some((q) => q[0] === t.id)) this.relengthen.push([t.id, info.depot, cars.map((c) => c.id)]);
      return true;
    }
    // trains as long as the platforms and still crowded: longer platforms (station rebuild) when money allows, up
    // to 12 units (compact stations)
    if (!short && atPlatform && platform < 12 && this.extendPlatforms(l, Math.min(12, platform + 2))) return true;
    return short;
  }

  /** Rebuild a line's stations with longer platforms (trackops / stations API), when no train stands in them. */
  private extendPlatforms(l: Line, length: number): boolean {
    const g = this.game;
    let done = false;
    for (const sid of new Set(l.stops)) {
      const st = g.stations.get(sid);
      if (!st || !st.rail || st.owner !== this.companyId || st.rail.length >= length) continue;
      if (st.rail.edges.some((e) => g.vehicles.isEdgeBusy(e))) continue; // never strand a train: next month
      try {
        const plan = planStationUpgrade(g, sid, { length });
        if (!plan || !plan.ok || this.available() < plan.cost * 1.5 + 500_000 || !this.borrowFor(plan.cost)) continue;
        const err = commitStationUpgrade(g, plan);
        if (err) continue;
        done = true;
        this.note(`rebuilt ${st.name} with ${length}-unit platforms`);
      } catch (e) { this.note('station rebuild failed: ' + String((e as Error)?.message ?? e)); }
    }
    if (done) g.postNews(`${this.name} lengthens platforms on ${l.name}.`, 'ai');
    return done;
  }

  /** Trains waiting to be replaced by longer ones: replaced when they stand at a platform. */
  private replaceTrains() {
    this.mailPolicy.step();
    const g = this.game;
    for (let i = this.relengthen.length - 1; i >= 0; i--) {
      const [tid, dep, ids] = this.relengthen[i];
      const t = g.vehicles.get(tid);
      const l = t?.line;
      if (!(t instanceof Train) || !l || t.owner !== this.companyId || !g.lines.canOperate(l, this.companyId) || !g.depots.get(dep)) { this.relengthen.splice(i, 1); continue; }
      if (t.state !== 'loading') continue;
      this.relengthen.splice(i, 1);
      const platform = Math.min(...l.stops.map((id) => g.stations.get(id)?.rail?.length ?? 0));
      const cars = keepMailVans(t, ids.map((id) => MODEL_BY_ID.get(id)).filter((m): m is VehicleModel => !!m), platform);
      if (!cars || cars.reduce((s, c) => s + c.capacity, 0) <= t.capacity) continue;
      if (marginalSharedConsist(g, l, t, cars) <= 0) continue;
      const cost = cars.reduce((a, c) => a + c.cost, 0);
      if (cars.length < 2 || this.available() < cost - g.vehicles.resaleValue(t) + 500_000 || !this.borrowFor(cost)) continue;
      if (this.railPolicy.account(l).step > 0 || this.railPolicy.deepTrouble) continue;
      const nt = g.vehicles.buyTrain(dep, cars, l.id);
      if (typeof nt === 'string') continue;
      nt.pattern = t.pattern;
      const call = openingRailCall(g, nt, t.atStation);
      if (call < 0) { g.vehicles.sell(nt.id); continue; }
      nt.stopIndex = call;
      this.mailPolicy.replaced(t, nt);
      const name = t.name;
      // The replacement starts at its depot: mail aboard waits here with its journey intact.
      if (t.mailLoad > 0) offloadMail(g, t, t.mailLoad, g.stations.get(t.atStation) ?? null);
      g.vehicles.sell(t.id);
      this.stats.vehicles++; this.stats.sold++;
      this.note(`lengthened ${name} to ${cars.filter((c) => c.capacity > 0).length} coaches on ${l.name}`);
    }
  }

  /** The main track of a railway line between its end stations (our single-track chain, no platforms or depots). */
  private mainTrack(l: Line): { edges: number[]; len: number; a: Station; b: Station } | null {
    const g = this.game, net = g.world.net, me = this.companyId;
    const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s && !!s.rail);
    if (sts.length < 2) return null;
    const a = sts[0];
    let b = sts[1], bd = 0;
    for (const s of sts) { const d = Math.hypot(s.x - a.x, s.z - a.z); if (d > bd) { bd = d; b = s; } }
    for (const eid of a.rail!.edges) {
      const e = net.edges.get(eid);
      if (!e) continue;
      for (const dir of [1, -1]) {
        const r = findRailRoute(g, railNext(g, e, dir, me), b.id, me, -1, 30000);
        if (!r) continue;
        const edges = r.conts.map((c) => c.edge).filter((x) => x.station < 0 && x.depot < 0 && x.owner === me);
        return { edges: edges.map((x) => x.id), len: edges.reduce((s, x) => s + x.len, 0), a, b };
      }
    }
    return null;
  }

  /**
   * Complete a busy railway, including approaches and junctions. Each station leg's construction is atomic;
   * its cursor, costs and unresolved finishing work survive a save between fixed work ticks. Clear parts of a
   * blocked formation get temporary loops and are retried with the remaining legs.
   */
  private *doubleGen(l: Line, info: LineInfo): Generator<void, void> {
    const g = this.game, me = this.companyId;
    const resuming = !!this.state.doubleJob;
    const cursor = this.state.doubleJob ??= newDoubleJob(l, this.state.phase);
    if (!resuming && info.doubleFinish) cursor.finishFailed = [...info.doubleFinish];
    if (!resuming) info.upgradeFailed = g.day;
    this.state.phase = `doubling ${l.name}`;
    const embedded = this.project?.kind !== 'double';
    const worth = (cost: number) => AIController.forceBuild || (embedded && !l.vehicles.length)
      || cost + (cursor.spent ?? 0) <= Math.max(cursor.returnValue ?? 0, congestionReturn(g, l)) * (6 + 12 * this.config.risk);
    const fund = (cost: number) => this.available() >= cost * 1.15 + 500_000 && this.borrowFor(cost);
    while (!doubleJobStep(g, cursor, me, fund, worth)) {
      if (!embedded) yield;
    }
    info.doubleFinish = cursor.finishFailed?.length ? [...new Set(cursor.finishFailed)] : undefined;
    info.double = lineIsDouble(g, l, me) && !info.doubleFinish;
    if (info.double) { info.doubleValue = undefined; info.doubleSince = undefined; cursor.error = ''; }
    info.doubleImpossible = !info.double && cursor.blocked && !cursor.deferred;
    info.upgradeRetry = info.double ? undefined : g.day + (cursor.deferred ? 30 : 180);
    if (cursor.built) {
      this.stats.doubled++; this.stats.trackDouble += cursor.length; this.stats.signals += cursor.signals;
      if (!info.double) { info.loops = (info.loops ?? 0) + cursor.built; this.stats.loops += cursor.built; }
      else info.loops = undefined;
      info.maxVehicles = Math.max(info.maxVehicles, info.double ? 4 : 3);
      g.postNews(info.double ? `${this.name} doubles the full track of ${l.name}, including its approaches and junctions.` : `${this.name} upgrades part of ${l.name}; the remaining single track will be retried.`, 'ai');
    }
    this.note(`${l.name}: ${info.double ? 'fully double' : 'second track deferred'} (${cursor.built} stretches, ${cursor.signals} signals${cursor.error ? ', ' + cursor.error : ''})`);
    this.state.phase = cursor.phase;
    delete this.state.doubleJob;
  }

  private *legacyDoubleGen(l: Line, info: LineInfo): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net;
    info.upgradeFailed = g.day;
    const m = this.mainTrack(l);
    if (!m || m.edges.length === 0) return;
    const phase = this.state.phase;
    this.state.phase = `doubling ${l.name}`;
    // each stretch between stations (a line through a hub has several); the throats (platform tracks joining the
    // main line) stay as they are: the second track starts beyond them
    const chains = this.stretches(m.edges).map((c) => this.trimThroats(c)).sort((a, b) => b.length - a.length);
    yield;
    let built = 0, full = true, newLen = 0, signals = 0, crossovers = 0, err = '', why = '', plans = 0, fullParts = 0;
    const build = function* (self: AIController, pl: DoublePlan): Generator<void, boolean> {
      if (self.available() < pl.cost * 1.2 + 500_000 || !self.borrowFor(pl.cost)) { err = 'not enough money'; return false; }
      const res = yield* aiCommitDoubleTrack(g, pl, true, {}, (ids) => {
        const p = self.project;
        if (p) for (const id of ids) if (net.edges.get(id)?.owner === me && !p.edges.includes(id)) p.edges.push(id);
      });
      if (self.project?.kind === 'double') self.project.edges = [];
      if (res.error) { err = res.error; return false; }
      built++;
      newLen += res.edges.reduce((s2, id) => s2 + (net.edges.get(id)?.len ?? 0), 0);
      signals += res.signals; crossovers += res.crossovers;
      if (res.finishError) err = res.finishError;
      return true;
    };
    // a plan that could not be built: the piece where it failed is the trouble
    const unbuilt = (pl: DoublePlan): DoublePlan => {
      const at = /at (\d+) m/.exec(err);
      return { ...pl, ok: false, proposals: [], errors: at ? [err, `Piece at ${at[1]} m`] : [err] };
    };
    for (const chain of chains) {
      if (err === 'not enough money' || plans >= 16) { full = false; break; }
      // the whole stretch, either side
      const whole: DoublePlan[] = [];
      let whole1 = false;
      for (const side of [1, -1] as const) {
        const pl = yield* aiPlanDoubleTrack(g, chain, side, me);
        plans++;
        yield;
        // Pause after every plan, including failures, and after every build before trying another stretch.
        if (pl.ok) { whole1 = yield* build(this, pl); yield; if (whole1 || err === 'not enough money') break; whole.push(unbuilt(pl)); }
        else { why ||= pl.errors[0] ?? ''; whole.push(pl); }
      }
      if (whole1) { fullParts++; continue; }
      full = false;
      // else passing loops: the stretches clear of the trouble, on the side with less of it (the other side tried
      // for each stretch too); a stretch that fails is split again
      if (err !== 'not enough money' && whole.length === 2) {
        const clear = (pl: DoublePlan) => this.clearRuns(pl).reduce((s2, r) => s2 + r.length, 0);
        const order: (1 | -1)[] = clear(whole[0]) >= clear(whole[1]) ? [1, -1] : [-1, 1];
        const first = whole[order[0] === 1 ? 0 : 1];
        let queue = this.clearRuns(first);
        while (queue.length && plans < 16 && err !== 'not enough money') {
          const run = queue.shift()!;
          let done = false, failed: DoublePlan | null = null;
          for (const side of order) {
            const pl = yield* aiPlanDoubleTrack(g, run, side, me);
            plans++;
            yield;
            if (pl.ok) {
              done = yield* build(this, pl);
              yield;
              if (done) break;
              // built nothing: split where the new track could not be laid
              failed = unbuilt(pl);
              break;
            }
            if (side === order[0]) failed = pl;
          }
          yield;
          if (!done && failed) queue = [...this.clearRuns(failed), ...queue];
        }
      }
    }
    full = full && fullParts === chains.length;
    this.state.phase = phase;
    if (!built) {
      // short of money: try again in half a year
      if (err === 'not enough money') info.upgradeFailed = g.day - 540;
      this.note(`could not double ${l.name}: ${err || why}`);
      return;
    }
    info.upgradeFailed = undefined;
    if (full) info.double = true; else info.loops = (info.loops ?? 0) + built;
    // directional running with block signals takes more trains (each loop one more)
    info.maxVehicles = Math.max(info.maxVehicles, full ? (err ? 3 : 4) : Math.min(4, 2 + built));
    this.stats.doubled++;
    if (!full) this.stats.loops += built - fullParts;
    this.stats.trackDouble += newLen;
    this.stats.signals += signals;
    // the rest of the line (starters, junctions, the single-track stretches between the loops)
    signals += this.signalLine(l.id);
    g.postNews(full ? `${this.name} doubles ${l.name}.` : `${this.name} lays ${built > 1 ? built + ' passing loops' : 'a passing loop'} on ${l.name}.`, 'ai', (m.a.x + m.b.x) / 2, (m.a.z + m.b.z) / 2);
    this.note(`${full ? 'doubled' : `${built} passing loop${built > 1 ? 's' : ''} on`} ${l.name} (${Math.round(newLen)} u new track of ${Math.round(m.len)} u, ${signals} signals, ${crossovers} crossovers${err ? ', ' + err : ''})`);
  }

  /** A route's edges (in travel order) split into continuous stretches (between the stations it passes). */
  private stretches(edges: number[]): number[][] {
    const net = this.game.world.net;
    const out: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < edges.length; i++) {
      const e = net.edges.get(edges[i]), f = i > 0 ? net.edges.get(edges[i - 1]) : undefined;
      if (cur.length && (!e || !f || (e.a !== f.a && e.a !== f.b && e.b !== f.a && e.b !== f.b))) { out.push(cur); cur = []; }
      if (e) cur.push(e.id);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** A chain of edges (in order) without its throat pieces: up to the last junction within 30 units of each end. */
  private trimThroats(edges: number[]): number[] {
    const net = this.game.world.net;
    const deg = (e: NEdge, f: NEdge) => net.nodes.get(e.a === f.a || e.a === f.b ? e.a : e.b)?.edges.length ?? 0;
    let i = 0, j = edges.length - 1;
    for (let k = 0, u = 0; k + 1 < edges.length; k++) {
      const e = net.edges.get(edges[k]), f = net.edges.get(edges[k + 1]);
      if (!e || !f) break;
      u += e.len;
      if (u > 30) break;
      if (deg(e, f) >= 3) i = k + 1;
    }
    for (let k = edges.length - 1, u = 0; k - 1 >= i; k--) {
      const e = net.edges.get(edges[k]), f = net.edges.get(edges[k - 1]);
      if (!e || !f) break;
      u += e.len;
      if (u > 30) break;
      if (deg(e, f) >= 3) j = k - 1;
    }
    return j - i >= 1 ? edges.slice(i, j + 1) : edges;
  }

  /**
   * After a failed doubling plan, the stretches of its track (edge runs in chain order) clear of the trouble:
   * pieces that could not be planned, a branch on the new track's side, an end without room for the turnout,
   * a piece that could not be built; each long enough for a passing loop.
   */
  private clearRuns(pl: DoublePlan): number[][] {
    const net = this.game.world.net;
    const steps = pl.steps;
    if (steps.length < 1) return [];
    let u = 0;
    const span = steps.map((st) => { const len = net.edges.get(st.edge)?.len ?? 0; const r = { id: st.edge, len, u0: u, u1: u + len }; u += len; return r; });
    const U = u, bad: [number, number][] = [];
    const P = pl.points;
    pl.proposals.forEach((pr, k) => { if (!pr.ok && P[k] && P[k + 1]) bad.push([P[k].u, P[k + 1].u]); });
    for (const e of pl.errors) {
      const at = /(?:\(|at )(\d+) m/.exec(e);
      if (e.startsWith('No room for the turnout at the start')) bad.push([0, 28]);
      else if (e.startsWith('No room for the turnout at the end')) bad.push([U - 28, U]);
      else if (at && (e.startsWith('A branch') || e.startsWith('Piece at'))) { const x = Number(at[1]) / 10; bad.push([x - 3, x + 3]); }
    }
    if (!bad.length) return [];
    const out: number[][] = [];
    let cur: typeof span = [];
    const flush = () => {
      const len = cur.reduce((s2, x) => s2 + x.len, 0);
      // long enough for a loop that trains can pass in, and not the same stretch again
      if (len >= 40 && cur.length < steps.length) out.push(cur.map((x) => x.id));
      cur = [];
    };
    for (const sp of span) {
      if (bad.some(([a, b]) => sp.u0 < b + 1 && sp.u1 > a - 1)) { flush(); continue; }
      cur.push(sp);
    }
    flush();
    return out;
  }

  /**
   * Signals for a railway line we built or changed (signals.ts autoSignalLine, where there): block signals on
   * double track, path signals before junctions and stations, starters at the platforms, two-way signals at
   * passing loops. Returns the signals placed.
   */
  private signalLine(lineId: number): number {
    const auto = (Signals as unknown as { autoSignalLine?: (g: Game, line: number, owner: number, opts?: object) => unknown }).autoSignalLine;
    if (!auto) return 0;
    try {
      const r = auto(this.game, lineId, this.companyId) as { placed?: number } | null | undefined;
      const n = typeof r?.placed === 'number' ? r.placed : 0;
      this.stats.signals += n;
      return n;
    } catch (e) {
      this.note('signalling failed: ' + String((e as Error)?.message ?? e));
      return 0;
    }
  }

  /** Signals on our track. */
  private signalCount(): number {
    let n = 0;
    for (const nd of this.game.world.net.nodes.values()) if (nd.signal && nd.owner === this.companyId) n++;
    return n;
  }

  /** Bold, active companies buy struggling rivals (never the player). */
  private considerAcquisition() {
    const g = this.game, c = this.config, e = this.eco;
    if (!g.aiAcquisitions || this.job || c.activeness < 0.9 || c.risk < 0.45 || g.day < 720 || g.day - this.lastAcq < 720) return;
    if (!this.rng.chance(0.1 * c.activeness)) return;
    for (const co of g.companies) {
      if (!co.ai || co.defunct || co.id === this.companyId) continue;
      const ce = co.economy;
      const last2 = ce.yearTotals.slice(-2);
      const losing = last2.length === 2 && last2.every((y) => Object.values(y.v).reduce((a, b) => a + b, 0) < 0);
      if (!(ce.money < 0 || ce.loan >= ce.maxLoan * 0.95 || losing)) continue;
      const price = g.buyoutPrice(co.id);
      if (price > e.money - 1_500_000 || price > this.available() * 0.5) continue;
      const name = co.name;
      if (!g.buyCompany(this.companyId, co.id)) {
        this.lastAcq = g.day;
        this.stats.acquired++;
        this.note(`bought ${name}`);
        this.adoptLines();
        return;
      }
    }
  }

  // ---------------------------------------------------------------- save / load
  toJSON(): unknown {
    const tram = this.project?.kind === 'tram' && this.tram ? tramExt(this.tram).record?.() ?? null : null;
    return {
      companyId: this.companyId,
      config: this.config,
      state: {
        ...this.state, rng: this.rng.state, failed: [...this.failed], stats: this.stats, lines: [...this.lines],
        project: this.project, lastAcq: this.lastAcq, tram, relengthen: this.relengthen, stationCare: [...this.stationCare].sort((x, y) => x[0] - y[0]),
        accessCare: [...this.accessCare].sort((x, y) => x[0] - y[0]),
        ...(this.urbanSurvey ? { urbanSurvey: { ...this.urbanSurvey, sites: this.urbanSurvey.sites.map((p) => 'cost' in p
          ? { station: saveTaskStation(p) } : { site: { ...p, walk: { ...p.walk, buildings: [...p.walk.buildings] } } }) } } : {}),
        ...(this.urbanTask ? { urban: { ...this.urbanTask, got: this.urbanTask.got.map(saveTaskStation), plans: this.urbanTask.plans.map(saveTaskStation) }, splitPieces: [...this.splitPieces] } : {}),
        ...(this.accessTask ? { repair: { ...this.accessTask, ...(this.accessTask.road ? { road: saveTaskProposal(this.accessTask.road) } : {}), ...(this.accessTask.plan ? { plan: saveTaskStation(this.accessTask.plan) } : {}) } } : {}),
        rail: this.railPolicy.save(),
        ...this.mailPolicy.save(),
      },
    };
  }

  load(data: any) {
    if (data?.config) this.config = normalizeAIConfig(data.config);
    const s = data?.state;
    if (!s) return;
    this.state = { phase: s.phase ?? 'idle', cooldown: s.cooldown ?? 10, projects: s.projects ?? 0,
      urbanSearchCursor: Number.isSafeInteger(s.urbanSearchCursor) && s.urbanSearchCursor >= 0 ? s.urbanSearchCursor : this.companyId - 1 };
    if (Array.isArray(s.corridor) && s.corridor.length === 2) this.state.corridor = [s.corridor[0], s.corridor[1]];
    // a through service being planned resumes where it was (its cursor), as the running game goes on with it
    if (!s.project && s.through && typeof s.through.line === 'number') {
      this.state.through = { line: s.through.line, end: s.through.end, mode: s.through.mode === 'metro' ? 'metro' : 'lightrail', at: s.through.at ?? 0 };
      this.job = this.throughJob();
    }
    if (typeof s.rng === 'number') this.rng.state = s.rng;
    if (Array.isArray(s.failed)) this.failed = new Map(s.failed);
    if (s.stats) this.stats = { ...this.stats, ...s.stats };
    if (Array.isArray(s.lines)) this.lines = new Map(s.lines);
    if (s.project?.kind === 'double' && s.doubleJob && this.lines.has(s.doubleJob.line) && this.game.lines.get(s.doubleJob.line)) {
      this.state.doubleJob = { ...s.doubleJob, stops: [...s.doubleJob.stops], ...(s.doubleJob.legs ? { legs: s.doubleJob.legs.map(([a, b]: [number, number]) => [a, b] as [number, number]) } : {}), ...(s.doubleJob.finishFailed ? { finishFailed: [...s.doubleJob.finishFailed] } : {}) };
      this.project = { ...s.project, built: true, edges: [], stations: [], depots: [] };
      this.job = this.doubleGen(this.game.lines.get(s.doubleJob.line)!, this.lines.get(s.doubleJob.line)!);
    }
    this.railPolicy.load(s.rail);
    this.mailPolicy.load(s);
    if (typeof s.lastAcq === 'number') this.lastAcq = s.lastAcq;
    if (Array.isArray(s.stationCare)) this.stationCare = new Map(s.stationCare);
    if (Array.isArray(s.accessCare)) this.accessCare = new Map(s.accessCare);
    if (Array.isArray(s.relengthen)) this.relengthen = s.relengthen.map((q: [number, number, string[]]) => [q[0], q[1], [...q[2]]]);
    // Urban construction and access repair retain the exact next work unit, including partial works.
    if (s.project && (s.project.kind === 'metro' || s.project.kind === 'lightrail')) {
      this.project = { ...s.project, towns: s.project.towns ?? [], stations: s.project.stations ?? [], edges: s.project.edges ?? [], depots: s.project.depots ?? [] };
      if (s.urbanSurvey) this.urbanSurvey = { ...s.urbanSurvey, sites: s.urbanSurvey.sites.map((p: any) => p.station ? loadTaskStation(this.game, p.station)
        : { ...p.site, walk: { ...p.site.walk, buildings: new Map(p.site.walk.buildings) } }) };
      if (s.urban) this.urbanTask = { ...s.urban, got: s.urban.got.map((p: ReturnType<typeof saveTaskStation>) => loadTaskStation(this.game, p)), plans: s.urban.plans.map((p: ReturnType<typeof saveTaskStation>) => loadTaskStation(this.game, p)) };
      this.splitPieces = new Set(s.splitPieces ?? []);
      const T = this.game.towns.list[this.project!.towns[0]];
      this.job = this.urbanJob(T, this.project!.kind as 'metro' | 'lightrail');
    } else if (!s.project && s.repair) {
      this.accessTask = { ...s.repair, ...(s.repair.road ? { road: loadTaskProposal(s.repair.road) } : {}), ...(s.repair.plan ? { plan: loadTaskStation(this.game, s.repair.plan) } : {}) };
      this.job = this.accessRepairJob(s.repair.station);
    } else if (s.project && !this.state.doubleJob) {
      // Legacy project types still use their existing cleanup path.
      const p: Project = {
        kind: s.project.kind, towns: s.project.towns ?? [], stations: s.project.stations ?? [], edges: s.project.edges ?? [], depots: s.project.depots ?? [],
        line: s.project.line ?? -1, started: s.project.started ?? 0, access: s.project.access ?? -1, joint: s.project.joint,
      };
      try {
        if (p.kind === 'tram') { if (s.tram) TramPlanner.abandon(this.game, this.companyId, s.tram); }
        else this.abandon(p);
      } catch { /* ignore */ }
      this.state.phase = 'idle';
      this.state.cooldown = 5;
    }
  }
}

// keep type imports referenced
export type { Town, Station, StationPlan, NEdge };
