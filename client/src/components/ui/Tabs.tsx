import type { KeyboardEvent } from 'react';

export interface TabItem<T extends string> { id: T; label: string; disabled?: boolean }

export function Tabs<T extends string>({ label, items, value, onChange }: {
  label: string; items: readonly TabItem<T>[]; value: T; onChange: (value: T) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    const enabled = items.filter((item) => !item.disabled);
    const current = enabled.findIndex((item) => item.id === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    event.preventDefault();
    onChange(enabled[next].id);
  };
  return (
    <div className="ds-tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {items.map((item) => <button key={item.id} type="button" role="tab" className="ds-tab"
        aria-selected={item.id === value} tabIndex={item.id === value ? 0 : -1} disabled={item.disabled}
        onClick={() => onChange(item.id)}>{item.label}</button>)}
    </div>
  );
}
