// World sounds driven by the game state: trains (steam chuff / diesel rumble / electric hum, rail-joint
// clatter, brake squeal, horns and whistles), road traffic, level-crossing bells, station chimes,
// income near the camera, and an ambience bed crossfaded by what the camera sees.
import type { Game } from '../game/game';
import type { Train } from '../game/train';
import type { RoadVehicle } from '../game/roadvehicle';
import type { Vehicle } from '../game/vehicle';
import type { Station } from '../game/stations';
import { Kit, RECIPES, VoicePool } from './synth';

export interface Listener { x: number; y: number; z: number; rx: number; ry: number; rz: number; camDist: number; ground: number }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Distance gain: full within `ref` world units, ~1/d^1.2 beyond, faded to silence at `max`. */
export function distGain(d: number, ref = 6, max = 150): number {
  if (!(d < max)) return 0;
  const g = Math.min(1, Math.pow(ref / Math.max(d, 1e-3), 1.2));
  return g * Math.min(1, (max - d) / (max * 0.3));
}

/** Stereo position of a point for the listener (-1 left .. 1 right). */
export function panOf(L: Listener, x: number, y: number, z: number): number {
  const dx = x - L.x, dy = y - L.y, dz = z - L.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  return clamp(((dx * L.rx + dy * L.ry + dz * L.rz) / d) * 0.9, -1, 1);
}

/** Air absorption: duller with distance. */
export function lowpassOf(d: number): number { return clamp(16000 / (1 + d / 12), 900, 16000); }

export function distTo(L: Listener, x: number, y: number, z: number) { return Math.hypot(x - L.x, y - L.y, z - L.z); }

