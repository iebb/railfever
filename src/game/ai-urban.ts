// Geometry alternatives for city rail. These are only search inputs: the ordinary walking forecast,
// station/link/depot plans, fleet and discounted capital gates decide whether anything is built.
import type { Game } from './game';
import type { Town } from './towns';
import { CATCHMENT_RADIUS, CITY_WALK_SCALE } from './stations';

export interface UrbanTrunk {
  x: number; z: number; angle: number; L: number; targets: number[]; towns: number[];
}

/** Through alignments containing this town and a real neighbouring centre. Plain saved numbers. */
export function urbanTrunks(g: Game, seed: Town, endGap: number, maxStops: number): UrbanTrunk[] {
  const nearby = g.towns.list.filter(t => t.pop > 0 && Math.hypot(t.x - seed.x, t.z - seed.z) <= 220)
    .sort((a, b) => Math.hypot(a.x - seed.x, a.z - seed.z) - Math.hypot(b.x - seed.x, b.z - seed.z) || a.id - b.id).slice(0, 8);
  const choices: (UrbanTrunk & { rank: number })[] = [], seen = new Set<string>();
  for (let i = 0; i < nearby.length; i++) for (let j = i + 1; j < nearby.length; j++) {
    const a = nearby[i], b = nearby[j], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 2 * endGap || L > 360) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    const centres = nearby.map(t => ({ t, along: (t.x - a.x) * ux + (t.z - a.z) * uz,
      side: Math.abs((t.x - a.x) * uz - (t.z - a.z) * ux) }))
      .filter(c => c.along >= -1e-6 && c.along <= L + 1e-6 && c.side <= Math.min(8, c.t.radius * .25))
      .sort((p, q) => p.along - q.along || p.t.id - q.t.id);
    if (centres.length < 2 || centres.length > maxStops || !centres.some(c => c.t === seed)) continue;
    if (centres.some((c, k) => k && c.along - centres[k - 1].along < endGap)) continue;
    let targets = centres.map(c => c.along);
    // Two centres can anchor a longer city railway too. Additional stops must reach occupied
    // neighbourhoods outside the centres' walking circles, rather than an empty intercity midpoint.
    if (centres.length === 2) {
      const reach = CATCHMENT_RADIUS.rail * CITY_WALK_SCALE, fresh = (along: number) => {
        const x = a.x + ux * along, z = a.z + uz * along, town = g.towns.nearest(x, z);
        if (!g.world.inside(x, z, 10) || !town || !centres.some(c => c.t === town) || Math.hypot(x-town.x,z-town.z)>town.radius) return 0;
        let pop = 0;
        for (const id of g.world.bgrid.query(x-reach,z-reach,x+reach,z+reach)) {
          const b = g.world.buildings.get(id);
          if (!b || b.pop <= 0 || Math.hypot(b.x-x,b.z-z)>reach
            || centres.some(c => Math.hypot(b.x-c.t.x,b.z-c.t.z)<=reach)) continue;
          pop += b.pop;
        }
        return pop;
      };
      const extra = [-endGap,endGap,L-endGap,L+endGap].map(along=>({along,pop:fresh(along)}))
        .filter(c=>c.pop>0 && targets.every(t=>Math.abs(t-c.along)>=endGap-1e-6))
        .sort((p,q)=>q.pop-p.pop || p.along-q.along);
      for (const c of extra) if (targets.length<maxStops && targets.every(t=>Math.abs(t-c.along)>=endGap-1e-6)) targets.push(c.along);
      if (targets.length<3) continue;
      targets.sort((p,q)=>p-q);
    }
    const key = centres.map(c => c.t.id).sort((p, q) => p - q).join(',')+':'+targets.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const span = targets[targets.length - 1] - targets[0], middle = (targets[0] + targets[targets.length - 1]) / 2;
    choices.push({ x: a.x + ux * middle, z: a.z + uz * middle, angle: Math.atan2(ux, uz), L: span,
      targets: targets.map(t => t - middle), towns: centres.map(c => c.t.id),
      // Bounded search orders native population per length only; no score or demand bonus reaches the decision.
      rank: centres.reduce((s, c) => s + c.t.pop, 0) / span });
  }
  return choices.sort((a, b) => b.rank - a.rank || a.L - b.L || a.towns[0] - b.towns[0])
    .slice(0, 4).map(({ rank, ...c }) => c);
}

/** A centre the existing terminus can reach without turning its continuation away from the trunk. */
export function onwardCentres(g: Game, x: number, z: number, ux: number, uz: number, towns: Set<number>, gap: number) {
  return g.towns.list.map(t => ({ town: t.id, along: (t.x - x) * ux + (t.z - z) * uz,
    side: Math.abs((t.x - x) * uz - (t.z - z) * ux), pop: t.pop, x: t.x, z: t.z }))
    .filter(c => !towns.has(c.town) && c.pop > 0 && c.along >= gap && c.along <= 220 && c.side <= 8)
    .sort((a, b) => a.along - b.along || a.town - b.town);
}
