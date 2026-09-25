# DocumentTile

## What is this component
A resource tile tuned for project documents.

## When to use this component
Use it for document cards and project knowledge surfaces.

## Where to use this component
Use it in project dashboards and document pickers.

## Why to use this component
It is a Card with the document icon on the title line, a medium two-line
title, one caption line (optional `Tag` badge, then description · meta) and
actions at the top right. `clickTarget="tile"` makes the whole card the
open button (inspector artifacts); otherwise `actionLabel` + `onOpen` render
a trailing Open button (dashboard plan and spec lists).

## How to use this component
Pass display-ready document title, description, metadata, and either an open
handler or a safe open href.

## Who can use this component
Management and project containers.

## Best practice
Keep document fetching and routing outside this block.

## Wrong use cases
Do not use it for session rows. Use `SessionRow`.

## Tags
document, dashboard, resource, tile