/** Night factor from the day-cycle time, matching the renderer's sun model. */
export function nightOf(visualTime: number): number {
  const elev = Math.sin((visualTime - 0.25) * Math.PI * 2) * 1.05;
  const x = clamp((elev + 0.2) / 0.25, 0, 1);
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Sound voices. Electric multiple units: 'resistor' (1960s resistor control: motor hum and gear whine), 'gto'
 * (1980s GTO inverter: the carrier "sings" up a scale while starting), 'vvvf' (modern IGBT inverter: smooth
 * rising whine), 'hsr' (high speed: wind roar and pantograph hiss rising steeply with speed).
 */
type SlotKind = 'steam' | 'diesel' | 'hst' | 'electric' | 'resistor' | 'gto' | 'vvvf' | 'hsr' | 'tram' | 'bus' | 'coach' | 'car' | 'bell';
/** GTO inverter start-up: the carrier steps up a scale (F major, Hz) */
const GTO_SCALE = [349, 392, 440, 466, 523, 587, 659, 698];

/** Long-distance coach: a bus model with a 'coach' style (rail coaches are wagons). */
function isCoach(r: RoadVehicle): boolean {
  const m = r.model;
  return !!m && ((m.kind as string) === 'coach' || (m.kind === 'bus' && typeof m.style === 'string' && m.style.startsWith('coach')));
}

/** A continuous positional sound (one vehicle or crossing): sources -> body -> lowpass -> gain -> pan -> bus. */
class Slot {
  body: GainNode; lp: BiquadFilterNode; out: GainNode; pan: StereoPannerNode;
  srcs: AudioScheduledSourceNode[] = [];
  freqs: [AudioParam, number][] = [];
  eng: GainNode | null = null; engF: BiquadFilterNode | null = null;
  roll: GainNode | null = null; rollF: BiquadFilterNode | null = null;
  whine: OscillatorNode | null = null; whineG: GainNode | null = null;
  squealG: GainNode | null = null;
  hiss: GainNode | null = null;
  /** inverter carrier tone (gto / vvvf) */
  car: OscillatorNode | null = null; carF: BiquadFilterNode | null = null; carG: GainNode | null = null;
  /** high-speed wind roar */
  wind: GainNode | null = null; windF: BiquadFilterNode | null = null;
  next = 0; nextJoint = 0; throttle = 0; lastSpeed = -1; seen = 0; dying = 0; gain = 0; d = 1e9; lastRamp = -1;
  x = 0; y = 0; z = 0; alt = 1;
  /** coaches: 0 in town .. 1 out on country roads (deeper, steadier engine and more tyre roar) */
  rural = 0; ruralAt = -1;

  constructor(public k: Kit, public key: number, public kind: SlotKind, dest: AudioNode, now: number) {
    const c = k.ctx;
    this.pan = c.createStereoPanner();
    this.pan.connect(dest);
    this.out = c.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.pan);
    this.lp = c.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 8000;
    this.lp.connect(this.out);
    this.body = c.createGain();
    this.body.connect(this.lp);
    this.alt = kind === 'bell' ? 1 : 0.94 + Math.random() * 0.12;
    if (kind === 'bell') return;
    // rolling noise for every vehicle
    this.roll = k.gain(0, this.body);
    this.rollF = k.filter({ type: 'lowpass', f: 400, q: 0.6 }, now, this.roll);
    this.loopNoise(kind === 'car' || kind === 'bus' || kind === 'coach' ? k.brown : k.pink, this.rollF);
    if (kind === 'steam') {
      this.hiss = k.gain(0, this.body);
      this.loopNoise(k.white, k.filter({ type: 'highpass', f: 3800 }, now, this.hiss));
    } else if (kind === 'diesel' || kind === 'hst' || kind === 'bus' || kind === 'coach') {
      this.eng = k.gain(0, this.body);
      this.engF = k.filter({ type: 'lowpass', f: 300, q: 1.1 }, now, this.eng);
      // coach: bigger engine, lower firing frequency
      const f0 = kind === 'bus' ? 44 : kind === 'coach' ? 34 : 32;
      this.osc('sawtooth', f0, this.engF, 1);
      this.osc('sawtooth', f0 * 1.008, this.engF, 1.008);
      this.osc('sine', f0 / 2, this.engF, 0.5);
      if (kind === 'hst') this.addWhine(2500, 0);
    } else if (kind === 'electric' || kind === 'tram') {
      this.eng = k.gain(0, this.body);
      this.osc('sine', 100, this.eng, 0);
      this.osc('sine', kind === 'tram' ? 200 : 300, k.gain(0.25, this.eng), 0);
      this.addWhine(kind === 'tram' ? 220 : 160, 0);
    } else if (kind === 'resistor') {
      // traction motor hum (follows the speed) with its second harmonic, gear whine above it
      this.eng = k.gain(0, this.body);
      this.engF = k.filter({ type: 'lowpass', f: 700, q: 0.7 }, now, this.eng);
      this.osc('triangle', 30, this.engF, 1);
      this.osc('sine', 60, k.gain(0.35, this.engF), 2);
      this.addWhine(300, 0);
    } else if (kind === 'gto' || kind === 'vvvf' || kind === 'hsr') {
      // inverter carrier (filtered square / saw) and the motors' magnetic whine
      this.carG = k.gain(0, this.body);
      this.carF = k.filter({ type: kind === 'gto' ? 'bandpass' : 'lowpass', f: 900, q: kind === 'gto' ? 2.5 : 0.8 }, now, this.carG);
      this.car = this.osc(kind === 'gto' ? 'square' : 'sawtooth', 400, this.carF, 0);
      this.addWhine(200, 0);
      if (kind === 'hsr') {
        this.wind = k.gain(0, this.body);
        this.windF = k.filter({ type: 'bandpass', f: 500, q: 0.6 }, now, this.wind);
        this.loopNoise(k.pink, this.windF);
        this.hiss = k.gain(0, this.body);
        this.loopNoise(k.white, k.filter({ type: 'highpass', f: 4200 }, now, this.hiss));
      }
    }
    if (kind !== 'car' && kind !== 'bus' && kind !== 'coach') {
      // brake squeal, a little vibrato
      this.squealG = k.gain(0, this.body);
      const sq = this.osc('sine', 3100 + Math.random() * 600, this.squealG, 0);
      const lfo = c.createOscillator();
      lfo.frequency.value = 5 + Math.random() * 3;
      lfo.connect(k.gain(25, sq.frequency));
      lfo.start(now);
      this.srcs.push(lfo);
    }
  }

  private loopNoise(buf: AudioBuffer, dest: AudioNode) {
    const s = this.k.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(dest);
    s.start(this.k.ctx.currentTime, Math.random() * Math.max(0, buf.duration - 0.1));
    this.srcs.push(s);
    return s;
  }

  /** Oscillator; `ratio` > 0 registers its frequency for the engine pitch (f = ratio * f0). */
  private osc(type: OscillatorType, f: number, dest: AudioNode, ratio: number) {
    const o = this.k.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(dest);
    o.start(this.k.ctx.currentTime);
    this.srcs.push(o);
    if (ratio > 0) this.freqs.push([o.frequency, ratio]);
    return o;
  }

  private addWhine(f: number, g: number) {
    this.whineG = this.k.gain(g, this.body);
    this.whine = this.osc('sine', f, this.whineG, 0);
  }

  /** Smoothly move a param towards a value. */
  static ramp(p: AudioParam, v: number, now: number, tc = 0.08) { p.setTargetAtTime(v, now, tc); }

  stop(now: number) {
    this.out.gain.setTargetAtTime(0, now, 0.12);
    for (const s of this.srcs) { try { s.stop(now + 0.7); } catch { /* stopped */ } }
    this.srcs = [];
  }
}

const TRAIN_SLOTS = 3, TRAFFIC_SLOTS = 3;
const JOINT = 2.5;          // rail joints every 25 m
const DRIVER_CIRC = 0.534;  // steam driving wheel circumference (1.7 m wheels)
const LOOKAHEAD = 0.14;

export interface WorldMix {
  ambient: GainNode;
  world: GainNode;
  voices: VoicePool;
  /** one-shot voice budget currently available for world/ambience */
  budget: () => number;
}

export class WorldAudio {
  game: Game | null = null;
  slots = new Map<string, Slot>();
  private prevState = new Map<number, string>();
  private chimeAt = new Map<number, number>();
  private segKind = new Map<number, string>();
  private dingAt = new Map<number, number>();
  private income: { x: number; z: number; amount: number }[] = [];
  private lastCash = 0;
  private scanT = 0; private envT = 0; private purgeT = 0;
  private tmp = { x: 0, y: 0, z: 0 };
  // ambience
  private wind: GainNode; private gust: GainNode;
  private town: GainNode;
  private waves: GainNode; private swell: GainNode;
  private nextSwell = 0;
  private env = { wind: 0.1, town: 0, waves: 0, birds: 0, crickets: 0, near: 1 };
  private nextBird = 0; private nextSwish = 0; private nextCricket = [0, 0.3];

