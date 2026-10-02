// Old-save upgrades and autosave recovery. Bundle with esbuild, then run with node (no browser needed).
// Optional args: fixture directory, followed by individual *.json / *.json.gz names.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Game } from '../src/game/game';
import { World } from '../src/game/world';
import { Lines } from '../src/game/lines';
import { Towns } from '../src/game/towns';
import { Train } from '../src/game/train';
import { Network } from '../src/game/network';
import { DAY_SECONDS, DAYS_PER_MONTH } from '../src/game/constants';
import { migrateElectricTrains } from '../src/game/migrate';
import { canonicalizeLines } from '../src/game/patterns';
import { backupSlot, deserialize, listSlots, loadFromSlot, serialize, slotsReady } from '../src/game/save';
import { deleteSave, getSave, putSave, putSaveOnce } from '../src/game/storage';

// Fixtures are v2.2/v2.3 saves (*.json / *.json.gz, made with the old code); they are too large to keep in the
// repo, so pass their directory as the first argument (default: scripts/fixtures/saves).
const directory = process.argv[2] ?? 'scripts/fixtures/saves';
if (!existsSync(directory)) {
  console.log(`SKIPPED: fixture directory not found: ${directory} (pass a directory of v2.2/v2.3 saves as the first argument)`);
  process.exit(0);
}
const upgradeText = 'Lines used by electric trains were electrified when this save was upgraded';
const required = /^(s7y2005(?:-busy)?|aiw2000(?:-busy)?)\.json(?:\.gz)?$/;

function readSave(file: string): any {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
}

function health(g: Game): void {
  const finite = (x: number, label: string) => assert(Number.isFinite(x), `${label}: ${x}`);
  const p = { x: 0, y: 0, z: 0 };
  for (const v of [...g.vehicles.map.values(), ...g.vehicles.ambient]) {
    v.worldPos(p);
    for (const k of ['x', 'y', 'z'] as const) finite(p[k], `${v.name} position.${k}`);
    for (const k of ['speed', 'delivered', 'load', 'value', 'profitYear', 'incomeYear'] as const) finite((v as any)[k], `${v.name}.${k}`);
    for (const [k, value] of Object.entries(v)) if (typeof value === 'number') finite(value, `${v.name}.${k}`);
  }
  for (const c of g.companies) for (const [k, v] of Object.entries(c.economy)) {
    if (typeof v === 'number') finite(v, `${c.name}.${k}`);
    else if (v && typeof v === 'object') for (const [key, value] of Object.entries(v)) {
      if (typeof value === 'number') finite(value, `${c.name}.${k}.${key}`);
    }
  }
  for (const st of g.stations.map.values()) {
    finite(st.waitingTotal, `${st.name} waitingTotal`);
    for (const w of st.waiting.values()) {
      finite(w.count, `${st.name} waiting count`);
      finite(w.transfers ?? 0, `${st.name} transfers`);
    }
  }
  for (const t of g.towns.list) finite(t.pop, `${t.name} population`);
  for (const l of g.lines.map.values()) for (const k of ['passMonth', 'passLast', 'incomeYear', 'costYear'] as const) finite(l[k], `${l.name}.${k}`);
}

function roundTrip(g: Game): void {
  const d = serialize(g);
  assert.equal(d.opsVersion, 1, 'migrated saves carry the opsVersion marker');
  const json = JSON.stringify(d);
  const loaded = deserialize(JSON.parse(json));
  const next = JSON.stringify(serialize(loaded));
  if (next !== json) {
    let i = 0;
    while (i < json.length && json[i] === next[i]) i++;
    assert.fail(`round trip changed at ${i}: ${json.slice(i - 60, i + 120)} -> ${next.slice(i - 60, i + 120)}`);
  }
  assert.equal(JSON.stringify(loaded.news), JSON.stringify(g.news), 'upgrades and merge notices run only once');
  health(loaded);
}

