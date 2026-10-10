# Legacy save fixtures

`scripts/migrate.ts` loads the saves in `scripts/fixtures/saves/` with the current code. It checks the pre-v2.4 wire upgrade, line merges, round trips and four months of play. This file records how each save was made, so they can be rebuilt with the old code.

## Files

| File | Code | Command (see below) | Saved at | Contents |
|---|---|---|---|---|
| `s7y2005.json` | v2.3, `d494ca4` (`v2.3-ai-networks`) | `mk23.mjs 7 2005 18 s7y2005` | 1 Jul 2006 | 384 map, 10 towns, 3 AIs. Player Velocity HS (electric) on unelectrified track, reversed duplicate rail and bus lines, track access. 16 lines, 38 vehicles |
| `s7y2005-busy.json` | same run | same | 1 Nov 2005 | Same run, saved while an AI project was half-built |
| `aiw2000.json` | v2.3, `d494ca4` | `aiworld23.mjs 11 3 512 aiw2000 2000` | 1 Jan 2003 | 512 map, 14 towns, 5 AIs (rail, bus, tram). AI Velocity HS (Evergreen Train 37) on unelectrified track |
| `aiw2000-busy.json` | same run | same | 18 Jan 2002 | Same run, saved while two AI projects were half-built |
| `s7v22.json` | v2.2, `98c4d43` (`v2.2-trams-companies`) | `mk22.mjs 7 1985 18 s7v22` | 1 Jul 1986 | The `s7y2005` setup in the diesel era, written by v2.2 |
| `legacy-v2.6.json` … `legacy-v2.9.json` | tags `v2.6` … `v2.9` | `mkleg2N.mjs 7 2005 18 legacy-v2.N` | 1 Jul 2006 | The `s7y2005` setup with electrified player track. From v2.8 there is also a mail van and a postbus |

`migrate.ts` requires the first four. Their names match its `required` pattern, and it asserts the strict checks on them. Expected results: 21 wire edges upgraded for both `s7y2005` saves, 27 for both `aiw2000` saves, and 0 for the others.

Keep the saves as plain `.json`:
- `migrate.ts` reads `s7y2005.json` by name.
- For every `X.json.gz` it also reads `X.json` to compare the two, so a `.gz` on its own fails.
- Git deltas plain JSON well: the nine files pack to about 4 MB, against 10 MB as gzip.

The v2.2/v2.3 originals were made on 2026-10-03 during the v2.4 review and later lost with a temporary folder. The generators below are those scripts, verbatim apart from the worktree names. Rebuilt saves have the byte sizes recorded for the originals. All builds are deterministic; check them against these SHA-256 sums (Node 20):

```
e97c9fb7c5cd115305a891eea4ab3ea141b42d14727876e648b277c676840cd5  s7y2005.json
1ea799b8a9f8740dbb190447a1c966db1fbaf761c51d0a98b7db41a3d0314971  s7y2005-busy.json
6bcdd79f9361159422bc0e2a2ff116fd281c0386a9e89c8a439f72f3fe913a1a  aiw2000.json
36505420bc56d2beab6ec456d4f6ec74176efa8a48696c168941bdc230e69b47  aiw2000-busy.json
a945d67c89867fe544ef6d937983d6069d60be599ed25594920f7a0b1a671840  s7v22.json
73eff49d5a7be2455ae2d8e546ff7518aa24899a6badc38011c615f62229c8dd  legacy-v2.6.json
94bae1140280e01e6a12ccbe8353b7f7798c4a6310b374e8a086f4f8f652903c  legacy-v2.7.json
7e6eeb10a188d7ad26353248ea17ef3a6c94a2db99150eb496e7ec6ca2ecca78  legacy-v2.8.json
12792836d03f49fa0ebdb1b009a3567238921b8e7da781333baf4125e0a1592e  legacy-v2.9.json
```

## Rebuild

Run from the repo root. `../legacy-saves` can be any scratch directory outside the repo.

