/** ESBT-owned position identity logic for lossy, non-persistent presence. */
import {
  decodeSelectionPresence,
  type SelectionDirection,
  type SelectionPresenceV2,
} from './protocol.ts';
import type { CaretAffinity, EsbtDocument } from './wasm/esbt-document.ts';

export interface RemoteSelection {
  from: number;
  to: number;
  name: string;
  colorClassName: string;
  direction: SelectionDirection;
}

export type PresenceDocument = Pick<
  EsbtDocument,
  'length' | 'capturePresencePosition' | 'resolvePresencePosition'
>;

export function captureSelectionPresence(
  document: PresenceDocument,
  anchor: number,
  head: number,
  sequence: number,
): SelectionPresenceV2 {
  const direction: SelectionDirection = anchor <= head ? 'forward' : 'backward';
  // In ESBT, `before` follows text inserted at the exact boundary while
  // `after` stays ahead of it. Carets follow typing; range affinities point
  // inward so concurrent boundary text is excluded from the selection.
  const anchorAffinity: CaretAffinity = anchor === head || direction === 'forward'
    ? 'before'
    : 'after';
  const headAffinity: CaretAffinity = anchor === head || direction === 'backward'
    ? 'before'
    : 'after';
  const pair = document.capturePresencePosition(anchor, head, anchorAffinity, headAffinity);
  return { version: 2, ...pair, direction, sequence };
}

export function remoteSelections(
  states: Record<string, unknown>,
  selfSiteId: string,
  document: PresenceDocument | null,
  lastSequences = new Map<string, number>(),
): RemoteSelection[] {
  const out: RemoteSelection[] = [];
  for (const [key, value] of Object.entries(states)) {
    if (!key.endsWith('-cm-sel') || !value || typeof value !== 'object') continue;
    const site = key.slice(0, -'-cm-sel'.length);
    if (site === selfSiteId) continue;
    const selection = decodeSelectionPresence(value);
    if (!selection || !document) continue;

    let anchor: number;
    let head: number;
    if (selection.version === 2) {
      const previous = lastSequences.get(site) ?? -1;
      if (selection.sequence < previous) continue;
      lastSequences.set(site, selection.sequence);
      try {
        ({ anchor, head } = document.resolvePresencePosition(selection));
      } catch {
        // A durable operation naming this identity may not have arrived yet.
        // Hide it and retry after the next store/document notification.
        continue;
      }
      if (anchor > document.length || head > document.length) continue;
    } else {
      // Temporary bounded v1 rolling-upgrade behavior. Only identity-less v1
      // offsets are clamped; v2 never guesses an unrelated document offset.
      anchor = Math.min(selection.anchorOffset, document.length);
      head = Math.min(selection.headOffset, document.length);
    }
    const user = states[`${site}-cm-user`] as
      | { name?: unknown; colorClassName?: unknown }
      | undefined;
    out.push({
      from: Math.min(anchor, head),
      to: Math.max(anchor, head),
      name: typeof user?.name === 'string' ? user.name : 'Anonymous',
      colorClassName: typeof user?.colorClassName === 'string'
        ? user.colorClassName
        : 'marks-user1',
      direction: selection.direction,
    });
  }
  return out;
}
