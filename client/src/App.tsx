import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandEnvironment } from './commands/types';
import { bindPendingDevice, getOrCreatePendingDevice } from './auth/pending-device';
import {
  ensureServiceCaller,
  getActiveCaller,
  subscribeActiveCaller,
  type ServiceCaller,
} from './auth/caller';
import { createMarksDocumentAccess } from './auth/room-access';
import { loadUser } from './collab/user';
import type { AppDialog, ReviewSurface } from './components/overlays/AppOverlays';
import { Icon, icons } from './components/ui/Icon';
import { OpeningShell } from './components/shell/OpeningShell';
import { Sidebar } from './components/shell/Sidebar';
import type { CursorInfo } from './components/workspace/EditorPane';
import { StatusBar } from './components/workspace/StatusBar';
import { LiquidDock } from './components/shell/LiquidDock';
import { ABOUT_DOCUMENT_ID, ABOUT_DOCUMENT_TITLE, isAboutDocument } from './content/about';
import { signalDocumentRepositoryChange } from './data/documents';
import { runWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from './browser/network.ts';
import { readPairingHash } from './lib/pairing-link';
import { readDocumentShareHash } from './lib/share-link';
import { loadServiceApi } from './lib/service-api.ts';
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
import { EMPTY_SNAPSHOT, type HudSnapshot } from './lib/hud';
import { LatencyTracker } from './lib/latency';
import { RIBBON_WILD_ENABLED, UI_DATA_MODE, UI_MEDIA } from './lib/product';
import { ScrollSync } from './lib/scroll-sync';
import type { UiActionId } from './lib/ui-actions';
import { practicalCapabilityForAction } from './lib/practical.ts';
import type { PracticalCapability } from './intelligence/types.ts';
import { wildCapabilityForAction } from './lib/wild.ts';
import type { WildCapability } from './wild/types.ts';
import type { PreviewStats } from './markdown/preview';
import type { Heading } from './markdown/types';

const Benchmark = lazy(() =>
  import('./pages/Benchmark').then((module) => ({ default: module.Benchmark })),
);
const DesignSystem = lazy(() =>
  import('./design-system/DesignSystem').then((module) => ({ default: module.DesignSystem })),
);
const Workspace = lazy(() =>
  import('./components/workspace/Workspace').then((module) => ({ default: module.Workspace })),
);
const AppOverlays = lazy(() =>
  import('./components/overlays/AppOverlays').then((module) => ({ default: module.AppOverlays })),
);
const CommandProvider = lazy(() =>
  import('./commands/react').then((module) => ({ default: module.CommandProvider })),
);
const AppRail = lazy(() =>
  import('./components/chrome/AppRail').then((module) => ({ default: module.AppRail })),
);
const AgentPill = lazy(() =>
  import('./components/agent/AgentPill').then((module) => ({ default: module.AgentPill })),
);
const DraftToolsSheet = lazy(() =>
  import('./components/chrome/DraftToolsSheet').then((module) => ({ default: module.DraftToolsSheet })),
);
const LinkPage = lazy(() =>
  import('./pages/Link').then((module) => ({ default: module.LinkPage })),
);
const Home = lazy(() =>
  import('./pages/Home').then((module) => ({ default: module.Home })),
);
const ContextMenu = lazy(() =>
  import('./components/overlays/ContextMenu').then((module) => ({ default: module.ContextMenu })),
);
const Outline = lazy(() =>
  import('./components/workspace/Outline').then((module) => ({ default: module.Outline })),
);
const PerfHud = lazy(() =>
  import('./components/overlays/PerfHud').then((module) => ({ default: module.PerfHud })),
);
const PracticalInspector = lazy(() =>
  import('./components/practical/PracticalInspector').then((module) => ({ default: module.PracticalInspector })),
);
const WildStudio = RIBBON_WILD_ENABLED
  ? lazy(() => import('./components/wild/WildStudio').then((module) => ({ default: module.WildStudio })))
  : null;
const WildTelemetry = RIBBON_WILD_ENABLED
  ? lazy(() => import('./components/wild/WildTelemetry').then((module) => ({ default: module.WildTelemetry })))
  : null;

/** How often the HUD and word counts refresh. Editing never waits on this. */
const SAMPLE_INTERVAL_MS = 400;

const MODE_ORDER: ViewMode[] = ['edit', 'split', 'preview'];
const IMPORT_FILE_PATTERN = /\.(?:md|markdown|pdf|doc|docx|xls|xlsx)$/iu;
const IMPORT_FILE_ACCEPT = '.md,.markdown,.pdf,.doc,.docx,.xls,.xlsx,text/markdown,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isImportableFile(file: Pick<File, 'name'>): boolean {
  return IMPORT_FILE_PATTERN.test(file.name);
}

