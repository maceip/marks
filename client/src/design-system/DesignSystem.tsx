import '../styles/overlays.css';
import '../styles/chrome.css';
import '../styles/components/ribbon.css';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  RibbonCommand,
  RibbonDeck,
  RibbonGroup,
  RibbonTabButton,
  RibbonTabList,
  RibbonToolbar,
} from '../components/chrome/RibbonCommand';
import type { AgentChatState } from '../components/agent/agent-chat-model';
import {
  Avatar,
  Button,
  CommentCard,
  CommentCompose,
  Divider,
  ICON_NAMES,
  Icon,
  iconLabel,
  IconButton,
  MarksMark,
  Menu,
  Modal,
  Pill,
  Popover,
  Spinner,
  SurfaceMaterial,
  Tabs,
  Tooltip,
} from '../components/ui';
import { PresenceBar } from '../components/shell/PresenceBar';
import { LiquidDock } from '../components/shell/LiquidDock';
import { catalogPeers, catalogStates, catalogThread, palette, sectionLinks } from './fixtures';
import {
  DESIGN_SYSTEM_CONTRACT_VERSION,
  DESIGN_SYSTEM_ENTRY_POINTS,
  DESIGN_SYSTEM_EXCEPTIONS,
  DESIGN_SYSTEM_FOUNDATIONS,
  DESIGN_SYSTEM_PATTERNS,
  DESIGN_SYSTEM_PRIMITIVES,
  DESIGN_SYSTEM_RULES,
} from './contract';
import type { Peer } from '../collab/types';
import './design-system.css';

type Toggle = 'light' | 'dark';
type Material = 'cinematic' | 'balanced' | 'foundation' | 'opaque';

const AgentChatPill = __MARKS_FEATURES__.agentChat
  ? lazy(() => import('../components/agent/AgentChatPill').then((module) => ({ default: module.AgentChatPill })))
  : null;

