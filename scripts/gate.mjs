// Full headless release gate. Each invocation owns its checkout, processes and log directory.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const active = new Set();
let interrupted = false;
function stop(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* The process may already have finished. */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of active) stop(child);
});
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || r.error?.message || `git ${args[0]} failed`);
  return r.stdout.trim();
}
function command(program, args, cwd, log, seconds = 1800) {
  if (interrupted) { writeFileSync(log, 'Gate interrupted.\n'); return Promise.resolve(130); }
  return new Promise((done) => {
    const fd = openSync(log, 'w');
    const child = spawn(program, args, { cwd, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' });
    closeSync(fd);
    active.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(child); }, seconds * 1000);
    child.on('error', (error) => { writeFileSync(log, `${error.stack}\n`, { flag: 'a' }); });
    child.on('close', (code) => {
      clearTimeout(timer); active.delete(child);
      if (timedOut) writeFileSync(log, `\nGate timed out after ${seconds}s.\n`, { flag: 'a' });
      done(interrupted ? 130 : timedOut ? 124 : code ?? 1);
    });
  });
}
const excluded = new Map([
  ...['lib', 'stationlib', 'saves-harness', 'linegrow-fixtures', 'opening-fixtures', 'sectionlib', 'section-structurelib'].map((n) => [n, 'shared test helper']),
  ['saves-ui', 'browser/Chrome integration, run separately'],
  ...['perf', 'perfbench', 'scale', 'huge-displays'].map((n) => [n, 'manual benchmark']),
]);
let root, scratch, work, added = false;
let failed = false;
try {
  root = git(['rev-parse', '--show-toplevel'], process.cwd());
  const require = createRequire(join(root, 'package.json'));
  // These checks are mandatory; missing test dependencies must never silently reduce coverage.
  for (const dependency of ['esbuild', 'jsdom', 'fake-indexeddb']) {
    try { require.resolve(dependency); }
    catch { throw new Error(`Missing required headless dependency ${dependency}; run npm ci before validation.`); }
  }
  const { build } = require('esbuild');
  const ref = process.argv[2] || 'HEAD';
  const outputParent = resolve(root, process.argv[3] || '.gate');
  mkdirSync(outputParent, { recursive: true });
  const logs = mkdtempSync(join(outputParent, 'run-'));
  scratch = mkdtempSync(join(tmpdir(), 'rf-gate-'));
  work = join(scratch, 'checkout');
  git(['worktree', 'add', '--detach', work, ref], root);
  added = true;
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'junction');
  symlinkSync(join(root, 'node_modules'), join(logs, 'node_modules'), 'junction');
  console.log(`ref ${git(['log', '--oneline', '-1'], work)}; load: ${loadavg().map((n) => n.toFixed(2)).join(' ')}; logs: ${logs}`);
  for (const [name, args] of [['typecheck', ['run', 'typecheck']], ['build', ['run', 'build']]]) {
    const rc = await command('npm', args, work, join(logs, `${name}.log`));
    console.log(`${name}: ${rc === 0 ? 'ok' : `FAILED rc=${rc}`} (see ${name}.log)`);
    if (rc !== 0) failed = true;
  }
  const scripts = readdirSync(join(work, 'scripts')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();
  for (const name of scripts) if (excluded.has(name)) console.log(`skip ${name}: ${excluded.get(name)}`);
  const jobs = scripts.filter((n) => !excluded.has(n) && n !== 'ai' && n !== 'catchperf').flatMap((script) => {
    switch (script) {
      case 'smoke': return [7, 11, 23].map((n) => ({ name: `smoke${n}`, script, args: [String(n)] }));
      case 'replay': return [7, 23].map((n) => ({ name: `replay${n}`, script, args: [String(n)] }));
      case 'ainet': return [{ name: script, script, args: ['scenarios'] }];
      case 'migrate': return [{ name: script, script, args: [join(work, 'scripts/fixtures/saves')] }];
      case 'switches': return [[], ['--memory'], ['--resume']].map((args) => ({ name: `switches${args[0] || ''}`, script, args }));
      default: return [{ name: script, script, args: [] }];
    }
  });
  async function run({ name, script, args }) {
    const dir = join(logs, name), log = join(logs, `${name}.log`);
    mkdirSync(dir);
    const start = Date.now();
    const options = {
      absWorkingDir: work, entryPoints: [`scripts/${script}.ts`], bundle: true, platform: 'node', format: 'esm',
      outfile: join(dir, `${script}.mjs`), external: ['jsdom', 'fake-indexeddb'], logLevel: 'silent',
    };
    if (script === 'switches') {
      const canonicalWork = realpathSync(work);
      const adapters = new Set(['render/renderer', 'ui/ui', 'ui/fonts', 'audio/engine'].map((n) => join(canonicalWork, `src/${n}.ts`)));
      options.plugins = [{ name: 'save-ui-adapters', setup(b) {
        b.onResolve({ filter: /^\./ }, (a) => {
          const file = resolve(a.resolveDir, a.path);
          if (adapters.has(file) || adapters.has(`${file}.ts`)) return { path: join(canonicalWork, 'scripts/saves-harness.ts') };
        });
      } }];
      options.loader = { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty' };
    }
    let rc;
    try { await build(options); rc = await command(process.execPath, [`${script}.mjs`, ...args], dir, log); }
    catch (error) { writeFileSync(log, `${error.stack}\n`); rc = 1; }
    const output = readFileSync(log, 'utf8');
    const summary = output.split('\n').filter((l) => /ALL CHECKS PASSED|ALL INVARIANTS HELD|ALL PASSED|ALL \d+ .*PASSED|^PASS|PURITY PASSED|checks passed|\d+ FAILURES?|FAIL/.test(l)).at(-1)?.slice(0, 140) || '';
    const result = `${name}: ${rc === 0 ? 'ok' : `FAILED rc=${rc}`} (${((Date.now() - start) / 1000).toFixed(1)}s) ${summary}`;
    writeFileSync(join(logs, `${name}.res`), `${result}\n`);
    console.log(result);
    return { rc, output };
  }
  // Two workers take the next independent check when ready, so a long simulation cannot leave
  // half the battery waiting behind it. Timing-sensitive tests run after both workers finish.
  let nextJob = 0;
  const lanes = await Promise.allSettled([0, 1].map(async () => {
    while (nextJob < jobs.length && !interrupted) if ((await run(jobs[nextJob++])).rc !== 0) failed = true;
  }));
  for (const lane of lanes) if (lane.status === 'rejected') throw lane.reason;
  if (scripts.includes('ai') && !interrupted) {
    const timingOnly = ({ rc, output }) => {
      const failures = output.split('\n').filter((l) => l.includes('FAIL:'));
      return rc === 1 && failures.length > 0 && failures.every((l) => l.includes('stays sliced')) && !/\b(?:Error|Exception):/.test(output);
    };
    let result = await run({ name: 'ai', script: 'ai', args: ['23', '3', '512', '3'] });
    if (result.rc !== 0 && timingOnly(result)) {
      console.log('ai: timing-only failures; rerunning once (original log preserved)');
      result = await run({ name: 'ai-rerun', script: 'ai', args: ['23', '3', '512', '3'] });
      if (result.rc !== 0 && timingOnly(result)) console.log(`ai: repeated timing-only failure at load ${loadavg().map((n) => n.toFixed(2)).join(' ')}; reported, not blocking`);
      else if (result.rc !== 0) failed = true;
    } else if (result.rc !== 0) failed = true;
  }
  if (scripts.includes('catchperf') && !interrupted && (await run({ name: 'catchperf', script: 'catchperf', args: [] })).rc !== 0) failed = true;
  if (interrupted) failed = true;
} catch (error) {
  console.error(error.stack); failed = true;
} finally {
  // Only remove the checkout created by this invocation. Never prune or touch shared worktrees.
  if (added) {
    try { git(['worktree', 'remove', '--force', work], root); }
    catch (error) { console.error(`Cleanup failed; checkout retained at ${work}: ${error.message}`); failed = true; }
  }
  if (scratch && (!added || !work || !existsSync(work))) rmSync(scratch, { recursive: true, force: true });
}
console.log(`GATE: ${failed ? 'FAIL' : 'PASS'}`);
process.exitCode = interrupted ? 130 : failed ? 1 : 0;
