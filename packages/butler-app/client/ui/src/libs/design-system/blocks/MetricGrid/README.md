# MetricGrid

## What is this block

MetricGrid is a Butler design-system block for laying out multiple MetricCards in a responsive grid.

## When to use this block

Use MetricGrid to display dashboard stats, project analytics, or multiple related metrics in a grid layout.

## Container vs Presenter

**MetricGrid is a presenter block.** It owns grid layout only. It must not import Butler metrics or calculation logic.

**Container responsibilities:** Domain components fetch and format metrics, then pass MetricCard children.

## Similar blocks

- Use **Grid** primitive for non-metric grid layouts
- Use **Stack** for vertical metric stacking
- Compose with **MetricCard** for individual metrics

## Usage

```tsx
import { MetricGrid, MetricCard } from "@/butler-ds";

<MetricGrid>
  <MetricCard value={sessions} label="Sessions" />
  <MetricCard value={tokens} label="Tokens" />
  <MetricCard value={projects} label="Projects" />
</MetricGrid>
```

## Accessibility

- Standard grid layout
- Children provide semantics
- Responsive reflow

## Responsive behavior

- Auto-fills columns based on width
- Minimum 200px per column
- Stacks on narrow viewports

## Wrong use cases

- Do not use for non-metric content
- Do not use when vertical Stack is clearer
- Do not force too many columns on mobile

## Tags

metric, grid, layout, dashboard, responsive
