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

## Background

`background` takes a decorative layer drawn behind the scrolling content and
confined to the page (never behind the sidebar or inspector), typically
`<Wallpaper scope="container">`. The layer is `aria-hidden`, takes no pointer
input and fills the page while the content scrolls over it.

`backgroundTreatment` sets how it sits behind text: `calm` (default) lays the
`--management-page-veil` token (the page tone, translucent) over it to lower
its contrast; `none` shows it as is. `calm` is the seam for a calmer engine
mode later: the prop stays, only its mapping changes.

With a background, wrap each content group in `ManagementPagePanel`: it
becomes a TintedGlass surface (the class export, `--space-2xl` padding,
`--space-lg` on phones) so text stays readable. Without a background it
renders its children only, with no DOM, so the plain page is unchanged. A
panel takes `ref`, e.g. to measure the header for the wallpaper's
`contentRect`. Omit `background` (not an empty layer) when there is nothing
to draw, so the page keeps its plain look.

```tsx
<ManagementPage background={<Wallpaper scope="container" source={source} contentRect={headerRect} />}>
  <ManagementPagePanel ref={setHeader}><DashboardHeader title="Butler" /></ManagementPagePanel>
  <ManagementPagePanel><Tabs>…</Tabs></ManagementPagePanel>
</ManagementPage>
```

## Who can use this component

Domain containers can wrap their presenter content with this block.

## Best practice

Keep domain loading and mutations outside this block. Pass rendered page content
as children.

## Wrong use cases

Do not use it for modal dialogs, inspector panels, or card interiors. Use
`DialogForm`, `InspectorPanel`, or `SurfacePanel` for those surfaces.

## Tags

management, page, layout, workspace, automation, background, wallpaper, glass

## Page width
ManagementPage renders its content inside `PageContainer`; pass `width` (`narrow`, `default`, `full`) instead of adding max-width or container CSS in product code. Grid responsive columns inside the page query that container.
