/**
 * Contract tests: every invariant `docs/ESBT-INTEGRATION.md` says marks will
 * assert, plus the paper's worked situations from the Rust reference suite,
 * plus the additions this implementation made to the contract
 * (`EphemeralStore.keys`, undo merge grouping, anchors).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EphemeralStore, EsbtDoc, UndoManager, VersionVector } from './index.js';
import { Allocator, cmpWeight, fraction, newseq, weight } from './weight.js';

/** Pipe every local update of `from` straight into `to`. */
function wire(from: EsbtDoc, to: EsbtDoc): () => void {
  return from.subscribeLocalUpdates((update) => to.import(update));
}

/** Deterministic PRNG (mulberry32) for fuzz cases. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- weights */

test('weight order follows Definition 2', () => {
  const a = weight(fraction(1, 4), 0, [0], 'site1');
  const mid = weight(fraction(1, 4), 0, [0, 5], 'site1');
  const b = weight(fraction(1, 4), 1, [0], 'site1');
  const c = weight(fraction(2, 3), 0, [0], 'site1');
  assert.ok(cmpWeight(a, mid) < 0 && cmpWeight(mid, b) < 0 && cmpWeight(b, c) < 0);
  const d = weight(fraction(1, 4), 1, [0], 'site2');
  assert.ok(cmpWeight(b, d) < 0);
});

test('NEWSEQ reproduces the paper examples', () => {
  assert.deepEqual(newseq([3], [7], 10, 3, 'x'), [5]);
  assert.deepEqual(newseq([3], [4], 10, 3, 'x'), [3, 5]);
});

test('Situation 1: the mediant 3/7 is rejected at Dmax = 5', () => {
  const alloc = new Allocator(5, 10, 3);
  const w1 = weight(fraction(1, 4), 0, [0], 'a');
  const w2 = weight(fraction(2, 3), 0, [0], 'a');
  const w = alloc.createWeight(w1, w2, 'a')!;
  assert.deepEqual(w.f, fraction(1, 4));
  assert.equal(w.sn, 1);
});

test('Situation 2: the sn ladder walks right +1 / left −1', () => {
  const alloc = new Allocator(5, 10, 3);
  const w1 = weight(fraction(1, 4), 0, [0], 'a');
  const w2 = weight(fraction(2, 3), 0, [0], 'a');
  const r1 = alloc.createWeight(w1, w2, 'a')!;
  const r2 = alloc.createWeight(r1, w2, 'a')!;
  const begin = weight(fraction(0, 1), 0, [0], '');
  const l1 = alloc.createWeight(begin, w1, 'a')!;
  const l2 = alloc.createWeight(begin, l1, 'a')!;
  assert.deepEqual([r1.sn, r2.sn, l1.sn, l2.sn], [1, 2, -1, -2]);
  assert.ok(cmpWeight(l2, l1) < 0 && cmpWeight(l1, w1) < 0);
  assert.ok(cmpWeight(w1, r1) < 0 && cmpWeight(r1, r2) < 0 && cmpWeight(r2, w2) < 0);
});

test('Situation 3: the sequence path splits equal (f, sn)', () => {
  const alloc = new Allocator(5, 10, 3);
  const w0 = weight(fraction(1, 4), 0, [0], 'a');
  const w1 = weight(fraction(1, 4), 1, [0], 'a');
  const mid = alloc.createWeight(w0, w1, 'b')!;
  assert.ok(cmpWeight(w0, mid) < 0 && cmpWeight(mid, w1) < 0);
  assert.equal(mid.sn, 0);
});

test('fraction layer assigns the mediant while it fits', () => {
  const alloc = new Allocator(10, 10, 3);
  const w1 = weight(fraction(1, 3), 0, [0], 'a');
  const w2 = weight(fraction(1, 2), 0, [0], 'a');
  const w = alloc.createWeight(w1, w2, 'a')!;
  assert.deepEqual(w.f, fraction(2, 5));
  assert.equal(w.sn, 0);
});

