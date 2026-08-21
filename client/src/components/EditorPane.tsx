import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useLayoutEffect, useRef } from 'react';
import type { CollabSession } from '../collab/types';
import { setCommentHighlights } from '../editor/comment-highlights';
import { createEditorExtensions } from '../editor/setup';
import { Toolbar } from './Toolbar';

export interface CursorInfo {
  line: number;
  column: number;
  selected: number;
}

interface EditorPaneProps {
  session: CollabSession;
  showToolbar: boolean;
  onView: (view: EditorView | null) => void;
  onScroll: () => void;
  onCursor: (info: CursorInfo) => void;
  onComment?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
}

export function EditorPane({
  session,
  showToolbar,
  onView,
  onScroll,
  onCursor,
  onComment,
  onVoice,
  voiceActive,
}: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep the latest callbacks reachable without rebuilding the editor. An
  // editor rebuild loses focus, cursor and scroll position, so it must happen
  // only when the document itself changes.
  const handlers = useRef({ onScroll, onCursor, onView });
  handlers.current = { onScroll, onCursor, onView };

  // A layout effect, not a passive one: React detaches DOM nodes before
  // passive cleanups run, and a CRDT update dispatching into a detached
  // EditorView throws from CodeMirror's view internals. Destroying the view
  // during the layout phase keeps teardown ahead of the DOM removal.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        // The CRDT binding populates the document; starting empty avoids
        // inserting a duplicate copy of the text before sync attaches.
        doc: '',
        extensions: createEditorExtensions({
          session,
          onScroll: () => handlers.current.onScroll(),
          onSelectionChange: (current) => {
            const range = current.state.selection.main;
            const line = current.state.doc.lineAt(range.head);
            handlers.current.onCursor({
              line: line.number,
              column: range.head - line.from + 1,
              selected: Math.abs(range.to - range.from),
            });
          },
        }),
      }),
    });

    viewRef.current = view;
    handlers.current.onView(view);
    const paintHighlights = (comments: ReturnType<CollabSession['comments']>) => {
      // Comment writes go through the same CRDT transaction as the editor
      // binding. Dispatching decorations synchronously re-enters
      // EditorView.update and CodeMirror logs a console error.
      queueMicrotask(() => {
        if (viewRef.current !== view) return;
        view.dispatch({ effects: setCommentHighlights.of(comments) });
      });
    };
    paintHighlights(session.comments());
    const offComments = session.onCommentsChange(paintHighlights);
    view.focus();

    return () => {
      offComments();
      handlers.current.onView(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [session]);

  return (
    <section className="pane editor-pane" aria-label="Markdown source">
      {showToolbar && (
        <Toolbar
          getView={() => viewRef.current}
          onComment={onComment}
          onVoice={onVoice}
          voiceActive={voiceActive}
        />
      )}
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}
