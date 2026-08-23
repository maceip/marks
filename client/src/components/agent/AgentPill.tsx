import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { executeAgentSteps } from '../../agent/execution.ts';
import { planAgentRequest, type AgentPlanStep } from '../../agent/planner.ts';
import { useCommandCenter } from '../../commands/context.tsx';
import { getCommand } from '../../commands/registry.ts';
import type { CommandRun } from '../../commands/types.ts';
import { Glyph } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import '../../styles/agent.css';

const SUGGESTIONS = [
  'Show rendered view',
  'Make this bold',
  'Open comments',
  'Pair my phone',
] as const;

interface DisplayStep extends AgentPlanStep {
  runtimeRunId?: string;
}

interface DisplayPlan {
  request: string;
  message: string;
  steps: DisplayStep[];
}

/**
 * A local, command-scoped agent surface. It deliberately receives neither the
 * Markdown document nor selection text: planning is performed against the
 * projected command catalog and every action still passes through the same
 * authorization, approval, cancellation, and receipt path as ribbon clicks.
 */
export function AgentPill() {
  const center = useCommandCenter();
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [plan, setPlan] = useState<DisplayPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeController = useRef<AbortController | null>(null);
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

  const patchStep = useCallback((id: string, patch: Partial<DisplayStep>) => {
    setPlan((current) => current ? {
      ...current,
      steps: current.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
    } : current);
  }, []);

  const cancelCurrent = useCallback(() => {
    const controller = activeController.current;
    if (!controller) return;
    controller.abort();
    setPlan((current) => current ? { ...current, message: 'Agent run cancelled.' } : current);
  }, []);

  const runLocal = useCallback(async (request: string) => {
    const next = planAgentRequest(request, agentCommands);
    setPlan({ request, steps: next.steps.map((step) => ({ ...step })), message: next.message });
    setExpanded(true);
    if (!next.steps.length) return;

    const controller = new AbortController();
    activeController.current = controller;
    setBusy(true);
    try {
      const results = await executeAgentSteps(center, next.steps, {
        signal: controller.signal,
        onStarted: (step, run) => patchStep(step.id, { runtimeRunId: run.id }),
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
      if (activeController.current === controller) activeController.current = null;
      setBusy(false);
    }
  }, [agentCommands, center, patchStep]);

  const submit = useCallback(async (request: string) => {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setInput('');
    await runLocal(trimmed);
  }, [busy, runLocal]);

  useEffect(() => () => activeController.current?.abort(), []);

  return (
    <aside
      className={`agent-pill surface-material-host${expanded ? ' expanded' : ''}${busy || pending.length ? ' active' : ''}`}
      aria-label="Marks command agent"
    >
      <SurfaceMaterial variant="floating" intensity={1.22} />
      {expanded && (
        <div className="agent-pill-panel">
          <header>
            <span>
              <Glyph name="sparkles" size={18} />
              Local command agent
            </span>
            <span className="agent-header-actions">
              {busy && (
                <button type="button" className="agent-run-stop" onClick={cancelCurrent}>
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
            On-device command matching. Your instruction and document text do not leave this browser.
          </p>

          {plan ? (
            <section className="agent-plan" aria-live="polite">
              <p>{plan.message}</p>
              {plan.steps.length > 0 && (
                <ol className="agent-horizon" aria-label="Agent command plan">
                  {plan.steps.map((step) => {
                    const command = agentCommands.find((candidate) => candidate.id === step.commandId) ?? getCommand(step.commandId);
                    const run = step.runtimeRunId ? runById.get(step.runtimeRunId) : undefined;
                    return (
                      <li
                        key={step.id}
                        className={`agent-step state-${run?.status ?? 'planned'}`}
                        data-command-id={step.commandId}
                      >
                        <Glyph name={command?.glyph ?? 'sparkles'} size={18} />
                        <span>
                          <strong>{command?.label ?? step.commandId}</strong>
                          <small>{run?.error ?? run?.message ?? step.reason}</small>
                        </span>
                        <AgentState run={run} />
                      </li>
                    );
                  })}
                </ol>
              )}
              {plan.steps.length === 0 && !busy && <Suggestions onChoose={submit} />}
            </section>
          ) : (
            <Suggestions onChoose={submit} />
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
        <span className="agent-provider" aria-label="Agent provider">Local</span>
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

function Suggestions({ onChoose }: { onChoose: (request: string) => Promise<void> }) {
  return (
    <div className="agent-suggestions">
      {SUGGESTIONS.map((suggestion) => (
        <button key={suggestion} type="button" onClick={() => void onChoose(suggestion)}>
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function AgentState({ run }: { run?: CommandRun }) {
  const center = useCommandCenter();
  if (!run) return <span className="agent-step-state">Planned</span>;
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
