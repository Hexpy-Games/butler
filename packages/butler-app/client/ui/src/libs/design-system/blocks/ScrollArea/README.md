# ScrollArea

ScrollArea provides the shared Butler scrollbar treatment for bounded internal
scroll regions.

Use it for document panes, short panel lists, and other app surfaces that need
to match the sidebar scrollbar behavior without owning product-specific CSS.

## Example

```tsx
import { ScrollArea } from "@/butler-ds";

<ScrollArea maxHeight="sm">
  <DocumentList />
</ScrollArea>
```

`maxHeight` caps the area (`xs` 180px, `sm` 320px); `minHeight="xs"` keeps a
96px floor when the content is short (the inspector context legend); `fill`
takes the free space in a flex column. There is no `UNSAFE_style`.

## Edge Fade

The scroller opts into the shared scroll-fade primitive (`useScrollEdges` plus
`scroll-fade.css`). An edge fades only while content is clipped there: no fade
at a resting edge and none when content fits. Pass `orientation="x"` for a
horizontal scroller; the fade follows the scrolling axis.

## Boundaries

- Do not use it as the primary page layout shell.
- Keep domain data fetching and list state in product components.
