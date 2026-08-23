import type { EditorView } from '@codemirror/view';
import type { CollabSession } from '../collab/types';
import type { ViewMode } from '../components/shell/TopBar';
import type { UiActionId } from '../lib/ui-actions';
import type { CommandDefinition, CommandExecutionResult, EditorOperation } from './types.ts';

export interface CommandServices {
  session: CollabSession | null;
  getView: () => EditorView | null;
  onAction: (action: UiActionId) => void;
  onModeChange: (mode: ViewMode) => void;
  onToggleOutline: () => void;
  onToggleHud: () => void;
  onToggleTheme: () => void;
  onToggleRibbon: () => void;
  onToggleVoice?: () => void;
  onChooseImage: (replace: boolean, signal: AbortSignal) => Promise<boolean>;
  onFormatPainter: () => Promise<boolean>;
}

export async function executeCommand(
  command: CommandDefinition,
  input: Record<string, unknown>,
  signal: AbortSignal,
  services: CommandServices,
): Promise<CommandExecutionResult> {
  if (signal.aborted) return { ok: false, message: 'Command was cancelled.' };
  const operation = command.operation;
  if (operation.kind === 'ui') {
    services.onAction(operation.action);
    return { ok: true, message: `Opened ${command.label}.` };
  }
  if (operation.kind === 'mode') {
    services.onModeChange(operation.mode);
    return { ok: true, message: `${command.label} view is active.` };
  }
  if (operation.kind === 'toggle') {
    if (operation.target === 'outline') services.onToggleOutline();
    else if (operation.target === 'hud') services.onToggleHud();
    else if (operation.target === 'theme') services.onToggleTheme();
    else if (operation.target === 'ribbon') services.onToggleRibbon();
    else services.onToggleVoice?.();
    return { ok: true, message: `${command.label} toggled.` };
  }
  const applied = await executeEditorOperation(operation.operation, input, signal, services);
  if (!applied) return { ok: false, message: `${command.label} is not applicable at the current selection.` };
  if (mutatesDocument(operation.operation) && services.session) {
    await services.session.whenDurable();
    if (signal.aborted) return { ok: false, message: 'Command was cancelled.' };
    return { ok: true, message: `${command.label} is durable.` };
  }
  return { ok: true, message: `${command.label} completed.` };
}

async function executeEditorOperation(
  operation: EditorOperation,
  input: Record<string, unknown>,
  signal: AbortSignal,
  services: CommandServices,
): Promise<boolean> {
  if (operation === 'undo') return services.session?.undo() ?? false;
  if (operation === 'redo') return services.session?.redo() ?? false;
  if (operation === 'format-painter') return services.onFormatPainter();
  if (operation === 'insert-image-file') return services.onChooseImage(false, signal);
  if (operation === 'replace-image-file') return services.onChooseImage(true, signal);

  const view = services.getView();
  if (!view) return false;
  const actions = await import('../editor/actions.ts');
  if (signal.aborted) return false;
  if (operation === 'paste') return actions.pasteMarkdown(view);
  if (operation === 'cut') return actions.cutSelection(view);
  if (operation === 'copy') return actions.copySelection(view);
  if (operation === 'find') return actions.openFind(view);
  if (operation === 'image-small') return actions.updateImageAtCursor(view, { width: 240 });
  if (operation === 'image-medium') return actions.updateImageAtCursor(view, { width: 480 });
  if (operation === 'image-full') return actions.updateImageAtCursor(view, { width: 720 });
  if (operation === 'image-left') return actions.updateImageAtCursor(view, { align: 'left' });
  if (operation === 'image-center') return actions.updateImageAtCursor(view, { align: 'center' });
  if (operation === 'image-right') return actions.updateImageAtCursor(view, { align: 'right' });
  if (operation === 'replace-image-url') {
    const url = imageUrl(input, 'Replacement image URL');
    return url ? actions.updateImageAtCursor(view, { url }) : false;
  }
  if (operation.startsWith('change-shape-')) {
    const context = (await import('../editor/context.ts')).inspectEditorContext(
      view.state.doc.toString(),
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    const kind = operation.slice('change-shape-'.length) as 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'bubble';
    return context.shape ? actions.applyShapeLabel(view, kind, context.shape.label) : false;
  }

  const commands = await import('../editor/commands.ts');
  if (operation === 'insert-image-url') {
    const url = imageUrl(input, 'Image URL');
    if (!url) return false;
    const alt = typeof input.alt === 'string' ? input.alt.slice(0, 500) : 'image';
    return commands.insertGenerated(`${actions.imageMarkup(url, alt)}\n`)(view);
  }

  const stateCommands: Partial<Record<EditorOperation, typeof commands.toggleBold>> = {
    paragraph: commands.setParagraph,
    'heading-1': commands.setHeading(1),
    'heading-2': commands.setHeading(2),
    'heading-3': commands.setHeading(3),
    'heading-4': commands.setHeading(4),
    bold: commands.toggleBold,
    italic: commands.toggleItalic,
    underline: commands.toggleUnderline,
    strikethrough: commands.toggleStrikethrough,
    highlight: commands.toggleHighlight,
    'inline-code': commands.toggleInlineCode,
    'grow-heading': commands.growHeading,
    'shrink-heading': commands.shrinkHeading,
    'clear-formatting': commands.clearFormatting,
    'bullet-list': commands.toggleBullet,
    'numbered-list': commands.toggleNumbered,
    'task-list': commands.toggleTask,
    quote: commands.toggleQuote,
    indent: commands.indentLines(),
    outdent: commands.outdentLines(),
    'insert-shape-rect': commands.insertShape('rect', 'Rectangle'),
    'insert-shape-ellipse': commands.insertShape('ellipse', 'Ellipse'),
    'insert-shape-diamond': commands.insertShape('diamond', 'Diamond'),
    'insert-shape-arrow': commands.insertShape('arrow', 'Arrow'),
    'insert-shape-bubble': commands.insertShape('bubble', 'Callout'),
    'insert-table': commands.insertTable,
    'add-table-row': commands.addTableRow(),
    'add-table-column': commands.addTableColumn(),
    'insert-link': commands.insertLink,
    'insert-footnote': commands.insertFootnote,
    'insert-code-block': commands.insertCodeBlock,
    'insert-math': commands.insertMath,
    'insert-mermaid': commands.insertMermaid,
    'insert-callout-info': commands.insertCallout('info'),
    'insert-callout-warning': commands.insertCallout('warning'),
    'insert-callout-danger': commands.insertCallout('danger'),
    'insert-horizontal-rule': commands.insertHorizontalRule,
    'insert-toc': commands.insertToc,
  };
  const stateCommand = stateCommands[operation];
  if (!stateCommand) return false;
  const result = stateCommand(view);
  view.focus();
  return result;
}

function mutatesDocument(operation: EditorOperation): boolean {
  return operation !== 'copy' && operation !== 'find' && operation !== 'format-painter';
}

function imageUrl(input: Record<string, unknown>, promptLabel: string): string | null {
  const candidate = typeof input.url === 'string' ? input.url : window.prompt(promptLabel)?.trim();
  if (!candidate) return null;
  if (candidate.startsWith('/')) return candidate;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
