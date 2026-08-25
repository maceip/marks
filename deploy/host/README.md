# Authoritative secure.build deployment boundary

These are the exact programs and policy files installed on `secure.build`
(`vectorheart`) that implement the restricted Marks deployment protocol.
They are the production implementation, not documentation: the `probe`
operation reports the SHA-256 of every installed program plus the
root-owned service template, and `scripts/deploy-secure-build.sh` refuses
to deploy unless those hashes equal these checked-in files.

| File | Installed path | Owner/mode |
| --- | --- | --- |
| `marks-deploy-ssh` | `/usr/local/libexec/marks-deploy-ssh` | root:root 0755 |
| `marks-upload` | `/usr/local/libexec/marks-upload` | root:root 0755 |
| `marks-sqlite-worker` | `/usr/local/libexec/marks-sqlite-worker` | root:root 0755 |
| `marks-release-root` | `/usr/local/sbin/marks-release-root` | root:root 0755 |
| `marks.service.template` | `/etc/marks/marks.service.template` | root:root 0644 |
| `90-marks-deploy.sshd.conf` | `/etc/ssh/sshd_config.d/90-marks-deploy.conf` | root:root 0644 |
| `sudoers-marks-deploy` | `/etc/sudoers.d/marks-deploy` | root:root 0440 |

`marks.service.template` must stay byte-identical to
`deploy/systemd/marks.service`; a harness test enforces it, and
`marks-release-root` additionally fails a deployment whose uploaded
repository unit differs from the installed template, so a unit change can
never pass CI while production silently keeps an older template.

## Changing a helper

Installation is deliberately not reachable through the `marks-deploy`
account — the deployment key must never be able to rewrite its own
security boundary. To change a helper:

1. Edit the file here and validate it (`python3 -m py_compile`, `bash -n`).
2. From an administrative session, back up the installed file under
   `/root/`, install the new one root-owned with the mode above
   (`sshd -t` / `visudo -cf` for the policy files), and run
   `sudo /usr/local/sbin/marks-release-root probe` to confirm.
3. Commit the matching repository copy and deploy. Deployment fails closed
   until the installed and checked-in hashes agree, in either direction.

The product-variant release change upgrades the forced-command grammar and
probe receipt to `marks-deploy.v2`. Install `marks-deploy-ssh`, `marks-upload`,
`marks-sqlite-worker`, and `marks-release-root` together from the exact committed revision before
retrying its production workflow. During the brief transition, the old client
cannot speak to the new dispatcher and the new client refuses the old probe;
that fail-closed window is intentional. Do not weaken the probe identity check
or temporarily permit both grammars.

The restricted `rollback` grammar accepts only receipt-bound v2 stable release
ids (or no id, in which case the root helper validates `previous` as v2 stable
before activation). Retained revision-only v1 and `legacy-*` releases are
unknown product builds and cannot cross the SSH/sudo boundary. Last-resort
recovery of one of those artifacts is the explicit local-console operation
`sudo /usr/local/sbin/marks-release-root rollback-legacy <release-id>`; the
helper rejects that operation from the `marks-deploy` sudo identity or SSH and
never permits it to bypass a v2 beta receipt.

Provisioning history, the acceptance evidence for this boundary, and the
administrative recovery procedure are recorded on the host in
`/etc/marks/deploy-protocol.md` (pre-change backups under
`/root/marks-boundary-backup-*`).

The activation, retention, rollback-preflight, and backup contracts are
tested directly against `marks-release-root` by
`scripts/harness/marks-release-root.test.py`: running unprivileged, the
helper accepts `MARKS_TEST_*` path overrides so tests drive the exact
installed code inside a fixture tree; running as root it ignores every
override and uses only the fixed production paths.

## Runtime state ownership

`/var/lib/marks-deploy` is an exact root:root 0755 hierarchy root. The uploader
owns only its exact marks-deploy:marks-deploy 0700 `incoming/` child; it never
creates or owns the common parent or the namespace lock. Upload and cleanup
take the same administrator-provisioned, no-follow 0600 lock after checking
the lock, `incoming/`, and common-parent ownership and mode before and after
acquisition. Lock contention fails immediately with a retryable error instead
of accumulating forced-command processes. While holding that lock, either
operation removes abandoned `.upload.*` staging trees left by a killed process. A new
upload is admitted only if the in-flight tree keeps the namespace at no more
than four complete/staging trees and 2 GiB of conservatively accounted
aggregate storage. The aggregate charge includes the greater of apparent or
allocated bytes plus a per-object metadata reserve; each archive separately
remains limited to 512 MiB compressed, 1 GiB expanded, 50,000 members, and 32
path components. Archive links, hard links, special files, duplicate names,
overlong paths, and unsafe pre-existing incoming objects are rejected.

