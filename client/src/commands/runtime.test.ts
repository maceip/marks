import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandRuntime } from './runtime.ts';
import type { CommandEnvironment } from './types.ts';

function environment(): CommandEnvironment {
  return {
    hasDocument: true,
    hydrated: true,
    capabilities: { role: 'owner', edit: true, comment: true, saveVersion: true, manageShares: true },
    workspaceKind: 'session',
    mode: 'edit',
    activePane: 'editor',
    shell: 'desktop',
    context: 'text',
    selectionLength: 4,
    selectionFrom: 0,
    selectionTo: 4,
    voiceSupported: true,
    voiceActive: false,
    theme: 'light',
    outlineOpen: false,
    hudOpen: false,
    ribbonCollapsed: false,
    reviewOpen: null,
    formatPainterArmed: false,
  };
}

test('human and agent calls use one executor while external agent effects await approval', async () => {
  let calls = 0;
  const runtime = new CommandRuntime({
    environment,
    id: (() => { let id = 0; return () => String(++id); })(),
    execute: async () => { calls += 1; return { ok: true, message: 'done' }; },
  });

  const human = await runtime.invoke('format.bold', { source: 'human' });
  assert.equal(human.status, 'succeeded');
  assert.equal(calls, 1);

  const agent = runtime.propose('document.print');
  assert.equal(agent.status, 'awaiting-approval');
  assert.equal(calls, 1);
  runtime.approve(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.getSnapshot().receipts.at(-1)?.status, 'succeeded');
  assert.equal(calls, 2);
});

test('runtime reauthorizes immediately before execution', async () => {
  const current = environment();
  const runtime = new CommandRuntime({
    environment: () => current,
    execute: async () => ({ ok: true }),
  });
  const run = runtime.propose('document.delete');
  current.capabilities = { role: 'viewer', edit: false, comment: false, saveVersion: false, manageShares: false };
  runtime.approve(run.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const receipt = runtime.getSnapshot().receipts.at(-1);
  assert.equal(receipt?.status, 'failed');
  assert.match(receipt?.error ?? '', /role/i);
});

test('cancellation prevents a late success receipt', async () => {
  let release: (() => void) | undefined;
  const runtime = new CommandRuntime({
    environment,
    execute: async (_command, _input, signal) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: !signal.aborted };
    },
  });
  const run = runtime.propose('format.bold');
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.cancel(run.id);
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.getSnapshot().receipts.at(-1)?.status, 'cancelled');
});

test('agent arguments are schema validated before the executor', async () => {
  let calls = 0;
  const runtime = new CommandRuntime({
    environment,
    execute: async () => { calls += 1; return { ok: true }; },
  });
  const missing = runtime.start('insert.picture-url', { source: 'agent' });
  const extra = runtime.start('format.bold', { source: 'agent', input: { surprise: true } });
  assert.equal(missing.run.status, 'failed');
  assert.equal(extra.run.status, 'failed');
  assert.equal((await missing.finished).status, 'failed');
  assert.equal((await extra.finished).status, 'failed');
  assert.equal(calls, 0);
});
