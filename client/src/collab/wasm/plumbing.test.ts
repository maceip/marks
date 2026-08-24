import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyComponentArtifact } from './esbt-document.ts';
import { createTestRuntime } from './test-runtime.ts';
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

test('production config crosses WIT as typed adaptive Dmax and resource ceilings', async () => {
  const runtime = await createTestRuntime();
  const config = runtime.resolveConfig(MARKS_DOCUMENT_CONFIG);
  assert.equal(config.strategy.kind, 'midpoint');
  assert.equal(config.adaptiveDmax?.floor, 16);
  assert.equal(config.adaptiveDmax?.ceiling, 2_147_483_648);
  assert.equal(config.limits.maxDocumentUnits, 1_000_000);
  assert.equal(config.limits.maxMessageBytes, 64 * 1024 * 1024);
});

test('component core bytes must match their provenance descriptor', async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const descriptor = { path: '/dummy.wasm', bytes: bytes.byteLength, sha256 };
  await verifyComponentArtifact(bytes, descriptor);
  await assert.rejects(
    verifyComponentArtifact(bytes, { ...descriptor, sha256: '0'.repeat(64) }),
    /do not match/,
  );
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
