# Tag

## What is this component
Tag is a compact pill for a status, mode or category label, with an optional leading icon and an optional remove button.

## Props

| Prop | Values |
| --- | --- |
| `tone` | `neutral` (default), `accent`, `success`, `warning`, `danger` |
| `icon` | Leading icon, sized to `--icon-size-xs` |
| `onRemove`, `removeLabel` | Trailing remove button inside the pill; `removeLabel` names it |

## How to use this component

```tsx
import { ListChecks, Tag } from "@/butler-ds";

<Tag tone="success">Done</Tag>
<Tag icon={<ListChecks size="xs" />} onRemove={exitPlanMode} removeLabel="Exit plan mode">Plan</Tag>
```

## Wrong use cases
- Do not build a styled `span` pill in product code; use Tag.
- Do not use Tag as a button; use `PillButton` for actions.

## Tags
tag, badge, chip, tone