const CATALOG_POSTURES = [
  ['phone', 'Phone', 'task picker + one command deck', 'pencil'],
  ['studio', 'Studio', 'compact task ribbon', 'split'],
  ['desktop', 'Desktop', 'task tabs + full ribbon', 'bold'],
  ['fold', 'Fold book', 'hinge-safe task ribbon', 'sidebar'],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="ds-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

function AgentChatCatalog() {
  const [state, setState] = useState<AgentChatState>('collapsed');
  const [prompt, setPrompt] = useState('Summarize this document');
  if (!AgentChatPill) return null;
  return (
    <>
      <label>
        Pattern state
        <select
          aria-label="Agent-chat pattern state"
          value={state}
          onChange={(event) => setState(event.target.value as AgentChatState)}
        >
          {['collapsed', 'focused', 'submitting', 'working', 'result', 'error', 'expanded'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div className="ds-agent-live">
        <Suspense fallback={null}>
          <AgentChatPill
            state={state}
            shell="desktop"
            prompt={prompt}
            result={state === 'result' || state === 'expanded' ? 'The document has three main sections.' : undefined}
            error={state === 'error' ? 'The assistant could not finish.' : undefined}
            onOpen={() => setState('focused')}
            onPromptChange={setPrompt}
            onSubmit={() => setState('working')}
            onCancel={() => setState('focused')}
            onRetry={() => setState('submitting')}
            onClose={() => setState('collapsed')}
            onExpand={() => setState('expanded')}
          />
        </Suspense>
      </div>
    </>
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

// The release-coexistence proof builds this lazily loaded chunk twice with
// different salts so its hashed filename differs across the two builds;
// the salt must be rendered or the bundler would eliminate it.
const RELEASE_SALT = import.meta.env.VITE_MARKS_RELEASE_SALT ?? 'dev';

export function DesignSystem({ onBack }: { onBack: () => void }) {
  const [theme, setTheme] = useState<Toggle>('light');
  const [density, setDensity] = useState('comfortable');
  const [glass, setGlass] = useState('full');
  const [motion, setMotion] = useState('full');
  const [material, setMaterial] = useState<Material>('balanced');
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
    <div className="design-system" data-release-salt={RELEASE_SALT}>
      <header className="ds-header">
        <div>
          <span className="ds-eyebrow">Internal catalog</span>
          <h1>Marks design system</h1>
          <p>Production tokens, isometric icons, liquid materials, and the chrome that owns writing, review, and presence.</p>
        </div>
        <button type="button" className="ds-back" onClick={onBack}><Icon name="chevron" size={16} /> Back to Marks</button>
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
        <Section id="governance" title="One-stop ownership and enforcement">
          <div className="ds-governance-lead">
            <MarksMark size={48} label="Marks design system" />
            <div>
              <Pill>Contract v{DESIGN_SYSTEM_CONTRACT_VERSION}</Pill>
              <p>Start here for every UI modification, addition, or clarification. Each concern has one source owner, an executable production example, and a check that rejects unregistered machinery.</p>
            </div>
          </div>
          <h3>Entry points</h3>
          <div className="ds-governance-grid">
            {DESIGN_SYSTEM_ENTRY_POINTS.map((entry) => (
              <article key={entry.id} data-design-system-entry={entry.id}>
                <b>{entry.label}</b><code>{entry.location}</code><p>{entry.purpose}</p>
              </article>
            ))}
          </div>
          <h3>Canonical owners</h3>
          <div className="ds-owner-list">
            {[...DESIGN_SYSTEM_FOUNDATIONS, ...DESIGN_SYSTEM_PRIMITIVES, ...DESIGN_SYSTEM_PATTERNS].map((owner) => (
              <article key={owner.id} data-design-system-owner={owner.id}>
                <b>{owner.label}</b>
                <code>{owner.source}</code>
                <p>{owner.scope}</p>
                {owner.styles?.map((style) => <code key={style}>{style}</code>)}
              </article>
            ))}
          </div>
          <h3>Non-negotiable rules</h3>
          <ol className="ds-contract-list">
            {DESIGN_SYSTEM_RULES.map((rule) => <li key={rule.id} data-design-system-rule={rule.id}><b>{rule.requirement}</b><code>{rule.enforcedBy.join(' · ')}</code></li>)}
          </ol>
          <h3>Explicit exceptions</h3>
          <div className="ds-exception-list">
            {DESIGN_SYSTEM_EXCEPTIONS.map((exception) => <article key={exception.id} data-design-system-exception={exception.id}><b>{exception.scope}</b><p>{exception.reason}</p><code>Owner: {exception.owner}</code></article>)}
          </div>
        </Section>

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
          <div className="ds-icon-grid">{ICON_NAMES.map((name) => <span className="icon-demo" title={iconLabel(name)} key={name}><Icon name={name} size={28} /><span>{iconLabel(name)}</span></span>)}</div>
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
          <h3>Primitive API</h3>
          <div className="ds-primitive-row" data-ui-primitive-examples>
            <MarksMark size={36} label="Marks product mark" />
            <Pill><Icon name="check" size={16} interactive={false} /> Canonical primitive</Pill>
            <Tooltip content="Shared tooltip behavior and styling"><Button variant="subtle">Hover for help</Button></Tooltip>
          </div>
          <Divider aria-label="Primitive examples divider" />
          <h3>Pills, spinner, tabs</h3>
          <StateMatrix kind="pill" />
          <div className="ds-status">
            <Pill><Icon name="check" size={16} interactive={false} /> Connected</Pill>
            <Pill><Spinner aria-label="Saving" /> Saving</Pill>
            <Pill><Icon name="bolt" size={16} interactive={false} /> Attention</Pill>
            <Pill><Icon name="close" size={16} interactive={false} /> Offline</Pill>
          </div>
          <StateMatrix kind="input" />
          <Tabs label="Document views" selectedId={catalogTab} onChange={setCatalogTab} items={['write', 'preview', 'review', 'history'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))} />
        </Section>

        <Section id="chrome" title={__MARKS_FEATURES__.agentChat ? 'Ribbon and agent chat' : 'Ribbon'}>
          <div className="ds-ribbon">
            <div className="ds-titlebar">Quick access <b>Document title</b> Presence</div>
            <div className="ribbon-body">
              <RibbonTabList>
                {['File', 'Home', 'Insert', 'Review', 'View'].map((label) => <RibbonTabButton key={label} selected={label === 'Home'}>{label}</RibbonTabButton>)}
              </RibbonTabList>
              <RibbonDeck>
                <RibbonToolbar aria-label="Catalog production ribbon">
                  <RibbonGroup label="Clipboard">
                    {catalogStates.slice(0, 4).map((state, index) => <RibbonCommand key={state.id} glyph={index % 2 ? 'italic' : 'bold'} label={state.label} disabled={state.id === 'disabled'} pressed={state.id === 'selected'} danger={state.id === 'danger'} onClick={() => undefined} />)}
                  </RibbonGroup>
                  <RibbonGroup label="Formatting">
                    {catalogStates.slice(4, 8).map((state, index) => <RibbonCommand key={state.id} glyph={index % 2 ? 'highlight' : 'heading'} label={state.label} disabled={state.id === 'disabled'} pressed={state.id === 'selected'} danger={state.id === 'danger'} onClick={() => undefined} />)}
                  </RibbonGroup>
                </RibbonToolbar>
              </RibbonDeck>
            </div>
          </div>
          <div className="ds-dock-preview">
            <LiquidDock
              onCommands={() => undefined}
              onComments={() => undefined}
              onHistory={() => undefined}
              voiceSupported
            />
          </div>
          {__MARKS_FEATURES__.agentChat && <AgentChatCatalog />}
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
            <output role="status"><Icon name="check" size={18} interactive={false} /> Changes saved locally</output>
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
            {CATALOG_POSTURES.map(([posture, label, detail, glyph]) => (
              <article className={posture} data-posture={posture} key={posture}>
                <b>{label}</b><small>{detail}</small>
                <RibbonCommand glyph={glyph} label="Production command" onClick={() => undefined} />
              </article>
            ))}
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
