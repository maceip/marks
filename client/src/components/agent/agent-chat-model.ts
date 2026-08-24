import type { Shell } from '../../lib/posture';

export type AgentChatState =
  | 'collapsed'
  | 'focused'
  | 'submitting'
  | 'working'
  | 'result'
  | 'error'
  | 'expanded';

export type AgentChatHost = 'floating' | 'anchored-panel' | 'phone-tools-sheet' | 'companion-stage';

export function agentChatHost(shell: Shell): AgentChatHost {
  if (shell === 'phone') return 'phone-tools-sheet';
  if (shell === 'studio' || shell === 'fold-laptop') return 'anchored-panel';
  if (shell === 'fold-book') return 'companion-stage';
  return 'floating';
}

export function agentChatAnnouncement(state: AgentChatState, error?: string): string {
  if (state === 'submitting') return 'Sending prompt';
  if (state === 'working') return 'Assistant is working';
  if (state === 'result') return 'Assistant response available';
  if (state === 'error') return error ? `Assistant error: ${error}` : 'Assistant could not complete the request';
  return '';
}

export function shouldSubmitPrompt(key: string, shiftKey: boolean, composing: boolean): boolean {
  return key === 'Enter' && !shiftKey && !composing;
}

export function shouldRestoreLauncherFocus(previous: AgentChatState, next: AgentChatState): boolean {
  return previous !== 'collapsed' && next === 'collapsed';
}

export function recoveryAction(state: AgentChatState): 'cancel' | 'retry' | 'submit' {
  if (state === 'submitting' || state === 'working') return 'cancel';
  if (state === 'error') return 'retry';
  return 'submit';
}
