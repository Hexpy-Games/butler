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

### Joined stat row

```tsx
<MetricGrid variant="joined">
  <MetricCard value="4.41B" label="Lifetime tokens" />
  <MetricCard value="300M" label="Busiest day" change="Sep 14" trend="neutral" />
</MetricGrid>
```

`variant="joined"` draws one card with hairline dividers. Tiles grow from a ~136px basis, so wrapped rows always fill: five tiles read 5, 3 + 2, 2 + 2 + 1 or one column as the width shrinks. Labels and captions stay on one line and truncate. Tiles are not interactive (the card clips to its corners). `columns` is ignored.

## Accessibility

- Standard grid layout
- Children provide semantics
- Responsive reflow

## Responsive behavior

- `cards`: auto-fills columns of at least 150px (or the `columns` preset)
- `joined`: tiles grow from ~136px and every row fills
- Stacks on narrow viewports

## Wrong use cases

- Do not use for non-metric content
- Do not use when vertical Stack is clearer
- Do not force too many columns on mobile

## Tags

metric, grid, layout, dashboard, responsive
