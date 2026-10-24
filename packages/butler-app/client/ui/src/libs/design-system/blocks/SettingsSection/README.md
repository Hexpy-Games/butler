# SettingsSection

## What is this block

`SettingsPage` and `SettingsSection` are the structure of every settings
page. A page renders only sections; a section is one header (title,
description, toolbar) above one card surface and owns its loading, error and
empty states. `SettingsField` throws (outside production builds) when it is
not inside a section, so fields can never float between cards.

## When to use this block

Use it for every settings page and settings subpage. Pick `kind` by content:
`form` for stacked fields and action rows, `list` for repeated rows
(servers, archives, events), `status` for live status (usage metrics, log
storage meters), `info` for read-only `KeyValueRow`s (app info). Fields are
always 24px apart: a `status` or `info` card that holds a field uses the
field gap (see `FormSection`, "Card gap by kind").

## Props

`SettingsPage`: `children` (only `SettingsSection`, fragments, `null`,
`false`), `labels` (`loading`, `error`, `retry`, `empty` state copy),
`footer` (sticky page actions).

`SettingsSection`: `id` (stable, listed in the page schema), `title?`,
`description?`, `kind`, `actions?` (list toolbar, `kind="list"` only), `state?`
(`ready | loading | error | empty`), `onRetry?`, `errorMessage?`,
`emptyMessage?`.

## Container vs Presenter

Presenter blocks. Product pages fetch data, map the fetch result to `state`,
pass app copy through `SettingsPage labels` and declare section and field ids
in their schema.

## Similar blocks

- **FormSection**: the header + card primitive SettingsSection composes; use
  it directly only outside settings pages.
- **SettingsShell**: the settings window (navigation, page header, scroll
  area) that hosts a `SettingsPage`.
- **SurfacePanel**: a standalone panel; never nest one inside a section card.

## Usage

```tsx
import { SettingsPage, SettingsSection } from "@/butler-ds";

<SettingsPage labels={copy.sectionState} footer={<ButtonContainer>...</ButtonContainer>}>
  <SettingsSection id="language-region" kind="form" title={copy.languageRegion}>
    <SettingsField settingId="language" ... />
  </SettingsSection>
  <SettingsSection id="updates" kind="list" actions={<Button>Check</Button>}
    state={view ? "ready" : error ? "error" : "loading"} onRetry={load}>
    {rows}
  </SettingsSection>
</SettingsPage>
```

## Accessibility

- Each section is a `section` labelled by its `h3` title.
- Loading sets `aria-busy` on the section; the skeleton carries the loading
  label.
- Errors render with `role="alert"` and a real Retry button.

## Responsive behavior

- The header toolbar sits at the inline end of the title and wraps under it
  at narrow widths. It is a list toolbar: add, refresh or check, filter, or a
  bulk action on every row of a `kind="list"` section. Reset, clear, free
  up space, export and every other action is a `SettingsActionField` row in
  the card (`bun run lint:ds` rejects header actions on other kinds).
- The sticky footer spans the page width at every width.

## Wrong use cases

- Do not render loose content, headings or dividers between sections.
- Do not show an empty message while a section is still loading or failed.
- Do not nest cards or panels inside the section card.
- Do not repeat the page title as a section title.
- Do not put a reset or clear button beside the section title; use a
  `SettingsActionField` row with a description of what it removes.
- Do not wrap sections in a `Stack`; `SettingsPage` owns the section gap.

## Tags

settings, section, page, loading, error, empty, toolbar
