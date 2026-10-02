// Procedural sound engine (WebAudio, no audio files). Contract stub — implemented by the audio work.
import type * as THREE from 'three';
import type { Game } from '../game/game';

export type Sfx =
  | 'click' | 'hover' | 'open' | 'close' | 'toggle' | 'tool'
  | 'build-rail' | 'build-road' | 'build' | 'demolish' | 'error' | 'cash' | 'purchase'
  | 'station' | 'depot' | 'signal' | 'notify' | 'news-good' | 'news-bad' | 'speed' | 'pause';

export interface AudioSettings { master: number; ui: number; world: number; ambient: number; muted: boolean }

export interface PlayOpts { x?: number; z?: number; volume?: number; pitch?: number }

export class AudioEngine {
  settings: AudioSettings = { master: 0.8, ui: 0.7, world: 0.8, ambient: 0.6, muted: false };
  /** Call on the first user gesture (browsers keep audio suspended until then). */
  unlock() {}
  setGame(game: Game) { void game; }
  /** Per frame: listener follows the camera; world sounds and ambience. */
  update(dt: number, camera: THREE.PerspectiveCamera, focus: THREE.Vector3, camDist: number) { void dt; void camera; void focus; void camDist; }
  play(name: Sfx, opts: PlayOpts = {}) { void name; void opts; }
  loadSettings() {}
  saveSettings() {}
}

export const audio = new AudioEngine();
