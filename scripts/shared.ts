// Shared networks: joining another company's track needs track access; the joined pieces stay the owner's,
// the new track is the builder's; without access tracks cross over or under, never at grade. Same for trams.
// npx esbuild scripts/shared.ts --bundle --platform=node --format=esm --outfile=$S/shared.mjs && node $S/shared.mjs
import { scenario } from './sectionlib';
import { sharedCivilRights } from './section-structurelib';
import { Game } from '../src/game/game';
import { planEdge, commitProposal, findSnap } from '../src/game/construction';
import { fails, check, free, railOpts, roadOpts } from './lib';

const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 1, aiConfigs: [{ risk: 0.9 }] });
g.aiEnabled = false;
// company 1 shares its network on request here (open access, the default, needs none: see access.ts / networks.ts)
g.setAccessPolicy(1, 'auto-approve');
const w = g.world, net = w.net;
for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
w.heightsVersion++;
for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
g.company(0).economy.money = 1e9;
g.company(1).economy.money = 1e9;

// company 1's railway, west - east
check(commitProposal(g, planEdge(g, free(g, 60, 100), free(g, 180, 100), railOpts(1))) === null, 'company 1 built a railway');
const theirs = [...net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === 1).map((e) => e.id);
// the player joins it from the south (a junction in the middle of their track)
const join = () => planEdge(g, free(g, 120, 160), findSnap(g, 'rail', 120, 100, 1), railOpts(0));
const p1 = join();
check(!p1.ok && p1.errors.some((e) => e.includes('needs track access')), `joining without access refused (${p1.errors.join(', ')})`);
// crossing it without access: over or under, no diamond
const cross = planEdge(g, free(g, 90, 60), free(g, 95, 140), railOpts(0));
check(cross.crossings.length > 0 && cross.crossings.every((c) => c.mode === 'over' || c.mode === 'under'), `crossing without access is grade-separated (${cross.crossings.map((c) => c.mode).join(', ')})`);
check(g.requestAccess(0, 1) === 'granted', 'access granted');
const p2 = join();
check(p2.ok, `joining with access (${p2.errors.join(', ')})`);
const e0 = net.nextEdge;
check(commitProposal(g, p2) === null, 'junction built');
const mine = [...net.edges.values()].filter((e) => e.id >= e0 && e.owner === 0);
const split = [...net.edges.values()].filter((e) => e.id >= e0 && e.owner === 1);
check(mine.length >= 1, `the new track is the player's (${mine.length} edge(s))`);
check(split.length === 2 && theirs.every((id) => !net.edges.has(id) || net.edges.get(id)!.owner === 1), `the split pieces stay company 1's (${split.length})`);
const jn = net.nearestNode(120, 100, 1, 'rail', (n) => n.edges.length === 3);
check(!!jn && jn.owner === 1, `the junction node is company 1's (${jn?.owner})`);
const cross2 = planEdge(g, free(g, 150, 60), free(g, 155, 140), railOpts(0, 1, { crossing: 'level' }));
check(cross2.ok && cross2.crossings.some((c) => c.mode === 'diamond'), `with access a diamond crossing at grade is allowed (${cross2.crossings.map((c) => c.mode).join(', ')})`);

// trams: company 1's tram road, the player's tram road joining it
check(commitProposal(g, planEdge(g, free(g, 40, 200), free(g, 120, 200), roadOpts(1, 'road', { tram: true }))) === null, 'company 1 built a tram road');
g.endAccess?.(0, 1);
const tj = () => planEdge(g, free(g, 80, 240), findSnap(g, 'road', 80, 200, 1), roadOpts(0, 'road', { tram: true }));
const t1 = tj();
check(!g.canUse(0, 1) ? !t1.ok && t1.errors.some((e) => e.includes('needs track access')) : t1.ok, `tram tracks: joining needs access (${t1.errors.join(', ')})`);
const road = planEdge(g, free(g, 70, 240), findSnap(g, 'road', 70, 200, 1), roadOpts(0));
check(road.ok, `a plain road may join their road (${road.errors.join(', ')})`);
scenario('accessible widening retains the infrastructure owner for rails and civil works',sharedCivilRights);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
