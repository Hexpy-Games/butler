# ListRow

## What is this block

ListRow is a Butler design-system block for displaying list items with icon, title, description, and metadata.

## When to use this block

Use ListRow for document lists, artifact lists, file browsers, or any non-navigation list of items with rich metadata.

## Container vs Presenter

**ListRow is a presenter block.** It owns list item layout. It must not import Butler domain data or stores.

**Container responsibilities:** Domain components fetch list data, format metadata, and provide item content.

## Similar blocks

- Use **NavRow** for navigation items with active state and click handling
- Use **ResourceTile** for card-like resource displays
- Use simple Stack for basic content lists

## Usage

```tsx
import { ListRow } from "@/butler-ds";

<ListRow
  icon={<FileText />}
  title="README.md"
  description="Project documentation"
  meta="Updated 2h ago"
/>
```

## Accessibility

- Semantic text hierarchy
- Icon is decorative (aria-hidden)
- Title is emphasized via font-weight

## Responsive behavior

- Title truncates with ellipsis
- Description wraps
- Meta text doesn't wrap

## Wrong use cases

- Do not use for clickable navigation; use NavRow
- Do not use for metrics; use MetricCard
- Do not use for complex nested content

## Tags

list, row, item, document, file
