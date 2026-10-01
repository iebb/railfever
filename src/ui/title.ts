// Title screen over the live (blurred) world: wordmark, main actions and the new-game card.
import type { UI } from './ui';
import type { NewGameOptions } from '../game/game';
import { h, icon, seg, stepper, field } from './dom';
import { COMPANY_COLORS } from '../game/economy';
import { AI_NAMES } from '../game/ai';
import { openSaveLoad, openSettings } from './win-menu';

export interface TitleOpts {
  ui: UI;
  /** open the new-game card right away */
  newGame?: boolean;
  /** offer "Continue" (autosave) */
  onContinue?: () => void;
}

/** Default number of towns for a map size (scaled with the area). */
export function defaultTowns(size: number) { return Math.max(3, Math.round(10 * (size / 384) ** 2)); }

const ERAS: [number, string, string][] = [[1900, '1900', 'Steam age'], [1930, '1930', 'Express steam'], [1950, '1950', 'Diesel age'], [1980, '1980', 'Intercity'], [2005, '2005', 'High speed']];

let current: { close: () => void } | null = null;

const MOTIF = `<svg class="motif" viewBox="0 0 380 46" fill="none" aria-hidden="true">
  <path d="M4 30 H120 C150 30 158 12 188 12 H262 C292 12 300 30 330 30 H376" stroke="rgba(255,176,32,0.25)" stroke-width="9" stroke-linecap="round"/>
  <path d="M4 30 H120 C150 30 158 12 188 12 H262 C292 12 300 30 330 30 H376" stroke="#ffb020" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="40" cy="30" r="6.5" fill="#10161f" stroke="#ffb020" stroke-width="3"/>
  <circle cx="225" cy="12" r="6.5" fill="#10161f" stroke="#ffb020" stroke-width="3"/>
  <circle cx="352" cy="30" r="6.5" fill="#10161f" stroke="#eef2f7" stroke-width="3"/>
</svg>`;

