// Browser frame benchmark, companion of scripts/perfbench.ts. Works with any build exposing window.__rf = {game, renderer, ui}.
// Serve this file next to the built railfever.html, open the game with ?new&nointro&seed=N&size=N, mute it, then in the console:
//   const b = await import('/perfbench-browser.js');
//   await b.importSave('/save.json');  // optional: a JSON save written by `perfbench.mjs ... --save=save.json`
//   await b.live(8, 600);              // the real pacing path at 8x: main-thread ms per frame (p95/p99/max, frames > 50 ms)
//   await b.views();                   // renderer.frame CPU and CPU+GPU (readPixels sync) at five camera views, draw calls, triangles
//   await b.zoomPlay(8);               // simulation and frame CPU at three zooms (viewport culling at work)
//   await b.windows(); await b.drag(); await b.save(); b.memory();
// A hidden browser tab runs requestAnimationFrame rarely or never; these functions drive ticks and frames themselves.
const now = () => performance.now();
const rf = () => window.__rf;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const r1 = (x) => Math.round(x * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = new Uint8Array(4);
function sync() { const gl = rf().renderer.renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); }

let origUpdate = null;
/** Stop the page's own loop from advancing the simulation; this module drives ticks itself. */
export function hold() {
  const g = rf().game;
  if (!origUpdate) { origUpdate = g.update; g.update = () => {}; }
}
export function release() { const g = rf().game; if (origUpdate) { g.update = origUpdate; origUpdate = null; } }

export function snap(x, z, d, pitch = 0.8, yaw) {
  const c = rf().renderer.controls;
  c.jumpTo(x, z, d);
  c.pitch = pitch;
  if (yaw !== undefined) c.yaw = yaw;
  const cur = c.cur;
  cur.tx = c.target.x; cur.tz = c.target.z; cur.d = c.distance; cur.pitch = c.pitch; cur.yaw = c.yaw;
}

function bigTown() { const g = rf().game; return [...g.towns.list].sort((a, b) => b.pop - a.pop)[0]; }

/** Time renderer.frame at a view: cpu (frame call) and total (frame + GPU sync). */
export function measureView(n = 60, warm = 20) {
  const R = rf().renderer;
  for (let i = 0; i < warm; i++) { R.frame(1 / 60); sync(); }
  const cpu = [], tot = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    R.frame(1 / 60);
    const c = now() - t;
    sync();
    cpu.push(c); tot.push(now() - t);
  }
  return { cpu50: r1(pct(cpu, 0.5)), cpu95: r1(pct(cpu, 0.95)), cpuMax: r1(Math.max(...cpu)), tot50: r1(pct(tot, 0.5)), tot95: r1(pct(tot, 0.95)), calls: R.stats.calls, tris: R.stats.tris,
    vehicles: R.vehicles?.instances, geos: R.renderer.info.memory.geometries, tex: R.renderer.info.memory.textures };
}

export async function views() {
  hold();
  const g = rf().game, R = rf().renderer, T = bigTown();
  const size = g.world.size, maxD = R.controls.maxDist;
  const list = [
    ['town 40', T.x, T.z, 40, 0.8],
    ['town 120', T.x, T.z, 120, 0.8],
    ['region 350', T.x, T.z, 350, 0.9],
    ['map max', size / 2, size / 2, maxD, 1.2],
    ['horizon 150', T.x, T.z, 150, 0.3],
  ];
  const out = {};
  for (const [label, x, z, d, p] of list) {
    snap(x, z, d, p);
    // the first frame at a new view builds terrain/objects: report it separately
    const t = now(); R.frame(1 / 60); sync(); const first = now() - t;
    out[label] = { first: r1(first), ...measureView() };
    await sleep(30);
  }
  snap(T.x, T.z, 120, 0.8);
  return out;
}

