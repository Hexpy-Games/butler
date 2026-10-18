# DisclosureRow

## What is this component
A row that can reveal detail content below it.

## When to use this component
Use it for tool calls, worker steps, collapsible facts, or audit entries.

## Where to use this component
Use it in conversation activity, inspectors, and detail panels.

## Why to use this component
It standardizes nested-button-safe disclosure behavior with `Clickable`.

## How to use this component
Keep expansion state in the caller and pass `open`, `onToggle`, and children.

### Affordance (where the open cue sits)
| `affordance` | Cue | Use |
| --- | --- | --- |
| `leading` (default) | Chevron column before the title (right / down) | Tool calls, changed files, source details. |
| `trailing` | Chevron after the meta; turns 90° down when open | Log lists. The title starts at the row inset. |
| `none` | No glyph; the row itself is the button | Trace steps (with a SpanBar in `bar`). |

With `trailing` or `none`, a row with nothing to reveal (no children, no
`count`) is static: plain text, no hover fill, not focusable, the same
columns as its interactive neighbours. A row with content is one button
with `aria-expanded`.

### Title extras and the bar line
- `count`: a muted number after the title, "턴 실행 (8)": the direct child
  rows the caller shows while the row is open. A count above 0 makes a
  trailing or no-chevron row interactive even without children.
- `attention`: `error` (`--trace-error`) or `warning` (`--trace-wait`) dot
  before the title, on problem rows only. The meta or title must still say
  what happened.
- `bar`: a full-width line under the description for a SpanBar. Inside a
  `SpanRow indent="text"` only the text indents; the fill and the bar keep
  the full width, and rows deeper than 3 levels append the SpanRow's depth
  cue to the description.

## Who can use this component
Any container that owns expandable row state.

## Best practice
Icon, title, metadata and chevron share the first title baseline. Descriptions
wrap below the title; expanded content uses the same title inset, with or without
an icon.

## Geometry (owner-approved; do not change without DS approval)
- The title line is vertically centred in the trigger and its hover/open
  fill on both surfaces, including plain rows where Clickable's minimum
  height is taller than one line (`align-content: center`).
- Plain rows: the chevron sits on the card's content edge, aligned with the
  labels of neighbouring cards; the hover fill bleeds `--space-sm` past it
  on both sides.
- Selection rows: the trigger is inset by `--space-sm` inside its fill.
- Trailing and no-chevron rows: the title starts at the row inset; meta
  (and the trailing chevron, pulled `--space-xs` toward it) end the first
  line; the focus ring is drawn inside the fill.
- Review every change against the States matrix (each surface and content
  shape in default, hover, focus-visible and open) in light and dark.

Pass domain labels as text and keep block children presentational.
Use `surface="plain"` when the disclosure only controls a timeline or nested
detail region and must not turn the whole area into an active background block.

## Wrong use cases
Do not use it for sidebar hierarchy. Use `CollapsibleNavGroup`.

## Tags
disclosure, row, activity, details, log, trace, chevron

Long meta wraps within half the row, preserving space for the title at phone widths. Meta is complete; it is never truncated.
