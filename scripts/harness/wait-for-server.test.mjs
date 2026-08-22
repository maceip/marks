import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'wait-for-server.sh');

function run(args) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

test('wait-for-server times out instead of looping forever', () => {
  const result = run(['http://127.0.0.1:9', '', '2']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out after 2s/);
});

test('wait-for-server fails when the recorded pid is already gone', () => {
  const result = run(['http://127.0.0.1:9', '999999', '5']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /process 999999 exited/);
});