  constructor(private k: Kit, private mix: WorldMix) {
    const c = k.ctx, now = c.currentTime;
    // wind: stereo pink noise, slowly gusting
    this.wind = k.gain(0, mix.ambient);
    this.gust = k.gain(0.75, this.wind);
    const wf = k.filter({ type: 'lowpass', f: 420, q: 0.7 }, now, this.gust);
    this.bed(k.stereo, wf, 0);
    this.lfo(0.071, 120, wf.frequency);
    this.lfo(0.113, 0.25, this.gust.gain);
    // town: low traffic rumble
    this.town = k.gain(0, mix.ambient);
    this.bed(k.brown, k.filter({ type: 'lowpass', f: 240, q: 0.5 }, now, this.town), 0);
    // waves: surf swells on a pink bed
    this.waves = k.gain(0, mix.ambient);
    this.swell = k.gain(0.4, this.waves);
    this.bed(k.stereo, k.filter({ type: 'lowpass', f: 850, q: 0.5 }, now, this.swell), 1.3);
  }

  private bed(buf: AudioBuffer, dest: AudioNode, offset: number) {
    const s = this.k.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(dest);
    s.start(this.k.ctx.currentTime, offset);
  }

  private lfo(f: number, depth: number, target: AudioParam) {
    const o = this.k.ctx.createOscillator();
    o.frequency.value = f;
    o.connect(this.k.gain(depth, target));
    o.start(this.k.ctx.currentTime);
  }

  setGame(g: Game) {
    this.game = g;
    for (const s of this.slots.values()) s.stop(this.k.ctx.currentTime);
    this.slots.clear();
    this.prevState.clear();
    this.chimeAt.clear();
    this.income = [];
  }

  onIncome(amount: number, v: Vehicle, st: Station) {
    if (v.owner !== 0 || amount < 1 || this.income.length > 16) return;
    this.income.push({ x: st.x, z: st.z, amount });
  }

  get slotCount() { let n = 0; for (const s of this.slots.values()) if (!s.dying) n++; return n; }

  /** Positional one-shot through the world bus (respects the voice budget). */
  private oneShot(name: string, L: Listener, x: number, y: number, z: number, vol: number, prio: number, pitch = 1, dest?: AudioNode) {
    const c = this.k.ctx, now = c.currentTime;
    const d = distTo(L, x, y, z);
    const g = distGain(d) * vol;
    if (g < 0.004) return;
    if (!this.mix.voices.reserve(now, prio, this.mix.budget())) return;
    const pan = c.createStereoPanner();
    pan.pan.value = panOf(L, x, y, z);
    pan.connect(dest ?? this.mix.world);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpassOf(d);
    lp.connect(pan);
    const out = c.createGain();
    out.gain.value = 1;
    out.connect(lp);
    this.k.begin();
    RECIPES[name](this.k, now + 0.01, out, pitch, g);
    this.mix.voices.add({ end: this.k.end, prio, out, srcs: this.k.srcs });
  }

  /** Track vehicle states while audio is locked or paused (no burst of events later). */
  track(g: Game) {
    for (const v of g.vehicles.map.values()) this.prevState.set(v.id, v.state);
  }

  update(dt: number, L: Listener, night: number, paused: boolean) {
    const g = this.game;
    if (!g) return;
    const now = this.k.ctx.currentTime;
    this.scanT -= dt; this.envT -= dt; this.purgeT -= dt;
    if (this.envT <= 0) { this.envT = 0.3; this.analyze(g, L, night); }
    this.ambience(now, L);
    if (paused) { this.track(g); this.income.length = 0; return; }
    const gs = Math.max(0, g.speed);
    if (this.scanT <= 0) { this.scanT = 0.1; this.assign(g, L); }
    this.events(g, L, now);
    for (const [key, s] of this.slots) {
      if (s.dying && now > s.dying) { this.slots.delete(key); continue; }
      if (s.kind === 'bell') this.bellSlot(s, now);
      else this.vehicleSlot(g, s, L, dt, gs, now);
    }
    if (this.purgeT <= 0) {
      this.purgeT = 5;
      for (const id of this.prevState.keys()) if (!g.vehicles.get(id)) this.prevState.delete(id);
      for (const id of this.segKind.keys()) if (!g.vehicles.get(id)) { this.segKind.delete(id); this.dingAt.delete(id); }
    }
  }

  // ------------------------------------------------------------------ slots

  /** Position of a train's (first) locomotive. */
  private locoPos(t: Train, out: { x: number; y: number; z: number }): boolean {
    let off = 0;
    for (const c of t.cars) {
      if (c.power > 0) return !!t.pointBehind(off + c.length / 2, out);
      off += c.length + 0.1;
    }
    return !!t.pointBehind(t.cars[0] ? t.cars[0].length / 2 : 0, out);
  }

