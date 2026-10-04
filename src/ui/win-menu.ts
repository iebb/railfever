// Menu, save / load, settings and help windows.
import type { UI } from './ui';
import { h, clear, section, icon, toggle, field, add, seg } from './dom';
import { UI_SCALES, uiScale, setUiScale } from './uiscale';
import { fmtMoney } from '../game/economy';
import { saveToSlot, loadFromSlot, listSlots, deleteSlot, exportToFile, importFromText, saveIncompatibility } from '../game/save';
import { storageMode } from '../game/storage';
import { fmtDate, fmtLen } from './format';
import { audio, AudioSettings } from '../audio/engine';
import { walkLimit, WALK_DETOUR } from '../game/catchment';
import { CITY_STATION, CITY_WALK_SCALE } from '../game/stations';
import { RAIL_FARE } from '../game/constants';
import { FARE_LEVEL, TRANSFER_FARE_FACTOR } from '../game/fares';

export function openMenu(ui: UI) {
  const win = ui.wm.open('menu', 'Menu', { width: 280, x: window.innerWidth - 300, y: 64, icon: 'menu', color: '#eef2f7' });
  const item = (ic: string, label: string, fn: () => void) => h('button', { class: 'menu-item', onclick: () => fn() }, icon(ic, 18), label);
  add(win.body, 
    item('play', 'Resume', () => win.close()),
    item('plus', 'New game…', () => { win.close(); ui.openNewGame(); }),
    item('save', 'Save game…', () => { win.close(); openSaveLoad(ui, 'save'); }),
    item('load', 'Load game…', () => { win.close(); openSaveLoad(ui, 'load'); }),
    item('export', 'Export save to file', () => exportSave(ui)),
    item('import', 'Import save from file…', () => importSave(ui)),
    item('company', 'Companies', () => { win.close(); ui.openCompetitors(); }),
    item('money', 'Finances (I)', () => { win.close(); ui.openFinances(); }),
    item('key', 'Track access', () => { win.close(); ui.openTrackAccess(); }),
    item('signal', 'Auto-signal railway', () => { win.close(); ui.openAutoSignal(); }),
    item('settings', 'Settings', () => { win.close(); openSettings(ui); }),
    item('help', 'Help & controls', () => { win.close(); openHelp(ui); }),
    item('rail', 'Title screen', () => { win.close(); ui.showTitle({ resumed: {} }); }),
  );
}

export function openSaveLoad(ui: UI, mode: 'save' | 'load') {
  const win = ui.wm.open('saveload', mode === 'save' ? 'Save game' : 'Load game', { width: 430, icon: mode === 'save' ? 'save' : 'load', color: '#eef2f7' });
  const render = () => {
    clear(win.body);
    const slots = listSlots();
    if (mode === 'save') {
      const name = h('input', { class: 'input', style: 'flex:1', value: `${ui.game.player.name} – ${fmtDate(ui.game)}`, 'aria-label': 'Save name' }) as HTMLInputElement;
      add(win.body, h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
        try { await saveToSlot(ui.game, 'slot' + Date.now(), name.value); savedNotice(ui); render(); } catch (e) { ui.toast('Save failed: ' + (e as Error).message, 'bad'); }
      } }, icon('save', 16), 'Save')));
    }
    add(win.body, section('Saved games', String(slots.length)));
    if (!slots.length) add(win.body, h('div', { class: 'pad' }, 'No saved games.'));
    slots.sort((a, b) => (a.slot === 'autosave' ? -1 : b.slot === 'autosave' ? 1 : b.saved - a.saved));
    for (const s of slots) {
      const incompatible = saveIncompatibility(s);
      add(win.body, h('div', { class: 'slot' },
        h('div', { style: 'min-width:0' }, h('b', null, s.name),
          h('div', { class: 'muted' }, `${s.date} · ${fmtMoney(s.money)} · ${new Date(s.saved).toLocaleString()}${s.game ? ` · v${s.game}` : ''}`),
          incompatible ? h('div', { class: 'neg' }, 'Incompatible version') : null),
        h('div', { class: 'rowbtns' },
          mode === 'save'
            ? h('button', { class: 'btn sm', onclick: async () => { if (confirm('Overwrite this save?')) { try { await saveToSlot(ui.game, s.slot, s.name); savedNotice(ui); } catch (e) { ui.toast('Save failed: ' + (e as Error).message, 'bad'); } render(); } } }, 'Overwrite')
            : h('button', { class: 'btn sm primary', disabled: !!incompatible, 'data-tip': incompatible ?? undefined, onclick: async () => {
              try {
                const g = await loadFromSlot(s.slot);
                if (await (ui.app.setGame(g) as unknown as Promise<boolean>)) { win.close(); ui.toast('Game loaded', 'good'); }
              } catch (e) { ui.toast('Load failed: ' + (e as Error).message, 'bad'); }
            } }, 'Load'),
          h('button', { class: 'ibtn sm', 'data-tip': 'Delete save', 'aria-label': 'Delete save', onclick: () => { if (confirm('Delete this save?')) { deleteSlot(s.slot); render(); } } }, icon('trash', 15)))));
    }
    add(win.body, h('div', { class: 'muted', style: 'margin-top:8px' }, storageMode() === 'memory'
      ? "Session-only saves: lost on reload; Export to keep."
      : 'Browser saves · autosave every minute and on leaving · restored on return'));
    add(win.body, h('div', { class: 'btns right' }, h('button', { class: 'btn', onclick: () => exportSave(ui) }, icon('export', 16), 'Export'), h('button', { class: 'btn', onclick: () => importSave(ui) }, icon('import', 16), 'Import')));
  };
  render();
}