/* --------------------------------------------------------------- editing */

test('local editing: insert, delete, replaceRange, setText, clamping', () => {
  const doc = new EsbtDoc();
  doc.insert(0, 'hello world');
  assert.equal(doc.getText(), 'hello world');
  assert.equal(doc.length, 11);

  doc.delete(5, 6);
  assert.equal(doc.getText(), 'hello');

  doc.replaceRange(0, 5, 'goodbye');
  assert.equal(doc.getText(), 'goodbye');

  doc.setText('fresh');
  assert.equal(doc.getText(), 'fresh');

  // Out of range clamps, never throws.
  doc.insert(999, '!');
  assert.equal(doc.getText(), 'fresh!');
  doc.delete(999, 5);
  assert.equal(doc.getText(), 'fresh!');
  doc.delete(-5, 2);
  assert.equal(doc.getText(), 'esh!');
});

test('surrogate pairs survive the wire unit-for-unit', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const unwire = wire(a, b);
  a.insert(0, 'x🎉y');
  a.delete(1, 1); // deletes only the high surrogate — the editor's business
  unwire();
  assert.equal(b.getText(), a.getText());
  const c = new EsbtDoc();
  c.import(a.export({ mode: 'snapshot' }));
  assert.equal(c.getText(), a.getText());
});

/* --------------------------------------------------------- convergence */

test('two replicas exchanging only updates converge', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const ua = wire(a, b);
  const ub = wire(b, a);

  a.insert(0, 'shared ');
  b.insert(b.length, 'ground');
  a.insert(0, '# ');
  b.delete(0, 1);

  ua();
  ub();
  assert.equal(a.getText(), b.getText());
});

test('offline edits appear on the peer via a version-vector delta, not a snapshot', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  a.insert(0, 'base');
  b.import(a.export({ mode: 'update' }));
  assert.equal(b.getText(), 'base');

  // A goes offline and keeps typing.
  a.insert(4, ' + offline edits');

  // Reconnect: B announces what it has, A ships only the difference.
  const delta = a.export({ mode: 'update', from: b.oplogVersion() });
  assert.ok(delta.byteLength > 0);
  b.import(delta);
  assert.equal(b.getText(), 'base + offline edits');

  // The delta contains nothing B already had.
  const nothing = a.export({ mode: 'update', from: b.oplogVersion() });
  b.import(nothing);
  assert.equal(b.getText(), 'base + offline edits');
});

test('a delete delivered before its insert waits, then applies', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });

  const updates: Uint8Array[] = [];
  const stop = a.subscribeLocalUpdates((u) => updates.push(u));
  a.insert(0, 'A');
  a.delete(0, 1);
  stop();
  assert.equal(updates.length, 2);

  // Deliver the delete first: it must neither drop the insert nor throw.
  b.import(updates[1]);
  assert.equal(b.getText(), '');
  b.import(updates[0]);
  assert.equal(b.getText(), '');
  assert.equal(a.getText(), '');
});

test('concurrent inserts between the same pair are both present, stably ordered', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const c = new EsbtDoc({ siteId: 'c' });

  a.insert(0, 'XY');
  const seed = a.export({ mode: 'update' });
  b.import(seed);
  c.import(seed);

  const fromA: Uint8Array[] = [];
  const fromB: Uint8Array[] = [];
  const fromC: Uint8Array[] = [];
  a.subscribeLocalUpdates((u) => fromA.push(u));
  b.subscribeLocalUpdates((u) => fromB.push(u));
  c.subscribeLocalUpdates((u) => fromC.push(u));

  a.insert(1, '1');
  b.insert(1, '2');
  c.insert(1, '3');

  // Every replica sees the others' ops in a different order.
  for (const u of [...fromB, ...fromC]) a.import(u);
  for (const u of [...fromC, ...fromA]) b.import(u);
  for (const u of [...fromA, ...fromB]) c.import(u);

  assert.equal(a.getText(), b.getText());
  assert.equal(b.getText(), c.getText());
  assert.equal(a.getText().length, 5);
  assert.ok(a.getText().startsWith('X') && a.getText().endsWith('Y'));
});

