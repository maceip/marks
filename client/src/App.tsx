import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadUser } from './collab';
import type { EngineName } from './collab/types';
import { CommentsDrawer } from './components/CommentsDrawer';
import { ContextMenu } from './components/ContextMenu';
import { EmptyState } from './components/EmptyState';
import type { CursorInfo } from './components/EditorPane';
import { Icon, icons } from './components/Icon';
import { OpeningShell } from './components/OpeningShell';
import { Outline } from './components/Outline';
import { PerfHud } from './components/PerfHud';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TopBar, type ViewMode } from './components/TopBar';
import { VoiceBar } from './components/VoiceBar';
import { Workspace } from './components/Workspace';
import { useBrowserSurface } from './hooks/useBrowserSurface';
import { useDocumentMeta } from './hooks/useDocumentMeta';
import { useDocuments } from './hooks/useDocuments';
import { useRoute } from './hooks/useRoute';
import { useSession } from './hooks/useSession';
import { useTheme } from './hooks/useTheme';
import { countWords } from './lib/format';
import { EMPTY_SNAPSHOT, type HudSnapshot } from './lib/hud';
import { LatencyTracker } from './lib/latency';
import { ScrollSync } from './lib/scroll-sync';
import type { PreviewStats } from './markdown/preview';
import type { Heading } from './markdown/types';

const Benchmark = lazy(() =>
  import('./pages/Benchmark').then((module) => ({ default: module.Benchmark })),
);

/** How often the HUD and word counts refresh. Editing never waits on this. */
const SAMPLE_INTERVAL_MS = 400;

const MODE_ORDER: ViewMode[] = ['edit', 'split', 'preview'];

function initialMode(): ViewMode {
  const stored = localStorage.getItem('marks:mode');
  if (stored === 'edit' || stored === 'split' || stored === 'preview') return stored;
  return matchMedia('(max-width: 900px)').matches ? 'edit' : 'split';
}

