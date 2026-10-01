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
zero horizontal padding. It inherits surrounding text metrics; `textSize="label"`
matches Typo.Label. Its one-line footprint stays stable on mobile; the enclosing
editable row must provide the touch target. Long values scroll within the input.
Hover uses `--line-strong`; focus uses `--focus-ring-color`; invalid uses
`--color-danger-border`. Disabled keeps a quiet line and disabled text;
read-only uses secondary text and remains selectable and keyboard focusable.
There is no transition, so reduced motion is respected without an override.

Keyboard focus is the bottom line only: `--focus-ring-width` thickens the
bottom border with `--focus-ring-color`, without a shadow or other-side outline.
Reserved thickness below the text keeps its baseline unchanged. The focus
foundation's shape-specific indicator rule allows a bottom line while retaining
token thickness (2px) and at least 3:1 contrast against adjacent surfaces.
The enclosing row must reserve space for the line inside clipping containers.

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
