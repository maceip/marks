# Motion design system

Motion communicates state without delaying work. Entrances use only `transform` and `opacity`; production UI does not animate layout dimensions. The agent pill changes between its compact and expanded geometries discretely, then animates only owned visual state within that geometry.

Durations, easings, travel, scale, and stagger must come from `tokens.css`. Reusable cross-pattern recipes belong in `motion.css`; a pattern-specific keyframe may live with its registered stylesheet owner. Both routes are scanned for unregistered duration literals. `motion.css` contains only recipes used by production components, so this document must not promise a utility class that has no consumer.

## Interaction and interruption contract

Stateful motion should be implemented as a transition (or a Web Animation whose current time is preserved), so reversing an interaction continues from the current computed visual state. It must not remove/re-add an animation class to reverse direction. A repeated press updates the same state/animation; it never appends to an animation queue. Exit completion may remove a surface, but cancellation must retain it until the reversed entrance completes.

Reduced motion is selected either by `prefers-reduced-motion: reduce` or `data-motion="reduced"` on the root. Both routes make motion instant, remove delay, and preserve the recipe's final state. The replacements below describe that final-state behavior.

## Component sequences

### Fade

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Surface visibility changes | opacity | 0 (enter), 1 (exit) | 1 (enter), 0 (exit) | fast | standard in, accelerate out | none | Reverse from computed opacity; no queue | Set final opacity instantly |

### Fade and rise (panels and liquid dock)

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Panel/dock mounts | opacity, transform | 0; translate Y small + subtle scale | 1; resting transform | medium (dock: slow) | decelerate (dock: spring) | none | Reverse from computed transform/opacity; no queue | Show at rest instantly |

### Popover

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Menu/modal opens or closes | opacity, transform | 0; -small Y/popover scale | 1; rest (reverse on exit) | fast | spring in, accelerate out | none | Reverse the active transition from computed state; no queue | Toggle final visibility instantly |

### Drawer and sheet

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Sidebar/review drawer/sheet opens or closes | opacity, transform | 0; off-axis large translation | 1; rest (reverse on exit) | medium | decelerate in, accelerate out | none | Preserve current progress when direction changes; repeated presses coalesce | Toggle final state instantly |

### Scrim

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Modal/drawer backdrop appears or disappears | opacity | 0 | 1 (reverse on exit) | medium in, fast out | standard in, accelerate out | none | Reverse from computed opacity; no queue | Set final opacity instantly |

### Toast

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Notification added/dismissed | opacity, transform | 0; medium X/popover scale | 1; rest (reverse on exit) | medium in, fast out | spring in, accelerate out | per-item standard stagger | Dismiss reverses current entrance; duplicate presses coalesce by toast id | Add/remove instantly |

### Agent pill

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Agent details expand/collapse | discrete geometry, then opacity/transform inside the owned surface | compact; hidden detail | expanded geometry; visible detail | pattern-owned tokenized motion | pattern-owned easing | none | A repeated action replaces the requested state; it does not queue a second expansion | Switch geometry and content instantly |

### Ribbon deck

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Active ribbon tab/deck is replaced | opacity, transform | 0; small Y | 1; rest | fast | decelerate | optional standard stagger for groups | A new selection replaces the target and continues from computed state; no queue | Replace deck instantly |
| Desktop split inspects the rendered pane, or a foldable rail switches to Preview | opacity, transform | 0; small X | 1; rest | fast | decelerate | none | The inspect/compose replacement is a new deck; it does not queue behind the previous tab animation | Replace deck instantly |

### Phone ghost viewfinder

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Two-finger pan snaps the Write-mode ghost between page halves | transform (`--phone-ghost-shift`) | current percent | 50% (start) or 0% (end) | fast after release; none while dragging | standard | none | A new pan replaces the live percent; pinch restores the committed stop | Snap instantly |

### Async control

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Button or icon-button `loading` | overlay spinner opacity | 0 | 1; control size unchanged (`visibility: hidden` on label/icon) | fast | standard | none | A second press is ignored while `aria-busy`; spinner stays until loading ends | Keep the overlay spinner; do not resize the control |

### Isometric icon

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Pointer hover/press on a Marks icon | transform via `--icon-tilt-*` / `--icon-press` | rest | tilt toward pointer; press translates down | fast | out | none | Leave and pointer-up reverse from computed variables; no queue | Resting tile, no tilt |

### Status pulse

| Trigger | Property | Start | End | Duration | Easing | Delay/stagger | Interruption | Reduced-motion replacement |
|---|---|---|---|---|---|---|---|---|
| Bounded connecting/busy status begins | opacity, transform | 1; scale 1 | 0.45; scale 0.92; return | deliberate, repeating | standard | none | Stop immediately when status resolves; status changes never queue cycles | Static status dot at full opacity |
