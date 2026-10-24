# Popover

## What is this component
Popover is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Popover when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Popover } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

## Width
`PopoverContent width="narrow"` sets `min(280px, 100vw - 32px)` for compact
readouts (the composer context and usage popover). The default is 18rem.
`width="anchor"` makes the content exactly as wide as its `PopoverAnchor` (or
trigger) at every viewport, capped by the viewport: a suggestion list under its
field. `density="list"` drops the gap and uses a 4px inset for lists whose rows
carry their own padding (`SuggestionList`).

## Mobile sheet
At 640px and narrower every popover except `width="anchor"` becomes a sheet:
the screen width minus `--popover-sheet-gutter` (8px) on each side and the
side safe areas, whatever its content, so selections never resize it. It stays
attached above or below its trigger; `side="left"` or `"right"` opens below.
Height is capped to the space Radix reports on that side (and the viewport
minus the titlebar and bottom safe area); taller content scrolls inside with
`overscroll-behavior: contain`. It opens with an 8px slide along its side and a
fade (`--motion-enter-overlay`) and closes with a 4px slide and fade
(`--motion-exit-fast`), without scale; reduced motion keeps only the fade.

## Presentation
`presentation="auto"` opens the content as a `BottomSheet` below 768px and
anchored above; `"sheet"` always opens a sheet; `"popover"` (the app-wide
default, `DEFAULT_OVERLAY_PRESENTATION`) stays anchored. A sheet keeps the
same items, keyboard and dismissal. `width="anchor"` stays attached unless
it asks for a sheet. See `BottomSheet`.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Popover as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
overlay, contextual, disclosure
