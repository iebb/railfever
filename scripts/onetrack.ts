// Unified physical track, independent station styles, wire inheritance and exact fixed-step replay.
// Bundle as onetrack.mjs; run from the bundle directory with node.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Game, TICK } from '../src/game/game';
import { TRACK_TYPES, ELECTRIFY, KMH_TO_UPS } from '../src/game/constants';
import { planEdge, commitProposal, curveSpeed } from '../src/game/construction';
import { electrify } from '../src/game/build-ops';
import { serialize, deserialize } from '../src/game/save';
import { railPartMode, railModeOf, planStationUpgrade, commitStationUpgrade } from '../src/game/stations';
import { Train, consistRule, ruleAllows, makeSeg, lineCompatibility } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { h } from '../src/ui/dom';
import { Hud } from '../src/ui/hud';
import { Tools, TOOL_INFO } from '../src/ui/tools';
import type { ToolId } from '../src/ui/tools';
import type { UI } from '../src/ui/ui';
import { openEdge, openPurchase } from '../src/ui/win-info';
import { WindowManager } from '../src/ui/windows';
import { Overlay } from '../src/render/overlay';
import { flatGame, station, endNode, depotFor, nodeSnap, free, railOpts, runTrains } from './stationlib';
import { terrainFit } from './terrainfit';

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
  replaceChildren(...ns: (DomNode | string)[]) { for (const n of [...this.childNodes]) this.removeChild(n); for (const n of ns) this.appendChild(typeof n === 'string' ? new DomNode(3, '#text', n) : n); }
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
  override replaceChildren(...ns: (DomNode | string)[]) { this.html = ''; super.replaceChildren(...ns); }
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
  window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, setTimeout: () => 1, clearTimeout() {} },
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

const saved = (g: Game) => JSON.stringify(serialize(g));
let checks = 0;
function check(ok: unknown, msg: string) { assert.ok(ok, msg); checks++; }
const M = (id: string) => { const m = MODEL_BY_ID.get(id); assert.ok(m, id); return m; };

console.log('one physical track and geometry speeds');
for (const id of ['highspeed', 'metro', 'lightrail']) {
  check(TRACK_TYPES[id] === TRACK_TYPES.electric, `${id}: deprecated alias is wired track`);
  check(curveSpeed(12, id) === curveSpeed(12, 'standard'), `${id}: same curve speed`);
}
check(TRACK_TYPES.standard.minRadius === 3 && TRACK_TYPES.standard.maxGrade === 0.07 && TRACK_TYPES.standard.speed === 400, 'city geometry and high-speed cap');
check(TRACK_TYPES.standard.costPerUnit === 7500 && TRACK_TYPES.standard.maintPerUnit === 300 && TRACK_TYPES.standard.formation === 1, 'common standard formation and costs');
check(TRACK_TYPES.electric.costPerUnit - TRACK_TYPES.standard.costPerUnit === ELECTRIFY.costPerUnit, 'wire adds the Electrify price');
const g = flatGame(384), net = g.world.net;
const plain = planEdge(g, free(g, 30, 50), free(g, 80, 50), railOpts());
check(plain.ok && plain.opts.type === 'standard' && !commitProposal(g, plain), 'free build: track without wire');
const e = [...net.edges.values()].find((e) => e.kind === 'rail')!;
const beforeWire = saved(g), money = g.economy.money;
const quote = electrify(g, [e.id], 0, true);
check(quote.changed === 1 && quote.cost === Math.round(e.len * ELECTRIFY.costPerUnit) && saved(g) === beforeWire, 'Electrify quotes without changing the game');
check(!electrify(g, [e.id], 0).error && e.type === 'electric' && money - g.economy.money === quote.cost, 'Electrify adds only wires and charges its quote');
const input = railOpts(), inputJSON = JSON.stringify(input);
const from = nodeSnap(g, e.b, 'rail');
const beforePlan = saved(g);
const extension = planEdge(g, from, free(g, 130, 50), input);
check(saved(g) === beforePlan && JSON.stringify(input) === inputJSON, 'inherited-wire preview is read-only');
check(extension.ok && extension.opts.type === 'electric', 'node extension inherits wire');
e.type = 'standard';
const bare = planEdge(g, from, free(g, 130, 50), input);
e.type = 'electric';
check(Math.abs(extension.cost - bare.cost - extension.stats.len * ELECTRIFY.costPerUnit) <= 1, 'preview includes the exact wire price');
check(!commitProposal(g, extension) && [...net.edges.values()].every((e) => e.type === 'electric'), 'committed extension carries its preview wire');
const join = planEdge(g, free(g, 210, 50), nodeSnap(g, e.b, 'rail'), input);
check(join.opts.type === 'electric', 'wire is inherited from the destination too');
const branch = planEdge(g, { kind: 'edge', edge: e.id, s: e.len / 2, x: 55, z: 50, y: 3 }, free(g, 100, 72), input);
check(branch.opts.type === 'electric', 'branch at an edge inherits wire');
for (const id of ['highspeed', 'metro', 'lightrail']) {
  const z = 100 + ['highspeed', 'metro', 'lightrail'].indexOf(id) * 40;
  const p = planEdge(g, free(g, 30, z), free(g, 80, z), railOpts(0, 1, { type: id }));
  check(p.ok && p.opts.type === 'electric' && !commitProposal(g, p), `${id}: builds the common wired track`);
}
check([...net.edges.values()].every((e) => e.kind !== 'rail' || ['standard', 'electric'].includes(e.type)), 'builds never store legacy types');

