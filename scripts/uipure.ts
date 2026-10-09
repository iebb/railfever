// Passive UI must leave saves byte-identical, including pending catchment work and provisional lines.
// Adapted from codex/val-mail-ui/harness.ts (uiFor, fixtures, per-window/tab/hover checks).
// Bundle as uipure.mjs with esbuild --bundle --platform=node --format=esm, then run with node.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Game, PLAYER, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { demandView } from '../src/game/demand';
import { mailView } from '../src/game/mail-view';
import { bezLine } from '../src/game/geom';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { h } from '../src/ui/dom';
import type { UI } from '../src/ui/ui';
import { WindowManager } from '../src/ui/windows';
import { HoverCard, type HoverTarget } from '../src/ui/hovercard';
import { openStation, openTown, openVehicle, openDepot, openEdge, openPurchase } from '../src/ui/win-info';
import { openLines, openLine, openVehicles, openTowns } from '../src/ui/win-lines';
import { openFinances, openCompetitors, openAIConfig, openInvest, openBuyout } from '../src/ui/win-company';
import { openMenu, openSaveLoad, openSettings, openHelp } from '../src/ui/win-menu';
import { openTrackAccess } from '../src/ui/win-access';
import { openAutoSignal } from '../src/ui/win-signals';
import { lineCodeOf, stationBadges, lineTag } from '../src/ui/lineid';
import { memo, pruneMemos } from '../src/ui/win-ops';
import { MapModes } from '../src/ui/mapmodes';
import { catchStreets } from '../src/ui/gameapi';
import { placeAndConnect, depotBehind, busStopSites, addBusStop, roadDepotNear, fails } from './lib';

