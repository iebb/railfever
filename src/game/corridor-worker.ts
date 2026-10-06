// Speculative coarse search cache. Replies can save CPU but never control the simulation's work clock.
import type { Game } from './game';
import { createCorridorKernel, type CorridorReply, type CorridorSnapshot } from './planning-corridor';

export interface CorridorWorkerStats {
  active: boolean; jobs: number; completed: number; pending: number; hits: number; fallback: number;
  computeMs: number; postMs: number;
}
interface Runtime {
  enabled: boolean;
  worker: Worker | null;
  unavailable: boolean;
  launched: boolean;
  nextId: number;
  terrainSent: string;
  jobs: Map<number, CorridorJob>;
  stats: CorridorWorkerStats;
}
export interface CorridorJob {
  readonly snapshot: CorridorSnapshot;
  readonly budget: number;
  index: number;
  reply: CorridorReply | null;
  kernel: ReturnType<typeof createCorridorKernel> | null;
  runtime: Runtime;
  id: number;
  cancelled: boolean;
}
const runtimes = new WeakMap<Game, Runtime>();
function runtime(g: Game): Runtime {
  let r = runtimes.get(g);
  if (!r) {
    r = { enabled: false, worker: null, unavailable: false, launched: false, nextId: 0, terrainSent: '', jobs: new Map(),
      stats: { active: false, jobs: 0, completed: 0, pending: 0, hits: 0, fallback: 0, computeMs: 0, postMs: 0 } };
    runtimes.set(g, r);
  }
  return r;
}

/** Embedded code, including every helper: the standalone file needs no worker URL or imports. */
export function corridorWorkerSource(): string {
  return `const kernelFactory = (${createCorridorKernel.toString()});
    let terrain = null;
    self.onmessage = ({data}) => {
      if (data.kind === 'terrain') { terrain = data; return; }
      if (data.kind !== 'run') return;
      try {
        if (!terrain || terrain.terrainId !== data.snapshot.terrainId) throw Error('Corridor terrain revision unavailable');
        const start = performance.now();
        const result = kernelFactory({...data.snapshot, h: terrain.h, lock: terrain.lock}).run(data.budget);
        self.postMessage({id: data.id, result, computeMs: performance.now() - start});
      } catch (e) { self.postMessage({id: data.id, error: String(e && e.message || e)}); }
    };`;
}
function disable(r: Runtime) {
  r.worker?.terminate(); r.worker = null; r.unavailable = true; r.terrainSent = '';
  r.stats.active = false; r.jobs.clear(); r.stats.pending = 0;
}
function getWorker(r: Runtime): Worker | null {
  if (!r.enabled || r.unavailable) return null;
  if (r.worker) return r.worker;
  if (typeof Worker === 'undefined') { r.unavailable = true; return null; }
  try {
    const url = URL.createObjectURL(new Blob([corridorWorkerSource()], { type: 'text/javascript' }));
    try { r.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    r.stats.active = true;
    r.worker.onmessage = (e: MessageEvent) => {
      if (!e.data.error) {
        r.stats.completed++;
        r.stats.computeMs += Number(e.data.computeMs) || 0;
      }
      const job = r.jobs.get(e.data.id); if (!job) return;
      r.jobs.delete(e.data.id); r.stats.pending = r.jobs.size;
      if (!e.data.error && !job.cancelled) job.reply = e.data.result;
    };
    r.worker.onerror = () => disable(r);
    return r.worker;
  } catch { disable(r); return null; }
}

export function enableCorridorWorker(g: Game) { runtime(g).enabled = true; }
export function disposeCorridorWorker(g: Game) {
  const r = runtimes.get(g); if (!r) return;
  disable(r); runtimes.delete(g);
}
/** Main-thread pacing may end a frame only after its complete committed tick. */
export function consumeCorridorWorkerLaunch(g: Game): boolean {
  const r = runtimes.get(g); if (!r?.launched) return false;
  r.launched = false; return true;
}
export function corridorWorkerStats(g: Game): Readonly<CorridorWorkerStats> { return runtime(g).stats; }

export function requestCorridor(g: Game, snapshot: CorridorSnapshot, budget: number): CorridorJob {
  const r = runtime(g), id = ++r.nextId;
  const job: CorridorJob = { snapshot, budget, index: 0, reply: null, kernel: null, runtime: r, id, cancelled: false };
  const worker = getWorker(r);
  // The cache is optional: bound queued speculation while many rivals start projects together.
  if (!worker || r.jobs.size >= 4) return job;
  const start = performance.now();
  try {
    if (r.terrainSent !== snapshot.terrainId) {
      // The copied revision belongs to main-thread fallback too; structured clone retains those buffers.
      worker.postMessage({ kind: 'terrain', terrainId: snapshot.terrainId, h: snapshot.h, lock: snapshot.lock });
      r.terrainSent = snapshot.terrainId;
    }
    const { h: _, lock: __, ...input } = snapshot;
    r.jobs.set(id, job); r.stats.pending = r.jobs.size;
    worker.postMessage({ kind: 'run', id, snapshot: input, budget });
    r.stats.jobs++; r.launched = true;
  } catch { disable(r); }
  r.stats.postMs += performance.now() - start;
  return job;
}

/** A late reply replaces only the matching next slice; every earlier fallback slice used the same frozen input. */
export function advanceCorridor(job: CorridorJob) {
  const index = job.index++, r = job.runtime;
  if (job.reply) {
    r.stats.hits++;
    const step = job.reply.steps[index];
    return { ...step, path: step.state === 'done' ? job.reply.path : null };
  }
  r.stats.fallback++;
  const kernel = job.kernel ??= createCorridorKernel(job.snapshot);
  const state = kernel.step(job.budget);
  return { state, expanded: kernel.expanded, path: state === 'done' ? kernel.path : null };
}
export function cancelCorridor(job: CorridorJob) {
  // A queued search may already be executing. Keep its slot until the reply, account its CPU, discard its cache.
  job.cancelled = true;
}
