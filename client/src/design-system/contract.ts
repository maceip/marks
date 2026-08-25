/**
 * The human- and machine-readable ownership map for Marks UI.
 *
 * Keep this deliberately declarative: production code consumes the owners
 * listed here, the live catalog renders them, and the inventory/check scripts
 * verify that new UI machinery cannot appear without joining this contract.
 */

export interface DesignSystemEntryPoint {
  id: string;
  label: string;
  location: string;
  purpose: string;
}

export interface DesignSystemOwner {
  id: string;
  label: string;
  source: string;
  styles?: readonly string[];
  documentation?: string;
  scope: string;
}

export interface DesignSystemRule {
  id: string;
  requirement: string;
  enforcedBy: readonly string[];
}

export interface DesignSystemException {
  id: string;
  scope: string;
  reason: string;
  owner: string;
}

export const DESIGN_SYSTEM_ENTRY_POINTS: readonly DesignSystemEntryPoint[] = [
  {
    id: 'human-contract',
    label: 'Human and agent contract',
    location: 'docs/DESIGN-SYSTEM.md',
    purpose: 'How to modify, add, review, and verify Marks UI.',
  },
  {
    id: 'live-catalog',
    label: 'Executable catalog',
    location: '/design-system',
    purpose: 'Production primitives, patterns, states, motion, themes, and postures.',
  },
  {
    id: 'machine-inventory',
    label: 'Machine inventory',
    location: 'docs/design-system-inventory.json',
    purpose: 'Deterministic inventory of every UI component, style, pattern, icon, asset, and exception.',
  },
  {
    id: 'canonical-ui-api',
    label: 'Canonical UI API',
    location: 'client/src/components/ui/index.ts',
    purpose: 'The only public import surface for shared React UI primitives.',
  },
] as const;

export const DESIGN_SYSTEM_FOUNDATIONS: readonly DesignSystemOwner[] = [
  {
    id: 'tokens',
    label: 'Semantic tokens',
    source: 'client/src/styles/tokens.css',
    styles: ['client/src/styles/foundation-tokens.css', 'client/src/styles/document-tokens.css'],
    documentation: 'docs/design-tokens.md',
    scope: 'Color, typography, spacing, geometry, elevation, layers, interaction, motion, material, and posture values.',
  },
  {
    id: 'base',
    label: 'Universal element and accessibility foundation',
    source: 'client/src/styles/base.css',
    styles: ['client/src/styles/index.css'],
    scope: 'Element normalization, focus-visible, accessible hiding, icon rendering, and shared control behavior.',
  },
  {
    id: 'motion',
    label: 'Motion system',
    source: 'client/src/styles/motion.css',
    styles: ['client/src/components/icons/motion.ts'],
    documentation: 'docs/MOTION-DESIGN-SYSTEM.md',
    scope: 'Named CSS motion recipes, Web Animation plans, and reduced-motion alternatives.',
  },
  {
    id: 'materials',
    label: 'Material system',
    source: 'client/src/design-system/materials.ts',
    styles: ['client/src/styles/material.css'],
    scope: 'CSS frost invariant, rendering tiers, and optional GPU enhancement variables.',
  },
  {
    id: 'icons',
    label: 'Icon system',
    source: 'client/src/components/icons/catalog.ts',
    styles: ['client/src/components/icons/assets.ts', 'client/src/components/ui/Icon.tsx'],
    scope: 'Typed names, tones, PNG/vector assets, interaction shell, load fallback, and command glyphs.',
  },
] as const;

export const DESIGN_SYSTEM_PRIMITIVES: readonly DesignSystemOwner[] = [
  {
    id: 'react-primitives',
    label: 'React UI primitives',
    source: 'client/src/components/ui/index.ts',
    styles: ['client/src/styles/components.css'],
    scope: 'Buttons, icon buttons, tabs, menus, popovers, modals, status, comments, materials, icons, and brand mark.',
  },
  {
    id: 'command-glyph',
    label: 'Command glyph',
    source: 'client/src/components/glyphs/Glyph.tsx',
    scope: 'Command-sized, typed use of the shared icon renderer.',
  },
] as const;

