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
  loading.querySelector('.ltext')!.textContent = text;
  loading.classList.remove('hidden');
}
function hideLoading() { loading.classList.add('hidden'); }

function setGame(g: Game) {
  game = g;
  renderer.setGame(g);
  ui.setGame(g);
  // focus the camera on the biggest town
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  if (big) renderer.controls.jumpTo(big.x + 0.5, big.z + 0.5, 26);
  (window as any).__rf = { game: g, renderer, ui };
}

function newGame(opts: NewGameOptions) {
  showLoading('Generating world…');
  setTimeout(() => {
    try {
      const g = Game.create(opts);
      setGame(g);
    } catch (e) {
      console.error(e);
      ui.toast('World generation failed: ' + (e as Error).message, 'bad');
    }
    hideLoading();
  }, 40);
}

// periodic autosave
let autosaveTimer = 0;
async function autosave() {
  if (!game) return;
  try { await saveToSlot(game, 'autosave', 'Autosave'); } catch (e) { console.warn('autosave failed', e); }
}
window.addEventListener('beforeunload', () => { /* autosave is async; rely on periodic saves */ });

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (game) {
    game.update(dt);
    renderer.frame(dt);
    ui.update(dt);
    autosaveTimer += dt;
    if (autosaveTimer > 180) { autosaveTimer = 0; autosave(); }
  }
  requestAnimationFrame(loop);
}

async function boot() {
  // start with a scenic default world behind the welcome dialog
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || Math.floor(Math.random() * 99999);
  const size = Number(params.get('size')) || 128;
  const towns = params.has('towns') ? Number(params.get('towns')) : Math.round(12 * (size / 128) ** 2);
  const hilliness = (['flat', 'hilly', 'mountainous'].includes(params.get('terrain') ?? '') ? params.get('terrain') : 'hilly') as 'flat' | 'hilly' | 'mountainous';
  const water = (['low', 'medium', 'high'].includes(params.get('water') ?? '') ? params.get('water') : 'medium') as 'low' | 'medium' | 'high';
  const g = Game.create({ size, seed, towns, hilliness, water, startYear: Number(params.get('year')) || 1950 });
  setGame(g);
  hideLoading();
  requestAnimationFrame(loop);
  if (params.has('nointro')) return;
  const hasAuto = listSlots().some((s) => s.slot === 'autosave');
  ui.openNewGame(true);
  const win = ui.wm.get('newgame');
  if (win) {
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
        try { const ag = await loadFromSlot('autosave'); win.close(); setGame(ag); } catch (e) { ui.toast('Could not load autosave', 'bad'); }
      };
      btns?.prepend(cont);
    }
  }
}

boot();
