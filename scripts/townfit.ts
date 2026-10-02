// Towns and the terrain / railways (UPDATE 9e(e), 9g, 9i, 9k):
//  A. hilly growth: no town street ends on a bridge (after generation and a 10-year run), town streets bridge only
//     strictly inside, building lots are levelled (plinths), towns grow; the terrain still fits the network.
//  B. a railway through a town: the town keeps growing across it — level crossings on conventional track,
//     street bridges (or nothing) over high-speed track, never a level crossing on high-speed / metro track.
// npx esbuild scripts/townfit.ts --bundle --platform=node --format=esm --outfile=$S/townfit.mjs && node $S/townfit.mjs [seeds] [years]
import { Game } from '../src/game/game';
import { planEdge, commitProposal, levelCrossingAllowed } from '../src/game/construction';
import { BUILDING_TYPES } from '../src/game/towns';
import { terrainFit, fitLine, noteStations, Sites } from './terrainfit';
import { fails, check } from './lib';

const seeds = (process.argv[2] ?? '5,13').split(',').map(Number);
const YEARS = Number(process.argv[3] ?? 10);

/** Plinth of a building: its base above the lowest ground under its footprint. */
function plinths(g: Game, since = -1): { n: number; over: number; worst: number } {
  const w = g.world;
  let n = 0, over = 0, worst = 0;
  for (const b of w.buildings.values()) {
    if (b.townId < 0 || BUILDING_TYPES[b.type].rank >= 9 || b.built < since) continue;
    const fx = Math.sin(b.angle), fz = Math.cos(b.angle), rx = fz, rz = -fx;
    let mn = Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, 1], [0, -1]]) mn = Math.min(mn, w.heightAt(b.x + rx * (b.w / 2) * sx + fx * (b.d / 2) * sz, b.z + rz * (b.w / 2) * sx + fz * (b.d / 2) * sz));
    const p = b.y - mn;
    n++;
    if (p > 0.12) over++;
    worst = Math.max(worst, p);
  }
  return { n, over, worst };
}
/** Town street bridges: count, total length, and any not strictly inside their street (< 1 unit of ground at an end). */
function townBridges(g: Game): { n: number; len: number; atEnd: number } {
  const net = g.world.net;
  let n = 0, len = 0, atEnd = 0;
  for (const e of net.edges.values()) {
    if (e.kind !== 'road' || e.owner !== -1 || e.type !== 'street') continue;
    for (const q of e.sections) {
      if (q.type !== 'bridge') continue;
      n++; len += q.s1 - q.s0;
      const deadA = net.nodes.get(e.a)?.edges.length === 1, deadB = net.nodes.get(e.b)?.edges.length === 1;
      if ((deadA && q.s0 < 0.05) || (deadB && q.s1 > e.len - 0.05)) atEnd++;
    }
  }
  return { n, len, atEnd };
}

// ---------------------------------------------------------------- A. hilly growth
for (const seed of seeds) {
  const g = Game.create({ size: 512, seed, towns: 6, hilliness: 'hilly', water: 'medium', startYear: 1960, aiCompanies: 1 });
  const pop0 = g.towns.list.reduce((a, t) => a + t.pop, 0);
  const be0 = g.towns.bridgeEnds().length, tb0 = townBridges(g), pl0 = plinths(g);
  console.log(`seed ${seed}: generated: pop ${pop0}, ${be0} town dead ends on a bridge; town street bridges ${tb0.n} (${tb0.len.toFixed(0)} units, ${tb0.atEnd} at a dead end); plinths > 1.2 m: ${pl0.over}/${pl0.n} (worst ${(pl0.worst * 10).toFixed(1)} m)`);
  check(be0 === 0, `seed ${seed}: no generated town street ends on a bridge (${be0})`);
  check(pl0.over <= pl0.n * 0.05, `seed ${seed}: generated lots levelled: plinths over 1.2 m on at most 5 % of the buildings (${pl0.over}/${pl0.n})`);
  const day0 = g.day;
  g.speed = 8;
  const sites: Sites = new Map();
  for (let d = 0; d < YEARS * 360; d++) { g.update(0.25); if (d % 5 === 0) noteStations(g, sites); }
  const pop1 = g.towns.list.reduce((a, t) => a + t.pop, 0);
  const be1 = g.towns.bridgeEnds(), tb1 = townBridges(g), pl1 = plinths(g, day0 + 1);
  console.log(`  after ${YEARS} years: pop ${pop1} (${((pop1 / pop0 - 1) * 100).toFixed(0)} %), largest ${Math.max(...g.towns.list.map((t) => t.pop))}; ${be1.length} town dead ends on a bridge; town street bridges ${tb1.n} (${tb1.len.toFixed(0)} units, ${tb1.atEnd} at a dead end); new buildings with plinths > 1.2 m: ${pl1.over}/${pl1.n} (worst ${(pl1.worst * 10).toFixed(1)} m)`);
  for (const b of be1.slice(0, 3)) console.log(`      #${b.e.id} ${b.e.type} len ${b.e.len.toFixed(1)} sections ${JSON.stringify(b.e.sections)}`);
  check(be1.length === 0, `seed ${seed}: no town street ends on a bridge after ${YEARS} years (${be1.length})`);
  check(tb1.atEnd === 0, `seed ${seed}: town street bridges only inside streets (${tb1.atEnd})`);
  check(pop1 > pop0 * 1.1, `seed ${seed}: towns grew (${pop0} -> ${pop1})`);
  check(pl1.over <= Math.max(3, pl1.n * 0.05), `seed ${seed}: new lots levelled: plinths over 1.2 m on at most 5 % (${pl1.over}/${pl1.n})`);
  const fit = terrainFit(g, undefined, sites);
  console.log(`  terrain fit: ${fitLine(fit)}`);
  check(fit.covered === 0 && fit.floating <= fit.samples * 0.001, `seed ${seed}: the terrain fits the network after ${YEARS} years of growth (${fit.covered} covered, ${fit.floating} floating)`);
}

