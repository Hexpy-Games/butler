# SettingsSection

## What is this block

`SettingsPage` and `SettingsSection` are the structure of every settings
page. A page renders only sections; a section is one header (title,
description, actions) above one card surface and owns its loading, error and
empty states and the "more" row of a paged list. `SettingsField` throws
(outside production builds) when it is not inside a section, so fields can
never float between cards.

## When to use this block

Use it for every settings page and settings subpage. Pick `kind` by content:
`form` for stacked fields and action rows, `list` for repeated rows
(servers, archives, events), `status` for live status (usage metrics, log
storage meters), `info` for read-only `KeyValueRow`s (app info). Fields are
always 24px apart: a `status` or `info` card that holds a field uses the
field gap (see `FormSection`, "Card gap by kind").

## Page structure

1. **Every section has a title.** `title` is required. It names what the
   card holds below the page title; a title that repeats the page title
   throws in dev builds (production renders it as given).
2. **No page-level actions.** The page header (`SettingsHeader`) shows only
   the page title and description (a subpage adds its breadcrumb). The
   `SettingsPage` footer is only for pages that save explicitly (Personalization).
3. **Section actions go only in the section header,** right-aligned (also
   when they wrap under the title), `Button variant="outline" size="sm"`
   (or `size="icon-sm"`), on `kind="list"` and `kind="status"`: add,
   refresh, filter (`Select size="sm"`), period (`SegmentedControl size="sm"`).
   The header never holds a setting: a setting is a `SettingsField` in the
   card. Reset, clear and export are `SettingsActionField` rows.
4. **List rows sit directly in the section card.** `CardList` and
   `CardListItem` render flush inside a section card (no nested bordered
   cards; rows divided by hairlines). A paged list passes `more` and the
   section draws the last row. An empty list uses `state="empty"` with one
   short message; the header actions stay visible.

`bun run lint:ds` (`butler-ds/settings-field-grouping`) rejects header
actions on `form` and `info` sections, a setting control in a header, and a
header button that is not outline and small.

## Props

`SettingsPage`: `children` (only `SettingsSection`, fragments, `null`,
`false`), `labels` (`loading`, `error`, `retry`, `empty` state copy),
`footer` (sticky Save / Cancel of an explicit-save page only).

`SettingsSection`: `id` (stable, listed in the page schema), `title`
(required), `description?`, `kind`, `actions?` (header actions, `list` and
`status` only), `state?` (`ready | loading | error | empty`), `onRetry?`,
`errorMessage?`, `emptyMessage?`, `more?` (`{ label, onClick, busy? }`: the
last row of a paged list, shown when `state` is `ready`).

## Container vs Presenter

Presenter blocks. Product pages fetch data, map the fetch result to `state`,
pass app copy through `SettingsPage labels` and declare section and field ids
in their schema.

## Similar blocks

- **FormSection**: the header + card primitive SettingsSection composes; use
  it directly only outside settings pages.
- **CardList**: the list rows of a list section; flush inside the card.
- **SettingsShell**: the settings window (navigation, page header, scroll
  area) that hosts a `SettingsPage`.
- **SurfacePanel**: a standalone panel; never nest one inside a section card.

## Usage

```tsx
import { Button, CardList, Plus, SettingsPage, SettingsSection } from "@/butler-ds";

<SettingsPage labels={copy.sectionState}>
  <SettingsSection id="language-region" kind="form" title={copy.languageRegion}>
    <SettingsField settingId="language" ... />
  </SettingsSection>
  <SettingsSection id="servers" kind="list" title={copy.servers}
    actions={<Button size="sm" variant="outline"><Plus size="md" />{copy.add}</Button>}
    state={servers ? (servers.length ? "ready" : "empty") : error ? "error" : "loading"}
    emptyMessage={copy.noServers} onRetry={load}
    more={hasMore ? { label: copy.more, busy: loading, onClick: loadMore } : undefined}>
    <CardList>{rows}</CardList>
  </SettingsSection>
</SettingsPage>
```

## Accessibility

- Each section is a `section` labelled by its `h3` title.
- Loading sets `aria-busy` on the section; the skeleton carries the loading
  label.
- Errors render with `role="alert"` and a real Retry button.
- The more row is a real button after the rows it extends.

## Responsive behavior

- The header actions sit at the inline end of the title and wrap under it at
  narrow widths, still right-aligned.
- The sticky footer spans the page width at every width.

## Wrong use cases

- Do not omit the title or repeat the page title as a section title.
- Do not render loose content, headings or dividers between sections.
- Do not show an empty message while a section is still loading or failed.
- Do not nest cards or panels inside the section card, or give a list a
  second empty state of its own.
- Do not put a setting (input, switch) or a reset or clear button in the
  section header.
- Do not put a page-level button in the page header or footer; the footer is
  for explicit save only.
- Do not wrap sections in a `Stack`; `SettingsPage` owns the section gap.

## Tags

settings, section, page, loading, error, empty, actions, more, list
