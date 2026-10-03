import './ui/style.css';
import * as THREE from 'three';
import { Game, MAX_FRAME_SECONDS, NewGameOptions } from './game/game';
import { Renderer } from './render/renderer';
import { UI } from './ui/ui';
import { saveToSlot, listSlots, loadFromSlot, slotsReady, backupSlot } from './game/save';
import { loadFonts } from './ui/fonts';
import { defaultTowns, DEFAULT_MAP_SIZE } from './ui/title';
import { aiConfigsFor, MAX_AI } from './ui/gameapi';
import { audio } from './audio/engine';

const fontsReady = loadFonts();
audio.loadSettings();
// browsers keep audio suspended until the first user gesture
const unlockAudio = () => {
  try { audio.unlock(); } catch (e) { console.warn('audio unlock failed', e); }
  window.removeEventListener('pointerdown', unlockAudio, true);
  window.removeEventListener('keydown', unlockAudio, true);
};
window.addEventListener('pointerdown', unlockAudio, true);
window.addEventListener('keydown', unlockAudio, true);
const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const renderer = new Renderer(app);
renderer.loadSettings();
let game: Game | null = null;
/** autosave state (see autosave() below) */
const AUTOSAVE_EVERY = 60;
let autosaveTimer = 0;
let saving = false;
let autosaveNeedsBackup = false;
/** the current world has been played (title closed, or started from "New game") */
let played = false;

const ui = new UI(app, renderer, {
  newGame: (opts) => newGame(opts),
  setGame: (g) => setGame(g),
});

function showLoading(text: string) {
  const t = loading.querySelector('.ltext');
  if (t) t.textContent = text;
  loading.classList.remove('hidden');
}
function hideLoading() { loading.classList.add('hidden'); }

/** Wait for the fonts (briefly) and for the loading screen to paint before blocking work. */
function afterPaint(fn: () => void) {
  const timeout = new Promise<void>((r) => setTimeout(r, 350));
  Promise.race([fontsReady, timeout]).then(() => requestAnimationFrame(() => setTimeout(fn, 20)));
}

function setGame(g: Game) {
  game = g;
  played = false;
  renderer.setGame(g);
  ui.setGame(g);
  renderer.controls.followPosition = (out) => {
    const v = ui.following === null ? undefined : g.vehicles.get(ui.following);
    return v ? g.vehicles.renderWorldPos(v, out) : false;
  };
  try { audio.setGame(g); } catch (e) { console.warn('audio setGame failed', e); }
  // focus the camera on the biggest town
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  if (big) renderer.controls.jumpTo(big.x, big.z, 40);
  else renderer.controls.jumpTo(g.world.size / 2, g.world.size / 2, 60);
  autosaveTimer = 0;
  (window as unknown as { __rf: unknown }).__rf = { game: g, renderer, ui };
}

/** Loading text for generating a world of the given size. */
const genText = (size: number) => (size >= 1024 ? 'Generating a large world… this takes a few seconds' : 'Generating world…');

function newGame(opts: NewGameOptions) {
  showLoading(genText(opts.size));
  afterPaint(() => {
    try {
      setGame(Game.create(opts));
      played = true;
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
    hideLoading();
  });
}

// ------------------------------------------------------------------ autosave (IndexedDB)
// Every minute of play, when the page is hidden and when it is left; never two saves at once, never while the
// title screen shows a world nobody has played yet (a fresh map must not replace the player's autosave).
async function autosave(reason: string) {
  if (!game || saving) return;
  if (ui.titleOpen && !played) return;
  saving = true;
  ui.hud.showSave('saving');
  try {
    if (autosaveNeedsBackup) { await backupSlot('autosave', 'autosave-failed', 'Autosave (failed to load)'); autosaveNeedsBackup = false; }
    await saveToSlot(game, 'autosave', 'Autosave'); ui.hud.showSave('saved');
  } catch (e) { console.warn('autosave failed (' + reason + ')', e); ui.hud.showSave('error'); }
  saving = false;
  autosaveTimer = 0;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave('hidden'); });
window.addEventListener('pagehide', () => { autosave('pagehide'); });

let last = performance.now();
const focusV = new THREE.Vector3();
function loop(now: number) {
  const wallDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(MAX_FRAME_SECONDS, wallDt);
  last = now;
  if (game) {
    const t0 = performance.now();
    try { game.update(dt); } catch (e) { console.error(e); }
    renderer.simMs = performance.now() - t0;
    try {
      if (ui.titleOpen) {
        // slow cinematic orbit behind the title screen
        const c = renderer.controls as unknown as { yaw?: number };
        if (typeof c.yaw === 'number') c.yaw += dt * 0.03;
      }
      renderer.frame(dt);
    } catch (e) { console.error(e); }
    try { ui.update(dt); } catch (e) { console.error(e); }
    try { audio.update(dt, renderer.camera, renderer.controls.focusInto(focusV), renderer.controls.smoothDistance, renderer.night); } catch (e) { console.error(e); }
    if (ui.titleOpen) { if (!played) autosaveTimer = 0; } else played = true;
    if (!game.paused) autosaveTimer += dt;
    if (autosaveTimer > AUTOSAVE_EVERY) { autosaveTimer = 0; autosave('timer'); }
  }
  requestAnimationFrame(loop);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
  const seed = num('seed', Math.floor(Math.random() * 99999)) || 1;
  const size = Math.max(128, Math.min(2048, Math.round(num('size', DEFAULT_MAP_SIZE))));
  const towns = Math.max(0, Math.round(num('towns', defaultTowns(size))));
  const terrain = params.get('terrain');
  const hilliness = (terrain === 'flat' || terrain === 'hilly' || terrain === 'mountainous' ? terrain : 'hilly') as NewGameOptions['hilliness'];
  const wp = params.get('water');
  const water = (wp === 'low' || wp === 'medium' || wp === 'high' ? wp : 'medium') as NewGameOptions['water'];
  const aiCompanies = Math.max(0, Math.min(MAX_AI, Math.round(num('ai', 1))));
  // ?aistyle=balanced|cautious|aggressive|rail|bus|tram|mixed
  const aiConfigs = aiConfigsFor(params.get('aistyle') ?? 'balanced', aiCompanies);
  // the autosave (IndexedDB) becomes the current game unless ?new asks for a fresh map
  showLoading('Loading…');
  await slotsReady;
  const auto = params.has('new') ? undefined : listSlots().find((s) => s.slot === 'autosave');
  let resumed = false;
  if (auto) {
    showLoading('Loading your game…');
    try { setGame(await loadFromSlot('autosave')); resumed = true; } catch (e) {
      console.error(e);
      autosaveNeedsBackup = true;
      try { await backupSlot('autosave', 'autosave-failed', 'Autosave (failed to load)'); autosaveNeedsBackup = false; }
      catch (backupError) { console.warn('Could not back up the failed autosave', backupError); }
      ui.toast('Could not load the autosave — here is a new map', 'bad');
    }
  }
  if (!game) {
    showLoading(genText(size));
    await new Promise<void>((r) => afterPaint(r));
    try {
      setGame(Game.create({ size, seed, towns, hilliness, water, startYear: num('year', 1950), aiCompanies, aiConfigs }));
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
  }
  hideLoading();
  requestAnimationFrame(loop);
  if (params.has('nointro') || !game) { played = true; return; }
  ui.showTitle({ resumed: resumed && auto ? { saved: auto.saved } : undefined });
}

boot();
