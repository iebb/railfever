// Read-only mail demand for the map. Volumes are tonnes per game month; arcs combine both directions.
import type { Game } from './game';
import { DAYS_PER_MONTH, MAIL_UNIT_T } from './constants';
import { MAIL_TYPE_WEIGHT, mailEra, mailGenRate, townMailFactor } from './mail';

export interface MailTown {
  id: number; x: number; z: number; pop: number; radius: number;
  /** Potential outgoing mail and the estimated part carried by the current mail network (t/month). */
  potential: number; carried: number;
  /** Carried / potential, bounded to 0..1. */
  share: number;
  /** Accepting mail stations in the town. */
  stations: number;
}

export interface MailPair {
  /** Town ids, a < b; distance in world units. */
  a: number; b: number; dist: number;
  /** Mail in both directions, in t/month; carried is estimated from posting rates and routed weights. */
  potential: number; carried: number; share: number;
}

export interface MailView {
  towns: MailTown[]; pairs: MailPair[];
  maxPotential: number;
  /** Network-wide tonnes per month, counting each outgoing flow once. */
  potential: number; carried: number;
}

const cache = new WeakMap<Game, { key: string; view: MailView }>();

export function mailView(g: Game): MailView;
export function mailView(g: Game, enabled: true): MailView;
export function mailView(g: Game, enabled: boolean): MailView | null;
/**
 * Query only while the Mail layer is on. The disabled path touches no game data; unchanged versions return the
 * same object. Reads do not flush catchments, rebuild demand, create mail state or consume either random stream.
 */
export function mailView(g: Game, enabled = true): MailView | null {
  if (!enabled) return null;
  const key = `${g.day}:${g.year}:${g.lines.version}:${g.demand.version}:${g.networkVersion}:${g.stations.catchVersion}:${g.world.lotVersions.version}:${g.world.nextBuildingId}:${g.world.buildings.size}:${g.stations.map.size}:${g.towns.list.length}`;
  const c = cache.get(g);
  if (c?.key === key) return c.view;
  const view = computeView(g);
  cache.set(g, { key, view });
  return view;
}

function computeView(g: Game): MailView {
  const T = g.towns.list, { n, share } = g.mail.townShares();
  const month = DAYS_PER_MONTH * MAIL_UNIT_T;
  const base = mailGenRate() * mailEra(g.year) * 0.85 * month;
  const population = new Float64Array(n);
  // Extend the core's weighted catchment potential to every town building, including uncovered residents:
  // a town without any stations still has mail demand. No catchment work is scheduled by this view.
  for (const b of g.world.buildings.values()) {
    if (b.townId >= 0 && b.townId < n && b.pop > 0) population[b.townId] += b.pop * (MAIL_TYPE_WEIGHT[b.type] ?? 1);
  }
  const towns: MailTown[] = T.map((t) => ({
    id: t.id, x: t.x, z: t.z, pop: t.pop, radius: t.radius,
    potential: 0, carried: 0, share: 0, stations: 0,
  }));
  const potential = new Float64Array(n * n), carried = new Float64Array(n * n);
  for (const t of towns) {
    const rate = population[t.id] * base * townMailFactor(t.pop);
    for (let U = 0; U < n; U++) if (U !== t.id) potential[t.id * n + U] = rate * share[t.id * n + U];
  }
  // Only accepting origins post mail. Each destination weight names exactly one station per other town,
  // so transfers do not count again here. Every company's mail routes contribute, as in the passenger view.
  if (g.lines.mailActive) for (const st of g.stations.map.values()) {
    const town = towns[st.townId];
    if (!town || !g.mail.accepts(st)) continue;
    town.stations++;
    const dw = g.mail.weights(st);
    if (!(dw.served > 0)) continue;
    const rate = g.mail.rate(st) * month;
    for (let i = 0; i < dw.dest.length; i++) {
      const U = g.stations.get(dw.dest[i])?.townId ?? -1;
      if (U >= 0 && U < n && U !== st.townId) carried[st.townId * n + U] += rate * dw.w[i] / dw.served;
    }
  }
  // Fast services and high ratings can unlock more posting than the baseline potential. Bound each direction
  // separately before combining pairs, keeping the displayed share meaningful even with overlapping stations.
  let total = 0, transported = 0;
  for (const t of towns) for (let U = 0; U < n; U++) {
    const k = t.id * n + U;
    carried[k] = Math.max(0, Math.min(potential[k], carried[k]));
    t.potential += potential[k]; t.carried += carried[k];
    total += potential[k]; transported += carried[k];
  }
  for (const t of towns) t.share = t.potential > 0 ? t.carried / t.potential : 0;
  const pairs: MailPair[] = [];
  let maxPotential = 0;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const p = potential[a * n + b] + potential[b * n + a];
    if (!(p > 0)) continue;
    const c = carried[a * n + b] + carried[b * n + a];
    pairs.push({ a: T[a].id, b: T[b].id, dist: Math.hypot(T[a].x - T[b].x, T[a].z - T[b].z), potential: p, carried: c, share: c / p });
    maxPotential = Math.max(maxPotential, p);
  }
  pairs.sort((a, b) => b.potential - a.potential || a.a - b.a || a.b - b.b);
  return { towns, pairs, maxPotential, potential: total, carried: transported };
}
