import './ui/style.css';
import { Game, NewGameOptions } from './game/game';
import { Renderer } from './render/renderer';
import { UI } from './ui/ui';
import { saveToSlot, listSlots, loadFromSlot } from './game/save';

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

/** Default number of towns for a map size (scaled with the area). */
export function defaultTowns(size: number) { return Math.max(3, Math.round(10 * (size / 384) ** 2)); }

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
  // let the loading screen paint before the (blocking) generation
  setTimeout(() => {
    try {
      setGame(Game.create(opts));
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
    hideLoading();
  }, 60);
}

// periodic autosave
let autosaveTimer = 0;
let saving = false;
async function autosave() {
  if (!game || saving) return;
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
      game.update(dt);
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
  setTimeout(() => {
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
    ui.openNewGame(true);
    const win = ui.wm.get('newgame');
    if (!win) return;
    const btns = win.body.querySelector('.btns');
    const play = document.createElement('button');
    play.className = 'btn';
    play.textContent = 'Play this map';
    play.onclick = () => win.close();
    btns?.prepend(play);
    if (hasAuto) {
      const cont = document.createElement('button');
      cont.className = 'btn';
      cont.textContent = 'Continue autosave';
      cont.onclick = async () => {
        try { const ag = await loadFromSlot('autosave'); win.close(); setGame(ag); } catch (e) { console.error(e); ui.toast('Could not load autosave', 'bad'); }
      };
      btns?.prepend(cont);
    }
  }, 30);
}

boot();
