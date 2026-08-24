import { LIQUID_FRAGMENT_GLSL, LIQUID_VERTEX_GLSL } from './shaders';
import type { SurfaceDrawState, SurfaceGpuEngine } from './engine';

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, LIQUID_VERTEX_GLSL);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, LIQUID_FRAGMENT_GLSL);
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

export function createWebGl2Engine(canvas: HTMLCanvasElement): SurfaceGpuEngine | null {
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
  if (!gl) return null;

  const program = createProgram(gl);
  const buffer = gl.createBuffer();
  if (!program || !buffer) {
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
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

  return {
    label: 'webgl2',
    resize(width, height) {
      gl.viewport(0, 0, width, height);
    },
    draw(state: SurfaceDrawState) {
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, state.pointerX, state.pointerY);
      if (uniforms.time) gl.uniform1f(uniforms.time, state.time);
      if (uniforms.hover) gl.uniform1f(uniforms.hover, state.hover);
      if (uniforms.pulse) gl.uniform1f(uniforms.pulse, state.pulse);
      if (uniforms.quality) gl.uniform1f(uniforms.quality, state.quality);
      if (uniforms.variant) gl.uniform1f(uniforms.variant, state.variant);
      if (uniforms.theme) gl.uniform1f(uniforms.theme, state.theme);
      if (uniforms.intensity) gl.uniform1f(uniforms.intensity, state.intensity * state.mix);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
