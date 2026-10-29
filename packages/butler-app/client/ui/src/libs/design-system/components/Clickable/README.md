# Clickable

## What is this component
Clickable is a non-button element with `role="button"` and keyboard activation behavior.

## When to use this component
Use it when a clickable container must contain another interactive element and a native `<button>` would create invalid nested button markup.

## Where to use this component
Use it in domain rows such as sidebar items, list items, cards, or command rows that have their own trailing action buttons.

## Why to use this component
It avoids invalid `<button>` inside `<button>` DOM while preserving keyboard activation and accessible button semantics.

## How to use this component
Import from the public design-system alias:

```tsx
import { Clickable } from "@/butler-ds";
```

Provide an accessible label when the visible content is not plain text.

Nested icon controls retain compact defaults. A row can declare
`--clickable-action-size` and `--clickable-action-icon-size` to preserve its own
touch-target and icon-slot sizing instead. Set the icon size on the nearest
control when leading identity icons differ from trailing action icons.

Opt-in row options, all off by default:

- `bleed="inline"` pulls the row into its container's gutter by its own inline
  padding (and grows a `stretch` row by the same amount), so the row's text
  lines up with sibling content and the card's content edge while the hover
  and selected fills extend into the gutter. Use it inside a padded surface
  such as a settings card; the focus ring stays inside the card padding.
- `bleed="block"` lets the hover and selected fills reach `--space-xs` above
  and below the content. The row takes the same space as without it, so its
  text and the rows around it stay where they were; only the fill (and the
  focus ring around it) grows. Keep at least `--space-xs` plus
  `--focus-ring-room` between the row and its neighbours or a clipping edge.
  `bleed="both"` applies the inline and block bleed together, as inline-edit
  fields do.
- `selected` makes the row a toggle: it sets `aria-pressed` (while the role is
  `button`), a lighter hover, and the `--selection-strong` fill when `true`.

```tsx
<Clickable bleed="inline" stretch selected={active} onClick={toggle}>
  <ListRow title="Release checklist" meta="412K" />
</Clickable>

<Clickable bleed="both" stretch aria-label="Edit description" onClick={edit}>
  <Typo.Body>Collect the changes and review the release notes.</Typo.Body>
</Clickable>
```

Motion: every row's hover and selected fills fade in and out on
`--motion-fast` (`--motion-ease-standard`); the pressed fill and the compact
press scale land on `--motion-instant`. With reduced motion
(`prefers-reduced-motion: reduce`) the fills change at once. The text variant
keeps its own color fade.

## Who can use this component
Product engineers and agents can use it when composing interactive rows. Design-system maintainers own its keyboard and accessibility contract.

## Best practice
- Prefer native `Button` when the control does not contain nested interactive children.
- Keep `Clickable` content visually row-like, not form-submit-like.
- Ensure nested controls stop event propagation when they should not activate the row.
- A row never grows past its container: its children may shrink and icons keep their size. Give a text label `<Typo.Text truncate>` (or use `ListRow`) so it ends in an ellipsis.

## Wrong use cases
- Do not use `Clickable` for form submission; use `Button`.
- Do not use it just to avoid styling a button; use `Button variant="borderless"` or `PillButton`.
- Do not put large workflows inside a clickable row.

## Tags
clickable, role-button, nested-action, sidebar, row, toggle, bleed
