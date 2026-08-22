/**
 * Guard the emitted declaration graph dependents typecheck against.
 * Run after `tsc -p tsconfig.build.json`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

function exportedSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
    specifiers.push(match[1].replace(/\.js$/, ''));
  }
  return [...new Set(specifiers)];
}

describe('ESBT emitted declaration surface', () => {
  it('emits dist/index.d.ts and dist/index.js', () => {
    assert.equal(existsSync(join(dist, 'index.d.ts')), true, 'missing dist/index.d.ts');
    assert.equal(existsSync(join(dist, 'index.js')), true, 'missing dist/index.js');
  });

  it('index.d.ts re-exports resolve to emitted .d.ts files', () => {
    const index = readFileSync(join(dist, 'index.d.ts'), 'utf8');
    const missing = exportedSpecifiers(index).filter((name) => !existsSync(join(dist, `${name}.d.ts`)));
    assert.deepEqual(missing, [], `dist/index.d.ts names missing modules: ${missing.join(', ')}`);
  });

  for (const file of ['doc.d.ts', 'weight.d.ts', 'vector.d.ts', 'undo.d.ts', 'ephemeral.d.ts']) {
    it(`emits dist/${file}`, () => {
      assert.equal(existsSync(join(dist, file)), true, `missing emitted ${file}`);
    });
  }
});
