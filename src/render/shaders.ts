// Shared GLSL snippets.

export const NOISE_GLSL = /* glsl */ `
float rf_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rf_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rf_hash12(i), rf_hash12(i + vec2(1.0, 0.0)), u.x),
             mix(rf_hash12(i + vec2(0.0, 1.0)), rf_hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float rf_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * rf_vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
vec3 rf_srgb(vec3 c) { return pow(c, vec3(2.2)); }
`;
