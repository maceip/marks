import { useEffect, useRef, useState } from 'react';
import type { CollabSession } from '../../collab/types.ts';
import { getCommand } from '../../commands/registry.ts';
import {
  deriveContextSignals,
  digestText,
  minimalSourceDelta,
  predictConsequences,
  reverseCounterfactual,
} from '../../wild/model.ts';
import { subscribeCommandEffects } from '../../wild/observations.ts';
import {
  putCausalReceipt,
  putCounterfactual,
  reconcileContextSignals,
} from '../../wild/store.ts';
import type {
  CommandEffectObservation,
  ConsequenceLane,
} from '../../wild/types.ts';
import { SurfaceMaterial } from '../ui/SurfaceMaterial.tsx';
import '../../styles/wild.css';

interface ActivePath {
  observation: CommandEffectObservation;
  lanes: ConsequenceLane[];
  settling: boolean;
}

export interface WildTelemetryProps {
  documentId: string;
  session: CollabSession;
  onOpenCausal: () => void;
}

/**
 * The possibility layer listens after the guarded command center has admitted
 * a command. Source text stays in this component long enough to derive a
 * bounded local receipt and an optional reversal patch; it is never sent to a
 * provider or copied into the causal ledger.
 */
export function WildTelemetry({ documentId, session, onOpenCausal }: WildTelemetryProps) {
  const [active, setActive] = useState<ActivePath | null>(null);
  const clearTimer = useRef<number | null>(null);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const off = subscribeCommandEffects((observation) => {
      if (observation.documentId !== documentId) return;
      const command = getCommand(observation.commandId);
      if (!command) return;
      const lanes = predictConsequences(command);
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
      setActive({ observation, lanes, settling: observation.phase === 'finished' });

      if (observation.phase === 'started') return;
      clearTimer.current = window.setTimeout(() => {
        setActive((current) => current?.observation.runId === observation.runId ? null : current);
        clearTimer.current = null;
      }, 1_800);

      persistenceQueue.current = persistenceQueue.current.then(async () => {
        const before = observation.beforeText;
        const after = observation.afterText ?? before;
        let counterfactualId: string | null = null;
        if (observation.status === 'succeeded' && before !== after) {
          const patch = await reverseCounterfactual(
            documentId,
            `Before ${observation.commandLabel}`,
            observation.commandId,
            observation.source === 'agent' || observation.source === 'bridge' ? 'agent' : 'command',
            before,
            after,
            observation.finishedAt,
          );
          if (patch) {
            try {
              await putCounterfactual(patch);
              counterfactualId = patch.id;
            } catch {
              // A full shelf must not erase the independent causal receipt.
            }
          }
        }
        await putCausalReceipt({
          id: `causal:${observation.runId}`,
          documentId,
          commandId: observation.commandId,
          commandLabel: observation.commandLabel,
          source: observation.source,
          risk: observation.risk,
          status: observation.status ?? 'failed',
          proposedAt: observation.proposedAt,
          startedAt: observation.startedAt,
          finishedAt: observation.finishedAt ?? Date.now(),
          beforeDigest: await digestText(before),
          afterDigest: await digestText(after),
          beforeChars: before.length,
          afterChars: after.length,
          selectionFrom: observation.selectionFrom,
          selectionTo: observation.selectionTo,
          modeBefore: observation.modeBefore,
          sourceDelta: minimalSourceDelta(before, after),
          lanes,
          counterfactualId,
          message: observation.message ?? null,
          error: observation.error ?? null,
        });
      }).catch(() => undefined);
    });
    return () => {
      off();
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    };
  }, [documentId]);

  useEffect(() => {
    let timer: number | null = null;
    let disposed = false;
    const scan = () => {
      timer = null;
      if (disposed) return;
      const discovered = deriveContextSignals(documentId, session.getText());
      void reconcileContextSignals(documentId, discovered).catch(() => undefined);
    };
    const schedule = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(scan, delay);
    };
    schedule(80);
    const off = session.onChange(() => schedule(650));
    return () => {
      disposed = true;
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [documentId, session]);

  if (!active) return null;
  const touched = active.lanes.filter((lane) => lane.impact !== 'none');
  return (
    <button
      type="button"
      className={`causal-lightpath surface-material-host${active.settling ? ' is-settling' : ''}`}
      data-command-id={active.observation.commandId}
      data-command-phase={active.observation.phase}
      aria-label={`Open causal receipt for ${active.observation.commandLabel}`}
      onClick={onOpenCausal}
    >
      <SurfaceMaterial variant="floating" intensity={1.05} />
      <span className="lightpath-origin">{active.observation.source === 'agent' ? 'Agent' : 'Ribbon'}</span>
      <strong>{active.observation.commandLabel}</strong>
      <span className="lightpath-rail" aria-hidden="true">
        {touched.map((lane) => <i key={lane.id} data-lane={lane.id} data-impact={lane.impact} />)}
      </span>
      <span className="lightpath-state">
        {active.settling
          ? active.observation.status === 'succeeded' ? 'receipt sealed' : active.observation.status
          : 'tracing consequence'}
      </span>
    </button>
  );
}
