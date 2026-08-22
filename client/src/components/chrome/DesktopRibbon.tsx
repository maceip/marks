import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import {
  addTableColumn,
  addTableRow,
  clearFormatting,
  growHeading,
  indentLines,
  insertCallout,
  insertCodeBlock,
  insertFootnote,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertMath,
  insertMermaid,
  insertShape,
  insertTable,
  insertToc,
  outdentLines,
  setHeading,
  setParagraph,
  shrinkHeading,
  toggleBold,
  toggleBullet,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleNumbered,
  toggleQuote,
  toggleStrikethrough,
  toggleTask,
  toggleUnderline,
  type ShapeKind,
} from '../../editor/commands';
import {
  copySelection,
  cutSelection,
  insertImageFile,
  openFind,
  pasteMarkdown,
  runRedo,
  runUndo,
  updateImageAtCursor,
} from '../../editor/actions';
import { inspectEditorContext, type EditorContextKind } from '../../editor/context';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../TopBar';
import { Glyph, type GlyphName } from '../glyphs/Glyph';
import { RibbonCommand, RibbonGroup } from './RibbonCommand';

export type RibbonTab =
  | 'file'
  | 'home'
  | 'insert'
  | 'draw'
  | 'review'
  | 'view'
  | 'ai'
  | 'picture'
  | 'table'
  | 'shape';

interface DesktopRibbonProps {
  documentReady: boolean;
  mode: ViewMode;
  theme: 'light' | 'dark';
  hudOpen: boolean;
  outlineOpen: boolean;
  reviewOpen?: 'comments' | 'history' | null;
  focusMode?: boolean;
  phone: boolean;
  selected: number;
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onAction: (action: UiActionId) => void;
  onOpenAi: () => void;
  onToggleTheme?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
}

const CORE_TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'draw', label: 'Draw' },
  { id: 'ai', label: 'AI' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
];

const CONTEXT_TABS: Array<{ id: RibbonTab; label: string; kind: EditorContextKind }> = [
  { id: 'picture', label: 'Picture', kind: 'image' },
  { id: 'table', label: 'Table', kind: 'table' },
  { id: 'shape', label: 'Shape', kind: 'shape' },
];

const HEADINGS = [1, 2, 3, 4] as const;
const SHAPES: Array<{ id: ShapeKind; label: string; glyph: GlyphName }> = [
  { id: 'rect', label: 'Rectangle', glyph: 'rect' },
  { id: 'ellipse', label: 'Ellipse', glyph: 'ellipse' },
  { id: 'diamond', label: 'Diamond', glyph: 'diamond' },
  { id: 'arrow', label: 'Arrow', glyph: 'arrow' },
  { id: 'bubble', label: 'Callout', glyph: 'bubble' },
];

