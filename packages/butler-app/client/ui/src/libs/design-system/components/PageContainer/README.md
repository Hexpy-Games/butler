# PageContainer

## What is this component
PageContainer is the page frame for full pages (dashboards, management pages, setup). It centers the page, caps its inline size with page width tokens, applies the page gutter, and is the `page` inline-size container that page layouts query.

## Props

| Prop | Values |
| --- | --- |
| `width` | `narrow` (`--page-container-narrow`, 760px reading width), `default` (`--page-container-default`, 72rem), `full` (no cap) |
| `gutter` | named Space (`none`, `xs`, `sm`, `md`, `lg`, `xl`, `2xl`); omit for the adaptive page gutter |
| `as` | `div` (default), `main`, `section` |
| `align` | `center` (default) or `start`: the capped page stays at the inline start, as in the settings detail (`SettingsShell`) |

## How to use this component

```tsx
import { Grid, PageContainer } from "@/butler-ds";

<PageContainer as="main" width="default">
  <Grid columns={{ base: "1", wide: "main-aside" }} gap="xl">
    {main}
    {aside}
  </Grid>
</PageContainer>
```

`ManagementPage` and `SetupWizardShell` already render a PageContainer; pass `width` to ManagementPage instead of nesting another one.

## Responsive behavior
- `container: page / inline-size`: `Grid` `columns={{ base, wide }}` switches to `wide` from `@container page (min-width: 48rem)`, so a page inside a narrow drawer or split view stays on `base` even on a wide screen.
- The default gutter is `clamp(--space-lg, 3vw, 40px)`, and `--adaptive-page-gutter` at 700px and below.

## Best practice
- One PageContainer per page; sections inside use Stack, Grid and Box.

## Wrong use cases
- Do not add `max-width` or `container` CSS to product pages; choose a `width`.
- Do not nest PageContainers to shrink a section; use Grid columns.

## Tags
layout, page, width, gutter, container query