// Only DOM operations used by these renderers: no browser, HTML parser or layout engine.
// Canvas uses the validation probe's no-op context. Game/UI functions themselves are never stubbed.
class DomNode {
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  parentNode: DomNode | null = null;
  childNodes: DomNode[] = [];
  constructor(public nodeType: number, public nodeName: string, public nodeValue: string | null = null) {}
  get firstChild() { return this.childNodes[0] ?? null; }
  get parentElement() { return this.parentNode instanceof DomElement ? this.parentNode : null; }
  get textContent(): string { return this.nodeValue ?? this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(s: string) { this.replaceChildren(); if (this.nodeType === 3) this.nodeValue = s; else this.appendChild(new DomNode(3, '#text', s)); }
  appendChild<T extends DomNode>(n: T): T { n.remove(); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n: DomNode) { assert.equal(n.parentNode, this); this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  replaceChild(n: DomNode, old: DomNode) { const i = this.childNodes.indexOf(old); assert.ok(i >= 0); n.remove(); this.childNodes[i] = n; n.parentNode = this; old.parentNode = null; return old; }
  replaceChildren(...ns: DomNode[]) { for (const n of [...this.childNodes]) this.removeChild(n); for (const n of ns) this.appendChild(n); }
  append(...ns: (DomNode | string)[]) { for (const n of ns) this.appendChild(typeof n === 'string' ? new DomNode(3, '#text', n) : n); }
  prepend(n: DomNode) { n.remove(); n.parentNode = this; this.childNodes.unshift(n); }
  remove() { this.parentNode?.removeChild(this); }
  contains(n: DomNode | null): boolean { return !!n && (this === n || this.childNodes.some((c) => c.contains(n))); }
}
class DomElement extends DomNode {
  private attrs = new Map<string, string>();
  private html = '';
  private events = new Map<string, ((e: unknown) => void)[]>();
  style: Record<string, any> = { setProperty: (k: string, v: string) => { this.style[k] = v; } };
  dataset: Record<string, string> = {};
  value = ''; checked = false; disabled = false; selected = false;
  width = 0; height = 0;
  clientWidth = 1280; clientHeight = 800; offsetWidth = 360; offsetHeight = 200;
  classList = {
    contains: (s: string) => this.className.split(/\s+/).includes(s),
    add: (...ss: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...ss])].join(' '); },
    remove: (...ss: string[]) => { this.className = this.className.split(/\s+/).filter((s) => !ss.includes(s)).join(' '); },
    toggle: (s: string, force?: boolean) => { const on = force ?? !this.classList.contains(s); if (on) this.classList.add(s); else this.classList.remove(s); return on; },
  };
  constructor(public tagName: string) { super(1, tagName.toUpperCase()); this.tagName = this.nodeName; }
  get children() { return this.childNodes.filter((n): n is DomElement => n instanceof DomElement); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(s: string) { this.setAttribute('class', s); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); if (k === 'value') this.value = v; }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  toggleAttribute(k: string, on: boolean) { if (on) this.setAttribute(k, ''); else this.removeAttribute(k); }
  get innerHTML(): string { return this.html + this.childNodes.map((n) => n instanceof DomElement ? n.outerHTML : n.textContent).join(''); }
  set innerHTML(s: string) { this.replaceChildren(); this.html = s; }
  get outerHTML() { return `<${this.tagName} ${JSON.stringify(this.attributes)}>${this.innerHTML}</${this.tagName}>`; }
  override replaceChildren(...ns: DomNode[]) { this.html = ''; super.replaceChildren(...ns); }
  addEventListener(k: string, fn: (e: unknown) => void) { const es = this.events.get(k) ?? []; es.push(fn); this.events.set(k, es); }
  click() { if (!this.disabled) for (const fn of this.events.get('click') ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
  querySelectorAll(selector: string): DomElement[] {
    // The passive renderers use simple tag/class selectors (.win-ic, .sw-l); tests also use buttons.
    const match = (e: DomElement) => selector.startsWith('.') ? selector.slice(1).split('.').every((s) => e.classList.contains(s)) : e.tagName === selector.toUpperCase();
    return this.children.flatMap((c) => [...(match(c) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): DomElement | null { return selector === 'button' && this.tagName === 'BUTTON' ? this : this.parentElement?.closest(selector) ?? null; }
  focus() { dom.activeElement = this; }
  blur() { if (dom.activeElement === this) dom.activeElement = null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 360, bottom: 200, width: 360, height: 200 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  getContext() { return new Proxy({} as Record<string, unknown>, { get: (t, k) => t[String(k)] ?? (() => {}), set: (t, k, v) => { t[String(k)] = v; return true; } }); }
}
const dom = {
  activeElement: null as DomElement | null,
  body: new DomElement('body'), documentElement: new DomElement('html'),
  createElement: (tag: string) => new DomElement(tag),
  createElementNS: (_ns: string, tag: string) => new DomElement(tag),
  createTextNode: (s: string) => new DomNode(3, '#text', s),
};
const storage = new Map<string, string>();
Object.assign(globalThis, {
  Node: DomNode, Element: DomElement, HTMLElement: DomElement, document: dom,
  window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} },
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

const saved = (g: Game) => JSON.stringify(serialize(g));
let calls = 0;
const failures: string[] = [];
function same(actual: string, expected: string, label: string) {
  if (actual === expected) return;
  let at = 0; while (actual[at] === expected[at] && at < Math.min(actual.length, expected.length)) at++;
  failures.push(`${label}: save differs at ${at}\nbefore: ${expected.slice(Math.max(0, at - 60), at + 120)}\nafter:  ${actual.slice(Math.max(0, at - 60), at + 120)}`);
  if (failures.length <= 10) console.log('FAIL ' + failures.at(-1));
}
function pure(g: Game, label: string, fn: () => void) {
  const before = saved(g), walkVersion = g.stations.walkVersion;
  fn();
  same(saved(g), before, label);
  if (g.stations.walkVersion !== walkVersion) failures.push(`${label}: walkVersion changed from ${walkVersion} to ${g.stations.walkVersion}`);
  calls++;
}
function uiFor(g: Game): UI {
  dom.body.replaceChildren(); dom.activeElement = null;
  const root = h('div'); dom.body.appendChild(root as unknown as DomNode);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.01, 5000);
  camera.position.set(g.world.size / 2, 350, g.world.size / 2);
  camera.lookAt(g.world.size / 2, 0, g.world.size / 2); camera.updateMatrixWorld();
  const ui = {
    game: g, root, wm: new WindowManager(root), following: null, catchmentStation: -1, lineBroken: new Map(),
    tools: { tool: 'inspect', lineEditId: -1, setTool() {}, refreshHover() {} },
    mapModes: { mode: 'none', toggle() {} }, hud: { avoidRects: () => [], onToolChange() {} },
    checklist: { hidden: false }, reduceTransparency: false,
    renderer: { camera, controls: { distance: 100 }, overlay: { setSignalGhosts() {} },
      terrain: { uniforms: { uGrid: { value: 0 } } },
      settings: { shadows: true, shadowQuality: 'high', resolution: 'auto', pixelRatio: 1 }, applySettings() {} },
    sound() {}, toast() {}, centerOn() {}, follow() {}, setCatchment() {}, onLineEdited() {},
    kv: (k: string, v: any) => h('div', { class: 'kv' }, h('span', null, k), h('span', null, v)),
    stationLink: (id: number) => h('a', null, g.stations.get(id)?.name ?? '?'),
    ownerTag: (id: number) => h('span', null, g.company(id).name),
    lineChip: (l: any) => lineTag(g, l), financeActions: () => h('div'),
    posOf: (v: any) => { const p = { x: 0, y: 0, z: 0 }; v.worldPos(p); return [p.x, p.z]; },
  } as unknown as UI;
  ui.openLine = (id) => openLine(ui, id); ui.openStation = (id) => openStation(ui, id);
  ui.openTown = (id) => openTown(ui, id); ui.openVehicle = (id) => openVehicle(ui, id);
  ui.openPurchase = (kind, dep, line) => openPurchase(ui, kind, dep, line);
  ui.openAutoSignal = (target) => openAutoSignal(ui, target ?? { all: true });
  return ui;
}
function allTabs(g: Game, ui: UI, id: string, label: string) {
  const w = ui.wm.get(id); assert.ok(w, `${label}: window opened`);
  // Click the actual tab controls: covers only tabs the renderer offered, including foreign stations.
  const tabs = [...w.tabsEl.children] as unknown as DomElement[];
  for (const tab of tabs) pure(g, `${label}/${tab.textContent}`, () => tab.click());
}
function sweep(g: Game, label: string) {
  const ui = uiFor(g), before = saved(g);
  const hover = new HoverCard(ui) as unknown as { content: (t: HoverTarget) => unknown; set: (t: HoverTarget) => void; update: (dt: number) => void };
  const show = (name: string, fn: () => void) => pure(g, `${label}: ${name}`, fn);
  const hoverOn = (kind: HoverTarget['kind'], id: number) => show(`hover ${kind} ${id}`, () => {
    assert.ok(hover.content({ kind, id })); // Probe's direct content check, even if the anchor is offscreen.
    hover.set({ kind, id }); hover.update(0.5); // Also exercise the public projection/update path.
  });
  // These two reads must be pure even on their first, cold-cache call.
  for (const town of g.towns.list) { show(`town ${town.id}`, () => openTown(ui, town.id)); hoverOn('town', town.id); }
  for (const l of g.lines.all()) {
    show(`line ${l.id}`, () => openLine(ui, l.id));
    if (l.owner === PLAYER) {
      const body = ui.wm.get('line-' + l.id)!.body as unknown as DomElement;
      const join = body.querySelectorAll('button').find((b) => b.textContent === (l.kind === 'rail' ? 'Join with line…' : 'Connect with line…'));
      assert.ok(join); show(`join preview ${l.id}`, () => join.click());
    }
    allTabs(g, ui, 'line-' + l.id, `${label}: line ${l.id}`);
  }
  for (const st of g.stations.map.values()) {
    show(`station ${st.id}`, () => openStation(ui, st.id));
    allTabs(g, ui, 'station-' + st.id, `${label}: station ${st.id}`); hoverOn('station', st.id);
  }
  for (const v of g.vehicles.all()) { show(`vehicle ${v.id}`, () => openVehicle(ui, v.id)); hoverOn('vehicle', v.id); }
  for (const d of g.depots.map.values()) {
    show(`depot ${d.id}`, () => openDepot(ui, d.id)); hoverOn('depot', d.id);
    show(`purchase ${d.kind}/${d.id}`, () => openPurchase(ui, d.kind, d.id, null));
  }
  for (const e of g.world.net.edges.values()) show(`edge ${e.id}`, () => openEdge(ui, e.id));
  for (const kind of ['rail', 'road', 'tram'] as const) show(`purchase ${kind}/line`, () => openPurchase(ui, kind, null, null));
  for (const [name, fn] of [
    ['lines', openLines], ['vehicles', openVehicles], ['towns', openTowns], ['finances', openFinances],
    ['companies', openCompetitors], ['access', openTrackAccess], ['menu', openMenu], ['settings', openSettings], ['help', openHelp],
  ] as const) show(name, () => fn(ui));
  allTabs(g, ui, 'finances', label + ': finances'); allTabs(g, ui, 'competitors', label + ': companies');
  show('save list', () => openSaveLoad(ui, 'save')); show('load list', () => openSaveLoad(ui, 'load'));
  show('new AI settings', () => openAIConfig(ui, null));
  for (const co of g.companies) if (co.id !== PLAYER) {
    show(`AI settings ${co.id}`, () => openAIConfig(ui, co.id));
    show(`investment ${co.id}`, () => openInvest(ui, co.id)); show(`buyout ${co.id}`, () => openBuyout(ui, co.id));
  }
  show('signal network preview', () => openAutoSignal(ui, { all: true }));
  for (const l of g.lines.all()) if (l.kind === 'rail') show(`signal line preview ${l.id}`, () => openAutoSignal(ui, { line: l.id }));
  // refreshAll catches renderer exceptions internally; surface them instead of accepting missing coverage.
  const logError = console.error;
  console.error = (...args) => { throw new Error(`Window refresh failed: ${args.join(' ')}`); };
  try { for (let i = 0; i < 3; i++) show(`refreshAll ${i}`, () => ui.wm.refreshAll()); }
  finally { console.error = logError; }
  show('memo pruning', () => pruneMemos(g));
  same(saved(g), before, label + ': aggregate UI purity');
  show('close all', () => { for (const w of ui.wm.wins.values()) w.el.remove(); ui.wm.closeAll(); });
  console.log(`${label}: ${g.lines.map.size} lines, ${g.stations.map.size} stations, ${g.vehicles.map.size} vehicles`);
}

function fixture(seed: number) {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 60, 150, 0, new Set(), 1, () => {}) ?? placeAndConnect(g, 150, 240, 0, new Set(), 1, () => {});
  assert.ok(pr, `seed ${seed}: fixture railway`);
  const dep = depotBehind(g, pr.A, pr.B, 0), line = g.lines.create('rail'); line.stops = [pr.A.id, pr.B.id];
  const train = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!], line.id);
  assert.notEqual(typeof train, 'string', 'fixture train');
  const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0], sites = busStopSites(g, town, 0, 12, 30);
  assert.equal(sites.length, 2, 'fixture bus sites');
  const road = g.lines.create('road'); road.stops = sites.map(([x, z]) => addBusStop(g, x, z, 0));
  const bd = roadDepotNear(g, ...sites[0], 0);
  assert.notEqual(typeof g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, road.id), 'string', 'fixture bus');
  for (let k = 0; k < TICKS_PER_DAY * 180; k++) g.stepTick();
  // Economic construction may finish later than the original six-month fixture. Wait for real foreign service
  // before testing foreign windows, without forcing a project or replacing the required coverage.
  while (g.day < 720 && !g.lines.all().some((l) => l.owner !== PLAYER && l.vehicles.length)) g.stepTick();
  assert.ok(g.lines.all().some((l) => l.owner !== PLAYER && l.vehicles.length), `seed ${seed}: AI network has service`);
  assert.equal(fails.length, 0, 'shared fixture checks');
  return g;
}

