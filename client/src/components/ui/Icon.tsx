interface IconProps {
  path: string;
  label?: string;
  size?: number;
}

/** Single-path icons, inline so the UI never waits on an icon font. */
export function Icon({ path, label, size = 16 }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      <path d={path} />
    </svg>
  );
}

export const icons = {
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  strikethrough: 'M16 4H9a3 3 0 0 0-1 5.8M4 12h16M8 16a3 3 0 0 0 3 4h4a3 3 0 0 0 2-5',
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
  quote: 'M7 7H4v6h6V9a5 5 0 0 1-3 4M17 7h-3v6h6V9a5 5 0 0 1-3 4',
  list: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  numbered: 'M10 6h11M10 12h11M10 18h11M4 4v4M3 8h2M3 12h2l-2 3h2',
  task: 'M4 6l2 2 3-3M4 14l2 2 3-3M13 7h8M13 15h8',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  heading: 'M6 4v16M18 4v16M6 12h12',
  hr: 'M3 12h18',
  highlight: 'M4 20h16M6 16l8-8 4 4-8 8H6z',
  sidebar: 'M3 5h18v14H3zM9 5v14',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M18 6l1.5-1.5M4.5 19.5L6 18M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  moon: 'M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  download: 'M12 4v11M8 12l4 4 4-4M4 20h16',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M8 7l4-4 4 4',
  gauge: 'M12 14l4-4M4 20a9 9 0 1 1 16 0',
  document: 'M6 3h8l4 4v14H6zM14 3v4h4',
  outline: 'M4 6h10M4 12h16M4 18h7',
  check: 'M5 13l4 4L19 7',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  split: 'M12 4v16M4 4h16v16H4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  pencil: 'M4 20h4l11-11-4-4L4 16zM14 6l4 4',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  close: 'M6 6l12 12M18 6L6 18',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 13.5l2 1-2 3-2-.5-1.5 1.5.5 2-3 1-1-2h-2l-1 2-3-1 .5-2L5 17l-2 .5-1-3 2-1v-2l-2-1 1-3 2 .5L6.5 6 6 4l3-1 1 2h2l1-2 3 1-.5 2L17 7.5l2-.5 1 3-2 1z',
  comment: 'M4 4h16v12H9l-5 4z',
  history: 'M4 5v5h5M5 10a8 8 0 1 1 2 7M12 7v5l3 2',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  focus: 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5',
  template: 'M4 4h16v16H4zM4 9h16M9 9v11',
  undo: 'M9 7L4 12l5 5M5 12h8a6 6 0 0 1 6 6',
  chevron: 'M9 6l6 6-6 6',
  sparkles: 'M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
} as const;
