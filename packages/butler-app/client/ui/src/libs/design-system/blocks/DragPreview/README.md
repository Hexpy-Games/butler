# DragPreview

## What is this block
`DragPreview` is what follows the pointer while picked elements or a browser tab
are dragged: two stacked crops with a count, or the lifted tab, with a
no-entry badge over invalid targets. Lifted on `--shadow-drag-lift`.

## When to use this block
Render it for `setDragImage` or in the overlay layer while dragging picks to
the chat, a conversation or the library, or a tab to the sidebar.

## Container vs Presenter
The App owns the drag; the target (`NavDropTarget` `outside`, the composer)
shows what a drop will do.

## Usage

```tsx
<DragPreview kind="elements" images={picks.map((pick) => ({ src: pick.crop }))} invalid={!canDrop} />
```

## Accessibility
Purely visual (`aria-hidden`); every drag has a menu path too.

## Responsive behavior
Fixed size; the crops cover their frames.

## Wrong use cases
- Do not put words in the preview; the drop label explains the drop.

## Tags
browser, drag, drop, ghost
