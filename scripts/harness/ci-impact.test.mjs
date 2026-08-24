import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyPaths } from '../ci-impact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const classifier = resolve(root, 'scripts/ci-impact.mjs');

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function mustRun(cwd, command, args) {
  const result = run(cwd, command, args);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function compact(result) {
  return {
    profile: result.profile,
    runtimeChanged: result.runtimeChanged,
    runRust: result.runRust,
    runWeb: result.runWeb,
    runHarness: result.runHarness,
    runAggregate: result.runAggregate,
    runService: result.runService,
    browsers: result.browsers,
  };
}

test('an identical revision needs no checks and no deployment', () => {
  assert.deepEqual(compact(classifyPaths([])), {
    profile: 'none',
    runtimeChanged: false,
    runRust: false,
    runWeb: false,
    runHarness: false,
    runAggregate: false,
    runService: false,
    browsers: ['chromium'],
  });
});

test('documentation does not build or deploy application artifacts', () => {
  const result = classifyPaths(['README.md', 'docs/TEST-HARNESS.md']);
  assert.equal(result.profile, 'docs');
  assert.equal(result.runtimeChanged, false);
  assert.equal(result.runAggregate, false);
  assert.equal(result.runService, false);
});

test('deployment-only changes run contract harnesses without app deployment', () => {
  const result = classifyPaths([
    '.github/workflows/production.yml',
    'scripts/deploy-secure-build.sh',
    'scripts/harness/deploy-release.test.mjs',
  ]);
  assert.equal(result.profile, 'infra');
  assert.equal(result.runtimeChanged, false);
  assert.equal(result.runHarness, true);
  assert.equal(result.runRust, false);
  assert.equal(result.runWeb, false);
  assert.equal(result.runService, false);
});

test('CI selectors force their own full three-browser proof without deployment', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/scheduled-service-smoke.yml',
    'scripts/ci-impact.mjs',
    'scripts/harness/ci-impact.test.mjs',
  ]) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, false, path);
    assert.deepEqual(result.browsers, ['chromium', 'firefox', 'webkit'], path);
  }
});

test('explicitly pure text and content changes use the web unit profile', () => {
  const result = classifyPaths([
    'client/src/content/about.ts',
    'client/src/text/change.ts',
  ]);
  assert.equal(result.profile, 'web-unit');
  assert.equal(result.runtimeChanged, true);
  assert.equal(result.runWeb, true);
  assert.equal(result.runRust, false);
  assert.equal(result.runService, false);
});

test('ordinary web runtime changes add Chromium but not unrelated Rust checks', () => {
  const result = classifyPaths([
    'client/src/agent/runtime.ts',
    'client/src/lib/service-api.ts',
  ]);
  assert.equal(result.profile, 'web-chromium');
  assert.equal(result.runtimeChanged, true);
  assert.equal(result.runWeb, true);
  assert.equal(result.runRust, false);
  assert.equal(result.runService, true);
  assert.deepEqual(result.browsers, ['chromium']);
});

test('server-only changes run Rust and one browser integration lane', () => {
  const result = classifyPaths(['crates/marks-server/src/routes/assets.rs']);
  assert.equal(result.profile, 'server-chromium');
  assert.equal(result.runtimeChanged, true);
  assert.equal(result.runRust, true);
  assert.equal(result.runWeb, false);
  assert.equal(result.runService, true);
  assert.deepEqual(result.browsers, ['chromium']);
});

test('browser, auth, editor, service-worker, and ESBT changes stay full', () => {
  for (const path of [
    'client/src/browser/clipboard.ts',
    'client/src/auth/session.ts',
    'client/src/editor/Editor.tsx',
    'client/src/styles/editor.css',
    'client/src/collab/wasm/esbt.ts',
    'client/public/esbt.wit',
    'client/public/sw.js',
  ]) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, true, path);
    assert.deepEqual(result.browsers, ['chromium', 'firefox', 'webkit'], path);
  }
});

