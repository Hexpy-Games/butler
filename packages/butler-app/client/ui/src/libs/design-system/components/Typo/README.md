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
| `lineClamp` | `2`, `3`, `4`, `5` | Clamp to that many lines; `5` is the message-length clamp (a user message before Show more). |
| `wrap` | `normal`, `nowrap`, `anywhere`, `pre` | `anywhere` lets long tokens (URLs, paths) wrap; Korean still keeps words whole. `pre` keeps typed line breaks and wraps long tokens anywhere (user messages, logs). |
| `numeric` | `tabular` | Tabular numerals for clocks, counts and columns. |
| `literal` | `boolean` | The text is an exact value (a command, path, URL, an approval or confirmation line): draws its own characters. Pretendard otherwise draws `2876x6` as `2876×6` and `->`, `=>`, `<-` as arrows, through the same substitutions in `calt` and `clig`; `literal` sets `font-variant-ligatures: none`. Prose keeps them. |

`Typo.Text` (default `span`) inherits the container's size, weight and
line-height and only applies text props. Use it for text inside blocks that own
the type scale (NavRow labels, message footers, pill buttons):

```tsx
<NavRow label={<Typo.Text lineClamp={2} wrap="anywhere">{title}</Typo.Text>} />
<Typo.Text as="time" dateTime={iso} numeric="tabular">{formatClock(date, locale)}</Typo.Text>
<Typo.Caption tone="secondary" truncate literal>{path}</Typo.Caption>
```

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Text box (cap to baseline)
Every block-level Typo (paragraphs, headings, and any Typo that is a flex or
grid item) is trimmed to cap height and the alphabetic baseline and padded
back by `(1lh - 1cap) / 2` on both sides (`text-box: trim-both cap
alphabetic`, under `@supports`). Each line keeps the role's integer
line-height, and the box centre is the centre of the letters in every
renderer, so icons beside text line up without per-component offsets.
Inline Typo inside running text is unaffected. Renderers without `text-box`
keep plain line boxes.

Only text is trimmed: Typo sets `data-trim` when its children are
strings and text-level elements (`strong`, `a`, `code`, …). A Typo that holds a
box (an icon, a Tag, an `Inline` row) keeps a plain line box, because the trim
cannot cut the box and its padding would be added on top. For the same reason
a Typo must stay a block container: never give it `display: flex` or `grid`
through a class (the trim does not reach a flex container's text). Put the row
on a wrapper and the Typo inside it.

Not trimmed: line-clamped Typo (`lineClamp`), because the trim cuts the last
formatted line, which the clamp hides, and the next line would show below the
clamp. Inputs, textareas, the composer editor and Markdown/code blocks are
not Typo and keep plain line boxes, so caret placement and code layout do not
change.

## Programmatic heading focus

Headings with `tabIndex={-1}` may receive focus to announce a screen change.
They show no outline or focus ring, like the Dialog content focus target.
Interactive controls retain the keyboard focus ring from the Focus foundation.

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
typography, text, semantic, tone, truncate, line-clamp, tabular-numbers, literal, ligatures