// Every mail surface with unflushed access edits: cold map first, or warm panels first; pause and running modes.
// The original, an untouched control, and a game loaded while the edit is pending must continue identically.
{
  const base = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 2000 });
  base.economy.money = 1e9;
  const pr = placeAndConnect(base, 80, 160, 0, new Set(), 1, () => {}); assert.ok(pr);
  const depot = depotBehind(base, pr.A, pr.B, 0), line = base.lines.create('rail'); line.stops = [pr.A.id, pr.B.id];
  const cars = ['diesel_b', 'van_ic', 'coach_ic', 'coach_ic'].map((id) => MODEL_BY_ID.get(id)!);
  assert.equal(cars[0]?.kind, 'loco', JSON.stringify(cars.map((m) => [m?.id, m?.kind])));
  const train = base.vehicles.buyTrain(depot, [...cars], line.id); assert.notEqual(typeof train, 'string', String(train));
  for (let k = 0; k < TICKS_PER_DAY * 90; k++) base.stepTick();
  assert.ok(base.stations.all().every((st) => base.mail.accepts(st)), 'mail fixture accepts at both ends');
  assert.ok(base.towns.list.some((t) => t.mail), 'mail fixture has posted mail');
  // Include an entrance so the station's infrastructure tab exercises all of its walking-coverage reads.
  const forecourt = base.stations.forecourt(pr.A)!;
  pr.A.rail!.entrances.push({ ...forecourt, angle: pr.A.rail!.angle, kind: 'gate' });
  base.lines.rebuild();
  // A newly purchased train exercises real depot recompose previews before its first tick.
  const parked = base.vehicles.buyTrain(depot, [...cars], line.id); assert.notEqual(typeof parked, 'string', String(parked));
  base.flushNetworkChanges(); base.lines.flushCatchment();
  const initial = saved(base);
  for (const paused of [true, false]) for (const edit of ['remove', 'add'] as const) for (const mapFirst of [true, false]) {
    const g = deserialize(JSON.parse(initial)), control = deserialize(JSON.parse(initial));
    for (const game of [g, control]) {
      game.paused = paused;
      if (!mapFirst) mailView(game); // A previously used map must also leave pending edits alone.
      const net = game.world.net;
      if (edit === 'remove') for (const e of [...net.edges.values()]) { if (e.kind === 'road') net.removeEdge(e.id); }
      else {
        const a = net.addNode('road', 2, game.world.heightAt(2, 2), 2, 0, 0, -1);
        const b = net.addNode('road', 12, game.world.heightAt(12, 2), 2, 0, 0, -1);
        net.addEdge('road', a.id, b.id, bezLine(2, 2, 12, 2), new Float32Array([a.y, b.y]), [], 'street', -1);
      }
      game.onNetworkChanged();
    }
    const label = `mail ${paused ? 'paused' : 'running'}, pending road ${edit}, ${mapFirst ? 'cold map first' : 'warm panels first'}`;
    const pending = saved(g), loaded = deserialize(JSON.parse(pending)); loaded.paused = paused;
    same(saved(control), pending, label + ': untouched control');
    same(saved(loaded), pending, label + ': pending-edit save round trip');
    const ui = uiFor(g), show = (name: string, fn: () => void) => pure(g, label + ': ' + name, fn);
    // Real map toggles, card rendering and updates; only GPU drawing and minimap output are sinks.
    Object.assign(ui.renderer.overlay, { setArcs() {}, setShareRings() {}, setCatchments() {}, setDim() {} });
    Object.assign(ui.renderer, { labels: { townInfo: new Map() } });
    Object.assign(ui, { minimap: { setMapMode() {} } });
    const modes = Object.create(MapModes.prototype) as MapModes;
    Object.assign(modes, { ui, mode: 'none', demandLayer: 'pax', demand: null, mailDemand: null, demandT: 0, shares: new Map(), card: h('div'), onChange() {} });
    const map = () => {
      show('Mail map layer', () => { modes.set('demand'); modes.setDemandLayer('mail'); modes.update(1); });
      assert.ok(modes.mailDemand && modes.card.textContent?.includes('Mail'), 'real Mail card rendered');
      show('Mail map update', () => modes.update(1));
      show('Mail map close', () => modes.set('none'));
    };
    const panels = () => {
      for (const st of g.stations.all()) {
        show(`mail station walking overlay ${st.id}`, () => { catchStreets(g, st); });
        show(`station mail ${st.id}`, () => openStation(ui, st.id));
        assert.ok(ui.wm.get('station-' + st.id)!.body.textContent?.includes('Mail waiting'), 'station mail panel rendered');
        allTabs(g, ui, 'station-' + st.id, label + ': station ' + st.id);
      }
      for (const town of g.towns.list.filter((t) => t.mail)) {
        show(`town mail ${town.id}`, () => openTown(ui, town.id));
        assert.ok(ui.wm.get('town-' + town.id)!.body.textContent?.includes('Mail last month'), 'town mail panel rendered');
      }
      show('line mail', () => openLine(ui, line.id)); allTabs(g, ui, 'line-' + line.id, label + ': line');
      for (const v of g.vehicles.all()) {
        show(`van controls ${v.id}`, () => openVehicle(ui, v.id));
        assert.ok(ui.wm.get('veh-' + v.id)!.body.textContent?.includes('Mail vans'), 'van controls rendered');
      }
      show('mail window refresh', () => ui.wm.refreshAll());
    };
    if (mapFirst) { map(); panels(); } else { panels(); map(); }
    same(saved(g), pending, label + ': all mail reads');
    assert.ok(g.stations.all().every((st) => st.roadAccess), 'UI leaves the saved access flags untouched');
    if (paused) {
      for (const game of [g, control, loaded]) game.update(0);
      same(saved(g), saved(control), label + ': paused construction flush');
      same(saved(g), saved(loaded), label + ': loaded paused construction flush');
    }
    for (let k = 0; k < TICKS_PER_DAY * 30; k++) {
      g.stepTick(); control.stepTick(); loaded.stepTick();
      if (k < TICKS_PER_DAY * 2 || k % TICKS_PER_DAY === 0) {
        same(saved(g), saved(control), label + ': UI replay tick ' + k);
        same(saved(g), saved(loaded), label + ': pending-edit loaded replay tick ' + k);
      }
    }
    assert.ok(g.stations.all().every((st) => st.roadAccess === (edit === 'add')), 'simulation refreshes access deterministically');
    console.log(label + ': pure views and 30-day original/control/save-load replay');
  }
}

