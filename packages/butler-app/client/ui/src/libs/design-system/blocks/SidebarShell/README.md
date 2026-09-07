# SidebarShell

The shell accepts `--sidebar-region-gap` and `--sidebar-content-inset` CSS
variables for token-based section spacing. Defaults preserve existing layouts.
Set `--sidebar-footer-border-width: 0` for a spacing-only footer separation.
Set `scrollFade={false}` when the scrolling content has opaque sticky headers
that should not fade at the viewport edge. The default fade remains unchanged.
For an all-menu scroll, put entry actions in `scrollHeader` and browse controls
in `stickyHeader`. Both use the same scrollbar as children. The sticky slot sits
below the fade and publishes its measured height as `--nav-sticky-offset` for
nested tree headers. No wheel interception or second scrollbar is needed.
The sticky header owns an 8px trailing gap; the all-menu scroll removes its
legacy inter-section gap to avoid doubling that space. Sticky material accepts
`--nav-sticky-surface` and `--nav-sticky-filter`. Transparent surfaces do not
need extra blur: the shell clips the child paint/hit-test area below the sticky
header, including nested CollapsibleNavGroup branches. One passive scroll/RAF
measurement updates CSS variables, without React state or a second scrollbar.
Resize/structural changes refresh the boundaries; keyboard focus reveals a
clipped row through the same scrollbar. Native sticky owns branch push-off.
Set `--sidebar-compact-titlebar-display: flex` when a compact sidebar needs its
brand titlebar alongside fixed window chrome. The default remains hidden.

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
