// Procedurally painted texture atlases.
import * as THREE from 'three';

export const ATLAS_CELLS = 8;
const CELL = 128;

/** Cell indices into the facade atlas. */
export const FC = {
  HOUSE: 0, WOOD: 1, BRICK: 2, TOWNHOUSE: 3, APART: 4, PANEL: 5, GLASS: 6, STONE: 7,
  HOUSE_DOOR: 8, WOOD_DOOR: 9, BRICK_DOOR: 10, TOWN_DOOR: 11, APART_DOOR: 12, SHOP: 13, LOBBY: 14, CHURCH: 15,
  TOWER: 16, SHOP2: 17, CHURCH_DOOR: 18, BRICK_PLAIN: 19, GARAGE: 20, STATION: 21, PLASTER_PLAIN: 22, CONCRETE_PLAIN: 23,
};

type Ctx = CanvasRenderingContext2D;

function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function noiseFill(c: Ctx, x: number, y: number, w: number, h: number, base: string, amt: number, seed: number) {
  c.fillStyle = base;
  c.fillRect(x, y, w, h);
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 6; i++) {
    const v = r();
    c.fillStyle = v > 0.5 ? `rgba(255,255,255,${amt * r()})` : `rgba(0,0,0,${amt * r()})`;
    c.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

function bricks(c: Ctx, x: number, y: number, w: number, h: number, col: string, seed: number) {
  noiseFill(c, x, y, w, h, col, 0.12, seed);
  c.strokeStyle = 'rgba(40,20,10,0.35)';
  c.lineWidth = 1;
  const bh = 8;
  for (let yy = 0; yy < h; yy += bh) {
    c.beginPath(); c.moveTo(x, y + yy + 0.5); c.lineTo(x + w, y + yy + 0.5); c.stroke();
    const off = (yy / bh) % 2 ? 10 : 0;
    for (let xx = off; xx < w; xx += 20) { c.beginPath(); c.moveTo(x + xx + 0.5, y + yy); c.lineTo(x + xx + 0.5, y + yy + bh); c.stroke(); }
  }
}

function siding(c: Ctx, x: number, y: number, w: number, h: number, col: string, seed: number) {
  noiseFill(c, x, y, w, h, col, 0.08, seed);
  for (let yy = 0; yy < h; yy += 7) {
    c.fillStyle = 'rgba(0,0,0,0.13)';
    c.fillRect(x, y + yy, w, 1.5);
  }
}

/** Window with frame; mask: draw onto emissive canvas too. */
function windowRect(c: Ctx, e: Ctx, x: number, y: number, w: number, h: number, opts: { frame?: string; glass?: [string, string]; mullion?: boolean; sill?: boolean; shutters?: string; arch?: boolean } = {}) {
  const frame = opts.frame ?? '#f2efe8';
  const [g1, g2] = opts.glass ?? ['#2d3e4f', '#7b98ae'];
  c.fillStyle = frame;
  c.fillRect(x - 3, y - 3, w + 6, h + 6);
  const grad = c.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, g2); grad.addColorStop(0.45, g1); grad.addColorStop(1, g1);
  c.fillStyle = grad;
  if (opts.arch) {
    c.beginPath();
    c.moveTo(x, y + h); c.lineTo(x, y + w / 2); c.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); c.lineTo(x + w, y + h); c.closePath(); c.fill();
  } else c.fillRect(x, y, w, h);
  // reflection streak
  c.fillStyle = 'rgba(255,255,255,0.12)';
  c.beginPath(); c.moveTo(x + w * 0.15, y + h); c.lineTo(x + w * 0.45, y); c.lineTo(x + w * 0.6, y); c.lineTo(x + w * 0.3, y + h); c.fill();
  if (opts.mullion) {
    c.fillStyle = frame;
    c.fillRect(x + w / 2 - 1.5, y, 3, h);
    c.fillRect(x, y + h * 0.4 - 1.5, w, 3);
  }
  if (opts.sill) { c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x - 5, y + h + 3, w + 10, 3); }
  if (opts.shutters) {
    c.fillStyle = opts.shutters;
    c.fillRect(x - 3 - w * 0.35, y - 3, w * 0.33, h + 6);
    c.fillRect(x + w + 5, y - 3, w * 0.33, h + 6);
    c.fillStyle = 'rgba(0,0,0,0.2)';
    for (let yy = y; yy < y + h; yy += 4) { c.fillRect(x - 3 - w * 0.35, yy, w * 0.33, 1); c.fillRect(x + w + 5, yy, w * 0.33, 1); }
  }
  // emissive mask (warm lit window)
  e.fillStyle = '#ffffff';
  if (opts.arch) {
    e.beginPath();
    e.moveTo(x, y + h); e.lineTo(x, y + w / 2); e.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); e.lineTo(x + w, y + h); e.closePath(); e.fill();
  } else e.fillRect(x, y, w, h);
  if (opts.mullion) { e.fillStyle = '#000'; e.fillRect(x + w / 2 - 1.5, y, 3, h); e.fillRect(x, y + h * 0.4 - 1.5, w, 3); }
}

