// Bundle as ui-windows.mjs with esbuild --bundle --platform=node --format=esm --external:jsdom.
// Run beside a node_modules containing jsdom; no browser, audio or simulation ticks are needed.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WindowManager } from '../src/ui/windows';
import { h } from '../src/ui/dom';
import { openRouteUpgrade } from '../src/ui/win-upgrade';
import type { UI } from '../src/ui/ui';
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { fmtMoney } from '../src/game/economy';
import { planRouteUpgrade } from '../src/game/route-works';
import { serialize } from '../src/game/save';
import { addBusStop, busStopSites, roadDepotNear } from './lib';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://railfever.test' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage,
});
const root = document.querySelector('main')!;
const wm = new WindowManager(root);
const win = wm.open('tabs', 'Tabs');
const tabs: [string, string][] = [['one', 'One'], ['two', 'Two'], ['three', 'Three']];
const render = () => { wm.setTabs(win, tabs, render); win.body.replaceChildren(h('button', null, win.tab)); };
render();
const selected = () => win.tabsEl.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
const key = (value: string) => {
  const e = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(e); assert(e.defaultPrevented, value + ' is handled');
};
selected().focus(); key('ArrowRight');
assert.equal(win.tab, 'two'); assert.equal(document.activeElement, selected(), 'ArrowRight keeps focus on the new tab');
assert.equal(win.body.getAttribute('aria-labelledby'), selected().id, 'panel follows the selected tab');
assert.equal(selected().getAttribute('aria-controls'), win.body.id, 'tabs reference their panel');
key('End'); assert.equal(win.tab, 'three');
key('ArrowRight'); assert.equal(win.tab, 'one', 'right wraps');
key('ArrowLeft'); assert.equal(win.tab, 'three', 'left wraps');
key('Home'); assert.equal(win.tab, 'one');
const two = win.tabsEl.querySelectorAll<HTMLButtonElement>('button')[1];
two.focus(); two.click();
assert.equal(document.activeElement, selected(), 'keyboard click keeps focus after the tabs re-render');
assert.equal(win.tabsEl.querySelectorAll('[tabindex="0"]').length, 1, 'only the active tab is in the Tab order');
wm.setTabs(win, [], render);
assert.equal(win.tabsEl.children.length, 0); assert.equal(win.body.hasAttribute('role'), false, 'empty tabs clear panel semantics');

// A rendering error must retain the last complete controls and always restore the live body reference.
const body = win.body, button = h('button', null, 'Keep'); body.replaceChildren(button);
const errors: unknown[] = [], logError = console.error;
win.refresh = () => { win.body.append(h('span', null, 'Partial')); throw new Error('expected refresh failure'); };
console.error = (e) => { errors.push(e); };
try { wm.refreshAll(); } finally { console.error = logError; }
assert.equal(errors.length, 1); assert.equal(win.body, body); assert.equal(body.firstChild, button);
win.refresh = () => { win.body.append(h('button', null, 'Recovered')); };
wm.refreshAll(); assert.equal(body.textContent, 'Recovered', 'the next complete refresh recovers');
win.refresh = () => { win.close(); win.body.append(h('span', null, 'Closed')); };
wm.refreshAll(); assert.equal(body.textContent, 'Recovered', 'closing during a refresh discards its temporary output');
wm.closeAll();

// Real planning, without simulation stepping: edit a route/fleet while its planner is open.
const g = Game.create({ seed: 7, size: 384, towns: 10, startYear: 2000, aiCompanies: 0, hilliness: 'hilly', water: 'medium' });
g.economy.money = 1e9;
const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, town, 0, 12, 30); assert.equal(sites.length, 2);
const line = g.lines.create('road'); line.stops = sites.map(([x, z]) => addBusStop(g, x, z, 0));
const depot = roadDepotNear(g, ...sites[0], 0), model = MODEL_BY_ID.get('bus_c')!;
const bus = g.vehicles.buyRoad(depot, model, line.id); assert.notEqual(typeof bus, 'string');
if (typeof bus === 'string') throw new Error(bus);
bus.opLastSt = line.stops[0]; // Mark it as previously used so the aging estimate must depreciate it.
const messages: string[] = [];
let previews = 0;
const ui = {
  game: g, wm: new WindowManager(root),
  renderer: { overlay: { setSegments() { previews++; }, setRings() {} } },
  kv: (k: string, v: Node | string) => h('div', null, k, v),
  toast: (text: string) => messages.push(text), sound() {},
} as unknown as UI;
const saved = () => JSON.stringify(serialize(g));
const initial = saved();
openRouteUpgrade(ui, line.id);
const planner = ui.wm.get('upgrade-' + line.id)!;
assert(planner.body.textContent?.includes('Start works'), 'fixture has a valid tram upgrade');
assert.equal(saved(), initial, 'opening the planner is pure');
const initialPreviews = previews;
for (let i = 0; i < 3; i++) ui.wm.refreshAll();
assert.equal(previews, initialPreviews, 'unchanged refreshes reuse expensive geometry');
assert.equal(saved(), initial, 'refreshing the planner is pure');
g.day = 180;
const agedSave = saved(); ui.wm.refreshAll();
const aged = planRouteUpgrade(g, line.id, 0, 'tram'); assert(aged.ok);
assert(planner.body.textContent?.includes('+' + fmtMoney(aged.resale)), 'cached estimates update aging bus resale');
assert.equal(previews, initialPreviews, 'aging does not rerun expensive geometry planning');
assert.equal(saved(), agedSave, 'aging estimates are pure');
g.day = 0; ui.wm.refreshAll();
const start = () => [...planner.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Start works'))!;
const old = start();
// Bypass the next refresh deliberately: the click must validate the plan itself.
for (let i = 0; i < 5; i++) assert.notEqual(typeof g.vehicles.buyRoad(depot, model, line.id), 'string');
const expected = planRouteUpgrade(g, line.id, 0, 'tram'); assert(expected.ok);
old.click();
assert.equal(g.routeWorks.length, 0, 'an outdated fleet quote is never started');
assert.equal(messages.at(-1), 'Plan changed. Review before starting.');
assert(planner.body.textContent?.includes(`${expected.vehicles}×`), 'the revised fleet is displayed');
start().click();
assert.equal(g.routeWorks.length, 1, 'a reviewed fresh quote starts');
assert.equal(g.routeWorks[0].quote.vehicles, expected.vehicles);

g.routeWorks.length = 0;
openRouteUpgrade(ui, line.id);
const routePlanner = ui.wm.get('upgrade-' + line.id)!;
const beforeRouteEdit = previews;
line.stops = [...line.stops].reverse(); g.lines.rebuild();
const routeBeforeRefresh = saved();
ui.wm.refreshAll();
assert(previews > beforeRouteEdit, 'route changes invalidate the cached preview');
assert.equal(saved(), routeBeforeRefresh, 'replanning an edited route is pure');
assert.equal(routePlanner.sub.textContent, line.name);
// Changing loop direction also affects the actual tram street path.
const beforeLoopEdit = previews;
line.loop = true; ui.wm.refreshAll(); assert(previews > beforeLoopEdit, 'loop setting invalidates the plan');
ui.wm.closeAll(); dom.window.close();
console.log('PASS: window tab navigation/focus and panel semantics; failed/closed refresh recovery; pure route-upgrade cache, edited fleet/route/loop and validated Start.');