test('same integrated op set ⇒ identical text, any delivery order (fuzz)', () => {
  for (const seed of [1, 42, 20260821]) {
    const random = rng(seed);
    const sites = ['a', 'b', 'c'];
    const docs = sites.map((siteId) => new EsbtDoc({ siteId }));
    const outbox: Uint8Array[][] = sites.map(() => []);
    docs.forEach((doc, i) => doc.subscribeLocalUpdates((u) => outbox[i].push(u)));

    for (let step = 0; step < 300; step++) {
      const i = Math.floor(random() * docs.length);
      const doc = docs[i];
      const roll = random();
      if (roll < 0.55 || doc.length === 0) {
        const at = Math.floor(random() * (doc.length + 1));
        const ch = String.fromCharCode(97 + Math.floor(random() * 26));
        doc.insert(at, random() < 0.15 ? ch.repeat(3) : ch);
      } else if (roll < 0.8) {
        const at = Math.floor(random() * doc.length);
        doc.delete(at, 1 + Math.floor(random() * 2));
      } else {
        const from = Math.floor(random() * (doc.length + 1));
        const to = Math.min(doc.length, from + Math.floor(random() * 3));
        doc.replaceRange(from, to, 'R');
      }
    }

    // Deliver everything to everyone, in a per-receiver shuffled sender order.
    for (let r = 0; r < docs.length; r++) {
      const order = [...outbox.keys()].filter((s) => s !== r);
      if (random() < 0.5) order.reverse();
      for (const s of order) {
        for (const update of outbox[s]) docs[r].import(update);
      }
    }

    assert.equal(docs[0].getText(), docs[1].getText(), `seed ${seed}`);
    assert.equal(docs[1].getText(), docs[2].getText(), `seed ${seed}`);
  }
});

/* ------------------------------------------------------ snapshots / wire */

test('setText → snapshot → import on a fresh doc reproduces the string', () => {
  const a = new EsbtDoc();
  a.setText('# Title\n\nBody with **bold** and \u00e9\u5b57🎈.');
  const snapshot = a.export({ mode: 'snapshot' });
  const b = new EsbtDoc();
  b.import(snapshot);
  assert.equal(b.getText(), a.getText());

  // Idempotent: importing the same payload again changes nothing.
  b.import(snapshot);
  assert.equal(b.getText(), a.getText());
});

test('an update from an empty version vector reproduces the snapshot text', () => {
  const a = new EsbtDoc();
  a.setText('replay me');
  const b = new EsbtDoc();
  b.import(a.export({ mode: 'update' }));
  assert.equal(b.getText(), 'replay me');
});

test('fork: snapshot → two docs → edits each → exchange updates → equal text', () => {
  const origin = new EsbtDoc({ siteId: 'origin' });
  origin.setText('The quick brown fox jumps over the lazy dog.');
  const snapshot = origin.export({ mode: 'snapshot' });

  const a = new EsbtDoc({ siteId: 'fork-a' });
  const b = new EsbtDoc({ siteId: 'fork-b' });
  a.import(snapshot);
  b.import(snapshot);

  for (let i = 0; i < 20; i++) {
    a.insert(Math.min(a.length, 4 + i), 'A');
    b.insert(Math.min(b.length, 10 + i), 'B');
    if (i % 3 === 0) {
      a.delete(0, 1);
      b.delete(b.length - 1, 1);
    }
  }

  const forA = b.export({ mode: 'update', from: a.oplogVersion() });
  const forB = a.export({ mode: 'update', from: b.oplogVersion() });
  a.import(forA);
  b.import(forB);
  assert.equal(a.getText(), b.getText());
});

