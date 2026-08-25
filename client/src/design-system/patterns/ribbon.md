# Ribbon pattern

The ribbon is the shared task-command system across desktop, studio, phone, and
foldable shells. `DesktopRibbon.tsx`, `PhoneComposer.tsx`,
`FoldableRibbon.tsx`, and `RibbonCommand.tsx` are the reference product
implementations. Consumers compose the exported production components rather
than adding selectors. All ribbon-family selectors live in
`styles/components/ribbon.css`; the design-system contract rejects a second
owner.

## Anatomy

1. **Titlebar** owns document identity and window-level controls. **Quick
   actions** are the small, high-frequency controls beside that identity.
2. The **tab list** selects one deck. A **contextual tab** is appended only when
   the editor selection provides its context (picture, table, or shape).
3. The **deck** is the single clipped transition boundary below the tabs. It
   contains one horizontally scrolling **toolbar**.
4. A toolbar is divided into labelled **groups**. A group may expose a
   **launcher** for its advanced surface.
5. A **command** is the standard glyph-and-label action. A **gallery** is a
   compact, visually comparable collection of choices in a group.
6. In **collapsed state**, desktop retains the titlebar and hides the tab/deck
   region. **Focus mode** does the same while also removing nonessential chrome.
7. On phone or short coarse-pointer viewports, the desktop tab row is replaced
   by a fixed-bottom task ribbon. Its header has one **category trigger** and a
   persistent **Edit / Preview** mode switch; its deck shows exactly one task's
   command groups at a time. Opening the trigger presents the task picker in a
   labelled sheet, with **All commands** as the explicit expanded path. This
   keeps navigation and commands causally related instead of presenting two
   unrelated rows. The phone projection uses the same command registry,
   availability rules, profile, contextual state, agent relevance, and feature
   flags as desktop. The **View** task owns the Ghost overlay control.
8. Foldable book and laptop postures keep the same task/deck anatomy but segment
   it around the reported hinge. Commands and flyouts may not occupy the hinge
   gap; companion space is presentation-only and cannot steal ribbon hit targets.

## States

| State | Contract |
| --- | --- |
| Default | Muted label/glyph on a raised, stable command footprint. |
| Hover | Tint border/surface/text over `--motion-fast`; no required reflow. |
| Pressed | Move down 1px (or scale) over `--motion-instant`. |
| Selected | Use `aria-pressed`/`aria-selected` plus accent colors; dimensions never change. |
| Disabled | Native `disabled` or `aria-disabled`; reduced opacity and no action. |
| Loading | `loading` sets `aria-busy`, `data-loading`, disables activation, and animates the glyph. |
| Dangerous | `danger`/`data-danger` uses semantic `--danger`; danger is not communicated by color alone because the accessible label remains explicit. |
| Contextual | Green contextual accent; appearance fades and scales horizontally from the tab's left origin. |
| Focus-visible | Semantic `--focus-ring`, never an ad-hoc outline color. |
| Collapsed | Titlebar remains; deck/tabs are absent on desktop. |
| Focus mode | Titlebar-only command chrome; workspace receives focus. |
| Compact density | Compact height, tab, command, and gap tokens are selected without changing anatomy. |
| Coarse pointer | Minimum touch target, fixed-bottom phone task ribbon, and horizontally scrollable command groups. |

## Sizing tokens

Do not encode shared ribbon sizing in components. `tokens.css` defines reusable
shell and interaction values; `ribbon.css` owns pattern-local aliases for tab,
command, gap, icon, and label geometry. `data-density="compact"` switches those
aliases. Phone substitution deliberately retains safe-area-aware height and
touch geometry in the same canonical stylesheet.

## Motion

Tab selection is a two-phase transaction. The old deck transitions from
`opacity: 1` and `translateY(0)` to `opacity: 0` and `translateY(-4px)` over
`--motion-exit-fast`. Only after its animation ends does React swap the content.
The new deck then transitions from `opacity: 0` and `translateY(4px)` to its
resting state over `--motion-enter-fast`. Contextual tabs fade and horizontally
scale from the tab origin. Reduced motion swaps at an effectively immediate
animation boundary and never translates.

Commands tint on hover over `--motion-fast`, press over `--motion-instant`, and
change selected colors without movement. Glyph tilt is disabled for reduced
motion and when `data-surface-tier="foundation"` is selected.

## Accessibility and composition

Tabs use `role="tablist"`, `role="tab"`, and `aria-selected`. Toolbars retain an
accessible command-family label. Icon-only launchers require an action-specific
label. Use exported props and subcomponents first; new behavior may add a stable
prop or `data-*` state, but must not require a one-off descendant selector.

## Visual regression matrix

Run `npm run visual:ribbon` against a live app. Coverage captures light and dark
themes across 320×568 and 390×844 phone portrait, 844×390 phone landscape,
1280×800 fold-book, 840×1100 fold-laptop, 1024×800 studio, and 1440×900 desktop
postures. The phone matrix also captures the category picker and the View deck
containing the Ghost overlay control. Desktop/studio coverage retains comfortable
and compact density, a contextual tab, and collapsed state. Every case uses an
explicit `marks-posture` query override so the baseline name matches the shell
under test. Set `UPDATE_RIBBON_SCREENSHOTS=1` only when intentionally accepting
new baselines.
