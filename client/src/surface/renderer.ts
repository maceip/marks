import { surfaceRuntime, type SurfaceFrame } from './runtime';

export type SurfaceMaterialVariant = 'chrome' | 'floating' | 'panel' | 'hero';

export interface SurfaceMaterialOptions {
  variant?: SurfaceMaterialVariant;
  intensity?: number;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
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

  float edge_distance = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
  float rim = 1.0 - smoothstep(0.0, 0.075, edge_distance);
  float top_lip = (1.0 - smoothstep(0.0, 0.12, 1.0 - v_uv.y)) * (0.62 + 0.38 * flow);

  float pointer_distance = length(plane - pointer);
  float pointer_light = exp(-pointer_distance * pointer_distance * 7.5) * u_hover;
  float pulse_ring = exp(-abs(pointer_distance - (0.08 + u_pulse * 0.31)) * 32.0) * u_pulse;

  vec3 light_blue = mix(vec3(0.34, 0.55, 1.0), vec3(0.40, 0.62, 1.0), u_theme);
  vec3 mint = mix(vec3(0.30, 0.92, 0.73), vec3(0.20, 0.94, 0.67), u_theme);
  vec3 pearl = mix(vec3(1.0, 1.0, 1.0), vec3(0.80, 0.88, 1.0), u_theme);
  vec3 tint = mix(light_blue, mint, smoothstep(0.28, 0.78, flow));
  tint = mix(tint, pearl, rim * 0.48 + pointer_light * 0.56);

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
    rim * 0.082 +
    top_lip * 0.064 +
    pointer_light * 0.12 +
    pulse_ring * 0.10
  ) * variant_strength * u_intensity;

  alpha *= mix(1.0, 0.86, u_theme);
  alpha = clamp(alpha, 0.0, 0.34);
  out_color = vec4(tint * alpha, alpha);
}`;

const VARIANT_VALUE: Record<SurfaceMaterialVariant, number> = {
  chrome: 0,
  floating: 1,
  panel: 2,
  hero: 3,
};

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
}

function setUniform(gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, value: number) {
  if (location) gl.uniform1f(location, value);
}

export function attachSurfaceMaterial(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  { variant = 'panel', intensity = 1 }: SurfaceMaterialOptions = {},
): () => void {
    if (!surfaceRuntime.supportsShader) return () => undefined;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) {
      surfaceRuntime.disableShader();
      return () => undefined;
    }

    const program = createProgram(gl);
    const buffer = gl.createBuffer();
    if (!program || !buffer) {
      if (program) gl.deleteProgram(program);
      if (buffer) gl.deleteBuffer(buffer);
      surfaceRuntime.disableShader();
      return () => undefined;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      pointer: gl.getUniformLocation(program, 'u_pointer'),
      time: gl.getUniformLocation(program, 'u_time'),
      hover: gl.getUniformLocation(program, 'u_hover'),
      pulse: gl.getUniformLocation(program, 'u_pulse'),
      quality: gl.getUniformLocation(program, 'u_quality'),
      variant: gl.getUniformLocation(program, 'u_variant'),
      theme: gl.getUniformLocation(program, 'u_theme'),
      intensity: gl.getUniformLocation(program, 'u_intensity'),
    };

    let visible = true;
    let enabled = true;
    let width = 0;
    let height = 0;
    let profile = -1;
    let hostBounds = host.getBoundingClientRect();
    let pointerX = 0.22;
    let pointerY = 0.78;
    let targetX = pointerX;
    let targetY = pointerY;
    let hover = 0;
    let hoverTarget = 0;
    let pulse = 0;
    let firstFrame = true;
    let frozenTime = 0;

    const applyPreferences = () => {
      enabled =
        document.documentElement.dataset.glass !== 'reduced' &&
        !matchMedia('(prefers-reduced-transparency: reduce)').matches;
      if (!enabled) canvas.removeAttribute('data-ready');
      surfaceRuntime.invalidate();
    };

    const resize = (quality: number) => {
      const nextWidth = Math.max(1, Math.round(hostBounds.width));
      const nextHeight = Math.max(1, Math.round(hostBounds.height));
      const nextProfile = quality > 1.48 ? 2 : quality > 0.8 ? 1 : 0;
      if (
        nextWidth === width &&
        nextHeight === height &&
        nextProfile === profile &&
        canvas.width > 0
      ) return;

      width = nextWidth;
      height = nextHeight;
      profile = nextProfile;
      const deviceScale = Math.max(1, devicePixelRatio || 1);
      const scale =
        profile === 2
          ? Math.min(1.6, deviceScale * 0.82)
          : profile === 1
            ? Math.min(1.12, deviceScale * 0.58)
            : Math.min(0.78, deviceScale * 0.44);
      const maximumPixels = profile === 2 ? 1_250_000 : profile === 1 ? 620_000 : 310_000;
      const requestedPixels = width * height * scale * scale;
      const boundedScale =
        requestedPixels > maximumPixels
          ? scale * Math.sqrt(maximumPixels / requestedPixels)
          : scale;

      canvas.width = Math.max(1, Math.round(width * boundedScale));
      canvas.height = Math.max(1, Math.round(height * boundedScale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (frame: SurfaceFrame) => {
      if (!visible || !enabled) return;
      resize(frame.quality);

      const smoothing = frame.active ? 0.17 : 0.08;
      pointerX += (targetX - pointerX) * smoothing;
      pointerY += (targetY - pointerY) * smoothing;
      hover += (hoverTarget - hover) * smoothing;
      pulse *= frame.active ? 0.91 : 0.82;
      if (frame.motion) frozenTime = frame.elapsed;

      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, pointerX, pointerY);
      setUniform(gl, uniforms.time, frozenTime);
      setUniform(gl, uniforms.hover, hover);
      setUniform(gl, uniforms.pulse, pulse);
      setUniform(gl, uniforms.quality, frame.quality);
      setUniform(gl, uniforms.variant, VARIANT_VALUE[variant]);
      setUniform(
        gl,
        uniforms.theme,
        document.documentElement.dataset.theme === 'dark' ? 1 : 0,
      );
      setUniform(gl, uniforms.intensity, intensity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (firstFrame) {
        firstFrame = false;
        canvas.dataset.ready = 'true';
      }
    };

    const pointerMove = (event: PointerEvent) => {
      targetX = Math.min(1, Math.max(0, (event.clientX - hostBounds.left) / hostBounds.width));
      targetY = 1 - Math.min(1, Math.max(0, (event.clientY - hostBounds.top) / hostBounds.height));
      surfaceRuntime.activate();
    };
    const pointerEnter = () => {
      hostBounds = host.getBoundingClientRect();
      hoverTarget = 1;
      surfaceRuntime.activate();
    };
    const pointerLeave = () => {
      hoverTarget = 0;
      surfaceRuntime.activate(850);
    };
    const pointerDown = () => {
      pulse = 1;
      surfaceRuntime.activate(1_600);
    };
    const contextLost = () => {
      enabled = false;
      canvas.removeAttribute('data-ready');
      surfaceRuntime.disableShader();
    };

    const resizeObserver = new ResizeObserver(() => {
      hostBounds = host.getBoundingClientRect();
      width = 0;
      surfaceRuntime.invalidate();
    });
    resizeObserver.observe(host);
    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      if (visible) surfaceRuntime.invalidate();
    });
    intersectionObserver.observe(host);
    const preferenceObserver = new MutationObserver(applyPreferences);
    preferenceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-glass', 'data-motion', 'data-theme'],
    });

    host.addEventListener('pointermove', pointerMove, { passive: true });
    host.addEventListener('pointerenter', pointerEnter, { passive: true });
    host.addEventListener('pointerleave', pointerLeave, { passive: true });
    host.addEventListener('pointerdown', pointerDown, { passive: true });
    canvas.addEventListener('webglcontextlost', contextLost);
    applyPreferences();
    const unsubscribe = surfaceRuntime.subscribe(draw);

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      preferenceObserver.disconnect();
      host.removeEventListener('pointermove', pointerMove);
      host.removeEventListener('pointerenter', pointerEnter);
      host.removeEventListener('pointerleave', pointerLeave);
      host.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('webglcontextlost', contextLost);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
}

export function mountSurfaceMaterial(
  host: HTMLElement,
  options: SurfaceMaterialOptions = {},
): () => void {
  const variant = options.variant ?? 'panel';
  const canvas = document.createElement('canvas');
  canvas.className = `surface-material-canvas surface-material-${variant}`;
  canvas.setAttribute('aria-hidden', 'true');
  host.classList.add('surface-material-host');
  host.prepend(canvas);
  const detach = attachSurfaceMaterial(canvas, host, options);

  return () => {
    detach();
    canvas.remove();
  };
}
