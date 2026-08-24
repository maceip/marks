# Deploy marks.secure.build

Production runs on `secure.build` (`vectorheart`). Deployments authenticate as
the dedicated `marks-deploy` Unix identity; the application continues to run
as `devuser`. Caddy terminates TLS for the subdomain, Knot is authoritative for
`secure.build.`, and systemd runs the one Rust process.

| Piece | Location |
| --- | --- |
| Active binary + static UI | `/opt/marks/current` → `/opt/marks/releases/<git-sha>` |
| Previous release | `/opt/marks/previous` → retained release directory |
| SQLite | `/var/lib/marks/marks.db3` |
| Content-addressed assets | `/var/lib/marks/assets` |
| Unit | `/etc/systemd/system/marks.service` |
| Reverse proxy | `/etc/caddy/Caddyfile` site `marks.secure.build` |
| DNS | Knot zone `secure.build.` → `marks` A `142.248.222.1` |
| Listen | `127.0.0.1:5192` |
| Origin | `https://marks.secure.build` |
| Restricted SSH endpoint | `marks-deploy@secure.build` |
| Forced-command protocol | `/etc/marks/deploy-protocol.md` on `secure.build` |

## Deploy

Every successful same-repository `CI` push run on `main` triggers
`.github/workflows/production.yml`. The privileged workflow checks out the
exact tested revision and compares the complete currently-deployed-to-head diff
with `scripts/ci-impact.mjs`. A docs, test, or CI/deployment-infrastructure-only
commit records a successful no-runtime-change receipt without rebuilding or
restarting the application. Accumulated runtime changes deploy even if an
intervening deployment was skipped or failed. Pull requests, fork runs, failed
CI, non-`main` runs, and manually selected non-`main` refs cannot reach the
production job.

GitHub Actions needs two repository or `production` environment secrets:

| Secret | Value |
| --- | --- |
| `MARKS_DEPLOY_SSH_KEY` | Dedicated passphrase-free OpenSSH private key whose public half is forced-command authorized for `marks-deploy@secure.build` |
| `MARKS_DEPLOY_KNOWN_HOSTS` | Trusted `secure.build ssh-ed25519 ...` host-key line |

The workflow requires strict host-key checking and only the supplied identity;
it never learns a host key from the deployment connection. Its SSH
configuration disables forwarding and PTYs. Production deploys and rollbacks
share the `marks-production` concurrency group, while the remote release lock
remains the final serialization boundary.

The operator command remains available from a clean published checkout:

```bash
./scripts/deploy-secure-build.sh deploy
# or: npm run deploy:secure-build
```

For a local operator invocation, select the dedicated private key explicitly:

```bash
MARKS_DEPLOY_IDENTITY_FILE=/absolute/path/to/marks_github_actions \
  ./scripts/deploy-secure-build.sh status
```

Deployment only accepts a clean commit that exactly matches the freshly
fetched `origin/main` (override the branch with `MARKS_DEPLOY_BRANCH`). It
runs the pinned Rust format/test/Clippy gate, all browser/product/Markdown/
benchmark/Wasm/auth and harness unit suites, the service-mode production
client build and UI budgets, then a live Chromium workflow with a native
second ESBT peer. There is no `--skip-tests` or dirty-release option.

That complete local gate is the operator/manual path. An automatic
same-repository `workflow_run` uses `deploy-verified <sha>` only after checking
out the successful CI SHA and binding it to the triggering CI run id. That path
cannot be used as a generic local skip switch: it rejects non-GitHub and
non-`workflow_run` callers. It removes the duplicate GitHub-side suite, while
the host still performs its independent locked source verification, Linux
build, isolated canary, activation, observation, and automatic restoration.

The exact commit is sent with `git archive`; ignored files and the local
working tree are not uploaded. The client can issue only the fixed
`probe/upload/cleanup/deploy/rollback/status/releases` grammar. It cannot run
a shell, create arbitrary remote paths, inject environment variables, invoke
Docker or sudo, stream a privileged script, or select a systemd unit. Because
the development checkout is macOS arm64 and production is Linux x86_64, the
root-owned Marks helper builds both Rust binaries in a digest-pinned
`rust:1.88.0-bookworm` container. The unprivileged build sandbox uses locked
Node dependencies to rebuild the service-mode static UI from the same archive.

Before production changes, the candidate binary and its static directory are
started on an isolated loopback port with a temporary database. `/readyz` and
`/v1/artifact` must prove database writes, the exact Git revision, clean Rust
and Wasm sources, the build-bound static artifact, the engine/profile match,
and `releaseReady: true`.

Activation stops `marks.service`, atomically replaces the single `current`
symlink, installs that release's unit, and starts the service. Both the local
and public readiness/artifact receipts must match throughout the observation
window, and systemd must not restart. Any failure restores the prior symlink
and its unit automatically. The first run preserves the existing direct
`/opt/marks/marks-server` + `static/` installation as a `legacy-*` release, so
the migration itself has a rollback target.

The client verifies the installed boundary with the read-only `probe` command.
Toolchain, container, staging, release ownership, canary, and service checks
are server-owned policy; the deployment key has no general shell, Docker group,
or sudo access. Uploaded source is confined to `/var/lib/marks-deploy`, sealed
releases are root-owned under `/opt/marks/releases`, and the deployment account
cannot read `/var/lib/marks` or touch unrelated services and configuration.

## Fast rollback

Rollback never rebuilds and does not rerun the deployment gate. It verifies
the retained release's checksums, stops the service, switches the local
symlink and unit, restarts, then checks the public service:

