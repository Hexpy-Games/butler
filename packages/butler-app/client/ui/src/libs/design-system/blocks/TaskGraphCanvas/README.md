# TaskGraphCanvas

## What is this component
A read-only task DAG. Desktop: ranked columns left to right in a horizontal
`ScrollArea` (edge fades follow the scroll) running edge to edge in the
inspector, first column on the inspector inset. Phones (`orientation="auto"`,
the default): `TaskGraphLanes` inside `InspectorInset`.

## When to use this component
To show one plan's tasks and their prerequisites.

## Where to use this component
The inspector Tasks tab, inside `TaskGraphSection`.

## Why to use this component
Layout, edges, keyboard navigation and scroll behaviour live here; the product
passes nodes, edges and a `renderNode`.

## How to use this component
```tsx
<TaskGraphCanvas nodes={[{ id, status }]} edges={[{ from, to }]} label={copy.graphLabel}
  selectedId={selected} onSelect={setSelected} renderNode={(id) => <TaskGraphCard … />} />
```

## Layout (lib/taskGraphLayout.ts, pure)
`indexTaskGraph` → `layoutTaskGraph` (longest-path ranks, one dummy slot per
skipped rank, barycentre ordering) → `laneTaskGraph` for phones. Ranks and
lanes are O(V + E); ordering sorts each column once. Recompute per graph
revision only (memoised on `nodes`/`edges`); cards are re-measured only when
the canvas or a card resizes (ResizeObserver), never on scroll.
`taskGraphEdgeState` and `rollupTaskGraphStatus` are exported for containers.

## Edges
SVG under the cards, tokens only, no motion: `satisfied` solid `--line-strong`,
`waiting` dashed, `failed` dashed `--danger` (from failed or cancelled),
`active` 2px `--worker-active` into a running task.

## Selection and keyboard
An out-of-view `selectedId` scrolls its column to the inset (not centred).
Arrow keys move focus and call `onSelect`: right/left follow edges, up/down
stay in the column.

## Who can use this component
Task graph containers.

## Best practice
Pass stable `nodes`/`edges` arrays (memoise) so layout runs once per revision.
Large graphs: layout is cheap (2,000 tasks in a few ms); rendering is the cost.
Virtualise only if real graphs pass a few hundred tasks.

## Wrong use cases
No editing, dragging or reordering; no fake nodes for sessions.

## Tags
task, graph, dag, dependencies, canvas