function door(c: Ctx, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = '#e8e4da';
  c.fillRect(x - 3, y - 3, w + 6, h + 3);
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
  c.fillStyle = 'rgba(255,255,255,0.15)';
  c.fillRect(x + 3, y + 3, w - 6, h * 0.35);
  c.fillStyle = '#d4b04a';
  c.fillRect(x + w - 6, y + h * 0.55, 3, 3);
}

export interface Atlases { color: THREE.CanvasTexture; emissive: THREE.CanvasTexture }

/** True when a DOM (canvas) is available; headless (node) builds get placeholder textures. */
export const HAS_DOM = typeof document !== 'undefined';

/** 1x1 placeholder texture for headless runs. */
export function placeholderTexture(r = 200, g = 200, b = 200): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

export function createFacadeAtlas(): Atlases {
  if (!HAS_DOM) return { color: placeholderTexture() as unknown as THREE.CanvasTexture, emissive: placeholderTexture(0, 0, 0) as unknown as THREE.CanvasTexture };
  const size = CELL * ATLAS_CELLS;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ev = document.createElement('canvas'); ev.width = ev.height = size;
  const c = cv.getContext('2d')!, e = ev.getContext('2d')!;
  e.fillStyle = '#000'; e.fillRect(0, 0, size, size);
  const cellXY = (i: number) => [(i % ATLAS_CELLS) * CELL, Math.floor(i / ATLAS_CELLS) * CELL];
  const at = (i: number, fn: (x: number, y: number) => void) => { const [x, y] = cellXY(i); c.save(); e.save(); c.beginPath(); c.rect(x, y, CELL, CELL); c.clip(); e.beginPath(); e.rect(x, y, CELL, CELL); e.clip(); fn(x, y); c.restore(); e.restore(); };

  const plaster = '#f3eee4';
  // --- upper floors
  at(FC.HOUSE, (x, y) => { noiseFill(c, x, y, CELL, CELL, plaster, 0.1, 1); windowRect(c, e, x + 40, y + 34, 48, 58, { mullion: true, sill: true, shutters: '#5f7f5a' }); });
  at(FC.WOOD, (x, y) => { siding(c, x, y, CELL, CELL, '#f1ece2', 2); windowRect(c, e, x + 38, y + 32, 52, 60, { mullion: true, frame: '#ffffff' }); });
  at(FC.BRICK, (x, y) => { bricks(c, x, y, CELL, CELL, '#a95f45', 3); windowRect(c, e, x + 36, y + 28, 56, 66, { mullion: true, sill: true }); });
  at(FC.TOWNHOUSE, (x, y) => { noiseFill(c, x, y, CELL, CELL, '#e9e1d1', 0.1, 4); c.fillStyle = 'rgba(0,0,0,0.08)'; c.fillRect(x, y + CELL - 10, CELL, 4); windowRect(c, e, x + 40, y + 18, 48, 84, { mullion: true, sill: true }); });
  at(FC.APART, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#ece6dc', 0.07, 5);
    windowRect(c, e, x + 22, y + 22, 84, 70, { mullion: true, frame: '#d9d4cc' });
    c.fillStyle = '#9aa1a8'; c.fillRect(x + 16, y + 82, 96, 6);
    c.fillStyle = 'rgba(60,60,60,0.6)'; for (let i = 0; i < 12; i++) c.fillRect(x + 18 + i * 8, y + 70, 2, 14);
    c.fillStyle = '#7e858c'; c.fillRect(x + 16, y + 68, 96, 3);
  });
  at(FC.PANEL, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#d8d8d4', 0.06, 6);
    c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 2; c.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
    windowRect(c, e, x + 14, y + 30, 100, 56, { frame: '#bcbcb8', glass: ['#26323d', '#6e8aa0'] });
  });
  at(FC.GLASS, (x, y) => {
    const g = c.createLinearGradient(x, y, x + CELL, y + CELL);
    g.addColorStop(0, '#7fa6c2'); g.addColorStop(0.5, '#2e4b63'); g.addColorStop(1, '#1d3346');
    c.fillStyle = g; c.fillRect(x, y, CELL, CELL);
    c.fillStyle = '#8c949b'; c.fillRect(x, y, CELL, 8); c.fillRect(x, y, 5, CELL); c.fillRect(x + CELL - 5, y, 5, CELL); c.fillRect(x + 62, y, 4, CELL);
    e.fillStyle = '#5a5246'; e.fillRect(x + 6, y + 10, 54, CELL - 12); e.fillRect(x + 68, y + 10, 54, CELL - 12); e.fillStyle = '#d8d0c0'; e.fillRect(x + 6, y + 10, 54, 14); e.fillRect(x + 68, y + 10, 54, 14);
  });
  at(FC.STONE, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#cfc5b3', 0.12, 8);
    windowRect(c, e, x + 24, y + 24, 32, 76, { frame: '#b8ae9c', glass: ['#283746', '#6d8799'] });
    windowRect(c, e, x + 72, y + 24, 32, 76, { frame: '#b8ae9c', glass: ['#283746', '#6d8799'] });
  });
  // --- ground floors
  at(FC.HOUSE_DOOR, (x, y) => { noiseFill(c, x, y, CELL, CELL, plaster, 0.1, 9); door(c, x + 44, y + 40, 40, 88, '#6b3f2a'); c.fillStyle = 'rgba(0,0,0,0.15)'; c.fillRect(x, y + CELL - 8, CELL, 8); });
  at(FC.WOOD_DOOR, (x, y) => { siding(c, x, y, CELL, CELL, '#f1ece2', 10); door(c, x + 44, y + 40, 40, 88, '#2f5d7c'); });
  at(FC.BRICK_DOOR, (x, y) => { bricks(c, x, y, CELL, CELL, '#a95f45', 11); door(c, x + 44, y + 36, 40, 92, '#2d4a3a'); });
  at(FC.TOWN_DOOR, (x, y) => { noiseFill(c, x, y, CELL, CELL, '#ddd3c0', 0.1, 12); door(c, x + 40, y + 30, 48, 98, '#1f2f45'); });
  at(FC.APART_DOOR, (x, y) => { noiseFill(c, x, y, CELL, CELL, '#cfc8bc', 0.08, 13); windowRect(c, e, x + 20, y + 26, 88, 102, { frame: '#6b6f73', glass: ['#2a3540', '#8aa0b0'], mullion: true }); });
  at(FC.SHOP, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#e2d9c9', 0.08, 14);
    windowRect(c, e, x + 10, y + 34, 108, 86, { frame: '#3b3b3b', glass: ['#3a4752', '#b9c9d3'] });
    c.fillStyle = 'rgba(255,240,200,0.25)'; c.fillRect(x + 14, y + 90, 100, 26);
  });
  at(FC.LOBBY, (x, y) => {
    c.fillStyle = '#4a545c'; c.fillRect(x, y, CELL, CELL);
    windowRect(c, e, x + 6, y + 14, 116, 114, { frame: '#9aa3aa', glass: ['#2b3c4c', '#9ab3c5'], mullion: true });
  });
  at(FC.CHURCH, (x, y) => { noiseFill(c, x, y, CELL, CELL, '#c9bfa8', 0.15, 15); windowRect(c, e, x + 44, y + 20, 40, 92, { arch: true, frame: '#a99f88', glass: ['#3b2e52', '#a26f5d'] }); });
  at(FC.TOWER, (x, y) => {
    const g = c.createLinearGradient(x, y, x, y + CELL);
    g.addColorStop(0, '#5e8b8f'); g.addColorStop(1, '#1f3c42');
    c.fillStyle = g; c.fillRect(x, y, CELL, CELL);
    c.fillStyle = '#d6dde0'; c.fillRect(x, y + CELL - 10, CELL, 10); c.fillRect(x, y, 4, CELL); c.fillRect(x + 124, y, 4, CELL);
    e.fillStyle = '#5a5246'; e.fillRect(x + 6, y + 4, 116, CELL - 16); e.fillStyle = '#d8d0c0'; e.fillRect(x + 6, y + 4, 116, 16);
  });
  at(FC.SHOP2, (x, y) => {
    bricks(c, x, y, CELL, CELL, '#8f5640', 17);
    windowRect(c, e, x + 12, y + 30, 70, 90, { frame: '#1e3b2c', glass: ['#334048', '#c3d1d9'] });
    door(c, x + 90, y + 40, 30, 88, '#1e3b2c');
  });
  at(FC.CHURCH_DOOR, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#c9bfa8', 0.15, 18);
    c.fillStyle = '#5b3a24';
    c.beginPath(); c.moveTo(x + 40, y + CELL); c.lineTo(x + 40, y + 60); c.arc(x + 64, y + 60, 24, Math.PI, 0); c.lineTo(x + 88, y + CELL); c.fill();
  });
  at(FC.BRICK_PLAIN, (x, y) => bricks(c, x, y, CELL, CELL, '#9a5a42', 19));
  at(FC.GARAGE, (x, y) => {
    bricks(c, x, y, CELL, CELL, '#9a5a42', 20);
    c.fillStyle = '#6b7178'; c.fillRect(x + 12, y + 20, 104, 108);
    c.fillStyle = 'rgba(0,0,0,0.25)'; for (let yy = 24; yy < 128; yy += 8) c.fillRect(x + 12, y + yy, 104, 2);
  });
  at(FC.STATION, (x, y) => {
    noiseFill(c, x, y, CELL, CELL, '#e6dccb', 0.1, 21);
    windowRect(c, e, x + 30, y + 16, 68, 100, { arch: true, mullion: true, frame: '#8a3324' });
  });
  at(FC.PLASTER_PLAIN, (x, y) => noiseFill(c, x, y, CELL, CELL, plaster, 0.1, 22));
  at(FC.CONCRETE_PLAIN, (x, y) => noiseFill(c, x, y, CELL, CELL, '#bdbab3', 0.12, 23));

  const color = new THREE.CanvasTexture(cv);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 8;
  color.generateMipmaps = true;
  color.minFilter = THREE.LinearMipmapLinearFilter;
  const emissive = new THREE.CanvasTexture(ev);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.generateMipmaps = true;
  emissive.minFilter = THREE.LinearMipmapLinearFilter;
  return { color, emissive };
}

