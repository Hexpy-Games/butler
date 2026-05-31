# AutomationRow

## What is this component
A row for automation status and quick actions.

## When to use this component
Use it for recurring task lists and automation summaries.

## Where to use this component
Use it in automation management views and inspectors.

## Why to use this component
It separates automation state display from scheduling logic.

## How to use this component
Pass display-ready title, description, status, schedule, and action nodes.

## Who can use this component
Automation containers.

## Best practice
Keep schedule parsing and run commands outside the block.

## Wrong use cases
Do not use it for worker runs. Use `WorkerActivityRow`.

## Tags
automation, row, management, status