test('dependency and toolchain changes stay full and deployable', () => {
  for (const path of [
    'Cargo.lock',
    'package-lock.json',
    'rust-toolchain.toml',
    'crates/marks-server/Cargo.toml',
  ]) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, true, path);
  }
});

test('the production unit is runtime even though other deploy files are infrastructure', () => {
  const unit = classifyPaths(['deploy/systemd/marks.service']);
  assert.equal(unit.profile, 'full');
  assert.equal(unit.runtimeChanged, true);

  const caddy = classifyPaths(['deploy/caddy/Caddyfile']);
  assert.equal(caddy.profile, 'infra');
  assert.equal(caddy.runtimeChanged, false);
});

test('CI proof scripts force full checks without restarting unchanged runtime', () => {
  for (const path of [
    'scripts/ci-service-ui.mjs',
    'scripts/check-ui-budgets.mjs',
    'scripts/measure.mjs',
    'scripts/visual/ribbon.mjs',
  ]) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, false, path);
  }
});

test('local harness implementation runs infrastructure contracts without deployment', () => {
  const result = classifyPaths(['scripts/harness/run.mjs']);
  assert.equal(result.profile, 'infra');
  assert.equal(result.runtimeChanged, false);
  assert.equal(result.runHarness, true);
});

test('a changed test runs the subsystem it verifies, never a deployment', () => {
  const markdown = classifyPaths(['client/src/markdown/render.test.ts']);
  assert.equal(markdown.profile, 'web-unit');
  assert.equal(markdown.runtimeChanged, false);
  assert.equal(markdown.runWeb, true);
  assert.equal(markdown.runService, false);

  const server = classifyPaths(['crates/marks-server/tests/room_collab.rs']);
  assert.equal(server.profile, 'server-chromium');
  assert.equal(server.runtimeChanged, false);
  assert.equal(server.runRust, true);
  assert.equal(server.runService, true);
  assert.deepEqual(server.browsers, ['chromium']);

  const designSystem = classifyPaths([
    'scripts/token-contract.test.mjs',
    'client/src/components/ui/Button.test.ts',
    'client/src/surface/materials.test.ts',
  ]);
  assert.equal(designSystem.profile, 'web-unit');
  assert.equal(designSystem.runtimeChanged, false);
  assert.equal(designSystem.runService, false);

  const harness = classifyPaths(['scripts/harness/session.test.mjs']);
  assert.equal(harness.profile, 'infra');
  assert.equal(harness.runtimeChanged, false);
  assert.equal(harness.runHarness, true);
});

test('editor, collaboration, auth, and protocol test changes stay full', () => {
  for (const path of [
    'client/src/editor/Editor.test.ts',
    'client/src/collab/session.test.ts',
    'client/src/auth/session.test.ts',
    'client/src/browser/clipboard.test.ts',
  ]) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, false, path);
    assert.deepEqual(result.browsers, ['chromium', 'firefox', 'webkit'], path);
  }
});

test('markdown outside explicit documentation roots keeps runtime coverage', () => {
  const fixture = classifyPaths(['fixtures/large-document.md']);
  assert.equal(fixture.profile, 'full');
  assert.equal(fixture.runtimeChanged, false);

  const publicAsset = classifyPaths(['client/public/help.md']);
  assert.equal(publicAsset.profile, 'full');
  assert.equal(publicAsset.runtimeChanged, true);
});

test('the design-system proofs run their own lanes without full escalation', () => {
  const catalog = classifyPaths(['scripts/check-design-system.mjs']);
  assert.equal(catalog.profile, 'web-chromium');
  assert.equal(catalog.runtimeChanged, false);
  assert.equal(catalog.runWeb, true);
  assert.equal(catalog.runService, true);
  assert.deepEqual(catalog.browsers, ['chromium']);

  const motion = classifyPaths(['scripts/check-motion-tokens.mjs']);
  assert.equal(motion.profile, 'web-unit');
  assert.equal(motion.runtimeChanged, false);
  assert.equal(motion.runService, false);
});

