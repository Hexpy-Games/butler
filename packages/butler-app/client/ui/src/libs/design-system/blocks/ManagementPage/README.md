# ManagementPage

## What is this component

ManagementPage is a padded page surface for workspace management views.

## When to use this component

Use it for full-page management areas such as automations, project dashboards,
and other workspace views that sit below the app titlebar.

## Where to use this component

Use it as the outer presenter around page-level headers, list content, and
detail forms inside the workspace column.

## Why to use this component

It keeps page padding, scrolling, and titlebar separation consistent without
adding product-owned CSS modules.

## How to use this component

Compose it with `DashboardHeader`, `Section`, `Grid`, and form primitives.
Use `as="form"` when the whole page is a form surface.

For a floating composer use `footerPlacement="overlay"`. The footer must own
its positioning (for example `ComposerCard` with `floating`). Pass its measured
height as `footerReserve`; the full-height page scrolls underneath it, with
bottom content padding to keep the final item reachable. The default `flow`
placement retains a separate footer for surfaces that require one.

## Who can use this component

Domain containers can wrap their presenter content with this block.

## Best practice

Keep domain loading and mutations outside this block. Pass rendered page content
as children.

## Wrong use cases

Do not use it for modal dialogs, inspector panels, or card interiors. Use
`DialogForm`, `InspectorPanel`, or `SurfacePanel` for those surfaces.

## Tags

management, page, layout, workspace, automation
