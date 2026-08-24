import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRACTICAL_ACTIONS,
  practicalCapabilityForAction,
} from './practical.ts';
import { PRACTICAL_SURFACES } from './practical-surfaces.ts';
import { UI_ACTIONS } from './ui-actions.ts';

test('all eighteen practical capabilities have a unique ribbon action and inspector destination', () => {
  assert.equal(PRACTICAL_ACTIONS.length, 18);
  assert.equal(PRACTICAL_SURFACES.length, 18);
  assert.equal(new Set(PRACTICAL_ACTIONS).size, 18);
  assert.equal(new Set(PRACTICAL_SURFACES.map((item) => item.capability)).size, 18);
  assert.deepEqual(
    PRACTICAL_ACTIONS.map((action) => practicalCapabilityForAction(action)),
    PRACTICAL_SURFACES.map((item) => item.capability),
  );
  const registered = new Set(UI_ACTIONS.map((action) => action.id));
  for (const action of PRACTICAL_ACTIONS) assert.ok(registered.has(action), action);
});

test('unrelated and prototype-shaped action names never reach a practical surface', () => {
  assert.equal(practicalCapabilityForAction('bold'), null);
  assert.equal(practicalCapabilityForAction('__proto__'), null);
  assert.equal(practicalCapabilityForAction('constructor'), null);
});
