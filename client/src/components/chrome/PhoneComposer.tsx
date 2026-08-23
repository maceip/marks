import { useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import type { CollabSession } from '../../collab/types';
import {
  insertCallout,
  insertCodeBlock,
  insertImage,
  insertLink,
  insertMath,
  insertMermaid,
  insertShape,
  insertTable,
  setHeading,
  toggleBold,
  toggleBullet,
  toggleInlineCode,
  toggleItalic,
  toggleTask,
} from '../../editor/commands';
import { insertImageFile, openFind } from '../../editor/actions';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../shell/TopBar';
import { Glyph, type GlyphName } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import { DraftToolsSheet } from './DraftToolsSheet';
import { getPresenceDisplay, setPresenceDisplay } from '../../collab/presence-display';

interface PhoneComposerProps {
  documentId: string;
  session: CollabSession | null;
  posture: Posture;
  documentReady: boolean;
  documentTitle: string;
  mode: ViewMode;
  reviewOpen?: 'comments' | 'history' | null;
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onAction: (action: UiActionId) => void;
  onToggleOutline: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  temporary?: boolean;
}

type PhoneSheet = 'insert' | 'tools' | 'more' | null;

const FORMAT: Array<{ glyph: GlyphName; label: string; command: StateCommand }> = [
  { glyph: 'bold', label: 'Bold', command: toggleBold },
  { glyph: 'italic', label: 'Italic', command: toggleItalic },
  { glyph: 'heading', label: 'Heading', command: setHeading(2) },
  { glyph: 'list', label: 'List', command: toggleBullet },
  { glyph: 'task', label: 'Task', command: toggleTask },
  { glyph: 'code', label: 'Code', command: toggleInlineCode },
];

const INSERT: Array<{ glyph: GlyphName; label: string; run: 'command' | 'file' | UiActionId; command?: StateCommand }> = [
  { glyph: 'image', label: 'Photo', run: 'file' },
  { glyph: 'link', label: 'Link', run: 'command', command: insertLink },
  { glyph: 'table', label: 'Table', run: 'command', command: insertTable },
  { glyph: 'rect', label: 'Shape', run: 'command', command: insertShape('rect') },
  { glyph: 'callout', label: 'Callout', run: 'command', command: insertCallout('info') },
  { glyph: 'math', label: 'Math', run: 'command', command: insertMath },
  { glyph: 'mermaid', label: 'Diagram', run: 'command', command: insertMermaid },
  { glyph: 'code', label: 'Fence', run: 'command', command: insertCodeBlock },
  { glyph: 'image', label: 'Image URL', run: 'command', command: insertImage },
  { glyph: 'comment', label: 'Comment', run: 'comments' },
];

const MORE: Array<{ glyph: GlyphName; label: string; action: UiActionId | 'find' | 'outline' }> = [
  { glyph: 'plus', label: 'New page', action: 'new' },
  { glyph: 'share', label: 'Keep', action: 'keep-workspace' },
  { glyph: 'settings', label: 'Account', action: 'account' },
  { glyph: 'link', label: 'Pairing', action: 'pairing' },
  { glyph: 'clear', label: 'Sign out', action: 'logout' },
  { glyph: 'template', label: 'Templates', action: 'templates' },
  { glyph: 'download', label: 'Import', action: 'import' },
  { glyph: 'pencil', label: 'Rename', action: 'rename' },
  { glyph: 'download', label: 'Export', action: 'download' },
  { glyph: 'download', label: 'Bundle', action: 'download-bundle' },
  { glyph: 'share', label: 'Share', action: 'share' },
  { glyph: 'find', label: 'Find', action: 'find' },
  { glyph: 'outline', label: 'Outline', action: 'outline' },
  { glyph: 'history', label: 'History', action: 'history' },
  { glyph: 'trash', label: 'Trash', action: 'trash' },
  { glyph: 'settings', label: 'Appearance', action: 'preferences' },
  { glyph: 'trash', label: 'Delete', action: 'delete' },
];

export function PhoneComposer(props: PhoneComposerProps) {
  const [sheet, setSheet] = useState<PhoneSheet>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = (command: StateCommand) => {
    const view = props.getView();
    if (!view || !props.documentReady) return;
    command(view);
    view.focus();
    setSheet(null);
  };

  const writing = props.mode !== 'preview';

  return (
    <div className={`phone-composer${props.posture.keyboardOpen ? ' keyboard-open' : ''}`}>
      {props.temporary && (
        <button type="button" className="phone-identity" onClick={() => props.onAction('keep-workspace')}>
          <span>Temporary</span>
          Closing this tab is unrecoverable until you keep it.
        </button>
      )}
      {writing && (
        <div className="phone-format-chips" role="toolbar" aria-label="Quick format">
          {FORMAT.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={!props.documentReady}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(item.command)}
            >
              <Glyph name={item.glyph} size={20} />
              <span>{item.label}</span>
            </button>
          ))}
          <button type="button" disabled={!props.documentReady} onClick={() => setSheet('tools')}>
            <Glyph name="sparkles" size={20} />
            <span>Tools</span>
          </button>
          {props.voiceSupported && (
            <button type="button" className={props.voiceActive ? 'active' : undefined} onClick={() => props.onVoice?.()}>
              <Glyph name="mic" size={20} />
              <span>Speak</span>
            </button>
          )}
        </div>
      )}

      {sheet && (
        <div className="phone-sheet-layer">
          <button type="button" className="phone-sheet-scrim" aria-label="Close sheet" onClick={() => setSheet(null)} />
          <div className="phone-sheet surface-material-host" role="dialog" aria-label={sheet}>
            <SurfaceMaterial variant="floating" intensity={1.08} />
            {sheet === 'tools' ? (
              <DraftToolsSheet
                open
                embedded
                documentTitle={props.documentTitle}
                getView={props.getView}
                onClose={() => setSheet(null)}
                onNotify={props.onNotify}
              />
            ) : (
              <>
                <header>
                  <h2>{sheet === 'insert' ? 'Insert' : 'Page'}</h2>
                  <button type="button" className="icon-button" aria-label="Close" onClick={() => setSheet(null)}>
                    <Glyph name="clear" size={16} interactive={false} />
                  </button>
                </header>
                <div className="phone-sheet-grid">
                  {sheet === 'more' && (['exact', 'section', 'off'] as const).map((value) => (
                    <button key={value} type="button" aria-pressed={getPresenceDisplay(props.mode === 'preview') === value} onClick={() => { setPresenceDisplay(value); setSheet(null); }}>
                      <Glyph name={value === 'off' ? 'clear' : value === 'exact' ? 'find' : 'outline'} size={28} />
                      <span>Presence: {value}</span>
                    </button>
                  ))}
                  {(sheet === 'insert' ? INSERT : MORE).map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={!props.documentReady && item.label !== 'New page' && item.label !== 'Templates'}
                      onClick={() => {
                        if ('command' in item && item.run === 'command' && item.command) run(item.command);
                        else if ('run' in item && item.run === 'file') fileRef.current?.click();
                        else if ('run' in item && item.run === 'comments') props.onAction('comments');
                        else if ('action' in item) {
                          if (item.action === 'find') {
                            const view = props.getView();
                            if (view) openFind(view);
                          } else if (item.action === 'outline') props.onToggleOutline();
                          else props.onAction(item.action);
                          setSheet(null);
                        }
                      }}
                    >
                      <Glyph name={item.glyph} size={28} />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <nav className="phone-nav surface-material-host" aria-label="Phone composer">
        <SurfaceMaterial variant="chrome" intensity={0.9} />
        <button type="button" className={writing ? 'active' : undefined} onClick={() => props.onModeChange('edit')}>
          <Glyph name="pencil" size={22} />
          <span>Write</span>
        </button>
        <button type="button" className={props.mode === 'preview' ? 'active' : undefined} onClick={() => props.onModeChange('preview')}>
          <Glyph name="eye" size={22} />
          <span>Preview</span>
        </button>
        <button type="button" className={sheet === 'insert' ? 'active' : undefined} onClick={() => setSheet((current) => (current === 'insert' ? null : 'insert'))}>
          <Glyph name="plus" size={22} />
          <span>Insert</span>
        </button>
        <button type="button" disabled={!props.documentReady} className={sheet === 'tools' ? 'active' : undefined} onClick={() => setSheet((current) => (current === 'tools' ? null : 'tools'))}>
          <Glyph name="sparkles" size={22} />
          <span>Tools</span>
        </button>
        <button type="button" className={sheet === 'more' ? 'active' : undefined} onClick={() => setSheet((current) => (current === 'more' ? null : 'more'))}>
          <Glyph name="more" size={22} />
          <span>More</span>
        </button>
      </nav>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          const view = props.getView();
          if (file && view && props.session) {
            void insertImageFile(view, props.session, file)
              .catch((error) => props.onNotify?.('Image not inserted', error instanceof Error ? error.message : 'The asset upload failed.', 'danger'));
          }
          event.currentTarget.value = '';
          setSheet(null);
        }}
      />
    </div>
  );
}
