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

## Scrollbar Lane

The frame bleeds a scrollbar lane past the content's inline end. An overlay
scrollbar takes no layout width, so the content gives the lane back and the
scrollbar floats in it; a classic (always-shown) scrollbar is its own lane, so
nothing more is reserved. The first ScrollArea in a document measures the thin
scrollbar once and publishes it as `--scrollbar-width` on the root (`0px` for
overlay scrollbars); nothing runs while idle or on scroll.

## Focus Rings

The frame keeps `--focus-ring-room` of paint room on every edge (it bleeds past
the content's inline start, and across on the block edges, and the content pads
it back), so a row flush with the content edge shows its whole ring and nothing
moves. Keyboard focus scrolls a control clear of an active fade, ring included,
and while a ring shows inside, each fade turns solid `--focus-ring-room` sooner:
a control resting at an edge keeps its whole ring even on the frame where the
fade still lags the scroll. Nothing changes while nothing inside has focus.

## Boundaries

- Do not use it as the primary page layout shell.
- Keep domain data fetching and list state in product components.
