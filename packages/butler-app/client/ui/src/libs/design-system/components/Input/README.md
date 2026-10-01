# Input

## What is this component
Input is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Input when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Input } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

`compact` makes a short inline field (5.5rem, small control height; the
touch target still applies on coarse pointers) for a number in a toolbar,
such as the Worker profiles header's max simultaneous Workers.

`variant="default"` is the boxed field. `variant="underline"` is an in-place
field with a single token bottom border, transparent background, no radius and
zero horizontal padding. Typography and touch targets match the default.
Hover uses `--line-strong`; focus uses `--focus-ring-color`; invalid uses
`--color-danger-border`. Disabled keeps a quiet line and disabled text;
read-only uses secondary text and remains selectable and keyboard focusable.
There is no transition, so reduced motion is respected without an override.

Keyboard focus follows the focus foundation's clipping-container rule: use an
inset `--focus-ring-width` / `--focus-ring-color` outline rather than an outer
shadow. The full ring stays inside the field in scroll containers. It appears
only for `:focus-visible`; the resting field has only the bottom border.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Input as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
form, text-entry, control
