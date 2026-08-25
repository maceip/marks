import DOMPurify, { type Config } from 'dompurify';
import MarkdownWorker from '../workers/markdown.worker?worker';
import { applyTextEdits, type TextEdit } from '../text/change';
import { hydrateLocalAssetImages, revokeLocalAssetImages } from '../data/assets';
import { watchDiagrams } from './mermaid';
import { hydrateCrossDocumentBlocks } from './cross-document.ts';
import type { BlockPatch, Heading, RenderRequest, RenderResponse, RenderStats } from './types';
import { WorkerSupervisor, type WorkerFailure } from './worker-supervisor';

/** First paint inserts this many blocks before yielding to the browser. */
const FIRST_PAINT_BLOCKS = 48;
const IDLE_PAINT_BLOCKS = 40;
const RENDER_DEADLINE_MS = 20_000;
let mathStyles: Promise<unknown> | null = null;

function loadMathStylesWhenNeeded(blocks: BlockPatch[]): void {
  if (mathStyles || !blocks.some((block) => block.html?.includes('class="katex'))) return;
  mathStyles = import('../styles/katex.css').catch(() => undefined);
}

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
  ADD_ATTR: ['target', 'rel', 'align', 'colspan', 'rowspan', 'checked', 'disabled', 'hidden', 'data-align', 'data-shape', 'data-fill', 'data-marks-local-asset', 'data-marks-document-block', 'data-marks-heading'],
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
  private readonly worker: WorkerSupervisor<RenderRequest, RenderResponse>;
  private nodes = new Map<string, HTMLElement>();

  private seq = 0;
  private inFlight: { seq: number; submittedAt: number } | null = null;
  private queuedFull: { text: string; submittedAt: number } | null = null;
  private queuedEdits: {
    edits: TextEdit[];
    submittedAt: number;
    baseChars: number;
    chars: number;
  } | null = null;
  private sourceText = '';
  private workerGeneration = '';
  private workerTerminal = false;
  private destroyed = false;
  private idleHandle = 0;
  private readonly unwatchDiagrams: () => void;

  private statsListener: ((stats: PreviewStats) => void) | null = null;
  private headingsListener: ((headings: Heading[]) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    this.worker = new WorkerSupervisor<RenderRequest, RenderResponse>(
      () => new MarkdownWorker({ name: 'marks-preview' }),
      {
        deadlineMs: RENDER_DEADLINE_MS,
        onMessage: (response) => this.onRendered(response),
        onRecover: (failure) => this.onWorkerRecovery(failure),
        onTerminal: (failure) => this.onWorkerTerminal(failure),
      },
    );
    this.unwatchDiagrams = watchDiagrams(container);
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
  update(edits: readonly TextEdit[]): void {
    if (this.destroyed || this.workerTerminal || edits.length === 0) return;
    const baseChars = this.sourceText.length;
    this.sourceText = applyTextEdits(this.sourceText, edits);
    if (!this.queuedEdits) {
      this.queuedEdits = {
        edits: [],
        submittedAt: performance.now(),
        baseChars,
        chars: this.sourceText.length,
      };
    }
    this.queuedEdits.edits.push(...edits.map((edit) => ({ ...edit })));
    this.queuedEdits.chars = this.sourceText.length;
    this.pump();
  }

  /** Drop all caches and re-render from scratch (theme changes, doc switches). */
  invalidate(text: string): void {
    if (this.destroyed || this.workerTerminal) return;
    this.cancelIdle();
    this.sourceText = text;
    this.workerGeneration = '';
    this.post({ type: 'reset' }, false);
    this.nodes.clear();
    this.container.replaceChildren();
    // `text` already includes every edit queued before this reset.
    this.queuedEdits = null;
    this.queuedFull = { text, submittedAt: performance.now() };
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || this.destroyed || this.workerTerminal) return;
    if (this.queuedEdits && !this.workerGeneration) {
      // A worker restart or full invalidation has no delta base. Every queued
      // edit is already represented in sourceText, so replace it with one
      // authoritative full render.
      this.queuedEdits = null;
      this.queuedFull = { text: this.sourceText, submittedAt: performance.now() };
    }
    const queued = this.queuedFull ?? this.queuedEdits;
    if (!queued) return;
    this.seq += 1;
    const seq = this.seq;
    this.inFlight = { seq, submittedAt: queued.submittedAt };
    let sent = false;
    if (this.queuedFull) {
      const { text } = this.queuedFull;
      this.queuedFull = null;
      sent = this.post({ type: 'render', seq, text }, true);
    } else if (this.queuedEdits) {
      const { edits, baseChars, chars } = this.queuedEdits;
      this.queuedEdits = null;
      sent = this.post({
        type: 'patch',
        seq,
        edits,
        generation: this.workerGeneration,
        baseChars,
        chars,
      }, true);
    }
    if (!sent && this.inFlight?.seq === seq) this.inFlight = null;
  }

  private post(message: RenderRequest, expectResponse: boolean): boolean {
    return this.worker.post(message, expectResponse);
  }

  private onRendered(response: RenderResponse): void {
    if (this.destroyed || this.workerTerminal) return;
    const request = this.inFlight;
    this.inFlight = null;

    // A stale response can only happen if the worker got out of step; ignore it.
    if (!request || response.seq !== request.seq) {
      this.pump();
      return;
    }

    if (response.type === 'resync') {
      this.workerGeneration = response.generation;
      this.queuedEdits = null;
      this.queuedFull = { text: this.sourceText, submittedAt: request.submittedAt };
      // Reset parsing and DOM-presence caches before sending the authoritative
      // source. The existing DOM stays visible until its replacement arrives.
      this.post({ type: 'reset' }, false);
      this.pump();
      return;
    }

    this.workerGeneration = response.generation;

    const patchStart = performance.now();
    loadMathStylesWhenNeeded(response.blocks);
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

    this.pump();
  }

  private onWorkerRecovery(failure: WorkerFailure): void {
    if (this.destroyed || this.workerTerminal) return;
    console.error('[marks] markdown worker failed; restarting', failure.error);
    this.inFlight = null;
    this.workerGeneration = '';
    this.queuedEdits = null;
    this.queuedFull = { text: this.sourceText, submittedAt: performance.now() };
    queueMicrotask(() => {
      if (this.destroyed || this.workerTerminal) return;
      this.post({ type: 'reset' }, false);
      this.pump();
    });
  }

  private onWorkerTerminal(failure: WorkerFailure): void {
    if (this.destroyed || this.workerTerminal) return;
    this.workerTerminal = true;
    this.inFlight = null;
    this.queuedEdits = null;
    this.queuedFull = null;
    this.cancelIdle();
    console.error('[marks] markdown worker stopped after recovery failed', failure.error);
    revokeLocalAssetImages(this.container);
    this.nodes.clear();
    const node = document.createElement('div');
    node.className = 'marks-block';
    node.dataset.key = 'worker-terminal-error';
    node.dataset.line = '0';
    node.dataset.sourceStart = '0';
    node.dataset.sourceEnd = String(this.sourceText.length);
    node.innerHTML = sanitize(
      '<div class="marks-callout marks-callout-danger"><p>Preview stopped responding. Reload this page to try again.</p></div>',
    );
    this.nodes.set('worker-terminal-error', node);
    this.container.replaceChildren(node);
    this.headingsListener?.([]);
  }

  /** Keyed reconciliation: unchanged runs of blocks cost zero DOM operations. */
  private patch(blocks: BlockPatch[]): number {
    this.cancelIdle();
    if (this.nodes.size === 0 && blocks.length > FIRST_PAINT_BLOCKS) {
      const first = this.patchRange(blocks, 0, FIRST_PAINT_BLOCKS, false);
      this.scheduleRemainder(blocks, FIRST_PAINT_BLOCKS);
      return first;
    }
    return this.patchRange(blocks, 0, blocks.length, true);
  }

  private scheduleRemainder(blocks: BlockPatch[], start: number): void {
    let offset = start;
    const step = () => {
      if (this.destroyed) return;
      const end = Math.min(offset + IDLE_PAINT_BLOCKS, blocks.length);
      this.patchRange(blocks, offset, end, end === blocks.length);
      offset = end;
      if (offset < blocks.length) this.idleHandle = requestIdleOrFrame(step);
    };
    this.idleHandle = requestIdleOrFrame(step);
  }

  private cancelIdle(): void {
    if (!this.idleHandle) return;
    cancelIdleOrFrame(this.idleHandle);
    this.idleHandle = 0;
  }

  private patchRange(blocks: BlockPatch[], start: number, end: number, retire: boolean): number {
    const slice = blocks.slice(start, end);
    let touched = 0;

    // Retire stale nodes *before* walking the list. Leaving them in place
    // would sit between the nodes we want to keep, and every subsequent block
    // would be re-inserted to step over them — turning a one-block edit into
    // one DOM move per block in the document.
    if (retire) {
      const keys = new Set(blocks.map((block) => block.key));
      for (const [key, node] of this.nodes) {
        if (!keys.has(key)) {
          revokeLocalAssetImages(node);
          node.remove();
          this.nodes.delete(key);
          touched += 1;
        }
      }
    }

    const before = start === 0 ? this.container.firstElementChild : this.nodes.get(blocks[start - 1]?.key ?? '')?.nextElementSibling;
    let cursor = (before ?? this.container.firstElementChild) as HTMLElement | null;

    const next = start === 0 ? new Map<string, HTMLElement>() : this.nodes;

    for (const block of slice) {
      let node = this.nodes.get(block.key);

      if (!node) {
        node = document.createElement('div');
        node.className = 'marks-block';
        node.dataset.key = block.key;
        node.innerHTML = sanitize(block.html ?? '');
        void hydrateLocalAssetImages(node);
        void hydrateCrossDocumentBlocks(node);
        touched += 1;
      } else if (block.html !== undefined) {
        revokeLocalAssetImages(node);
        node.innerHTML = sanitize(block.html);
        void hydrateLocalAssetImages(node);
        void hydrateCrossDocumentBlocks(node);
        touched += 1;
      }

      node.dataset.line = String(block.line);
      node.dataset.sourceStart = String(block.sourceStart);
      node.dataset.sourceEnd = String(block.sourceEnd);
      if (block.exactTextStart === undefined) delete node.dataset.exactTextStart;
      else node.dataset.exactTextStart = String(block.exactTextStart);

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
    this.cancelIdle();
    this.unwatchDiagrams();
    revokeLocalAssetImages(this.container);
    this.worker.destroy();
    this.nodes.clear();
    this.statsListener = null;
    this.headingsListener = null;
  }
}

function requestIdleOrFrame(callback: () => void): number {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(() => callback(), { timeout: 80 });
  }
  return requestAnimationFrame(() => callback());
}

function cancelIdleOrFrame(handle: number): void {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
  else cancelAnimationFrame(handle);
}
