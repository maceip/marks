import { LIQUID_WGSL } from './shaders';
import type { SurfaceDrawState, SurfaceGpuEngine } from './engine';

interface GpuNavigator {
  gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null>;
    getPreferredCanvasFormat(): string;
  };
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}

interface GpuDevice {
  createShaderModule(descriptor: { code: string }): GpuShaderModule;
  createBindGroupLayout(descriptor: object): GpuBindGroupLayout;
  createPipelineLayout(descriptor: object): GpuPipelineLayout;
  createRenderPipeline(descriptor: object): GpuRenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createBindGroup(descriptor: object): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: BufferSource): void; submit(commandBuffers: GpuCommandBuffer[]): void };
  lost: Promise<{ reason?: string }>;
  destroy(): void;
}

interface GpuShaderModule { }
interface GpuBindGroupLayout { }
interface GpuPipelineLayout { }
interface GpuRenderPipeline { getBindGroupLayout(index: number): GpuBindGroupLayout }
interface GpuBuffer { }
interface GpuBindGroup { }
interface GpuCommandBuffer { }
interface GpuCommandEncoder {
  beginRenderPass(descriptor: object): GpuRenderPass;
  finish(): GpuCommandBuffer;
}
interface GpuRenderPass {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}
interface GpuCanvasContext {
  configure(descriptor: object): void;
  getCurrentTexture(): { createView(): object };
  unconfigure(): void;
}

const BUFFER_SIZE = 48;
const UNIFORM_USAGE = 0x0040 | 0x0008;

export { canUseWebGpu } from './detect';

export async function createWebGpuEngine(canvas: HTMLCanvasElement): Promise<SurfaceGpuEngine | null> {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu) return null;

  let adapter: GpuAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  if (!adapter) return null;

  let device: GpuDevice;
  try {
    device = await adapter.requestDevice();
  } catch {
    return null;
  }

  const context = canvas.getContext('webgpu') as unknown as GpuCanvasContext | null;
  if (!context) {
    device.destroy();
    return null;
  }

  const format = gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
    usage: 0x10,
  });

  let pipeline: GpuRenderPipeline;
  let buffer: GpuBuffer;
  let bindGroup: GpuBindGroup;
  try {
    const module = device.createShaderModule({ code: LIQUID_WGSL });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    buffer = device.createBuffer({ size: BUFFER_SIZE, usage: UNIFORM_USAGE });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });
  } catch {
    context.unconfigure();
    device.destroy();
    return null;
  }

  const uniforms = new Float32Array(12);
  let lost = false;
  void device.lost.then(() => {
    lost = true;
  });

  return {
    label: 'webgpu',
    resize() {
      if (lost) return;
      context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
        usage: 0x10,
      });
    },
    draw(state: SurfaceDrawState) {
      if (lost) return;
      uniforms[0] = canvas.width;
      uniforms[1] = canvas.height;
      uniforms[2] = state.pointerX;
      uniforms[3] = state.pointerY;
      uniforms[4] = state.time;
      uniforms[5] = state.hover;
      uniforms[6] = state.pulse;
      uniforms[7] = state.quality;
      uniforms[8] = state.variant;
      uniforms[9] = state.theme;
      uniforms[10] = state.intensity;
      uniforms[11] = state.mix;
      device.queue.writeBuffer(buffer, 0, uniforms);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    dispose() {
      lost = true;
      try {
        context.unconfigure();
        device.destroy();
      } catch {
        // Device may already be lost.
      }
    },
  };
}
