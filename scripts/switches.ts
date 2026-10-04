// Bundle as switches.mjs using the adapters in saves-harness.ts (see saves.progress.md). Node + jsdom.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
const memory = process.argv.includes('--memory');
const resumed = process.argv.includes('--resume');
const dom = new JSDOM('<div id="app"></div><div id="loading"><span class="ltext"></span></div>', { url: 'https://railfever.test/?' + (resumed ? '' : 'new&') + 'seed=7&size=128&towns=3&ai=0' + (memory ? '&nointro' : '') });
const win = dom.window;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'location', 'localStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: (win as any)[key] });
(globalThis as any).__notices = [];
if (memory) Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
else (globalThis as any).indexedDB = indexedDB;
let frames: FrameRequestCallback[] = [];
(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; };
let accept = true;
const confirmations: string[] = [];
(globalThis as any).confirm = (text: string) => { confirmations.push(text); return accept; };
const sleep = () => new Promise((r) => setTimeout(r, 5));
function frame() { const q = frames; frames = []; for (const fn of q) fn(performance.now()); }
async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 20000;
  while (!await fn()) { assert(Date.now() < end, 'UI operation timed out'); frame(); await sleep(); }
}
function button(parent: ParentNode, text: string) {
  const b = [...parent.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!;
  assert(b, 'button exists: ' + text); return b;
}
if (resumed) {
  const { Game } = await import('../src/game/game');
  const { saveToSlot } = await import('../src/game/save');
  const game = Game.create({ size: 128, seed: 7, towns: 3, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 0 });
  game.economy.money = 222222222;
  await saveToSlot(game, 'autosave', 'Autosave');
}
await import('../src/main');
const { getSave } = await import('../src/game/storage');
const { loadFromSlot, listSlots, exportToFile, importFromText, serialize } = await import('../src/game/save');
await until(() => !!(win as any).__rf?.game);
const current = () => (win as any).__rf;
const hidden = () => {
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, value: 'hidden' });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
};
try {
  if (memory) {
    await until(() => !!win.document.querySelector('.storage-banner'));
    assert(win.document.querySelector('.storage-banner')!.textContent!.includes("Session-only saves: lost on reload; Export to keep."));
    hidden(); await until(() => !!listSlots().find((s) => s.slot === 'autosave'));
    assert(win.document.querySelector('.savechip')!.textContent!.includes('Session only'));
    (win.document.querySelector('[aria-label="Dismiss storage notice"]') as HTMLElement).click();
    assert(!win.document.querySelector('.storage-banner'));
    hidden(); await sleep(); assert(!win.document.querySelector('.storage-banner'), 'notice remains dismissed');
    let downloaded = '';
    win.HTMLAnchorElement.prototype.click = function () { downloaded = this.href; };
    current().ui.openMenu(); button(win.document.querySelector('.win:not(.closing)')!, 'Export save to file').click();
    await until(() => !!downloaded);
    assert(downloaded.startsWith('blob:'), 'Export produces a download in memory mode');
    const json = JSON.stringify(serialize(current().game));
    assert.equal(JSON.stringify(serialize(await importFromText(await (await exportToFile(current().game)).text()))), json);
    console.log('PASS memory UI: SecurityError fallback, persistent dismissible banner, honest indicator, direct Export, complete file roundtrip');
  } else if (resumed) {
    await until(() => !!win.document.querySelector('.title'));
    assert.equal(current().game.economy.money, 222222222);
    current().ui.openNewGame(); accept = false;
    button(win.document.querySelector('.ng-card')!, 'Start').click(); await sleep();
    assert.equal(confirmations.length, 1, 'a resumed game is played even before Continue is clicked');
    assert.equal(current().game.economy.money, 222222222);
    assert.equal(await getSave('autosave-previous'), null);
    console.log('PASS resumed autosave: title-screen New requires confirmation and preserves the loaded game on decline');
  } else {
    hidden(); await sleep(); assert.equal(await getSave('autosave'), null, 'preview is never autosaved');
    button(win.document.querySelector('.title')!, 'Load game').click(); frame(); hidden(); await sleep();
    assert.equal(await getSave('autosave'), null, 'preview opening Load is still not played');
    assert.equal(await getSave('autosave-previous'), null);
    current().ui.wm.close('saveload'); frame(); hidden(); await sleep();
    assert.equal(await getSave('autosave'), null, 'a paused preview after cancelling Load is still not played');
    const newCard = (seed: number) => {
      current().ui.openNewGame();
      (win.document.querySelector('.ng-card .seg button') as HTMLElement).click();
      const input = win.document.querySelector('.ng-card input[type=number]') as HTMLInputElement;
      input.value = String(seed); input.dispatchEvent(new win.Event('input'));
    };
    newCard(11); button(win.document.querySelector('.ng-card')!, 'Start').click();
    await until(() => current().game.options.seed === 11 && !win.document.querySelector('.title'));
    assert.equal(confirmations.length, 0); assert.equal(await getSave('autosave-previous'), null, 'preview was never archived');
    current().game.paused = true; current().game.economy.money = 123456789;
    newCard(12); accept = false; button(win.document.querySelector('.ng-card')!, 'Start').click(); await sleep();
    assert.equal(current().game.options.seed, 11); assert(win.document.querySelector('.title')); assert.equal(await getSave('autosave-previous'), null);
    // If preservation cannot commit, the shell must keep both the current game and its card.
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: any[]) {
      const req = originalPut.apply(this, args as any);
      if (this.name === 'saves' && args[0].slot === 'autosave-previous') queueMicrotask(() => this.transaction.abort());
      return req;
    };
    accept = true; button(win.document.querySelector('.ng-card')!, 'Start').click();
    await until(() => (globalThis as any).__notices.some(([text]: string[]) => text.startsWith('Could not switch games:')));
    IDBObjectStore.prototype.put = originalPut;
    assert.equal(current().game.options.seed, 11); assert(win.document.querySelector('.title'));
    assert.equal(await getSave('autosave-previous'), null);
    button(win.document.querySelector('.ng-card')!, 'Start').click();
    await until(() => current().game.options.seed === 12 && !win.document.querySelector('.title'));
    assert.equal((await loadFromSlot('autosave-previous')).economy.money, 123456789);
    assert.equal(confirmations[0], "Start a new game? Current game will be saved as 'Autosave (previous game)'.");
    current().game.paused = true; current().game.economy.money = 987654321;
    current().ui.openMenu(); button(win.document.querySelector('.win:not(.closing)')!, 'Load game…').click();
    const beforeLoad = confirmations.length;
    accept = false; button(win.document.querySelector('.win:not(.closing)')!, 'Load').click();
    await until(() => confirmations.length === beforeLoad + 1);
    assert.equal(current().game.options.seed, 12); assert(current().ui.wm.get('saveload'));
    accept = true; button(win.document.querySelector('.win:not(.closing)')!, 'Load').click();
    await until(() => current().game.options.seed === 11);
    assert.equal(current().game.economy.money, 123456789);
    assert.equal((await loadFromSlot('autosave-previous')).economy.money, 987654321);
    assert(confirmations.includes("Load another game? Current game will be saved as 'Autosave (previous game)'."));
    hidden(); await until(() => !!listSlots().find((s) => s.slot === 'autosave'));
    assert.equal((await loadFromSlot('autosave-previous')).economy.money, 987654321, 'later autosave does not overwrite the previous game');
    assert(win.document.querySelector('.savechip')!.textContent!.includes('Saved'));
    console.log('PASS switch UI: unplayed preview, New/Load confirmations and cancellations, real current-game preservation, previous-slot load, subsequent autosave isolation');
  }
} finally { dom.window.close(); frames = []; }
