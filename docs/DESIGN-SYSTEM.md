# Marks design system

This is the one-stop contract for changing Marks UI. Humans and agents should begin here for every modification, addition, clarification, or review. A UI change is not complete merely because a page looks correct: the production implementation, canonical owner, live catalog, generated inventory, and enforcement checks must all agree.

## Authoritative entry points

| Need | Start here | What it owns |
| --- | --- | --- |
| Understand or clarify the system | `docs/DESIGN-SYSTEM.md` | Contribution workflow, ownership rules, exceptions, and acceptance gates |
| Inspect the typed ownership map | `client/src/design-system/contract.ts` | Machine-readable foundations, primitives, patterns, rules, and exceptions |
| See and interact with the system | [`/design-system`](/design-system) | Executable production primitives, states, themes, materials, motion, and posture examples |
| Audit everything classified as UI | `docs/design-system-inventory.json` | Generated components, pages, styles, imports, patterns, icons, assets, and declared exceptions |
| Import a shared React primitive | `client/src/components/ui/index.ts` | The only public primitive import surface |
| Change semantic values | `client/src/styles/tokens.css` | Color, type, spacing, geometry, elevation, layers, interaction, motion, and material decisions |
| Change command artwork or behavior | `client/src/components/icons/` and `Icon`/`Glyph` | Typed names, PNG/vector assets, fallback marks, interaction shell, and activation recipes |
| Change the ribbon | `client/src/components/chrome/RibbonCommand.tsx` and `client/src/styles/components/ribbon.css` | Desktop, studio, phone, and foldable ribbon anatomy and states |

The live catalog's **Governance** section renders the ownership map above from `contract.ts`; it is not separately maintained copy.

## What “universally used” means

All production UI machinery participates in the design system:

1. Every UI `.tsx` module, page, CSS file, pattern document, icon, and icon asset appears in the deterministic inventory.
2. Shared React UI is imported from `components/ui`; direct imports of individual primitive files are rejected.
3. Every module in `components/ui/*.tsx` is exported by the canonical barrel and rendered by the executable catalog.
4. Action artwork uses the typed `Icon` or `Glyph` API. Catalog names and case-sensitive PNG filenames have exact parity, and every asset passes dimension, alpha, and decode checks.
5. Reusable visual values use semantic tokens. CSS and Web Animation motion use named recipes with a reduced-motion alternative.
6. Each pattern class family has one stylesheet owner. Shell or route CSS may compose a pattern but may not redefine its anatomy.
7. A new mechanism cannot be hidden in an untracked helper, route, or stylesheet: the contract check fails until the implementation and reviewed inventory are updated.
8. Exceptions are narrow, explicit, and owned. There are no informal “special cases.”

Catalog-only fixtures may describe adverse states, but production code must never import `client/src/design-system/fixtures.ts`. The catalog must render production components, not visually similar mocks.

## Ownership model

The authoritative list is `client/src/design-system/contract.ts`. At a high level:

- **Foundations** own tokens, base/accessibility behavior, motion, materials, and icons.
- **Primitives** own the canonical React API and command-sized `Glyph`.
- **Patterns** own ribbon/Quick Access, document chrome, workspace, overlays, collaboration, agent interaction, identity/sharing, public home, and diagnostics.
- A pattern's source component owns behavior and semantics; its listed stylesheet owns anatomy and visual states.
- Route and shell code owns composition only. If it needs to alter pattern anatomy, make the change in the pattern owner and expose a semantic prop, state attribute, or token.

For ribbon work specifically, every `.ribbon-*`, `.phone-ribbon*`, `.phone-category*`, `.quick-access*`, and `.foldable-ribbon*` selector belongs to `styles/components/ribbon.css`. The contract checker rejects those class families anywhere else.

## Modification workflow

### Modify an existing primitive or pattern

1. Find its owner in the Governance section or `contract.ts`.
2. Change the canonical production source—not a catalog-only imitation or route override.
3. Use existing semantic tokens and shared state conventions. If the design decision is reusable, add or change a token first.
4. Update the production example and applicable state/posture coverage in `/design-system`.
5. Update the owner documentation when behavior or intent changed.
6. Run the focused tests, regenerate the inventory after reviewing its diff, then run the full design-system gate.

### Add a primitive

1. Add the production component under `client/src/components/ui`.
2. Export it from `client/src/components/ui/index.ts`.
3. Add a representative, interactive production example to `/design-system`.
4. Cover its relevant default, hover, focus-visible, active, selected, disabled, loading, danger, long-label, localization, and high-zoom states.
5. Regenerate and review the inventory. CI will fail if the barrel or catalog step was skipped.

### Add or change an icon

