/** Remote CodeMirror selections and their transient presentation state. */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { PresenceStoreApi } from './presence-store';

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
    site: string, name: string, colorClassName: string, active: boolean, stack: number,
  ) {
    super();
    this.site = site;
    this.name = name;
    this.colorClassName = colorClassName;
    this.active = active;
    this.stack = stack;
  }

  override eq(other: CaretWidget): boolean {
    return other.site === this.site && other.name === this.name &&
      other.colorClassName === this.colorClassName && other.active === this.active &&
      other.stack === this.stack;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = `esbt-caret ${this.colorClassName}`;
    caret.dataset.name = this.name;
    caret.dataset.site = this.site;
    caret.dataset.presentation = this.active ? 'active' : 'settled';
    caret.style.setProperty('--caret-stack', String(this.stack));
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }
  override ignoreEvent(): boolean { return true; }
}

interface RemoteSelection { site: string; from: number; to: number; name: string; colorClassName: string }

function remoteSelections(states: Record<string, unknown>, self: string, length: number): RemoteSelection[] {
  const out: RemoteSelection[] = [];
  for (const [key, value] of Object.entries(states)) {
    if (!key.endsWith('-cm-sel') || !value || typeof value !== 'object') continue;
    const site = key.slice(0, -'-cm-sel'.length);
    if (site === self) continue;
    const sel = value as { from?: unknown; to?: unknown };
    if (typeof sel.from !== 'number' || typeof sel.to !== 'number') continue;
    const user = states[`${site}-cm-user`] as { name?: unknown; colorClassName?: unknown } | undefined;
    out.push({ site, from: Math.max(0, Math.min(sel.from, sel.to, length)),
      to: Math.max(0, Math.min(Math.max(sel.from, sel.to), length)),
      name: typeof user?.name === 'string' ? user.name : 'Anonymous',
      colorClassName: typeof user?.colorClassName === 'string' ? user.colorClassName : 'marks-user1' });
  }
  return out;
}

function decorations(peers: RemoteSelection[], presentations: Map<string, CaretPresentation>, followed: Set<string>, now: number) {
  const ranges = []; const positions = new Map<number, number>();
  for (const peer of peers) {
    if (peer.to > peer.from) ranges.push(Decoration.mark({ class: `esbt-selection ${peer.colorClassName}` }).range(peer.from, peer.to));
    const stack = positions.get(peer.to) ?? 0; positions.set(peer.to, stack + 1);
    ranges.push(Decoration.widget({ widget: new CaretWidget(peer.site, peer.name, peer.colorClassName,
      followed.has(peer.site) || (presentations.get(peer.site)?.visibleUntil ?? 0) > now, stack), side: -1 }).range(peer.to));
  }
  return Decoration.set(ranges, true);
}

/** Reveal a peer from an avatar or follow-mode control without putting names in editor text. */
export function revealPresence(siteId: string, follow = false): void {
  document.dispatchEvent(new CustomEvent(PRESENCE_REVEAL_EVENT, { detail: { siteId, follow } }));
}

export function esbtPresence(getSiteId: () => string, getLength: () => number, presence: PresenceStoreApi): Extension {
  const selectionKeyFor = () => `${getSiteId()}-cm-sel`;
  const plugin = ViewPlugin.define((view) => {
    let destroyed = false, scheduled = false, expiryTimer: number | null = null, frame: number | null = null;
    const states = new Map<string, CaretPresentation>();
    const followed = new Set<string>();

    const publish = () => { const main = view.state.selection.main; presence.set(selectionKeyFor(), { from: main.from, to: main.to }); };
    const positionLabels = () => {
      frame = null;
      const bounds = view.dom.getBoundingClientRect();
      for (const el of view.dom.querySelectorAll<HTMLElement>('.esbt-caret')) {
        const rect = el.getBoundingClientRect();
        const labelWidth = Math.max(40, (el.dataset.name?.length ?? 0) * 7 + 10);
        const geometry = labelGeometry(rect.left, rect.top, labelWidth, bounds);
        el.dataset.placement = geometry.placement;
        el.style.setProperty('--label-shift-x', `${geometry.shiftX}px`);
      }
    };
    const refresh = () => {
      if (destroyed) return;
      const now = Date.now(); const peers = remoteSelections(presence.getAllStates(), getSiteId(), getLength() || view.state.doc.length);
      const live = new Set(peers.map((peer) => peer.site));
      for (const peer of peers) states.set(peer.site, updateCaretPresentation(states.get(peer.site), peer.to, now));
      for (const site of states.keys()) if (!live.has(site)) states.delete(site);
      view.dispatch({ effects: setPresenceDecorations.of(decorations(peers, states, followed, now)) });
      if (frame === null) frame = requestAnimationFrame(positionLabels);
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      let next = Infinity;
      for (const [site, state] of states) if (!followed.has(site) && state.visibleUntil > now) next = Math.min(next, state.visibleUntil);
      expiryTimer = next < Infinity ? window.setTimeout(refresh, Math.max(0, next - now + 1)) : null;
    };
    const schedule = () => { if (scheduled || destroyed) return; scheduled = true; queueMicrotask(() => { scheduled = false; refresh(); }); };
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ siteId?: string; follow?: boolean }>).detail;
      if (!detail?.siteId || !states.has(detail.siteId)) return;
      if (detail.follow) followed.add(detail.siteId);
      else states.get(detail.siteId)!.visibleUntil = Date.now() + LABEL_VISIBLE_MS;
      schedule();
    };
    const hover = (event: Event) => {
      const caret = (event.target as Element | null)?.closest?.('.esbt-caret') as HTMLElement | null;
      if (caret?.dataset.site) revealPresence(caret.dataset.site);
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
