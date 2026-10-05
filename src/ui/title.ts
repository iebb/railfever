// Title screen over the live (blurred) world: wordmark, main actions and the new-game card.
import { GAME_VERSION } from '../game/version';

declare const __BUILD__: string | undefined;
/** The build's short commit (Vite define; absent in headless bundles). */
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : '';
import type { UI } from './ui';
import type { NewGameOptions } from '../game/game';
import { h, icon, seg, stepper, field, add } from './dom';
import { COMPANY_COLORS } from '../game/economy';
import { openSaveLoad, openSettings } from './win-menu';
import { MAX_AI, aiConfigsFor, presetOf, AI_PRESETS } from './gameapi';
import { inertBehind } from './windows';

export interface TitleOpts {
  ui: UI;
  /** open the new-game card right away */
  newGame?: boolean;
  /** the current world is being played (or was restored from the autosave, `saved` = when): "Continue" */
  resumed?: { saved?: number };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} day${s < 172800 ? '' : 's'} ago`;
}

/** Default number of towns for a map size (scaled with the area). */
export function defaultTowns(size: number) { return Math.max(3, Math.min(40, Math.round(3.2 * (size / 384) ** 2))); }
/** Map size presets (world units; 1 unit = 10 m). */
export const MAP_SIZES: [number, string, string][] = [[512, 'S', '5.1 km'], [768, 'M', '7.7 km'], [1024, 'L', '10.2 km'], [1536, 'XL', '15.4 km']];
export const DEFAULT_MAP_SIZE = 768;

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
  const root = h('div', { class: 'title', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Railfever', tabindex: '-1' });
  const row = h('div', { class: 'title-row' });
  const main = h('div', { class: 'title-main' });
  let card: HTMLElement | null = null;
  /** a11y: the HUD and windows behind the title take no focus or clicks while it is open */
  let releaseHud = () => {};
  const close = (resume = true) => {
    releaseHud();
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
    if (card) { card.remove(); card = null; root.classList.remove('card-open'); } else if (g) close();
  };
  window.addEventListener('keydown', onKey, true);
  const btn = (ic: string, label: string, note: string, fn: () => void, primary = false) =>
    h('button', { class: 'tm-btn' + (primary ? ' primary' : ''), onclick: fn }, icon(ic, 22), label, note ? h('small', null, note) : null);
  main.innerHTML = `<div class="wordmark">RAIL<span>FEVER</span></div>${MOTIF}`;
  main.append(
    h('div', { class: 'tagline' }, 'Connect growing towns and outpace rival companies.'),
    h('div', { class: 'title-menu' },
      g && o.resumed ? btn('play', 'Continue', o.resumed.saved ? `${g.dateString()} · saved ${ago(o.resumed.saved)}` : g.dateString(), () => close(), true) : null,
      g && !o.resumed ? btn('play', 'Play this map', `${g.towns.list.length} towns · ${g.options.startYear}`, () => close(), true) : null,
      btn('plus', 'New game', '', () => openCard()),
      btn('save', 'Load game', '', () => { close(false); openSaveLoad(ui, 'load'); }),
      btn('settings', 'Settings', '', () => { close(); openSettings(ui); })),
    h('div', { class: 'title-foot' }, 'Offline in your browser'),
  );
  const preview = /\/preview\//.test(location.pathname);
  root.append(h('div', { class: 'title-ver', title: BUILD ? `Build ${BUILD}` : undefined }, `v${GAME_VERSION}${preview ? ` preview${BUILD ? ` · ${BUILD}` : ''}` : ''}`));
  row.appendChild(main);
  root.appendChild(row);
  ui.root.appendChild(root);
  releaseHud = inertBehind(root);
  if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });

  function openCard() {
    if (card) return;
    const st = { size: DEFAULT_MAP_SIZE, towns: defaultTowns(DEFAULT_MAP_SIZE), hilliness: 'hilly' as NewGameOptions['hilliness'], water: 'medium' as NewGameOptions['water'], year: 1950, ai: 1, style: 'balanced', money: null as number | null, seed: Math.floor(Math.random() * 99999) };
    const c = h('div', { class: 'ng-card glass' });
    card = c;
    const render = () => {
      c.replaceChildren();
      const towns = h('input', { type: 'range', min: '3', max: '64', value: String(st.towns), class: 'range', 'aria-label': 'Towns' }) as HTMLInputElement;
      const tv = h('span', { class: 'stp-v' }, String(st.towns));
      towns.addEventListener('input', () => { st.towns = Number(towns.value); tv.textContent = towns.value; });
      const seed = h('input', { type: 'number', value: String(st.seed), class: 'input', style: 'width:110px', 'aria-label': 'Seed' }) as HTMLInputElement;
      seed.addEventListener('input', () => { st.seed = Number(seed.value) || 1; });
      const era = ERAS.find(([y]) => y === st.year);
      const money = h('input', { type: 'number', min: '0', max: '1000', step: 'any', value: st.money == null ? '' : String(st.money), placeholder: 'Preset', class: 'input', style: 'width:110px', 'aria-label': 'AI starting balance in millions' }) as HTMLInputElement;
      money.addEventListener('input', () => { st.money = money.value === '' ? null : money.valueAsNumber; });
      add(c,
        h('div', { class: 'ng-title' }, 'New game'),
        field('Map size', seg(MAP_SIZES, st.size, (v) => { st.size = v; st.towns = defaultTowns(v); render(); }), `${(st.size / 100).toFixed(1)} × ${(st.size / 100).toFixed(1)} km${st.size >= 1024 ? ' · large maps: a few seconds to generate' : ''}`),
        field('Towns', h('div', { class: 'inline', style: 'flex:1' }, towns, tv)),
        field('Terrain', seg([['flat', 'Flat'], ['hilly', 'Hilly'], ['mountainous', 'Mountains']], st.hilliness, (v) => { st.hilliness = v; render(); })),
        field('Water', seg([['low', 'Little'], ['medium', 'Some'], ['high', 'Lots']], st.water, (v) => { st.water = v; render(); })),
        field('Start year', seg(ERAS.map(([y, l]) => [y, l] as [number, string]), st.year, (v) => { st.year = v; render(); }), era?.[2]),
        field('Competitors', h('div', { class: 'inline wrap' },
          stepper(String(st.ai), () => { st.ai = Math.max(0, st.ai - 1); render(); }, () => { st.ai = Math.min(MAX_AI, st.ai + 1); render(); }),
          h('div', { class: 'ai-chips' }, st.ai ? aiConfigsFor(st.style, st.ai).map((cfg, i) => h('span', { class: 'ai-chip', style: `--c:${COMPANY_COLORS[i + 1]}`, 'data-tip': presetOf(cfg)?.name ?? '' }, h('i'), `Rival ${i + 1}`)) : h('span', { class: 'muted' }, 'Sandbox: no rivals')))),
        st.ai ? field('AI style', seg([['cautious', 'Cautious'], ['balanced', 'Balanced'], ['aggressive', 'Aggressive'], ['mixed', 'Mixed']], st.style, (v) => { st.style = v; render(); }),
          st.style === 'mixed' ? 'Rail barons, bus operators, tram builders…' : AI_PRESETS.find((p) => p.id === st.style)?.hint) : null,
        st.ai ? field('AI balance', h('div', { class: 'inline' }, money, '$M', h('button', { class: 'btn ghost sm', onclick: () => { st.money = null; render(); } }, 'Use preset')),
          'Each rival; the first $5M is a loan. Blank uses the style’s balance.') : null,
        field('Seed', h('div', { class: 'inline' }, seed, h('button', { class: 'ibtn', 'data-tip': 'Random seed', 'aria-label': 'Random seed', onclick: () => { st.seed = Math.floor(Math.random() * 99999); seed.value = String(st.seed); } }, icon('dice', 18)))),
        h('div', { class: 'btns right' },
          h('button', { class: 'btn ghost', onclick: () => { c.remove(); card = null; root.classList.remove('card-open'); if (o.newGame && g) close(); } }, 'Cancel'),
          h('button', { class: 'btn primary lg', onclick: async () => {
            if (st.ai && !money.reportValidity()) return;
            const nt = Math.min(st.towns, Math.round((st.size * st.size) / 3000));
            // The shell returns success after confirmation, preservation, and world creation.
            const started = await (ui.app.newGame({ size: st.size, towns: nt, hilliness: st.hilliness, water: st.water, startYear: st.year, seed: st.seed || 1, aiCompanies: st.ai, aiConfigs: aiConfigsFor(st.style, st.ai, st.money == null ? undefined : st.money * 1_000_000) }) as unknown as Promise<boolean>);
            if (started) close(false);
          } }, icon('play', 18), 'Start')),
      );
    };
    render();
    row.appendChild(c);
    root.classList.add('card-open');
    (c as HTMLElement & { scrollIntoView?: (o?: object) => void }).scrollIntoView?.({ block: 'nearest' });
  }
  if (o.newGame) openCard();
}
