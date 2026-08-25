import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertRealClientOutputPath } from '../product-variant-paths.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = resolve(root, 'scripts/product-variant.ts');
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ![
      'MARKS_PRODUCT_VARIANT',
      'MARKS_BUILD_PLAN_JSON',
      'MARKS_BUILD_PLAN_SHA256',
      'MARKS_SERVER_CARGO_FEATURES',
      'VITE_MARKS_AGENT_CHAT',
      'VITE_MARKS_RIBBON_WILD',
      'VITE_MARKS_DATA_MODE',
    ].includes(key)),
);

function run(...arguments_) {
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', cli, ...arguments_],
    { cwd: root, env: baseEnvironment, encoding: 'utf8' },
  ).trim();
}

function fail(arguments_, environment = {}) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', cli, ...arguments_],
    {
      cwd: root,
      env: { ...baseEnvironment, ...environment },
      encoding: 'utf8',
    },
  );
}

test('stable is the default and canonical bytes hash to the receipt digest', () => {
  const receipt = JSON.parse(run('resolve', '--data-mode', 'service'));
  const canonical = run('resolve', '--data-mode', 'service', '--format', 'canonical');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');

  assert.equal(receipt.schema, 'marks.product-build-receipt.v1');
  assert.equal(receipt.buildPlan.productVariant, 'stable');
  assert.equal(receipt.buildPlan.deployable, true);
  assert.deepEqual(receipt.buildPlan.features, {
    'agent-chat': false,
    'ribbon-wild': false,
  });
  assert.deepEqual(receipt.buildPlan.server.cargoFeatures, []);
  assert.equal(receipt.buildPlanSha256, digest);
  assert.equal(run('resolve', '--data-mode', 'service', '--format', 'sha256'), digest);
});

test('beta resolves one coherent client and server plan', () => {
  const receipt = JSON.parse(run(
    'resolve',
    '--variant', 'beta',
    '--data-mode', 'service',
    '--require-deployable',
  ));
  assert.deepEqual(receipt.buildPlan.features, {
    'agent-chat': true,
    'ribbon-wild': true,
  });
  assert.deepEqual(receipt.buildPlan.server.cargoFeatures, ['agent-chat']);
  assert.equal(receipt.buildPlan.client.dataMode, 'service');
});

test('validation-only variants cannot cross a deployable resolver boundary', () => {
  const result = fail([
    'resolve',
    '--variant', 'agent-chat-validation',
    '--data-mode', 'service',
    '--require-deployable',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /validation-only and cannot be deployed/u);
});

test('legacy per-feature environment variables fail even when empty', () => {
  const result = fail(
    ['resolve', '--data-mode', 'service'],
    { VITE_MARKS_AGENT_CHAT: '' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Legacy per-feature build environment is forbidden/u);
});

test('unknown inputs and irrelevant list options fail closed', () => {
  const unknown = fail(['resolve', '--variant', 'future', '--data-mode', 'service']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown product variant/u);

  const listOption = fail(['list', '--format', 'env']);
  assert.equal(listOption.status, 2);
  assert.match(listOption.stderr, /list does not accept options/u);
});

test('build-client refuses to empty an arbitrary absolute directory', () => {
  const result = fail([
    'build-client',
    '--variant', 'stable',
    '--data-mode', 'service',
    '--out-dir', resolve(root, '..'),
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be client\/dist or the resolver-owned isolated path/u);
});

test('empty-output validation checks the client root before its descendants', (context) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'marks-product-variant-path-'));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const realClient = join(sandbox, 'real-client');
  mkdirSync(realClient);
  assert.doesNotThrow(() => assertRealClientOutputPath(realClient, join(realClient, 'dist')));

  const symlinkedClient = join(sandbox, 'client-link');
  symlinkSync(realClient, symlinkedClient, 'dir');
  assert.throws(
    () => assertRealClientOutputPath(symlinkedClient, join(symlinkedClient, 'dist')),
    /refusing symlinked client root/u,
  );

  const fileClient = join(sandbox, 'client-file');
  writeFileSync(fileClient, 'not a directory');
  assert.throws(
    () => assertRealClientOutputPath(fileClient, join(fileClient, 'dist')),
    /client root is not a directory/u,
  );
  assert.throws(
    () => assertRealClientOutputPath(join(sandbox, 'missing-client'), join(sandbox, 'missing-client', 'dist')),
    /client root does not exist/u,
  );
});

test('env output binds every cross-target build input to one plan', () => {
  const environment = run(
    'resolve',
    '--variant', 'beta',
    '--data-mode', 'service',
    '--format', 'env',
  );
  assert.match(environment, /^MARKS_PRODUCT_VARIANT='beta'$/mu);
  assert.match(environment, /^MARKS_PRODUCT_VARIANT_DEPLOYABLE='1'$/mu);
  assert.match(environment, /^MARKS_BUILD_PLAN_SHA256='[a-f0-9]{64}'$/mu);
  assert.match(environment, /^MARKS_BUILD_PLAN_JSON='\{.+\}'$/mu);
  assert.match(environment, /^MARKS_SERVER_CARGO_FEATURES='agent-chat'$/mu);
  assert.match(environment, /^VITE_MARKS_DATA_MODE='service'$/mu);
});
