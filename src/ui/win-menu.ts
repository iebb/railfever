// Menu, save / load, settings and help windows.
import type { UI } from './ui';
import { h, clear, section, icon, toggle, field, add } from './dom';
import { fmtMoney } from '../game/economy';
import { saveToSlot, loadFromSlot, listSlots, deleteSlot, exportToFile, importFromText } from '../game/save';
import { fmtDate } from './format';

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
    item('settings', 'Settings', () => { win.close(); openSettings(ui); }),
    item('help', 'Help & controls', () => { win.close(); openHelp(ui); }),
    item('rail', 'Title screen', () => { win.close(); ui.showTitle({}); }),
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
        try { await saveToSlot(ui.game, 'slot' + Date.now(), name.value); ui.toast('Game saved', 'good'); render(); } catch (e) { ui.toast('Save failed: ' + (e as Error).message, 'bad'); }
      } }, icon('save', 16), 'Save')));
    }
    add(win.body, section('Saved games', String(slots.length)));
    if (!slots.length) add(win.body, h('div', { class: 'pad' }, 'No saved games yet.'));
    for (const s of slots) {
      add(win.body, h('div', { class: 'slot' },
        h('div', { style: 'min-width:0' }, h('b', null, s.name), h('div', { class: 'muted' }, `${s.date} · ${fmtMoney(s.money)} · ${new Date(s.saved).toLocaleString()}`)),
        h('div', { class: 'rowbtns' },
          mode === 'save'
            ? h('button', { class: 'btn sm', onclick: async () => { if (confirm('Overwrite this save?')) { try { await saveToSlot(ui.game, s.slot, s.name); ui.toast('Game saved', 'good'); } catch (e) { ui.toast('Save failed: ' + (e as Error).message, 'bad'); } render(); } } }, 'Overwrite')
            : h('button', { class: 'btn sm primary', onclick: async () => {
              try { const g = await loadFromSlot(s.slot); win.close(); ui.app.setGame(g); ui.toast('Game loaded', 'good'); } catch (e) { ui.toast('Load failed: ' + (e as Error).message, 'bad'); }
            } }, 'Load'),
          h('button', { class: 'ibtn sm', title: 'Delete save', 'aria-label': 'Delete save', onclick: () => { if (confirm('Delete this save?')) { deleteSlot(s.slot); render(); } } }, icon('trash', 15)))));
    }
  };
  render();
}

