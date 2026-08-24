import type { CommandId, CommandReceipt, CommandRun } from '../commands/types.ts';

export interface ExecutableAgentStep {
  id: string;
  commandId: CommandId;
  input: Record<string, unknown>;
}

export interface AgentExecutionPort {
  start(
    commandId: CommandId,
    source: 'agent',
    input: Record<string, unknown>,
  ): { run: CommandRun; finished: Promise<CommandReceipt> };
  cancel(runId: string): void;
  focusCommands(commandIds: readonly CommandId[], ttlMs?: number): void;
}

export interface AgentStepResult {
  step: ExecutableAgentStep;
  runId: string;
  receipt: CommandReceipt;
}

/**
 * Execute an agent plan in document order. A later command is never launched
 * until the preceding command has a terminal receipt, including the time a
 * high-consequence command spends waiting for explicit human approval.
 */
export async function executeAgentSteps(
  port: AgentExecutionPort,
  steps: readonly ExecutableAgentStep[],
  options: {
    signal?: AbortSignal;
    onStarted?: (step: ExecutableAgentStep, run: CommandRun) => void;
    onFinished?: (result: AgentStepResult) => void;
  } = {},
): Promise<AgentStepResult[]> {
  const completed: AgentStepResult[] = [];
  let activeRunId: string | null = null;
  const cancel = () => {
    if (activeRunId) port.cancel(activeRunId);
  };
  options.signal?.addEventListener('abort', cancel);
  try {
    for (const step of steps) {
      if (options.signal?.aborted) break;
      port.focusCommands([step.commandId], 8_500);
      const started = port.start(step.commandId, 'agent', step.input);
      activeRunId = started.run.id;
      options.onStarted?.(step, started.run);
      const receipt = await started.finished;
      const result = { step, runId: started.run.id, receipt };
      completed.push(result);
      options.onFinished?.(result);
      activeRunId = null;
      if (receipt.status !== 'succeeded') break;
    }
    return completed;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
