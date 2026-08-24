#!/usr/bin/env bash
# Build, prove, and atomically deploy one clean Marks commit to secure.build.
# The release is built on the Linux host so a macOS checkout cannot
# accidentally upload a Darwin binary. See deploy/README.md for the release
# layout and rollback contract.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOST=${MARKS_DEPLOY_HOST:-devuser@secure.build}
PUBLIC_ORIGIN=${MARKS_PUBLIC_ORIGIN:-https://marks.secure.build}
OBSERVE_SECONDS=${MARKS_OBSERVE_SECONDS:-30}
DEPLOY_BRANCH=${MARKS_DEPLOY_BRANCH:-main}
REMOTE_UPLOAD=""

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-secure-build.sh deploy
  scripts/deploy-secure-build.sh rollback [release-id]
  scripts/deploy-secure-build.sh status
  scripts/deploy-secure-build.sh releases

Commands:
  deploy       Require a clean commit, run the complete local gate, build that
               commit for Linux on devuser@secure.build, canary it, atomically
               activate it, and automatically roll back failed health checks.
  rollback     Atomically activate `previous`, or the named retained release.
               A successful rollback swaps `current` and `previous`, so the
               command can be used again to undo the rollback.
  status       Show the active/previous release and live service receipt.
  releases     List retained versioned releases on the host.

Environment:
  MARKS_DEPLOY_HOST       SSH target (default: devuser@secure.build)
  MARKS_PUBLIC_ORIGIN     Public origin (default: https://marks.secure.build)
  MARKS_OBSERVE_SECONDS   Post-start health observation, 5-600 (default: 30)
  MARKS_DEPLOY_BRANCH     Required origin branch (default: main)

Deployment intentionally has no skip-tests or dirty-tree switch. Rollback and
status do not build and do not run the pre-deploy suite.
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
  if [[ -n "$REMOTE_UPLOAD" ]]; then
    if [[ "$REMOTE_UPLOAD" =~ ^/tmp/marks-deploy\.[A-Za-z0-9]+$ ]]; then
      ssh -o BatchMode=yes "$HOST" "rm -rf -- '$REMOTE_UPLOAD'" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

validate_common_config() {
  [[ "$PUBLIC_ORIGIN" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || die "MARKS_PUBLIC_ORIGIN must be one HTTP(S) origin without a path"
  [[ "$OBSERVE_SECONDS" =~ ^[0-9]+$ ]] \
    || die "MARKS_OBSERVE_SECONDS must be an integer"
  (( OBSERVE_SECONDS >= 5 && OBSERVE_SECONDS <= 600 )) \
    || die "MARKS_OBSERVE_SECONDS must be between 5 and 600"
  [[ "$DEPLOY_BRANCH" =~ ^[A-Za-z0-9._/-]+$ \
    && "$DEPLOY_BRANCH" != /* \
    && "$DEPLOY_BRANCH" != */ \
    && "$DEPLOY_BRANCH" != *..* ]] \
    || die "MARKS_DEPLOY_BRANCH is not a safe branch name"
}

remote_command() {
  local command=$1
  shift
  local quoted_args=""
  local argument
  for argument in "$@"; do
    [[ "$argument" =~ ^[A-Za-z0-9._-]+$ ]] \
      || die "unsafe remote argument: $argument"
    quoted_args+=" '$argument'"
  done
  ssh -o BatchMode=yes "$HOST" \
    "MARKS_PUBLIC_ORIGIN='$PUBLIC_ORIGIN' MARKS_OBSERVE_SECONDS='$OBSERVE_SECONDS' bash -s -- '$command'$quoted_args" \
    < "$ROOT/deploy/remote-release.sh"
}

check_remote_build_prerequisites() {
  echo "==> checking deployment host prerequisites"
  ssh -o BatchMode=yes "$HOST" '
    set -eu
    test "$(uname -s)" = Linux
    test "$(uname -m)" = x86_64
    for command in docker npm rsync flock curl python3 sha256sum tar systemd-analyze; do
      command -v "$command" >/dev/null 2>&1 || {
        echo "missing remote command: $command" >&2
        exit 1
      }
    done
    sudo -n true
    docker info >/dev/null
    node -e "
      const [major, minor] = process.versions.node.split(\".\").map(Number);
      if (major < 22 || (major === 22 && minor < 12)) process.exit(1);
    "
  '
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
  (cd "$ROOT" && npm run test:wasm)
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
  (cd "$ROOT" && npx playwright install chromium)
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
  validate_common_config
  assert_clean_commit
  assert_published_commit
  check_remote_build_prerequisites

  local revision
  revision=$(git -C "$ROOT" rev-parse HEAD)
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "HEAD is not one full Git revision"

  run_local_gate "$revision"

  echo "==> uploading exact commit $revision"
  REMOTE_UPLOAD=$(
    ssh -o BatchMode=yes "$HOST" 'mktemp -d /tmp/marks-deploy.XXXXXXXX' | tail -n 1
  )
  [[ "$REMOTE_UPLOAD" =~ ^/tmp/marks-deploy\.[A-Za-z0-9]+$ ]] \
    || die "host returned an unexpected staging path: $REMOTE_UPLOAD"
  ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_UPLOAD/source'"
  git -C "$ROOT" archive --format=tar "$revision" \
    | ssh -o BatchMode=yes "$HOST" "tar -xf - -C '$REMOTE_UPLOAD/source'"

  echo "==> building, canarying, and activating $revision on $HOST"
  ssh -o BatchMode=yes "$HOST" \
    "MARKS_PUBLIC_ORIGIN='$PUBLIC_ORIGIN' MARKS_OBSERVE_SECONDS='$OBSERVE_SECONDS' bash '$REMOTE_UPLOAD/source/deploy/remote-release.sh' deploy '$REMOTE_UPLOAD/source' '$revision' '$REMOTE_UPLOAD/source/deploy/systemd/marks.service'"
}

main() {
  local command=${1:-}
  case "$command" in
    deploy)
      [[ $# -eq 1 ]] || die "deploy accepts no arguments"
      deploy
      ;;
    rollback)
      [[ $# -le 2 ]] || die "rollback accepts at most one release id"
      validate_common_config
      if [[ $# -eq 2 ]]; then
        remote_command rollback "$2"
      else
        remote_command rollback
      fi
      ;;
    status)
      [[ $# -eq 1 ]] || die "status accepts no arguments"
      validate_common_config
      remote_command status
      ;;
    releases)
      [[ $# -eq 1 ]] || die "releases accepts no arguments"
      validate_common_config
      remote_command releases
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
