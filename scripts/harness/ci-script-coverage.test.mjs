import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const packageScripts = Object.keys(JSON.parse(read('package.json')).scripts);
const ciWorkflow = read('.github/workflows/ci.yml');
const deploymentGate = read('scripts/deploy-secure-build.sh');

// Every test: and check: script must be wired into required CI and the
// manual deployment gate, or listed here with the exact alternative both
// run instead. A future script cannot silently fall out of either gate:
// adding one forces either wiring or an explicit, reviewed substitution.
const substitutes = {
  // The catalog proof reuses the production build the surrounding gate has
  // already produced, instead of rebuilding through test:design-system.
  'test:design-system': 'node scripts/check-design-system.mjs',
};

const required = packageScripts.filter((name) => /^(?:test|check):/u.test(name));

// `npm run test:component` must not satisfy `test:components`; require a
// non-name character (or end) after the match.
const invocationPattern = (command) =>
  new RegExp(`${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w:-])`, 'u');

test('the coverage contract still sees the real proof scripts', () => {
  assert.ok(required.length >= 12, `only ${required.length} test:/check: scripts found`);
  for (const name of Object.keys(substitutes)) {
    assert.ok(required.includes(name), `${name} no longer exists; update substitutes`);
  }
});

test('required CI invokes every test and check script', () => {
  for (const name of required) {
    const command = substitutes[name] ?? `npm run ${name}`;
    assert.match(ciWorkflow, invocationPattern(command), `${name} is missing from ci.yml`);
  }
});

test('the manual deployment gate invokes every test and check script', () => {
  for (const name of required) {
    const command = substitutes[name] ?? `npm run ${name}`;
    assert.match(
      deploymentGate,
      invocationPattern(command),
      `${name} is missing from deploy-secure-build.sh`,
    );
  }
});

test('typecheck, artifact verification, and the production build stay gated', () => {
  for (const command of [
    'npm run typecheck',
    'npm run verify:esbt',
    'npm run test:harness',
  ]) {
    assert.match(ciWorkflow, invocationPattern(command), `${command} is missing from ci.yml`);
    assert.match(
      deploymentGate,
      invocationPattern(command),
      `${command} is missing from deploy-secure-build.sh`,
    );
  }
  assert.match(ciWorkflow, invocationPattern('npm run build'), 'npm run build is missing from ci.yml');
  assert.match(
    deploymentGate,
    invocationPattern('npm run build:variant'),
    'canonical product variant build is missing from deploy-secure-build.sh',
  );
});

test('the manual server gate enumerates the catalog and deduplicates resolved Cargo feature sets', () => {
  const start = deploymentGate.indexOf('run_product_variant_server_gate()');
  const end = deploymentGate.indexOf('\n}\n', start);
  assert.notEqual(start, -1, 'catalog-derived server gate is missing');
  assert.notEqual(end, -1, 'catalog-derived server gate is unterminated');
  const catalogGate = deploymentGate.slice(start, end);
  assert.match(deploymentGate, /scripts\/product-variant\.ts list/u);
  assert.match(catalogGate, /resolve_product_variant "\$candidate" local false/u);
  assert.match(catalogGate, /tested_cargo_feature_sets/u);
  assert.match(catalogGate, /catalog_cargo_args=\(--no-default-features\)/u);
  assert.match(catalogGate, /catalog_cargo_args\+=\(--features "\$cargo_feature_set"\)/u);
  assert.equal(
    [...catalogGate.matchAll(/"\$\{catalog_cargo_args\[@\]\}"/gu)].length,
    2,
    'both test and clippy must consume the resolver-derived feature array',
  );
  assert.doesNotMatch(catalogGate, /\bbeta\b|--features\s+agent-chat/u);
  assert.match(
    deploymentGate,
    /run_product_variant_server_gate\s*\n\s*resolve_product_variant "\$variant" service/u,
    'the exact target service plan must be restored after catalog testing',
  );

  const derivation = catalogGate.match(
    /local -a catalog_cargo_args\n\s+catalog_cargo_args=\(--no-default-features\)\n\s+if \[\[ -n "\$cargo_feature_set" \]\]; then\n\s+catalog_cargo_args\+=\(--features "\$cargo_feature_set"\)\n\s+fi/u,
  )?.[0];
  assert.ok(derivation, 'could not isolate the production Cargo argument derivation');
  const exercise = (features) => {
    const result = spawnSync(
      'bash',
      ['-c', `derive() {\ncargo_feature_set=$SERVER_CARGO_FEATURES\n${derivation}\nprintf '%s\\n' "\${catalog_cargo_args[@]}"\n}\nderive`],
      {
        encoding: 'utf8',
        env: { ...process.env, SERVER_CARGO_FEATURES: features },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n');
  };
  assert.deepEqual(exercise(''), ['--no-default-features']);
  assert.deepEqual(
    exercise('agent-chat,second-validated-feature'),
    ['--no-default-features', '--features', 'agent-chat,second-validated-feature'],
  );
});

test('every CI product variant runs server tests while only deployable cuts build releases', () => {
  const start = ciWorkflow.indexOf('  product-variants:');
  const end = ciWorkflow.indexOf('\n  gate:', start);
  assert.notEqual(start, -1, 'product variant job is missing');
  assert.notEqual(end, -1, 'product variant job is unterminated');
  const variantJob = ciWorkflow.slice(start, end);
  const testStart = variantJob.indexOf('- name: Test the matching server cut');
  const releaseStart = variantJob.indexOf('- name: Build the deployable server release cut');
  const lintStart = variantJob.indexOf('- name: Lint the resolved server feature boundary');
  assert.ok(testStart >= 0 && releaseStart > testStart && lintStart > releaseStart);
  const testStep = variantJob.slice(testStart, releaseStart);
  const releaseStep = variantJob.slice(releaseStart, lintStart);
  assert.match(testStep, /cargo test -p marks-server --locked/u);
  assert.doesNotMatch(testStep, /^\s*if:\s/mu, 'variant tests must not skip nondeployable plans');
  assert.match(releaseStep, /if: steps\.plan\.outputs\.deployable == 'true'/u);
  assert.match(releaseStep, /cargo build -p marks-server --release --locked/u);
  assert.match(variantJob, /Build the matching server executable cut/u);
  assert.match(variantJob, /target\/debug\/marks-server/u);
  assert.match(ciWorkflow, /if \(!deployable\) return \[\{ variant: name, browser: "chromium" \}\]/u);
  assert.match(
    ciWorkflow,
    /Enforce product feature source and catalog contracts[\s\S]*product-feature-source-contract\.test\.mjs/u,
  );
});
