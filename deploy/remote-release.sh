#!/usr/bin/env bash
# Remote half of scripts/deploy-secure-build.sh. It is intentionally usable
# over `bash -s` so rollback does not depend on the currently active release.
set -euo pipefail

MARKS_ROOT=${MARKS_ROOT:-/opt/marks}
RELEASES="$MARKS_ROOT/releases"
CURRENT_LINK="$MARKS_ROOT/current"
PREVIOUS_LINK="$MARKS_ROOT/previous"
DEPLOY_DIR="$MARKS_ROOT/deploy"
BUILD_CACHE="$MARKS_ROOT/.build-cache"
SERVICE=${MARKS_SERVICE:-marks.service}
UNIT_PATH=${MARKS_UNIT_PATH:-/etc/systemd/system/marks.service}
LOCAL_ORIGIN=${MARKS_LOCAL_ORIGIN:-http://127.0.0.1:5192}
PUBLIC_ORIGIN=${MARKS_PUBLIC_ORIGIN:-https://marks.secure.build}
OBSERVE_SECONDS=${MARKS_OBSERVE_SECONDS:-30}
BUILDER_IMAGE=${MARKS_RUST_BUILDER_IMAGE:-rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0}
SCRIPT_PATH=${BASH_SOURCE[0]:-}
BUILT_RELEASE=""
CANARY_PID=""
CANARY_DIR=""
RELEASE_STAGE=""

log() {
  echo "remote-release: $*"
}

die() {
  echo "remote-release: $*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

run_sudo() {
  sudo -n "$@"
}

validate_config() {
  [[ "$MARKS_ROOT" == /* && "$MARKS_ROOT" != "/" ]] \
    || die "MARKS_ROOT must be a non-root absolute path"
  [[ "$PUBLIC_ORIGIN" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || die "MARKS_PUBLIC_ORIGIN must be one HTTP(S) origin without a path"
  [[ "$LOCAL_ORIGIN" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] \
    || die "MARKS_LOCAL_ORIGIN must be loopback HTTP with an explicit port"
  [[ "$OBSERVE_SECONDS" =~ ^[0-9]+$ ]] \
    || die "MARKS_OBSERVE_SECONDS must be an integer"
  (( OBSERVE_SECONDS >= 5 && OBSERVE_SECONDS <= 600 )) \
    || die "MARKS_OBSERVE_SECONDS must be between 5 and 600"
}

prepare_root() {
  local user group
  user=$(id -un)
  group=$(id -gn)
  run_sudo install -d -o "$user" -g "$group" -m 0755 \
    "$MARKS_ROOT" "$RELEASES" "$DEPLOY_DIR" "$BUILD_CACHE"
  install -d -m 0755 "$BUILD_CACHE/cargo" "$BUILD_CACHE/target"
}

resolve_path() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

with_lock() {
  exec 9>"$MARKS_ROOT/.deploy.lock"
  flock -n 9 || die "another Marks deployment or rollback holds $MARKS_ROOT/.deploy.lock"
  "$@"
}

release_from_link() {
  local link=$1
  [[ -L "$link" ]] || return 1
  local resolved release_root
  resolved=$(resolve_path "$link") || return 1
  release_root=$(resolve_path "$RELEASES") || return 1
  case "$resolved" in
    "$release_root"/*)
      [[ -d "$resolved" ]] || return 1
      printf '%s\n' "$resolved"
      ;;
    *)
      return 1
      ;;
  esac
}

release_id() {
  basename "$1"
}

release_revision() {
  local release=$1
  python3 - "$release/release.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
if value.get("schema") != "marks-release.v1":
    raise SystemExit("release.json has the wrong schema")
revision = value.get("revision")
if not isinstance(revision, str):
    raise SystemExit("release.json has no revision")
print(revision)
PY
}

validate_release() {
  local release=$1
  local resolved release_root
  resolved=$(resolve_path "$release") || return 1
  release_root=$(resolve_path "$RELEASES") || return 1
  case "$resolved" in
    "$release_root"/*) ;;
    *) die "release escapes $RELEASES: $release"; return 1 ;;
  esac
  [[ -x "$resolved/marks-server" ]] || die "release has no executable marks-server: $resolved"
  [[ -f "$resolved/static/index.html" ]] || die "release has no static/index.html: $resolved"
  [[ -f "$resolved/marks.service" ]] || die "release has no marks.service: $resolved"
  if find "$resolved" -type l -print -quit | grep -q .; then
    die "release contains a symbolic link: $resolved"
    return 1
  fi

  if [[ -f "$resolved/release.json" ]]; then
    [[ -x "$resolved/marks-admin" ]] || die "release has no executable marks-admin: $resolved"
    [[ -f "$resolved/SHA256SUMS" ]] || die "release has no SHA256SUMS: $resolved"
    (cd "$resolved" && sha256sum -c --quiet SHA256SUMS) \
      || die "release checksum verification failed: $resolved"
    local revision
    revision=$(release_revision "$resolved") || return 1
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "release has an invalid revision: $resolved"
  elif [[ -f "$resolved/LEGACY" ]]; then
    [[ -f "$resolved/SHA256SUMS" ]] || die "legacy release has no SHA256SUMS: $resolved"
    (cd "$resolved" && sha256sum -c --quiet SHA256SUMS) \
      || die "legacy release checksum verification failed: $resolved"
  else
    die "release has neither a versioned receipt nor a legacy receipt: $resolved"
    return 1
  fi
}

atomic_link() {
  local target=$1
  local link=$2
  python3 - "$target" "$link" <<'PY'
import os
import sys
target, link = sys.argv[1:]
temporary = f"{link}.new.{os.getpid()}"
try:
    os.symlink(target, temporary)
    os.replace(temporary, link)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

wait_for_url() {
  local url=$1
  local timeout=${2:-60}
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "timed out waiting for $url"
}

verify_ok_json() {
  local url=$1
  local body
  body=$(mktemp /tmp/marks-json.XXXXXXXX)
  if ! curl --fail --silent --show-error --max-time 10 "$url" > "$body"; then
    rm -f "$body"
    return 1
  fi
  local status=0
  if python3 - "$body" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if body.get("ok") is not True:
    raise SystemExit("response did not contain ok=true")
PY
  then
    :
  else
    status=$?
  fi
  rm -f "$body"
  return "$status"
}

verify_artifact() {
  local origin=$1
  local expected_revision=$2
  local body headers
  body=$(mktemp /tmp/marks-artifact.XXXXXXXX)
  headers=$(mktemp /tmp/marks-headers.XXXXXXXX)
  if ! curl --fail --silent --show-error --max-time 10 \
    -D "$headers" "$origin/v1/artifact" > "$body"; then
    rm -f "$body" "$headers"
    return 1
  fi
  local status=0
  if python3 - "$body" "$headers" "$expected_revision" <<'PY'
import json
import sys
body_path, headers_path, expected = sys.argv[1:]
with open(body_path, encoding="utf-8") as handle:
    body = json.load(handle)
required = {
    "buildRevision": expected,
    "serverSourceDirty": False,
    "wasmSourceDirty": False,
    "staticArtifactVerified": True,
    "profileCoherent": True,
    "engineCoherent": True,
    "releaseReady": True,
}
for key, value in required.items():
    if body.get(key) != value:
        raise SystemExit(f"artifact {key}={body.get(key)!r}, expected {value!r}")
headers = {}
with open(headers_path, encoding="iso-8859-1") as handle:
    for line in handle:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
if headers.get("x-marks-release") != expected:
    raise SystemExit("X-Marks-Release does not match the build revision")
PY
  then
    :
  else
    status=$?
  fi
  rm -f "$body" "$headers"
  return "$status"
}

verify_running_release() {
  local release=$1
  local include_public=${2:-1}

  wait_for_url "$LOCAL_ORIGIN/healthz" 60
  verify_ok_json "$LOCAL_ORIGIN/healthz" \
    || die "local health response is not the expected JSON"

  # A legacy snapshot predates /readyz and the artifact receipt. It exists
  # solely so the first versioned deployment can restore the known process.
  if [[ ! -f "$release/release.json" ]]; then
    if [[ "$include_public" == 1 ]]; then
      wait_for_url "$PUBLIC_ORIGIN/healthz" 60
      verify_ok_json "$PUBLIC_ORIGIN/healthz" \
        || die "public legacy health response is not the expected JSON"
      curl --fail --silent --show-error --max-time 10 "$PUBLIC_ORIGIN/" \
        | grep -Fqi '<!doctype html>' \
        || die "public root did not serve the legacy Marks HTML shell"
    fi
    return 0
  fi

  local revision
  revision=$(release_revision "$release")
  wait_for_url "$LOCAL_ORIGIN/readyz" 60
  verify_ok_json "$LOCAL_ORIGIN/readyz" \
    || die "local readiness response is not the expected JSON"
  verify_artifact "$LOCAL_ORIGIN" "$revision" \
    || die "local artifact receipt does not match $revision"

  if [[ "$include_public" == 1 ]]; then
    wait_for_url "$PUBLIC_ORIGIN/readyz" 60
    verify_ok_json "$PUBLIC_ORIGIN/readyz" \
      || die "public readiness response is not the expected JSON"
    verify_artifact "$PUBLIC_ORIGIN" "$revision" \
      || die "public artifact receipt does not match $revision"
    curl --fail --silent --show-error --max-time 10 "$PUBLIC_ORIGIN/" \
      | grep -Fqi '<!doctype html>' \
      || die "public root did not serve the Marks HTML shell"
  fi
}

install_release_unit() {
  local release=$1
  run_sudo install -m 0644 "$release/marks.service" "$UNIT_PATH"
  run_sudo systemctl daemon-reload
}

service_stop() {
  run_sudo systemctl stop "$SERVICE"
}

service_start() {
  run_sudo systemctl start "$SERVICE"
}

service_logs() {
  run_sudo journalctl -u "$SERVICE" -n 100 --no-pager >&2 || true
}

verify_release_unit() {
  run_sudo systemd-analyze verify "$1/marks.service"
}

cleanup_canary() {
  if [[ -n "$CANARY_PID" ]]; then
    kill -TERM "$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
    CANARY_PID=""
  fi
  if [[ -n "$CANARY_DIR" && "$CANARY_DIR" =~ ^/tmp/marks-canary\.[A-Za-z0-9]+$ ]]; then
    rm -rf -- "$CANARY_DIR"
    CANARY_DIR=""
  fi
}

cleanup_release_stage() {
  if [[ -n "$RELEASE_STAGE" ]]; then
    case "$RELEASE_STAGE" in
      "$RELEASES"/.*.staging.*)
        rm -rf -- "$RELEASE_STAGE"
        ;;
    esac
    RELEASE_STAGE=""
  fi
}

cleanup_transients() {
  cleanup_canary
  cleanup_release_stage
}

observe_release() {
  local release=$1
  local baseline restarts deadline
  baseline=$(systemctl show "$SERVICE" -p NRestarts --value)
  deadline=$((SECONDS + OBSERVE_SECONDS))
  while (( SECONDS < deadline )); do
    if [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" != active ]]; then
      die "$SERVICE stopped during the observation window"
      return 1
    fi
    restarts=$(systemctl show "$SERVICE" -p NRestarts --value)
    if [[ "$restarts" != "$baseline" ]]; then
      die "$SERVICE restarted during the observation window ($baseline -> $restarts)"
      return 1
    fi
    verify_running_release "$release" 1 || return 1
    sleep 2
  done
}

activate_release() {
  local target=$1
  local observe=${2:-1}
  validate_release "$target"
  target=$(resolve_path "$target")

  local old=""
  old=$(release_from_link "$CURRENT_LINK" 2>/dev/null || true)
  if [[ "$old" == "$target" ]]; then
    log "$(release_id "$target") is already current; verifying it"
    verify_running_release "$target" 1
    return 0
  fi

  log "activating $(release_id "$target")"
  verify_release_unit "$target" \
    || { die "systemd rejected the target release unit"; return 1; }
  local activated=0
  if service_stop \
    && atomic_link "$target" "$CURRENT_LINK" \
    && install_release_unit "$target" \
    && service_start \
    && verify_running_release "$target" 1 \
    && { [[ "$observe" == 0 ]] || observe_release "$target"; }; then
    if [[ -z "$old" || "$old" == "$target" ]] \
      || atomic_link "$old" "$PREVIOUS_LINK"; then
      activated=1
    fi
  fi

  if [[ "$activated" == 1 ]]; then
    log "active release: $(release_id "$target")"
    return 0
  fi

  log "activation failed; restoring ${old:-the prior service state}"
  service_logs
  service_stop || true
  if [[ -n "$old" ]]; then
    if atomic_link "$old" "$CURRENT_LINK" \
      && install_release_unit "$old" \
      && service_start \
      && verify_running_release "$old" 1; then
      log "automatic rollback restored $(release_id "$old")"
    else
      service_logs
      die "automatic rollback could not restore $(release_id "$old")"
      return 1
    fi
  else
    die "activation failed and no prior release exists"
    return 1
  fi
  die "deployment failed health checks and was rolled back"
}

snapshot_legacy_release() {
  local current=""
  current=$(release_from_link "$CURRENT_LINK" 2>/dev/null || true)
  if [[ -n "$current" ]]; then
    validate_release "$current"
    return 0
  fi

  [[ -x "$MARKS_ROOT/marks-server" && -f "$MARKS_ROOT/static/index.html" ]] \
    || die "there is no current symlink or legacy /opt/marks installation to preserve"
  [[ -f "$UNIT_PATH" ]] || die "legacy service unit is missing: $UNIT_PATH"

  local id stage release
  id="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  release="$RELEASES/$id"
  stage="$RELEASES/.$id.staging.$$"
  RELEASE_STAGE=$stage
  install -d -m 0755 "$stage/static"
  install -m 0755 "$MARKS_ROOT/marks-server" "$stage/marks-server"
  if [[ -x "$MARKS_ROOT/marks-admin" ]]; then
    install -m 0755 "$MARKS_ROOT/marks-admin" "$stage/marks-admin"
  fi
  rsync -a "$MARKS_ROOT/static/" "$stage/static/"
  sed \
    -e 's|^WorkingDirectory=/opt/marks$|WorkingDirectory=/opt/marks/current|' \
    -e 's|^Environment=MARKS_STATIC_DIR=/opt/marks/static$|Environment=MARKS_STATIC_DIR=/opt/marks/current/static|' \
    -e 's|^ExecStart=/opt/marks/marks-server$|ExecStart=/opt/marks/current/marks-server|' \
    "$UNIT_PATH" > "$stage/marks.service"
  grep -Fq 'ExecStart=/opt/marks/current/marks-server' "$stage/marks.service" \
    || die "could not bind the legacy unit to its retained release"
  grep -Fq 'Environment=MARKS_STATIC_DIR=/opt/marks/current/static' "$stage/marks.service" \
    || die "could not bind the legacy static directory to its retained release"
  grep -Fq 'WorkingDirectory=/opt/marks/current' "$stage/marks.service" \
    || die "could not bind the legacy working directory to its retained release"
  printf 'Legacy release captured before versioned deployment.\n' > "$stage/LEGACY"
  (
    cd "$stage"
    { find marks-server marks.service LEGACY static -type f -print; \
      [[ ! -f marks-admin ]] || printf '%s\n' marks-admin; } \
      | LC_ALL=C sort \
      | while IFS= read -r path; do sha256sum "$path"; done \
      > SHA256SUMS
  )
  mv "$stage" "$release"
  RELEASE_STAGE=""
  validate_release "$release"
  atomic_link "$release" "$CURRENT_LINK"
  log "preserved legacy installation as $id"
}

build_release() {
  local source=$1
  local revision=$2
  local unit=$3
  local release="$RELEASES/$revision"

  if [[ -d "$release" ]]; then
    validate_release "$release"
    local recorded
    recorded=$(release_revision "$release")
    [[ "$recorded" == "$revision" ]] \
      || die "existing release directory has a different receipt: $release"
    log "reusing previously verified release $revision"
    BUILT_RELEASE="$release"
    return 0
  fi

  require_command docker
  require_command npm
  require_command node
  require_command sha256sum
  [[ -d "$source" && -f "$source/Cargo.lock" && -f "$source/package-lock.json" ]] \
    || die "uploaded source archive is incomplete: $source"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "revision must be 40 lowercase hex characters"
  [[ -f "$unit" ]] || die "systemd unit is missing: $unit"
  grep -Fq 'ExecStart=/opt/marks/current/marks-server' "$unit" \
    || die "systemd unit does not execute the atomic current release"
  grep -Fq 'Environment=MARKS_STATIC_DIR=/opt/marks/current/static' "$unit" \
    || die "systemd unit does not serve static files from the atomic current release"
  grep -Fq 'WorkingDirectory=/opt/marks/current' "$unit" \
    || die "systemd unit does not use the atomic current release as its working directory"

  log "installing locked Node dependencies"
  (cd "$source" && npm ci)
  (cd "$source" && npm run verify:esbt)
  (cd "$source" && VITE_MARKS_DATA_MODE=service npm run build)
  (cd "$source" && npm run check:ui-budgets)

  log "building Linux x86_64 binaries with $BUILDER_IMAGE"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --env CARGO_HOME=/cargo \
    --env CARGO_TARGET_DIR=/target \
    --env RUSTUP_TOOLCHAIN=1.88.0 \
    --env MARKS_BUILD_REVISION="$revision" \
    --env MARKS_SOURCE_DIRTY=0 \
    --volume "$source:/work:ro" \
    --volume "$BUILD_CACHE/cargo:/cargo" \
    --volume "$BUILD_CACHE/target:/target" \
    --workdir /work \
    "$BUILDER_IMAGE" \
    bash -ceu '
      case "$(rustc --version)" in
        "rustc 1.88.0 "*) ;;
        *) echo "unexpected builder toolchain: $(rustc --version)" >&2; exit 1 ;;
      esac
      cargo build -p marks-server --release --locked --bin marks-server --bin marks-admin
    '

  local stage="$RELEASES/.$revision.staging.$$"
  RELEASE_STAGE=$stage
  install -d -m 0755 "$stage/static"
  install -m 0755 "$BUILD_CACHE/target/release/marks-server" "$stage/marks-server"
  install -m 0755 "$BUILD_CACHE/target/release/marks-admin" "$stage/marks-admin"
  rsync -a --delete "$source/client/dist/" "$stage/static/"
  install -m 0644 "$unit" "$stage/marks.service"
  if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
    install -m 0755 "$SCRIPT_PATH" "$stage/remote-release.sh"
  fi
  python3 - "$stage/release.json" "$revision" "$BUILDER_IMAGE" <<'PY'
import datetime
import json
import sys
path, revision, image = sys.argv[1:]
value = {
    "schema": "marks-release.v1",
    "revision": revision,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "builderImage": image,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(value, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  (
    cd "$stage"
    { find marks-server marks-admin marks.service release.json static -type f -print; \
      [[ ! -f remote-release.sh ]] || printf '%s\n' remote-release.sh; } \
      | LC_ALL=C sort \
      | while IFS= read -r path; do sha256sum "$path"; done \
      > SHA256SUMS
  )
  mv "$stage" "$release"
  RELEASE_STAGE=""
  validate_release "$release"
  log "built release $revision"
  BUILT_RELEASE="$release"
}

canary_release() {
  local release=$1
  validate_release "$release"
  local revision
  revision=$(release_revision "$release")

  local canary port pid log_path
  canary=$(mktemp -d /tmp/marks-canary.XXXXXXXX)
  CANARY_DIR=$canary
  port=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )
  log_path="$canary/server.log"
  MARKS_LISTEN="127.0.0.1:$port" \
  MARKS_ORIGIN="http://127.0.0.1:$port" \
  MARKS_DB="$canary/marks.db3" \
  MARKS_ASSET_DIR="$canary/assets" \
  MARKS_STATIC_DIR="$release/static" \
  RUST_LOG=info \
    "$release/marks-server" > "$log_path" 2>&1 &
  pid=$!
  CANARY_PID=$pid

  local status=0
  if ! wait_for_url "http://127.0.0.1:$port/readyz" 60 \
    || ! verify_ok_json "http://127.0.0.1:$port/readyz" \
    || ! verify_artifact "http://127.0.0.1:$port" "$revision"; then
    status=1
    sed -n '1,240p' "$log_path" >&2 || true
  fi
  cleanup_canary
  [[ "$status" == 0 ]] || die "candidate release failed its isolated canary"
  log "isolated canary passed for $revision"
}

install_remote_helper() {
  local release=$1
  if [[ -f "$release/remote-release.sh" ]]; then
    install -m 0755 "$release/remote-release.sh" "$DEPLOY_DIR/remote-release.sh"
  fi
}

deploy_locked() {
  local source=$1
  local revision=$2
  local unit=$3
  snapshot_legacy_release
  build_release "$source" "$revision" "$unit"
  local release=$BUILT_RELEASE
  validate_release "$release"
  canary_release "$release"
  install_remote_helper "$release"
  activate_release "$release" 1
}

rollback_locked() {
  local requested=${1:-}
  local target
  if [[ -n "$requested" ]]; then
    [[ "$requested" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid release id: $requested"
    target="$RELEASES/$requested"
  else
    target=$(release_from_link "$PREVIOUS_LINK") \
      || die "there is no previous release to activate"
  fi
  validate_release "$target"
  activate_release "$target" 0
}

status_command() {
  local current previous current_label
  current=$(release_from_link "$CURRENT_LINK" 2>/dev/null || true)
  previous=$(release_from_link "$PREVIOUS_LINK" 2>/dev/null || true)
  current_label="${current:+$(release_id "$current")}"
  if [[ -z "$current_label" && -x "$MARKS_ROOT/marks-server" ]]; then
    current_label="legacy-direct (not yet rollback-managed)"
  fi
  printf 'current:  %s\n' "$current_label"
  printf 'previous: %s\n' "${previous:+$(release_id "$previous")}"
  systemctl show "$SERVICE" \
    -p ActiveState -p SubState -p MainPID -p NRestarts --no-pager 2>/dev/null || true
  if [[ -n "$current" ]]; then
    if [[ -f "$current/release.json" ]]; then
      curl --fail --silent --show-error --max-time 10 "$LOCAL_ORIGIN/v1/artifact" || true
      printf '\n'
    else
      printf 'receipt:  legacy release predates /v1/artifact\n'
    fi
  fi
}

releases_command() {
  if [[ ! -d "$RELEASES" ]]; then
    return 0
  fi
  local current previous path marker
  current=$(release_from_link "$CURRENT_LINK" 2>/dev/null || true)
  previous=$(release_from_link "$PREVIOUS_LINK" 2>/dev/null || true)
  while IFS= read -r path; do
    marker=""
    [[ "$path" == "$current" ]] && marker=" current"
    [[ "$path" == "$previous" ]] && marker="$marker previous"
    printf '%s%s\n' "$(release_id "$path")" "$marker"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*.staging.*' -print | LC_ALL=C sort)
}

usage() {
  cat <<'EOF'
Usage: remote-release.sh deploy <source> <revision> <unit>
       remote-release.sh rollback [release-id]
       remote-release.sh status
       remote-release.sh releases
EOF
}

main() {
  validate_config
  require_command curl
  require_command python3
  local command=${1:-}
  case "$command" in
    deploy)
      [[ $# -eq 4 ]] || { usage >&2; return 2; }
      prepare_root
      require_command flock
      require_command rsync
      require_command sha256sum
      require_command systemd-analyze
      with_lock deploy_locked "$2" "$3" "$4"
      ;;
    rollback)
      [[ $# -le 2 ]] || { usage >&2; return 2; }
      prepare_root
      require_command flock
      require_command sha256sum
      require_command systemd-analyze
      with_lock rollback_locked "${2:-}"
      ;;
    status)
      [[ $# -eq 1 ]] || { usage >&2; return 2; }
      status_command
      ;;
    releases)
      [[ $# -eq 1 ]] || { usage >&2; return 2; }
      releases_command
      ;;
    help|--help|-h)
      usage
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  trap cleanup_transients EXIT
  trap 'cleanup_transients; exit 130' INT
  trap 'cleanup_transients; exit 143' TERM
  main "$@"
fi
