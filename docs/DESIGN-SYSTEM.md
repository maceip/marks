# Marks design system delivery

The design system extends the single app described by [`UI-SURFACE.md`](UI-SURFACE.md); it does not create another browser entry or React root. Its catalog is the lazy `/design-system` route, and its CSS is paid only when that route opens. Shared primitive CSS remains in the app-shell budget.

## Phased migration

1. **Inventory and freeze.** `design-system-inventory.json` records selectors, literals, control states, themes, postures, and material hosts. The baseline image hashes below freeze the pre-migration visual receipt.
2. **Foundations.** `tokens.css` provides semantic color, spacing, control, and motion names while old variables remain compatibility aliases. `SurfaceMaterial` names chrome, panel, floating, and hero recipes while opaque editor and preview surfaces remain outside glass hosts.
3. **Primitives.** `components/ui` owns Button, IconButton, Chip, Tabs, Tooltip, and Status. Primitives expose native semantics; icon-only controls require a label, arrow keys move tabs, and danger status uses an alert role.
4. **Major patterns.** Ribbon work continues through shared command contracts. The Ask Marks pill reuses the same semantic action, motion, and draft-tools path rather than introducing a second agent surface.
5. **Catalog and governance.** Run `npm run check:design-system`, `npm run test:surface`, `npm run typecheck`, `npm run build`, and `npm run check:ui-budgets`. The catalog must remain lazy.
6. **Controlled cleanup.** Do not delete a legacy selector or alias until `rg '<name>' client/src` returns no call sites and the full matrix passes.

## Baseline receipt

These repository screenshots existed before visual migration and are retained as the baseline:

| Image | SHA-256 |
| --- | --- |
| `screenshots/split-light.png` | `d4933899fafde010374b7832e9aa346ce62d56b4f28d6fb697b44d51b79aafb6` |
| `screenshots/split-dark.png` | `d1ca78cd543959e5b7c6e9fea9399659acd3b37f6d555fa1cfdedf52983b3721` |
| `screenshots/performance.png` | `cc0ce2b63c783ed2980e70a35b704531d51d8b6dc32860965e4c0f5388f21634` |
| `screenshots/benchmark.png` | `dd6a22ce1628f31c825e1fd713d13e655fa69a502830aad72dbe6531574e9835` |

## Visual and accessibility matrix

Exercise light and dark themes at desktop (1440×900), phone (390×844), studio (853×1280), and forced fold postures. For each, cover default, hover, keyboard focus, pressed, disabled, loading, offline, reduced motion, and reduced transparency. Validate accessible names, tab order, arrow-key tab selection, contrast, zoom at 200%, and no horizontal app-shell scrolling.

All phases preserve the transfer ceilings and route-splitting rules in `UI-SURFACE.md`. A phase cannot merge if `check:ui-budgets` regresses the app home or if the catalog, editor, overlays, renderer, or benchmark leaks into an earlier route.
