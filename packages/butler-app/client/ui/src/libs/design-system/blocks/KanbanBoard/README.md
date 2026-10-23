# KanbanBoard

## What is this component
`KanbanBoard` lays out `KanbanLane`s on a grid (four columns by default); each lane is a flat surface with a title and a fixed-height (`--kanban-lane-height`) scrolling list, or (`height="content"`) a lane that grows with its cards. Inside a `KanbanDragScope`, `KanbanCard`s move within a lane, between lanes and between boards.

## When to use this component
Use it for plans or tasks grouped by status. Add `KanbanDragScope` when people change an item's status, order or group by dragging it.

## Where to use this component
Project dashboards and boards with one section per group (one board per section plus a wide lane above them, all in one scope).

## Why to use this component
The lane geometry, drag feedback, motion, auto-scroll and keyboard dragging live in the DS instead of product code.

## How to use this component
`<KanbanBoard><KanbanLane title="Draft">{tiles}</KanbanLane></KanbanBoard>`

`scroll` keeps every lane in one row at least `--kanban-lane-min-width` (15rem) wide; the board scrolls sideways with the x scroll-edge fade and pads its bottom for the scrollbar (the project work board's six status lanes). Lanes can be `KanbanLane`s or any lane surface (`Box` + `Section`).

Dragging:

```tsx
<KanbanDragScope onMove={({ itemId, fromLaneId, toLaneId, beforeItemId }) => save(...)} canDrop={(itemId, laneId) => true} labels={localized}>
  <KanbanBoard scroll>
    <KanbanLane laneId="todo" height="content" title="To do · 2">
      <KanbanCard itemId="a" label="Login form" onOpen={open}>…</KanbanCard>
    </KanbanLane>
  </KanbanBoard>
  {/* more boards (sections) in the same scope */}
</KanbanDragScope>
```

- `onMove` fires once per drop that changes something: same lane = reorder, other lane = status change, other board = move to that group. `beforeItemId` is the card it lands above, `null` for the lane's end. `applyKanbanMove` applies it to lanes of ids.
- The product owns the order: apply the move at once, persist it, and restore the previous order if saving fails. Cards glide (FLIP) to their places on every reorder, so a rejected move snaps back with motion.
- `canDrop(itemId, laneId)` keeps a lane from highlighting or taking a card; keyboard moves skip it.
- `layout="grid"` wraps cards in columns at least `--kanban-card-min-width` wide (one wide lane such as a backlog).
- `KanbanCard` is a button: click or Enter opens (`onOpen`), Space lifts; `disabled` keeps it in place.

## Motion
Pick-up lifts the card into an overlay (`--motion-scale-lift`, `--shadow-drag-lift`, spring) and leaves a faint placeholder. At the drop point a slot the size of the card opens on `--motion-base` with a `--kanban-drop-line` accent line centered in it (M5 drag feedback), and the target lane gets an accent border and a 5% accent fill. On drop the overlay settles into the card's new place while its neighbors glide (FLIP, `--motion-ease-emphasized`). Reduced motion opens no slot, the line only fades in, and cards are placed at once. A keyboard-lifted card lifts in place and keeps its focus ring.

Pointer drags start after 6px, touch drags after a 250ms long press. The containers under the pointer (a board sideways, a lane and the page vertically) scroll in a 40px edge band.

## Who can use this component
Dashboard components.

## Best practice
Put `DocumentTile`s in plain lanes and `KanbanCard`s in drag lanes; show an `EmptyLine` in an empty lane. Use one `KanbanDragScope` for every board of the page.

## Wrong use cases
Do not use it for a single list. Use `CardList` (or `SortableCardList` for one ordered list).

## Tags
kanban, board, lanes, plans, drag, reorder
