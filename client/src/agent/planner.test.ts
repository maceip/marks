import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCommands } from '../commands/projection.ts';
import type { CommandEnvironment } from '../commands/types.ts';
import { planAgentRequest } from './planner.ts';

const environment: CommandEnvironment = {
  hasDocument: true,
  hydrated: true,
  capabilities: { role: 'owner', edit: true, comment: true, saveVersion: true, manageShares: true },
  workspaceKind: 'session',
  mode: 'edit',
  shell: 'desktop',
  context: 'text',
  selectionLength: 12,
  selectionFrom: 0,
  selectionTo: 12,
  voiceSupported: true,
  voiceActive: false,
  theme: 'light',
  outlineOpen: false,
  hudOpen: false,
  ribbonCollapsed: false,
  reviewOpen: null,
  formatPainterArmed: false,
};
const commands = projectCommands(environment, 'agent');

test('local planner turns one request into ordered registry command steps', () => {
  const plan = planAgentRequest('Make this bold and italic, then show split view', commands);
  assert.deepEqual(plan.steps.map((step) => step.commandId), ['format.bold', 'format.italic', 'view.split']);
});

test('one request cannot finish by applying two mutually exclusive view modes', () => {
  const plan = planAgentRequest('Show source and rendering together', commands);
  assert.deepEqual(plan.steps.map((step) => step.commandId), ['view.split']);
});

test('image URL extraction produces schema-ready arguments', () => {
  const plan = planAgentRequest('Insert an image from https://example.test/cat.png described as “sleeping cat”', commands);
  assert.equal(plan.steps[0]?.commandId, 'insert.picture-url');
  assert.deepEqual(plan.steps[0]?.input, { url: 'https://example.test/cat.png', alt: 'sleeping cat' });
});

test('help and unmatched requests do not guess mutations', () => {
  assert.equal(planAgentRequest('What can you help me with?', commands).steps.length, 0);
  assert.equal(planAgentRequest('Contemplate the nature of authorship', commands).steps.length, 0);
});
