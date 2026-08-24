export type IconTone = 'navy' | 'blue' | 'green' | 'teal' | 'amber' | 'rose' | 'slate';
export type IconKind = 'chrome' | 'command';

export const ICON_NAMES = [
  'bold', 'italic', 'strike', 'strikethrough', 'underline', 'highlight', 'code', 'heading',
  'clear', 'grow', 'shrink', 'list', 'numbered', 'task', 'quote', 'indent', 'outdent',
  'link', 'image', 'table', 'hr', 'math', 'mermaid', 'callout', 'footnote', 'contents',
  'mic', 'comment', 'history', 'gauge', 'outline', 'focus', 'settings', 'sun', 'moon',
  'split', 'pencil', 'eye', 'plus', 'template', 'duplicate', 'download', 'print', 'trash',
  'undo', 'redo', 'cut', 'copy', 'paste', 'painter', 'find', 'sparkles', 'rewrite',
  'summarize', 'continue', 'expand', 'compose', 'alignLeft', 'alignCenter', 'alignRight',
  'row', 'column', 'rect', 'ellipse', 'diamond', 'arrow', 'bubble', 'file', 'share',
  'search', 'more', 'sidebar', 'close', 'check', 'document', 'bolt', 'chevron',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const ICON_TONE: Record<IconName, IconTone> = {
  bold: 'blue', italic: 'blue', strike: 'blue', strikethrough: 'blue', underline: 'blue',
  highlight: 'amber', code: 'navy', heading: 'blue', clear: 'slate', grow: 'blue', shrink: 'blue',
  list: 'navy', numbered: 'navy', task: 'green', quote: 'teal', indent: 'navy', outdent: 'navy',
  link: 'teal', image: 'teal', table: 'teal', hr: 'slate', math: 'blue', mermaid: 'teal',
  callout: 'amber', footnote: 'navy', contents: 'navy', mic: 'green', comment: 'green', history: 'green',
  gauge: 'amber', outline: 'navy', focus: 'blue', settings: 'slate', sun: 'amber', moon: 'navy',
  split: 'blue', pencil: 'blue', eye: 'teal', plus: 'green', template: 'navy', duplicate: 'navy',
  download: 'blue', print: 'navy', trash: 'rose', undo: 'navy', redo: 'navy', cut: 'navy',
  copy: 'navy', paste: 'blue', painter: 'amber', find: 'navy', sparkles: 'amber', rewrite: 'amber',
  summarize: 'amber', continue: 'amber', expand: 'amber', compose: 'amber', alignLeft: 'teal',
  alignCenter: 'teal', alignRight: 'teal', row: 'teal', column: 'teal', rect: 'teal',
  ellipse: 'teal', diamond: 'teal', arrow: 'teal', bubble: 'teal', file: 'navy', share: 'blue',
  search: 'navy', more: 'slate', sidebar: 'navy', close: 'slate', check: 'green',
  document: 'navy', bolt: 'amber', chevron: 'slate',
};

/** 24×24 stroke marks placed on the isometric face. */
export const ICON_MARKS: Record<IconName, string> = {
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  strike: 'M16 4H9a3 3 0 0 0-1 5.8M4 12h16M8 16a3 3 0 0 0 3 4h4a3 3 0 0 0 2-5',
  strikethrough: 'M16 4H9a3 3 0 0 0-1 5.8M4 12h16M8 16a3 3 0 0 0 3 4h4a3 3 0 0 0 2-5',
  underline: 'M7 4v10a5 5 0 0 0 10 0V4M5 20h14',
  highlight: 'M4 20h16M6 16l8-8 4 4-8 8H6z',
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  heading: 'M6 4v16M18 4v16M6 12h12',
  clear: 'M6 6l12 12M18 6L6 18',
  grow: 'M5 19V7l-3 3M12 8h8M12 13h6',
  shrink: 'M5 7v12l-3-3M12 8h6M12 13h8',
  list: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  numbered: 'M10 6h11M10 12h11M10 18h11M4 4v4M3 8h2M3 12h2l-2 3h2',
  task: 'M4 6l2 2 3-3M4 14l2 2 3-3M13 7h8M13 15h8',
  quote: 'M7 7H4v6h6V9a5 5 0 0 1-3 4M17 7h-3v6h6V9a5 5 0 0 1-3 4',
  indent: 'M12 6h9M8 12h13M12 18h9M4 9l4 3-4 3',
  outdent: 'M8 6h13M8 12h13M8 18h13M12 9L8 12l4 3',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  hr: 'M3 12h18',
  math: 'M5 7h5l3 10h6M7 14h8',
  mermaid: 'M4 13c3-6 6-8 8-8s5 2 8 8c-3 6-6 8-8 8s-5-2-8-8zm8-8V3',
  callout: 'M4 5h14v12l-4 4v-4H4z',
  footnote: 'M7 4h4c2.5 0 4 1.5 4 3.5S13.5 11 11 11H7zM7 11v9',
  contents: 'M4 6h16M7 12h13M10 18h10',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  comment: 'M4 4h16v12H9l-5 4z',
  history: 'M4 5v5h5M5 10a8 8 0 1 1 2 7M12 7v5l3 2',
  gauge: 'M12 14l4-4M4 20a9 9 0 1 1 16 0',
  outline: 'M4 6h10M4 12h16M4 18h7',
  focus: 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 13.5l2 1-2 3-2-.5-1.5 1.5.5 2-3 1-1-2h-2l-1 2-3-1 .5-2L5 17l-2 .5-1-3 2-1v-2l-2-1 1-3 2 .5L6.5 6 6 4l3-1 1 2h2l1-2 3 1-.5 2L17 7.5l2-.5 1 3-2 1z',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M18 6l1.5-1.5M4.5 19.5L6 18M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  moon: 'M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10z',
  split: 'M12 4v16M4 4h16v16H4z',
  pencil: 'M4 20h4l11-11-4-4L4 16zM14 6l4 4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  plus: 'M12 5v14M5 12h14',
  template: 'M4 4h16v16H4zM4 9h16M9 9v11',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  download: 'M12 4v11M8 12l4 4 4-4M4 20h16',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  undo: 'M9 7L4 12l5 5M5 12h8a6 6 0 0 1 6 6',
  redo: 'M15 7l5 5-5 5M19 12H11a6 6 0 0 0-6 6',
  cut: 'M6 7a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm12 8a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 11l10-5M8 13l10 5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  paste: 'M8 4h8v4H8zM6 8h12v12H6z',
  painter: 'M5 19h5l8-10-4-4L5 15zM14 7l4 4',
  find: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  sparkles: 'M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  rewrite: 'M5 19h5l9-10-4-4L5 15zM4 6h7',
  summarize: 'M5 7h14M5 12h14M5 17h9',
  continue: 'M5 12h12l-3-3M17 12l-3 3M5 6v12',
  expand: 'M5 12h14M12 5v14M5 5l3 3M19 5l-3 3M5 19l3-3M19 19l-3-3',
  compose: 'M5 19V6h13v10l-4 3zM8 10h7M8 14h5',
  alignLeft: 'M4 7h16M4 12h10M4 17h16',
  alignCenter: 'M4 7h16M7 12h10M4 17h16',
  alignRight: 'M4 7h16M10 12h10M4 17h16',
  row: 'M4 7h16v10H4zM4 12h16M6 12V9M18 12V9',
  column: 'M4 5h16v14H4zM12 5v14',
  rect: 'M5 7h14v10H5z',
  ellipse: 'M12 7a7 5 0 1 0 0 10 7 5 0 0 0 0-10z',
  diamond: 'M12 4l8 8-8 8-8-8z',
  arrow: 'M5 12h13l-4-4M18 12l-4 4',
  bubble: 'M5 7h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5l-4 3v-3H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M8 7l4-4 4 4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sidebar: 'M3 5h18v14H3zM9 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  document: 'M6 3h8l4 4v14H6zM14 3v4h4',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  chevron: 'M9 6l6 6-6 6',
};

export const icons = Object.fromEntries(ICON_NAMES.map((name) => [name, name])) as Record<IconName, IconName>;

const ICON_LABELS: Partial<Record<IconName, string>> = {
  contents: 'Table of contents',
  hr: 'Divider',
  mermaid: 'Diagram',
  numbered: 'Numbered list',
  strike: 'Strikethrough',
  strikethrough: 'Strikethrough',
};

export function iconLabel(name: IconName): string {
  return ICON_LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
}

export function isIconName(value: string | undefined): value is IconName {
  return Boolean(value && value in ICON_MARKS);
}
