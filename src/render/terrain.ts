// Terrain chunks, map-edge skirts and water.
import * as THREE from 'three';
import { World, TERRAIN_CHUNK } from '../game/world';
import { HSTEP, WATER_Y } from '../game/constants';
import { NOISE_GLSL } from './shaders';
import { GeoBuilder } from './geo';

export interface TerrainUniforms {
  uGrid: { value: number };
  uHiRect: { value: THREE.Vector4 };
  uHiColor: { value: THREE.Color };
  uHiOn: { value: number };
  uSnow: { value: number };
  uTime: { value: number };
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
  private heightData: Float32Array;
  private lastHeightsVersion = -1;
  base: THREE.Mesh;

  constructor(public world: World) {
    const s = world.size;
    this.uniforms = {
      uGrid: { value: 0 },
      uHiRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uHiColor: { value: new THREE.Color(0.3, 0.8, 1.0) },
      uHiOn: { value: 0 },
      uSnow: { value: 7.5 },
      uTime: { value: 0 },
    };
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    const U = this.uniforms;
    this.material.onBeforeCompile = (sh) => {
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
uniform float uGrid; uniform vec4 uHiRect; uniform vec3 uHiColor; uniform float uHiOn; uniform float uSnow; uniform float uTime;
varying vec3 vWPos; varying vec3 vWNormal; varying float vForest;
${NOISE_GLSL}`)
        .replace('#include <map_fragment>', `
{
  vec2 p = vWPos.xz;
  float n1 = rf_fbm(p * 0.07);
  float n2 = rf_fbm(p * 0.55 + 3.0);
  float n3 = rf_vnoise(p * 5.0);
  float n4 = rf_vnoise(p * 17.0);
  vec3 grassA = rf_srgb(vec3(0.33, 0.47, 0.20));
  vec3 grassB = rf_srgb(vec3(0.45, 0.56, 0.24));
  vec3 dry    = rf_srgb(vec3(0.62, 0.58, 0.34));
  vec3 dirt   = rf_srgb(vec3(0.47, 0.38, 0.27));
  vec3 rock   = rf_srgb(vec3(0.52, 0.50, 0.47));
  vec3 sand   = rf_srgb(vec3(0.84, 0.77, 0.57));
  vec3 mud    = rf_srgb(vec3(0.33, 0.33, 0.24));
  vec3 snow   = rf_srgb(vec3(0.95, 0.96, 0.99));
  vec3 forest = rf_srgb(vec3(0.22, 0.30, 0.13));
  vec3 col = mix(grassA, grassB, smoothstep(0.3, 0.72, n1));
  col = mix(col, dry, smoothstep(0.52, 0.78, n2) * 0.55);
  col *= 0.88 + 0.16 * n3 + 0.08 * n4;
  col = mix(col, forest * (0.85 + 0.3 * n3), clamp(vForest, 0.0, 1.0) * 0.85);
  float slope = 1.0 - normalize(vWNormal).y;
  col = mix(col, dirt * (0.9 + 0.2 * n3), smoothstep(0.10, 0.22, slope) * 0.45);
  col = mix(col, rock * (0.75 + 0.45 * n2), smoothstep(0.26, 0.42, slope + (n2 - 0.5) * 0.12));
  float h = vWPos.y;
  col = mix(sand * (0.9 + 0.15 * n3), col, smoothstep(${(WATER_Y + 0.0).toFixed(3)}, ${(WATER_Y + 0.09).toFixed(3)}, h + (n2 - 0.5) * 0.08));
  col = mix(mud * (0.85 + 0.2 * n3), col, smoothstep(${(WATER_Y - 0.09).toFixed(3)}, ${(WATER_Y - 0.005).toFixed(3)}, h));
  float sn = smoothstep(uSnow, uSnow + 0.9, h + (n1 - 0.5) * 1.6) * (1.0 - smoothstep(0.3, 0.55, slope));
  col = mix(col, snow, sn);
  if (uHiOn > 0.5) {
    if (p.x >= uHiRect.x && p.x <= uHiRect.z && p.y >= uHiRect.y && p.y <= uHiRect.w) {
      col = mix(col, uHiColor, 0.28);
      vec2 dd = min(p - uHiRect.xy, uHiRect.zw - p);
      float edge = 1.0 - smoothstep(0.0, 0.06, min(dd.x, dd.y));
      col = mix(col, uHiColor, edge * 0.7);
    }
  }
  if (uGrid > 0.0) {
    vec2 f = abs(fract(p) - 0.5);
    float g = max(f.x, f.y);
    float line = smoothstep(0.465, 0.5, g);
    col = mix(col, col * 0.45, line * uGrid * 0.8);
  }
  diffuseColor.rgb = col;
}`);
    };
    this.material.customProgramCacheKey = () => 'rf-terrain';

    // heightmap texture for the water shader
    this.heightData = new Float32Array((s + 1) * (s + 1));
    this.heightTex = new THREE.DataTexture(this.heightData, s + 1, s + 1, THREE.RedFormat, THREE.FloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;

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
    bg.translate(s / 2, -1.6, s / 2);
    this.base = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x5b6150, roughness: 1 }));
    this.base.receiveShadow = true;
    this.group.add(this.base);

    const n = Math.ceil(s / TERRAIN_CHUNK);
    this.chunks = new Array(n * n).fill(null);
    for (let i = 0; i < n * n; i++) this.rebuildChunk(i);
    this.rebuildSkirt();
    this.updateHeightTex();
  }

  get chunkCount() { return Math.ceil(this.world.size / TERRAIN_CHUNK); }

  update() {
    const w = this.world;
    if (w.dirtyTerrain.size) {
      for (const c of w.dirtyTerrain) this.rebuildChunk(c);
      w.dirtyTerrain.clear();
    }
    if (w.heightsVersion !== this.lastHeightsVersion) {
      this.updateHeightTex();
      this.rebuildSkirt();
    }
  }

  private updateHeightTex() {
    const w = this.world;
    const s1 = w.size + 1;
    const a = this.heightData;
    for (let i = 0; i < s1 * s1; i++) a[i] = w.hgt[i] * HSTEP;
    // soften the quantised heights so shallow water shading is smooth
    const tmp = new Float32Array(a.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let z = 0; z < s1; z++) for (let x = 0; x < s1; x++) {
        let sum = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= s1 || zz >= s1) continue;
          sum += a[zz * s1 + xx]; n++;
        }
        tmp[z * s1 + x] = sum / n;
      }
      a.set(tmp);
    }
    this.heightTex.needsUpdate = true;
    this.lastHeightsVersion = w.heightsVersion;
  }

  rebuildChunk(ci: number) {
    const w = this.world;
    const n = this.chunkCount;
    const cx = ci % n, cz = Math.floor(ci / n);
    const x0 = cx * TERRAIN_CHUNK, z0 = cz * TERRAIN_CHUNK;
    const x1 = Math.min(w.size, x0 + TERRAIN_CHUNK), z1 = Math.min(w.size, z0 + TERRAIN_CHUNK);
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    const pos = new Float32Array(vw * vh * 3);
    const nrm = new Float32Array(vw * vh * 3);
    const forest = new Float32Array(vw * vh);
    const s = w.size;
    const H = (x: number, z: number) => w.cornerH(Math.max(0, Math.min(s, x)), Math.max(0, Math.min(s, z))) * HSTEP;
    const treeAt = (x: number, z: number) => (w.inBounds(x, z) ? w.trees[w.idx(x, z)] & 15 : 0);
    let k = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      pos[k * 3] = x; pos[k * 3 + 1] = H(x, z); pos[k * 3 + 2] = z;
      const dx = (H(x + 1, z) - H(x - 1, z)) * 0.5;
      const dz = (H(x, z + 1) - H(x, z - 1)) * 0.5;
      const l = Math.hypot(dx, 1, dz);
      nrm[k * 3] = -dx / l; nrm[k * 3 + 1] = 1 / l; nrm[k * 3 + 2] = -dz / l;
      forest[k] = (treeAt(x - 1, z - 1) + treeAt(x, z - 1) + treeAt(x - 1, z) + treeAt(x, z)) / 9;
      k++;
    }
    const idx: number[] = [];
    const c = [0, 0, 0, 0];
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const nw = (z - z0) * vw + (x - x0), ne = nw + 1, sw = nw + vw, se = sw + 1;
      w.corners(x, z, c);
      if (!World.splitOf(c)) idx.push(nw, se, ne, nw, sw, se);
      else idx.push(nw, sw, ne, ne, sw, se);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aForest', new THREE.BufferAttribute(forest, 1));
    g.setIndex(idx);
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

  private rebuildSkirt() {
    const w = this.world;
    const s = w.size;
    const gb = new GeoBuilder();
    const wb = new GeoBuilder();
    const bottom = -1.6;
    const edge = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number) => {
      const h0 = w.cornerH(x0, z0) * HSTEP, h1 = w.cornerH(x1, z1) * HSTEP;
      // earth layers
      gb.color(0x6b5a45);
      const mid0 = Math.min(h0, -0.35), mid1 = Math.min(h1, -0.35);
      const q = (ya0: number, ya1: number, yb0: number, yb1: number) => {
        if (nx + nz > 0) gb.quad(x0, ya0, z0, x1, ya1, z1, x1, yb1, z1, x0, yb0, z0);
        else gb.quad(x1, ya1, z1, x0, ya0, z0, x0, yb0, z0, x1, yb1, z1);
      };
      gb.color(0x4e4234);
      q(bottom, bottom, mid0, mid1);
      gb.color(0x7a6448);
      q(mid0, mid1, h0, h1);
      if (h0 < WATER_Y || h1 < WATER_Y) {
        wb.color(0x2c6f86);
        const a0 = Math.min(h0, WATER_Y), a1 = Math.min(h1, WATER_Y);
        if (nx + nz > 0) wb.quad(x0, a0, z0, x1, a1, z1, x1, WATER_Y, z1, x0, WATER_Y, z0);
        else wb.quad(x1, a1, z1, x0, a0, z0, x0, WATER_Y, z0, x1, WATER_Y, z1);
      }
    };
    for (let i = 0; i < s; i++) {
      edge(i, 0, i + 1, 0, 0, -1);      // north (faces -z)
      edge(i, s, i + 1, s, 0, 1);       // south
      edge(0, i, 0, i + 1, -1, 0);      // west
      edge(s, i, s, i + 1, 1, 0);       // east
    }
    const g = gb.build();
    // the quad helper derives normals from winding; force outward normals for the skirt
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
      float wv(vec2 p) {
        return rf_vnoise(p * 1.3 + vec2(uTime * 0.25, uTime * 0.11)) * 0.6
             + rf_vnoise(p * 3.1 - vec2(uTime * 0.18, -uTime * 0.31)) * 0.3
             + rf_vnoise(p * 7.7 + vec2(-uTime * 0.5, uTime * 0.4)) * 0.1;
      }
      void main() {
        vec2 uv = (vWPos.xz + 0.5) / (uSize + 1.0);
        float th = texture2D(uHeight, uv).r;
        float depth = vWPos.y - th;
        depth = max(depth, 0.0);
        vec2 p = vWPos.xz;
        float e = 0.04;
        float h0 = wv(p);
        float hx = wv(p + vec2(e, 0.0));
        float hz = wv(p + vec2(0.0, e));
        vec3 N = normalize(vec3((h0 - hx) * 1.6, 1.0, (h0 - hz) * 1.6));
        vec3 V = normalize(cameraPosition - vWPos);
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 deep = vec3(0.012, 0.06, 0.10);
        vec3 shallow = vec3(0.05, 0.26, 0.28);
        vec3 col = mix(shallow, deep, smoothstep(0.0, 0.8, depth));
        float lit = 0.25 + 0.75 * max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0);
        col *= lit * uLight + 0.05;
        vec3 R = reflect(-V, N);
        vec3 refl = mix(uHorizon, uSkyColor, clamp(R.y * 1.8, 0.0, 1.0)) * uLight;
        col = mix(col, refl, clamp(fres, 0.0, 0.85));
        float spec = pow(max(dot(R, uSunDir), 0.0), 180.0) * 3.0;
        col += uSunColor * spec * step(0.0, uSunDir.y);
        float shore = 1.0 - smoothstep(0.0, 0.03, depth);
        float foamN = rf_vnoise(p * 9.0 + vec2(uTime * 0.7, -uTime * 0.5));
        float foam = shore * smoothstep(0.35, 0.75, foamN + shore * 0.4);
        col = mix(col, vec3(0.85, 0.9, 0.92) * uLight, foam * 0.75);
        float alpha = mix(0.62, 0.95, smoothstep(0.0, 0.35, depth));
        alpha = max(alpha, foam * 0.9);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