test('type declarations are checked but do not replace production artifacts', () => {
  const result = classifyPaths(['client/src/types/markdown-it-plugins.d.ts']);
  assert.equal(result.profile, 'web-unit');
  assert.equal(result.runtimeChanged, false);
  assert.equal(result.runWeb, true);
  assert.equal(result.runService, false);
});

test('a cross-subsystem server and web change escalates to full coverage', () => {
  const result = classifyPaths([
    'crates/marks-server/src/routes/documents.rs',
    'client/src/markdown/render.ts',
  ]);
  assert.equal(result.profile, 'full');
  assert.equal(result.runtimeChanged, true);
  assert.deepEqual(result.browsers, ['chromium', 'firefox', 'webkit']);
});

test('mixed deployment infrastructure and runtime changes keep both requirements', () => {
  const result = classifyPaths([
    'scripts/deploy-secure-build.sh',
    'client/src/text/change.ts',
  ]);
  assert.equal(result.profile, 'web-unit');
  assert.equal(result.runtimeChanged, true);
  assert.equal(result.runHarness, true);
  assert.equal(result.runWeb, true);
  assert.equal(result.runRust, false);
  assert.equal(result.runService, false);
});

test('unknown or unsafe paths fail toward full runtime coverage', () => {
  for (const path of ['unexpected/new-subsystem/file.xyz', '../outside', '/absolute']) {
    const result = classifyPaths([path]);
    assert.equal(result.profile, 'full', path);
    assert.equal(result.runtimeChanged, true, path);
  }
});

test('an explicit full request cannot turn an empty diff into a deployment', () => {
  const empty = classifyPaths([], { forceFull: true });
  assert.equal(empty.profile, 'none');
  assert.equal(empty.runtimeChanged, false);

  const docs = classifyPaths(['README.md'], { forceFull: true });
  assert.equal(docs.profile, 'full');
  assert.equal(docs.runtimeChanged, false);
});

test('the CLI treats a runtime-to-docs rename as both deletion and addition', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'marks-ci-impact.'));
  try {
    mustRun(fixture, 'git', ['init', '--quiet']);
    mustRun(fixture, 'git', ['config', 'user.name', 'Marks CI']);
    mustRun(fixture, 'git', ['config', 'user.email', 'marks-ci@example.invalid']);
    mkdirSync(resolve(fixture, 'client/src/editor'), { recursive: true });
    writeFileSync(resolve(fixture, 'client/src/editor/Editor.tsx'), 'export const editor = true;\n');
    mustRun(fixture, 'git', ['add', '.']);
    mustRun(fixture, 'git', ['commit', '--quiet', '-m', 'runtime']);
    const base = mustRun(fixture, 'git', ['rev-parse', 'HEAD']);

    mkdirSync(resolve(fixture, 'docs'), { recursive: true });
    mustRun(fixture, 'git', ['mv', 'client/src/editor/Editor.tsx', 'docs/Editor.tsx']);
    mustRun(fixture, 'git', ['commit', '--quiet', '-m', 'rename']);
    const head = mustRun(fixture, 'git', ['rev-parse', 'HEAD']);
    const output = resolve(fixture, 'github-output');
    writeFileSync(output, '');

    const result = run(fixture, process.execPath, [
      classifier,
      '--base', base,
      '--head', head,
      '--github-output', output,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.profile, 'full');
    assert.equal(receipt.runtimeChanged, true);
    assert.deepEqual(receipt.paths, [
      'client/src/editor/Editor.tsx',
      'docs/Editor.tsx',
    ]);
    assert.match(readFileSync(output, 'utf8'), /^runtime_changed=true$/m);
    assert.match(readFileSync(output, 'utf8'), /^browser_matrix=\["chromium","firefox","webkit"\]$/m);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
