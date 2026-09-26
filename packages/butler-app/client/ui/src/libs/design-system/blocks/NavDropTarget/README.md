# NavDropTarget

## What is this block
`NavDropTarget` wraps one draggable sidebar tree item and shows where a dragged
row would land: a line before or after the row header, or a ring for dropping
inside a folder or grouping two conversations (with a short hint).
`NavRootDropZone` is the dashed "move to the top level" zone shown while a row
is dragged.

## When to use this block
Use it for sidebar trees whose rows can be reordered or moved by drag and drop.

## Container vs Presenter
The product container owns the drag data (native drag events, what may drop
where) and passes `drop`, `dragging` and the measured row header box
(`indicator`). The block owns every visual state and its motion; product CSS
never styles drop indicators.

## Similar blocks
- `SortableCardList`: keyboard and pointer reordering of cards (dnd-kit).
- `CollapsibleNavGroup`: the folder row inside a drop target.

## Usage

```tsx
import { NavDropTarget, NavRow } from "@/butler-ds";

<NavDropTarget draggable drop={placement} dragging={isSource}
  indicator={{ top, height }} hint={copy.groupTogether}
  onDragStart={start} onDragOver={over} onDrop={drop}>
  <NavRow label={title} onClick={open} />
</NavDropTarget>
```

## Motion
Rows on both sides of an insert line slide apart (`--motion-distance-xs`,
`--motion-fast`), the line grows in, and a drop-inside or group target lifts
(`--motion-scale-lift`, `--shadow-drag-lift`, `--motion-ease-spring`). Rows
must be `CollapsibleList` items for the neighbor slide. The Space sidebar keeps
native drag and drop (a dragged conversation can be dropped into the composer
as a reference), so the dragged row itself stays in place, dimmed, while the
browser's drag image follows the pointer.

## Accessibility
Drop feedback is visual; pair pointer dragging with a keyboard path (a "Move
to..." menu item) as the Space sidebar does.

## Responsive behavior
The indicator follows the measured row header, so it works for every sidebar
density.

## Wrong use cases
- Do not use it for lists without drag and drop; use `NavRow` alone.
- Do not add drop indicator CSS in product code.

## Tags
navigation, sidebar, drag, drop, reorder
