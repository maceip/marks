import type { ConnectionStatus } from '../collab/types';
import { formatCount, formatMs, readingTime } from '../lib/format';
import type { CursorInfo } from './EditorPane';

interface StatusBarProps {
  words: number;
  chars: number;
  cursor: CursorInfo;
  status: ConnectionStatus;
  latencyP50: number;
  latencyP95: number;
  peers: number;
}

export function StatusBar({
  words,
  chars,
  cursor,
  status,
  latencyP50,
  latencyP95,
  peers,
}: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        <span>{formatCount(words)} words</span>
        <span>{formatCount(chars)} chars</span>
        <span>{readingTime(words)}</span>
      </div>

      <div className="statusbar-group">
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
        {cursor.selected > 0 && <span>{formatCount(cursor.selected)} selected</span>}
      </div>

      <div className="statusbar-group statusbar-right">
        <span title="Time from an edit landing to the preview being repainted">
          preview p50 {formatMs(latencyP50)} · p95 {formatMs(latencyP95)}
        </span>
        <span>{peers === 1 ? 'only you' : `${peers} people`}</span>
        <span className={`status status-${status}`}>
          <span className="status-dot" />
          {status}
        </span>
      </div>
    </footer>
  );
}
