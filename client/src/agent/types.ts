import type {
  AgentToolDefinition,
  CommandId,
  CommandReceipt,
} from '../commands/types.ts';

export interface HostedAgentCapabilities {
  enabled: boolean;
  protocolVersion: 1;
  provider: 'openai' | null;
  limits: {
    maxPromptBytes: number;
    maxTools: number;
    maxSchemaBytes: number;
    maxToolResultBytes: number;
    maxOutputTokens: number;
    maxRunMs: number;
    maxConcurrentRunsPerSession: number;
  };
  features: {
    sseReplay: boolean;
    toolResults: boolean;
    cancellation: boolean;
    webMcp: boolean;
  };
}

export type HostedAgentEffect = 'read' | 'write' | 'destructive';
export type HostedAgentDurability = 'ephemeral' | 'document' | 'external';

export interface HostedAgentToolDefinition {
  commandId: CommandId;
  name: string;
  description: string;
  inputSchema: AgentToolDefinition['parameters'];
  effect: HostedAgentEffect;
  durability: HostedAgentDurability;
}

export interface CreateHostedAgentRun {
  requestId: string;
  documentId: string;
  prompt: string;
  tools: HostedAgentToolDefinition[];
}

export type HostedAgentRunStatus =
  | 'queued'
  | 'running'
  | 'waitingForTool'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface HostedAgentRunAccepted {
  runId: string;
  status: HostedAgentRunStatus;
  eventsUrl: string;
  createdAtMs: number;
  expiresAtMs: number;
  replayed: boolean;
}

export type HostedAgentRunEvent =
  | {
      type: 'run.started';
      runId: string;
      documentId: string;
      status: 'running';
      createdAtMs: number;
    }
  | { type: 'assistant.delta'; text: string }
  | {
      type: 'tool.call';
      callId: string;
      commandId: CommandId;
      name: string;
      arguments: Record<string, unknown>;
      effect: HostedAgentEffect;
      durability: HostedAgentDurability;
    }
  | {
      type: 'tool.result.accepted';
      callId: string;
      status: CommandReceipt['status'];
    }
  | {
      type: 'run.completed';
      status: 'completed';
      outputText: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { type: 'run.failed'; status: 'failed'; code: string }
  | { type: 'run.cancelled'; status: 'cancelled' };

export interface HostedAgentEventEnvelope {
  id: string;
  event: HostedAgentRunEvent;
}

export interface HostedAgentToolResult {
  requestId: string;
  callId: string;
  status: CommandReceipt['status'];
  output: {
    commandId: CommandId;
    message?: string;
    error?: string;
  };
}

export interface HostedAgentToolResultAccepted {
  runId: string;
  callId: string;
  accepted: true;
  replayed: boolean;
}

export interface HostedAgentCancelResult {
  runId: string;
  status: 'cancelled';
  replayed: boolean;
}
