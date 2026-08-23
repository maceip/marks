import assert from 'node:assert/strict';
import test from 'node:test';
import { PresenceActivityController } from './presence-activity-controller.ts';

class Target {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

class Clock {
  now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  tick(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.timers.entries()].find(([, timer]) => timer.at <= this.now);
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function fixture() {
  const clock = new Clock();
  const windowTarget = new Target();
  const documentTarget = new Target();
  const publications: string[] = [];
  const controller = new PresenceActivityController({
    idleMs: 1_000,
    windowTarget,
    documentTarget,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publishActive: () => publications.push('active'),
    publishInactive: () => publications.push('inactive'),
  });
  return { clock, windowTarget, documentTarget, publications, controller };
}

test('active becomes idle once, heartbeat does not count as activity, and input resumes', () => {
  const f = fixture();
  f.controller.start();
  assert.deepEqual(f.publications, ['active']);
  f.clock.tick(500);
  f.controller.heartbeat();
  assert.deepEqual(f.publications, ['active', 'active']);
  f.clock.tick(500);
  assert.equal(f.controller.state, 'idle');
  assert.deepEqual(f.publications, ['active', 'active', 'inactive']);
  f.clock.tick(5_000);
  assert.equal(f.publications.filter((item) => item === 'inactive').length, 1);

  f.windowTarget.emit('pointerdown');
  assert.equal(f.controller.state, 'active');
  assert.equal(f.publications.at(-1), 'active');
});

test('hidden deletes once and waits for subsequent activity after becoming visible', () => {
  const f = fixture();
  f.controller.start();
  f.documentTarget.visibilityState = 'hidden';
  f.documentTarget.emit('visibilitychange');
  assert.equal(f.controller.state, 'hidden');
  assert.deepEqual(f.publications, ['active', 'inactive']);
  f.documentTarget.emit('visibilitychange');
  assert.deepEqual(f.publications, ['active', 'inactive']);

  f.documentTarget.visibilityState = 'visible';
  f.documentTarget.emit('visibilitychange');
  assert.equal(f.controller.state, 'hidden');
  f.documentTarget.emit('selectionchange');
  assert.equal(f.controller.state, 'active');
});

test('CodeMirror activity resumes and pagehide disconnects with one deletion', () => {
  const f = fixture();
  f.controller.start();
  f.clock.tick(1_000);
  f.controller.recordActivity();
  assert.equal(f.controller.state, 'active');
  f.controller.pagehide();
  f.controller.pagehide();
  assert.equal(f.controller.state, 'disconnected');
  assert.equal(f.publications.filter((item) => item === 'inactive').length, 2);
  f.windowTarget.emit('keydown');
  assert.equal(f.controller.state, 'disconnected');
});
