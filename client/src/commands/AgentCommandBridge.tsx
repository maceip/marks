import '../styles/agent.css';
import { useEffect, useRef } from 'react';
import type { CommandCenterValue } from './context.tsx';
import { toAgentTools } from './projection.ts';
import type { CommandRuntime } from './runtime.ts';
import type { CommandId, CommandRun } from './types.ts';
import { registerMarksWebMcp } from './webmcp.ts';

export interface AgentCommandBridgeProps {
  runtime: CommandRuntime;
  center: CommandCenterValue;
}

/**
 * Agent-only browser entry points live in this feature-owned chunk so a stable
 * build omits their implementation rather than merely returning early at
 * runtime. The shared command provider supplies only its current runtime state.
 */
export function AgentCommandBridge({ runtime, center }: AgentCommandBridgeProps) {
  const centerRef = useRef(center);
  centerRef.current = center;

  useEffect(() => {
    const bridge: MarksRibbonBridge = {
      version: 1,
      listTools: () => toAgentTools(centerRef.current.environment),
      propose: (commandId, input = {}) => centerRef.current.propose(commandId, input),
      approve: (runId) => centerRef.current.approve(runId),
      cancel: (runId) => centerRef.current.cancel(runId),
      focus: (commandIds, ttlMs) => centerRef.current.focusCommands(commandIds, ttlMs),
      state: () => ({
        runs: centerRef.current.runs,
        receipts: centerRef.current.receipts,
      }),
    };
    window.marksRibbon = bridge;

    let active = true;
    let disposeWebMcp: () => void = () => undefined;
    void registerMarksWebMcp({
      tools: () => toAgentTools(centerRef.current.environment),
      focus: (commandIds, ttlMs) => centerRef.current.focusCommands(commandIds, ttlMs),
      execute: async (commandId, input, signal) => {
        const started = runtime.start(commandId, { source: 'bridge', input });
        const cancel = () => runtime.cancel(started.run.id);
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
        try {
          return await started.finished;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      },
    }).then((cleanup) => {
      if (active) disposeWebMcp = cleanup;
      else cleanup();
    }).catch(() => undefined);

    return () => {
      active = false;
      disposeWebMcp();
      if (window.marksRibbon === bridge) delete window.marksRibbon;
    };
  }, [runtime]);

  return null;
}

export interface MarksRibbonBridge {
  version: 1;
  listTools(): ReturnType<typeof toAgentTools>;
  propose(commandId: CommandId, input?: Record<string, unknown>): CommandRun;
  approve(runId: string): void;
  cancel(runId: string): void;
  focus(commandIds: CommandId[], ttlMs?: number): void;
  state(): Pick<CommandCenterValue, 'runs' | 'receipts'>;
}

declare global {
  interface Window {
    marksRibbon?: MarksRibbonBridge;
  }
}