const steep = planEdge(g, free(g, 30, 310), free(g, 45, 310), railOpts(0, 1, { heightOffset: -0.8 }));
const firstSteep = net.nextEdge;
check(steep.ok && steep.stats.maxGrade > 0.06 && !commitProposal(g, steep), 'city alignment can use steep grades on the common track');
const fit = terrainFit(g, [...net.edges.values()].filter((e) => e.id >= firstSteep));
check(fit.covered === 0 && fit.floating === 0, 'earthworks keep steep ground track clear of the terrain');

// Exercise the real renderer, including the inherited contact wire in the construction ghost.
const overlay = new Overlay(g);
overlay.setProposal(bare);
const bareVertices = (overlay as any).ghost.mesh.geometry.attributes.position.count;
overlay.setProposal(extension);
const wiredVertices = (overlay as any).ghost.mesh.geometry.attributes.position.count;
check(wiredVertices > bareVertices, 'wired preview draws a contact wire above the rail');

const crossings = flatGame(384);
const road = planEdge(crossings, free(crossings, 90, 40), free(crossings, 90, 140), { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: 'auto', owner: 0 });
check(road.ok && !commitProposal(crossings, road), 'crossing road built');
const crossingTrack = planEdge(crossings, free(crossings, 40, 90), free(crossings, 140, 90), railOpts(0, 1, { crossing: 'level' }));
check(crossingTrack.ok && crossingTrack.stats.speed === 160 && !commitProposal(crossings, crossingTrack), 'common track permits a level crossing and previews its speed');
const rail = [...crossings.world.net.edges.values()].find((e) => e.kind === 'rail')!;
check(Math.abs(makeSeg(crossings, rail, 1).limit / KMH_TO_UPS - 160) < 1e-9, 'train speed follows the level-crossing limit');
const fast = planEdge(crossings, free(crossings, 40, 120), free(crossings, 140, 120), railOpts(0, 1, { designSpeed: 300 }));
check(fast.ok && fast.crossings.every((c) => c.mode !== 'level'), 'fast alignment chooses road separation on the same track');

