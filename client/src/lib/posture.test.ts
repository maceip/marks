import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPosture } from './posture.ts';

describe('classifyPosture', () => {
  it('uses viewport segments for a book fold, not width', () => {
    const posture = classifyPosture({
      width: 1280,
      height: 800,
      coarse: true,
      spanningHorizontal: true,
      segments: [
        { x: 0, y: 0, width: 620, height: 800 },
        { x: 656, y: 0, width: 624, height: 800 },
      ],
    });
    assert.equal(posture.shell, 'fold-book');
    assert.equal(posture.hinge, 'vertical');
    assert.equal(posture.foldable, true);
    assert.equal(posture.geometry.hingeGap, 36);
    assert.equal(posture.phone, false);
  });

  it('uses stacked segments for a laptop fold', () => {
    const posture = classifyPosture({
      width: 840,
      height: 1100,
      coarse: true,
      spanningVertical: true,
      segments: [
        { x: 0, y: 0, width: 840, height: 520 },
        { x: 0, y: 548, width: 840, height: 552 },
      ],
    });
    assert.equal(posture.shell, 'fold-laptop');
    assert.equal(posture.hinge, 'horizontal');
    assert.equal(posture.geometry.hingeGap, 28);
  });

  it('keeps a phone shell for a short coarse landscape even when wide', () => {
    const posture = classifyPosture({
      width: 844,
      height: 390,
      coarse: true,
    });
    assert.equal(posture.shell, 'phone');
    assert.equal(posture.overlayNavigation, true);
  });

  it('classifies a mid-width fine pointer as studio, not phone', () => {
    const posture = classifyPosture({
      width: 900,
      height: 1200,
      coarse: false,
    });
    assert.equal(posture.shell, 'studio');
    assert.equal(posture.foldable, false);
  });

  it('classifies a wide fine pointer as desktop', () => {
    const posture = classifyPosture({
      width: 1440,
      height: 900,
      coarse: false,
    });
    assert.equal(posture.shell, 'desktop');
    assert.equal(posture.overlayNavigation, false);
  });

  it('honors an explicit override for foldable walkthroughs', () => {
    const posture = classifyPosture({
      width: 390,
      height: 844,
      coarse: true,
      override: 'fold-book',
    });
    assert.equal(posture.shell, 'fold-book');
    assert.equal(posture.segments, 2);
    assert.ok(posture.geometry.hingeGap > 0);
  });

  it('detects a virtual keyboard from the visual viewport', () => {
    const posture = classifyPosture({
      width: 390,
      height: 844,
      coarse: true,
      visualViewportHeight: 480,
    });
    assert.equal(posture.keyboardOpen, true);
    assert.equal(posture.keyboardInset, 364);
  });
});
