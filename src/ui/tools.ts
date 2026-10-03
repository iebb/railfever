// Map interaction tools: Transport-Fever-style track & road construction (click-click chains with live
// preview), stations, depots, signals, demolition, terraforming and object queries.
import * as THREE from 'three';
import type { UI } from './ui';
import { PLAYER } from '../game/game';
import { findSnap, planEdge, commitProposal, Snap, Proposal, BuildOptions, curveSpeed, levelCrossingAllowed } from '../game/construction';
import { toggleSignal, bulldoze, terraformBrush, depotSize, DepotPlan, DepotKind, addTramTracks, removeTramTracks, roadPath, tramUsable, electrify } from '../game/build-ops';
import { setSignal, signalsAlong, autoSignals, clearSignalsAlong, SIGNAL_SPACING, SIGNAL_COST } from '../game/signals';
import { planDoubleTrack, commitDoubleTrack, finishDoubleTrack, relocateDepot, DoublePlan, planStationOnTrack, commitStationOnTrack, OnTrackPlan, planConnection, commitConnection, ConnectionPlan, planRelevel, commitRelevel, RelevelPlan } from '../game/trackops';
import { openAutoSignal } from './win-signals';
import { computeLinePath } from './linepaths';
import { brush as brushVolume } from '../game/terraform';
import { bezOffset, startTangent, endTangent } from '../game/geom';
import { stationLayout, StationPlan, DEFAULT_PLATFORM_LENGTH, PLATFORM_LENGTH, STATION_HEIGHT, STATION_DEPTH, ENTRANCE_TYPES, relocateStation, ThroughMode, railModeOf, catchModeOf, entranceAlong, railWidth, entrancesGo } from '../game/stations';
import type { EntranceKind } from '../game/stations';
import { fmtMoney } from '../game/economy';
import { STATION_RADIUS, BUSSTOP_RADIUS, NetKind, TRACK_TYPES, ROAD_TYPES, RAIL, LINE_LEVEL, TRAM } from '../game/constants';
import { CROSS_LABEL, MarkerKind } from '../render/overlay';
import { distToRect } from '../game/world';
import type { NNode, NEdge } from '../game/network';
import { esc, svg } from './dom';
import { fmtLen, fmtHeight, fmtMult } from './format';
import { planStation, StationLevel, catchWalkLimit, catchStreets, planCatchStreets, catchStreetPop, drawCatchStreets, catchBonusOf, stationStyles, autoStationStyle } from './gameapi';
import { stopWalkingCatchment, walkLimit, walkingCatchment, entrancePlanCatchment } from '../game/catchment';
import type { FootRect } from '../render/overlay';
import { STATION_STYLES } from '../game/station-styles';
import { servesKind } from './win-lines';
import { accessState, policyText, requestAccessUI } from './win-access';

export type ToolId = 'inspect' | 'rail' | 'road' | 'tram' | 'station' | 'busstop' | 'tramstop' | 'depot-rail' | 'depot-road' | 'depot-tram' | 'signal' | 'bulldoze' | 'terraform' | 'line-edit' | 'double' | 'entrance'
  | 'metro' | 'metro-station' | 'electrify' | 'connect' | 'relevel';
export type CrossingPref = BuildOptions['crossing'];
/** Level a line is built at (BuildOptions.level). */
export type LineLevel = 'ground' | 'elevated' | 'underground';

/** Tools with their own remembered settings: the main-line and urban track tools, the two station tools. */
const PROFILE_KEYS = {
  rail: ['railType', 'railLevel', 'tracks', 'levelHeight', 'levelDepth'],
  station: ['stationType', 'stationLevel', 'stationLen', 'stationTracks', 'stationThrough', 'throughMode', 'stationOnLine', 'stationStyle', 'stationHeight', 'stationDepth'],
} as const;
const profileKind = (t: ToolId): keyof typeof PROFILE_KEYS | null => (t === 'rail' || t === 'metro' ? 'rail' : t === 'station' || t === 'metro-station' ? 'station' : null);
/** Track types offered by the main-line and the urban track tools. */
export const MAIN_TYPES = ['standard', 'electric', 'highspeed', 'metro', 'lightrail'].filter((t) => !!TRACK_TYPES[t]);
export const URBAN_TYPES = ['metro', 'lightrail'].filter((t) => !!TRACK_TYPES[t]);
/** Level of an edge from its structures: a full-length bridge (elevated) or tunnel (underground), else ground. */
export function edgeLevel(e: NEdge): LineLevel {
  for (const s of e.sections) if (s.s1 - s.s0 >= e.len * 0.9) return s.type === 'bridge' ? 'elevated' : 'underground';
  return 'ground';
}

export const TOOL_INFO: Record<ToolId, { name: string; hint: string }> = {
  inspect: { name: 'Inspect', hint: 'Click stations, vehicles, depots, towns, buildings or tracks for details.' },
  rail: { name: 'Build track', hint: 'Click to start, click again to build — construction continues from the new end with a smooth curve. Right-click, Esc or a long press ends the chain. Snap onto track ends to extend, onto track to branch. Hold Shift over a track to copy it as a parallel track.' },
  road: { name: 'Build road', hint: 'Click to start, click again to build — continues from the new end. Snap onto roads to create junctions. Connect to town streets so buses can reach them.' },
  station: { name: 'Train station', hint: 'Click to place. R / Shift+R or Alt+wheel rotate by 15°. Lines up with a nearby track end; connect its tracks with the track tool.' },
  busstop: { name: 'Bus stop', hint: 'Click on a road. Next to one of your train stations it joins it (passengers transfer).' },
  tram: { name: 'Tram tracks', hint: 'Add to roads: click a road, or press and drag along streets to lay tracks with overhead wire. New road builds a road with tracks; Remove takes your tracks up.' },
  tramstop: { name: 'Tram stop', hint: 'Click on a road with tram tracks. Next to one of your stations it joins it (passengers transfer).' },
  'depot-tram': { name: 'Tram depot', hint: 'Click next to a road with tram tracks: the depot faces it and connects itself. R / Shift+R or Alt+wheel rotates when away from roads.' },
  'depot-rail': { name: 'Train depot', hint: 'Click near a free end of your track (it snaps on), or place it and connect it with track. R / Shift+R or Alt+wheel rotates.' },
  'depot-road': { name: 'Bus depot', hint: 'Click next to a road: the depot faces it and connects itself. R / Shift+R or Alt+wheel rotates when away from roads.' },
  signal: { name: 'Signals', hint: 'Click a track to add a signal, click a signal to cycle two-way → one-way → one-way (reversed) → none. Drag along a track to place block signals at the chosen spacing (one-way signals face the drag direction). Remove mode or right-click takes signals away. Two-way signals suit single track with passing loops; one-way signals give double track a block every few hundred metres so trains can follow each other.' },
  double: { name: 'Double track', hint: 'Click one of your single tracks, or drag along it, to lay a second track beside it with switches at both ends (into a free platform where a station is). Directional double track gets one running direction per track, block signals and crossovers before stations. Pick the side, or let it try both.' },
  entrance: { name: 'Add entrance', hint: 'Add an entrance: beside a road near an underground or elevated station (pavilion or stair tower); beside the tracks of a ground station, on either side (a side entrance, a footbridge or underpass to both sides, or a gate at a platform end). Every entrance brings its own catchment area.' },
  bulldoze: { name: 'Demolish', hint: 'Click to remove an object, or drag a rectangle to clear an area. Other companies’ property is protected.' },
  terraform: { name: 'Terraform', hint: 'Hold the left button to raise or lower the ground under the brush. Level flattens to the height where you press.' },
  'line-edit': { name: 'Edit line', hint: 'Click stations (or their labels) to add them as stops. Press Esc or Done when finished.' },
  metro: { name: 'Urban rail', hint: 'Metro and light-rail track: underground (subway), elevated (lifted rails on a viaduct) or on the ground. Click to start, click to build — construction continues from the new end. Metro units and light-rail vehicles run on it; commuter EMUs run on metro and electrified track, so lines can through-run.' },
  'metro-station': { name: 'Urban station', hint: `Metro or light-rail station: underground by default, with street entrances; stations may be close together (~1 km). R / Shift+R or Alt+wheel rotates; it lines up with nearby track ends. Walking catchment along streets: metro ${fmtLen(walkLimit('metro'))}, light rail ${fmtLen(walkLimit('lightrail'))}, before station-building bonuses.` },
  electrify: { name: 'Electrify', hint: 'Click a track, or drag along a line, to string overhead wire: standard track becomes electrified track for electric locomotives and EMUs (platform tracks included). Works on other companies’ track you may use; it stays theirs.' },
  connect: { name: 'Connect tracks', hint: 'Click a point on one track, then a point on another: a connecting curve with turnouts into both tracks is planned within the curve and grade limits, and signalled where the track is. Click to build; Esc or right-click picks the first track again.' },
  relevel: { name: 'Re-level', hint: 'Drag along a stretch of your track to lift it onto a viaduct or sink it into a tunnel in place, with ramps at both ends; stations on it go with it, lines and signals are kept.' },
};

const CONSTRUCTION: ToolId[] = ['rail', 'road', 'tram', 'station', 'busstop', 'tramstop', 'depot-rail', 'depot-road', 'depot-tram', 'signal', 'bulldoze', 'terraform', 'double', 'entrance', 'metro', 'metro-station', 'electrify', 'connect', 'relevel'];
const SIGNAL_NAMES = ['none', 'two-way', 'one-way', 'one-way (reversed)'];
const DEG = Math.PI / 180;

/** Terrain shader uniforms used by the tools (cast: the terrain view owns the declaration). */
interface TerrainU {
  uGrid?: { value: number };
  uHiRect?: { value: THREE.Vector4 };
  uHiColor?: { value: THREE.Color };
  uHiOn?: { value: number };
  uCircle?: { value: THREE.Vector4 };
  uCircleColor?: { value: THREE.Color };
}

export interface Hit { kind: 'station' | 'depot' | 'building' | 'edge' | 'town'; id: number }

export { fmtHeight };

