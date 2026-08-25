import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const localScript = resolve(root, 'scripts/deploy-secure-build.sh');
const releaseRoot = resolve(root, 'deploy/host/marks-release-root');
const productionWorkflow = resolve(root, '.github/workflows/production.yml');

function runBash(script, args = [], options = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
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
  // Dependabot auto-merge dispatches CI on main with the workflow token,
  // which cannot retrigger push workflows; a successful dispatched run on
  // main is accepted and the impact comparison still gates deployment.
  assert.match(workflow, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
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

test('systemd always resolves the binary and static bundle through one release link', () => {
  const unit = readFileSync(resolve(root, 'deploy/systemd/marks.service'), 'utf8');
  assert.match(unit, /^WorkingDirectory=\/opt\/marks\/current$/m);
  assert.match(unit, /^ExecStart=\/opt\/marks\/current\/marks-server$/m);
  assert.match(unit, /^Environment=MARKS_STATIC_DIR=\/opt\/marks\/current\/static$/m);
  assert.doesNotMatch(unit, /^ExecStart=\/opt\/marks\/marks-server$/m);
});

test('remote Linux builder is pinned by toolchain version and image digest', () => {
  const helper = readFileSync(releaseRoot, 'utf8');
  const entryPoint = readFileSync(localScript, 'utf8');
  assert.match(helper, /rust:1\.88\.0-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(helper, /RUSTUP_TOOLCHAIN=1\.88\.0/);
  assert.match(entryPoint, /rustup which cargo --toolchain 1\.88\.0/);
  assert.match(entryPoint, /PATH="\$toolchain_bin:\$PATH" RUSTUP_TOOLCHAIN=1\.88\.0/);
  assert.match(entryPoint, /with_pinned_rust[\s\\]+\n\s*bash scripts\/run-service-ci\.sh/);
  assert.match(entryPoint, /npx playwright install --with-deps chromium/);
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
