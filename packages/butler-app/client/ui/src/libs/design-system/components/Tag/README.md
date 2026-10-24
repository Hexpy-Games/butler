# Tag

## What is this component
Tag is a compact pill for a status, mode or category label, with an optional leading icon and an optional remove button.
Status tones mean a state; label tones are categorical colors for a user's own labels.

## Props

| Prop | Values |
| --- | --- |
| `tone` | Status: `neutral` (default), `accent`, `success`, `warning`, `danger`. Label: `gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple` (`tagLabelTones`) |
| `size` | `sm` (default; 22px tall, 8px inline padding) for inline chips, `md` (24px, 10px) for page eyebrows and hero labels |
| `icon` | Leading icon, sized to `--icon-size-xs` |
| `iconEnd` | Trailing icon, sized to `--icon-size-xs`, tight to the label: a chevron when the Tag is the visible cue of a larger control that opens more (`+4 ›`). Ignored with `onRemove` |
| `onRemove`, `removeLabel` | Trailing remove button inside the pill; `removeLabel` names it |

## How to use this component

```tsx
import { ChevronRight, ListChecks, Tag } from "@/butler-ds";

<Tag tone="success">Done</Tag>
<Tag icon={<ListChecks size="xs" />} onRemove={exitPlanMode} removeLabel="Exit plan mode">Plan</Tag>
<Tag iconEnd={<ChevronRight size="xs" />}>+4</Tag>
<Tag tone="teal">design</Tag>
```

## Label tones
Each label tone reads `--tag-label-<tone>-bg|fg|border` (tokens.css): an
opaque fill from the palette ramps, light and dark, with text at 4.5:1 or more
on its fill, so wallpapers and glass behind never change it. Store the tone
name, never a color value. Pick one with `TagColorSwatches`.

## Wrong use cases
- Do not build a styled `span` pill in product code; use Tag.
- Do not use a label tone for a status (a red label is not an error).
- Do not use Tag as a button; use `PillButton` for actions. A Tag with
  `iconEnd` may sit inside a larger control (WorkActivityDisclosure) as its
  count cue; the control acts and names itself, the Tag does not.

## Tags
tag, badge, chip, tone
