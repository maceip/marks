import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const dispatcher = read('deploy/host/marks-deploy-ssh');
const releaseRoot = read('deploy/host/marks-release-root');
const client = read('scripts/deploy-secure-build.sh');

test('the checked-in service template is exactly the repository unit', () => {
  assert.equal(
    read('deploy/host/marks.service.template'),
    read('deploy/systemd/marks.service'),
    'deploy/host/marks.service.template must stay byte-identical to deploy/systemd/marks.service',
  );
});

test('the installed boundary programs are syntactically valid', () => {
  const bash = spawnSync('bash', ['-n', resolve(root, 'deploy/host/marks-deploy-ssh')], {
    encoding: 'utf8',
  });
  assert.equal(bash.status, 0, bash.stderr);
  const python = spawnSync(
    'python3',
    ['-m', 'py_compile', resolve(root, 'deploy/host/marks-upload'), resolve(root, 'deploy/host/marks-release-root')],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr);
});

test('the dispatcher grammar covers exactly the client protocol', () => {
  // Every command the client can send has a dispatcher arm, and the
  // dispatcher rejects everything else.
  assert.match(client, /probe\|upload\|cleanup\|deploy\|rollback\|status\|releases/);
  assert.match(dispatcher, /^\s*probe\|status\|releases\)/mu);
  assert.match(dispatcher, /^\s*upload\|cleanup\)/mu);
  assert.match(dispatcher, /^\s*deploy\)/mu);
  assert.match(dispatcher, /^\s*rollback\)/mu);
  assert.match(dispatcher, /^\s*\*\)\s*\n\s*echo "marks-deploy: command rejected"/mu);
  assert.match(dispatcher, /\[\[ -z "\$original" \|\| ! "\$original" =~ /);
});

test('probe identity and template equality fail closed on both sides', () => {
  // The root helper reports the installed boundary identity...
  assert.match(releaseRoot, /"protocol": "marks-deploy\.v1"/);
  for (const helper of ['dispatcher', 'uploader', 'releaseRoot', 'serviceTemplate']) {
    assert.match(releaseRoot, new RegExp(`"${helper}": hash_file\\(`), helper);
  }
  // ...refuses a repository unit that differs from the installed template...
  assert.match(
    releaseRoot,
    /read_bytes\(\) != TEMPLATE\.read_bytes\(\):\n\s+fail\("uploaded deploy\/systemd\/marks\.service differs/,
  );
  // ...and the client refuses to deploy through a drifted boundary.
  for (const source of [
    'deploy/host/marks-deploy-ssh',
    'deploy/host/marks-upload',
    'deploy/host/marks-release-root',
    'deploy/host/marks.service.template',
  ]) {
    assert.match(client, new RegExp(source.replace(/[.\\/]/gu, '\\$&')), source);
  }
  assert.match(client, /installed deployment boundary differs from the checked-in/);
});

test('the boundary policy files stay restrictive', () => {
  const sshd = read('deploy/host/90-marks-deploy.sshd.conf');
  assert.match(sshd, /^Match User marks-deploy$/m);
  assert.match(sshd, /^\s*ForceCommand \/usr\/local\/libexec\/marks-deploy-ssh$/m);
  assert.match(sshd, /^\s*PermitTTY no$/m);
  assert.match(sshd, /^\s*AllowTcpForwarding no$/m);
  assert.match(sshd, /^\s*PasswordAuthentication no$/m);

  const sudoers = read('deploy/host/sudoers-marks-deploy');
  const rules = sudoers.trim().split('\n').filter((line) => !line.startsWith('Defaults'));
  assert.deepEqual(rules, ['marks-deploy ALL=(root) NOPASSWD: /usr/local/sbin/marks-release-root']);
  assert.match(sudoers, /env_reset/);
});
