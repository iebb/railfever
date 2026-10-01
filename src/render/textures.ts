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

/** World length (units) covered by one repeat of the road strip cells. */
export const STRIP_PERIOD = 0.96;

// ------------------------------------------------------------------------------ world atlas
// One procedurally generated atlas (pure JS, so it also works headless) for all static world surfaces.
// Cells are 4x4; each holds a tileable 256 px pattern with a wrapped 16 px gutter. Most patterns are
// neutral in tone so vertex colours give the albedo; asphalt/ballast cells carry their own colours.

/** World atlas cell indices (index = row * 4 + col). */
export const WC = {
  PLAIN: 0, BALLAST_WOOD: 1, BALLAST_CONC: 2, GRAVEL: 3,
  ROAD_COUNTRY: 4, ROAD_STREET: 5, ASPHALT: 6, PAVING: 7,
  PLATFORM: 8, CONCRETE: 9, STONE: 10, ROOF_TILES: 11,
  ROOF_SLATE: 12, ROOF_FLAT: 13, METAL: 14, LAMP: 15,
};
/** World units per texture repeat for the 2D cells (strip cells are mapped explicitly). */
export const WSCALE = {
  GRAVEL: 0.5, ASPHALT: 1.2, PAVING: 0.4, PLATFORM: 1.0, CONCRETE: 1.0, STONE: 0.5,
  ROOF_TILES: 0.36, ROOF_SLATE: 0.3, ROOF_FLAT: 1.0, PLAIN: 1.0,
};
/** Ballast cell: sleepers per repeat (one repeat = BALLAST_PERIOD units along the track). */
export const BALLAST_PERIOD = 0.24;
export const ATLAS = { cols: 4, content: 256, gutter: 16 };
export const ATLAS_SIZE = ATLAS.cols * (ATLAS.content + 2 * ATLAS.gutter);
/** Per-cell roughness / metalness used by the world material. */
export const CELL_ROUGH = [0.9, 0.97, 0.95, 0.96, 0.9, 0.9, 0.9, 0.86, 0.85, 0.88, 0.9, 0.72, 0.62, 0.92, 0.42, 0.5];
export const CELL_METAL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0, 0.72, 0];

function h2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Tileable value noise; x,y in lattice units, lattice wraps at period p. */
function vn(x: number, y: number, p: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % p) + p) % p, y0 = ((iy % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = h2(x0, y0, seed), b = h2(x1, y0, seed), c = h2(x0, y1, seed), d = h2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tileable fBm in [0,1]; (s,t) in [0,1) over the cell, base period p. */
function fb(s: number, t: number, p: number, seed: number, oct = 3): number {
  let sum = 0, amp = 0.5, norm = 0, per = p;
  for (let o = 0; o < oct; o++) { sum += amp * vn(s * per, t * per, per, seed + o * 31); norm += amp; amp *= 0.5; per *= 2; }
  return sum / norm;
}
/** Tileable Worley noise: returns [F1, F2-F1, cell id] for points jittered in a g x g grid. */
function worley(s: number, t: number, g: number, seed: number, out: number[]) {
  const x = s * g, y = t * g;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy;
    const wx = ((cx % g) + g) % g, wy = ((cy % g) + g) % g;
    const px = cx + h2(wx, wy, seed), py = cy + h2(wx, wy, seed + 7);
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = wy * g + wx; } else if (d < f2) f2 = d;
  }
  out[0] = f1; out[1] = f2 - f1; out[2] = id;
}

type Painter = (s: number, t: number, o: number[]) => void;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const W3 = [0, 0, 0];

function stones(s: number, t: number, g: number, seed: number, o: number[], base: [number, number, number], vary: number) {
  worley(s, t, g, seed, W3);
  const id = W3[2];
  const k = 0.78 + vary * (h2(id, 3, seed) - 0.5) * 2 + 0.12 * (1 - Math.min(1, W3[0] * 1.6));
  const edge = smooth(0.0, 0.12, W3[1]);
  const shade = k * (0.68 + 0.32 * edge);
  const tint = h2(id, 9, seed);
  o[0] = base[0] * shade * (0.95 + tint * 0.1); o[1] = base[1] * shade; o[2] = base[2] * shade * (1.05 - tint * 0.1);
}

function asphalt(s: number, t: number, o: number[], tone: number, seed: number) {
  const n = fb(s, t, 8, seed, 3);
  const sp = h2(Math.floor(s * 256), Math.floor(t * 256), seed + 5);
  let v = tone * (0.88 + 0.22 * n);
  if (sp > 0.93) v *= 1.25; else if (sp < 0.05) v *= 0.8;
  o[0] = v; o[1] = v * 1.01; o[2] = v * 1.04;
}

