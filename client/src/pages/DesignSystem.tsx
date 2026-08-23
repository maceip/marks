import { useState } from 'react';
import { AgentChatPill } from '../components/ui/AgentChatPill';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { Icon, icons } from '../components/ui/Icon';
import { IconButton } from '../components/ui/IconButton';
import { Status } from '../components/ui/Status';
import { Tabs } from '../components/ui/Tabs';
import { Tooltip } from '../components/ui/Tooltip';
import '../styles/design-system.css';
import '../styles/primitives.css';

const TAB_ITEMS = [{ id: 'write', label: 'Write' }, { id: 'preview', label: 'Preview' }, { id: 'review', label: 'Review' }] as const;

export function DesignSystem({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'write' | 'preview' | 'review'>('write');
  const [selected, setSelected] = useState(false);
  return <div className="design-system">
    <header className="design-system-header"><div><h2>Marks design system</h2><p>Cold glass, hot core — foundations and interaction contracts.</p></div><Button onClick={onBack}>Back to workspace</Button></header>
    <section className="design-system-section"><h3>Semantic color</h3><div className="token-grid">
      <div className="token-swatch" style={{ '--swatch': 'var(--color-canvas)' } as React.CSSProperties}>Canvas</div>
      <div className="token-swatch" style={{ '--swatch': 'var(--color-surface)' } as React.CSSProperties}>Surface</div>
      <div className="token-swatch" style={{ '--swatch': 'var(--color-action)', '--swatch-text': 'white' } as React.CSSProperties}>Action</div>
      <div className="token-swatch" style={{ '--swatch': 'var(--color-positive)' } as React.CSSProperties}>Positive</div>
    </div></section>
    <section className="design-system-section"><h3>Controls</h3><div className="design-system-row">
      <Button>Default</Button><Button tone="primary">Primary</Button><Button tone="subtle">Subtle</Button>
      <Tooltip label="Create document"><IconButton label="New document" icon={<Icon path={icons.plus} />} /></Tooltip>
      <Chip>Read only</Chip><Chip interactive aria-pressed={selected} onClick={() => setSelected(!selected)}>Selected chip</Chip>
      <AgentChatPill onClick={() => undefined} />
    </div></section>
    <section className="design-system-section"><h3>Tabs and status</h3><div className="design-system-row">
      <Tabs label="Document view" items={TAB_ITEMS} value={tab} onChange={setTab} />
      <Status>Idle</Status><Status tone="info">Opening</Status><Status tone="success">Saved</Status><Status tone="warning">Offline</Status><Status tone="danger">Failed</Status>
    </div></section>
  </div>;
}
