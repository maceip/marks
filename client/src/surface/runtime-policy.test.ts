import assert from 'node:assert/strict';
import test from 'node:test';
import { selectInitialTier, type SurfaceCapabilities } from './runtime-policy.ts';

const capable: SurfaceCapabilities = { coarsePointer: false, cores: 12, memoryGb: 16, pixelCost: 3_000_000, saveData: false, reducedTransparency: false, reducedGlass: false, webgl2: true, backdropFilter: true };
test('tier selection covers accessibility and hardware boundaries', () => {
  assert.equal(selectInitialTier(capable), 'cinematic');
  assert.equal(selectInitialTier({ ...capable, cores: 4, memoryGb: 4 }), 'balanced');
  assert.equal(selectInitialTier({ ...capable, webgl2: false }), 'foundation');
  assert.equal(selectInitialTier({ ...capable, reducedTransparency: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, reducedGlass: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, saveData: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, backdropFilter: false }), 'opaque');
});
test('low-end and high-pixel-cost phones remain foundation with WebGL2', () => {
  assert.equal(selectInitialTier({ ...capable, coarsePointer: true, cores: 4, memoryGb: 4 }), 'foundation');
  assert.equal(selectInitialTier({ ...capable, coarsePointer: true, pixelCost: 6_000_000 }), 'foundation');
});
