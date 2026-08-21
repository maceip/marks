import { hasBroadcastChannel } from './platform.ts';

/**
 * Same-document, cross-tab replica sync.
 *
 * Two tabs on the same document are two CRDT replicas. Without a local
 * channel they only meet at the server, so an offline pair of tabs will
 * last-write-wins their IndexedDB snapshots and drop edits. This channel
 * fans local updates between tabs on the same origin. Different documents
 * use different channel names and never see each other.
 */

export type TabMessage =
  | { type: 'hello'; tabId: string; clock: number }
  | { type: 'update'; tabId: string; bytes: ArrayBuffer }
  | { type: 'snapshot'; tabId: string; bytes: ArrayBuffer }
  | { type: 'request-snapshot'; tabId: string };

export interface TabChannelHandlers {
  onHello: (tabId: string) => void;
  onUpdate: (bytes: Uint8Array, tabId: string) => void;
  onSnapshot: (bytes: Uint8Array, tabId: string) => void;
  onRequestSnapshot: (tabId: string) => void;
}

export function tabChannelName(engine: string, docId: string): string {
  return `marks:tab:${engine}:${docId}`;
}

export function createTabId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class TabChannel {
  readonly tabId = createTabId();
  readonly name: string;
  private channel: BroadcastChannel | null = null;
  private destroyed = false;
  private readonly handlers: TabChannelHandlers;

  constructor(name: string, handlers: TabChannelHandlers) {
    this.name = name;
    this.handlers = handlers;
    if (!hasBroadcastChannel()) return;
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (event: MessageEvent<TabMessage>) => this.onMessage(event.data);
  }

  get enabled(): boolean {
    return this.channel !== null;
  }

  hello(): void {
    this.post({ type: 'hello', tabId: this.tabId, clock: Date.now() });
  }

  requestSnapshot(): void {
    this.post({ type: 'request-snapshot', tabId: this.tabId });
  }

  sendUpdate(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.post({ type: 'update', tabId: this.tabId, bytes: copyBuffer(bytes) });
  }

  sendSnapshot(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.post({ type: 'snapshot', tabId: this.tabId, bytes: copyBuffer(bytes) });
  }

  destroy(): void {
    this.destroyed = true;
    this.channel?.close();
    this.channel = null;
  }

  private post(message: TabMessage): void {
    if (this.destroyed || !this.channel) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // A closed channel or a detached buffer is not worth surfacing.
    }
  }

  private onMessage(message: TabMessage | null): void {
    if (!message || this.destroyed || message.tabId === this.tabId) return;

    switch (message.type) {
      case 'hello':
        this.handlers.onHello(message.tabId);
        break;
      case 'request-snapshot':
        this.handlers.onRequestSnapshot(message.tabId);
        break;
      case 'update':
        this.handlers.onUpdate(new Uint8Array(message.bytes), message.tabId);
        break;
      case 'snapshot':
        this.handlers.onSnapshot(new Uint8Array(message.bytes), message.tabId);
        break;
      default:
        break;
    }
  }
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
