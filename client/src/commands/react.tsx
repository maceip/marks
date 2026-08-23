import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MarkdownFormatSample } from '../editor/actions';
import { executeCommand, type CommandServices } from './executor.ts';
import { composeRibbon, projectCommands, projectQuickAccess, toAgentTools } from './projection.ts';
import {
  defaultRibbonProfile,
  readRibbonProfile,
  type RibbonProfile,
  writeRibbonProfile,
} from './profile.ts';
import { getCommand } from './registry.ts';
import { CommandRuntime } from './runtime.ts';
import { emitCommandEffect } from '../wild/observations.ts';
import type {
  CommandEnvironment,
  CommandId,
  CommandRun,
  CommandSource,
} from './types.ts';
import { CommandCenter, type CommandCenterValue } from './context.tsx';

export interface CommandProviderProps {
  documentId: string;
  environment: CommandEnvironment;
  services: Omit<CommandServices, 'onChooseImage' | 'onFormatPainter'>;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  children: ReactNode;
}

export function CommandProvider({ documentId, environment: providedEnvironment, services, onNotify, children }: CommandProviderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<{
    replace: boolean;
    resolve: (value: boolean) => void;
    signal: AbortSignal;
    cancel: () => void;
  } | null>(null);
  const [profile, setProfile] = useState<RibbonProfile>(() => {
    try { return readRibbonProfile(); } catch { return defaultRibbonProfile(); }
  });
  const [formatSample, setFormatSample] = useState<{
    sample: MarkdownFormatSample;
    from: number;
    to: number;
  } | null>(null);
  const [directed, setDirected] = useState<ReadonlySet<CommandId>>(new Set());
  const focusTimer = useRef<number | null>(null);
  const environment = useMemo<CommandEnvironment>(() => ({
    ...providedEnvironment,
    formatPainterArmed: Boolean(formatSample),
  }), [formatSample, providedEnvironment]);
  const environmentRef = useRef(environment);
  environmentRef.current = environment;
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;

  const chooseImage = useCallback((replace: boolean, signal: AbortSignal) => {
    const input = inputRef.current;
    if (!input || !servicesRef.current.session || !servicesRef.current.getView()) return Promise.resolve(false);
    pickerRef.current?.cancel();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (pickerRef.current?.resolve === resolve) pickerRef.current = null;
        resolve(value);
      };
      const cancel = () => finish(false);
      pickerRef.current = { replace, resolve: finish, signal, cancel };
      signal.addEventListener('abort', cancel, { once: true });
      input.value = '';
      input.click();
      window.addEventListener('focus', () => {
        window.setTimeout(() => {
          if (pickerRef.current?.resolve === finish && !input.files?.length) finish(false);
        }, 400);
      }, { once: true });
    });
  }, []);

  const toggleFormatPainter = useCallback(async () => {
    if (formatSample) {
      setFormatSample(null);
      return true;
    }
    const view = servicesRef.current.getView();
    if (!view) return false;
    const actions = await import('../editor/actions.ts');
    const sample = actions.captureMarkdownFormatting(view);
    const range = view.state.selection.main;
    if (!sample || range.empty) return false;
    setFormatSample({ sample, from: range.from, to: range.to });
    notifyRef.current?.('Format painter armed', 'Select the text that should receive this formatting.', 'neutral');
    return true;
  }, [formatSample]);

  const executorServicesRef = useRef<CommandServices | null>(null);
  executorServicesRef.current = {
    ...services,
    onChooseImage: chooseImage,
    onFormatPainter: toggleFormatPainter,
  };

  const runtimeRef = useRef<CommandRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = new CommandRuntime({
      environment: () => environmentRef.current,
      execute: async (command, input, signal, run) => {
        const activeDocumentId = documentIdRef.current;
        const activeServices = executorServicesRef.current!;
        const beforeText = activeServices.session?.getText() ?? '';
        const beforeEnvironment = environmentRef.current;
        const startedAt = run.startedAt ?? Date.now();
        emitCommandEffect({
          phase: 'started',
          runId: run.id,
          documentId: activeDocumentId,
          commandId: command.id,
          commandLabel: command.label,
          source: run.source,
          risk: command.risk,
          proposedAt: run.proposedAt,
          startedAt,
          beforeText,
          selectionFrom: beforeEnvironment.selectionFrom,
          selectionTo: beforeEnvironment.selectionTo,
          modeBefore: beforeEnvironment.mode,
        });
        try {
          const result = await executeCommand(command, input, signal, activeServices);
          const afterText = activeServices.session?.getText() ?? beforeText;
          emitCommandEffect({
            phase: 'finished',
            runId: run.id,
            documentId: activeDocumentId,
            commandId: command.id,
            commandLabel: command.label,
            source: run.source,
            risk: command.risk,
            proposedAt: run.proposedAt,
            startedAt,
            finishedAt: Date.now(),
            status: signal.aborted ? 'cancelled' : result.ok ? 'succeeded' : 'failed',
            message: result.message,
            error: result.ok ? undefined : result.message,
            beforeText,
            afterText,
            selectionFrom: beforeEnvironment.selectionFrom,
            selectionTo: beforeEnvironment.selectionTo,
            modeBefore: beforeEnvironment.mode,
          });
          return result;
        } catch (error) {
          emitCommandEffect({
            phase: 'finished',
            runId: run.id,
            documentId: activeDocumentId,
            commandId: command.id,
            commandLabel: command.label,
            source: run.source,
            risk: command.risk,
            proposedAt: run.proposedAt,
            startedAt,
            finishedAt: Date.now(),
            status: signal.aborted ? 'cancelled' : 'failed',
            error: error instanceof Error ? error.message : 'Command failed.',
            beforeText,
            afterText: activeServices.session?.getText() ?? beforeText,
            selectionFrom: beforeEnvironment.selectionFrom,
            selectionTo: beforeEnvironment.selectionTo,
            modeBefore: beforeEnvironment.mode,
          });
          throw error;
        }
      },
    });
  }
  const runtime = runtimeRef.current;
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);

  useEffect(() => () => {
    pickerRef.current?.cancel();
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    runtime.destroy();
  }, [runtime]);

  useEffect(() => {
    if (!formatSample || providedEnvironment.selectionLength === 0) return;
    if (
      providedEnvironment.selectionFrom === formatSample.from &&
      providedEnvironment.selectionTo === formatSample.to
    ) return;
    const view = services.getView();
    if (!view) return;
    let active = true;
    void import('../editor/actions.ts').then((actions) => {
      if (!active) return;
      const applied = actions.applyMarkdownFormatting(view, formatSample.sample);
      setFormatSample(null);
      if (applied) {
        void services.session?.whenDurable().then(
          () => notifyRef.current?.('Formatting painted', 'The formatting change is durable.', 'success'),
          (error) => notifyRef.current?.('Formatting applied locally', error instanceof Error ? error.message : 'Durability is pending.', 'danger'),
        );
      }
    });
    return () => { active = false; };
  }, [formatSample, providedEnvironment.selectionFrom, providedEnvironment.selectionLength, providedEnvironment.selectionTo, services]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'marks:ribbon-profile:v1') setProfile(readRibbonProfile());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const activeRaised = useMemo(() => {
    const next = new Set(directed);
    for (const run of snapshot.runs) {
      if (run.source === 'agent' || run.source === 'bridge') {
        if (run.status === 'proposed' || run.status === 'awaiting-approval' || run.status === 'running') {
          next.add(run.commandId);
        }
      }
    }
    return next;
  }, [directed, snapshot.runs]);

  const persistProfile = useCallback((next: RibbonProfile) => {
    setProfile(next);
    writeRibbonProfile(next);
  }, []);

  const invoke = useCallback(async (
    id: CommandId,
    source: CommandSource = 'human',
    input: Record<string, unknown> = {},
  ) => {
    const receipt = await runtime.invoke(id, { source, input });
    if (receipt.status === 'failed') {
      notifyRef.current?.(`${getCommand(id)?.label ?? 'Command'} unavailable`, receipt.error, 'danger');
    }
    return receipt;
  }, [runtime]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      let commandId: string | null = null;
      if (event.shiftKey && key === 'p') commandId = 'workspace.command-palette';
      else if (event.shiftKey && key === 'f') commandId = 'view.focus';
      else if (event.shiftKey && key === 'o') commandId = 'view.outline';
      else if (event.shiftKey && key === 'm') commandId = 'view.hud';
      else if (event.key === 'F1') commandId = 'view.ribbon';
      else if (!event.shiftKey && key === 'n') commandId = 'document.new';
      else if (!event.shiftKey && key === 'p') commandId = 'document.print';
      else if (!event.shiftKey && key === 'f') commandId = 'edit.find';
      else if (!event.shiftKey && key === '\\') {
        const modes = environmentRef.current.shell === 'phone'
          ? ['view.editor', 'view.preview']
          : ['view.editor', 'view.split', 'view.preview'];
        const current = `view.${environmentRef.current.mode}`;
        commandId = modes[(modes.indexOf(current) + 1) % modes.length];
      }
      if (!commandId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void invoke(commandId, 'keyboard');
    };
    window.addEventListener('keydown', onShortcut, true);
    return () => window.removeEventListener('keydown', onShortcut, true);
  }, [invoke]);

  const focusCommands = useCallback((ids: readonly CommandId[], ttlMs = 4800) => {
    const valid = new Set(ids.filter((id) => Boolean(getCommand(id))));
    setDirected(valid);
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      setDirected(new Set());
      focusTimer.current = null;
    }, Math.max(500, Math.min(ttlMs, 30_000)));
  }, []);

  const value = useMemo<CommandCenterValue>(() => ({
    environment,
    profile,
    raised: activeRaised,
    runs: snapshot.runs,
    receipts: snapshot.receipts,
    ribbon: composeRibbon(environment, { expanded: profile.expanded, agentRaised: activeRaised }),
    commands: (surface) => projectCommands(environment, surface, { agentRaised: activeRaised }),
    quickAccess: projectQuickAccess(environment, profile.pinned),
    agentTools: toAgentTools(environment),
    invoke,
    start: (id, source = 'human', input = {}) => runtime.start(id, { source, input }),
    propose: (id, input = {}) => runtime.propose(id, input),
    approve: (runId) => runtime.approve(runId),
    cancel: (runId) => runtime.cancel(runId),
    setExpanded: (expanded) => persistProfile({ ...profile, expanded, touched: true }),
    togglePin: (id) => persistProfile({
      ...profile,
      pinned: profile.pinned.includes(id)
        ? profile.pinned.filter((current) => current !== id)
        : [...profile.pinned, id].slice(-12),
      touched: true,
    }),
    focusCommands,
  }), [activeRaised, environment, focusCommands, invoke, persistProfile, profile, runtime, snapshot.receipts, snapshot.runs]);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const bridge: MarksRibbonBridge = {
      version: 1,
      listTools: () => toAgentTools(valueRef.current.environment),
      propose: (commandId, input = {}) => valueRef.current.propose(commandId, input),
      approve: (runId) => valueRef.current.approve(runId),
      cancel: (runId) => valueRef.current.cancel(runId),
      focus: (commandIds, ttlMs) => valueRef.current.focusCommands(commandIds, ttlMs),
      state: () => ({ runs: valueRef.current.runs, receipts: valueRef.current.receipts }),
    };
    window.marksRibbon = bridge;
    return () => {
      if (window.marksRibbon === bridge) delete window.marksRibbon;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let dispose: () => void = () => undefined;
    void import('./webmcp.ts').then(({ registerMarksWebMcp }) => registerMarksWebMcp({
      tools: () => toAgentTools(environmentRef.current),
      focus: (commandIds, ttlMs) => valueRef.current.focusCommands(commandIds, ttlMs),
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
    })).then((cleanup) => {
      if (active) dispose = cleanup;
      else cleanup();
    }).catch(() => undefined);
    return () => {
      active = false;
      dispose();
    };
  }, [runtime]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('marks:command-state', {
      detail: { runs: snapshot.runs, receipts: snapshot.receipts },
    }));
  }, [snapshot]);

  return (
    <CommandCenter.Provider value={value}>
      {children}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        aria-hidden="true"
        onChange={(event) => {
          const pending = pickerRef.current;
          const file = event.currentTarget.files?.[0];
          const view = servicesRef.current.getView();
          const session = servicesRef.current.session;
          if (!pending || !file || !view || !session || pending.signal.aborted) {
            pending?.resolve(false);
            return;
          }
          void import('../editor/actions.ts')
            .then((actions) => pending.replace
              ? actions.replaceImageFileAtCursor(view, session, file)
              : actions.insertImageFile(view, session, file))
            .then(pending.resolve)
            .catch((error) => {
              notifyRef.current?.('Image not inserted', error instanceof Error ? error.message : 'The upload failed.', 'danger');
              pending.resolve(false);
            });
        }}
      />
    </CommandCenter.Provider>
  );
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
