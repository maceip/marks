import { useCallback, type PointerEvent as ReactPointerEvent } from 'react';

export type GlyphTone = 'navy' | 'blue' | 'green' | 'teal' | 'amber';

export type GlyphName =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'underline'
  | 'highlight'
  | 'code'
  | 'heading'
  | 'clear'
  | 'grow'
  | 'shrink'
  | 'list'
  | 'numbered'
  | 'task'
  | 'quote'
  | 'indent'
  | 'outdent'
  | 'link'
  | 'image'
  | 'table'
  | 'hr'
  | 'math'
  | 'mermaid'
  | 'callout'
  | 'footnote'
  | 'toc'
  | 'mic'
  | 'comment'
  | 'history'
  | 'gauge'
  | 'outline'
  | 'focus'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'split'
  | 'pencil'
  | 'eye'
  | 'plus'
  | 'template'
  | 'duplicate'
  | 'download'
  | 'print'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'painter'
  | 'find'
  | 'sparkles'
  | 'rewrite'
  | 'summarize'
  | 'continue'
  | 'expand'
  | 'compose'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'row'
  | 'column'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'bubble'
  | 'file'
  | 'share'
  | 'search'
  | 'more'
  | 'sidebar';

const TONE: Record<GlyphName, GlyphTone> = {
  bold: 'blue',
  italic: 'blue',
  strike: 'blue',
  underline: 'blue',
  highlight: 'amber',
  code: 'navy',
  heading: 'blue',
  clear: 'navy',
  grow: 'blue',
  shrink: 'blue',
  list: 'navy',
  numbered: 'navy',
  task: 'green',
  quote: 'teal',
  indent: 'navy',
  outdent: 'navy',
  link: 'teal',
  image: 'teal',
  table: 'teal',
  hr: 'navy',
  math: 'blue',
  mermaid: 'teal',
  callout: 'amber',
  footnote: 'navy',
  toc: 'navy',
  mic: 'green',
  comment: 'green',
  history: 'green',
  gauge: 'amber',
  outline: 'navy',
  focus: 'blue',
  settings: 'navy',
  sun: 'amber',
  moon: 'navy',
  split: 'blue',
  pencil: 'blue',
  eye: 'teal',
  plus: 'green',
  template: 'navy',
  duplicate: 'navy',
  download: 'blue',
  print: 'navy',
  trash: 'amber',
  undo: 'navy',
  redo: 'navy',
  cut: 'navy',
  copy: 'navy',
  paste: 'blue',
  painter: 'amber',
  find: 'navy',
  sparkles: 'amber',
  rewrite: 'amber',
  summarize: 'amber',
  continue: 'amber',
  expand: 'amber',
  compose: 'amber',
  alignLeft: 'teal',
  alignCenter: 'teal',
  alignRight: 'teal',
  row: 'teal',
  column: 'teal',
  rect: 'teal',
  ellipse: 'teal',
  diamond: 'teal',
  arrow: 'teal',
  bubble: 'teal',
  file: 'navy',
  share: 'blue',
  search: 'navy',
  more: 'navy',
  sidebar: 'navy',
};

