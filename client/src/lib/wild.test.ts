import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_ACTIONS } from './ui-actions.ts';
import {
  WILD_ACTIONS,
  WILD_SURFACES,
  wildCapabilityForAction,
} from './wild.ts';

test('all five wild capabilities have one registered action and destination', () => {
  assert.equal(WILD_ACTIONS.length, 5);
  assert.equal(WILD_SURFACES.length, 5);
  assert.equal(new Set(WILD_ACTIONS).size, 5);
  assert.deepEqual(
    WILD_ACTIONS.map((action) => wildCapabilityForAction(action)),
    WILD_SURFACES.map((surface) => surface.capability),
  );
  const registered = new Set(UI_ACTIONS.map((action) => action.id));
  for (const action of WILD_ACTIONS) assert.ok(registered.has(action), action);
});

test('prototype-shaped and unrelated values never reach a wild surface', () => {
  assert.equal(wildCapabilityForAction('bold'), null);
  assert.equal(wildCapabilityForAction('__proto__'), null);
  assert.equal(wildCapabilityForAction('constructor'), null);
});
