#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROFILE_ORDER = new Map([
  ['none', 0],
  ['docs', 1],
  ['infra', 2],
  ['web-unit', 3],
  ['web-chromium', 4],
  ['server-chromium', 4],
  ['full', 5],
]);

const PROFILE_CONFIG = {
  none: {
    runRust: false,
    runWeb: false,
    runHarness: false,
    runService: false,
    browsers: ['chromium'],
  },
  docs: {
    runRust: false,
    runWeb: false,
    runHarness: false,
    runService: false,
    browsers: ['chromium'],
  },
  infra: {
    runRust: false,
    runWeb: false,
    runHarness: true,
    runService: false,
    browsers: ['chromium'],
  },
  'web-unit': {
    runRust: false,
    runWeb: true,
    runHarness: false,
    runService: false,
    browsers: ['chromium'],
  },
  'web-chromium': {
    runRust: false,
    runWeb: true,
    runHarness: false,
    runService: true,
    browsers: ['chromium'],
  },
  'server-chromium': {
    runRust: true,
    runWeb: false,
    runHarness: false,
    runService: true,
    browsers: ['chromium'],
  },
  full: {
    runRust: true,
    runWeb: true,
    runHarness: true,
    runService: true,
    browsers: ['chromium', 'firefox', 'webkit'],
  },
};

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function isTestOnly(path) {
  return (
    /(?:^|\/)tests?\//u.test(path) ||
    /\.test\.(?:mjs|js|ts|tsx|rs)$/u.test(path) ||
    /(?:^|\/)test_[^/]+\.rs$/u.test(path)
  );
}

// A changed test inherits the subsystem it verifies. Editor, collaboration/
// ESBT, auth/protocol, service-worker, and CSS/input proofs keep the full
// three-browser suite; server proofs run the Rust plus Chromium lane; pure
// Node proofs run their aggregate lane; anything unrecognized stays full.
function classifyTestPath(path) {
  if (
    startsWithAny(path, [
      'client/public/',
      'client/src/auth/',
      'client/src/browser/',
      'client/src/collab/',
      'client/src/editor/',
      'client/src/styles/',
      'client/src/workers/',
    ]) ||
    /\.(?:css|scss)$/u.test(path)
  ) {
    return { profile: 'full', runtime: false, reason: 'cross-browser-test-self-check' };
  }
  if (startsWithAny(path, ['crates/'])) {
    return { profile: 'server-chromium', runtime: false, reason: 'server-test-self-check' };
  }
  if (startsWithAny(path, ['scripts/harness/'])) {
    return { profile: 'infra', runtime: false, reason: 'harness-test-self-check' };
  }
  if (
    startsWithAny(path, ['client/src/components/', 'client/src/surface/']) ||
    path === 'scripts/token-contract.test.mjs'
  ) {
    return { profile: 'web-unit', runtime: false, reason: 'design-system-test-self-check' };
  }
  if (startsWithAny(path, ['client/src/'])) {
    return { profile: 'web-unit', runtime: false, reason: 'unit-test-self-check' };
  }
  return { profile: 'full', runtime: false, reason: 'test-self-check' };
}

function classifyPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('\n') ||
    path.split('/').includes('..')
  ) {
    return { profile: 'full', runtime: true, reason: 'unsafe-or-unknown-path' };
  }

  // A selector must never be able to downgrade its own verification. Changes
  // to CI selection, the scheduled full proof, or their contract tests force
  // the complete aggregate and three-browser matrix.
  if (
    path === '.github/workflows/ci.yml' ||
    path === '.github/workflows/scheduled-service-smoke.yml' ||
    path === 'scripts/ci-impact.mjs' ||
    path === 'scripts/harness/ci-impact.test.mjs' ||
    path === 'scripts/harness/service-proof-contract.test.mjs' ||
    path === 'scripts/harness/scheduled-workflow.test.mjs'
  ) {
    return { profile: 'full', runtime: false, reason: 'ci-selector-self-check' };
  }

  if (path === 'deploy/systemd/marks.service') {
    return { profile: 'full', runtime: true, reason: 'production-service-runtime' };
  }

  // Production/recovery infrastructure is tested as infrastructure and is not
  // itself an application release. The server-side forced-command boundary
  // owns activation of runtime artifacts.
  if (
    path === '.github/workflows/production.yml' ||
    path === 'scripts/deploy-secure-build.sh' ||
    path === 'scripts/harness/deploy-release.test.mjs' ||
    startsWithAny(path, ['deploy/'])
  ) {
    return { profile: 'infra', runtime: false, reason: 'deployment-infrastructure' };
  }

  // Documentation is only the explicit documentation roots. Markdown
  // elsewhere — an application fixture, a public asset — participates in
  // whatever its directory is, so a content change cannot silently skip
  // runtime testing by carrying a .md suffix.
  if (/^README[^/]*$/u.test(path) || startsWithAny(path, ['docs/'])) {
    return { profile: 'docs', runtime: false, reason: 'documentation' };
  }

  if (startsWithAny(path, ['.cursor/'])) {
    return { profile: 'infra', runtime: false, reason: 'development-infrastructure' };
  }

  if (startsWithAny(path, ['.github/'])) {
    return { profile: 'full', runtime: false, reason: 'github-control-self-check' };
  }

  if (path.startsWith('client/') && path.endsWith('.d.ts')) {
    return { profile: 'web-unit', runtime: false, reason: 'type-declaration' };
  }

  // Tests are conservative but owned: a changed proof runs the subsystem it
  // verifies instead of always escalating to the three-browser matrix. No
  // test change causes a production deployment.
  if (isTestOnly(path)) {
    return classifyTestPath(path);
  }

  if (startsWithAny(path, ['scripts/harness/'])) {
    return { profile: 'infra', runtime: false, reason: 'local-harness-infrastructure' };
  }

  if (
    path === 'Cargo.toml' ||
    path === 'Cargo.lock' ||
    path === 'rust-toolchain.toml' ||
    path === 'package.json' ||
    path === 'package-lock.json' ||
    path === 'engine-profile.json' ||
    path === '.dockerignore' ||
    path === 'client/package.json' ||
    path === 'client/tsconfig.json' ||
    path === 'client/vite.config.ts' ||
    path.endsWith('/Cargo.toml')
  ) {
    return { profile: 'full', runtime: true, reason: 'build-or-dependency-contract' };
  }

  if (
    startsWithAny(path, [
      'client/public/esbt.',
      'client/src/auth/',
      'client/src/browser/',
      'client/src/collab/',
      'client/src/components/',
      'client/src/editor/',
      'client/src/styles/',
      'client/src/surface/',
      'client/src/workers/',
    ]) ||
    path === 'client/public/sw.js' ||
    /\.(?:css|scss)$/u.test(path)
  ) {
    return { profile: 'full', runtime: true, reason: 'cross-browser-or-protocol-runtime' };
  }

  // The design-system catalog, release-coexistence, and mobile UI proofs
  // are browser-based but Chromium-only, and the motion contract is a pure
  // Node check; none needs the complete three-browser escalation alone.
  if (
    path === 'scripts/check-design-system.mjs' ||
    path === 'scripts/check-two-release-coexistence.mjs' ||
    path === 'scripts/check-mobile-ui.mjs'
  ) {
    return { profile: 'web-chromium', runtime: false, reason: 'design-system-proof' };
  }
  if (path === 'scripts/check-motion-tokens.mjs') {
    return { profile: 'web-unit', runtime: false, reason: 'design-system-proof' };
  }

  if (
    startsWithAny(path, [
      'scripts/build-esbt-component.sh',
      'scripts/check-',
      'scripts/inventory-',
      'scripts/measure',
      'scripts/sync-esbt-component.mjs',
      'scripts/verify-esbt-artifact.mjs',
      'scripts/ci-service-ui.mjs',
      'scripts/run-service-ci.sh',
      'scripts/wait-for-server.sh',
      'scripts/visual/',
    ])
  ) {
    return { profile: 'full', runtime: false, reason: 'release-or-service-proof-contract' };
  }

  if (startsWithAny(path, ['crates/'])) {
    return { profile: 'server-chromium', runtime: true, reason: 'server-runtime' };
  }

  if (
    startsWithAny(path, [
      'client/src/bench/',
      'client/src/content/',
      'client/src/text/',
      'client/src/types/',
    ]) ||
    [
      'client/src/intelligence/analyze.ts',
      'client/src/intelligence/frontmatter.ts',
      'client/src/intelligence/operations.ts',
      'client/src/intelligence/types.ts',
      'client/src/markdown/blocks.ts',
      'client/src/markdown/cross-document.ts',
      'client/src/markdown/incremental.ts',
      'client/src/markdown/md.ts',
      'client/src/markdown/tasks.ts',
      'client/src/markdown/types.ts',
    ].includes(path)
  ) {
    return { profile: 'web-unit', runtime: true, reason: 'pure-web-runtime' };
  }

  if (startsWithAny(path, ['client/src/'])) {
    return { profile: 'web-chromium', runtime: true, reason: 'web-runtime' };
  }

  if (startsWithAny(path, ['client/public/', 'client/welcome/'])) {
    return { profile: 'full', runtime: true, reason: 'browser-static-runtime' };
  }

  if (startsWithAny(path, ['scripts/'])) {
    return { profile: 'full', runtime: true, reason: 'unknown-build-script' };
  }

  if (startsWithAny(path, ['fixtures/'])) {
    return { profile: 'full', runtime: false, reason: 'test-fixture' };
  }

  if (path === '.gitignore') {
    return { profile: 'infra', runtime: false, reason: 'repository-infrastructure' };
  }

  return { profile: 'full', runtime: true, reason: 'unknown-default-full' };
}

