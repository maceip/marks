import { history, historyKeymap } from '@codemirror/commands';
import { Annotation, type Extension } from '@codemirror/state';
import { keymap, ViewPlugin, type EditorView } from '@codemirror/view';
import type { CollabSession, EngineStats, LocalUser, Peer } from '../collab/types';
import { readLocalDocumentText, writeLocalDocumentText } from './workspace';

const fromSession = Annotation.define<boolean>();
const SAVE_DELAY_MS = 220;

/**
 * A deliberately small, service-free editor session for the UI prototype.
 * It owns no network behavior and can be replaced by the collaboration engine
 * without changing anything above CollabSession.
 */
export class LocalSession implements CollabSession {
  readonly engine = 'esbt' as const;
  readonly docId: string;
  readonly extension: Extension;

  private text: string;
  private readonly peer: Peer;
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly views = new Set<EditorView>();
  private saveTimer: number | null = null;
  private destroyed = false;

  constructor(docId: string, user: LocalUser) {
    this.docId = docId;
    this.text = readLocalDocumentText(docId);
    this.peer = {
      id: `local-${user.name}`,
      name: user.name,
      colorIndex: user.colorIndex,
      self: true,
    };
    this.extension = [history(), keymap.of(historyKeymap), this.syncExtension()];
  }

  private reconcile(view: EditorView): void {
    const current = view.state.doc.toString();
    if (current === this.text) return;

    let from = 0;
    const shortest = Math.min(current.length, this.text.length);
    while (from < shortest && current[from] === this.text[from]) from += 1;

    let currentEnd = current.length;
    let targetEnd = this.text.length;
    while (
      currentEnd > from &&
      targetEnd > from &&
      current[currentEnd - 1] === this.text[targetEnd - 1]
    ) {
      currentEnd -= 1;
      targetEnd -= 1;
    }

    view.dispatch({
      changes: { from, to: currentEnd, insert: this.text.slice(from, targetEnd) },
      annotations: fromSession.of(true),
    });
  }

  private syncExtension(): Extension {
    return ViewPlugin.define((view) => {
      let disposed = false;
      this.views.add(view);
      queueMicrotask(() => {
        if (!disposed) this.reconcile(view);
      });

      return {
        update: (update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((transaction) => transaction.annotation(fromSession))) return;
          this.text = update.state.doc.toString();
          this.emitText(view);
        },
        destroy: () => {
          disposed = true;
          this.views.delete(view);
        },
      };
    });
  }

  private emitText(origin?: EditorView): void {
    for (const view of this.views) {
      if (view !== origin) this.reconcile(view);
    }
    for (const listener of this.textListeners) listener(this.text);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      writeLocalDocumentText(this.docId, this.text);
    }, SAVE_DELAY_MS);
  }

  getText(): string {
    return this.text;
  }

  setText(markdown: string): void {
    if (markdown === this.text) return;
    this.text = markdown;
    this.emitText();
  }

  replaceRange(from: number, to: number, insert: string): void {
    this.setText(`${this.text.slice(0, from)}${insert}${this.text.slice(to)}`);
  }

  status() {
    return 'connected' as const;
  }

  peers(): Peer[] {
    return [this.peer];
  }

  stats(): EngineStats {
    return {
      snapshotBytes: new TextEncoder().encode(this.text).byteLength,
      received: 0,
      sent: 0,
    };
  }

  onTextChange(listener: (text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => this.textListeners.delete(listener);
  }

  onStatusChange(): () => void {
    return () => undefined;
  }

  onPeersChange(): () => void {
    return () => undefined;
  }

  hydrated(): boolean {
    return true;
  }

  onHydrated(listener: () => void): () => void {
    queueMicrotask(listener);
    return () => undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    writeLocalDocumentText(this.docId, this.text);
    this.textListeners.clear();
    this.views.clear();
  }
}

export function createLocalSession(docId: string, user: LocalUser): CollabSession {
  return new LocalSession(docId, user);
}
