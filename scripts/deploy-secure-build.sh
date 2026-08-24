#!/usr/bin/env bash
# Build, prove, and atomically deploy one clean Marks commit through the
# restricted secure.build deployment protocol. The release is built on the
# Linux host so a macOS checkout cannot accidentally upload a Darwin binary.
# See deploy/README.md for the release layout and rollback contract.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOST=marks-deploy@secure.build
DEPLOY_BRANCH=${MARKS_DEPLOY_BRANCH:-main}
IDENTITY_FILE=${MARKS_DEPLOY_IDENTITY_FILE:-}
STAGED_REVISION=""
SSH=(
  ssh
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=15
  -o ClearAllForwardings=yes
  -o RequestTTY=no
)

if [[ -n "$IDENTITY_FILE" ]]; then
  [[ -f "$IDENTITY_FILE" ]] \
    || { echo "deploy: MARKS_DEPLOY_IDENTITY_FILE is not a file: $IDENTITY_FILE" >&2; exit 1; }
  SSH+=(-i "$IDENTITY_FILE")
fi

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-secure-build.sh deploy
  scripts/deploy-secure-build.sh deploy-verified <revision>
  scripts/deploy-secure-build.sh rollback [release-id]
  scripts/deploy-secure-build.sh status
  scripts/deploy-secure-build.sh releases

Commands:
  deploy       Require a clean commit, run the complete local gate, build that
               commit through the restricted secure.build protocol, canary it,
               atomically activate it, and automatically restore a failed
               activation.
  deploy-verified
               GitHub workflow_run path for an exact successful CI revision.
               It removes only the duplicate local gate; secure.build still
               performs its locked build, verification, canary, and activation.
  rollback     Atomically activate `previous`, or the named retained release.
               A successful rollback swaps `current` and `previous`, so the
               command can be used again to undo the rollback.
  status       Show the active/previous release and live service receipt.
  releases     List retained versioned releases on the host.

Environment:
  MARKS_DEPLOY_BRANCH         Required origin branch (default: main)
  MARKS_DEPLOY_IDENTITY_FILE  Optional private-key path for a local invocation;
                              GitHub uses its ephemeral SSH agent instead.

Deployment intentionally has no skip-tests or dirty-tree switch. Rollback and
status do not build and do not run the pre-deploy suite. The SSH target and
remote command grammar are fixed rather than supplied by the environment.
deploy-verified is rejected outside the exact GitHub workflow_run contract.
EOF
}

die() {
  echo "deploy: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$STAGED_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    restricted_command cleanup "$STAGED_REVISION" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

validate_deploy_config() {
  [[ "$DEPLOY_BRANCH" =~ ^[A-Za-z0-9._/-]+$ \
    && "$DEPLOY_BRANCH" != /* \
    && "$DEPLOY_BRANCH" != */ \
    && "$DEPLOY_BRANCH" != *..* ]] \
    || die "MARKS_DEPLOY_BRANCH is not a safe branch name"
}

restricted_command() {
  local command=$1
  shift
  case "$command" in
    probe|upload|cleanup|deploy|rollback|status|releases) ;;
    *) die "unsupported restricted command: $command" ;;
  esac

  local request=$command
  local argument
  for argument in "$@"; do
    [[ "$argument" =~ ^[A-Za-z0-9._-]+$ ]] \
      || die "unsafe remote argument: $argument"
    request+=" $argument"
  done
  "${SSH[@]}" "$HOST" "$request"
}

check_remote_protocol() {
  echo "==> checking restricted deployment protocol"
  restricted_command probe
}

assert_clean_commit() {
  local status
  status=$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)
  if [[ -n "$status" ]]; then
    echo "$status" >&2
    die "deploy requires a clean, committed tree so the receipt matches the shipped source"
  fi
  git -C "$ROOT" rev-parse --verify 'HEAD^{commit}' >/dev/null
}

assert_published_commit() {
  git check-ref-format --branch "$DEPLOY_BRANCH" >/dev/null \
    || die "MARKS_DEPLOY_BRANCH is not a valid Git branch"
  git -C "$ROOT" fetch --quiet origin \
    "refs/heads/$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"
  local head published
  head=$(git -C "$ROOT" rev-parse HEAD)
  published=$(git -C "$ROOT" rev-parse "refs/remotes/origin/$DEPLOY_BRANCH") \
    || die "origin/$DEPLOY_BRANCH is unavailable after fetch"
  [[ "$head" == "$published" ]] \
    || die "HEAD $head is not the published origin/$DEPLOY_BRANCH commit $published"
}