for (const seed of [7, 11, 23]) {
  const initial = saved(fixture(seed));
  for (const paused of [true, false]) {
    const g = deserialize(JSON.parse(initial)), control = deserialize(JSON.parse(initial));
    // Identical construction on both copies: update population and queue fresh shares while time is stopped.
    for (const game of [g, control]) {
      game.paused = paused;
      const building = [...game.world.buildings.values()].find((b) => b.pop > 0)!;
      building.pop += 5; game.world.touchBuilding(building);
      game.lines.rebuild();
      const provisional = game.lines.create('rail');
      delete provisional.code; // Raw legacy/provisional data must display a fallback without self-repair.
    }
    const label = `seed ${seed}, ${paused ? 'paused' : 'running'}, dirty catchments`;
    assert.ok(g.lines.catchmentDirty);
    assert.equal(saved(g), saved(control), label + ': identical starting games');
    sweep(g, label);
    const provisional = g.lines.all().at(-1)!;
    pure(g, label + ': fallback', () => assert.equal(lineCodeOf(g, provisional), 'R' + provisional.num));
    assert.equal(provisional.code, undefined, 'UI leaves uncoded provisional line untouched');
    assert.ok(g.lines.catchmentDirty, 'UI leaves catchment refresh pending');
    // Cache warming and window order must not affect the following committed simulation ticks either.
    for (let k = 0; k < TICKS_PER_DAY * 2; k++) {
      g.stepTick(); control.stepTick();
      same(saved(g), saved(control), label + ': replay tick ' + k);
    }
    assert.ok(!g.lines.catchmentDirty, 'simulation completes the pending refresh');
  }
}