test('import merges a snapshot — newer local ops are never clobbered', () => {
  const server = new EsbtDoc({ siteId: 'server' });
  server.setText('server state');
  const snapshot = server.export({ mode: 'snapshot' });

  const client = new EsbtDoc({ siteId: 'client' });
  client.import(snapshot);
  client.insert(client.length, ' + local tail'); // ops the snapshot has never seen
  client.import(snapshot); // e.g. a stale HTTP response arriving late
  assert.equal(client.getText(), 'server state + local tail');
});

test('shallow snapshot paints the text without an oplog and still merges', () => {
  const server = new EsbtDoc({ siteId: 'server' });
  server.setText('cold open body');
  const shallow = server.export({ mode: 'shallow-snapshot' });
  const full = server.export({ mode: 'snapshot' });
  assert.ok(shallow.byteLength < full.byteLength);

  const client = new EsbtDoc({ siteId: 'client' });
  client.import(shallow);
  assert.equal(client.getText(), 'cold open body');

  // The shallow copy can not serve history it does not hold…
  const replay = client.export({ mode: 'update' });
  const fresh = new EsbtDoc();
  fresh.import(replay);
  assert.equal(fresh.getText(), '');

  // …but it edits and syncs normally from here on.
  client.insert(client.length, '!');
  server.import(client.export({ mode: 'update', from: server.oplogVersion() }));
  assert.equal(server.getText(), 'cold open body!');
});

test('a delete the exporter still had buffered stays buffered through a snapshot', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });

  const updates: Uint8Array[] = [];
  const stop = a.subscribeLocalUpdates((u) => updates.push(u));
  a.insert(0, 'Z');
  a.delete(0, 1);
  stop();

  // B receives only the delete: it waits for its insert.
  b.import(updates[1]);
  // A third replica bootstraps from B's full snapshot while that delete is pending.
  const c = new EsbtDoc({ siteId: 'c' });
  c.import(b.export({ mode: 'snapshot' }));

  // The insert finally reaches both: the buffered delete must fire on each.
  b.import(updates[0]);
  c.import(updates[0]);
  assert.equal(b.getText(), '');
  assert.equal(c.getText(), '');
});

test('unknown and corrupt payloads throw; nothing half-applies', () => {
  const doc = new EsbtDoc();
  doc.setText('untouched');
  assert.throws(() => doc.import(new Uint8Array([0x7f, 1, 2, 3])));
  assert.throws(() => doc.import(new Uint8Array(0)));
  const truncated = doc.export({ mode: 'snapshot' }).subarray(0, 5);
  const fresh = new EsbtDoc();
  assert.throws(() => fresh.import(truncated));
  assert.equal(fresh.getText(), '');
  assert.equal(doc.getText(), 'untouched');
});

test('version vector: roundtrip, URL-sized, independent of document length', () => {
  const doc = new EsbtDoc({ siteId: 'main-site' });
  doc.setText('x'.repeat(50_000));
  const encoded = doc.oplogVersion().encode();
  assert.ok(encoded.byteLength < 64, `one busy site encodes to ${encoded.byteLength} bytes`);

  const decoded = VersionVector.decode(encoded);
  assert.deepEqual([...decoded.next.entries()], [['main-site', 50_000]]);

  // 100 peers with default-generated site ids stay under the 4 KiB URL budget.
  const many = new Map<string, number>();
  for (let i = 0; i < 100; i++) many.set(new EsbtDoc().siteId, 1_000_000 + i);
  const big = new VersionVector(many).encode();
  assert.ok(big.byteLength < 4_096, `100 peers encode to ${big.byteLength} bytes`);

  assert.throws(() => VersionVector.decode(doc.export({ mode: 'snapshot' })));
});

