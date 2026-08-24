import '../../styles/components.css';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { Shell } from '../../lib/posture';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import { AgentActionButton, AgentIconButton, PillSurface, PromptInput, StatusIndicator } from './AgentChatPrimitives';
import { agentChatAnnouncement, agentChatHost, shouldSubmitPrompt, type AgentChatState } from './agent-chat-model';
import './agent-chat.css';

export interface AgentChatPillProps {
  state: AgentChatState;
  shell: Shell;
  prompt: string;
  result?: ReactNode;
  error?: string;
  accessibleName?: string;
  onOpen: () => void;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  onExpand: () => void;
}

/** A controlled visual pattern. Request, model, and streaming ownership belongs to its parent. */
export function AgentChatPill({ accessibleName = 'AI assistant', ...props }: AgentChatPillProps) {
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(props.state !== 'collapsed');
  const open = props.state !== 'collapsed';
  const expanded = props.state === 'expanded';
  const working = props.state === 'submitting' || props.state === 'working';
  const host = agentChatHost(props.shell);

  useEffect(() => {
    if (props.state === 'focused') inputRef.current?.focus();
    if (wasOpen.current && !open) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open, props.state]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open, props.onClose]);

  const submit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (shouldSubmitPrompt(event.key, event.shiftKey, event.nativeEvent.isComposing)) {
      event.preventDefault();
      if (props.prompt.trim() && !working) props.onSubmit();
    }
  };

  return (
    <div className={`agent-chat-host host-${host}`} data-agent-chat-host={host} role="group" aria-label={accessibleName} aria-expanded={open}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {agentChatAnnouncement(props.state, props.error)}
      </span>
      {!open ? (
        <button ref={launcherRef} type="button" className="agent-chat-launcher surface-material-host" aria-label={accessibleName} aria-expanded="false" onClick={props.onOpen}>
          <SurfaceMaterial variant="floating" /><span aria-hidden="true">✦</span><span>Ask AI</span>
        </button>
      ) : (
        <PillSurface className={`state-${props.state}`}>
          <section
            className="agent-chat-content"
            role={expanded || host === 'phone-tools-sheet' ? 'dialog' : 'region'}
            aria-modal={host === 'phone-tools-sheet' ? true : undefined}
            aria-label={accessibleName}
          >
            <header>
              <StatusIndicator active={working} label={working ? 'Working' : props.state === 'error' ? 'Needs attention' : 'Assistant'} />
              <AgentIconButton glyph={expanded ? 'shrink' : 'grow'} tooltip={expanded ? 'Collapse conversation' : 'Expand conversation'} onClick={expanded ? props.onOpen : props.onExpand} />
              <AgentIconButton glyph="clear" tooltip="Close assistant" onClick={props.onClose} />
            </header>
            {(props.result || props.error) && <div className={`agent-chat-response${props.state === 'result' ? ' arrived' : ''}`}>{props.error ?? props.result}</div>}
            <div className="agent-chat-compose">
              <PromptInput ref={inputRef} aria-label="Prompt" value={props.prompt} disabled={working} placeholder="Ask about this document…" onChange={(event) => props.onPromptChange(event.currentTarget.value)} onKeyDown={submit} />
              {working ? <AgentActionButton onClick={props.onCancel}>Cancel</AgentActionButton> : props.state === 'error' ? <AgentActionButton onClick={props.onRetry}>Try again</AgentActionButton> : <AgentActionButton disabled={!props.prompt.trim()} onClick={props.onSubmit}>Send</AgentActionButton>}
            </div>
          </section>
        </PillSurface>
      )}
    </div>
  );
}
