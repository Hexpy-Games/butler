# ResourceTile

## What is this block

ResourceTile is a Butler design-system block for displaying resources like projects, documents, or folders in a card/tile format. It composes the shared `Card` primitive with `ResourceSummary`.

## When to use this block

Use ResourceTile for project galleries, document grids, folder browsers, or any grid-based resource display.

## Container vs Presenter

**ResourceTile is a presenter block.** It owns tile layout and visual styling. It must not import Butler domain data or stores.

**Container responsibilities:** Domain components fetch resources, format metadata, and compose tiles in Grid layouts.

## Similar blocks

- Use **CardListItem** for list-based management rows
- Use **ResourceSummary** inside another card container when the surface is already owned
- Use **MetricCard** for numeric metrics, not resources
- Use **NavRow** for navigation items

## Usage

```tsx
import { ResourceTile } from "@/butler-ds";

<Grid>
  <ResourceTile
    icon={<Folder />}
    title="Project Alpha"
    description="AI assistant"
    meta="12 sessions"
  />
</Grid>
```

## Accessibility

- Semantic text hierarchy
- Icon is decorative
- Title supports multi-line truncation

## Responsive behavior

- Works in Grid layouts
- Title truncates to 2 lines
- Adapts to tile width

## Wrong use cases

- Do not use for list layouts; use ListRow
- Do not use for navigation; use NavRow
- Do not use when simple text list suffices

## Tags

tile, card, resource, grid, project
