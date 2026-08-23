import type { PracticalActionId } from './practical.ts';
import type { WildActionId } from './wild.ts';

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
  | 'draft-tools'
  | PracticalActionId
  | WildActionId;

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
  { id: 'practical-health', label: 'Document health', description: 'Prioritize issues across the document', group: 'Review' },
  { id: 'practical-render', label: 'Render diagnostics', description: 'Inspect compiled-output problems', group: 'Review' },
  { id: 'practical-accessibility', label: 'Accessibility', description: 'Check semantic reading quality', group: 'Review' },
  { id: 'practical-schema', label: 'Front matter & schema', description: 'Edit portable document metadata', group: 'Document' },
  { id: 'practical-publish', label: 'Publish profiles', description: 'Configure web, print, README, or slides', group: 'Document' },
  { id: 'practical-links', label: 'Link intelligence', description: 'Resolve internal and inspect external links', group: 'Review' },
  { id: 'practical-citations', label: 'Citation ledger', description: 'Reconcile citations and sources', group: 'Review' },
  { id: 'practical-structure', label: 'Structural refactoring', description: 'Move, rename, or extract sections', group: 'Document' },
  { id: 'practical-collaboration', label: 'Collaboration console', description: 'Inspect peers, roles, and savedness', group: 'Review' },
  { id: 'practical-recovery', label: 'Durability & recovery', description: 'Create and verify recovery checkpoints', group: 'Document' },
  { id: 'practical-versions', label: 'Versions & branches', description: 'Compare and branch durable snapshots', group: 'Review' },
  { id: 'practical-assets', label: 'Asset inspector', description: 'Audit image origins, reuse, and alt text', group: 'Review' },
  { id: 'practical-reader', label: 'Reader simulation', description: 'Preview reading pace and layouts', group: 'Review' },
  { id: 'practical-privacy', label: 'Privacy & exposure', description: 'Find sensitive values before sharing', group: 'Review' },
  { id: 'practical-ledger', label: 'Task & decision ledger', description: 'Collect work and decisions from Markdown', group: 'Review' },
  { id: 'practical-paste', label: 'Paste intent & provenance', description: 'Control how clipboard material lands', group: 'Document' },
  { id: 'practical-blocks', label: 'Cross-document blocks', description: 'Reference another document section', group: 'Document' },
  { id: 'practical-quality', label: 'Audience & quality contract', description: 'Keep readability aligned to an audience', group: 'Review' },
  { id: 'wild-intent-horizon', label: 'Intent Horizon', description: 'Turn declared outcomes and document signals into inspectable next moves', group: 'Review' },
  { id: 'wild-causal-lightpath', label: 'Causal Lightpath', description: 'Trace real commands through source, rendering, collaboration, and durability', group: 'Review' },
  { id: 'wild-consequence-lanes', label: 'Consequence Lanes', description: 'Stage a command and inspect every product plane it can touch', group: 'Review' },
  { id: 'wild-context-half-life', label: 'Context Half-Life', description: 'Review claims as dates, versions, links, and assumptions age', group: 'Review' },
  { id: 'wild-counterfactual-shelf', label: 'Counterfactual Shelf', description: 'Preserve, preview, branch, and safely apply alternate source patches', group: 'Review' },
];
