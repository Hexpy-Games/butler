# SettingsHeader

## What is this component
A responsive header for a settings detail page.

## When to use this component
Use it at the top of a settings section or preference page.

## Where to use this component
Use it inside settings views and configuration panels.

## Why to use this component
It standardizes the page title and description.

## How to use this component
Pass title, optional description and, on a subpage, the breadcrumb as
`secondary`. The title renders as the page `h2` in `Typo.H2` (24px), the top
of the settings type hierarchy, so it always outranks `FormSection` titles
(`Typo.H4`) and field labels.

Settings pages show only the title and description here: they do not use
`action`. There are no page-level actions; add, refresh, filter and period
go in the header of the `SettingsSection` they act on, and a save result is
a brief toast. `action` remains for settings-like editors outside the
settings window.

## Who can use this component
Settings containers and related blocks.

## Best practice
Keep descriptions concise and actionable.

## Wrong use cases
Do not use it for dashboard page headers. Use `DashboardHeader`.
Do not pass `action` on a settings page; put the control in its section's header.

## Tags
settings, header, page-title