/** Player frames at each speed: ticks owed by a 60 fps frame + renderer.frame + ui.update (+ GPU sync). */
export async function play(speeds = [1, 4, 8], frames = 240, view = 120) {
  hold();
  const { game: g, renderer: R, ui } = rf(), T = bigTown();
  snap(T.x, T.z, view, 0.8);
  const out = {};
  for (const s of speeds) {
    g.speed = s;
    let acc = 0;
    const tot = [], sim = [], ren = [], uim = [], cpu = [], cpuTot = [];
    for (let i = 0; i < frames; i++) {
      const t0 = now();
      acc += s / 3;
      const k = Math.floor(acc + 1e-9); acc -= k;
      for (let j = 0; j < k; j++) g.stepTick();
      const t1 = now();
      R.frame(1 / 60);
      const t2 = now();
      ui.update(1 / 60);
      const t3 = now();
      sync();
      const t4 = now();
      tot.push(t4 - t0); sim.push(t1 - t0); ren.push(t2 - t1 + (t4 - t3)); uim.push(t3 - t2); cpu.push(t2 - t1); cpuTot.push(t3 - t0);
      if ((i & 31) === 31) await sleep(0);
    }
    out[s + 'x'] = { p50: r1(pct(tot, 0.5)), p95: r1(pct(tot, 0.95)), max: r1(Math.max(...tot)), over33: tot.filter((x) => x > 33).length, over50: tot.filter((x) => x > 50).length,
      sim50: r1(pct(sim, 0.5)), simMax: r1(Math.max(...sim)), render50: r1(pct(ren, 0.5)), renderMax: r1(Math.max(...ren)), ui50: r1(pct(uim, 0.5)), uiMax: r1(Math.max(...uim)),
      frameCpu50: r1(pct(cpu, 0.5)), frameCpuMax: r1(Math.max(...cpu)), mainThread50: r1(pct(cpuTot, 0.5)), mainThread99: r1(pct(cpuTot, 0.99)), mainThreadMax: r1(Math.max(...cpuTot)), mainOver33: cpuTot.filter((x) => x > 33).length, mainOver50: cpuTot.filter((x) => x > 50).length };
  }
  g.speed = 1;
  return out;
}

/** Advance the simulation by whole days in slices (keeps the page responsive). */
export async function advance(days) {
  hold();
  const g = rf().game;
  const t0 = now();
  let worst = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < 40; i++) { const t = now(); g.stepTick(); worst = Math.max(worst, now() - t); }
    if ((d & 7) === 7) await sleep(0);
  }
  return { days, ms: Math.round(now() - t0), worstTick: r1(worst), date: g.dateString?.(), vehicles: g.vehicles.map.size, lines: g.lines.map.size };
}

/** Windows: open + one ui.update + one frame; then a few refreshes. */
export async function windows() {
  hold();
  const { game: g, renderer: R, ui } = rf();
  const st = [...g.stations.map.values()].sort((a, b) => (b.lines?.length ?? 0) - (a.lines?.length ?? 0))[0];
  const T = bigTown();
  const line = [...g.lines.map.values()][0];
  const list = [
    ['lines', () => ui.openLines()], ['vehicles', () => ui.openVehicles()], ['towns', () => ui.openTowns()],
    ['finances', () => ui.openFinances()], ['competitors', () => ui.openCompetitors?.()],
    ['town', () => ui.openTown(T.id)], ['station', () => st && ui.openStation(st.id)], ['line', () => line && ui.openLine(line.id)],
    ['settings', () => ui.openSettings?.()], ['menu', () => ui.openMenu?.()],
  ];
  const out = {};
  for (const [name, fn] of list) {
    ui.wm.closeAll?.();
    R.frame(1 / 60); ui.update(1 / 60); sync();
    await sleep(20);
    const t0 = now();
    try { fn(); } catch (e) { out[name] = 'error ' + e.message; continue; }
    const t1 = now();
    ui.update(1 / 60);
    R.frame(1 / 60); sync();
    const t2 = now();
    // force the 0.3 s window refresh a few times
    const ref = [];
    for (let i = 0; i < 5; i++) { const t = now(); ui.wm.refreshAll(); ref.push(now() - t); }
    out[name] = { open: r1(t1 - t0), firstFrame: r1(t2 - t1), refresh50: r1(pct(ref, 0.5)), refreshMax: r1(Math.max(...ref)) };
  }
  ui.wm.closeAll?.();
  return out;
}

