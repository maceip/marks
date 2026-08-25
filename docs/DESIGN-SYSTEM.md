# Marks design-system contract

The internal catalog at [`/design-system`](../client/src/design-system/DesignSystem.tsx) is the executable contract for Marks UI. It is lazy-loaded, absent from production navigation, and uses the same tokens and production primitives as the application. Catalog-only copy and adverse-state data live in `client/src/design-system/fixtures.ts`; production code must never import them.

## Ownership and contribution

The browser-surface maintainers own this contract, `client/src/styles/tokens.css`, shared primitives under `client/src/components/ui`, and catalog review. A change to a shared primitive is incomplete until its relevant matrix is updated.

Contributions must:

1. use an existing semantic token or propose a token change—never add a one-off visual constant to a component;
2. put reusable behavior in production components and catalog scenarios in `design-system/fixtures.ts`;
3. render applicable default, hover, focus-visible, active, selected, disabled, loading, danger, long-label, localization-expansion, and 200%-zoom states;
4. exercise light/dark, comfortable/compact, full/reduced glass, full/reduced motion, and every material tier;
5. include keyboard and screen-reader semantics before visual polish; and
6. update this contract and visual/accessibility checks in the same pull request.

Reviewers from browser-surface ownership approve token or primitive changes. Product-area owners approve behavior changes in their patterns.

## Naming conventions

- **Tokens:** semantic CSS custom properties use `--role[-state]` (`--text-muted`, `--danger-soft`). Foundation scales use `--radius-*`, `--shadow-*`, and `--motion-*`.
- **Components:** React components use PascalCase; props describe intent rather than appearance (`danger`, not `red`).
- **CSS:** production classes name the component or pattern. Catalog-only classes use the `ds-` prefix.
- **States:** native attributes (`disabled`, `aria-selected`, `aria-pressed`) are authoritative. `state-*` classes exist only to make transient states deterministic in the catalog.
- **Materials:** `cinematic`, `balanced`, `foundation`, and `opaque`, from richest to least composited. Cinematic prefers a WebGPU liquid-glass pass, then WebGL2; both fade `--material-shader-mix` under load so CSS gaussian frost never pops off in a single frame.

## Accessibility requirements

All interactive controls require an accessible name, logical DOM order, visible `:focus-visible`, keyboard operability, and a 44×44 CSS-pixel comfortable-density target. Text and meaningful UI graphics must meet WCAG 2.2 AA contrast. Do not communicate status by color alone. Dialogs and sheets require labeled modal semantics, focus containment/restoration, Escape dismissal, and inert background content.

Every affected matrix is checked at 200% browser zoom, with keyboard-only navigation, `forced-colors: active`, `prefers-reduced-motion: reduce`, and `prefers-reduced-transparency: reduce`. Content must reflow without page-level two-dimensional scrolling. Reduced modes must preserve meaning and immediate feedback: replace movement with an instant state change, and glass with an opaque bordered surface.

## Token-change policy

Tokens are a public interface within the client. Before changing one, inventory consumers, describe the semantic intent, verify both themes and forced colors, run the catalog checks, and attach before/after catalog captures. Do not rename or delete a token in the same change that migrates only some consumers. Aliases may bridge a staged migration, but must include a removal issue. Raw color, spacing, blur, radius, shadow, or duration values belong only in the token source or in an explicitly documented rendering algorithm.

## Catalog map

- [Foundations: intent roles, elevation, radius, isometric icons](/design-system#foundations)
- [Controls: buttons, icon buttons, pills, tabs, size-stable loading](/design-system#controls)
- [Ribbon chrome; agent-chat patterns appear only in an explicitly enabled agent-chat build](/design-system#chrome)
- [Presence and comments](/design-system#collaboration)
- [Menus, popovers, and dialogs](/design-system#overlays)
- [Material recipes and rendering tiers](/design-system#materials)
- [Motion and reduced alternatives](/design-system#motion)
- [Responsive postures and accessibility](/design-system#responsive)

## Verification

Run `npm run test:design-system` against a production build. The check verifies the route chunk boundary, landmark and matrix presence, keyboard focus, 200% zoom reflow, semantic contrast, reduced motion, forced colors, and captures each theme/tier combination in `artifacts/design-system/` for visual-regression comparison by CI or reviewers.
