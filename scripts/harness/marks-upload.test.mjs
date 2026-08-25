import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('the installed upload helper passes its ingress security suite', () => {
  const result = spawnSync(
    'python3',
    [resolve(root, 'scripts/harness/marks-upload.test.py')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
