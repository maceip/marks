import { commandInvocationAvailability } from './projection.ts';
import { requireCommand } from './registry.ts';
import type {
  CommandDefinition,
  CommandEnvironment,
  CommandExecutionResult,
  CommandId,
  CommandReceipt,
  CommandRun,
  CommandSource,
} from './types.ts';

export interface RuntimeInvocation {
  source: CommandSource;
  input?: Record<string, unknown>;
  bypassApproval?: boolean;
}

export type CommandExecutor = (
  command: CommandDefinition,
  input: Record<string, unknown>,
  signal: AbortSignal,
  run: Readonly<CommandRun>,
) => Promise<CommandExecutionResult>;

export interface CommandRuntimeOptions {
  environment: () => CommandEnvironment;
  execute: CommandExecutor;
  now?: () => number;
  id?: () => string;
  maxReceipts?: number;
}

export interface CommandRuntimeSnapshot {
  runs: readonly CommandRun[];
  receipts: readonly CommandReceipt[];
}

interface PendingRun {
  run: CommandRun;
  abort: AbortController;
  resolve: (receipt: CommandReceipt) => void;
  finished: Promise<CommandReceipt>;
}

export interface StartedCommandRun {
  run: CommandRun;
  finished: Promise<CommandReceipt>;
}

export class CommandRuntime {
  private readonly environment: () => CommandEnvironment;
  private readonly executor: CommandExecutor;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly maxReceipts: number;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingRun>();
  private runs: CommandRun[] = [];
  private receipts: CommandReceipt[] = [];
  private snapshot: CommandRuntimeSnapshot = { runs: this.runs, receipts: this.receipts };

  constructor(options: CommandRuntimeOptions) {
    this.environment = options.environment;
    this.executor = options.execute;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.maxReceipts = options.maxReceipts ?? 40;
  }

  getSnapshot = (): CommandRuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async invoke(commandId: CommandId, invocation: RuntimeInvocation): Promise<CommandReceipt> {
    return this.start(commandId, invocation).finished;
  }

  /** Start a command and retain its identity so external callers can cancel it. */
  start(commandId: CommandId, invocation: RuntimeInvocation): StartedCommandRun {
    const pending = this.create(commandId, invocation);
    if (pending.run.status === 'proposed') queueMicrotask(() => void this.execute(pending.run.id));
    return { run: pending.run, finished: pending.finished };
  }

  propose(commandId: CommandId, input: Record<string, unknown> = {}, source: Extract<CommandSource, 'agent' | 'bridge'> = 'agent'): CommandRun {
    return this.start(commandId, { source, input }).run;
  }

  approve(runId: string): void {
    const pending = this.pending.get(runId);
    if (!pending || pending.run.status !== 'awaiting-approval') return;
    this.update(runId, { status: 'proposed', message: 'Approved' });
    void this.execute(runId);
  }

  cancel(runId: string): void {
    const pending = this.pending.get(runId);
    if (!pending || isTerminal(pending.run.status)) return;
    pending.abort.abort();
    this.finish(runId, 'cancelled', 'Cancelled before completion.');
  }

  destroy(): void {
    for (const pending of this.pending.values()) pending.abort.abort();
    for (const id of [...this.pending.keys()]) this.finish(id, 'cancelled', 'Command surface closed.');
    this.listeners.clear();
  }

  private create(commandId: CommandId, invocation: RuntimeInvocation): PendingRun {
    const command = requireCommand(commandId);
    const source = invocation.source;
    const availability = commandInvocationAvailability(command, this.environment(), source);
    const inputError = source === 'agent' || source === 'bridge'
      ? validateInput(command, invocation.input ?? {})
      : undefined;
    const needsApproval = (source === 'agent' || source === 'bridge') &&
      (command.risk === 'external' || command.risk === 'destructive') &&
      !invocation.bypassApproval;
    const run: CommandRun = {
      id: this.id(),
      commandId,
      source,
      status: availability.enabled && !inputError
        ? needsApproval ? 'awaiting-approval' : 'proposed'
        : 'failed',
      input: invocation.input ?? {},
      proposedAt: this.now(),
      message: needsApproval ? approvalMessage(command) : undefined,
      error: inputError ?? (availability.enabled ? undefined : availability.reason ?? 'Command is unavailable.'),
    };
    let resolve!: (receipt: CommandReceipt) => void;
    const finished = new Promise<CommandReceipt>((next) => { resolve = next; });
    const pending: PendingRun = { run, abort: new AbortController(), resolve, finished };
    this.pending.set(run.id, pending);
    this.runs = [...this.runs, run].slice(-12);
    this.publish();
    if (run.status === 'failed') this.finish(run.id, 'failed', run.error);
    return pending;
  }

