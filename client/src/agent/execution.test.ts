import assert from 'node:assert/strict';
import test from 'node:test';
import { executeAgentSteps } from './execution.ts';
import type { CommandReceipt, CommandRun } from '../commands/types.ts';

function run(id: string, commandId: string): CommandRun {
  return { id, commandId, source: 'agent', status: 'running', input: {}, proposedAt: 1 };
}

function receipt(value: CommandRun, status: CommandReceipt['status']): CommandReceipt {
  return { ...value, status, finishedAt: 2 };
}

test('agent steps are strictly sequential and stop after a failed receipt', async () => {
  const releases: Array<(value: CommandReceipt) => void> = [];
  const started: string[] = [];
  const port = {
    start(commandId: string) {
      const current = run(String(started.length + 1), commandId);
      started.push(commandId);
      return {
        run: current,
        finished: new Promise<CommandReceipt>((resolve) => releases.push(resolve)),
      };
    },
    cancel() {},
    focusCommands() {},
  };
  const pending = executeAgentSteps(port, [
    { id: 'a', commandId: 'format.bold', input: {} },
    { id: 'b', commandId: 'format.italic', input: {} },
    { id: 'c', commandId: 'format.highlight', input: {} },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['format.bold']);
  releases[0](receipt(run('1', 'format.bold'), 'succeeded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['format.bold', 'format.italic']);
  releases[1](receipt(run('2', 'format.italic'), 'failed'));
  const results = await pending;
  assert.equal(results.length, 2);
  assert.deepEqual(started, ['format.bold', 'format.italic']);
});

test('aborting a plan cancels only its currently active command', async () => {
  let resolve!: (value: CommandReceipt) => void;
  const cancelled: string[] = [];
  const controller = new AbortController();
  const current = run('run-1', 'format.bold');
  const pending = executeAgentSteps({
    start: () => ({ run: current, finished: new Promise((next) => { resolve = next; }) }),
    cancel: (id) => {
      cancelled.push(id);
      resolve(receipt(current, 'cancelled'));
    },
    focusCommands() {},
  }, [
    { id: 'a', commandId: 'format.bold', input: {} },
    { id: 'b', commandId: 'format.italic', input: {} },
  ], { signal: controller.signal });
  await new Promise((done) => setTimeout(done, 0));
  controller.abort();
  const results = await pending;
  assert.deepEqual(cancelled, ['run-1']);
  assert.equal(results.length, 1);
  assert.equal(results[0].receipt.status, 'cancelled');
});
