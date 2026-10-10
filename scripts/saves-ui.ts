// Bundle as saves-ui.mjs with --external:playwright; run from the scratch test directory after build.
// Uses isolated headless Chrome profiles and the built file:// HTML; never starts a dev server.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const build = process.argv[2];
assert(build, 'pass the absolute path to dist/railfever.html');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const failures: string[] = [];
const dbRecords = (page: Page) => page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('railfever', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  return new Promise<any[]>((resolve, reject) => {
    const t = db.transaction('saves', 'readonly'), r = t.objectStore('saves').getAll();
    t.oncomplete = () => { db.close(); resolve(r.result); }; t.onerror = () => reject(t.error);
  });
});
const getGame = (page: Page) => page.evaluate(() => {
  const g = (window as any).__rf.game;
  return { seed: g.options.seed, size: g.world.size, money: g.economy.money, tick: g.tick };
});
async function newCard(page: Page, seed: number) {
  await page.evaluate(() => (window as any).__rf.ui.openNewGame());
  await page.locator('.ng-card .seg button').first().click(); // S / 512
  // (by label: the card also has a number field for the starting balance)
  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).fill(String(seed));
}
async function hidden(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => failures.push(e.message));
  await page.goto(pathToFileURL(resolve(build)).href + '?new&seed=7&size=128&towns=3&ai=0');
  await page.waitForFunction(() => !!(window as any).__rf?.game && !!document.querySelector('.title'));
  assert.equal((await getGame(page)).size, 128);
  await hidden(page);
  await page.waitForTimeout(250);
  assert.equal((await dbRecords(page)).length, 0, 'title preview is never autosaved');
  // The title Load path must also leave the preview unplayed until a real game starts.
  await page.getByRole('button', { name: 'Load game', exact: true }).click();
  await hidden(page); await page.waitForTimeout(200);
  assert.equal((await dbRecords(page)).length, 0, 'opening Load from the preview does not autosave it');
  let dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await newCard(page, 11);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => (window as any).__rf?.game.options.seed === 11 && !document.querySelector('.title'));
  assert.equal(dialogs.length, 0, 'unplayed preview switch needs no confirmation');
  assert(!(await dbRecords(page)).some((r) => r.slot === 'autosave-previous'), 'preview was not archived');
  await page.evaluate(() => { const g = (window as any).__rf.game; g.paused = true; g.economy.money = 123456789; });
  page.removeAllListeners('dialog');
  await newCard(page, 12);
  page.once('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal((await getGame(page)).seed, 11, 'declining New retains the active game');
  assert(await page.locator('.title').isVisible(), 'declining New retains the card');
  assert(!(await dbRecords(page)).some((r) => r.slot === 'autosave-previous'));
  page.once('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => (window as any).__rf?.game.options.seed === 12 && !document.querySelector('.title'));
  let prev = (await dbRecords(page)).find((r) => r.slot === 'autosave-previous');
  assert.equal(prev.meta.name, 'Autosave (previous game)'); assert.equal(prev.meta.money, 123456789);
  assert.equal(dialogs[0], "Start a new game? Current game will be saved as 'Autosave (previous game)'.");
  await page.evaluate(() => { const g = (window as any).__rf.game; g.paused = true; g.economy.money = 987654321; (window as any).__rf.ui.openMenu(); });
  await page.getByRole('button', { name: 'Load game…', exact: true }).click();
  page.once('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal((await getGame(page)).seed, 12, 'declining Load retains the game');
  page.once('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.waitForFunction(() => (window as any).__rf?.game.options.seed === 11);
  assert.equal((await getGame(page)).money, 123456789);
  prev = (await dbRecords(page)).find((r) => r.slot === 'autosave-previous');
  assert.equal(prev.meta.money, 987654321, 'Load archives the game being replaced, even when loading previous-game itself');
  assert(dialogs.includes("Load another game? Current game will be saved as 'Autosave (previous game)'."));
  await hidden(page);
  await page.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('railfever', 2); q.onsuccess = () => r(q.result); });
    return new Promise<boolean>((r) => { const t = db.transaction('saves', 'readonly'), q = t.objectStore('saves').get('autosave'); t.oncomplete = () => { db.close(); r(!!q.result); }; });
  });
  assert.equal((await dbRecords(page)).find((r) => r.slot === 'autosave-previous').meta.money, 987654321);
  // (the hidden-page autosave may still be writing when its record from the earlier save is found)
  await page.locator('.savechip.saved').waitFor({ timeout: 10000 }).catch(() => {});
  assert(await page.locator('.savechip.saved').isVisible(), 'persistent saves can honestly say Saved');
  assert.equal(failures.length, 0, failures.join('\n'));
  await context.close();
  console.log('PASS offline HTML: preview exclusion, confirmation decline/accept, current-game preservation for New and Load, subsequent autosave isolation');

  const memory = await browser.newContext({ acceptDownloads: true });
  await memory.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } }); });
  const mem = await memory.newPage();
  mem.on('pageerror', (e) => failures.push(e.message));
  await mem.goto(pathToFileURL(resolve(build)).href + '?new&nointro&seed=7&size=128&towns=3&ai=0');
  await mem.waitForFunction(() => !!(window as any).__rf?.game);
  await mem.locator('.storage-banner').waitFor();
  assert((await mem.locator('.storage-banner').innerText()).includes("Session-only saves: lost on reload; Export to keep."));
  await hidden(mem);
  await mem.locator('.savechip.memory').waitFor();
  // (textContent: the chip is set in capitals by CSS, which innerText reflects)
  assert((await mem.locator('.savechip').textContent())?.includes('Session only'));
  await mem.getByRole('button', { name: 'Dismiss storage notice' }).click();
  assert.equal(await mem.locator('.storage-banner').count(), 0);
  await hidden(mem); await mem.waitForTimeout(150);
  assert.equal(await mem.locator('.storage-banner').count(), 0, 'dismissal persists for the session');
  await mem.evaluate(() => (window as any).__rf.ui.openMenu());
  const downloadPromise = mem.waitForEvent('download');
  await mem.getByRole('button', { name: 'Export save to file', exact: true }).click();
  const download = await downloadPromise, path = await download.path();
  assert(path, 'Export downloads a single file in memory mode');
  page.removeAllListeners('dialog');
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('PASS memory mode: SecurityError fallback, persistent dismissible notice, honest save indicator, working Export');
  await memory.close();
} finally { await browser.close(); }