export function App() {
  const [route, navigate] = useRoute();
  const [theme, toggleTheme] = useTheme();
  const user = useMemo(loadUser, []);

  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia('(max-width: 900px)').matches);
  const [hudOpen, setHudOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const documents = useDocuments();
  const docId = route.name === 'document' ? route.id : null;
  const { meta, engine, resolved } = useDocumentMeta(docId);
  const { session, status, peers, comments } = useSession(resolved ? docId : null, engine, user);

  const scrollSync = useMemo(() => new ScrollSync(), []);
  const tracker = useRef(new LatencyTracker(240));
  const latest = useRef<PreviewStats | null>(null);
  const textRef = useRef('');
  const viewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const getView = useCallback(() => viewRef.current, []);
  const getPreview = useCallback(() => previewRef.current, []);
  const surface = useBrowserSurface(session, getView, getPreview);

  const [snapshot, setSnapshot] = useState<HudSnapshot>(EMPTY_SNAPSHOT);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 });

  useEffect(() => localStorage.setItem('marks:mode', mode), [mode]);

  // Text is kept out of React state; only the derived counters are published.
  useEffect(() => {
    if (!session) {
      textRef.current = '';
      return;
    }
    textRef.current = session.getText();
    tracker.current.reset();
    return session.onTextChange((text) => {
      textRef.current = text;
    });
  }, [session]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const stats = latest.current;
      const engineStats = session?.stats();
      const text = textRef.current;

      setSnapshot({
        engine: session?.engine ?? engine,
        p50: tracker.current.p50,
        p95: tracker.current.p95,
        max: tracker.current.max,
        samples: tracker.current.count,
        blocks: stats?.blocks ?? 0,
        dirty: stats?.dirty ?? 0,
        parseMs: stats?.parseMs ?? 0,
        renderMs: stats?.renderMs ?? 0,
        patchMs: stats?.patchMs ?? 0,
        touched: stats?.touched ?? 0,
        htmlBytes: stats?.bytes ?? 0,
        chars: text.length,
        words: countWords(text),
        snapshotBytes: engineStats?.snapshotBytes ?? 0,
        sent: engineStats?.sent ?? 0,
        received: engineStats?.received ?? 0,
      });
    }, SAMPLE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [session, engine]);

  const handleView = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

  const handleStats = useCallback((stats: PreviewStats) => {
    latest.current = stats;
    tracker.current.add(stats.latencyMs);
  }, []);

  const openDocument = useCallback(
    (id: string) => {
      navigate({ name: 'document', id });
      if (matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
    },
    [navigate],
  );

  const createDocument = useCallback(
    async (nextEngine: EngineName) => {
      const created = await documents.create(nextEngine);
      openDocument(created.id);
    },
    [documents, openDocument],
  );

  const removeDocument = useCallback(
    async (id: string) => {
      await documents.remove(id);
      if (docId === id) navigate({ name: 'home' });
    },
    [documents, docId, navigate],
  );

  // Application shortcuts. Editor shortcuts live in the CodeMirror keymap.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key === '\\') {
        event.preventDefault();
        setMode((current) => MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length]);
      } else if (event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        setOutlineOpen((open) => !open);
      } else if (event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setHudOpen((open) => !open);
      } else if (event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Titles are derived server-side from the first heading, so the polled index
  // is fresher than the metadata fetched when the document was opened.
  const title =
    documents.documents.find((entry) => entry.id === docId)?.title ??
    meta?.title ??
    (docId ? 'Untitled' : 'marks');

  useEffect(() => {
    document.title = route.name === 'benchmark' ? 'Benchmark · marks' : `${title} · marks`;
  }, [title, route.name]);

  return (
    <div className={`app${sidebarOpen ? ' with-sidebar' : ''}`}>
      {sidebarOpen && (
        <Sidebar
          documents={documents.documents}
          activeId={docId}
          loading={documents.loading}
          stale={documents.stale}
          onOpen={openDocument}
          onCreate={(nextEngine) => void createDocument(nextEngine)}
          onDelete={(id) => void removeDocument(id)}
          onOpenBenchmark={() => navigate({ name: 'benchmark' })}
        />
      )}

      <main className="main">
        <TopBar
          title={route.name === 'benchmark' ? 'Engine benchmark' : title}
          docId={docId}
          engine={engine}
          status={status}
          peers={peers}
          mode={mode}
          theme={theme}
          sidebarOpen={sidebarOpen}
          hudOpen={hudOpen}
          outlineOpen={outlineOpen}
          commentsOpen={surface.commentsOpen}
          commentCount={comments.filter((comment) => !comment.resolved).length}
          onModeChange={setMode}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleTheme={toggleTheme}
          onToggleHud={() => setHudOpen((open) => !open)}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onToggleComments={() => surface.setCommentsOpen(!surface.commentsOpen)}
        />

        {route.name === 'benchmark' ? (
          <Suspense fallback={<div className="empty-state">Loading benchmark…</div>}>
            <Benchmark onBack={() => navigate({ name: 'home' })} />
          </Suspense>
        ) : session ? (
          <div
            className="workspace-shell"
            onFocusCapture={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('.preview-pane')) surface.setLastSurface('preview');
              else if (target.closest('.editor-pane')) surface.setLastSurface('editor');
            }}
          >
            {!surface.hydrated && (
              <OpeningShell cached={Boolean(meta)} offline={surface.network === 'offline'} />
            )}
            <Workspace
              session={session}
              mode={mode}
              scrollSync={scrollSync}
              onStats={handleStats}
              onHeadings={setHeadings}
              onCursor={setCursor}
              onView={handleView}
              onPreview={(element) => {
                previewRef.current = element;
              }}
              onComment={surface.beginComment}
              onVoice={surface.toggleVoice}
              voiceActive={surface.voiceStatus === 'listening'}
            />
            <VoiceBar status={surface.voiceStatus} interim={surface.voiceInterim} onStop={surface.stopVoice} />
          </div>
        ) : docId ? (
          <OpeningShell cached={Boolean(meta)} offline={surface.network === 'offline'} />
        ) : (
          <EmptyState
            onCreate={(nextEngine) => void createDocument(nextEngine)}
            onOpenBenchmark={() => navigate({ name: 'benchmark' })}
          />
        )}

        {route.name !== 'benchmark' && (
          <StatusBar
            words={snapshot.words}
            chars={snapshot.chars}
            cursor={cursor}
            status={status}
            latencyP50={snapshot.p50}
            latencyP95={snapshot.p95}
            peers={peers.length || 1}
            network={surface.network}
          />
        )}
      </main>

      {surface.contextMenu && (
        <ContextMenu
          x={surface.contextMenu.x}
          y={surface.contextMenu.y}
          actions={surface.contextMenu.actions}
          onClose={surface.closeContextMenu}
        />
      )}

      {surface.commentsOpen && session && route.name !== 'benchmark' && (
        <CommentsDrawer
          comments={comments}
          draftQuote={surface.draftQuote}
          onSubmitDraft={surface.submitComment}
          onCancelDraft={surface.cancelDraft}
          onResolve={(id) => session.resolveComment(id)}
          onDelete={(id) => session.deleteComment(id)}
          onSelect={(comment) => {
            const view = viewRef.current;
            if (!view) return;
            view.dispatch({
              selection: { anchor: comment.from, head: comment.to },
              scrollIntoView: true,
            });
            view.focus();
          }}
          onClose={() => surface.setCommentsOpen(false)}
        />
      )}

      {outlineOpen && route.name !== 'benchmark' && (
        <aside className="outline-drawer" aria-label="Outline">
          <header className="drawer-head">
            <h2>
              <Icon path={icons.outline} size={14} /> Outline
            </h2>
            <button
              type="button"
              className="icon-button"
              onClick={() => setOutlineOpen(false)}
              aria-label="Close outline"
            >
              <Icon path={icons.close} size={14} />
            </button>
          </header>
          <Outline headings={headings} onSelect={(line) => scrollSync.scrollToLine(line)} />
        </aside>
      )}

      {hudOpen && (
        <PerfHud
          snapshot={snapshot}
          onClose={() => setHudOpen(false)}
          onOpenBenchmark={() => navigate({ name: 'benchmark' })}
        />
      )}
    </div>
  );
}
