import type { AgentToolDefinition } from '../commands/types.ts';
import type {
  HostedAgentCapabilities,
  HostedAgentDurability,
  HostedAgentEffect,
  HostedAgentToolDefinition,
} from './types.ts';

export function hostedConsequence(
  risk: AgentToolDefinition['risk'],
): { effect: HostedAgentEffect; durability: HostedAgentDurability } {
  return {
    effect: risk === 'read' ? 'read' : risk === 'destructive' ? 'destructive' : 'write',
    durability: risk === 'read' ? 'ephemeral' : risk === 'external' ? 'external' : 'document',
  };
}

export function toHostedAgentTools(
  tools: readonly AgentToolDefinition[],
  limits: HostedAgentCapabilities['limits'],
): HostedAgentToolDefinition[] {
  const bounded: HostedAgentToolDefinition[] = [];
  let schemaBytes = 0;
  const encoder = new TextEncoder();
  for (const tool of tools) {
    const consequence = hostedConsequence(tool.risk);
    const candidate: HostedAgentToolDefinition = {
      commandId: tool.commandId,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      ...consequence,
    };
    const bytes = encoder.encode(JSON.stringify(candidate.inputSchema)).byteLength;
    if (bounded.length >= limits.maxTools || schemaBytes + bytes > limits.maxSchemaBytes) break;
    schemaBytes += bytes;
    bounded.push(candidate);
  }
  return bounded;
}
