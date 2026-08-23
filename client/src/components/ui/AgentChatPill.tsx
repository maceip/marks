import { Icon, icons } from './Icon';

export function AgentChatPill({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="identity-chip agent-chat-pill" onClick={onClick} disabled={disabled}
    aria-label="Open local draft agent"><Icon path={icons.sparkles} size={14} /><span>Ask Marks</span></button>;
}
