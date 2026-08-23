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
import type { PresenceActivityController } from './presence-activity-controller';

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
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.colorClassName === this.colorClassName;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = `esbt-caret ${this.colorClassName}`;
    caret.dataset.name = this.name;
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

interface RemoteSelection {
  from: number;
  to: number;
  name: string;
  colorClassName: string;
}

function remoteSelections(
  states: Record<string, unknown>,
  selfSiteId: string,
  docLength: number,
): RemoteSelection[] {
  const out: RemoteSelection[] = [];
  for (const [key, value] of Object.entries(states)) {
    if (!key.endsWith('-cm-sel') || !value || typeof value !== 'object') continue;
    const site = key.slice(0, -'-cm-sel'.length);
    if (site === selfSiteId) continue;

    const sel = value as { from?: unknown; to?: unknown };
    if (typeof sel.from !== 'number' || typeof sel.to !== 'number') continue;

    const user = states[`${site}-cm-user`] as
      | { name?: unknown; colorClassName?: unknown }
      | undefined;

    // The remote replica can be a step ahead of this editor; clamp rather
    // than let a stale index throw inside the decoration layer.
    const from = Math.max(0, Math.min(Math.min(sel.from, sel.to), docLength));
    const to = Math.max(0, Math.min(Math.max(sel.from, sel.to), docLength));

    out.push({
      from,
      to,
      name: typeof user?.name === 'string' ? user.name : 'Anonymous',
      colorClassName:
        typeof user?.colorClassName === 'string' ? user.colorClassName : 'marks-user1',
    });
  }
  return out;
}

function buildDecorations(
  states: Record<string, unknown>,
  selfSiteId: string,
  docLength: number,
): DecorationSet {
  const ranges = [];
  for (const peer of remoteSelections(states, selfSiteId, docLength)) {
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
        widget: new CaretWidget(peer.name, peer.colorClassName),
        side: -1,
      }).range(peer.to),
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
  getLength: () => number,
  presence: PresenceStoreApi,
  activity: PresenceActivityController,
): Extension {
  const selectionKeyFor = () => `${getSiteId()}-cm-sel`;

  const plugin = ViewPlugin.define((view) => {
    let destroyed = false;
    let scheduled = false;

    const publishSelection = (): void => {
      if (!activity.active || !view.hasFocus) return;
      const main = view.state.selection.main;
      presence.set(selectionKeyFor(), { from: main.from, to: main.to });
    };

    const refresh = (): void => {
      if (destroyed) return;
      const decorations = buildDecorations(
        presence.getAllStates(),
        getSiteId(),
        getLength() || view.state.doc.length,
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
    const heartbeat = window.setInterval(publishSelection, HEARTBEAT_MS);

    if (view.hasFocus) {
      activity.recordActivity();
      publishSelection();
    }
    scheduleRefresh();

    return {
      update(update) {
        if (update.selectionSet || update.docChanged || update.focusChanged) {
          // CodeMirror updates are meaningful only when locally focused;
          // remote reconciliation must not wake an idle user.
          if (view.hasFocus) activity.recordActivity();
          publishSelection();
        }
      },
      destroy() {
        destroyed = true;
        clearInterval(heartbeat);
        unsubscribe();
        presence.delete(selectionKeyFor());
      },
    };
  });

  return [presenceField, plugin];
}
