import '../styles/foundation-tokens.css';
import { useEffect, useState, type ReactNode } from 'react';
import { RibbonCommand } from '../components/chrome/RibbonCommand';
import { AgentChatPill } from '../components/agent/AgentChatPill';
import type { AgentChatState } from '../components/agent/agent-chat-model';
import { Icon, icons } from '../components/ui/Icon';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { SurfaceMaterial } from '../components/ui/SurfaceMaterial';
import { catalogStates, palette, sectionLinks } from './fixtures';
import '../styles/motion.css';
import './design-system.css';

type Toggle = 'light' | 'dark';
type Material = 'cinematic' | 'balanced' | 'foundation' | 'opaque';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="ds-section" aria-labelledby={`${id}-title`}><h2 id={`${id}-title`}>{title}</h2>{children}</section>;
}

function StateMatrix({ kind = 'button' }: { kind?: 'button' | 'input' | 'pill' }) {
  return <div className="ds-matrix" role="list" aria-label={`${kind} state matrix`}>
    {catalogStates.map((state) => <div className={`ds-state state-${state.id}`} role="listitem" key={state.id}>
      <small>{state.label}</small>
      {kind === 'input' ? <input aria-label={`${state.label} input`} value={state.id === 'localized' ? state.label : 'Document title'} disabled={state.id === 'disabled'} readOnly /> :
        <Button className={kind === 'pill' ? 'ds-pill' : ''} disabled={state.id === 'disabled'} loading={state.id === 'loading'} aria-pressed={state.id === 'selected'} variant={state.id === 'danger' ? 'danger' : state.id === 'selected' ? 'primary' : 'secondary'}>
          {state.label}
        </Button>}
    </div>)}
  </div>;
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
  useEffect(() => {
    const root = document.documentElement;
    const previous = { ...root.dataset };
    root.dataset.theme = theme; root.dataset.density = density; root.dataset.glass = glass;
    root.dataset.motion = motion; root.dataset.materialTier = material;
    return () => {
      for (const key of ['theme', 'density', 'glass', 'motion', 'materialTier']) {
        const value = previous[key];
        if (value === undefined) delete root.dataset[key]; else root.dataset[key] = value;
      }
    };
  }, [density, glass, material, motion, theme]);

  return <div className="design-system">
    <header className="ds-header"><div><span className="ds-eyebrow">Internal catalog</span><h1>Marks design system</h1><p>Production primitives, tokens, patterns, and adverse states in one inspectable surface.</p></div><button type="button" onClick={onBack}>← Back to Marks</button></header>
    <div className="ds-controls" aria-label="Catalog simulation controls">
      <label>Theme<select value={theme} onChange={(e) => setTheme(e.target.value as Toggle)}><option>light</option><option>dark</option></select></label>
      <label>Density<select value={density} onChange={(e) => setDensity(e.target.value)}><option>comfortable</option><option>compact</option></select></label>
      <label>Glass<select value={glass} onChange={(e) => setGlass(e.target.value)}><option>full</option><option>reduced</option></select></label>
      <label>Motion<select value={motion} onChange={(e) => setMotion(e.target.value)}><option>full</option><option>reduced</option></select></label>
      <label>Material<select value={material} onChange={(e) => setMaterial(e.target.value as Material)}>{['cinematic','balanced','foundation','opaque'].map(x => <option key={x}>{x}</option>)}</select></label>
    </div>
    <nav className="ds-nav" aria-label="Catalog sections">{sectionLinks.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
    <main>
      <Section id="foundations" title="Foundations"><h3>Palette & semantic roles</h3><div className="ds-swatches">{palette.map(([name, token]) => <div key={token}><span style={{ background: `var(${token})` }} /><b>{name}</b><code>{token}</code></div>)}</div><h3>Typography</h3><div className="ds-type"><span className="display">Display / 36</span><p className="heading-one">Heading one / 28</p><p className="heading-two">Heading two / 22</p><p>Body text keeps long-form writing calm and readable.</p><code>Mono / editor and code</code></div><h3>Spacing, size, radius, border, shadow & icons</h3><div className="ds-foundations"><div className="spacing-demo">4<br/>8<br/>12<br/>16<br/>24<br/>32</div>{['sm','default','lg','xl'].map(x => <span className={`radius-${x}`} key={x}>{x}</span>)}<span className="shadow-demo">Elevation</span><div>{Object.entries(icons).slice(0,12).map(([name,path]) => <span className="icon-demo" title={name} key={name}><Icon path={path}/></span>)}</div></div></Section>
      <Section id="components" title="Component state matrices"><p>Every row includes default, simulated interaction, accessibility, stress, and failure states.</p><h3>Buttons & icon buttons</h3><StateMatrix/><div className="ds-icon-buttons">{catalogStates.map(state => <IconButton key={state.id} label={`${state.label} settings`} disabled={state.id === 'disabled'} loading={state.id === 'loading'} className={`state-${state.id}`} icon={<Icon path={icons.settings}/>} />)}</div><h3>Pills & status indicators</h3><StateMatrix kind="pill"/><div className="ds-status"><span>● Connected</span><span><Spinner aria-label="Saving" /> Saving</span><span>▲ Attention</span><span>● Offline</span></div><h3>Inputs & tabs</h3><StateMatrix kind="input"/><Tabs label="Document views" selectedId={catalogTab} onChange={setCatalogTab} items={['write', 'preview', 'review', 'history'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }))} /><h3>Tooltips, menus, dialogs, sheets & toasts</h3><div className="ds-overlays"><span className="ds-tooltip">Keyboard shortcut <kbd>⌘K</kbd></span><menu><button>Rename</button><button>Duplicate</button><button className="danger">Delete</button></menu><div role="dialog" aria-label="Example dialog"><b>Publish changes?</b><p>Everyone with access will see this version.</p><button>Cancel</button> <button>Publish</button></div><aside>Sheet · Appearance controls</aside><output role="status">✓ Changes saved locally</output></div></Section>
      <Section id="ribbon" title="Ribbon anatomy & states"><div className="ds-ribbon"><div className="ds-titlebar">Quick access <b>Document title</b> Presence</div><div className="ds-ribbon-tabs">File　 <b>Home</b>　Insert　Review　View</div><div className="ds-ribbon-commands">{catalogStates.slice(0,8).map((s,i)=><RibbonCommand key={s.id} glyph={i % 2 ? 'italic' : 'bold'} label={s.label} disabled={s.id==='disabled'} pressed={s.id==='selected'} danger={s.id==='danger'} onClick={()=>undefined}/>)}</div></div></Section>
      <Section id="agent" title="Agent-chat pill states"><label>Pattern state<select aria-label="Agent-chat pattern state" value={agentState} onChange={(event) => setAgentState(event.target.value as AgentChatState)}>{['collapsed', 'focused', 'submitting', 'working', 'result', 'error', 'expanded'].map((state) => <option key={state}>{state}</option>)}</select></label><div className="ds-agent-live"><AgentChatPill state={agentState} shell="desktop" prompt={agentPrompt} result={agentState === 'result' || agentState === 'expanded' ? 'The document has three main sections.' : undefined} error={agentState === 'error' ? 'The assistant could not finish.' : undefined} onOpen={() => setAgentState('focused')} onPromptChange={setAgentPrompt} onSubmit={() => setAgentState('working')} onCancel={() => setAgentState('focused')} onRetry={() => setAgentState('submitting')} onClose={() => setAgentState('collapsed')} onExpand={() => setAgentState('expanded')} /></div></Section>
      <Section id="materials" title="Material recipes & live rendering tiers"><div className="ds-materials">{(['cinematic','balanced','foundation','opaque'] as Material[]).map((tier,i)=><article key={tier}><SurfaceMaterial variant={i===0?'hero':i===1?'panel':'floating'} modifier={i === 0 ? 'emphasized' : i === 1 ? 'standard' : 'subtle'}/><b>{tier}</b><p>{tier==='opaque'?'Solid raised surface; no transparency.':`${24-i*6}px blur, ${160-i*20}% saturation`}</p></article>)}</div></Section>
      <Section id="motion" title="Motion sequences & reduced alternatives"><div className="ds-motion"><div className="motion-full">Full: fade → lift → settle</div><div className="motion-reduced">Reduced: instant state change</div></div><p>Reduced motion removes transforms, smooth scrolling, spinners, and decorative transitions while retaining immediate state feedback.</p></Section>
      <Section id="responsive" title="Responsive postures"><div className="ds-postures"><article className="phone">Phone<br/><small>composer + sheet</small></article><article className="studio">Studio<br/><small>compact ribbon</small></article><article className="desktop">Desktop<br/><small>rail + full ribbon</small></article><article className="fold">Fold book<br/><small>editor │ companion</small></article></div></Section>
      <Section id="accessibility" title="Accessibility test bench"><ul><li>All controls have visible keyboard focus and a minimum 44px comfortable target.</li><li>Semantic foreground/background pairs meet WCAG AA contrast.</li><li>Matrices remain usable at 200% zoom without two-dimensional page scrolling.</li><li>Forced colors preserve borders and selection; reduced preferences remove blur and motion.</li></ul><a href="/docs/DESIGN-SYSTEM.md">Read the design-system contract</a></Section>
    </main>
  </div>;
}
