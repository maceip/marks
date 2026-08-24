import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scheduledPath = resolve(root, '.github/workflows/scheduled-service-smoke.yml');

test('scheduled proof uses the current service boundary and explicit rendering budgets', () => {
  const workflow = readFileSync(scheduledPath, 'utf8');

  assert.match(workflow, /^\s*schedule:\s*$/m);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /VITE_MARKS_DATA_MODE=service VITE_MARKS_TEST_SERVICE_WORKER=1 npm run build/);
  assert.match(workflow, /scripts\/run-service-ci\.sh --bin target\/release\/marks-server/);
  assert.match(workflow, /npm run measure --/);
  assert.match(workflow, /--budget-first-ms 15000/);
  assert.match(workflow, /--budget-p50 150/);
  assert.match(workflow, /--budget-p95 300/);
  assert.match(workflow, /--budget-dirty 2/);
  assert.match(workflow, /--budget-dom 6/);
  assert.doesNotMatch(workflow, /npm run smoke(?:\s|$)/m);
});

test('GitHub JavaScript actions use their supported Node 24 runtime releases', () => {
  const workflows = [
    readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    readFileSync(scheduledPath, 'utf8'),
  ].join('\n');

  assert.doesNotMatch(workflows, /actions\/(?:checkout|setup-node)@v4/);
  assert.match(workflows, /actions\/checkout@v7/);
  assert.match(workflows, /actions\/setup-node@v7/);
});