```sh
E="$PWD/node_modules/.bin/esbuild"
mkdir -p ../legacy-saves/gen ../legacy-saves/out
git worktree add --detach ../legacy-saves/wt-v22 98c4d43   # v2.2-trams-companies (same game code as 901cd85 on main)
git worktree add --detach ../legacy-saves/wt-v23 d494ca4   # v2.3-ai-networks
git worktree add --detach ../legacy-saves/wt-v26 v2.6
git worktree add --detach ../legacy-saves/wt-v27 v2.7
git worktree add --detach ../legacy-saves/wt-v28 v2.8
git worktree add --detach ../legacy-saves/wt-v29 v2.9
for w in wt-v22 wt-v23 wt-v26 wt-v27 wt-v28 wt-v29; do ln -s "$PWD/node_modules" ../legacy-saves/$w/node_modules; done
# save the three generators below into ../legacy-saves/gen/, then:
cd ../legacy-saves/gen
sed 's#wt-v23#wt-v22#g' mk23.ts > mk22.ts
for v in 26 27 28 29; do sed "s#wt-VER#wt-v$v#g" mkleg.ts > mkleg$v.ts; done
for n in mk22 mk23 aiworld23 mkleg26 mkleg27 mkleg28 mkleg29; do "$E" $n.ts --bundle --platform=node --format=esm --outfile=$n.mjs --log-level=warning; done
cd ../out
node ../gen/mk23.mjs 7 2005 18 s7y2005             # s7y2005.json, s7y2005-busy.json
node ../gen/aiworld23.mjs 11 3 512 aiw2000 2000    # aiw2000.json, aiw2000-busy.json
node ../gen/mk22.mjs 7 1985 18 s7v22               # s7v22.json (s7v22-busy.json is not kept)
for v in 6 7 8 9; do node ../gen/mkleg2$v.mjs 7 2005 18 legacy-v2.$v; done
shasum -a 256 *.json
```

Copy the nine `.json` files listed above to `scripts/fixtures/saves/`. The generators also write `.json.gz` copies; do not copy those. Remove the worktrees with `git worktree remove --force`.

Each run takes a few seconds. The other saves of the original review set can be rebuilt the same way, but are not kept:
- `s7y1980`: `mk23 7 1980 24`
- `s3y1900`: `mk23 3 1900 18`
- `aiw23`: `aiworld23 5 4 512 aiw23`
- `aiw1900`: `aiworld23 9 3 512 aiw1900 1900`
- `smoke23` and `tram23`: the end states of v2.3's `scripts/smoke.ts` and `scripts/tram.ts`, saved with `serialize`

## Check

From a checkout of the code under test:

```sh
"$E" scripts/migrate.ts --bundle --platform=node --format=esm --outfile=../legacy-saves/migrate.mjs
node ../legacy-saves/migrate.mjs scripts/fixtures/saves
```

## Generators

### `mk23.ts` (v2.3; `mk22.ts` is this file with `wt-v23` replaced by `wt-v22`)

