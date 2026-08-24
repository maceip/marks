import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearActiveHostedRun,
  readActiveHostedRun,
  writeActiveHostedRun,
  type ActiveHostedRunRecord,
} from './run-store.ts';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function record(): ActiveHostedRunRecord {
  return {
    version: 1,
    documentId: 'doc_1',
    runId: 'run_1',
    requestId: 'request_1',
    eventsUrl: '/v1/agent/runs/run_1/events',
    expiresAtMs: 2_000,
    lastEventId: '7',
    calls: [{
      callId: 'call_1',
      requestId: 'result_1',
      commandId: 'format.bold',
      state: 'terminal',
      status: 'succeeded',
      message: 'durable',
    }],
  };
}

test('active hosted run survives reload without storing prompt or command arguments', () => {
  const storage = new MemoryStorage();
  writeActiveHostedRun(record(), storage);
  const restored = readActiveHostedRun('doc_1', storage, 1_000);
  assert.deepEqual(restored, record());
  const serialized = storage.getItem('marks:hosted-agent-run:v1:doc_1') ?? '';
  assert.doesNotMatch(serialized, /prompt|arguments/u);
});

test('expired and malformed runs fail closed and are removed', () => {
  const storage = new MemoryStorage();
  writeActiveHostedRun(record(), storage);
  assert.equal(readActiveHostedRun('doc_1', storage, 2_001), null);
  storage.setItem('marks:hosted-agent-run:v1:doc_1', '{bad');
  assert.equal(readActiveHostedRun('doc_1', storage, 1), null);
  clearActiveHostedRun('doc_1', storage);
  assert.equal(storage.length, 0);
});

