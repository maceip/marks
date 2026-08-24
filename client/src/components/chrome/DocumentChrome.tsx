import type { EditorView } from '@codemirror/view';
import type { CollabSession } from '../../collab/types';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../shell/TopBar';
import { DesktopRibbon } from './DesktopRibbon';
import { FoldableRibbon } from './FoldableRibbon';
import { MiniToolbar } from './MiniToolbar';
import { PhoneComposer } from './PhoneComposer';
import { LiquidDock } from '../shell/LiquidDock';
import '../../styles/chrome.css';

export interface DocumentChromeProps {
  documentId: string;
  session: CollabSession | null;
  posture: Posture;
  documentReady: boolean;
  documentTitle: string;
  mode: ViewMode;
  theme: 'light' | 'dark';
  hudOpen: boolean;
  outlineOpen: boolean;
  reviewOpen?: 'comments' | 'history' | null;
  focusMode?: boolean;
  selected: number;
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onAction: (action: UiActionId) => void;
  onOpenDraftTools: () => void;
  onToggleTheme?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  temporary?: boolean;
}

export function DocumentChrome(props: DocumentChromeProps) {
  if (props.focusMode) return null;

  if (props.posture.phone) {
    return (
      <PhoneComposer
        documentId={props.documentId}
        session={props.session}
        posture={props.posture}
        documentReady={props.documentReady}
        documentTitle={props.documentTitle}
        mode={props.mode}
        reviewOpen={props.reviewOpen}
        getView={props.getView}
        onModeChange={props.onModeChange}
        onAction={props.onAction}
        onToggleOutline={props.onToggleOutline}
        onVoice={props.onVoice}
        voiceActive={props.voiceActive}
        voiceSupported={props.voiceSupported}
        onNotify={props.onNotify}
        temporary={props.temporary}
      />
    );
  }

  if (props.posture.foldable) {
    return (
      <>
        <FoldableRibbon posture={props.posture} />
        <MiniToolbar selected={props.selected} disabled={!props.documentReady} getView={props.getView} />
      </>
    );
  }

  return (
    <>
      <DesktopRibbon
        documentId={props.documentId}
        session={props.session}
        documentReady={props.documentReady}
        mode={props.mode}
        theme={props.theme}
        hudOpen={props.hudOpen}
        outlineOpen={props.outlineOpen}
        reviewOpen={props.reviewOpen}
        focusMode={props.focusMode}
        phone={false}
        selected={props.selected}
        getView={props.getView}
        onModeChange={props.onModeChange}
        onToggleHud={props.onToggleHud}
        onToggleOutline={props.onToggleOutline}
        onAction={props.onAction}
        onOpenDraftTools={props.onOpenDraftTools}
        onToggleTheme={props.onToggleTheme}
        onVoice={props.onVoice}
        voiceActive={props.voiceActive}
        voiceSupported={props.voiceSupported}
        onNotify={props.onNotify}
      />
      <MiniToolbar selected={props.selected} disabled={!props.documentReady} getView={props.getView} />
      <LiquidDock
        onCommands={() => props.onAction('command-palette')}
        onComments={() => props.onAction('comments')}
        onHistory={() => props.onAction('history')}
        onVoice={props.onVoice}
        voiceActive={props.voiceActive}
        voiceSupported={props.voiceSupported}
      />
    </>
  );
}

export { QuickAccess } from './DesktopRibbon';
export { DraftToolsSheet } from './DraftToolsSheet';
