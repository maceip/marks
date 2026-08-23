import { useEffect, useRef, useState } from 'react';
import type { CollabSession } from '../../collab/types';
import { getPresenceDisplay, PRESENCE_DISPLAY_EVENT, type DocumentPresenceDisplay } from '../../collab/presence-display';
import { PreviewRenderer, type PreviewStats } from '../../markdown/preview';
import type { Heading } from '../../markdown/types';

interface PreviewPaneProps {
  session: CollabSession;
  onContainer: (element: HTMLElement | null) => void;
  onStats: (stats: PreviewStats) => void;
  onHeadings: (headings: Heading[]) => void;
  onScroll: () => void;
  renderedOnly?: boolean;
}

const TASK_LINE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/;

export function PreviewPane({
  session,
  onContainer,
  onStats,
  onHeadings,
  onScroll,
  renderedOnly = false,
}: PreviewPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const [display, setDisplay] = useState<DocumentPresenceDisplay>(() => getPresenceDisplay(renderedOnly));
  const [overlay, setOverlay] = useState<Array<{ id: string; name: string; color: number; exact: boolean; top: number; left: number; height: number }>>([]);

  const handlers = useRef({ onStats, onHeadings, onScroll });
  handlers.current = { onStats, onHeadings, onScroll };

  useEffect(() => {
    const update = (event: Event) => setDisplay((event as CustomEvent<DocumentPresenceDisplay>).detail ?? getPresenceDisplay(renderedOnly));
    window.addEventListener(PRESENCE_DISPLAY_EVENT, update);
    return () => window.removeEventListener(PRESENCE_DISPLAY_EVENT, update);
  }, [renderedOnly]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || display === 'off') { setOverlay([]); return; }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const origin = content.getBoundingClientRect();
        const entries: typeof overlay = [];
        for (const peer of session.peers()) {
          if (peer.self || !peer.presence?.location) continue;
          const location = peer.presence.location;
          let block = content.querySelector<HTMLElement>(`.marks-block[data-source-start="${location.blockStart}"]`);
          if (!block && location.headingLine !== undefined) block = content.querySelector<HTMLElement>(`.marks-block[data-line="${location.headingLine}"]`);
          if (!block) continue; // deleted or not painted/off-screen incremental block
          let rect = block.getBoundingClientRect();
          let exact = false;
          if (display === 'exact' && peer.presence.selection && block.dataset.exactTextStart) {
            const mapped = textCaretRect(block, peer.presence.selection.to - Number(block.dataset.exactTextStart));
            if (mapped) { rect = mapped; exact = true; }
          }
          entries.push({ id: peer.id, name: peer.name, color: peer.colorIndex, exact, top: rect.top - origin.top, left: exact ? rect.left - origin.left : -10 - entries.length * 5, height: exact ? Math.max(rect.height, 18) : Math.max(block.getBoundingClientRect().height, 20) });
        }
        setOverlay(entries);
      });
    };
    const off = session.onPeersChange(measure);
    const resize = new ResizeObserver(measure);
    resize.observe(scroll); resize.observe(content);
    const mutation = new MutationObserver(measure);
    mutation.observe(content, { childList: true, subtree: true, attributes: true });
    scroll.addEventListener('scroll', measure, { passive: true });
    content.addEventListener('load', measure, true);
    document.fonts?.ready.then(measure);
    measure();
    return () => { cancelAnimationFrame(frame); off(); resize.disconnect(); mutation.disconnect(); scroll.removeEventListener('scroll', measure); content.removeEventListener('load', measure, true); };
  }, [display, session]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const renderer = new PreviewRenderer(content);
    rendererRef.current = renderer;
    renderer.onStats((stats) => handlers.current.onStats(stats));
    renderer.onHeadings((headings) => handlers.current.onHeadings(headings));

    renderer.invalidate(session.getText());
    const off = session.onChange((change) => renderer.update(change.edits));

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
      tabIndex={0}
      onScroll={() => handlers.current.onScroll()}
    >
      <div className="marks-preview" ref={contentRef} onClick={handleClick} />
      <div className="preview-presence-overlay" aria-label="Collaborator locations">
        {overlay.map((item, index) => (
          <button key={item.id} type="button" className={`preview-presence ${item.exact ? 'exact' : 'section'} marks-user${item.color}`} style={{ top: item.top, left: item.left + (item.exact ? index * 3 : 0), height: item.height }} title={item.name} aria-label={`Scroll to ${item.name}`} onClick={() => contentRef.current?.querySelector<HTMLElement>(`.marks-block[data-source-start="${session.peers().find((peer) => peer.id === item.id)?.presence?.location?.blockStart}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            <span>{item.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function textCaretRect(block: HTMLElement, offset: number): DOMRect | null {
  if (offset < 0) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining); range.collapse(true);
      const rect = range.getClientRects()[0];
      return rect && Number.isFinite(rect.left) ? rect : null;
    }
    remaining -= length;
  }
  return null;
}
