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
  /** view distances over which the near shadow cascade hands over to the far one */
  uCascade: { value: new THREE.Vector2(1e5, 2e5) },
};
const SHADOW_CALL = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
const SHADOW_LINE = `directLight.color *= ( directLight.visible && receiveShadow ) ? ${SHADOW_CALL} : 1.0;`;
/**
 * Directional shadows: with two shadow-casting directional lights, light 0 (the sun) samples the near cascade
 * (its own map) and the far cascade (light 1's map) by view distance; light 1 carries no light and is skipped.
 * Single map otherwise. Both fade out (rfShadowFade) before the shadow footprint ends. (No braces here: the
 * code sits inside three's unrolled light loop.)
 */
const CASCADED = `#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		float rfVd = length( vViewPosition );
		vec3 rfNearCoord = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
		rfNearCoord.z += directionalLightShadow.shadowBias;
		bool rfNearInside = all( greaterThanEqual( rfNearCoord, vec3( 0.0 ) ) ) && all( lessThanEqual( rfNearCoord, vec3( 1.0 ) ) );
		float rfCk = rfNearInside ? smoothstep( uCascade.x, uCascade.y, rfVd ) : 1.0;
		float rfS0 = rfCk < 1.0 ? getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
		float rfS1 = rfCk > 0.0 ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
		directLight.color *= ( directLight.visible && receiveShadow ) ? mix( mix( rfS0, rfS1, rfCk ), 1.0, rfShadowFade( vDirectionalShadowCoord[ 1 ], rfVd ) ) : 1.0;
		#else
		directLight.color *= ( directLight.visible && receiveShadow ) ? mix( ${SHADOW_CALL}, 1.0, rfShadowFade( vDirectionalShadowCoord[ i ], length( vViewPosition ) ) ) : 1.0;
		#endif`;
function cascadedLights(): string {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const a = src.indexOf('directionalLight = directionalLights[ i ];');
  const re = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const b = src.indexOf(re, a);
  if (a < 0 || b < 0 || src.indexOf(SHADOW_LINE, a) < 0 || src.indexOf(SHADOW_LINE, a) > b) return src;
  const head = 'directionalLight = directionalLights[ i ];';
  const body = src.slice(a + head.length, b + re.length).replace(SHADOW_LINE, CASCADED);
  return src.slice(0, a) + head + `
		#if !( ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 ) )` + body + `
		#endif` + src.slice(b + re.length);
}
const LIGHTS_FADED = cascadedLights();

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
    sh.uniforms.uCascade = shadowFadeUniforms.uCascade;
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
uniform float uShadowEdge; uniform vec2 uShadowDist; uniform vec2 uCascade;
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
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|clouds4';
  mat.needsUpdate = true;
}
