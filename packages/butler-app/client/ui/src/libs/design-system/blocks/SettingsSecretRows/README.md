# SettingsSecretRows

## What is this component
SettingsSecretRows provides the compact row layout used for editable secret maps in settings.

## When to use this component
Use it when a settings surface needs repeated secret source, key, value, and row-action controls.

## Where to use this component
Use it inside settings sections. Keep data mapping and validation in the product container.

## Why to use this component
It centralizes responsive row geometry so settings domain components do not own CSS modules.

## How to use this component
Pass already-rendered controls into SettingsSecretRow slots and pass bulk actions to SettingsSecretRows.

## Who can use this component
Butler client settings containers and design-system fixtures.

## Best practice
Keep controls controlled by the container and let this block own only layout.

## Wrong use cases
Do not use it for generic tables, dashboards, or logs.

## Tags
settings, secrets, rows, form
