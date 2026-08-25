import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextEdits } from '../text/change.ts';
import type { RenderRequest } from './types.ts';
import { createSerialDispatcher } from './serial-dispatch.ts';

test('an async initial render establishes the text before replacement patches run', async () => {
  const marketing = '# Google Docs for Markdown\n\n' + 'm'.repeat(3_445);
  const fixturePrefix = '# Current WebKit service proof\n\n- [ ] shared service task\n\n';
  const fixture = fixturePrefix + 'f'.repeat(1_172 - fixturePrefix.length);
  let releaseInitialRender!: () => void;
  const initialRenderGate = new Promise<void>((resolve) => { releaseInitialRender = resolve; });
  const lifecycle: string[] = [];
  const unexpected: unknown[] = [];
  let workerText = '';

  const dispatch = createSerialDispatcher<RenderRequest>(async (message) => {
    if (message.type === 'reset') {
      workerText = '';
      lifecycle.push('reset');
      return;
    }
    if (message.type === 'render') {
      lifecycle.push('render:start');
      // Model the lazy KaTeX/highlighter import that made WebKit expose the
      // race: event delivery continues while this first handler is suspended.
      await initialRenderGate;
      workerText = message.text;
      lifecycle.push('render:end');
      return;
    }
    lifecycle.push('patch');
    workerText = applyTextEdits(workerText, message.edits);
  }, (error) => unexpected.push(error));

  const initial = dispatch({ type: 'render', seq: 1, text: marketing });
  const replacement = dispatch({
    type: 'patch',
    seq: 2,
    generation: 'test-generation',
    baseChars: marketing.length,
    chars: fixture.length,
    edits: [{ from: 0, to: marketing.length, insert: fixture }],
  });
  const append = dispatch({
    type: 'patch',
    seq: 3,
    generation: 'test-generation',
    baseChars: fixture.length,
    chars: fixture.length + 1,
    edits: [{ from: fixture.length, to: fixture.length, insert: '0' }],
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ['render:start']);
  assert.equal(workerText, '');

  releaseInitialRender();
  await Promise.all([initial, replacement, append]);

  assert.deepEqual(lifecycle, ['render:start', 'render:end', 'patch', 'patch']);
  assert.equal(workerText, `${fixture}0`);
  assert.deepEqual(unexpected, []);
});

test('one unexpected handler failure does not poison later messages', async () => {
  const processed: number[] = [];
  const unexpected: unknown[] = [];
  const dispatch = createSerialDispatcher<number>(async (value) => {
    if (value === 1) throw new Error('synthetic render failure');
    processed.push(value);
  }, (error) => unexpected.push(error));

  await assert.rejects(dispatch(1), /synthetic render failure/);
  await dispatch(2);

  assert.deepEqual(processed, [2]);
  assert.equal(unexpected.length, 1);
});