function runFixture(file: string): void {
  const name = basename(file), strict = required.test(name);
  console.log(`Loading ${name}`);
  const d = readSave(file);
  const g = deserialize(d);
  health(g);
  const changed = d.net.edges.filter((e: any) => e.type === 'standard' && g.world.net.edges.get(e.id)?.type === 'electric');
  const notices = g.news.filter((n) => n.text.includes(upgradeText));
  if (!d.opsVersion) {
    assert.equal(new Set(notices.map((n) => n.text)).size, notices.length, 'one electrification notice per company');
    if (strict) {
      assert(changed.length > 0, `${name}: electric train routes were upgraded`);
      assert(g.world.dirtyObj.size > 0, 'upgraded wire chunks are dirty for rendering');
      assert(changed.length < d.net.edges.filter((e: any) => e.type === 'standard').length, 'unrelated track stays unelectrified');
      assert(notices.length > 0, 'electrification is announced');
    }
    for (const [from, to] of g.lines.redirect) {
      const old = d.lines.find((l: any) => l.id === from);
      if (!old || (d.linesRedirect ?? []).some(([id]: [number]) => id === from)) continue;
      assert.equal(g.lines.get(to.line)?.owner, old.owner, 'load-time merges preserve company ownership');
      assert(g.news.some((n) => n.text.startsWith(old.name + ' merged into ')), `merge of ${old.name} is announced`);
    }
  } else assert.equal(changed.length, 0, 'v2.4 saves do not run the old wire upgrade');
  roundTrip(g);

  const electric = g.vehicles.trains().filter((t) => t.rule.wire).map((t) => ({ id: t.id, delivered: t.delivered }));
  const deliveries = new Map<number, number>();
  const capture = () => {
    for (const v of g.vehicles.map.values()) deliveries.set(v.id, Math.max(deliveries.get(v.id) ?? 0, v.delivered));
    return [...deliveries.values()].reduce((a, n) => a + n, 0);
  };
  let before = capture();
  const since = new Map<number, number>(), longest = new Map<number, number>();
  const startDay = g.day;
  g.paused = false;
  g.speed = 1;
  for (let month = 1; month <= 4; month++) {
    let ticks = 0;
    while (g.day < startDay + month * DAYS_PER_MONTH) {
      g.update(0.25);
      const now = g.day + g.dayFrac;
      for (const t of g.vehicles.trains()) {
        if (t.state !== 'noroute') { since.delete(t.id); continue; }
        if (!since.has(t.id)) since.set(t.id, now);
        longest.set(t.id, Math.max(longest.get(t.id) ?? 0, now - since.get(t.id)!));
      }
      if (++ticks % (DAY_SECONDS * 4) === 0) health(g);
      assert(ticks < DAYS_PER_MONTH * DAY_SECONDS * 8, 'simulation keeps advancing');
    }
    const after = capture();
    assert(after > before, `${name}: deliveries increase in month ${month} (${before} -> ${after})`);
    console.log(`  month ${month}: deliveries +${after - before}, ${g.vehicles.trains().length} trains`);
    before = after;
    health(g);
  }
  if (strict) {
    for (const [id, days] of longest) assert(days < DAYS_PER_MONTH, `${name}: train ${id} stayed in noroute for ${days.toFixed(1)} days`);
    for (const t of electric) assert((deliveries.get(t.id) ?? 0) > t.delivered, `${name}: electric train ${t.id} keeps delivering`);
  }
  // Exact stability is checked immediately after migration above. During play, unfinished AI construction
  // is deliberately aborted on reload, so also check that a later save can be loaded and resumed safely.
  const resumed = deserialize(serialize(g));
  assert.equal(JSON.stringify(resumed.news), JSON.stringify(g.news.slice(-40)), 'a later load does not repeat migration notices');
  for (let i = 0; i < 16; i++) resumed.update(0.25);
  health(resumed);
  console.log(`PASS ${name}: ${changed.length} edges upgraded, ${notices.length} company notices`);
}

