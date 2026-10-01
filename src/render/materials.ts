// Shared materials with custom shader tweaks.
import * as THREE from 'three';
import { createFacadeAtlas, ATLAS_CELLS, createGlowTexture, createWorldAtlas, ATLAS, ATLAS_SIZE, CELL_ROUGH, CELL_METAL, WC } from './textures';
import { NOISE_GLSL } from './shaders';

export class Materials {
  uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uLitRatio: { value: 0.55 },
  };
  matte: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  facade: THREE.MeshStandardMaterial;
  tree: THREE.MeshStandardMaterial;
  body: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  lamp: THREE.MeshBasicMaterial;
  ghost: THREE.MeshBasicMaterial;
  glow: THREE.PointsMaterial;
  headlight: THREE.PointsMaterial;
  /**
   * Static world surfaces: one atlas (see textures.ts WC) selected per vertex by the `aCell` attribute
   * (uv in repeats of the cell), with per-cell roughness/metalness and a night-emissive LAMP cell.
   */
  world: THREE.MeshStandardMaterial;
  /** Shadow depth material for world meshes: faces with aCast = 0 (flat ground pieces) cast no shadow. */
  worldDepth: THREE.MeshDepthMaterial;
  /** materials added by the static renderer that should also get cloud shadows etc. */
  extra: THREE.Material[];
  /** night window emission of facade cells in the world material */
  facEmissive = { value: new THREE.Color(0, 0, 0) };

  constructor() {
    const U = this.uniforms;
    this.matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
    this.metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.7 });
    const atlas = createFacadeAtlas();
    this.facade = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.72, metalness: 0.05, map: atlas.color, emissiveMap: atlas.emissive,
      emissive: new THREE.Color(1.0, 0.72, 0.38), emissiveIntensity: 0,
    });
    const N = ATLAS_CELLS.toFixed(1);
    this.facade.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = U.uNight;
      sh.uniforms.uLitRatio = U.uLitRatio;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aCell; attribute float aSeed;
varying vec2 vCell; varying float vSeed; varying vec2 vCellUv;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCell = aCell; vSeed = aSeed; vCellUv = uv;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uNight; uniform float uLitRatio;
varying vec2 vCell; varying float vSeed; varying vec2 vCellUv;
${NOISE_GLSL}`)
        .replace('#include <map_fragment>', `
