import { PRESENCE_IDLE_MS } from '../lib/product.ts';

export type PresenceActivityState = 'active' | 'idle' | 'hidden' | 'disconnected';

interface ActivityEventTarget {
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void;
}

export interface PresenceActivityOptions {
  publishActive: () => void;
  publishInactive: () => void;
  idleMs?: number;
  windowTarget?: ActivityEventTarget;
  documentTarget?: ActivityEventTarget & { visibilityState?: DocumentVisibilityState };
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

/**
 * Owns the user's transient visibility independently from transport state.
 * Only direct input enters the active state; network and timer work can merely
 * refresh an already-active record through `heartbeat`.
 */
export class PresenceActivityController {
  private current: PresenceActivityState = 'disconnected';
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly idleMs: number;
  private readonly windowTarget?: ActivityEventTarget;
  private readonly documentTarget?: PresenceActivityOptions['documentTarget'];
  private readonly schedule: NonNullable<PresenceActivityOptions['setTimeout']>;
  private readonly cancel: NonNullable<PresenceActivityOptions['clearTimeout']>;
  private readonly options: PresenceActivityOptions;

  constructor(options: PresenceActivityOptions) {
    this.options = options;
    this.idleMs = options.idleMs ?? PRESENCE_IDLE_MS;
    if (!Number.isFinite(this.idleMs) || this.idleMs < 1) {
      throw new RangeError('marks: presence idle threshold must be positive');
    }
    this.windowTarget = options.windowTarget;
    this.documentTarget = options.documentTarget;
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout;
  }

  get state(): PresenceActivityState {
    return this.current;
  }

  get active(): boolean {
    return this.current === 'active';
  }

  start(): void {
    if (this.current !== 'disconnected') return;
    this.windowTarget?.addEventListener('pointerdown', this.handleActivity, true);
    this.windowTarget?.addEventListener('keydown', this.handleActivity, true);
    // Scroll does not bubble, so capture observes editor and preview scrolling.
    this.documentTarget?.addEventListener('scroll', this.handleActivity, true);
    this.documentTarget?.addEventListener('selectionchange', this.handleActivity);
    this.documentTarget?.addEventListener('visibilitychange', this.handleVisibility);
    this.current = 'idle';
    if (this.documentTarget?.visibilityState === 'hidden') this.transitionInactive('hidden');
    else this.recordActivity();
  }

  /** Called by CodeMirror focus/transaction hooks and other explicit UI input. */
  recordActivity = (): void => {
    if (this.current === 'disconnected' || this.documentTarget?.visibilityState === 'hidden') return;
    this.current = 'active';
    this.options.publishActive();
    this.armIdleTimer();
  };

  /** Refresh identity only when user activity currently permits visibility. */
  heartbeat(): void {
    if (this.active) this.options.publishActive();
  }

  pagehide(): void {
    this.disconnect();
  }

  disconnect(): void {
    if (this.current === 'disconnected') return;
    this.clearIdleTimer();
    this.options.publishInactive();
    this.current = 'disconnected';
    this.windowTarget?.removeEventListener('pointerdown', this.handleActivity, true);
    this.windowTarget?.removeEventListener('keydown', this.handleActivity, true);
    this.documentTarget?.removeEventListener('scroll', this.handleActivity, true);
    this.documentTarget?.removeEventListener('selectionchange', this.handleActivity);
    this.documentTarget?.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private handleActivity = (): void => this.recordActivity();

  private handleVisibility = (): void => {
    if (this.documentTarget?.visibilityState === 'hidden') this.transitionInactive('hidden');
    // Becoming visible alone is passive. The first subsequent action resumes.
  };

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.current === 'active') this.transitionInactive('idle');
    }, this.idleMs);
  }

  private clearIdleTimer(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private transitionInactive(state: 'idle' | 'hidden'): void {
    this.clearIdleTimer();
    if (this.current === 'active') this.options.publishInactive();
    this.current = state;
  }
}