/** Autosave: the synchronous part of the visibility autosave (capture + post to the worker), then completion. */
export async function save() {
  const { ui } = rf();
  const t0 = now();
  document.dispatchEvent(new Event('visibilitychange'));
  const sync = now() - t0;
  // wait for the HUD to say saved
  const t1 = now();
  let done = -1;
  for (let i = 0; i < 400; i++) {
    await sleep(25);
    const el = document.querySelector('.savechip');
    const cls = el?.className ?? '';
    if (/saved|memory|error/.test(cls)) { done = now() - t1; break; }
  }
  return { syncMs: r1(sync), doneMs: done < 0 ? 'unknown' : Math.round(done) };
}

/** Rail tool drag: start a chain at one point, then move the pointer in steps and plan every frame. */
export async function drag(steps = 30) {
  hold();
  const { renderer: R, ui } = rf(), T = bigTown();
  ui.wm.closeAll?.();
  snap(T.x + T.radius * 1.5, T.z, 120, 0.8);
  for (let i = 0; i < 5; i++) R.frame(1 / 60);
  const canvas = R.renderer.domElement, rect = canvas.getBoundingClientRect();
  const tools = ui.tools;
  tools.setTool('rail');
  const ev = (type, x, y, buttons) => {
    const e = new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true });
    canvas.dispatchEvent(e);
  };
  const cx = rect.width * 0.3, cy = rect.height * 0.5;
  ev('pointermove', cx, cy, 0); ui.update(1 / 60);
  ev('pointerdown', cx, cy, 1); ui.update(1 / 60);
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + cx, clientY: rect.top + cy, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
  ui.update(1 / 60);
  const frames = [], plans = [];
  for (let i = 0; i < steps; i++) {
    const x = cx + 40 + i * (rect.width * 0.55 / steps), y = cy + Math.sin(i / 3) * 80;
    const e = new PointerEvent('pointermove', { clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', bubbles: true });
    canvas.dispatchEvent(e);
    tools.planAt = -1e9; // plan on this frame (the tool throttles to 2x its last plan time, at most 200 ms)
    const t0 = now();
    ui.update(1 / 60);
    const t1 = now();
    R.frame(1 / 60); sync();
    frames.push(now() - t0); plans.push(t1 - t0);
    await sleep(0);
  }
  const ok = !!tools.proposal;
  tools.setTool('inspect');
  ui.update(1 / 60);
  return { proposal: ok, planMs: tools.planMs, ui50: r1(pct(plans, 0.5)), uiMax: r1(Math.max(...plans)), frame50: r1(pct(frames, 0.5)), frameMax: r1(Math.max(...frames)) };
}

export function memory() {
  const R = rf().renderer;
  const m = performance.memory;
  return { heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null, geometries: R.renderer.info.memory.geometries, textures: R.renderer.info.memory.textures, programs: R.renderer.info.programs?.length };
}

export function loadInfo() {
  const nav = performance.getEntriesByType('navigation')[0];
  return { domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), loadEvent: Math.round(nav?.loadEventEnd ?? 0) };
}

/** Load a JSON save (from scripts/perfbench --save) through the Import button of the load window. */
export async function importSave(url) {
  const text = await (await fetch(url)).text();
  const file = new File([text], 'bench.json');
  const { ui } = rf();
  const origClick = HTMLInputElement.prototype.click, origConfirm = window.confirm;
  window.confirm = () => true;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file') { const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files; this.dispatchEvent(new Event('change')); }
    else origClick.call(this);
  };
  const before = rf().game;
  const t0 = now();
  try {
    ui.openSaveLoad('load');
    const btn = [...document.querySelectorAll('button')].find((b) => /import/i.test(b.textContent ?? ''));
    if (!btn) throw new Error('no import button');
    btn.click();
    for (let i = 0; i < 600 && rf().game === before; i++) await sleep(50);
  } finally { HTMLInputElement.prototype.click = origClick; window.confirm = origConfirm; }
  origUpdate = null;
  return { ms: Math.round(now() - t0), loaded: rf().game !== before, date: rf().game.dateString?.() };
}

