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

## Aside

`aside` shows a detail beside the content (the selected task on a project
board). The page owns where it sits and scrolls it in a scroller of its own
(the shared edge fade; a scrollbar lane only while a classic scrollbar is drawn):

- Docked (a 1000px page or wider; a floating aside docks again from 1032px):
  flat in the right margin, 360px (`--management-aside-width`), `--space-lg`
  from the top, end and bottom. The scroll area and an overlay footer narrow to
  its left (the footer follows `--conversation-column-width` and
  `--conversation-column-shift`, as ComposerCard reads them).
- Floating (narrower): one TintedGlass panel over the page, ending above the
  footer, shown only while `asideFloatOpen`.

A function gets the layout (`"docked" | "floating"`). Both layouts keep one
inset on the start and the end, whatever the scrollbar (overlay, classic or
hidden). The page carries `data-aside`, the aside `data-layout`; opening, closing and a
docked/floating flip cross-fade with the DS Presence fade. Name the landmark
with `asideLabel`. Without `aside` the page renders exactly as before.

```tsx
<ManagementPage footerPlacement="overlay" footerReserve={reserve} footer={composer}
  aside={task && <TaskDetail task={task} />} asideFloatOpen={detailOpen} asideLabel={copy.taskDetails}>
  {board}
</ManagementPage>
```

### Wallpaper keep-out

`onColumnRect` reports the content column's left and right edges and the
page's top in client CSS px, the same rect ConversationShell's
`MessageListSurface onColumnRect` gives. While the aside is docked, `right`
reaches the aside's far edge, so a wallpaper's dots stay out from behind it as
well as the content. It reports on mount and on every resize (column, page,
window, the aside docking or leaving), never on scroll; equal values are not
reported twice. With no aside docked it is the column alone. Pass it to the
background's `columnRect`; the page never needs to read the DOM itself.

```tsx
const [column, setColumn] = useState<ManagementPageColumnRect>();
const columnRect = column && { x: column.left, y: column.top, width: column.right - column.left, height: 0 };
<ManagementPage onColumnRect={setColumn} aside={detail}
  background={<Wallpaper scope="container" source={source} columnRect={columnRect} />}>
  {board}
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

management, page, layout, workspace, automation, background, wallpaper, glass, aside, detail

## Page width
ManagementPage renders its content inside `PageContainer`; pass `width` (`narrow`, `default`, `full`) instead of adding max-width or container CSS in product code. Grid responsive columns inside the page query that container.
