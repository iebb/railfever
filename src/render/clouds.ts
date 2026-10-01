// Drifting cloud shadows: attenuates direct sunlight using a world-space noise field.
import * as THREE from 'three';
import { NOISE_GLSL } from './shaders';

export const cloudUniforms = {
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudStrength: { value: 0.5 },
};

/** Chain cloud-shadow shader code onto a material (keeps any existing onBeforeCompile). */
export function applyClouds(mat: THREE.Material, needsNoise = true) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.uCloudOffset = cloudUniforms.uCloudOffset;
    sh.uniforms.uCloudStrength = cloudUniforms.uCloudStrength;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRfCloudPos;')
      .replace('#include <project_vertex>', `{
  vec4 rfWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  rfWp = instanceMatrix * rfWp;
  #endif
  vRfCloudPos = (modelMatrix * rfWp).xyz;
}
#include <project_vertex>`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec2 uCloudOffset; uniform float uCloudStrength;
varying vec3 vRfCloudPos;
${needsNoise && !sh.fragmentShader.includes('rf_fbm') ? NOISE_GLSL : ''}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  float rfCl = smoothstep(0.5, 0.7, rf_fbm(vRfCloudPos.xz * 0.016 + uCloudOffset));
  float rfK = 1.0 - rfCl * uCloudStrength;
  reflectedLight.directDiffuse *= rfK;
  reflectedLight.directSpecular *= rfK;
}`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|clouds';
  mat.needsUpdate = true;
}