vec2 rfCuv = fract(vCellUv);
vec2 rfAuv = vec2((vCell.x + rfCuv.x) / ${N}, 1.0 - (vCell.y + 1.0 - rfCuv.y) / ${N});
vec2 rfGx = dFdx(vCellUv) / ${N};
vec2 rfGy = dFdy(vCellUv) / ${N};
vec4 rfTex = textureGrad(map, rfAuv, rfGx, rfGy);
diffuseColor *= rfTex;`)
        .replace('#include <emissivemap_fragment>', `
{
  vec4 em = textureGrad(emissiveMap, rfAuv, rfGx, rfGy);
  float h = rf_hash12(floor(vCellUv) + vec2(vSeed * 1.37, vSeed * 0.71));
  float lit = step(h, uLitRatio);
  float warm = rf_hash12(floor(vCellUv) * 1.7 + vSeed);
  totalEmissiveRadiance *= em.rgb * lit * mix(vec3(1.0), vec3(0.75, 0.9, 1.25), step(0.8, warm));
}`);
    };
    this.facade.customProgramCacheKey = () => 'rf-facade';

    this.tree = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.tree.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 1.3;
  float sw = (sin(uTime * 1.4 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.7)) * 0.012 * max(position.y - 0.3, 0.0);
  transformed.x += sw;
  transformed.z += sw * 0.6;
#endif`);
    };
    this.tree.customProgramCacheKey = () => 'rf-tree';

    this.body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
    this.glass = new THREE.MeshStandardMaterial({ color: 0x1b2730, roughness: 0.12, metalness: 0.6, emissive: new THREE.Color(1, 0.85, 0.55), emissiveIntensity: 0 });
    this.lamp = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.ghost = new THREE.MeshBasicMaterial({ color: 0x55ff88, transparent: true, opacity: 0.55, depthWrite: false });
    const glowTex = createGlowTexture();
    this.glow = new THREE.PointsMaterial({ map: glowTex, color: 0xffd9a0, size: 0.85, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.headlight = new THREE.PointsMaterial({ map: glowTex, color: 0xfff2d0, size: 0.3, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    // static world: one material for all static surfaces. Cells 0..15 = procedural world atlas (map),
    // cells >= 16 = facade atlas (uFacMap/uFacEm, lit windows at night); ground pieces sit slightly above
    // graded terrain, so pull them forward in depth.
    const S = ATLAS_SIZE, A = ATLAS;
    const f = (x: number) => x.toFixed(6);
    const STRIDE = f((A.content + 2 * A.gutter) / S), PAD = f(A.gutter / S), CONT = f(A.content / S);
    this.world = new THREE.MeshStandardMaterial({ vertexColors: true, map: createWorldAtlas(), roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const facEm = this.facEmissive;
    this.world.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = U.uNight;
      sh.uniforms.uLitRatio = U.uLitRatio;
      sh.uniforms.uCellRough = { value: CELL_ROUGH };
      sh.uniforms.uCellMetal = { value: CELL_METAL };
      sh.uniforms.uFacMap = { value: atlas.color };
      sh.uniforms.uFacEm = { value: atlas.emissive };
      sh.uniforms.uFacEmissive = facEm;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aCell; attribute float aSeed;
varying float vRfCell; varying float vRfSeed; varying vec2 vRfUv;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vRfCell = aCell; vRfSeed = aSeed; vRfUv = uv;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uNight; uniform float uLitRatio; uniform float uCellRough[16]; uniform float uCellMetal[16];
uniform sampler2D uFacMap; uniform sampler2D uFacEm; uniform vec3 uFacEmissive;
varying float vRfCell; varying float vRfSeed; varying vec2 vRfUv;
${NOISE_GLSL}`)
        .replace('#include <map_fragment>', `
int rfCi = int(vRfCell + 0.5);
vec2 rfGx = dFdx(vRfUv), rfGy = dFdy(vRfUv);
vec2 rfCuv = fract(vRfUv);
vec3 rfEm = vec3(0.0);
vec4 rfTex;
float rfRough, rfMetal;
if (rfCi >= 16) {
  int rfF = rfCi - 16;
  vec2 rfFc = vec2(float(rfF % ${ATLAS_CELLS}), float(rfF / ${ATLAS_CELLS}));
  vec2 rfFuv = vec2((rfFc.x + rfCuv.x) / ${ATLAS_CELLS.toFixed(1)}, 1.0 - (rfFc.y + 1.0 - rfCuv.y) / ${ATLAS_CELLS.toFixed(1)});
  rfTex = textureGrad(uFacMap, rfFuv, rfGx / ${ATLAS_CELLS.toFixed(1)}, rfGy / ${ATLAS_CELLS.toFixed(1)});
  vec4 rfE = textureGrad(uFacEm, rfFuv, rfGx / ${ATLAS_CELLS.toFixed(1)}, rfGy / ${ATLAS_CELLS.toFixed(1)});
  float rfH = rf_hash12(floor(vRfUv) + vec2(vRfSeed * 1.37, vRfSeed * 0.71));
  float rfWarm = rf_hash12(floor(vRfUv) * 1.7 + vRfSeed);
  rfEm = uFacEmissive * rfE.rgb * step(rfH, uLitRatio) * mix(vec3(1.0), vec3(0.75, 0.9, 1.25), step(0.8, rfWarm));
  rfRough = 0.72; rfMetal = 0.05;
} else {
  vec2 rfCell = vec2(float(rfCi % ${A.cols}), float(rfCi / ${A.cols}));
  rfTex = textureGrad(map, rfCell * ${STRIDE} + ${PAD} + rfCuv * ${CONT}, rfGx * ${CONT}, rfGy * ${CONT});
  rfRough = uCellRough[rfCi]; rfMetal = uCellMetal[rfCi];
}
diffuseColor *= rfTex;`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rfRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = rfMetal;')
        .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance = rfEm;
if (rfCi == ${WC.LAMP}) totalEmissiveRadiance += diffuseColor.rgb * uNight * 2.6;`);
    };
    this.world.customProgramCacheKey = () => 'rf-world';
    this.worldDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.worldDepth.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCast;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nif (aCast < 0.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);');
    };
    this.worldDepth.customProgramCacheKey = () => 'rf-world-depth';
    this.extra = [this.world];
  }

  update(time: number, night: number) {
    this.uniforms.uTime.value = time;
    this.uniforms.uNight.value = night;
    this.facade.emissiveIntensity = night * 1.25;
    this.facEmissive.value.setRGB(1.0 * night * 1.25, 0.72 * night * 1.25, 0.38 * night * 1.25);
    this.glow.opacity = night * 0.9;
    this.glow.visible = night > 0.02;
    this.headlight.opacity = night;
    this.headlight.visible = night > 0.02;
    this.glass.emissiveIntensity = night * 0.35;
  }
}