const MARK: Record<GlyphName, string> = {
  bold: 'M11 10h5.2a2.2 2.2 0 0 1 0 4.4H11zm0 4.4h5.8A2.4 2.4 0 0 1 17 19H11z',
  italic: 'M16.2 10h-4.4M14.6 22h-4.4M14.8 10l-3.2 12',
  strike: 'M10 12.2c.4-1.4 1.6-2.2 3.4-2.2 1.8 0 3 1 3 2.3 0 2.4-6.8 1.4-6.8 4.6 0 1.5 1.4 2.5 3.5 2.5 1.6 0 2.8-.6 3.4-1.6M9 16h10',
  underline: 'M11 10v7.2a3 3 0 0 0 6 0V10M10 22h8',
  highlight: 'M10 21h12M11 18l6.2-6.4 3 2.8-6.2 6.4H11z',
  code: 'M13 11l-3.2 5L13 21M19 11l3.2 5L19 21',
  heading: 'M11 10v12M21 10v12M11 16h10',
  clear: 'M11 11l10 10M21 11L11 21',
  grow: 'M12 20V10l-2.2 2.2M16 12h6M16 16h4',
  shrink: 'M12 10v10l-2.2-2.2M16 12h4M16 16h6',
  list: 'M14 11h8M14 16h8M14 21h8M11 11h.01M11 16h.01M11 21h.01',
  numbered: 'M14 11h8M14 16h8M14 21h8M10.4 10v4M10 14h1.2M10 16h1.4L10 20h1.6',
  task: 'M11 11.2l1.4 1.4 2.6-2.6M11 16.8l1.4 1.4 2.6-2.6M17 11h5M17 18h5',
  quote: 'M12 11h-2v5h4v-3a4 4 0 0 1-2 3.2M20 11h-2v5h4v-3a4 4 0 0 1-2 3.2',
  indent: 'M18 11h5M14 16h9M18 21h5M11 13.5l3 2.5-3 2.5',
  outdent: 'M14 11h9M14 16h9M14 21h9M15.5 13.5L12.5 16l3 2.5',
  link: 'M14 18.4a3.6 3.6 0 0 0 5 0l1.8-1.8a3.6 3.6 0 0 0-5-5L15 12.4M18 13.6a3.6 3.6 0 0 0-5 0l-1.8 1.8a3.6 3.6 0 1 0 5 5',
  image: 'M10 11h12v10H10zM10 18l3.2-3.2 2.6 2.6 1.8-1.8L22 20',
  table: 'M10 11h12v10H10zM10 15h12M14.4 15v6M17.6 15v6',
  hr: 'M10 16h12',
  math: 'M11 12h4l2 8h4M12 16h6',
  mermaid: 'M11 16c1.6-3 3.2-5 5-5s3.4 2 5 5c-1.6 3-3.2 5-5 5s-3.4-2-5-5zm5-5V9',
  callout: 'M11 11h10v8l-3.2 3v-3H11z',
  footnote: 'M12 10.5h2.2c1.6 0 2.6 1 2.6 2.4S15.8 15.4 14.2 15.4H12zM12 15.4V22',
  toc: 'M11 11h10M11 16h10M11 21h6M22 11v10',
  mic: 'M16 10a2.2 2.2 0 0 1 2.2 2.2V16a2.2 2.2 0 1 1-4.4 0v-3.8A2.2 2.2 0 0 1 16 10zM12.2 16a3.8 3.8 0 0 0 7.6 0M16 19.8V22',
  comment: 'M11 11h10v8H16l-3.2 2.6V19H11z',
  history: 'M12 12.4V16h4M12.6 20.2A5.2 5.2 0 1 0 13 11.4',
  gauge: 'M16 18.4l3-3M11.4 20.2a6 6 0 1 1 9.2 0',
  outline: 'M11 11h6M11 16h10M11 21h4',
  focus: 'M13 10H11v3M19 10h2v3M13 22H11v-3M19 22h2v-3',
  settings: 'M16 14.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM20.4 16.8l1.4.7-1.2 2-1.4-.3-1 1 .3 1.4-2 .8-.7-1.3h-1.4l-.7 1.3-2-.8.3-1.4-1-1-1.4.3-1.2-2 1.4-.7v-1.4l-1.4-.7 1.2-2 1.4.3 1-1-.3-1.4 2-.8.7 1.3h1.4l.7-1.3 2 .8-.3 1.4 1 1 1.4-.3 1.2 2-1.4.7z',
  sun: 'M16 13.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM16 10v-1.4M16 23.4V22M11 16H9.6M22.4 16H21M12.4 12.4l-1-1M20.6 20.6l-1-1M19.6 12.4l1-1M12.4 20.6l-1 1',
  moon: 'M20.4 17.2A6 6 0 1 1 13 11a5.2 5.2 0 0 0 7.4 6.2z',
  split: 'M16 10v12M10 11h12v10H10z',
  pencil: 'M11 21h3.2L23 12.2 19.8 9 11 17.8zM19 10l3.2 3.2',
  eye: 'M10 16s2.8-5 6-5 6 5 6 5-2.8 5-6 5-6-5-6-5zM16 14.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z',
  plus: 'M16 11v10M11 16h10',
  template: 'M10 11h12v10H10zM10 15h12M14 15v6',
  duplicate: 'M13 13h10v10H13zM10 19V11h10',
  download: 'M16 10v8M13 15.4L16 18.4 19 15.4M11 21h10',
  print: 'M12 14V10h8v4M12 20H11v-5h10v5h-1M13 17h6v5H13z',
  trash: 'M11 13h10M14.2 13V11h3.6v2M12.4 13l.8 8h5.6l.8-8',
  undo: 'M14.2 12.2L11 16l3.2 3.8M11.6 16H18a4 4 0 0 1 4 4',
  redo: 'M17.8 12.2L21 16l-3.2 3.8M20.4 16H14a4 4 0 0 0-4 4',
  cut: 'M12.2 12.2a2 2 0 1 1-2 2 2 2 0 0 1 2-2zm9.6 8.6a2 2 0 1 1-2 2 2 2 0 0 1 2-2zM13.4 15.2L21 11M13.4 17.8L21 22',
  copy: 'M13 13h10v10H13zM11 19V11h9',
  paste: 'M14 10.6h4a1.4 1.4 0 0 1 1.4 1.4V13H12.6v-1a1.4 1.4 0 0 1 1.4-1.4zM12 13h8v10H12z',
  painter: 'M12 20h4l6-8-3.4-3.2L12 16.6zM18.2 11.2l2.4 2.2',
  find: 'M15.2 11a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM18.4 18.4L22 22',
  sparkles: 'M16 10l1.1 3.2L20.4 14.4l-3.3 1.1L16 18.8l-1.1-3.3-3.3-1.1 3.3-1.2zM21 18l.6 1.6L23.2 20 21.6 20.6 21 22.2l-.6-1.6-1.6-.6 1.6-.6z',
  rewrite: 'M12 20h4l7-8-3.4-3.2L12 16.6zM11 11h5',
  summarize: 'M11 12h10M11 16h10M11 20h6',
  continue: 'M12 16h8l-2.4-2.4M20 16l-2.4 2.4M12 11v10',
  expand: 'M12 16h8M16 12v8M12 12l2.2 2.2M20 12l-2.2 2.2M12 20l2.2-2.2M20 20l-2.2-2.2',
  compose: 'M12 20.4V11h9.2v7.4L18 22H12zM15 14h4M15 17h3',
  alignLeft: 'M11 12h10M11 16h7M11 20h10',
  alignCenter: 'M11 12h10M13 16h6M11 20h10',
  alignRight: 'M11 12h10M14 16h7M11 20h10',
  row: 'M10 12h12v8H10zM10 16h12M11.6 16v-1.6M20.4 16v-1.6',
  column: 'M10 11h12v10H10zM16 11v10',
  rect: 'M11 12h10v8H11z',
  ellipse: 'M16 12a5 4 0 1 0 0 8 5 4 0 0 0 0-8z',
  diamond: 'M16 11l6 5-6 5-6-5z',
  arrow: 'M11 16h9l-2.4-2.6M20 16l-2.4 2.6',
  bubble: 'M11 12h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4l-3 2v-2h-2a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
  file: 'M12 10h6.2L22 14.4V22H12zM18.2 10v4.4H22',
  share: 'M12 16.2V21h10v-4.8M16 10v10M13.2 13l2.8-3 2.8 3',
  search: 'M15.2 11a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM18.4 18.4L22 22',
  more: 'M12 16h.01M16 16h.01M20 16h.01',
  sidebar: 'M10 11h12v10H10zM14.4 11v10',
};

