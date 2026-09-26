# KanbanBoard

## What is this component
`KanbanBoard` lays out `KanbanLane`s on a grid (four columns by default); each lane is a flat surface with a title and a fixed-height (`--kanban-lane-height`) scrolling list.

## When to use this component
Use it for plans or tasks grouped by status.

## Where to use this component
Project dashboards.

## Why to use this component
The lane geometry lives in the DS instead of inline styles.

## How to use this component
`<KanbanBoard><KanbanLane title="Draft">{tiles}</KanbanLane></KanbanBoard>`

`scroll` keeps every lane in one row at least `--kanban-lane-min-width` (15rem) wide; the board scrolls sideways with the x scroll-edge fade and pads its bottom for the scrollbar (the project work board's six status lanes). Lanes can be `KanbanLane`s or any lane surface (`Box` + `Section`).

## Who can use this component
Dashboard components.

## Best practice
Put `DocumentTile`s in lanes; show an `EmptyLine` in an empty lane.

## Wrong use cases
Do not use it for a single list. Use `CardList`.

## Tags
kanban, board, lanes, plans
