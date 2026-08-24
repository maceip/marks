import type { VoiceStatus } from '../../browser';
import { Button } from '../ui/Button';

interface VoiceBarProps {
  status: VoiceStatus;
  interim: string;
  onStop: () => void;
}

const LABEL: Record<VoiceStatus, string> = {
  idle: '',
  listening: 'Listening…',
  unsupported: 'Voice input is not available in this browser',
  denied: 'Microphone permission denied',
  error: 'Voice input failed',
};

export function VoiceBar({ status, interim, onStop }: VoiceBarProps) {
  if (status === 'idle') return null;

  return (
    <div className={`voice-bar voice-${status}`} role="status">
      <span className="voice-dot" />
      <span>{LABEL[status]}</span>
      {interim && <span className="voice-interim">{interim}</span>}
      {status === 'listening' && (
        <Button variant="link" onClick={onStop}>Stop</Button>
      )}
    </div>
  );
}