test('a rehydrated server site resumes its counters — no (site, seq) reuse', () => {
  const first = new EsbtDoc({ siteId: 'stable-server' });
  first.setText('persisted');
  const stored = first.export({ mode: 'snapshot' });

  // Same stable site id, new process.
  const second = new EsbtDoc({ siteId: 'stable-server' });
  second.import(stored);
  second.insert(second.length, ' + after restart');

  // A client that followed the first life keeps following the second.
  const client = new EsbtDoc({ siteId: 'client' });
  client.import(stored);
  client.import(second.export({ mode: 'update', from: client.oplogVersion() }));
  assert.equal(client.getText(), 'persisted + after restart');
});

/* ------------------------------------------------------------ reuse rule */

test('reinsertion at a released weight uses a fresh counter (Scenario 3)', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });

  const updates: Uint8Array[] = [];
  const stop = a.subscribeLocalUpdates((u) => updates.push(u));
  a.insert(0, 'A'); // ins (w, c1)
  a.delete(0, 1); //  del (w, c1)
  a.insert(0, 'B'); // likely reuses w with c2
  stop();

  // Worst-case order: the reuse insert, then the old delete, then the old insert.
  b.import(updates[2]);
  b.import(updates[1]);
  b.import(updates[0]);
  assert.equal(a.getText(), 'B');
  assert.equal(b.getText(), 'B');
});

/* ------------------------------------------------------------- events */

test('events carry origin and fresh text; imports fire with undefined origin', () => {
  const doc = new EsbtDoc();
  const seen: Array<{ origin: string | undefined; text: string }> = [];
  doc.subscribe((event) => seen.push({ origin: event.origin, text: event.text }));

  doc.transact(() => {
    doc.insert(0, 'ab');
    doc.transact(() => doc.delete(0, 1)); // nested joins the outer transact
  }, 'editor');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { origin: 'editor', text: 'b' });

  const other = new EsbtDoc();
  other.setText('remote');
  doc.import(other.export({ mode: 'update' }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].origin, undefined);
  assert.equal(seen[1].text, doc.getText());

  // Re-importing the same payload is a no-op and fires nothing.
  doc.import(other.export({ mode: 'update' }));
  assert.equal(seen.length, 2);
});

test('subscribeLocalUpdates fires once per outermost transact, never for imports', () => {
  const doc = new EsbtDoc();
  const updates: Uint8Array[] = [];
  doc.subscribeLocalUpdates((u) => updates.push(u));

  doc.transact(() => {
    doc.insert(0, 'one ');
    doc.insert(4, 'two');
  }, 'editor');
  assert.equal(updates.length, 1);

  const other = new EsbtDoc();
  other.setText('imported');
  doc.import(other.export({ mode: 'update' }));
  assert.equal(updates.length, 1);

  // The single batched payload applies atomically on a peer.
  const peer = new EsbtDoc();
  peer.import(updates[0]);
  assert.equal(peer.getText(), 'one two');
});

/* --------------------------------------------------------------- undo */

test('undo on A removes A’s text and leaves B’s concurrent text', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const undo = new UndoManager(a);
  const ua = wire(a, b);
  const ub = wire(b, a);

  a.transact(() => a.insert(0, 'from A. '), 'editor');
  b.transact(() => b.insert(b.length, 'from B.'), 'editor');
  assert.equal(a.getText(), b.getText());

  assert.ok(undo.canUndo());
  undo.undo();
  assert.equal(a.getText(), 'from B.');
  assert.equal(b.getText(), 'from B.'); // undo emitted new ops; peers converge

  assert.ok(undo.canRedo());
  undo.redo();
  assert.equal(a.getText(), 'from A. from B.');
  assert.equal(b.getText(), a.getText());

  ua();
  ub();
  undo.destroy();
});

