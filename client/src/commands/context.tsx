import { createContext, useContext } from 'react';
import type { RibbonProfile } from './profile.ts';
import type {
  CommandEnvironment,
  CommandId,
  CommandReceipt,
  CommandRun,
  CommandSource,
  CommandSurface,
  ProjectedCommand,
  ProjectedRibbonTab,
} from './types.ts';

/**
 * The deliberately tiny React seam between the document shell and the command
 * runtime. Keeping this module free of registry/runtime values lets the home
 * route render TopBar without loading the document-only command system.
 */
export interface CommandCenterValue {
  environment: CommandEnvironment;
  profile: RibbonProfile;
  ribbon: ProjectedRibbonTab[];
  raised: ReadonlySet<CommandId>;
  runs: readonly CommandRun[];
  receipts: readonly CommandReceipt[];
  commands: (surface: CommandSurface) => ProjectedCommand[];
  quickAccess: ProjectedCommand[];
  invoke: (id: CommandId, source?: CommandSource, input?: Record<string, unknown>) => Promise<CommandReceipt>;
  start: (
    id: CommandId,
    source?: CommandSource,
    input?: Record<string, unknown>,
  ) => { run: CommandRun; finished: Promise<CommandReceipt> };
  propose: (id: CommandId, input?: Record<string, unknown>) => CommandRun;
  approve: (runId: string) => void;
  cancel: (runId: string) => void;
  setExpanded: (expanded: boolean) => void;
  togglePin: (id: CommandId) => void;
  focusCommands: (ids: readonly CommandId[], ttlMs?: number) => void;
}

export const CommandCenter = createContext<CommandCenterValue | null>(null);

export function useCommandCenter(): CommandCenterValue {
  const value = useContext(CommandCenter);
  if (!value) throw new Error('useCommandCenter must be used inside CommandProvider');
  return value;
}

export function useOptionalCommandCenter(): CommandCenterValue | null {
  return useContext(CommandCenter);
}
