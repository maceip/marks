import { COMMANDS } from './registry.ts';
import type {
  AgentToolDefinition,
  CommandDefinition,
  CommandEnvironment,
  CommandId,
  CommandSurface,
  ProjectedCommand,
  ProjectedCommandGroup,
  ProjectedRibbonTab,
  RibbonTabId,
  RibbonTask,
} from './types.ts';
import { EMPTY_PARAMETERS } from './types.ts';

const TAB_LABELS: Record<RibbonTabId, string> = {
  import: 'Start from template',
  login: 'Log In',
  file: 'File',
  home: 'Home',
  insert: 'Insert',
  draw: 'Draw',
  tools: 'Tools',
  review: 'Review',
  view: 'View',
  picture: 'Picture',
  table: 'Table',
  shape: 'Shape',
};

const TAB_ORDER: RibbonTabId[] = [
  'import',
  'login',
  'file',
  'home',
  'insert',
  'draw',
  'tools',
  'review',
  'view',
  'picture',
  'table',
  'shape',
];

const ESSENTIAL_TABS = new Set<RibbonTabId>(['import', 'login', 'file', 'home', 'insert', 'review', 'view']);

export interface ProjectionOptions {
  expanded?: boolean;
  agentRaised?: ReadonlySet<CommandId>;
  pinned?: readonly CommandId[];
}

export interface CommandAvailability {
  visible: boolean;
  enabled: boolean;
  reason?: string;
}

/**
 * Which ribbon projection to show. Foldable unfolded follows the app-rail
 * view. Desktop split follows whichever document pane last received a click.
 */
export function ribbonTask(environment: CommandEnvironment): RibbonTask {
  if (environment.mode === 'preview') return 'inspect';
  if (environment.mode === 'edit') return 'compose';
  if (environment.shell === 'fold-book' || environment.shell === 'fold-laptop') return 'compose';
  return environment.activePane === 'preview' ? 'inspect' : 'compose';
}

function ribbonCommandMode(environment: CommandEnvironment, surface: CommandSurface): CommandEnvironment['mode'] {
  if (surface === 'ribbon' && ribbonTask(environment) === 'inspect') return 'preview';
  return environment.mode;
}

export function commandAvailability(
  command: CommandDefinition,
  environment: CommandEnvironment,
  surface: CommandSurface,
): CommandAvailability {
  if (!command.surfaces.includes(surface)) return { visible: false, enabled: false };

  const commandMode = ribbonCommandMode(environment, surface);
  let reason: string | undefined;
  if (command.requiresDocument && !environment.hasDocument) reason = 'Open a document first.';
  else if (command.requiresDocument && !environment.hydrated) reason = 'The document is still opening.';
  else if (command.modes && !command.modes.includes(commandMode)) {
    reason = commandMode === 'preview'
      ? 'Switch to Editor or Split to change Markdown.'
      : `This command is unavailable in ${commandMode} mode.`;
  } else if (command.contexts && !command.contexts.includes(environment.context)) {
    reason = `Select a ${command.contexts.join(' or ')} to use this command.`;
  } else if (command.workspaceKinds && !command.workspaceKinds.includes(environment.workspaceKind)) {
    reason = workspaceReason(command, environment);
  } else if (command.roles && !environment.capabilities?.role) {
    reason = 'Document authority has not resolved yet.';
  } else if (
    command.roles &&
    !command.roles.includes(environment.capabilities?.role as NonNullable<CommandEnvironment['capabilities']>['role'] & ('owner' | 'editor' | 'commenter' | 'viewer' | 'scratch' | 'local'))
  ) {
    reason = 'Your document role does not allow this command.';
  } else if (command.capability && !environment.capabilities?.[command.capability]) {
    reason = capabilityReason(command.capability);
  } else if (command.requiresSelection && environment.selectionLength === 0) {
    reason = 'Select text first.';
  } else if (command.id === 'input.dictate' && !environment.voiceSupported) {
    reason = 'Voice input is not supported by this browser.';
  } else if (command.id === 'view.split' && environment.shell === 'phone') {
    reason = 'Split view is not available in the phone shell.';
  }

  const inspectRibbon = surface === 'ribbon' && ribbonTask(environment) === 'inspect';
  const context = inspectRibbon ? 'text' : environment.context;
  const contextualMismatch = Boolean(command.contexts && !command.contexts.includes(context));
  const modalityMismatch = Boolean(command.modes && !command.modes.includes(commandMode));
  const identityMismatch = Boolean(
    (command.workspaceKinds && !command.workspaceKinds.includes(environment.workspaceKind)) ||
    (command.roles && !command.roles.includes(environment.capabilities?.role as never)),
  );
  const visible = !command.hiddenWhenUnavailable || !reason
    ? surface === 'ribbon' || surface === 'phone' || surface === 'foldable' || surface === 'mini'
      ? !contextualMismatch && !modalityMismatch
      : true
    : !identityMismatch && !contextualMismatch && !modalityMismatch;

  return { visible, enabled: !reason, reason };
}