console.log('station styles belong to parts; legacy v3 saves');
const stGame = flatGame(384);
const styles = ['mainline', 'metro', 'lightrail'] as const;
const sts = styles.map((mode, i) => station(stGame, 60 + i * 110, 124, Math.PI / 2, mode === 'metro' ? 12 : 8, 2, 0, { mode, trackType: 'electric' })!);
check(sts.every(Boolean), 'all station styles built on the same wired track');
check(sts.map((s) => railPartMode(s.rail!)).join() === styles.join(), 'each part reports its own style');
check(sts[1].rail!.psd && sts[1].rail!.level === 'underground' && sts[2].rail!.platformStyle === 'side', 'metro/light-rail defaults stay with station style');
check(railPartMode({ ...sts[0].rail!, mode: undefined, trackType: 'metro' }) === 'metro', 'railPartMode keeps the legacy fallback');
const partGame = flatGame(256);
const part = station(partGame, 124, 124, Math.PI / 2, 12, 2, 0, { trackType: 'standard', mode: 'metro', level: 'ground', through: 1 })!.rail!;
check(!electrify(partGame, part.edges, 0).error && part.trackType === 'standard' && railPartMode(part) === 'metro', 'partial station wiring preserves its style and unwired through track');
check(!electrify(partGame, part.throughEdges, 0).error && part.trackType === 'electric' && railPartMode(part) === 'metro', 'fully wired station retains wire for future rebuilding');
const upgrade = planStationUpgrade(stGame, sts[2].id, { length: 10 });
check(upgrade.ok && !commitStationUpgrade(stGame, upgrade) && railPartMode(sts[2].rail!) === 'lightrail', 'station upgrade preserves its independent style');
for (const version of ['2.7.0', '2.8.0']) {
  const d = JSON.parse(saved(stGame)); d.game = version;
  for (const [i, st] of d.stations.entries()) {
    delete st.rail.mode;
    st.rail.trackType = ['highspeed', 'metro', 'lightrail'][i];
    for (const edge of [...st.rail.edges, ...st.rail.throughEdges]) d.net.edges.find((e: any) => e.id === edge).type = st.rail.trackType;
  }
  const original = JSON.stringify(d), migrated = deserialize(d);
  check(JSON.stringify(d) === original, `${version}: load leaves its source unchanged`);
  check([...migrated.world.net.edges.values()].every((e) => e.kind !== 'rail' || e.type === 'electric'), `${version}: old rail ids become wired track`);
  check(migrated.stations.all().map((s) => railPartMode(s.rail!)).join() === styles.join(), `${version}: old station styles retained`);
  check(migrated.stations.all().every((s, i) => s.rail!.psd === stGame.stations.all()[i].rail!.psd), `${version}: screen doors retained`);
  const reloaded = deserialize(JSON.parse(saved(migrated)));
  check(saved(reloaded) === saved(migrated), `${version}: migrated save round trip exact`);
}

console.log('train traction and running; exact replay');
let replayGame: Game | undefined;
for (const [kind, cars] of [
  ['steam', [M('steam_b'), M('coach_wood')]], ['diesel', [M('diesel_b'), M('coach_ic')]],
  ['electric', [M('bullet'), M('coach_ic')]], ['EMU', [M('emu_b')]],
  ['metro', [M('metro_b')]], ['light rail', [M('lrv_b')]], ['high speed', [M('hsr_e')]],
] as const) {
  const h = flatGame(384), A = station(h, 60, 120, Math.PI / 2, 16, 1)!, B = station(h, 300, 120, Math.PI / 2, 16, 1)!;
  const p = planEdge(h, nodeSnap(h, endNode(h, A, 0, true), 'rail'), nodeSnap(h, endNode(h, B, 0, false), 'rail'), railOpts());
  check(p.ok && !commitProposal(h, p), `${kind}: common line built`);
  const depot = depotFor(h, A, B), line = h.lines.create('rail'); line.stops = [A.id, B.id]; h.lines.rebuild();
  const wire = cars.some((m) => m.traction === 'electric');
  check(consistRule([...cars]).wire === wire, `${kind}: only electric traction requests wire`);
  check((lineCompatibility(h, line.id, [...cars]) === null) === !wire, `${kind}: plain track compatibility`);
  check(ruleAllows(consistRule([...cars]), { ...h.world.net.edges.values().next().value!, type: 'electric' }), `${kind}: wired track compatibility`);
  if (wire) check(!electrify(h, [...h.world.net.edges.keys()], 0).error, `${kind}: line electrified`);
  const train = h.vehicles.buyTrain(depot, [...cars], line.id);
  check(train instanceof Train, `${kind}: train bought`);
  if (!(train instanceof Train)) continue;
  const r = runTrains(h, [train], 480), count = r.arrivals.get(train.id)?.length ?? 0;
  check(count >= 4 && train.state !== 'noroute', `${kind}: runs on unified track (${count} stops)`);
  console.log(`  ${kind}: ${count} stops, wire ${wire}`);
  if (kind === 'metro') replayGame = h;
}
check(TICK === 0.05, 'fixed-step game uses 0.05 s ticks');
assert.ok(replayGame);
const oldRunning = JSON.parse(saved(replayGame));
oldRunning.game = '2.7.0';
delete oldRunning.congestionTold;
for (const e of oldRunning.net.edges) if (e.kind === 'rail' && e.type === 'electric') e.type = 'highspeed';
for (const st of oldRunning.stations) if (st.rail) { delete st.rail.mode; st.rail.trackType = 'highspeed'; }
const migratedRunning = deserialize(oldRunning);
check(saved(migratedRunning) === saved(replayGame), 'legacy running train migrates to the same canonical state');
const copy = deserialize(JSON.parse(saved(replayGame)));
check(saved(copy) === saved(replayGame), 'running train save round trip exact');
for (let tick = 1; tick <= 2400; tick++) {
  replayGame.stepTick(); copy.stepTick(); migratedRunning.stepTick();
  if (tick === 1 || tick % 40 === 0) check(saved(copy) === saved(replayGame) && saved(migratedRunning) === saved(replayGame), `exact replay and migrated replay at tick ${tick}`);
}