function transferMayContainImport(dataTransfer: DataTransfer): boolean {
  return [...dataTransfer.items].some((item) => {
    if (item.kind !== 'file') return false;
    const file = item.getAsFile();
    return file ? isImportableFile(file) : item.type === '' || /(?:pdf|word|excel|spreadsheet|markdown)/iu.test(item.type);
  });
}

function exportStem(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    || 'marks-document';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // WebKit can begin reading the object URL after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
  const [serviceCallerResolved, setServiceCallerResolved] = useState(UI_DATA_MODE !== 'service');
  const [serviceCallerError, setServiceCallerError] = useState<string | null>(null);
  useEffect(() => subscribeActiveCaller((caller) => {
    // A completed pairing can outlive its dialog. Keep the application state
    // aligned with the authoritative caller even when that surface unmounts
    // in the same turn as the server commits the session.
    if (!caller) return;
    setServiceCaller(caller);
    setServiceCallerResolved(true);
    setServiceCallerError(null);
  }), []);
  useEffect(() => {
    void getOrCreatePendingDevice().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (UI_DATA_MODE !== 'service') return;
    let cancelled = false;
    void ensureServiceCaller()
      .then(async (caller) => {
        if (cancelled) return;
        setServiceCaller(caller);
        setServiceCallerResolved(true);
        setServiceCallerError(null);
        if (caller.kind === 'scratch') {
          void bindPendingDevice().catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServiceCaller(null);
          setServiceCallerResolved(true);
          setServiceCallerError('Marks could not reach the document service in time.');
        }
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
  const [preparedMarketingPresentation, setPreparedMarketingPresentation] = useState<string | null>(null);
  const [dragImportActive, setDragImportActive] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [ribbonCollapsed, setRibbonCollapsed] = useState(
    () => localStorage.getItem('marks:ribbon-collapsed') === 'true',
  );
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [draftToolsOpen, setDraftToolsOpen] = useState(false);
  const [practicalSurface, setPracticalSurface] = useState<PracticalCapability | null>(null);
  const [wildSurface, setWildSurface] = useState<WildCapability | null>(null);
  const [reviewSurface, setReviewSurface] = useState<ReviewSurface | null>(null);
  const [overlaysMounted, setOverlaysMounted] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [pairing, setPairing] = useState(() => readPairingHash(location.hash));
  const [shareGrant, setShareGrant] = useState(() => readDocumentShareHash(location.hash));
  const redeemingShare = useRef<string | null>(null);
  useEffect(() => {
    if (!location.hash.startsWith('#v1.')) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }, []);

  const documents = useDocuments(route.name !== 'benchmark' && route.name !== 'design-system');
  const docId = route.name === 'document' ? route.id : null;
  const { meta, engine, supported, resolved, error: metadataError } = useDocumentMeta(docId);
  const marketingDocument =
    isAboutDocument(docId) ||
    (meta?.id === docId && meta.public === true && meta.title === ABOUT_DOCUMENT_TITLE);
  const marketingPresentationKey = marketingDocument && docId
    ? `${docId}:${phone ? 'phone' : 'wide'}`
    : null;
  const preparingMarketingPresentation =
    marketingPresentationKey !== null && preparedMarketingPresentation !== marketingPresentationKey;
  const { session, status, peers, hydrated, error: sessionError } = useSession(
    resolved && supported ? docId : null,
    user,
    documentAccess,
  );

  const scrollSync = useMemo(() => new ScrollSync(), []);
  const tracker = useRef(new LatencyTracker(240));
  const latest = useRef<PreviewStats | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const dragImportDepth = useRef(0);
  const initialAnonymousPageStarted = useRef(false);
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
  const [cursor, setCursor] = useState<CursorInfo>({
    line: 1,
    column: 1,
    selected: 0,
    from: 0,
    to: 0,
    context: { kind: 'text' },
  });
  useEffect(() => localStorage.setItem('marks:mode', mode), [mode]);

  useEffect(() => {
    if (!marketingPresentationKey) {
      setPreparedMarketingPresentation(null);
      return;
    }
    // Both the built-in /welcome document and the anonymous editable clone
    // mount only after their initial presentation is ready. That keeps Import
    // selected even on a cold, copy-pasted slug; later user mode changes do not
    // retrigger this effect.
    setMode(phone ? 'preview' : 'split');
    setPreparedMarketingPresentation(marketingPresentationKey);
  }, [marketingPresentationKey, phone]);

  useEffect(() => {
    localStorage.setItem('marks:ribbon-collapsed', String(ribbonCollapsed));
  }, [ribbonCollapsed]);

  useEffect(() => {
    if (phone && mode === 'split') setMode('edit');
  }, [mode, phone]);

  useEffect(() => {
    setSidebarOpen(!overlayNavigation);
  }, [overlayNavigation]);

  useEffect(() => {
    if (!session) {
      setSnapshot({ ...EMPTY_SNAPSHOT, engine });
      return;
    }
    tracker.current.reset();

    const sample = () => {
      const stats = latest.current;
      const engineStats = session.stats();
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
        chars: stats?.chars ?? session.length(),
        words: stats?.words ?? 0,
        snapshotBytes: engineStats.snapshotBytes,
        sent: engineStats.sent,
        received: engineStats.received,
        lastUpdateBytes: engineStats.lastUpdateBytes,
        retainedOperations: engineStats.retainedOperations,
        pendingOperations: engineStats.pendingOperations,
        currentDmax: engineStats.currentDmax,
        parseMode: stats?.parseMode ?? '',
        localSaved: engineStats.localSaved,
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

  const activeDocument = meta ?? documents.documents.find((entry) => entry.id === docId) ?? null;
  const activeDocumentPublic = activeDocument?.public === true;
  const title = activeDocument?.title ?? (docId ? 'Untitled' : 'marks');
  const workspaceKind = UI_DATA_MODE === 'local'
    ? 'local' as const
    : serviceCaller?.kind === 'session'
      ? 'session' as const
      : 'scratch' as const;

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

  useEffect(() => {
    if (!session?.onError) return;
    return session.onError((error) => {
      notify('Could not apply that edit', error.message, 'danger');
    });
  }, [session, notify]);

  const openDialog = useCallback((next: AppDialog) => {
    setOverlaysMounted(true);
    setDialog(next);
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeReview = useCallback(() => setReviewSurface(null), []);

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

  useEffect(() => {
    const sync = () => setShareGrant(readDocumentShareHash(location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    if (route.name !== 'document' || !shareGrant) return;
    if (shareGrant === 'invalid') {
      notify('Share link invalid', 'The fragment is malformed and no authority was sent to the server.', 'danger');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      setShareGrant(null);
      return;
    }
    if (UI_DATA_MODE !== 'service') {
      notify('Sharing unavailable', 'This build is using a browser-local workspace.', 'danger');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      setShareGrant(null);
      return;
    }
    if (serviceCaller?.kind !== 'session') {
      openDialog({ type: 'keep-workspace' });
      return;
    }
    const key = `${route.id}:${shareGrant}`;
    if (redeemingShare.current === key) return;
    redeemingShare.current = key;
    void loadServiceApi()
      .then((api) => api.redeemDocumentLink(route.id, shareGrant))
      .then(({ role }) => {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        setShareGrant(null);
        signalDocumentRepositoryChange();
        void documents.refresh();
        notify('Access granted', `This account joined as ${role}.`, 'success');
      })
      .catch((error) => {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        setShareGrant(null);
        const copy = error instanceof Error && 'copy' in error
          ? (error as { copy: { title: string; detail: string; tone: 'neutral' | 'danger' } }).copy
          : SERVICE_ERROR_COPY[401];
        notify(copy.title, copy.detail, copy.tone);
      })
      .finally(() => {
        redeemingShare.current = null;
      });
  }, [documents.refresh, notify, openDialog, route, serviceCaller, shareGrant]);

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
      notify(
        'Document created',
        UI_DATA_MODE === 'service'
          ? `${created.title} and its initial Markdown were committed atomically.`
          : `${created.title} is saved in this browser.`,
        'success',
      );
    } catch {
      setUiError('Marks could not create that document. Your current screen is still available.');
    }
  }, [documents, notify, openDocument]);

  useEffect(() => {
    if (
      route.name !== 'home' ||
      UI_DATA_MODE !== 'service' ||
      !serviceCallerResolved ||
      serviceCaller?.kind !== 'scratch' ||
      initialAnonymousPageStarted.current
    ) {
      return;
    }
    initialAnonymousPageStarted.current = true;
    void runWithTimeout(
      async (signal) => {
        const { ABOUT_DOCUMENT } = await import('./content/marketing-markdown');
        if (signal.aborted) throw signal.reason;
        return documents.create({
          title: ABOUT_DOCUMENT_TITLE,
          content: ABOUT_DOCUMENT,
        });
      },
      SERVICE_REQUEST_TIMEOUT_MS,
      null,
      new DOMException('The starter page took too long to create.', 'TimeoutError'),
    )
      .then((created) => {
        if (location.pathname === '/') {
          setMode(phone ? 'preview' : 'split');
          setPreparedMarketingPresentation(`${created.id}:${phone ? 'phone' : 'wide'}`);
          navigate({ name: 'document', id: created.id }, { replace: true });
        }
      })
      .catch(() => {
        initialAnonymousPageStarted.current = false;
        setUiError('Marks could not create a public page. Try reloading this tab.');
      });
  }, [documents.create, navigate, phone, route.name, serviceCaller, serviceCallerResolved]);

  useEffect(() => {
    if (route.name !== 'home') initialAnonymousPageStarted.current = false;
  }, [route.name]);

  const importDocumentFile = useCallback(async (file: File) => {
    if (!isImportableFile(file)) {
      notify('Import refused', 'Choose Markdown, PDF, Word, or Excel.', 'danger');
      return;
    }
    try {
      if (/\.pdf$/iu.test(file.name)) {
        const { readPdfImport } = await import('./lib/wasm-document-import');
        await createDocument(await readPdfImport(file));
        return;
      }
      if (UI_DATA_MODE === 'local') {
        const { readMarkdownImport } = await import('./lib/markdown-import');
        await createDocument(await readMarkdownImport(file));
        return;
      }
      const imported = await (await loadServiceApi()).importDocumentFile(file);
      await createDocument({ title: imported.title, content: imported.markdown });
    } catch (error) {
      notify(
        error instanceof Error && error.name === 'MarkdownImportError' ? 'Import refused' : 'Import failed',
        error instanceof Error ? error.message : 'Marks could not convert that document.',
        'danger',
      );
    }
  }, [createDocument, notify]);

  const importFromUrl = useCallback(async (url: string) => {
    if (UI_DATA_MODE !== 'service') {
      notify('URL import unavailable', 'This local-only build has no protected web importer.', 'danger');
      return;
    }
    try {
      const imported = await (await loadServiceApi()).importWebPage(url);
      await createDocument({ title: imported.title, content: imported.markdown });
    } catch (error) {
      notify(
        'URL import failed',
        error instanceof Error ? error.message : 'Marks could not convert that public web page.',
        'danger',
      );
    }
  }, [createDocument, notify]);

  const renameDocument = useCallback(
    async (id: string, nextTitle: string) => {
      try {
        const renamed = await documents.rename(id, nextTitle);
        if (!renamed) throw new Error('missing document');
        setDialog(null);
        notify('Document renamed', `Now called “${renamed.title}”.`, 'success');
      } catch {
        notify('Rename unavailable', 'The active data adapter could not rename this document.', 'danger');
      }
    },
    [documents, notify],
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
        notify(
          'Document moved to trash',
          UI_DATA_MODE === 'service'
            ? 'Its live room closed; the owner can restore it for 30 days.'
            : 'It remains recoverable in this browser for 30 days.',
          'success',
        );
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
    setPracticalSurface(null);
    setWildSurface(null);
    if (overlayNavigation) setSidebarOpen(false);
    navigate({ name: 'benchmark' });
  }, [navigate, overlayNavigation]);

  const exportPortableBundle = useCallback(async () => {
    if (!docId || !session) return;
    try {
      await session.whenDurable();
      const blob = UI_DATA_MODE === 'service'
        ? await (await loadServiceApi()).downloadDocumentBundle(docId)
        : await (await import('./data/assets')).createLocalPortableBundle(docId, session.getText());
      const filename = `${exportStem(title)}.zip`;
      downloadBlob(blob, filename);
      notify('Portable bundle exported', `${filename} contains Markdown and referenced images.`, 'success');
    } catch (error) {
      notify(
        'Bundle export failed',
        error instanceof Error ? error.message : 'Marks could not assemble the portable archive.',
        'danger',
      );
    }
  }, [docId, notify, session, title]);

  const runAction = useCallback(
    (action: UiActionId) => {
      const practical = practicalCapabilityForAction(action);
      if (practical) {
        if (!docId || !session) return;
        setPracticalSurface(practical);
        setWildSurface(null);
        setReviewSurface(null);
        setDraftToolsOpen(false);
        return;
      }
      const wild = RIBBON_WILD_ENABLED ? wildCapabilityForAction(action) : null;
      if (wild) {
        if (!docId || !session) return;
        setWildSurface(wild);
        setPracticalSurface(null);
        setReviewSurface(null);
        setDraftToolsOpen(false);
        return;
      }
      switch (action) {
        case 'new':
          void createDocument();
          break;
        case 'templates':
          openDialog({ type: 'templates' });
          break;
        case 'import':
          importRef.current?.click();
          break;
        case 'template-notes':
          void createDocument({ templateId: 'notes' });
          break;
        case 'template-meeting':
          void createDocument({ templateId: 'meeting' });
          break;
        case 'template-github-readme':
          void createDocument({ templateId: 'github-readme' });
          break;
        case 'import-url':
          openDialog({ type: 'import-url' });
          break;
        case 'rename':
          if (docId && (UI_DATA_MODE === 'local' || session?.capabilities().role === 'owner')) {
            openDialog({ type: 'rename', documentId: docId, title });
          } else {
            notify('Rename unavailable', 'Only the document owner can change its catalog title.', 'danger');
          }
          break;
        case 'duplicate':
          void duplicateDocument();
          break;
        case 'download': {
          if (!session) break;
          const blob = new Blob([session.getText()], { type: 'text/markdown;charset=utf-8' });
          const filename = `${exportStem(title)}.md`;
          downloadBlob(blob, filename);
          notify('Markdown exported', filename, 'success');
          break;
        }
        case 'download-bundle':
          void exportPortableBundle();
          break;
        case 'print':
          setMode('preview');
          window.setTimeout(() => window.print(), 180);
          break;
        case 'delete':
          if (isAboutDocument(docId)) {
            notify('Built-in document', 'The Google Docs for Markdown page is part of the app and cannot be trashed.', 'neutral');
          } else if (docId && (UI_DATA_MODE === 'local' || session?.capabilities().role === 'owner' || session?.capabilities().role === 'scratch')) {
            openDialog({ type: 'delete', documentId: docId, title });
          } else {
            notify('Delete unavailable', 'Only the document owner can delete this page.', 'danger');
          }
          break;
        case 'trash':
          openDialog({ type: 'trash' });
          break;
        case 'share':
          if (docId) {
            openDialog({
              type: 'share',
              documentId: docId,
              title,
              publicPage: activeDocumentPublic,
            });
          }
          break;
        case 'comments':
        case 'history':
          if (!docId) break;
          if (UI_DATA_MODE === 'service' && session?.capabilities().role === 'scratch') {
            openDialog({ type: 'keep-workspace' });
            notify(
              'Log In First',
              'This public page can be edited anonymously, but named review history belongs to an account.',
              'neutral',
            );
            break;
          }
          setOverlaysMounted(true);
          setPracticalSurface(null);
          setWildSurface(null);
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
              setPracticalSurface(null);
              setWildSurface(null);
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
          if (UI_DATA_MODE === 'service') openDialog({ type: 'keep-workspace' });
          else notify('Local-only build', 'This build has no identity service for login or account sharing.', 'neutral');
          break;
        case 'account':
          if (UI_DATA_MODE === 'service') openDialog({ type: 'account' });
          else notify('Local-only build', 'Account and device controls require the Rust identity service.', 'neutral');
          break;
        case 'pairing':
          if (UI_DATA_MODE === 'service') navigate({ name: 'link' });
          else notify('Local-only build', 'Login approval requires the Rust identity service.', 'neutral');
          break;
        case 'logout':
          if (UI_DATA_MODE === 'service' && serviceCaller?.kind === 'session') {
            void import('./auth/identity')
              .then(({ logout }) => logout())
              .then(() => {
                setServiceCaller(null);
                setServiceCallerResolved(false);
                setServiceCallerError(null);
                void ensureServiceCaller({ forceProbe: true })
                  .then((caller) => {
                    setServiceCaller(caller);
                    setServiceCallerResolved(true);
                    setServiceCallerError(null);
                  })
                  .catch(() => {
                    setServiceCallerResolved(true);
                    setServiceCallerError('Marks could not reach the document service in time.');
                  });
                notify('Logged Out', 'This browser is anonymous again. Public page URLs still work.', 'success');
                void documents.refresh();
              })
              .catch(() => notify(SERVICE_ERROR_COPY[403].title, SERVICE_ERROR_COPY[403].detail, 'danger'));
            break;
          }
          void import('./lib/identity-copy').then(({ LOGOUT_LOCAL_LINE }) => {
            notify(SERVICE_ERROR_COPY[401].title, LOGOUT_LOCAL_LINE, 'neutral');
          });
          break;
        case 'find': {
          const view = viewRef.current;
          if (view) void import('./editor/actions').then(({ openFind }) => openFind(view));
          break;
        }
        case 'draft-tools':
          if (session?.capabilities().edit) {
            setPracticalSurface(null);
            setWildSurface(null);
            setDraftToolsOpen(true);
          }
          else notify('Draft tools are read-only', 'Your current role cannot change this document.', 'neutral');
          break;
      }
    },
    [
      createDocument,
      activeDocumentPublic,
      docId,
      duplicateDocument,
      exportPortableBundle,
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
      documents,
      serviceCaller,
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
        : route.name === 'design-system'
          ? 'Design system · marks'
        : route.name === 'link'
          ? 'Log In · marks'
          : route.name === 'document'
            ? `${title} · marks`
            : 'marks — collaborative writing at thought speed';
  }, [title, route.name]);

  useEffect(() => {
    if (route.name === 'document') return;
    setFocusMode(false);
    setReviewSurface(null);
    setOutlineOpen(false);
    setDraftToolsOpen(false);
    setPracticalSurface(null);
    setWildSurface(null);
  }, [route.name]);

  useEffect(() => {
    setReviewSurface(null);
    setDraftToolsOpen(false);
    setPracticalSurface(null);
    setWildSurface(null);
  }, [docId]);

  const commandEnvironment = useMemo<CommandEnvironment>(() => ({
    hasDocument: Boolean(docId && session),
    hydrated,
    capabilities: session?.capabilities() ?? null,
    workspaceKind,
    mode,
    activePane: surface.lastSurface === 'preview' ? 'preview' : 'editor',
    shell: posture.shell,
    context: cursor.context.kind,
    selectionLength: cursor.selected,
    selectionFrom: cursor.from,
    selectionTo: cursor.to,
    voiceSupported: surface.voiceSupported,
    voiceActive: surface.voiceStatus === 'listening',
    theme,
    outlineOpen,
    hudOpen,
    ribbonCollapsed,
    reviewOpen: reviewSurface?.type ?? null,
    formatPainterArmed: false,
  }), [
    cursor.context.kind,
    cursor.from,
    cursor.selected,
    cursor.to,
    docId,
    hydrated,
    hudOpen,
    ribbonCollapsed,
    mode,
    outlineOpen,
    posture.shell,
    reviewSurface?.type,
    session,
    surface.lastSurface,
    surface.voiceStatus,
    surface.voiceSupported,
    theme,
    workspaceKind,
  ]);

  const commandServices = useMemo(() => ({
    session,
    getView,
    onAction: runAction,
    onModeChange: setMode,
    onToggleOutline: () => setOutlineOpen((open) => !open),
    onToggleHud: () => setHudOpen((open) => !open),
    onToggleTheme: toggleTheme,
    onToggleRibbon: () => setRibbonCollapsed((collapsed) => !collapsed),
    onToggleVoice: session?.capabilities().edit ? surface.toggleVoice : undefined,
  }), [getView, runAction, session, surface.toggleVoice, toggleTheme]);

  if (route.name === 'design-system') {
    return (
      <Suspense fallback={<div className="empty-state">Loading design system…</div>}>
        <DesignSystem onBack={() => navigate({ name: 'home' })} />
      </Suspense>
    );
  }

  const openingAnonymousEntry =
    UI_DATA_MODE === 'service' &&
    route.name === 'home' &&
    serviceCallerError === null &&
    (!serviceCallerResolved || (serviceCaller?.kind === 'scratch' && uiError === null));
  const openingPage =
    openingAnonymousEntry || (route.name === 'document' && (!resolved || preparingMarketingPresentation));

  const appSurface = (
    <div
      className={`app route-${route.name}${sidebarOpen && !focusMode && !posture.foldable ? ' with-sidebar' : ''}${focusMode ? ' focus-mode' : ''}${ribbonCollapsed ? ' ribbon-collapsed' : ''}${practicalSurface ? ' practical-open' : ''}${wildSurface ? ' wild-open' : ''}${dragImportActive ? ' drag-import-active' : ''}`}
      data-shell={posture.shell}
      data-doc={docId ?? undefined}
      data-marketing={marketingDocument ? 'true' : undefined}
      onDragEnterCapture={(event) => {
        if (!transferMayContainImport(event.dataTransfer)) return;
        dragImportDepth.current += 1;
        setDragImportActive(true);
      }}
      onDragOverCapture={(event) => {
        if (!transferMayContainImport(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeaveCapture={() => {
        dragImportDepth.current = Math.max(0, dragImportDepth.current - 1);
        if (dragImportDepth.current === 0) setDragImportActive(false);
      }}
      onDropCapture={(event) => {
        dragImportDepth.current = 0;
        setDragImportActive(false);
        const file = [...event.dataTransfer.files].find(isImportableFile);
        if (!file) return;
        event.preventDefault();
        event.stopPropagation();
        void importDocumentFile(file);
      }}
    >
      {dragImportActive && (
        <div className="document-drop-target" role="status" aria-live="polite">
          <span><Icon path={icons.download} size={24} /></span>
          <strong>Drop to import as Markdown</strong>
          <small>PDF, Word, Excel, or Markdown</small>
        </div>
      )}
      {!openingPage && sidebarOpen && !focusMode && !posture.foldable && (
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
            if (document && !isAboutDocument(id)) openDialog({ type: 'delete', documentId: id, title: document.title });
          }}
          onOpenTrash={() => openDialog({ type: 'trash' })}
          onOpenBenchmark={openBenchmark}
          onOpenAbout={() => {
            openDocument(ABOUT_DOCUMENT_ID);
            if (!phone) setMode('split');
          }}
        />
      )}

      <main className={`main route-${route.name}`}>
        {posture.foldable && route.name === 'document' && !focusMode && (
          <Suspense fallback={null}>
            <AppRail />
          </Suspense>
        )}
        {!openingPage && <TopBar
          title={route.name === 'benchmark' ? 'Engine benchmark' : route.name === 'link' ? 'Log In' : title}
          docId={docId}
          route={route.name}
          documentReady={Boolean(session && hydrated && session.capabilities().edit)}
          session={session}
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
          workspaceKind={workspaceKind}
          focusMode={focusMode}
          ribbonCollapsed={ribbonCollapsed}
          onModeChange={setMode}
          onToggleSidebar={toggleSidebar}
          onToggleTheme={toggleTheme}
          onToggleHud={() => setHudOpen((open) => !open)}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onToggleRibbon={() => setRibbonCollapsed((collapsed) => !collapsed)}
          onAction={runAction}
          onOpenDraftTools={() => setDraftToolsOpen(true)}
          onNotify={notify}
          onVoice={session?.capabilities().edit ? surface.toggleVoice : undefined}
          voiceActive={surface.voiceStatus === 'listening'}
          voiceSupported={surface.voiceSupported}
        />}

        {route.name === 'benchmark' ? (
          <Suspense fallback={<div className="empty-state">Loading benchmark…</div>}>
            <Benchmark onBack={() => navigate({ name: 'home' })} />
          </Suspense>
        ) : route.name === 'link' ? (
          <Suspense fallback={<div className="empty-state">Opening Log In…</div>}>
            <LinkPage
              pairing={pairing}
              onNotify={notify}
              onKeep={() => openDialog({ type: 'keep-workspace' })}
            />
          </Suspense>
        ) : openingPage ? (
          <OpeningShell cached={false} offline={surface.network === 'offline'} />
        ) : UI_DATA_MODE === 'service' && (serviceCallerError || (route.name === 'home' && uiError)) ? (
          <div className="empty-state">
            <div className="empty-card">
              <h2>Page could not open</h2>
              <p>{serviceCallerError ?? uiError} Check the connection, then try again.</p>
              <button type="button" className="button primary" onClick={() => location.reload()}>
                Try again
              </button>
            </div>
          </div>
        ) : docId && resolved && (metadataError || sessionError) ? (
          <div className="empty-state">
            <div className="empty-card">
              <h2>Document connection failed</h2>
              <p>{metadataError ?? sessionError} Your URL is unchanged; try the connection again.</p>
              <button type="button" className="button primary" onClick={() => location.reload()}>
                Try again
              </button>
            </div>
          </div>
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
            onContextMenuCapture={surface.onContextMenu}
            onPointerDownCapture={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('.preview-pane')) surface.setLastSurface('preview');
              else if (target.closest('.editor-pane')) surface.setLastSurface('editor');
            }}
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
                onAssetError={(error) => notify('Image not inserted', error.message, 'danger')}
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
          <Suspense fallback={<OpeningShell cached={false} offline={surface.network === 'offline'} />}>
            <Home
              documents={documents.documents}
              loading={documents.loading}
              workspaceKind={workspaceKind === 'session' ? 'account' : workspaceKind}
              onCreate={() => void createDocument()}
              onCreateFromTemplate={(templateId) => void createDocument({ templateId })}
              onOpen={openDocument}
              onOpenTemplates={() => openDialog({ type: 'templates' })}
              onImport={() => importRef.current?.click()}
              onOpenBenchmark={openBenchmark}
              onOpenPreferences={() => openDialog({ type: 'preferences' })}
              onKeepWorkspace={() => openDialog({ type: 'keep-workspace' })}
            />
          </Suspense>
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

      {route.name === 'document' && !focusMode && !posture.phone && !posture.foldable && (
        <LiquidDock
          onCommands={() => runAction('command-palette')}
          onComments={() => runAction('comments')}
          onHistory={() => runAction('history')}
          onVoice={session?.capabilities().edit ? surface.toggleVoice : undefined}
          voiceActive={surface.voiceStatus === 'listening'}
          voiceSupported={surface.voiceSupported}
        />
      )}

      {surface.contextMenu && (
        <Suspense fallback={null}>
          <ContextMenu
            x={surface.contextMenu.x}
            y={surface.contextMenu.y}
            actions={surface.contextMenu.actions}
            onClose={surface.closeContextMenu}
          />
        </Suspense>
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
          <Suspense fallback={null}>
            <Outline headings={headings} onSelect={(line) => scrollSync.scrollToLine(line)} />
          </Suspense>
        </aside>
      )}

      {hudOpen && (
        <Suspense fallback={null}>
          <PerfHud
            snapshot={snapshot}
            onClose={() => setHudOpen(false)}
            onOpenBenchmark={openBenchmark}
          />
        </Suspense>
      )}

      {draftToolsOpen && route.name === 'document' && (
        <Suspense fallback={null}>
          <aside className={phone ? 'phone-draft-tools-layer' : 'draft-tools-float'} aria-label="Local draft tools">
            <DraftToolsSheet
              open
              documentTitle={title}
              getView={getView}
              onClose={() => setDraftToolsOpen(false)}
              onNotify={notify}
            />
          </aside>
        </Suspense>
      )}

      {practicalSurface && route.name === 'document' && session && (
        <Suspense fallback={null}>
          <PracticalInspector
            capability={practicalSurface}
            documentId={route.id}
            documentTitle={title}
            session={session}
            documents={documents.documents}
            userName={user.name}
            status={status}
            peers={peers}
            shell={posture.shell}
            mode={mode}
            selection={{ from: cursor.from, to: cursor.to }}
            getView={getView}
            onModeChange={setMode}
            onSelect={setPracticalSurface}
            onOpenDocument={(id) => {
              setPracticalSurface(null);
              openDocument(id);
            }}
            onClose={() => setPracticalSurface(null)}
            onNotify={notify}
          />
        </Suspense>
      )}

      {RIBBON_WILD_ENABLED && WildStudio && wildSurface && route.name === 'document' && session && (
        <Suspense fallback={null}>
          <WildStudio
            capability={wildSurface}
            documentId={route.id}
            documentTitle={title}
            session={session}
            userName={user.name}
            shell={posture.shell}
            mode={mode}
            selection={{ from: cursor.from, to: cursor.to }}
            getView={getView}
            onModeChange={setMode}
            onSelect={setWildSurface}
            onOpenDocument={(id) => {
              setWildSurface(null);
              openDocument(id);
            }}
            onClose={() => setWildSurface(null)}
            onNotify={notify}
          />
        </Suspense>
      )}

      {RIBBON_WILD_ENABLED && WildTelemetry && route.name === 'document' && session && (
        <Suspense fallback={null}>
          <WildTelemetry
            documentId={route.id}
            session={session}
            onOpenCausal={() => {
              setPracticalSurface(null);
              setReviewSurface(null);
              setDraftToolsOpen(false);
              setWildSurface('causal');
            }}
          />
        </Suspense>
      )}

      {route.name === 'document' && session && !focusMode && (
        <Suspense fallback={null}>
          <AgentPill documentId={route.id} linkedSurface={practicalSurface ?? wildSurface} />
        </Suspense>
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
            phone={phone}
            dataMode={UI_DATA_MODE}
            capabilities={session?.capabilities() ?? null}
            onCloseDialog={closeDialog}
            onCloseReview={closeReview}
            onAction={runAction}
            onCreateFromTemplate={(templateId: TemplateId) => void createDocument({ templateId })}
            onImportUrl={importFromUrl}
            onRename={(id, nextTitle) => void renameDocument(id, nextTitle)}
            onDelete={(id) => void removeDocument(id)}
            onDocumentsChanged={() => void documents.refresh()}
            onTheme={setTheme}
            onPreferences={setPreferences}
            onNotify={notify}
            onPromoted={() => {
              setServiceCaller({ kind: 'session' });
              setDialog(null);
              void documents.refresh();
            }}
            onSignedOut={() => {
              setServiceCaller(null);
              setServiceCallerResolved(false);
              setServiceCallerError(null);
              void ensureServiceCaller({ forceProbe: true })
                .then((caller) => {
                  setServiceCaller(caller);
                  setServiceCallerResolved(true);
                  setServiceCallerError(null);
                })
                .catch(() => {
                  setServiceCallerResolved(true);
                  setServiceCallerError('Marks could not reach the document service in time.');
                });
              void documents.refresh();
            }}
          />
        </Suspense>
      )}

      <ToastRegion
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
      <input
        ref={importRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        className="document-import-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void importDocumentFile(file);
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
  if (route.name !== 'document') return appSurface;
  return (
    <Suspense fallback={<div className="app route-document"><OpeningShell cached={Boolean(meta)} offline={surface.network === 'offline'} /></div>}>
      <CommandProvider key={route.id} documentId={route.id} environment={commandEnvironment} services={commandServices} onNotify={notify}>
        {appSurface}
      </CommandProvider>
    </Suspense>
  );
}
