# ActivityStrip

## What is this component
A thin strip with one cell per day; active days are filled with `--context-chart-1`.

## When to use this component
Use it under a list row to show on which days something changed in a short window.

## Where to use this component
Dashboard statistics and activity lists.

## Why to use this component
It replaces per-screen CSS for small day strips.

## How to use this component
`<ActivityStrip days={[{ key, label, active }]} ariaLabel="Sep 24, Sep 26" />`

## Who can use this component
Dashboard and statistics components.

## Best practice
Keep the window short (a week or two); use `ActivityHeatmap` for longer ranges.

## Wrong use cases
Do not use it for progress. Use `ProgressMeter`.

## Tags
activity, days, timeline, sparkline
