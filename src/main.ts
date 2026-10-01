import './ui/style.css';
import { Game, NewGameOptions } from './game/game';
import { Renderer } from './render/renderer';
import { UI } from './ui/ui';
import { saveToSlot, listSlots, loadFromSlot } from './game/save';
import { loadFonts } from './ui/fonts';
import { defaultTowns } from './ui/title';

const fontsReady = loadFonts();
const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const renderer = new Renderer(app);
renderer.loadSettings();
let game: Game | null = null;

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
  renderer.setGame(g);
  ui.setGame(g);
  // focus the camera on the biggest town
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  if (big) renderer.controls.jumpTo(big.x, big.z, 40);
  else renderer.controls.jumpTo(g.world.size / 2, g.world.size / 2, 60);
  autosaveTimer = 0;
  (window as unknown as { __rf: unknown }).__rf = { game: g, renderer, ui };
}

function newGame(opts: NewGameOptions) {
  showLoading('Generating world…');
  afterPaint(() => {
    try {
      setGame(Game.create(opts));
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
    hideLoading();
  });
}

// periodic autosave
let autosaveTimer = 0;
let saving = false;
async function autosave() {
  if (!game || saving || ui.titleOpen) return;
  saving = true;
  try { await saveToSlot(game, 'autosave', 'Autosave'); } catch (e) { console.warn('autosave failed', e); }
  saving = false;
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (game) {
    try {
      const t0 = performance.now();
      game.update(dt);
      renderer.simMs = performance.now() - t0;
      if (ui.titleOpen) {
        // slow cinematic orbit behind the title screen
        const c = renderer.controls as unknown as { yaw?: number };
        if (typeof c.yaw === 'number') c.yaw += dt * 0.03;
      }
      renderer.frame(dt);
      ui.update(dt);
    } catch (e) { console.error(e); }
    autosaveTimer += dt;
    if (autosaveTimer > 180) { autosaveTimer = 0; autosave(); }
  }
  requestAnimationFrame(loop);
}

function boot() {
  const params = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
  const seed = num('seed', Math.floor(Math.random() * 99999)) || 1;
  const size = Math.max(128, Math.min(1024, Math.round(num('size', 384))));
  const towns = Math.max(0, Math.round(num('towns', defaultTowns(size))));
  const terrain = params.get('terrain');
  const hilliness = (terrain === 'flat' || terrain === 'hilly' || terrain === 'mountainous' ? terrain : 'hilly') as NewGameOptions['hilliness'];
  const wp = params.get('water');
  const water = (wp === 'low' || wp === 'medium' || wp === 'high' ? wp : 'medium') as NewGameOptions['water'];
  const aiCompanies = Math.max(0, Math.min(3, Math.round(num('ai', 1))));
  showLoading('Generating world…');
  afterPaint(() => {
    try {
      setGame(Game.create({ size, seed, towns, hilliness, water, startYear: num('year', 1950), aiCompanies }));
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
    hideLoading();
    requestAnimationFrame(loop);
    if (params.has('nointro') || !game) return;
    const hasAuto = listSlots().some((s) => s.slot === 'autosave');
    ui.showTitle({
      onContinue: hasAuto ? async () => {
        showLoading('Loading autosave…');
        try { setGame(await loadFromSlot('autosave')); } catch (e) { console.error(e); ui.toast('Could not load the autosave', 'bad'); }
        hideLoading();
      } : undefined,
    });
  });
}

boot();
