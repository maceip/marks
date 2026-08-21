import { useEffect, useRef } from 'react';
import type { CollabSession } from '../collab/types';
import { PreviewRenderer, type PreviewStats } from '../markdown/preview';
import type { Heading } from '../markdown/types';

interface PreviewPaneProps {
  session: CollabSession;
  onContainer: (element: HTMLElement | null) => void;
  onStats: (stats: PreviewStats) => void;
  onHeadings: (headings: Heading[]) => void;
  onScroll: () => void;
}

const TASK_LINE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/;

export function PreviewPane({
  session,
  onContainer,
  onStats,
  onHeadings,
  onScroll,
}: PreviewPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);

  const handlers = useRef({ onStats, onHeadings, onScroll });
  handlers.current = { onStats, onHeadings, onScroll };

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const renderer = new PreviewRenderer(content);
    rendererRef.current = renderer;
    renderer.onStats((stats) => handlers.current.onStats(stats));
    renderer.onHeadings((headings) => handlers.current.onHeadings(headings));

    renderer.invalidate(session.getText());
    const off = session.onTextChange((text) => renderer.update(text));

    return () => {
      off();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    onContainer(scrollRef.current);
    return () => onContainer(null);
  }, [onContainer]);

  // Diagrams are rendered with the theme that was active at the time, so a
  // theme switch has to re-render the preview. Watching the attribute keeps
  // this self-contained instead of threading the theme through the memoised
  // editor subtree.
  useEffect(() => {
    const root = document.documentElement;
    let current = root.dataset.theme;

    const observer = new MutationObserver(() => {
      if (root.dataset.theme === current) return;
      current = root.dataset.theme;
      rendererRef.current?.invalidate(session.getText());
    });

    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [session]);

  /**
   * Clicking a rendered checkbox edits the source line behind it, so task
   * lists work the way they do everywhere else instead of being read-only.
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    const anchor = target.closest('a');
    if (anchor && anchor.getAttribute('href')?.startsWith('#')) {
      event.preventDefault();
      const id = decodeURIComponent(anchor.getAttribute('href')!.slice(1));
      const heading = contentRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
    event.preventDefault();

    const block = target.closest('.marks-block') as HTMLElement | null;
    if (!block) return;

    // Find which checkbox inside this block was clicked, then the matching
    // task line inside the block's source range. Working from the CRDT text
    // rather than the editor keeps this working in preview-only mode.
    const ordinal = Array.from(block.querySelectorAll('input[type="checkbox"]')).indexOf(target);
    const startLine = Number(block.dataset.line ?? 0);
    const nextBlock = block.nextElementSibling as HTMLElement | null;
    const nextLine = nextBlock ? Number(nextBlock.dataset.line ?? NaN) : NaN;

    const lines = session.getText().split('\n');
    const endLine = Number.isNaN(nextLine) ? lines.length : Math.min(nextLine, lines.length);

    let offset = 0;
    for (let index = 0; index < startLine && index < lines.length; index++) {
      offset += lines[index].length + 1;
    }

    let seen = -1;
    for (let index = startLine; index < endLine; index++) {
      const match = TASK_LINE.exec(lines[index]);
      if (match) {
        seen += 1;
        if (seen === ordinal) {
          const at = offset + match[1].length + 1;
          session.replaceRange(at, at + 1, match[2] === ' ' ? 'x' : ' ');
          return;
        }
      }
      offset += lines[index].length + 1;
    }
  };

  return (
    <section
      className="pane preview-pane"
      aria-label="Preview"
      ref={scrollRef}
      onScroll={() => handlers.current.onScroll()}
    >
      <div className="marks-preview" ref={contentRef} onClick={handleClick} />
    </section>
  );
}