function savedNotice(ui: UI) {
  ui.hud.showSave('saved');
  ui.toast(storageMode() === 'memory' ? 'Session-only save; Export to keep' : 'Game saved', storageMode() === 'memory' ? 'info' : 'good');
}

export async function exportSave(ui: UI) {
  try {
    const blob = await exportToFile(ui.game);
    const a = h('a', { href: URL.createObjectURL(blob), download: `railfever-${ui.game.year}.rfsave` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { ui.toast('Export failed: ' + (e as Error).message, 'bad'); }
}

function importSave(ui: UI) {
  const inp = h('input', { type: 'file', accept: '.rfsave,.txt,.json' }) as HTMLInputElement;
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const g = await importFromText(await f.text());
      if (await (ui.app.setGame(g) as unknown as Promise<boolean>)) { ui.wm.closeAll(); ui.toast('Game imported', 'good'); }
    }
    catch (e) { ui.toast('Import failed: ' + (e as Error).message, 'bad'); }
  });
  inp.click();
}

const SETTING_LABELS: Record<string, [string, string?]> = {
  shadows: ['Shadows'],
  ao: ['Ambient occlusion', 'Soft contact shadows'],
  clouds: ['Cloud shadows'],
  dayNight: ['Day / night cycle'],
  labels: ['Town & station labels'],
  debug: ['Performance overlay (F3)', 'Frame times, draw calls, resolution'],
};
const ORDER = ['shadows', 'ao', 'clouds', 'dayNight', 'labels'];

