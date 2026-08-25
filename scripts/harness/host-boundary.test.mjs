import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const dispatcher = read('deploy/host/marks-deploy-ssh');
const releaseRoot = read('deploy/host/marks-release-root');
const sqliteWorker = read('deploy/host/marks-sqlite-worker');
const hostReadme = read('deploy/host/README.md');
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
    [
      '-m',
      'py_compile',
      resolve(root, 'deploy/host/marks-upload'),
      resolve(root, 'deploy/host/marks-sqlite-worker'),
      resolve(root, 'deploy/host/marks-release-root'),
    ],
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
  assert.match(dispatcher, /\$argc -eq 4/);
  assert.match(dispatcher, /\$\{argv\[2\]\} =~ \$variant/);
  assert.match(dispatcher, /\$\{argv\[3\]\} =~ \$digest/);
  assert.match(dispatcher, /release='\^\[0-9a-f\]\{40\}\\\.stable\\\.\[0-9a-f\]\{64\}\$'/);
  assert.doesNotMatch(dispatcher, /legacy-\[0-9\]\{8\}T\[0-9\]\{6\}Z/);
  assert.doesNotMatch(dispatcher, /rollback-legacy/);
  assert.doesNotMatch(dispatcher, /release='\^\[A-Za-z0-9\._-\]\+\$'/);
  assert.match(dispatcher, /^\s*rollback\)/mu);
  assert.match(dispatcher, /^\s*\*\)\s*\n\s*echo "marks-deploy: command rejected"/mu);
  assert.match(dispatcher, /\[\[ -z "\$original" \|\| ! "\$original" =~ /);
});

test('unknown-plan rollback is local-root break-glass only', () => {
  assert.match(releaseRoot, /def require_normal_rollback_receipt\(receipt\)/u);
  assert.match(releaseRoot, /normal rollback requires a v2 stable product-build receipt/u);
  assert.match(releaseRoot, /def require_local_break_glass\(\)/u);
  assert.match(releaseRoot, /os\.environ\.get\("SUDO_USER"\) == "marks-deploy"/u);
  assert.match(releaseRoot, /"rollback-legacy"/u);
  assert.match(releaseRoot, /rollback\(requested, allow_legacy=True\)/u);
  assert.doesNotMatch(client, /rollback-legacy/u);
  assert.match(client, /retained stable v2 release identity/u);
});

