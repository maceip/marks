import type { EditorView } from '@codemirror/view';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CollabSession } from '../collab/types';
import type { ScrollSync } from '../lib/scroll-sync';
import type { PreviewStats } from '../markdown/preview';
import type { Heading } from '../markdown/types';
import { EditorPane, type CursorInfo } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import type { ViewMode } from './TopBar';

interface WorkspaceProps {
  session: CollabSession;
  mode: ViewMode;
  scrollSync: ScrollSync;
  onStats: (stats: PreviewStats) => void;
  onHeadings: (headings: Heading[]) => void;
  onCursor: (cursor: CursorInfo) => void;
  onView: (view: EditorView | null) => void;
  onPreview?: (element: HTMLElement | null) => void;
  onComment?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
}

const SPLIT_KEY = 'marks:split';
const MIN_SPLIT = 20;
const MAX_SPLIT = 80;

function loadSplit(): number {
  const stored = Number(localStorage.getItem(SPLIT_KEY));
  return Number.isFinite(stored) && stored >= MIN_SPLIT && stored <= MAX_SPLIT ? stored : 50;
}

function WorkspaceView({
  session,
  mode,
  scrollSync,
  onStats,
  onHeadings,
  onCursor,
  onView,
  onPreview,
  onComment,
  onVoice,
  voiceActive,
}: WorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(loadSplit);
  const [dragging, setDragging] = useState(false);

  const handleView = useCallback(
    (view: EditorView | null) => {
      scrollSync.setEditor(view);
      onView(view);
    },
    [scrollSync, onView],
  );

  const handleContainer = useCallback(
    (element: HTMLElement | null) => {
      scrollSync.setPreview(element);
      onPreview?.(element);
    },
    [scrollSync, onPreview],
  );

  // Only sync scrolling when both panes are actually on screen.
  useEffect(() => {
    scrollSync.setEnabled(mode === 'split');
  }, [mode, scrollSync]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) return;
      const percent = ((event.clientX - bounds.left) / bounds.width) * 100;
      setSplit(Math.min(Math.max(percent, MIN_SPLIT), MAX_SPLIT));
    };
    const onUp = () => setDragging(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(Math.round(split)));
  }, [split]);

  return (
    <div
      className={`workspace mode-${mode}${dragging ? ' dragging' : ''}`}
      ref={rootRef}
      style={{ '--split': `${split}%` } as React.CSSProperties}
    >
      {/*
        In preview-only mode the editor is unmounted rather than hidden: a
        CodeMirror instance inside a `display: none` subtree cannot measure
        itself, and the collaborative cursor layers throw when they try.
      */}
      {mode !== 'preview' && (
        <EditorPane
          session={session}
          showToolbar
          onView={handleView}
          onScroll={() => scrollSync.fromEditor()}
          onCursor={onCursor}
          onComment={onComment}
          onVoice={onVoice}
          voiceActive={voiceActive}
        />
      )}

      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setSplit(50)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setSplit((value) => Math.max(MIN_SPLIT, value - 2));
          if (event.key === 'ArrowRight') setSplit((value) => Math.min(MAX_SPLIT, value + 2));
        }}
      />

      <PreviewPane
        session={session}
        onContainer={handleContainer}
        onStats={onStats}
        onHeadings={onHeadings}
        onScroll={() => scrollSync.fromPreview()}
      />
    </div>
  );
}

/** The metrics sampler re-renders App several times a second; the editor
 * subtree must not re-render with it. */
export const Workspace = memo(WorkspaceView);