with_pinned_rust() {
  local cargo_path toolchain_bin
  cargo_path=$(rustup which cargo --toolchain 1.88.0) \
    || die "Rust 1.88.0 is not installed through rustup"
  toolchain_bin=${cargo_path%/*}
  PATH="$toolchain_bin:$PATH" RUSTUP_TOOLCHAIN=1.88.0 \
    "$@"
}

cargo_pinned() {
  local cargo_path
  cargo_path=$(rustup which cargo --toolchain 1.88.0) \
    || die "Rust 1.88.0 is not installed through rustup"
  with_pinned_rust "$cargo_path" "$@"
}

run_local_gate() {
  local revision=$1
  require_command git
  require_command ssh
  require_command npm
  require_command node
  require_command rustup
  require_command curl
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12)) process.exit(1);
  ' || die "Node 22.12 or newer is required"

  echo "==> installing locked browser dependencies"
  (cd "$ROOT" && npm ci)

  echo "==> Rust format, workspace tests, and warnings-as-errors lint"
  (cd "$ROOT" && cargo_pinned fmt --all --check)
  (cd "$ROOT" && cargo_pinned test --workspace --locked)
  (cd "$ROOT" && cargo_pinned clippy --workspace --all-targets --locked -- -D warnings)

  echo "==> TypeScript and checked-in ESBT artifact verification"
  (cd "$ROOT" && npm run typecheck)
  (cd "$ROOT" && npm run verify:esbt)

  echo "==> browser, product, renderer, Wasm, auth, benchmark, and harness tests"
  (cd "$ROOT" && npm run test:browser)
  (cd "$ROOT" && npm run test:surface)
  (cd "$ROOT" && npm run test:markdown)
  (cd "$ROOT" && npm run test:bench)
  (cd "$ROOT" && npm run test:component)
  (cd "$ROOT" && npm run test:auth)
  (cd "$ROOT" && npm run test:harness)

  echo "==> production service-mode UI and release-receipt build"
  (cd "$ROOT" && VITE_MARKS_DATA_MODE=service npm run build)
  (cd "$ROOT" && npm run check:ui-budgets)
  (
    cd "$ROOT"
    MARKS_BUILD_REVISION="$revision" MARKS_SOURCE_DIRTY=0 \
      cargo_pinned build -p marks-server --locked
  )

  echo "==> live Chromium workflow plus native multi-peer convergence"
  if [[ "$(uname -s)" == Linux ]]; then
    (cd "$ROOT" && npx playwright install --with-deps chromium)
  else
    (cd "$ROOT" && npx playwright install chromium)
  fi
  (
    cd "$ROOT"
    export MARKS_REQUIRE_RELEASE=1
    with_pinned_rust \
      bash scripts/run-service-ci.sh \
      --bin target/debug/marks-server \
      --static-dir client/dist \
      --browser chromium
  )

  assert_clean_commit
  assert_published_commit
  [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$revision" ]] \
    || die "HEAD changed while the deployment gate was running"
  echo "==> local deployment gate passed for $revision"
}

deploy() {
  validate_deploy_config
  assert_clean_commit
  assert_published_commit

  local revision
  revision=$(git -C "$ROOT" rev-parse HEAD)
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "HEAD is not one full Git revision"

  check_remote_protocol
  run_local_gate "$revision"

  ship_revision "$revision"
}

ship_revision() {
  local revision=$1

  echo "==> uploading exact commit $revision"
  STAGED_REVISION=$revision
  git -C "$ROOT" archive --format=tar "$revision" \
    | restricted_command upload "$revision"

  echo "==> building, canarying, and activating $revision on $HOST"
  restricted_command deploy "$revision"
}

deploy_verified() {
  local expected_revision=$1
  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] \
    || die "deploy-verified requires one full lowercase Git revision"
  [[ "${GITHUB_ACTIONS:-}" == true ]] \
    || die "deploy-verified is available only in GitHub Actions"
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_run ]] \
    || die "deploy-verified requires a workflow_run event"
  [[ "${MARKS_CI_VERIFIED_SHA:-}" == "$expected_revision" ]] \
    || die "deploy-verified revision does not match the successful CI receipt"
  [[ "${MARKS_CI_RUN_ID:-}" =~ ^[0-9]+$ ]] \
    || die "deploy-verified requires the successful CI run id"

  validate_deploy_config
  assert_clean_commit
  assert_published_commit

  local revision
  revision=$(git -C "$ROOT" rev-parse HEAD)
  [[ "$revision" == "$expected_revision" ]] \
    || die "checked-out HEAD $revision does not match verified revision $expected_revision"

  check_remote_protocol
  echo "==> accepting successful CI run $MARKS_CI_RUN_ID for exact revision $revision"
  ship_revision "$revision"
}

main() {
  local command=${1:-}
  case "$command" in
    deploy)
      [[ $# -eq 1 ]] || die "deploy accepts no arguments"
      deploy
      ;;
    deploy-verified)
      [[ $# -eq 2 ]] || die "deploy-verified requires one revision"
      deploy_verified "$2"
      ;;
    rollback)
      [[ $# -le 2 ]] || die "rollback accepts at most one release id"
      if [[ $# -eq 2 ]]; then
        restricted_command rollback "$2"
      else
        restricted_command rollback
      fi
      ;;
    status)
      [[ $# -eq 1 ]] || die "status accepts no arguments"
      restricted_command status
      ;;
    releases)
      [[ $# -eq 1 ]] || die "releases accepts no arguments"
      restricted_command releases
      ;;
    help|--help|-h)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