  private trainKind(t: Train): SlotKind {
    const loco = t.cars.find((c) => c.power > 0) ?? t.cars[0];
    const st = loco?.style ?? 'diesel';
    if (st.startsWith('hsr')) return 'hsr';
    if (st === 'lrv' || st === 'lrv_modern') return 'tram';
    if (st === 'metro_steel' || st === 'emu_60s') return 'resistor';
    if (st === 'metro_stainless' || st === 'emu_80s') return 'gto';
    if (st === 'metro_modern' || st === 'emu_modern') return 'vvvf';
    return st === 'steam' ? 'steam' : st === 'bullet' ? 'electric' : st === 'hst' ? 'hst' : 'diesel';
  }

  /** Pick the loudest trains, nearby road vehicles and the nearest ringing crossing. */
  private assign(g: Game, L: Listener) {
    const now = this.k.ctx.currentTime, p = this.tmp;
    const trains: { id: number; gain: number }[] = [], roads: { id: number; gain: number; kind: SlotKind }[] = [];
    for (const v of g.vehicles.map.values()) {
      if (v.kind === 'train') {
        const t = v as Train;
        if (!t.onMap || !this.locoPos(t, p)) continue;
        const gain = distGain(distTo(L, p.x, p.y, p.z)) * (0.4 + Math.min(1, t.speed * 2));
        if (gain > 0.015) trains.push({ id: t.id, gain });
      } else {
        const r = v as RoadVehicle;
        if (!r.onMap) continue;
        r.worldPos(p);
        const tram = r.model?.kind === 'tram', coach = !tram && isCoach(r);
        const gain = distGain(distTo(L, p.x, p.y, p.z), tram ? 4 : coach ? 3.5 : 3, tram ? 60 : coach ? 50 : 40) * (tram ? 1.2 : coach ? 1.1 : 1);
        if (gain > 0.03) roads.push({ id: r.id, gain, kind: tram ? 'tram' : coach ? 'coach' : 'bus' });
      }
    }
    if (L.camDist < 35) {
      for (const a of g.vehicles.ambient) {
        if (!a.seg) continue;
        a.worldPos(p);
        const gain = distGain(distTo(L, p.x, p.y, p.z), 2.5, 30) * 0.7;
        if (gain > 0.05) roads.push({ id: -1 - (a.id % 1000000), gain, kind: 'car' });
      }
    }
    trains.sort((a, b) => b.gain - a.gain);
    roads.sort((a, b) => b.gain - a.gain);
    const want = new Set<string>();
    for (const c of trains.slice(0, TRAIN_SLOTS)) want.add('t' + c.id);
    for (const c of roads.slice(0, TRAFFIC_SLOTS)) want.add('r' + c.id);
    // nearest closed level crossing
    let bell: { id: number; d: number } | null = null;
    for (const id of g.vehicles.crossingClosed) {
      const c = g.world.net.crossings.get(id);
      if (!c) continue;
      const d = distTo(L, c.x, g.world.heightAt(c.x, c.z) + 0.4, c.z);
      if (d < 70 && (!bell || d < bell.d)) bell = { id, d };
    }
    if (bell) want.add('x' + bell.id);
    for (const [key, s] of this.slots) if (!want.has(key) && !s.dying) { s.stop(now); s.dying = now + 0.8; }
    for (const key of want) {
      const s = this.slots.get(key);
      if (s && !s.dying) continue;
      if (s) this.slots.delete(key);
      const id = Number(key.slice(1));
      let kind: SlotKind = 'bell';
      if (key[0] === 't') { const t = g.vehicles.get(id) as Train | undefined; if (!t) continue; kind = this.trainKind(t); }
      else if (key[0] === 'r') kind = roads.find((r) => r.id === id)?.kind ?? 'car';
      const slot = new Slot(this.k, id, kind, this.mix.world, now);
      slot.next = now + Math.random() * 0.05;
      slot.nextJoint = now + Math.random() * 0.4;
      this.slots.set(key, slot);
    }
  }

  private place(s: Slot, L: Listener, x: number, y: number, z: number, now: number, level: number) {
    s.x = x; s.y = y; s.z = z;
    s.d = distTo(L, x, y, z);
    const k = s.kind;
    const g = distGain(s.d, k === 'car' ? 2.5 : k === 'bus' ? 3 : k === 'coach' ? 3.5 : k === 'tram' ? 4 : 6, k === 'car' ? 30 : k === 'bus' ? 40 : k === 'coach' ? 50 : k === 'tram' ? 60 : 150) * level;
    s.gain = g;
    Slot.ramp(s.out.gain, g, now, 0.06);
    Slot.ramp(s.pan.pan, panOf(L, x, y, z), now, 0.05);
    Slot.ramp(s.lp.frequency, lowpassOf(s.d), now, 0.1);
  }

