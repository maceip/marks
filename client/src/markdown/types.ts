/** A top-level markdown block: the unit of caching, diffing and repainting. */
export interface BlockPatch {
  /** Content hash plus an occurrence counter, stable across edits elsewhere. */
  key: string;
  /** Source line the block starts on, used for scroll sync. */
  line: number;
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
}

export type RenderRequest =
  | { type: 'render'; seq: number; text: string }
  | { type: 'reset' };

export interface RenderResponse {
  type: 'rendered';
  seq: number;
  blocks: BlockPatch[];
  headings: Heading[];
  stats: RenderStats;
}
