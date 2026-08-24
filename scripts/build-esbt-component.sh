#!/usr/bin/env bash
# Build and bind the ESBT component, generated wrapper, core modules, and WIT
# contract from the same engine source identity used by Marks.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
pinned_rev=$(sed -n 's/.*ESBT-web", rev = "\([^"]*\)".*/\1/p' "$root/crates/marks-server/Cargo.toml" | head -n 1)
if [[ -z "$pinned_rev" ]]; then
  echo "could not read the pinned ESBT-web revision" >&2
  exit 1
fi

temporary=""
if [[ -n "${ESBT_SOURCE_DIR:-}" ]]; then
  source_dir=$(cd "$ESBT_SOURCE_DIR" && pwd)
else
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT
  source_dir="$temporary/src"
  git clone --filter=blob:none --no-checkout https://github.com/maceip/ESBT-web.git "$source_dir"
  git -C "$source_dir" fetch --depth 1 origin "$pinned_rev"
  git -C "$source_dir" checkout --detach "$pinned_rev"
fi

source_revision=$(git -C "$source_dir" rev-parse HEAD)
source_paths=(Cargo.toml Cargo.lock package.json package-lock.json src wit tools)
source_sha256=$(
  cd "$source_dir"
  find "${source_paths[@]}" -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r path; do shasum -a 256 "$path"; done \
    | shasum -a 256 \
    | awk '{print $1}'
)
profile_sha256=$(shasum -a 256 "$root/engine-profile.json" | awk '{print $1}')
if git -C "$source_dir" diff --quiet -- "${source_paths[@]}" \
  && git -C "$source_dir" diff --cached --quiet -- "${source_paths[@]}" \
  && [[ -z "$(git -C "$source_dir" ls-files --others --exclude-standard -- "${source_paths[@]}")" ]]; then
  source_dirty=false
else
  source_dirty=true
fi

if [[ ! -f "$source_dir/node_modules/@bytecodealliance/jco-transpile/package.json" ]]; then
  (
    cd "$source_dir"
    npm ci --ignore-scripts
  )
fi

toolchain=${ESBT_RUST_TOOLCHAIN:-1.95.0}
if command -v rustup >/dev/null 2>&1 \
  && rustc_bin=$(rustup which rustc --toolchain "$toolchain" 2>/dev/null); then
  :
else
  rustc_bin=${RUSTC:-rustc}
fi
compiler=$($rustc_bin --version)

(
  cd "$source_dir"
  ESBT_RUST_TOOLCHAIN="$toolchain" npm run build:component
)

node "$root/scripts/sync-esbt-component.mjs" \
  "$source_dir" \
  "$root" \
  "$source_revision" \
  "$source_dirty" \
  "$source_sha256" \
  "$profile_sha256" \
  "$compiler"

echo "wrote ESBT component set from $source_sha256"
