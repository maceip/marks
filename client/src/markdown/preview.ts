import DOMPurify, { type Config } from 'dompurify';
import MarkdownWorker from '../workers/markdown.worker?worker';
import { renderDiagrams } from './mermaid';
import type { BlockPatch, Heading, RenderRequest, RenderResponse, RenderStats } from './types';

export interface PreviewStats extends RenderStats {
  /** Time from the edit landing to the preview being painted. */
  latencyMs: number;
  /** Time spent mutating the DOM. */
  patchMs: number;
  /** DOM nodes inserted or moved this pass. */
  touched: number;
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  ADD_ATTR: ['target', 'rel', 'align', 'colspan', 'rowspan', 'checked', 'disabled', 'hidden'],
} satisfies Config;

function sanitize(html: string): string {
  return String(DOMPurify.sanitize(html, SANITIZE_CONFIG));
}

/**
 * Drives the markdown worker and patches its output into the DOM.
 *
 * Only blocks whose key changed are touched: unchanged blocks keep their exact
 * DOM nodes, so their layout, their rendered diagrams and any text selection
 * inside them survive an edit elsewhere in the document.
 */
export class PreviewRenderer {
  private readonly worker = new MarkdownWorker();
  private nodes = new Map<string, HTMLElement>();

  private seq = 0;
  private inFlight: { seq: number; submittedAt: number } | null = null;
  private queued: { text: string; submittedAt: number } | null = null;
  private destroyed = false;

  private statsListener: ((stats: PreviewStats) => void) | null = null;
  private headingsListener: ((headings: Heading[]) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    this.worker.onmessage = (event: MessageEvent<RenderResponse>) => this.onRendered(event.data);
  }

  onStats(listener: (stats: PreviewStats) => void): void {
    this.statsListener = listener;
  }

  onHeadings(listener: (headings: Heading[]) => void): void {
    this.headingsListener = listener;
  }

  /**
   * Queue text for rendering. Calls made while a render is in flight collapse
   * into a single follow-up pass, so a burst of keystrokes never queues a
   * backlog of stale renders.
   */
  update(text: string): void {
    if (this.destroyed) return;
    this.queued = { text, submittedAt: performance.now() };
    this.pump();
  }

  /** Drop all caches and re-render from scratch (theme changes, doc switches). */
  invalidate(text: string): void {
    this.post({ type: 'reset' });
    this.nodes.clear();
    this.container.replaceChildren();
    this.update(text);
  }

  private pump(): void {
    if (this.inFlight || !this.queued) return;
    const { text, submittedAt } = this.queued;
    this.queued = null;
    this.seq += 1;
    this.inFlight = { seq: this.seq, submittedAt };
    this.post({ type: 'render', seq: this.seq, text });
  }

  private post(message: RenderRequest): void {
    this.worker.postMessage(message);
  }

  private onRendered(response: RenderResponse): void {
    if (this.destroyed) return;
    const request = this.inFlight;
    this.inFlight = null;

    // A stale response can only happen if the worker got out of step; ignore it.
    if (!request || response.seq !== request.seq) {
      this.pump();
      return;
    }

    const patchStart = performance.now();
    const touched = this.patch(response.blocks);
    const patchMs = performance.now() - patchStart;

    this.headingsListener?.(response.headings);

    // Measure to the frame that actually shows the change, not just to the
    // end of our DOM writes.
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.statsListener?.({
        ...response.stats,
        patchMs,
        touched,
        latencyMs: performance.now() - request.submittedAt,
      });
    });

    void renderDiagrams(this.container);
    this.pump();
  }

  /** Keyed reconciliation: unchanged runs of blocks cost zero DOM operations. */
  private patch(blocks: BlockPatch[]): number {
    const next = new Map<string, HTMLElement>();
    let touched = 0;

    // Retire stale nodes *before* walking the list. Leaving them in place
    // would sit between the nodes we want to keep, and every subsequent block
    // would be re-inserted to step over them — turning a one-block edit into
    // one DOM move per block in the document.
    const keys = new Set(blocks.map((block) => block.key));
    for (const [key, node] of this.nodes) {
      if (!keys.has(key)) {
        node.remove();
        this.nodes.delete(key);
        touched += 1;
      }
    }

    let cursor = this.container.firstElementChild as HTMLElement | null;

    for (const block of blocks) {
      let node = this.nodes.get(block.key);

      if (!node) {
        node = document.createElement('div');
        node.className = 'marks-block';
        node.dataset.key = block.key;
        node.innerHTML = sanitize(block.html ?? '');
        touched += 1;
      } else if (block.html !== undefined) {
        node.innerHTML = sanitize(block.html);
        touched += 1;
      }

      node.dataset.line = String(block.line);

      if (cursor === node) {
        cursor = cursor.nextElementSibling as HTMLElement | null;
      } else {
        this.container.insertBefore(node, cursor);
        touched += 1;
      }

      next.set(block.key, node);
    }

    this.nodes = next;
    return touched;
  }

  destroy(): void {
    this.destroyed = true;
    this.worker.terminate();
    this.nodes.clear();
    this.statsListener = null;
    this.headingsListener = null;
  }
}
