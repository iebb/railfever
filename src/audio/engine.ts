// Procedural sound engine (WebAudio, no audio files): soft UI and construction sounds, positional world
// sounds driven by the game (trains, traffic, crossings, stations, income) and an ambience bed that
// follows what the camera sees. Everything is synthesized at runtime (offline build).
import type * as THREE from 'three';
import type { Game } from '../game/game';
import { Kit, RECIPES, VoicePool, WORLD_ONLY, impulseResponse } from './synth';
import { WorldAudio, Listener, nightOf, panOf, distTo } from './world';

export type Sfx =
  | 'click' | 'hover' | 'open' | 'close' | 'toggle' | 'tool'
  | 'build-rail' | 'build-road' | 'build' | 'demolish' | 'error' | 'cash' | 'purchase'
  | 'station' | 'depot' | 'signal' | 'notify' | 'news-good' | 'news-bad' | 'speed' | 'pause';

export interface AudioSettings { master: number; ui: number; world: number; ambient: number; muted: boolean }

/** x/z: world position (pans the sound); volume: gain factor; pitch: frequency factor (e.g. cash by amount,
 * toggle on/off, pause > 1 = resume). */
export interface PlayOpts { x?: number; z?: number; volume?: number; pitch?: number }

const STORE = 'railfever.audio';
/** Total concurrent voices: continuous beds and vehicle slots plus one-shots. */
export const MAX_VOICES = 16;
const BEDS = 3;

/** Voice priority when the budget is full (higher steals lower; equal steals the oldest). */
const PRIO: Record<Sfx, number> = {
  hover: 0, click: 2, open: 2, close: 2, toggle: 2, tool: 2, speed: 2, pause: 2, notify: 3, signal: 2,
  build: 3, 'build-rail': 3, 'build-road': 3, demolish: 3, station: 3, depot: 3,
  error: 3, cash: 3, purchase: 3, 'news-good': 3, 'news-bad': 3,
};

/** Pitch for a 'cash' sound by amount: small sums ring higher, big ones a little deeper and fuller. */
export function cashPitch(amount: number): number {
  return Math.max(0.85, Math.min(1.1, 1.12 - Math.log10(Math.max(10, Math.abs(amount))) * 0.04));
}

function defaultContext(): BaseAudioContext | null {
  if (typeof window === 'undefined') return null;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try { return new C({ latencyHint: 'interactive' }); } catch { return null; }
}

export class AudioEngine {
  settings: AudioSettings = { master: 0.8, ui: 0.7, world: 0.8, ambient: 0.6, muted: false };
  /** Context factory (tests inject a fake). */
  createContext: () => BaseAudioContext | null = defaultContext;
  ctx: BaseAudioContext | null = null;
  voices = new VoicePool(MAX_VOICES);
  world: WorldAudio | null = null;
  private kit: Kit | null = null;
  private master: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private worldBus: GainNode | null = null;
  private ambBus: GainNode | null = null;
  private game: Game | null = null;
  private subscribed = new WeakSet<Game>();
  private L: Listener = { x: 0, y: 50, z: 0, rx: 1, ry: 0, rz: 0, camDist: 60, ground: 0 };
  private lastHover = 0;
  private paused = false;
  private unlocked = false;

  /** Call on the first user gesture (browsers keep audio suspended until then). */
  unlock() {
    if (!this.ctx && !this.init()) return;
    this.unlocked = true;
    const c = this.ctx as AudioContext;
    if (c.state !== 'running' && typeof c.resume === 'function' && !(typeof document !== 'undefined' && document.hidden)) {
      c.resume().catch(() => { /* not allowed yet */ });
    }
  }

