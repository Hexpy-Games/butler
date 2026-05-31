# WorkerActivityRow

## What is this component
A worker-oriented activity row composed from `ActivityFeed` and row actions.

## When to use this component
Use it for background worker status and small control affordances.

## Where to use this component
Use it in worker inspectors and task activity panels.

## Why to use this component
It standardizes worker rows without embedding worker lifecycle logic.

## How to use this component
Pass formatted title, description, icon, meta, and optional action nodes.

## Who can use this component
Worker containers and inspector panels.

## Best practice
Keep control availability and labels in the caller.

## Wrong use cases
Do not use it for generic history lists. Use `ActivityFeed`.

## Tags
worker, activity, inspector, actions
