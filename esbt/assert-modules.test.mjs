/**
 * Guard the files `src/index.ts` re-exports.
 *
 * The original failure was `Cannot find module './doc.js'` / `'./weight.js'`
 * because the public surface named modules that were not in the tree.
 * TypeScript resolves those specifiers to the `.ts` sources, so a missing
 * source fails `tsc --noEmit` the same way a consumer would.
 *
 * Package `types` must point at emitted `dist/*.d.ts`. Pointing them at
 * `src/` hides a broken emit.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');

const REQUIRED = [
  'index.ts',
  'api.ts',
  'doc.ts',
  'weight.ts',
  'vector.ts',
  'undo.ts',
  'ephemeral.ts',
  'codec.ts',
  'encode.ts',
  'ops.ts',
  'tree.ts',
];

function exportedSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
    specifiers.push(match[1].replace(/\.js$/, ''));
  }
  return [...new Set(specifiers)];
}

describe('ESBT public source surface', () => {
  for (const file of REQUIRED) {
    it(`ships src/${file}`, () => {
      assert.equal(existsSync(join(src, file)), true, `missing ${file}`);
    });
  }

  it('index.ts re-exports resolve to files that exist', () => {
    const index = readFileSync(join(src, 'index.ts'), 'utf8');
    const missing = exportedSpecifiers(index).filter((name) => !existsSync(join(src, `${name}.ts`)));
    assert.deepEqual(missing, [], `src/index.ts names missing modules: ${missing.join(', ')}`);
  });

  it('package.json types point at emitted declarations', () => {
    const require = createRequire(join(root, 'package.json'));
    const pkg = require('./package.json');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
    assert.equal(pkg.exports['.'].import, './dist/index.js');
  });
});
