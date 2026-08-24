import {
  nextLowerTier,
  prefersGpuEngine,
  selectInitialTier,
  shaderMixForQuality,
  TIER_SCORE,
  type SurfaceTier,
} from './runtime-policy';
import { canUseWebGpu } from './detect';

export type { SurfaceTier } from './runtime-policy';

export interface SurfaceFrame {
  now: number;
  elapsed: number;
  quality: number;
  mix: number;
  motion: boolean;
  active: boolean;
}

type SurfaceFrameListener = (frame: SurfaceFrame) => void;

interface NavigatorHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

const SESSION_TIER_KEY = 'marks:surface-tier:v1';

function media(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

function storedTier(): SurfaceTier | null {
  try {
    const value = sessionStorage.getItem(SESSION_TIER_KEY);
    return value === 'opaque' || value === 'foundation' || value === 'balanced' || value === 'cinematic'
      ? value
      : null;
  } catch {
    return null;
  }
}

function rememberTier(tier: SurfaceTier) {
  try {
    sessionStorage.setItem(SESSION_TIER_KEY, tier);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function detectTier(): SurfaceTier {
  const nav = navigator as NavigatorHints;
  const coarsePointer = media('(pointer: coarse)');
  const css = globalThis.CSS;
  const backdropFilter = Boolean(css?.supports?.('backdrop-filter', 'blur(1px)') || css?.supports?.('-webkit-backdrop-filter', 'blur(1px)'));
  const detected = selectInitialTier({
    coarsePointer,
    cores: nav.hardwareConcurrency || 4,
    memoryGb: nav.deviceMemory ?? (coarsePointer ? 4 : 8),
    pixelCost: innerWidth * innerHeight * Math.max(1, devicePixelRatio ** 2),
    saveData: Boolean(nav.connection?.saveData),
    reducedTransparency: media('(prefers-reduced-transparency: reduce)'),
    reducedGlass: document.documentElement.dataset.glass === 'reduced',
    webgl2: typeof WebGL2RenderingContext !== 'undefined',
    webgpu: canUseWebGpu(),
    backdropFilter,
  });
  const remembered = storedTier();
  return remembered && TIER_SCORE[remembered] < TIER_SCORE[detected] ? remembered : detected;
}

function motionAllowed(): boolean {
  return (
    document.documentElement.dataset.motion !== 'reduced' &&
    !media('(prefers-reduced-motion: reduce)')
  );
}

/**
 * One clock drives every material canvas. Cost adapts by interpolating quality
 * and shader mix; CSS frost stays painted so a stressed device never pops from
 * liquid glass to a flat fill in a single frame.
 */
class SurfaceRuntime {
  private currentTier: SurfaceTier;
  private listeners = new Set<SurfaceFrameListener>();
  private shaderAvailable: boolean;
  private webgpuPreferred: boolean;
  private frameHandle: number | null = null;
  private timerHandle: number | null = null;
  private startedAt = performance.now();
  private lastPresentedAt = 0;
  private lastTickAt = this.startedAt;
  private activeUntil = this.startedAt + 1_200;
  private quality: number;
  private qualityTarget: number;
  private slowPressure = 0;
  private lastAdaptedAt = this.startedAt;
  private failures = 0;

  constructor() {
    this.currentTier = detectTier();
    this.webgpuPreferred = this.currentTier === 'cinematic' && canUseWebGpu();
    this.shaderAvailable = this.currentTier === 'balanced' || this.currentTier === 'cinematic';
    this.quality = TIER_SCORE[this.currentTier];
    this.qualityTarget = this.quality;
    this.publishRoot();
    rememberTier(this.currentTier);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.invalidate();
    });
    visualViewport?.addEventListener('resize', () => {
      const keyboard = innerHeight - (visualViewport?.height ?? innerHeight) > 120;
      if (keyboard) this.cancel();
      else this.invalidate();
    });
  }

  get label(): string {
    if (!this.shaderAvailable || this.qualityTarget < 0.2) return 'Efficient frosted';
    if (this.currentTier === 'cinematic' && this.webgpuPreferred) return 'Cinematic WebGPU';
    if (this.currentTier === 'cinematic') return 'Cinematic GPU';
    if (this.currentTier === 'balanced') return 'Adaptive GPU';
    return 'Efficient frosted';
  }

  get supportsShader(): boolean {
    return this.shaderAvailable;
  }

  get prefersWebGpu(): boolean {
    return this.webgpuPreferred;
  }

  /** Keep canvases mounted. Mix fades with quality so CSS gaussian frost remains. */
  disableShader() {
    this.soften('preference');
  }

  noteEngineFailure() {
    this.failures += 1;
    if (this.webgpuPreferred) {
      this.webgpuPreferred = false;
      this.publishRoot();
      return;
    }
    this.soften('context-lost');
  }

  soften(reason: 'pressure' | 'context-lost' | 'preference' = 'pressure') {
    const next = reason === 'preference' && this.currentTier !== 'opaque'
      ? 'foundation'
      : nextLowerTier(this.currentTier);
    if (next === this.currentTier && this.qualityTarget === TIER_SCORE[next]) return;
    this.currentTier = next;
    this.qualityTarget = TIER_SCORE[next];
    this.slowPressure = 0;
    this.lastAdaptedAt = performance.now();
    if (next === 'opaque') this.qualityTarget = 0;
    if (next === 'foundation' || next === 'opaque') this.webgpuPreferred = false;
    document.documentElement.dataset.surfaceLoad = reason === 'pressure' ? 'tempered' : reason;
    this.publishRoot();
    rememberTier(next);
    this.invalidate();
  }

  subscribe(listener: SurfaceFrameListener): () => void {
    if (!this.supportsShader) return () => undefined;
    this.listeners.add(listener);
    this.invalidate();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.cancel();
    };
  }

  activate(duration = 1_250) {
    this.activeUntil = Math.max(this.activeUntil, performance.now() + duration);
    this.invalidate();
  }

  invalidate() {
    if (!this.supportsShader || this.listeners.size === 0 || this.frameHandle !== null) return;
    if (this.timerHandle !== null) {
      window.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  private publishRoot() {
    const root = document.documentElement;
    root.dataset.surfaceTier = this.currentTier;
    const engine = this.qualityTarget < 0.2
      ? 'css'
      : prefersGpuEngine(this.currentTier, this.webgpuPreferred);
    root.dataset.surfaceEngine = engine;
    root.style.setProperty('--surface-quality', this.quality.toFixed(3));
    root.style.setProperty('--material-shader-mix', shaderMixForQuality(this.quality).toFixed(3));
  }

  private cancel() {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    if (this.timerHandle !== null) window.clearTimeout(this.timerHandle);
    this.frameHandle = null;
    this.timerHandle = null;
  }

  private schedule(delay: number) {
    if (this.listeners.size === 0 || document.visibilityState !== 'visible') return;
    if (delay <= 2) {
      this.frameHandle = requestAnimationFrame(this.tick);
      return;
    }
    this.timerHandle = window.setTimeout(() => {
      this.timerHandle = null;
      this.frameHandle = requestAnimationFrame(this.tick);
    }, delay);
  }

  private readonly tick = (now: number) => {
    this.frameHandle = null;
    if (this.listeners.size === 0 || document.visibilityState !== 'visible') return;
    if (document.documentElement.dataset.glass === 'reduced') return;

    const active = now < this.activeUntil;
    const motion = motionAllowed();
    const mix = shaderMixForQuality(this.quality);
    const targetFps = motion
      ? active
        ? this.qualityTarget > 1.45
          ? 60
          : 45
        : this.qualityTarget > 1.45
          ? 18
          : 10
      : 0;
    const minimumGap = targetFps ? 1_000 / targetFps : 0;
    const sincePresented = now - this.lastPresentedAt;

    if (targetFps && sincePresented + 1 < minimumGap) {
      this.schedule(minimumGap - sincePresented);
      return;
    }

    const tickDelta = Math.min(100, now - this.lastTickAt);
    this.lastTickAt = now;
    this.lastPresentedAt = now;
    const blend = Math.min(1, tickDelta / 720);
    this.quality += (this.qualityTarget - this.quality) * blend;
    this.publishRoot();

    const frame: SurfaceFrame = {
      now,
      elapsed: (now - this.startedAt) / 1_000,
      quality: this.quality,
      mix,
      motion,
      active,
    };
    for (const listener of this.listeners) listener(frame);

    if (mix <= 0.02 && this.qualityTarget <= 0.02) {
      this.shaderAvailable = false;
      document.documentElement.dataset.surfaceEngine = 'css';
      return;
    }

    if (motion && active && sincePresented < 90) {
      if (sincePresented > 25) this.slowPressure += 1;
      else if (sincePresented < 20) this.slowPressure = Math.max(0, this.slowPressure - 0.35);

      if (
        this.slowPressure > 48 &&
        this.qualityTarget > 0 &&
        now - this.lastAdaptedAt > 12_000
      ) {
        this.soften('pressure');
      }
    }

    if (!motion) return;
    this.schedule(active ? 0 : 1_000 / Math.max(8, targetFps));
  };
}

export const surfaceRuntime = new SurfaceRuntime();
