import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_ACTIONS } from './ui-actions.ts';
import { WILD_SURFACES } from './wild-surfaces.ts';
import { WILD_ACTIONS, wildCapabilityForAction } from './wild.ts';
import { RIBBON_WILD_ENABLED } from './product.ts';

test('all five wild capabilities have one destination and registration follows the product flag', () => {
  assert.equal(WILD_ACTIONS.length, 5);
  assert.equal(WILD_SURFACES.length, 5);
  assert.equal(new Set(WILD_ACTIONS).size, 5);
  assert.deepEqual(
    WILD_ACTIONS.map((action) => wildCapabilityForAction(action)),
    WILD_SURFACES.map((surface) => surface.capability),
  );
  const registered = new Set(UI_ACTIONS.map((action) => action.id));
  for (const action of WILD_ACTIONS) {
    assert.equal(registered.has(action), RIBBON_WILD_ENABLED, action);
  }
});

test('prototype-shaped and unrelated values never reach a wild surface', () => {
  assert.equal(wildCapabilityForAction('bold'), null);
  assert.equal(wildCapabilityForAction('__proto__'), null);
  assert.equal(wildCapabilityForAction('constructor'), null);
});
