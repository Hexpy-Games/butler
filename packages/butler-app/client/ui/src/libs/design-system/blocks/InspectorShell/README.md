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

## Wrong use cases
Do not use it for settings navigation or full-page dashboards. Use SettingsShell or dashboard blocks instead.

## Tags
inspector, shell, tabs, side-panel, responsive
