# SegmentedControl

## What is this component
SegmentedControl is a compact single-choice radiogroup for a secondary choice inside a page: a period (7/30/90 days), a dataset (Work/Task), a view mode (Types/Changes) or a list filter (All/Recent/Running).

It is flat: a hairline `--line` border on `--surface`, and the selected option is a `--selection` fill. There is no raised thumb and no shadow; the track matches the default `Tabs` list.

## Props

| Prop | Values |
| --- | --- |
| `options` | `{ value, label, icon?, disabled? }[]`; `icon` is a leading glyph that supports the label |
| `value`, `onValueChange` | controlled selection |
| `ariaLabel` | accessible group name |
| `size` | `default` (30px options inset 4px: a 40px track), `sm` (24px options inset 2px: a 28px track, `--control-height-sm`); on touch and at phone width each default option is 44px tall |
| `stretch` | fill the container's width; the options share it equally |

## How to use this component

```tsx
import { SegmentedControl } from "@/butler-ds";

<SegmentedControl ariaLabel={copy.period} value={period} onValueChange={setPeriod}
  options={[{ value: "7", label: copy.days(7) }, { value: "30", label: copy.days(30) }]} />
```

```tsx
<SegmentedControl stretch ariaLabel={copy.views} value={view} onValueChange={setView}
  options={[{ value: "all", label: copy.all, icon: <ListFilter /> }, { value: "recent", label: copy.recent, icon: <Clock3 /> }]} />
```

## Accessibility
- `role="radiogroup"` with `role="radio"` buttons and `aria-checked`.
- Roving focus: only the selected option is in the tab order; arrow keys, Home and End move and select.
- The focused option shows the shared focus ring; the track's inset keeps the ring whole inside the scrolling track.

## Best practice
- Use `Tabs` (preferably `variant="line"`) for the page's primary navigation between panels, and SegmentedControl for choices that change what the current panel shows. A screen shows at most one tab bar.

## Wrong use cases
- Do not use it for navigation between routes or panels; use Tabs.
- Do not use it for more than about five options; use Select.

## Tags
input, choice, radiogroup, filter, period
