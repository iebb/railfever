// Procedural terrain detail textures, generated once in code (no image files): a layered array of tileable
// albedo + height maps (grass, dirt, scree, rock, sand) with matching normal / cavity / roughness maps, and a
// tileable macro-variation texture (large-scale colour change sampled per pixel, so LOD cells never show).
// Generation is allocation-free typed-array code (it runs once at start-up, and in node for previews).
import * as THREE from 'three';

export const DETAIL_LAYERS = 5;
export const L_GRASS = 0, L_DIRT = 1, L_SCREE = 2, L_ROCK = 3, L_SAND = 4;

type F = Float32Array;
type RGB = readonly [number, number, number];

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Add amp * tileable value noise (cx x cy lattice cells over the tile, quintic interpolation). */
function octave(out: F, N: number, cx: number, cy: number, seed: number, amp: number, ridged: boolean) {
  const r = mulberry(seed), lat = new Float32Array(cx * cy);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const ax0 = new Int32Array(N), ax1 = new Int32Array(N), fx = new Float32Array(N);
  const ay0 = new Int32Array(N), ay1 = new Int32Array(N), fy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = (i / N) * cx, iu = Math.floor(u), f = u - iu;
    ax0[i] = iu % cx; ax1[i] = (iu + 1) % cx; fx[i] = f * f * f * (f * (f * 6 - 15) + 10);
    const v = (i / N) * cy, iv = Math.floor(v), g = v - iv;
    ay0[i] = (iv % cy) * cx; ay1[i] = ((iv + 1) % cy) * cx; fy[i] = g * g * g * (g * (g * 6 - 15) + 10);
  }
  for (let y = 0; y < N; y++) {
    const r0 = ay0[y], r1 = ay1[y], wy = fy[y], row = y * N;
    for (let x = 0; x < N; x++) {
      const a = lat[r0 + ax0[x]], b = lat[r0 + ax1[x]], c = lat[r1 + ax0[x]], d = lat[r1 + ax1[x]], w = fx[x];
      const t = a + (b - a) * w, s = c + (d - c) * w;
      let v = t + (s - t) * wy;
      if (ridged) v = 1 - Math.abs(2 * v - 1);
      out[row + x] += v * amp;
    }
  }
}

/** Remap so the 2nd..98th percentiles span 0..1 (clamped): value noise sums cluster around the mean. */
function stretch(f: F): F {
  const s = new Float32Array(1024);
  for (let i = 0; i < s.length; i++) s[i] = f[(i * 7919) % f.length];
  s.sort();
  const a = s[20], b = s[1003], k = 1 / Math.max(1e-6, b - a);
  for (let i = 0; i < f.length; i++) { const v = (f[i] - a) * k; f[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return f;
}

/** Fractal value noise: `cells` lattice at the base octave (doubling per octave); aniso scales the x cells. */
function fbm(N: number, cells: number, octaves: number, seed: number, gain = 0.5, aniso = 1, ridged = false): F {
  const out = new Float32Array(N * N);
  let amp = 1, c = cells;
  for (let o = 0; o < octaves && c <= N; o++) {
    octave(out, N, Math.max(1, Math.round(c * aniso)), c, seed + o * 1013, amp, ridged);
    amp *= gain; c *= 2;
  }
  return stretch(out);
}

interface Cells { f1: F; f2: F; id: F }
/** Tileable Worley noise: distances (in cell units) to the nearest / second feature point, nearest cell's id. */
function voronoi(N: number, cells: number, seed: number, jitter = 0.85): Cells {
  const r = mulberry(seed), n = cells * cells;
  const px = new Float32Array(n), py = new Float32Array(n), rid = new Float32Array(n);
  for (let i = 0; i < n; i++) { px[i] = 0.5 + (r() - 0.5) * jitter; py[i] = 0.5 + (r() - 0.5) * jitter; rid[i] = r(); }
  const f1 = new Float32Array(N * N), f2 = new Float32Array(N * N), id = new Float32Array(N * N);
  const wrap = new Int32Array(cells + 2);
  for (let i = -1; i <= cells; i++) wrap[i + 1] = (i + cells) % cells;
  for (let y = 0; y < N; y++) {
    const v = ((y + 0.5) / N) * cells, cy = Math.floor(v), fy = v - cy;
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * cells, cx = Math.floor(u), fx = u - cx;
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let j = -1; j <= 1; j++) {
        const row = wrap[cy + j + 1] * cells;
        for (let i = -1; i <= 1; i++) {
          const k = row + wrap[cx + i + 1];
          const ox = i + px[k] - fx, oy = j + py[k] - fy, d = ox * ox + oy * oy;
          if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
        }
      }
      const o = y * N + x;
      f1[o] = Math.sqrt(d1); f2[o] = Math.sqrt(d2); id[o] = rid[best];
    }
  }
  return { f1, f2, id };
}

