import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureServiceCaller, getActiveCaller, type ServiceCaller } from './auth/caller';
import { createMarksDocumentAccess } from './auth/room-access';
import { loadUser } from './collab/user';
import type { AppDialog, ReviewSurface } from './components/overlays/AppOverlays';
import { ContextMenu } from './components/overlays/ContextMenu';
import { Icon, icons } from './components/ui/Icon';
import { LiquidDock } from './components/shell/LiquidDock';
import { OpeningShell } from './components/shell/OpeningShell';
import { PerfHud } from './components/overlays/PerfHud';
import { Sidebar } from './components/shell/Sidebar';
import type { CursorInfo } from './components/workspace/EditorPane';
import { Outline } from './components/workspace/Outline';
import { StatusBar } from './components/workspace/StatusBar';
import { ABOUT_DOCUMENT_ID } from './content/about';
import { Home } from './pages/Home';
import { LOGOUT_LOCAL_LINE } from './lib/identity-copy';
import { readPairingHash } from './lib/pairing-link';
import { SERVICE_ERROR_COPY } from './lib/service-errors';
import { TopBar, type ViewMode } from './components/shell/TopBar';
import { ToastRegion, type ToastMessage } from './components/overlays/ToastRegion';
import { VoiceBar } from './components/overlays/VoiceBar';
import type { LocalDocumentDraft, TemplateId } from './demo/workspace';
import { useBrowserSurface } from './hooks/useBrowserSurface';
import { useDocumentMeta } from './hooks/useDocumentMeta';
import { useDocuments } from './hooks/useDocuments';
import { useDevicePosture } from './hooks/useDevicePosture';
import { useRoute } from './hooks/useRoute';
import { useSession } from './hooks/useSession';
import { useTheme } from './hooks/useTheme';
import { useUiPreferences } from './hooks/useUiPreferences';
import { countWords } from './lib/format';
import { EMPTY_SNAPSHOT, type HudSnapshot } from './lib/hud';
import { LatencyTracker } from './lib/latency';
import { UI_DATA_MODE, UI_MEDIA } from './lib/product';
import { ScrollSync } from './lib/scroll-sync';
import type { UiActionId } from './lib/ui-actions';
import type { PreviewStats } from './markdown/preview';
import type { Heading } from './markdown/types';