async function exportSave(ui: UI) {
  try {
    const blob = await exportToFile(ui.game);
    const a = h('a', { href: URL.createObjectURL(blob), download: `railfever-${ui.game.year}.rfsave` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { ui.toast('Export failed: ' + (e as Error).message, 'bad'); }
}

function importSave(ui: UI) {
  const inp = h('input', { type: 'file', accept: '.rfsave,.txt,.json' }) as HTMLInputElement;
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try { const g = await importFromText(await f.text()); ui.wm.closeAll(); ui.app.setGame(g); ui.toast('Game imported', 'good'); }
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
  const s = r.settings as unknown as Record<string, unknown>;
  const win = ui.wm.open('settings', 'Settings', { width: 390, icon: 'settings', color: '#eef2f7' });
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
    const opts: [string, string][] = [['auto', 'Auto (holds ~60 fps)'], ['1', '100%'], ['0.75', '75%'], ['0.5', '50%']];
    const cur = String(s.resolution);
    const sel = h('select', { class: 'select', 'aria-label': 'Resolution' }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
    sel.addEventListener('change', () => { s.resolution = sel.value === 'auto' ? 'auto' : Number(sel.value); apply(); });
    win.body.append(field('Resolution', sel, 'Render scale on top of the pixel ratio'));
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
  win.body.append(
    section('Interface'),
    toggle('Reduce transparency', ui.reduceTransparency, (v) => { ui.reduceTransparency = v; ui.savePrefs(); }, 'Solid panels, faster on slow GPUs'),
    toggle('Sound effects', ui.soundOn, (v) => { ui.soundOn = v; ui.savePrefs(); }),
    toggle('Construction grid', (grid()?.value ?? 0) > 0, (v) => { const u = grid(); if (u) u.value = v ? 1 : 0; }, 'G'),
    section('Simulation'),
    toggle('Ambient town traffic', g.vehicles.ambientEnabled, (v) => { g.vehicles.ambientEnabled = v; g.vehicles.manageAmbient(); }),
    toggle('AI companies build', g.aiEnabled, (v) => { g.aiEnabled = v; }),
  );
}

export function openHelp(ui: UI) {
  const win = ui.wm.open('help', 'How to play', { width: 520, icon: 'help', color: '#eef2f7' });
  win.body.innerHTML = `
    <div class="help">
    <h4>Camera</h4>
    <p><b>Right-drag</b> pan · <b>Middle-drag</b> or <kbd>Alt</kbd> + drag rotate &amp; tilt · <b>Wheel</b> zoom · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Q</kbd> <kbd>E</kbd> rotate · <kbd>R</kbd> <kbd>F</kbd> tilt · <kbd>M</kbd> minimap. On touch: two fingers pan, pinch and rotate.</p>
    <h4>Building track and roads</h4>
    <ol>
      <li>Open <b>Rail</b> or <b>Road</b> in the dock (<kbd>2</kbd> / <kbd>6</kbd>). Click to set the start — on open ground, a track end, or onto a track to branch off.</li>
      <li>Move the mouse: the preview shows the curve, bridges (blue), tunnels (purple), crossings and buildings in the way (red). The card shows cost, length, grade, radius and speed.</li>
      <li>Click to build. Construction continues from the new end with a smooth curve; <b>right-click</b>, <kbd>Esc</kbd> or a long press ends it. You can also drag to build one section.</li>
      <li>Options: standard or high-speed track, <b>1–4 parallel tracks</b>, road type, the <b>end height</b> (<kbd>[</kbd> <kbd>]</kbd>, ±5 m) for bridges and tunnels, and how to cross other lines. Hold <kbd>Shift</kbd> over a track to copy it as a parallel track.</li>
    </ol>
    <h4>Getting started</h4>
    <ol>
      <li>Place a <b>train station</b> (<kbd>3</kbd>) near two towns — <kbd>R</kbd> rotates, it lines up with nearby track ends. The green circle is its catchment.</li>
      <li>Connect the stations with track and add a <b>train depot</b> (<kbd>5</kbd>) at a free track end.</li>
      <li>Open <b>Lines</b> (<kbd>L</kbd>) → <i>New rail line</i>, click both stations, then <i>Add train</i>. Keep trains shorter than the platforms.</li>
      <li>Buses: <b>bus stops</b> (<kbd>7</kbd>) on roads, a <b>bus depot</b> (<kbd>8</kbd>) next to a road, and a bus line.</li>
    </ol>
    <h4>Tips</h4>
    <ul>
      <li>Several trains on a line need <b>signals</b> (<kbd>4</kbd>). Use one-way signals on double track; build passing loops on single track.</li>
      <li>Fast, frequent service raises station ratings — well-served towns grow faster.</li>
      <li>AI companies build their own networks (<b>Companies</b>, <kbd>C</kbd>). You can inspect their property but not change it.</li>
    </ul>
    <h4>Keys</h4>
    <p><kbd>1</kbd> inspect · <kbd>2</kbd> track · <kbd>3</kbd> station · <kbd>4</kbd> signal · <kbd>5</kbd> train depot · <kbd>6</kbd> road · <kbd>7</kbd> bus stop · <kbd>8</kbd> bus depot · <kbd>9</kbd> demolish · <kbd>0</kbd> terraform · <kbd>L</kbd> lines · <kbd>V</kbd> vehicles · <kbd>T</kbd> towns · <kbd>C</kbd> companies · <kbd>N</kbd> news · <kbd>Space</kbd> pause · <kbd>G</kbd> grid · <kbd>Esc</kbd> cancel / close</p>
    </div>`;
}
