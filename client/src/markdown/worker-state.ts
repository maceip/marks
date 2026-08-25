import { applyTextEdits } from '../text/change.ts';
import type { RenderRequest, RenderResyncResponse } from './types.ts';

type PatchRequest = Extract<RenderRequest, { type: 'patch' }>;

export type PatchTransition =
  | { type: 'applied'; text: string }
  | RenderResyncResponse;

/**
 * Apply a delta only when it names this exact worker state.
 *
 * WebKit can re-evaluate a module-worker entry when a lazy rendering chunk
 * circularly imports that entry. The Worker object and message port survive,
 * but module state starts over. A generation check turns that reset into an
 * explicit full-render handshake instead of interpreting valid CRDT offsets
 * against an empty string.
 */
export function transitionPatch(
  text: string,
  generation: string,
  request: PatchRequest,
): PatchTransition {
  const resync = (
    reason: RenderResyncResponse['reason'],
  ): RenderResyncResponse => ({
    type: 'resync',
    seq: request.seq,
    generation,
    actualChars: text.length,
    reason,
  });

  if (request.generation !== generation) return resync('generation');
  if (request.baseChars !== text.length) return resync('base-length');

  let next: string;
  try {
    next = applyTextEdits(text, request.edits);
  } catch {
    return resync('invalid-edit');
  }
  if (next.length !== request.chars) return resync('result-length');
  return { type: 'applied', text: next };
}
