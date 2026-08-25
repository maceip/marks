import type { UiActionId } from '../lib/ui-actions';
import { RIBBON_WILD_ENABLED } from '../lib/product.ts';
import type {
  CommandDefinition,
  CommandId,
  CommandModality,
  CommandOperation,
  CommandSource,
  CommandSurface,
  EditorOperation,
  RibbonTabId,
} from './types.ts';
import { EMPTY_PARAMETERS } from './types.ts';

// Node unit tests execute this registry without Vite. Production replaces the
// property-level branch with a literal and erases disabled command definitions.
const RIBBON_WILD_BUILD_ENABLED = typeof __MARKS_VITE_BUILD__ === 'undefined'
  ? RIBBON_WILD_ENABLED
  : __MARKS_FEATURES__.ribbonWild;

const ALL: readonly CommandSurface[] = ['ribbon', 'phone', 'foldable', 'palette', 'agent'];
const EDIT: readonly CommandModality[] = ['edit', 'split'];
const IMAGE_URL_PARAMETERS = {
  type: 'object' as const,
  properties: {
    url: { type: 'string' as const, description: 'An absolute HTTP(S) image URL or a same-origin asset path.' },
    alt: { type: 'string' as const, description: 'Concise alternative text for the image.' },
  },
  required: ['url'] as const,
  additionalProperties: false as const,
};

type Seed = Omit<CommandDefinition, 'description' | 'risk' | 'priority' | 'surfaces' | 'invocationSources' | 'agent'> &
  Partial<Pick<CommandDefinition, 'description' | 'risk' | 'priority' | 'surfaces' | 'invocationSources' | 'agent'>>;

const HUMAN_SURFACES = new Set<CommandSurface>(['ribbon', 'phone', 'foldable', 'mini', 'quick-access']);

/**
 * Preserve the established entry-point contract while keeping it distinct
 * from presentation. A future phone-only command is human-invokable without
 * pretending it belongs on the desktop ribbon; agent and palette admission
 * remain exactly as narrow as their registered surfaces.
 */
function defaultInvocationSources(surfaces: readonly CommandSurface[]): readonly CommandSource[] {
  const sources: CommandSource[] = [];
  if (surfaces.some((surface) => HUMAN_SURFACES.has(surface))) sources.push('human');
  if (surfaces.includes('palette')) sources.push('keyboard', 'palette');
  if (surfaces.includes('agent')) sources.push('agent', 'bridge');
  return sources;
}

function define(seed: Seed): CommandDefinition {
  const requestedSurfaces = seed.surfaces ?? ALL;
  const surfaces: readonly CommandSurface[] = requestedSurfaces.includes('foldable') ||
    !requestedSurfaces.includes('ribbon')
    ? requestedSurfaces
    : [...requestedSurfaces, 'foldable' as const];
  return {
    ...seed,
    description: seed.description ?? seed.label,
    risk: seed.risk ?? 'write',
    priority: seed.priority ?? 50,
    surfaces,
    invocationSources: seed.invocationSources ?? defaultInvocationSources(surfaces),
    agent: seed.agent ?? { exposed: true, parameters: EMPTY_PARAMETERS },
  };
}

function editor(
  id: string,
  label: string,
  operation: EditorOperation,
  tab: RibbonTabId,
  group: string,
  glyph: CommandDefinition['glyph'],
  extra: Partial<Seed> = {},
): CommandDefinition {
  return define({
    id,
    label,
    operation: { kind: 'editor', operation },
    tab,
    group,
    glyph,
    category: tab === 'insert' || tab === 'draw' ? 'Insert' : 'Edit',
    modes: EDIT,
    capability: operation === 'copy' || operation === 'find' ? undefined : 'edit',
    requiresDocument: true,
    ...extra,
  });
}

function ui(
  id: string,
  label: string,
  action: UiActionId,
  tab: RibbonTabId,
  group: string,
  glyph: CommandDefinition['glyph'],
  extra: Partial<Seed> = {},
): CommandDefinition {
  return define({
    id,
    label,
    operation: { kind: 'ui', action },
    tab,
    group,
    glyph,
    category: tab === 'review' ? 'Review' : tab === 'view' ? 'View' : 'Document',
    risk: 'read',
    ...extra,
  });
}

