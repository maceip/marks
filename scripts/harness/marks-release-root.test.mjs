import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The activation, retention, rollback-preflight, and backup contracts run
// against the exact installed implementation (deploy/host/marks-release-root)
// through its unprivileged test seams — not against a shell model of it.
test('the installed release helper passes its ported contract suite', () => {
  const result = spawnSync(
    'python3',
    [resolve(root, 'scripts/harness/marks-release-root.test.py')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