console.log('DOM: no track selector or track-type chips in any tool');
const root = h('div'), canvas = h('canvas');
const noop = () => {};
const noops = new Proxy({}, { get: () => noop });
const ui = {
  game: g, root, wm: new WindowManager(root),
  renderer: { renderer: { domElement: canvas }, fps: 60, overlay: noops, terrain: { uniforms: {} } },
  mapModes: noops, sound: noop, syncCompactPanels: noop,
  kv: (k: string, v: any) => h('div', { class: 'kv' }, h('span', null, k), h('span', null, v)),
  stationLink: (id: number) => h('a', null, g.stations.get(id)?.name ?? '?'),
  ownerTag: () => h('span'),
} as unknown as UI;
const tools = new Tools(ui); ui.tools = tools;
const hud = new Hud(ui); ui.hud = hud;
tools.onToolChange = () => hud.onToolChange();
for (const id of Object.keys(TOOL_INFO) as ToolId[]) {
  tools.setTool(id);
  const nodes = [root as unknown as DomElement, ...(root as unknown as DomElement).querySelectorAll('div')];
  check(nodes.every((e) => e.getAttribute('aria-label') !== 'Track type' && !e.classList.contains('typepick')), `${id}: no track type picker`);
  const labels = (root as unknown as DomElement).querySelectorAll('.opt-l').map((e) => e.textContent);
  check(!labels.includes('Track'), `${id}: no platform-track selector`);
  check((root as unknown as DomElement).querySelectorAll('.ttype').length === 0 && (root as unknown as DomElement).querySelectorAll('.mtag').length === 0, `${id}: no type chips`);
}
tools.setTool('rail'); tools.proposal = bare; hud.update(0.05);
const plainSpec = (root as unknown as DomElement).querySelector('.tc-spec')!.textContent;
tools.proposal = extension; hud.update(0.05);
const wiredSpec = (root as unknown as DomElement).querySelector('.tc-spec')!.textContent;
check(wiredSpec !== plainSpec && wiredSpec.includes('overhead wire'), 'tool card refreshes wire and price when the destination supplies wire');
tools.proposal = null;
tools.setTool('metro');
check(tools.buildOptions().type === 'electric' && tools.tracks === 2 && tools.railLevel === 'underground', 'urban preset supplies double underground track with wires');
tools.setTool('metro-station');
const light = (root as unknown as DomElement).querySelectorAll('button').find((e) => e.textContent === 'Light rail');
assert.ok(light); light.click();
check(tools.stationMode() === 'lightrail' && tools.stationTrackType() === 'electric' && tools.stationLevel === 'ground', 'station-style control changes defaults without changing the physical track');
openEdge(ui, e.id);
check(ui.wm.get('edge')?.body.textContent?.includes('Overhead wire'), 'track window reports wire as an attribute');
openPurchase(ui, 'rail');
check((root as unknown as DomElement).querySelectorAll('.mtag').every((tag) => !tag.hasAttribute('title') && !tag.querySelector('i')), 'purchase window has no track-type chips');
console.log(`ALL ${checks} CHECKS PASSED`);
