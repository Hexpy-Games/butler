# AutomationRunList

## What is this component
A compact activity list for automation run history.

## When to use this component
Use it when showing recent runs for one automation or a filtered group.

## Where to use this component
Use it in automation detail and management panels.

## Why to use this component
It reuses `ActivityFeed` for run history without embedding automation APIs.

## How to use this component
Map automation run records into `ActivityFeedItem` objects.

## Who can use this component
Automation containers.

## Best practice
Format run state and time before passing items.

## Wrong use cases
Do not use it for scheduled automation definitions. Use `AutomationRow`.

## Tags
automation, runs, history, activity
