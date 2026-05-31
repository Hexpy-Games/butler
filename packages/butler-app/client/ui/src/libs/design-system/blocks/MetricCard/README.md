# MetricCard

## What is this block

MetricCard is a Butler design-system block for displaying a single metric with value, label, trend, and optional change indicator.

## When to use this block

Use MetricCard in dashboards, project stats, analytics panels, or anywhere you need to display a key performance indicator.

## Container vs Presenter

**MetricCard is a presenter block.** It owns metric layout and trend styling. It must not import Butler analytics data or calculation logic.

**Container responsibilities:** Domain components fetch metrics, calculate trends, format values, and provide labels from app copy.

## Similar blocks

- Use **MetricGrid** to layout multiple MetricCards
- Use **Chart** for visual data comparison
- Use **Typo.MetricValue** alone for inline metrics

## Usage

```tsx
import { MetricCard } from "@/butler-ds";

<MetricCard
  value={sessionCount}
  label="Active Sessions"
  trend="up"
  change="+12%"
  icon={<TrendingUp />}
/>
```

## Accessibility

- Value uses MetricValue typography
- Label provides context
- Trend is visual only (not critical info)

## Responsive behavior

- Compact layout
- Works in grid or stack
- Mobile-friendly sizing

## Wrong use cases

- Do not use for non-numeric data displays
- Do not use when Chart is more appropriate
- Do not overload with too many metrics in one view

## Tags

metric, dashboard, analytics, kpi, stats
