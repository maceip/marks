import { useMemo } from 'react';
import { useCommandCenter } from '../../commands/context';
import { Glyph } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';
import '../../styles/chrome.css';

const RAIL_COMMANDS = [
  { id: 'view.editor', mode: 'edit' as const, label: 'Markdown' },
  { id: 'view.split', mode: 'split' as const, label: 'Split' },
  { id: 'view.preview', mode: 'preview' as const, label: 'Preview' },
] as const;

/** Unfolded foldable view switcher. Thinner than the Material 3 80dp rail. */
export function AppRail() {
  const center = useCommandCenter();
  const available = useMemo(
    () => new Map(center.commands('ribbon').map((command) => [command.id, command])),
    [center],
  );

  return (
    <nav className="app-rail surface-material-host" aria-label="Document views">
      <SurfaceMaterial variant="chrome" />
      {RAIL_COMMANDS.map((item) => {
        const command = available.get(item.id);
        const active = center.environment.mode === item.mode;
        return (
          <button
            key={item.id}
            type="button"
            data-command-id={item.id}
            aria-pressed={active}
            aria-label={command?.description ?? item.label}
            title={command?.description ?? item.label}
            disabled={command ? !command.enabled : false}
            onClick={() => {
              if (command && !command.enabled) return;
              void center.invoke(item.id);
            }}
          >
            <Glyph name={command?.glyph ?? (item.mode === 'edit' ? 'pencil' : item.mode === 'split' ? 'split' : 'eye')} size={22} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
