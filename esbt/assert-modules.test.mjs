/**
 * Guard the files `src/index.ts` re-exports.
 *
 * The original typecheck failure was `Cannot find module './doc.js'` /
 * `'./weight.js'` because the public surface named modules that were not
 * in the tree. TypeScript resolves those specifiers to the `.ts` sources,
 * so this test fails in the same place a consumer typecheck would.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

describe('ESBT public source surface', () => {
  for (const file of REQUIRED) {
    it(`ships src/${file}`, () => {
      assert.equal(existsSync(join(src, file)), true, `missing ${file}`);
    });
  }

  it('package.json types point at source so dependents typecheck without dist/', () => {
    const require = createRequire(join(root, 'package.json'));
    const pkg = require('./package.json');
    assert.equal(pkg.types, './src/index.ts');
    assert.equal(pkg.exports['.'].types, './src/index.ts');
    assert.equal(pkg.exports['.'].import.types, './src/index.ts');
  });
});
