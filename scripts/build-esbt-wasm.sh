#!/usr/bin/env bash
# Rebuild the browser engine from the same ESBT source identity used by Marks.
# A content fingerprint (not only a Git ref) makes dirty/local source and stale
# artifacts visible and prevents the previous false cache hit.
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
source_sha256=$(
  cd "$source_dir"
  find Cargo.toml Cargo.lock src abi tools -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r path; do shasum -a 256 "$path"; done \
    | shasum -a 256 \
    | awk '{print $1}'
)
abi_definition="$source_dir/abi/esbt-wasm-v1.json"
abi_sha256=$(shasum -a 256 "$abi_definition" | awk '{print $1}')
abi_version=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$abi_definition")
profile_sha256=$(shasum -a 256 "$root/engine-profile.json" | awk '{print $1}')
if git -C "$source_dir" diff --quiet -- Cargo.toml Cargo.lock src abi tools \
  && git -C "$source_dir" diff --cached --quiet -- Cargo.toml Cargo.lock src abi tools \
  && [[ -z "$(git -C "$source_dir" ls-files --others --exclude-standard -- Cargo.toml Cargo.lock src abi tools)" ]]; then
  source_dirty=false
else
  source_dirty=true
fi

# The TypeScript surface is generated from the engine-owned IDL on every
# invocation, including artifact cache hits.
node "$source_dir/tools/wasm-abi.mjs" \
  --typescript "$root/client/src/collab/wasm/esbt-abi.generated.ts"

toolchain=${ESBT_RUST_TOOLCHAIN:-1.95.0}
if command -v rustup >/dev/null 2>&1 \
  && cargo_bin=$(rustup which cargo --toolchain "$toolchain" 2>/dev/null) \
  && rustc_bin=$(rustup which rustc --toolchain "$toolchain" 2>/dev/null); then
  :
else
  cargo_bin=${CARGO:-cargo}
  rustc_bin=${RUSTC:-rustc}
fi
compiler=$($rustc_bin --version)

artifact="$root/client/public/esbt.wasm"
stamp="$root/client/public/esbt.wasm.rev"
manifest="$root/client/public/esbt.wasm.manifest.json"
if [[ -f "$artifact" && -f "$manifest" ]] \
  && grep -Fq "\"engine_revision\": \"$source_revision\"" "$manifest" \
  && grep -Fq "\"source_dirty\": $source_dirty" "$manifest" \
  && grep -Fq "\"source_sha256\": \"$source_sha256\"" "$manifest" \
  && grep -Fq "\"abi_version\": $abi_version" "$manifest" \
  && grep -Fq "\"abi_sha256\": \"$abi_sha256\"" "$manifest" \
  && grep -Fq "\"profile_sha256\": \"$profile_sha256\"" "$manifest" \
  && grep -Fq "\"compiler\": \"$compiler\"" "$manifest"; then
  recorded_wasm=$(sed -n 's/.*"wasm_sha256": "\([0-9a-f]*\)".*/\1/p' "$manifest")
  actual_wasm=$(shasum -a 256 "$artifact" | awk '{print $1}')
  if [[ -n "$recorded_wasm" && "$recorded_wasm" == "$actual_wasm" ]]; then
    echo "esbt.wasm already matches source $source_sha256"
    exit 0
  fi
fi

RUSTC="$rustc_bin" "$cargo_bin" build \
  --release \
  --target wasm32-unknown-unknown \
  --manifest-path "$source_dir/Cargo.toml"

built="$source_dir/target/wasm32-unknown-unknown/release/esbt.wasm"
mkdir -p "$root/client/public"
cp "$built" "$artifact"
node "$source_dir/tools/wasm-abi.mjs" --verify-wasm "$artifact"
wasm_sha256=$(shasum -a 256 "$artifact" | awk '{print $1}')
printf '%s\n' "$source_revision" > "$stamp"
printf '{\n  "format": 2,\n  "engine_revision": "%s",\n  "source_dirty": %s,\n  "source_sha256": "%s",\n  "abi_version": %s,\n  "abi_sha256": "%s",\n  "profile_sha256": "%s",\n  "wasm_sha256": "%s",\n  "compiler": "%s",\n  "target": "wasm32-unknown-unknown"\n}\n' \
  "$source_revision" "$source_dirty" "$source_sha256" "$abi_version" "$abi_sha256" \
  "$profile_sha256" "$wasm_sha256" "$compiler" \
  > "$manifest"
echo "wrote $artifact ($wasm_sha256 from $source_sha256)"
