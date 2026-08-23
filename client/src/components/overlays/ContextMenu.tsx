import { useEffect, useLayoutEffect, useRef } from 'react';
import { clampMenuPosition } from '../../browser';
import { modifierLabel } from '../../browser/platform';

export interface ContextMenuAction {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { x: left, y: top } = clampMenuPosition(x, y, node.offsetWidth, node.offsetHeight);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={`context-menu-item${action.danger ? ' danger' : ''}`}
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return;
            action.run();
            onClose();
          }}
        >
          <span>{action.label}</span>
          {action.shortcut && <kbd>{action.shortcut.replace('Mod', modifierLabel())}</kbd>}
        </button>
      ))}
    </div>
  );
}