/** Box blur with wrap-around (separable, radius r texels). */
function blur(f: F, N: number, r: number): F {
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N), k = 1 / (2 * r + 1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += f[y * N + ((x + i + N) % N)];
    tmp[y * N + x] = s * k;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[((y + i + N) % N) * N + x];
    out[y * N + x] = s * k;
  }
  return out;
}

const sm = (a: number, b: number, x: number) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Scratch colour (no per-texel allocations). */
const C = new Float64Array(3);
const setMix = (a: RGB, b: RGB, t: number) => { C[0] = a[0] + (b[0] - a[0]) * t; C[1] = a[1] + (b[1] - a[1]) * t; C[2] = a[2] + (b[2] - a[2]) * t; };
const towards = (b: RGB, t: number) => { C[0] += (b[0] - C[0]) * t; C[1] += (b[1] - C[1]) * t; C[2] += (b[2] - C[2]) * t; };
const towardsK = (k0: number, k1: number, k2: number, t: number) => { C[0] += (C[0] * k0 - C[0]) * t; C[1] += (C[1] * k1 - C[1]) * t; C[2] += (C[2] * k2 - C[2]) * t; };
const put = (rgb: F, i: number, k: number) => { rgb[i * 3] = C[0] * k; rgb[i * 3 + 1] = C[1] * k; rgb[i * 3 + 2] = C[2] * k; };

interface Layer { rgb: F; height: F; normalK: number; rough: F }

function grass(N: number, seed: number): Layer {
  // isotropic: variation lives in clumps (~2 m) and patches (~4-5 m), fine grain is weak (no directional strokes)
  const patches = fbm(N, 3, 4, seed + 1, 0.5);
  const clumps = fbm(N, 6, 4, seed + 2, 0.55);
  const fine = fbm(N, 40, 3, seed + 3, 0.5);
  const straw = fbm(N, 12, 3, seed + 5, 0.55);
  const gaps = fbm(N, 20, 3, seed + 6, 0.5);
  const tone = fbm(N, 2, 3, seed + 7, 0.5);
  const rgb = new Float32Array(N * N * 3), height = new Float32Array(N * N), rough = new Float32Array(N * N);
  const dark: RGB = [0.24, 0.345, 0.11], mid: RGB = [0.325, 0.45, 0.145], light: RGB = [0.415, 0.535, 0.185], dry: RGB = [0.55, 0.54, 0.29], soil: RGB = [0.3, 0.27, 0.17];
  for (let i = 0; i < N * N; i++) {
    const t = 0.5 + 0.62 * ((patches[i] - 0.5) * 0.22 + (clumps[i] - 0.5) * 0.48 + (fine[i] - 0.5) * 0.17);
    if (t < 0.5) setMix(dark, mid, sm(0, 0.5, t)); else setMix(mid, light, sm(0.5, 1, t));
    towards(dry, sm(0.62, 0.9, straw[i] * 0.75 + patches[i] * 0.25) * 0.28);
    const gap = sm(0.24, 0.08, gaps[i] * 0.5 + clumps[i] * 0.5);
    towards(soil, gap * 0.22);
    put(rgb, i, 0.95 + 0.1 * tone[i]);
    height[i] = 0.48 * clumps[i] + 0.16 * patches[i] + 0.16 * fine[i] - 0.2 * gap;
    rough[i] = 0.9 + 0.05 * fine[i];
  }
  return { rgb, height: stretch(height), normalK: 1.3, rough };
}