/** Content of the build tooltip card. */
interface Tip { title?: string; cost?: number; rows?: [string, string][]; err?: string[]; warn?: string[]; ok?: string[]; hint?: string }
const pill = (cls: string, ic: string, t: string) => `<span class="pill ${cls}">${svg(ic, 12)}${esc(t)}</span>`;
function tipHtml(c: Tip): string {
  let s = '';
  if (c.title) s += `<div class="tt-title">${c.title}</div>`;
  if (c.cost !== undefined) s += `<div class="tt-cost">${fmtMoney(c.cost)}</div>`;
  if (c.rows?.length) s += `<div class="tt-rows">${c.rows.map(([ic, t]) => `<div class="tt-row">${svg(ic, 14)}<span>${t}</span></div>`).join('')}</div>`;
  const pills = [...(c.err ?? []).map((t) => pill('err', 'warning', t)), ...(c.warn ?? []).map((t) => pill('warn', 'warning', t)), ...(c.ok ?? []).map((t) => pill('ok', 'check', t))];
  if (pills.length) s += `<div class="tt-pills">${pills.join('')}</div>`;
  if (c.hint) s += `<div class="tt-hint">${c.hint}</div>`;
  return s;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const snapKey = (s: Snap | null) => (s ? `${s.kind}:${s.node ?? ''}:${s.edge ?? ''}:${s.x.toFixed(2)},${s.z.toFixed(2)}` : '-');

export class Tools {
  tool: ToolId = 'inspect';
  // ---- construction options (edited by the options panel)
  /** track type (TRACK_TYPES id) and build level of the track tools; viaduct height / tunnel depth (LINE_LEVEL) */
  railType = 'standard';
  railLevel: LineLevel = 'ground';
  levelHeight = LINE_LEVEL.height.def;
  levelDepth = LINE_LEVEL.depth.def;
  roadType: 'street' | 'road' = 'road';
  tracks = 1;
  /** station tools: platform track type ('auto': as the track it lines up with) and building style ('auto': by era and town) */
  stationType = 'auto';
  stationStyle = 'shelter';
  /** connect tool: the point picked on the first track */
  conn: { edge: number; s: number; x: number; y: number; z: number } | null = null;
  private connPlan: { key: string; plan: ConnectionPlan } | null = null;
  private connAt = 0;
  /** re-level tool: the level to lift / sink to */
  relevelTo: LineLevel = 'elevated';
  private rlv: { key: string; chain: number[]; plan: RelevelPlan | null } | null = null;
  private elec: { key: string; ids: number[]; cost: number; changed: number; length: number; error: string | null } | null = null;
  /** remembered settings of the other tool of a pair (rail / urban rail, station / urban station) */
  private profiles = new Map<ToolId, Record<string, unknown>>([
    ['rail', { railType: 'standard', railLevel: 'ground', tracks: 1 }],
    ['metro', { railType: 'metro', railLevel: 'underground', tracks: 2 }],
    ['station', { stationType: 'auto', stationLevel: 'ground', stationLen: DEFAULT_PLATFORM_LENGTH, stationTracks: 1, stationThrough: 0, throughMode: 'middle', stationOnLine: false, stationStyle: 'shelter', stationDepth: STATION_DEPTH.def }],
    ['metro-station', { stationType: 'metro', stationLevel: 'underground', stationLen: PLATFORM_LENGTH.metro, stationTracks: 2, stationThrough: 0, stationOnLine: false, stationStyle: 'auto', stationDepth: STATION_DEPTH.metro }],
  ]);
  /** double track: one running direction per track with crossovers before stations (right- or left-hand) */
  directional = true;
  rightHand = true;
  heightOffset = 0;
  crossing: CrossingPref = 'auto';
  stationLen = DEFAULT_PLATFORM_LENGTH;
  stationTracks = 1;
  /** station level: on the ground, on a viaduct (height above the highest ground) or underground (depth) */
  stationLevel: StationLevel = 'ground';
  stationHeight = STATION_HEIGHT.def;
  stationDepth = STATION_DEPTH.def;
  /** station tool moving an existing station (its id), else null */
  relocating: number | null = null;
  /** depot tool moving an existing depot (its id), else null */
  relocatingDepot: number | null = null;
  /** entrance tool: the station getting a new entrance */
  entranceStation: number | null = null;
  /** entrance tool at a ground station: the kind of entrance (side hall, footbridge, underpass, platform-end gate) */
  entranceKind: EntranceKind = 'footbridge';
  /** signal tool: click places / cycles (or removes); a drag along a track places a series at the spacing */
  signalMode: 'place' | 'remove' = 'place';
  signalKind: 'oneway' | 'twoway' = 'oneway';
  signalSpacing = SIGNAL_SPACING;
  /** block signals (open line) or path signals (junctions, station entries); one-way ones may be passable from behind */
  signalClass: 'block' | 'path' = 'block';
  signalPass = false;
  /** station tool: through tracks without platforms (0-2) and where they go; insert into an existing line */
  stationThrough = 0;
  throughMode: ThroughMode = 'middle';
  stationOnLine = false;
  private onTrack: { key: string; plan: OnTrackPlan; edge: number } | null = null;
  private sigDrag: { edge: number; s0: number; dir: number; len: number } | null = null;
  /** double track tool: which side of the old track (auto tries right, then left) */
  doubleSide: 'auto' | 'right' | 'left' = 'auto';
  private dbl: { key: string; chain: number[]; plan: DoublePlan | null; flipped: boolean } | null = null;
  /** the directional-double-track note was shown for this chain */
  private finishTold = false;
  stationAngle = 0;
  autoAlign = true;
  depotAngle = 0;
  terraMode: 'raise' | 'lower' | 'level' = 'raise';
  /** tram tracks tool: lay tracks in existing roads, build a new road with tracks, or take tracks up */
  tramMode: 'add' | 'build' | 'remove' = 'add';
  brushRadius = 4;
  lineEditId: number | null = null;
  onToolChange: () => void = () => {};

  // ---- pointer state
  tooltip: HTMLDivElement;
  private client = { x: -1, y: -1 };
  private overMap = false;
  private ground: THREE.Vector3 | null = null;
  private down: { x: number; y: number; button: number; ground: THREE.Vector3 | null; moved: boolean; hadStart: boolean; id: number; touch: boolean; t: number } | null = null;
  private touches = new Set<number>();
  /** A touch placement is committed only after a second tap on this preview. */
  private touchPreview: { point: THREE.Vector3; client: { x: number; y: number }; signature: string } | null = null;
  private shift = false;
  private parallel: { edge: number; side: number; prop: Proposal } | null = null;
  private moveDirty = false;
  private camPos = new THREE.Vector3();
  private camQuat = new THREE.Quaternion();
  private netVer = -1;
  private rect: DOMRect | null = null;
  private v3 = new THREE.Vector3();

  // ---- track / road chain
  start: Snap | null = null;
  hoverSnap: Snap | null = null;
  proposal: Proposal | null = null;
  private planDirty = false;
  private planAt = 0;
  private planMs = 0;
  private planKey = '';
  // ---- other tool state
  private stationPlan: StationPlan | null = null;
  private depotPlan: DepotPlan | null = null;
  private dragRect: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private dozeAt = 0;
  private brush = { timer: 0, level: 0, cost: 0, err: false };
  private wheelAcc = 0;
  hoverStation: number | null = null;
  private vehPickAt = 0;
  private hoverVeh: number | null = null;

  constructor(private ui: UI) {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    ui.root.appendChild(this.tooltip);
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', (e) => {
      if (!this.down && !this.touchPreview && !(e.relatedTarget instanceof Node && this.tooltip.contains(e.relatedTarget))) { this.overMap = false; this.hideTip(); }
    });
    window.addEventListener('pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      if (this.down?.id === e.pointerId) { this.down = null; this.touchPreview = null; this.overMap = false; this.moveDirty = true; }
    });
    // Alt+wheel rotates stations and depots; Ctrl+wheel / pinch always reaches camera zoom.
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    const shift = (e: KeyboardEvent) => { if (e.key === 'Shift' && this.shift !== (e.type === 'keydown')) { this.shift = e.type === 'keydown'; if (this.railBuild) this.moveDirty = true; } };
    window.addEventListener('keydown', shift);
    window.addEventListener('keyup', shift);
    window.addEventListener('blur', () => { this.shift = false; });
  }

  get game() { return this.ui.game; }
  get overlay() { return this.ui.renderer.overlay; }
  private get canvas() { return this.ui.renderer.renderer.domElement; }
  private get terr(): TerrainU { return this.ui.renderer.terrain.uniforms as unknown as TerrainU; }
  get kind(): NetKind { return this.tool === 'road' || this.tool === 'tram' ? 'road' : 'rail'; }
  /** a track tool (main line or urban rail) */
  get railBuild() { return this.tool === 'rail' || this.tool === 'metro'; }
  /** a station tool (main line or urban) */
  get stationTool() { return this.tool === 'station' || this.tool === 'metro-station'; }
  get building() { return this.railBuild || this.tool === 'road' || (this.tool === 'tram' && this.tramMode === 'build'); }

  /** Construction advice shared by the preview and the options card; never changes build eligibility. */
  get constructionWarnings(): string[] {
    const p = this.parallel?.prop ?? this.proposal;
    return this.building && p ? this.planWarnings(p) : [];
  }

  buildOptions(): BuildOptions {
    const rail = this.railBuild;
    const o: BuildOptions = { kind: rail ? 'rail' : 'road', type: rail ? this.railType : this.roadType, tracks: rail ? this.tracks : 1, heightOffset: this.heightOffset, crossing: this.crossing, owner: PLAYER, tram: this.tool === 'tram' || undefined };
    if (rail && this.railLevel !== 'ground') { o.level = this.railLevel; o.levelHeight = this.levelHeight; o.levelDepth = this.levelDepth; }
    return o;
  }

  /** Keep each tool of a pair's settings (rail / urban rail, station / urban station) when switching between them. */
  private swapProfile(from: ToolId, to: ToolId) {
    if (from === to) return;
    const self = this as unknown as Record<string, unknown>;
    const fk = profileKind(from), tk = profileKind(to);
    if (fk) { const p: Record<string, unknown> = {}; for (const k of PROFILE_KEYS[fk]) p[k] = self[k]; this.profiles.set(from, p); }
    if (tk) { const p = this.profiles.get(to); if (p) for (const k of PROFILE_KEYS[tk]) if (k in p) self[k] = p[k]; }
  }

  // ------------------------------------------------------------------ tool switching
  /** Finish an edit, or discard its id when changing games. Clear it before canonicalizing. */
  endLineEdit(canonicalize = true) {
    const id = this.lineEditId;
    this.lineEditId = null;
    if (!canonicalize || id == null) return;
    const line = this.game.lines.map.get(id);
    if (line?.owner === PLAYER && !line.stops.length && !line.vehicles.length) {
      this.game.lines.delete(id); // freeNumber reuses this line's number on the next creation
      this.ui.wm.close('line-' + id);
    } else this.ui.onLineEdited(id);
  }

  setTool(t: ToolId) {
    if (this.tool === 'line-edit' && t !== 'line-edit') this.endLineEdit();
    // modes started from windows (moving a station / depot, adding an entrance) end with any tool change
    this.relocating = null;
    this.relocatingDepot = null;
    this.entranceStation = null;
    this.sigDrag = null;
    this.dbl = null;
    this.conn = null;
    this.connPlan = null;
    this.rlv = null;
    this.elec = null;
    this.swapProfile(this.tool, t);
    this.tool = t;
    this.start = null;
    this.proposal = null;
    this.planKey = '';
    this.planDirty = false;
    this.down = null;
    this.touchPreview = null;
    this.dragRect = null;
    this.stationPlan = null;
    this.depotPlan = null;
    this.hoverStation = null;
    this.parallel = null;
    this.hoverVeh = null;
    this.ui.hoverCard?.set(null);
    this.clearVisuals();
    const u = this.terr;
    if (u.uGrid) u.uGrid.value = CONSTRUCTION.includes(t) && t !== 'signal' ? 1 : 0;
    this.hideTip();
    this.onToolChange();
    this.refreshHover();
  }

  private clearVisuals() {
    this.overlay.clear();
    drawCatchStreets(this.overlay, 'hover', null);
    const u = this.terr;
    if (u.uHiOn) u.uHiOn.value = 0;
    if (u.uCircle) u.uCircle.value.w = 0;
  }

  /** Re-evaluate the hover state (e.g. after options changed). */
  refreshHover() { this.touchPreview = null; this.planKey = ''; this.moveDirty = true; if (this.start) this.planDirty = true; }

  rotate(dir = 1) {
    if (this.stationTool) {
      this.stationAngle = norm(this.stationAngle + dir * 15 * DEG);
      if (this.autoAlign) {
        this.autoAlign = false;
        this.onToolChange();
        this.ui.toast('Align to track off: manual rotation', 'info');
      }
    }
    else if (this.tool === 'depot-rail' || this.tool === 'depot-road' || this.tool === 'depot-tram') this.depotAngle = norm(this.depotAngle + dir * 15 * DEG);
    else return;
    this.refreshHover();
  }

  adjustHeight(d: number) {
    this.heightOffset = Math.max(-6, Math.min(6, Math.round((this.heightOffset + d) * 2) / 2));
    this.onToolChange();
    this.refreshHover();
  }

  /** Drop a construction chain in progress (e.g. when the tool mode changes). */
  resetChain() { if (this.start || this.dragRect) this.endChain(); this.refreshHover(); }

  /** End the current chain / drag; returns false if there was nothing to cancel (caller may close windows). */
  cancel(): boolean {
    if (this.touchPreview) { this.touchPreview = null; this.clearVisuals(); this.hideTip(); this.moveDirty = true; return true; }
    if (this.start || this.dragRect || this.down) { this.endChain(); this.sigDrag = null; this.overlay.setSignalGhosts(null); return true; }
    if (this.conn) { this.clearConn(); return true; }
    if (this.tool !== 'inspect') { this.setTool('inspect'); return true; }
    return false;
  }

  /** Connect tool: forget the first pick (pick again). */
  clearConn() {
    this.conn = null;
    this.connPlan = null;
    this.overlay.setProposal(null);
    this.overlay.setDemolish(null);
    this.overlay.setMarker('start0', null);
    this.overlay.setHoverEdge(null);
    this.moveDirty = true;
    this.onToolChange();
  }

  private endChain() {
    this.finishTold = false;
    this.start = null;
    this.proposal = null;
    this.planKey = '';
    this.planDirty = false;
    this.down = null;
    this.touchPreview = null;
    this.dragRect = null;
    this.overlay.setProposal(null);
    this.overlay.setDemolish(null);
    this.overlay.setMarker('start0', null);
    for (let i = 1; i < 4; i++) this.overlay.setMarker('start' + i, null);
    const u = this.terr;
    if (u.uHiOn) u.uHiOn.value = 0;
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ pointer events
  private onDown = (e: PointerEvent) => {
    if (!this.game || e.altKey || (e.button !== 0 && e.button !== 2)) return;
    const touch = e.pointerType === 'touch';
    if (touch) {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // a second finger: camera gesture, abandon what the first one started
        if (this.down && !this.down.hadStart && this.building) this.endChain();
        this.down = null;
        this.touchPreview = null;
        this.overMap = false;
        this.hideTip();
        return;
      }
    }
    this.client = { x: e.clientX, y: e.clientY };
    this.overMap = true;
    this.shift = e.shiftKey;
    this.ground = this.pick();
    this.moveDirty = true;
    if (!touch) this.touchPreview = null;
    this.down = { x: e.clientX, y: e.clientY, button: e.button, ground: this.ground?.clone() ?? null, moved: false, hadStart: !!this.start, id: e.pointerId, touch, t: performance.now() };
    if (e.button !== 0) return;
    const p = this.ground;
    if (!p) return;
    if (this.railBuild && !this.start && e.shiftKey && !touch) {
      this.down = null;
      this.buildParallel();
      return;
    }
    if (this.building && !this.start) {
      // press starts a chain (a drag builds straight away on release)
      const sn = this.snapAt(this.kind);
      const err = this.ownErr(sn);
      const fo = this.snapOwner(sn);
      // another company's track without access: the click asks for it
      if (err && fo !== null && !this.game.canUse(PLAYER, fo)) {
        this.down = null;
        if (requestAccessUI(this.ui, fo) !== 'granted') return;
      } else if (err) { this.ui.toast(err, 'bad'); this.down = null; return; }
      this.setStart(sn);
    } else if (this.tool === 'terraform') {
      this.brush = { timer: 0, level: this.game.world.heightAt(p.x, p.z), cost: 0, err: false };
    }
  };

  private onMove = (e: PointerEvent) => {
    if ((e.target as HTMLElement)?.closest?.('.tooltip')) return;
    if (e.pointerType === 'touch' && this.touches.size > 1) return;
    if (this.down && e.pointerId !== this.down.id) return;
    this.client = { x: e.clientX, y: e.clientY };
    if (e.shiftKey !== this.shift && this.railBuild) { this.shift = e.shiftKey; this.moveDirty = true; }
    const t = e.target as HTMLElement;
    this.overMap = t === this.canvas || !!t?.closest?.('.labels');
    const d = this.down;
    if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.moved = true;
      if (d.button === 0 && this.tool === 'bulldoze' && d.ground) this.dragRect = { x0: d.ground.x, z0: d.ground.z, x1: d.ground.x, z1: d.ground.z };
    }
    if (!this.overMap && !this.down) { this.hideTip(); return; }
    this.moveDirty = true;
    this.positionTip();
  };

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    const d = this.down;
    if (!d || e.button !== d.button || e.pointerId !== d.id) return;
    this.down = null;
    if (!this.game) return;
    this.client = { x: e.clientX, y: e.clientY };
    if (d.button === 2) {
      // right click (not a camera drag) ends the construction chain; with the signal tool it removes a signal
      if (!d.moved && (this.start || this.dragRect)) this.endChain();
      else if (!d.moved && this.tool === 'signal') { const q = this.pick(); if (q) this.removeSignalAt(q.x, q.z); }
      else if (!d.moved && this.conn) this.clearConn();
      return;
    }
    const onMap = (e.target as HTMLElement) === this.canvas || !!(e.target as HTMLElement)?.closest?.('.labels');
    this.ground = this.pick();
    if (d.touch && CONSTRUCTION.includes(this.tool)) {
      if (!onMap || !this.ground) return;
      this.overMap = true;
      // The first track / connection pick only sets its start; no construction is charged.
      if (this.building && !d.hadStart && !d.moved) { this.hover(); this.planNow(); return; }
      if (this.tool === 'connect' && !this.conn) { this.click(e); this.moveDirty = true; return; }
      const preview = this.touchPreview;
      const same = preview && !d.moved && preview.signature === this.touchSignature() &&
        Math.hypot(e.clientX - preview.client.x, e.clientY - preview.client.y) <= 16 &&
        Math.hypot(this.ground.x - preview.point.x, this.ground.z - preview.point.z) <= 1.2;
      if (same) {
        // Confirm the exact world position that was quoted, allowing a little finger imprecision.
        this.ground = preview.point.clone(); this.client = { ...preview.client };
        d.ground = preview.point.clone();
        this.touchPreview = null;
        this.connAt = -Infinity;
        this.hover();
        if (this.building) { this.hoverSnap = this.snapAt(this.kind); this.planKey = ''; this.planNow(); }
        if (this.tool === 'terraform') {
          const r = terraformBrush(this.game, this.ground.x, this.ground.z, this.brushRadius, this.terraMode, this.ground.y, PLAYER);
          if (r.error) this.ui.toast(r.error, 'bad');
          else if (r.cost) { this.ui.floatCost(r.cost, this.client.x, this.client.y); this.ui.sound('build', { x: this.ground.x, z: this.ground.z, pitch: 0.8 }); }
          this.moveDirty = true;
          return;
        }
      } else {
        // Touch drags also stop at a preview instead of spending on release.
        this.dragRect = null;
        if (this.terr.uHiOn) this.terr.uHiOn.value = 0;
        this.touchPreview = { point: this.ground.clone(), client: { ...this.client }, signature: this.touchSignature() };
        this.connAt = -Infinity;
        this.hover();
        if (this.building) { this.hoverSnap = this.snapAt(this.kind); this.planKey = ''; this.planNow(); }
        this.positionTip();
        return;
      }
    }
    if (this.building) {
      if (d.moved || d.hadStart) this.commitChain();
      return;
    }
    switch (this.tool) {
      case 'signal':
        if (d.moved) { this.commitSignalDrag(); break; }
        if (onMap) this.click(e);
        break;
      case 'double':
        if (d.moved || onMap) this.commitDouble();
        break;
      case 'electrify':
        if (d.moved || onMap) this.commitElectrify();
        break;
      case 'relevel':
        if (d.moved || onMap) this.commitRelevel();
        break;
      case 'tram': {
        const ids = this.tramEdges(d.moved ? d.ground : null);
        if (ids && ids.length) this.commitTram(ids);
        this.overlay.setHoverEdge(null);
        break;
      }
      case 'bulldoze': {
        const r = this.dragRect;
        this.dragRect = null;
        const u = this.terr;
        if (u.uHiOn) u.uHiOn.value = 0;
        if (r && d.moved) this.doBulldoze(r.x0, r.z0, r.x1, r.z1);
        else if (!d.moved && d.ground) this.doBulldoze(d.ground.x, d.ground.z, d.ground.x, d.ground.z);
        break;
      }
      case 'terraform':
        if (this.brush.cost > 0) { this.ui.floatCost(this.brush.cost, e.clientX, e.clientY); this.ui.sound('build', this.ground ? { x: this.ground.x, z: this.ground.z, pitch: 0.8 } : {}); }
        this.brush.cost = 0;
        this.overlay.setDisc(null);
        break;
      default:
        if (!d.moved && onMap) this.click(e);
    }
    this.moveDirty = true;
  };

  private touchSignature(): string {
    return JSON.stringify([this.tool, this.buildOptions(), snapKey(this.start), this.conn, this.game.networkVersion, this.game.world.heightsVersion,
      this.stationType, this.stationStyle, this.stationLen, this.stationTracks, this.stationLevel, this.stationHeight, this.stationDepth,
      this.stationThrough, this.throughMode, this.stationOnLine, this.stationAngle, this.autoAlign, this.relocating, this.relocatingDepot,
      this.depotAngle, this.signalMode, this.signalKind, this.signalClass, this.signalPass, this.signalSpacing,
      this.doubleSide, this.directional, this.rightHand, this.relevelTo, this.tramMode, this.entranceStation, this.entranceKind, this.terraMode, this.brushRadius]);
  }

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || !e.altKey || e.target !== this.canvas) return;
    if (!this.stationTool && this.tool !== 'depot-rail' && this.tool !== 'depot-road' && this.tool !== 'depot-tram') return;
    e.preventDefault();
    e.stopPropagation();
    this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
    while (Math.abs(this.wheelAcc) >= 40) { const s = Math.sign(this.wheelAcc); this.wheelAcc -= s * 40; this.rotate(s); }
  };

  // ------------------------------------------------------------------ picking & snapping
  private pick(): THREE.Vector3 | null {
    if (this.client.x < 0) return null;
    return this.ui.renderer.pickGround(this.client.x, this.client.y);
  }

  private camDist(): number {
    const c = this.ui.renderer.controls as unknown as { smoothDistance?: number };
    return c.smoothDistance ?? this.ui.renderer.camera.position.distanceTo(this.ground ?? new THREE.Vector3());
  }

  private project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = this.v3.set(x, y, z).project(this.ui.renderer.camera);
    if (v.z > 1 || v.z < -1) return null;
    const r = this.rect ?? (this.rect = this.canvas.getBoundingClientRect());
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  /** Snap under the cursor: nodes and edges are matched in screen space (works for bridges), then findSnap. */
  snapAt(kind: NetKind): Snap {
    const g = this.game;
    const net = g.world.net;
    const p = this.ground ?? new THREE.Vector3(this.start?.x ?? 0, 0, this.start?.z ?? 0);
    const cx = this.client.x, cy = this.client.y;
    const R = Math.max(3, Math.min(16, this.camDist() * 0.1));
    let bn: NNode | null = null, bd = 15;
    for (const id of net.nodeGrid.query(p.x - R, p.z - R, p.x + R, p.z + R)) {
      const n = net.nodes.get(id);
      if (!n || n.kind !== kind || !n.edges.length) continue;
      if (n.edges.some((eid) => { const e = net.edges.get(eid); return !!e && e.depot >= 0 && e.a === n.id; })) continue; // depot interior
      const s = this.project(n.x, n.y, n.z);
      if (!s) continue;
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d < bd) { bd = d; bn = n; }
    }
    if (bn) return findSnap(g, kind, bn.x, bn.z, 0.02);
    const best = this.edgeAtCursor(kind, (e) => e.depot < 0);
    if (best) return findSnap(g, kind, best.x, best.z, 0.3);
    return findSnap(g, kind, p.x, p.z, Math.max(0.3, Math.min(2, this.camDist() * 0.012)));
  }

  /** Edge closest to the cursor in screen space (within 12 px), with the nearest world point on it. */
  private edgeAtCursor(kind: NetKind, pred: (e: NEdge) => boolean, tol = 12): { edge: NEdge; x: number; z: number; d: number } | null {
    const net = this.game.world.net;
    const p = this.ground;
    if (!p) return null;
    const cx = this.client.x, cy = this.client.y;
    const R = Math.max(3, Math.min(16, this.camDist() * 0.1));
    let best: { edge: NEdge; x: number; z: number; d: number } | null = null;
    for (const e of net.edgesNear(p.x - R, p.z - R, p.x + R, p.z + R)) {
      if (e.kind !== kind || !pred(e)) continue;
      const geo = net.geo(e);
      const step = Math.max(1, Math.round(1 / Math.max(0.05, geo.len / Math.max(1, geo.n - 1))));
      let prev: { x: number; y: number } | null = null, pi = 0;
      for (let i = 0; i < geo.n; i += step) {
        const j = i;
        const s = this.project(geo.pts[j * 3], geo.pts[j * 3 + 1], geo.pts[j * 3 + 2]);
        if (s && prev) {
          const dx = s.x - prev.x, dy = s.y - prev.y;
          const l2 = dx * dx + dy * dy;
          let f = l2 > 1e-6 ? ((cx - prev.x) * dx + (cy - prev.y) * dy) / l2 : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const d = Math.hypot(prev.x + dx * f - cx, prev.y + dy * f - cy);
          if (d < tol && (!best || d < best.d)) best = { edge: e, x: geo.pts[pi * 3] + (geo.pts[j * 3] - geo.pts[pi * 3]) * f, z: geo.pts[pi * 3 + 2] + (geo.pts[j * 3 + 2] - geo.pts[pi * 3 + 2]) * f, d };
        }
        prev = s; pi = j;
        if (i < geo.n - 1 && i + step > geo.n - 1) i = geo.n - 1 - step;
      }
    }
    return best;
  }

  /** Ownership / validity problems of a snap target. */
  private ownErr(s: Snap | null): string | null {
    if (!s) return null;
    const g = this.game, net = g.world.net;
    if (s.kind === 'edge') {
      const e = net.edges.get(s.edge!);
      if (e && e.station >= 0 && e.kind === 'rail') return 'Cannot branch off inside a station';
      if (e && e.kind === 'rail' && !g.canUse(PLAYER, e.owner)) return `Track of ${g.company(e.owner).name} — request access first`;
    } else if (s.kind === 'node') {
      const n = net.nodes.get(s.node!);
      if (n && n.kind === 'rail' && !g.canUse(PLAYER, n.owner)) return `Track of ${g.company(n.owner).name} — request access first`;
    }
    return null;
  }

  /** Owner of another company's rail infrastructure a snap touches (with or without access), else null. */
  private snapOwner(s: Snap | null): number | null {
    if (!s || this.kind !== 'rail') return null;
    const net = this.game.world.net;
    const o = s.kind === 'edge' ? net.edges.get(s.edge!)?.owner : s.kind === 'node' ? net.nodes.get(s.node!)?.owner : undefined;
    return o !== undefined && o >= 0 && o !== PLAYER ? o : null;
  }
  /** Snap marker colour: the owner's colour on another company's network. */
  private snapColor(sn: Snap, err: string | null): number {
    if (err) return 0xff5a4a;
    const fo = this.snapOwner(sn);
    if (fo !== null) return new THREE.Color(this.game.company(fo).color).getHex();
    return sn.kind === 'node' ? 0x5ff07a : sn.kind === 'edge' ? 0xffd84a : 0xffffff;
  }

  /** Owner of foreign rail infrastructure a snap joins (with an access agreement), else null. */
  private foreignOwner(s: Snap | null): number | null {
    if (!s || this.kind !== 'rail') return null;
    const net = this.game.world.net;
    const o = s.kind === 'edge' ? net.edges.get(s.edge!)?.owner : s.kind === 'node' ? net.nodes.get(s.node!)?.owner : undefined;
    return o !== undefined && o >= 0 && o !== PLAYER ? o : null;
  }

  private setStart(sn: Snap) {
    this.start = sn;
    this.planKey = '';
    this.planDirty = true;
    this.showSnap('start', sn, 0xffb020, 'start');
  }

  private showSnap(slot: string, sn: Snap | null, color: number, kind?: MarkerKind) {
    const net = this.game.world.net;
    const nodes = sn?.kind === 'node' ? (sn.group ?? [sn.node!]).map((id) => net.nodes.get(id)).filter((n): n is NNode => !!n) : [];
    for (let i = 0; i < 4; i++) {
      if (!sn) { this.overlay.setMarker(slot + i, null); continue; }
      if (nodes.length) {
        const n = nodes[i];
        this.overlay.setMarker(slot + i, n ? { x: n.x, y: n.y, z: n.z } : null, kind ?? 'node', color, nodes.length > 1 ? 0.009 : 0.013);
      } else this.overlay.setMarker(slot + i, i === 0 ? { x: sn.x, y: sn.y, z: sn.z } : null, kind ?? (sn.kind === 'edge' ? 'edge' : 'free'), color);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    const g = this.game;
    if (!g) return;
    const cam = this.ui.renderer.camera;
    if (!cam.position.equals(this.camPos) || !cam.quaternion.equals(this.camQuat)) {
      this.camPos.copy(cam.position);
      this.camQuat.copy(cam.quaternion);
      if (this.overMap || this.down) this.moveDirty = true;
    }
    if (g.networkVersion !== this.netVer) {
      this.netVer = g.networkVersion;
      this.planKey = '';
      if (this.start) this.planDirty = true;
      this.moveDirty = true;
    }
    if (this.moveDirty) {
      this.moveDirty = false;
      this.rect = this.canvas.getBoundingClientRect();
      this.ground = this.touchPreview && !this.down ? this.touchPreview.point.clone() : this.overMap || this.down ? this.pick() : null;
      if (this.touchPreview && !this.down) {
        const pos = this.project(this.ground!.x, this.ground!.y, this.ground!.z);
        if (pos) { this.client = pos; this.touchPreview.client = { ...pos }; }
      }
      this.hover();
    }
    if (this.planDirty && performance.now() - this.planAt >= Math.min(200, this.planMs * 2)) this.planNow();
    // long press (touch) ends a construction chain
    const d = this.down;
    if (d && d.touch && !d.moved && performance.now() - d.t > 650 && (this.start || this.dragRect)) {
      this.endChain();
      this.ui.toast('Construction ended', 'info');
    }
    // terraform brush while the button is held
    if (this.tool === 'terraform' && this.down?.button === 0 && !this.down.touch && this.ground) {
      this.brush.timer -= dt;
      if (this.brush.timer <= 0) {
        this.brush.timer = 0.12;
        const r = terraformBrush(g, this.ground.x, this.ground.z, this.brushRadius, this.terraMode, this.brush.level, PLAYER);
        if (r.error) { if (!this.brush.err) this.ui.toast(r.error, 'bad'); this.brush.err = true; }
        else this.brush.cost += r.cost;
        const what = this.terraMode === 'level' ? `Levelling to ${Math.round(this.brush.level * 10)} m` : this.terraMode === 'raise' ? 'Raising ground' : 'Lowering ground';
        this.tip({ title: what, cost: this.brush.cost, err: this.brush.err ? ['Not enough money'] : [] }, this.brush.err ? 'err' : 'info');
        if (this.terraMode === 'level') this.overlay.setDisc({ x: this.ground.x, z: this.ground.z, r: this.brushRadius, y: this.brush.level + 0.03, color: 0xffb020 });
      }
    }
    // bulldoze rectangle preview (throttled dry run)
    if (this.dragRect && this.ground && this.down) {
      const r = this.dragRect;
      r.x1 = this.ground.x; r.z1 = this.ground.z;
      const u = this.terr;
      if (u.uHiRect && u.uHiOn && u.uHiColor) {
        u.uHiRect.value.set(Math.min(r.x0, r.x1), Math.min(r.z0, r.z1), Math.max(r.x0, r.x1), Math.max(r.z0, r.z1));
        u.uHiColor.value.setHex(0xff5a5f);
        u.uHiOn.value = 1;
      }
      const now = performance.now();
      if (now - this.dozeAt > 120) {
        this.dozeAt = now;
        const res = bulldoze(g, r.x0, r.z0, r.x1, r.z1, PLAYER, true);
        this.tip({ title: 'Clear area', cost: res.cost || undefined,
          rows: res.changed ? [['bulldoze', plural(res.changed, 'object')]] : res.error ? [] : [['info', 'Nothing to remove']],
          err: res.error ? [res.error] : [] }, res.changed || res.error ? 'err' : 'info');
      }
    }
  }

  // ------------------------------------------------------------------ hover
  private hover() {
    const g = this.game;
    const p = this.ground;
    const ov = this.overlay;
    const u = this.terr;
    if (!p) {
      if (!this.building) this.clearVisuals();
      ov.setMarker('hover0', null);
      this.ui.hoverCard?.set(null);
      this.hideTip();
      return;
    }
    switch (this.tool) {
      case 'rail':
      case 'metro':
      case 'road': {
        if (this.railBuild && !this.start && this.shift && this.hoverParallel()) break;
        if (this.parallel) { this.parallel = null; ov.setProposal(null); ov.setHoverEdge(null); ov.setDemolish(null); }
        const sn = this.snapAt(this.kind);
        this.hoverSnap = sn;
        const err = this.ownErr(sn);
        this.showSnap('hover', sn, this.snapColor(sn, err));
        if (this.start) { this.planDirty = true; this.positionTip(); }
        else this.tip(this.describeSnap(sn, err), err ? 'err' : 'info');
        break;
      }
      case 'tram': this.hoverTram(); break;
      case 'tramstop': this.hoverStop(p, true); break;
      case 'station':
      case 'metro-station': {
        if (this.stationOnLine && this.relocating == null) { this.hoverStationOnLine(p); break; }
        ov.setSegments('throat', null);
        const pos = this.stationPlacement(p.x, p.z);
        const pl = this.planStation(pos.x, pos.z, pos.angle, pos.type);
        this.stationPlan = pl;
        ov.setStationGhost(pl);
        ov.setDemolish(pl.ok ? pl.demolish : null);
        // the access street a ground station builds to the nearest road
        ov.setProposal(pl.access ?? null);
        // catchment with the building style's bonus (grows / shrinks live with the chosen style)
        const walk = planCatchStreets(g, pl);
        drawCatchStreets(ov, 'hover', walk, pl.ok ? undefined : 0xff6b6b);
        const pop = catchStreetPop(g, walk);
        const lv = pl.level;
        const moving = this.relocating != null ? g.stations.get(this.relocating) : undefined;
        const bonus = catchBonusOf(pl.style);
        const reach = Math.round(catchWalkLimit(catchModeOf(railModeOf(pl.trackType)), bonus) * 10);
        const tt = TRACK_TYPES[pl.trackType];
        const rows: [string, string][] = [['station', `${plural(pl.tracks, 'platform track')}${pl.through ? ` + ${pl.through} through (${pl.throughMode === 'outer' ? 'outside' : 'in the middle'})` : ''} × ${pl.length * 10} m`], ['people', `<b>${pop.toLocaleString('en-US')}</b> residents within ${reach} m walking${pl.roadAccess ? '' : ' (not reached without road access)'}`]];
        if (tt) rows.push(['rail', `${esc(tt.name)}${pl.psd ? ' · platform doors' : ''}`]);
        const sty = STATION_STYLES[pl.style];
        if (sty) rows.push(['station', `${esc(sty.name)}${bonus ? ` · <b>+${Math.round(bonus * 100)}%</b> reach` : ''}`]);
        if (lv === 'elevated') rows.push(['bridge', `Elevated · deck <b>${Math.round(pl.height * 10)} m</b> up · ${plural(pl.entrances.length, 'stair tower')}`]);
        if (lv === 'underground') rows.push(['tunnel', `Underground · <b>${Math.round(pl.depth * 10)} m</b> deep · ${plural(pl.entrances.length, 'entrance')}`]);
        if (pl.access) rows.push(['road', `Access street ${fmtLen(pl.access.stats.len)} · ${fmtMoney(pl.access.cost)} (included)`]);
        if (pl.join) rows.push(['plus', `Joins ${esc(pl.join.name)}`]);
        if (pl.links.length) rows.push(['plus', `Links with ${esc(pl.links.map((x) => x.name).join(', '))} (transfers)`]);
        if (pos.snapped) rows.push(['target', pos.snapped === 'end' ? 'Lined up with the track end' : 'Aligned with the track']);
        const warn = [...pl.warnings];
        // (its added entrances do not move with it: taken down, as a rebuild or re-level that drops them says)
        const gone = moving?.rail ? entrancesGo(moving.rail.level ?? 'ground', moving.rail.entrances, 'taken down at the old site') : null;
        if (gone) warn.push(gone);
        if (pl.ok && !pl.roadAccess && !warn.some((w) => /road/i.test(w))) warn.unshift('No road access — this station won\u2019t attract passengers');
        if (pl.ok && pl.demolish.length) warn.push(`Demolishes ${plural(pl.demolish.length, 'building')}`);
        if (pl.ok && !g.economy.canAfford(pl.cost) && !warn.includes('Not enough money')) warn.push('Not enough money');
        const kindName = pl.mode === 'metro' ? 'metro station' : pl.mode === 'lightrail' ? 'light-rail station' : 'station';
        const title = moving ? `Move ${esc(moving.name)}` : lv === 'elevated' ? `Elevated ${kindName}` : lv === 'underground' ? `Underground ${kindName}` : pl.mode === 'mainline' ? 'Train station' : kindName[0].toUpperCase() + kindName.slice(1);
        this.tip({ title, cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : [pl.error ?? 'Cannot build'], warn, hint: moving ? 'Click to move the station here · Esc cancels' : undefined }, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'busstop': this.hoverStop(p, false); break;
      case 'depot-rail':
      case 'depot-road':
      case 'depot-tram': {
        const kind: DepotKind = this.tool === 'depot-rail' ? 'rail' : this.tool === 'depot-tram' ? 'tram' : 'road';
        const pos = this.depotPlacement(kind, p.x, p.z);
        const pl = this.planDepot(kind, p.x, p.z);
        this.depotPlan = pl;
        ov.setDepotGhost(pl, kind);
        ov.setDemolish(pl.demolish?.length ? pl.demolish : null);
        const how = pl.snapNode >= 0 ? 'Connects to the track end' : kind !== 'rail' && pos.road ? (kind === 'tram' ? 'Connects to the tram tracks' : 'Connects to the road') : kind === 'rail' ? 'Connect it with track afterwards' : kind === 'tram' ? 'Place it next to a road with tram tracks' : 'Place it next to a road';
        const nd = pl.demolish?.length ?? 0;
        const movingDepot = this.relocatingDepot != null ? g.depots.get(this.relocatingDepot) : undefined;
        this.tip({ title: movingDepot ? 'Move depot' : kind === 'rail' ? 'Train depot' : kind === 'tram' ? 'Tram depot' : 'Bus depot', hint: movingDepot ? 'Click to move the depot here · its vehicles move with it · Esc cancels' : undefined, cost: pl.ok ? pl.cost : undefined, rows: [[pl.snapNode >= 0 || pos.road ? 'check' : 'info', how]], err: pl.ok ? [] : [pl.error ?? 'Cannot build'], warn: [...(nd ? [`Demolishes ${plural(nd, 'building')}`] : []), ...(pl.ok && !g.economy.canAfford(pl.cost) ? ['Not enough money'] : [])] }, pl.ok ? 'ok' : 'err');
        break;
      }
      case 'signal': this.hoverSignal(p); break;
      case 'double': this.hoverDouble(p); break;
      case 'electrify': this.hoverElectrify(p); break;
      case 'connect': this.hoverConnect(p); break;
      case 'relevel': this.hoverRelevel(p); break;
      case 'entrance': this.hoverEntrance(p); break;
      case 'bulldoze': {
        if (this.dragRect) break;
        const net = g.world.net;
        const ne = net.nearestEdge(p.x, p.z, 0.9);
        // (a click on a station building or entrance takes that, not the street beside it: see bulldoze)
        const onStructure = g.stations.footprintsNear(p.x, p.z, 0.1).some((s) => g.stations.footprints(s).some((f) => f.part !== 'platforms' && distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.1));
        ov.setHoverEdge(ne && !onStructure && ne.edge.station < 0 && ne.edge.depot < 0 ? ne.edge.id : null, 0xff5a5f);
        const now = performance.now();
        if (now - this.dozeAt < 40) break;
        this.dozeAt = now;
        const r = bulldoze(g, p.x, p.z, p.x, p.z, PLAYER, true);
        if (r.changed) this.tip({ title: 'Demolish', cost: r.cost, err: r.error ? [r.error] : [], hint: 'Drag to clear an area' }, 'err');
        else if (r.error) this.tip({ title: 'Demolish', cost: r.cost || undefined, err: [r.error] }, 'err');
        else this.hideTip();
        break;
      }
      case 'terraform': {
        this.setCircle(p.x, p.z, this.brushRadius, this.terraMode === 'raise' ? 0x4ade80 : this.terraMode === 'lower' ? 0xff8a3d : 0xffb020);
        if (this.down) break;
        const h = g.world.heightAt(p.x, p.z);
        if (this.touchPreview) {
          const cost = Math.round(brushVolume(g.world, p.x, p.z, this.brushRadius, this.terraMode, 0.25, h, true) * 1500);
          this.tip({ title: this.terraMode === 'level' ? 'Level ground' : this.terraMode === 'raise' ? 'Raise ground' : 'Lower ground', cost,
            rows: [['catchment', `Radius ${this.brushRadius * 10} m · one brush stroke`]] }, 'info');
          break;
        }
        if (this.terraMode === 'level') {
          this.overlay.setDisc({ x: p.x, z: p.z, r: this.brushRadius, y: h + 0.03, color: 0xffb020 });
          this.tip({ title: 'Level ground', rows: [['level', `Flattens to <b>${Math.round(h * 10)} m</b> (where you press)`], ['catchment', `Radius ${this.brushRadius * 10} m`]], hint: 'Hold the button to apply' }, 'info');
        } else {
          const step = Math.round(brushVolume(g.world, p.x, p.z, this.brushRadius, this.terraMode, 0.25, 0, true) * 1500);
          this.tip({ title: this.terraMode === 'raise' ? 'Raise ground' : 'Lower ground', rows: [['coin', `≈ <b>${fmtMoney(step * 8)}</b> per second held`], ['catchment', `Radius ${this.brushRadius * 10} m`]], hint: 'Hold the button to apply' }, 'info');
        }
        break;
      }
      case 'inspect':
      case 'line-edit': this.hoverInspect(p); break;
    }
  }

  private hoverSignal(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    if (this.down && this.down.button === 0 && this.down.moved && this.down.ground) { this.hoverSignalDrag(p); return; }
    ov.setSignalGhosts(null);
    this.sigDrag = null;
    if (this.signalMode === 'remove') {
      const n = net.nearestNode(p.x, p.z, 0.8, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
      ov.setMarker('hover0', n ? n : null, 'signal', 0xff5a5f);
      ov.setHoverEdge(n ? n.edges : null, 0xff5a5f);
      this.tip(n ? (n.owner === PLAYER ? { title: 'Remove signal', rows: [['signal', SIGNAL_NAMES[n.signal]]], hint: 'Drag along a track to remove a series' } : { title: 'Signal', err: [`Belongs to ${g.company(n.owner).name}`] }) : { title: 'Remove signals', rows: [['info', 'Point at a signal, or drag along a track']] }, n && n.owner === PLAYER ? 'err' : 'info');
      return;
    }
    const n = net.nearestNode(p.x, p.z, 0.8, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
    if (n) {
      ov.setMarker('hover0', n, 'signal', n.owner === PLAYER ? 0xffb020 : 0xff5a4a);
      ov.setHoverEdge(n.edges, 0xffb020);
      if (n.owner !== PLAYER) this.tip({ title: 'Signal', err: [`Belongs to ${g.company(n.owner).name}`] }, 'err');
      else this.tip({ title: 'Change signal', rows: [['signal', `${SIGNAL_NAMES[n.signal]} → <b>${SIGNAL_NAMES[(n.signal + 1) % 4]}</b>`]] }, 'info');
      return;
    }
    const ne = net.nearestEdge(p.x, p.z, 1.0, 'rail');
    if (!ne) { ov.setMarker('hover0', null); ov.setHoverEdge(null); this.tip({ title: 'Signals', rows: [['info', 'Point at one of your tracks']] }, 'info'); return; }
    const e = ne.edge;
    const q = { x: 0, y: 0, z: 0 };
    let err = '';
    if (e.station >= 0 || e.depot >= 0) err = 'Not inside stations or depots';
    else if (e.owner !== PLAYER) err = `Track owned by ${g.company(e.owner).name}`;
    else if (ne.s < 1 || ne.s > e.len - 1) {
      const end = net.nodes.get(ne.s < 1 ? e.a : e.b)!;
      if (end.edges.length !== 2) err = 'Signals need plain track (not at a switch or track end)';
      q.x = end.x; q.y = end.y; q.z = end.z;
    }
    if (!q.x) net.pointAt(e, ne.s, q);
    ov.setMarker('hover0', q, 'signal', err ? 0xff5a4a : 0xffb020);
    ov.setHoverEdge(e.id, err ? 0xff5a4a : 0xffb020);
    const name = `${this.signalKind === 'oneway' ? 'One-way' : 'Two-way'} ${this.signalClass} signal`;
    this.tip(err ? { title: 'Signal', err: [err] } : { title: name, cost: SIGNAL_COST, rows: this.signalKind === 'oneway' ? [['signal', `facing away from you${this.signalPass ? ' · passable from behind' : ''}`]] : [], hint: 'Click to place · drag along the track for a series' }, err ? 'err' : 'info');
  }

  private hoverInspect(p: THREE.Vector3) {
    const g = this.game, ov = this.overlay;
    const card = this.ui.hoverCard;
    // vehicles under the cursor (throttled raycast; retried next frame while throttled)
    if (this.tool === 'inspect') {
      const now = performance.now();
      if (now - this.vehPickAt > 100) { this.vehPickAt = now; this.hoverVeh = this.ui.renderer.pickVehicle(this.client.x, this.client.y); }
      else this.moveDirty = true;
      if (this.hoverVeh != null && g.vehicles.get(this.hoverVeh)) {
        ov.setHoverEdge(null);
        ov.setFootprints(null);
        this.hoverStation = null;
        card.set({ kind: 'vehicle', id: this.hoverVeh });
        this.hideTip();
        return;
      }
    }
    const hit = this.hitAt(p.x, p.z);
    ov.setHoverEdge(null);
    ov.setFootprints(null);
    if (this.hoverStation != null && (hit?.kind !== 'station' || hit.id !== this.hoverStation)) drawCatchStreets(ov, 'hover', null);
    this.hoverStation = null;
    // demand view: districts under the cursor explain their trips
    if (this.tool === 'inspect' && (!hit || hit.kind === 'town' || hit.kind === 'building')) {
      const reg = this.ui.mapModes?.regionAt(p.x, p.z);
      if (reg) { card.set(null); this.tip({ title: esc(reg.title), rows: reg.rows }, 'info'); return; }
    }
    // stations, depots and towns get the in-world hover card; tracks keep the cursor tooltip
    if (this.tool === 'inspect' && hit && hit.kind !== 'edge') {
      const t = hit.kind === 'building' ? { kind: 'town' as const, id: g.world.buildings.get(hit.id)?.townId ?? -1 } : { kind: hit.kind, id: hit.id };
      if (t.id >= 0) card.set(t); else card.set(null);
    } else card.set(null);
    if (!hit) { this.hideTip(); return; }
    const own = (o: number): [string, string][] => (o === PLAYER ? [] : [['company', o < 0 ? 'Town' : esc(g.company(o).name)]]);
    if (hit.kind === 'station') {
      const st = g.stations.get(hit.id)!;
      this.hoverStation = st.id;
      const rects = g.stations.footprints(st).map((f) => ({ ...f, color: 0xffb020, y: st.rail?.y, lift: 0.12 }));
      for (const s of st.stops) rects.push({ x: s.x, z: s.z, angle: 0, w: 0.9, d: 0.9, color: 0xffb020, y: undefined, lift: 0.08 });
      ov.setFootprints(rects);
      drawCatchStreets(ov, 'hover', catchStreets(g, st));
      if (this.tool === 'line-edit') {
        const l = this.lineEditId != null ? g.lines.get(this.lineEditId) : null;
        const okKind = !!l && servesKind(g, st, l.kind);
        const foreign = st.owner >= 0 && st.owner !== PLAYER;
        const acc = foreign ? accessState(g, st.owner) : null;
        const kindErr = !okKind ? (l?.kind === 'rail' ? 'No train platforms' : l?.kind === 'tram' ? 'No tram stop' : 'No bus stop') : '';
        const rows: [string, string][] = foreign ? [['company', esc(g.company(st.owner).name)]] : [];
        if (kindErr) this.tip({ title: esc(st.name), rows, err: [kindErr] }, 'err');
        else if (!acc || acc.kind === 'agreement') this.tip({ title: esc(st.name), rows: acc ? [...rows, ['key', `Upkeep shared ${fmtMult(g.accessMultiplier(st.owner))}`]] : rows, ok: [`Add to ${l?.name ?? 'line'}`] }, 'ok');
        else if (acc.kind === 'none') this.tip({ title: esc(st.name), rows: [...rows, ['key', `${policyText(g, st.owner)} · upkeep shared ${fmtMult(g.accessMultiplier(st.owner))}`]], hint: 'Click to request track access' }, 'info');
        else this.tip({ title: esc(st.name), rows, err: [acc.text] }, 'err');
      } else this.hideTip();
      return;
    }
    if (this.tool === 'line-edit') { this.hideTip(); return; }
    if (hit.kind === 'depot') {
      const dp = g.depots.get(hit.id)!;
      const sz = depotSize(dp.kind);
      ov.setFootprints([{ x: dp.x, z: dp.z, angle: dp.angle, w: sz.w, d: sz.d, color: 0xffb020, y: dp.y, lift: 0.1 }]);
      this.hideTip();
    } else if (hit.kind === 'edge') {
      const e = g.world.net.edges.get(hit.id)!;
      ov.setHoverEdge(e.id, 0xffb020);
      const name = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).name : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).name;
      const tramRow: [string, string][] = e.tram ? [['tram', `tram tracks${e.tramOwner !== undefined && e.tramOwner !== PLAYER ? ' · ' + esc(g.company(e.tramOwner).name) : ''}`]] : [];
      this.tip({ title: esc(name), rows: [...own(e.owner), ['length', fmtLen(e.len) + (e.sections.length ? ' · ' + e.sections.map((s) => s.type).join(', ') : '')], ...tramRow] }, 'info');
    } else if (hit.kind === 'building') {
      const b = g.world.buildings.get(hit.id)!;
      ov.setFootprints([{ x: b.x, z: b.z, angle: b.angle, w: b.w, d: b.d, color: 0xffb020, lift: 0.08 }]);
      this.tip({ title: esc(g.towns.list[b.townId]?.name ?? 'Building'), rows: [['people', `<b>${b.pop}</b> residents in this building`]] }, 'info');
    } else if (hit.kind === 'town') {
      this.hideTip();
    }
  }

  // ------------------------------------------------------------------ signals: series along a track
  /** Preview of block signals (or their removal) from the press point along the track towards the cursor. */
  private hoverSignalDrag(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const d = this.down!.ground!;
    if (!this.sigDrag) {
      const ne = net.nearestEdge(d.x, d.z, 1.4, 'rail', (e) => e.station < 0 && e.depot < 0);
      if (!ne || ne.edge.owner !== PLAYER) { ov.setSignalGhosts(null); this.tip({ title: 'Block signals', err: [ne ? `Track of ${g.company(ne.edge.owner).name}` : 'Start the drag on one of your tracks'] }, 'err'); return; }
      this.sigDrag = { edge: ne.edge.id, s0: ne.s, dir: 1, len: 0 };
    }
    const sd = this.sigDrag;
    const e = net.edges.get(sd.edge);
    if (!e) { this.sigDrag = null; return; }
    const q = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
    net.pointAt(e, sd.s0, q, t);
    sd.dir = (p.x - q.x) * t.x + (p.z - q.z) * t.z >= 0 ? 1 : -1;
    sd.len = Math.hypot(p.x - q.x, p.z - q.z);
    ov.setMarker('hover0', null);
    if (this.signalMode === 'remove') {
      ov.setSignalGhosts(null);
      this.tip({ title: 'Remove signals', rows: [['length', `along ${fmtLen(sd.len)} of track`]], hint: 'Release to remove' }, 'err');
      return;
    }
    const lay = signalsAlong(g, sd.edge, sd.dir, this.signalSpacing, PLAYER, Math.max(1, sd.len), { s0: sd.s0, kind: this.signalKind, signalKind: this.signalClass, pass: this.signalKind === 'oneway' && this.signalPass });
    const ghosts = lay.spots.map((sp) => {
      const ee = net.edges.get(sp.edge)!, pp = { x: 0, y: 0, z: 0 }, dd = { x: 0, y: 0, z: 0 };
      net.pointAt(ee, sp.s, pp, dd);
      const f = sp.forward ? 1 : -1;
      return { x: pp.x, y: pp.y, z: pp.z, dx: dd.x * f, dz: dd.z * f, existing: sp.signal > 0, twoWay: this.signalKind === 'twoway' };
    });
    ov.setSignalGhosts(ghosts);
    const fresh = lay.spots.filter((sp) => !sp.signal).length;
    const STOP: Record<string, string> = { switch: 'stops at a switch', station: 'stops at a station', depot: 'stops at a depot', foreign: 'stops at another company\u2019s track', end: 'stops at the track end', loop: 'the loop is closed' };
    this.tip({
      title: `${this.signalKind === 'oneway' ? 'One-way' : 'Two-way'} ${this.signalClass} signals`, cost: lay.cost,
      rows: [['signal', `<b>${lay.spots.length}</b> signal${lay.spots.length === 1 ? '' : 's'}${fresh < lay.spots.length ? ` (${fresh} new)` : ''} every ${fmtLen(this.signalSpacing)}`], ['length', `${fmtLen(lay.length)}${STOP[lay.stop] ? ' · ' + STOP[lay.stop] : ''}`]],
      err: lay.spots.length ? [] : ['No room for signals here'], warn: g.economy.canAfford(lay.cost) ? [] : ['Not enough money'], hint: 'Release to place',
    }, lay.spots.length ? 'ok' : 'err');
  }

  private commitSignalDrag() {
    const g = this.game, sd = this.sigDrag;
    this.sigDrag = null;
    this.overlay.setSignalGhosts(null);
    if (!sd) return;
    const at = this.ground;
    if (this.signalMode === 'remove') {
      const r = clearSignalsAlong(g, sd.edge, sd.dir, PLAYER, Math.max(1, sd.len), { s0: sd.s0 });
      if (r.removed) { this.ui.toast(`${plural(r.removed, 'signal')} removed`, 'info'); this.ui.sound('demolish', at ? { x: at.x, z: at.z, pitch: 1.3 } : {}); }
      else this.ui.toast('No signals there', 'info');
      return;
    }
    const r = autoSignals(g, sd.edge, sd.dir, this.signalSpacing, PLAYER, Math.max(1, sd.len), { s0: sd.s0, kind: this.signalKind, signalKind: this.signalClass, pass: this.signalKind === 'oneway' && this.signalPass });
    if (r.placed) {
      if (r.cost > 0) this.ui.floatCost(r.cost, this.client.x, this.client.y);
      this.ui.sound('signal', at ? { x: at.x, z: at.z } : {});
      this.ui.toast(`${plural(r.placed, `${this.signalKind === 'oneway' ? 'one-way' : 'two-way'} ${this.signalClass} signal`)} placed${r.error ? ` — ${r.error}` : ''}`, r.error ? 'info' : 'good');
    } else this.ui.toast(r.error ?? 'No room for signals here', 'bad');
  }

  /** Remove the signal nearest to a point (own track). */
  private removeSignalAt(x: number, z: number) {
    const g = this.game, net = g.world.net;
    const n = net.nearestNode(x, z, 0.9, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
    if (!n) return;
    if (n.owner !== PLAYER) { this.ui.toast(`Signal of ${g.company(n.owner).name}`, 'bad'); return; }
    const e = net.edges.get(n.edges[0]);
    if (!e) return;
    const err = setSignal(g, e.id, e.a === n.id ? 0 : e.len, 'none', true, PLAYER);
    if (err) this.ui.toast(err, 'bad');
    else this.ui.sound('signal', { x: n.x, z: n.z, pitch: 0.8 });
  }

  // ------------------------------------------------------------------ double track
  /** Own single track for doubling: the edge under the cursor, or the track from the press point to it. */
  private hoverDouble(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const ok = (e: NEdge) => e.owner === PLAYER && e.station < 0 && e.depot < 0;
    const cur = net.nearestEdge(p.x, p.z, 1.4, 'rail', ok);
    let chain: number[] = [];
    const d = this.down;
    if (d && d.button === 0 && d.moved && d.ground) {
      const st = net.nearestEdge(d.ground.x, d.ground.z, 1.4, 'rail', ok);
      if (st) chain = cur && cur.edge.id !== st.edge.id ? railChain(g, st.edge.id, cur.edge.id) ?? [st.edge.id] : [st.edge.id];
    } else if (cur) chain = [cur.edge.id];
    if (!chain.length) {
      this.dbl = null;
      ov.setProposal(null); ov.setHoverEdge(null); ov.setMarker('start', null); ov.setMarker('hover0', null);
      const other = net.nearestEdge(p.x, p.z, 1.4, 'rail');
      this.tip(other ? { title: 'Double track', err: [other.edge.owner !== PLAYER ? `Track of ${g.company(other.edge.owner).name}` : other.edge.station >= 0 ? 'Not inside stations' : 'Not on depot tracks'] } : { title: 'Double track', rows: [['parallel', 'Point at one of your single tracks, or drag along it']] }, other ? 'err' : 'info');
      return;
    }
    const key = `${chain.join(',')}|${this.doubleSide}|${g.networkVersion}`;
    if (this.dbl?.key !== key) {
      const sides: (1 | -1)[] = this.doubleSide === 'left' ? [-1] : this.doubleSide === 'right' ? [1] : [1, -1];
      let plan: DoublePlan | null = null, flipped = false;
      for (const sd of sides) {
        const pl = planDoubleTrack(g, chain, sd, PLAYER);
        if (!plan || pl.ok) { flipped = plan !== null; plan = pl; }
        if (pl.ok) break;
      }
      this.dbl = { key, chain, plan, flipped };
    }
    const pl = this.dbl.plan!;
    ov.setHoverEdge(chain, 0xffb020);
    ov.setProposal(mergedProposal(pl));
    const a = pl.points[0], b = pl.points[pl.points.length - 1];
    const y = (q: { x: number; z: number; y: number }) => ({ x: q.x, y: q.y, z: q.z });
    ov.setMarker('start', a ? y(a) : null, 'node', pl.ok ? 0x5ff07a : 0xff5a4a);
    ov.setMarker('hover0', b ? y(b) : null, 'node', pl.ok ? 0x5ff07a : 0xff5a4a);
    const endText = (e: DoublePlan['start']) => (e.kind === 'platform' ? 'into a free platform' : 'switch');
    const rows: [string, string][] = [
      ['length', `<b>${fmtLen(pl.length)}</b> of new track${chain.length > 1 ? ` along ${chain.length} sections` : ''}`],
      ['parallel', `${pl.side > 0 ? 'Right' : 'Left'} side${this.dbl.flipped ? ' (the other side is blocked)' : ''}`],
      ['rail', `Ends: ${endText(pl.start)} · ${endText(pl.end)}`],
    ];
    const walls = this.retainingWallRow(pl.proposals);
    if (walls) rows.push(walls);
    if (this.directional) rows.push(['signal', `Directional: ${this.rightHand ? 'right' : 'left'}-hand running, block signals, crossovers before stations`]);
    this.tip({ title: 'Double track', cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : pl.errors.slice(0, 3), warn: pl.warnings, hint: pl.ok ? (d?.moved ? 'Release to build' : 'Click to build · drag along the line for more') : 'Try the other side or a shorter stretch' }, pl.ok ? 'ok' : 'err');
  }

  private commitDouble() {
    const g = this.game, pl = this.dbl?.plan;
    if (!pl) return;
    if (!pl.ok) { this.ui.toast(pl.errors[0] ?? 'Cannot build', 'bad'); return; }
    const res = commitDoubleTrack(g, pl, this.directional, { rightHand: this.rightHand });
    this.dbl = null;
    this.overlay.setProposal(null);
    this.overlay.setMarker('start', null);
    if (res.error) { this.ui.toast(res.error, 'bad'); return; }
    this.ui.floatCost(res.cost, this.client.x, this.client.y);
    const at = this.ground;
    this.ui.sound('build-rail', at ? { x: at.x, z: at.z } : {});
    const extra = this.directional ? ` · ${plural(res.signals, 'signal')} · ${plural(res.crossovers, 'crossover')}` : '';
    this.ui.toast(`Double track: ${fmtLen(pl.length)}${extra}${res.finishError ? ` — ${res.finishError}` : ''}`, res.finishError ? 'info' : 'good');
    this.moveDirty = true;
  }

  /** Directional running after a two-track build (one way per track, signals, crossovers before stations). */
  private finishDouble(edges: number[]) {
    const g = this.game;
    if (edges.length < 2) return;
    const f = finishDoubleTrack(g, edges, PLAYER, { rightHand: this.rightHand });
    if (f.error) { this.ui.toast(`Double track kept two-way: ${f.error}`, 'info'); return; }
    // signals are visible on the track; crossovers are worth a word (once per chain)
    if (f.crossovers) this.ui.toast(`Directional double track: ${plural(f.crossovers, 'crossover')} before the station · ${plural(f.signals, 'signal')}`, 'good');
    else if (f.signals && !this.finishTold) { this.finishTold = true; this.ui.toast(`Directional double track: one way per track, ${plural(f.signals, 'block signal')}`, 'good'); }
  }

  // ------------------------------------------------------------------ electrification
  /** Track to wire: the track under the cursor, or along the track from the press point to it (any track you may use). */
  private hoverElectrify(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const hit = (x: number, z: number) => net.nearestEdge(x, z, 1.4, 'rail', (e) => e.depot < 0);
    const along = (e: NEdge) => e.depot < 0 && g.canUse(PLAYER, e.owner);
    const cur = hit(p.x, p.z);
    let ids: number[] = [];
    const d = this.down;
    if (d && d.button === 0 && d.moved && d.ground) {
      const st = hit(d.ground.x, d.ground.z);
      if (st) ids = cur && cur.edge.id !== st.edge.id ? railChain(this.game, st.edge.id, cur.edge.id, 200, along) ?? [st.edge.id] : [st.edge.id];
    } else if (cur) ids = [cur.edge.id];
    if (!ids.length) {
      this.elec = null;
      ov.setHoverEdge(null);
      this.tip({ title: 'Electrify', rows: [['bolt', 'Point at a track, or drag along a line']] }, 'info');
      return;
    }
    const key = ids.join(',') + '|' + g.networkVersion;
    if (this.elec?.key !== key) this.elec = { key, ids, ...electrify(g, ids, PLAYER, true) };
    const r = this.elec;
    ov.setHoverEdge(ids, r.changed ? 0xffd84a : 0x8490a2);
    let len = 0;
    for (const id of ids) len += net.edges.get(id)?.len ?? 0;
    const rows: [string, string][] = [['length', `<b>${fmtLen(r.length)}</b> of track to wire${ids.length > 1 ? ` · ${ids.length} sections` : ''}`]];
    if (r.changed && len - r.length > 0.5) rows.push(['check', `${fmtLen(len - r.length)} electrified already (or not standard track)`]);
    rows.push(['bolt', 'Standard → electrified track: electric locomotives and EMUs can run']);
    const ownerOf = ids.map((id) => net.edges.get(id)?.owner ?? PLAYER).find((o) => o !== PLAYER && o >= 0);
    if (ownerOf !== undefined) rows.push(['company', `Track of ${esc(g.company(ownerOf).name)} — stays theirs, you pay the wire`]);
    this.tip({
      title: 'Electrify', cost: r.changed ? r.cost : undefined, rows,
      err: r.changed ? [] : [r.error ?? 'Already electrified'],
      warn: r.changed && r.error ? [r.error] : r.changed && !g.economy.canAfford(r.cost) ? ['Not enough money'] : [],
      hint: d?.moved ? 'Release to electrify' : 'Click to electrify · drag along the line for more',
    }, r.changed ? 'ok' : 'err');
  }

  private commitElectrify() {
    const g = this.game, e = this.elec;
    this.elec = null;
    this.overlay.setHoverEdge(null);
    if (!e || !e.ids.length) return;
    const r = electrify(g, e.ids, PLAYER);
    if (!r.changed) {
      const who = accessOwnerOf(g, r.error ?? undefined);
      if (who !== null) { requestAccessUI(this.ui, who); return; }
      this.ui.toast(r.error ?? 'Nothing to electrify here', 'bad');
      return;
    }
    this.ui.floatCost(r.cost, this.client.x, this.client.y);
    this.ui.sound('build-rail', this.ground ? { x: this.ground.x, z: this.ground.z, pitch: 1.25 } : {});
    this.ui.toast(`${fmtLen(r.length)} of track electrified${r.error ? ` — ${r.error}` : ''}`, r.error ? 'info' : 'good');
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ connecting two tracks
  /** Point under the cursor on plain track (not platforms or depot tracks) for a turnout. */
  private connPoint(): { edge: NEdge; s: number; x: number; y: number; z: number } | null {
    const net = this.game.world.net, p = this.ground;
    if (!p) return null;
    const plain = (e: NEdge) => e.station < 0 && e.depot < 0;
    const hit = this.edgeAtCursor('rail', plain, 14);
    const ne = hit ? net.nearestEdge(hit.x, hit.z, 0.6, 'rail', (e) => e.id === hit.edge.id) : net.nearestEdge(p.x, p.z, 1.2, 'rail', plain);
    if (!ne || ne.edge.len < 2.5) return null;
    const q = { x: 0, y: 0, z: 0 };
    const s = Math.max(1, Math.min(ne.edge.len - 1, Math.round(ne.s * 2) / 2));
    net.pointAt(ne.edge, s, q);
    return { edge: ne.edge, s, x: q.x, y: q.y, z: q.z };
  }

  private connKey(a: { edge: number; s: number }, b: { edge: NEdge; s: number }) { return `${a.edge}|${a.s}|${b.edge.id}|${b.s}|${this.game.networkVersion}`; }

  /** First click: a point on one track; then the connecting curve to the track under the cursor (planned, throttled). */
  private hoverConnect(p: THREE.Vector3) {
    void p;
    const g = this.game, ov = this.overlay;
    const pt = this.connPoint();
    if (!this.conn) {
      ov.setProposal(null); ov.setDemolish(null);
      if (!pt) { ov.setHoverEdge(null); ov.setMarker('hover0', null); this.tip({ title: 'Connect tracks', rows: [['connect', 'Click a point on the first track']] }, 'info'); return; }
      const err = g.canUse(PLAYER, pt.edge.owner) ? '' : `Track of ${g.company(pt.edge.owner).name}: needs track access`;
      ov.setHoverEdge(pt.edge.id, err ? 0xff5a4a : 0xffb020);
      ov.setMarker('hover0', pt, 'edge', err ? 0xff5a4a : 0xffd84a);
      const tt = (TRACK_TYPES[pt.edge.type] ?? TRACK_TYPES.standard).name;
      this.tip(err ? { title: 'Connect tracks', err: [err], hint: 'Click to request track access' } : { title: 'Connect tracks', rows: [['connect', 'Click to put the first turnout here'], ['rail', esc(tt) + (pt.edge.owner !== PLAYER ? ' · ' + esc(g.company(pt.edge.owner).name) : '')]] }, err ? 'err' : 'info');
      return;
    }
    const a = this.conn;
    if (!pt || pt.edge.id === a.edge) {
      ov.setProposal(null); ov.setDemolish(null); ov.setMarker('hover0', null);
      ov.setHoverEdge(a.edge, 0xffb020);
      this.tip({ title: 'Connect tracks', rows: [['connect', 'Now point at the other track']], hint: 'Esc or right-click picks the first track again' }, 'info');
      return;
    }
    const key = this.connKey(a, pt);
    if (this.connPlan?.key !== key) {
      // planning tries a few turnout positions: at most ~10 plans a second while the cursor moves
      if (this.connPlan && performance.now() - this.connAt < 100) { this.moveDirty = true; return; }
      this.connPlan = { key, plan: planConnection(g, a.edge, a.s, pt.edge.id, pt.s, PLAYER, { search: 2 }) };
      this.connAt = performance.now();
    }
    this.showConnPlan(this.connPlan.plan, a.edge, pt.edge.id);
  }

  private showConnPlan(pl: ConnectionPlan, ea: number, eb: number) {
    const g = this.game, ov = this.overlay;
    ov.setProposal(pl.proposal);
    ov.setDemolish(pl.proposal?.demolish ?? null);
    ov.setHoverEdge([ea, eb], pl.ok ? 0xffb020 : 0xff5a4a);
    const t1 = pl.turnouts[1];
    ov.setMarker('hover0', t1 ? { x: t1.x, y: g.world.net.edges.get(t1.edge) ? g.world.net.heightAtS(g.world.net.edges.get(t1.edge)!, t1.s) : 0, z: t1.z } : null, 'edge', pl.ok ? 0x5ff07a : 0xff5a4a);
    const rows: [string, string][] = [];
    if (pl.ok) {
      rows.push(['length', `<b>${fmtLen(pl.length)}</b> connecting curve`]);
      const R = pl.minRadius;
      const type = pl.proposal?.opts.type ?? g.world.net.edges.get(ea)?.type ?? 'standard';
      rows.push(['radius', isFinite(R) && R < 5000 ? `radius <b>${Math.round(R * 10).toLocaleString('en-US')} m</b> · ${Math.round(Math.min((TRACK_TYPES[type] ?? TRACK_TYPES.standard).speed, curveSpeed(R, type)))} km/h` : 'straight']);
      rows.push(['rail', '2 turnouts · path signals where the line is signalled']);
      if (pl.proposal?.stats.bridges || pl.proposal?.stats.tunnels) rows.push(['bridge', `<span class="tt-hot">${pl.proposal.stats.bridges ? plural(pl.proposal.stats.bridges, 'bridge') : ''}${pl.proposal.stats.bridges && pl.proposal.stats.tunnels ? ' · ' : ''}${pl.proposal.stats.tunnels ? plural(pl.proposal.stats.tunnels, 'tunnel') : ''}</span>`]);
    }
    const walls = pl.proposal ? this.retainingWallRow([pl.proposal]) : null;
    if (walls) rows.push(walls);
    const warn = [...pl.warnings];
    if (pl.ok && pl.proposal?.demolish.length) warn.unshift(`Demolishes ${plural(pl.proposal.demolish.length, 'building')}`);
    this.tip({ title: 'Connect tracks', cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : [pl.error ?? 'Cannot connect here'], warn, hint: pl.ok ? 'Click to build · Esc picks again' : 'Try another point, or click to search nearby' }, pl.ok && g.economy.canAfford(pl.cost) ? 'ok' : 'err');
  }

  private clickConnect() {
    const g = this.game;
    const pt = this.connPoint();
    if (!this.conn) {
      if (!pt) { this.ui.toast('Click on a track (not a platform or depot track)', 'bad'); return; }
      if (!g.canUse(PLAYER, pt.edge.owner)) { requestAccessUI(this.ui, pt.edge.owner); return; }
      this.conn = { edge: pt.edge.id, s: pt.s, x: pt.x, y: pt.y, z: pt.z };
      this.overlay.setMarker('start0', pt, 'start', 0xffb020);
      this.ui.sound('click', { pitch: 1.1 });
      this.onToolChange();
      return;
    }
    if (!pt || pt.edge.id === this.conn.edge) { this.ui.toast('Click a point on another track', 'info'); return; }
    const a = this.conn, key = this.connKey(a, pt);
    let pl = this.connPlan?.key === key ? this.connPlan.plan : planConnection(g, a.edge, a.s, pt.edge.id, pt.s, PLAYER, { search: 2 });
    if (!pl.ok) {
      const who = accessOwnerOf(g, pl.error);
      if (who !== null) { requestAccessUI(this.ui, who); return; }
      // a wider search: the turnouts may move a little along their tracks
      const wide = planConnection(g, a.edge, a.s, pt.edge.id, pt.s, PLAYER, { search: 8 });
      if (wide.ok) { this.connPlan = { key, plan: wide }; this.showConnPlan(wide, a.edge, pt.edge.id); this.ui.toast('A curve fits with the turnouts moved a little — click again to build it', 'info'); return; }
      this.ui.toast(pl.error ?? 'Cannot connect the tracks here', 'bad');
      return;
    }
    if (!g.economy.canAfford(pl.cost)) { this.ui.toast('Not enough money', 'bad'); return; }
    const r = commitConnection(g, pl);
    if (r.error) { this.ui.toast(r.error, 'bad'); this.connPlan = null; return; }
    this.ui.floatCost(pl.cost, this.client.x, this.client.y);
    this.ui.sound('build-rail', { x: pt.x, z: pt.z });
    this.ui.toast(`Tracks connected: ${fmtLen(pl.length)}${r.signals ? ` · ${plural(r.signals, 'signal')}` : ''}`, 'good');
    pl = pl as ConnectionPlan;
    this.clearConn();
  }

  // ------------------------------------------------------------------ re-level (lift / sink track in place)
  /** Own track to lift / sink: the track under the cursor, or along it from the press point (stations on it go along). */
  private hoverRelevel(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const ok = (e: NEdge) => e.owner === PLAYER && e.depot < 0;
    const cur = net.nearestEdge(p.x, p.z, 1.4, 'rail', ok);
    let chain: number[] = [];
    const d = this.down;
    if (d && d.button === 0 && d.moved && d.ground) {
      const st = net.nearestEdge(d.ground.x, d.ground.z, 1.4, 'rail', ok);
      if (st) chain = cur && cur.edge.id !== st.edge.id ? railChain(g, st.edge.id, cur.edge.id, 120, ok) ?? [st.edge.id] : [st.edge.id];
    } else if (cur) chain = [cur.edge.id];
    const title = this.relevelTo === 'elevated' ? 'Lift onto a viaduct' : this.relevelTo === 'underground' ? 'Sink into a tunnel' : 'Back to the ground';
    if (!chain.length) {
      this.rlv = null;
      ov.setProposal(null); ov.setHoverEdge(null);
      const other = net.nearestEdge(p.x, p.z, 1.4, 'rail');
      this.tip(other ? { title, err: [other.edge.depot >= 0 ? 'Depot tracks stay on the ground' : `Track of ${g.company(other.edge.owner).name}`] } : { title, rows: [['relevel', 'Point at your track, or drag along a stretch']] }, other ? 'err' : 'info');
      return;
    }
    const key = `${chain.join(',')}|${this.relevelTo}|${this.levelHeight}|${this.levelDepth}|${g.networkVersion}`;
    if (this.rlv?.key !== key) {
      let plan: RelevelPlan;
      try { plan = planRelevel(g, chain, this.relevelTo, PLAYER, { height: this.levelHeight, depth: this.levelDepth }); }
      catch (e) { plan = { ok: false, error: (e as Error).message, warnings: [], owner: PLAYER, level: this.relevelTo, cost: 0, edges: [], nodes: [], stations: [], crossings: [], ramps: [] }; }
      this.rlv = { key, chain, plan };
    }
    const pl = this.rlv.plan!;
    ov.setProposal(relevelPreview(this.game, pl));
    ov.setHoverEdge(chain, pl.ok ? 0xffb020 : 0xff5a4a);
    let len = 0;
    for (const x of pl.edges.length ? pl.edges : chain.map((id) => ({ id }))) len += net.edges.get(x.id)?.len ?? 0;
    const rows: [string, string][] = [['length', `<b>${fmtLen(len)}</b> of track${pl.edges.length > 1 ? ` · ${pl.edges.length} sections` : ''}`]];
    if (this.relevelTo !== 'ground') rows.push([this.relevelTo === 'elevated' ? 'bridge' : 'tunnel', this.relevelTo === 'elevated' ? `deck <b>${Math.round(this.levelHeight * 10)} m</b> up` : `<b>${Math.round(this.levelDepth * 10)} m</b> deep`]);
    if (pl.ramps.length) rows.push(['grade', `ramps ${pl.ramps.map((r) => fmtLen(r)).join(' · ')}`]);
    if (pl.stations.length) rows.push(['station', `${pl.stations.map((s) => esc(g.stations.get(s.id)?.name ?? '?')).join(', ')} go${pl.stations.length === 1 ? 'es' : ''} with it`]);
    if (pl.crossings.length) rows.push(['crossing', `${plural(pl.crossings.length, 'level crossing')} become${pl.crossings.length === 1 ? 's' : ''} grade-separated`]);
    const err = pl.ok ? [] : [pl.error ?? 'Cannot re-level here'];
    this.tip({ title, cost: pl.ok ? pl.cost : undefined, rows, err, warn: [...pl.warnings], hint: pl.ok ? (d?.moved ? 'Release to rebuild' : 'Click to rebuild · drag along the line for more') : undefined }, pl.ok && g.economy.canAfford(pl.cost) ? 'ok' : 'err');
  }

  private commitRelevel() {
    const g = this.game, r = this.rlv;
    this.rlv = null;
    this.overlay.setProposal(null);
    this.overlay.setHoverEdge(null);
    if (!r?.plan) return;
    if (!r.plan.ok) { this.ui.toast(r.plan.error ?? 'Cannot re-level here', 'bad'); return; }
    const before = g.economy.money;
    let err: string | null;
    try { err = commitRelevel(g, r.plan); } catch (e) { err = (e as Error).message; }
    if (err === 'busy') { this.ui.toast('A train is on this stretch — try again in a moment', 'info'); return; }
    if (err) { this.ui.toast(err, 'bad'); return; }
    this.ui.floatCost(Math.max(0, before - g.economy.money), this.client.x, this.client.y);
    this.ui.sound('build-rail', this.ground ? { x: this.ground.x, z: this.ground.z, pitch: 0.9 } : {});
    this.ui.toast(r.plan.level === 'elevated' ? 'Track lifted onto a viaduct' : r.plan.level === 'underground' ? 'Track sunk into a tunnel' : 'Track back on the ground', 'good');
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ stations inserted into a line
  /** Preview of a through station cut into one of your tracks at the cursor (planStationOnTrack). */
  private hoverStationOnLine(p: THREE.Vector3) {
    const g = this.game, net = g.world.net, ov = this.overlay;
    const ne = net.nearestEdge(p.x, p.z, 1.6, 'rail', (e) => e.station < 0 && e.depot < 0);
    if (!ne || ne.edge.owner !== PLAYER) {
      this.onTrack = null;
      ov.setStationGhost(null); ov.setSegments('throat', null); drawCatchStreets(ov, 'hover', null);
      this.tip(ne ? { title: 'Station on the line', err: [`Track of ${g.company(ne.edge.owner).name}`] } : { title: 'Station on the line', rows: [['station', 'Point at one of your tracks: the station is cut into the line there']] }, ne ? 'err' : 'info');
      return;
    }
    const s = Math.round(ne.s * 2) / 2;
    const key = `${ne.edge.id}|${s}|${this.stationLen}|${this.stationTracks}|${this.stationThrough}|${this.throughMode}|${this.stationLevel}|${g.networkVersion}`;
    if (this.onTrack?.key !== key) {
      const plan = planStationOnTrack(g, ne.edge.id, s, { length: this.stationLen, tracks: this.stationTracks, through: this.stationThrough, throughMode: this.throughMode, level: this.stationLevel === 'ground' ? undefined : this.stationLevel }, PLAYER);
      this.onTrack = { key, plan, edge: ne.edge.id };
    }
    const pl = this.onTrack.plan, st = pl.station;
    ov.setStationGhost(st);
    ov.setSegments('throat', pl.throat, pl.ok ? 0xffd84a : 0xff6b6b);
    if (st) {
      drawCatchStreets(ov, 'hover', planCatchStreets(g, st), pl.ok ? undefined : 0xff6b6b);
    } else drawCatchStreets(ov, 'hover', null);
    const rows: [string, string][] = [];
    if (st) {
      rows.push(['station', `${plural(st.tracks, 'platform track')}${st.through ? ` + ${st.through} through` : ''} × ${st.length * 10} m`]);
      rows.push(['rail', `cuts the ${pl.mains.length > 1 ? 'double' : 'single'} track; ${plural(pl.throat.length, 'throat connection')}`]);
      if (st.level !== 'ground') rows.push([st.level === 'elevated' ? 'bridge' : 'tunnel', st.level === 'elevated' ? 'elevated with the line' : 'underground with the line']);
      rows.push(['people', `<b>${catchStreetPop(g, planCatchStreets(g, st)).toLocaleString('en-US')}</b> residents in walking reach`]);
    }
    this.tip({ title: 'Station on the line', cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : [pl.error ?? 'Cannot build here'], warn: [...pl.warnings, ...(pl.ok && !g.economy.canAfford(pl.cost) ? ['Not enough money'] : [])], hint: pl.ok ? 'Click to build · trains keep running through it' : 'Straight, level track is needed for the platforms' }, pl.ok ? 'ok' : 'err');
  }

  private commitStationOnLine(e: PointerEvent) {
    const g = this.game, ot = this.onTrack;
    if (!ot || !ot.plan.ok) { this.ui.toast(ot?.plan.error ?? 'Point at one of your tracks', 'bad'); return; }
    // lines running over the cut stretch (to offer signalling them afterwards)
    const cut = new Set(ot.plan.mains.flatMap((m) => m.steps.map((x) => x.edge)));
    const lines = g.lines.all().filter((l) => l.owner === PLAYER && l.kind === 'rail' && computeLinePath(g, l).edges.some((arr) => Array.from(arr).some((se) => cut.has(Math.abs(se) - 1))));
    const before = g.economy.money;
    const r = commitStationOnTrack(g, ot.plan);
    this.onTrack = null;
    if (r.error === 'busy') { this.ui.toast('A train is on this stretch — try again in a moment', 'info'); return; }
    if (r.error) { this.ui.toast(r.error, 'bad'); return; }
    this.overlay.setSegments('throat', null);
    this.ui.floatCost(Math.max(0, before - g.economy.money), e.clientX, e.clientY);
    const st = g.stations.get(r.station);
    if (st) this.ui.sound('station', { x: st.x, z: st.z });
    const line = lines[0];
    this.ui.toastAction(`${st?.name ?? 'Station'} built into the line${line ? ` — ${line.name} can add the stop` : ''}`, 'good', 'Auto-signal', () => {
      if (line) openAutoSignal(this.ui, { line: line.id });
      else if (st?.rail) openAutoSignal(this.ui, { edges: trackAround(g, st.rail.edges.concat(st.rail.throughEdges), 300), label: `Track around ${st.name}` });
    });
  }

  // ------------------------------------------------------------------ station entrances
  private hoverEntrance(p: THREE.Vector3) {
    const g = this.game, ov = this.overlay;
    const st = this.entranceStation != null ? g.stations.get(this.entranceStation) : undefined;
    const r = st?.rail;
    if (!st || !r) { ov.setFootprints(null); ov.setProposal(null); drawCatchStreets(ov, 'hover', null); this.tip({ title: 'Add entrance', err: ['Pick a station first (station window → Build → Add entrance)'] }, 'err'); return; }
    const ground = r.level === 'ground';
    const pl = g.stations.planEntrance(st.id, p.x, p.z, PLAYER, ground ? this.entranceKind : undefined);
    const T = ENTRANCE_TYPES[pl.kind];
    // its landings (paler where no road passes), and a ground entrance's way across the tracks
    const sites = pl.landings.length ? pl.landings : [{ x: p.x, z: p.z, angle: r.angle, road: false }];
    const rects: FootRect[] = sites.map((q) => ({ x: q.x, z: q.z, angle: q.angle, w: T.w, d: T.d, color: !pl.ok ? 0xff6b6b : q.road ? 0x46e07a : 0xb9dd8f, lift: 0.12 }));
    if (ground && pl.entrance && pl.kind !== 'gate') {
      const a = entranceAlong(r, pl.entrance), fx = Math.sin(r.angle), fz = Math.cos(r.angle);
      rects.push({ x: r.x + fx * a, z: r.z + fz * a, angle: r.angle + Math.PI / 2, w: 0.26, d: railWidth(r) + 0.3, color: pl.ok ? 0x9fe3b4 : 0xff9a8a, y: r.y + (pl.kind === 'footbridge' ? 0.75 : 0.14), lift: 0.02 });
    }
    ov.setFootprints(rects);
    ov.setProposal(pl.access ?? null);
    const gone = pl.ok ? pl.access?.demolish ?? [] : [];
    ov.setDemolish(gone.length ? gone : null);
    // (the forecast leaves out the buildings its access street demolishes)
    const walk = pl.ok ? entrancePlanCatchment(g, st, pl) : null;
    drawCatchStreets(ov, 'hover', walk);
    const cm = catchModeOf(railModeOf(r.trackType)), R = catchWalkLimit(cm, catchBonusOf(r.style));
    let fresh = 0, reach = 0;
    if (walk) {
      const covered = walkingCatchment(g, st).buildings;
      for (const id of walk.buildings.keys()) { const b = g.world.buildings.get(id); if (!b) continue; reach += b.pop; if (!covered.has(id)) fresh += b.pop; }
    }
    const rows: [string, string][] = pl.ok ? [['entrance', esc(T.desc)], ['people', `<b>${fresh.toLocaleString('en-US')}</b> residents newly within ${Math.round(R * 10)} m walking (${reach.toLocaleString('en-US')} in its reach)`]] : [];
    if (pl.ok && pl.landings.length > 1) rows.push(['walk', `Stairs on both sides of the tracks · ${pl.landings.filter((q) => q.road).length === 2 ? 'streets on both' : 'a street on one'}`]);
    if (pl.access) rows.push(['road', `Access street ${fmtLen(pl.access.stats.len)} · ${fmtMoney(pl.access.cost)} (included)`]);
    if (pl.ok) rows.push(['coin', `Upkeep ${fmtMoney(T.upkeep)} a year`]);
    const warn = pl.ok ? [...pl.warnings] : [];
    if (gone.length) warn.push(`Its access street demolishes ${plural(gone.length, 'building')} (${gone.reduce((n, id) => n + (g.world.buildings.get(id)?.pop ?? 0), 0).toLocaleString('en-US')} residents)`);
    this.tip({ title: `${T.name} · ${esc(st.name)}`, cost: pl.ok ? pl.cost : undefined, rows, err: pl.ok ? [] : [pl.error ?? 'Cannot build here'], warn, hint: ground ? 'Click beside the tracks to build · Esc when done' : 'Click to build · Esc when done' }, pl.ok ? 'ok' : 'err');
  }

  /** Object under a ground point (stations first, then depots, network, buildings, towns). */
  hitAt(x: number, z: number): Hit | null {
    const g = this.game;
    for (const st of g.stations.footprintsNear(x, z, 0.05)) return { kind: 'station', id: st.id };
    for (const st of g.stations.map.values()) for (const s of st.stops) if (Math.hypot(s.x - x, s.z - z) < 0.75) return { kind: 'station', id: st.id };
    const dp = g.depots.near(x, z, 0.05)[0];
    if (dp) return { kind: 'depot', id: dp.id };
    const ne = g.world.net.nearestEdge(x, z, 0.55);
    if (ne) {
      if (ne.edge.station >= 0 && g.stations.get(ne.edge.station)) return { kind: 'station', id: ne.edge.station };
      if (ne.edge.depot >= 0 && g.depots.get(ne.edge.depot)) return { kind: 'depot', id: ne.edge.depot };
      return { kind: 'edge', id: ne.edge.id };
    }
    for (const b of g.world.buildingsNear(x, z, 3)) if (distToRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.02) return { kind: 'building', id: b.id };
    let bt = -1, bd = Infinity;
    for (const t of g.towns.list) { const d = Math.hypot(t.x - x, t.z - z); if (d < Math.max(8, t.radius * 0.85) && d < bd) { bd = d; bt = t.id; } }
    if (bt >= 0) return { kind: 'town', id: bt };
    return null;
  }

  private setCircle(x: number, z: number, r: number, color: number) {
    const u = this.terr;
    if (!u.uCircle) return;
    u.uCircle.value.set(x, z, r, r > 0 ? 1 : 0);
    u.uCircleColor?.value.setHex(color);
  }

  /**
   * Platform track type of a planned station: the chosen one, else ('auto') the type of the track it lines up with,
   * else the main-line track tool's type (main line only).
   */
  stationTrackType(near?: string): string {
    if (this.stationType !== 'auto' && TRACK_TYPES[this.stationType]) return this.stationType;
    const moving = this.relocating != null ? this.game.stations.get(this.relocating)?.rail : null;
    if (moving && TRACK_TYPES[moving.trackType]) return moving.trackType;
    if (near && TRACK_TYPES[near] && (this.tool !== 'station' || TRACK_TYPES[near].mode === 'mainline')) return near;
    if (this.tool === 'metro-station') return 'metro';
    const rt = (this.profiles.get('rail')?.railType as string | undefined) ?? 'standard';
    return TRACK_TYPES[rt]?.mode === 'mainline' ? rt : 'standard';
  }

  /** Building style of a planned station: the chosen one where it can be built, else the automatic one. */
  stationStyleFor(x: number, z: number, type: string): string {
    const lv = this.stationLevel, year = this.game.year;
    const moving = this.relocating != null ? this.game.stations.get(this.relocating)?.rail : null;
    // Existing buildings can be moved after their style has stopped being sold.
    if (moving && this.stationStyle === (moving.style ?? 'classic') && lv === moving.level && this.stationTracks === moving.tracks && STATION_STYLES[this.stationStyle]) return this.stationStyle;
    if (this.stationStyle !== 'auto' && stationStyles(lv, this.stationTracks, year).some((s) => s.id === this.stationStyle)) return this.stationStyle;
    return autoStationStyle(this.game, x, z, this.stationTracks, lv, railModeOf(type));
  }

  /** Plan a station at the current options (track type, level, height / depth, building style). */
  private planStation(x: number, z: number, angle: number, near?: string): StationPlan {
    const lv = this.stationLevel;
    const type = this.stationTrackType(near);
    return planStation(this.game, x, z, angle, this.stationLen, this.stationTracks, PLAYER, { level: lv, height: this.stationHeight, depth: this.stationDepth },
      { through: this.stationThrough, throughMode: this.throughMode, trackType: type, style: this.stationStyleFor(x, z, type), ...(this.relocating != null ? { ignoreStation: this.relocating } : {}) });
  }

  private coveredPop(x: number, z: number, r: number): number {
    const w = this.game.world;
    let pop = 0;
    for (const id of w.bgrid.query(x - r, z - r, x + r, z + r)) {
      const b = w.buildings.get(id);
      if (b && Math.hypot(b.x - x, b.z - z) <= r) pop += b.pop;
    }
    return pop;
  }

  // ------------------------------------------------------------------ placement helpers
  /** Station position/orientation at the cursor, lined up with a nearby track end or edge. */
  private stationPlacement(px: number, pz: number): { x: number; z: number; angle: number; snapped: '' | 'end' | 'edge'; type?: string } {
    const net = this.game.world.net;
    if (this.autoAlign) {
      const L = this.stationLen;
      const reach = L / 2 + 10;
      let best: NNode | null = null, bd = reach;
      for (const id of net.nodeGrid.query(px - reach, pz - reach, px + reach, pz + reach)) {
        const n = net.nodes.get(id);
        if (!n || n.kind !== 'rail' || n.edges.length !== 1 || n.owner !== PLAYER) continue;
        const e = net.edges.get(n.edges[0]);
        if (!e || e.depot >= 0 || e.station >= 0) continue;
        const d = Math.hypot(n.x - px, n.z - pz);
        if (d < bd) { bd = d; best = n; }
      }
      if (best) {
        const e = net.edges.get(best.edges[0])!;
        const ld = net.leaveDir(e, best.id);
        const ox = -ld.x, oz = -ld.z;
        const along0 = (px - best.x) * ox + (pz - best.z) * oz;
        if (along0 > -1) {
          const a = Math.atan2(ox, oz);
          const rx = Math.cos(a), rz = -Math.sin(a);
          let along = Math.max(L / 2 + 1.5, along0);
          const lat = (px - best.x) * rx + (pz - best.z) * rz;
          const offs = stationLayout(this.stationTracks).trackOffsets;
          let k = offs[0];
          for (const o of offs) if (Math.abs(lat + o) < Math.abs(lat + k)) k = o;
          // leave enough room to connect at the track's grade limit (station level follows the terrain)
          const grade = (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).maxGrade * 0.85;
          const y = this.game.stations.planRail(best.x + ox * along - rx * k, best.z + oz * along - rz * k, a, L, this.stationTracks, PLAYER).y;
          along = Math.max(along, L / 2 + Math.min(20, Math.max(1.5, Math.abs(y - best.y) / grade + 1.2)));
          return { x: best.x + ox * along - rx * k, z: best.z + oz * along - rz * k, angle: a, snapped: 'end', type: e.type };
        }
      }
      const ne = net.nearestEdge(px, pz, 3, 'rail', (e) => e.depot < 0 && e.station < 0);
      if (ne) {
        const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
        net.pointAt(ne.edge, ne.s, q, d);
        let a = Math.atan2(d.x, d.z);
        if (Math.cos(a - this.stationAngle) < 0) a += Math.PI;
        return { x: px, z: pz, angle: norm(a), snapped: 'edge', type: ne.edge.type };
      }
    }
    return { x: px, z: pz, angle: this.stationAngle, snapped: '' };
  }

  private planDepot(kind: DepotKind, px: number, pz: number): DepotPlan {
    const g = this.game;
    const pos = this.depotPlacement(kind, px, pz);
    const pl = g.depots.plan(kind, pos.x, pos.z, pos.angle, PLAYER);
    if (pl.snapNode >= 0) {
      const n = g.world.net.nodes.get(pl.snapNode);
      if (n && n.owner !== PLAYER && pl.ok) { pl.ok = false; pl.error = `Track owned by ${g.company(n.owner).name}`; }
    }
    return pl;
  }

  /** Depot position: road depots face the nearest road at a connectable distance. */
  private depotPlacement(kind: DepotKind, px: number, pz: number): { x: number; z: number; angle: number; road: boolean } {
    if (kind === 'road' || kind === 'tram') {
      const net = this.game.world.net;
      const ne = net.nearestEdge(px, pz, 4, 'road', (e) => e.depot < 0 && (kind !== 'tram' || tramUsable(this.game, e, PLAYER)));
      if (ne) {
        const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
        net.pointAt(ne.edge, ne.s, q, d);
        let ux = px - q.x, uz = pz - q.z;
        const l = Math.hypot(ux, uz);
        if (l < 0.05) { const dl = Math.hypot(d.x, d.z) || 1; ux = -d.z / dl; uz = d.x / dl; } else { ux /= l; uz /= l; }
        const sz = depotSize(kind);
        const off = net.halfWidth(ne.edge) + 1.25 + sz.d / 2 + 0.3;
        return { x: q.x + ux * off, z: q.z + uz * off, angle: Math.atan2(-ux, -uz), road: true };
      }
    }
    return { x: px, z: pz, angle: this.depotAngle, road: false };
  }

  // ------------------------------------------------------------------ planning (track / road)
  private validStart(): Snap | null {
    const s = this.start;
    if (!s) return null;
    const g = this.game, net = g.world.net;
    if (s.kind === 'node') {
      const n = net.nodes.get(s.node!);
      this.start = n ? findSnap(g, this.kind, n.x, n.z, 0.02) : findSnap(g, this.kind, s.x, s.z, 0.3);
    } else if (s.kind === 'edge' && !net.edges.has(s.edge!)) this.start = findSnap(g, this.kind, s.x, s.z, 0.3);
    return this.start;
  }

  private planNow(): Proposal | null {
    this.planDirty = false;
    const start = this.validStart();
    const end = this.hoverSnap;
    if (!start || !end) return null;
    const opts = this.buildOptions();
    const key = `${snapKey(start)}|${snapKey(end)}|${JSON.stringify(opts)}|${this.game.networkVersion}`;
    if (key === this.planKey && this.proposal) return this.proposal;
    this.planKey = key;
    const t0 = performance.now();
    const p = planEdge(this.game, start, end, opts);
    const own = this.ownErr(start) ?? this.ownErr(end);
    if (own) { p.ok = false; p.errors.unshift(own); }
    this.planMs = performance.now() - t0;
    this.planAt = performance.now();
    this.proposal = p;
    this.overlay.setProposal(p);
    this.overlay.setDemolish(p.demolish);
    this.showSnap('start', start, 0xffb020, 'start');
    this.showPlanTip();
    return p;
  }

  private commitChain() {
    const g = this.game;
    if (!this.start) return;
    if (this.ground && (!this.hoverSnap || this.planDirty || !this.proposal)) { this.hoverSnap = this.snapAt(this.kind); this.planKey = ''; }
    const p = this.planNow();
    if (!p) return;
    if (!p.ok) {
      const who = accessOwnerOf(g, p.errors[0]);
      if (who !== null) { requestAccessUI(this.ui, who); this.planKey = ''; return; }
      if (p.errors[0] !== 'Too short') this.ui.toast(p.errors[0] ?? 'Cannot build here', 'bad');
      return;
    }
    const e0 = g.world.net.nextEdge;
    const err = commitProposal(g, p);
    if (err) { this.ui.toast(err, 'bad'); return; }
    if (p.opts.kind === 'rail' && p.tracks.length === 2 && this.directional) {
      const created: number[] = [];
      for (let id = e0; id < g.world.net.nextEdge; id++) { const e = g.world.net.edges.get(id); if (e && e.kind === 'rail' && e.owner === PLAYER) created.push(id); }
      this.finishDouble(created);
    }
    this.ui.floatCost(p.cost, this.client.x, this.client.y);
    const end = this.hoverSnap!;
    this.ui.sound(p.opts.kind === 'rail' || p.opts.tram ? 'build-rail' : 'build-road', { x: end.x, z: end.z });
    this.proposal = null;
    this.overlay.setProposal(null);
    this.overlay.setDemolish(null);
    this.planKey = '';
    if (end.kind === 'free') {
      // continue the chain from the new end (tangent continuity comes from the end node direction)
      let x = 0, z = 0;
      for (const tp of p.tracks) { x += tp.bez.x3; z += tp.bez.z3; }
      x /= p.tracks.length; z /= p.tracks.length;
      const ns = findSnap(g, this.kind, x, z, 0.3);
      if (ns.kind === 'node') this.setStart(ns); else this.endChain();
    } else this.endChain();
    this.moveDirty = true;
  }

  private describeSnap(sn: Snap, err: string | null): Tip {
    const rail = this.kind === 'rail';
    const net = this.game.world.net;
    const so = this.snapOwner(sn);
    if (err && so !== null && !this.game.canUse(PLAYER, so)) {
      const st = accessState(this.game, so);
      return { title: `${esc(this.game.company(so).name)}'s network`, rows: [['key', `${policyText(this.game, so)} · shared maintenance ${fmtMult(this.game.accessMultiplier(so))}`]], err: [st.kind === 'pending' ? 'Access request pending' : st.kind === 'blocked' ? 'You are blocked from this network' : st.kind === 'closed' ? 'The owner refuses access' : 'Request access first'], hint: st.kind === 'none' ? 'Click to request track access' : undefined };
    }
    if (err) return { title: rail ? 'Track' : 'Road', err: [err] };
    const fo = this.foreignOwner(sn);
    if (fo !== null) return { title: `Junction on ${esc(this.game.company(fo).name)}'s network`, rows: [['company', `New track is yours, theirs stays theirs`], ['coin', `Shared maintenance ${fmtMult(this.game.accessMultiplier(fo))} when you run on it`]] };
    if (sn.kind === 'node') {
      const n = net.nodes.get(sn.node!);
      const cnt = sn.group?.length ?? 1;
      const st = n?.edges.map((id) => net.edges.get(id)).find((e) => e && e.station >= 0);
      if (st) return { title: 'Platform end', rows: [['rail', `Click to build out of the station${cnt > 1 ? ` (${cnt} tracks)` : ''}`]] };
      if (n && n.edges.length === 1) return { title: rail ? 'Track end' : 'Road end', rows: [[rail ? 'rail' : 'road', rail ? `Click to extend ${cnt > 1 ? `${cnt} parallel tracks` : 'the track'}` : 'Click to extend the road']] };
      return { title: rail ? 'Switch' : 'Junction', rows: [[rail ? 'rail' : 'road', 'Click to build from here']] };
    }
    if (sn.kind === 'edge') return { title: rail ? 'Branch off' : 'New junction', rows: [[rail ? 'rail' : 'road', rail ? 'Click to start a switch here' : 'Click to start a junction here']] };
    const t = rail ? (this.tracks > 1 ? `${this.tracks} parallel tracks` : 'Single track') : (ROAD_TYPES[this.roadType] ?? ROAD_TYPES.road).name;
    const rows: [string, string][] = [[rail ? 'rail' : 'road', `Click to start · ${esc(t)}`]];
    if (rail) rows.push([this.railLevel === 'elevated' ? 'bridge' : this.railLevel === 'underground' ? 'tunnel' : 'rail', typeLevelText(this.buildOptions())]);
    if (this.heightOffset) rows.push(['height', `Section ends at <b>${fmtHeight(this.heightOffset)}</b>`]);
    return { title: rail ? 'New track' : 'New road', rows, hint: rail ? 'Hold Shift over a track to copy it in parallel' : undefined };
  }

  private showPlanTip() {
    const p = this.proposal;
    if (!p) return;
    const g = this.game;
    const N = Math.max(1, p.tracks.length);
    const st = p.stats;
    if (p.errors[0] === 'Too short') { this.tip({ title: p.opts.kind === 'rail' ? 'Track' : 'Road', rows: [['target', 'Move the cursor to plan the next section']], hint: 'Right-click or Esc ends construction' }, 'info'); return; }
    this.tip(this.proposalTip(p, N), p.ok && g.economy.canAfford(p.cost) ? 'ok' : 'err');
  }

  private planWarnings(p: Proposal): string[] {
    const warnings: string[] = [];
    const bridgeEnd = p.tracks.some((tp) => [tp.start, tp.end].some((sn, i) => {
      const s = i === 0 ? 0 : tp.len;
      return sn.kind === 'free' && tp.sections.some((q) => q.type === 'bridge' && q.s0 <= s + 0.05 && q.s1 >= s - 0.05);
    }));
    if (bridgeEnd) warnings.push(`End stands on a bridge — ${p.opts.kind === 'rail' ? 'trains' : 'vehicles'} can't continue. Extend to the ground.`);
    if (p.opts.kind === 'road' && (!p.opts.level || p.opts.level === 'ground') && (p.opts.crossing === 'auto' || p.opts.crossing === 'level')) {
      const net = this.game.world.net, types = new Set<string>();
      for (const c of p.crossings) {
        const e = net.edges.get(c.edge);
        if (e?.kind === 'rail' && net.sectionAt(e, c.sOld) === 'ground' && !levelCrossingAllowed(e.type)) types.add(e.type);
      }
      for (const type of types) {
        const name = (TRACK_TYPES[type] ?? TRACK_TYPES.standard).name.replace(/ \(electrified\)$/, '');
        warnings.push(`${name} doesn't allow level crossings. Choose Overpass or Underpass crossing mode.`);
      }
    }
    return warnings;
  }

  /** Walls are in the planner's "other" bill: remove its non-wall charges to retain the actual height-based cost. */
  private retainingWallCost(p: Proposal): number | undefined {
    if (p.stats.walls === undefined || !p.stats.costSplit) return undefined;
    let other = p.trees * 250;
    for (const id of p.demolish) { const b = this.game.world.buildings.get(id); if (b) other += 6000 + b.pop * 2500; }
    for (const c of p.crossings) if (c.mode === 'level' || c.mode === 'diamond') other += 15000;
    if (p.opts.tram && p.opts.kind === 'road') for (const tp of p.tracks) other += TRAM.costPerUnit * tp.len;
    return Math.max(0, Math.round(p.stats.costSplit.other - other));
  }

  private retainingWallRow(proposals: Proposal[]): [string, string] | null {
    const walls = proposals.filter((p) => p.stats.walls !== undefined);
    if (!walls.length) return null;
    const length = walls.reduce((sum, p) => sum + p.stats.walls!, 0);
    const costs = walls.map((p) => this.retainingWallCost(p));
    const cost = costs.every((c) => c !== undefined) ? fmtMoney(costs.reduce<number>((sum, c) => sum + c!, 0)) : 'included in total';
    return ['terraform', `<span class="tt-hot">Retaining walls: <b>${fmtLen(length)}</b>, cost ${cost}</span>`];
  }

  /** Tooltip card of a planned track / road. */
  private proposalTip(p: Proposal, N: number, title?: string): Tip {
    const st = p.stats;
    const rows: [string, string][] = [];
    rows.push(['length', `<b>${fmtLen(st.len / N)}</b>${N > 1 ? ` × ${N} tracks` : ''}`]);
    const speed = p.opts.kind === 'rail' ? Math.min((TRACK_TYPES[p.opts.type] ?? TRACK_TYPES.standard).speed, curveSpeed(st.minRadius, p.opts.type)) : st.speed;
    rows.push(['speed', `<b>${Math.round(speed)}</b> km/h`]);
    if (p.opts.kind === 'rail') rows.push([p.opts.level === 'elevated' ? 'bridge' : p.opts.level === 'underground' ? 'tunnel' : 'rail', typeLevelText(p.opts)]);
    rows.push(['grade', `grade <b>${(st.maxGrade * 100).toFixed(1)}%</b>`]);
    rows.push(['radius', isFinite(st.minRadius) && st.minRadius < 5000 ? `radius <b>${Math.round(st.minRadius * 10).toLocaleString('en-US')} m</b>` : 'straight']);
    if (st.bridges || st.tunnels) {
      // structures are much dearer than track on the ground: their length and cost stand out
      let bl = 0, tl = 0;
      for (const sec of p.tracks[0]?.sections ?? []) { if (sec.type === 'bridge') bl += sec.s1 - sec.s0; else if (sec.type === 'tunnel') tl += sec.s1 - sec.s0; }
      const cs = st.costSplit;
      if (bl > 0) rows.push(['bridge', `<span class="tt-hot">${plural(st.bridges, 'bridge')} · ${fmtLen(bl)}${cs?.bridges ? ` · ${fmtMoney(cs.bridges)}` : ''}</span>`]);
      if (tl > 0) rows.push(['tunnel', `<span class="tt-hot">${plural(st.tunnels, 'tunnel')} · ${fmtLen(tl)}${cs?.tunnels ? ` · ${fmtMoney(cs.tunnels)}` : ''}</span>`]);
    }
    const walls = this.retainingWallRow([p]);
    if (walls) rows.push(walls);
    if (st.costSplit) {
      const cs = st.costSplit, parts: string[] = [];
      if (cs.track) parts.push(`track ${fmtMoney(cs.track)}`);
      if (cs.earthworks) parts.push(`earthworks ${fmtMoney(cs.earthworks)}`);
      const other = cs.other - (this.retainingWallCost(p) ?? 0);
      if (other > 0) parts.push(`other ${fmtMoney(other)}`);
      if (parts.length > 1 || cs.bridges || cs.tunnels) rows.push(['coin', parts.join(' · ')]);
    }
    if (p.crossings.length) {
      const m = new Map<string, number>();
      for (const c of p.crossings) m.set(CROSS_LABEL[c.mode], (m.get(CROSS_LABEL[c.mode]) ?? 0) + 1);
      rows.push(['crossing', [...m].map(([k, v]) => `${v} ${k}${v > 1 ? (k.endsWith('ss') ? 'es' : 's') : ''}`).join(', ')]);
    }
    if (this.heightOffset && this.hoverSnap?.kind === 'free' && !title) rows.push(['height', `end ${fmtHeight(this.heightOffset)}`]);
    if (st.sharedSaving && st.sharedSaving > 0) rows.push(['coin', `<b>${fmtMoney(st.sharedSaving)}</b> saved: ${N > 1 ? 'the tracks share one formation' : 'it shares the formation of the track beside it'}`]);
    for (const sn of [this.start, this.hoverSnap]) { const fo = this.foreignOwner(sn); if (fo !== null) { rows.push(['key', `joins ${esc(this.game.company(fo).name)}'s track (upkeep shared ${fmtMult(this.game.accessMultiplier(fo))})`]); break; } }
    const warn = [...this.planWarnings(p), ...p.warnings.filter((w) => w !== 'The free end stands on a bridge: continue it to the ground')];
    if (p.demolish.length) warn.unshift(`Demolishes ${plural(p.demolish.length, 'building')}`);
    const who = accessOwnerOf(this.game, p.errors[0]);
    if (who !== null) return { title: `${esc(this.game.company(who).name)}'s network`, cost: p.cost, rows, warn, err: [`${p.errors[0]}`], hint: accessState(this.game, who).kind === 'none' ? 'Click to request track access' : undefined };
    return { title: title ?? (p.opts.kind === 'rail' ? (N === 2 ? 'Double track' : N > 2 ? `${N} parallel tracks` : 'Single track') : (ROAD_TYPES[p.opts.type] ?? ROAD_TYPES.road).name), cost: p.cost, rows, warn, err: p.errors.slice(0, 1) };
  }

  // ------------------------------------------------------------------ tram tracks (lay in / take up roads)
  /** Road edges for the tram tool: the road under the cursor, or the street path from the press point. */
  private tramEdges(from: THREE.Vector3 | null): number[] | null {
    const g = this.game;
    const p = this.ground;
    if (!p) return null;
    if (from) return roadPath(g, from.x, from.z, p.x, p.z);
    const hit = this.edgeAtCursor('road', (e) => e.depot < 0 && e.station < 0, 16);
    if (hit) return [hit.edge.id];
    const ne = g.world.net.nearestEdge(p.x, p.z, 1.2, 'road', (e) => e.depot < 0 && e.station < 0);
    return ne ? [ne.edge.id] : null;
  }

  private hoverTram() {
    const g = this.game, ov = this.overlay;
    const d = this.down;
    const ids = this.tramEdges(d && d.button === 0 && d.moved ? d.ground : null);
    const remove = this.tramMode === 'remove';
    if (!ids || !ids.length) {
      ov.setHoverEdge(null);
      this.tip({ title: remove ? 'Remove tram tracks' : 'Tram tracks', rows: [['road', remove ? 'Point at your tram tracks' : 'Point at a road']], hint: 'Press and drag along streets for a whole route' }, 'info');
      return;
    }
    const r = remove ? removeTramTracks(g, ids, PLAYER, true) : addTramTracks(g, ids, PLAYER, true);
    ov.setHoverEdge(ids, remove ? 0xff5a5f : r.changed ? 0xc084fc : 0x8490a2);
    let len = 0;
    for (const id of ids) len += g.world.net.edges.get(id)?.len ?? 0;
    const rows: [string, string][] = [['length', `<b>${fmtLen(len)}</b> of road${ids.length > 1 ? ` · ${ids.length} sections` : ''}`]];
    if (!remove && r.changed < ids.length) rows.push(['check', `${ids.length - r.changed} section${ids.length - r.changed === 1 ? '' : 's'} already with tracks`]);
    const err = r.changed ? [] : [r.error ?? (remove ? 'No tram tracks of yours here' : 'Already has tram tracks')];
    this.tip({ title: remove ? 'Remove tram tracks' : 'Lay tram tracks', cost: r.changed ? r.cost : undefined, rows, err, warn: r.changed && r.error ? [r.error] : !remove && r.changed && !g.economy.canAfford(r.cost) ? ['Not enough money'] : [], hint: d ? undefined : 'Click for one road · press and drag along streets' }, r.changed ? (remove ? 'err' : 'ok') : 'err');
  }

  private commitTram(ids: number[]) {
    const g = this.game;
    const remove = this.tramMode === 'remove';
    const r = remove ? removeTramTracks(g, ids, PLAYER) : addTramTracks(g, ids, PLAYER);
    if (!r.changed) { this.ui.toast(r.error ?? (remove ? 'No tram tracks of yours here' : 'These roads already have tram tracks'), 'bad'); return; }
    if (r.error) this.ui.toast(r.error, 'info');
    this.ui.floatCost(r.cost, this.client.x, this.client.y);
    this.ui.sound(remove ? 'demolish' : 'build-rail', this.ground ? { x: this.ground.x, z: this.ground.z } : {});
  }

  /** Bus / tram stop placement preview. */
  private hoverStop(p: THREE.Vector3, tram: boolean) {
    const g = this.game, ov = this.overlay;
    const pl = g.stations.planBusStop(p.x, p.z, PLAYER);
    const tramErr = tram && pl.ok && pl.edge && !tramUsable(g, pl.edge, PLAYER) ? (pl.edge.tram ? `Tram tracks of ${g.company(pl.edge.tramOwner ?? -1).name} — click to request access` : 'Needs a road with tram tracks') : '';
    const color = tram ? 0xc084fc : 0x46e07a;
    if (pl.ok && pl.edge && !tramErr) {
      const q = { x: 0, y: 0, z: 0 }, dd = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(pl.edge, pl.s!, q, dd);
      const a = Math.atan2(dd.x, dd.z);
      const off = g.world.net.halfWidth(pl.edge) - 0.12;
      ov.setFootprints([{ x: q.x + Math.cos(a) * off, z: q.z - Math.sin(a) * off, angle: a, w: 0.3, d: tram ? 2.2 : 1.2, color, y: q.y, lift: 0.06 }]);
      ov.setMarker('hover0', q, 'point', color);
      const mode = tram ? 'tram' : 'bus', R = catchWalkLimit(mode);
      const walk = stopWalkingCatchment(g, pl.edge.id, pl.s!, mode);
      drawCatchStreets(ov, 'hover', walk);
      const pop = catchStreetPop(g, walk);
      const rows: [string, string][] = [['people', `<b>${pop.toLocaleString('en-US')}</b> residents within ${Math.round(R * 10)} m walking`]];
      if (pl.join) rows.push(['plus', `Joins ${esc(pl.join.name)}`]);
      const lk = linkNames(g, pl);
      if (lk) rows.push(['plus', `Links with ${esc(lk)} (transfers)`]);
      if (pl.edge.owner >= 0 && pl.edge.owner !== PLAYER) rows.push(['company', `Road of ${esc(g.company(pl.edge.owner).name)}`]);
      const to = pl.edge.tramOwner ?? -1;
      if (tram && to >= 0 && to !== PLAYER) rows.push(['key', `Tram tracks of <b>${esc(g.company(to).name)}</b> (upkeep shared ${fmtMult(g.accessMultiplier(to))})`]);
      this.tip({ title: tram ? 'Tram stop' : 'Bus stop', cost: pl.cost, rows, warn: g.economy.canAfford(pl.cost) ? [] : ['Not enough money'] }, 'ok');
    } else {
      ov.setFootprints(null);
      ov.setMarker('hover0', { x: p.x, y: p.y, z: p.z }, 'free', 0xff5a4a);
      drawCatchStreets(ov, 'hover', null);
      this.tip({ title: tram ? 'Tram stop' : 'Bus stop', err: [tramErr || (pl.error ?? 'Cannot build')] }, 'err');
    }
  }

  // ------------------------------------------------------------------ parallel track copy (Shift)
  /** Plan (or build) a copy of a rail edge, offset sideways by the track spacing. */
  private parallelPlan(e: NEdge, side: number, commit: boolean): { prop: Proposal; err: string | null } {
    const g = this.game, net = g.world.net;
    const ob = bezOffset(e.bez, side * RAIL.spacing);
    const t0 = startTangent(ob), t1 = endTangent(ob);
    // temporary end nodes give the planner fixed tangents; they are removed again unless the copy is built
    const saveNext = net.nextNode, saveVer = net.version;
    const temp: number[] = [];
    let blocked = false;
    const endSnap = (x: number, z: number, y: number, dx: number, dz: number): Snap => {
      const s = findSnap(g, 'rail', x, z, 0.12);
      if (s.kind === 'node') return s;
      if (s.kind === 'edge') blocked = true;
      const n = net.addNode('rail', x, y, z, dx, dz, PLAYER);
      temp.push(n.id);
      return { kind: 'node', x, z, y, node: n.id, group: [n.id] };
    };
    try {
      const a = endSnap(ob.x0, ob.z0, e.prof[0], t0.x, t0.z);
      const b = endSnap(ob.x3, ob.z3, e.prof[e.prof.length - 1], -t1.x, -t1.z);
      // the copy takes the original's track type and level (a viaduct beside a viaduct, a tunnel beside a tunnel)
      const lv = edgeLevel(e), q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const off = q.y - g.world.heightAt(q.x, q.z);
      const lvo = lv === 'ground' ? { level: undefined, levelHeight: undefined, levelDepth: undefined }
        : { level: lv, levelHeight: Math.max(LINE_LEVEL.height.min, Math.min(LINE_LEVEL.height.max, off)), levelDepth: Math.max(LINE_LEVEL.depth.min, Math.min(LINE_LEVEL.depth.max, -off)) };
      const prop = planEdge(g, a, b, { ...this.buildOptions(), kind: 'rail', type: e.type, tracks: 1, heightOffset: 0, ...lvo });
      const own = this.ownErr(a) ?? this.ownErr(b);
      if (own) { prop.ok = false; prop.errors.unshift(own); }
      if (blocked) { prop.ok = false; prop.errors.unshift('There is already a track on this side'); }
      return { prop, err: commit ? commitProposal(g, prop) : null };
    } finally {
      for (const id of temp) { const n = net.nodes.get(id); if (n && !n.edges.length) net.removeNode(id); }
      if (!commit) { net.nextNode = saveNext; net.version = saveVer; }
    }
  }

  /** Side of edge e (+1 right / -1 left of its direction) the cursor is on. */
  private sideOf(e: NEdge, x: number, z: number): number {
    const net = this.game.world.net;
    const ne = net.nearestEdge(x, z, 3, 'rail', (f) => f.id === e.id);
    const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, ne ? ne.s : e.len / 2, q, d);
    const p = this.ground!;
    return (p.x - q.x) * -d.z + (p.z - q.z) * d.x >= 0 ? 1 : -1;
  }

  /** Shift held over own track: preview a parallel copy. Returns false when nothing is under the cursor. */
  private hoverParallel(): boolean {
    const ov = this.overlay;
    const hit = this.edgeAtCursor('rail', (e) => e.station < 0 && e.depot < 0 && e.owner === PLAYER, 40);
    if (!hit || !this.ground) return false;
    const side = this.sideOf(hit.edge, this.ground.x, this.ground.z);
    const cur = this.parallel;
    const prop = cur && cur.edge === hit.edge.id && cur.side === side && this.planKey === `par:${this.game.networkVersion}:${this.railType}:${this.crossing}`
      ? cur.prop : this.parallelPlan(hit.edge, side, false).prop;
    this.planKey = `par:${this.game.networkVersion}:${this.railType}:${this.crossing}`;
    this.parallel = { edge: hit.edge.id, side, prop };
    for (let i = 0; i < 4; i++) ov.setMarker('hover' + i, null);
    ov.setProposal(prop);
    ov.setHoverEdge(hit.edge.id, 0xffffff);
    ov.setDemolish(prop.demolish);
    const tip = this.proposalTip(prop, 1, `Parallel track · ${side > 0 ? 'right' : 'left'}`);
    if (prop.ok) tip.hint = 'Shift+click to build';
    this.tip(tip, prop.ok && this.game.economy.canAfford(prop.cost) ? 'ok' : 'err');
    return true;
  }

  private buildParallel() {
    const hit = this.edgeAtCursor('rail', (e) => e.station < 0 && e.depot < 0 && e.owner === PLAYER, 40);
    if (!hit || !this.ground) { this.ui.toast('Hold Shift over one of your tracks to copy it', 'info'); return; }
    const side = this.sideOf(hit.edge, this.ground.x, this.ground.z);
    const r = this.parallelPlan(hit.edge, side, true);
    if (!r.prop.ok) { this.ui.toast(r.prop.errors[0] ?? 'Cannot build here', 'bad'); return; }
    if (r.err) { this.ui.toast(r.err, 'bad'); return; }
    this.ui.floatCost(r.prop.cost, this.client.x, this.client.y);
    this.ui.sound('build-rail', { x: this.ground.x, z: this.ground.z });
    this.parallel = null;
    this.planKey = '';
    this.moveDirty = true;
  }

  // ------------------------------------------------------------------ clicks
  private click(e: PointerEvent) {
    const g = this.game;
    const p = this.ground;
    switch (this.tool) {
      case 'inspect': {
        const vid = this.ui.renderer.pickVehicle(e.clientX, e.clientY);
        if (vid != null) { this.ui.openVehicle(vid); return; }
        if (!p) return;
        const hit = this.hitAt(p.x, p.z);
        if (hit) this.ui.openHit(hit);
        return;
      }
      case 'line-edit': {
        if (!p || this.lineEditId == null) return;
        const hit = this.hitAt(p.x, p.z);
        if (hit?.kind === 'station') this.ui.addStopToLine(this.lineEditId, hit.id);
        return;
      }
      case 'station':
      case 'metro-station': {
        if (!p) return;
        if (this.stationOnLine && this.relocating == null) { this.commitStationOnLine(e); return; }
        const pos = this.stationPlacement(p.x, p.z);
        const pl = this.planStation(pos.x, pos.z, pos.angle, pos.type);
        this.stationPlan = null;
        if (this.relocating != null) {
          const id = this.relocating;
          const before = g.economy.money;
          const err = relocateStation(g, id, pl);
          if (err === 'busy') { this.ui.toast('A vehicle is at the station — try again in a moment', 'info'); return; }
          if (err) { this.ui.toast(err, 'bad'); return; }
          this.ui.floatCost(Math.max(0, before - g.economy.money), e.clientX, e.clientY);
          this.ui.sound('station', { x: pl.x, z: pl.z });
          this.ui.toast(`${g.stations.get(id)?.name ?? 'Station'} moved`, 'good');
          this.relocating = null;
          this.setTool('inspect');
          this.ui.openStation(id);
          return;
        }
        const err = g.stations.commitRail(pl, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else {
          this.ui.floatCost(pl.cost, e.clientX, e.clientY);
          this.ui.sound('station', { x: pl.x, z: pl.z });
          if (!pl.roadAccess) this.ui.toast('The station has no road access yet: connect it to a street so passengers can reach it', 'info');
        }
        break;
      }
      case 'busstop': {
        if (!p) return;
        const cost = g.stations.planBusStop(p.x, p.z, PLAYER).cost;
        const err = g.stations.commitBusStop(p.x, p.z, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(cost, e.clientX, e.clientY); this.ui.sound('station', { x: p.x, z: p.z, pitch: 1.15 }); }
        break;
      }
      case 'tramstop': {
        if (!p) return;
        const pl = g.stations.planBusStop(p.x, p.z, PLAYER);
        if (pl.ok && pl.edge && !tramUsable(g, pl.edge, PLAYER)) {
          const to = pl.edge.tramOwner ?? -1;
          if (!pl.edge.tram || to < 0) { this.ui.toast('Needs a road with tram tracks', 'bad'); return; }
          if (requestAccessUI(this.ui, to) !== 'granted') return;
        }
        const err = g.stations.commitBusStop(p.x, p.z, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(pl.cost, e.clientX, e.clientY); this.ui.sound('station', { x: p.x, z: p.z, pitch: 1.25 }); }
        break;
      }
      case 'depot-rail':
      case 'depot-road':
      case 'depot-tram': {
        if (!p) return;
        const kind: DepotKind = this.tool === 'depot-rail' ? 'rail' : this.tool === 'depot-tram' ? 'tram' : 'road';
        const pl = this.planDepot(kind, p.x, p.z);
        this.depotPlan = null;
        if (!pl.ok) { this.ui.toast(pl.error ?? 'Cannot build', 'bad'); return; }
        if (this.relocatingDepot != null) {
          const before = g.economy.money;
          const err = relocateDepot(g, this.relocatingDepot, pl);
          if (err === 'busy') { this.ui.toast('A vehicle is on the depot track — try again in a moment', 'info'); return; }
          if (err) { this.ui.toast(err, 'bad'); return; }
          this.ui.floatCost(Math.max(0, before - g.economy.money), e.clientX, e.clientY);
          this.ui.sound('depot', { x: pl.x, z: pl.z });
          this.ui.toast('Depot moved', 'good');
          this.setTool('inspect');
          return;
        }
        const err = g.depots.commit(kind, pl, PLAYER);
        if (err) this.ui.toast(err, 'bad');
        else { this.ui.floatCost(pl.cost, e.clientX, e.clientY); this.ui.sound('depot', { x: pl.x, z: pl.z }); }
        break;
      }
      case 'signal': {
        if (!p) return;
        if (this.signalMode === 'remove') { this.removeSignalAt(p.x, p.z); break; }
        const net = g.world.net;
        const n = net.nearestNode(p.x, p.z, 0.8, 'rail', (nn) => nn.edges.length === 2 && nn.signal > 0);
        if (n && n.owner !== PLAYER) { this.ui.toast(`Signal of ${g.company(n.owner).name}`, 'bad'); return; }
        let err: string | null;
        if (n) err = toggleSignal(g, p.x, p.z, PLAYER); // an existing signal: cycle it
        else {
          // a new signal of the chosen type; one-way ones face away from the camera
          const ne = net.nearestEdge(p.x, p.z, 1.0, 'rail');
          if (!ne) { this.ui.toast('Click on a track', 'bad'); return; }
          const q = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
          net.pointAt(ne.edge, ne.s, q, t);
          const cam = this.ui.renderer.camera.position;
          const forward = (q.x - cam.x) * t.x + (q.z - cam.z) * t.z >= 0;
          err = setSignal(g, ne.edge.id, ne.s, this.signalKind, forward, PLAYER, { signalKind: this.signalClass, pass: this.signalKind === 'oneway' && this.signalPass });
        }
        if (err) this.ui.toast(err, 'bad');
        else this.ui.sound('signal', { x: p.x, z: p.z });
        break;
      }
      case 'double': this.commitDouble(); break;
      case 'connect': this.clickConnect(); break;
      case 'entrance': {
        if (!p || this.entranceStation == null) return;
        const ground = g.stations.get(this.entranceStation)?.rail?.level === 'ground';
        const pl = g.stations.planEntrance(this.entranceStation, p.x, p.z, PLAYER, ground ? this.entranceKind : undefined);
        const err = g.stations.commitEntrance(this.entranceStation, pl, PLAYER);
        if (err) { this.ui.toast(err, 'bad'); return; }
        this.ui.floatCost(pl.cost, e.clientX, e.clientY);
        this.ui.sound('station', { x: p.x, z: p.z, pitch: 1.2 });
        this.ui.wm.get('station-' + this.entranceStation)?.refresh?.();
        break;
      }
    }
    this.moveDirty = true;
  }

  private doBulldoze(x0: number, z0: number, x1: number, z1: number) {
    const g = this.game;
    const preview = bulldoze(g, x0, z0, x1, z1, PLAYER, true);
    if (preview.error === 'Not enough money') { this.ui.toast(preview.error, 'bad'); this.hideTip(); return; }
    const stationLines = g.lines.all().filter((l) => l.stops.some((sid) => preview.stationIds.includes(sid)));
    const stationEdges = new Set(preview.stationIds.flatMap((sid) => {
      const st = g.stations.get(sid);
      return st?.rail ? [...st.rail.edges, ...st.rail.throughEdges] : [];
    }));
    const vehicles = [...g.vehicles.trains(), ...g.vehicles.roads()].filter((v) =>
      preview.depotIds.includes(v.depotId) || stationLines.some((l) => l.vehicles.includes(v.id)) ||
      preview.stationIds.includes(v.targetStation()?.id ?? -1) || v.occupiedEdges().some((eid) => stationEdges.has(eid)));
    const lines = g.lines.all().filter((l) => stationLines.includes(l) || vehicles.some((v) => v.lineId === l.id));
    if (lines.length || vehicles.length) {
      const stations = preview.stationIds.map((sid) => g.stations.get(sid)?.name).filter(Boolean);
      const depots = preview.depotIds.map((id) => {
        const dp = g.depots.get(id)!;
        return `${dp.kind === 'rail' ? 'Train' : dp.kind === 'tram' ? 'Tram' : 'Bus'} depot #${id}`;
      });
      const some = (names: string[], n = 8) => names.length <= n ? names.join(', ') || 'None' : `${names.slice(0, n).join(', ')} and ${names.length - n} more`;
      const message = [`Demolish ${[...stations, ...depots].join(', ')}?`,
        `Affected lines: ${some(lines.map((l) => l.name))}`,
        `Affected vehicles: ${some(vehicles.map((v) => v.name))}`,
        `Demolition costs ${fmtMoney(preview.cost)}. Construction costs are not refunded.`].join('\n\n');
      if (!confirm(message)) { this.hideTip(); return; }
    }
    const r = bulldoze(g, x0, z0, x1, z1, PLAYER, false);
    if (r.error) this.ui.toast(r.error, 'bad');
    if (r.changed) { this.ui.floatCost(r.cost, this.client.x, this.client.y); this.ui.sound('demolish', { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }); }
    this.overlay.setHoverEdge(null);
    this.hideTip();
  }

  // ------------------------------------------------------------------ tooltip
  private tip(c: Tip, kind: 'ok' | 'err' | 'info' = 'info') {
    const unaffordable = c.cost !== undefined && !this.game.economy.canAfford(c.cost);
    if (unaffordable) {
      c = { ...c, warn: c.warn?.filter((msg) => !this.ui.needsMoney(msg)),
        err: [...(c.err ?? []).filter((msg) => !this.ui.needsMoney(msg)), `Not enough money: ${fmtMoney(c.cost!)} needed, ${fmtMoney(this.game.economy.money)} available`] };
      kind = 'err';
    }
    if (this.touchPreview) c = { ...c, hint: 'Tap the same spot to confirm · tap elsewhere to move the preview' };
    this.showTip(tipHtml(c), kind);
    const finance = unaffordable || [...(c.err ?? []), ...(c.warn ?? [])].some((msg) => this.ui.needsMoney(msg));
    if (finance && !this.tooltip.querySelector('.finance-actions')) this.tooltip.append(this.ui.financeActions(() => this.refreshHover()));
    this.positionTip();
  }

  private tipHtml = '';
  private tipKind = '';
  private tipShown = false;
  private showTip(html: string, kind: 'ok' | 'err' | 'info' = 'info') {
    const t = this.tooltip;
    if (html !== this.tipHtml) { this.tipHtml = html; t.innerHTML = html; }
    if (kind !== this.tipKind) { this.tipKind = kind; t.className = 'tooltip ' + kind; }
    if (!this.tipShown) { this.tipShown = true; t.style.display = 'block'; }
    this.positionTip();
  }
  hideTip() { if (this.tipShown) { this.tipShown = false; this.tooltip.style.display = 'none'; } }
  private positionTip() {
    const t = this.tooltip;
    if (!this.tipShown) return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = t.offsetWidth, h = t.offsetHeight;
    const cx = this.client.x, cy = this.client.y;
    // try the four corners around the cursor; avoid the tool card and the minimap
    const avoid = this.ui.hud?.avoidRects() ?? [];
    const cands: [number, number][] = [[cx + 18, cy + 16], [cx - w - 14, cy + 16], [cx + 18, cy - h - 12], [cx - w - 14, cy - h - 12]];
    const fits = (x: number, y: number) => x >= 4 && y >= 4 && x + w <= W - 4 && y + h <= H - 4;
    const free = (x: number, y: number) => avoid.every((r) => x + w < r.left || x > r.right || y + h < r.top || y > r.bottom);
    const pos = cands.find(([x, y]) => fits(x, y) && free(x, y)) ?? cands.find(([x, y]) => fits(x, y)) ?? cands[0];
    const x = Math.max(4, Math.min(W - w - 4, pos[0])), y = Math.max(4, Math.min(H - h - 4, pos[1]));
    t.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
}

/** Owner named in a planner error "Track of X: needs track access" (or tram tracks), else null. */
function accessOwnerOf(g: { companies: { id: number; name: string; defunct?: boolean }[] }, err: string | undefined): number | null {
  const m = err ? /^(?:Track|Tram tracks) of (.+): needs track access/.exec(err) : null;
  if (!m) return null;
  const co = g.companies.find((c) => !c.defunct && c.name === m[1]);
  return co && co.id !== PLAYER ? co.id : null;
}

/** Own rail edges reachable from some edges within a distance along the track (for signalling a stretch). */
function trackAround(g: { world: { net: { edges: Map<number, NEdge>; nodes: Map<number, NNode> } } }, from: number[], reach: number): number[] {
  const net = g.world.net;
  const dist = new Map<number, number>(from.map((id) => [id, 0]));
  const queue = [...from];
  while (queue.length) {
    const id = queue.shift()!;
    const e = net.edges.get(id), d0 = dist.get(id)!;
    if (!e || d0 > reach) continue;
    for (const nid of [e.a, e.b]) for (const nx of net.nodes.get(nid)?.edges ?? []) {
      const f = net.edges.get(nx);
      if (!f || f.kind !== 'rail' || f.owner !== PLAYER || dist.has(nx)) continue;
      dist.set(nx, d0 + e.len);
      queue.push(nx);
    }
  }
  return [...dist.keys()];
}

/** All parallel segments of a double-track plan as one proposal (for the ghost preview). */
function mergedProposal(pl: DoublePlan): Proposal | null {
  if (!pl.proposals.length) return null;
  const p0 = pl.proposals[0];
  return { ...p0, ok: pl.ok, errors: pl.errors, warnings: pl.warnings, cost: pl.cost, tracks: pl.proposals.flatMap((q) => q.tracks), crossings: pl.proposals.flatMap((q) => q.crossings), demolish: pl.proposals.flatMap((q) => q.demolish) };
}

/** Rail edges from one edge to another along the track (breadth first; default: own track outside stations and depots). */
function railChain(g: { world: { net: { edges: Map<number, NEdge>; nodes: Map<number, NNode> } } }, from: number, to: number, max = 80, pred: (e: NEdge) => boolean = (f) => f.owner === PLAYER && f.station < 0 && f.depot < 0): number[] | null {
  const net = g.world.net;
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length && prev.size < 4000) {
    const id = queue.shift()!;
    if (id === to) break;
    const e = net.edges.get(id);
    if (!e) continue;
    for (const nid of [e.a, e.b]) for (const nx of net.nodes.get(nid)?.edges ?? []) {
      if (prev.has(nx)) continue;
      const f = net.edges.get(nx);
      if (!f || f.kind !== 'rail' || !pred(f)) continue;
      prev.set(nx, id);
      queue.push(nx);
    }
  }
  if (!prev.has(to)) return null;
  const out: number[] = [];
  for (let id = to; id !== -1 && out.length <= max; id = prev.get(id) ?? -1) out.push(id);
  return out.length > max ? null : out.reverse();
}

/** Names of the stations a planned station or stop would link with for transfers (when the game reports them). */
function linkNames(g: { stations: { get(id: number): { name: string } | undefined } }, pl: unknown): string {
  const lk = (pl as { links?: (number | { name: string })[] } | null)?.links;
  if (!Array.isArray(lk) || !lk.length) return '';
  return lk.map((x) => (typeof x === 'number' ? g.stations.get(x)?.name : x.name)).filter(Boolean).join(', ');
}

function norm(a: number) { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; }

/** Track type and build level of track options, for tooltips ("Metro track · underground, 22 m deep"). */
export function typeLevelText(o: BuildOptions): string {
  const tt = TRACK_TYPES[o.type] ?? TRACK_TYPES.standard;
  const name = tt.name.replace(/ \(electrified\)$/, '');
  if (o.level === 'elevated') return `${esc(name)} · elevated, <b>${Math.round((o.levelHeight ?? LINE_LEVEL.height.def) * 10)} m</b> up`;
  if (o.level === 'underground') return `${esc(name)} · underground, <b>${Math.round((o.levelDepth ?? LINE_LEVEL.depth.def) * 10)} m</b> deep`;
  return `${esc(name)}${tt.electrified ? ' · electrified' : ''}`;
}

/** Preview of a re-level plan as a proposal ghost: the stretch's edges with their new heights and structures. */
function relevelPreview(g: { world: { net: { edges: Map<number, NEdge> } } }, pl: RelevelPlan): Proposal | null {
  const net = g.world.net;
  const tracks = pl.edges.map((x) => {
    const e = net.edges.get(x.id);
    if (!e) return null;
    const snap = (t: 0 | 1): Snap => ({ kind: 'free', x: t ? e.bez.x3 : e.bez.x0, z: t ? e.bez.z3 : e.bez.z0, y: x.prof[t ? x.prof.length - 1 : 0] });
    return { bez: e.bez, len: e.len, prof: x.prof, sections: x.sections, start: snap(0), end: snap(1) };
  }).filter((t): t is NonNullable<typeof t> => !!t);
  if (!tracks.length) return null;
  const e0 = net.edges.get(pl.edges[0].id);
  return {
    ok: pl.ok, errors: pl.error ? [pl.error] : [], warnings: pl.warnings, opts: { kind: 'rail', type: e0?.type ?? 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner: pl.owner },
    tracks, crossings: [], demolish: [], trees: 0, cost: pl.cost, stats: { len: 0, maxGrade: 0, minRadius: Infinity, bridges: 0, tunnels: 0, speed: 0 },
  };
}
