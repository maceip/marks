import { useId, useRef, type KeyboardEvent } from 'react';
export interface TabItem { id: string; label: string; disabled?: boolean }
export function Tabs({ items, selectedId, onChange, label = 'Tabs' }: { items: TabItem[]; selectedId: string; onChange: (id: string) => void; label?: string }) {
  const uid = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = items.map((item, i) => !item.disabled ? i : -1).filter(i => i >= 0);
    const position = enabled.indexOf(index);
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)! : enabled[(position + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    refs.current[next]?.focus(); onChange(items[next].id);
  };
  return <div role="tablist" aria-label={label} className="ui-tabs">{items.map((item, index) => <button key={item.id} ref={node => { refs.current[index] = node; }} type="button" role="tab" id={`${uid}-tab-${item.id}`} aria-controls={`${uid}-panel-${item.id}`} aria-selected={item.id === selectedId} tabIndex={item.id === selectedId ? 0 : -1} disabled={item.disabled} className="ui-control ui-tab" onClick={() => onChange(item.id)} onKeyDown={event => onKeyDown(event, index)}>{item.label}</button>)}</div>;
}