  private vehicleSlot(g: Game, s: Slot, L: Listener, dt: number, gs: number, now: number) {
    const v = (s.kind === 'car' ? g.vehicles.ambient.find((a) => -1 - (a.id % 1000000) === s.key) : g.vehicles.get(s.key)) as Train | RoadVehicle | undefined;
    const p = this.tmp;
    if (!v || !v.onMap) { if (!s.dying) { s.stop(now); s.dying = now + 0.8; } return; }
    if (v.kind === 'train') { if (!this.locoPos(v as Train, p)) return; } else v.worldPos(p);
    // parameters move at ~20 Hz (their time constants keep them smooth); events are scheduled every frame
    const ramp = now - s.lastRamp >= 0.05;
    if (ramp) { s.lastRamp = now; this.place(s, L, p.x, p.y + 0.3, p.z, now, 1); }
    const speed = v.speed;
    const vis = speed * gs; // units per real second
    const accel = s.lastSpeed < 0 || dt <= 0 ? 0 : (speed - s.lastSpeed) / Math.max(1e-3, dt * gs);
    s.lastSpeed = speed;
    const working = accel > 0.002 || (speed > 0.05 && accel > -0.002 && v.state === 'running');
    const thr = clamp((accel > 0.002 ? 0.55 + accel * 25 : working ? 0.3 : 0.08) + (vis > 0.2 ? 0.15 : 0), 0, 1);
    s.throttle += (thr - s.throttle) * Math.min(1, dt * 2.5);
    const T = s.throttle;
    const run = clamp(vis / 3, 0, 1);
    if (s.kind === 'coach') {
      // out of town (no town within its radius + 4 units, checked twice a second) the coach cruises in top gear
      if (now - s.ruralAt > 0.5) {
        s.ruralAt = now;
        let rural = 1;
        for (const t of g.towns.list) if (Math.hypot(t.x - p.x, t.z - p.z) < t.radius + 4) { rural = 0; break; }
        s.rural += (rural - s.rural) * 0.35;
      }
    }
    const R = s.rural;
    if (ramp && s.roll && s.rollF) {
      Slot.ramp(s.roll.gain, (s.kind === 'car' ? 0.3 : s.kind === 'bus' ? 0.25 : s.kind === 'coach' ? 0.27 + 0.1 * R : 0.4) * Math.pow(run, 0.8), now);
      Slot.ramp(s.rollF.frequency, (s.kind === 'coach' ? 220 - 60 * R : 250) + 650 * clamp(vis / 5, 0, 1), now, 0.2);
    }
    if (!ramp) { /* parameters unchanged this frame */ } else if (s.kind === 'diesel' || s.kind === 'hst' || s.kind === 'bus' || s.kind === 'coach') {
      // coach: like a bus but deeper, and deeper still (low revs, darker timbre) on country roads
      const f0 = (s.kind === 'bus' ? 42 + 30 * T : s.kind === 'coach' ? (34 + 22 * T) * (1 - R) + (27 + 12 * T) * R : s.kind === 'hst' ? 42 + 46 * T : 30 + 38 * T) * s.alt;
      for (const [fp, r] of s.freqs) Slot.ramp(fp, f0 * r, now, 0.25);
      if (s.engF) Slot.ramp(s.engF.frequency, s.kind === 'coach' ? (150 + 520 * T) * (1 - R) + (115 + 330 * T) * R : 170 + 650 * T, now, 0.2);
      if (s.eng) Slot.ramp(s.eng.gain, s.kind === 'bus' ? 0.07 + 0.1 * T : s.kind === 'coach' ? 0.085 + 0.1 * T + 0.02 * R : 0.14 + 0.22 * T, now, 0.15);
      if (s.whine && s.whineG) { Slot.ramp(s.whine.frequency, 2300 + 500 * T, now, 0.3); Slot.ramp(s.whineG.gain, 0.008 * T, now, 0.2); }
    } else if (s.kind === 'tram') {
      if (s.eng) Slot.ramp(s.eng.gain, 0.025 + 0.03 * T, now, 0.2);
      if (s.whine && s.whineG) {
        Slot.ramp(s.whine.frequency, (220 + 560 * clamp(vis / 2.5, 0, 1)) * s.alt, now, 0.15);
        Slot.ramp(s.whineG.gain, 0.03 * T * clamp(vis / 0.3, 0, 1), now, 0.15);
      }
      if (s.rollF) Slot.ramp(s.rollF.frequency, 450 + 900 * clamp(vis / 3, 0, 1), now, 0.2);
    } else if (s.kind === 'resistor' || s.kind === 'gto' || s.kind === 'vvvf' || s.kind === 'hsr') {
      // speed as a fraction of the unit's top speed: motor and inverter tones follow it
      const vmax = v.kind === 'train' ? (v as Train).maxSpeed : 1;
      const u = clamp(speed / Math.max(1e-3, vmax), 0, 1);
      const brake = accel < -0.004 && speed > 0.05;
      if (s.kind === 'resistor') {
        const f0 = (14 + 150 * u) * s.alt;
        for (const [fp, r] of s.freqs) Slot.ramp(fp, f0 * r, now, 0.2);
        if (s.eng) Slot.ramp(s.eng.gain, (0.035 + 0.12 * T) * clamp(u * 6, 0, 1), now, 0.15);
        if (s.whine && s.whineG) { Slot.ramp(s.whine.frequency, (260 + 1300 * u) * s.alt, now, 0.2); Slot.ramp(s.whineG.gain, 0.012 * clamp(u * 4, 0, 1), now, 0.2); }
      } else {
        // carrier: GTO steps up the scale below ~1/3 of top speed, then glides up; IGBT rises smoothly
        let fc: number, gc: number;
        if (s.kind === 'gto') {
          if (u < 0.32) { fc = GTO_SCALE[Math.min(7, Math.floor((u / 0.32) * 8))]; gc = 0.045; }
          else { fc = 700 + 900 * ((u - 0.32) / 0.68); gc = 0.028 * (1.1 - u); }
        } else { fc = (s.kind === 'hsr' ? 900 : 600) + 1500 * u; gc = 0.016; }
        const drive = accel > 0.002 ? 1 : brake ? 0.65 : 0.12;
        if (s.car && s.carF && s.carG) {
          Slot.ramp(s.car.frequency, fc * s.alt, now, s.kind === 'gto' ? 0.02 : 0.15);
          Slot.ramp(s.carF.frequency, fc * 1.3, now, 0.1);
          Slot.ramp(s.carG.gain, gc * drive * clamp(u * 20, 0, 1), now, 0.12);
        }
        if (s.whine && s.whineG) {
          Slot.ramp(s.whine.frequency, ((s.kind === 'hsr' ? 280 : 180) + (s.kind === 'hsr' ? 2200 : 1300) * u) * s.alt, now, 0.15);
          Slot.ramp(s.whineG.gain, 0.022 * clamp(u * 5, 0, 1) * (0.35 + 0.65 * Math.max(T, brake ? 0.6 : 0)), now, 0.15);
        }
        if (s.kind === 'hsr') {
          // wind roar and pantograph hiss rise steeply with speed
          if (s.wind && s.windF) { Slot.ramp(s.wind.gain, 0.34 * Math.pow(u, 2.4), now, 0.2); Slot.ramp(s.windF.frequency, 320 + 950 * u, now, 0.2); }
          if (s.hiss) Slot.ramp(s.hiss.gain, 0.075 * Math.pow(u, 3), now, 0.2);
        }
      }
    } else if (s.kind === 'electric') {
      if (s.eng) Slot.ramp(s.eng.gain, 0.04 + 0.05 * T, now, 0.2);
      if (s.whine && s.whineG) {
        Slot.ramp(s.whine.frequency, (140 + 320 * clamp(vis / 6, 0, 1)) * s.alt, now, 0.15);
        Slot.ramp(s.whineG.gain, 0.04 * T * clamp(vis / 0.4, 0, 1), now, 0.15);
      }
    } else if (s.kind === 'steam') {
      if (s.hiss) Slot.ramp(s.hiss.gain, vis < 0.05 && v.state !== 'depot' ? 0.02 : 0.004, now, 0.3);
    }
    if (s.kind === 'steam') {
      // chuffs: four exhaust beats per driving-wheel turn
      const rate = Math.min(13, (vis / DRIVER_CIRC) * 4);
      if (rate > 0.5) {
        if (s.next < now) s.next = now;
        while (s.next < now + LOOKAHEAD) {
          this.chuff(s, s.next, (T > 0.25 ? 0.55 + 0.45 * T : 0.18) * (rate > 10 ? 0.8 : 1));
          s.next += (1 / rate) * (0.94 + Math.random() * 0.12);
        }
      } else s.next = now;
    }
    if (ramp && s.squealG) {
      let sq = accel < -0.015 && vis > 0.05 && vis < 1.6 ? Math.min(0.025, -accel * 0.5) : 0;
      // trams: flange squeal through tight curves and junctions
      if (s.kind === 'tram') {
        const seg = (v as RoadVehicle).seg;
        const R = seg ? seg.curve.minRadius : Infinity;
        sq = Math.max(sq, vis > 0.06 && R < 3 ? 0.02 * clamp((3 - R) / 2, 0, 1) * clamp(vis / 0.6, 0.3, 1) : 0);
      }
      Slot.ramp(s.squealG.gain, sq, now, 0.12);
    }
    // rail joints: "da-dum ... da-dum" (axles of a bogie, then the next bogie)
    if (v.kind === 'train' && vis > 0.15) {
      const per = JOINT / vis;
      if (s.nextJoint < now) s.nextJoint = now;
      while (s.nextJoint < now + LOOKAHEAD) {
        const t0 = s.nextJoint, k = clamp(vis / 3, 0.2, 1) * (vis > 7 ? 0.5 : 1);
        if (per > 0.3) {
          const a = 0.26 / vis, b = 1.5 / vis;
          this.clack(s, t0, k); this.clack(s, t0 + a, k * 0.8);
          if (b + a < per * 0.9) { this.clack(s, t0 + b, k * 0.9); this.clack(s, t0 + b + a, k * 0.75); }
        } else this.clack(s, t0, k * 0.7);
        s.nextJoint += per * (0.97 + Math.random() * 0.06);
      }
    } else s.nextJoint = now;
  }