const Benchmark = lazy(() =>
  import('./pages/Benchmark').then((module) => ({ default: module.Benchmark })),
);
const Workspace = lazy(() =>
  import('./components/workspace/Workspace').then((module) => ({ default: module.Workspace })),
);
const AppOverlays = lazy(() =>
  import('./components/overlays/AppOverlays').then((module) => ({ default: module.AppOverlays })),
);
const AiSheet = lazy(() =>
  import('./components/chrome/AiSheet').then((module) => ({ default: module.AiSheet })),
);
const LinkPage = lazy(() =>
  import('./pages/Link').then((module) => ({ default: module.LinkPage })),
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
  const [theme, toggleTheme, setTheme] = useTheme();
  const [preferences, setPreferences] = useUiPreferences();
  const posture = useDevicePosture();
  const phone = posture.phone;
  const overlayNavigation = posture.overlayNavigation;
  const user = useMemo(loadUser, []);
  const [serviceCaller, setServiceCaller] = useState<ServiceCaller | null>(null);
  useEffect(() => {
    if (UI_DATA_MODE !== 'service') return;
    let cancelled = false;
    void ensureServiceCaller()
      .then((caller) => {
        if (!cancelled) setServiceCaller(caller);
      })
      .catch(() => {
        if (!cancelled) setServiceCaller(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const documentAccess = useMemo(() => {
    if (UI_DATA_MODE !== 'service' || !serviceCaller) return null;
    return createMarksDocumentAccess({
      authority: () => getActiveCaller() ?? serviceCaller,
    });
  }, [serviceCaller]);

  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !matchMedia(UI_MEDIA.overlayNavigation).matches,
  );
  const [hudOpen, setHudOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [ribbonCollapsed, setRibbonCollapsed] = useState(
    () => localStorage.getItem('marks:ribbon-collapsed') === 'true',
  );
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [reviewSurface, setReviewSurface] = useState<ReviewSurface | null>(null);
  const [overlaysMounted, setOverlaysMounted] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [pairing, setPairing] = useState(() => readPairingHash(location.hash));

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
  const focusRestoreRef = useRef<{
    sidebarOpen: boolean;
    hudOpen: boolean;
    outlineOpen: boolean;
    reviewSurface: ReviewSurface | null;
  } | null>(null);
  const getView = useCallback(() => viewRef.current, []);
  const getPreview = useCallback(() => previewRef.current, []);
  const surface = useBrowserSurface(session, getView, getPreview);

  const [snapshot, setSnapshot] = useState<HudSnapshot>(EMPTY_SNAPSHOT);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 });

  useEffect(() => localStorage.setItem('marks:mode', mode), [mode]);

  useEffect(() => {
    localStorage.setItem('marks:ribbon-collapsed', String(ribbonCollapsed));
  }, [ribbonCollapsed]);

  useEffect(() => {
    if (phone && mode === 'split') setMode('edit');
  }, [mode, phone]);

  useEffect(() => {
    setSidebarOpen(!overlayNavigation);
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

  const title =
    documents.documents.find((entry) => entry.id === docId)?.title ??
    meta?.title ??
    (docId ? 'Untitled' : 'marks');

  const notify = useCallback(
    (toastTitle: string, detail?: string, tone: ToastMessage['tone'] = 'neutral') => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, title: toastTitle, detail, tone }].slice(-4));
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 4200);
    },
    [],
  );

  const openDialog = useCallback((next: AppDialog) => {
    setOverlaysMounted(true);
    setDialog(next);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = readPairingHash(location.hash);
      setPairing(next);
      if (next === 'invalid') {
        notify(SERVICE_ERROR_COPY[401].title, SERVICE_ERROR_COPY[401].detail, SERVICE_ERROR_COPY[401].tone);
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [notify]);

  const openDocument = useCallback(
    (id: string) => {
      setUiError(null);
      navigate({ name: 'document', id });
      if (overlayNavigation) setSidebarOpen(false);
    },
    [navigate, overlayNavigation],
  );

  const createDocument = useCallback(async (draft?: LocalDocumentDraft) => {
    try {
      setUiError(null);
      const created = await documents.create(draft);
      setDialog(null);
      openDocument(created.id);
      notify('Document created', `${created.title} is saved in this browser.`, 'success');
    } catch {
      setUiError('Marks could not create that document. Your current screen is still available.');
    }
  }, [documents, notify, openDocument]);

  const renameDocument = useCallback(
    async (id: string, nextTitle: string) => {
      try {
        if (id === docId && session) {
          const markdown = session.getText();
          const heading = /^#\s+.*$/m;
          session.setText(
            heading.test(markdown)
              ? markdown.replace(heading, `# ${nextTitle.trim()}`)
              : `# ${nextTitle.trim()}\n\n${markdown}`,
          );
        }
        const renamed = await documents.rename(id, nextTitle);
        if (!renamed) throw new Error('missing document');
        setDialog(null);
        notify('Document renamed', `Now called “${renamed.title}”.`, 'success');
      } catch {
        notify('Rename unavailable', 'The active data adapter could not rename this document.', 'danger');
      }
    },
    [docId, documents, notify, session],
  );

  const duplicateDocument = useCallback(async () => {
    if (!docId) return;
    try {
      const duplicate = await documents.duplicate(docId, session?.getText());
      if (!duplicate) throw new Error('missing document');
      openDocument(duplicate.id);
      notify('Document duplicated', 'The copy is independent and ready to edit.', 'success');
    } catch {
      notify('Duplicate unavailable', 'The active data adapter could not create a copy.', 'danger');
    }
  }, [docId, documents, notify, openDocument, session]);

  const removeDocument = useCallback(
    async (id: string) => {
      try {
        setUiError(null);
        await documents.remove(id);
        setDialog(null);
        if (docId === id) navigate({ name: 'home' });
        notify('Document deleted', 'It was removed from this browser.', 'success');
      } catch {
        notify('Delete unavailable', 'The active data adapter could not remove this document.', 'danger');
      }
    },
    [documents, docId, navigate, notify],
  );

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const openBenchmark = useCallback(() => {
    setReviewSurface(null);
    if (overlayNavigation) setSidebarOpen(false);
    navigate({ name: 'benchmark' });
  }, [navigate, overlayNavigation]);

  const runAction = useCallback(
    (action: UiActionId) => {
      switch (action) {
        case 'new':
          void createDocument();
          break;
        case 'templates':
          openDialog({ type: 'templates' });
          break;
        case 'rename':
          if (docId) openDialog({ type: 'rename', documentId: docId, title });
          break;
        case 'duplicate':
          void duplicateDocument();
          break;
        case 'download': {
          if (!session) break;
          const blob = new Blob([session.getText()], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'marks-document'}.md`;
          anchor.click();
          URL.revokeObjectURL(url);
          notify('Markdown exported', anchor.download, 'success');
          break;
        }
        case 'print':
          setMode('preview');
          window.setTimeout(() => window.print(), 180);
          break;
        case 'delete':
          if (docId) openDialog({ type: 'delete', documentId: docId, title });
          break;
        case 'share':
          if (docId) openDialog({ type: 'share', documentId: docId, title });
          break;
        case 'comments':
        case 'history':
          if (!docId) break;
          setOverlaysMounted(true);
          setReviewSurface((current) =>
            current?.type === action ? null : { type: action, documentId: docId, title },
          );
          break;
        case 'command-palette':
          openDialog({ type: 'command-palette' });
          break;
        case 'preferences':
          openDialog({ type: 'preferences' });
          break;
        case 'focus':
          setFocusMode((current) => {
            if (!current) {
              focusRestoreRef.current = { sidebarOpen, hudOpen, outlineOpen, reviewSurface };
              setSidebarOpen(false);
              setHudOpen(false);
              setOutlineOpen(false);
              setReviewSurface(null);
            } else {
              const restore = focusRestoreRef.current;
              setSidebarOpen(restore?.sidebarOpen ?? !overlayNavigation);
              setHudOpen(restore?.hudOpen ?? false);
              setOutlineOpen(restore?.outlineOpen ?? false);
              setReviewSurface(restore?.reviewSurface ?? null);
              focusRestoreRef.current = null;
            }
            return !current;
          });
          break;
        case 'benchmark':
          openBenchmark();
          break;
        case 'about':
          openDocument(ABOUT_DOCUMENT_ID);
          if (!phone) setMode('split');
          break;
        case 'keep-workspace':
          openDialog({ type: 'keep-workspace' });
          break;
        case 'account':
          openDialog({ type: 'account' });
          break;
        case 'pairing':
          navigate({ name: 'link' });
          break;
        case 'logout':
          notify(SERVICE_ERROR_COPY[401].title, LOGOUT_LOCAL_LINE, 'neutral');
          break;
        case 'find': {
          const view = viewRef.current;
          if (view) void import('./editor/actions').then(({ openFind }) => openFind(view));
          break;
        }
        case 'ai-compose':
          setAiOpen(true);
          break;
      }
    },
    [
      createDocument,
      docId,
      duplicateDocument,
      hudOpen,
      notify,
      openBenchmark,
      openDialog,
      outlineOpen,
      navigate,
      openDocument,
      overlayNavigation,
      phone,
      reviewSurface,
      session,
      sidebarOpen,
      title,
    ],
  );

  // Application shortcuts. Editor shortcuts live in the CodeMirror keymap.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        runAction('command-palette');
        return;
      }

      if (event.key === 'F1' && docId && !phone) {
        event.preventDefault();
        setRibbonCollapsed((collapsed) => !collapsed);
        return;
      }

      if (dialog) return;

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
      } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        runAction('focus');
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        runAction('new');
      } else if (event.key.toLowerCase() === 'p' && docId) {
        event.preventDefault();
        runAction('print');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog, docId, phone, runAction]);

  useEffect(() => {
    document.title =
      route.name === 'benchmark'
        ? 'Benchmark · marks'
        : route.name === 'link'
          ? 'Phone confirmation · marks'
          : route.name === 'document'
            ? `${title} · marks`
            : 'marks — collaborative writing at thought speed';
  }, [title, route.name]);

  useEffect(() => {
    if (route.name === 'document') return;
    setFocusMode(false);
    setReviewSurface(null);
    setOutlineOpen(false);
    setAiOpen(false);
  }, [route.name]);

  return (
    <div className={`app route-${route.name}${sidebarOpen && !focusMode && !posture.foldable ? ' with-sidebar' : ''}${focusMode ? ' focus-mode' : ''}${ribbonCollapsed ? ' ribbon-collapsed' : ''}`} data-shell={posture.shell} data-doc={docId ?? undefined}>
      {sidebarOpen && !focusMode && !posture.foldable && (
        <Sidebar
          documents={documents.documents}
          activeId={docId}
          loading={documents.loading}
          stale={documents.stale}
          error={UI_DATA_MODE === 'service' ? documents.error ?? uiError : null}
          overlay={overlayNavigation}
          onClose={closeSidebar}
          onOpen={openDocument}
          onCreate={() => void createDocument()}
          onDelete={(id) => {
            const document = documents.documents.find((entry) => entry.id === id);
            if (document) openDialog({ type: 'delete', documentId: id, title: document.title });
          }}
          onOpenBenchmark={openBenchmark}
          onOpenAbout={() => openDocument(ABOUT_DOCUMENT_ID)}
        />
      )}

      <main className={`main route-${route.name}`}>
        <TopBar
          title={route.name === 'benchmark' ? 'Engine benchmark' : route.name === 'link' ? 'Phone confirmation' : title}
          docId={docId}
          route={route.name}
          documentReady={Boolean(session && hydrated)}
          documentAvailable={!resolved || supported}
          posture={posture}
          selected={cursor.selected}
          getView={getView}
          status={status}
          peers={peers}
          mode={mode}
          theme={theme}
          sidebarOpen={sidebarOpen}
          hudOpen={hudOpen}
          outlineOpen={outlineOpen}
          reviewOpen={reviewSurface?.type ?? null}
          localMode={UI_DATA_MODE === 'local'}
          focusMode={focusMode}
          ribbonCollapsed={ribbonCollapsed}
          onModeChange={setMode}
          onToggleSidebar={toggleSidebar}
          onToggleTheme={toggleTheme}
          onToggleHud={() => setHudOpen((open) => !open)}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onToggleRibbon={() => setRibbonCollapsed((collapsed) => !collapsed)}
          onAction={runAction}
          onOpenAi={() => setAiOpen(true)}
          onNotify={notify}
          onVoice={session ? surface.toggleVoice : undefined}
          voiceActive={surface.voiceStatus === 'listening'}
          voiceSupported={surface.voiceSupported}
        />

        {route.name === 'benchmark' ? (
          <Suspense fallback={<div className="empty-state">Loading benchmark…</div>}>
            <Benchmark onBack={() => navigate({ name: 'home' })} />
          </Suspense>
        ) : route.name === 'link' ? (
          <Suspense fallback={<div className="empty-state">Opening phone confirmation…</div>}>
            <LinkPage
              pairing={pairing}
              onNotify={notify}
              onKeep={() => openDialog({ type: 'keep-workspace' })}
            />
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
                posture={posture}
                getView={getView}
                documentTitle={title}
                onModeChange={setMode}
                onAction={runAction}
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
          <Home
            documents={documents.documents}
            loading={documents.loading}
            onCreate={() => void createDocument()}
            onCreateFromTemplate={(templateId) => void createDocument({ templateId })}
            onOpen={openDocument}
            onOpenTemplates={() => openDialog({ type: 'templates' })}
            onOpenBenchmark={openBenchmark}
            onOpenPreferences={() => openDialog({ type: 'preferences' })}
            onKeepWorkspace={() => openDialog({ type: 'keep-workspace' })}
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
            network={UI_DATA_MODE === 'local' ? 'online' : surface.network}
            localMode={UI_DATA_MODE === 'local'}
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

      {aiOpen && route.name === 'document' && !phone && (
        <Suspense fallback={null}>
          <aside className="ai-float" aria-label="AI composition">
            <AiSheet
              open
              documentTitle={title}
              getView={getView}
              onClose={() => setAiOpen(false)}
              onNotify={notify}
            />
          </aside>
        </Suspense>
      )}

      {route.name === 'document' && session && !phone && !focusMode && !posture.foldable && (
        <LiquidDock
          onCommands={() => runAction('command-palette')}
          onComments={() => runAction('comments')}
          onHistory={() => runAction('history')}
          onVoice={surface.voiceSupported ? surface.toggleVoice : undefined}
          voiceActive={surface.voiceStatus === 'listening'}
          voiceSupported={surface.voiceSupported}
        />
      )}

      {overlaysMounted && (
        <Suspense fallback={null}>
          <AppOverlays
            dialog={dialog}
            review={reviewSurface}
            session={session}
            userName={user.name}
            theme={theme}
            preferences={preferences}
            hasDocument={Boolean(docId && session)}
            onCloseDialog={() => setDialog(null)}
            onCloseReview={() => setReviewSurface(null)}
            onAction={runAction}
            onCreateFromTemplate={(templateId: TemplateId) => void createDocument({ templateId })}
            onRename={(id, nextTitle) => void renameDocument(id, nextTitle)}
            onDelete={(id) => void removeDocument(id)}
            onTheme={setTheme}
            onPreferences={setPreferences}
            onNotify={notify}
          />
        </Suspense>
      )}

      <ToastRegion
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </div>
  );
}
