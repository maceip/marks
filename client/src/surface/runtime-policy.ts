export type SurfaceTier = 'opaque' | 'foundation' | 'balanced' | 'cinematic';

export interface SurfaceCapabilities {
  coarsePointer: boolean;
  cores: number;
  memoryGb: number;
  pixelCost: number;
  saveData: boolean;
  reducedTransparency: boolean;
  reducedGlass: boolean;
  webgl2: boolean;
  webgpu: boolean;
  backdropFilter: boolean;
}

export const TIER_SCORE: Record<SurfaceTier, number> = {
  opaque: 0,
  foundation: 0,
  balanced: 1,
  cinematic: 2,
};

const TIER_ORDER: SurfaceTier[] = ['cinematic', 'balanced', 'foundation', 'opaque'];

/** Pure, ordered policy so browser hints always produce the same initial tier. */
export function selectInitialTier(c: SurfaceCapabilities): SurfaceTier {
  if (c.reducedTransparency || c.reducedGlass || c.saveData) return 'opaque';
  if (!c.backdropFilter) return 'opaque';
  if (!c.webgl2 && !c.webgpu) return 'foundation';
  if (c.coarsePointer && (c.memoryGb < 6 || c.cores < 6 || c.pixelCost > 4_000_000)) return 'foundation';
  if (!c.coarsePointer && ((c.webgpu && c.cores >= 6 && c.memoryGb >= 6) || (c.cores >= 8 && c.memoryGb >= 8)) && c.pixelCost <= 10_000_000) {
    return 'cinematic';
  }
  if (c.cores >= 4 && c.memoryGb >= 4 && c.pixelCost <= 8_000_000) return 'balanced';
  return 'foundation';
}

export function nextLowerTier(tier: SurfaceTier): SurfaceTier {
  const index = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, index + 1)];
}

export function shaderMixForQuality(quality: number): number {
  if (quality <= 0.08) return 0;
  if (quality >= 1) return 1;
  return (quality - 0.08) / 0.92;
}

export function prefersGpuEngine(tier: SurfaceTier, webgpu: boolean): 'webgpu' | 'webgl2' | 'css' {
  if (tier === 'opaque' || tier === 'foundation') return 'css';
  if (tier === 'cinematic' && webgpu) return 'webgpu';
  if (tier === 'cinematic' || tier === 'balanced') return 'webgl2';
  return 'css';
}
