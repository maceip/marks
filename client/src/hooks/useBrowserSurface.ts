import type { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createLongPress,
  hasDomSelection,
  readClipboardMarkdown,
  readNetworkQuality,
  selectElementContents,
  shouldHandleSelectAll,
  shouldOfferCustomMenu,
  speechRecognitionCtor,
  subscribeNetwork,
  surfaceFromTarget,
  writeClipboard,
  type NetworkQuality,
  type Surface,
  type VoiceStatus,
} from '../browser';
import type { CollabSession } from '../collab/types';
import type { ContextMenuAction } from '../components/ContextMenu';
import { insertAtSelection } from '../editor/commands';
import { VoiceSession } from '../browser/voice';

export interface ContextMenuState {
  x: number;
  y: number;
  actions: ContextMenuAction[];
}

export interface BrowserSurface {
  lastSurface: Surface;
  setLastSurface: (surface: Surface) => void;
  contextMenu: ContextMenuState | null;
  closeContextMenu: () => void;
  onContextMenu: (event: React.MouseEvent | MouseEvent) => void;
  commentsOpen: boolean;
  setCommentsOpen: (open: boolean) => void;
  draftQuote: string;
  beginComment: () => void;
  submitComment: (body: string) => void;
  cancelDraft: () => void;
  voiceStatus: VoiceStatus;
  voiceInterim: string;
  toggleVoice: () => void;
  stopVoice: () => void;
  voiceSupported: boolean;
  network: NetworkQuality;
  hydrated: boolean;
}