function dirt(N: number, seed: number): Layer {
  const base = fbm(N, 5, 5, seed + 1, 0.55);
  const clods = fbm(N, 14, 4, seed + 2, 0.6);
  const cracks = fbm(N, 7, 4, seed + 3, 0.55, 1, true);
  const peb = voronoi(N, 46, seed + 4, 0.95);
  const grain = fbm(N, 64, 2, seed + 5, 0.5);
  const moist = fbm(N, 3, 3, seed + 6, 0.5);
  const rgb = new Float32Array(N * N * 3), height = new Float32Array(N * N), rough = new Float32Array(N * N);
  const darkS: RGB = [0.25, 0.19, 0.13], lightS: RGB = [0.49, 0.40, 0.28], pA: RGB = [0.47, 0.42, 0.35], pB: RGB = [0.58, 0.54, 0.47];
  for (let i = 0; i < N * N; i++) {
    const crack = sm(0.9, 0.97, cracks[i]) * 0.7;
    const r = 0.18 + 0.22 * peb.id[i], pd = peb.f1[i] / r;
    const isPeb = peb.id[i] < 0.3 && pd < 1 ? Math.sqrt(1 - pd * pd) : 0;
    setMix(darkS, lightS, clamp01(0.2 + 0.45 * base[i] + 0.3 * clods[i] - 0.2 * moist[i] + 0.15 * (grain[i] - 0.5)));
    towardsK(0.6, 0.57, 0.55, crack);
    if (isPeb > 0) {
      const k = 0.75 + 0.25 * isPeb, t = peb.id[i] / 0.3, w = sm(0.0, 0.25, isPeb);
      C[0] += ((pA[0] + (pB[0] - pA[0]) * t) * k - C[0]) * w;
      C[1] += ((pA[1] + (pB[1] - pA[1]) * t) * k - C[1]) * w;
      C[2] += ((pA[2] + (pB[2] - pA[2]) * t) * k - C[2]) * w;
    }
    put(rgb, i, 1);
    height[i] = 0.3 * base[i] + 0.45 * clods[i] - 0.4 * crack + 0.4 * isPeb + 0.1 * grain[i];
    rough[i] = 0.94 - 0.1 * sm(0.0, 0.3, isPeb);
  }
  return { rgb, height: stretch(height), normalK: 3.0, rough };
}

function scree(N: number, seed: number): Layer {
  // rounded stones of three sizes over fine gravel; the highest dome at a texel wins (stones overlap)
  const sets = [voronoi(N, 7, seed + 1, 0.9), voronoi(N, 17, seed + 2, 0.9), voronoi(N, 42, seed + 3, 0.95)];
  const H = [1.0, 0.62, 0.34], R = [0.42, 0.44, 0.48];
  const fine = fbm(N, 64, 3, seed + 4, 0.55);
  const tone = fbm(N, 4, 3, seed + 5, 0.5);
  const rgb = new Float32Array(N * N * 3), height = new Float32Array(N * N), rough = new Float32Array(N * N);
  const pal: RGB[] = [[0.40, 0.38, 0.35], [0.55, 0.52, 0.47], [0.50, 0.44, 0.36], [0.64, 0.61, 0.55], [0.45, 0.42, 0.39], [0.58, 0.52, 0.44]];
  const gA: RGB = [0.30, 0.28, 0.25], gB: RGB = [0.46, 0.43, 0.38];
  for (let i = 0; i < N * N; i++) {
    let h = 0.12 * fine[i], id = -1, shade = 1;
    for (let s = 0; s < 3; s++) {
      const v = sets[s], r = R[s] * (0.75 + 0.5 * v.id[i]), d = v.f1[i] / r;
      if (d >= 1) continue;
      const q = Math.sqrt(1 - d * d), dome = q * H[s] * (0.7 + 0.3 * v.id[i]);
      if (dome > h) { h = dome; id = v.id[i]; shade = 0.85 + 0.15 * q; }
    }
    if (id < 0) setMix(gA, gB, fine[i]);
    else {
      const f = id * (pal.length - 1), k = Math.min(pal.length - 2, Math.floor(f));
      setMix(pal[k], pal[k + 1], f - k);
      C[0] *= shade; C[1] *= shade; C[2] *= shade;
    }
    put(rgb, i, 0.92 + 0.16 * tone[i]);
    height[i] = h;
    rough[i] = id < 0 ? 0.95 : 0.8;
  }
  return { rgb, height: stretch(height), normalK: 3.5, rough };
}

