import { MATERIAL_RECIPES, type MaterialModifier, type MaterialRecipeName } from '../design-system/materials';
import type { SurfaceGpuEngine } from './engine';
import { surfaceRuntime, type SurfaceFrame } from './runtime';
import { createWebGl2Engine } from './webgl2';

export type SurfaceMaterialVariant = Exclude<MaterialRecipeName, 'opaqueDocument'>;

export interface SurfaceMaterialOptions {
  variant?: SurfaceMaterialVariant;
  modifier?: MaterialModifier;
}

const VARIANT_VALUE: Record<SurfaceMaterialVariant, number> = {
  chrome: 0,
  floating: 1,
  panel: 2,
  hero: 3,
};

export function attachSurfaceMaterial(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  { variant = 'panel', modifier = 'standard' }: SurfaceMaterialOptions = {},
): () => void {
  if (!surfaceRuntime.supportsShader) return () => undefined;

  let disposed = false;
  let detachEngine: (() => void) | undefined;
  let engine: SurfaceGpuEngine | null = null;

  const start = (next: SurfaceGpuEngine | null) => {
    if (disposed) {
      next?.dispose();
      return;
    }
    if (!next) {
      surfaceRuntime.noteEngineFailure();
      return;
    }
    engine = next;
    detachEngine = bindEngine(canvas, host, engine, variant, modifier);
  };

  if (surfaceRuntime.prefersWebGpu) {
    void import('./webgpu').then(({ createWebGpuEngine }) => {
      if (disposed) return;
      return createWebGpuEngine(canvas).then((gpuEngine) => {
        if (gpuEngine) {
          start(gpuEngine);
          return;
        }
        start(createWebGl2Engine(canvas));
      });
    }).catch(() => {
      if (!disposed) start(createWebGl2Engine(canvas));
    });
  } else {
    start(createWebGl2Engine(canvas));
  }

  return () => {
    disposed = true;
    detachEngine?.();
    engine?.dispose();
  };
}

function bindEngine(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  engine: SurfaceGpuEngine,
  variant: SurfaceMaterialVariant,
  modifier: MaterialModifier,
): () => void {
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
    if (nextWidth === width && nextHeight === height && nextProfile === profile && canvas.width > 0) return;

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
    engine.resize(canvas.width, canvas.height);
  };

  const draw = (frame: SurfaceFrame) => {
    if (!visible || !enabled || frame.mix <= 0.01) {
      if (frame.mix <= 0.01) canvas.removeAttribute('data-ready');
      return;
    }
    resize(frame.quality);

    const smoothing = frame.active ? 0.17 : 0.08;
    pointerX += (targetX - pointerX) * smoothing;
    pointerY += (targetY - pointerY) * smoothing;
    hover += (hoverTarget - hover) * smoothing;
    pulse *= frame.active ? 0.91 : 0.82;
    if (frame.motion) frozenTime = frame.elapsed;

    const modifierScale = modifier === 'subtle' ? 0.86 : modifier === 'emphasized' ? 1.12 : 1;
    engine.draw({
      pointerX,
      pointerY,
      time: frozenTime,
      hover,
      pulse,
      quality: frame.quality,
      variant: VARIANT_VALUE[variant],
      theme: document.documentElement.dataset.theme === 'dark' ? 1 : 0,
      intensity: MATERIAL_RECIPES[variant].shaderIntensity * modifierScale,
      mix: frame.mix,
    });

    if (firstFrame) {
      firstFrame = false;
      canvas.dataset.ready = 'true';
      canvas.dataset.engine = engine.label;
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
  const contextLost = (event: Event) => {
    event.preventDefault();
    enabled = false;
    canvas.removeAttribute('data-ready');
    surfaceRuntime.noteEngineFailure();
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
    engine.dispose();
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
