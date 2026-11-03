// Read-only admission for a new stop on running rail. Never shorten or replace paid consists.
import type { Game } from './game';
import type { Line } from './lines';
import { linearStops, outAndBack } from './lines';
import type { OnTrackPlan, Step } from './trackops';
import type { Train } from './train';
import { consistRule, findRailRoute, platformDepartureFrontiers, trackAllows } from './train';
import { linePatterns, patternStops } from './patterns';
import { platformChoices } from './rail-platforms';
import { TRACK_TYPES } from './constants';

/** The same insertion and local-only rule as publication, with independently owned pattern arrays. */
export function infillCandidate(l: Line, x: number, y: number, station: number): Line | null {
  if (l.stops.includes(station)) return null;
  const path = linearStops(l.stops), list = path ?? l.stops;
  const at = list.findIndex((a, i) => i < (path ? list.length - 1 : list.length)
    && (a === x && list[(i + 1) % list.length] === y || a === y && list[(i + 1) % list.length] === x));
  if (at < 0) return null;
  const stops = [...list.slice(0, at + 1), station, ...list.slice(at + 1)];
  const candidate: Line = { ...l, stops: path ? outAndBack(stops) : stops,
    ...(l.patterns ? { patterns: l.patterns.map(p => ({ ...p, stops: [...p.stops], ...(p.ids ? { ids: [...p.ids] } : {}) })) } : {}) };
  linePatterns(candidate);
  if (candidate.patterns && candidate.patterns.length >= 2) for (const p of candidate.patterns) {
    if (p.kind !== 'local') candidate.stops.forEach((id, i) => { if (id === station) p.stops[i] = false; });
  }
  return candidate;
}

function fleet(g: Game, l: Line): Train[] {
  return l.vehicles.map(id => g.vehicles.get(id)).filter((t): t is Train => t?.kind === 'train');
}
function pattern(l: Line, t: Train): number {
  return l.patterns?.some(p => p.id === t.pattern) ? t.pattern! : l.patterns?.[0]?.id ?? 0;
}

/** Full native platform cells, owner access, arrival and onward departure for each operated pattern. */
export function infillCallsFit(g: Game, l: Line): boolean {
  const patterns = new Set(fleet(g, l).map(t => pattern(l, t)));
  return [...patterns].every(pid => patternStops(l, pid).every(i => platformChoices(g, l, pid, i).length > 0));
}

function interval(g: Game, steps: Step[], cut: [number, number]): Step[] | null {
  if (!(cut[0] >= 0 && cut[1] > cut[0])) return null;
  let at = 0, previous: number | undefined;
  const inside: Step[] = [];
  for (const step of steps) {
    const e = g.world.net.edges.get(step.edge);
    if (!e || e.kind !== 'rail' || ![1, -1].includes(step.dir)) return null;
    const a = step.dir > 0 ? e.a : e.b, b = step.dir > 0 ? e.b : e.a;
    if (previous !== undefined && a !== previous) return null;
    previous = b;
    if (at < cut[1] && at + e.len > cut[0]) inside.push(step);
    at += e.len;
  }
  return at + 1e-6 >= cut[1] && inside.length ? inside : null;
}
function includesInterval(route: { edge: { id: number }; dir: number }[], steps: Step[]): boolean {
  return [steps, [...steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }))].some(ordered =>
    route.some((_, i) => ordered.every((s, k) => route[i + k]?.edge.id === s.edge && route[i + k].dir === s.dir)));
}

/** Existing native train path through the exact plain interval that the station plan retains/reconnects. */
export type InfillRouteCache = Map<string, { edge: { id: number }; dir: number }[][]>;
function usesInterval(g: Game, from: number, to: number, t: Train, steps: Step[], cache?: InfillRouteCache): boolean {
  const st = g.stations.get(from), rule = consistRule(t.cars);
  if (!st?.rail || !g.canUse(t.owner, st.owner)) return false;
  const key = JSON.stringify([from, to, t.owner, t.length, rule.wire, rule.types && [...rule.types].sort()]);
  const known = cache?.get(key);
  if (known) return known.some(route => includesInterval(route, steps));
  const routes: { edge: { id: number }; dir: number }[][] = [];
  for (const group of g.stations.railTrackGroups(st)) {
    if (group.length + 1e-6 < t.length + .05 || group.steps.some(s => {
      const e = g.world.net.edges.get(s.edge); return !e || !g.canUse(t.owner, e.owner) || !trackAllows(t.cars, e);
    })) continue;
    for (const ordered of [group.steps, [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }))]) {
      const frontiers = platformDepartureFrontiers(g, ordered, t.owner, rule, t.length);
      for (const start of [frontiers.forward, frontiers.reverse]) {
        const r = findRailRoute(g, start, to, t.owner, -1, 15000, false, rule, true, { length: t.length });
        if (r) routes.push(r.conts);
      }
    }
  }
  cache?.set(key, routes);
  return routes.some(route => includesInterval(route, steps));
}

/** Conservative preflight; the actual built platform/onward proof still precedes every timetable edit. */
export function infillPlanFits(g: Game, plan: OnTrackPlan, candidate: Line, station: number, routes?: InfillRouteCache): boolean {
  const sp = plan.station;
  if (!plan.ok || !sp) return false;
  const tracks = plan.native ? plan.native.tracks.filter(t => !t.through) : plan.mains.filter((_, i) =>
    plan.feeds.some((main, j) => main === i && sp.layout.trackOffsets.includes(
      [...sp.layout.trackOffsets, ...sp.layout.throughOffsets].sort((a, b) => a - b)[plan.feedTrack[j]])));
  let stopping = false;
  for (const t of fleet(g, candidate)) {
    const calls = patternStops(candidate, pattern(candidate, t)), newCalls = calls.filter(i => candidate.stops[i] === station);
    if (!newCalls.length) continue; // A long express still passes without gaining a call.
    stopping = true;
    if (!g.canUse(t.owner, plan.owner) || sp.length + 1e-6 < t.length + .05) return false;
    const rule = consistRule(t.cars), type = sp.trackType;
    if (!plan.native && (rule.wire && !TRACK_TYPES[type]?.electrified || rule.types && !rule.types.has(TRACK_TYPES[type]?.id ?? type))) return false;
    for (const i of newCalls) {
      const k = calls.indexOf(i), from = candidate.stops[calls[(k + calls.length - 1) % calls.length]], to = candidate.stops[calls[(k + 1) % calls.length]];
      if (from === to || !tracks.some(track => {
        const steps = interval(g, track.steps, track.cut);
        return steps && (!plan.native || track.cut[1] - track.cut[0] + 1e-6 >= t.length + .05)
          && (!plan.native || steps.every(s => { const e = g.world.net.edges.get(s.edge)!; return g.canUse(t.owner, e.owner) && trackAllows(t.cars, e); }))
          && usesInterval(g, from, to, t, steps, routes);
      })) return false;
    }
  }
  return stopping;
}
