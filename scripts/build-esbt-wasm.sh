#!/usr/bin/env bash
# Rebuild client/public/esbt.wasm from the ESBT-web revision pinned in
# crates/marks-server/Cargo.toml. Same crate, same rev, native + Wasm.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
rev=$(sed -n 's/.*ESBT-web", rev = "\([^"]*\)".*/\1/p' "$root/crates/marks-server/Cargo.toml" | head -n 1)
if [[ -z "$rev" ]]; then
  echo "could not read the pinned ESBT-web revision" >&2
  exit 1
fi
stamp="$root/client/public/esbt.wasm.rev"
artifact="$root/client/public/esbt.wasm"
if [[ -f "$artifact" && -f "$stamp" && $(cat "$stamp") == "$rev" ]]; then
  echo "esbt.wasm already matches $rev"
  exit 0
fi
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
git clone --depth 1 https://github.com/maceip/ESBT-web.git "$workdir/src"
git -C "$workdir/src" fetch --depth 1 origin "$rev"
git -C "$workdir/src" checkout --detach "$rev"
cargo +1.88.0 build --release --target wasm32-unknown-unknown --manifest-path "$workdir/src/Cargo.toml"
mkdir -p "$root/client/public"
cp "$workdir/src/target/wasm32-unknown-unknown/release/esbt.wasm" "$artifact"
printf '%s\n' "$rev" > "$stamp"
echo "wrote $artifact ($rev)"