test('probe identity and template equality fail closed on both sides', () => {
  // The root helper reports the installed boundary identity...
  assert.match(releaseRoot, /"protocol": "marks-deploy\.v2"/);
  assert.match(releaseRoot, /"productVariant": TARGET_PRODUCT_VARIANT/);
  assert.match(releaseRoot, /"buildFilesystem": \{/u);
  assert.match(releaseRoot, /"fetchEgress": fetch_egress/u);
  assert.match(releaseRoot, /"build": "marks-build"/u);
  assert.match(releaseRoot, /"incomingAggregateLimitBytes": 2 \* 1024 \* 1024 \* 1024/u);
  assert.match(releaseRoot, /"uploadLock": str\(UPLOAD_LOCK\)/u);
  assert.match(client, /installed helper did not prove the bounded build filesystem/u);
  assert.match(client, /installed helper did not prove the dedicated build identity/u);
  assert.match(client, /installed helper did not prove the filtered dependency-fetch network/u);
  assert.match(client, /installed helper did not prove the bounded upload namespace/u);
  for (const helper of ['dispatcher', 'uploader', 'sqliteWorker', 'releaseRoot', 'serviceTemplate']) {
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
    'deploy/host/marks-sqlite-worker',
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
  assert.match(sshd, /^\s*PermitTunnel no$/m);
  assert.match(sshd, /^\s*PermitUserRC no$/m);
  assert.match(sshd, /^\s*MaxSessions 1$/m);
  assert.match(sshd, /^\s*AuthorizedKeysFile \/etc\/ssh\/authorized_keys\/%u$/m);
  assert.doesNotMatch(sshd, /^--$/m);

  const sshdBinary = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find(existsSync);
  const sshKeygen = ['/usr/bin/ssh-keygen', '/usr/local/bin/ssh-keygen'].find(existsSync);
  if (sshdBinary && sshKeygen) {
    const fixture = mkdtempSync(resolve(tmpdir(), 'marks-sshd-contract.'));
    try {
      const key = resolve(fixture, 'host-key');
      const generated = spawnSync(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
        encoding: 'utf8',
      });
      assert.equal(generated.status, 0, generated.stderr);
      const parsed = spawnSync(
        sshdBinary,
        ['-t', '-h', key, '-f', resolve(root, 'deploy/host/90-marks-deploy.sshd.conf')],
        { encoding: 'utf8' },
      );
      assert.equal(parsed.status, 0, parsed.stderr);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  const sudoers = read('deploy/host/sudoers-marks-deploy');
  const rules = sudoers.trim().split('\n').filter((line) => !line.startsWith('Defaults'));
  assert.deepEqual(rules, ['marks-deploy ALL=(root) NOPASSWD: /usr/local/sbin/marks-release-root']);
  assert.match(sudoers, /env_reset/);
});

test('root release assembly crosses only bounded unprivileged build boundaries', () => {
  assert.match(releaseRoot, /def run_untrusted_readonly\(/u);
  assert.match(
    releaseRoot,
    /sandbox_command=\["\/usr\/bin\/env", "--", "\/marks-input\/marks-admin", "schema"\]/u,
  );
  assert.doesNotMatch(releaseRoot, /run\(\[stage \/ "marks-admin", "schema"\]/u);
  assert.match(releaseRoot, /copy_built_binary\(cargo, "marks-server", stage \/ "marks-server"\)/u);
  assert.match(releaseRoot, /copy_built_binary\(cargo, "marks-admin", stage \/ "marks-admin"\)/u);
  assert.match(releaseRoot, /source = claim_uploaded_source\(revision\)/u);
  assert.match(releaseRoot, /freeze_claimed_source\(source\)/u);
  assert.match(releaseRoot, /workspace = copy_claimed_workspace\(source, revision\)/u);
  assert.match(releaseRoot, /cargo = create_cargo_workspace\(revision\)/u);
  assert.match(releaseRoot, /docker_fetch\(source, cargo, revision\)/u);
  assert.match(releaseRoot, /docker_build\(source, cargo, revision, build\)/u);
  assert.match(
    releaseRoot,
    /static_build_receipt = read_bounded_json_file\([\s\S]*MAX_BUILD_RECEIPT_BYTES/u,
  );
});

test('root build storage is a distinct fixed-capacity filesystem', () => {
  assert.match(releaseRoot, /BUILD_ROOT = fixed_path\([^\n]+\/var\/lib\/marks-deploy\/build/u);
  assert.match(releaseRoot, /CACHE = fixed_path\([^\n]+\/var\/lib\/marks-deploy\/build\/cache/u);
  assert.match(releaseRoot, /WORKSPACES = fixed_path\([^\n]+\/var\/lib\/marks-deploy\/build\/workspaces/u);
  assert.match(releaseRoot, /VERIFIED_GIT = fixed_path\([^\n]+\/var\/lib\/marks-deploy\/build\/verified-git/u);
  assert.match(releaseRoot, /def validate_build_filesystem_contract\(/u);
  assert.match(releaseRoot, /build_info\.st_dev == state_info\.st_dev/u);
  assert.match(releaseRoot, /MAX_BUILD_FILESYSTEM_BYTES = 24 \* 1024\*\*3/u);
  assert.match(releaseRoot, /\{"nodev", "nosuid"\}\.issubset/u);
  assert.match(releaseRoot, /validate_loop_backing_contract\(/u);
  assert.match(releaseRoot, /st_blocks \* 512 < backing_info\.st_size/u);
  assert.match(hostReadme, /mkfs\.ext4 -E nodiscard -m 0/u);
  assert.match(hostReadme, /stat -c %b \/var\/lib\/marks-deploy-build\.ext4/u);
  assert.match(releaseRoot, /purge_stale_build_state\(\)[\s\S]{0,300}source = claim_uploaded_source/u);
  assert.match(releaseRoot, /def purge_stale_release_staging\(/u);
  assert.match(releaseRoot, /purge_stale_release_staging\(\)/u);
  assert.match(releaseRoot, /prune_releases\(\)[\s\S]{0,200}purge_stale_build_state\(\)/u);
});

test('every untrusted build process has a wall-clock and resource bound', () => {
  for (const property of [
    '--property=RuntimeMaxSec={NPM_RUNTIME_SECONDS}',
    '--property=MemoryMax=4G',
    '--property=TasksMax=512',
    '--property=CPUQuota=600%',
    '--property=LimitFSIZE=2147483648',
  ]) {
    assert.ok(releaseRoot.includes(property), property);
  }
  assert.match(
    releaseRoot,
    /"--property=ReadWritePaths=\/work"/u,
  );
  assert.match(releaseRoot, /--setenv=HOME=\/work\/\.marks-npm-home/u);
  assert.match(releaseRoot, /--setenv=npm_config_cache=\/work\/\.marks-npm-cache/u);
  assert.match(releaseRoot, /TemporaryFileSystem=\/marks-npm-config:ro,nodev,nosuid,noexec,size=1M/u);
  assert.match(releaseRoot, /npm_config_userconfig=\/marks-npm-config\/user/u);
  assert.match(releaseRoot, /npm_config_globalconfig=\/marks-npm-config\/global/u);
  assert.doesNotMatch(releaseRoot, /npm_config_(?:user|global)config=\/dev\/null/u);
  assert.match(releaseRoot, /def build_identity\(/u);
  assert.match(releaseRoot, /account = pwd\.getpwnam\("marks-build"\)/u);
  assert.match(releaseRoot, /"ci",\s*"--ignore-scripts"/u);
  assert.match(releaseRoot, /sandboxed_npm\(workspace, "rebuild", "rebuild"\)/u);
  assert.match(releaseRoot, /def validate_node_dependency_policy\(/u);
  assert.match(releaseRoot, /def validate_cargo_dependency_policy\(/u);
  assert.doesNotMatch(releaseRoot, /CACHE_LIMIT_BYTES|CACHE \/ 'npm'/u);
  assert.match(releaseRoot, /def create_cargo_workspace\(/u);
  assert.match(releaseRoot, /--volume=\{cargo \/ 'home'\}:\/cargo/u);
  assert.match(releaseRoot, /--volume=\{cargo \/ 'target'\}:\/target/u);
  assert.match(releaseRoot, /"--pull=never"/u);
  assert.match(releaseRoot, /"--log-driver=none"/u);
  assert.match(releaseRoot, /"--network=none"/u);
  assert.match(releaseRoot, /cargo build[\s\S]{0,160}--offline/u);
  assert.match(releaseRoot, /\/usr\/bin\/mkdir -m 0700 \/target\/marks-export/u);
  assert.match(
    releaseRoot,
    /\/usr\/bin\/install -m 0500 \/target\/release\/marks-server[\s\S]{0,80}\/target\/marks-export\/marks-server/u,
  );
  assert.match(
    releaseRoot,
    /\/usr\/bin\/install -m 0500 \/target\/release\/marks-admin[\s\S]{0,80}\/target\/marks-export\/marks-admin/u,
  );
  assert.match(releaseRoot, /cargo fetch --locked/u);
  assert.match(releaseRoot, /def validate_fetch_egress_policy\(/u);
  assert.match(releaseRoot, /network\.get\("EnableIPv4"\) is not True/u);
  assert.match(releaseRoot, /network\.get\("EnableIPv6"\) is not False/u);
  assert.match(releaseRoot, /timeout=DOCKER_RUNTIME_SECONDS/u);
  assert.match(releaseRoot, /\["\/usr\/bin\/docker", "rm", "--force", container\]/u);
  for (const property of [
    '--property=RuntimeMaxSec={CANARY_RUNTIME_SECONDS}',
    '--property=MemoryMax=3G',
    '--property=TasksMax=512',
    '--property=CPUQuota=400%',
    '--property=LimitFSIZE=1073741824',
    '--property=StandardOutput=null',
    '--property=StandardError=null',
  ]) {
    assert.ok(releaseRoot.includes(property), property);
  }
  assert.match(releaseRoot, /TemporaryFileSystem=\/marks-canary:rw,nodev,nosuid,noexec,size=\{CANARY_TMPFS_BYTES\}/u);
  assert.match(releaseRoot, /TemporaryFileSystem=\/tmp:rw,nodev,nosuid,noexec,size=64M/u);
  assert.match(releaseRoot, /"--property=DynamicUser=yes"/u);
  assert.match(releaseRoot, /"--property=PrivateNetwork=yes"/u);
  assert.match(releaseRoot, /"--property=ProtectProc=invisible"/u);
  assert.match(releaseRoot, /"--property=ProcSubset=pid"/u);
  assert.match(releaseRoot, /JoinsNamespaceOf=\{canary_unit\}\.service/u);
  assert.match(releaseRoot, /SQLITE_WORKER, "launch-canary"/u);
  assert.doesNotMatch(releaseRoot, /"\/bin\/sh", "-ceu"/u);
});

test('root never parses live SQLite or executes the worker outside systemd', () => {
  assert.doesNotMatch(releaseRoot, /import sqlite3|sqlite3\.connect/u);
  assert.match(releaseRoot, /def run_sqlite_worker\(/u);
  assert.match(releaseRoot, /"\/usr\/bin\/systemd-run"[\s\S]{0,2200}command\.extend\(str\(item\) for item in payload\)/u);
  assert.match(releaseRoot, /capture_limit=MAX_SQLITE_RECEIPT_BYTES/u);
  assert.match(releaseRoot, /BindReadOnlyPaths=\{service_root\}:\/marks-live/u);
  assert.match(releaseRoot, /SQLITE_ARCHIVE = fixed_path\(/u);
  assert.match(releaseRoot, /KEEP_AUTHORITATIVE_SNAPSHOTS = 2/u);
  assert.match(sqliteWorker, /MAX_DATABASE_BYTES = 512 \* 1024\*\*2/u);
  assert.match(sqliteWorker, /KEEP_PUBLISHED_BACKUPS = 4/u);
  assert.match(sqliteWorker, /def launch_canary\(/u);
});

test('Git identity and dirty-state captures are bounded before root parses them', () => {
  assert.match(
    releaseRoot,
    /"rev-parse", "FETCH_HEAD"\],[\s\S]{0,120}capture_limit=128/u,
  );
  const boundedStatuses = [
    ...releaseRoot.matchAll(/"status",[\s\S]{0,300}?capture_limit=64 \* 1024/gu),
  ];
  assert.equal(boundedStatuses.length, 2);
  assert.match(releaseRoot, /"http\.lowSpeedLimit=1024"/u);
  assert.match(releaseRoot, /"http\.lowSpeedTime=30"/u);
  assert.match(releaseRoot, /"fetch",[\s\S]{0,180}?timeout=5 \* 60/u);
  assert.match(releaseRoot, /os\.killpg\(process\.pid, signal\.SIGKILL\)/u);
});
