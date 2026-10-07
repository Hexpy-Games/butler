# TaskGraphLanes

## What is this component
The phone layout of a task DAG: full-width cards top to bottom in rank order
with a lane gutter (git-log lanes) that carries fan-out and join.

## When to use this component
Compact widths. `TaskGraphCanvas` renders it automatically with
`orientation="auto"`; use it directly only for a forced vertical layout.

## Where to use this component
The inspector Tasks tab on phones.

## Why to use this component
Each dot is centred on its card's first text line (the card IconSlot,
measured), at any type scale.

## How to use this component
Same props as `TaskGraphCanvas` (`nodes`, `edges`, `renderNode`, `onSelect`, `label`).

## Who can use this component
Task graph containers.

## Best practice
Up/Down move focus and selection row by row. Edge states match the canvas.

## Wrong use cases
Desktop widths (use the canvas); plain step lists (use ActivityFeed).

## Tags
task, graph, lanes, phone