```ts
// Build a v2.3 game with main's code (player rail + bus lines, duplicate lines for the 9k merge, AI companies),
// simulate, and write saves (JSON, as the browser's saveToSlot does before gzip).
// args: seed startYear months outPrefix [bullet]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Game } from '../wt-v23/src/game/game';
import { serialize } from '../wt-v23/src/game/save';
import { MODEL_BY_ID } from '../wt-v23/src/game/vehicle-types';
import { Train } from '../wt-v23/src/game/train';
import { connectStations, depotBehind, placeStationPair, busStopSites, addBusStop, roadDepotNear, checkNaN } from '../wt-v23/scripts/lib';

const seed = Number(process.argv[2] ?? 7);
const startYear = Number(process.argv[3] ?? 1980);
const months = Number(process.argv[4] ?? 24);
const out = process.argv[5] ?? 'save23';
const T0 = performance.now();
const g = Game.create({
  size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear, aiCompanies: 3,
  aiConfigs: [
    { activeness: 1.6, risk: 0.8, focus: { rail: 3, road: 1, tram: 0.5 } },
    { activeness: 1.4, risk: 0.6, focus: { rail: 1, road: 2, tram: 2 } },
    { activeness: 1.2, risk: 0.5, focus: { rail: 2, road: 1, tram: 1 } },
  ],
});
console.log(`gen ${(performance.now() - T0).toFixed(0)} ms, year ${g.year}`);
g.economy.money = 60_000_000;
const pr = placeStationPair(g, 60, 150, 0)!;
const con = connectStations(g, pr.A, pr.B, 0, 1, () => {});
const dep = depotBehind(g, pr.A, pr.B, 0);
console.log(`player rail: ${pr.A.name} - ${pr.B.name} connected=${con.ok} depot=${dep}`);
const line = g.lines.create('rail', 0);
line.stops = [pr.A.id, pr.B.id];
const loco = g.year >= 1998 ? 'bullet' : 'diesel_b';
const coach = g.year >= 1998 ? 'coach_hs' : 'coach_ic';
const t1 = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get(loco)!, MODEL_BY_ID.get(coach)!, MODEL_BY_ID.get(coach)!], line.id);
console.log(`  train 1 (${loco}):`, typeof t1 === 'string' ? t1 : t1.name);
// the same route the other way round as a second line (v2.4 merges it as a service pattern of the first)
const line2 = g.lines.create('rail', 0);
line2.stops = [pr.B.id, pr.A.id];
const t2 = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!], line2.id);
console.log('  train 2 (duplicate line):', typeof t2 === 'string' ? t2 : t2.name);
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 12, 30);
if (sites.length === 2) {
  const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
  const bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  for (let i = 0; i < 2; i++) { const r = g.vehicles.buyRoad(bd, MODEL_BY_ID.get(g.year >= 1985 ? 'bus_c' : 'bus_b')!, bl.id); console.log('  bus:', typeof r === 'string' ? r : r.name); }
  const bl2 = g.lines.create('road', 0);
  bl2.stops = [s1, s0];
  const r2 = g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_b')!, bl2.id);
  console.log('  bus (duplicate line):', typeof r2 === 'string' ? r2 : r2.name);
} else console.log('  no bus stop sites');
// company state as in scripts/save.ts
console.log('  access:', g.requestAccess(0, g.ais[1].companyId));
g.lines.rename(line.id, 'Main Line');

const sum = (x: Game) => {
  const vs = [...x.vehicles.map.values()];
  const trains = vs.filter((v) => v instanceof Train).length;
  return `${x.dateString()} lines ${x.lines.map.size} vehicles ${vs.length} (trains ${trains}) stations ${x.stations.map.size} money ${x.companies.map((c) => (c.economy.money / 1e6).toFixed(1)).join('/')} delivered ${vs.reduce((a, v) => a + v.delivered, 0)} busy ${x.ais.map((a) => (a.busy ? 1 : 0)).join('')}`;
};
const write = (name: string) => {
  const json = JSON.stringify(serialize(g));
  writeFileSync(`${name}.json`, json);
  writeFileSync(`${name}.json.gz`, gzipSync(json));
  console.log(`  wrote ${name}.json (${(json.length / 1e6).toFixed(2)} MB) at ${sum(g)}`);
};
const day0 = g.day;
let savedBusy = false;
const t = performance.now();
for (let m = 1; m <= months; m++) {
  while (g.day < day0 + m * 30) g.update(0.25);
  if (m % 3 === 0) console.log(`${sum(g)} [${((performance.now() - t) / 1000).toFixed(0)} s]`);
  // a save taken while an AI project is half-built (the browser autosaves every minute, whatever the AIs do)
  if (!savedBusy && m >= Math.floor(months / 2) && g.ais.some((a) => a.busy)) { write(out + '-busy'); savedBusy = true; }
}
const nan = checkNaN(g);
console.log('NaN check (v2.3):', nan ?? 'ok');
write(out);
```

### `aiworld23.ts` (v2.3)

