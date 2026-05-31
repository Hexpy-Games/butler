# SettingsShell

## What is this component
SettingsShell provides the two-region settings layout: navigation sidebar and scrollable detail area.

## When to use this component
Use it for full settings surfaces that switch between sections.

## Where to use this component
Use it at the settings view boundary. Keep each section's fields in SettingsField or FormSection blocks.

## Why to use this component
It centralizes responsive settings geometry and prevents product CSS from owning layout.

## How to use this component
Pass already-rendered sidebar and detail nodes. The product container decides active section and data.

## Who can use this component
Butler client settings containers and design-system fixtures.

## Best practice
Keep sidebar items presentational and drive selection from the container.

## Wrong use cases
Do not use it for inspector panels or project dashboards. Use InspectorPanel or dashboard blocks instead.

## Tags
settings, shell, responsive, navigation, layout
