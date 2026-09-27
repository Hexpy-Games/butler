# SegmentedControl

## What is this component
SegmentedControl is a compact single-choice radiogroup for a secondary choice inside a page: a period (7/30/90 days), a dataset (Work/Task) or a view mode (Types/Changes).

## Props

| Prop | Values |
| --- | --- |
| `options` | `{ value, label, disabled? }[]` |
| `value`, `onValueChange` | controlled selection |
| `ariaLabel` | accessible group name |
| `size` | `default` (28px items), `sm` (24px items) |

## How to use this component

```tsx
import { SegmentedControl } from "@/butler-ds";

<SegmentedControl ariaLabel={copy.period} value={period} onValueChange={setPeriod}
  options={[{ value: "7", label: copy.days(7) }, { value: "30", label: copy.days(30) }]} />
```

## Accessibility
- `role="radiogroup"` with `role="radio"` buttons and `aria-checked`.
- Roving focus: only the selected option is in the tab order; arrow keys, Home and End move and select.

## Best practice
- Use `Tabs` (preferably `variant="line"`) for the page's primary navigation between panels, and SegmentedControl for choices that change what the current panel shows. A screen shows at most one tab bar.

## Wrong use cases
- Do not use it for navigation between routes or panels; use Tabs.
- Do not use it for more than about five options; use Select.

## Tags
input, choice, radiogroup, filter, period
