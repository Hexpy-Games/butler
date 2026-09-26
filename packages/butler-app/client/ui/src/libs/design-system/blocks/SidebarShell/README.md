# SidebarShell

`density` (`compact`, `comfortable` (default), `touch`) sets row height, inline
padding, icon size, label gap, row spacing and trailing action targets for every
`NavRow` inside through tokens (`[data-sidebar-density]` in `tokens.css`:
`--sidebar-row-height`, `--sidebar-row-padding-inline`, `--sidebar-icon-size`,
`--sidebar-row-gap`, `--sidebar-row-spacing`, `--sidebar-action-size`).
Comfortable becomes touch on phones and coarse pointers. A single `NavRow` or
`NavRow` may take its own `density`.

The shell owns the sidebar surface: icon actions sized by the density with a
round hover surface, tight icon clusters, a transparent sticky header, heading
insets, tree indent, a spacing-only footer, and the `SidebarBrand` title row.
Product CSS never sets `--sidebar-*`, `--clickable-*`, `--icon-button-*` or
`--nav-*` properties; request a density or a shell prop instead.
Set `scrollFade={false}` when the scrolling content has opaque sticky headers
that should not fade at the viewport edge. The default fade remains unchanged.
For an all-menu scroll, put entry actions in `scrollHeader` and browse controls
in `stickyHeader`. Both use the same scrollbar as children. The sticky slot sits
below the fade and publishes its measured height as `--nav-sticky-offset` for
nested tree headers. No wheel interception or second scrollbar is needed.
The shell clips the child paint/hit-test area below the transparent sticky
header, including nested CollapsibleNavGroup branches. One passive scroll/RAF
measurement updates CSS variables, without React state or a second scrollbar.
Resize/structural changes refresh the boundaries; keyboard focus reveals a
clipped row through the same scrollbar. Native sticky owns branch push-off.

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

## Header row

The `titlebar` slot is the sidebar header row: `--titlebar-height` tall, its
content vertically centered and starting at `--sidebar-titlebar-leading`,
after the floating sidebar toggle (`ChromeFloatingToggleLayer`). The toggle is
a standard `IconButton` (`--chrome-floating-toggle-size`,
`--control-height-md`) centered in the row. Its left edge is
`--traffic-controls-width + --chrome-toggle-inset`: in a browser it lines up
with the sidebar rows (`--sidebar-padding-inline`, 14px); on macOS Electron it
sits after the 72px traffic-light reserve. `AdaptiveShell` picks the reserve
from its `data-chrome-environment`/`data-platform` attributes, and the toggle
keeps its place whether the sidebar is open or closed. Pass
`SidebarTrafficSpace` when the row has no brand. Product CSS never offsets the
brand or the toggle.

## Who can use this component

Frontend agents building Butler app chrome or sidebar variants.

## Best practice

Keep `SidebarShell` as layout only. Put row state and actions in
`NavRow`, `ButtonContainer`, `OverflowActionMenu`, or product containers.

## Wrong use cases

Do not use this as a generic panel. Use `SurfacePanel` or `InspectorPanel`
instead. Do not put domain fetching or route selection into this block.

## Tags

sidebar, chrome, layout, responsive, navigation