  private chuff(s: Slot, t: number, k: number) {
    this.k.begin();
    this.k.noise(this.k.white, t, 0.11 + 0.05 * k, 0.32 * k, s.body, { type: 'bandpass', f: 600 + Math.random() * 200, q: 0.9 }, 0.004);
    this.k.noise(this.k.brown, t, 0.13, 0.22 * k, s.body, { type: 'lowpass', f: 200 }, 0.006);
  }

  private clack(s: Slot, t: number, k: number) {
    this.k.begin();
    this.k.noise(this.k.white, t, 0.035, 0.16 * k, s.body, { type: 'bandpass', f: 2300 + Math.random() * 400, q: 4 }, 0.001);
    this.k.tone('sine', 140, t, 0.045, 0.14 * k, s.body, 0.002, 90, 0.04);
  }

  private bellSlot(s: Slot, now: number) {
    const g = this.game!;
    if (!g.world.net.crossings.has(s.key) || !g.vehicles.crossingClosed.has(s.key)) { if (!s.dying) { s.stop(now); s.dying = now + 0.8; } return; }
    if (s.next < now) s.next = now;
    while (s.next < now + LOOKAHEAD) {
      this.k.begin();
      s.alt = s.alt === 1 ? 0.93 : 1;
      RECIPES.xbell(this.k, s.next, s.body, s.alt, 1);
      s.next += 0.42;
    }
  }

