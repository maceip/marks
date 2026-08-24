import assert from "node:assert/strict";
import test from "node:test";
import { PresenceStore } from "./presence-store.ts";

test("presence roundtrips, deletes, and never re-emits remote state", () => {
  const first = new PresenceStore(30_000);
  const second = new PresenceStore(30_000);
  const frames: Uint8Array[] = [];
  first.subscribeLocalUpdates((bytes) => frames.push(bytes));

  first.set("site-a-cm-user", {
    name: "Swift Otter",
    colorClassName: "marks-user3",
  });
  first.set("site-a-cm-sel", { from: 2, to: 7 });
  assert.equal(frames.length, 2);
  for (const frame of frames) second.apply(frame);
  assert.deepEqual(second.get("site-a-cm-sel"), { from: 2, to: 7 });

  const emitted = frames.length;
  first.apply(second.encodeAll());
  assert.equal(frames.length, emitted);

  first.delete("site-a-cm-sel");
  second.apply(frames.at(-1)!);
  assert.equal(second.get("site-a-cm-sel"), undefined);

  first.destroy();
  second.destroy();
});

test("presence decoding is atomic and rejects trailing or non-canonical input", () => {
  const source = new PresenceStore(30_000);
  const target = new PresenceStore(30_000);

  source.set("peer-cm-user", { name: "Peer" });

  const valid = source.encodeAll();

  const trailing = new Uint8Array(valid.byteLength + 1);
  trailing.set(valid);
  assert.throws(() => target.apply(trailing), /trailing/);
  assert.deepEqual(target.getAllStates(), {});


  assert.throws(
    () => target.apply(new Uint8Array([5, 2, 0x80, 0x00])),
    /truncated/,
  );

  assert.deepEqual(target.getAllStates(), {});

  source.destroy();
  target.destroy();
});

test("presence validates values before changing local state", () => {
  const store = new PresenceStore(30_000);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => store.set("bad", cyclic));
  assert.deepEqual(store.getAllStates(), {});
  assert.throws(() => store.set("huge", "x".repeat(17 * 1024)), /16 KiB/);

  assert.deepEqual(store.getAllStates(), {});
  store.destroy();
});


test("presence expiry removes stale peers and notifies subscribers", async () => {

  const store = new PresenceStore(20);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.set("peer", "online");
  const afterSet = notifications;
  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal(store.get("peer"), undefined);

  assert.ok(notifications > afterSet);
  store.destroy();
});

test("presence ignores reordered and duplicate publications", () => {
  const source = new PresenceStore(30_000);
  const target = new PresenceStore(30_000);
  const frames: Uint8Array[] = [];
  source.subscribeLocalUpdates((frame) => frames.push(frame));
  source.set("7-cm-user", { name: "first" });
  source.set("7-cm-user", { name: "second" });
  target.apply(frames[1]);
  target.apply(frames[1]);
  target.apply(frames[0]);
  assert.deepEqual(target.get("7-cm-user"), { name: "second" });
  source.destroy();
  target.destroy();
});

test("a deletion prevents a stale update from reviving an instance", () => {
  const source = new PresenceStore(30_000);
  const target = new PresenceStore(30_000);
  const frames: Uint8Array[] = [];
  source.subscribeLocalUpdates((frame) => frames.push(frame));
  source.set("9-cm-user", "online");
  source.delete("9-cm-user");
  target.apply(frames[1]);
  target.apply(frames[0]);
  assert.equal(target.get("9-cm-user"), undefined);
  source.destroy();
  target.destroy();
});

test("a retired instance can be replaced after reconnect with a reused site id", () => {
  const source = new PresenceStore(30_000);
  const target = new PresenceStore(30_000);
  const frames: Uint8Array[] = [];
  source.subscribeLocalUpdates((frame) => frames.push(frame));
  source.set("11-cm-user", "old");
  target.apply(frames.at(-1)!);
  source.delete("11-cm-user");
  target.apply(frames.at(-1)!);
  source.beginConnectionLifecycle();
  source.set("11-cm-user", "new");
  target.apply(frames.at(-1)!);
  assert.equal(target.get("11-cm-user"), "new");
  source.destroy();
  target.destroy();
});

test("presence sequence overflow fails closed and requires reconnect", () => {
  const store = new PresenceStore(30_000);
  store.set("12-cm-user", "online");
  (store as unknown as { sequence: number }).sequence =
    Number.MAX_SAFE_INTEGER - 1;
  assert.throws(() => store.encodeAll(), /sequence exhausted/);
  store.beginConnectionLifecycle();
  assert.ok(store.encodeAll().byteLength > 0);
  store.destroy();
});

test("local wall-clock changes do not affect ordering or receiver TTL", () => {
  let monotonic = 10;
  const source = new PresenceStore(100, () => monotonic);
  const target = new PresenceStore(100, () => monotonic);
  source.set("13-cm-user", "online");
  const frame = source.encodeAll();
  const originalDateNow = Date.now;
  Date.now = () => -9_000_000_000;
  try {
    target.apply(frame);
    monotonic = 90;
    assert.equal(target.get("13-cm-user"), "online");
    monotonic = 111;
    assert.equal(target.get("13-cm-user"), undefined);
  } finally {
    Date.now = originalDateNow;
    source.destroy();
    target.destroy();
  }
});
