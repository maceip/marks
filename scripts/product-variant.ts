#!/usr/bin/env -S node --experimental-strip-types

import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT_VARIANTS,
  assertNoLegacyProductFeatureEnvironment,
  canonicalProductBuildPlan,
  canonicalProductBuildReceipt,
  createProductBuildReceipt,
  resolveProductBuildPlan,
  validateProductVariantConfiguration,
} from '../config/product-variants.ts';
import { assertRealClientOutputPath } from './product-variant-paths.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELP = `Resolve and build checked-in Marks product variants.

Usage:
  node --experimental-strip-types scripts/product-variant.ts list
  node --experimental-strip-types scripts/product-variant.ts resolve \\
    [--variant stable] --data-mode <local|service> \\
    [--format json|canonical|sha256|env] [--require-deployable]
  node --experimental-strip-types scripts/product-variant.ts build-client \\
    [--variant stable] --data-mode <local|service> --out-dir <absolute-path> \\
    [--require-deployable]

The stable variant is the default. Release callers should always pass
--data-mode service and --require-deployable. Validation-only variants may be
built in CI but cannot pass the deployable check.
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fail(message: string): never {
  process.stderr.write(`product-variant: ${message}\n`);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  options: {
    variant: { type: 'string' },
    'data-mode': { type: 'string' },
    format: { type: 'string', default: 'json' },
    'out-dir': { type: 'string' },
    'require-deployable': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const command = positionals[0];
if (!command || positionals.length !== 1) fail('expected exactly one command; use --help');

if (command === 'list') {
  if (process.argv.slice(2).some((argument) => argument !== 'list')) {
    fail('list does not accept options');
  }
  try {
    validateProductVariantConfiguration();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const variants = Object.entries(PRODUCT_VARIANTS).map(([name, definition]) => ({
    name,
    label: definition.label,
    deployable: definition.deployable,
    features: definition.features,
  }));
  process.stdout.write(`${JSON.stringify(variants, null, 2)}\n`);
  process.exit(0);
}

if (command !== 'resolve' && command !== 'build-client') {
  fail(`unknown command ${JSON.stringify(command)}; expected list, resolve, or build-client`);
}

try {
  assertNoLegacyProductFeatureEnvironment(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const dataMode = values['data-mode'] ?? process.env.VITE_MARKS_DATA_MODE;
if (!dataMode) fail('--data-mode is required (local or service)');

let plan;
try {
  plan = resolveProductBuildPlan({
    variant: values.variant ?? process.env.MARKS_PRODUCT_VARIANT,
    dataMode,
    requireDeployable: values['require-deployable'],
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const receipt = createProductBuildReceipt(plan);
const planJson = canonicalProductBuildPlan(plan);
const receiptJson = canonicalProductBuildReceipt(receipt);

if (command === 'resolve') {
  if (values['out-dir']) fail('resolve does not accept --out-dir');
  if (values.format === 'json') process.stdout.write(`${receiptJson}\n`);
  else if (values.format === 'canonical') process.stdout.write(`${planJson}\n`);
  else if (values.format === 'sha256') process.stdout.write(`${receipt.buildPlanSha256}\n`);
  else if (values.format === 'env') {
    const environment = {
      MARKS_PRODUCT_VARIANT: plan.productVariant,
      MARKS_PRODUCT_VARIANT_DEPLOYABLE: plan.deployable ? '1' : '0',
      MARKS_BUILD_PLAN_SHA256: receipt.buildPlanSha256,
      MARKS_BUILD_PLAN_JSON: planJson,
      MARKS_SERVER_CARGO_FEATURES: plan.server.cargoFeatures.join(','),
      VITE_MARKS_DATA_MODE: plan.client.dataMode,
    };
    process.stdout.write(`${Object.entries(environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join('\n')}\n`);
  } else {
    fail(`unknown --format ${JSON.stringify(values.format)}; expected json, canonical, sha256, or env`);
  }
  process.exit(0);
}

if (values.format !== 'json') fail('build-client does not accept --format');
const outDir = values['out-dir'];
if (!outDir) fail('build-client requires --out-dir');
if (!isAbsolute(outDir)) fail('--out-dir must be an absolute path');

const resolvedOutput = resolve(outDir);
const ownedOutputRoot = resolve(REPOSITORY_ROOT, 'client', 'dist-variants');
const legacySequentialOutput = resolve(REPOSITORY_ROOT, 'client', 'dist');
const outputRelative = relative(ownedOutputRoot, resolvedOutput);
const outputSegments = outputRelative.split(/[\\/]/u);
const expectedLeaf = `${plan.client.dataMode}-${receipt.buildPlanSha256.slice(0, 16)}`;
const isIsolatedOutput = !(
  outputRelative.startsWith('../') ||
  isAbsolute(outputRelative) ||
  outputSegments.length !== 2 ||
  outputSegments[0] !== plan.productVariant ||
  outputSegments[1] !== expectedLeaf
);
if (!isIsolatedOutput && resolvedOutput !== legacySequentialOutput) {
  fail(
    '--out-dir must be client/dist or the resolver-owned isolated path ' +
    `${JSON.stringify(resolve(ownedOutputRoot, plan.productVariant, expectedLeaf))}`,
  );
}

// Vite's --emptyOutDir is intentionally destructive. The path allowlist above
// is insufficient if the client root or an ignored build directory has been
// replaced by a symlink, so reject every existing symlink/non-directory
// component before handing the path to Vite.
const clientRoot = resolve(REPOSITORY_ROOT, 'client');
try {
  assertRealClientOutputPath(clientRoot, resolvedOutput);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const result = spawnSync(
  'npm',
  [
    'run',
    'build',
    '--workspace=client',
    '--',
    '--outDir',
    resolvedOutput,
    '--emptyOutDir',
  ],
  {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      MARKS_PRODUCT_VARIANT: plan.productVariant,
      MARKS_PRODUCT_VARIANT_DEPLOYABLE: plan.deployable ? '1' : '0',
      MARKS_BUILD_PLAN_SHA256: receipt.buildPlanSha256,
      MARKS_BUILD_PLAN_JSON: planJson,
      MARKS_SERVER_CARGO_FEATURES: plan.server.cargoFeatures.join(','),
      VITE_MARKS_DATA_MODE: plan.client.dataMode,
    },
    stdio: 'inherit',
  },
);

if (result.error) fail(`client build could not start: ${result.error.message}`);
if (result.signal) fail(`client build terminated by ${result.signal}`);
process.exit(result.status ?? 1);
