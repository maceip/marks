export interface SurfaceDrawState {
  pointerX: number;
  pointerY: number;
  time: number;
  hover: number;
  pulse: number;
  quality: number;
  variant: number;
  theme: number;
  intensity: number;
  mix: number;
}

export interface SurfaceGpuEngine {
  label: 'webgpu' | 'webgl2';
  resize(width: number, height: number): void;
  draw(state: SurfaceDrawState): void;
  dispose(): void;
}
