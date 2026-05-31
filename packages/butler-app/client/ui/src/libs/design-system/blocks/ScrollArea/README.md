# ScrollArea

ScrollArea provides the shared Butler scrollbar treatment for bounded internal
scroll regions.

Use it for document panes, short panel lists, and other app surfaces that need
to match the sidebar scrollbar behavior without owning product-specific CSS.

## Example

```tsx
import { ScrollArea } from "@/butler-ds";

<ScrollArea style={{ height: "16rem" }}>
  <DocumentList />
</ScrollArea>
```

## Boundaries

- Do not use it as the primary page layout shell.
- Keep domain data fetching and list state in product components.
