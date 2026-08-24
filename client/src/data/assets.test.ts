import assert from 'node:assert/strict';
import test from 'node:test';
import { sniffImageType } from '../lib/asset-sniff.ts';

test('asset sniffing accepts supported signatures and rejects active SVG text', () => {
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image/png');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)">')), null);
});