```ts
// A v2.3 world with five AI companies of mixed focus (rail, buses, trams) run for N years, saved at the end and
// once mid-run while an AI project is half-built. args: seed years size out
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Game } from '../wt-v23/src/game/game';
import { serialize } from '../wt-v23/src/game/save';
import { Train } from '../wt-v23/src/game/train';
const seed = Number(process.argv[2] ?? 5), years = Number(process.argv[3] ?? 4), size = Number(process.argv[4] ?? 512), out = process.argv[5] ?? 'aiw23';
const towns = Math.round(size / 36);
const g = Game.create({ size, seed, towns, hilliness: 'hilly', water: 'medium', startYear: Number(process.argv[6] ?? 1985), aiConfigs: [
  { focus: { rail: 2.5, road: 0.8, tram: 0.5 } }, { focus: { rail: 0.5, road: 1, tram: 3 }, activeness: 1.6 }, { focus: { rail: 1.5, road: 1.5, tram: 1.5 } },
  { focus: { rail: 3, road: 0.3, tram: 0.3 }, activeness: 1.8, risk: 0.9 }, { focus: { rail: 1, road: 2, tram: 2 } },
] });
const write = (name: string) => { const j = JSON.stringify(serialize(g)); writeFileSync(name + '.json', j); writeFileSync(name + '.json.gz', gzipSync(j)); };
const sum = () => { const vs = [...g.vehicles.map.values()]; const kinds: Record<string, number> = {}; for (const l of g.lines.map.values()) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1; return `${g.dateString()} lines ${JSON.stringify(kinds)} vehicles ${vs.length} trains ${vs.filter((v) => v instanceof Train).length} stations ${g.stations.map.size} edges ${g.world.net.edges.size} busy ${g.ais.map((a) => (a.busy ? 1 : 0)).join('')}`; };
const t0 = performance.now();
let busySaved = false;
while (g.day < years * 360) {
  g.update(0.25);
  if (g.day % 90 === 0 && g.dayFrac < 0.13) console.log(`${sum()} [${((performance.now() - t0) / 1000).toFixed(0)} s]`);
  if (!busySaved && g.day > years * 180 && g.ais.filter((a) => a.busy).length >= 2) { write(out + '-busy'); busySaved = true; console.log('  busy save at ' + sum()); }
}
write(out);
console.log('final ' + sum());
```

### `mkleg.ts` (v2.6+; `wt-VER` is replaced by `wt-v26` … `wt-v29`)