/** Soft round sprite for particles. */
export function createSmokeTexture(): THREE.CanvasTexture {
  if (!HAS_DOM) return placeholderTexture(255, 255, 255) as unknown as THREE.CanvasTexture;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft glow sprite for lamps and headlights. */
export function createGlowTexture(): THREE.CanvasTexture {
  if (!HAS_DOM) return placeholderTexture(255, 255, 255) as unknown as THREE.CanvasTexture;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,240,210,0.9)');
  g.addColorStop(0.4, 'rgba(255,200,140,0.25)');
  g.addColorStop(1, 'rgba(255,180,120,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function finishStrip(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** World length (units) covered by one texture repeat along strip textures (ballast, roads). */
export const STRIP_PERIOD = 0.96;
/** Sleepers per texture repeat. */
export const SLEEPERS_PER_PERIOD = 16;

/**
 * Ballast bed top with sleepers. u: [0, 0.5] wooden sleepers, [0.5, 1] concrete sleepers; each half spans
 * the bed top across (left edge to right edge). v: one repeat = STRIP_PERIOD units along the track.
 */
export function createBallastTexture(): THREE.Texture {
  if (!HAS_DOM) return placeholderTexture(120, 110, 98);
  const W = 256, H = 1024;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const r = rng(77);
  for (let half = 0; half < 2; half++) {
    const x0 = half * 128;
    noiseFill(c, x0, 0, 128, H, '#7a746a', 0.28, 41 + half);
    // individual stones
    for (let i = 0; i < 2600; i++) {
      const v = 70 + Math.floor(r() * 90);
      c.fillStyle = `rgb(${v + 8},${v + 4},${v - 4})`;
      c.fillRect(x0 + r() * 128, r() * H, 1.5 + r() * 2.5, 1.5 + r() * 2.5);
    }
    const per = H / SLEEPERS_PER_PERIOD;
    for (let k = 0; k < SLEEPERS_PER_PERIOD; k++) {
      const y = k * per + per * 0.3;
      const sh = per * 0.42;
      const sx = x0 + 128 * 0.11, sw = 128 * 0.78;
      // shadow under the sleeper edges
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(sx - 1, y - 2, sw + 2, sh + 5);
      if (half === 0) {
        const g = 60 + Math.floor(r() * 22);
        c.fillStyle = `rgb(${g + 26},${g + 10},${g - 6})`;
        c.fillRect(sx, y, sw, sh);
        c.fillStyle = 'rgba(0,0,0,0.18)';
        for (let j = 0; j < 3; j++) c.fillRect(sx, y + 3 + j * (sh / 3), sw, 1);
      } else {
        c.fillStyle = '#a7a39b';
        c.fillRect(sx, y, sw, sh);
        c.fillStyle = 'rgba(255,255,255,0.12)';
        c.fillRect(sx, y, sw, 3);
        c.fillStyle = '#8f8b84';
        c.fillRect(sx + sw * 0.42, y + 2, sw * 0.16, sh - 4);
      }
      // rail fastenings under both rails
      c.fillStyle = '#2b2b2b';
      for (const u of [0.267, 0.733]) c.fillRect(x0 + 128 * u - 7, y + 2, 14, sh - 4);
    }
  }
  return finishStrip(cv);
}

/**
 * Road surfaces. u: [0, 0.5] country road (solid edge lines, dashed centre), [0.5, 1] town street
 * (dashed centre, gutters); each half spans the carriageway across. v: one repeat = STRIP_PERIOD units.
 */
export function createRoadTexture(): THREE.Texture {
  if (!HAS_DOM) return placeholderTexture(84, 86, 90);
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const r = rng(91);
  for (let half = 0; half < 2; half++) {
    const x0 = half * 256;
    noiseFill(c, x0, 0, 256, H, half === 0 ? '#57595d' : '#505256', 0.16, 51 + half);
    for (let i = 0; i < 900; i++) {
      const v = 60 + Math.floor(r() * 50);
      c.fillStyle = `rgba(${v},${v},${v + 3},0.55)`;
      c.fillRect(x0 + r() * 256, r() * H, 1 + r() * 2, 1 + r() * 2);
    }
    // worn wheel tracks
    c.fillStyle = 'rgba(0,0,0,0.07)';
    for (const u of [0.18, 0.34, 0.66, 0.82]) c.fillRect(x0 + 256 * u - 9, 0, 18, H);
    c.fillStyle = '#ecebe4';
    if (half === 0) {
      c.fillRect(x0 + 9, 0, 4, H);
      c.fillRect(x0 + 256 - 13, 0, 4, H);
      c.fillRect(x0 + 126, 0, 4, H / 3);
    } else {
      c.fillRect(x0 + 126, 0, 4, H / 4);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(x0, 0, 7, H);
      c.fillRect(x0 + 249, 0, 7, H);
    }
  }
  return finishStrip(cv);
}
