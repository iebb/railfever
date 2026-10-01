// Terrain chunks (1 vertex per world unit), map-edge skirts, water surface and exact ray picking.
import * as THREE from 'three';
import { World, TERRAIN_CHUNK } from '../game/world';
import { WATER_Y } from '../game/constants';
import { NOISE_GLSL } from './shaders';
import { GeoBuilder } from './geo';

export interface TerrainUniforms {
  uGrid: { value: number };
  uHiRect: { value: THREE.Vector4 };
  uHiColor: { value: THREE.Color };
  uHiOn: { value: number };
  uCircle: { value: THREE.Vector4 };
  uCircleColor: { value: THREE.Color };
  uSnow: { value: number };
  uTime: { value: number };
}

/** Shared index buffers per chunk vertex dimensions (same split as World.heightAt). */
const indexCache = new Map<string, THREE.BufferAttribute>();
function chunkIndex(vw: number, vh: number): THREE.BufferAttribute {
  const key = vw + 'x' + vh;
  let a = indexCache.get(key);
  if (a) return a;
  const n = (vw - 1) * (vh - 1) * 6;
  const idx = vw * vh > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  let k = 0;
  for (let j = 0; j < vh - 1; j++) for (let i = 0; i < vw - 1; i++) {
    const a0 = j * vw + i, b = a0 + 1, c = a0 + vw + 1, d = a0 + vw;
    // (x,z),(x+1,z+1),(x+1,z) and (x,z),(x,z+1),(x+1,z+1): CCW seen from above
    idx[k++] = a0; idx[k++] = c; idx[k++] = b;
    idx[k++] = a0; idx[k++] = d; idx[k++] = c;
  }
  a = new THREE.BufferAttribute(idx, 1);
  indexCache.set(key, a);
  return a;
}

export class TerrainView {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  uniforms: TerrainUniforms;
  chunks: (THREE.Mesh | null)[] = [];
  skirt: THREE.Mesh | null = null;
  waterSides: THREE.Mesh | null = null;
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  heightTex: THREE.DataTexture;
  base: THREE.Mesh;
  /** max milliseconds spent rebuilding dirty chunks per update */
  budgetMs = 6;
  private heightData: Uint16Array;
  private nc: number;
  private bottom = -6;

