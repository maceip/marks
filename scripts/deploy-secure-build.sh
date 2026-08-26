#!/usr/bin/env bash
# Build, prove, and atomically deploy one clean Marks commit through the
# restricted secure.build deployment protocol. The release is built on the
# Linux host so a macOS checkout cannot accidentally upload a Darwin binary.
# See deploy/README.md for the release layout and rollback contract.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOST=marks-deploy@secure.build
PUBLIC_ORIGIN=https://marks.secure.build
TARGET_PRODUCT_VARIANT=stable
DEPLOY_BRANCH=${MARKS_DEPLOY_BRANCH:-main}
IDENTITY_FILE=${MARKS_DEPLOY_IDENTITY_FILE:-}
STAGED_REVISION=""
PRODUCT_VARIANT=""
BUILD_PLAN_SHA256=""
BUILD_PLAN_JSON=""
SERVER_CARGO_FEATURES=""
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
  scripts/deploy-secure-build.sh deploy-verified <revision> <product-variant> <build-plan-sha256>
  scripts/deploy-secure-build.sh rollback [release-id]
  scripts/deploy-secure-build.sh status
  scripts/deploy-secure-build.sh verify
  scripts/deploy-secure-build.sh releases

Commands:
  deploy       Require a clean commit, run the complete local gate, build that
               commit through the restricted secure.build protocol, canary it,
               atomically activate it, and automatically restore a failed
               activation.
  deploy-verified
               GitHub workflow_run path for an exact successful CI revision.
               The successful receipt must also match the production product
               variant and canonical build-plan digest.
               It removes only the duplicate local gate; secure.build still
               performs its locked build, verification, canary, and activation.
  rollback     Atomically activate `previous`, or a named retained stable v2
               release. The host rejects `previous` if it lacks a stable v2
               product-build receipt; legacy recovery is root-only break-glass.
               A successful rollback swaps `current` and `previous`, so the
               command can be used again to undo the rollback.
  status       Show the active/previous release and live service receipt.
  verify       Fail unless the restricted status receipt, the public health
               and readiness endpoints, and the public artifact receipt all
               agree on one coherent, release-ready deployment. status is
               output; verify is the gate.
  releases     List retained versioned releases on the host.

Environment:
  MARKS_DEPLOY_BRANCH         Required origin branch (default: main)
  MARKS_DEPLOY_IDENTITY_FILE  Optional private-key path for a local invocation;
                              GitHub uses its ephemeral SSH agent instead.

Deployment intentionally has no skip-tests or dirty-tree switch. Rollback and
status do not build and do not run the pre-deploy suite. The SSH target and
remote command grammar are fixed rather than supplied by the environment.
deploy-verified is rejected outside the exact GitHub workflow_run contract.
The marks.secure.build target is fixed to the checked-in stable variant; this
client cannot select beta or retarget the production service.
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