export function useBrowserSurface(
  session: CollabSession | null,
  getView: () => EditorView | null,
  getPreview: () => HTMLElement | null,
): BrowserSurface {
  const [lastSurface, setLastSurface] = useState<Surface>('editor');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draftQuote, setDraftQuote] = useState('');
  const draftRange = useRef<{ from: number; to: number; quote: string } | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(
    speechRecognitionCtor() ? 'idle' : 'unsupported',
  );
  const [voiceInterim, setVoiceInterim] = useState('');
  const [network, setNetwork] = useState<NetworkQuality>(readNetworkQuality);
  const [hydrated, setHydrated] = useState(false);
  const voiceRef = useRef<VoiceSession | null>(null);

  useEffect(() => subscribeNetwork(setNetwork), []);

  useEffect(() => {
    if (!session) {
      setHydrated(false);
      return;
    }
    setHydrated(session.hydrated());
    return session.onHydrated(() => setHydrated(true));
  }, [session]);

  useEffect(() => {
    const voice = new VoiceSession({
      onStatus: setVoiceStatus,
      onTranscript: ({ finalText, interimText }) => {
        setVoiceInterim(interimText);
        if (!finalText) return;
        const view = getView();
        if (!view) return;
        const suffix = /\s$/.test(finalText) ? '' : ' ';
        insertAtSelection(view, finalText + suffix, 'input.voice');
      },
    });
    voiceRef.current = voice;
    return () => voice.destroy();
  }, [getView]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const beginComment = useCallback(() => {
    const view = getView();
    if (!view || !session) return;
    const range = view.state.selection.main;
    if (range.empty) return;
    const quote = view.state.sliceDoc(range.from, range.to);
    draftRange.current = { from: range.from, to: range.to, quote };
    setDraftQuote(quote);
    setCommentsOpen(true);
  }, [getView, session]);

  const submitComment = useCallback(
    (body: string) => {
      if (!session || !draftRange.current) return;
      session.addComment({ ...draftRange.current, body });
      draftRange.current = null;
      setDraftQuote('');
    },
    [session],
  );

  const cancelDraft = useCallback(() => {
    draftRange.current = null;
    setDraftQuote('');
  }, []);

  const toggleVoice = useCallback(() => voiceRef.current?.toggle(), []);
  const stopVoice = useCallback(() => voiceRef.current?.stop(), []);

  const buildActions = useCallback(
    (surface: 'editor' | 'preview'): ContextMenuAction[] => {
      const view = getView();
      const preview = getPreview();
      const selected = view ? !view.state.selection.main.empty : hasDomSelection();

      const copyEditor = () => {
        if (!view) return;
        const range = view.state.selection.main;
        const text = range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to);
        void writeClipboard({ text, markdown: text });
      };

      const cutEditor = () => {
        if (!view || view.state.selection.main.empty) return;
        const range = view.state.selection.main;
        const text = view.state.sliceDoc(range.from, range.to);
        void writeClipboard({ text, markdown: text });
        view.dispatch({ changes: { from: range.from, to: range.to, insert: '' }, userEvent: 'delete.cut' });
      };

      const pasteEditor = () => {
        void readClipboardMarkdown().then((text) => {
          if (text && getView()) insertAtSelection(getView()!, text, 'input.paste');
        });
      };

      const selectAllEditor = () => {
        if (!view) return;
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
      };

      const copyPreview = () => {
        const selection = document.getSelection();
        const text = selection && !selection.isCollapsed ? selection.toString() : preview?.innerText ?? '';
        const html = selection && !selection.isCollapsed ? serializeSelectionHtml() : preview?.innerHTML ?? '';
        void writeClipboard({ text, html, markdown: session?.getText() });
      };

      if (surface === 'preview') {
        return [
          { id: 'copy', label: 'Copy', shortcut: 'Mod+C', run: copyPreview },
          {
            id: 'select-all',
            label: 'Select all',
            shortcut: 'Mod+A',
            run: () => {
              if (preview) selectElementContents(preview);
            },
          },
          {
            id: 'copy-md',
            label: 'Copy markdown',
            run: () => {
              const text = session?.getText() ?? '';
              void writeClipboard({ text, markdown: text });
            },
          },
        ];
      }

      return [
        { id: 'cut', label: 'Cut', shortcut: 'Mod+X', disabled: !selected, run: cutEditor },
        { id: 'copy', label: 'Copy', shortcut: 'Mod+C', disabled: !selected, run: copyEditor },
        { id: 'paste', label: 'Paste', shortcut: 'Mod+V', run: pasteEditor },
        { id: 'select-all', label: 'Select all', shortcut: 'Mod+A', run: selectAllEditor },
        { id: 'comment', label: 'Comment', shortcut: 'Mod+Alt+M', disabled: !selected, run: beginComment },
        {
          id: 'voice',
          label: voiceStatus === 'listening' ? 'Stop voice input' : 'Voice input',
          disabled: voiceStatus === 'unsupported',
          run: toggleVoice,
        },
      ];
    },
    [beginComment, getPreview, getView, session, toggleVoice, voiceStatus],
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      const surface = surfaceFromTarget(event.target);
      if (surface === 'other') return;
      const request = {
        clientX: event.clientX,
        clientY: event.clientY,
        surface,
        hasSelection: hasDomSelection() || Boolean(getView() && !getView()!.state.selection.main.empty),
        pointerType: 'mouse' as const,
      };
      if (!shouldOfferCustomMenu(request)) return;
      event.preventDefault();
      event.stopPropagation();
      setLastSurface(surface === 'preview' ? 'preview' : 'editor');
      setContextMenu({ x: event.clientX, y: event.clientY, actions: buildActions(surface) });
    },
    [buildActions, getView],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldHandleSelectAll(event, lastSurface)) {
        const preview = getPreview();
        if (preview) {
          event.preventDefault();
          selectElementContents(preview);
        }
        return;
      }

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.altKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        beginComment();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('.cm-editor, .editor-pane')) {
          event.preventDefault();
          toggleVoice();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, [beginComment, getPreview, lastSurface, onContextMenu, toggleVoice]);

  useEffect(() => {
    const longPress = createLongPress((event) => {
      const surface = surfaceFromTarget(event.target);
      if (surface === 'other') return;
      if (!shouldOfferCustomMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        surface,
        hasSelection: hasDomSelection(),
        pointerType: event.pointerType === 'pen' ? 'pen' : 'touch',
      })) return;
      setContextMenu({ x: event.clientX, y: event.clientY, actions: buildActions(surface) });
    });

    const down = (event: PointerEvent) => longPress.start(event);
    const move = (event: PointerEvent) => longPress.move(event);
    const up = () => longPress.cancel();

    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      longPress.destroy();
    };
  }, [buildActions]);

  return useMemo(
    () => ({
      lastSurface,
      setLastSurface,
      contextMenu,
      closeContextMenu,
      onContextMenu,
      commentsOpen,
      setCommentsOpen,
      draftQuote,
      beginComment,
      submitComment,
      cancelDraft,
      voiceStatus,
      voiceInterim,
      toggleVoice,
      stopVoice,
      voiceSupported: voiceStatus !== 'unsupported',
      network,
      hydrated,
    }),
    [
      beginComment,
      cancelDraft,
      closeContextMenu,
      commentsOpen,
      contextMenu,
      draftQuote,
      hydrated,
      lastSurface,
      network,
      onContextMenu,
      stopVoice,
      submitComment,
      toggleVoice,
      voiceInterim,
      voiceStatus,
    ],
  );
}

function serializeSelectionHtml(): string {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return '';
  const container = document.createElement('div');
  container.appendChild(selection.getRangeAt(0).cloneContents());
  return container.innerHTML;
}
