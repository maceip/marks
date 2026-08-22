import type { EditorView } from '@codemirror/view';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../TopBar';
import { DesktopRibbon } from './DesktopRibbon';
import { MiniToolbar } from './MiniToolbar';
import { PhoneComposer } from './PhoneComposer';
import '../../styles/chrome.css';

export interface DocumentChromeProps {
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
  onOpenAi: () => void;
  onToggleTheme?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function DocumentChrome(props: DocumentChromeProps) {
  if (props.focusMode) return null;

  if (props.posture.phone) {
    return (
      <PhoneComposer
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
      />
    );
  }

  return (
    <>
      <DesktopRibbon
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
        onOpenAi={props.onOpenAi}
        onToggleTheme={props.onToggleTheme}
        onVoice={props.onVoice}
        voiceActive={props.voiceActive}
        voiceSupported={props.voiceSupported}
      />
      <MiniToolbar selected={props.selected} disabled={!props.documentReady} getView={props.getView} />
    </>
  );
}

export { QuickAccess } from './DesktopRibbon';
export { AiSheet } from './AiSheet';