  /** Called per frame by the engine for listener placement of the crossing bell. */
  private placeBells(g: Game, L: Listener, now: number) {
    for (const s of this.slots.values()) {
      if (s.kind !== 'bell' || s.dying || now - s.lastRamp < 0.05) continue;
      s.lastRamp = now;
      const c = g.world.net.crossings.get(s.key);
      if (c) this.place(s, L, c.x, g.world.heightAt(c.x, c.z) + 0.5, c.z, now, 0.9);
    }
  }

  // ------------------------------------------------------------------ events

  private events(g: Game, L: Listener, now: number) {
    const p = this.tmp;
    this.placeBells(g, L, now);
    for (const v of g.vehicles.map.values()) {
      const prev = this.prevState.get(v.id);
      this.prevState.set(v.id, v.state);
      if (prev === undefined || prev === v.state) continue;
      if (v.kind === 'train') {
        const t = v as Train;
        if (prev === 'loading' && (v.state === 'running' || v.state === 'waiting')) {
          // departure: whistle / horn
          if (!this.locoPos(t, p)) continue;
          const kind = this.trainKind(t);
          if (kind === 'tram') this.oneShot('tbell', L, p.x, p.y + 0.3, p.z, 1, 2, 0.97 + Math.random() * 0.06);
          else if (kind === 'resistor' || kind === 'gto' || kind === 'vvvf') this.oneShot('tchime', L, p.x, p.y + 0.3, p.z, 0.7, 1);
          else this.oneShot(kind === 'steam' ? 'whistle' : kind === 'diesel' ? 'horn' : 'horn2', L, p.x, p.y + 0.4, p.z, kind === 'hsr' ? 0.6 : 1, 2, 0.97 + Math.random() * 0.06);
        } else if (v.state === 'loading' && t.atStation >= 0) {
          const st = g.stations.get(t.atStation);
          if (!st || (this.chimeAt.get(st.id) ?? -1e9) > now - 8) continue;
          this.chimeAt.set(st.id, now);
          const y = (st.rail?.y ?? g.world.heightAt(st.x, st.z)) + 0.8;
          this.oneShot('chime', L, st.x, y, st.z, 0.9, 2);
        }
      } else if (!(v as RoadVehicle).ambient) {
        const tram = (v as RoadVehicle).model?.kind === 'tram';
        if (v.state === 'loading') {
          v.worldPos(p);
          if (tram) this.oneShot('tchime', L, p.x, p.y + 0.3, p.z, 0.8, 1);
          this.oneShot('doors', L, p.x, p.y + 0.2, p.z, 0.8, 1);
        } else if (tram && prev === 'loading' && v.state === 'running') {
          v.worldPos(p);
          this.oneShot('tbell', L, p.x, p.y + 0.3, p.z, 1, 2, 0.97 + Math.random() * 0.06);
        }
      }
    }
    // trams ring now and then when they enter a junction
    for (const sl of this.slots.values()) {
      if (sl.kind !== 'tram' || sl.dying) continue;
      const tv = g.vehicles.get(sl.key) as RoadVehicle | undefined;
      const k = tv?.seg?.kind ?? 'lane';
      const was = this.segKind.get(sl.key);
      this.segKind.set(sl.key, k);
      if (tv && was === 'lane' && k === 'conn' && now - (this.dingAt.get(sl.key) ?? -1e9) > 10 && Math.random() < 0.3) {
        this.dingAt.set(sl.key, now);
        tv.worldPos(p);
        this.oneShot('tding', L, p.x, p.y + 0.3, p.z, 0.9, 1);
      }
    }
    // income near the camera
    if (this.income.length && now - this.lastCash > 0.25) {
      const e = this.income.shift()!;
      this.lastCash = now;
      const pitch = clamp(1.12 - Math.log10(Math.max(10, e.amount)) * 0.04, 0.85, 1.1); // = cashPitch()
      this.oneShot('cash', L, e.x, g.world.heightAt(e.x, e.z) + 1, e.z, 0.7, 2, pitch);
      if (this.income.length > 4) this.income.length = 4;
    }
  }

  // ------------------------------------------------------------------ ambience

