import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('Marks keeps one backend: Rust marks-server, never a Node server workspace', () => {
  assert.equal(existsSync(join(root, 'server/package.json')), false, 'retired Node server/package.json must stay gone');
  assert.equal(existsSync(join(root, 'server/src')), false, 'retired Node server/src must stay gone');
  assert.equal(
    existsSync(join(root, 'scripts/harness/ensure-server.mjs')),
    false,
    'ensure-server.mjs started the Node workspace and must not return',
  );

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(
    packageJson.workspaces,
    ['client', 'esbt'],
    'npm workspaces must not include a server package',
  );
  assert.equal(packageJson.scripts?.['dev:server'], undefined);
  assert.equal(packageJson.scripts?.start, undefined);

  const crateDirs = existsSync(join(root, 'crates'))
    ? readdirSync(join(root, 'crates'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const name of crateDirs) {
    assert.match(
      name,
      /^(marks-auth|marks-server)$/,
      `unexpected crate ${name}; Marks owns marks-auth plus at most one marks-server`,
    );
  }
});