// ---------------------------------------------------------------- B. railways through a town
for (const type of ['standard', 'highspeed']) {
  const g = Game.create({ size: 256, seed: 3, towns: 1, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 0 });
  g.economy.money = 1e9;
  const town = g.towns.list[0], net = g.world.net;
  const a = town.grid!.angle;
  // a straight line past the centre (through the planned growth area), at the ground
  const ux = Math.sin(a + Math.PI / 2), uz = Math.cos(a + Math.PI / 2), off = 9;
  const cx = town.x + Math.sin(a) * off, cz = town.z + Math.cos(a) * off;
  // as far as the map allows, up to 60 each way
  const reach = (sg: number) => { let t = 0; while (t < 60 && g.world.inside(cx + ux * (t + 1) * sg, cz + uz * (t + 1) * sg, 10)) t++; return t * sg; };
  const ends = [reach(-1), reach(1)].map((t) => ({ kind: 'free' as const, x: cx + ux * t, z: cz + uz * t, y: 0 }));
  const p = planEdge(g, ends[0], ends[1], { kind: 'rail', type, tracks: 2, heightOffset: 0, crossing: 'auto', owner: 0, straight: true });
  if (!p.ok) { console.log(`  ${type}: cannot build the test line: ${p.errors.join(', ')}`); check(false, `${type}: test line built`); continue; }
  const e0 = net.nextEdge;
  check(commitProposal(g, p) === null, `${type}: test line built`);
  const rails = new Set<number>();
  for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.kind === 'rail') rails.add(id);
  const side = (x: number, z: number) => Math.sign((x - cx) * Math.sin(a) + (z - cz) * Math.cos(a));
  const count = () => {
    let far = 0, near = 0;
    for (const id of town.buildings) { const b = g.world.buildings.get(id); if (!b) continue; if (side(b.x, b.z) > 0) far++; else near++; }
    return { far, near };
  };
  const b0 = count(), crossings0 = net.crossings.size, pop0 = town.pop;
  g.speed = 8;
  for (let d = 0; d < 6 * 360; d++) g.update(0.25);
  const b1 = count();
  // the town's crossings of the line: level crossings, street bridges over it
  let level = 0, over = 0, levelHs = 0;
  for (const c of net.crossings.values()) {
    const e1 = net.edges.get(c.e1), e2 = net.edges.get(c.e2);
    if (!e1 || !e2 || c.kind !== 'level') continue;
    if (e2.owner === -1) level++;
    if (!levelCrossingAllowed(e1.type)) levelHs++;
  }
  const p1 = { x: 0, y: 0, z: 0 };
  for (const e of net.edges.values()) {
    if (e.kind !== 'road' || e.owner !== -1 || !e.sections.some((q) => q.type === 'bridge')) continue;
    for (const q of e.sections) {
      if (q.type !== 'bridge') continue;
      net.pointAt(e, (q.s0 + q.s1) / 2, p1);
      if (net.edgesNear(p1.x - 1, p1.z - 1, p1.x + 1, p1.z + 1).some((r) => r.kind === 'rail' && net.nearestEdge(p1.x, p1.z, 1.2, 'rail', (k) => k.id === r.id))) over++;
    }
  }
  console.log(`${type} line through ${town.name}: pop ${pop0} -> ${town.pop}; buildings beyond the line ${b0.far} -> ${b1.far}, this side ${b0.near} -> ${b1.near}; town level crossings ${level} (on high-speed / metro / light rail: ${levelHs}), street bridges over the line ${over}; crossings ${crossings0} -> ${net.crossings.size}`);
  check(levelHs === 0, `${type}: no level crossing on high-speed, metro or light-rail track (${levelHs})`);
  if (type === 'standard') check(level + over > 0 && b1.far > b0.far + 5, `${type}: the town grows across the line (level crossings ${level}, bridges ${over}, buildings beyond ${b0.far} -> ${b1.far})`);
  else check(b1.far > b0.far || over > 0 || b0.far === 0, `${type}: the town still grows beyond the line or bridges it (bridges ${over}, buildings beyond ${b0.far} -> ${b1.far})`);
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
