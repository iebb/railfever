// Synthesis toolkit: generated noise buffers and impulse response, enveloped tones/noise bursts,
// a small voice pool, and the one-shot sound recipes (UI, construction, world events).
// Everything is computed at runtime: no audio files.

export type Ctx = BaseAudioContext;

/** A one-shot voice: sources play into `out` (a kill-switch gain used for stealing). */
export interface Voice { end: number; prio: number; out: GainNode; srcs: AudioScheduledSourceNode[] }

/** Fixed-size voice budget; when full, a new voice may steal the least important (then oldest) one. */
export class VoicePool {
  list: Voice[] = [];
  constructor(public max: number) {}
  purge(now: number) {
    let j = 0;
    for (let i = 0; i < this.list.length; i++) if (this.list[i].end > now) this.list[j++] = this.list[i];
    this.list.length = j;
  }
  /** Make room for a voice of priority `prio`; false when every active voice matters more. */
  reserve(now: number, prio: number, budget = this.max): boolean {
    this.purge(now);
    while (this.list.length >= budget) {
      let vi = -1;
      for (let i = 0; i < this.list.length; i++) {
        const v = this.list[i];
        if (vi < 0 || v.prio < this.list[vi].prio || (v.prio === this.list[vi].prio && v.end < this.list[vi].end)) vi = i;
      }
      if (vi < 0 || this.list[vi].prio > prio) return false;
      this.steal(this.list[vi], now);
      this.list.splice(vi, 1);
    }
    return true;
  }
  steal(v: Voice, now: number) {
    v.out.gain.setTargetAtTime(0, now, 0.012);
    for (const s of v.srcs) { try { s.stop(now + 0.1); } catch { /* already stopped */ } }
    v.end = now;
  }
  add(v: Voice) { this.list.push(v); }
}

export interface Filt { type: BiquadFilterType; f: number; q?: number; f1?: number; t1?: number }

/** Builder for one-shot recipes: creates sources into a destination and collects them. */
export class Kit {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** stereo pink noise for ambience beds */
  stereo: AudioBuffer;
  srcs: AudioScheduledSourceNode[] = [];
  end = 0;

  constructor(public ctx: Ctx) {
    const sr = ctx.sampleRate;
    this.white = noiseBuffer(ctx, 'white', Math.round(sr * 1.5), 1);
    this.pink = noiseBuffer(ctx, 'pink', Math.round(sr * 2), 1);
    this.brown = noiseBuffer(ctx, 'brown', Math.round(sr * 2), 1);
    this.stereo = noiseBuffer(ctx, 'pink', Math.round(sr * 3), 2);
  }

  begin() { this.srcs = []; this.end = 0; }

  private track(s: AudioScheduledSourceNode, stop: number) {
    s.stop(stop);
    this.srcs.push(s);
    if (stop > this.end) this.end = stop;
  }