const definitions: CommandDefinition[] = [
  ui('import.notes-app', 'Notes', 'template-notes', 'import', 'Templates', 'file', { description: 'Create a lightweight notes page', keyTip: 'N', priority: 100, presentation: 'large', requiresDocument: false }),
  ui('import.meeting', 'Meeting', 'template-meeting', 'import', 'Templates', 'meetingNotes', { description: 'Create a meeting page for notes, decisions, and actions', keyTip: 'M', priority: 98, presentation: 'large', requiresDocument: false }),
  ui('import.github-readme', 'GitHub README', 'template-github-readme', 'import', 'Templates', 'githubReadme', { description: 'Create a README with installation, usage, and contribution sections', keyTip: 'G', priority: 96, presentation: 'large', requiresDocument: false }),
  ui('import.url', 'Import web page', 'import-url', 'import', 'Sources', 'importWebsite', { description: 'Convert a public web page to Markdown', keyTip: 'U', priority: 94, presentation: 'large', requiresDocument: false, risk: 'external', agent: { exposed: false } }),
  ui('document.import', 'From file', 'import', 'import', 'Sources', 'download', { description: 'Import Markdown, PDF, Word, or Excel', keyTip: 'F', priority: 92, requiresDocument: false, risk: 'external', agent: { exposed: false } }),
  ui('document.new', 'New', 'new', 'file', 'Create', 'plus', { description: 'Create a blank document', keyTip: 'N', priority: 100, requiresDocument: false }),
  ui('document.templates', 'Template', 'templates', 'file', 'Create', 'startTemplate', { description: 'Create from a structured template', keyTip: 'T', requiresDocument: false }),
  ui('document.rename', 'Rename', 'rename', 'file', 'Document', 'pencil', { description: 'Rename the current document', keyTip: 'R', roles: ['owner', 'local'], requiresDocument: true, hiddenWhenUnavailable: true }),
  ui('document.duplicate', 'Duplicate', 'duplicate', 'file', 'Document', 'duplicate', { description: 'Create an independent copy', keyTip: 'D', requiresDocument: true }),
  ui('document.export-markdown', 'Markdown', 'download', 'file', 'Export', 'download', { description: 'Download the Markdown source', keyTip: 'M', requiresDocument: true, risk: 'external' }),
  ui('document.export-bundle', 'Bundle', 'download-bundle', 'file', 'Export', 'download', { description: 'Download Markdown and referenced assets', keyTip: 'B', requiresDocument: true, risk: 'external' }),
  ui('document.print', 'Print', 'print', 'file', 'Export', 'print', { description: 'Print the rendered document or save it as PDF', keyTip: 'P', shortcut: '⌘P', requiresDocument: true, risk: 'external' }),
  ui('document.share', 'Share', 'share', 'file', 'Access', 'share', { description: 'Manage document access and links', keyTip: 'S', capability: 'manageShares', workspaceKinds: ['session'], requiresDocument: true, risk: 'external', hiddenWhenUnavailable: true }),
  ui('document.delete', 'Delete', 'delete', 'file', 'Document', 'trash', { description: 'Move this document to recoverable trash', keyTip: 'X', roles: ['owner', 'scratch', 'local'], requiresDocument: true, risk: 'destructive', hiddenWhenUnavailable: true }),
  ui('workspace.trash', 'Trash', 'trash', 'file', 'Workspace', 'trash', { description: 'Open recoverable deleted documents', requiresDocument: false, workspaceKinds: ['local', 'session'] }),
  ui('workspace.command-palette', 'Command palette', 'command-palette', 'view', 'Navigate', 'find', { description: 'Search every available Marks command', shortcut: '⌘⇧P', requiresDocument: false, surfaces: ['ribbon'], agent: { exposed: false }, priority: 25 }),
  ui('workspace.about', 'Google Docs for Markdown', 'about', 'view', 'Navigate', 'template', { description: 'Open the built-in Marks introduction', requiresDocument: false, surfaces: ['palette', 'agent'], priority: 20 }),

  editor('edit.paste', 'Paste', 'paste', 'home', 'Clipboard', 'paste', { description: 'Paste Markdown-aware clipboard content', keyTip: 'V', priority: 100, presentation: 'large', risk: 'external', agent: { exposed: false } }),
  editor('edit.cut', 'Cut', 'cut', 'home', 'Clipboard', 'cut', { keyTip: 'X', requiresSelection: true, agent: { exposed: false } }),
  editor('edit.copy', 'Copy', 'copy', 'home', 'Clipboard', 'copy', { keyTip: 'C', requiresSelection: true, risk: 'read', agent: { exposed: false } }),
  editor('edit.format-painter', 'Painter', 'format-painter', 'home', 'Clipboard', 'painter', { description: 'Capture formatting, then apply it to another selection', keyTip: 'F', requiresSelection: true, agent: { exposed: false } }),
  editor('format.paragraph', 'Body', 'paragraph', 'home', 'Styles', 'pencil', { description: 'Convert the active line to body text', keyTip: 'P', presentation: 'gallery', priority: 90 }),
  editor('format.heading-1', 'Heading 1', 'heading-1', 'home', 'Styles', 'heading', { description: 'Apply top-level heading style', keyTip: '1', presentation: 'gallery', priority: 92 }),
  editor('format.heading-2', 'Heading 2', 'heading-2', 'home', 'Styles', 'heading', { description: 'Apply second-level heading style', keyTip: '2', presentation: 'gallery', priority: 91 }),
  editor('format.heading-3', 'Heading 3', 'heading-3', 'home', 'Styles', 'heading', { description: 'Apply third-level heading style', keyTip: '3', presentation: 'gallery', priority: 75 }),
  editor('format.heading-4', 'Heading 4', 'heading-4', 'home', 'Styles', 'heading', { description: 'Apply fourth-level heading style', keyTip: '4', presentation: 'gallery', priority: 65 }),
  editor('format.bold', 'Bold', 'bold', 'home', 'Font', 'bold', { description: 'Toggle strong emphasis', keyTip: 'B', shortcut: '⌘B', priority: 100, surfaces: ['ribbon', 'phone', 'mini', 'palette', 'quick-access', 'agent'], pinByDefault: true }),
  editor('format.italic', 'Italic', 'italic', 'home', 'Font', 'italic', { description: 'Toggle emphasis', keyTip: 'I', shortcut: '⌘I', priority: 99, surfaces: ['ribbon', 'phone', 'mini', 'palette', 'quick-access', 'agent'], pinByDefault: true }),
  editor('format.underline', 'Underline', 'underline', 'home', 'Font', 'underline', { description: 'Toggle Markdown underline extension', keyTip: 'U', priority: 70 }),
  editor('format.strikethrough', 'Strike', 'strikethrough', 'home', 'Font', 'strike', { description: 'Toggle strikethrough', keyTip: 'K', priority: 70 }),
  editor('format.highlight', 'Highlight', 'highlight', 'home', 'Font', 'highlight', { description: 'Toggle highlighted text', keyTip: 'H', priority: 84, surfaces: ['ribbon', 'phone', 'mini', 'palette', 'agent'] }),
  editor('format.inline-code', 'Inline code', 'inline-code', 'home', 'Font', 'code', { description: 'Toggle inline code', keyTip: 'C', priority: 88, surfaces: ['ribbon', 'phone', 'mini', 'palette', 'agent'] }),
  editor('format.grow-heading', 'Grow', 'grow-heading', 'home', 'Font', 'grow', { description: 'Promote the active heading', priority: 45 }),
  editor('format.shrink-heading', 'Shrink', 'shrink-heading', 'home', 'Font', 'shrink', { description: 'Demote the active heading', priority: 44 }),
  editor('format.clear', 'Clear', 'clear-formatting', 'home', 'Font', 'clear', { description: 'Remove Markdown formatting from the selection', priority: 50 }),
  editor('paragraph.bullets', 'Bullets', 'bullet-list', 'home', 'Paragraph', 'list', { description: 'Toggle a bulleted list', keyTip: 'L', priority: 87, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('paragraph.numbered', 'Numbered', 'numbered-list', 'home', 'Paragraph', 'numbered', { description: 'Toggle a numbered list', priority: 75 }),
  editor('paragraph.tasks', 'Tasks', 'task-list', 'home', 'Paragraph', 'task', { description: 'Toggle a task list', keyTip: 'T', priority: 86, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('paragraph.quote', 'Quote', 'quote', 'home', 'Paragraph', 'quote', { description: 'Toggle block quote', priority: 70 }),
  editor('paragraph.indent', 'Indent', 'indent', 'home', 'Paragraph', 'indent', { description: 'Indent selected lines', priority: 55 }),
  editor('paragraph.outdent', 'Outdent', 'outdent', 'home', 'Paragraph', 'outdent', { description: 'Outdent selected lines', priority: 54 }),
  editor('edit.find', 'Find', 'find', 'home', 'Editing', 'find', { description: 'Find text in the Markdown source', keyTip: 'F', shortcut: '⌘F', risk: 'read', priority: 85, capability: undefined }),
  define({ id: 'input.dictate', label: 'Dictate', description: 'Toggle browser speech input', category: 'Edit', tab: 'home', group: 'Editing', glyph: 'mic', operation: { kind: 'toggle', target: 'voice' }, surfaces: ['ribbon', 'phone', 'palette'], modes: EDIT, capability: 'edit', requiresDocument: true, risk: 'external', priority: 60, agent: { exposed: false } }),

  editor('insert.picture-url', 'Picture URL', 'insert-image-url', 'insert', 'Illustrations', 'image', { description: 'Insert image Markdown from a URL', keyTip: 'P', priority: 82, agent: { exposed: true, parameters: IMAGE_URL_PARAMETERS } }),
  editor('insert.picture-file', 'From file', 'insert-image-file', 'insert', 'Illustrations', 'image', { description: 'Upload and insert an image file', keyTip: 'F', priority: 90, risk: 'external', agent: { exposed: false } }),
  editor('insert.shape-rect', 'Rectangle', 'insert-shape-rect', 'draw', 'Shapes', 'rect', { description: 'Insert a rectangular semantic figure', priority: 72 }),
  editor('insert.shape-ellipse', 'Ellipse', 'insert-shape-ellipse', 'draw', 'Shapes', 'ellipse', { description: 'Insert an elliptical semantic figure', priority: 65 }),
  editor('insert.shape-diamond', 'Diamond', 'insert-shape-diamond', 'draw', 'Shapes', 'diamond', { description: 'Insert a diamond semantic figure', priority: 64 }),
  editor('insert.shape-arrow', 'Arrow', 'insert-shape-arrow', 'draw', 'Shapes', 'arrow', { description: 'Insert an arrow semantic figure', priority: 63 }),
  editor('insert.shape-bubble', 'Callout shape', 'insert-shape-bubble', 'draw', 'Shapes', 'bubble', { description: 'Insert a callout-shaped semantic figure', priority: 62 }),
  editor('insert.table', 'Table', 'insert-table', 'insert', 'Table', 'table', { description: 'Insert a Markdown table', keyTip: 'T', priority: 88, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('table.add-row', 'Add row', 'add-table-row', 'insert', 'Table', 'row', { description: 'Add a row to the active table', contexts: ['table'], priority: 75 }),
  editor('table.add-column', 'Add column', 'add-table-column', 'insert', 'Table', 'column', { description: 'Add a column to the active table', contexts: ['table'], priority: 74 }),
  editor('insert.link', 'Link', 'insert-link', 'insert', 'Links', 'link', { description: 'Insert or wrap a Markdown link', keyTip: 'L', priority: 93, surfaces: ['ribbon', 'phone', 'mini', 'palette', 'agent'] }),
  editor('insert.footnote', 'Footnote', 'insert-footnote', 'insert', 'Links', 'footnote', { description: 'Insert a footnote definition', priority: 58 }),
  ui('review.comments', 'Comments', 'comments', 'review', 'Review', 'comment', { description: 'Open anchored review threads', keyTip: 'C', requiresDocument: true, workspaceKinds: ['local', 'session'], priority: 100 }),
  ui('review.history', 'History', 'history', 'review', 'Review', 'history', { description: 'Open durable version history', keyTip: 'H', requiresDocument: true, workspaceKinds: ['local', 'session'], priority: 95 }),
  editor('insert.code-block', 'Code block', 'insert-code-block', 'insert', 'Blocks', 'code', { description: 'Insert a fenced code block', priority: 78, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('insert.math', 'Math', 'insert-math', 'insert', 'Blocks', 'math', { description: 'Insert a display math block', priority: 77, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('insert.mermaid', 'Diagram', 'insert-mermaid', 'insert', 'Blocks', 'mermaid', { description: 'Insert a Mermaid diagram', priority: 76, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('insert.callout-info', 'Info callout', 'insert-callout-info', 'insert', 'Blocks', 'callout', { description: 'Insert an informational callout', priority: 74, surfaces: ['ribbon', 'phone', 'palette', 'agent'] }),
  editor('insert.callout-warning', 'Warning callout', 'insert-callout-warning', 'draw', 'Notes', 'callout', { description: 'Insert a warning callout', priority: 65 }),
  editor('insert.callout-danger', 'Danger callout', 'insert-callout-danger', 'draw', 'Notes', 'callout', { description: 'Insert a danger callout', priority: 64 }),
  editor('insert.break', 'Divider', 'insert-horizontal-rule', 'insert', 'Blocks', 'hr', { description: 'Insert a thematic break', priority: 55 }),
  editor('insert.toc', 'Contents', 'insert-toc', 'insert', 'Blocks', 'toc', { description: 'Insert a generated table-of-contents marker', priority: 54 }),

  ui('tools.draft', 'Draft tools', 'draft-tools', 'tools', 'Transforms', 'sparkles', { description: 'Open deterministic local Markdown transforms', requiresDocument: true, capability: 'edit', modes: EDIT, risk: 'write', priority: 100, presentation: 'large' }),

  ui('review.document-health', 'Health', 'practical-health', 'review', 'Assurance', 'gauge', { description: 'Open the prioritized document-health report', requiresDocument: true, priority: 100, presentation: 'large' }),
  ui('review.render-diagnostics', 'Render', 'practical-render', 'review', 'Assurance', 'code', { description: 'Inspect source constructs that can break compiled output', requiresDocument: true, priority: 78 }),
  ui('review.accessibility', 'Accessibility', 'practical-accessibility', 'review', 'Assurance', 'eye', { description: 'Check headings, images, links, and table semantics', requiresDocument: true, priority: 92 }),
  ui('tools.front-matter', 'Front matter', 'practical-schema', 'tools', 'Document model', 'file', { description: 'Edit portable metadata while preserving unknown YAML and comments', requiresDocument: true, priority: 92 }),
  ui('document.publish-profile', 'Publish', 'practical-publish', 'file', 'Publish', 'share', { description: 'Configure web, print, README, or slide publishing intent', requiresDocument: true, priority: 72 }),
  ui('review.link-intelligence', 'Links', 'practical-links', 'review', 'Evidence', 'link', { description: 'Resolve internal targets and explicitly check external links', requiresDocument: true, priority: 82 }),
  ui('review.citation-ledger', 'Citations', 'practical-citations', 'review', 'Evidence', 'footnote', { description: 'Reconcile citations, footnotes, and source records', requiresDocument: true, priority: 76 }),
  ui('tools.structure', 'Structure', 'practical-structure', 'tools', 'Document model', 'outline', { description: 'Move, rename, promote, demote, or extract complete sections', requiresDocument: true, priority: 88 }),
  ui('review.collaboration-console', 'People', 'practical-collaboration', 'review', 'Live document', 'comment', { description: 'Inspect authority, peers, connection, and durability', requiresDocument: true, priority: 70 }),
  ui('document.recovery', 'Recovery', 'practical-recovery', 'file', 'Document', 'history', { description: 'Prove savedness and create portable recovery checkpoints', requiresDocument: true, priority: 64 }),
  ui('review.version-compare', 'Compare', 'practical-versions', 'review', 'Live document', 'history', { description: 'Compare durable versions and branch without overwriting', requiresDocument: true, priority: 74 }),
  ui('tools.asset-inspector', 'Assets', 'practical-assets', 'tools', 'Document model', 'image', { description: 'Audit image origins, alt text, reuse, and portable state', requiresDocument: true, priority: 76 }),
  ui('view.reader-simulation', 'Reader', 'practical-reader', 'view', 'Reading', 'eye', { description: 'Simulate reading pace and responsive output contexts', requiresDocument: true, priority: 82 }),
  ui('review.privacy-exposure', 'Privacy', 'practical-privacy', 'review', 'Assurance', 'focus', { description: 'Find sensitive values and outbound exposure before sharing', requiresDocument: true, priority: 90 }),
  ui('review.task-decision-ledger', 'Ledger', 'practical-ledger', 'review', 'Evidence', 'task', { description: 'Collect actionable work and decisions from Markdown', requiresDocument: true, priority: 75 }),
  ui('tools.paste-intent', 'Paste intent', 'practical-paste', 'tools', 'Transforms', 'paste', { description: 'Choose how clipboard material lands and record provenance', requiresDocument: true, capability: 'edit', risk: 'external', priority: 84, agent: { exposed: false } }),
  ui('insert.cross-document-block', 'Document block', 'practical-blocks', 'insert', 'Links', 'duplicate', { description: 'Insert an access-checked reference to another document section', requiresDocument: true, capability: 'edit', priority: 72, risk: 'write' }),
  ui('review.quality-contract', 'Quality', 'practical-quality', 'review', 'Assurance', 'sparkles', { description: 'Declare the audience and inspect readability against its contract', requiresDocument: true, priority: 86 }),

  ...(RIBBON_WILD_BUILD_ENABLED ? [
    ui('wild.intent-horizon', 'Horizon', 'wild-intent-horizon', 'review', 'Possibility', 'sparkles', { description: 'Infer and declare inspectable next actions for this exact document', requiresDocument: true, priority: 97, presentation: 'large' }),
    ui('wild.causal-lightpath', 'Lightpath', 'wild-causal-lightpath', 'review', 'Possibility', 'mermaid', { description: 'Inspect receipts from real ribbon and agent commands', requiresDocument: true, priority: 83 }),
    ui('wild.consequence-lanes', 'Lanes', 'wild-consequence-lanes', 'review', 'Possibility', 'split', { description: 'Stage a command and predict its source, render, collaboration, durability, and external effects', requiresDocument: true, priority: 88 }),
    ui('wild.context-half-life', 'Half-life', 'wild-context-half-life', 'review', 'Time & alternatives', 'history', { description: 'Track time-sensitive claims and review their explicit freshness cadence', requiresDocument: true, priority: 84 }),
    ui('wild.counterfactual-shelf', 'Shelf', 'wild-counterfactual-shelf', 'review', 'Time & alternatives', 'duplicate', { description: 'Preserve reversible source alternatives without overwriting the live document', requiresDocument: true, priority: 91 }),
  ] : []),

  ui('review.performance', 'Performance', 'benchmark', 'review', 'Inspect', 'gauge', { description: 'Open the engine performance receipt', requiresDocument: false, priority: 45 }),
  define({ id: 'view.editor', label: 'Editor', description: 'Show only the Markdown source', category: 'View', tab: 'view', group: 'Layout', glyph: 'pencil', operation: { kind: 'mode', mode: 'edit' }, surfaces: ALL, requiresDocument: true, risk: 'read', priority: 90, keyTip: 'E', agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  define({ id: 'view.split', label: 'Split', description: 'Show source and rendered output together', category: 'View', tab: 'view', group: 'Layout', glyph: 'split', operation: { kind: 'mode', mode: 'split' }, surfaces: ALL, requiresDocument: true, risk: 'read', priority: 100, keyTip: 'S', agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  define({ id: 'view.preview', label: 'Preview', description: 'Show only the compiled Markdown rendering', category: 'View', tab: 'view', group: 'Layout', glyph: 'eye', operation: { kind: 'mode', mode: 'preview' }, surfaces: ALL, requiresDocument: true, risk: 'read', priority: 95, keyTip: 'P', agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  ui('view.ghost-overlay', 'Ghost overlay', 'ghost-overlay', 'view', 'Layout', 'ghostOverlay', { description: 'Explain and control the rendered Markdown guide while editing on a phone', surfaces: ['phone'], requiresDocument: true, priority: 92, presentation: 'large', agent: { exposed: false } }),
  define({ id: 'view.outline', label: 'Outline', description: 'Toggle the document outline', category: 'View', tab: 'view', group: 'Workspace', glyph: 'outline', operation: { kind: 'toggle', target: 'outline' }, surfaces: ALL, requiresDocument: true, risk: 'read', priority: 85, agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  ui('view.focus', 'Focus', 'focus', 'view', 'Workspace', 'focus', { description: 'Hide chrome and focus on the page', requiresDocument: true, priority: 72 }),
  ui('view.preferences', 'Appearance', 'preferences', 'view', 'Workspace', 'settings', { description: 'Tune density, material, and motion', requiresDocument: false, priority: 60 }),
  define({ id: 'view.theme', label: 'Theme', description: 'Toggle light and dark appearance', category: 'View', tab: 'view', group: 'Workspace', glyph: 'moon', operation: { kind: 'toggle', target: 'theme' }, surfaces: ALL, requiresDocument: false, risk: 'read', priority: 55, agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  define({ id: 'view.hud', label: 'Performance HUD', description: 'Toggle live rendering and engine telemetry', category: 'View', tab: 'view', group: 'Workspace', glyph: 'gauge', operation: { kind: 'toggle', target: 'hud' }, surfaces: ['ribbon', 'palette', 'agent'], requiresDocument: true, risk: 'read', priority: 42, agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),
  define({ id: 'view.ribbon', label: 'Minimize ribbon', description: 'Collapse or expand the command ribbon', category: 'View', tab: 'view', group: 'Workspace', glyph: 'shrink', operation: { kind: 'toggle', target: 'ribbon' }, surfaces: ['ribbon', 'palette', 'agent'], requiresDocument: true, risk: 'read', priority: 35, shortcut: '⌃F1', agent: { exposed: true, parameters: EMPTY_PARAMETERS } }),

  editor('picture.small', 'Small', 'image-small', 'picture', 'Size', 'shrink', { description: 'Set the active image width to 240 pixels', contexts: ['image'], contextual: true, priority: 80 }),
  editor('picture.medium', 'Medium', 'image-medium', 'picture', 'Size', 'image', { description: 'Set the active image width to 480 pixels', contexts: ['image'], contextual: true, priority: 90 }),
  editor('picture.full', 'Full', 'image-full', 'picture', 'Size', 'grow', { description: 'Set the active image width to 720 pixels', contexts: ['image'], contextual: true, priority: 78 }),
  editor('picture.left', 'Left', 'image-left', 'picture', 'Position', 'alignLeft', { description: 'Align the active image left', contexts: ['image'], contextual: true, priority: 72 }),
  editor('picture.center', 'Center', 'image-center', 'picture', 'Position', 'alignCenter', { description: 'Center the active image', contexts: ['image'], contextual: true, priority: 75 }),
  editor('picture.right', 'Right', 'image-right', 'picture', 'Position', 'alignRight', { description: 'Align the active image right', contexts: ['image'], contextual: true, priority: 71 }),
  editor('picture.replace-url', 'Replace URL', 'replace-image-url', 'picture', 'Replace', 'link', { description: 'Replace the active image URL without inserting another image', contexts: ['image'], contextual: true, priority: 60, agent: { exposed: true, parameters: IMAGE_URL_PARAMETERS } }),
  editor('picture.replace-file', 'Replace file', 'replace-image-file', 'picture', 'Replace', 'image', { description: 'Upload a replacement for the active image', contexts: ['image'], contextual: true, priority: 65, risk: 'external', agent: { exposed: false } }),

  editor('table.context-row', 'Add row', 'add-table-row', 'table', 'Rows and columns', 'row', { description: 'Add a row to the active table', contexts: ['table'], contextual: true, priority: 90 }),
  editor('table.context-column', 'Add column', 'add-table-column', 'table', 'Rows and columns', 'column', { description: 'Add a column to the active table', contexts: ['table'], contextual: true, priority: 89 }),
  editor('table.context-new', 'New table', 'insert-table', 'table', 'Rows and columns', 'table', { description: 'Insert a new table after the active table', contexts: ['table'], contextual: true, priority: 65 }),

  editor('shape.change-rect', 'Rectangle', 'change-shape-rect', 'shape', 'Change shape', 'rect', { description: 'Change the active shape to a rectangle', contexts: ['shape'], contextual: true, priority: 90 }),
  editor('shape.change-ellipse', 'Ellipse', 'change-shape-ellipse', 'shape', 'Change shape', 'ellipse', { description: 'Change the active shape to an ellipse', contexts: ['shape'], contextual: true, priority: 89 }),
  editor('shape.change-diamond', 'Diamond', 'change-shape-diamond', 'shape', 'Change shape', 'diamond', { description: 'Change the active shape to a diamond', contexts: ['shape'], contextual: true, priority: 88 }),
  editor('shape.change-arrow', 'Arrow', 'change-shape-arrow', 'shape', 'Change shape', 'arrow', { description: 'Change the active shape to an arrow', contexts: ['shape'], contextual: true, priority: 87 }),
  editor('shape.change-bubble', 'Callout', 'change-shape-bubble', 'shape', 'Change shape', 'bubble', { description: 'Change the active shape to a callout', contexts: ['shape'], contextual: true, priority: 86 }),

  ui('identity.keep', 'Log In', 'keep-workspace', 'login', 'Account', 'share', { description: 'Log in with your phone', requiresDocument: false, workspaceKinds: ['scratch'], category: 'Identity', priority: 100, presentation: 'large', hiddenWhenUnavailable: true }),
  ui('identity.account', 'Account', 'account', 'file', 'Account', 'settings', { description: 'Manage your account and logged-in devices', requiresDocument: false, workspaceKinds: ['session'], category: 'Identity', priority: 70, hiddenWhenUnavailable: true }),
  ui('identity.pairing', 'Approve Login', 'pairing', 'file', 'Account', 'link', { description: 'Approve a login from another device', requiresDocument: false, workspaceKinds: ['session'], category: 'Identity', priority: 75, hiddenWhenUnavailable: true, risk: 'external' }),
  ui('identity.sign-out', 'Log Out', 'logout', 'file', 'Account', 'clear', { description: 'Log out on this browser', requiresDocument: false, workspaceKinds: ['session'], category: 'Identity', priority: 40, hiddenWhenUnavailable: true, risk: 'destructive' }),
];

const byId = new Map(definitions.map((definition) => [definition.id, definition]));
if (byId.size !== definitions.length) throw new Error('Command registry contains a duplicate id');

export const COMMANDS: readonly CommandDefinition[] = Object.freeze(definitions);

export const LEGACY_ACTION_TO_COMMAND: Readonly<Record<UiActionId, CommandId>> = Object.freeze({
  new: 'document.new',
  templates: 'document.templates',
  import: 'document.import',
  'template-notes': 'import.notes-app',
  'template-meeting': 'import.meeting',
  'template-github-readme': 'import.github-readme',
  'import-url': 'import.url',
  rename: 'document.rename',
  duplicate: 'document.duplicate',
  download: 'document.export-markdown',
  'download-bundle': 'document.export-bundle',
  print: 'document.print',
  delete: 'document.delete',
  trash: 'workspace.trash',
  share: 'document.share',
  comments: 'review.comments',
  history: 'review.history',
  'command-palette': 'workspace.command-palette',
  preferences: 'view.preferences',
  'ghost-overlay': 'view.ghost-overlay',
  focus: 'view.focus',
  benchmark: 'review.performance',
  about: 'workspace.about',
  'keep-workspace': 'identity.keep',
  account: 'identity.account',
  pairing: 'identity.pairing',
  logout: 'identity.sign-out',
  find: 'edit.find',
  'draft-tools': 'tools.draft',
  'practical-health': 'review.document-health',
  'practical-render': 'review.render-diagnostics',
  'practical-accessibility': 'review.accessibility',
  'practical-schema': 'tools.front-matter',
  'practical-publish': 'document.publish-profile',
  'practical-links': 'review.link-intelligence',
  'practical-citations': 'review.citation-ledger',
  'practical-structure': 'tools.structure',
  'practical-collaboration': 'review.collaboration-console',
  'practical-recovery': 'document.recovery',
  'practical-versions': 'review.version-compare',
  'practical-assets': 'tools.asset-inspector',
  'practical-reader': 'view.reader-simulation',
  'practical-privacy': 'review.privacy-exposure',
  'practical-ledger': 'review.task-decision-ledger',
  'practical-paste': 'tools.paste-intent',
  'practical-blocks': 'insert.cross-document-block',
  'practical-quality': 'review.quality-contract',
  ...(RIBBON_WILD_BUILD_ENABLED ? {
    'wild-intent-horizon': 'wild.intent-horizon',
    'wild-causal-lightpath': 'wild.causal-lightpath',
    'wild-consequence-lanes': 'wild.consequence-lanes',
    'wild-context-half-life': 'wild.context-half-life',
    'wild-counterfactual-shelf': 'wild.counterfactual-shelf',
  } as const : {}),
} as Record<UiActionId, CommandId>);

export function getCommand(id: CommandId): CommandDefinition | undefined {
  return byId.get(id);
}

export function requireCommand(id: CommandId): CommandDefinition {
  const command = getCommand(id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  return command;
}

export function commandOperation(id: CommandId): CommandOperation | undefined {
  return getCommand(id)?.operation;
}
