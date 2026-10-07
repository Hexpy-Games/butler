# ProgressRing

## What is this component
ProgressRing is a non-interactive ring that shows progress in an icon-sized
square: a determinate fill from 0 to 1, or, while indeterminate, the DS
`Spinner` itself in the same square (no layout shift when it switches). The
ring is the one ContextDonutButton draws (r 8 in a 20-unit box, round cap,
`--context-track-bg` track), without the button. Strokes land near 2px at the
fixed sizes and 1.5px at 16px for `sidebar` (the row's line-icon weight).

## Props
| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `value` | `number` | `0` | Completed fraction 0-1, clamped. Ignored while indeterminate. |
| `indeterminate` | `boolean` | `false` | Renders the DS `Spinner` (its motion and reduced-motion rules; `currentColor`, no track, tone not applied). No `aria-valuenow`. |
| `size` | `"xs" \| "sm" \| "md" \| "lg" \| "sidebar"` | `"md"` | `--icon-size-*` (12/14/16/20px); `sidebar` follows `--sidebar-icon-size` like `IconSlot size="sidebar"`. |
| `tone` | `"default" \| "success" \| "warning" \| "danger"` | `"default"` | Fill: `--accent`, `--color-success`, `--color-warning`, `--color-danger`. |
| `aria-label`, `aria-valuetext` | `string` | – | Name of the progressbar. |
| `aria-hidden` | `boolean` | – | Decorative inside a control or row that already carries the name: no role, no value attributes. |

## When to use this component
Progress in an icon slot: the sidebar update row, a status line, a list row
glyph. Use it when the fraction may be unknown at first (`indeterminate`) and
becomes known later; the box never changes size.

## Why to use this component
It keeps ring geometry, stroke weight per size, tones and motion in the DS.
The value is one inline custom property, so a change is a single
`stroke-dashoffset` transition with no per-frame JS.

## Best practice
- In a `NavRow`, pass `size="sidebar"` and `aria-hidden`, and put the percent in
  the row's `badge` and `ariaLabel`.
- Switch to `tone="success"` when complete; show a status icon instead of a
  ring for a failure that has no progress to show.

## Wrong use cases
- A labelled bar with room for a row: `ProgressMeter`.
- Busy with no progress to report: `Spinner`.
- The composer context trigger: `ContextDonutButton` (it composes this ring).

## Tags
progress, ring, donut, download, update, indeterminate, sidebar
