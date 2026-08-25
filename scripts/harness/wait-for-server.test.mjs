import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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

test('one accepted request that never responds cannot defeat the deadline', async (t) => {
  const listener = spawn(
    process.execPath,
    [
      '-e',
      "const net=require('node:net');const server=net.createServer(()=>{});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => listener.kill('SIGKILL'));
  const [chunk] = await once(listener.stdout, 'data');
  const port = Number.parseInt(String(chunk).trim(), 10);
  assert.ok(Number.isInteger(port) && port > 0, `invalid listener port: ${String(chunk)}`);

  const started = Date.now();
  const result = run([`http://127.0.0.1:${port}`, '', '2']);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out after 2s/);
  assert.ok(elapsed < 6_000, `wait-for-server took ${elapsed}ms`);
});