  /** Weights of the ambience layers from what the camera sees (3 Hz). */
  private analyze(g: Game, L: Listener, night: number) {
    const w = g.world;
    const focus = this.focus;
    // town: inside or near a town, louder for bigger towns
    let town = 0;
    for (const t of g.towns.list) {
      const d = Math.hypot(t.x - focus.x, t.z - focus.z);
      const k = clamp(1 - (d - t.radius * 0.6) / (t.radius * 0.8 + 6), 0, 1) * clamp(0.35 + t.pop / 4000, 0.35, 1);
      if (k > town) town = k;
    }
    // water: share of samples under the sea around the focus (surf strongest along shores)
    const R = clamp(L.camDist * 0.5, 6, 90);
    let wet = 0, n = 0;
    for (let i = 0; i < 13; i++) {
      const a = i * 2.39996, r = i === 0 ? 0 : R * Math.sqrt(i / 12);
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      if (x < 0 || z < 0 || x > w.size || z > w.size) continue;
      n++;
      if (w.heightAt(x, z) < 0) wet++;
    }
    const water = n ? wet / n : 0;
    const shore = water * (0.5 + 2 * water * (1 - water));
    // forest density near the focus
    let trees = 0;
    for (const id of w.treeGrid.query(focus.x - 10, focus.z - 10, focus.x + 10, focus.z + 10)) if (w.trees[id]) trees++;
    const forest = clamp(trees / 50, 0, 1);
    const near = clamp((420 - L.camDist) / 340, 0.15, 1);
    const high = clamp((L.y - L.ground) / 220, 0, 1);
    const e = this.env;
    e.near = near;
    e.wind = 0.07 + 0.12 * high + 0.04 * (1 - town) + 0.04 * clamp((focus.y - 12) / 30, 0, 1);
    e.town = 0.2 * town * near * (1 - 0.35 * night);
    e.waves = 0.3 * clamp(shore, 0, 1) * near;
    e.birds = (1 - town * 0.75) * (1 - night) * (0.3 + 0.7 * forest) * near * (1 - water);
    e.crickets = night * (1 - town * 0.6) * near * (1 - water);
  }

  /** Smoothed focus point (set by the engine each frame). */
  focus = { x: 0, y: 0, z: 0 };

  private bedT = -1;
  private ambience(now: number, L: Listener) {
    const e = this.env;
    if (now - this.bedT >= 0.1) {
      this.bedT = now;
      Slot.ramp(this.wind.gain, e.wind, now, 1.2);
      Slot.ramp(this.town.gain, e.town, now, 1.2);
      Slot.ramp(this.waves.gain, e.waves, now, 1.2);
    }
    // surf swells
    if (e.waves > 0.01) {
      if (this.nextSwell < now) this.nextSwell = now;
      while (this.nextSwell < now + 0.5) {
        const t = this.nextSwell, up = 1.8 + Math.random() * 1.4, down = 2.2 + Math.random() * 2;
        this.swell.gain.setTargetAtTime(0.85 + Math.random() * 0.3, t, up / 3);
        this.swell.gain.setTargetAtTime(0.25 + Math.random() * 0.1, t + up, down / 3);
        this.nextSwell = t + up + down;
      }
    }
    const pick = (spread: number) => (Math.random() * 2 - 1) * spread;
    // birds by day in the countryside
    if (e.birds > 0.03 && now >= this.nextBird) {
      this.ambientShot('bird', pick(0.8), 0.6 + 0.4 * e.birds, 0.9 + Math.random() * 0.3);
      this.nextBird = now + (0.7 + 3 * (1 - e.birds)) * (0.5 + Math.random());
    } else if (now >= this.nextBird) this.nextBird = now + 1;
    // crickets at night: two individuals, left and right
    if (e.crickets > 0.05) {
      for (let i = 0; i < 2; i++) {
        if (now < this.nextCricket[i]) continue;
        this.ambientShot('cricket', i ? 0.55 : -0.6, e.crickets, i ? 1.03 : 0.97);
        this.nextCricket[i] = now + (i ? 0.62 : 0.71) * (0.85 + Math.random() * 0.3) + (Math.random() < 0.1 ? 1.5 : 0);
      }
    }
    // cars passing in town
    if (e.town > 0.03 && now >= this.nextSwish) {
      this.ambientShot('swish', pick(0.7), e.town * 4, 0.8 + Math.random() * 0.5);
      this.nextSwish = now + (1.2 + 3 * (1 - e.town * 4)) * (0.6 + Math.random() * 0.8);
    } else if (now >= this.nextSwish) this.nextSwish = now + 1;
    void L;
  }

  /** Non-positional ambience one-shot (lowest priority). */
  private ambientShot(name: string, pan: number, vol: number, pitch: number) {
    const c = this.k.ctx, now = c.currentTime;
    if (!this.mix.voices.reserve(now, 0, this.mix.budget())) return;
    const p = c.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.mix.ambient);
    const out = c.createGain();
    out.gain.value = 1;
    out.connect(p);
    this.k.begin();
    RECIPES[name](this.k, now + 0.01, out, pitch, vol);
    this.mix.voices.add({ end: this.k.end, prio: 0, out, srcs: this.k.srcs });
  }

  /** Current ambience weights (for tests and debugging). */
  get weights() { return { ...this.env }; }
}
