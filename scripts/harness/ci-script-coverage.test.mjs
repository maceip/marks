import assert from 'node:assert/strict';
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
    'npm run build',
    'npm run test:harness',
  ]) {
    assert.match(ciWorkflow, invocationPattern(command), `${command} is missing from ci.yml`);
    assert.match(
      deploymentGate,
      invocationPattern(command),
      `${command} is missing from deploy-secure-build.sh`,
    );
  }
});
