import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import type { CollabSession } from '../collab/types';
import { handleEditorCopy, handleEditorCut, handleEditorPaste, markdownKeymap } from './commands';
import { commentHighlights } from './comment-highlights';
import { editorTheme, markdownHighlighting } from './theme';

/**
 * Positions that briefly outrun the local document.
 *
 * The presence layer resolves remote cursors against the CRDT, which can be a
 * step ahead of the editor while a change is still being applied. CodeMirror
 * routes the failure here and recovers on the next update, so these are
 * noise. Anything else deserves to be seen.
 */
const TRANSIENT_BINDING_ERROR =
  /Invalid position \d+ in document|No tile at position|property 'tile' of/;

const exceptionSink = EditorView.exceptionSink.of((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (TRANSIENT_BINDING_ERROR.test(message)) return;
  console.error('[marks] editor exception', error);
});

export interface EditorSetupOptions {
  session: CollabSession;
  onScroll?: (view: EditorView) => void;
  onSelectionChange?: (view: EditorView) => void;
}

export function createEditorExtensions({
  session,
  onScroll,
  onSelectionChange,
}: EditorSetupOptions): Extension[] {
  return [
    exceptionSink,
    // No local history: CodeMirror's undo stack has no idea which edits are
    // yours, so it would happily revert a collaborator's paragraph. Each engine
    // contributes a CRDT-aware undo manager and its own Mod-Z binding instead.
    keymap.of([
      ...markdownKeymap,
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    markdownHighlighting,
    editorTheme,
    EditorView.lineWrapping,
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    search({ top: true }),
    autocompletion({ activateOnTyping: true, icons: false }),
    placeholder('Start writing…'),
    commentHighlights,
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocorrect: 'on',
      autocapitalize: 'sentences',
      translate: 'no',
    }),
    EditorView.domEventHandlers({
      paste: (event, view) => handleEditorPaste(event, view),
      copy: (event, view) => handleEditorCopy(event, view),
      cut: (event, view) => handleEditorCut(event, view),
      contextmenu: (event) => {
        // Policy lives in the React layer so mobile callouts stay native.
        // Returning false never steals the event from the browser.
        void event;
        return false;
      },
      scroll: (_event, view) => {
        onScroll?.(view);
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) onSelectionChange?.(update.view);
    }),
    // The CRDT binding goes last so its plugins see a fully configured editor.
    session.extension,
  ];
}
