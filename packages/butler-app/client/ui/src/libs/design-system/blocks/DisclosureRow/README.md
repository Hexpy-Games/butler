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
A disclosure chevron never leads a title: a chevron column before the title
pushes every row's content one column right. When a row has one, it sits
directly right of the title text (after any count), beside the text, never
at the far edge, and turns 90° down when the row opens.

| `affordance` | Cue | Use |
| --- | --- | --- |
| `trailing` (default) | Chevron right after the title (and count) | Tool calls, changed files, source details, log lists, settings. |
| `none` | No glyph; the row itself is the button | Trace steps (with a SpanBar in `bar`). |

A row shows a chevron only when it has hidden content: children, a `count`
above 0, or `reveals` (it opens content outside the row, such as sibling
settings sections; pair it with `controlsId`). A row with nothing to reveal
is static: plain text, no chevron, no hover fill, not focusable, the same
columns as its interactive neighbours. A row with content is one button
with `aria-expanded`.

### Title extras and the bar line
- `count`: a muted number after the title, "턴 실행 (8)": the direct child
  rows the caller shows while the row is open. A count above 0 makes the
  row interactive even without children.
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
Icon, title, chevron and metadata share the first title line; the chevron
follows the title text and only the title truncates, so the chevron never
leaves its side. Descriptions wrap below the title; expanded content starts
at the title's left edge, with or without an icon.

## Geometry (owner-approved; do not change without DS approval)
- The title line is vertically centred in the trigger and its hover/open
  fill on both surfaces, including plain rows where Clickable's minimum
  height is taller than one line (`align-content: center`).
- No chevron column: the first line is [icon] title [count] [chevron], then
  meta at the end. The chevron is `--space-xs` after the title text and as
  tall as the title line.
- Plain rows: the title sits on the card's content edge, aligned with the
  labels of neighbouring cards; the hover fill bleeds like every clickable
  row in a card (`Clickable bleed="inline"`, 10px) past it on both sides.
  A card holding plain rows keeps a content inset of at least that bleed
  plus `--focus-ring-room`. Static plain rows have no fill and no bleed.
- Selection rows: the trigger is inset by `--space-sm` inside its fill.
- Every row draws its focus ring inside the fill.
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
