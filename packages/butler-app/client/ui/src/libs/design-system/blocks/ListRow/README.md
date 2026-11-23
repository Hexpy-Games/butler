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
- Use **DocumentTile** for card-like resource displays
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

- Title truncates with ellipsis only when the title alone exceeds the available width
- A short `Tag` in the `tag` slot follows the title and moves below it when they exceed the available width
- Meta sits right-aligned beside the title and any tag when all three fit at their full widths
- Otherwise meta moves to its own left-aligned line below the title and any tag, where it can wrap
- The rule follows the row's own width (flex wrap), not the viewport, so it holds in panels, inspectors and phone layouts alike
- Description wraps

## Wrong use cases

- Do not use for clickable navigation; use NavRow
- Do not use for metrics; use MetricCard
- Do not use for complex nested content

## Tags

list, row, item, document, file
