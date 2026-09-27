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

The sidebar slot is bounded by the available shell height on desktop and mobile.
Keep back navigation and search fixed above a filling `ScrollArea` for category
navigation. Use `NavSection` headings for search and category groups so their
indentation and typography stay consistent. The scrolling list must be outside
Electron drag regions and keep its last item reachable in short windows.

### Spacing

The detail content stacks settings sections with `--settings-section-gap`
(40px at every width): the space from one card to the next section header.
It is at least 3x the header -> card gap (`--settings-section-header-gap`,
12px), so each section header visibly belongs to the card below it (see
`FormSection`), and at least 1.5x `--settings-field-gap` (20px), the gap
between fields inside a card.

### Page header and sections

Pass `pageTitle` and `pageDescription` (the copy `detailHeader` shows). The
detail content is wrapped in a `SettingsPageProvider`, so `FormSection` drops a
section title or description that repeats the page header and a page never
reads its title twice (`repeatsSettingsCopy`).

## Who can use this component
Butler client settings containers and design-system fixtures.

## Best practice
Keep sidebar items presentational and drive selection from the container.

## Wrong use cases
Do not use it for inspector panels or project dashboards. Use InspectorPanel or dashboard blocks instead.

## Tags
settings, shell, responsive, navigation, layout
