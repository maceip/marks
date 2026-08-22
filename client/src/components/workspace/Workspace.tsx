import type { EditorView } from '@codemirror/view';
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CollabSession } from '../../collab/types';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import type { ScrollSync } from '../../lib/scroll-sync';
import type { PreviewStats } from '../../markdown/preview';
import type { Heading } from '../../markdown/types';
import '../../styles/document.css';
import '../../styles/chrome.css';
import { Outline } from './Outline';
import type { CursorInfo } from './EditorPane';
import type { ViewMode } from '../TopBar';

const EditorPane = lazy(() =>
  import('./EditorPane').then((module) => ({ default: module.EditorPane })),
);
const PreviewPane = lazy(() =>
  import('./PreviewPane').then((module) => ({ default: module.PreviewPane })),
);
const AiSheet = lazy(() =>
  import('../chrome/AiSheet').then((module) => ({ default: module.AiSheet })),
);

interface WorkspaceProps {
  session: CollabSession;
  mode: ViewMode;
  posture: Posture;
  getView: () => EditorView | null;
  documentTitle?: string;
  onModeChange?: (mode: ViewMode) => void;
  onAction?: (action: UiActionId) => void;
  scrollSync: ScrollSync;
  onStats: (stats: PreviewStats) => void;
  onHeadings: (headings: Heading[]) => void;
  onCursor: (cursor: CursorInfo) => void;
  onView: (view: EditorView | null) => void;
  onPreview?: (element: HTMLElement | null) => void;
  previewRequested?: boolean;
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
  posture,
  getView,
  documentTitle,
  onModeChange,
  onAction,
  scrollSync,
  onStats,
  onHeadings,
  onCursor,
  onView,
  onPreview,
  previewRequested,
}: WorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(loadSplit);
  const [dragging, setDragging] = useState(false);
  const [previewWarm, setPreviewWarm] = useState(
    () => mode !== 'edit' || Boolean(previewRequested) || posture.foldable,
  );
  const [companion, setCompanion] = useState<'preview' | 'outline' | 'ai'>('preview');
  const [localHeadings, setLocalHeadings] = useState<Heading[]>([]);
  const foldBook = posture.shell === 'fold-book';
  const showEditor = mode !== 'preview' || foldBook;

  useEffect(() => {
    if (mode !== 'edit' || previewRequested || posture.foldable) setPreviewWarm(true);
  }, [mode, posture.foldable, previewRequested]);

  useEffect(() => {
    if (posture.shell !== 'phone' || !onModeChange) return;
    const root = rootRef.current;
    if (!root) return;
    let startX = 0;
    let startY = 0;
    const onDown = (event: PointerEvent) => {
      startX = event.clientX;
      startY = event.clientY;
    };
    const onUp = (event: PointerEvent) => {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy)) return;
      onModeChange(dx < 0 ? 'preview' : 'edit');
    };
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointerup', onUp);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointerup', onUp);
    };
  }, [onModeChange, posture.shell]);

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
    scrollSync.setEnabled(mode === 'split' || foldBook);
  }, [foldBook, mode, scrollSync]);

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
      {showEditor && (
        <Suspense
          fallback={
            <section className="pane editor-pane editor-loading" aria-label="Markdown source">
              Preparing editor…
            </section>
          }
        >
          <EditorPane
            session={session}
            onView={handleView}
            onScroll={() => scrollSync.fromEditor()}
            onCursor={onCursor}
          />
        </Suspense>
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

      {previewWarm && (
        <Suspense
          fallback={
            <section className="pane preview-pane preview-loading" aria-label="Preview">
              Preparing preview…
            </section>
          }
        >
          {foldBook ? (
            <section className="fold-companion" aria-label="Folded companion">
              <nav className="fold-companion-tabs" aria-label="Companion pane">
                <button type="button" className={companion === 'preview' ? 'active' : undefined} onClick={() => setCompanion('preview')}>Preview</button>
                <button type="button" className={companion === 'outline' ? 'active' : undefined} onClick={() => setCompanion('outline')}>Outline</button>
                <button type="button" className={companion === 'ai' ? 'active' : undefined} onClick={() => setCompanion('ai')}>AI</button>
                <button type="button" onClick={() => onAction?.('comments')}>Review</button>
              </nav>
              <div className="fold-companion-body">
                <div hidden={companion !== 'preview'}>
                  <PreviewPane
                    session={session}
                    onContainer={handleContainer}
                    onStats={onStats}
                    onHeadings={(items) => {
                      setLocalHeadings(items);
                      onHeadings(items);
                    }}
                    onScroll={() => scrollSync.fromPreview()}
                  />
                </div>
                {companion === 'outline' && (
                  <Outline headings={localHeadings} onSelect={(line) => scrollSync.scrollToLine(line)} />
                )}
                {companion === 'ai' && (
                  <Suspense fallback={null}>
                    <AiSheet
                      open
                      embedded
                      documentTitle={documentTitle}
                      getView={getView}
                      onClose={() => setCompanion('preview')}
                    />
                  </Suspense>
                )}
              </div>
            </section>
          ) : (
            <PreviewPane
              session={session}
              onContainer={handleContainer}
              onStats={onStats}
              onHeadings={onHeadings}
              onScroll={() => scrollSync.fromPreview()}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}

/** The metrics sampler re-renders App several times a second; the editor
 * subtree must not re-render with it. */
export const Workspace = memo(WorkspaceView);