1. Add the typed name, tone, and fallback mark in `components/icons/catalog.ts`.
2. Unless it is a declared vector-only icon, add the exact case-sensitive PNG filename under `client/public/icons/isometric`.
3. Keep the shared 104×104 transparent RGBA asset contract.
4. Render it through `Icon` or `Glyph`; do not add a private `img`, font symbol, or local animation loop.
5. Put activation timing/keyframes in `components/icons/motion.ts`; the renderer consumes that plan and supplies reduced motion, disabled/loading gates, and the vector fallback.
6. Run `npm run test:components` and the full contract.

### Clarify an ambiguous rule

A clarification is a system change. Update this document and, when it is enforceable or changes ownership, `contract.ts`. Add an executable catalog scenario when the clarification affects visible or interactive behavior. A code comment in a single consumer is not an authoritative clarification.

## State and accessibility contract

Native and ARIA state are authoritative: `disabled`, `aria-disabled`, `aria-selected`, `aria-pressed`, `aria-busy`, and stable `data-*` state hooks. `state-*` classes exist only for deterministic catalog simulation.

All interactive controls require an accessible name, logical DOM order, visible `:focus-visible`, keyboard operability, and a 44×44 CSS-pixel comfortable-density target. Text and meaningful graphics must meet WCAG 2.2 AA contrast. Status cannot be communicated by color alone. Dialogs and sheets require labelled modal semantics, focus containment/restoration, Escape dismissal, and inert background content.

Affected surfaces must be checked at 200% zoom, with keyboard-only navigation, `forced-colors: active`, `prefers-reduced-motion: reduce`, and `prefers-reduced-transparency: reduce`. Reduced modes preserve meaning and immediate feedback: movement becomes an immediate state transition, and glass becomes an opaque bordered surface.

## Token and material policy

Tokens are a public interface inside the client. Reusable color, type, spacing, dimensions, shape, borders, opacity, elevation, layering, motion, interaction, and material choices belong in the token system. Local custom properties are allowed only for component-owned geometry or runtime data, such as a split position, fold hinge, or pointer tilt.

Before renaming or deleting a token, inventory all consumers and migrate them coherently. A staged alias needs a tracked removal plan. Raw values are allowed only in a documented third-party/content boundary or typed rendering algorithm covered by an explicit exception.

Material tiers are `cinematic`, `balanced`, `foundation`, and `opaque`. CSS frost is always present; optional GPU enhancement fades its mix under load instead of replacing the recipe abruptly.

See `docs/design-tokens.md` for the detailed token policy.

## Explicit exceptions

The exact list lives in `contract.ts` and appears in the Governance section:

- rendered user-authored Markdown and third-party KaTeX/Mermaid/syntax content;
- user avatars and generated QR modules;
- the governed `MarksMark` brand primitive;
- typed canvas/WebGPU/WebGL rendering algorithms; and
- the large static Ghost overlay explainer illustration, which is deliberately noninteractive.

An exception does not exempt its surrounding controls, labels, motion, layout, or accessibility from the design system.

## Generated inventory

Run:

```sh
npm run inventory:design-system
```

The command deterministically rewrites `docs/design-system-inventory.json`. Do not hand-edit that file. Review the diff: regeneration is an explicit acknowledgement that the listed UI machinery and dependency relationships are intentional. The contract gate deep-compares the working tree with the committed snapshot and reports additions, removals, changed source hashes, and ownership violations.

## Verification

Use the narrowest relevant checks while working, then finish with the full gate:

```sh
npm run typecheck
npm run test:components
npm run test:tokens
npm run check:motion
npm run test:design-system-contract
npm run test:design-system
npm run visual:ribbon
```

- `test:design-system-contract` tests the ownership model and inventory generator, enforces the canonical UI barrel and live-catalog coverage, validates icon/asset parity, rejects pattern-selector leaks, and rejects unreviewed inventory drift.
- `test:design-system` builds production, verifies the catalog is a lazy route, exercises keyboard/zoom/contrast/reduced/forced-color behavior, validates governance and icon loading, and captures the theme/material matrix under `artifacts/design-system`.
- `visual:ribbon` covers phone portrait/landscape, studio, desktop, fold-book, and fold-laptop scenarios. Set `UPDATE_RIBBON_SCREENSHOTS=1` only when intentionally accepting reviewed baselines.

A source-only change, a successful build, or an unreviewed screenshot is not sufficient evidence by itself.

## Catalog map

- [Governance: entry points, owners, rules, and exceptions](/design-system#governance)
- [Foundations: intent roles, elevation, radius, and icons](/design-system#foundations)
- [Controls: canonical primitives and adverse states](/design-system#controls)
- [Ribbon and agent interaction; agent chat appears only in explicitly enabled builds](/design-system#chrome)
- [Presence and comments](/design-system#collaboration)
- [Menus, popovers, and dialogs](/design-system#overlays)
- [Materials and live rendering tiers](/design-system#materials)
- [Motion and reduced alternatives](/design-system#motion)
- [Responsive postures and accessibility](/design-system#responsive)