export function openSettings(ui: UI) {
  const r = ui.renderer;
  const win = ui.wm.open('settings', 'Settings', { width: 390, icon: 'settings', color: '#eef2f7' });
  const render = () => {
    clear(win.body);
    const s = r.settings as unknown as Record<string, unknown>;
    const apply = () => r.applySettings();
    const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const flag = (key: string) => {
      const [label, hint] = SETTING_LABELS[key] ?? [humanize(key)];
      return toggle(label, !!s[key], (v) => { s[key] = v; apply(); }, hint);
    };
    win.body.append(section('Graphics'));
    const bools = Object.keys(s).filter((k) => typeof s[k] === 'boolean' && k !== 'debug');
    for (const key of [...ORDER.filter((k) => bools.includes(k)), ...bools.filter((k) => !ORDER.includes(k))]) win.body.append(flag(key));
    if ('shadowQuality' in s) {
      const q = h('select', { class: 'select', 'aria-label': 'Shadow quality' }, ['high', 'low'].map((v) => h('option', { value: v, selected: s.shadowQuality === v }, v[0].toUpperCase() + v.slice(1))));
      q.addEventListener('change', () => { s.shadowQuality = q.value; apply(); });
      win.body.append(field('Shadow quality', q));
    }
    if ('resolution' in s) {
      const opts: [string, string][] = [['auto', 'Auto (~60 fps)'], ['1', '100%'], ['0.75', '75%'], ['0.5', '50%']];
      const cur = String(s.resolution);
      const sel = h('select', { class: 'select', 'aria-label': 'Resolution' }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
      sel.addEventListener('change', () => { s.resolution = sel.value === 'auto' ? 'auto' : Number(sel.value); apply(); });
      win.body.append(field('Resolution', sel, 'Render scale × pixel ratio'));
    }
    if ('pixelRatio' in s) {
      const vals = [1, 1.25, 1.5, 2];
      const cur = Number(s.pixelRatio);
      if (!vals.some((v) => Math.abs(v - cur) < 0.01)) vals.push(cur);
      const sc = h('select', { class: 'select', 'aria-label': 'Max pixel ratio' }, vals.sort((a, b) => a - b).map((v) => h('option', { value: String(v), selected: Math.abs(cur - v) < 0.01 }, `${v}×`)));
      sc.addEventListener('change', () => { s.pixelRatio = Number(sc.value); apply(); });
      win.body.append(field('Max pixel ratio', sc, `Display: ${(window.devicePixelRatio || 1).toFixed(2)}×`));
    }
    if ('debug' in s) win.body.append(flag('debug'));
    const g = ui.game;
    const grid = () => (r.terrain.uniforms as unknown as { uGrid?: { value: number } }).uGrid;
    // interface size: text, HUD, cards, windows and map labels at 90–130 % (kept when the window re-renders)
    const uiSize = () => {
      const sg = seg(UI_SCALES.map((v) => [v, `${Math.round(v * 100)}%`] as [number, string]), uiScale(), (v) => {
        const focused = win.body.contains(document.activeElement);
        setUiScale(v);
        render();
        if (focused) (win.body.querySelector('.uiscale .segb.on') as HTMLElement | null)?.focus({ preventScroll: true });
      }, 'uiscale');
      sg.setAttribute('aria-label', 'Interface size');
      return field('Interface size', sg, 'Text, panels, windows, map labels');
    };
    // audio: volume sliders (0–100 %) and mute
    const vol = (key: keyof Omit<AudioSettings, 'muted'>, label: string, hint?: string) => {
      const rng = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(audio.settings[key] * 100)), class: 'range', 'aria-label': label }) as HTMLInputElement;
      const val = h('span', { class: 'stp-v' }, `${rng.value}%`);
      rng.addEventListener('input', () => { audio.settings[key] = Number(rng.value) / 100; val.textContent = `${rng.value}%`; ui.hud.syncVol(); });
      rng.addEventListener('change', () => { audio.saveSettings(); ui.sound(key === 'ui' ? 'click' : key === 'world' ? 'build' : 'toggle'); });
      return field(label, h('div', { class: 'inline', style: 'flex:1' }, rng, val), hint);
    };
    win.body.append(
      section('Audio'),
      toggle('Mute all sound', audio.settings.muted, (v) => { audio.settings.muted = v; audio.saveSettings(); ui.hud.syncVol(); }),
      vol('master', 'Master'),
      vol('ui', 'Interface', 'Clicks, windows, notifications'),
      vol('world', 'World', 'Construction, trains, stations'),
      vol('ambient', 'Ambience', 'Wind, birds, town and traffic'),
      section('Interface'),
      uiSize(),
      toggle('Reduce transparency', ui.reduceTransparency, (v) => { ui.reduceTransparency = v; ui.savePrefs(); }, 'Solid panels; faster on slow GPUs'),
      toggle('Construction grid', (grid()?.value ?? 0) > 0, (v) => { const u = grid(); if (u) u.value = v ? 1 : 0; }, 'G'),
      toggle('Getting-started checklist', !ui.checklist.hidden, (v) => { if (v) ui.checklist.reopen(); else ui.checklist.dismiss(); }),
      section('Simulation'),
      toggle('Ambient town traffic', g.vehicles.ambientEnabled, (v) => { g.vehicles.ambientEnabled = v; g.vehicles.manageAmbient(); }),
      toggle('AI companies build', g.aiEnabled, (v) => { g.aiEnabled = v; }),
    );
  };
  win.refresh = render;
  render();
}