export function showTitle(o: TitleOpts) {
  const ui = o.ui;
  current?.close();
  const g = ui.game;
  const wasPaused = g ? g.paused : false;
  if (g) g.paused = true;
  ui.titleOpen = true;
  ui.tools?.setTool('inspect');
  const root = h('div', { class: 'title', role: 'dialog', 'aria-label': 'Railfever' });
  const main = h('div', { class: 'title-main' });
  let card: HTMLElement | null = null;
  const close = (resume = true) => {
    root.remove();
    window.removeEventListener('keydown', onKey, true);
    ui.titleOpen = false;
    if (current === handle) current = null;
    if (resume && g && ui.game === g) g.paused = wasPaused;
  };
  const handle = { close: () => close(false) };
  current = handle;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (card) { card.remove(); card = null; } else if (g) close();
  };
  window.addEventListener('keydown', onKey, true);
  const btn = (ic: string, label: string, note: string, fn: () => void, primary = false) =>
    h('button', { class: 'tm-btn' + (primary ? ' primary' : ''), onclick: fn }, icon(ic, 22), label, note ? h('small', null, note) : null);
  main.innerHTML = `<div class="wordmark">RAIL<span>FEVER</span></div>${MOTIF}`;
  main.append(
    h('div', { class: 'tagline' }, 'Lay curved railways, bridges and bus lines between growing towns — and outpace rival companies.'),
    h('div', { class: 'title-menu' },
      g ? btn('play', 'Play this map', `${g.towns.list.length} towns · ${g.options.startYear}`, () => close(), true) : null,
      o.onContinue ? btn('load', 'Continue', 'autosave', () => { close(false); o.onContinue!(); }) : null,
      btn('plus', 'New game', '', () => openCard()),
      btn('save', 'Load game', '', () => { close(); openSaveLoad(ui, 'load'); }),
      btn('settings', 'Settings', '', () => { close(); openSettings(ui); })),
    h('div', { class: 'title-foot' }, 'Runs entirely in your browser — no internet needed.'),
  );
  root.appendChild(main);
  ui.root.appendChild(root);

  function openCard() {
    if (card) return;
    const st = { size: 384, towns: defaultTowns(384), hilliness: 'hilly' as NewGameOptions['hilliness'], water: 'medium' as NewGameOptions['water'], year: 1950, ai: 1, seed: Math.floor(Math.random() * 99999) };
    const c = h('div', { class: 'ng-card glass' });
    card = c;
    const render = () => {
      c.replaceChildren();
      const towns = h('input', { type: 'range', min: '3', max: '40', value: String(st.towns), class: 'range', 'aria-label': 'Towns' }) as HTMLInputElement;
      const tv = h('span', { class: 'stp-v' }, String(st.towns));
      towns.addEventListener('input', () => { st.towns = Number(towns.value); tv.textContent = towns.value; });
      const seed = h('input', { type: 'number', value: String(st.seed), class: 'input', style: 'width:110px', 'aria-label': 'Seed' }) as HTMLInputElement;
      seed.addEventListener('input', () => { st.seed = Number(seed.value) || 1; });
      const era = ERAS.find(([y]) => y === st.year);
      c.append(
        h('div', { class: 'ng-title' }, 'New game'),
        field('Map size', seg([[256, 'S', '2.6 km'], [384, 'M', '3.8 km'], [512, 'L', '5.1 km'], [768, 'XL', '7.7 km']], st.size, (v) => { st.size = v; st.towns = defaultTowns(v); render(); }), `${(st.size / 100).toFixed(1)} × ${(st.size / 100).toFixed(1)} km`),
        field('Towns', h('div', { class: 'inline', style: 'flex:1' }, towns, tv)),
        field('Terrain', seg([['flat', 'Flat'], ['hilly', 'Hilly'], ['mountainous', 'Mountains']], st.hilliness, (v) => { st.hilliness = v; render(); })),
        field('Water', seg([['low', 'Little'], ['medium', 'Some'], ['high', 'Lots']], st.water, (v) => { st.water = v; render(); })),
        field('Start year', seg(ERAS.map(([y, l]) => [y, l] as [number, string]), st.year, (v) => { st.year = v; render(); }), era?.[2]),
        field('Competitors', h('div', { class: 'inline wrap' },
          stepper(String(st.ai), () => { st.ai = Math.max(0, st.ai - 1); render(); }, () => { st.ai = Math.min(3, st.ai + 1); render(); }),
          h('div', { class: 'ai-chips' }, st.ai ? Array.from({ length: st.ai }, (_, i) => h('span', { class: 'ai-chip', style: `--c:${COMPANY_COLORS[(i + 1) % COMPANY_COLORS.length]}` }, h('i'), AI_NAMES[i % AI_NAMES.length])) : h('span', { class: 'muted' }, 'Sandbox — no rivals')))),
        field('Seed', h('div', { class: 'inline' }, seed, h('button', { class: 'ibtn', title: 'Random seed', 'aria-label': 'Random seed', onclick: () => { st.seed = Math.floor(Math.random() * 99999); seed.value = String(st.seed); } }, icon('dice', 18)))),
        h('div', { class: 'btns right' },
          h('button', { class: 'btn ghost', onclick: () => { c.remove(); card = null; if (o.newGame && g) close(); } }, 'Cancel'),
          h('button', { class: 'btn primary lg', onclick: () => {
            close(false);
            const nt = Math.min(st.towns, Math.round((st.size * st.size) / 3000));
            ui.app.newGame({ size: st.size, towns: nt, hilliness: st.hilliness, water: st.water, startYear: st.year, seed: st.seed || 1, aiCompanies: st.ai });
          } }, icon('play', 18), 'Start')),
      );
    };
    render();
    root.appendChild(c);
  }
  if (o.newGame) openCard();
}
