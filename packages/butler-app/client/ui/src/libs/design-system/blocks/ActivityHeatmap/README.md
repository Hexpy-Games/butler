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
Pass normalized day items with stable ids, labels, and counts. Let the component calculate relative intensity.

## Who can use this component
Any Butler client surface that needs a non-interactive activity density preview.

## Best practice
Keep labels date-specific and pair the heatmap with a nearby section title.

## Wrong use cases
Do not use it for interactive calendars or timelines. Use a table, chart, or list when exact comparison is required.

## Tags
dashboard, activity, density, heatmap, responsive