test('undo skips steps a collaborator already deleted', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const undo = new UndoManager(a);
  const ua = wire(a, b);
  const ub = wire(b, a);

  a.transact(() => a.insert(0, 'first '), 'editor');
  a.transact(() => a.insert(6, 'second'), 'editor');
  b.delete(6, 6); // B removes "second" entirely

  // Undoing must not resurrect it, and must fall through to undo "first ".
  undo.undo();
  assert.equal(a.getText(), '');
  assert.equal(b.getText(), '');
  ua();
  ub();
  undo.destroy();
});

test('undoing a deletion of collaborator text does not alias its tombstone', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  a.insert(0, 'X'); // A's first insertion has counter 1.
  b.import(a.export({ mode: 'update' }));

  const undo = new UndoManager(b);
  const toA = wire(b, a);
  const toB = wire(a, b);
  b.delete(0, 1); // B's first exact-weight reuse would also have counter 1.
  assert.equal(a.getText(), '');

  undo.undo();
  assert.equal(b.getText(), 'X');
  assert.equal(a.getText(), 'X');

  toA();
  toB();
  undo.destroy();
});

test('undo grouping: transacts inside mergeIntervalMs form one step', () => {
  const doc = new EsbtDoc();
  const undo = new UndoManager(doc, { mergeIntervalMs: 60_000 });
  for (const ch of 'burst') doc.transact(() => doc.insert(doc.length, ch), 'editor');
  undo.undo();
  assert.equal(doc.getText(), '');
  undo.redo();
  assert.equal(doc.getText(), 'burst');
  undo.destroy();

  const strict = new EsbtDoc();
  const strictUndo = new UndoManager(strict); // contract default: one transact = one step
  for (const ch of 'ab') strict.transact(() => strict.insert(strict.length, ch), 'editor');
  strictUndo.undo();
  assert.equal(strict.getText(), 'a');
  strictUndo.destroy();
});

test('imports never enter the undo stack', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const undo = new UndoManager(a);
  const other = new EsbtDoc({ siteId: 'b' });
  other.setText('remote text');
  a.import(other.export({ mode: 'update' }));
  assert.equal(undo.canUndo(), false);
  undo.undo(); // must be a harmless no-op
  assert.equal(a.getText(), 'remote text');
  undo.destroy();
});

/* ----------------------------------------------------- headless writes */

test('replaceRange with no editor attached still updates getText() and syncs', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const ua = wire(a, b);
  a.setText('- [ ] task');
  a.replaceRange(3, 4, 'x'); // the preview checkbox path
  assert.equal(a.getText(), '- [x] task');
  ua();
  assert.equal(b.getText(), '- [x] task');
});

/* ------------------------------------------------------------- anchors */

test('anchors stay attached through concurrent edits; deleted anchors collapse', () => {
  const doc = new EsbtDoc();
  doc.setText('abcdef');
  const anchor = doc.indexToAnchor(3); // 'd'
  doc.insert(0, '>>> ');
  assert.equal(doc.anchorToIndex(anchor), 7);
  assert.equal(doc.getText()[doc.anchorToIndex(anchor)], 'd');

  doc.delete(7, 1); // delete 'd' itself
  const collapsed = doc.anchorToIndex(anchor);
  assert.equal(doc.getText()[collapsed], 'e');

  const end = doc.indexToAnchor(doc.length);
  doc.insert(doc.length, '!');
  assert.equal(doc.anchorToIndex(end), doc.length);
});

/* ------------------------------------------------------------ presence */

