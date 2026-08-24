import type { DocumentCapabilities, DocumentRole } from '../collab/types';
import type { EditorContextKind } from '../editor/context';
import type { Shell } from '../lib/posture';
import type { UiActionId } from '../lib/ui-actions';
import type { GlyphName } from '../components/glyphs/Glyph';

export type CommandId = string;
export type CommandSource = 'human' | 'keyboard' | 'palette' | 'agent' | 'bridge';
export type CommandModality = 'edit' | 'split' | 'preview';
export type RibbonPane = 'editor' | 'preview';
export type RibbonTask = 'compose' | 'inspect';
export type CommandSurface = 'ribbon' | 'phone' | 'foldable' | 'mini' | 'palette' | 'quick-access' | 'agent';
export type CommandRisk = 'read' | 'write' | 'external' | 'destructive';
export type CommandCapability = keyof Pick<
  DocumentCapabilities,
  'edit' | 'comment' | 'saveVersion' | 'manageShares'
>;

export type RibbonTabId =
  | 'file'
  | 'home'
  | 'insert'
  | 'draw'
  | 'tools'
  | 'review'
  | 'view'
  | 'picture'
  | 'table'
  | 'shape';

export type EditorOperation =
  | 'paste'
  | 'cut'
  | 'copy'
  | 'format-painter'
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'highlight'
  | 'inline-code'
  | 'grow-heading'
  | 'shrink-heading'
  | 'clear-formatting'
  | 'bullet-list'
  | 'numbered-list'
  | 'task-list'
  | 'quote'
  | 'indent'
  | 'outdent'
  | 'find'
  | 'insert-image-url'
  | 'insert-image-file'
  | 'insert-shape-rect'
  | 'insert-shape-ellipse'
  | 'insert-shape-diamond'
  | 'insert-shape-arrow'
  | 'insert-shape-bubble'
  | 'insert-table'
  | 'add-table-row'
  | 'add-table-column'
  | 'insert-link'
  | 'insert-footnote'
  | 'insert-code-block'
  | 'insert-math'
  | 'insert-mermaid'
  | 'insert-callout-info'
  | 'insert-callout-warning'
  | 'insert-callout-danger'
  | 'insert-horizontal-rule'
  | 'insert-toc'
  | 'image-small'
  | 'image-medium'
  | 'image-full'
  | 'image-left'
  | 'image-center'
  | 'image-right'
  | 'replace-image-url'
  | 'replace-image-file'
  | 'change-shape-rect'
  | 'change-shape-ellipse'
  | 'change-shape-diamond'
  | 'change-shape-arrow'
  | 'change-shape-bubble';

export type CommandOperation =
  | { kind: 'editor'; operation: EditorOperation }
  | { kind: 'ui'; action: UiActionId }
  | { kind: 'mode'; mode: CommandModality }
  | { kind: 'toggle'; target: 'outline' | 'hud' | 'theme' | 'voice' | 'ribbon' };

export interface CommandParameterSchema {
  type: 'object';
  properties?: Record<string, {
    type: 'string' | 'number' | 'boolean';
    description?: string;
    enum?: readonly (string | number | boolean)[];
  }>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface CommandDefinition {
  id: CommandId;
  label: string;
  description: string;
  category: 'Document' | 'Edit' | 'Insert' | 'Review' | 'View' | 'Identity' | 'Tools';
  tab: RibbonTabId;
  group: string;
  glyph: GlyphName;
  operation: CommandOperation;
  keyTip?: string;
  shortcut?: string;
  aliases?: readonly string[];
  surfaces: readonly CommandSurface[];
  modes?: readonly CommandModality[];
  contexts?: readonly EditorContextKind[];
  roles?: readonly (DocumentRole | 'scratch' | 'local')[];
  workspaceKinds?: readonly ('local' | 'scratch' | 'session')[];
  capability?: CommandCapability;
  requiresDocument?: boolean;
  requiresSelection?: boolean;
  risk: CommandRisk;
  priority: number;
  presentation?: 'small' | 'large' | 'gallery';
  contextual?: boolean;
  pinByDefault?: boolean;
  hiddenWhenUnavailable?: boolean;
  agent?: {
    exposed: boolean;
    parameters?: CommandParameterSchema;
  };
}

export interface CommandEnvironment {
  hasDocument: boolean;
  hydrated: boolean;
  capabilities: DocumentCapabilities | null;
  workspaceKind: 'local' | 'scratch' | 'session';
  mode: CommandModality;
  activePane: RibbonPane;
  shell: Shell;
  context: EditorContextKind;
  selectionLength: number;
  selectionFrom: number;
  selectionTo: number;
  voiceSupported: boolean;
  voiceActive: boolean;
  theme: 'light' | 'dark';
  outlineOpen: boolean;
  hudOpen: boolean;
  ribbonCollapsed: boolean;
  reviewOpen: 'comments' | 'history' | null;
  formatPainterArmed: boolean;
}

export interface ProjectedCommand extends CommandDefinition {
  enabled: boolean;
  unavailableReason?: string;
  pressed?: boolean;
  agentRaised?: boolean;
}

export interface ProjectedCommandGroup {
  id: string;
  label: string;
  priority: number;
  commands: ProjectedCommand[];
  contextual: boolean;
  agentRaised: boolean;
}

export interface ProjectedRibbonTab {
  id: RibbonTabId;
  label: string;
  contextual: boolean;
  agentRaised: boolean;
  groups: ProjectedCommandGroup[];
}

export type CommandRunStatus =
  | 'proposed'
  | 'awaiting-approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CommandRun {
  id: string;
  commandId: CommandId;
  source: CommandSource;
  status: CommandRunStatus;
  input: Record<string, unknown>;
  proposedAt: number;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
  error?: string;
}

export interface CommandReceipt extends CommandRun {
  status: 'succeeded' | 'failed' | 'cancelled';
}

export interface CommandExecutionResult {
  ok: boolean;
  message?: string;
}

export interface AgentToolDefinition {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: CommandParameterSchema;
  commandId: CommandId;
  risk: CommandRisk;
}

export const EMPTY_PARAMETERS: CommandParameterSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
