import { encodeQr } from '../../lib/qr';

interface QrMarkProps {
  value: string;
  label: string;
}

/** On-brand QR: navy modules, green finder centers, no third-party icon font. */
export function QrMark({ value, label }: QrMarkProps) {
  const grid = encodeQr(value);
  const size = grid.length;
  const cells = grid.flatMap((row, y) =>
    row.flatMap((on, x) => (on ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : [])),
  );

  return (
    <svg
      className="qr-mark"
      viewBox={`-1 -1 ${size + 2} ${size + 2}`}
      role="img"
      aria-label={label}
    >
      <rect x="-1" y="-1" width={size + 2} height={size + 2} className="qr-mark-page" />
      <g className="qr-mark-modules" dangerouslySetInnerHTML={{ __html: cells.join('') }} />
    </svg>
  );
}
