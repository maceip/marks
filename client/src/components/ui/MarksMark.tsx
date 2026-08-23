interface MarksMarkProps {
  size?: number;
  label?: string;
  className?: string;
}

/**
 * Code-native product mark: a folded Markdown page with blue source and green
 * revision accents. It stays legible at favicon size and costs no image fetch.
 */
export function MarksMark({ size = 24, label, className = '' }: MarksMarkProps) {
  return (
    <svg
      className={`marks-mark${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect className="marks-mark-frame" x="1.5" y="1.5" width="29" height="29" rx="8" />
      <path className="marks-mark-page" d="M7 5.8h12.2l5.8 5.8V26H7z" />
      <path className="marks-mark-fold" d="M19.2 5.8v5.8H25z" />
      <path className="marks-mark-hash" d="M10 12h5M11.1 9.7l-1.2 4.8M14.5 9.7l-1.2 4.8" />
      <path className="marks-mark-line" d="M16.8 13.1h4.8M10 18h11.5M10 21.4h7.4" />
      <path className="marks-mark-history" d="M20.2 22.9a3 3 0 1 0 .5-3.8M18.9 18.7h2v2" />
    </svg>
  );
}