function mergeProfile(current, next) {
  if (current === 'full' || next === 'full') return 'full';
  const currentFamily = current.startsWith('web-') ? 'web' : current.startsWith('server-') ? 'server' : current;
  const nextFamily = next.startsWith('web-') ? 'web' : next.startsWith('server-') ? 'server' : next;
  if (
    (currentFamily === 'web' && nextFamily === 'server') ||
    (currentFamily === 'server' && nextFamily === 'web')
  ) {
    return 'full';
  }
  return PROFILE_ORDER.get(next) > PROFILE_ORDER.get(current) ? next : current;
}

export function classifyPaths(paths, { forceFull = false } = {}) {
  const uniquePaths = [...new Set(paths)];
  let profile = uniquePaths.length === 0 ? 'none' : 'docs';
  let runtimeChanged = false;
  const reasons = new Set();
  const requirements = {
    runRust: false,
    runWeb: false,
    runHarness: false,
    runService: false,
    browsers: new Set(['chromium']),
  };

  const requireProfile = (requiredProfile) => {
    const config = PROFILE_CONFIG[requiredProfile];
    requirements.runRust ||= config.runRust;
    requirements.runWeb ||= config.runWeb;
    requirements.runHarness ||= config.runHarness;
    requirements.runService ||= config.runService;
    for (const browser of config.browsers) requirements.browsers.add(browser);
  };

  for (const path of uniquePaths) {
    const result = classifyPath(path);
    profile = mergeProfile(profile, result.profile);
    runtimeChanged ||= result.runtime;
    reasons.add(result.reason);
    requireProfile(result.profile);
  }

  if (forceFull && profile !== 'none') {
    profile = 'full';
    reasons.add('explicit-full-request');
  }

  // A mixed server + web change promotes the profile to full even though no
  // individual path is full. Apply the merged profile after the per-path
  // union so combined requirements can never be lost by profile ordering.
  requireProfile(profile);
  return {
    profile,
    runtimeChanged,
    runRust: requirements.runRust,
    runWeb: requirements.runWeb,
    runHarness: requirements.runHarness,
    runAggregate: requirements.runRust || requirements.runWeb || requirements.runHarness,
    runService: requirements.runService,
    browsers: [...requirements.browsers],
    changedPathCount: uniquePaths.length,
    reasons: [...reasons].sort(),
  };
}

function parseArgs(argv) {
  const options = { base: '', head: '', githubOutput: '', forceFull: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--base':
        options.base = argv[++index] ?? '';
        break;
      case '--head':
        options.head = argv[++index] ?? '';
        break;
      case '--github-output':
        options.githubOutput = argv[++index] ?? '';
        break;
      case '--force-full':
        options.forceFull = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function changedPaths(base, head) {
  const revisionPattern = /^[0-9a-f]{40}$/u;
  if (!revisionPattern.test(base) || !revisionPattern.test(head)) {
    throw new Error('base and head must be full lowercase Git revisions');
  }
  if (base === head) return [];
  const emptyRevision = '0000000000000000000000000000000000000000';
  const args = base === emptyRevision
    ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', head, '--']
    : ['diff', '--no-renames', '--name-only', '--diff-filter=ACDMRTUXB', base, head, '--'];
  const result = spawnSync(
    'git',
    args,
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited ${result.status}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function writeGithubOutputs(path, result) {
  const outputs = {
    profile: result.profile,
    runtime_changed: result.runtimeChanged,
    run_rust: result.runRust,
    run_web: result.runWeb,
    run_harness: result.runHarness,
    run_aggregate: result.runAggregate,
    run_service: result.runService,
    browser_matrix: JSON.stringify(result.browsers),
    changed_path_count: result.changedPathCount,
    reasons: result.reasons.join(','),
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join('');
  appendFileSync(path, lines, { encoding: 'utf8' });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = changedPaths(options.base, options.head);
  const result = classifyPaths(paths, { forceFull: options.forceFull });
  if (options.githubOutput) writeGithubOutputs(options.githubOutput, result);
  process.stdout.write(`${JSON.stringify({ ...result, paths }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ci-impact: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