test('EphemeralStore: set/get/keys/getAllStates, apply merges, encodeAll roundtrips', () => {
  const a = new EphemeralStore(30_000);
  const b = new EphemeralStore(30_000);

  const frames: Uint8Array[] = [];
  a.subscribeLocalUpdates((bytes) => frames.push(bytes));

  a.set('site-a-cm-user', { name: 'Swift Otter', colorClassName: 'marks-user3' });
  a.set('site-a-cm-sel', { from: 2, to: 7 });
  assert.equal(frames.length, 2);
  assert.deepEqual(a.keys().sort(), ['site-a-cm-sel', 'site-a-cm-user']);

  let notified = 0;
  b.subscribe(() => (notified += 1));
  for (const frame of frames) b.apply(frame);
  assert.ok(notified > 0);
  assert.deepEqual(b.get('site-a-cm-sel'), { from: 2, to: 7 });

  const c = new EphemeralStore(30_000);
  c.apply(b.encodeAll());
  assert.deepEqual(c.getAllStates(), b.getAllStates());

  // Applying a remote frame must not re-emit it as a local update.
  const before = frames.length;
  a.apply(b.encodeAll());
  assert.equal(frames.length, before);

  // Deletion gossips as a tombstone.
  a.delete('site-a-cm-sel');
  b.apply(frames[frames.length - 1]);
  assert.equal(b.get('site-a-cm-sel'), undefined);

  assert.throws(() => a.apply(new Uint8Array([9, 9, 9])));

  a.destroy();
  b.destroy();
  c.destroy();
});

test('EphemeralStore: entries expire after ttlMs and subscribers hear about it', async () => {
  const store = new EphemeralStore(600);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  store.set('k', 'v');
  assert.equal(store.get('k'), 'v');
  const seen = notified;
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.equal(store.get('k'), undefined);
  assert.deepEqual(store.getAllStates(), {});
  assert.ok(notified > seen, 'expiry must notify so cursors disappear');
  store.destroy();
});

/* ------------------------------------------------------------ LWW map */

test('map: set/get/delete/entries, syncs over updates, rides snapshots', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  const unwire = wire(a, b);

  a.mapSet('meta_1', '{"value":"first"}');
  a.mapSet('meta_2', '{"value":"second"}');
  assert.equal(a.mapGet('meta_1'), '{"value":"first"}');
  assert.deepEqual(
    a.mapEntries(),
    [
      ['meta_1', '{"value":"first"}'],
      ['meta_2', '{"value":"second"}'],
    ],
  );
  assert.deepEqual(b.mapEntries(), a.mapEntries());

  a.mapDelete('meta_1');
  assert.equal(a.mapGet('meta_1'), undefined);
  assert.deepEqual(b.mapEntries(), [['meta_2', '{"value":"second"}']]);
  unwire();

  // Snapshots (both flavours) carry compatibility map state.
  const fresh = new EsbtDoc();
  fresh.import(a.export({ mode: 'snapshot' }));
  assert.deepEqual(fresh.mapEntries(), a.mapEntries());
  const shallow = new EsbtDoc();
  shallow.import(a.export({ mode: 'shallow-snapshot' }));
  assert.deepEqual(shallow.mapEntries(), a.mapEntries());

  // The tombstone must merge: a replica that only saw the set drops the key.
  const late = new EsbtDoc({ siteId: 'late' });
  late.import(a.export({ mode: 'snapshot' }));
  assert.equal(late.mapGet('meta_1'), undefined);
});

test('map: concurrent writes to one key converge on the same winner', () => {
  const a = new EsbtDoc({ siteId: 'aaa' });
  const b = new EsbtDoc({ siteId: 'bbb' });
  const fromA: Uint8Array[] = [];
  const fromB: Uint8Array[] = [];
  a.subscribeLocalUpdates((u) => fromA.push(u));
  b.subscribeLocalUpdates((u) => fromB.push(u));

  a.mapSet('k', 'from-a');
  b.mapSet('k', 'from-b');
  for (const u of fromB) a.import(u);
  for (const u of fromA) b.import(u);

  assert.equal(a.mapGet('k'), b.mapGet('k'));

  // A later write beats both, in either delivery order.
  const fromA2: Uint8Array[] = [];
  a.subscribeLocalUpdates((u) => fromA2.push(u));
  a.mapSet('k', 'settled');
  for (const u of fromA2) b.import(u);
  assert.equal(a.mapGet('k'), 'settled');
  assert.equal(b.mapGet('k'), 'settled');
});