The forced-command dispatcher wraps both upload and cleanup in a 45-minute
wall-clock limit and explicit address-space, CPU, file-size, descriptor,
process, and core-dump limits via the host's GNU `timeout` and util-linux
`prlimit`. These binaries are deployment-boundary prerequisites. At the
start of a locked deployment, the root helper atomically moves the completed
revision into root-only `claimed/`, rejects links and special files, and makes
that snapshot root-owned and read-only before Git verification. A separate
root-hidden workspace is exposed to the unprivileged npm unit only as its
`/work` bind mount. Uploader cleanup continues to address only
`incoming/<revision>` and cannot reach either the claim or workspace.

All writable build storage is beneath a separate fixed-capacity ext4 mount at
`/var/lib/marks-deploy/build`: `cache/`, `workspaces/`, and `verified-git/`.
`incoming/`, root-only `claimed/`, and `canary/` remain outside that mount. The
helper fails `probe` and `deploy` unless `build/` is an exact, root-owned,
non-group/world-writable mount, uses a device distinct from the deployment
state filesystem, is mounted `nodev,nosuid`, and reports between 20 GiB and 24
GiB of total capacity. A loop-backed mount is additionally rejected unless its
root-owned backing file is non-sparse and fully allocated. This is the hard
aggregate boundary during a failed or hostile build; locked stale-workspace
cleanup is the tighter pre-build hygiene layer. `status`, `releases`, and rollback remain
available if the disposable build filesystem is offline.

The legacy `cache/` directory is empty and root-owned; no repository-writable
tool state persists across releases. Every release gets a new npm home and
cache inside its disposable workspace plus new empty Cargo home and target
directories under a root-hidden per-release workspace; all three are deleted
after success or failure, and all stale workspaces are purged at the start of
the next locked deploy. A prior revision therefore cannot persist `.npmrc`,
`script-shell`, Cargo config, `rustc-wrapper`, registry, or fingerprint state
into a reverted-good build. After Cargo finishes, its normally hard-linked
release binaries are copied to new single-link inodes in a freshly created
export directory. Those exports are imported with no-follow descriptors and
strict type, owner, mode, link-count, and size checks;
repository-built code is executed only in bounded unprivileged transient
units as a dedicated locked `marks-build` system identity. `marks-deploy`
owns ingress only, so build code cannot signal, ptrace, or traverse uploader
process descriptors. npm units can write only their workspace and have hard
runtime, memory, task, CPU, temporary-filesystem, and per-file limits. Docker
builds have a hard client deadline plus named-container cleanup, use a
read-only root, disable host-persistent container logs, and run with
`--pull=never`. Exact npm and Cargo lock sources are allowlisted before fetch;
npm lifecycle/repository scripts and Cargo compilation then run networkless
from fresh per-release state. Canary units use a distinct systemd
`DynamicUser` and private network namespace, have independent
hard runtime, memory, task, CPU, and per-file limits, null output, a 1 GiB
aggregate state tmpfs, and a separate 64 MiB `/tmp`; they cannot fill host state
or the system journal, inspect or signal the live `devuser` service, or reach
host loopback. A second bounded transient probe joins only the canary network
namespace to verify its private loopback receipts.

Root never imports `sqlite3` or parses the service-controlled live database.
The fixed root-owned `marks-sqlite-worker` is launched as `devuser` in a
networkless, resource-bounded transient unit. systemd binds the fixed real
`/var/lib/marks` directory and the demoted worker alone opens `marks.db3`; a
mutable database or backup symlink is never resolved with root authority.
Snapshots are integrity-checked, limited to 512 MiB, and receipt-bound through
a 64 KiB JSON capture. Before activation, root imports the snapshot through
no-follow descriptors into `/var/lib/marks-deploy/sqlite-snapshots`, publishes
atomically, and retains exactly two files (at most 1 GiB). A convenience copy
published by the unprivileged worker under `/var/lib/marks/backups` retains four
exact-name files (at most 2 GiB). Hidden crash temporaries are safely normalized
before either retention pass. Rollback binds the verified root-hidden seed
read-only and the fixed worker copies it into the canary tmpfs before exec.

