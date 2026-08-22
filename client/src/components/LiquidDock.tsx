import { Icon, icons } from './Icon';
import { SurfaceMaterial } from './SurfaceMaterial';

interface LiquidDockProps {
  onCommands: () => void;
  onComments: () => void;
  onHistory: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
}

export function LiquidDock({
  onCommands,
  onComments,
  onHistory,
  onVoice,
  voiceActive,
  voiceSupported,
}: LiquidDockProps) {
  return (
    <div className="liquid-dock surface-material-host" role="toolbar" aria-label="Quick document actions">
      <SurfaceMaterial variant="floating" intensity={1.18} />
      <button type="button" className="liquid-dock-primary" onClick={onCommands}>
        <span><Icon path={icons.sparkles} size={16} /></span>
        Commands
        <kbd>⌘⇧P</kbd>
      </button>
      <button type="button" aria-label="Open comments" title="Comments" onClick={onComments}>
        <Icon path={icons.comment} size={16} />
      </button>
      <button type="button" aria-label="Open history" title="History" onClick={onHistory}>
        <Icon path={icons.history} size={16} />
      </button>
      <button
        type="button"
        className={voiceActive ? 'active' : undefined}
        aria-label="Voice input"
        aria-pressed={voiceActive}
        title={voiceSupported ? 'Dictate' : 'Voice input is not supported by this browser'}
        disabled={!voiceSupported || !onVoice}
        onClick={() => onVoice?.()}
      >
        <Icon path={icons.mic} size={16} />
      </button>
    </div>
  );
}
