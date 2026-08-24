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
  ['Background', '--bg'], ['Surface', '--surface'], ['Raised', '--surface-raised'],
  ['Text', '--text'], ['Muted text', '--text-muted'], ['Border', '--border'],
  ['Intent', '--accent'], ['Danger', '--danger'], ['Success', '--success'],
  ['Warning', '--warning'], ['Information', '--info'],
] as const;

export const sectionLinks = [
  ['foundations', 'Foundations'], ['components', 'Components'], ['ribbon', 'Ribbon'],
  ['agent', 'Agent chat'], ['materials', 'Materials'], ['motion', 'Motion'],
  ['responsive', 'Responsive'], ['accessibility', 'Accessibility'],
] as const;