interface GlyphProps {
  name: GlyphName;
  size?: number;
  label?: string;
  interactive?: boolean;
}

function setTilt(target: HTMLElement, event: ReactPointerEvent<HTMLElement>) {
  const bounds = target.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  const y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
  target.style.setProperty('--tilt-x', x.toFixed(3));
  target.style.setProperty('--tilt-y', y.toFixed(3));
}

function clearTilt(target: HTMLElement) {
  target.style.setProperty('--tilt-x', '0');
  target.style.setProperty('--tilt-y', '0');
}

/** Folded-glass command glyph. Tilt is CSS-variable driven so hover and touch
 * never start their own animation loop. */
export function Glyph({ name, size = 22, label, interactive = true }: GlyphProps) {
  const tone = TONE[name];
  const mark = MARK[name];
  const onMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!interactive) return;
    setTilt(event.currentTarget, event);
  }, [interactive]);

  return (
    <span
      className={`glyph glyph-${tone}${interactive ? ' glyph-live' : ''}`}
      data-glyph={name}
      style={{ width: size, height: size }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      onPointerEnter={onMove}
      onPointerMove={onMove}
      onPointerLeave={(event) => clearTilt(event.currentTarget)}
      onPointerUp={(event) => clearTilt(event.currentTarget)}
    >
      <svg className="glyph-shadow" viewBox="0 0 32 32" width={size} height={size}>
        <rect x="5" y="8" width="24" height="22" rx="7" />
      </svg>
      <svg className="glyph-body" viewBox="0 0 32 32" width={size} height={size}>
        <rect className="glyph-slab" x="3.2" y="4" width="25.6" height="23.4" rx="7" />
        <path className="glyph-lip" d="M4.2 8.2h23.4" />
        <path className="glyph-fold" d="M21.4 4l7.4 7.2h-5.2a2.2 2.2 0 0 1-2.2-2.2V4z" />
        <path className="glyph-mark" d={mark} />
        <path className="glyph-spec" d="M6.4 7.2c3.4-1.2 8.2-1.4 12.4.2" />
      </svg>
    </span>
  );
}
