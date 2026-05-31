# Pill Button

## What is this component
Pill Button is a borderless command button with fully rounded ends, matching Butler composer toolbar controls.

## When to use this component
Use it for compact toolbar commands, composer controls, mode selectors, and dense utility actions where a full rectangular button feels too heavy.

## Where to use this component
Use it in composer toolbars, compact filter bars, and low-risk mode controls.

## Why to use this component
It preserves Butler's half-round control language and avoids recreating composer-specific pill CSS in domain components.

## How to use this component
Import from the public design-system alias:

```tsx
import { PillButton } from "@/butler-ds";
```

Pass text and optionally an icon.

## Who can use this component
Product engineers, design-system maintainers, and agents can use it for compact Butler controls.

## Best practice
- Keep the label short.
- Pair unfamiliar icons with text.
- Use `IconButton` when there is no text label.

## Wrong use cases
- Do not use `PillButton` for primary irreversible actions; use `Button`.
- Do not use it for a clickable row; use `Clickable`.
- Do not add borders to it locally; use `Button variant="outline"` when a bordered control is needed.

## Tags
pill, composer, toolbar, borderless, action
