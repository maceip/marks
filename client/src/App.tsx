import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMarksDocumentAccess } from './auth/room-access';
import { loadScratchCredential } from './auth/scratch';
import { loadUser } from './collab/user';
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
import { useBrowserSurface } from './hooks/useBrowserSurface';
import { useDocumentMeta } from './hooks/useDocumentMeta';
import { useDocuments } from './hooks/useDocuments';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useRoute } from './hooks/useRoute';
import { useSession } from './hooks/useSession';
import { useTheme } from './hooks/useTheme';
import { countWords } from './lib/format';
import { EMPTY_SNAPSHOT, type HudSnapshot } from './lib/hud';
import { LatencyTracker } from './lib/latency';
import { UI_MEDIA } from './lib/product';
import { ScrollSync } from './lib/scroll-sync';
import type { PreviewStats } from './markdown/preview';
import type { Heading } from './markdown/types';

const Benchmark = lazy(() =>
  import('./pages/Benchmark').then((module) => ({ default: module.Benchmark })),
);
const Workspace = lazy(() =>
  import('./components/Workspace').then((module) => ({ default: module.Workspace })),
);

/** How often the HUD and word counts refresh. Editing never waits on this. */
const SAMPLE_INTERVAL_MS = 400;

const MODE_ORDER: ViewMode[] = ['edit', 'split', 'preview'];

function initialMode(): ViewMode {
  const stored = localStorage.getItem('marks:mode');
  if (stored === 'edit' || stored === 'split' || stored === 'preview') return stored;
  return matchMedia(UI_MEDIA.phone).matches ? 'edit' : 'split';
}

