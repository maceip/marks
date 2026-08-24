/** Procedural liquid-glass shaders. CSS frost remains the invariant surface. */

export const LIQUID_VERTEX_GLSL = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const LIQUID_FRAGMENT_GLSL = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 out_color;

uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform float u_time;
uniform float u_hover;
uniform float u_pulse;
uniform float u_quality;
uniform float u_variant;
uniform float u_theme;
uniform float u_intensity;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float value_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x),
    f.y
  );
}

float liquid_field(vec2 p, float time) {
  float field = value_noise(p + vec2(time * 0.055, -time * 0.035)) * 0.58;
  float middle_mix = smoothstep(0.58, 0.96, u_quality);
  if (u_quality > 0.56) {
    p = mat2(0.80, -0.60, 0.60, 0.80) * p * 2.03;
    field += value_noise(p - vec2(time * 0.07, time * 0.045)) * 0.28 * middle_mix;
  }
  float fine_mix = smoothstep(1.24, 1.72, u_quality);
  if (u_quality > 1.22) {
    p = mat2(0.86, 0.51, -0.51, 0.86) * p * 1.96;
    field += value_noise(p + vec2(-time * 0.09, time * 0.04)) * 0.14 * fine_mix;
  }
  return field;
}

void main() {
  float aspect = max(0.35, u_resolution.x / max(1.0, u_resolution.y));
  vec2 plane = vec2(v_uv.x * aspect, v_uv.y);
  vec2 pointer = vec2(u_pointer.x * aspect, u_pointer.y);
  float time = u_time;

  float flow = liquid_field(plane * vec2(1.35, 2.1) + vec2(0.0, sin(time * 0.13) * 0.08), time);
  float wave = sin((plane.x * 4.8 + plane.y * 3.1) + flow * 4.2 - time * 0.16);
  float caustic = pow(max(0.0, 0.5 + 0.5 * wave), 8.0) * (0.34 + flow * 0.42);
  float frost = value_noise(plane * 18.0 + time * 0.04) * 0.08 * smoothstep(0.4, 1.2, u_quality);

  float edge_distance = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
  float rim = 1.0 - smoothstep(0.0, 0.075, edge_distance);
  float top_lip = (1.0 - smoothstep(0.0, 0.12, 1.0 - v_uv.y)) * (0.62 + 0.38 * flow);
  float fresnel = pow(1.0 - edge_distance, 2.4) * 0.22;

  float pointer_distance = length(plane - pointer);
  float pointer_light = exp(-pointer_distance * pointer_distance * 7.5) * u_hover;
  float pulse_ring = exp(-abs(pointer_distance - (0.08 + u_pulse * 0.31)) * 32.0) * u_pulse;

  vec3 light_blue = mix(vec3(0.34, 0.55, 1.0), vec3(0.40, 0.62, 1.0), u_theme);
  vec3 mint = mix(vec3(0.30, 0.92, 0.73), vec3(0.20, 0.94, 0.67), u_theme);
  vec3 pearl = mix(vec3(1.0, 1.0, 1.0), vec3(0.80, 0.88, 1.0), u_theme);
  vec3 tint = mix(light_blue, mint, smoothstep(0.28, 0.78, flow));
  tint = mix(tint, pearl, rim * 0.48 + pointer_light * 0.56 + fresnel);

  float variant_strength = u_variant < 0.5
    ? 0.78
    : u_variant < 1.5
      ? 1.18
      : u_variant < 2.5
        ? 0.94
        : 1.04;
  float alpha = (
    0.014 +
    caustic * 0.105 +
    frost +
    rim * 0.082 +
    top_lip * 0.064 +
    pointer_light * 0.12 +
    pulse_ring * 0.10
  ) * variant_strength * u_intensity;

  alpha *= mix(1.0, 0.86, u_theme);
  alpha = clamp(alpha, 0.0, 0.34);
  out_color = vec4(tint * alpha, alpha);
}`;

export const LIQUID_WGSL = `
struct Uniforms {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
  hover: f32,
  pulse: f32,
  quality: f32,
  variant: f32,
  theme: f32,
  intensity: f32,
  mix_amount: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let pos = positions[index];
  var out: VertexOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5, 0.5);
  return out;
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn value_noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), f.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), f.x),
    f.y
  );
}

