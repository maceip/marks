export type UiActionId =
  | 'new'
  | 'templates'
  | 'rename'
  | 'duplicate'
  | 'download'
  | 'print'
  | 'delete'
  | 'share'
  | 'comments'
  | 'history'
  | 'command-palette'
  | 'preferences'
  | 'focus'
  | 'benchmark'
  | 'about';

export interface UiActionDescriptor {
  id: UiActionId;
  label: string;
  description: string;
  group: 'Document' | 'Review' | 'Workspace' | 'Navigate';
  shortcut?: string;
}

export const UI_ACTIONS: UiActionDescriptor[] = [
  { id: 'new', label: 'New document', description: 'Open a quiet blank page', group: 'Document', shortcut: '⌘N' },
  { id: 'templates', label: 'New from template', description: 'Start from a useful structure', group: 'Document' },
  { id: 'rename', label: 'Rename document', description: 'Change the title in the document catalog', group: 'Document' },
  { id: 'duplicate', label: 'Duplicate document', description: 'Create an independent local copy', group: 'Document' },
  { id: 'download', label: 'Download Markdown', description: 'Export the current source as a .md file', group: 'Document' },
  { id: 'print', label: 'Print or save PDF', description: 'Use the browser print surface', group: 'Document', shortcut: '⌘P' },
  { id: 'delete', label: 'Move document to trash', description: 'Remove this local document', group: 'Document' },
  { id: 'share', label: 'Share', description: 'Prepare access and copy a document link', group: 'Document' },
  { id: 'comments', label: 'Comments', description: 'Open the local review conversation', group: 'Review' },
  { id: 'history', label: 'Version history', description: 'Save, preview, and restore local snapshots', group: 'Review' },
  { id: 'focus', label: 'Focus mode', description: 'Hide everything except the page', group: 'Workspace', shortcut: '⌘⇧F' },
  { id: 'preferences', label: 'Appearance preferences', description: 'Tune density, glass, and motion', group: 'Workspace' },
  { id: 'command-palette', label: 'Command palette', description: 'Search every Marks command', group: 'Workspace', shortcut: '⌘⇧P' },
  { id: 'benchmark', label: 'Open performance receipt', description: 'Run the in-browser engine benchmark', group: 'Navigate' },
  { id: 'about', label: 'About Marks', description: 'Open the product and performance story', group: 'Navigate' },
];