```ts
// The v2.3 generator (mk23.ts) adapted for v2.4+ code: a newer release's save with the same content. The player's
// track is electrified before the Velocity HS is bought (v2.4+ trains need wire); from v2.8 a mail van and a postbus
// carry mail. Only the final save is written.
// args: seed startYear months out
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Game } from '../wt-VER/src/game/game';
import { serialize } from '../wt-VER/src/game/save';
import { MODEL_BY_ID } from '../wt-VER/src/game/vehicle-types';
import { Train } from '../wt-VER/src/game/train';
import { connectStations, depotBehind, placeStationPair, busStopSites, addBusStop, roadDepotNear, checkNaN } from '../wt-VER/scripts/lib';
import { electrify } from '../wt-VER/src/game/build-ops';
import { GAME_VERSION } from '../wt-VER/src/game/version';

const seed = Number(process.argv[2] ?? 7);
const startYear = Number(process.argv[3] ?? 2005);
const months = Number(process.argv[4] ?? 18);
const out = process.argv[5] ?? 'legacy';
console.log(`Railfever v${GAME_VERSION}`);
const T0 = performance.now();
const g = Game.create({
  size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear, aiCompanies: 3,
  aiConfigs: [
    { activeness: 1.6, risk: 0.8, focus: { rail: 3, road: 1, tram: 0.5 } },
    { activeness: 1.4, risk: 0.6, focus: { rail: 1, road: 2, tram: 2 } },
    { activeness: 1.2, risk: 0.5, focus: { rail: 2, road: 1, tram: 1 } },
  ],
});
console.log(`gen ${(performance.now() - T0).toFixed(0)} ms, year ${g.year}`);
g.economy.money = 60_000_000;
const pr = placeStationPair(g, 60, 150, 0)!;
const con = connectStations(g, pr.A, pr.B, 0, 1, () => {});
const dep = depotBehind(g, pr.A, pr.B, 0);
console.log(`player rail: ${pr.A.name} - ${pr.B.name} connected=${con.ok} depot=${dep}`);
const loco = g.year >= 1998 ? 'bullet' : 'diesel_b';
if (MODEL_BY_ID.get(loco)!.traction === 'electric') {
  const ids = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === 0 && e.type === 'standard').map((e) => e.id);
  console.log('  electrify:', JSON.stringify(electrify(g, ids, 0)));
}
const line = g.lines.create('rail', 0);
line.stops = [pr.A.id, pr.B.id];
const coach = g.year >= 1998 ? 'coach_hs' : 'coach_ic';
const t1 = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get(loco)!, MODEL_BY_ID.get(coach)!, MODEL_BY_ID.get(coach)!], line.id);
console.log(`  train 1 (${loco}):`, typeof t1 === 'string' ? t1 : t1.name);
// the same route the other way round as a second line (v2.4 merges it as a service pattern of the first)
const line2 = g.lines.create('rail', 0);
line2.stops = [pr.B.id, pr.A.id];
// v2.8+: mail rides along (an InterCity mail van on the second train, a postbus on the bus line)
const van = MODEL_BY_ID.get('van_ic'), postbus = MODEL_BY_ID.get('postbus_b');
const t2 = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, ...(van ? [van] : []), MODEL_BY_ID.get('coach_ic')!], line2.id);
console.log('  train 2 (duplicate line):', typeof t2 === 'string' ? t2 : t2.name);
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 12, 30);
if (sites.length === 2) {
  const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
  const bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  for (let i = 0; i < 2; i++) { const r = g.vehicles.buyRoad(bd, MODEL_BY_ID.get(g.year >= 1985 ? 'bus_c' : 'bus_b')!, bl.id); console.log('  bus:', typeof r === 'string' ? r : r.name); }
  if (postbus) { const r = g.vehicles.buyRoad(bd, postbus, bl.id); console.log('  postbus:', typeof r === 'string' ? r : r.name); }
  const bl2 = g.lines.create('road', 0);
  bl2.stops = [s1, s0];
  const r2 = g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_b')!, bl2.id);
  console.log('  bus (duplicate line):', typeof r2 === 'string' ? r2 : r2.name);
} else console.log('  no bus stop sites');
// company state as in scripts/save.ts
console.log('  access:', g.requestAccess(0, g.ais[1].companyId));
g.lines.rename(line.id, 'Main Line');

const sum = (x: Game) => {
  const vs = [...x.vehicles.map.values()];
  const trains = vs.filter((v) => v instanceof Train).length;
  return `${x.dateString()} lines ${x.lines.map.size} vehicles ${vs.length} (trains ${trains}) stations ${x.stations.map.size} money ${x.companies.map((c) => (c.economy.money / 1e6).toFixed(1)).join('/')} delivered ${vs.reduce((a, v) => a + v.delivered, 0)} busy ${x.ais.map((a) => (a.busy ? 1 : 0)).join('')}`;
};
const write = (name: string) => {
  const json = JSON.stringify(serialize(g));
  writeFileSync(`${name}.json`, json);
  writeFileSync(`${name}.json.gz`, gzipSync(json));
  console.log(`  wrote ${name}.json (${(json.length / 1e6).toFixed(2)} MB) at ${sum(g)}`);
};
const day0 = g.day;
const t = performance.now();
for (let m = 1; m <= months; m++) {
  // stepTick, not update(): update() drops ticks after a 20 ms wall-clock budget, so the save point would vary
  while (g.day < day0 + m * 30) g.stepTick();
  if (m % 3 === 0) console.log(`${sum(g)} [${((performance.now() - t) / 1000).toFixed(0)} s]`);
}
const nan = checkNaN(g);
console.log(`NaN check (v${GAME_VERSION}):`, nan ?? 'ok');
write(out);
```
