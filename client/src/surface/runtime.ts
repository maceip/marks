export type SurfaceTier = 'foundation' | 'balanced' | 'cinematic';

export interface SurfaceFrame {
  now: number;
  elapsed: number;
  quality: number;
  motion: boolean;
  active: boolean;
}

type SurfaceFrameListener = (frame: SurfaceFrame) => void;

interface NavigatorHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

const SESSION_TIER_KEY = 'marks:surface-tier:v1';
const TIER_SCORE: Record<SurfaceTier, number> = {
  foundation: 0,
  balanced: 1,
  cinematic: 2,
};

function media(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

function storedTier(): SurfaceTier | null {
  try {
    const value = sessionStorage.getItem(SESSION_TIER_KEY);
    return value === 'foundation' || value === 'balanced' || value === 'cinematic'
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
  const reducedTransparency = media('(prefers-reduced-transparency: reduce)');
  const saveData = Boolean(nav.connection?.saveData);
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined';

  if (reducedTransparency || saveData || !webgl2) return 'foundation';

  const remembered = storedTier();
  if (remembered) return remembered;

  const cores = nav.hardwareConcurrency || 4;
  const finePointer = media('(pointer: fine)');
  const memory = nav.deviceMemory ?? (finePointer ? 8 : 4);
  const pixelCost = innerWidth * innerHeight * Math.max(1, devicePixelRatio ** 2);

  if (finePointer && cores >= 8 && memory >= 8 && pixelCost <= 10_000_000) {
    return 'cinematic';
  }

  if (cores >= 4 && memory >= 4) return 'balanced';
  return 'foundation';
}

function motionAllowed(): boolean {
  return (
    document.documentElement.dataset.motion !== 'reduced' &&
    !media('(prefers-reduced-motion: reduce)')
  );
}

/**
 * One clock drives every material canvas. It deliberately adapts cost rather
 * than appearance: a downgrade lowers cadence, backing resolution and shader
 * octaves while the CSS glass recipe remains unchanged.
 */
class SurfaceRuntime {
  readonly tier: SurfaceTier;

  private listeners = new Set<SurfaceFrameListener>();
  private shaderAvailable: boolean;
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

  constructor() {
    this.tier = detectTier();
    this.shaderAvailable = this.tier !== 'foundation';
    this.quality = TIER_SCORE[this.tier];
    this.qualityTarget = this.quality;

    const root = document.documentElement;
    root.dataset.surfaceTier = this.tier;
    root.dataset.surfaceEngine = this.supportsShader ? 'webgl2' : 'css';
    rememberTier(this.tier);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.invalidate();
    });
  }

  get label(): string {
    if (!this.shaderAvailable) return 'Efficient frosted';
    if (this.tier === 'cinematic') return 'Cinematic GPU';
    if (this.tier === 'balanced') return 'Adaptive GPU';
    return 'Efficient frosted';
  }

  get supportsShader(): boolean {
    return this.shaderAvailable;
  }

  disableShader() {
    if (!this.shaderAvailable) return;
    this.shaderAvailable = false;
    this.cancel();
    document.documentElement.dataset.surfaceEngine = 'css';
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

    const frame: SurfaceFrame = {
      now,
      elapsed: (now - this.startedAt) / 1_000,
      quality: this.quality,
      motion,
      active,
    };
    for (const listener of this.listeners) listener(frame);

    // Hysteresis makes adaptation intentionally slow and one-way within a
    // session. The visible material stays constant; only GPU work tapers.
    if (motion && active && sincePresented < 90) {
      if (sincePresented > 25) this.slowPressure += 1;
      else if (sincePresented < 20) this.slowPressure = Math.max(0, this.slowPressure - 0.35);

      if (
        this.slowPressure > 48 &&
        this.qualityTarget > 0.72 &&
        now - this.lastAdaptedAt > 12_000
      ) {
        this.qualityTarget = Math.max(0.72, this.qualityTarget - 0.65);
        this.slowPressure = 0;
        this.lastAdaptedAt = now;
        document.documentElement.dataset.surfaceLoad = 'tempered';
        rememberTier('balanced');
      }
    }

    if (!motion) return;
    this.schedule(active ? 0 : 1_000 / targetFps);
  };
}

export const surfaceRuntime = new SurfaceRuntime();
