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
Pass consecutive days with stable ids, localized labels and counts (`null` for unavailable). Supply `startWeekday` (Sunday = 0) and seven localized `weekdayLabels`. Days run down seven rows, then into the next week. Supply each day's `monthLabel` for the horizontal month axis and `countLabel` for a localized count with units. Fixed intensity bands: 0, 1, 2–4, 5–9, 10+. Pass `legend` with six localized labels (five count bands then unavailable) and an optional title; omit the title when surrounding copy already explains the metric. The swatches share cell styling so colors cannot drift. Pass `onSelect` and `selectedId` for date drilldown; the caller owns source lists, explanatory copy and metric semantics.

## Who can use this component
Any Butler client surface that needs activity density or date drilldown.

## Best practice
Keep labels date-specific and pair the heatmap with a nearby section title.

## Wrong use cases
Do not use it for scheduling calendar events. Use a table, chart, or list when exact comparison is required. Cells retain 24px targets and 16px visual squares; long periods scroll within the component. Unknown days have a dashed border, distinct from zero activity.

## Tags
dashboard, activity, density, heatmap, responsive