From GitHub, open **Actions → Production deploy and rollback → Run workflow**,
leave the default `rollback` operation selected, and leave `release_id` empty
to activate `previous`. Enter a retained release id to select it explicitly.
The same workflow exposes read-only `status` and `releases` operations, plus a
manual idempotent `deploy` of the current `main` revision. GitHub rollback uses
the fast path below: it does not install toolchains, run tests, rebuild, or
upload source.

```bash
./scripts/deploy-secure-build.sh status
./scripts/deploy-secure-build.sh releases
./scripts/deploy-secure-build.sh rollback

# Select an older retained release explicitly:
./scripts/deploy-secure-build.sh rollback <release-id>

# Direct restricted-protocol form:
ssh -i /absolute/path/to/marks_github_actions \
  -o IdentitiesOnly=yes marks-deploy@secure.build rollback
```

A successful rollback swaps `current` and `previous`, so running the default
rollback again undoes it. Releases are not automatically deleted; this keeps
older known-good binaries available until an operator deliberately prunes
them.

This is a code-and-static rollback, not a database downgrade. Schema changes
must remain backward compatible across the rollback window. If an incident
requires reverting persisted data, stop the service and use the separately
verified backup/restore procedure below; do not point an older binary at a
known-incompatible schema.

## Service policy

The unit restarts on failure with systemd backoff (`RestartSec=2s`,
`RestartSteps=5`, `RestartMaxDelaySec=60s`). Caddy drops scanner paths,
rejects `Content-Length` over 12 MiB with 413, and wraps remaining bodies
with `request_body`; Rust still enforces the exact per-route limits and image
signature/quota policy. The response policy (CSP, Wasm permission, MIME
sniffing, framing, referrer and origin isolation) exists in both marks-server
and Caddy so bypassing either layer cannot silently weaken the app. CrowdSec
already parses Caddy logs for HTTP floods.

## Optional in-page agent provider

The checked-in unit leaves the paid hosted planner disabled. The local,
browser-only planner remains available without a provider or network request.
To opt a deployment into OpenAI, install a root-managed key file outside the
repository and add a systemd override; do not put the key in an environment
line or the unit file:

```bash
sudo install -d -o root -g devuser -m 0750 /etc/marks
sudo install -o devuser -g devuser -m 0600 /path/to/openai-key /etc/marks/openai-api-key
sudo systemctl edit marks.service
```

The override contains non-secret policy and a path to the secret:

```ini
[Service]
Environment=MARKS_AGENT_PROVIDER=openai
Environment=MARKS_OPENAI_MODEL=<approved-model-id>
Environment=MARKS_OPENAI_API_KEY_FILE=/etc/marks/openai-api-key
ReadOnlyPaths=/etc/marks/openai-api-key
```

Then run `sudo systemctl daemon-reload && sudo systemctl restart marks.service`
and confirm an authenticated `GET /v1/agent/capabilities` reports the intended
provider. The server refuses a group/world-readable key file. Provider traffic
contains the user's pill prompt and bounded ribbon tool schemas, but not the
document Markdown or selection. See
[`RIBBON-PRACTICAL-INTERFACES.md`](../docs/RIBBON-PRACTICAL-INTERFACES.md) for
the protocol, persistence, cancellation, and rate-limit boundary.

Image responses and portable ZIPs stream instead of materializing whole files
or archives in process memory. `MARKS_MAX_BUNDLE_EXPORTS` (four in the unit)
bounds concurrent archive verification/compression and returns `503` when all
slots are occupied; clients preserve their document and retry the export.

## Backups and restore proof

`marks-server` creates an online backup immediately at boot and every 24 hours
under `MARKS_BACKUP_DIR`, retaining the newest 14 by default. This is not a
raw copy of WAL files: one application barrier prevents asset upload/purge
while SQLite's online backup snapshot and every referenced immutable image are
copied. Each published directory has a hash-bound `manifest.json`; incomplete
staging directories are never considered backups.

The configured `/var/lib/marks/backups` path protects against application and
database corruption. Production operations should mirror each newly published
`backup-*` directory to a separate host or mounted backup volume; a second copy
on the same disk is not disaster recovery.

Verify or restore with the separately installed admin binary:

```bash
/opt/marks/current/marks-admin verify \
  /var/lib/marks/backups/backup-00000000000000000000
sudo systemctl stop marks.service
/opt/marks/current/marks-admin restore \
  /path/to/backup \
  /var/lib/marks-restored/marks.db3 \
  /var/lib/marks-restored/assets
```

Restore refuses to overwrite either destination. Point a stopped/test service
at the restored paths, pass `/readyz`, open/export a document and fetch an
asset before switching production. The repository integration test performs
that full backup → verify → restore → restart → export/image proof.

For a release build, set the compile-time receipt explicitly and keep the
strict component/WIT verifier green:

```bash
MARKS_BUILD_REVISION=<40-character-git-sha> MARKS_SOURCE_DIRTY=0 \
  cargo build -p marks-server --release --locked
npm run verify:esbt
```

The process refuses startup unless `/opt/marks/current/static` contains the
exact manifest bound into the binary and the component, WIT, and every declared
core module hash to that manifest.
`GET /v1/artifact` must report `staticArtifactVerified: true`,
`profileCoherent: true`, and `releaseReady: true`; its response and every server
response expose matching `X-Marks-Release` and `X-Marks-Engine` values.

DNSSEC is on for this zone. Add or update the name with `knotc`, not by
editing the zone dump:

```bash
sudo knotc zone-begin secure.build.
sudo knotc zone-set secure.build. marks 3600 A 142.248.222.1
sudo knotc zone-commit secure.build.
```