  gain(v = 1, dest?: AudioNode | AudioParam): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) link(g, dest);
    return g;
  }

  filter(f: Filt, t: number, dest: AudioNode): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = f.type;
    b.frequency.setValueAtTime(f.f, t);
    if (f.f1) b.frequency.exponentialRampToValueAtTime(f.f1, t + (f.t1 ?? 0.2));
    b.Q.value = f.q ?? 0.707;
    b.connect(dest);
    return b;
  }

  /** Attack/decay envelope on a gain param (exponential decay to -60 dB at t + dur). */
  env(p: AudioParam, t: number, peak: number, attack: number, dur: number, hold = 0) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
    p.exponentialRampToValueAtTime(Math.max(1e-6, peak * 1e-3), t + Math.max(dur, attack + hold + 0.005));
  }

  /** Enveloped oscillator, optionally gliding f0 -> f1 over `glide` seconds. */
  tone(type: OscillatorType, f0: number, t: number, dur: number, peak: number, dest: AudioNode, attack = 0.004, f1 = 0, glide = 0, hold = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 > 0) o.frequency.exponentialRampToValueAtTime(f1, t + Math.max(0.005, glide || dur));
    const g = this.ctx.createGain();
    this.env(g.gain, t, peak, attack, dur, hold);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    this.track(o, t + dur + 0.03);
    return o;
  }

  /** Enveloped noise burst through an optional filter. */
  noise(buf: AudioBuffer, t: number, dur: number, peak: number, dest: AudioNode, filt?: Filt, attack = 0.003, hold = 0): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const g = this.ctx.createGain();
    this.env(g.gain, t, peak, attack, dur, hold);
    s.connect(g);
    g.connect(filt ? this.filter(filt, t, dest) : dest);
    s.start(t, Math.random() * Math.max(0, buf.duration - 0.1));
    this.track(s, t + dur + 0.03);
    return s;
  }

  /** Many short noise grains (gravel, debris) from a single source with a pulsed gain. */
  grains(buf: AudioBuffer, t: number, n: number, spread: number, peak: number, grain: number, dest: AudioNode, filt: Filt, decay = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    const times: number[] = [];
    for (let i = 0; i < n; i++) times.push(t + Math.pow(Math.random(), 1.3) * spread);
    times.sort((a, b) => a - b);
    let last = t;
    for (const tt of times) {
      // keep automation events strictly in time order: each grain starts after the previous ends
      const at = Math.max(tt, last + 0.004);
      const k = Math.max(0.05, Math.pow(Math.max(0, 1 - (at - t) / (spread + 0.05)), decay));
      const pk = peak * k * (0.4 + 0.6 * Math.random());
      const end = at + grain * (0.6 + 0.8 * Math.random());
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(pk, at + 0.002);
      g.gain.exponentialRampToValueAtTime(Math.max(1e-6, pk * 0.01), end);
      last = end;
    }
    g.gain.setValueAtTime(0, last + 0.01);
    s.connect(g);
    g.connect(this.filter(filt, t, dest));
    s.start(t, Math.random() * Math.max(0, buf.duration - 0.1));
    this.track(s, last + 0.03);
  }
}

/** Connect a node to another node or to an AudioParam (modulation). */
export function link(src: AudioNode, dest: AudioNode | AudioParam) {
  if ('setValueAtTime' in dest) src.connect(dest as AudioParam);
  else src.connect(dest as AudioNode);
}

/** White, pink (Kellet) or brown noise, normalised. */
export function noiseBuffer(ctx: Ctx, kind: 'white' | 'pink' | 'brown', len: number, channels: number): AudioBuffer {
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0, mx = 1e-9;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      let v = w;
      if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      } else if (kind === 'brown') {
        br = (br + 0.02 * w) / 1.02;
        v = br;
      }
      d[i] = v;
      const a = Math.abs(v);
      if (a > mx) mx = a;
    }
    // normalise and fade the loop seam
    const k = 0.9 / mx, fade = Math.min(256, len >> 3);
    for (let i = 0; i < len; i++) d[i] *= k;
    for (let i = 0; i < fade; i++) { const f = i / fade; d[i] *= f; d[len - 1 - i] *= f; }
  }
  return buf;
}

/** Small, warm room/outdoor reverb: decaying stereo noise with a few early reflections. */
export function impulseResponse(ctx: Ctx, seconds = 1.4, decay = 0.32): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.round(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      lp += (w - lp) * (0.25 + 0.5 * Math.exp(-t * 3)); // darker tail
      d[i] = lp * Math.exp(-t / decay) * (t < 0.008 ? t / 0.008 : 1);
    }
    for (const [ms, a] of [[11, 0.5], [17, 0.35], [29, 0.3], [41, 0.2]] as const) {
      const i = Math.round((ms + c * 3) * sr / 1000);
      if (i < len) d[i] += a * (c ? -1 : 1);
    }
  }
  return buf;
}

export type Recipe = (k: Kit, t: number, out: AudioNode, pitch: number, vol: number) => void;

const sine = 'sine' as const, tri = 'triangle' as const, saw = 'sawtooth' as const, sq = 'square' as const;

/** Bell-like strike: inharmonic sine partials with individual decays. */
function bell(k: Kit, t: number, f: number, peak: number, dur: number, out: AudioNode, partials: [number, number, number][]) {
  for (const [m, a, dk] of partials) k.tone(sine, f * m, t, dur * dk, peak * a, out, 0.002);
}

const COIN: [number, number, number][] = [[1, 1, 1], [1.5, 0.45, 0.8], [2.76, 0.3, 0.45], [4.1, 0.12, 0.3]];
const XBELL: [number, number, number][] = [[1, 1, 1], [2.0, 0.5, 0.7], [2.76, 0.35, 0.5], [5.4, 0.12, 0.25]];

