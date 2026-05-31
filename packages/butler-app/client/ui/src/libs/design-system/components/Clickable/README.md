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

## Who can use this component
Product engineers and agents can use it when composing interactive rows. Design-system maintainers own its keyboard and accessibility contract.

## Best practice
- Prefer native `Button` when the control does not contain nested interactive children.
- Keep `Clickable` content visually row-like, not form-submit-like.
- Ensure nested controls stop event propagation when they should not activate the row.

## Wrong use cases
- Do not use `Clickable` for form submission; use `Button`.
- Do not use it just to avoid styling a button; use `Button variant="borderless"` or `PillButton`.
- Do not put large workflows inside a clickable row.

## Tags
clickable, role-button, nested-action, sidebar, row
