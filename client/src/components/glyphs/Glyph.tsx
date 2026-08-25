import { Icon, type IconName } from '../ui';

export type GlyphTone = 'navy' | 'blue' | 'green' | 'teal' | 'amber';
export type GlyphName = IconName;

interface GlyphProps {
  name: GlyphName;
  size?: number;
  label?: string;
  interactive?: boolean;
}

/** Command-size isometric tile used by the ribbon, composer, and dock. */
export function Glyph({ name, size = 22, label, interactive = true }: GlyphProps) {
  return <Icon name={name} size={size} label={label} interactive={interactive} kind="command" className="glyph" />;
}
