import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../check-design-system.mjs', import.meta.url),
  'utf8',
);

test('design-system browser proof awaits and closes Vite preview without a startup race', () => {
  assert.match(source, /import \{ preview \} from 'vite'/);
  assert.match(source, /const server = await preview\(\{/);
  assert.match(source, /configFile:\s*false/);
  assert.match(source, /preview:\s*\{[\s\S]*strictPort:\s*true/);
  assert.match(source, /signal:\s*AbortSignal\.timeout\(5_000\)/);
  assert.match(source, /finally\s*\{\s*await server\.close\(\);\s*\}/);
  assert.doesNotMatch(source, /spawn\(['"]npm['"]/);
  assert.doesNotMatch(source, /process\.env\.VITE_MARKS_DATA_MODE\s*=/);
  assert.doesNotMatch(source, /setTimeout\(/);
});
