import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hostedConsequence, toHostedAgentTools } from '../../agent/catalog.ts';
import { executeAgentSteps } from '../../agent/execution.ts';
import {
  AgentGatewayError,
  cancelHostedAgentRun,
  createHostedAgentRun,
  getHostedAgentCapabilities,
  streamHostedAgentRun,
  submitHostedAgentToolResult,
} from '../../agent/gateway.ts';
import { planAgentRequest } from '../../agent/planner.ts';
import {
  clearActiveHostedRun,
  readActiveHostedRun,
  writeActiveHostedRun,
  type ActiveHostedRunRecord,
  type StoredHostedToolCall,
} from '../../agent/run-store.ts';
import type {
  HostedAgentCapabilities,
  HostedAgentRunEvent,
  HostedAgentToolResult,
} from '../../agent/types.ts';
import { useCommandCenter } from '../../commands/context.tsx';
import { getCommand } from '../../commands/registry.ts';
import type { CommandReceipt, CommandRun } from '../../commands/types.ts';
import { Glyph } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import '../../styles/agent.css';

const SUGGESTIONS = [
  'Check document health',
  'Audit privacy and links',
  'Show reader simulation',
  'Open the task ledger',
] as const;

type ProviderChoice = 'local' | 'openai';

interface DisplayStep {
  id: string;
  callId?: string;
  commandId: string;
  input: Record<string, unknown>;
  reason: string;
  runtimeRunId?: string;
  fallbackStatus?: CommandReceipt['status'];
}

interface DisplayPlan {
  request: string;
  message: string;
  steps: DisplayStep[];
  assistantText?: string;
  usage?: string;
}

interface ActiveExecution {
  controller: AbortController;
  documentId: string;
  hostedRunId?: string;
  commandRunId?: string;
}

export interface AgentPillProps {
  documentId: string;
  /** A command opened a companion inspector; keep the running receipt visible without covering it. */
  linkedSurface?: string | null;
}