/** Ballast bed top: stones, 4 sleepers per repeat, rails painted in so the track reads at distance. */
function ballast(concrete: boolean): Painter {
  return (s, t, o) => {
    stones(s, t, 44, concrete ? 61 : 62, o, [0.56, 0.53, 0.49], 0.13);
    const tt = (t * 4) % 1;
    const inSleeper = s > 0.11 && s < 0.89 && tt > 0.28 && tt < 0.7;
    if (inSleeper) {
      const n = fb(s, t, 16, 70, 2);
      if (concrete) { const v = 0.66 + 0.08 * n - (Math.abs(s - 0.5) < 0.08 ? 0.05 : 0); o[0] = v; o[1] = v * 0.99; o[2] = v * 0.96; }
      else { const v = 0.3 + 0.1 * n + 0.04 * Math.sin(t * 80); o[0] = v * 1.3; o[1] = v * 1.02; o[2] = v * 0.78; }
      if (Math.abs(tt - 0.28) < 0.02 || Math.abs(tt - 0.7) < 0.02) { o[0] *= 0.7; o[1] *= 0.7; o[2] *= 0.7; }
    } else if (s > 0.1 && s < 0.9 && (Math.abs(tt - 0.25) < 0.04 || Math.abs(tt - 0.73) < 0.04)) { o[0] *= 0.62; o[1] *= 0.62; o[2] *= 0.62; }
    // rails: dark web/foot, bright polished head
    for (const c of [0.267, 0.733]) {
      const d = Math.abs(s - c);
      if (d < 0.03) {
        if (inSleeper && d < 0.03 && d > 0.018) { o[0] = 0.14; o[1] = 0.14; o[2] = 0.15; }
        if (d <= 0.018) { const v = d < 0.009 ? 0.78 : 0.3; o[0] = v; o[1] = v * 0.97; o[2] = v * 0.93; }
      }
    }
  };
}

function roadStrip(country: boolean): Painter {
  return (s, t, o) => {
    asphalt(s, t, o, country ? 0.36 : 0.33, country ? 81 : 82);
    // worn wheel tracks
    for (const c of [0.2, 0.33, 0.67, 0.8]) if (Math.abs(s - c) < 0.05) { const k = 1 - 0.08 * (1 - Math.abs(s - c) / 0.05); o[0] *= k; o[1] *= k; o[2] *= k; }
    let paint = false;
    if (country) {
      if ((s > 0.035 && s < 0.057) || (s > 0.943 && s < 0.965)) paint = true;
      if (Math.abs(s - 0.5) < 0.011 && t < 0.34) paint = true;
    } else {
      if (Math.abs(s - 0.5) < 0.01 && t < 0.25) paint = true;
      if (s < 0.03 || s > 0.97) { o[0] *= 0.72; o[1] *= 0.72; o[2] *= 0.72; }
    }
    if (paint) { const v = 0.82 + 0.08 * fb(s, t, 32, 90, 2); o[0] = v; o[1] = v; o[2] = v * 0.97; }
  };
}

function slabs(s: number, t: number, nx: number, ny: number, seed: number, o: number[], joint = 0.03, stagger = false) {
  const row = Math.floor(t * ny);
  const ss = stagger && row % 2 ? s + 0.5 / nx : s;
  const ix = Math.floor(ss * nx), fx = ss * nx - ix, fy = t * ny - row;
  const k = 0.85 + 0.14 * (h2(((ix % nx) + nx) % nx, row, seed) - 0.5) * 2;
  let v = k * (0.9 + 0.12 * fb(s, t, 16, seed + 3, 2));
  if (fx < joint || fx > 1 - joint || fy < joint || fy > 1 - joint) v *= 0.68;
  o[0] = v; o[1] = v; o[2] = v;
}