  private async execute(runId: string): Promise<void> {
    const pending = this.pending.get(runId);
    if (!pending || pending.run.status !== 'proposed') return;
    const command = requireCommand(pending.run.commandId);
    const availability = commandInvocationAvailability(command, this.environment(), pending.run.source);
    if (!availability.enabled) {
      this.finish(runId, 'failed', availability.reason ?? 'Command became unavailable.');
      return;
    }

    this.update(runId, { status: 'running', startedAt: this.now(), message: `Running ${command.label}` });
    try {
      const result = await this.executor(command, pending.run.input, pending.abort.signal, pending.run);
      if (pending.abort.signal.aborted) {
        this.finish(runId, 'cancelled', 'Cancelled before completion.');
      } else if (result.ok) {
        this.finish(runId, 'succeeded', result.message ?? `${command.label} completed.`);
      } else {
        this.finish(runId, 'failed', result.message ?? `${command.label} could not be applied.`);
      }
    } catch (error) {
      if (pending.abort.signal.aborted) this.finish(runId, 'cancelled', 'Cancelled before completion.');
      else this.finish(runId, 'failed', error instanceof Error ? error.message : 'Command failed.');
    }
  }

  private update(runId: string, patch: Partial<CommandRun>): void {
    const pending = this.pending.get(runId);
    if (!pending) return;
    pending.run = { ...pending.run, ...patch };
    this.runs = this.runs.map((run) => run.id === runId ? pending.run : run);
    this.publish();
  }

  private finish(runId: string, status: CommandReceipt['status'], message?: string): void {
    const pending = this.pending.get(runId);
    // A rejected invocation is born with `failed` status so projections can
    // paint it synchronously. It is still pending until this method emits and
    // resolves the terminal receipt. Every other terminal run has already
    // been removed from `pending`, which is the actual duplicate guard.
    if (!pending) return;
    const receipt: CommandReceipt = {
      ...pending.run,
      status,
      finishedAt: this.now(),
      message: status === 'failed' ? pending.run.message : message,
      error: status === 'failed' ? message ?? pending.run.error : undefined,
    };
    this.pending.delete(runId);
    this.runs = this.runs.map((run) => run.id === runId ? receipt : run);
    this.receipts = [...this.receipts, receipt].slice(-this.maxReceipts);
    this.publish();
    pending.resolve(receipt);
  }

  private publish(): void {
    this.snapshot = { runs: this.runs, receipts: this.receipts };
    for (const listener of this.listeners) listener();
  }
}

function approvalMessage(command: CommandDefinition): string {
  return command.risk === 'destructive'
    ? `${command.label} can remove or revoke data. Approve before it runs.`
    : `${command.label} crosses the browser or service boundary. Approve before it runs.`;
}

function isTerminal(status: CommandRun['status']): status is CommandReceipt['status'] {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function validateInput(command: CommandDefinition, input: Record<string, unknown>): string | undefined {
  const schema = command.agent?.parameters;
  if (!schema) return Object.keys(input).length ? 'This command does not accept arguments.' : undefined;
  const properties = schema.properties ?? {};
  if (!schema.additionalProperties) {
    const unknown = Object.keys(input).find((key) => !(key in properties));
    if (unknown) return `Unknown command argument: ${unknown}`;
  }
  for (const required of schema.required ?? []) {
    if (!(required in input)) return `Missing required command argument: ${required}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) continue;
    if (typeof value !== property.type) return `Command argument ${key} must be ${property.type}.`;
    if (property.enum && !property.enum.includes(value as never)) return `Command argument ${key} is outside the allowed values.`;
  }
  return undefined;
}
