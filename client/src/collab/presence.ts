/**
 * Remote carets and selections, drawn from Marks' transient presence store.
 *
 * The store is the transport (`${siteId}-cm-user` for identity,
 * `${siteId}-cm-sel` for the selection, exactly the keys the integration
 * contract names). This extension publishes the local side and renders the
 * remote side as CodeMirror decorations.
 *
 * Presence entries expire after 30 s, so everything here is re-published on a
 * 15 s heartbeat — the y-protocols cadence the contract recommends — rather
 * than only when the caret moves.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import type { PresenceStoreApi } from './presence-store';
import {
  encodeSelectionPresence,
  type SelectionDirection,
} from './protocol';
import {
  captureSelectionPresence,
  remoteSelections,
  type PresenceDocument,
} from './presence-position';
import type { EsbtDocument } from './wasm/esbt-document';

export const HEARTBEAT_MS = 15_000;

const setPresenceDecorations = StateEffect.define<DecorationSet>();

const presenceField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setPresenceDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CaretWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly colorClassName: string,
    private readonly direction: SelectionDirection,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.colorClassName === this.colorClassName
      && other.direction === this.direction;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = `esbt-caret ${this.colorClassName}`;
    caret.dataset.name = this.name;
    caret.dataset.direction = this.direction;
    caret.setAttribute('role', 'mark');
    caret.setAttribute('aria-label', `${this.name}'s caret, ${this.direction} selection`);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(
  states: Record<string, unknown>,
  selfSiteId: string,
  document: PresenceDocument | null,
  lastSequences: Map<string, number>,
): DecorationSet {
  const ranges = [];
  for (const peer of remoteSelections(states, selfSiteId, document, lastSequences)) {
    if (peer.to > peer.from) {
      ranges.push(
        Decoration.mark({ class: `esbt-selection ${peer.colorClassName}` }).range(
          peer.from,
          peer.to,
        ),
      );
    }
    ranges.push(
      Decoration.widget({
        widget: new CaretWidget(peer.name, peer.colorClassName, peer.direction),
        side: peer.direction === 'forward' ? -1 : 1,
      }).range(peer.direction === 'forward' ? peer.to : peer.from),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * Publishes this editor's selection into the ephemeral store and renders
 * every other site's cursor. Identity (`-cm-user`) is published by the
 * engine, which outlives the editor view — the presence bar must show
 * people even in preview-only mode, where no editor is mounted.
 */
export function esbtPresence(
  getSiteId: () => string,
  getDocument: () => EsbtDocument | null,
  presence: PresenceStoreApi,
): Extension {
  const selectionKeyFor = () => `${getSiteId()}-cm-sel`;

  const plugin = ViewPlugin.define((view) => {
    let destroyed = false;
    let scheduled = false;

    // Epoch-based start prevents a reloaded sender from looking older than
    // its final pre-reload heartbeat while remaining a safe JSON integer.
    let sequence = Date.now() * 1_000;
    const lastSequences = new Map<string, number>();


    const publishSelection = (): void => {
      if (publishTimer !== null) clearTimeout(publishTimer);
      if (publishFrame !== null) cancelAnimationFrame(publishFrame);
      publishTimer = null;
      publishFrame = null;
      const main = view.state.selection.main;

      const document = getDocument();
      if (!document) return;
      sequence += 1;
      presence.set(
        selectionKeyFor(),
        encodeSelectionPresence(captureSelectionPresence(document, main.anchor, main.head, sequence)),
      );

    };

    const refresh = (): void => {
      if (destroyed) return;
      const decorations = buildDecorations(
        presence.getAllStates(),
        getSiteId(),
        getDocument(),
        lastSequences,
      );
      view.dispatch({ effects: setPresenceDecorations.of(decorations) });
    };

    // Store notifications can fire synchronously inside an editor update
    // (publishing the selection notifies subscribers); CodeMirror forbids
    // dispatching from there, so redraws are coalesced onto a microtask.
    const scheduleRefresh = (): void => {
      if (scheduled || destroyed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        refresh();
      });
    };

    const unsubscribe = presence.subscribe(scheduleRefresh);
    const unsubscribeReplica = getDocument()?.onReplicaChange(scheduleRefresh) ?? (() => {});
    const heartbeat = window.setInterval(publishSelection, HEARTBEAT_MS);

    publishSelection();
    scheduleRefresh();

    return {
      update(update) {
        if (update.selectionSet || update.docChanged || update.focusChanged) {
          scheduleSelection(dragging);
        }
      },
      destroy() {
        destroyed = true;
        clearInterval(heartbeat);
        if (publishTimer !== null) clearTimeout(publishTimer);
        if (publishFrame !== null) cancelAnimationFrame(publishFrame);
        view.dom.removeEventListener('pointerdown', pointerDown);
        view.dom.ownerDocument.removeEventListener('pointerup', pointerUp);
        unsubscribe();
        unsubscribeReplica();
        presence.delete(selectionKeyFor());
      },
    };
  });

  return [presenceField, plugin];
}
