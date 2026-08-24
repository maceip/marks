import '../styles/foundation-tokens.css';
import '../styles/components.css';
import '../styles/overlays.css';
import '../styles/chrome.css';
import { useEffect, useState, type ReactNode } from 'react';
import { RibbonCommand } from '../components/chrome/RibbonCommand';
import { AgentChatPill } from '../components/agent/AgentChatPill';
import type { AgentChatState } from '../components/agent/agent-chat-model';
import { ICON_NAMES, Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { Menu } from '../components/ui/Menu';
import { Modal } from '../components/ui/Modal';
import { Popover } from '../components/ui/Popover';
import { CommentCard, CommentCompose, Avatar } from '../components/ui/Comment';
import { PresenceBar } from '../components/shell/PresenceBar';
import { LiquidDock } from '../components/shell/LiquidDock';
import { SurfaceMaterial } from '../components/ui/SurfaceMaterial';
import { catalogPeers, catalogStates, catalogThread, palette, sectionLinks } from './fixtures';
import type { Peer } from '../collab/types';
import '../styles/motion.css';
import './design-system.css';

type Toggle = 'light' | 'dark';
type Material = 'cinematic' | 'balanced' | 'foundation' | 'opaque';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="ds-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

function StateMatrix({ kind = 'button' }: { kind?: 'button' | 'input' | 'pill' }) {
  return (
    <div className="ds-matrix" role="list" aria-label={`${kind} state matrix`}>
      {catalogStates.map((state) => (
        <div className={`ds-state state-${state.id}`} role="listitem" key={state.id}>
          <small>{state.label}</small>
          {kind === 'input' ? (
            <input aria-label={`${state.label} input`} value={state.id === 'localized' ? state.label : 'Document title'} disabled={state.id === 'disabled'} readOnly />
          ) : (
            <Button
              className={kind === 'pill' ? 'ds-pill' : ''}
              disabled={state.id === 'disabled'}
              loading={state.id === 'loading'}
              aria-pressed={state.id === 'selected'}
              variant={state.id === 'danger' ? 'danger' : state.id === 'selected' ? 'primary' : 'secondary'}
            >
              {state.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function DesignSystem({ onBack }: { onBack: () => void }) {
  const [theme, setTheme] = useState<Toggle>('light');
  const [density, setDensity] = useState('comfortable');
  const [glass, setGlass] = useState('full');
  const [motion, setMotion] = useState('full');
  const [material, setMaterial] = useState<Material>('balanced');
  const [agentState, setAgentState] = useState<AgentChatState>('collapsed');
  const [agentPrompt, setAgentPrompt] = useState('Summarize this document');
  const [catalogTab, setCatalogTab] = useState('write');
  const [menuOpen, setMenuOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(true);
  const [comment, setComment] = useState('Keep the intro under two sentences.');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const previous = { ...root.dataset };
    root.dataset.theme = theme;
    root.dataset.density = density;
    root.dataset.glass = glass;
    root.dataset.motion = motion;
    root.dataset.materialTier = material;
    return () => {
      for (const key of ['theme', 'density', 'glass', 'motion', 'materialTier']) {
        const value = previous[key];
        if (value === undefined) delete root.dataset[key];
        else root.dataset[key] = value;
      }
    };
  }, [density, glass, material, motion, theme]);

  return (
    <div className="design-system">
      <header className="ds-header">
        <div>
          <span className="ds-eyebrow">Internal catalog</span>
          <h1>Marks design system</h1>
          <p>Production tokens, isometric icons, liquid materials, and the chrome that owns writing, review, and presence.</p>
        </div>
        <button type="button" onClick={onBack}>← Back to Marks</button>
      </header>
      <div className="ds-controls" aria-label="Catalog simulation controls">
        <label>Theme<select value={theme} onChange={(e) => setTheme(e.target.value as Toggle)}><option>light</option><option>dark</option></select></label>
        <label>Density<select value={density} onChange={(e) => setDensity(e.target.value)}><option>comfortable</option><option>compact</option></select></label>
        <label>Glass<select value={glass} onChange={(e) => setGlass(e.target.value)}><option>full</option><option>reduced</option></select></label>
        <label>Motion<select value={motion} onChange={(e) => setMotion(e.target.value)}><option>full</option><option>reduced</option></select></label>
        <label>Material<select value={material} onChange={(e) => setMaterial(e.target.value as Material)}>{['cinematic', 'balanced', 'foundation', 'opaque'].map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>
      <nav className="ds-nav" aria-label="Catalog sections">{sectionLinks.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      <main>
        <Section id="foundations" title="Foundations">
          <h3>Intent roles</h3>
          <div className="ds-swatches">{palette.map(([name, token]) => <div key={token}><span style={{ background: `var(${token})` }} /><b>{name}</b><code>{token}</code></div>)}</div>
          <h3>Elevation and radius</h3>
          <div className="ds-foundations">
            {['xs', 'sm', 'md', 'lg', 'xl'].map((level) => <span className="shadow-demo" style={{ boxShadow: `var(--elevation-${level})` }} key={level}>{level}</span>)}
            {['tight', 'control', 'card', 'panel', 'sheet'].map((level) => <span key={level} style={{ padding: 18, border: '1px solid var(--color-border-default)', borderRadius: `var(--radius-${level})` }}>{level}</span>)}
          </div>
          <h3>Isometric icons</h3>
          <p>Custom 2.5D slabs, not a stroke pack. Hover tilts the tile; press depresses it.</p>
          <div className="ds-icon-grid">{ICON_NAMES.map((name) => <span className="icon-demo" title={name} key={name}><Icon name={name} size={28} /></span>)}</div>
        </Section>

        <Section id="controls" title="Controls">
          <p>Every row includes default, simulated interaction, accessibility, stress, and failure states. Loading keeps the control&apos;s size and shows an overlay spinner.</p>
          <h3>Buttons</h3>
          <div className="ds-intent-row">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="subtle">Tertiary</Button>
            <Button variant="danger">Destructive</Button>
            <Button variant="primary" loading>Publish</Button>
            <Button variant="primary" loading={busy} onClick={() => { setBusy(true); window.setTimeout(() => setBusy(false), 900); }}>Save async</Button>
          </div>
          <StateMatrix />
          <div className="ds-icon-buttons">{catalogStates.map((state) => <IconButton key={state.id} label={`${state.label} settings`} disabled={state.id === 'disabled'} loading={state.id === 'loading'} className={`state-${state.id}`} icon={<Icon name="settings" />} />)}</div>
          <h3>Pills, spinner, tabs</h3>
          <StateMatrix kind="pill" />
          <div className="ds-status"><span>● Connected</span><span><Spinner aria-label="Saving" /> Saving</span><span>▲ Attention</span><span>● Offline</span></div>
          <StateMatrix kind="input" />
          <Tabs label="Document views" selectedId={catalogTab} onChange={setCatalogTab} items={['write', 'preview', 'review', 'history'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))} />
        </Section>

        <Section id="chrome" title="Ribbon and agent chat">
          <div className="ds-ribbon">
            <div className="ds-titlebar">Quick access <b>Document title</b> Presence</div>
            <div className="ds-ribbon-tabs">File　 <b>Home</b>　Insert　Review　View</div>
            <div className="ds-ribbon-commands">{catalogStates.slice(0, 8).map((s, i) => <RibbonCommand key={s.id} glyph={i % 2 ? 'italic' : 'bold'} label={s.label} disabled={s.id === 'disabled'} pressed={s.id === 'selected'} danger={s.id === 'danger'} onClick={() => undefined} />)}</div>
          </div>
          <label>Pattern state<select aria-label="Agent-chat pattern state" value={agentState} onChange={(event) => setAgentState(event.target.value as AgentChatState)}>{['collapsed', 'focused', 'submitting', 'working', 'result', 'error', 'expanded'].map((state) => <option key={state}>{state}</option>)}</select></label>
          <div className="ds-dock-preview">
            <LiquidDock
              onCommands={() => undefined}
              onComments={() => undefined}
              onHistory={() => undefined}
              voiceSupported
            />
          </div>
          <div className="ds-agent-live">
            <AgentChatPill
              state={agentState}
              shell="desktop"
              prompt={agentPrompt}
              result={agentState === 'result' || agentState === 'expanded' ? 'The document has three main sections.' : undefined}
              error={agentState === 'error' ? 'The assistant could not finish.' : undefined}
              onOpen={() => setAgentState('focused')}
              onPromptChange={setAgentPrompt}
              onSubmit={() => setAgentState('working')}
              onCancel={() => setAgentState('focused')}
              onRetry={() => setAgentState('submitting')}
              onClose={() => setAgentState('collapsed')}
              onExpand={() => setAgentState('expanded')}
            />
          </div>
        </Section>

        <Section id="collaboration" title="Presence and comments">
          <div className="ds-collab">
            <PresenceBar peers={catalogPeers as Peer[]} />
            <div className="ds-avatars">{catalogPeers.map((person) => <Avatar key={person.id} name={person.name} self={person.self} activity={person.selection ? 'editing' : 'active'} />)}</div>
          </div>
          <CommentCompose value={comment} placeholder="Leave a comment…" onChange={setComment} onSubmit={() => undefined} />
          <CommentCard author={catalogThread.author} time={catalogThread.time} body={catalogThread.body} quote={catalogThread.quote} actions={<button type="button">Resolve</button>} />
        </Section>

        <Section id="overlays" title="Menus, popovers, and dialogs">
          <div className="ds-overlays">
            <div className="ds-overlay-demo">
              <button type="button" className="button" onClick={() => setMenuOpen((open) => !open)}>More</button>
              <Menu
                label="Workspace"
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                items={[
                  { id: 'rename', label: 'Rename', icon: <Icon name="pencil" size={18} />, onSelect: () => undefined },
                  { id: 'duplicate', label: 'Duplicate', icon: <Icon name="duplicate" size={18} />, onSelect: () => undefined },
                  { id: 'delete', label: 'Delete', icon: <Icon name="trash" size={18} />, danger: true, onSelect: () => undefined },
                ]}
              />
            </div>
            <div className="ds-overlay-demo">
              <button type="button" className="button" onClick={() => setPopoverOpen((open) => !open)}>Context</button>
              <Popover open={popoverOpen} title="Heading style" onClose={() => setPopoverOpen(false)}>
                <p>Applies to the current block without leaving the ribbon.</p>
              </Popover>
            </div>
            <div className="ds-overlay-demo">
              <Button variant="primary" onClick={() => setModalOpen(true)}>Open dialog</Button>
              <Modal
                open={modalOpen}
                title="Publish changes?"
                description="Everyone with access will see this version."
                onClose={() => setModalOpen(false)}
              >
                <div className="ds-intent-row">
                  <Button onClick={() => setModalOpen(false)}>Cancel</Button>
                  <Button variant="primary" onClick={() => setModalOpen(false)}>Publish</Button>
                </div>
              </Modal>
            </div>
            <output role="status">✓ Changes saved locally</output>
          </div>
        </Section>

        <Section id="materials" title="Material recipes and live rendering tiers">
          <p>CSS frost is always painted. WebGPU or WebGL only add caustics, then fade mix under load instead of swapping the recipe in one frame.</p>
          <div className="ds-materials">{(['cinematic', 'balanced', 'foundation', 'opaque'] as Material[]).map((tier, i) => (
            <article key={tier}>
              <SurfaceMaterial variant={i === 0 ? 'hero' : i === 1 ? 'panel' : 'floating'} modifier={i === 0 ? 'emphasized' : i === 1 ? 'standard' : 'subtle'} />
              <b>{tier}</b>
              <p>{tier === 'opaque' ? 'Solid raised surface; no transparency.' : 'Interpolated blur, saturation, and shader mix'}</p>
            </article>
          ))}</div>
        </Section>

        <Section id="motion" title="Motion sequences and reduced alternatives">
          <div className="ds-motion">
            <div className="motion-full">Full: fade → lift → settle</div>
            <div className="motion-reduced">Reduced: instant state change</div>
          </div>
          <p>Reduced motion removes transforms, smooth scrolling, and decorative motion while retaining immediate state feedback. Async controls keep their width and show an inline spinner.</p>
        </Section>

        <Section id="responsive" title="Responsive postures and accessibility">
          <div className="ds-postures">
            <article className="phone">Phone<br /><small>composer + sheet</small></article>
            <article className="studio">Studio<br /><small>compact ribbon</small></article>
            <article className="desktop">Desktop<br /><small>rail + full ribbon</small></article>
            <article className="fold">Fold book<br /><small>editor │ companion</small></article>
          </div>
          <ul>
            <li>All controls have visible keyboard focus and a minimum 44px comfortable target.</li>
            <li>Semantic foreground/background pairs meet WCAG AA contrast.</li>
            <li>Matrices remain usable at 200% zoom without two-dimensional page scrolling.</li>
            <li>Forced colors preserve borders and selection; reduced preferences remove blur and motion.</li>
          </ul>
          <a href="/docs/DESIGN-SYSTEM.md">Read the design-system contract</a>
        </Section>
      </main>
    </div>
  );
}
