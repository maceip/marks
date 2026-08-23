import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDocumentConfig } from './esbt-document.ts';
import {
  ESBT_ERROR,
  EsbtError,
  MARKS_DOCUMENT_CONFIG,
  engineSiteToMarks,
  exportReconnectPayload,
  isHistoryUnavailable,
  marksSiteToEngine,
  userMessageForError,
} from './index.ts';

test('marks sites widen to the 128-bit engine form and back', () => {
  assert.equal(marksSiteToEngine('2'), '00000000000000000000000000000002');
  assert.equal(marksSiteToEngine(4), '00000000000000000000000000000004');
  assert.equal(engineSiteToMarks('00000000000000000000000000000002'), '2');
  assert.throws(() => marksSiteToEngine('0'));
  assert.throws(() => marksSiteToEngine('site_1234'));
});

test('production config encodes adaptive Dmax and the browser ceilings', () => {
  const bytes = encodeDocumentConfig(MARKS_DOCUMENT_CONFIG);
  assert.equal(bytes[0], 1);
  assert.equal(bytes[1], 0);
  assert.equal(bytes[2] & 0b01, 0b01);
  assert.ok(bytes.byteLength > 16);
});

test('HistoryUnavailable falls back to a compact snapshot', () => {
  const compact = new Uint8Array([9, 9, 9]);
  const payload = exportReconnectPayload(
    {
      exportUpdate() {
        throw new EsbtError(ESBT_ERROR.HistoryUnavailable, 'history floor');
      },
      exportCompactSnapshot() {
        return compact;
      },
    },
    new Uint8Array([1]),
  );
  assert.equal(payload.kind, 'snapshot');
  assert.equal(payload.bytes, compact);
});

test('non-history export failures propagate', () => {
  assert.throws(
    () =>
      exportReconnectPayload(
        {
          exportUpdate() {
            throw new EsbtError(ESBT_ERROR.MalformedEncoding, 'garbage');
          },
          exportCompactSnapshot() {
            return new Uint8Array();
          },
        },
        new Uint8Array([1]),
      ),
    (error: unknown) => isHistoryUnavailable(error) === false && error instanceof EsbtError,
  );
});

test('user-facing copy exists for every plumbing error the UI must handle', () => {
  for (const code of [
    ESBT_ERROR.AllocationExhausted,
    ESBT_ERROR.MessageTooLarge,
    ESBT_ERROR.IdentifierTooDeep,
    ESBT_ERROR.DocumentTooLarge,
    ESBT_ERROR.MissingLocalHistory,
    ESBT_ERROR.SnapshotHasSequenceGaps,
    ESBT_ERROR.HistoryUnavailable,
  ]) {
    const message = userMessageForError(new EsbtError(code, 'x'));
    assert.notEqual(message, 'The collaboration engine rejected that change.');
  }
});
