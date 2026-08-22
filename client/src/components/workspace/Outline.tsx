import type { Heading } from '../../markdown/types';
import { Icon, icons } from '../Icon';

interface OutlineProps {
  headings: Heading[];
  onSelect: (line: number) => void;
}

export function Outline({ headings, onSelect }: OutlineProps) {
  if (headings.length === 0) {
    return (
      <div className="outline outline-empty">
        <Icon path={icons.outline} />
        <p>Headings appear here as you write them.</p>
      </div>
    );
  }

  const minLevel = Math.min(...headings.map((heading) => heading.level));

  return (
    <nav className="outline" aria-label="Document outline">
      {headings.map((heading, index) => (
        <button
          key={`${heading.slug}-${index}`}
          type="button"
          className="outline-item"
          style={{ paddingLeft: `${0.75 + (heading.level - minLevel) * 0.85}rem` }}
          data-level={heading.level}
          onClick={() => onSelect(heading.line)}
        >
          {heading.text || 'Untitled section'}
        </button>
      ))}
    </nav>
  );
}