export const DESIGN_SYSTEM_PATTERNS: readonly DesignSystemOwner[] = [
  {
    id: 'ribbon',
    label: 'Ribbon and Quick Access',
    source: 'client/src/components/chrome/RibbonCommand.tsx',
    styles: ['client/src/styles/components/ribbon.css'],
    documentation: 'client/src/design-system/patterns/ribbon.md',
    scope: 'Desktop, studio, phone, and foldable task/category/deck/command anatomy and states.',
  },
  {
    id: 'document-chrome',
    label: 'Document chrome',
    source: 'client/src/components/chrome/DocumentChrome.tsx',
    styles: ['client/src/styles/chrome.css'],
    scope: 'Shell-specific composition around canonical ribbon, app rail, dock, and contextual tools.',
  },
  {
    id: 'workspace',
    label: 'Editor and rendered workspace',
    source: 'client/src/components/workspace/Workspace.tsx',
    styles: [
      'client/src/styles/document.css',
      'client/src/styles/editor.css',
      'client/src/styles/preview.css',
      'client/src/styles/workspace.css',
      'client/src/styles/browser.css',
      'client/src/styles/outline.css',
      'client/src/styles/katex.css',
    ],
    scope: 'Editor, preview, outline, document content, and responsive pane composition.',
  },
  {
    id: 'overlays',
    label: 'Overlays and dialogs',
    source: 'client/src/components/overlays/AppOverlays.tsx',
    styles: ['client/src/styles/overlays.css'],
    scope: 'Menus, sheets, command palette, notifications, import flows, preferences, and modal tasks.',
  },
  {
    id: 'collaboration',
    label: 'Presence and collaboration',
    source: 'client/src/components/shell/PresenceBar.tsx',
    styles: ['client/src/styles/layout.css'],
    scope: 'Presence, participant state, comments, cursors, and collaboration affordances.',
  },
  {
    id: 'agent',
    label: 'Agent interaction',
    source: 'client/src/components/agent/AgentChatPill.tsx',
    styles: ['client/src/styles/agent.css', 'client/src/components/agent/agent-chat.css'],
    scope: 'Prompt, run, approval, receipt, error, and expanded conversation states.',
  },
  {
    id: 'identity',
    label: 'Identity and sharing',
    source: 'client/src/components/identity/ShareDialog.tsx',
    scope: 'Account, device linking, access, sharing, and workspace retention.',
  },
  {
    id: 'home',
    label: 'Home and public entry',
    source: 'client/src/pages/Home.tsx',
    styles: ['client/src/styles/home.css'],
    scope: 'Recent documents, templates, import entry, and public/mobile onboarding.',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics and advanced inspectors',
    source: 'client/src/components/practical/PracticalInspector.tsx',
    styles: ['client/src/styles/practical.css', 'client/src/styles/benchmark.css', 'client/src/styles/perf-hud.css', 'client/src/styles/wild.css'],
    scope: 'Document intelligence, performance, telemetry, and experimental inspection surfaces.',
  },
  {
    id: 'catalog',
    label: 'Executable design-system catalog',
    source: 'client/src/design-system/DesignSystem.tsx',
    styles: ['client/src/design-system/design-system.css'],
    documentation: 'docs/DESIGN-SYSTEM.md',
    scope: 'Governance map and production-component scenarios across states, themes, density, materials, motion, and postures.',
  },
] as const;

export const DESIGN_SYSTEM_RULES: readonly DesignSystemRule[] = [
  {
    id: 'registered-machinery',
    requirement: 'Every production UI component, page, stylesheet, pattern, icon, and asset is present in the deterministic inventory.',
    enforcedBy: ['scripts/check-design-system-contract.mjs'],
  },
  {
    id: 'canonical-primitives',
    requirement: 'Shared UI consumers import the canonical components/ui barrel; every public primitive is exported there.',
    enforcedBy: ['scripts/check-design-system-contract.mjs'],
  },
  {
    id: 'typed-icons',
    requirement: 'Action artwork uses typed Icon/Glyph names; catalog and PNG assets have exact parity and a runtime fallback.',
    enforcedBy: ['client/src/components/icons/catalog.test.ts', 'scripts/check-design-system-contract.mjs'],
  },
  {
    id: 'single-pattern-owner',
    requirement: 'A pattern selector has one canonical stylesheet owner; shell styles may compose but may not redefine its anatomy.',
    enforcedBy: ['scripts/check-design-system-contract.mjs'],
  },
  {
    id: 'semantic-values',
    requirement: 'Reusable values come from semantic tokens; rendering algorithms and third-party content require a documented exception.',
    enforcedBy: ['scripts/token-contract.test.mjs', 'scripts/check-motion-tokens.mjs'],
  },
  {
    id: 'executable-states',
    requirement: 'The live catalog renders production components, applicable states, themes, density, materials, motion, and posture variants.',
    enforcedBy: ['scripts/check-design-system.mjs'],
  },
] as const;

export const DESIGN_SYSTEM_EXCEPTIONS: readonly DesignSystemException[] = [
  {
    id: 'document-content',
    scope: 'Rendered Markdown, user-authored HTML/images, KaTeX, Mermaid, and syntax themes.',
    reason: 'User content and third-party renderers are normalized and sandboxed, but are not command-chrome artwork.',
    owner: 'workspace',
  },
  {
    id: 'identity-imagery',
    scope: 'User avatars and generated QR modules.',
    reason: 'These encode user/service data and cannot be replaced by a catalog command glyph.',
    owner: 'identity',
  },
  {
    id: 'brand-mark',
    scope: 'MarksMark and public product identity artwork.',
    reason: 'Brand identity is a governed primitive distinct from the command icon catalog.',
    owner: 'react-primitives',
  },
  {
    id: 'material-rendering',
    scope: 'Canvas/WebGPU/WebGL material algorithms and performance visualizations.',
    reason: 'Numeric rendering constants may live in typed rendering recipes when CSS computed values are not practical.',
    owner: 'materials',
  },
  {
    id: 'static-ghost-explainer',
    scope: 'The large Ghost overlay illustration inside its explanatory dialog.',
    reason: 'It is deliberately noninteractive so it cannot imply a second actionable control.',
    owner: 'overlays',
  },
] as const;

export const DESIGN_SYSTEM_CONTRACT_VERSION = 1 as const;
