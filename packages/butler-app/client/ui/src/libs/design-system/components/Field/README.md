# Field

## What is this component
Field is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Field when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Field } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Switch fields: stacked by default, row as the exception
A switch field is laid out like an input: `FieldLabel`, then
`FieldDescription`, then the `Switch` underneath, left-aligned (the default
vertical `Field`). Every desktop settings field and form uses it.

The row layout, `orientation="horizontal"` with `FieldContent` first and the
control after it, puts the label and the switch on one row with the switch at
the row end and the description under the label; the control centers on the
label's line. Use it only on a phone layout or for a list item inside a
closed container (a card, a list row) where the width has to be used. Never
put the switch before its label.

## Wrong use cases
- Do not use Field as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Responsive labels

Vertical Field places its label above the control. FieldLabel stays within the
content width and wraps even long unbroken labels rather than clipping them or
shrinking the control beside them.

## Tags
form, layout, validation
