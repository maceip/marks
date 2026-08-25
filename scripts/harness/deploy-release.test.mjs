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
const ciWorkflow = resolve(root, '.github/workflows/ci.yml');

function runBash(script, args = [], options = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

function workflowStepScript(workflow, stepName) {
  const stepStart = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(stepStart, -1, `workflow step not found: ${stepName}`);
  const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
  const step = workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
  const runMarker = '        run: |\n';
  const runStart = step.indexOf(runMarker);
  assert.notEqual(runStart, -1, `workflow run block not found: ${stepName}`);
  return step.slice(runStart + runMarker.length).replace(/^ {10}/gmu, '');
}

test('operator entry point documents deploy, status, and one-command rollback', () => {
  const result = runBash(localScript, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy-secure-build\.sh deploy/);
  assert.match(
    result.stdout,
    /deploy-secure-build\.sh deploy-verified <revision> <product-variant> <build-plan-sha256>/,
  );
  assert.match(result.stdout, /deploy-secure-build\.sh rollback \[release-id\]/);
  assert.match(result.stdout, /automatically restore a failed\s+activation/);
  assert.match(result.stdout, /remote command grammar are fixed/);
  assert.match(result.stdout, /fixed to the checked-in stable variant/);
  assert.doesNotMatch(result.stdout, /--skip-tests/);
});

test('deployment client uses only the fixed Marks restricted protocol', () => {
  const entryPoint = readFileSync(localScript, 'utf8');
  assert.match(entryPoint, /^HOST=marks-deploy@secure\.build$/m);
  assert.match(entryPoint, /probe\|upload\|cleanup\|deploy\|rollback\|status\|releases/);
  assert.match(entryPoint, /restricted_command probe/);
  assert.match(entryPoint, /git -C "\$ROOT" archive --format=tar "\$revision"[\s\\]+\n\s*\| restricted_command upload "\$revision"/);
  assert.match(entryPoint, /restricted_command deploy "\$revision" "\$variant" "\$plan_digest"/);
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
  assert.match(workflow, /^\s*timeout-minutes: 300\s*$/m);
  assert.match(workflow, /MARKS_CI_VERIFIED_VARIANT/);
  assert.match(workflow, /MARKS_CI_VERIFIED_PLAN_SHA256/);
  assert.match(workflow, /scripts\/product-variant\.ts resolve/);
  assert.match(workflow, /variant=stable/);
  assert.match(workflow, /steps\.product\.outputs\.build_plan_sha256/);
  assert.match(workflow, /MARKS_CI_RUN_ID/);
  assert.match(workflow, /node scripts\/ci-impact\.mjs/);
  assert.match(workflow, /steps\.impact\.outputs\.should_deploy == 'true'/);
  assert.match(workflow, /Skip application deployment when no runtime artifact changed/);
  assert.match(
    workflow,
    /if \[\[ -z "\$current_revision" && "\$current" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then\s+current_revision=\$current\s+fi[\s\S]*git cat-file -e "\$\{current_revision\}\^\{commit\}"/,
    'revision-only v1 releases remain valid comparison bases only when Git can resolve them',
  );
  assert.match(workflow, /^\s*environment:\s*\n\s*name: Production$/m);
  assert.match(
    workflow,
    /^\s*group: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.operation == 'rollback' && 'marks-production-rollback' \|\| 'marks-production-standard' \}\}$/m,
  );
  assert.match(
    workflow,
    /^\s*cancel-in-progress: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.operation == 'rollback' \}\}$/m,
  );
  assert.doesNotMatch(workflow, /^\s*cancel-in-progress: (?:true|false)$/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^\s{4}permissions:\s*\n\s{6}contents: read\s*\n(?:\s{6}#[^\n]*\n)+\s{6}actions: write$/m);
  assert.match(workflow, /^\s*persist-credentials: false$/m);
});

test('production impact accepts only a reachable revision-only v1 comparison base', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  const impactScript = workflowStepScript(workflow, 'Determine deployed-to-head runtime impact');
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-v1-impact-test.')));
  try {
    const baseResult = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8' });
    assert.equal(baseResult.status, 0, baseResult.stderr);
    const base = baseResult.stdout.trim();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const fakeSsh = resolve(fixture, 'ssh');
    const githubOutput = resolve(fixture, 'github-output');
    writeFileSync(fakeSsh, `#!/usr/bin/env bash
cat <<'EOF'
current:  ${base}
previous:
{"revision":"${base}","schema":"marks-release.v1"}
EOF
`);
    writeFileSync(githubOutput, '');
    chmodSync(fakeSsh, 0o755);

    const result = spawnSync('/bin/bash', ['-c', impactScript], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        EVENT_NAME: 'workflow_run',
        REVISION: head,
        REQUESTED_VARIANT: 'stable',
        REQUESTED_PLAN_SHA256: 'b'.repeat(64),
        RUNNER_TEMP: fixture,
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const outputs = readFileSync(githubOutput, 'utf8');
    assert.match(outputs, new RegExp(`^current_revision=${base}$`, 'm'));
    assert.match(outputs, /^should_deploy=true$/m);
    assert.match(outputs, /^reasons=.*product-build-identity-changed$/m);

    const unknown = 'f'.repeat(40);
    writeFileSync(fakeSsh, `#!/usr/bin/env bash
printf '%s\n' 'current:  ${unknown}' '{"revision":"${unknown}","schema":"marks-release.v1"}'
`);
    writeFileSync(githubOutput, '');
    const rejected = spawnSync('/bin/bash', ['-c', impactScript], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        EVENT_NAME: 'workflow_run',
        REVISION: head,
        REQUESTED_VARIANT: 'stable',
        REQUESTED_PLAN_SHA256: 'b'.repeat(64),
        RUNNER_TEMP: fixture,
        GITHUB_RUN_ID: '2',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(
      rejected.stderr,
      new RegExp(`current release is neither a reachable Git revision nor legacy: ${unknown}`),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('CI proves shipping and independent feature variants from canonical isolated cuts', () => {
  const workflow = readFileSync(ciWorkflow, 'utf8');
  assert.match(workflow, /scripts\/product-variant\.ts list/);
  assert.match(workflow, /product_variant_matrix: \$\{\{ steps\.variants\.outputs\.matrix \}\}/);
  assert.match(
    workflow,
    /matrix: \$\{\{ fromJSON\(needs\.impact\.outputs\.product_variant_matrix\) \}\}/,
  );
  assert.match(workflow, /if \(!deployable\) return \[\{ variant: name, browser: "chromium" \}\]/);
  assert.match(workflow, /name === "stable"[\s\S]*\["chromium"\][\s\S]*\["chromium", "firefox", "webkit"\]/);
  assert.match(workflow, /MARKS_BROWSER: \$\{\{ matrix\.browser \}\}/);
  assert.match(workflow, /playwright install --with-deps "\$MARKS_BROWSER"/);
  assert.match(workflow, /scripts\/product-variant\.ts resolve/);
  assert.match(workflow, /client\/dist-variants\/\$REQUESTED_VARIANT\/service-\$\{digest:0:16\}/);
  assert.match(workflow, /MARKS_EXPECT_PRODUCT_VARIANT/);
  assert.match(workflow, /MARKS_EXPECT_BUILD_PLAN_SHA256/);
  assert.match(workflow, /marks-product-build\.json/);
  assert.match(workflow, /steps\.plan\.outputs\.deployable == 'true'/);
  assert.doesNotMatch(
    workflow,
    /steps\.plan\.outputs\.deployable == 'false'/,
    'validation-only plans must still run their structural server test and lint cuts',
  );
  assert.match(workflow, /cargo build -p marks-server --release --locked/);
  assert.match(workflow, /target\/debug\/marks-server/);
  assert.match(workflow, /MARKS_VARIANT_DEPLOYABLE === "true"/);
  assert.match(workflow, /artifact\.staticBuildPlanVerified !== true/);
  assert.match(
    workflow,
    /Enforce product feature source and catalog contracts[\s\S]*product-feature-source-contract\.test\.mjs/,
  );
  assert.match(workflow, /needs: \[impact, test, service-collab, product-variants\]/);
});

test('GitHub fast rollback is manual, serialized, pinned, and does not rebuild', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s*default: rollback$/m);
  assert.match(workflow, /bash scripts\/deploy-secure-build\.sh rollback "\$RELEASE_ID"/);
  assert.match(workflow, /bash scripts\/deploy-secure-build\.sh rollback 2>&1/);
  assert.match(workflow, /secrets\.MARKS_DEPLOY_SSH_KEY/);
  assert.match(workflow, /secrets\.MARKS_DEPLOY_KNOWN_HOSTS/);
  assert.match(workflow, /StrictHostKeyChecking yes/);
  assert.match(workflow, /IdentitiesOnly yes/);
  assert.match(workflow, /User marks-deploy/);
  assert.match(workflow, /ClearAllForwardings yes/);
  assert.match(workflow, /RequestTTY no/);
  assert.match(workflow, /REQUESTED_OPERATION: \$\{\{ steps\.request\.outputs\.operation \}\}/);
  assert.match(
    workflow,
    /if \[\[ "\$REQUESTED_OPERATION" == deploy \]\]; then[\s\S]*ssh -o ConnectTimeout=15 secure\.build probe[\s\S]*else[\s\S]*ssh -o ConnectTimeout=15 secure\.build status >\/dev\/null/,
  );
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
  assert.match(
    rollbackStep,
    /lock_error='marks-release-root: another Marks deployment or rollback holds the release lock'/,
  );
  assert.match(rollbackStep, /rollback_retry_deadline_seconds=300/);
  assert.match(rollbackStep, /rollback_retry_deadline=\$\(\(SECONDS \+ rollback_retry_deadline_seconds\)\)/);
  assert.match(rollbackStep, /if \[\[ "\$rollback_output" != "\$lock_error" \]\]; then\s+exit "\$rollback_status"/);
  assert.match(rollbackStep, /if \(\( SECONDS >= rollback_retry_deadline \)\); then/);
  assert.match(rollbackStep, /rollback_retry_delay=20/);
  assert.doesNotMatch(rollbackStep, /grep|=~[^\n]*lock_error|\*\$lock_error/);
});

test('two concurrency lanes and API gates preserve rollback priority across interleavings', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  const runName = workflow.match(/^run-name: (.+)$/m);
  const group = workflow.match(/^\s*group: (.+)$/m);
  const cancellation = workflow.match(/^\s*cancel-in-progress: (.+)$/m);
  assert.ok(runName && group && cancellation);
  assert.equal(
    runName[1],
    "${{ github.event_name == 'workflow_dispatch' && inputs.operation == 'rollback' && 'Production rollback' || 'Production standard' }}",
  );
  assert.equal(
    group[1],
    "${{ github.event_name == 'workflow_dispatch' && inputs.operation == 'rollback' && 'marks-production-rollback' || 'marks-production-standard' }}",
  );
  assert.equal(
    cancellation[1],
    "${{ github.event_name == 'workflow_dispatch' && inputs.operation == 'rollback' }}",
  );

  const route = (eventName, operation) => {
    const rollback = eventName === 'workflow_dispatch' && operation === 'rollback';
    return {
      group: rollback ? 'marks-production-rollback' : 'marks-production-standard',
      cancel: rollback,
    };
  };
  assert.deepEqual(route('workflow_dispatch', 'rollback'), {
    group: 'marks-production-rollback', cancel: true,
  });
  assert.deepEqual(route('workflow_dispatch', 'deploy'), {
    group: 'marks-production-standard', cancel: false,
  });
  assert.deepEqual(route('workflow_run', 'deploy'), {
    group: 'marks-production-standard', cancel: false,
  });
  assert.doesNotMatch(workflow, /^\s*group: marks-production$/m);

  const preempt = workflow.slice(
    workflow.indexOf('- name: Preempt standard production runs for rollback'),
    workflow.indexOf('- name: Wait for rollback priority before deploy'),
  );
  const deployWait = workflow.slice(
    workflow.indexOf('- name: Wait for rollback priority before deploy'),
    workflow.indexOf('- name: Check out the trusted production revision'),
  );
  assert.match(preempt, /if: github\.event_name == 'workflow_dispatch' && inputs\.operation == 'rollback'/);
  assert.match(preempt, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(preempt, /select\(\.display_title == "Production standard"\)/);
  assert.match(preempt, /select\(\.status != "completed"\)/);
  assert.match(preempt, /actions\/runs\/\$run_id\/cancel/);
  assert.match(preempt, /declare -A cancellation_requested=\(\)/);
  assert.match(preempt, /cancellation_requested\[\$run_id\]=1/);
  assert.match(preempt, /while :; do[\s\S]*standard_runs_json=\$\(list_standard_runs\)[\s\S]*for run_id in "\$\{standard_run_ids\[@\]\}"; do[\s\S]*\/cancel/);
  assert.match(preempt, /cancellation_deadline_seconds=120/);
  assert.match(deployWait, /if: github\.event_name == 'workflow_run' \|\| inputs\.operation == 'deploy'/);
  assert.match(deployWait, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(deployWait, /select\(\.display_title == "Production rollback"\)/);
  assert.match(deployWait, /select\(\.status != "completed"\)/);
  assert.match(deployWait, /rollback_priority_deadline_seconds=900/);
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/^\s*name: Production$/gm) ?? []).length, 1);
});

test('workflow rejects explicit legacy, revision-only, and non-stable rollback targets', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  const requestStep = workflow.slice(
    workflow.indexOf('- name: Resolve and validate the production request'),
    workflow.indexOf('- name: Setup Node.js v24'),
  );
  const match = requestStep.match(/release_id_pattern='([^']+)'/);
  assert.ok(match, 'request validation must declare one explicit release identity pattern');
  const releaseId = new RegExp(match[1]);
  const revision = 'a'.repeat(40);
  const digest = 'b'.repeat(64);

  assert.match(`${revision}.stable.${digest}`, releaseId);
  assert.doesNotMatch(revision, releaseId);
  assert.doesNotMatch('legacy-20260825T120000Z', releaseId);
  assert.doesNotMatch(`${revision}.beta.${digest}`, releaseId);
  assert.match(requestStep, /\[\[ -n "\$release_id" && ! "\$release_id" =~ \$release_id_pattern \]\]/);
  assert.match(requestStep, /leave it empty to select previous/);
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

test('public verification rejects a readiness receipt for another build plan', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-ready-receipt-test.')));
  const revision = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const otherDigest = 'c'.repeat(64);
  try {
    const fakeSsh = resolve(fixture, 'ssh');
    const fakeCurl = resolve(fixture, 'curl');
    writeFileSync(fakeSsh, `#!/usr/bin/env bash
cat <<'EOF'
current:  ${revision}.stable.${digest}
previous:
revision: ${revision}
product-variant: stable
build-plan-sha256: ${digest}
EOF
`);
    writeFileSync(fakeCurl, `#!/usr/bin/env bash
url=\${!#}
case "$url" in
  */healthz) printf '%s\\n' '{"ok":true}' ;;
  */readyz) printf '%s\\n' '{"ok":true,"productVariant":"stable","buildPlanSha256":"${otherDigest}","staticBuildPlanVerified":true,"releaseReady":true}' ;;
  */v1/artifact) printf '%s\\n' '{"buildRevision":"${revision}","productVariant":"stable","buildPlanSha256":"${digest}","staticArtifactVerified":true,"staticBuildPlanVerified":true,"profileCoherent":true,"engineCoherent":true,"releaseReady":true,"serverSourceDirty":false,"componentSourceDirty":false}' ;;
  *) exit 22 ;;
esac
`);
    chmodSync(fakeSsh, 0o755);
    chmodSync(fakeCurl, 0o755);

    const result = runBash(localScript, ['verify'], {
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /public readiness build plan digest is not the active release plan/);
    assert.match(result.stderr, /public verification failed/);
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
    assert.match(result.stderr, /not one retained stable v2 release identity/);
    assert.equal(existsSync(invoked), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('dot path rollback identifiers are rejected before SSH', () => {
  for (const identifier of ['.', '..']) {
    const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'marks-ssh-dot-reject-test.')));
    try {
      const invoked = resolve(fixture, 'ssh-invoked');
      const fakeSsh = resolve(fixture, 'ssh');
      writeFileSync(fakeSsh, '#!/usr/bin/env bash\ntouch "$MARKS_SSH_INVOKED"\n');
      chmodSync(fakeSsh, 0o755);
      const result = runBash(localScript, ['rollback', identifier], {
        env: {
          ...process.env,
          MARKS_SSH_INVOKED: invoked,
          PATH: `${fixture}:${process.env.PATH}`,
        },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not one retained stable v2 release identity/);
      assert.equal(existsSync(invoked), false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test('deploy-verified cannot be used as a local skip-tests switch', () => {
  const result = runBash(localScript, [
    'deploy-verified',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'stable',
    'b'.repeat(64),
  ], {
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      GITHUB_EVENT_NAME: '',
      MARKS_CI_VERIFIED_SHA: '',
      MARKS_CI_VERIFIED_VARIANT: '',
      MARKS_CI_VERIFIED_PLAN_SHA256: '',
      MARKS_CI_RUN_ID: '',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /available only in GitHub Actions/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /checking restricted deployment protocol/);
});

test('production deployment is hard-bound to the stable product variant identity', () => {
  const entryPoint = readFileSync(localScript, 'utf8');
  const helper = readFileSync(releaseRoot, 'utf8');
  assert.match(entryPoint, /^TARGET_PRODUCT_VARIANT=stable$/m);
  assert.match(entryPoint, /resolve_product_variant "\$TARGET_PRODUCT_VARIANT"/);
  assert.match(entryPoint, /verified product build identity is not the current stable plan/);
  assert.match(helper, /^TARGET_PRODUCT_VARIANT = "stable"$/m);
  assert.match(helper, /this deployment target is fixed to \{TARGET_PRODUCT_VARIANT\}/);
  assert.match(helper, /release_identity\(revision, build\["variant"\], build\["digest"\]\)/);
});