const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
/** The real pacing path: game.update(1/60) (frame budget, planner yields) + frame + ui, yielding to the event loop
 * every frame like requestAnimationFrame would. Reports main-thread ms per frame and ticks released per frame. */
export async function live(speed = 8, frames = 600, view = 120) {
  release();
  const { game: g, renderer: R, ui } = rf(), T = bigTown();
  // the page's own (hidden, ~1 fps) loop must not release ticks meanwhile
  const real = g.update; let mine = false;
  g.update = function (dt) { if (mine) return real.call(this, dt); };
  snap(T.x, T.z, view, 0.8);
  g.speed = speed; g.paused = false;
  let yields = 0;
  const hook = g.runtimeFrameYield;
  if (hook) g.runtimeFrameYield = () => { const y = hook(); if (y) yields++; return y; };
  const ms = [], ticks = [], simMs = [];
  const tick0 = g.tick, t00 = now();
  for (let i = 0; i < frames; i++) {
    const t0 = now(), k0 = g.tick;
    mine = true; g.update(1 / 60); mine = false;
    const t1 = now();
    R.frame(1 / 60);
    ui.update(1 / 60);
    ms.push(now() - t0); simMs.push(t1 - t0); ticks.push(g.tick - k0);
    await yieldNow();
  }
  if (hook) g.runtimeFrameYield = hook;
  const wall = now() - t00;
  g.speed = 1;
  g.update = real;
  hold();
  const due = frames * speed / 3;
  const hist = {}; for (const k of ticks) hist[k] = (hist[k] ?? 0) + 1;
  return { speed, frames, p50: r1(pct(ms, 0.5)), p95: r1(pct(ms, 0.95)), p99: r1(pct(ms, 0.99)), max: r1(Math.max(...ms)),
    over33: ms.filter((x) => x > 33).length, over50: ms.filter((x) => x > 50).length, sim99: r1(pct(simMs, 0.99)), simMax: r1(Math.max(...simMs)),
    ticksDue: Math.round(due), ticksRun: g.tick - tick0, plannerYields: yields, ticksPerFrame: hist, wallMs: Math.round(wall) };
}

/** Sim (stepTick) and frame CPU at several zooms while playing at `speed` (the renderer's interest culling active). */
export async function zoomPlay(speed = 8, frames = 240) {
  hold();
  const { game: g, renderer: R } = rf(), T = bigTown(), size = g.world.size, maxD = R.controls.maxDist;
  const out = {};
  const vu = g.vehicles.update; let vms = 0;
  g.vehicles.update = function (...a) { const t = now(); try { return vu.apply(this, a); } finally { vms += now() - t; } };
  for (const [label, x, z, d, p] of [['town 120', T.x, T.z, 120, 0.8], ['region 350', T.x, T.z, 350, 0.9], ['map max', size / 2, size / 2, maxD, 1.2]]) {
    snap(x, z, d, p);
    for (let i = 0; i < 10; i++) R.frame(1 / 60);
    let acc = 0; const sim = [], fr = [], inst = []; vms = 0;
    for (let i = 0; i < frames; i++) {
      acc += speed / 3; const k = Math.floor(acc + 1e-9); acc -= k;
      const t0 = now();
      for (let j = 0; j < k; j++) g.stepTick();
      const t1 = now();
      R.frame(1 / 60);
      const t2 = now();
      sim.push(t1 - t0); fr.push(t2 - t1); inst.push(R.vehicles.instances);
      if ((i & 15) === 15) await yieldNow();
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    out[label] = { vehiclesSimPerFrame: Math.round(vms / frames * 100) / 100, simMean: r1(mean(sim)), sim50: r1(pct(sim, 0.5)), frameMean: r1(mean(fr) * 10) / 10, frame99: r1(pct(fr, 0.99)), instances: Math.round(mean(inst)),
      poses: g.vehicles.renderPoseCount, vehicles: g.vehicles.map.size + g.vehicles.ambient.length };
  }
  g.vehicles.update = vu;
  return out;
}