  constructor(public world: World) {
    const s = world.size;
    this.nc = Math.ceil(s / TERRAIN_CHUNK);
    this.uniforms = {
      uGrid: { value: 0 },
      uHiRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uHiColor: { value: new THREE.Color(0.3, 0.8, 1.0) },
      uHiOn: { value: 0 },
      uCircle: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCircleColor: { value: new THREE.Color(0.35, 0.75, 1.0) },
      uSnow: { value: 20 },
      uTime: { value: 0 },
    };
    this.material = createTerrainMaterial(this.uniforms);

    let minH = 0;
    for (let i = 0; i < world.h.length; i++) if (world.h[i] < minH) minH = world.h[i];
    this.bottom = Math.min(minH, WATER_Y) - 3;

    // height field texture (half float: filterable everywhere) for the water shader
    this.heightData = new Uint16Array((s + 1) * (s + 1));
    this.heightTex = new THREE.DataTexture(this.heightData, s + 1, s + 1, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fillHeights(0, s);

    this.waterMat = createWaterMaterial(this.heightTex, s);
    const wg = new THREE.PlaneGeometry(s, s, 1, 1);
    wg.rotateX(-Math.PI / 2);
    wg.translate(s / 2, WATER_Y, s / 2);
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = 2;
    this.group.add(this.water);

    // base plate under the diorama
    const bg = new THREE.PlaneGeometry(s * 12, s * 12);
    bg.rotateX(-Math.PI / 2);
    bg.translate(s / 2, this.bottom, s / 2);
    this.base = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x5b6150, roughness: 1 }));
    this.base.receiveShadow = true;
    this.group.add(this.base);

    this.chunks = new Array(this.nc * this.nc).fill(null);
    for (let i = 0; i < this.nc * this.nc; i++) this.buildChunk(i);
    this.rebuildSkirt();
  }

  get chunkCount() { return this.nc; }

  /** Rebuild dirty chunks (consumes world.dirtyTerrain) within the time budget. */
  update() {
    const w = this.world;
    if (!w.dirtyTerrain.size) return;
    const t0 = performance.now();
    let border = false;
    for (const ci of [...w.dirtyTerrain]) {
      w.dirtyTerrain.delete(ci);
      if (ci < 0 || ci >= this.chunks.length) continue;
      this.buildChunk(ci);
      const cx = ci % this.nc, cz = Math.floor(ci / this.nc);
      this.fillHeights(cz * TERRAIN_CHUNK, Math.min(w.size, (cz + 1) * TERRAIN_CHUNK));
      if (cx === 0 || cz === 0 || cx === this.nc - 1 || cz === this.nc - 1) border = true;
      if (performance.now() - t0 > this.budgetMs) break;
    }
    if (border) this.rebuildSkirt();
  }

  /** Copy vertex heights of rows z0..z1 into the height texture. */
  private fillHeights(z0: number, z1: number) {
    const w = this.world, s1 = w.size + 1;
    const a = this.heightData, h = w.h;
    const i0 = z0 * s1, i1 = (z1 + 1) * s1;
    for (let i = i0; i < i1; i++) a[i] = THREE.DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, h[i])));
    // (three's partial texture updates only support RGBA data: re-upload the whole texture)
    this.heightTex.needsUpdate = true;
  }

  buildChunk(ci: number) {
    const w = this.world;
    const cx = ci % this.nc, cz = Math.floor(ci / this.nc);
    const x0 = cx * TERRAIN_CHUNK, z0 = cz * TERRAIN_CHUNK;
    const x1 = Math.min(w.size, x0 + TERRAIN_CHUNK), z1 = Math.min(w.size, z0 + TERRAIN_CHUNK);
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    const nv = vw * vh;
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const aux = new Float32Array(nv);
    let k = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      pos[k * 3] = x; pos[k * 3 + 1] = w.vh(x, z); pos[k * 3 + 2] = z;
      const dx = (w.vh(x + 1, z) - w.vh(x - 1, z)) * 0.5;
      const dz = (w.vh(x, z + 1) - w.vh(x, z - 1)) * 0.5;
      const l = Math.hypot(dx, 1, dz);
      nrm[k * 3] = -dx / l; nrm[k * 3 + 1] = 1 / l; nrm[k * 3 + 2] = -dz / l;
      k++;
    }
    this.forestDensity(x0, z0, x1, z1, vw, aux);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aForest', new THREE.BufferAttribute(aux, 1));
    g.setIndex(chunkIndex(vw, vh));
    g.computeBoundingSphere();
    let m = this.chunks[ci];
    if (m) { m.geometry.dispose(); m.geometry = g; }
    else {
      m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      m.castShadow = true;
      this.chunks[ci] = m;
      this.group.add(m);
    }
  }

  /** Per-vertex forest density (darker forest floor under tree clusters). */
  private forestDensity(x0: number, z0: number, x1: number, z1: number, vw: number, out: Float32Array) {
    const w = this.world;
    const R = 1.8;
    for (const id of w.treeGrid.query(x0 - R, z0 - R, x1 + R, z1 + R)) {
      const t = w.trees[id];
      if (!t) continue;
      for (let z = Math.max(z0, Math.ceil(t.z - R)); z <= Math.min(z1, Math.floor(t.z + R)); z++) {
        for (let x = Math.max(x0, Math.ceil(t.x - R)); x <= Math.min(x1, Math.floor(t.x + R)); x++) {
          const d = Math.hypot(x - t.x, z - t.z);
          if (d < R) out[(z - z0) * vw + (x - x0)] += (1 - d / R) * 0.4 * t.s;
        }
      }
    }
  }

  private rebuildSkirt() {
    const w = this.world;
    const s = w.size;
    const gb = new GeoBuilder();
    const wb = new GeoBuilder();
    const bottom = this.bottom;
    const edge = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number) => {
      const h0 = w.vh(x0, z0), h1 = w.vh(x1, z1);
      const mid0 = Math.min(h0 - 0.6, -1.5), mid1 = Math.min(h1 - 0.6, -1.5);
      const q = (ya0: number, ya1: number, yb0: number, yb1: number) => {
        if (nx + nz > 0) gb.quad(x0, ya0, z0, x1, ya1, z1, x1, yb1, z1, x0, yb0, z0);
        else gb.quad(x1, ya1, z1, x0, ya0, z0, x0, yb0, z0, x1, yb1, z1);
      };
      gb.color(0x4e4234);
      q(bottom, bottom, Math.max(bottom, mid0), Math.max(bottom, mid1));
      gb.color(0x7a6448);
      q(Math.max(bottom, mid0), Math.max(bottom, mid1), h0, h1);
      if (h0 < WATER_Y || h1 < WATER_Y) {
        wb.color(0x2c6f86);
        const a0 = Math.min(h0, WATER_Y), a1 = Math.min(h1, WATER_Y);
        if (nx + nz > 0) wb.quad(x0, a0, z0, x1, a1, z1, x1, WATER_Y, z1, x0, WATER_Y, z0);
        else wb.quad(x1, a1, z1, x0, a0, z0, x0, WATER_Y, z0, x1, WATER_Y, z1);
      }
    };
    for (let i = 0; i < s; i++) {
      edge(i, 0, i + 1, 0, 0, -1);
      edge(i, s, i + 1, s, 0, 1);
      edge(0, i, 0, i + 1, -1, 0);
      edge(s, i, s, i + 1, 1, 0);
    }
    const g = gb.build();
    if (this.skirt) { this.skirt.geometry.dispose(); this.skirt.geometry = g; }
    else {
      this.skirt = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
      this.skirt.receiveShadow = true;
      this.group.add(this.skirt);
    }
    const wgeo = wb.build();
    if (this.waterSides) { this.waterSides.geometry.dispose(); this.waterSides.geometry = wgeo; }
    else {
      this.waterSides = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.75, roughness: 0.2, side: THREE.DoubleSide }));
      this.group.add(this.waterSides);
    }
  }

  /** Highest and lowest vertex height (for picking bounds). */
  heightRange(): [number, number] {
    const h = this.world.h;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < h.length; i++) { const v = h[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return [mn, mx];
  }

  dispose() {
    for (const m of this.chunks) m?.geometry.dispose();
    this.skirt?.geometry.dispose();
    this.waterSides?.geometry.dispose();
    this.water.geometry.dispose();
    this.base.geometry.dispose();
    this.heightTex.dispose();
    this.waterMat.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------------------------ picking

export interface V3 { x: number; y: number; z: number }

/**
 * Exact intersection of a ray with the visible surface max(terrain, WATER_Y) inside the map.
 * The terrain is piecewise planar between the lines x = int, z = int and x - z = int (the cell
 * diagonals of World.heightAt), so the ray is walked across those lines and each piece is solved
 * linearly. Returns false when the ray misses the map (or enters it through the side walls).
 */
export function raycastTerrain(w: World, o: V3, d: V3, maxH: number, out: V3, maxT = 1e5): boolean {
  const s = w.size;
  let t0 = 0, t1 = maxT;
  const clip = (oc: number, dc: number) => {
    if (Math.abs(dc) < 1e-12) return oc >= 0 && oc <= s;
    let a = (0 - oc) / dc, b = (s - oc) / dc;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return true;
  };
  if (!clip(o.x, d.x) || !clip(o.z, d.z) || t0 >= t1) return false;
  const top = Math.max(maxH, WATER_Y) + 1e-3;
  if (d.y < 0) { const tt = (top - o.y) / d.y; if (tt > t0) t0 = tt; }
  else if (o.y + d.y * t0 > top) return false;
  if (d.y > 0) t1 = Math.min(t1, (top - o.y) / d.y);
  if (t0 >= t1) return false;
  const terr = (t: number) => w.heightAt(o.x + d.x * t, o.z + d.z * t);
  let t = t0;
  let gT = o.y + d.y * t - terr(t), gW = o.y + d.y * t - WATER_Y;
  if (gT <= 0 || gW <= 0) return false; // entered below the surface: side wall or camera underground
  const dw = d.x - d.z;
  const nextLine = (v: number, dv: number) => (dv > 0 ? Math.floor(v) + 1 : Math.ceil(v) - 1);
  let ix = nextLine(o.x + d.x * t, d.x), iz = nextLine(o.z + d.z * t, d.z), iw = nextLine(o.x - o.z + dw * t, dw);
  let tx = Math.abs(d.x) > 1e-12 ? (ix - o.x) / d.x : Infinity;
  let tz = Math.abs(d.z) > 1e-12 ? (iz - o.z) / d.z : Infinity;
  let tw = Math.abs(dw) > 1e-12 ? (iw - (o.x - o.z)) / dw : Infinity;
  for (let guard = 0; guard < 8 * s + 16; guard++) {
    const tn = Math.min(tx, tz, tw, t1);
    const nT = o.y + d.y * tn - terr(tn), nW = o.y + d.y * tn - WATER_Y;
    if (nT <= 0 || nW <= 0) {
      let th = Infinity;
      if (nT <= 0) th = t + (gT / (gT - nT)) * (tn - t);
      if (nW <= 0) th = Math.min(th, t + (gW / (gW - nW)) * (tn - t));
      out.x = o.x + d.x * th; out.z = o.z + d.z * th;
      out.y = Math.max(w.heightAt(out.x, out.z), WATER_Y);
      return true;
    }
    if (tn >= t1) return false;
    t = tn; gT = nT; gW = nW;
    if (tx <= tn) { ix += d.x > 0 ? 1 : -1; tx = (ix - o.x) / d.x; }
    if (tz <= tn) { iz += d.z > 0 ? 1 : -1; tz = (iz - o.z) / d.z; }
    if (tw <= tn) { iw += dw > 0 ? 1 : -1; tw = (iw - (o.x - o.z)) / dw; }
  }
  return false;
}

// ------------------------------------------------------------------------------------ materials

function createTerrainMaterial(U: TerrainUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aForest;
varying vec3 vWPos;
varying vec3 vWNormal;
varying float vForest;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vForest = aForest;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uGrid; uniform vec4 uHiRect; uniform vec3 uHiColor; uniform float uHiOn;
uniform vec4 uCircle; uniform vec3 uCircleColor; uniform float uSnow; uniform float uTime;
varying vec3 vWPos; varying vec3 vWNormal; varying float vForest;
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `
vec3 rfGlow = vec3(0.0);
{
  vec2 p = vWPos.xz;
  float fw = max(length(fwidth(p)), 1e-4);
  float n0 = rf_fbm(p * 0.008 + 3.1);
  float n1 = rf_fbm(p * 0.035);
  float n2 = rf_vnoise(p * 0.25 + 5.3);
  float n3 = rf_vnoise(p * 1.9 + 1.7) * (1.0 - smoothstep(0.25, 0.6, fw * 1.9));
  float n4 = rf_vnoise(p * 8.3) * (1.0 - smoothstep(0.25, 0.6, fw * 8.3));
  vec3 grassA = rf_srgb(vec3(0.31, 0.44, 0.17));
  vec3 grassB = rf_srgb(vec3(0.43, 0.53, 0.22));
  vec3 dry    = rf_srgb(vec3(0.58, 0.56, 0.32));
  vec3 forest = rf_srgb(vec3(0.21, 0.27, 0.12));
  vec3 dirt   = rf_srgb(vec3(0.46, 0.38, 0.28));
  vec3 rockA  = rf_srgb(vec3(0.46, 0.44, 0.41));
  vec3 rockB  = rf_srgb(vec3(0.60, 0.58, 0.54));
  vec3 sand   = rf_srgb(vec3(0.80, 0.74, 0.56));
  vec3 wetS   = rf_srgb(vec3(0.55, 0.50, 0.38));
  vec3 mud    = rf_srgb(vec3(0.32, 0.31, 0.24));
  vec3 snow   = rf_srgb(vec3(0.93, 0.95, 0.98));
  vec3 col = mix(grassA, grassB, smoothstep(0.35, 0.65, n1));
  col = mix(col, dry, smoothstep(0.55, 0.8, n0 + (n2 - 0.5) * 0.3) * 0.55);
  col *= 0.9 + 0.16 * n2 + 0.08 * (n3 - 0.5) + 0.07 * (n4 - 0.5);
  col = mix(col, forest * (0.85 + 0.3 * n3), clamp(vForest, 0.0, 1.0) * 0.8);
  float slope = 1.0 - normalize(vWNormal).y;
  col = mix(col, dirt * (0.9 + 0.2 * n3), smoothstep(0.06, 0.2, slope + (n2 - 0.5) * 0.06) * 0.55);
  vec3 rock = mix(rockA, rockB, n3) * (0.8 + 0.3 * n4) * (0.92 + 0.1 * sin(vWPos.y * 6.0 + n2 * 4.0));
  col = mix(col, rock, smoothstep(0.2, 0.36, slope + (n2 - 0.5) * 0.12));
  float h = vWPos.y;
  float beach = (1.0 - smoothstep(0.05, 0.2, h + (n2 - 0.5) * 0.1)) * (1.0 - smoothstep(0.15, 0.4, slope));
  col = mix(col, sand * (0.92 + 0.12 * n4), beach);
  col = mix(col, wetS, (1.0 - smoothstep(-0.01, 0.04, h)) * 0.7);
  col = mix(col, mud, 1.0 - smoothstep(-0.3, -0.05, h));
  float sn = smoothstep(uSnow, uSnow + 3.0, h + (n1 - 0.5) * 6.0) * (1.0 - smoothstep(0.35, 0.6, slope));
  col = mix(col, snow, sn);
  if (uHiOn > 0.5) {
    vec2 dd = min(p - uHiRect.xy, uHiRect.zw - p);
    float md = min(dd.x, dd.y);
    if (md >= 0.0) {
      float edge = 1.0 - smoothstep(fw, fw * 2.5, md);
      col = mix(col, uHiColor, 0.25 + edge * 0.6);
      rfGlow += uHiColor * (0.05 + edge * 0.3);
    }
  }
  if (uCircle.w > 0.5) {
    float d = length(p - uCircle.xy);
    float ring = 1.0 - smoothstep(fw, fw * 2.5, abs(d - uCircle.z));
    float inside = 1.0 - step(uCircle.z, d);
    col = mix(col, uCircleColor, inside * 0.15 + ring * 0.8);
    rfGlow += uCircleColor * (inside * 0.03 + ring * 0.3);
  }
  if (uGrid > 0.5) {
    vec2 gw = fwidth(p);
    vec2 g1 = 1.0 - smoothstep(gw * 0.5, gw * 1.5, abs(fract(p + 0.5) - 0.5));
    float minor = max(g1.x, g1.y) * (1.0 - smoothstep(0.08, 0.25, fw));
    vec2 g10 = 1.0 - smoothstep(gw * 0.75, gw * 2.0, abs(fract(p / 10.0 + 0.5) - 0.5) * 10.0);
    float major = max(g10.x, g10.y) * (1.0 - smoothstep(0.8, 2.5, fw));
    float hw = max(fwidth(h), 1e-4);
    float c1 = (1.0 - smoothstep(hw * 0.6, hw * 1.6, abs(fract(h + 0.5) - 0.5))) * (1.0 - smoothstep(0.25, 0.8, hw));
    float c5 = 1.0 - smoothstep(hw * 0.8, hw * 2.0, abs(fract(h / 5.0 + 0.5) - 0.5) * 5.0);
    col = mix(col, vec3(0.0), minor * 0.22);
    col = mix(col, vec3(0.01), major * 0.4);
    col = mix(col, rf_srgb(vec3(0.98, 0.92, 0.62)), max(c1 * 0.35, c5 * 0.5));
  }
  diffuseColor.rgb = col;
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rfGlow;');
  };
  mat.customProgramCacheKey = () => 'rf-terrain-v2';
  return mat;
}

function createWaterMaterial(heightTex: THREE.Texture, size: number): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uHeight: { value: null },
      uSize: { value: size },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyColor: { value: new THREE.Color(0.35, 0.55, 0.85) },
      uHorizon: { value: new THREE.Color(0.75, 0.82, 0.9) },
      uLight: { value: 1 },
    },
  ]);
  uniforms.uHeight.value = heightTex;
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uHeight; uniform float uSize; uniform float uTime;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyColor; uniform vec3 uHorizon; uniform float uLight;
      varying vec3 vWPos;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      // value noise with analytic derivatives
      vec3 rfNoiseD(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
        float a = rf_hash12(i), b = rf_hash12(i + vec2(1.0, 0.0)), c = rf_hash12(i + vec2(0.0, 1.0)), d = rf_hash12(i + vec2(1.0, 1.0));
        float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
        return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
      }
      void main() {
        vec2 uv = (vWPos.xz + 0.5) / (uSize + 1.0);
        float th = texture2D(uHeight, uv).r;
        float depth = max(vWPos.y - th, 0.0);
        vec2 p = vWPos.xz;
        float fw = max(length(fwidth(p)), 1e-4);
        vec2 g = vec2(0.0);
        g += rfNoiseD(p * 0.18 + vec2(uTime * 0.02, uTime * 0.013)).yz * 0.18 * 0.5;
        g += rfNoiseD(p * 0.9 - vec2(uTime * 0.07, -uTime * 0.05)).yz * 0.9 * 0.06 * (1.0 - smoothstep(0.3, 0.7, fw * 0.9));
        g += rfNoiseD(p * 3.3 + vec2(-uTime * 0.21, uTime * 0.17)).yz * 3.3 * 0.012 * (1.0 - smoothstep(0.3, 0.7, fw * 3.3));
        g += rfNoiseD(p * 11.0 + vec2(uTime * 0.5, uTime * 0.37)).yz * 11.0 * 0.003 * (1.0 - smoothstep(0.3, 0.7, fw * 11.0));
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - vWPos);
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 deep = vec3(0.010, 0.05, 0.085);
        vec3 shallow = vec3(0.05, 0.24, 0.25);
        vec3 col = mix(shallow, deep, smoothstep(0.0, 0.7, depth));
        float lit = 0.25 + 0.75 * max(uSunDir.y, 0.0);
        col *= lit * uLight + 0.04;
        vec3 R = reflect(-V, N);
        vec3 refl = mix(uHorizon, uSkyColor, clamp(R.y * 1.8, 0.0, 1.0)) * uLight;
        col = mix(col, refl, clamp(fres, 0.0, 0.85));
        float spec = pow(max(dot(R, uSunDir), 0.0), 220.0) * 3.5;
        col += uSunColor * spec * step(0.0, uSunDir.y);
        float shore = 1.0 - smoothstep(0.0, 0.035, depth);
        float foamN = rf_vnoise(p * 6.0 + vec2(uTime * 0.6, -uTime * 0.45));
        float foam = shore * smoothstep(0.35, 0.75, foamN + shore * 0.4);
        col = mix(col, vec3(0.85, 0.9, 0.92) * uLight, foam * 0.7);
        float alpha = mix(0.55, 0.95, smoothstep(0.0, 0.4, depth));
        alpha = max(alpha, foam * 0.9);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
