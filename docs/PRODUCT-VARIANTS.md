# Product variants and build-time features

Marks uses named product variants to decide which optional product capabilities
exist in a browser/server artifact. A variant is a checked-in, complete feature
assignment. It is not a runtime toggle and it is not deployment authorization.

The executable source of truth is
[`config/product-variants.ts`](../config/product-variants.ts), with the catalog's
exact key-to-ID type contract in
[`config/product-feature-schema.ts`](../config/product-feature-schema.ts).
Every variant explicitly assigns every catalogued feature; variants do not
inherit from one another. The shared type contract also makes the browser's
Node-test fallback feature map exhaustive. A new feature is therefore a
deliberate compile-time decision for every artifact we ship instead of an
ambient environment-variable default.

## Current catalog

| Variant | Agent chat | Wild ribbon | Release artifact |
| --- | --- | --- | --- |
| `stable` | excluded | excluded | yes |
| `beta` | included | included | yes |
| `agent-chat-validation` | included | excluded | CI validation only |
| `ribbon-wild-validation` | excluded | included | CI validation only |

`stable` is the default for ordinary development and browser builds. The two
single-feature variants prove that each feature still compiles and is excluded
independently; they cannot be released. `beta` is a real release shape, but the
existing `marks.secure.build` deployment target is separately restricted to
`stable`. A future beta target must opt into `beta` in its root-owned target
policy; producing a beta artifact does not grant permission to activate it.

## Resolving a build

Use the checked-in resolver instead of translating variants into feature flags
in shell, CI, Rust, or Vite code:

```bash
node --experimental-strip-types scripts/product-variant.ts resolve \
  --variant stable --data-mode service --format json
```

The resolver accepts a known variant and an explicit client data mode, validates
the complete catalog, and emits one normalized plan:

```json
{
  "schema": "marks.product-build-plan.v1",
  "productVariant": "stable",
  "deployable": true,
  "features": {
    "agent-chat": false,
    "ribbon-wild": false
  },
  "client": {
    "dataMode": "service"
  },
  "server": {
    "cargoFeatures": []
  }
}
```

The build-plan digest is lowercase SHA-256 over UTF-8, recursively
key-sorted, minified JSON for the plan itself, with no trailing newline. Arrays
retain their resolved order; the Cargo feature array is sorted and unique.
`--format canonical` emits those exact bytes (plus one terminal newline),
`--format sha256` emits the digest, and `--format env` emits the validated
inputs used by build automation. `--format json` wraps the plan and digest in a
`marks.product-build-receipt.v1` receipt.

Browser builds write that receipt to `marks-product-build.json` at the static
artifact root. Release server binaries embed the same plan and digest. At
startup and during readiness checks, the server verifies that its embedded
identity and the static receipt agree. A mismatched browser/server pair is not
release-ready.

`releaseReady` is deliberately an internal coherence claim, not a signature,
proof that the plan came from the checked-in catalog, or permission to deploy.
A privileged release boundary must still check out the trusted revision,
independently re-resolve that revision's catalog, compare the exact plan and
digest, and enforce the destination's variant allowlist. The restricted Marks
release helper performs each of those checks before it builds or activates a
release.

## Developer commands

Run the default product locally:

```bash
npm run dev
npm run build
```

Run or build a named product variant:

```bash
MARKS_PRODUCT_VARIANT=beta npm run dev
MARKS_PRODUCT_VARIANT=beta npm run build
```

For service artifacts, the data mode remains an explicit orthogonal build
input:

```bash
npm run build:variant -- --variant stable --data-mode service \
  --out-dir "$PWD/client/dist" --require-deployable
```

Feature-enabled Rust builds must carry an explicit plan; a plain Rust build
resolves only the default `stable`/local plan. For example, to compile the beta
server without producing a release identity:

```bash
plan=$(node --experimental-strip-types scripts/product-variant.ts resolve \
  --variant beta --data-mode local --format canonical)
digest=$(node --experimental-strip-types scripts/product-variant.ts resolve \
  --variant beta --data-mode local --format sha256)
MARKS_PRODUCT_VARIANT=beta MARKS_BUILD_PLAN_JSON="$plan" \
  MARKS_BUILD_PLAN_SHA256="$digest" \
  cargo build -p marks-server --locked --no-default-features \
    --features agent-chat
```

Release builders use the same procedure with `service`, a clean 40-character
`MARKS_BUILD_REVISION`, and explicit `MARKS_SOURCE_DIRTY=0`. The restricted
deployment helper resolves and supplies those values itself.

`VITE_MARKS_AGENT_CHAT` and `VITE_MARKS_RIBBON_WILD` are intentionally
rejected. They could otherwise create an unregistered combination that has no
catalog identity, server feature set, CI evidence, or release receipt.