function focusedUpgrades(): void {
  const d = readSave(join(directory, 's7y2005.json'));
  // Loading an already marked save must retain the wire rule and its unelectrified track.
  const g = deserialize({ ...d, opsVersion: 1 });
  const money = g.companies.map((c) => c.economy.money);
  const before = new Map([...g.world.net.edges].map(([id, e]) => [id, e.type]));
  const electric = g.vehicles.trains().find((t) => t.rule.wire)!;
  assert(electric, 'fixture includes the v2.3 Velocity HS');
  migrateElectricTrains(g);
  assert.deepEqual(g.companies.map((c) => c.economy.money), money, 'wire migration is free');
  const changed = [...g.world.net.edges.values()].filter((e) => e.type !== before.get(e.id));
  assert(changed.length > 0, 'legacy electric train needs an upgrade');
  assert(changed.every((e) => e.kind === 'rail' && before.get(e.id) === 'standard' && e.type === 'electric'));
  assert.equal(g.world.net.edges.get(g.depots.get(electric.depotId)!.edge)?.type, 'electric', 'depot stub receives wire');
  const first = JSON.stringify(serialize(g));
  migrateElectricTrains(g);
  assert.equal(JSON.stringify(serialize(g)), first, 're-running the wire migration is idempotent');

  // A valid merge candidate from another company stays under that company's AI management on load.
  const grouped = deserialize(d);
  grouped.setAccessPolicy(0, 'open');
  const plain = serialize(grouped);
  const same = plain.lines.find((l: any) => l.kind === 'rail' && l.owner !== 0);
  assert(same, 'fixture includes an AI railway');
  const foreign = { ...same, id: plain.linesNextId++, owner: 0, name: 'Foreign duplicate', autoName: false, partners: 'open', vehicles: [], patterns: undefined };
  const own = { ...same, id: plain.linesNextId++, name: 'Same-owner duplicate', autoName: false, vehicles: [], patterns: undefined };
  plain.lines.push(foreign, own);
  const shared = deserialize(plain);
  assert(canonicalizeLines(shared, foreign.id).some((n) => n.from === same.id && n.into === foreign.id), 'default shared-line merging still permits this cross-company candidate');
  plain.opsVersion = undefined;
  const merged = deserialize(plain);
  assert(merged.lines.map.has(foreign.id), 'a cross-company duplicate is not silently merged');
  assert(!merged.lines.map.has(own.id), 'a same-company duplicate becomes a pattern');
  assert(merged.news.some((n) => n.text.startsWith('Same-owner duplicate merged into ')), 'one notice is posted for the merged line');
  console.log('PASS free/idempotent wire upgrades and same-owner merge notices');
}

function migrationIsolation(): void {
  const empty = serialize(new Game({ size: 64, seed: 1, towns: 0, hilliness: 'flat', water: 'low', startYear: 2005, aiCompanies: 0 }, new World(64)));
  empty.opsVersion = undefined;
  empty.ops = { wear: [null] }; // loadOps must warn, then continue restoring the world.
  const tidy = Towns.prototype.tidyBridgeEnds, rebuild = Lines.prototype.rebuild, ais = Game.prototype.restoreAIs;
  const warn = console.warn, warnings: string[] = [];
  let reachedAI = false;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  Towns.prototype.tidyBridgeEnds = () => { throw new Error('injected tidy failure'); };
  Lines.prototype.rebuild = () => { throw new Error('injected rebuild failure'); };
  Game.prototype.restoreAIs = () => { reachedAI = true; throw new Error('injected AI failure'); };
  try {
    const loaded = deserialize(empty);
    assert(loaded instanceof Game);
    assert(reachedAI, 'AI restoration is attempted after earlier migration failures');
    for (const step of ['loadOps', 'tidyBridgeEnds', 'rebuild', 'restoreAIs']) assert(warnings.some((w) => w.includes(step)), `${step} failure is warned about`);
  } finally {
    console.warn = warn;
    Towns.prototype.tidyBridgeEnds = tidy;
    Lines.prototype.rebuild = rebuild;
    Game.prototype.restoreAIs = ais;
  }
  const touch = Network.prototype.touchEdge, changed = Train.prototype.onLineChanged;
  const d = readSave(join(directory, 's7y2005.json'));
  warnings.length = 0;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  Network.prototype.touchEdge = () => { throw new Error('injected wire failure'); };
  Train.prototype.onLineChanged = () => { throw new Error('injected canonicalization failure'); };
  try {
    const loaded = deserialize(d);
    assert(loaded.ais.length > 0, 'AI restoration still follows failed electric upgrades');
    assert(warnings.some((w) => w.includes('electric train migration')), 'wire migration failure is isolated');
    // Force a rail-line merge so its onLineChanged step throws, independently of the wire upgrade.
    const copy = serialize(loaded);
    copy.opsVersion = undefined;
    const l = copy.lines.find((line: any) => line.kind === 'rail');
    copy.lines.push({ ...l, id: copy.linesNextId++, name: 'Failure duplicate', vehicles: [...l.vehicles] });
    deserialize(copy);
    assert(warnings.some((w) => w.includes('canonicalizeLines')), 'canonicalization failure is isolated');
  } finally {
    console.warn = warn;
    Network.prototype.touchEdge = touch;
    Train.prototype.onLineChanged = changed;
  }
  console.log('PASS post-load migration failure isolation');
}

