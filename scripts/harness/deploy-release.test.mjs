import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const localScript = resolve(root, 'scripts/deploy-secure-build.sh');
const remoteScript = resolve(root, 'deploy/remote-release.sh');
const productionWorkflow = resolve(root, '.github/workflows/production.yml');

function runBash(script, args = [], options = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

function fakeRelease(releases, id) {
  const release = resolve(releases, id);
  mkdirSync(resolve(release, 'static'), { recursive: true });
  writeFileSync(resolve(release, 'marks-server'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(resolve(release, 'marks-server'), 0o755);
  writeFileSync(resolve(release, 'static/index.html'), '<!doctype html>\n');
  writeFileSync(resolve(release, 'marks.service'), `[Service]\nExecStart=${release}/marks-server\n`);
  writeFileSync(resolve(release, 'LEGACY'), 'test-only retained release\n');
  const paths = ['LEGACY', 'marks-server', 'marks.service', 'static/index.html'];
  const sums = paths.map((path) => {
    const digest = createHash('sha256').update(readFileSync(resolve(release, path))).digest('hex');
    return `${digest}  ${path}`;
  });
  writeFileSync(resolve(release, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return release;
}

test('operator entry point documents deploy, status, and one-command rollback', () => {
  const result = runBash(localScript, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy-secure-build\.sh deploy/);
  assert.match(result.stdout, /deploy-secure-build\.sh deploy-verified <revision>/);
  assert.match(result.stdout, /deploy-secure-build\.sh rollback \[release-id\]/);
  assert.match(result.stdout, /automatically restore a failed\s+activation/);
  assert.match(result.stdout, /remote command grammar are fixed/);
  assert.doesNotMatch(result.stdout, /--skip-tests/);
});

test('deployment client uses only the fixed Marks restricted protocol', () => {
  const entryPoint = readFileSync(localScript, 'utf8');
  assert.match(entryPoint, /^HOST=marks-deploy@secure\.build$/m);
  assert.match(entryPoint, /probe\|upload\|cleanup\|deploy\|rollback\|status\|releases/);
  assert.match(entryPoint, /restricted_command probe/);
  assert.match(entryPoint, /git -C "\$ROOT" archive --format=tar "\$revision"[\s\\]+\n\s*\| restricted_command upload "\$revision"/);
  assert.match(entryPoint, /restricted_command deploy "\$revision"/);
  assert.match(entryPoint, /restricted_command cleanup "\$STAGED_REVISION"/);
  assert.match(entryPoint, /ClearAllForwardings=yes/);
  assert.match(entryPoint, /RequestTTY=no/);
  assert.match(entryPoint, /ConnectTimeout=15/);
  assert.doesNotMatch(entryPoint, /devuser@secure\.build/);
  assert.doesNotMatch(entryPoint, /bash -s|mktemp -d \/tmp\/marks-deploy|docker info|sudo -n|rm -rf/);
  assert.doesNotMatch(entryPoint, /MARKS_PUBLIC_ORIGIN=.*ssh|MARKS_OBSERVE_SECONDS=.*ssh/);
});

test('GitHub production deploy follows only successful same-repository main CI', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  assert.match(workflow, /^\s*workflow_run:\s*$/m);
  assert.match(workflow, /^\s*workflows: \[CI\]\s*$/m);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(
    workflow,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /run: npm run deploy:secure-build/);
  assert.match(workflow, /scripts\/deploy-secure-build\.sh deploy-verified/);
  assert.match(workflow, /MARKS_CI_VERIFIED_SHA/);
  assert.match(workflow, /MARKS_CI_RUN_ID/);
  assert.match(workflow, /node scripts\/ci-impact\.mjs/);
  assert.match(workflow, /steps\.impact\.outputs\.should_deploy == 'true'/);
  assert.match(workflow, /Skip application deployment when no runtime artifact changed/);
  assert.match(workflow, /^\s*environment:\s*\n\s*name: Production$/m);
  assert.match(workflow, /^\s*group: marks-production$/m);
  assert.match(workflow, /^\s*cancel-in-progress: false$/m);
  assert.match(workflow, /^permissions:\s*\n\s*contents: read$/m);
});

test('GitHub fast rollback is manual, serialized, pinned, and does not rebuild', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s*default: rollback$/m);
  assert.match(workflow, /bash scripts\/deploy-secure-build\.sh rollback "\$RELEASE_ID"/);
  assert.match(workflow, /bash scripts\/deploy-secure-build\.sh rollback\s*$/m);
  assert.match(workflow, /secrets\.MARKS_DEPLOY_SSH_KEY/);
  assert.match(workflow, /secrets\.MARKS_DEPLOY_KNOWN_HOSTS/);
  assert.match(workflow, /StrictHostKeyChecking yes/);
  assert.match(workflow, /IdentitiesOnly yes/);
  assert.match(workflow, /User marks-deploy/);
  assert.match(workflow, /ClearAllForwardings yes/);
  assert.match(workflow, /RequestTTY no/);
  assert.match(workflow, /ssh -o ConnectTimeout=15 secure\.build probe/);
  assert.match(workflow, /eval "\$\(ssh-agent -s\)"/);
  assert.match(workflow, /ssh-add "\$key_path"/);
  assert.match(workflow, /rm -f -- "\$key_path"/);
  assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking no/);
  assert.doesNotMatch(workflow, /User devuser|devuser@secure\.build/);

  const verifiedStep = workflow.slice(
    workflow.indexOf('- name: Deploy the exact successful CI revision'),
    workflow.indexOf('- name: Run the complete gate for a manual deploy'),
  );
  assert.match(verifiedStep, /deploy-verified/);
  assert.doesNotMatch(verifiedStep, /npm run deploy|cargo|playwright/);

  const manualDeployStep = workflow.slice(
    workflow.indexOf('- name: Run the complete gate for a manual deploy'),
    workflow.indexOf('- name: Skip application deployment'),
  );
  assert.match(manualDeployStep, /npm run deploy:secure-build/);

  const rollbackStep = workflow.slice(
    workflow.indexOf('- name: Fast rollback'),
    workflow.indexOf('- name: Show production status'),
  );
  assert.doesNotMatch(rollbackStep, /npm|cargo|playwright|deploy-secure-build\.sh deploy/);
});

test('retained release helper exposes its operator contract locally', () => {
  const result = runBash(remoteScript, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote-release\.sh rollback \[release-id\]/);
});

test('systemd always resolves the binary and static bundle through one release link', () => {
  const unit = readFileSync(resolve(root, 'deploy/systemd/marks.service'), 'utf8');
  assert.match(unit, /^WorkingDirectory=\/opt\/marks\/current$/m);
  assert.match(unit, /^ExecStart=\/opt\/marks\/current\/marks-server$/m);
  assert.match(unit, /^Environment=MARKS_STATIC_DIR=\/opt\/marks\/current\/static$/m);
  assert.doesNotMatch(unit, /^ExecStart=\/opt\/marks\/marks-server$/m);
});

test('remote Linux builder is pinned by toolchain version and image digest', () => {
  const helper = readFileSync(remoteScript, 'utf8');
  const entryPoint = readFileSync(localScript, 'utf8');
  assert.match(helper, /rust:1\.88\.0-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(helper, /--env RUSTUP_TOOLCHAIN=1\.88\.0/);
  assert.match(entryPoint, /rustup which cargo --toolchain 1\.88\.0/);
  assert.match(entryPoint, /PATH="\$toolchain_bin:\$PATH" RUSTUP_TOOLCHAIN=1\.88\.0/);
  assert.match(entryPoint, /with_pinned_rust[\s\\]+\n\s*bash scripts\/run-service-ci\.sh/);
  assert.match(entryPoint, /npx playwright install --with-deps chromium/);
});

test('first deploy captures the direct installation as an immutable legacy release', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-legacy-test.')));
  try {
    mkdirSync(resolve(fixture, 'static'), { recursive: true });
    mkdirSync(resolve(fixture, 'releases'), { recursive: true });
    writeFileSync(resolve(fixture, 'marks-server'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(resolve(fixture, 'marks-server'), 0o755);
    writeFileSync(resolve(fixture, 'static/index.html'), '<!doctype html>legacy\n');
    writeFileSync(resolve(fixture, 'legacy.service'), [
      '[Service]',
      'WorkingDirectory=/opt/marks',
      'Environment=MARKS_STATIC_DIR=/opt/marks/static',
      'ExecStart=/opt/marks/marks-server',
      '',
    ].join('\n'));

    const shell = String.raw`
set -euo pipefail
MARKS_ROOT=$1
MARKS_UNIT_PATH="$MARKS_ROOT/legacy.service"
source "$2"
snapshot_legacy_release
captured=$(release_from_link "$CURRENT_LINK")
[[ -f "$captured/LEGACY" ]]
grep -Fqx 'WorkingDirectory=/opt/marks/current' "$captured/marks.service"
grep -Fqx 'Environment=MARKS_STATIC_DIR=/opt/marks/current/static' "$captured/marks.service"
grep -Fqx 'ExecStart=/opt/marks/current/marks-server' "$captured/marks.service"
(cd "$captured" && sha256sum -c --quiet SHA256SUMS)
`;
    const result = spawnSync('/bin/bash', ['-c', shell, 'legacy-test', fixture, remoteScript], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(realpathSync(resolve(fixture, 'current')), /\/releases\/legacy-/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('rollback refuses a retained release whose bytes no longer match its receipt', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-tamper-test.')));
  try {
    const releases = resolve(fixture, 'releases');
    mkdirSync(releases, { recursive: true });
    const release = fakeRelease(releases, 'release-tampered');
    writeFileSync(resolve(release, 'marks-server'), '#!/usr/bin/env bash\nexit 99\n');
    chmodSync(resolve(release, 'marks-server'), 0o755);

    const shell = String.raw`
set -euo pipefail
MARKS_ROOT=$1
source "$2"
validate_release "$MARKS_ROOT/releases/release-tampered"
`;
    const result = spawnSync('/bin/bash', ['-c', shell, 'tamper-test', fixture, remoteScript], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /checksum verification failed/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('activation swaps previous atomically and failed verification restores current', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-release-test.')));
  try {
    const releases = resolve(fixture, 'releases');
    mkdirSync(releases, { recursive: true });
    const releaseA = fakeRelease(releases, 'release-a');
    const releaseB = fakeRelease(releases, 'release-b');
    const releaseC = fakeRelease(releases, 'release-c');

    const shell = String.raw`
set -euo pipefail
MARKS_ROOT=$1
MARKS_UNIT_PATH="$MARKS_ROOT/system-unit"
MARKS_LOCAL_ORIGIN=http://127.0.0.1:5192
MARKS_PUBLIC_ORIGIN=http://127.0.0.1:5192
MARKS_OBSERVE_SECONDS=5
source "$2"

service_stop() { :; }
service_start() { :; }
service_logs() { :; }
install_release_unit() { :; }
verify_release_unit() { :; }
observe_release() { :; }
verify_running_release() { [[ "$1" != "$MARKS_ROOT/releases/release-c" ]]; }

atomic_link "$MARKS_ROOT/releases/release-a" "$CURRENT_LINK"
activate_release "$MARKS_ROOT/releases/release-b" 0
[[ "$(release_from_link "$CURRENT_LINK")" == "$MARKS_ROOT/releases/release-b" ]]
[[ "$(release_from_link "$PREVIOUS_LINK")" == "$MARKS_ROOT/releases/release-a" ]]

rollback_locked
[[ "$(release_from_link "$CURRENT_LINK")" == "$MARKS_ROOT/releases/release-a" ]]
[[ "$(release_from_link "$PREVIOUS_LINK")" == "$MARKS_ROOT/releases/release-b" ]]

if activate_release "$MARKS_ROOT/releases/release-c" 0; then
  echo "failed candidate unexpectedly activated" >&2
  exit 90
fi
[[ "$(release_from_link "$CURRENT_LINK")" == "$MARKS_ROOT/releases/release-a" ]]
[[ "$(release_from_link "$PREVIOUS_LINK")" == "$MARKS_ROOT/releases/release-b" ]]
`;
    const result = spawnSync('/bin/bash', ['-c', shell, 'deploy-test', fixture, remoteScript], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(realpathSync(resolve(fixture, 'current')), releaseA);
    assert.equal(realpathSync(resolve(fixture, 'previous')), releaseB);
    assert.notEqual(realpathSync(resolve(fixture, 'current')), releaseC);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('status sends one fixed read-only request to the restricted account', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-ssh-test.')));
  try {
    const sshArgs = resolve(fixture, 'ssh-args');
    const fakeSsh = resolve(fixture, 'ssh');
    writeFileSync(fakeSsh, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$MARKS_SSH_ARGS"\n');
    chmodSync(fakeSsh, 0o755);

    const result = runBash(localScript, ['status'], {
      env: {
        ...process.env,
        MARKS_SSH_ARGS: sshArgs,
        PATH: `${fixture}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(sshArgs, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(-2), ['marks-deploy@secure.build', 'status']);
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('IdentitiesOnly=yes'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('ConnectTimeout=15'));
    assert.ok(args.includes('ClearAllForwardings=yes'));
    assert.ok(args.includes('RequestTTY=no'));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('unsafe rollback identifiers are rejected before SSH', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-ssh-reject-test.')));
  try {
    const invoked = resolve(fixture, 'ssh-invoked');
    const fakeSsh = resolve(fixture, 'ssh');
    writeFileSync(fakeSsh, '#!/usr/bin/env bash\ntouch "$MARKS_SSH_INVOKED"\n');
    chmodSync(fakeSsh, 0o755);

    const result = runBash(localScript, ['rollback', 'release;id'], {
      env: {
        ...process.env,
        MARKS_SSH_INVOKED: invoked,
        PATH: `${fixture}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe remote argument/);
    assert.equal(existsSync(invoked), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('deploy-verified cannot be used as a local skip-tests switch', () => {
  const result = runBash(localScript, [
    'deploy-verified',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ], {
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      GITHUB_EVENT_NAME: '',
      MARKS_CI_VERIFIED_SHA: '',
      MARKS_CI_RUN_ID: '',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /available only in GitHub Actions/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /checking restricted deployment protocol/);
});