// Empty-region reads, immediate allocation, old empty-line migration, and station badge getters.
const empty = Game.create({ size: 128, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
pure(empty, 'empty demand view', () => { assert.equal(demandView(empty).regions.length, 0); });
const codes = [empty.lines.create('rail'), empty.lines.create('rail')];
assert.ok(codes.every((l) => l.code), 'rail codes allocated at creation, before stops or UI');
assert.equal(new Set(codes.map((l) => l.code)).size, 2, 'provisional codes unique');
const legacy = JSON.parse(saved(empty)); delete legacy.lines[0].code;
const migrated = deserialize(legacy), m = migrated.lines.get(codes[0].id)!;
assert.ok(m.code, 'empty legacy rail line gets a code during load');
assert.equal(migrated.lines.get(codes[1].id)!.code, codes[1].code, 'migration keeps existing codes');
pure(migrated, 'migrated code getter', () => assert.ok(lineCodeOf(migrated, m)));
assert.equal(saved(deserialize(JSON.parse(saved(migrated)))), saved(migrated), 'migrated save round trip');

// Vehicle memo kinds from the validation probe must retain live entries and release sold vehicles.
const memoGame = fixture(7), vehicle = memoGame.vehicles.all().find((v) => v.owner === PLAYER)!;
const tokens = ['van-add', 'van-drop'].map((kind) => ({ name: `${kind}:${vehicle.id}`, value: {} }));
for (const t of tokens) assert.equal(memo(memoGame, t.name, 'key', () => t.value), t.value);
pure(memoGame, 'prune live vehicle memos', () => pruneMemos(memoGame));
for (const t of tokens) assert.equal(memo(memoGame, t.name, 'key', () => ({})), t.value, 'live memo retained');
memoGame.vehicles.sell(vehicle.id);
pure(memoGame, 'prune sold vehicle memos', () => pruneMemos(memoGame));
for (const t of tokens) assert.notEqual(memo(memoGame, t.name, 'key', () => ({})), t.value, 'sold memo removed');
const station = memoGame.stations.all().find((st) => st.rail)!;
const line = memoGame.lines.create('rail'); line.stops = [station.id];
pure(memoGame, 'unnumbered station getters', () => {
  memoGame.lines.stationCode(line.id, station.id); stationBadges(memoGame, station.id);
});
assert.equal(line.numbers, undefined, 'badge reads do not assign station numbers');

assert.equal(failures.length, 0, failures.join('\n'));
console.log(`PASS: ${calls} passive UI checks; every mail view with pending road edits and exact 30-day replay; seeds 7, 11, 23 paused/running with AI networks, dirty catchments and exact subsequent replay; code migration and vehicle memo pruning.`);