const PAINTERS: Painter[] = [
  (_s, _t, o) => { o[0] = 1; o[1] = 1; o[2] = 1; },
  ballast(false),
  ballast(true),
  (s, t, o) => stones(s, t, 52, 63, o, [0.62, 0.58, 0.53], 0.16),
  roadStrip(true),
  roadStrip(false),
  (s, t, o) => asphalt(s, t, o, 0.35, 83),
  (s, t, o) => slabs(s, t, 6, 6, 84, o, 0.03),
  (s, t, o) => { slabs(s, t, 4, 4, 85, o, 0.012); const sp = h2(Math.floor(s * 256), Math.floor(t * 256), 86); if (sp > 0.96) { o[0] *= 0.85; o[1] *= 0.85; o[2] *= 0.85; } },
  // concrete: noise, formwork joints, tie holes, rain streaks
  (s, t, o) => {
    let v = 0.86 + 0.1 * (fb(s, t, 6, 87, 3) - 0.5) - 0.05 * fb(s * 0.25, t, 24, 88, 1);
    const fx = (s * 2) % 1, fy = (t * 4) % 1;
    if (fx < 0.008 || fy < 0.012) v *= 0.82;
    const hx = (s * 8) % 1, hy = (t * 8) % 1;
    if (Math.hypot(hx - 0.5, hy - 0.5) < 0.05 && Math.floor(t * 8) % 2 === 0) v *= 0.7;
    o[0] = v; o[1] = v; o[2] = v * 0.98;
  },
  // stone masonry: 8 courses, 4 blocks each, random offsets
  (s, t, o) => {
    const row = Math.floor(t * 8), fy = t * 8 - row;
    const off = h2(row, 1, 89) * 0.25;
    const ss = (s + off) % 1;
    const bi = Math.floor(ss * 4), fx = ss * 4 - bi;
    const k = 0.84 + 0.18 * (h2(bi, row, 90) - 0.5) + 0.12 * (fb(s, t, 12, 91, 2) - 0.5);
    let v = k;
    const j = 0.045;
    if (fy < j || fy > 1 - j || fx < j * 0.5 || fx > 1 - j * 0.5) v = 0.62;
    else v *= 0.92 + 0.08 * Math.min(1, Math.min(fy, 1 - fy, fx * 2, (1 - fx) * 2) * 8);
    o[0] = v * 1.02; o[1] = v; o[2] = v * 0.95;
  },
  // roof tiles: 12 courses (v up the slope), 16 tiles across, overlap shadow at the course bottom
  (s, t, o) => {
    const row = Math.floor(t * 12), fy = t * 12 - row;
    const ss = (s + (row % 2) * 0.5 / 16) % 1;
    const ti = Math.floor(ss * 16), fx = ss * 16 - ti;
    let v = 0.82 + 0.14 * (h2(ti, row, 92) - 0.5) * 2;
    v *= 0.62 + 0.38 * smooth(0, 0.14, fy) - 0.1 * fy;
    v *= 0.88 + 0.12 * Math.sin(fx * Math.PI);
    if (fx < 0.05) v *= 0.8;
    o[0] = v; o[1] = v; o[2] = v;
  },
  // slate: 16 courses, 10 slates across, staggered
  (s, t, o) => {
    const row = Math.floor(t * 16), fy = t * 16 - row;
    const ss = (s + (row % 2) * 0.05) % 1;
    const ti = Math.floor(ss * 10), fx = ss * 10 - ti;
    let v = 0.78 + 0.16 * (h2(ti, row, 93) - 0.5) * 2;
    v *= 0.7 + 0.3 * smooth(0, 0.1, fy);
    if (fx < 0.04) v *= 0.75;
    v *= 0.94 + 0.08 * fb(s, t, 16, 94, 2);
    o[0] = v; o[1] = v; o[2] = v;
  },
  // flat roof: gravel + bitumen seams
  (s, t, o) => {
    let v = 0.72 + 0.16 * (fb(s, t, 24, 95, 2) - 0.5) + (h2(Math.floor(s * 256), Math.floor(t * 256), 96) - 0.5) * 0.12;
    if ((s * 3) % 1 < 0.01 || (t * 2) % 1 < 0.008) v *= 0.7;
    o[0] = v; o[1] = v; o[2] = v;
  },
  (s, t, o) => { const v = 0.92 + 0.06 * fb(s, t, 4, 97, 2); o[0] = v; o[1] = v; o[2] = v; },
  (_s, _t, o) => { o[0] = 1; o[1] = 1; o[2] = 1; },
];

let worldAtlasData: { data: Uint8Array; size: number } | null = null;

/** Pixel data of the world atlas (RGBA, sRGB, row 0 = v 0). Cached. */
export function worldAtlasPixels(): { data: Uint8Array; size: number } {
  if (worldAtlasData) return worldAtlasData;
  const { cols, content: C, gutter: G } = ATLAS;
  const S = C + 2 * G, size = cols * S;
  const data = new Uint8Array(size * size * 4);
  const tile = new Float32Array(C * C * 3);
  const o = [0, 0, 0];
  const lut = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) lut[i] = Math.round(clamp01(i / 4096) * 255);
  for (let ci = 0; ci < PAINTERS.length; ci++) {
    const paint = PAINTERS[ci];
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      paint((x + 0.5) / C, (y + 0.5) / C, o);
      const k = (y * C + x) * 3;
      tile[k] = o[0]; tile[k + 1] = o[1]; tile[k + 2] = o[2];
    }
    const ox = (ci % cols) * S, oy = Math.floor(ci / cols) * S;
    for (let y = -G; y < C + G; y++) {
      const sy = ((y % C) + C) % C;
      for (let x = -G; x < C + G; x++) {
        const sx = ((x % C) + C) % C;
        const k = (sy * C + sx) * 3;
        const d = ((oy + G + y) * size + ox + G + x) * 4;
        data[d] = lut[Math.round(clamp01(tile[k]) * 4096)];
        data[d + 1] = lut[Math.round(clamp01(tile[k + 1]) * 4096)];
        data[d + 2] = lut[Math.round(clamp01(tile[k + 2]) * 4096)];
        data[d + 3] = 255;
      }
    }
  }
  worldAtlasData = { data, size };
  return worldAtlasData;
}

/** The world atlas as a mip-mapped sRGB texture. */
export function createWorldAtlas(): THREE.DataTexture {
  const { data, size } = worldAtlasPixels();
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.flipY = false;
  t.userData = { cells: ATLAS.cols, pad: ATLAS.gutter / (ATLAS.content + 2 * ATLAS.gutter), content: ATLAS.content };
  t.needsUpdate = true;
  return t;
}
