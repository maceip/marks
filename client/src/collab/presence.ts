/** Remote CodeMirror selections and their transient presentation state. */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { PresenceStoreApi } from './presence-store';
import type { PresenceActivityController } from './presence-activity-controller';

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
export const LABEL_VISIBLE_MS = 1_800;
export const PRESENCE_REVEAL_EVENT = 'marks-presence-reveal';

const setPresenceDecorations = StateEffect.define<DecorationSet>();
const presenceField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setPresenceDecorations)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface CaretPresentation {
  position: number;
  visibleUntil: number;
  lastMovedAt: number;
}

export function labelGeometry(
  caretLeft: number,
  caretTop: number,
  labelWidth: number,
  bounds: { left: number; right: number; top: number },
): { placement: 'above' | 'below'; shiftX: number } {
  return {
    placement: caretTop - bounds.top < 28 ? 'below' : 'above',
    shiftX: Math.min(0, bounds.right - caretLeft - labelWidth - 2),
  };
}

/** Pure transition used by the view plugin and its timer regression tests. */
export function updateCaretPresentation(
  previous: CaretPresentation | undefined,
  position: number,
  now: number,
): CaretPresentation {
  const moved = previous === undefined || previous.position !== position;
  // A one-character stream is typing. It gets one sliding deadline rather than
  // one timer per update; a larger jump or line/section change follows the same path.
  const resumed = moved && (!previous || now - previous.lastMovedAt > LABEL_VISIBLE_MS);
  return {
    position,
    lastMovedAt: moved ? now : (previous?.lastMovedAt ?? now),
    visibleUntil: moved || resumed ? now + LABEL_VISIBLE_MS : (previous?.visibleUntil ?? 0),
  };
}

class CaretWidget extends WidgetType {
  readonly site: string;
  readonly name: string;
  readonly colorClassName: string;
  readonly active: boolean;
  readonly stack: number;

  constructor(

    private readonly name: string,
    private readonly colorClassName: string,
    private readonly direction: SelectionDirection,

  ) {
    super();
    this.site = site;
    this.name = name;
    this.colorClassName = colorClassName;
    this.active = active;
    this.stack = stack;
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
  override ignoreEvent(): boolean { return true; }
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
  activity: PresenceActivityController,
): Extension {

  const selectionKeyFor = () => `${getSiteId()}-cm-sel`;
  const plugin = ViewPlugin.define((view) => {
    let destroyed = false, scheduled = false, expiryTimer: number | null = null, frame: number | null = null;
    const states = new Map<string, CaretPresentation>();
    const followed = new Set<string>();


    // Epoch-based start prevents a reloaded sender from looking older than
    // its final pre-reload heartbeat while remaining a safe JSON integer.
    let sequence = Date.now() * 1_000;
    const lastSequences = new Map<string, number>();


    const publishSelection = (): void => {
      if (!activity.active || !view.hasFocus) return;

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
    const refresh = () => {
      if (destroyed) return;

      const decorations = buildDecorations(
        presence.getAllStates(),
        getSiteId(),
        getDocument(),
        lastSequences,
      );
      view.dispatch({ effects: setPresenceDecorations.of(decorations) });

    };
    const schedule = () => { if (scheduled || destroyed) return; scheduled = true; queueMicrotask(() => { scheduled = false; refresh(); }); };
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ siteId?: string; follow?: boolean }>).detail;
      if (!detail?.siteId || !states.has(detail.siteId)) return;
      if (detail.follow) followed.add(detail.siteId);
      else states.get(detail.siteId)!.visibleUntil = Date.now() + LABEL_VISIBLE_MS;
      schedule();
    };


    const unsubscribe = presence.subscribe(scheduleRefresh);
    const unsubscribeReplica = getDocument()?.onReplicaChange(scheduleRefresh) ?? (() => {});
    const heartbeat = window.setInterval(publishSelection, HEARTBEAT_MS);

    if (view.hasFocus) {
      activity.recordActivity();
      publishSelection();
    }
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
    document.addEventListener(PRESENCE_REVEAL_EVENT, reveal);
    view.dom.addEventListener('pointerover', hover);
    const unsubscribe = presence.subscribe(schedule); const heartbeat = window.setInterval(publish, HEARTBEAT_MS);
    publish(); schedule();
    return { update(update) { if (update.selectionSet || update.docChanged || update.focusChanged) publish(); }, destroy() {
      destroyed = true; clearInterval(heartbeat); if (expiryTimer !== null) clearTimeout(expiryTimer);
      if (frame !== null) cancelAnimationFrame(frame); document.removeEventListener(PRESENCE_REVEAL_EVENT, reveal);
      view.dom.removeEventListener('pointerover', hover); unsubscribe(); presence.delete(selectionKeyFor());
    } };
  });
  return [presenceField, plugin];
}
