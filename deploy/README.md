# Deploy marks.secure.build

Production host is `devuser@secure.build` (`vectorheart`). Caddy terminates
TLS for the subdomain; Knot is authoritative for `secure.build.`; systemd
runs the one Rust process.

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

## Deploy

```bash
./scripts/deploy-secure-build.sh deploy
# or: npm run deploy:secure-build
```

Deployment only accepts a clean commit that exactly matches the freshly
fetched `origin/main` (override the branch with `MARKS_DEPLOY_BRANCH`). It
runs the pinned Rust format/test/Clippy gate, all browser/product/Markdown/
benchmark/Wasm/auth and harness unit suites, the service-mode production
client build and UI budgets, then a live Chromium workflow with a native
second ESBT peer. There is no `--skip-tests` or dirty-release option.

The exact commit is sent with `git archive`; ignored files and the local
working tree are not uploaded. Because the development checkout is macOS
arm64 and production is Linux x86_64, the host builds both Rust binaries in
the digest-pinned `rust:1.88.0-bookworm` container. The host uses Node 22 and
`npm ci` to rebuild the service-mode static UI from the same archive.

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

The host prerequisites currently verified by the script are Linux x86_64,
Docker, Node/npm 22 or newer, rsync, flock, curl, Python 3, sha256sum,
`systemd-analyze`, noninteractive sudo, and SSH access as
`devuser@secure.build`.

## Fast rollback

Rollback never rebuilds and does not rerun the deployment gate. It verifies
the retained release's checksums, stops the service, switches the local
symlink and unit, restarts, then checks the public service:

```bash
./scripts/deploy-secure-build.sh status
./scripts/deploy-secure-build.sh releases
./scripts/deploy-secure-build.sh rollback

# Select an older retained release explicitly:
./scripts/deploy-secure-build.sh rollback <release-id>

# Emergency host-side form (installed by the first successful deployment):
ssh devuser@secure.build 'bash /opt/marks/deploy/remote-release.sh rollback'
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
strict Wasm verifier green:

```bash
MARKS_BUILD_REVISION=<40-character-git-sha> MARKS_SOURCE_DIRTY=0 \
  cargo build -p marks-server --release --locked
npm run verify:esbt
```

The process refuses startup unless `/opt/marks/current/static` contains the
exact manifest bound into the binary and `esbt.wasm` hashes to that manifest.
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