fn liquid_field(start: vec2f, time: f32) -> f32 {
  var p = start;
  var field = value_noise(p + vec2f(time * 0.055, -time * 0.035)) * 0.58;
  let middle_mix = smoothstep(0.58, 0.96, u.quality);
  if (u.quality > 0.56) {
    p = mat2x2f(0.80, -0.60, 0.60, 0.80) * p * 2.03;
    field += value_noise(p - vec2f(time * 0.07, time * 0.045)) * 0.28 * middle_mix;
  }
  let fine_mix = smoothstep(1.24, 1.72, u.quality);
  if (u.quality > 1.22) {
    p = mat2x2f(0.86, 0.51, -0.51, 0.86) * p * 1.96;
    field += value_noise(p + vec2f(-time * 0.09, time * 0.04)) * 0.14 * fine_mix;
  }
  return field;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let aspect = max(0.35, u.resolution.x / max(1.0, u.resolution.y));
  let plane = vec2f(input.uv.x * aspect, input.uv.y);
  let pointer = vec2f(u.pointer.x * aspect, u.pointer.y);
  let time = u.time;
  let flow = liquid_field(plane * vec2f(1.35, 2.1) + vec2f(0.0, sin(time * 0.13) * 0.08), time);
  let wave = sin((plane.x * 4.8 + plane.y * 3.1) + flow * 4.2 - time * 0.16);
  let caustic = pow(max(0.0, 0.5 + 0.5 * wave), 8.0) * (0.34 + flow * 0.42);
  let frost = value_noise(plane * 18.0 + time * 0.04) * 0.08 * smoothstep(0.4, 1.2, u.quality);
  let edge_distance = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  let rim = 1.0 - smoothstep(0.0, 0.075, edge_distance);
  let top_lip = (1.0 - smoothstep(0.0, 0.12, 1.0 - input.uv.y)) * (0.62 + 0.38 * flow);
  let fresnel = pow(1.0 - edge_distance, 2.4) * 0.22;
  let pointer_distance = length(plane - pointer);
  let pointer_light = exp(-pointer_distance * pointer_distance * 7.5) * u.hover;
  let pulse_ring = exp(-abs(pointer_distance - (0.08 + u.pulse * 0.31)) * 32.0) * u.pulse;
  let light_blue = mix(vec3f(0.34, 0.55, 1.0), vec3f(0.40, 0.62, 1.0), u.theme);
  let mint = mix(vec3f(0.30, 0.92, 0.73), vec3f(0.20, 0.94, 0.67), u.theme);
  let pearl = mix(vec3f(1.0, 1.0, 1.0), vec3f(0.80, 0.88, 1.0), u.theme);
  var tint = mix(light_blue, mint, smoothstep(0.28, 0.78, flow));
  tint = mix(tint, pearl, rim * 0.48 + pointer_light * 0.56 + fresnel);
  var variant_strength = 0.94;
  if (u.variant < 0.5) {
    variant_strength = 0.78;
  } else if (u.variant < 1.5) {
    variant_strength = 1.18;
  } else if (u.variant >= 2.5) {
    variant_strength = 1.04;
  }
  var alpha = (
    0.014 +
    caustic * 0.105 +
    frost +
    rim * 0.082 +
    top_lip * 0.064 +
    pointer_light * 0.12 +
    pulse_ring * 0.10
  ) * variant_strength * u.intensity * u.mix_amount;
  alpha *= mix(1.0, 0.86, u.theme);
  alpha = clamp(alpha, 0.0, 0.34);
  return vec4f(tint * alpha, alpha);
}
`;
