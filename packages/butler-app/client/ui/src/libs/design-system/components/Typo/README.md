# Typo

## What is this component
Typo is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Typo when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Typo } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

### Text props

Every variant accepts the same text props; none of them change the type scale:

| Prop | Values | Effect |
| --- | --- | --- |
| `tone` | `primary`, `secondary`, `tertiary`, `disabled`, `danger`, `success`, `warning`, `inherit` | Semantic text color token. Omit it to inherit the container color. |
| `weight` | `regular`, `medium`, `semibold` | `--font-weight-*` token. |
| `align` | `start`, `center`, `end` | Text alignment. |
| `truncate` | `boolean` | One line with an ellipsis; the element becomes a block with `min-width: 0`. |
| `lineClamp` | `2`, `3`, `4` | Clamp to that many lines. |
| `wrap` | `normal`, `nowrap`, `anywhere` | `anywhere` lets long tokens (URLs, paths) wrap; Korean still keeps words whole. |
| `numeric` | `tabular` | Tabular numerals for clocks, counts and columns. |

`Typo.Text` (default `span`) inherits the container's size, weight and
line-height and only applies text props. Use it for text inside blocks that own
the type scale (NavRow labels, message footers, pill buttons):

```tsx
<NavRow label={<Typo.Text lineClamp={2} wrap="anywhere">{title}</Typo.Text>} />
<Typo.Text as="time" dateTime={iso} numeric="tabular">{formatClock(date, locale)}</Typo.Text>
<Typo.Caption tone="secondary" truncate>{path}</Typo.Caption>
```

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Typo owns size, weight, line-height, letter spacing, and margin reset. Color is inherited from the parent unless a `tone` prop asks for a semantic text color.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Typo as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not hardcode text color inside Typo variants or through product `className`/`style`. Use `tone`, or leave it unset so nested text like work decision bodies inherits the owning surface color.
- Do not wrap text in a styled raw `span` for truncation, clamping, color or tabular numbers; use the text props (on `Typo.Text` when the container owns the size).
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
typography, text, semantic, tone, truncate, line-clamp, tabular-numbers
