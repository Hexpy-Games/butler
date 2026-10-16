# Tooltip

## What is this component
Tooltip is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Tooltip when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Tooltip } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

### Placement

`side` (`top` | `right` | `bottom` | `left`, default `top`) picks the side of
the trigger; `align` (`start` | `center` | `end`, default `center`) lines the
tooltip up with the trigger's start edge, center or end edge along that side.

```tsx
<Tooltip label={copy.unavailable} side="right">
  <SelectTrigger id={id} disabled>…</SelectTrigger>
</Tooltip>
```

- When the side has no room, the tooltip flips to the opposite side, then to
  the cross sides, and else takes the side with the most room. It then shifts
  to stay 12px inside the viewport and below the titlebar safe area.
- Pick the side that covers nothing the reader needs. Icon-button names stay
  `top`. A disabled reason on a control that sits under or after its label and
  description opens `right` (Switch `disabledReason` does this by default).
- When the trigger scrolls out of its scroll container, the tooltip hides.
- `open` controls visibility (documentation and the DS Viewer); product code
  leaves it unset so hover and keyboard focus drive it.
- Motion: it enters from the trigger's side on `--motion-enter-menu` and
  `--motion-distance-sm`, and fades out on `--motion-exit-fast`. Reduced
  motion zeroes the travel through the tokens.

Controls that show a disabled reason pass placement through:
`Switch`, `CheckCard`, `OptionMenuItem` and `ComposerSendButton` take
`disabledReasonSide` and `disabledReasonAlign`.

### Touch

Tooltips open on hover and keyboard focus only; a tap on a phone does not
open one yet. Never put the only copy of something people need in a tooltip.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Tooltip as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
help, hover, accessibility, placement
