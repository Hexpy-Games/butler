# SidebarShell

## What is this component

`SidebarShell` is the responsive structural shell for Butler's left navigation.
It owns sidebar width, collapse motion, internal scrolling, titlebar spacing,
and footer separation.

## When to use this component

Use it when a product container needs the Butler left navigation frame. Compose
the actual navigation rows with `NavRow`, `NavSection`, and
`CollapsibleNavGroup`.

## Where to use this component

Use it at the app shell boundary. Do not use it inside panels, dialogs, or
settings sections.

## Why to use this component

It keeps the sidebar's glass-era sizing, scroll behavior, collapse motion, and
macOS traffic-control spacing consistent without reintroducing product CSS.

## How to use this component

Pass titlebar, fixed header, scroll content, and footer slots. Keep direct
navigation in the fixed header. Put project/session and chat sections in the
scroll content so only session-related navigation scrolls.

## Who can use this component

Frontend agents building Butler app chrome or sidebar variants.

## Best practice

Keep `SidebarShell` as layout only. Put row state and actions in
`NavRow`, `RowActionCluster`, `OverflowActionMenu`, or product containers.

## Wrong use cases

Do not use this as a generic panel. Use `SurfacePanel` or `InspectorPanel`
instead. Do not put domain fetching or route selection into this block.

## Tags

sidebar, chrome, layout, responsive, navigation