function capabilityReason(capability: NonNullable<CommandDefinition['capability']>): string {
  if (capability === 'edit') return 'Your current role can read but cannot edit this document.';
  if (capability === 'comment') return 'Your current role cannot add review comments.';
  if (capability === 'saveVersion') return 'Your current role cannot save or restore versions.';
  return 'Only the document owner can manage access.';
}

function workspaceReason(command: CommandDefinition, environment: CommandEnvironment): string {
  if (environment.workspaceKind === 'scratch') return 'Log in before managing named access or account-only history.';
  if (environment.workspaceKind === 'local') return 'This control requires the Marks identity service.';
  if (command.workspaceKinds?.includes('scratch')) return 'This command only applies before you log in.';
  return 'This command is not available in the current workspace.';
}

function pressed(command: CommandDefinition, environment: CommandEnvironment): boolean | undefined {
  if (command.operation.kind === 'mode') return command.operation.mode === environment.mode;
  if (command.operation.kind === 'toggle') {
    if (command.operation.target === 'outline') return environment.outlineOpen;
    if (command.operation.target === 'hud') return environment.hudOpen;
    if (command.operation.target === 'voice') return environment.voiceActive;
    if (command.operation.target === 'theme') return environment.theme === 'dark';
    if (command.operation.target === 'ribbon') return environment.ribbonCollapsed;
  }
  if (command.id === 'review.comments') return environment.reviewOpen === 'comments';
  if (command.id === 'review.history') return environment.reviewOpen === 'history';
  if (command.id === 'edit.format-painter') return environment.formatPainterArmed;
  return undefined;
}

export function projectCommands(
  environment: CommandEnvironment,
  surface: CommandSurface,
  options: ProjectionOptions = {},
): ProjectedCommand[] {
  const raised = options.agentRaised ?? new Set<CommandId>();
  return COMMANDS.flatMap((command) => {
    const availability = commandAvailability(command, environment, surface);
    if (!availability.visible) return [];
    return [{
      ...command,
      enabled: availability.enabled,
      unavailableReason: availability.reason,
      pressed: pressed(command, environment),
      agentRaised: raised.has(command.id),
    }];
  });
}

export function composeRibbon(
  environment: CommandEnvironment,
  options: ProjectionOptions = {},
): ProjectedRibbonTab[] {
  const expanded = options.expanded ?? false;
  const projected = projectCommands(environment, 'ribbon', options).filter((command) => {
    if (expanded || command.contextual || command.agentRaised) return true;
    if (!ESSENTIAL_TABS.has(command.tab)) return false;
    return command.priority >= 54;
  });

  const tabs = new Map<RibbonTabId, Map<string, ProjectedCommand[]>>();
  for (const command of projected) {
    const groups = tabs.get(command.tab) ?? new Map<string, ProjectedCommand[]>();
    const commands = groups.get(command.group) ?? [];
    commands.push(command);
    groups.set(command.group, commands);
    tabs.set(command.tab, groups);
  }

  return TAB_ORDER.flatMap((tabId) => {
    const groups = tabs.get(tabId);
    if (!groups) return [];
    const projectedGroups: ProjectedCommandGroup[] = [...groups.entries()].map(([label, commands]) => ({
      id: `${tabId}:${slug(label)}`,
      label,
      priority: Math.max(...commands.map((command) => command.priority)),
      contextual: commands.some((command) => command.contextual),
      agentRaised: commands.some((command) => command.agentRaised),
      commands: commands.sort((a, b) => b.priority - a.priority),
    })).sort((a, b) => b.priority - a.priority);
    return [{
      id: tabId,
      label: TAB_LABELS[tabId],
      contextual: projectedGroups.some((group) => group.contextual),
      agentRaised: projectedGroups.some((group) => group.agentRaised),
      groups: projectedGroups,
    }];
  });
}

export function projectQuickAccess(
  environment: CommandEnvironment,
  pinned: readonly CommandId[],
): ProjectedCommand[] {
  return pinned.flatMap((id) => {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    if (!command) return [];
    const availability = commandAvailability(command, environment, 'palette');
    return [{
      ...command,
      enabled: availability.enabled,
      unavailableReason: availability.reason,
      pressed: pressed(command, environment),
    }];
  });
}

export function toAgentTools(environment: CommandEnvironment): AgentToolDefinition[] {
  return projectCommands(environment, 'agent')
    .filter((command) => command.agent?.exposed)
    .map((command) => ({
      type: 'function',
      name: `marks_${command.id.replace(/[^a-z0-9]+/gi, '_')}`,
      description: `${command.description}${command.unavailableReason ? ` Currently unavailable: ${command.unavailableReason}` : ''}`,
      strict: true,
      parameters: command.agent?.parameters ?? EMPTY_PARAMETERS,
      commandId: command.id,
      risk: command.risk,
    }));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