test('map: writes fire subscribe, ride local updates, and offline deltas include them', () => {
  const a = new EsbtDoc({ siteId: 'a' });
  const b = new EsbtDoc({ siteId: 'b' });
  b.import(a.export({ mode: 'update' }));

  const events: string[] = [];
  b.subscribe((event) => events.push(event.origin ?? 'remote'));

  a.transact(() => a.mapSet('meta', 'v1'), 'metadata');
  b.import(a.export({ mode: 'update', from: b.oplogVersion() }));
  assert.equal(events.length, 1);
  assert.equal(b.mapGet('meta'), 'v1');

  // Idempotent: replaying everything from birth changes nothing, silently.
  b.import(a.export({ mode: 'update' }));
  assert.equal(events.length, 1);
});

test('map writes never enter the undo stack', () => {
  const doc = new EsbtDoc();
  const undo = new UndoManager(doc, { excludeOriginPrefixes: ['metadata'] });

  doc.transact(() => doc.insert(0, 'text'), 'editor');
  doc.transact(() => doc.mapSet('meta_1', 'retained'), 'metadata');

  undo.undo();
  assert.equal(doc.getText(), '');
  assert.equal(doc.mapGet('meta_1'), 'retained');

  // Even in a mixed batch, undo skips map ops.
  doc.transact(() => {
    doc.insert(0, 'more');
    doc.mapSet('meta_2', 'inline');
  }, 'editor');
  undo.undo();
  assert.equal(doc.getText(), '');
  assert.equal(doc.mapGet('meta_2'), 'inline');
  undo.destroy();
});

/* ----------------------------------------------------- degenerate gaps */

test('inserting between concurrent same-gap twins never drops or misplaces beyond the pair', () => {
  // A and B insert into the same empty gap concurrently: with a flat first
  // path digit these would be weight twins with no admissible weight between
  // them. Every replica must still accept an insert aimed at that gap.
  const a = new EsbtDoc({ siteId: 'aaaa' });
  const b = new EsbtDoc({ siteId: 'bbbb' });
  const fromA: Uint8Array[] = [];
  const fromB: Uint8Array[] = [];
  a.subscribeLocalUpdates((u) => fromA.push(u));
  b.subscribeLocalUpdates((u) => fromB.push(u));
  a.insert(0, 'x');
  b.insert(0, 'y');
  for (const u of fromB) a.import(u);
  for (const u of fromA) b.import(u);
  assert.equal(a.getText(), b.getText());
  assert.equal(a.length, 2);

  // Type between the two concurrent units, from both sites.
  a.insert(1, 'M');
  assert.equal(a.length, 3, 'insert into the contested gap must not be dropped');
  b.insert(1, 'N');
  const more: Uint8Array[] = [];
  const stop = a.subscribeLocalUpdates((u) => more.push(u));
  stop();
  for (const u of fromB.slice(1)) a.import(u);
  for (const u of fromA.slice(1)) b.import(u);
  assert.equal(a.getText(), b.getText());
  assert.equal(a.length, 4);
});

test('deep same-site midpoint typing never drops units', () => {
  const doc = new EsbtDoc();
  for (let i = 0; i < 5_000; i++) doc.insert(Math.floor(i / 2), 'x');
  assert.equal(doc.length, 5_000);

  // And the result replays identically on a peer.
  const peer = new EsbtDoc();
  peer.import(doc.export({ mode: 'update' }));
  assert.equal(peer.getText(), doc.getText());
});

/* ---------------------------------------------------------- performance */

test('getText() is cheap enough to call on every change', () => {
  const doc = new EsbtDoc();
  const start = performance.now();
  for (let i = 0; i < 5_000; i++) {
    doc.insert(Math.floor(i / 2), 'x');
    doc.getText();
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5_000, `5k mid-document edits with reads took ${elapsed.toFixed(0)}ms`);
  assert.equal(doc.length, 5_000);
});