resolve_product_variant() {
  local requested_variant=$1
  local requested_data_mode=${2:-service}
  local require_deployable=${3:-true}
  [[ "$require_deployable" == true || "$require_deployable" == false ]] \
    || die "internal product variant deployability policy is invalid"
  local receipt fields
  receipt=$(
    cd "$ROOT"
    node --experimental-strip-types scripts/product-variant.ts resolve \
      --variant "$requested_variant" \
      --data-mode "$requested_data_mode" \
      --format json
  ) || die "failed to resolve product variant $requested_variant"
  fields=$(PRODUCT_BUILD_RECEIPT="$receipt" \
    REQUESTED_DATA_MODE="$requested_data_mode" \
    REQUIRE_DEPLOYABLE="$require_deployable" node -e '
    const { createHash } = require("node:crypto");
    const fail = (message) => { console.error(`variant: ${message}`); process.exit(1); };
    let receipt;
    try { receipt = JSON.parse(process.env.PRODUCT_BUILD_RECEIPT); } catch { fail("receipt is not JSON"); }
    const plan = receipt.buildPlan;
    if (receipt.schema !== "marks.product-build-receipt.v1" || !plan) fail("unsupported receipt");
    if (plan.schema !== "marks.product-build-plan.v1") fail("unsupported plan");
    if (typeof plan.deployable !== "boolean" || plan.client?.dataMode !== process.env.REQUESTED_DATA_MODE) {
      fail("plan is not the requested data mode or lacks a deployability decision");
    }
    if (process.env.REQUIRE_DEPLOYABLE === "true" && plan.deployable !== true) {
      fail("plan is not deployable");
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(plan.productVariant)) fail("unsafe product variant");
    if (!/^[0-9a-f]{64}$/.test(receipt.buildPlanSha256)) fail("invalid plan digest");
    const cargo = plan.server?.cargoFeatures;
    if (!Array.isArray(cargo) || cargo.some((name) => !/^[a-z][a-z0-9_-]{0,63}$/.test(name))) {
      fail("invalid server Cargo features");
    }
    if (JSON.stringify(cargo) !== JSON.stringify([...new Set(cargo)].sort())) {
      fail("server Cargo features must be sorted and unique");
    }
    const normalize = (value) => Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
        : value;
    const canonical = JSON.stringify(normalize(plan));
    if (createHash("sha256").update(canonical).digest("hex") !== receipt.buildPlanSha256) {
      fail("plan digest does not match canonical JSON");
    }
    if (canonical.includes("\n") || canonical.includes("\t")) fail("canonical plan is not line-safe");
    process.stdout.write(`${plan.productVariant}\t${receipt.buildPlanSha256}\t${canonical}\t${cargo.join(",")}`);
  ') || die "product variant receipt is invalid"
  IFS=$'\t' read -r PRODUCT_VARIANT BUILD_PLAN_SHA256 BUILD_PLAN_JSON SERVER_CARGO_FEATURES <<< "$fields"
  [[ "$PRODUCT_VARIANT" == "$requested_variant" ]] \
    || die "resolver returned $PRODUCT_VARIANT for requested variant $requested_variant"
}

list_product_variants() {
  (
    cd "$ROOT"
    node --experimental-strip-types scripts/product-variant.ts list
  ) | node -e '
    const { readFileSync } = require("node:fs");
    const variants = JSON.parse(readFileSync(0, "utf8"));
    if (!Array.isArray(variants) || variants.length === 0) throw new Error("product variant catalog is empty");
    const names = new Set();
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(variant.name) ||
          typeof variant.deployable !== "boolean" || names.has(variant.name)) {
        throw new Error("product variant catalog contains an invalid entry");
      }
      names.add(variant.name);
    }
    // Prefer a shipping plan as the representative when several variants
    // compile the same server Cargo feature set.
    variants.sort((left, right) =>
      Number(right.deployable) - Number(left.deployable) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    process.stdout.write(`${variants.map(({ name }) => name).join("\n")}\n`);
  '
}

