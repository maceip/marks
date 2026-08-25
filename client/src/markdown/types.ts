import type { TextEdit } from '../text/change';

/** A top-level markdown block: the unit of caching, diffing and repainting. */
export interface BlockPatch {
  /** Content hash plus an occurrence counter, stable across edits elsewhere. */
  key: string;
  /** Source line the block starts on, used for scroll sync. */
  line: number;
  /** UTF-16 bounds in the Markdown source (end exclusive). */
  sourceStart: number;
  sourceEnd: number;
  /** Offset where rendered plain text starts, or absent when exact mapping is ambiguous. */
  exactTextStart?: number;
  /** Only present when the main thread does not already have this block. */
  html?: string;
}

export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface RenderStats {
  /** Blocks in the document. */
  blocks: number;
  /** Blocks that had to be re-rendered this pass. */
  dirty: number;
  parseMs: number;
  /** `incremental` when only dirty source blocks were tokenized. */
  parseMode?: 'full' | 'incremental';
  renderMs: number;
  /** Bytes of HTML shipped to the main thread. */
  bytes: number;
  chars: number;
  words: number;
}

export type RenderRequest =
  | { type: 'render'; seq: number; text: string }
  | {
      type: 'patch';
      seq: number;
      edits: TextEdit[];
      /** Worker generation that produced the base DOM now held by the client. */
      generation: string;
      /** Cheap guard against applying valid coordinates to the wrong source. */
      baseChars: number;
      chars: number;
    }
  | { type: 'reset' };

export interface RenderedResponse {
  type: 'rendered';
  seq: number;
  generation: string;
  blocks: BlockPatch[];
  headings: Heading[];
  stats: RenderStats;
}

/** The worker restarted or otherwise no longer owns the patch's base text. */
export interface RenderResyncResponse {
  type: 'resync';
  seq: number;
  generation: string;
  actualChars: number;
  reason: 'generation' | 'base-length' | 'result-length' | 'invalid-edit';
}

export type RenderResponse = RenderedResponse | RenderResyncResponse;