/** UI and construction sounds (non-positional or panned). */
export const RECIPES: Record<string, Recipe> = {
  click(k, t, out, p, v) {
    k.tone(sine, 1500 * p, t, 0.05, 0.12 * v, out, 0.002, 1100 * p, 0.03);
    k.noise(k.white, t, 0.014, 0.035 * v, out, { type: 'highpass', f: 2600 });
  },
  hover(k, t, out, p, v) {
    k.tone(sine, 2300 * p, t, 0.022, 0.025 * v, out, 0.002, 2050 * p, 0.02);
  },
  open(k, t, out, p, v) {
    k.tone(sine, 620 * p, t, 0.16, 0.08 * v, out, 0.008, 930 * p, 0.07);
    k.tone(tri, 310 * p, t, 0.14, 0.05 * v, out, 0.008, 465 * p, 0.07);
    k.noise(k.pink, t, 0.12, 0.02 * v, out, { type: 'bandpass', f: 1200, q: 0.8, f1: 3200, t1: 0.1 }, 0.02);
  },
  close(k, t, out, p, v) {
    k.tone(sine, 860 * p, t, 0.13, 0.07 * v, out, 0.006, 560 * p, 0.08);
    k.tone(tri, 430 * p, t, 0.12, 0.045 * v, out, 0.006, 280 * p, 0.08);
  },
  toggle(k, t, out, p, v) {
    k.tone(sine, 1250, t, 0.04, 0.08 * v, out, 0.002);
    k.tone(sine, 1250 * (p >= 1 ? 1.33 : 0.8), t + 0.05, 0.05, 0.08 * v, out, 0.002);
  },
  tool(k, t, out, p, v) {
    const f = k.filter({ type: 'lowpass', f: 2600 }, t, out);
    k.tone(tri, 520 * p, t, 0.08, 0.12 * v, f, 0.002, 470 * p, 0.06);
    k.tone(sine, 1040 * p, t, 0.05, 0.04 * v, f, 0.002);
    k.noise(k.white, t, 0.015, 0.03 * v, out, { type: 'bandpass', f: 1900, q: 2 });
  },
  speed(k, t, out, p, v) {
    k.tone(sine, 500 * p, t, 0.09, 0.08 * v, out, 0.004, 720 * p, 0.06);
    k.tone(tri, 1000 * p, t + 0.02, 0.06, 0.025 * v, out, 0.004);
  },
  pause(k, t, out, p, v) {
    // falling two notes (pause); pitch > 1 rises instead (resume)
    const up = p > 1;
    k.tone(tri, up ? 392 : 523, t, 0.11, 0.08 * v, out, 0.005);
    k.tone(tri, up ? 523 : 392, t + 0.09, 0.16, 0.08 * v, out, 0.005);
  },
  notify(k, t, out, p, v) {
    bell(k, t, 1318.5 * p, 0.06 * v, 0.55, out, [[1, 1, 1], [2, 0.15, 0.5]]);
    bell(k, t + 0.09, 1568 * p, 0.06 * v, 0.7, out, [[1, 1, 1], [2, 0.15, 0.5]]);
  },
  error(k, t, out, p, v) {
    const f = k.filter({ type: 'lowpass', f: 750, q: 0.7 }, t, out);
    for (const dt of [0, 0.13]) {
      k.tone(saw, 155 * p, t + dt, 0.1, 0.07 * v, f, 0.006, 0, 0, 0.04);
      k.tone(saw, 158.5 * p, t + dt, 0.1, 0.06 * v, f, 0.006, 0, 0, 0.04);
    }
  },
  cash(k, t, out, p, v) {
    k.noise(k.white, t, 0.03, 0.05 * v, out, { type: 'bandpass', f: 2400, q: 1.5 });
    bell(k, t + 0.025, 2093 * p, 0.07 * v, 0.45, out, COIN);
    bell(k, t + 0.085, 2793 * p, 0.06 * v, 0.6, out, COIN);
  },
  purchase(k, t, out, p, v) {
    k.tone(sine, 140, t, 0.09, 0.12 * v, out, 0.003, 90, 0.08);
    k.noise(k.pink, t, 0.14, 0.04 * v, out, { type: 'bandpass', f: 800, q: 1, f1: 2200, t1: 0.12 }, 0.02);
    bell(k, t + 0.12, 1568 * p, 0.06 * v, 0.6, out, COIN);
    bell(k, t + 0.16, 2093 * p, 0.06 * v, 0.7, out, COIN);
    bell(k, t + 0.2, 2637 * p, 0.05 * v, 0.8, out, COIN);
  },
  build(k, t, out, p, v) {
    // two hammer knocks
    for (const [dt, m] of [[0, 1], [0.12, 0.92]] as const) {
      k.tone(tri, 190 * p * m, t + dt, 0.12, 0.18 * v, out, 0.002, 120 * p * m, 0.08);
      k.noise(k.white, t + dt, 0.03, 0.06 * v, out, { type: 'bandpass', f: 1100, q: 1.4 });
    }
  },
  'build-rail'(k, t, out, p, v) {
    // metallic rail clank (inharmonic partials) twice, ballast crunch in between
    for (const [dt, m] of [[0, 1], [0.2, 0.94]] as const) {
      bell(k, t + dt, 410 * p * m, 0.09 * v, 0.32, out, [[1, 1, 1], [2.76, 0.7, 0.7], [4.53, 0.45, 0.5], [7.24, 0.28, 0.35]]);
      k.noise(k.white, t + dt, 0.02, 0.07 * v, out, { type: 'highpass', f: 3000 });
    }
    k.grains(k.white, t + 0.04, 14, 0.42, 0.11 * v, 0.03, out, { type: 'bandpass', f: 1900, q: 1.1 }, 1.2);
    k.noise(k.brown, t + 0.03, 0.3, 0.08 * v, out, { type: 'lowpass', f: 500 }, 0.02);
  },
  'build-road'(k, t, out, p, v) {
    // asphalt roller: low thuds and a rolling rumble with a faint tarmac hiss
    k.tone(sine, 66 * p, t, 0.35, 0.3 * v, out, 0.01, 44 * p, 0.25);
    k.tone(sine, 58 * p, t + 0.24, 0.28, 0.18 * v, out, 0.01, 42 * p, 0.2);
    k.noise(k.brown, t, 0.5, 0.22 * v, out, { type: 'lowpass', f: 280, q: 0.8 }, 0.03);
    k.noise(k.pink, t + 0.05, 0.35, 0.012 * v, out, { type: 'highpass', f: 3200 }, 0.05);
  },
  demolish(k, t, out, p, v) {
    k.tone(sine, 55 * p, t, 0.22, 0.25 * v, out, 0.005, 38 * p, 0.2);
    k.noise(k.brown, t, 0.8, 0.32 * v, out, { type: 'lowpass', f: 1800, q: 0.6, f1: 220, t1: 0.7 }, 0.01);
    k.grains(k.white, t + 0.05, 16, 0.85, 0.09 * v, 0.035, out, { type: 'bandpass', f: 1100, q: 0.9 }, 1.6);
  },
  station(k, t, out, p, v) {
    bell(k, t, 440 * p, 0.05 * v, 0.25, out, [[1, 1, 1], [2.76, 0.6, 0.6], [4.53, 0.3, 0.4]]);
    RECIPES.chime(k, t + 0.12, out, p, v * 0.8);
  },
  depot(k, t, out, p, v) {
    k.tone(sine, 90 * p, t, 0.18, 0.18 * v, out, 0.004, 60 * p, 0.15);
    k.grains(k.white, t + 0.03, 10, 0.4, 0.05 * v, 0.03, out, { type: 'bandpass', f: 900, q: 2 }, 1);
    bell(k, t + 0.02, 330 * p, 0.05 * v, 0.3, out, [[1, 1, 1], [2.76, 0.6, 0.6]]);
  },
  signal(k, t, out, p, v) {
    k.noise(k.white, t, 0.012, 0.06 * v, out, { type: 'bandpass', f: 2200, q: 3 });
    k.noise(k.white, t + 0.045, 0.012, 0.05 * v, out, { type: 'bandpass', f: 1800, q: 3 });
    k.tone(sine, 1760 * p, t + 0.05, 0.2, 0.025 * v, out, 0.003);
  },
  'news-good'(k, t, out, p, v) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      k.tone(tri, f * p, t + i * 0.075, i === 3 ? 0.6 : 0.3, 0.06 * v, out, 0.006);
      k.tone(sine, f * 2 * p, t + i * 0.075, 0.2, 0.012 * v, out, 0.006);
    });
  },
  'news-bad'(k, t, out, p, v) {
    const f = k.filter({ type: 'lowpass', f: 1300 }, t, out);
    [440, 349.23, 293.66].forEach((n, i) => {
      k.tone(tri, n * p, t + i * 0.12, i === 2 ? 0.6 : 0.3, 0.075 * v, f, 0.008);
      k.tone(sq, n * p, t + i * 0.12, 0.25, 0.012 * v, f, 0.008);
    });
  },
  // ------------------------------------------------------------------ world events (positional)
  /** station announcement chime (G5 E5 C5) */
  chime(k, t, out, p, v) {
    [783.99, 659.25, 523.25].forEach((f, i) => bell(k, t + i * 0.32, f * p, 0.07 * v, 1.0, out, [[1, 1, 1], [2, 0.25, 0.5], [3, 0.08, 0.3]]));
  },
  /** steam whistle */
  whistle(k, t, out, p, v) {
    for (const f of [555, 698, 831]) k.tone(sine, f * p, t, 1.0, 0.07 * v, out, 0.07, 0, 0, 0.55);
    k.noise(k.pink, t, 1.0, 0.03 * v, out, { type: 'bandpass', f: 1500 * p, q: 3 }, 0.08, 0.55);
  },
  /** diesel two-tone horn */
  horn(k, t, out, p, v) {
    const f = k.filter({ type: 'lowpass', f: 1500, q: 0.7 }, t, out);
    k.tone(saw, 311 * p, t, 0.85, 0.06 * v, f, 0.04, 0, 0, 0.55);
    k.tone(saw, 370 * p, t, 0.85, 0.05 * v, f, 0.04, 0, 0, 0.55);
  },
  /** high-speed/electric two-note horn */
  horn2(k, t, out, p, v) {
    const f = k.filter({ type: 'lowpass', f: 2400, q: 0.7 }, t, out);
    k.tone(sq, 659 * p, t, 0.3, 0.035 * v, f, 0.02, 0, 0, 0.18);
    k.tone(sq, 494 * p, t + 0.28, 0.4, 0.035 * v, f, 0.02, 0, 0, 0.25);
  },
  /** level-crossing bell strike */
  xbell(k, t, out, p, v) { bell(k, t, 1180 * p, 0.07 * v, 0.5, out, XBELL); },
  /** bus doors */
  doors(k, t, out, p, v) { k.noise(k.white, t, 0.4, 0.05 * v, out, { type: 'highpass', f: 2600 * p }, 0.02, 0.15); },
  /** car passing in town (whoosh) */
  swish(k, t, out, p, v) { k.noise(k.pink, t, 1.4, 0.05 * v, out, { type: 'bandpass', f: 900 * p, q: 0.7, f1: 420 * p, t1: 1.3 }, 0.6); },
  /** bird chirp phrase */
  bird(k, t, out, p, v) {
    const n = 1 + Math.floor(Math.random() * 4);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const f0 = (2600 + Math.random() * 1800) * p;
      k.tone(sine, f0, tt, 0.07 + Math.random() * 0.05, 0.03 * v, out, 0.004, f0 * (1.25 + Math.random() * 0.4), 0.05);
      tt += 0.09 + Math.random() * 0.08;
    }
  },
  /** tram bell: "ding-ding" */
  tbell(k, t, out, p, v) {
    for (const dt of [0, 0.17]) bell(k, t + dt, 1250 * p, 0.055 * v, 0.6, out, [[1, 1, 1], [2.7, 0.35, 0.5], [5.2, 0.12, 0.3]]);
  },
  /** single tram bell strike (junctions) */
  tding(k, t, out, p, v) { bell(k, t, 1250 * p, 0.045 * v, 0.55, out, [[1, 1, 1], [2.7, 0.35, 0.5], [5.2, 0.12, 0.3]]); },
  /** tram door chime: soft falling two-tone */
  tchime(k, t, out, p, v) {
    k.tone(sine, 1174.7 * p, t, 0.32, 0.03 * v, out, 0.01);
    k.tone(sine, 880 * p, t + 0.2, 0.5, 0.03 * v, out, 0.01);
  },
  /** cricket chirp: 3 quick pulses */
  cricket(k, t, out, p, v) {
    for (let i = 0; i < 3; i++) k.tone(sine, 4300 * p, t + i * 0.032, 0.022, 0.018 * v, out, 0.004);
  },
};

/** World-sound recipes that are not offered through play(). */
export const WORLD_ONLY = new Set(['chime', 'whistle', 'horn', 'horn2', 'xbell', 'doors', 'swish', 'bird', 'cricket', 'tbell', 'tding', 'tchime']);
