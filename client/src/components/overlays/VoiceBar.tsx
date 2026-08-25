import type { VoiceStatus } from '../../browser';
import { Button } from '../ui';

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
  // Unsupported browsers already expose that state on the disabled Dictate
  // command. A permanent bottom overlay would only obscure unrelated controls.
  if (status === 'idle' || status === 'unsupported') return null;

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
