import type { EditorView } from '@codemirror/view';

interface BlockOffset {
  line: number;
  top: number;
  bottom: number;
}

/**
 * Two-way scroll sync between the source pane and the preview.
 *
 * Both panes are indexed by source line — preview blocks carry `data-line`
 * from markdown-it's token maps — so the mapping stays honest even when one
 * source line renders to a tall block (a table, a diagram) and its neighbour
 * renders to a single line.
 */
export class ScrollSync {
  private editor: EditorView | null = null;
  private preview: HTMLElement | null = null;
  private applying = false;
  private follow: 'off' | 'both' | 'preview' = 'off';

  private index: BlockOffset[] = [];
  private indexedChildren = -1;
  private indexedHeight = -1;

  setEditor(view: EditorView | null): void {
    this.editor = view;
  }

  setPreview(element: HTMLElement | null): void {
    this.preview = element;
    this.indexedChildren = -1;
  }

  setEnabled(enabled: boolean): void {
    this.follow = enabled ? 'both' : 'off';
  }

  /**
   * `both` is desktop/fold split. `preview` lets the phone ghost follow the
   * caret without letting the overlay scroll the editor.
   */
  setFollow(follow: 'off' | 'both' | 'preview'): void {
    this.follow = follow;
  }

  /** Preview follows the editor. */
  fromEditor(): void {
    const { editor, preview } = this;
    if (this.follow === 'off' || this.applying || !editor || !preview) return;

    this.guard(() => {
      const line = this.topVisibleEditorLine(editor);
      const target = this.previewOffsetForLine(line);
      if (target !== null) preview.scrollTop = target;
    });
  }

  /** Preview follows a source line (0-based), used by the phone ghost caret. */
  followPreviewToLine(line: number): void {
    const { preview } = this;
    if (this.follow === 'off' || this.applying || !preview) return;
    this.guard(() => {
      const target = this.previewOffsetForLine(line);
      if (target !== null) preview.scrollTop = target;
    });
  }

  /** Editor follows the preview. */
  fromPreview(): void {
    const { editor, preview } = this;
    if (this.follow !== 'both' || this.applying || !editor || !preview) return;

    this.guard(() => {
      const line = this.topVisiblePreviewLine(preview);
      if (line === null) return;

      const doc = editor.state.doc;
      const clamped = Math.min(Math.max(line + 1, 1), doc.lines);
      const block = editor.lineBlockAt(doc.line(clamped).from);
      editor.scrollDOM.scrollTop = block.top;
    });
  }

  /** Scroll both panes to a source line, used by the outline. */
  scrollToLine(line: number): void {
    const { editor, preview } = this;
    this.guard(() => {
      if (editor) {
        const doc = editor.state.doc;
        const clamped = Math.min(Math.max(line + 1, 1), doc.lines);
        editor.scrollDOM.scrollTop = editor.lineBlockAt(doc.line(clamped).from).top;
      }
      if (preview) {
        const target = this.previewOffsetForLine(line);
        if (target !== null) preview.scrollTop = target;
      }
    });
  }

  /**
   * Run a scroll mutation without letting the other pane's scroll handler
   * bounce it straight back.
   */
  private guard(mutate: () => void): void {
    this.applying = true;
    mutate();
    requestAnimationFrame(() => {
      this.applying = false;
    });
  }

  private topVisibleEditorLine(view: EditorView): number {
    const top = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(top);
    const fraction = block.height > 0 ? (top - block.top) / block.height : 0;
    const startLine = view.state.doc.lineAt(block.from).number - 1;
    const endLine = view.state.doc.lineAt(block.to).number - 1;
    return startLine + (endLine - startLine) * Math.min(Math.max(fraction, 0), 1);
  }

  /**
   * Index every rendered block by source line.
   *
   * The blocks are descendants of the scroll container, not its children — the
   * pane holds a single content element — so they are queried rather than
   * walked. Offsets are measured against the container's own scroll origin,
   * which keeps them correct regardless of what sits between the two.
   */
  private buildIndex(preview: HTMLElement): BlockOffset[] {
    const blocks = preview.querySelectorAll<HTMLElement>('.marks-block[data-line]');
    if (blocks.length === this.indexedChildren && preview.scrollHeight === this.indexedHeight) {
      return this.index;
    }

    // One batched read pass: every rect is measured before anything is written.
    const origin = preview.getBoundingClientRect().top - preview.scrollTop;
    const offsets: BlockOffset[] = [];

    for (const block of blocks) {
      const line = Number(block.dataset.line ?? NaN);
      if (Number.isNaN(line)) continue;
      const rect = block.getBoundingClientRect();
      const top = rect.top - origin;
      offsets.push({ line, top, bottom: top + rect.height });
    }

    this.index = offsets;
    this.indexedChildren = blocks.length;
    this.indexedHeight = preview.scrollHeight;
    return offsets;
  }

  /** Interpolate a scroll offset for a (possibly fractional) source line. */
  private previewOffsetForLine(line: number): number | null {
    const preview = this.preview;
    if (!preview) return null;

    const blocks = this.buildIndex(preview);
    if (blocks.length === 0) return null;
    if (line <= blocks[0].line) return 0;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const next = blocks[i + 1];
      if (!next) return block.top;
      if (line >= next.line) continue;

      const span = Math.max(next.line - block.line, 1);
      const fraction = Math.min(Math.max((line - block.line) / span, 0), 1);
      return block.top + (next.top - block.top) * fraction;
    }

    return null;
  }

  private topVisiblePreviewLine(preview: HTMLElement): number | null {
    const blocks = this.buildIndex(preview);
    if (blocks.length === 0) return null;

    const top = preview.scrollTop;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.bottom <= top) continue;

      const next = blocks[i + 1];
      const height = Math.max(block.bottom - block.top, 1);
      const fraction = Math.min(Math.max((top - block.top) / height, 0), 1);
      const span = next ? Math.max(next.line - block.line, 1) : 1;
      return block.line + span * fraction;
    }

    return blocks[blocks.length - 1].line;
  }
}
