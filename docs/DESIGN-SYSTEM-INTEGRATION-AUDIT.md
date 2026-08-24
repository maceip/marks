# Design-system source integration audit

This audit records the eight independent source PRs inspected before integration. The canonical base was `main` at `bddaec4c3efcfd86eec4f8923758c4ffb6bc1567`; every PR has that exact merge base and therefore no worker was based on another worker. All PRs were open and mechanically mergeable when audited. GitHub checks and review details below are historical source-patch signals, not integration validation.

| PR | Source patch | Branch | Published head | Diff | Checks / review |
|---|---|---|---|---:|---|
| #37 | Refactor design tokens | `md-refactor-and-enhance-design-tokens` | `a8e238f37ab88e1a4b03832a5544b6e3c27a1b1f` | +1025/-828, 15 files | 4 failures; Backstory neutral; bot commented |
| #38 | Standardize ribbon design system | `md-create-ribbon-component-specification-and-styles` | `d1dfe02877bd280de42fd6438e29642bb22b2b5a` | +340/-517, 10 files | 4 failures; Backstory neutral; bot commented |
| #39 | Foundational UI controls | `md-add-foundational-ui-components-and-tests` | `408c6fade4f1275b22935c7d6c7d97cf23b69d2d` | +190/-105, 16 files | 5 failures; bot commented |
| #40 | Controlled AgentChatPill | `md-add-agentchatpill-component-with-states` | `2a5943c4baece66f4ea33eb16220b359e8daf027` | +231/-9, 6 files | browser jobs passed; test failed; bot commented |
| #41 | Adaptive material tiers | `md-implement-material-registry-and-rendering-tiers` | `c7c4056db6cabcb90433f9d38b85bd52b1fe16ea` | +255/-55, 19 files | browser jobs passed; test failed; bot commented |
| #42 | Shared motion system | `md-extend-motion-styles-and-utilities` | `0b842a33c796a03e43c650177cf2b3643cf95f3c` | +218/-85, 15 files | 4 failures; Backstory neutral; bot commented |
| #43 | Phased design-system foundation | `md-implement-design-system-migration-phases` | `4d373bf9021f0c28ee46186c94831e0b632556d1` | +1904/-2, 21 files | browser jobs passed; test failed; bot commented |
| #44 | Lazy internal catalog | `md-add-internal-lazy-loaded-design-system-route` | `3789110dac8a7a3e4ebe7ab40657e86402458f23` | +227/-32, 10 files | browser jobs passed; test failed; bot commented |

Each PR contains one published commit with the title described above. The eight originally reported local SHAs (`619b3021`, `16ef8358`, `384f0aa0`, `975e0d4f`, `a9ff056f`, `761f9d5`, `da59a3c`, and `18374e0`) are not objects advertised by the remote. Their task mapping is confirmed by branch names and changed-file contents, while the published heads above are the authoritative source patches.

## Overlap matrix

| Shared path | PRs |
|---|---|
| `tokens.css` | #37, #38, #42, #43 |
| `index.css` | #38, #39, #42 |
| `base.css` | #37, #39, #42 |
| `layout.css`, `chrome.css` | #37, #38, #42 |
| `material.css` | #37, #41, #42 |
| `RibbonCommand.tsx` | #38, #39 |
| `PhoneComposer.tsx` | #40, #41 |
| shared UI primitives | #39, #43 |
| `App.tsx`, routing | #43, #44 |
| `DESIGN-SYSTEM.md`, catalog checker | #43, #44 |
| `UI-SURFACE.md` | #41, #43, #44 |
| `package.json` | #37, #38, #39, #41, #42, #43, #44 |

The package changes only add complementary scripts (`test:tokens`, `visual:ribbon`, `test:components`, `test:materials`, `check:motion`, inventory/catalog checks); none adds a dependency or modifies the lockfile. CSS ordering competed between material-before-layout and component-before-layout variants. Integration uses tokens first, then base/layout/material and feature layers, with reusable motion/catalog and ribbon CSS loaded at their lazy feature boundaries.

No source PR contains binary assets, generated screenshots, or lockfile changes. PR #43's inventory JSON is retained as explicit generated inventory data; its competing catalog and primitive library were discarded. PR #44's route/catalog won, normalized to the canonical primitives, material registry, and controlled agent pattern. The remaining unique behavior was retained or manually ported rather than merging any source branch.