  private init(): boolean {
    const ctx = this.createContext();
    if (!ctx) return false;
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.25;
    comp.connect(ctx.destination);
    const bus = (dest: AudioNode, v = 1) => { const g = ctx.createGain(); g.gain.value = v; g.connect(dest); return g; };
    this.master = bus(comp, 0);
    this.uiBus = bus(this.master);
    this.worldBus = bus(this.master);
    this.ambBus = bus(this.master);
    // a touch of space: shared convolution reverb fed by the UI and world buses
    const verb = ctx.createConvolver();
    verb.buffer = impulseResponse(ctx);
    verb.connect(bus(this.master, 0.8));
    this.uiBus.connect(bus(verb, 0.1));
    this.worldBus.connect(bus(verb, 0.2));
    this.kit = new Kit(ctx);
    this.world = new WorldAudio(this.kit, { ambient: this.ambBus, world: this.worldBus, voices: this.voices, budget: () => this.budget() });
    if (this.game) { this.world.setGame(this.game); this.world.track(this.game); }
    this.apply();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        const c = this.ctx as AudioContext | null;
        if (!c) return;
        if (document.hidden) c.suspend?.().catch(() => {});
        else if (this.unlocked) c.resume?.().catch(() => {});
      });
    }
    return true;
  }

  /** One-shot voices available now (continuous beds and vehicle slots count against the limit). */
  budget() { return Math.max(4, MAX_VOICES - BEDS - (this.world ? this.world.slotCount : 0)); }

  setGame(game: Game) {
    this.game = game;
    if (!this.subscribed.has(game)) {
      this.subscribed.add(game);
      game.listeners.income.push((amount, v, st) => { if (this.game === game) this.world?.onIncome(amount, v, st); });
    }
    if (this.world) { this.world.setGame(game); this.world.track(game); }
    this.paused = game.paused;
    this.apply();
  }

  /**
   * Per frame: listener follows the camera; world sounds and ambience. `night` (0..1, e.g. the
   * renderer's) overrides the day-cycle estimate from game.visualTime.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, focus: THREE.Vector3, camDist: number, night?: number) {
    const g = this.game;
    if (!g) return;
    const L = this.L, e = camera.matrixWorld.elements;
    L.x = camera.position.x; L.y = camera.position.y; L.z = camera.position.z;
    const rl = Math.hypot(e[0], e[1], e[2]) || 1;
    L.rx = e[0] / rl; L.ry = e[1] / rl; L.rz = e[2] / rl;
    L.camDist = camDist;
    L.ground = g.world.heightAt(L.x, L.z);
    if (g.paused !== this.paused) { this.paused = g.paused; this.apply(); }
    const w = this.world;
    if (!w || !this.ctx || this.ctx.state !== 'running') { w?.track(g); return; }
    w.focus.x = focus.x; w.focus.y = focus.y; w.focus.z = focus.z;
    w.update(Math.min(Math.max(dt, 0), 0.1), L, night ?? nightOf(g.visualTime), g.paused);
  }

  play(name: Sfx, opts: PlayOpts = {}) {
    const c = this.ctx, kit = this.kit;
    if (!c || !kit || c.state !== 'running' || this.settings.muted || !this.uiBus) return;
    const recipe = RECIPES[name];
    if (!recipe || WORLD_ONLY.has(name)) return;
    const now = c.currentTime;
    if (name === 'hover') { if (now - this.lastHover < 0.06) return; this.lastHover = now; }
    const prio = PRIO[name] ?? 2;
    if (!this.voices.reserve(now, prio, this.budget())) return;
    let vol = opts.volume ?? 1;
    const out = c.createGain();
    out.gain.value = 1;
    if (opts.x !== undefined && opts.z !== undefined && this.game) {
      // feedback stays audible: positioned in stereo, only mildly quieter far away
      const y = this.game.world.heightAt(opts.x, opts.z);
      const d = distTo(this.L, opts.x, y, opts.z);
      vol *= Math.max(0.55, Math.min(1, 1.15 - d / 400));
      const pan = c.createStereoPanner();
      pan.pan.value = panOf(this.L, opts.x, y, opts.z) * 0.6;
      pan.connect(this.uiBus);
      out.connect(pan);
    } else out.connect(this.uiBus);
    kit.begin();
    recipe(kit, now + 0.005, out, opts.pitch ?? 1, vol);
    this.voices.add({ end: kit.end, prio, out, srcs: kit.srcs });
  }

  loadSettings() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE) : null;
      if (raw) {
        const s = JSON.parse(raw) as Partial<AudioSettings>;
        for (const k of ['master', 'ui', 'world', 'ambient'] as const) {
          const v = s[k];
          if (typeof v === 'number' && isFinite(v)) this.settings[k] = Math.max(0, Math.min(1, v));
        }
        if (typeof s.muted === 'boolean') this.settings.muted = s.muted;
      }
    } catch { /* ignore */ }
    this.apply();
  }

  saveSettings() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.apply();
  }

  /** Push settings (and the paused state) into the bus gains, smoothly. */
  private apply() {
    const c = this.ctx;
    if (!c || !this.master || !this.uiBus || !this.worldBus || !this.ambBus) return;
    const s = this.settings, now = c.currentTime;
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), now, 0.05);
    set(this.master, s.muted ? 0 : s.master);
    set(this.uiBus, s.ui);
    set(this.worldBus, this.paused ? 0 : s.world);
    set(this.ambBus, s.ambient * (this.paused ? 0.6 : 1));
  }

  /** Debug figures. */
  get stats() {
    const now = this.ctx?.currentTime ?? 0;
    this.voices.purge(now);
    return { state: this.ctx?.state ?? 'none', voices: this.voices.list.length, slots: this.world?.slotCount ?? 0, budget: this.budget() };
  }
}

export const audio = new AudioEngine();
