export function canUseWebGpu(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as { gpu?: unknown }).gpu);
}
