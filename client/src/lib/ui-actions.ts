export type UiActionId =
  | 'new'
  | 'templates'
  | 'import'
  | 'rename'
  | 'duplicate'
  | 'download'
  | 'download-bundle'
  | 'print'
  | 'delete'
  | 'trash'
  | 'share'
  | 'comments'
  | 'history'
  | 'command-palette'
  | 'preferences'
  | 'focus'
  | 'benchmark'
  | 'about'
  | 'keep-workspace'
  | 'account'
  | 'pairing'
  | 'logout'
  | 'find'
  | 'draft-tools';

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
  { id: 'import', label: 'Import Markdown', description: 'Create a document from a .md file', group: 'Document' },
  { id: 'rename', label: 'Rename document', description: 'Change the title in the document catalog', group: 'Document' },
  { id: 'duplicate', label: 'Duplicate document', description: 'Create an independent local copy', group: 'Document' },
  { id: 'download', label: 'Download Markdown', description: 'Export the current source as a .md file', group: 'Document' },
  { id: 'download-bundle', label: 'Download portable bundle', description: 'Export Markdown and referenced images as a ZIP', group: 'Document' },
  { id: 'print', label: 'Print or save PDF', description: 'Use the browser print surface', group: 'Document', shortcut: '⌘P' },
  { id: 'delete', label: 'Move document to trash', description: 'Keep it recoverable for 30 days', group: 'Document' },
  { id: 'trash', label: 'Open trash', description: 'Restore retained documents', group: 'Workspace' },
  { id: 'share', label: 'Share', description: 'Prepare access and copy a document link', group: 'Document' },
  { id: 'comments', label: 'Comments', description: 'Review anchored document threads', group: 'Review' },
  { id: 'history', label: 'Version history', description: 'Save, preview, and restore durable snapshots', group: 'Review' },
  { id: 'focus', label: 'Focus mode', description: 'Hide everything except the page', group: 'Workspace', shortcut: '⌘⇧F' },
  { id: 'preferences', label: 'Appearance preferences', description: 'Tune density, glass, and motion', group: 'Workspace' },
  { id: 'command-palette', label: 'Command palette', description: 'Search every Marks command', group: 'Workspace', shortcut: '⌘⇧P' },
  { id: 'benchmark', label: 'Open performance receipt', description: 'Run the in-browser engine benchmark', group: 'Navigate' },
  { id: 'about', label: 'Google Docs for Markdown', description: 'Open the marketing page in the editor', group: 'Navigate' },
  { id: 'keep-workspace', label: 'Keep this workspace', description: 'See how a temporary tab becomes a durable principal', group: 'Workspace' },
  { id: 'account', label: 'Account and devices', description: 'Scratch, phone controller, and this browser', group: 'Workspace' },
  { id: 'pairing', label: 'Phone confirmation', description: 'Open the /link pairing surface', group: 'Workspace' },
  { id: 'logout', label: 'Sign out', description: 'Revoke the session cookie when one exists', group: 'Workspace' },
  { id: 'find', label: 'Find in document', description: 'Open the editor search panel', group: 'Workspace', shortcut: '⌘F' },
  { id: 'draft-tools', label: 'Draft tools', description: 'Apply deterministic local Markdown transformations', group: 'Workspace' },
];
