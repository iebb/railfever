// Drifting cloud shadows: attenuates direct sunlight using a world-space noise field (~1 km clouds).
import * as THREE from 'three';
import { NOISE_GLSL } from './shaders';

export const cloudUniforms = {
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudStrength: { value: 0.5 },
};

/**
 * Received-shadow fade shared by every world material (set by the renderer each frame): towards the edge of the
 * shadow box when a wide view clamps it around the focus (uShadowEdge 0..1), and with view distance before the
 * shadow footprint ends (uShadowDist: start, end), so shadows never stop at a hard line or square.
 */
export const shadowFadeUniforms = {
  uShadowEdge: { value: 0 },
  uShadowDist: { value: new THREE.Vector2(1e5, 2e5) },
};
const SHADOW_CALL = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
const LIGHTS_FADED = THREE.ShaderChunk.lights_fragment_begin.replace(SHADOW_CALL, `mix( ${SHADOW_CALL}, 1.0, rfShadowFade( vDirectionalShadowCoord[ i ], length( vViewPosition ) ) )`);

/** Chain cloud-shadow (and shadow-fade) shader code onto a material (keeps any existing onBeforeCompile). */
export function applyClouds(mat: THREE.Material, needsNoise = true) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.uCloudOffset = cloudUniforms.uCloudOffset;
    sh.uniforms.uCloudStrength = cloudUniforms.uCloudStrength;
    sh.uniforms.uShadowEdge = shadowFadeUniforms.uShadowEdge;
    sh.uniforms.uShadowDist = shadowFadeUniforms.uShadowDist;
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
uniform float uShadowEdge; uniform vec2 uShadowDist;
varying vec3 vRfCloudPos;
float rfShadowFade(vec4 sc, float d) {
  vec2 e = abs(sc.xy / sc.w * 2.0 - 1.0);
  return max(uShadowEdge * smoothstep(0.55, 0.96, max(e.x, e.y)), smoothstep(uShadowDist.x, uShadowDist.y, d));
}
${needsNoise && !sh.fragmentShader.includes('rf_fbm') ? NOISE_GLSL : ''}`)
      .replace('#include <lights_fragment_begin>', LIGHTS_FADED)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  float rfCl = smoothstep(0.5, 0.7, rf_fbm(vRfCloudPos.xz * 0.0085 + uCloudOffset));
  float rfK = 1.0 - rfCl * uCloudStrength;
  reflectedLight.directDiffuse *= rfK;
  reflectedLight.directSpecular *= rfK;
}`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|clouds2';
  mat.needsUpdate = true;
}
