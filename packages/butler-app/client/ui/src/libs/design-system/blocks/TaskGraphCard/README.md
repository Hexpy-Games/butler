# TaskGraphCard

## What is this component
One task in a task graph: status glyph and title (two lines), assignee and model,
status Tag with time, and the live step line while running.

## When to use this component
For every node rendered by `TaskGraphCanvas` / `TaskGraphLanes` (`renderNode`).

## Where to use this component
The inspector Tasks tab.

## Why to use this component
Status glyph, tag tone, running activity (`Card activity="running"`), the
first-line IconSlot alignment the lanes measure, and the accessible name are
owned here, so product code only maps data.

## How to use this component
```tsx
<TaskGraphCard taskId={id} title={title} status="running" statusLabel={copy.status.running}
  meta={`${copy.assignee(3)} · ${modelName}`} time={elapsed} step={currentStep}
  selected={id === selectedId} opensDialog onActivate={openConversation} />
```
Also exported: `TaskGraphStatusIcon` (the glyph, used by section rows),
`TaskGraphStepLine` (the rolling step line, used in the detail) and
`taskGraphStatusTone(status)`.

## Who can use this component
Task graph containers.

## Best practice
Statuses: `pending | running | review | done | failed | blocked | cancelled | paused`.
All words come from i18n. Running and done share `LoadingIndicator`, so a task
finishing while visible draws the check.

## Wrong use cases
Not a generic card (use `Card`), not editable, not draggable.

## Tags
task, graph, card, status, worker