export function DesktopRibbon(props: DesktopRibbonProps) {
  const [tab, setTab] = useState<RibbonTab>('home');
  const [contextKind, setContextKind] = useState<EditorContextKind>('text');
  const lastCommand = useRef<StateCommand | null>(null);
  const [painterArmed, setPainterArmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const view = props.getView();
    if (!view) return;
    const sync = () => {
      const range = view.state.selection.main;
      const next = inspectEditorContext(view.state.doc.toString(), range.from, range.to).kind;
      setContextKind(next);
    };
    sync();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') sync();
    }, 360);
    return () => window.clearInterval(interval);
  }, [props.documentReady, props.getView]);

  useEffect(() => {
    if (contextKind === 'image') setTab('picture');
    if (contextKind === 'table') setTab('table');
    if (contextKind === 'shape') setTab('shape');
  }, [contextKind]);

  const run = (command: StateCommand) => {
    const view = props.getView();
    if (!view || !props.documentReady) return;
    if (painterArmed && lastCommand.current) {
      lastCommand.current(view);
      setPainterArmed(false);
      view.focus();
      return;
    }
    command(view);
    lastCommand.current = command;
    view.focus();
  };

  const visibleModes = props.phone
    ? (['edit', 'preview'] as ViewMode[])
    : (['edit', 'split', 'preview'] as ViewMode[]);

  return (
    <div className="ribbon-body">
      <nav className="ribbon-tabs" aria-label="Command ribbon">
        {CORE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ribbon-tab${tab === item.id ? ' active' : ''}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        {CONTEXT_TABS.filter((item) => item.kind === contextKind).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ribbon-tab contextual${tab === item.id ? ' active' : ''}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="ribbon-deck">
        {tab === 'file' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="File commands">
            <RibbonGroup label="Create">
              <RibbonCommand glyph="plus" label="New" onClick={() => props.onAction('new')} />
              <RibbonCommand glyph="template" label="Template" onClick={() => props.onAction('templates')} />
            </RibbonGroup>
            <RibbonGroup label="Document">
              <RibbonCommand glyph="pencil" label="Rename" disabled={!props.documentReady} onClick={() => props.onAction('rename')} />
              <RibbonCommand glyph="duplicate" label="Duplicate" disabled={!props.documentReady} onClick={() => props.onAction('duplicate')} />
            </RibbonGroup>
            <RibbonGroup label="Export">
              <RibbonCommand glyph="download" label="Markdown" disabled={!props.documentReady} onClick={() => props.onAction('download')} />
              <RibbonCommand glyph="print" label="Print" disabled={!props.documentReady} onClick={() => props.onAction('print')} />
              <RibbonCommand glyph="share" label="Share" disabled={!props.documentReady} onClick={() => props.onAction('share')} />
              <RibbonCommand glyph="trash" label="Delete" danger disabled={!props.documentReady} onClick={() => props.onAction('delete')} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'home' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Home commands">
            <RibbonGroup label="Clipboard">
              <RibbonCommand
                glyph="paste"
                label="Paste"
                large
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) void pasteMarkdown(view);
                }}
              />
              <RibbonCommand
                glyph="cut"
                label="Cut"
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) void cutSelection(view);
                }}
              />
              <RibbonCommand
                glyph="copy"
                label="Copy"
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) void copySelection(view);
                }}
              />
              <RibbonCommand
                glyph="painter"
                label="Painter"
                pressed={painterArmed}
                disabled={!props.documentReady}
                onClick={() => setPainterArmed((armed) => !armed)}
              />
            </RibbonGroup>
            <RibbonGroup label="Styles" onLaunch={() => run(setHeading(2))} launchLabel="Apply heading 2">
              <div className="ribbon-gallery" role="listbox" aria-label="Heading styles">
                <button type="button" className="style-chip style-p" disabled={!props.documentReady} onMouseDown={(event) => event.preventDefault()} onClick={() => run(setParagraph)}>
                  <span>Aa</span>Body
                </button>
                {HEADINGS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`style-chip style-h${level}`}
                    disabled={!props.documentReady}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => run(setHeading(level))}
                  >
                    <span>H{level}</span>Title
                  </button>
                ))}
              </div>
            </RibbonGroup>
            <RibbonGroup label="Font">
              <RibbonCommand glyph="bold" label="Bold" title="Bold (⌘B)" disabled={!props.documentReady} onClick={() => run(toggleBold)} />
              <RibbonCommand glyph="italic" label="Italic" disabled={!props.documentReady} onClick={() => run(toggleItalic)} />
              <RibbonCommand glyph="underline" label="Insert" disabled={!props.documentReady} onClick={() => run(toggleUnderline)} />
              <RibbonCommand glyph="strike" label="Strike" disabled={!props.documentReady} onClick={() => run(toggleStrikethrough)} />
              <RibbonCommand glyph="highlight" label="Mark" disabled={!props.documentReady} onClick={() => run(toggleHighlight)} />
              <RibbonCommand glyph="code" label="Code" disabled={!props.documentReady} onClick={() => run(toggleInlineCode)} />
              <RibbonCommand glyph="grow" label="Grow" disabled={!props.documentReady} onClick={() => run(growHeading)} />
              <RibbonCommand glyph="shrink" label="Shrink" disabled={!props.documentReady} onClick={() => run(shrinkHeading)} />
              <RibbonCommand glyph="clear" label="Clear" disabled={!props.documentReady} onClick={() => run(clearFormatting)} />
            </RibbonGroup>
            <RibbonGroup label="Paragraph">
              <RibbonCommand glyph="list" label="Bullets" disabled={!props.documentReady} onClick={() => run(toggleBullet)} />
              <RibbonCommand glyph="numbered" label="Numbered" disabled={!props.documentReady} onClick={() => run(toggleNumbered)} />
              <RibbonCommand glyph="task" label="Tasks" disabled={!props.documentReady} onClick={() => run(toggleTask)} />
              <RibbonCommand glyph="quote" label="Quote" disabled={!props.documentReady} onClick={() => run(toggleQuote)} />
              <RibbonCommand glyph="indent" label="Indent" disabled={!props.documentReady} onClick={() => run(indentLines())} />
              <RibbonCommand glyph="outdent" label="Outdent" disabled={!props.documentReady} onClick={() => run(outdentLines())} />
            </RibbonGroup>
            <RibbonGroup label="Editing">
              <RibbonCommand
                glyph="find"
                label="Find"
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) openFind(view);
                }}
              />
              <RibbonCommand
                glyph="undo"
                label="Undo"
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) runUndo(view);
                }}
              />
              <RibbonCommand
                glyph="redo"
                label="Redo"
                disabled={!props.documentReady}
                onClick={() => {
                  const view = props.getView();
                  if (view) runRedo(view);
                }}
              />
              <RibbonCommand
                glyph="mic"
                label="Dictate"
                pressed={props.voiceActive}
                disabled={!props.documentReady || !props.voiceSupported || !props.onVoice}
                title={props.voiceSupported ? 'Dictate' : 'Voice input is not supported by this browser'}
                onClick={() => props.onVoice?.()}
              />
            </RibbonGroup>
          </div>
        )}

        {tab === 'insert' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Insert commands">
            <RibbonGroup label="Illustrations" onLaunch={() => fileRef.current?.click()} launchLabel="Insert image file">
              <RibbonCommand glyph="image" label="Picture" disabled={!props.documentReady} onClick={() => run(insertImage)} />
              <RibbonCommand glyph="image" label="From file" disabled={!props.documentReady} onClick={() => fileRef.current?.click()} />
              <RibbonCommand glyph="rect" label="Shape" disabled={!props.documentReady} onClick={() => run(insertShape('rect'))} />
            </RibbonGroup>
            <RibbonGroup label="Table">
              <RibbonCommand glyph="table" label="Table" disabled={!props.documentReady} onClick={() => run(insertTable)} />
              <RibbonCommand glyph="row" label="Row" disabled={!props.documentReady} onClick={() => run(addTableRow())} />
              <RibbonCommand glyph="column" label="Column" disabled={!props.documentReady} onClick={() => run(addTableColumn())} />
            </RibbonGroup>
            <RibbonGroup label="Links">
              <RibbonCommand glyph="link" label="Link" disabled={!props.documentReady} onClick={() => run(insertLink)} />
              <RibbonCommand glyph="footnote" label="Note" disabled={!props.documentReady} onClick={() => run(insertFootnote)} />
              <RibbonCommand glyph="comment" label="Comment" disabled={!props.documentReady} onClick={() => props.onAction('comments')} />
            </RibbonGroup>
            <RibbonGroup label="Blocks">
              <RibbonCommand glyph="code" label="Fence" disabled={!props.documentReady} onClick={() => run(insertCodeBlock)} />
              <RibbonCommand glyph="math" label="Math" disabled={!props.documentReady} onClick={() => run(insertMath)} />
              <RibbonCommand glyph="mermaid" label="Diagram" disabled={!props.documentReady} onClick={() => run(insertMermaid)} />
              <RibbonCommand glyph="callout" label="Callout" disabled={!props.documentReady} onClick={() => run(insertCallout('info'))} />
              <RibbonCommand glyph="hr" label="Break" disabled={!props.documentReady} onClick={() => run(insertHorizontalRule)} />
              <RibbonCommand glyph="toc" label="Contents" disabled={!props.documentReady} onClick={() => run(insertToc)} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'draw' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Draw commands">
            <RibbonGroup label="Shapes">
              {SHAPES.map((shape) => (
                <RibbonCommand
                  key={shape.id}
                  glyph={shape.glyph}
                  label={shape.label}
                  disabled={!props.documentReady}
                  onClick={() => run(insertShape(shape.id, shape.label))}
                />
              ))}
            </RibbonGroup>
            <RibbonGroup label="Notes">
              <RibbonCommand glyph="callout" label="Info" disabled={!props.documentReady} onClick={() => run(insertCallout('info'))} />
              <RibbonCommand glyph="callout" label="Warn" disabled={!props.documentReady} onClick={() => run(insertCallout('warning'))} />
              <RibbonCommand glyph="callout" label="Danger" disabled={!props.documentReady} onClick={() => run(insertCallout('danger'))} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'ai' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="AI commands">
            <RibbonGroup label="Compose">
              <RibbonCommand glyph="compose" label="Draft" large disabled={!props.documentReady} onClick={props.onOpenAi} />
              <RibbonCommand glyph="rewrite" label="Rewrite" disabled={!props.documentReady} onClick={props.onOpenAi} />
              <RibbonCommand glyph="summarize" label="Summarize" disabled={!props.documentReady} onClick={props.onOpenAi} />
              <RibbonCommand glyph="outline" label="Outline" disabled={!props.documentReady} onClick={props.onOpenAi} />
              <RibbonCommand glyph="continue" label="Continue" disabled={!props.documentReady} onClick={props.onOpenAi} />
              <RibbonCommand glyph="expand" label="Expand" disabled={!props.documentReady} onClick={props.onOpenAi} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'review' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Review commands">
            <RibbonGroup label="Review">
              <RibbonCommand glyph="comment" label="Comments" pressed={props.reviewOpen === 'comments'} onClick={() => props.onAction('comments')} />
              <RibbonCommand glyph="history" label="History" pressed={props.reviewOpen === 'history'} onClick={() => props.onAction('history')} />
            </RibbonGroup>
            <RibbonGroup label="Inspect">
              <RibbonCommand glyph="gauge" label="Performance" pressed={props.hudOpen} onClick={props.onToggleHud} />
              <RibbonCommand glyph="find" label="Find" disabled={!props.documentReady} onClick={() => props.getView() && openFind(props.getView()!)} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'view' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="View commands">
            <RibbonGroup label="Layout">
              {visibleModes.map((mode) => (
                <RibbonCommand
                  key={mode}
                  glyph={mode === 'edit' ? 'pencil' : mode === 'split' ? 'split' : 'eye'}
                  label={mode === 'edit' ? 'Editor' : mode === 'split' ? 'Split' : 'Preview'}
                  pressed={props.mode === mode}
                  onClick={() => props.onModeChange(mode)}
                />
              ))}
            </RibbonGroup>
            <RibbonGroup label="Workspace">
              <RibbonCommand glyph="outline" label="Outline" pressed={props.outlineOpen} onClick={props.onToggleOutline} />
              <RibbonCommand glyph="focus" label="Focus" pressed={props.focusMode} onClick={() => props.onAction('focus')} />
              <RibbonCommand glyph="settings" label="Appearance" onClick={() => props.onAction('preferences')} />
              <RibbonCommand
                glyph={props.theme === 'dark' ? 'sun' : 'moon'}
                label={props.theme === 'dark' ? 'Light' : 'Dark'}
                onClick={() => props.onToggleTheme?.() ?? props.onAction('preferences')}
              />
              <RibbonCommand glyph="gauge" label="Performance" pressed={props.hudOpen} onClick={props.onToggleHud} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'picture' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Picture tools">
            <RibbonGroup label="Size">
              <RibbonCommand glyph="shrink" label="Small" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { width: 240 }); }} />
              <RibbonCommand glyph="image" label="Medium" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { width: 480 }); }} />
              <RibbonCommand glyph="grow" label="Full" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { width: 720 }); }} />
            </RibbonGroup>
            <RibbonGroup label="Position">
              <RibbonCommand glyph="alignLeft" label="Left" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { align: 'left' }); }} />
              <RibbonCommand glyph="alignCenter" label="Center" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { align: 'center' }); }} />
              <RibbonCommand glyph="alignRight" label="Right" disabled={!props.documentReady} onClick={() => { const view = props.getView(); if (view) updateImageAtCursor(view, { align: 'right' }); }} />
            </RibbonGroup>
            <RibbonGroup label="Replace">
              <RibbonCommand glyph="image" label="File" disabled={!props.documentReady} onClick={() => fileRef.current?.click()} />
              <RibbonCommand glyph="link" label="URL" disabled={!props.documentReady} onClick={() => run(insertImage)} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'table' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Table tools">
            <RibbonGroup label="Rows and columns">
              <RibbonCommand glyph="row" label="Add row" disabled={!props.documentReady} onClick={() => run(addTableRow())} />
              <RibbonCommand glyph="column" label="Add column" disabled={!props.documentReady} onClick={() => run(addTableColumn())} />
              <RibbonCommand glyph="table" label="New table" disabled={!props.documentReady} onClick={() => run(insertTable)} />
            </RibbonGroup>
          </div>
        )}

        {tab === 'shape' && (
          <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Shape tools">
            <RibbonGroup label="Change shape">
              {SHAPES.map((shape) => (
                <RibbonCommand
                  key={shape.id}
                  glyph={shape.glyph}
                  label={shape.label}
                  disabled={!props.documentReady}
                  onClick={() => run(insertShape(shape.id, shape.label))}
                />
              ))}
            </RibbonGroup>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          const view = props.getView();
          if (file && view) void insertImageFile(view, file);
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}

export function QuickAccess({
  disabled,
  getView,
}: {
  disabled?: boolean;
  getView: () => EditorView | null;
}) {
  return (
    <div className="quick-access" role="toolbar" aria-label="Quick access">
      <button
        type="button"
        className="icon-button"
        aria-label="Undo"
        disabled={disabled}
        onClick={() => {
          const view = getView();
          if (view) runUndo(view);
        }}
      >
        <Glyph name="undo" size={16} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Redo"
        disabled={disabled}
        onClick={() => {
          const view = getView();
          if (view) runRedo(view);
        }}
      >
        <Glyph name="redo" size={16} />
      </button>
    </div>
  );
}