## Required one-time build-filesystem provisioning

This repository change deliberately does **not** provision or mount storage on
the production host. An administrator must complete this gate before the new
helper can pass `probe` or accept a deployment. The least complex supported
layout is one fully allocated 24 GiB loopback ext4 image:

```bash
sudo install -d -o root -g root -m 0755 /var/lib/marks-deploy
sudo useradd --system --no-create-home --user-group --shell /usr/sbin/nologin marks-build
sudo install -d -o marks-deploy -g marks-deploy -m 0700 /var/lib/marks-deploy/incoming
sudo install -o marks-deploy -g marks-deploy -m 0600 /dev/null \
  /var/lib/marks-deploy/incoming/.marks-upload.lock
sudo install -d -o root -g root -m 0755 /var/lib/marks-deploy/build
sudo fallocate -l 24G /var/lib/marks-deploy-build.ext4
sudo chown root:root /var/lib/marks-deploy-build.ext4
sudo chmod 0600 /var/lib/marks-deploy-build.ext4
sudo mkfs.ext4 -E nodiscard -m 0 -L marks-deploy-build /var/lib/marks-deploy-build.ext4
test "$(($(stat -c %b /var/lib/marks-deploy-build.ext4) * 512))" \
  -ge "$(stat -c %s /var/lib/marks-deploy-build.ext4)"
```

Do not substitute `truncate`, `dd ... seek=`, or another sparse-image
technique: the helper checks allocated blocks and refuses a sparse backing
file. The `nodiscard` format option is equally important: without it, `mkfs`
can discard the freshly allocated extents and turn the image sparse again. The
post-format allocation check above must pass. Add the persistent mount to
`/etc/fstab`, then mount it:

```fstab
/var/lib/marks-deploy-build.ext4 /var/lib/marks-deploy/build ext4 loop,nodev,nosuid 0 2
```

```bash
sudo mount /var/lib/marks-deploy/build
findmnt --mountpoint /var/lib/marks-deploy/build \
  --output TARGET,SOURCE,FSTYPE,OPTIONS,SIZE
```

A dedicated, non-thin 24 GiB logical volume formatted ext4 is also valid; use
its stable `/dev/mapper/...` or UUID in `fstab` with `nodev,nosuid`. Do not use
a bind mount, a subdirectory of the state/root filesystem, an oversized LV, or
a thin/sparse backing device: those do not provide the promised exhaustion
boundary.

The helper creates and hardens the fixed children after validating the mount.
Old `/var/lib/marks-deploy/cache` and `workspaces` contents are disposable and
must not be moved into place by the deployment account. An administrator may
remove them after the new mount passes `probe`; starting with empty caches is
the safest migration. Pre-pull the exact digest-pinned builder image because a
release build is forbidden from expanding Docker storage:

```bash
sudo docker pull rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0
sudo docker network create --driver bridge --subnet 172.30.0.0/24 \
  --opt com.docker.network.bridge.enable_icc=false \
  --label build.marks.secure/fetch-egress-policy=marks.fetch-egress.v1 \
  marks-build-fetch
sudo install -d -o root -g root -m 0755 /etc/marks
printf '%s\n' 'marks.fetch-egress.v1 network=marks-build-fetch private=deny link-local=deny' | \
  sudo install -o root -g root -m 0644 /dev/stdin /etc/marks/build-fetch-egress-policy.v1
sudo /usr/local/sbin/marks-release-root probe
```

Before installing that receipt, the administrator must enforce and verify a
host `DOCKER-USER`/nftables policy for source subnet `172.30.0.0/24` that denies
private, carrier-grade NAT, link-local, multicast, and local-service
destinations while permitting only required public dependency egress and DNS.
The helper validates the fixed network and root-owned receipt, but that receipt
is the administrator's attestation of the firewall rule, not a substitute for
the rule itself.

Only after that probe succeeds should the matching root-owned helper be
considered installed. Record the mount source, filesystem UUID, capacity,
options, image digest, and probe receipt in `/etc/marks/deploy-protocol.md`.
