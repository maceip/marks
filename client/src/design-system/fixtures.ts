/** Catalog-only copy and state definitions. Never import these from product code. */
export const catalogStates = [
  { id: 'default', label: 'Default' },
  { id: 'hover', label: 'Hover simulation' },
  { id: 'focus', label: 'Focus visible' },
  { id: 'active', label: 'Active' },
  { id: 'selected', label: 'Selected' },
  { id: 'disabled', label: 'Disabled' },
  { id: 'loading', label: 'Loading' },
  { id: 'danger', label: 'Danger' },
  { id: 'long', label: 'Long label that demonstrates truncation safely' },
  { id: 'localized', label: 'Änderungen gemeinsam veröffentlichen' },
  { id: 'zoom', label: 'High zoom' },
] as const;

export const palette = [
  ['Canvas', '--color-bg-canvas'], ['Surface', '--color-bg-surface'], ['Raised', '--color-bg-raised'],
  ['Text', '--color-fg-default'], ['Muted', '--color-fg-muted'], ['Border', '--color-border-default'],
  ['Primary', '--color-primary'], ['Secondary', '--color-secondary'], ['Destructive', '--color-destructive'],
  ['Success', '--color-success'], ['Warning', '--color-warning'], ['Information', '--color-info'],
] as const;

export const sectionLinks = [
  ['foundations', 'Foundations'], ['controls', 'Controls'], ['chrome', 'Chrome'],
  ['collaboration', 'Collaboration'], ['overlays', 'Overlays'], ['materials', 'Materials'],
  ['motion', 'Motion'], ['responsive', 'Responsive'],
] as const;

export const catalogPeers = [
  { id: 'self', participantId: 'self', connectionId: 'c1', name: 'You', colorIndex: 1, self: true, authenticated: true, section: 'Introduction' },
  { id: 'ada', participantId: 'ada', connectionId: 'c2', name: 'Ada', colorIndex: 2, self: false, authenticated: true, selection: { from: 12, to: 40 }, section: 'Architecture' },
  { id: 'lin', participantId: 'lin', connectionId: 'c3', name: 'Lin', colorIndex: 4, self: false, authenticated: false, section: 'Preview' },
];

export const catalogThread = {
  author: 'Ada',
  time: '2 min ago',
  body: 'This heading should stay a sentence, not a label.',
  quote: 'Marks keeps the preview on the dirty blocks.',
};
