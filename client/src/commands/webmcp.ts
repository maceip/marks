import type { AgentToolDefinition, CommandId, CommandReceipt } from './types.ts';

interface WebMcpExecutionOptions {
  signal: AbortSignal;
}

interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: AgentToolDefinition['parameters'];
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(input: unknown, options: WebMcpExecutionOptions): Promise<string> | string;
}

interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

interface WebMcpDocument extends Document {
  modelContext?: ModelContextLike;
}

export interface MarksWebMcpOptions {
  tools: () => AgentToolDefinition[];
  focus: (ids: CommandId[], ttlMs?: number) => void;
  execute: (
    commandId: CommandId,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<CommandReceipt>;
}

/**
 * Register the same semantic commands with the experimental WebMCP page API.
 * No cross-origin exposure is requested. Every call still enters the Marks
 * runtime, which validates arguments, rechecks role/capabilities, and pauses
 * external or destructive effects for visible approval.
 */
export async function registerMarksWebMcp(
  options: MarksWebMcpOptions,
  context: ModelContextLike | undefined = (document as WebMcpDocument).modelContext,
): Promise<() => void> {
  if (!context) return () => undefined;
  const lifecycle = new AbortController();
  const registration = { signal: lifecycle.signal };

  await context.registerTool({
    name: 'marks_list_available_commands',
    title: 'List current Marks commands',
    description: 'List the commands Marks exposes for the current document, role, view, selection, and device.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: false },
    execute: () => JSON.stringify(options.tools().map((tool) => ({
      name: tool.name,
      commandId: tool.commandId,
      description: tool.description,
    }))),
  }, registration);

  for (const tool of options.tools()) {
    await context.registerTool({
      name: tool.name,
      title: tool.name.replace(/^marks_/, '').replaceAll('_', ' '),
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: {
        readOnlyHint: tool.risk === 'read',
        destructiveHint: tool.risk === 'destructive',
        untrustedContentHint: false,
      },
      execute: async (input, { signal }) => {
        const record = isRecord(input) ? input : {};
        options.focus([tool.commandId], 8_500);
        const receipt = await options.execute(tool.commandId, record, signal);
        return JSON.stringify({
          commandId: receipt.commandId,
          runId: receipt.id,
          status: receipt.status,
          message: receipt.message,
          error: receipt.error,
        });
      },
    }, registration);
  }

  return () => lifecycle.abort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