function rock(N: number, seed: number): Layer {
  const warp = fbm(N, 4, 4, seed + 1, 0.5);
  const joints = fbm(N, 5, 4, seed + 2, 0.5, 0.35, true);
  const cr = fbm(N, 6, 5, seed + 3, 0.5, 1, true);
  const grain = fbm(N, 40, 3, seed + 4, 0.55);
  const mid = fbm(N, 10, 3, seed + 5, 0.55);
  const lichen = fbm(N, 48, 2, seed + 6, 0.55);
  const tone = fbm(N, 3, 3, seed + 7, 0.5);
  const rgb = new Float32Array(N * N * 3), height = new Float32Array(N * N), rough = new Float32Array(N * N);
  const BANDS = 6;
  const bandCol: RGB[] = [[0.52, 0.49, 0.44], [0.58, 0.53, 0.46], [0.48, 0.45, 0.41], [0.61, 0.58, 0.52], [0.55, 0.49, 0.41], [0.50, 0.48, 0.45]];
  const lich: RGB = [0.58, 0.58, 0.42], dark: RGB = [0.24, 0.22, 0.2];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    // strata: horizontal bands (texture v = world up on cliff faces), warped; ledges cast a dark lip below
    const v = (y / N) * BANDS + (warp[i] - 0.5) * 1.1;
    const b = ((Math.floor(v) % BANDS) + BANDS) % BANDS, fv = v - Math.floor(v);
    const lip = sm(0.12, 0.0, fv);
    const joint = sm(0.9, 0.975, joints[i]);
    const crack = sm(0.9, 0.97, cr[i]) * 0.8;
    setMix(bandCol[b], bandCol[(b + 1) % BANDS], sm(0.75, 1.0, fv) * 0.5);
    const g = grain[i] * 0.8 + mid[i] * 0.4 - 0.6;
    C[0] *= 1 + 0.1 * g; C[1] *= 1 + 0.09 * g; C[2] *= 1 + 0.07 * g;
    towards(lich, sm(0.8, 0.9, lichen[i] * 0.7 + mid[i] * 0.3) * 0.45);
    towards(dark, Math.max(joint, crack, lip * 0.75) * 0.65);
    put(rgb, i, 0.9 + 0.2 * tone[i]);
    height[i] = 0.3 * (1 - fv) + 0.25 * mid[i] + 0.2 * grain[i] + 0.2 * warp[i] - 0.45 * joint - 0.35 * crack;
    rough[i] = 0.76 + 0.14 * grain[i];
  }
  return { rgb, height: stretch(height), normalK: 4.5, rough };
}

function sand(N: number, seed: number): Layer {
  const warp = fbm(N, 3, 3, seed + 1, 0.5);
  const grain = fbm(N, 96, 2, seed + 2, 0.6);
  const spots = voronoi(N, 40, seed + 3, 0.95);
  const tone = fbm(N, 4, 3, seed + 4, 0.5);
  const rgb = new Float32Array(N * N * 3), height = new Float32Array(N * N), rough = new Float32Array(N * N);
  const base: RGB = [0.80, 0.72, 0.54], darkS: RGB = [0.70, 0.62, 0.45], shellC: RGB = [0.9, 0.87, 0.8];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const rip = 0.5 + 0.5 * Math.sin(2 * Math.PI * ((x / N) * 9 + (y / N) * 2 + (warp[i] - 0.5) * 1.6));
    const shell = spots.id[i] < 0.12 ? sm(0.3, 0.15, spots.f1[i]) : 0;
    setMix(darkS, base, 0.35 + 0.4 * rip + 0.25 * grain[i]);
    towards(shellC, shell * 0.6);
    put(rgb, i, 0.95 + 0.1 * tone[i]);
    height[i] = 0.6 * rip + 0.3 * grain[i] + 0.3 * shell;
    rough[i] = 0.96;
  }
  return { rgb, height: stretch(height), normalK: 1.6, rough };
}