run_product_variant_server_gate() {
  local -a catalog_variants=()
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && catalog_variants+=("$candidate")
  done < <(list_product_variants)
  [[ ${#catalog_variants[@]} -gt 0 ]] || die "product variant catalog is empty"

  local -a tested_cargo_feature_sets=()
  local cargo_feature_set already_tested existing
  for candidate in "${catalog_variants[@]}"; do
    # Validation-only variants are valid test plans but remain forbidden at
    # every release/deployment boundary.
    resolve_product_variant "$candidate" local false
    cargo_feature_set=$SERVER_CARGO_FEATURES
    already_tested=false
    # Bash 3.2 with nounset rejects expansion of an empty array, so guard the
    # first iteration explicitly while retaining an ordinary indexed array.
    if [[ ${#tested_cargo_feature_sets[@]} -gt 0 ]]; then
      for existing in "${tested_cargo_feature_sets[@]}"; do
        if [[ "$existing" == "$cargo_feature_set" ]]; then
          already_tested=true
          break
        fi
      done
    fi
    if [[ "$already_tested" == true ]]; then
      echo "==> server Cargo feature set already covered; skipping $candidate"
      continue
    fi
    tested_cargo_feature_sets+=("$cargo_feature_set")

    echo "==> server tests and lint for $candidate (${cargo_feature_set:-no Cargo features})"
    local -a catalog_cargo_args
    catalog_cargo_args=(--no-default-features)
    if [[ -n "$cargo_feature_set" ]]; then
      catalog_cargo_args+=(--features "$cargo_feature_set")
    fi
    (
      cd "$ROOT"
      MARKS_PRODUCT_VARIANT="$PRODUCT_VARIANT" \
      MARKS_BUILD_PLAN_SHA256="$BUILD_PLAN_SHA256" \
      MARKS_BUILD_PLAN_JSON="$BUILD_PLAN_JSON" \
        cargo_pinned test -p marks-server --locked "${catalog_cargo_args[@]}"
      MARKS_PRODUCT_VARIANT="$PRODUCT_VARIANT" \
      MARKS_BUILD_PLAN_SHA256="$BUILD_PLAN_SHA256" \
      MARKS_BUILD_PLAN_JSON="$BUILD_PLAN_JSON" \
        cargo_pinned clippy -p marks-server --all-targets --locked \
          "${catalog_cargo_args[@]}" -- -D warnings
    )
  done
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

validate_release_identifier() {
  local identifier=$1
  [[ "$identifier" =~ ^[0-9a-f]{40}\.stable\.[0-9a-f]{64}$ ]] \
    || die "release id is not one retained stable v2 release identity"
}

# The probe receipt carries the SHA-256 of every installed boundary program
# and the root-owned service template. Deployment fails closed unless they
# equal the checked-in deploy/host sources, so a green repository test can
# never certify a different installed implementation.
check_remote_protocol() {
  require_command node
  echo "==> checking restricted deployment protocol identity"
  local probe_receipt
  probe_receipt=$(restricted_command probe)
  printf '%s\n' "$probe_receipt"
  PROBE_RECEIPT="$probe_receipt" MARKS_ROOT_DIR="$ROOT" node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const fail = (message) => { console.error(`probe: ${message}`); process.exit(1); };
    let probe;
    try { probe = JSON.parse(process.env.PROBE_RECEIPT); } catch { fail("receipt is not JSON"); }
    if (probe.protocol !== "marks-deploy.v2") fail(`unsupported protocol: ${probe.protocol}`);
    if (probe.target?.origin !== "https://marks.secure.build" || probe.target?.productVariant !== "stable") {
      fail("installed helper does not own the stable marks.secure.build target");
    }
    const build = probe.buildFilesystem;
    if (
      build?.root !== "/var/lib/marks-deploy/build" ||
      build?.minimumBytes !== 20 * 1024 ** 3 ||
      build?.maximumBytes !== 24 * 1024 ** 3 ||
      !Number.isSafeInteger(build?.capacityBytes) ||
      build.capacityBytes < build.minimumBytes ||
      build.capacityBytes > build.maximumBytes
    ) {
      fail("installed helper did not prove the bounded build filesystem");
    }
    const nodeToolchain = probe.nodeToolchain;
    const expectedNodeToolchain = {
      root: "/opt/marks-build-tools/node-v24.19.0-linux-x64",
      nodePath: "/opt/marks-build-tools/node-v24.19.0-linux-x64/bin/node",
      npmCliPath: "/opt/marks-build-tools/node-v24.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js",
      nodeVersion: "v24.19.0",
      npmVersion: "11.17.0",
      archive: "node-v24.19.0-linux-x64.tar.xz",
      archiveSha256: "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
      nodeSha256: "bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12",
      npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
      npmTreeSha256: "55af62da9d601e0e132bd9c043c63dcaa9bddae2bf08266c029db18082ce7554",
    };
    if (
      !nodeToolchain ||
      Object.entries(expectedNodeToolchain).some(
        ([key, value]) => nodeToolchain[key] !== value,
      )
    ) {
      fail("installed helper did not prove the pinned Node 24 build toolchain");
    }
    if (
      probe.identities?.ingress !== "marks-deploy" ||
      probe.identities?.build !== "marks-build" ||
      probe.identities?.service !== "devuser" ||
      !Number.isSafeInteger(probe.identities?.buildUid) ||
      !Number.isSafeInteger(probe.identities?.buildGid) ||
      probe.identities.buildUid <= 0 ||
      probe.identities.buildGid <= 0
    ) {
      fail("installed helper did not prove the dedicated build identity");
    }
    if (
      probe.fetchEgress?.schema !== "marks.fetch-egress.v1" ||
      probe.fetchEgress?.network !== "marks-build-fetch" ||
      probe.fetchEgress?.subnet !== "172.30.0.0/24"
    ) {
      fail("installed helper did not prove the filtered dependency-fetch network");
    }
    if (
      probe.incomingAggregateLimitBytes !== 2 * 1024 ** 3 ||
      probe.incomingTreeLimit !== 4 ||
      probe.uploadLock !== "/var/lib/marks-deploy/incoming/.marks-upload.lock" ||
      probe.commands?.timeout !== true ||
      probe.commands?.prlimit !== true
    ) {
      fail("installed helper did not prove the bounded upload namespace");
    }
    const digest = (relative) =>
      createHash("sha256").update(readFileSync(join(process.env.MARKS_ROOT_DIR, relative))).digest("hex");
    const sources = {
      dispatcher: "deploy/host/marks-deploy-ssh",
      uploader: "deploy/host/marks-upload",
      sqliteWorker: "deploy/host/marks-sqlite-worker",
      releaseRoot: "deploy/host/marks-release-root",
      serviceTemplate: "deploy/host/marks.service.template",
    };
    for (const [helper, relative] of Object.entries(sources)) {
      const installed = probe.helpers ? probe.helpers[helper] : undefined;
      const declared = digest(relative);
      if (installed !== declared) {
        fail(`installed ${helper} ${installed} is not the checked-in ${relative} ${declared}`);
      }
    }
  ' || die "installed deployment boundary differs from the checked-in deploy/host sources"
  echo "==> installed helpers match the checked-in deployment boundary"
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
  local variant=$2
  local plan_digest=$3
  require_command git
  require_command ssh
  require_command npm
  require_command node
  require_command rustup
  require_command curl
  require_command python3
  [[ "$(node --version)" == "v24.19.0" ]] \
    || die "Node v24.19.0 is required"
  [[ "$(npm --version)" == "11.17.0" ]] \
    || die "npm 11.17.0 is required"

  echo "==> installing locked browser dependencies"
  (cd "$ROOT" && npm ci --engine-strict --strict-allow-scripts)

  echo "==> Rust format, workspace tests, and warnings-as-errors lint"
  (cd "$ROOT" && cargo_pinned fmt --all --check)
  (cd "$ROOT" && cargo_pinned test --workspace --locked)
  (cd "$ROOT" && cargo_pinned clippy --workspace --all-targets --locked -- -D warnings)

  echo "==> catalog-derived server feature tests and lint"
  run_product_variant_server_gate
  resolve_product_variant "$variant" service
  [[ "$BUILD_PLAN_SHA256" == "$plan_digest" ]] \
    || die "target product build plan changed while the deployment gate was running"

  echo "==> TypeScript and checked-in ESBT artifact verification"
  (cd "$ROOT" && npm run typecheck)
  (cd "$ROOT" && npm run verify:esbt)

  echo "==> browser, product, renderer, Wasm, auth, design-system, benchmark, and harness tests"
  (cd "$ROOT" && npm run test:browser)
  (cd "$ROOT" && npm run test:surface)
  (cd "$ROOT" && npm run test:markdown)
  (cd "$ROOT" && npm run test:bench)
  (cd "$ROOT" && npm run test:component)
  (cd "$ROOT" && npm run test:auth)
  (cd "$ROOT" && npm run test:components)
  (cd "$ROOT" && npm run test:materials)
  (cd "$ROOT" && npm run test:tokens)
  (cd "$ROOT" && npm run check:motion)
  (cd "$ROOT" && npm run test:design-system-contract)
  (cd "$ROOT" && npm run test:harness)
  (cd "$ROOT" && python3 -m py_compile \
    deploy/host/marks-upload \
    deploy/host/marks-sqlite-worker \
    deploy/host/marks-release-root)

  echo "==> production service-mode UI and release-receipt build"
  (
    cd "$ROOT"
    npm run build:variant -- \
      --variant "$variant" \
      --data-mode service \
      --out-dir "$ROOT/client/dist" \
      --require-deployable
  )
  (cd "$ROOT" && npm run check:ui-budgets)
  (
    cd "$ROOT"
    cargo_feature_args=(--no-default-features)
    if [[ -n "$SERVER_CARGO_FEATURES" ]]; then
      cargo_feature_args+=(--features "$SERVER_CARGO_FEATURES")
    fi
    MARKS_BUILD_REVISION="$revision" MARKS_SOURCE_DIRTY=0 \
    MARKS_PRODUCT_VARIANT="$variant" MARKS_BUILD_PLAN_SHA256="$plan_digest" \
    MARKS_BUILD_PLAN_JSON="$BUILD_PLAN_JSON" \
      cargo_pinned build -p marks-server --locked "${cargo_feature_args[@]}"
  )

  echo "==> live Chromium workflow plus native multi-peer convergence"
  if [[ "$(uname -s)" == Linux ]]; then
    (cd "$ROOT" && npx playwright install --with-deps chromium)
  else
    (cd "$ROOT" && npx playwright install chromium)
  fi

  echo "==> design-system browser catalog against the production build"
  (cd "$ROOT" && node scripts/check-design-system.mjs)

  echo "==> two-release asset coexistence and mobile UI proofs"
  (cd "$ROOT" && npm run check:two-release)
  (cd "$ROOT" && npm run check:mobile-ui)

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

  resolve_product_variant "$TARGET_PRODUCT_VARIANT"
  [[ "$PRODUCT_VARIANT" == "$TARGET_PRODUCT_VARIANT" ]] \
    || die "production target accepts only $TARGET_PRODUCT_VARIANT"

  check_remote_protocol
  run_local_gate "$revision" "$PRODUCT_VARIANT" "$BUILD_PLAN_SHA256"

  ship_revision "$revision" "$PRODUCT_VARIANT" "$BUILD_PLAN_SHA256"
}

ship_revision() {
  local revision=$1
  local variant=$2
  local plan_digest=$3

  echo "==> uploading exact commit $revision"
  STAGED_REVISION=$revision
  git -C "$ROOT" archive --format=tar "$revision" \
    | restricted_command upload "$revision"

  echo "==> building, canarying, and activating $revision/$variant/$plan_digest on $HOST"
  restricted_command deploy "$revision" "$variant" "$plan_digest"
}

deploy_verified() {
  local expected_revision=$1
  local expected_variant=$2
  local expected_plan_digest=$3
  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] \
    || die "deploy-verified requires one full lowercase Git revision"
  [[ "$expected_variant" =~ ^[a-z][a-z0-9-]{0,63}$ ]] \
    || die "deploy-verified requires one safe product variant"
  [[ "$expected_plan_digest" =~ ^[0-9a-f]{64}$ ]] \
    || die "deploy-verified requires one full lowercase build plan digest"
  [[ "${GITHUB_ACTIONS:-}" == true ]] \
    || die "deploy-verified is available only in GitHub Actions"
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_run ]] \
    || die "deploy-verified requires a workflow_run event"
  [[ "${MARKS_CI_VERIFIED_SHA:-}" == "$expected_revision" ]] \
    || die "deploy-verified revision does not match the successful CI receipt"
  [[ "${MARKS_CI_VERIFIED_VARIANT:-}" == "$expected_variant" ]] \
    || die "deploy-verified product variant does not match the successful CI receipt"
  [[ "${MARKS_CI_VERIFIED_PLAN_SHA256:-}" == "$expected_plan_digest" ]] \
    || die "deploy-verified build plan digest does not match the successful CI receipt"
  [[ "${MARKS_CI_RUN_ID:-}" =~ ^[0-9]+$ ]] \
    || die "deploy-verified requires the successful CI run id"

  validate_deploy_config
  assert_clean_commit
  assert_published_commit

  local revision
  revision=$(git -C "$ROOT" rev-parse HEAD)
  [[ "$revision" == "$expected_revision" ]] \
    || die "checked-out HEAD $revision does not match verified revision $expected_revision"

  resolve_product_variant "$TARGET_PRODUCT_VARIANT"
  [[ "$expected_variant" == "$TARGET_PRODUCT_VARIANT" \
    && "$PRODUCT_VARIANT" == "$expected_variant" \
    && "$BUILD_PLAN_SHA256" == "$expected_plan_digest" ]] \
    || die "verified product build identity is not the current stable plan"

  check_remote_protocol
  echo "==> accepting successful CI run $MARKS_CI_RUN_ID for exact build $revision/$PRODUCT_VARIANT/$BUILD_PLAN_SHA256"
  ship_revision "$revision" "$PRODUCT_VARIANT" "$BUILD_PLAN_SHA256"
}

# status prints a receipt and succeeds even when production is unhealthy.
# verify is the gate: it re-reads the restricted status and requires the
# public origin to serve a healthy, ready, coherent, release-ready build of
# exactly the active release.
verify_production() {
  require_command curl
  require_command node

  echo "==> restricted status receipt"
  local status_receipt current current_revision current_variant current_plan_digest
  status_receipt=$(restricted_command status)
  printf '%s\n' "$status_receipt"
  current=$(awk '$1 == "current:" { print $2 }' <<< "$status_receipt")
  current_revision=$(awk '$1 == "revision:" { print $2 }' <<< "$status_receipt")
  current_variant=$(awk '$1 == "product-variant:" { print $2 }' <<< "$status_receipt")
  current_plan_digest=$(awk '$1 == "build-plan-sha256:" { print $2 }' <<< "$status_receipt")
  [[ "$current" =~ ^[0-9a-f]{40}\.[a-z][a-z0-9-]{0,63}\.[0-9a-f]{64}$ \
    || "$current" =~ ^[0-9a-f]{40}$ \
    || "$current" == legacy-* ]] \
    || die "restricted status did not report the current release"

  echo "==> public health, readiness, and artifact receipt on $PUBLIC_ORIGIN"
  local health ready artifact
  health=$(curl -fsS --max-time 15 "$PUBLIC_ORIGIN/healthz") \
    || die "public health endpoint failed"
  ready=$(curl -fsS --max-time 15 "$PUBLIC_ORIGIN/readyz") \
    || die "public readiness endpoint failed"
  artifact=$(curl -fsS --max-time 15 "$PUBLIC_ORIGIN/v1/artifact") \
    || die "public artifact receipt failed"

  CURRENT_RELEASE="$current" CURRENT_REVISION="$current_revision" \
  CURRENT_VARIANT="$current_variant" CURRENT_PLAN_DIGEST="$current_plan_digest" \
  HEALTH="$health" READY="$ready" ARTIFACT="$artifact" node -e '
    const fail = (message) => { console.error(`verify: ${message}`); process.exit(1); };
    const parse = (label, text) => {
      try { return JSON.parse(text); } catch { fail(`${label} is not JSON`); }
    };
    const health = parse("healthz", process.env.HEALTH);
    if (health.ok !== true) fail("public health is not ok");
    const ready = parse("readyz", process.env.READY);
    if (ready.ok !== true) fail("public readiness is not ok");
    const artifact = parse("artifact", process.env.ARTIFACT);
    for (const field of [
      "staticArtifactVerified",
      "profileCoherent",
      "engineCoherent",
      "releaseReady",
    ]) {
      if (artifact[field] !== true) fail(`artifact ${field} is ${artifact[field]}`);
    }
    if (artifact.serverSourceDirty !== false || artifact.componentSourceDirty !== false) {
      fail("the live release was built from a dirty tree");
    }
    const current = process.env.CURRENT_RELEASE;
    if (!current.startsWith("legacy-")) {
      const revision = process.env.CURRENT_REVISION || current;
      if (artifact.buildRevision !== revision) {
        fail(`public build revision ${artifact.buildRevision} is not active revision ${revision}`);
      }
      if (current.includes(".")) {
        if (process.env.CURRENT_VARIANT !== "stable" || artifact.productVariant !== "stable") {
          fail("production is not the stable product variant");
        }
        if (artifact.buildPlanSha256 !== process.env.CURRENT_PLAN_DIGEST) {
          fail("public build plan digest is not the active release plan");
        }
        if (ready.productVariant !== process.env.CURRENT_VARIANT) {
          fail("public readiness variant is not the active release variant");
        }
        if (ready.buildPlanSha256 !== process.env.CURRENT_PLAN_DIGEST) {
          fail("public readiness build plan digest is not the active release plan");
        }
        if (ready.productVariant !== artifact.productVariant
            || ready.buildPlanSha256 !== artifact.buildPlanSha256) {
          fail("public readiness and artifact receipts disagree");
        }
        if (ready.staticBuildPlanVerified !== true || ready.releaseReady !== true) {
          fail("public readiness has not verified the release build plan");
        }
        if (artifact.staticBuildPlanVerified !== true) {
          fail("public static build plan is not verified");
        }
      }
    }
  ' || die "public verification failed"

  echo "==> production verified: release $current is live, stable, coherent, and ready"
}

main() {
  local command=${1:-}
  case "$command" in
    deploy)
      [[ $# -eq 1 ]] || die "deploy accepts no arguments"
      deploy
      ;;
    deploy-verified)
      [[ $# -eq 4 ]] \
        || die "deploy-verified requires revision, product variant, and build plan digest"
      deploy_verified "$2" "$3" "$4"
      ;;
    rollback)
      [[ $# -le 2 ]] || die "rollback accepts at most one release id"
      if [[ $# -eq 2 ]]; then
        validate_release_identifier "$2"
        restricted_command rollback "$2"
      else
        restricted_command rollback
      fi
      ;;
    status)
      [[ $# -eq 1 ]] || die "status accepts no arguments"
      restricted_command status
      ;;
    verify)
      [[ $# -eq 1 ]] || die "verify accepts no arguments"
      verify_production
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
