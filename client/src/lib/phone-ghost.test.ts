import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GHOST_SHIFT_END_PERCENT,
  GHOST_SHIFT_START_PERCENT,
  PhoneGhostGesture,
  clampGhostPercent,
  formatGhostPercent,
  ghostPercentFromDrag,
  isHorizontalPan,
  isPinchGesture,
  percentToShift,
  pinchRatio,
  shiftToPercent,
} from './phone-ghost.ts';

describe('phone ghost geometry', () => {
  it('maps the default start shift to a 50% translation', () => {
    assert.equal(shiftToPercent('start'), GHOST_SHIFT_START_PERCENT);
    assert.equal(shiftToPercent('end'), GHOST_SHIFT_END_PERCENT);
    assert.equal(percentToShift(50), 'start');
    assert.equal(percentToShift(0), 'end');
    assert.equal(percentToShift(24.9), 'end');
    assert.equal(percentToShift(25), 'start');
  });

  it('clamps live translation to the two viewfinder stops', () => {
    assert.equal(clampGhostPercent(-20), 0);
    assert.equal(clampGhostPercent(80), 50);
    assert.equal(formatGhostPercent(50), '50%');
  });

  it('moves the page with two-finger travel across the workspace width', () => {
    assert.equal(ghostPercentFromDrag(50, -200, 400), 0);
    assert.equal(ghostPercentFromDrag(0, 200, 400), 50);
    assert.equal(ghostPercentFromDrag(50, 80, 400), 50);
  });

  it('treats scale changes as pinch and horizontal travel as pan', () => {
    assert.equal(isPinchGesture(100, 112), true);
    assert.equal(isPinchGesture(100, 89), true);
    assert.equal(isPinchGesture(100, 105), false);
    assert.equal(pinchRatio(100, 50), 2);
    assert.equal(isHorizontalPan(-40, 10), true);
    assert.equal(isHorizontalPan(-8, 2), false);
    assert.equal(isHorizontalPan(-20, -40), false);
  });
});

describe('PhoneGhostGesture', () => {
  it('ignores a single pointer so text editing stays free', () => {
    const gesture = new PhoneGhostGesture();
    assert.equal(gesture.down(1, 40, 80, 50), 'pass');
    assert.equal(gesture.kind, 'idle');
    assert.deepEqual(gesture.move(1, 80, 80, 400), { kind: 'idle' });
    assert.deepEqual(gesture.up(1), { type: 'continue' });
  });

  it('captures the second pointer and snaps to the other half on a left pan', () => {
    const gesture = new PhoneGhostGesture();
    assert.equal(gesture.down(1, 120, 200, 50), 'pass');
    assert.equal(gesture.down(2, 180, 200, 50), 'capture');
    gesture.move(1, 10, 204, 400);
    const last = gesture.move(2, 40, 204, 400);
    assert.equal(last.kind, 'pan');
    if (last.kind === 'pan') assert.ok(last.percent < 25);
    assert.deepEqual(gesture.up(1), { type: 'snap', shift: 'end', percent: 0 });
  });

  it('aborts to the committed shift when the fingers pinch', () => {
    const gesture = new PhoneGhostGesture();
    gesture.down(1, 100, 200, 50);
    gesture.down(2, 160, 200, 50);
    gesture.move(1, 40, 200, 400);
    const result = gesture.move(2, 220, 200, 400);
    assert.equal(result.kind, 'pinch');
    if (result.kind === 'pinch') assert.equal(result.percent, 50);
    assert.deepEqual(gesture.up(2), { type: 'restore', percent: 50 });
  });

  it('does not steal a vertical two-finger scroll', () => {
    const gesture = new PhoneGhostGesture();
    gesture.down(1, 100, 180, 50);
    gesture.down(2, 160, 180, 50);
    const result = gesture.move(1, 102, 80, 400);
    gesture.move(2, 162, 80, 400);
    assert.equal(result.kind, 'undecided');
    assert.deepEqual(gesture.up(1), { type: 'restore', percent: 50 });
  });
});
