# DisclosureRow

## What is this component
A row that can reveal detail content below it.

## When to use this component
Use it for tool calls, worker steps, collapsible facts, or audit entries.

## Where to use this component
Use it in conversation activity, inspectors, and detail panels.

## Why to use this component
It standardizes nested-button-safe disclosure behavior with `Clickable`.

## How to use this component
Keep expansion state in the caller and pass `open`, `onToggle`, and children.

## Who can use this component
Any container that owns expandable row state.

## Best practice
Pass domain labels as text and keep block children presentational.
Use `surface="plain"` when the disclosure only controls a timeline or nested
detail region and must not turn the whole area into an active background block.

## Wrong use cases
Do not use it for sidebar hierarchy. Use `CollapsibleNavGroup`.

## Tags
disclosure, row, activity, details
