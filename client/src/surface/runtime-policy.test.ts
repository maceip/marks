import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextLowerTier,
  prefersGpuEngine,
  selectInitialTier,
  shaderMixForQuality,
  type SurfaceCapabilities,
} from './runtime-policy.ts';

const capable: SurfaceCapabilities = {
  coarsePointer: false,
  cores: 12,
  memoryGb: 16,
  pixelCost: 3_000_000,
  saveData: false,
  reducedTransparency: false,
  reducedGlass: false,
  webgl2: true,
  webgpu: true,
  backdropFilter: true,
};

test('tier selection covers accessibility and hardware boundaries', () => {
  assert.equal(selectInitialTier(capable), 'cinematic');
  assert.equal(selectInitialTier({ ...capable, cores: 4, memoryGb: 4, webgpu: false }), 'balanced');
  assert.equal(selectInitialTier({ ...capable, webgl2: false, webgpu: false }), 'foundation');
  assert.equal(selectInitialTier({ ...capable, reducedTransparency: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, reducedGlass: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, saveData: true }), 'opaque');
  assert.equal(selectInitialTier({ ...capable, backdropFilter: false }), 'opaque');
});

test('low-end and high-pixel-cost phones remain foundation with WebGL2', () => {
  assert.equal(selectInitialTier({ ...capable, coarsePointer: true, cores: 4, memoryGb: 4 }), 'foundation');
  assert.equal(selectInitialTier({ ...capable, coarsePointer: true, pixelCost: 6_000_000 }), 'foundation');
});

test('WebGPU-capable mid-high desktops select cinematic without jumping past balanced on weaker kits', () => {
  assert.equal(selectInitialTier({ ...capable, webgpu: true, cores: 6, memoryGb: 6 }), 'cinematic');
  assert.equal(selectInitialTier({ ...capable, webgpu: false, cores: 6, memoryGb: 6 }), 'balanced');
});

test('quality mix fades instead of snapping shader work off', () => {
  assert.equal(shaderMixForQuality(2), 1);
  assert.equal(shaderMixForQuality(1), 1);
  assert.ok(shaderMixForQuality(0.5) > 0.3 && shaderMixForQuality(0.5) < 0.7);
  assert.equal(shaderMixForQuality(0.08), 0);
  assert.equal(shaderMixForQuality(0), 0);
});

test('stress steps one tier at a time toward CSS frost', () => {
  assert.equal(nextLowerTier('cinematic'), 'balanced');
  assert.equal(nextLowerTier('balanced'), 'foundation');
  assert.equal(nextLowerTier('foundation'), 'opaque');
  assert.equal(prefersGpuEngine('cinematic', true), 'webgpu');
  assert.equal(prefersGpuEngine('cinematic', false), 'webgl2');
  assert.equal(prefersGpuEngine('foundation', true), 'css');
});
