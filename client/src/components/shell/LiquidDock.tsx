import { Icon, SurfaceMaterial } from '../ui';

interface LiquidDockProps {
  onCommands: () => void;
  onComments: () => void;
  onHistory: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  className?: string;
}

export function LiquidDock({
  onCommands,
  onComments,
  onHistory,
  onVoice,
  voiceActive,
  voiceSupported,
  className = '',
}: LiquidDockProps) {
  return (
    <div className={`liquid-dock surface-material-host${className ? ` ${className}` : ''}`} role="toolbar" aria-label="Quick document actions">
      <SurfaceMaterial variant="floating" />
      <button type="button" className="liquid-dock-primary" onClick={onCommands}>
        <span><Icon name="sparkles" size={16} /></span>
        Commands
        <kbd>⌘⇧P</kbd>
      </button>
      <button type="button" aria-label="Open comments" title="Comments" onClick={onComments}>
        <Icon name="comment" size={16} />
      </button>
      <button type="button" aria-label="Open history" title="History" onClick={onHistory}>
        <Icon name="history" size={16} />
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
        <Icon name="mic" size={16} />
      </button>
    </div>
  );
}
