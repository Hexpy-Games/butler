# ActivityHeatmap

## What is this component
ActivityHeatmap renders compact day-by-day activity density.

## When to use this component
Use it for dashboard summaries where the user needs a fast visual read of recent frequency.

## Where to use this component
Use it inside dashboard and inspector panels that already provide the section title and surrounding context.

## Why to use this component
It keeps activity color, spacing, and responsive grid behavior owned by the design system instead of product CSS.

## How to use this component
Pass consecutive days with stable ids, localized labels and counts (`null` for unavailable). `startWeekday` is the row of the first day (0 = the first weekday label); start `days` on the week start to get full columns. Supply seven localized `weekdayLabels` in row order; they stay pinned beside the horizontal scroller. Days run down seven rows, then into the next week. Supply each day's `monthLabel` for the horizontal month axis (months with fewer than three visible weeks drop their name) and `countLabel` for a localized count with units; the cell tooltip and accessible name read `label · countLabel`. Fixed intensity bands: 0, 1, 2–4, 5–9, 10+. Set a day's `level` (0–4) to replace the bands with a shade the screen computes, for example a data-relative scale or a bar chart drawn on the grid (level 0 or 3 per cell). Shades are the blue ramp: light `--blue-02/04/06/08`, dark `--blue-08/06/04/02`, empty `--selection`.

`cell="compact"` draws 10px cells with a 3px gap for a year at a glance (pass blank weekday labels for alternate rows); the default keeps 24px targets. `scrollAnchor="end"` opens scrolled to the latest week. When levels change, each cell eases over `--motion-base` in a wave (column × 4ms + (6 − row) × 18ms, about 480ms for a year), retargeting cleanly mid-wave; reduced motion makes it instant. Cells are one roving tab stop: arrow keys move by day and week, and the DS Tooltip shows on hover and keyboard focus. Pass `legend` with six localized labels (five count bands then unavailable) and an optional title; omit the title when surrounding copy already explains the metric. The swatches share cell styling so colors cannot drift. Pass `onSelect` and `selectedId` for date drilldown; the caller owns source lists, explanatory copy and metric semantics.

## Who can use this component
Any Butler client surface that needs activity density or date drilldown.

## Best practice
Keep labels date-specific and pair the heatmap with a nearby section title.

## Wrong use cases
Do not use it for scheduling calendar events. Use a table, chart, or list when exact comparison is required. Default cells retain 24px targets and 16px visual squares; long periods scroll within the component with edge fades. Under a larger App text size (큰 글자) the cells shrink to fit the weeks, staying square, but never below their on-screen size at 100%, so the zoom alone does not push weeks out of view. Unknown days have a dashed border, distinct from zero activity.

## Tags
dashboard, activity, density, heatmap, responsive
