import assert from 'node:assert/strict';
import test from 'node:test';
import type { Token } from 'markdown-it';
import { envSignature } from './blocks.ts';

function heading(id: string): Token {
  return {
    type: 'heading_open',
    attrGet(name: string) {
      return name === 'id' ? id : null;
    },
  } as Token;
}

test('global signature changes when an unchanged heading receives a colliding slug', () => {
  const withoutCollision = envSignature({}, [heading('a'), heading('b')]);
  const withCollision = envSignature({}, [heading('b'), heading('b-1')]);

  assert.notEqual(withCollision, withoutCollision);
});

test('global signature includes footnote identity and order, not only list length', () => {
  const firstThenSecond = envSignature({ footnotes: { list: [{ label: 'a' }, { label: 'b' }] } });
  const secondThenFirst = envSignature({ footnotes: { list: [{ label: 'b' }, { label: 'a' }] } });

  assert.notEqual(secondThenFirst, firstThenSecond);
});
