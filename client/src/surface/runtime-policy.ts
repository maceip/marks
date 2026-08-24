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
  backdropFilter: boolean;
}

/** Pure, ordered policy so browser hints always produce the same initial tier. */
export function selectInitialTier(c: SurfaceCapabilities): SurfaceTier {
  if (c.reducedTransparency || c.reducedGlass || c.saveData) return 'opaque';
  if (!c.backdropFilter) return 'opaque';
  if (!c.webgl2) return 'foundation';
  // Pixel-heavy phones must not get a shader merely because their browser exposes WebGL2.
  if (c.coarsePointer && (c.memoryGb < 6 || c.cores < 6 || c.pixelCost > 4_000_000)) return 'foundation';
  if (!c.coarsePointer && c.cores >= 8 && c.memoryGb >= 8 && c.pixelCost <= 10_000_000) return 'cinematic';
  if (c.cores >= 4 && c.memoryGb >= 4 && c.pixelCost <= 8_000_000) return 'balanced';
  return 'foundation';
}