The build keeps direct compile-time guards at feature-owned dynamic import and
shared command/ribbon sites. Vite then checks its final module graph plus
separate catalog-owned JavaScript and stylesheet markers: an excluded feature
fails the build if any owned module, shared feature branch, or feature-owned CSS
survives, and an included feature fails if its required entry modules or markers
are absent. Source maps are excluded from marker inspection because they
intentionally preserve non-executable source text. Every required module must
also be covered by that feature's exact forbidden-module list or one of its
forbidden-module prefixes, so inclusion and
exclusion ownership cannot silently drift apart. This is physical
executable-code exclusion, not just a hidden control in a running application.

Client code may access a product feature only as a direct, catalog-known
`__MARKS_FEATURES__.<key>` property. The harness source contract rejects
whole-object, destructured, computed, optional-chain, or unknown-property
access because Vite deliberately injects property-level literals rather than a
replaceable feature object. Comments and the single ambient declaration are
not runtime access and remain allowed.

When multiple variants are built concurrently, give each build its
resolver-owned output directory:

```text
client/dist-variants/<variant>/<data-mode>-<first-16-digest-hex>
```

The build wrapper accepts only that shape or the exact sequential
`client/dist` path, and rejects a missing, symlinked, or non-directory client
root as well as symlinked or non-directory output path components before
passing `--emptyOutDir` to Vite. This prevents a typo or symlink from emptying
an arbitrary directory. `client/dist` is a mutable default and must not be
shared between parallel builds or between local-mode and service-mode
validation.

## Release identity and deployment policy

A release is identified by all three immutable inputs:

1. the 40-character Git revision;
2. the product variant;
3. the full build-plan SHA-256 digest.

The release receipt records those values, the normalized feature assignment,
the client data mode, and the Cargo feature set. Reusing a Git revision for a
different variant therefore produces a different release directory and cannot
silently reuse the wrong browser or server bits.

The restricted deployment boundary independently re-resolves the plan from the
uploaded revision. It rejects unknown variants, client-supplied feature lists,
non-deployable validation variants, digest mismatches, browser/server receipt
mismatches, and variants that the deployment target does not allow. Runtime
provider settings such as `MARKS_AGENT_PROVIDER`, model choice, and credential
paths remain server-owned operational policy; they are not product features and
are never placed in a build plan.

## CI policy

CI resolves every named catalog variant, builds its isolated client cut, and
executes the matching server tests and warnings-as-errors lint with exactly
that plan's Cargo features. Deployable variants additionally produce release
server binaries and run the live browser/server coherence proof; validation
variants cannot cross either release boundary. The local manual-deploy gate is
catalog-driven too, deduplicating identical Cargo feature sets for test cost
before it restores and builds the exact target service plan.

This avoids an unbounded build of every possible Boolean combination: adding a
shipping variant extends the shipping matrix, while a new feature requires one
independent validation cut plus only the explicitly declared interaction cuts.

For a growing catalog, keep coverage in three layers:

- matching client builds, server tests, and lint for every named variant;
- release binaries and live browser/server proofs for every deployable product
  cut;
- one independent validation variant per switchable feature, plus additional
  named validation variants only for declared feature interactions.

The catalog validator rejects incomplete feature maps, duplicate or unknown
Cargo features, invalid deployability, and feature dependency violations before
a build starts.

## Changing the catalog

To add a build-time feature:

1. Add its key and stable ID to the feature identity schema, then add its
   ownership metadata to the executable catalog, including browser modules,
   any Cargo feature, and separate JavaScript/stylesheet markers for each
   feature-owned branch or selector. Every required browser module must also
   match an exact or prefix disabled boundary. Keep the marker list explicitly
   empty when module ownership covers the whole feature.
2. Assign it explicitly in every existing variant. There is no inherited
   default to conceal an unanswered product decision.
3. Add or update a single-feature validation variant and declare any feature
   dependency or interaction that needs combined coverage.
4. Keep browser imports and feature-specific shared branches behind direct
   `__MARKS_FEATURES__.<key>` compile-time guards, and server modules or routes
   behind the mapped Cargo feature.
5. Update surface assertions, artifact/readiness tests, variant documentation,
   and any variant-specific size budgets.

To add a variant, define its complete feature map and choose whether it is
deployable. CI derives its variant matrix from the catalog automatically;
deployment remains impossible until a particular target's root-owned policy
also allowlists it.

To remove a variant, first remove every target-policy or release-automation
reference to it, then remove it from the catalog. The CI and local manual-gate
matrices are derived from that catalog and drop it automatically. Existing
immutable receipts remain meaningful because their schema, variant name, plan,
and digest are recorded together.

To remove a feature, remove its gated code, artifact markers, and Cargo feature
first, then remove its catalog entry, key-to-ID schema entry, and every
explicit variant assignment in the same change. A server-backed feature whose
product boolean is explicitly cross-checked against a Cargo feature must also
remove that source-owned mapping from `crates/marks-server/build.rs` and
`crates/marks-server/src/artifact.rs`; those checks deliberately reject a
self-hashed plan that lies about the compiled capability. Update surface and
artifact-boundary assertions with the same change. The catalog validator and
shared exact types then ensure that a half-removed flag cannot continue as a
silent build input or Node-test fallback.