export function AgentPill({ documentId, linkedSurface = null }: AgentPillProps) {
  const center = useCommandCenter();
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [plan, setPlan] = useState<DisplayPlan | null>(null);
  const [provider, setProvider] = useState<ProviderChoice>('local');
  const [capabilities, setCapabilities] = useState<HostedAgentCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<ActiveExecution | null>(null);
  const storedRunRef = useRef<ActiveHostedRunRecord | null>(null);
  const previousDocumentRef = useRef(documentId);
  const agentCommands = useMemo(() => center.commands('agent'), [center]);
  const runById = useMemo(
    () => new Map(center.runs.map((run) => [run.id, run])),
    [center.runs],
  );
  const pending = center.runs.filter((run) =>
    (run.source === 'agent' || run.source === 'bridge') &&
    (run.status === 'awaiting-approval' || run.status === 'running' || run.status === 'proposed'));
  const latestReceipt = [...center.receipts]
    .reverse()
    .find((receipt) => receipt.source === 'agent' || receipt.source === 'bridge');
  const hostedAvailable = center.environment.workspaceKind === 'session' &&
    capabilities?.enabled === true && capabilities.provider === 'openai';

  const patchStep = useCallback((id: string, patch: Partial<DisplayStep>) => {
    setPlan((current) => current ? {
      ...current,
      steps: current.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
    } : current);
  }, []);

  const updateStoredCall = useCallback((call: StoredHostedToolCall) => {
    const current = storedRunRef.current;
    if (!current) return;
    const next = {
      ...current,
      calls: [...current.calls.filter((candidate) => candidate.callId !== call.callId), call],
    };
    storedRunRef.current = next;
    writeActiveHostedRun(next);
  }, []);

  const submitToolReceipt = useCallback(async (
    runId: string,
    receipt: HostedAgentToolResult,
    signal: AbortSignal,
  ) => retryIdempotent(
    () => submitHostedAgentToolResult(runId, receipt),
    signal,
  ), []);

  const handleHostedTool = useCallback(async (
    event: Extract<HostedAgentRunEvent, { type: 'tool.call' }>,
    runId: string,
    controller: AbortController,
  ) => {
    const definition = getCommand(event.commandId);
    const expectedName = `marks_${event.commandId.replace(/[^a-z0-9]+/gi, '_')}`;
    const expectedConsequence = definition
      ? hostedConsequence(definition.risk)
      : null;
    let stored = storedRunRef.current?.calls.find((call) => call.callId === event.callId);

    setPlan((current) => {
      if (!current || current.steps.some((step) => step.callId === event.callId)) return current;
      return {
        ...current,
        message: 'The hosted planner proposed a ribbon command. Marks is rechecking it locally.',
        steps: [...current.steps, {
          id: event.callId,
          callId: event.callId,
          commandId: event.commandId,
          input: event.arguments,
          reason: 'Proposed by the hosted planner; executed by the guarded Marks runtime.',
        }],
      };
    });
    center.focusCommands([event.commandId], 10_000);

    if (stored?.state === 'executing') {
      // The previous page disappeared after launch but before it recorded a
      // terminal command receipt. Re-execution could duplicate a mutation.
      stored = {
        ...stored,
        state: 'terminal',
        status: 'failed',
        error: 'The browser reloaded before the command receipt was recorded; outcome unknown and not replayed.',
      };
      updateStoredCall(stored);
      patchStep(event.callId, { fallbackStatus: 'failed', reason: stored.error });
    }

    if (!stored) {
      const requestId = crypto.randomUUID();
      const invalid = !definition ||
        !definition.agent?.exposed ||
        event.name !== expectedName ||
        !expectedConsequence ||
        event.effect !== expectedConsequence.effect ||
        event.durability !== expectedConsequence.durability;
      if (invalid) {
        stored = {
          callId: event.callId,
          requestId,
          commandId: event.commandId,
          state: 'terminal',
          status: 'failed',
          error: 'The proposed tool did not match the registered Marks command contract.',
        };
        updateStoredCall(stored);
        patchStep(event.callId, { fallbackStatus: 'failed', reason: stored.error });
      } else {
        stored = {
          callId: event.callId,
          requestId,
          commandId: event.commandId,
          state: 'executing',
        };
        updateStoredCall(stored);
        const started = center.start(event.commandId, 'agent', event.arguments);
        if (activeRef.current?.controller === controller) {
          activeRef.current.commandRunId = started.run.id;
        }
        patchStep(event.callId, { runtimeRunId: started.run.id });
        const receipt = await started.finished;
        if (activeRef.current?.controller === controller) {
          activeRef.current.commandRunId = undefined;
        }
        stored = {
          ...stored,
          state: 'terminal',
          status: receipt.status,
          message: receipt.message,
          error: receipt.error,
        };
        // The receipt is persisted before it crosses the network. A retry or
        // reload can resubmit it, but can never launch this call twice.
        updateStoredCall(stored);
      }
    }

    if (controller.signal.aborted || stored.state !== 'terminal' || !stored.status) return;
    await submitToolReceipt(runId, {
      requestId: stored.requestId,
      callId: stored.callId,
      status: stored.status,
      output: {
        commandId: stored.commandId,
        message: stored.message,
        error: stored.error,
      },
    }, controller.signal);
  }, [center, patchStep, submitToolReceipt, updateStoredCall]);

  const consumeHostedRun = useCallback(async (
    record: ActiveHostedRunRecord,
    controller: AbortController,
  ) => {
    try {
      await streamHostedAgentRun(record.eventsUrl, {
        signal: controller.signal,
        after: record.lastEventId,
        onEvent: async (envelope) => {
          const event = envelope.event;
          if (event.type === 'run.started') {
            if (event.runId !== record.runId || event.documentId !== record.documentId) {
              throw new Error('The hosted run identity did not match this document.');
            }
            setPlan((current) => current ? {
              ...current,
              message: 'Hosted planning is live. Relevant ribbon controls will light up before they run.',
            } : current);
          } else if (event.type === 'assistant.delta') {
            setPlan((current) => current ? {
              ...current,
              assistantText: `${current.assistantText ?? ''}${event.text}`.slice(-4_000),
            } : current);
          } else if (event.type === 'tool.call') {
            await handleHostedTool(event, record.runId, controller);
          } else if (event.type === 'run.completed') {
            setPlan((current) => current ? {
              ...current,
              message: event.outputText || 'The hosted plan completed.',
              usage: `${event.usage.totalTokens.toLocaleString()} provider tokens`,
            } : current);
          } else if (event.type === 'run.failed') {
            setPlan((current) => current ? {
              ...current,
              message: `The hosted plan stopped safely (${safeCode(event.code)}).`,
            } : current);
          } else if (event.type === 'run.cancelled') {
            setPlan((current) => current ? { ...current, message: 'The hosted plan was cancelled.' } : current);
          }

          if (
            event.type === 'run.completed' ||
            event.type === 'run.failed' ||
            event.type === 'run.cancelled'
          ) {
            clearActiveHostedRun(record.documentId);
            storedRunRef.current = null;
          } else {
            const current = storedRunRef.current;
            if (current?.runId === record.runId) {
              const next = { ...current, lastEventId: envelope.id };
              storedRunRef.current = next;
              writeActiveHostedRun(next);
            }
          }
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setPlan((current) => current ? {
          ...current,
          message: error instanceof Error ? error.message : 'The hosted plan was interrupted.',
        } : current);
        void cancelHostedAgentRun(record.runId).catch(() => undefined);
        clearActiveHostedRun(record.documentId);
        storedRunRef.current = null;
      }
    } finally {
      if (activeRef.current?.controller === controller) activeRef.current = null;
      setBusy(false);
    }
  }, [handleHostedTool]);

  const cancelCurrent = useCallback(async () => {
    const active = activeRef.current;
    if (!active) return;
    active.controller.abort();
    if (active.commandRunId) center.cancel(active.commandRunId);
    if (active.hostedRunId) {
      await cancelHostedAgentRun(active.hostedRunId).catch(() => undefined);
    }
    clearActiveHostedRun(active.documentId);
    storedRunRef.current = null;
    if (activeRef.current === active) activeRef.current = null;
    setBusy(false);
    setPlan((current) => current ? { ...current, message: 'Agent run cancelled.' } : current);
  }, [center]);

  const runLocal = useCallback(async (request: string) => {
    const next = planAgentRequest(request, agentCommands);
    const steps: DisplayStep[] = next.steps.map((step) => ({ ...step }));
    setPlan({ request, steps, message: next.message });
    setExpanded(true);
    if (!steps.length) return;
    const controller = new AbortController();
    activeRef.current = { controller, documentId };
    setBusy(true);
    try {
      const results = await executeAgentSteps(center, steps, {
        signal: controller.signal,
        onStarted: (step, run) => {
          if (activeRef.current?.controller === controller) activeRef.current.commandRunId = run.id;
          patchStep(step.id, { runtimeRunId: run.id });
        },
        onFinished: () => {
          if (activeRef.current?.controller === controller) activeRef.current.commandRunId = undefined;
        },
      });
      setPlan((current) => {
        if (!current) return current;
        if (controller.signal.aborted) return { ...current, message: 'Agent run cancelled.' };
        const terminal = results.at(-1)?.receipt;
        if (terminal && terminal.status !== 'succeeded') {
          return {
            ...current,
            message: `Stopped safely: ${terminal.error ?? terminal.message ?? 'a command did not complete'}`,
          };
        }
        return {
          ...current,
          message: `${results.length} ribbon command${results.length === 1 ? '' : 's'} completed.`,
        };
      });
    } finally {
      if (activeRef.current?.controller === controller) activeRef.current = null;
      setBusy(false);
    }
  }, [agentCommands, center, documentId, patchStep]);

  const runHosted = useCallback(async (
    request: string,
    advertised: HostedAgentCapabilities,
  ) => {
    const requestId = crypto.randomUUID();
    const promptBytes = new TextEncoder().encode(request).byteLength;
    if (promptBytes > advertised.limits.maxPromptBytes) {
      setPlan({
        request,
        steps: [],
        message: `That instruction is too long for the hosted planner (${promptBytes.toLocaleString()} bytes).`,
      });
      return;
    }
    const tools = toHostedAgentTools(center.agentTools, advertised.limits);
    if (!tools.length) {
      setPlan({ request, steps: [], message: 'No agent-safe ribbon commands are available in this context.' });
      return;
    }
    const controller = new AbortController();
    activeRef.current = { controller, documentId };
    setBusy(true);
    setExpanded(true);
    setPlan({
      request,
      steps: [],
      message: 'Sending only this instruction and the available command catalog to Hosted OpenAI…',
    });
    try {
      const accepted = await retryIdempotent(() => createHostedAgentRun({
        requestId,
        documentId,
        prompt: request,
        tools,
      }), controller.signal);
      if (controller.signal.aborted) return;
      activeRef.current.hostedRunId = accepted.runId;
      const record: ActiveHostedRunRecord = {
        version: 1,
        documentId,
        runId: accepted.runId,
        requestId,
        eventsUrl: accepted.eventsUrl,
        expiresAtMs: accepted.expiresAtMs,
        lastEventId: '',
        calls: [],
      };
      storedRunRef.current = record;
      writeActiveHostedRun(record);
      await consumeHostedRun(record, controller);
    } catch (error) {
      if (!controller.signal.aborted) {
        setPlan((current) => current ? {
          ...current,
          message: error instanceof Error ? error.message : 'The hosted planner could not start.',
        } : current);
      }
      if (activeRef.current?.controller === controller) activeRef.current = null;
      setBusy(false);
    }
  }, [center.agentTools, consumeHostedRun, documentId]);

  const submit = useCallback(async (request: string) => {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setInput('');
    if (provider === 'openai' && hostedAvailable && capabilities) {
      await runHosted(trimmed, capabilities);
    } else {
      await runLocal(trimmed);
    }
  }, [busy, capabilities, hostedAvailable, provider, runHosted, runLocal]);

  useEffect(() => {
    if (center.environment.workspaceKind !== 'session') {
      setCapabilities(null);
      setProvider('local');
      return;
    }
    let live = true;
    void getHostedAgentCapabilities()
      .then((next) => {
        if (live) setCapabilities(next);
      })
      .catch(() => {
        if (live) setCapabilities(null);
      });
    return () => { live = false; };
  }, [center.environment.workspaceKind]);

  useEffect(() => {
    if (!hostedAvailable || activeRef.current) return;
    const restored = readActiveHostedRun(documentId);
    if (!restored) return;
    const controller = new AbortController();
    storedRunRef.current = restored;
    activeRef.current = {
      controller,
      documentId,
      hostedRunId: restored.runId,
    };
    setProvider('openai');
    setExpanded(true);
    setBusy(true);
    setPlan({
      request: 'Resumed hosted run',
      steps: restored.calls.map((call) => ({
        id: call.callId,
        callId: call.callId,
        commandId: call.commandId,
        input: {},
        reason: call.state === 'executing'
          ? 'The previous page closed before a terminal receipt; Marks will not replay it.'
          : call.message ?? call.error ?? 'Recovered command receipt.',
        fallbackStatus: call.status,
      })),
      message: 'Reconnecting to the active hosted run without replaying completed commands…',
    });
    void consumeHostedRun(restored, controller);
  }, [consumeHostedRun, documentId, hostedAvailable]);

  useEffect(() => {
    if (previousDocumentRef.current === documentId) return;
    const previous = previousDocumentRef.current;
    previousDocumentRef.current = documentId;
    const active = activeRef.current;
    if (active?.documentId === previous) {
      active.controller.abort();
      if (active.commandRunId) center.cancel(active.commandRunId);
      if (active.hostedRunId) void cancelHostedAgentRun(active.hostedRunId).catch(() => undefined);
      clearActiveHostedRun(previous);
      activeRef.current = null;
      storedRunRef.current = null;
    }
    setBusy(false);
    setPlan(null);
    setProvider('local');
  }, [center, documentId]);

  useEffect(() => {
    if (linkedSurface) setExpanded(false);
  }, [linkedSurface]);

  useEffect(() => () => {
    // Leave the bounded server run recoverable across reload/focus-mode
    // remounts. Explicit Stop and document changes perform server cancellation.
    activeRef.current?.controller.abort();
  }, []);

  return (
    <aside
      className={`agent-pill surface-material-host${expanded ? ' expanded' : ''}${busy || pending.length ? ' active' : ''}${linkedSurface ? ' inspector-linked' : ''}`}
      data-linked-surface={linkedSurface ?? undefined}
      aria-label="Marks command agent"
    >
      <SurfaceMaterial variant="floating" intensity={1.22} />
      {expanded && (
        <div className="agent-pill-panel">
          <header>
            <span>
              <Glyph name="sparkles" size={18} />
              {provider === 'openai' ? 'Hosted OpenAI planner' : 'Local command agent'}
            </span>
            <span className="agent-header-actions">
              {busy && (
                <button type="button" className="agent-run-stop" onClick={() => void cancelCurrent()}>
                  Stop
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Collapse agent"
                onClick={() => setExpanded(false)}
              >
                <Glyph name="clear" size={15} />
              </button>
            </span>
          </header>
          <p className="agent-privacy">
            {provider === 'openai'
              ? 'Your instruction and command catalog go to the operator-configured OpenAI service. Document Markdown and selection text are not sent. Commands still run here with Marks approvals.'
              : 'On-device command matching. Your instruction and document text do not leave this browser.'}
          </p>

          {plan ? (
            <section className="agent-plan" aria-live="polite">
              <p>{plan.message}</p>
              {plan.assistantText && <p className="agent-assistant-text">{plan.assistantText}</p>}
              {plan.steps.length > 0 && (
                <ol className="agent-horizon" aria-label="Agent command plan">
                  {plan.steps.map((step) => {
                    const command = agentCommands.find((candidate) => candidate.id === step.commandId) ?? getCommand(step.commandId);
                    const run = step.runtimeRunId ? runById.get(step.runtimeRunId) : undefined;
                    return (
                      <li
                        key={step.id}
                        className={`agent-step state-${run?.status ?? step.fallbackStatus ?? 'planned'}`}
                        data-command-id={step.commandId}
                      >
                        <Glyph name={command?.glyph ?? 'sparkles'} size={18} />
                        <span>
                          <strong>{command?.label ?? step.commandId}</strong>
                          <small>{run?.error ?? run?.message ?? step.reason}</small>
                        </span>
                        <AgentState run={run} fallbackStatus={step.fallbackStatus} />
                      </li>
                    );
                  })}
                </ol>
              )}
              {plan.steps.length === 0 && !busy && (
                <div className="agent-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" onClick={() => void submit(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              {plan.usage && <small className="agent-usage">{plan.usage}</small>}
            </section>
          ) : (
            <div className="agent-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void submit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {latestReceipt && !busy && pending.length === 0 && (
            <button
              type="button"
              className={`agent-receipt receipt-${latestReceipt.status}`}
              onClick={() => center.focusCommands([latestReceipt.commandId], 3_000)}
            >
              <span>
                {latestReceipt.status === 'succeeded' ? '✓' : latestReceipt.status === 'cancelled' ? '—' : '!'}
              </span>
              <span>
                <strong>{latestReceipt.status === 'succeeded' ? 'Completed' : latestReceipt.status}</strong>
                <small>{latestReceipt.message ?? latestReceipt.error}</small>
              </span>
            </button>
          )}
        </div>
      )}

      <form
        className="agent-pill-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(input);
        }}
      >
        <button
          type="button"
          className="agent-orb"
          aria-label={expanded ? 'Agent details' : 'Open command agent'}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(true);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <Glyph name="sparkles" size={21} />
          {(busy || pending.length > 0) && <span className="agent-running-dot" />}
        </button>
        <input
          ref={inputRef}
          value={input}
          aria-label="Tell Marks what to do"
          placeholder="Tell Marks what to do…"
          autoComplete="off"
          onFocus={() => setExpanded(true)}
          onChange={(event) => setInput(event.target.value)}
        />
        <select
          className="agent-provider"
          aria-label="Agent provider"
          value={provider}
          disabled={busy}
          onChange={(event) => setProvider(event.target.value === 'openai' ? 'openai' : 'local')}
        >
          <option value="local">Local</option>
          {hostedAvailable && <option value="openai">OpenAI</option>}
        </select>
        <button
          type="submit"
          className="agent-submit"
          aria-label="Run matching ribbon commands"
          disabled={!input.trim() || busy}
        >
          ↑
        </button>
      </form>
    </aside>
  );
}

function AgentState({
  run,
  fallbackStatus,
}: {
  run?: CommandRun;
  fallbackStatus?: CommandReceipt['status'];
}) {
  const center = useCommandCenter();
  if (!run) return <span className="agent-step-state">{fallbackStatus ?? 'Planned'}</span>;
  if (run.status === 'awaiting-approval') {
    return (
      <span className="agent-step-approval">
        <button type="button" onClick={() => center.approve(run.id)}>Approve</button>
        <button type="button" onClick={() => center.cancel(run.id)}>Cancel</button>
      </span>
    );
  }
  if (run.status === 'running' || run.status === 'proposed') {
    return (
      <button type="button" className="agent-step-cancel" onClick={() => center.cancel(run.id)}>
        {run.status === 'running' ? 'Running…' : 'Queued'} · Cancel
      </button>
    );
  }
  return <span className="agent-step-state">{run.status}</span>;
}

async function retryIdempotent<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let delay = 250;
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof AgentGatewayError &&
        (error.code === 'network' || error.status >= 500);
      if (!retryable || attempt >= 2) throw error;
      await wait(delay, signal);
      delay *= 2;
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', finish);
      window.clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function safeCode(code: string): string {
  return /^[a-z0-9_]{1,48}$/u.test(code) ? code.replaceAll('_', ' ') : 'provider error';
}