async function autosaveBackups(): Promise<void> {
  await slotsReady;
  for (const slot of ['autosave', 'autosave-v2.3', 'autosave-failed', 'once-test']) await deleteSave(slot);
  const old = serialize(new Game({ size: 64, seed: 1, towns: 0, hilliness: 'flat', water: 'low', startYear: 2005, aiCompanies: 0 }, new World(64)));
  old.opsVersion = undefined;
  const bytes = new Uint8Array(gzipSync(JSON.stringify(old)));
  const meta = { slot: 'autosave', name: 'Autosave', saved: 123, date: '1 Jan 2005', money: 1234 };
  await putSave({ slot: 'autosave', data: bytes, meta });
  const loaded = await loadFromSlot('autosave');
  assert.equal(serialize(loaded).opsVersion, 1);
  const first = await getSave('autosave-v2.3');
  assert.deepEqual(first?.data, bytes, 'backup preserves the compressed v2.3 bytes exactly');
  assert.equal((first?.meta as any).saved, meta.saved, 'original timestamp is preserved');
  assert(listSlots().some((s) => s.slot === 'autosave-v2.3'), 'v2.3 backup appears as an ordinary load slot');
  assert.equal(serialize(await loadFromSlot('autosave-v2.3')).opsVersion, 1, 'the backup can be loaded as an ordinary slot');
  assert.deepEqual((await getSave('autosave'))?.data, bytes, 'loading does not overwrite the source autosave');
  const other = { ...old, day: 30 };
  await putSave({ slot: 'autosave', data: 'raw:' + JSON.stringify(other), meta });
  await loadFromSlot('autosave');
  assert.deepEqual(await getSave('autosave-v2.3'), first, 'later legacy loads never overwrite the first backup');
  assert.equal(listSlots().filter((s) => s.slot === 'autosave-v2.3').length, 1);
  await deleteSave('autosave-v2.3');
  await putSave({ slot: 'autosave', data: 'raw:' + JSON.stringify(serialize(loaded)), meta });
  await loadFromSlot('autosave');
  assert.equal(await getSave('autosave-v2.3'), null, 'v2.4 autosaves do not create legacy backups');
  for (const corrupt of ['raw:{broken', new Uint8Array([1, 2, 3]), 'raw:' + JSON.stringify({ ...old, version: 999 })]) {
    await putSave({ slot: 'autosave', data: corrupt, meta });
    await assert.rejects(loadFromSlot('autosave'));
    // The boot path awaits this raw copy before generating a replacement world.
    await backupSlot('autosave', 'autosave-failed', 'Autosave (failed to load)');
    assert.deepEqual((await getSave('autosave-failed'))?.data, corrupt, 'failed saves are copied without decoding');
    assert(listSlots().some((s) => s.slot === 'autosave-failed'), 'failed backup is visible in Load game');
  }
  const once = { slot: 'once-test', data: 'first', meta: {} };
  assert.deepEqual(await Promise.all([putSaveOnce(once), putSaveOnce({ ...once, data: 'second' })]), [true, false]);
  assert.equal((await getSave('once-test'))?.data, 'first', 'concurrent backup attempts retain the first record');
  console.log('PASS compressed/raw autosave backups, failed-load recovery, and slot listing');
}

const failures: string[] = [];
for (const [name, test] of [['focused upgrades', focusedUpgrades], ['failure isolation', migrationIsolation], ['autosave backups', autosaveBackups]] as const) {
  try { await test(); } catch (e) { failures.push(name); console.error(`FAIL ${name}`, e); }
}
const names = process.argv.length > 3 ? process.argv.slice(3) : [...new Set(readdirSync(directory).filter((n) => /\.json(?:\.gz)?$/.test(n)).map((n) => n.replace(/\.gz$/, '')))];
for (const name of names.sort()) {
  const file = join(directory, name);
  try {
    if (!name.endsWith('.gz') && existsSync(file + '.gz')) assert.deepEqual(readSave(file + '.gz'), readSave(file), `${name}: compressed and JSON fixtures agree`);
    runFixture(existsSync(file) ? file : file + '.gz');
  } catch (e) { failures.push(name); console.error(`FAIL ${name}`, e); }
}
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : `ALL PASSED: ${names.length} saves ran four months, migrations and backups verified`);
process.exitCode = failures.length ? 1 : 0;