export function App() {
  const [route, navigate] = useRoute();
  const [theme, toggleTheme] = useTheme();
  const phone = useMediaQuery(UI_MEDIA.phone);
  const overlayNavigation = useMediaQuery(UI_MEDIA.overlayNavigation);
  const user = useMemo(loadUser, []);
  const documentAccess = useMemo(
    () =>
      createMarksDocumentAccess({
        authority: () => {
          const credential = loadScratchCredential(sessionStorage);
          return credential ? { kind: 'scratch', credential } : { kind: 'session' };
        },
      }),
    [],
  );

  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !matchMedia(UI_MEDIA.overlayNavigation).matches,
  );
  const [hudOpen, setHudOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);

  const documents = useDocuments(route.name !== 'benchmark');
  const docId = route.name === 'document' ? route.id : null;
  const { meta, engine, supported, resolved } = useDocumentMeta(docId);
  const { session, status, peers, hydrated } = useSession(
    resolved && supported ? docId : null,
    user,
    documentAccess,
  );

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

  useEffect(() => {
    if (phone && mode === 'split') setMode('edit');
  }, [mode, phone]);

  useEffect(() => {
    if (overlayNavigation) setSidebarOpen(false);
  }, [overlayNavigation]);

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
    if (!session) {
      setSnapshot({ ...EMPTY_SNAPSHOT, engine });
      return;
    }

    const sample = () => {
      const stats = latest.current;
      const engineStats = session.stats();
      const text = textRef.current;

      setSnapshot({
        engine: session.engine,
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
        snapshotBytes: engineStats.snapshotBytes,
        sent: engineStats.sent,
        received: engineStats.received,
      });
    };

    sample();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') sample();
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
      setUiError(null);
      navigate({ name: 'document', id });
      if (overlayNavigation) setSidebarOpen(false);
    },
    [navigate, overlayNavigation],
  );

  const createDocument = useCallback(async () => {
    try {
      setUiError(null);
      const created = await documents.create();
      openDocument(created.id);
    } catch {
      setUiError('The document service is not ready yet. Your current screen is still available.');
    }
  }, [documents, openDocument]);

  const removeDocument = useCallback(
    async (id: string) => {
      try {
        setUiError(null);
        await documents.remove(id);
        if (docId === id) navigate({ name: 'home' });
      } catch {
        setUiError('That document could not be deleted while the service is unavailable.');
      }
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
        const availableModes = phone ? MODE_ORDER.filter((item) => item !== 'split') : MODE_ORDER;
        setMode(
          (current) =>
            availableModes[(availableModes.indexOf(current) + 1) % availableModes.length],
        );
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
  }, [phone]);

  // Titles are derived server-side from the first heading, so the polled index
  // is fresher than the metadata fetched when the document was opened.
  const title =
    documents.documents.find((entry) => entry.id === docId)?.title ??
    meta?.title ??
    (docId ? 'Untitled' : 'marks');

  useEffect(() => {
    document.title =
      route.name === 'benchmark'
        ? 'Benchmark · marks'
        : route.name === 'document'
          ? `${title} · marks`
          : 'marks — collaborative writing at thought speed';
  }, [title, route.name]);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const openBenchmark = useCallback(() => {
    if (overlayNavigation) setSidebarOpen(false);
    navigate({ name: 'benchmark' });
  }, [navigate, overlayNavigation]);

  return (
    <div className={`app route-${route.name}${sidebarOpen ? ' with-sidebar' : ''}`}>
      {sidebarOpen && (
        <Sidebar
          documents={documents.documents}
          activeId={docId}
          loading={documents.loading}
          stale={documents.stale}
          error={documents.error ?? uiError}
          overlay={overlayNavigation}
          onClose={closeSidebar}
          onOpen={openDocument}
          onCreate={() => void createDocument()}
          onDelete={(id) => void removeDocument(id)}
          onOpenBenchmark={openBenchmark}
        />
      )}

      <main className={`main route-${route.name}`}>
        <TopBar
          title={route.name === 'benchmark' ? 'Engine benchmark' : title}
          docId={docId}
          route={route.name}
          documentReady={Boolean(session && hydrated)}
          documentAvailable={!resolved || supported}
          phone={phone}
          getView={getView}
          status={status}
          peers={peers}
          mode={mode}
          theme={theme}
          sidebarOpen={sidebarOpen}
          hudOpen={hudOpen}
          outlineOpen={outlineOpen}
          onModeChange={setMode}
          onToggleSidebar={toggleSidebar}
          onToggleTheme={toggleTheme}
          onToggleHud={() => setHudOpen((open) => !open)}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onVoice={session ? surface.toggleVoice : undefined}
          voiceActive={surface.voiceStatus === 'listening'}
        />

        {route.name === 'benchmark' ? (
          <Suspense fallback={<div className="empty-state">Loading benchmark…</div>}>
            <Benchmark onBack={() => navigate({ name: 'home' })} />
          </Suspense>
        ) : docId && resolved && !supported ? (
          <div className="empty-state">
            <div className="empty-card">
              <h2>{meta ? 'Legacy document' : 'Document unavailable'}</h2>
              {meta ? (
                <p>
                  This document was created with the retired <code>{engine}</code> engine and its
                  stored bytes cannot be opened by the ESBT engine. Create a new document and paste
                  its content across from an older export.
                </p>
              ) : (
                <p>This document does not exist, was deleted, or is not available to this session.</p>
              )}
            </div>
          </div>
        ) : session ? (
          <div
            className="workspace-shell"
            onFocusCapture={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('.preview-pane')) surface.setLastSurface('preview');
              else if (target.closest('.editor-pane')) surface.setLastSurface('editor');
            }}
          >
            {!hydrated && (
              <OpeningShell cached={Boolean(meta)} offline={surface.network === 'offline'} />
            )}
            <Suspense fallback={<OpeningShell cached offline={false} />}>
              <Workspace
                session={session}
                mode={mode}
                scrollSync={scrollSync}
                onStats={handleStats}
                onHeadings={setHeadings}
                onCursor={setCursor}
                onView={handleView}
                previewRequested={outlineOpen}
                onPreview={(element) => {
                  previewRef.current = element;
                }}
              />
            </Suspense>
            <VoiceBar status={surface.voiceStatus} interim={surface.voiceInterim} onStop={surface.stopVoice} />
          </div>
        ) : docId ? (
          <OpeningShell cached={Boolean(meta)} offline={surface.network === 'offline'} />
        ) : (
          <EmptyState
            onCreate={() => void createDocument()}
            onOpenBenchmark={openBenchmark}
            error={
              uiError ??
              (documents.error
                ? 'The document service is not ready yet. You can still explore the workspace.'
                : null)
            }
          />
        )}

        {route.name === 'document' && session && (
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

      {outlineOpen && route.name === 'document' && (
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
          onOpenBenchmark={openBenchmark}
        />
      )}
    </div>
  );
}
