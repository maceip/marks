import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeQr } from './qr.ts';

function finderAt(grid: boolean[][], x: number, y: number) {
  assert.equal(grid[y][x], true);
  assert.equal(grid[y][x + 6], true);
  assert.equal(grid[y + 6][x], true);
  assert.equal(grid[y + 3][x + 3], true);
  assert.equal(grid[y + 1][x + 1], false);
}

describe('encodeQr', () => {
  it('builds a square matrix with three finder patterns', () => {
    const grid = encodeQr('https://marks.local/link');
    assert.equal(grid.length, grid[0]?.length);
    assert.ok(grid.length >= 21);
    finderAt(grid, 0, 0);
    finderAt(grid, grid.length - 7, 0);
    finderAt(grid, 0, grid.length - 7);
  });

  it('grows with longer pairing URLs instead of throwing early', () => {
    const short = encodeQr('/link');
    const long = encodeQr('https://marks.example/link?marks-posture=phone');
    assert.ok(long.length >= short.length);
  });
});