export interface DetailData {
  size: number;
  /** RGBA8 per layer: sRGB albedo + linear height */
  albedo: Uint8Array<ArrayBuffer>;
  /** RGBA8 per layer: normal x/y (0.5 + 0.5 n), cavity (1 = open), roughness */
  normal: Uint8Array<ArrayBuffer>;
  /** average linear albedo per layer */
  mean: number[][];
  macroSize: number;
  /** RGBA8 smooth tileable noise, four independent channels */
  macro: Uint8Array<ArrayBuffer>;
}

/** Generate all detail layers (pure typed-array code: runs in node for previews and tests). */
export function generateDetailData(N = 256, seed = 1234): DetailData {
  const gens = [grass, dirt, scree, rock, sand];
  const albedo = new Uint8Array(N * N * 4 * gens.length), normal = new Uint8Array(N * N * 4 * gens.length);
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const mean: number[][] = [];
  for (let li = 0; li < gens.length; li++) {
    const L = gens[li](N, seed + li * 100);
    const o = li * N * N * 4;
    const cav = blur(L.height, N, 3), hgt = L.height, K = L.normalK;
    let mr = 0, mg = 0, mb = 0;
    for (let y = 0; y < N; y++) {
      const yu = ((y + 1) % N) * N, yd = ((y + N - 1) % N) * N, row = y * N;
      for (let x = 0; x < N; x++) {
        const i = row + x, k = o + i * 4;
        const r = Math.round(clamp01(L.rgb[i * 3]) * 255), g = Math.round(clamp01(L.rgb[i * 3 + 1]) * 255), b = Math.round(clamp01(L.rgb[i * 3 + 2]) * 255);
        albedo[k] = r; albedo[k + 1] = g; albedo[k + 2] = b; albedo[k + 3] = Math.round(hgt[i] * 255);
        mr += lut[r]; mg += lut[g]; mb += lut[b];
        // normal from the height field (central differences, wrapped), strength per layer
        let nx = (hgt[row + ((x + N - 1) % N)] - hgt[row + ((x + 1) % N)]) * K, ny = (hgt[yd + x] - hgt[yu + x]) * K;
        const nl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= nl; ny *= nl;
        normal[k] = Math.round((nx * 0.5 + 0.5) * 255); normal[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normal[k + 2] = Math.round(clamp01(0.8 + (hgt[i] - cav[i]) * 2.2) * 255);
        normal[k + 3] = Math.round(clamp01(L.rough[i]) * 255);
      }
    }
    mean.push([mr / (N * N), mg / (N * N), mb / (N * N)]);
  }
  const M = 256, macro = new Uint8Array(M * M * 4);
  const ch = [fbm(M, 4, 5, seed + 900, 0.5), fbm(M, 5, 5, seed + 901, 0.5), fbm(M, 8, 4, seed + 902, 0.5), fbm(M, 3, 4, seed + 903, 0.55)];
  for (let i = 0; i < M * M; i++) for (let c = 0; c < 4; c++) macro[i * 4 + c] = Math.round(ch[c][i] * 255);
  return { size: N, albedo, normal, mean, macroSize: M, macro };
}

export interface DetailTextures { albedo: THREE.DataArrayTexture; normal: THREE.DataArrayTexture; macro: THREE.DataTexture; mean: number[][] }
let cached: DetailTextures | null = null;

/** GPU textures of the detail layers (generated once per session), mipmapped and anisotropically filtered. */
export function detailTextures(): DetailTextures {
  if (cached) return cached;
  const d = generateDetailData();
  const arr = (data: Uint8Array<ArrayBuffer>, srgb: boolean) => {
    const t = new THREE.DataArrayTexture(data, d.size, d.size, DETAIL_LAYERS);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const macro = new THREE.DataTexture(d.macro, d.macroSize, d.macroSize, THREE.RGBAFormat, THREE.UnsignedByteType);
  macro.wrapS = macro.wrapT = THREE.RepeatWrapping;
  macro.magFilter = THREE.LinearFilter;
  macro.minFilter = THREE.LinearMipmapLinearFilter;
  macro.generateMipmaps = true;
  macro.needsUpdate = true;
  cached = { albedo: arr(d.albedo, true), normal: arr(d.normal, false), macro, mean: d.mean };
  return cached;
}
