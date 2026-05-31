# Separator

## What is this component
Separator is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Separator when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Separator } from "@/butler-ds";
```

Use `line={false}` when the interface only needs tokenized whitespace. Use
`orientation="vertical"` for inline toolbar or breadcrumb separation. Use
`tone="default" | "strong" | "muted" | "accent"` to select the semantic line
color, and `space="none" | "xs" | "sm" | "md" | "lg"` to control the occupied
spacing around the center line.

Prefer token-backed spacing and responsive composition. Validate the fixture in the design-system workbench before using it in a domain flow.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Separator as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not use Separator as a generic layout stack gap when the surrounding `Stack`
  or `Grid` can express the spacing directly; use `Space` or layout `gap`
  instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
layout, structure, density
