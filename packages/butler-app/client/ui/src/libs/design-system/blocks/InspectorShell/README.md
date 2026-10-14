# InspectorShell

## What is this component
InspectorShell provides the right-side inspector panel with tab navigation and open/closed motion.

## When to use this component
Use it when a side inspector switches between several session-oriented panels.

## Where to use this component
Use it at the inspector container boundary. Individual tab content should use InspectorPanel and other DS blocks.

## Why to use this component
It keeps inspector geometry, transitions, tabs, and responsive scrolling in the design system.

## How to use this component
Pass tab metadata, the active tab id, an onTabChange handler, and the rendered active panel.

## Who can use this component
Butler client containers that render the right inspector.

## Best practice
Keep tabs short and keep domain data mapping outside the block.

The tab row and the content both fade at the edges where they scroll
(`useScrollEdges`): the content fades top and bottom while it is clipped.

Inside `AdaptiveShell frame="cards"` (docked) the inspector is the side card:
it fills the card slot under the title row with `--shell-card-bg`, a 12px
radius and one quiet `--shell-card-edge`; the tab row stays inside the card.
The title-bar toggle shows "open" by icon colour (IconButton `tone="butler"`
with `pressed`), never a fill.

## Wrong use cases
Do not use it for settings navigation or full-page dashboards. Use SettingsShell or dashboard blocks instead.

## Tags
inspector, shell, tabs, side-panel, responsive

## InspectorInset

Full-width inspector content that is not an `InspectorPanel` card (a `Section`,
an `ActivityFeed`) goes inside `InspectorInset`, which applies the inspector's
`--inspector-inline-padding`. Pass `fill` when the content should take the
remaining column height. Product code must not recreate the inset with
`style={{ marginInline: ... }}`.

