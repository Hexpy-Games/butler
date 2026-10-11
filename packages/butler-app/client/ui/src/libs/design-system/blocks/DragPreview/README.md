# DragPreview

## What is this block
`DragPreview` is what follows the pointer while picked elements or a browser tab
are dragged: two stacked crops with a count, or the lifted tab, with a
no-entry badge over invalid targets. Lifted on `--shadow-drag-lift`.

Each crop sits whole on a neutral matte (`contain`): a wide heading is a strip
across the card, a tall column a strip down it; nothing is cut mid-glyph.

It renders static (a `setDragImage` source, a story) or **floating**: pass the
pointer as `at` on every move and it follows, just below and right of the tip
(the badge sits beside the cursor; the target under the tip stays visible), on
`--z-drag`, never taking the pointer. `strategy="fixed"` (default) takes
viewport pixels (`clientX`/`clientY`); `strategy="absolute"` takes the pixels of
a positioned layer such as the browser overlay. It lifts in once (dropped under
reduced motion); moves are a `translate`, so following costs no layout.

## When to use this block
Render it for `setDragImage`, or floating while the App draws a drag itself:
picks dragged to the chat, a conversation or the library, or a tab dragged to
the sidebar.

## Container vs Presenter
The App owns the drag and the pointer position; the target (`NavDropTarget`
`outside`, the composer) shows what a drop will do and decides `invalid`.

## Usage

```tsx
<DragPreview kind="elements" images={picks.map((pick) => ({ src: pick.crop }))} invalid={!canDrop} />

// Floating: follows the pointer over the window.
{drag ? <DragPreview kind="elements" images={drag.crops} count={drag.count} invalid={!drag.canDrop} at={drag.pointer} /> : null}
```

## Accessibility
Purely visual (`aria-hidden`); every drag has a menu path too.

## Responsive behavior
Fixed size; the caller positions the floating mode.

## Wrong use cases
- Do not put words in the preview; the drop label explains the drop.
- Do not move the floating preview with `left`/`top` styles or a wrapper of
  your own; pass `at`.

## Tags
browser, drag, drop, ghost, floating