export function openHelp(ui: UI) {
  const win = ui.wm.open('help', 'How to play', { width: 520, icon: 'help', color: '#eef2f7', cls: 'help-info' });
  win.body.innerHTML = `
    <div class="help">
    <h4>Camera</h4>
    <ul>
      <li><b>Right-drag</b>: pan.</li>
      <li><b>Middle-drag</b>, <kbd>Alt</kbd>+left-drag or <kbd>Shift</kbd>/<kbd>Alt</kbd>+right-drag: rotate &amp; tilt.</li>
      <li><b>Wheel</b>, <kbd>Ctrl</kbd>+wheel, trackpad pinch or <kbd>+</kbd>/<kbd>−</kbd>: zoom.</li>
      <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>: move · <kbd>Q</kbd>/<kbd>E</kbd>: rotate · <kbd>R</kbd>/<kbd>F</kbd>: tilt.</li>
      <li>Touch: two fingers pan, pinch and rotate.</li>
    </ul>
    <h4>Building track and roads</h4>
    <ol>
      <li><b>Rail</b> / <b>Road</b> (<kbd>2</kbd> / <kbd>6</kbd>): click ground, an end to extend, or track to branch.</li>
      <li>Preview: cost, length, grade, radius, speed, crossings and demolition.</li>
      <li>Blue: bridges · purple: tunnels · red: buildings in the way.</li>
      <li>Click: build / continue; drag: one section; right-click / <kbd>Esc</kbd> / long press: end.</li>
      <li>Touch: tap start, end to preview, same spot to build; elsewhere: move preview.</li>
      <li>One track type: curves and grades set speed, up to 400 km/h; 1–4 parallel tracks.</li>
      <li>Road type, crossing mode and end height: <kbd>[</kbd>/<kbd>]</kbd>, ±5 m for bridges / tunnels.</li>
      <li><kbd>Shift</kbd> over track: parallel copy.</li>
    </ol>
    <h4>Getting started</h4>
    <ol>
      <li>Two train stations (<kbd>3</kbd>) near towns → track → depot (<kbd>5</kbd>) at a free track end.</li>
      <li><kbd>R</kbd> / <kbd>Shift</kbd>+<kbd>R</kbd> / <kbd>Alt</kbd>+wheel: rotate; manual rotation disables track alignment.</li>
      <li>Start with single track and one-platform halts; reserve cash for a train.</li>
      <li>Bridges, tunnels and demolition cost extra.</li>
      <li><b>Finances</b> (<kbd>I</kbd>, money plate or Menu): costs and loans; money warnings offer Borrow.</li>
      <li><b>Lines</b> (<kbd>L</kbd>) → Rail line → click both stations → Add train.</li>
      <li>Train length ≤ platform length.</li>
      <li>Buses: roadside stops (<kbd>7</kbd>) → roadside depot (<kbd>8</kbd>) → bus line → buy bus.</li>
      <li>Trams: click / drag street tracks → stops → roadside tram depot → tram line.</li>
    </ol>
    <h4>Walking catchments</h4>
    <ul>
      <li>Forecourt / entrance / stop street reach; colours match transport mode.</li>
      <li>Base reach: rail ${fmtLen(walkLimit('rail') / WALK_DETOUR)} · tram ${fmtLen(walkLimit('tram') / WALK_DETOUR)} · bus ${fmtLen(walkLimit('bus') / WALK_DETOUR)}.</li>
      <li>Street-grid allowance: +${Math.round((WALK_DETOUR - 1) * 100)}%.</li>
      <li>Street limits: rail ${fmtLen(walkLimit('rail'))} · tram ${fmtLen(walkLimit('tram'))} · bus ${fmtLen(walkLimit('bus'))}.</li>
      <li>Main-line / metro / light rail: equal reach; in-city metro / light rail (town ${CITY_STATION.pop.toLocaleString('en-US')}+ core): half, ${fmtLen(walkLimit('rail') * CITY_WALK_SCALE / WALK_DETOUR)}; buildings extend reach.</li>
    </ul>
    <h4>Urban rail &amp; network tools</h4>
    <ul>
      <li><b>Urban</b> (<kbd>U</kbd>): double track with wire; metro / light-rail station styles; ground / elevated / underground.</li>
      <li>Urban stations: close spacing, optional street entrances.</li>
      <li>Any train / rail line: urban + main-line through running; equal fares.</li>
      <li><b>Connect tracks</b> (<kbd>J</kbd>, Rail → Connect): two points → curve, turnouts, signals, cost.</li>
      <li>Click: build; <kbd>Esc</kbd> / right-click: restart; turnouts outside platforms / depots.</li>
      <li>Urban → <b>Re-level</b>: Lift / Sink / Ground; height / depth; click / drag your track.</li>
      <li>Ramps included; stations move; lines / signals stay; structures cost extra.</li>
      <li><b>Electrify</b> (Rail): click / drag track; platform tracks included; new track inherits wire.</li>
      <li>Electric locos, EMUs, metro and light-rail units need wire; wire doesn't change speed.</li>
      <li><b>Multiple units</b>: EMUs / light rail; price and capacity per complete unit.</li>
      <li><b>Units</b> couples sets; check the wire requirement before buying.</li>
    </ul>
    <h4>Lines, demand and companies</h4>
    <ul>
      <li>Automatic names from stops, colours and company / route symbols; click to edit.</li>
      <li>Empty name: automatic; badges such as <b>AS01</b>: station number on each rail line.</li>
      <li><b>Lines map</b> (<kbd>M</kbd>): coloured routes and station numbers at every zoom.</li>
      <li>Zoomed out: first number +n; busy stations / interchanges take overlap priority.</li>
      <li><b>Stations</b>: quieter routes, pins with name, waiting passengers and all numbers.</li>
      <li><kbd>B</kbd>: Lines / Stations; opens Stations if the map is closed.</li>
      <li>Hover route / number: name; click route: open; touch: tap name, tap to open.</li>
      <li>Filter by mode and company; <kbd>Esc</kbd>: close map.</li>
      <li><b>Demand</b> (<kbd>P</kbd>): Passengers / Mail; <kbd>Esc</kbd>: close.</li>
      <li>Town trips / served districts; orange dashed: unserved; blue solid: served.</li>
      <li>Mail width: potential t/month; colour / dashes: estimated carried share.</li>
      <li>Mail: orange short dashes 0%; blue solid 100%; estimate: routes, reach, ratings.</li>
      <li>Mail rings / labels: outgoing tonnes / carried share, including onward mail.</li>
      <li>Mail vehicles: vans, trucks and postbuses.</li>
      <li><b>Companies</b> (<kbd>C</kbd>): up to seven AI rivals, with adjustable styles.</li>
      <li>Buyouts transfer network, vehicles, cash and loan.</li>
      <li><b>Track access</b> (<kbd>K</kbd>): networks open by default; blocked companies excluded.</li>
      <li>Ask / Approve all / Reject all, company blocks, usage and agreements.</li>
      <li>Upkeep split by usage × owner’s multiplier; 50/50 use at 2×: user pays 2/3.</li>
      <li><b>Shared lines</b> → Vehicles: invite / join open lines; operators must own a stop.</li>
      <li>Operators keep vehicles / fares; shared stops: lines and upkeep estimates.</li>
    </ul>
    <h4>Service patterns</h4>
    <ul>
      <li><b>Services</b>: Local / Rapid / Express / Limited Express; station dots: stop / pass.</li>
      <li>Omit end stations: short-turn at first / last stopping station.</li>
      <li>Assign patterns in a vehicle window or the line’s Vehicles tab.</li>
      <li>Passengers board services that stop where they need to get off.</li>
      <li>Non-stop trains use through tracks; platform tracks are slower.</li>
      <li>A route inside a longer route becomes a service pattern of that line.</li>
      <li>Monthly income vs energy, crew, maintenance; full breakdown: Finances.</li>
    </ul>
    <h4>Tips</h4>
    <ul>
      <li>Signals (<kbd>4</kbd>): multiple trains; click: place / cycle; drag: 250 m – 1 km spacing.</li>
      <li>One-way: double track; two-way: single track with passing loops.</li>
      <li><b>Auto-signal</b>: line window, Signals or Menu; preview and cost before applying.</li>
      <li>Path: junctions / station entries; route to next signal must be free.</li>
      <li>Block: directional double track; single track: signals at passing loops.</li>
      <li><b>Signal blocks</b> view: free / reserved / occupied.</li>
      <li><b>Through</b>: 1–2 platform-free tracks, between side platforms or outside islands.</li>
      <li><b>On a line</b>: insert into your track; trains keep running; add stop to lines.</li>
      <li>Station → Build: connect open track ends.</li>
      <li><b>Loop</b> / Out and back / Auto: 3+ distinct stops loop one way; map shows direction.</li>
      <li>Rail → <b>Double</b>: click / drag single track; end switches to free platforms.</li>
      <li>Directional double: one way per track, block signals and station crossovers.</li>
      <li>Stations: ground / elevated / underground; optional buildings extend catchment.</li>
      <li>Station → <b>Build</b>: style, length, eight platforms max, side, entrances, move.</li>
      <li>Each entrance has its own street reach; list shows residents it alone adds.</li>
      <li>Elevated / underground entrances: roadside stair towers / pavilions.</li>
      <li>Ground: side hall, footbridge / underpass to both sides, platform-end gate.</li>
      <li>Entrances can add access streets where no road passes.</li>
      <li>Ground rebuilds keep entrances beside platforms; add access streets if needed.</li>
      <li>No room / street: entrance removed, with a preview warning.</li>
      <li>Moving or changing level removes entrances; Re-level moves connected track.</li>
      <li><b>Overview</b>: platform use, waiting trains, expansion advice and live cost.</li>
      <li>Merge panel: nearby stations → rebuild as one or link for walking transfers.</li>
      <li>Fares: distance, time saved versus walking / driving, including wait.</li>
      <li>Rail minimum ${fmtMoney(RAIL_FARE.minimum * FARE_LEVEL)} before speed factor, once per journey.</li>
      <li>Equal rail fares for every station style; short trips earn a smaller speed premium.</li>
      <li>Speed, frequency and direct journeys raise fares.</li>
      <li>Each transfer: −${Math.round((1 - TRANSFER_FARE_FACTOR) * 100)}% on that leg and all later legs.</li>
      <li>High-speed trains cost more energy and maintenance.</li>
      <li>Fast, frequent service raises ratings; served towns grow faster.</li>
      <li>Start single; double when traffic grows.</li>
      <li>AI builds networks; track access allows connections and use of stops.</li>
    </ul>
    <h4>Keys</h4>
    <ul>
      <li><kbd>1</kbd> inspect · <kbd>2</kbd> track · <kbd>3</kbd> station · <kbd>4</kbd> signal · <kbd>5</kbd> train depot.</li>
      <li><kbd>6</kbd> road · <kbd>7</kbd> bus stop · <kbd>8</kbd> bus depot · <kbd>9</kbd> demolish · <kbd>0</kbd> terraform.</li>
      <li><kbd>U</kbd> urban rail · <kbd>J</kbd> connect tracks · <kbd>L</kbd> lines · <kbd>V</kbd> vehicles · <kbd>T</kbd> towns.</li>
      <li><kbd>C</kbd> companies · <kbd>K</kbd> track access · <kbd>N</kbd> news · <kbd>I</kbd> finances.</li>
      <li><kbd>M</kbd> lines map · <kbd>H</kbd> collapse minimap · <kbd>B</kbd> Lines / Stations.</li>
      <li><kbd>P</kbd> demand · <kbd>O</kbd> catchment · <kbd>G</kbd> grid · <kbd>F1</kbd> help · <kbd>F3</kbd> performance.</li>
      <li><kbd>Space</kbd> pause · <kbd>,</kbd> slower · <kbd>.</kbd> faster: 1×, 2×, 4×, 8×.</li>
      <li><kbd>R</kbd> / <kbd>Shift</kbd>+<kbd>R</kbd> / <kbd>Alt</kbd>+wheel: rotate station / depot.</li>
      <li><kbd>+</kbd>/<kbd>−</kbd> / <kbd>Ctrl</kbd>+wheel / pinch: zoom · <kbd>R</kbd>/<kbd>F</kbd>: camera tilt.</li>
      <li><kbd>Space</kbd> / <kbd>Enter</kbd>: activate focused control · <kbd>Esc</kbd>: cancel / close.</li>
      <li>Form controls suppress global shortcuts; <kbd>Esc</kbd> still works.</li>
    </ul>
    </div>`;
}
