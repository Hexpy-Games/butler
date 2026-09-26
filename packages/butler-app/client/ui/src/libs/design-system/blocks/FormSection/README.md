# FormSection

## What is this block

FormSection is a Butler design-system block for a grouped settings section:
a section header (title + optional description) above a bordered card that
contains only fields (the macOS System Settings / iOS grouped list / Vercel
and GitHub settings pattern).

## When to use this block

Use FormSection in settings panels, configuration dialogs, or multi-section forms where fields need logical grouping.

Use it as the top-level group of a settings page. Repeated editable items
inside the card should be separate bordered rows or panels, not loose text.

## Container vs Presenter

**FormSection is a presenter block.** It owns section layout and title rendering. It must not import Butler domain logic or form state.

**Container responsibilities:** Domain components provide section title/description from app copy and map form fields.

## Similar blocks

- Use **NavSection** for navigation grouping, not forms
- Use **Section** primitive for general content sections
- Use **PanelHeader** + Stack for custom form layouts

## Usage

```tsx
import { FormSection, FormRow } from "@/butler-ds";

<FormSection title="Appearance" description="Customize your theme">
  <FormRow label="Theme"><Select>...</Select></FormRow>
  <FormRow label="Density"><Select>...</Select></FormRow>
</FormSection>

// The page's single card, when a title would repeat the page title:
<FormSection>
  <FormRow label="Theme"><Select>...</Select></FormRow>
</FormSection>
```

`title` is optional. Omit it when the section's title would repeat the page
title (for example Appearance, General or MCP under a page titled the same).
A description that differs from the page description may still sit above the
card on its own; one that repeats the page description is dropped, so a
section whose title and description both restate the page (MCP, Skills, Logs)
renders the card alone. Title-only sections (Models "Model settings") use the
same header-above-card pattern.

Inside a `SettingsShell` with `pageTitle` / `pageDescription`, FormSection
enforces this: a title or description that repeats the page header is not
rendered (`repeatsSettingsCopy`: equal after NFKC, case, whitespace and end
punctuation normalization, or, for descriptions of three or more words, the
page description followed by more words). Short titles only match exactly, so
"Model settings" stays on "Models" in every locale. Product pages still omit
the repeated copy themselves; the check is a safety net.

## Structure

```
<section data-slot="form-section" aria-labelledby=title>
  <div data-slot="form-section-header">  h3 title, p description   (no surface)
  <div data-slot="form-section-card">    fields only (border, radius, panel bg, inset)
```

The header aligns to the card's outer edge, the same left edge as the page
title. macOS and iOS inset their small 11-13px group captions to the row
text, but an 18px heading is a heading, not a caption: Vercel and GitHub
keep settings headings flush with the card, so the page title, section
titles and cards share one left edge and the fields step in by the card
inset. There is no divider: the header's proximity to its card does the
grouping.

## Hierarchy and spacing

A settings page reads page title -> section -> field -> description:

| Level | Type | Tone |
| --- | --- | --- |
| Page title (`SettingsHeader`) | `Typo.H2` 24px / 620 | primary |
| Section title (FormSection, above the card) | `Typo.H4` as `h3`, 18px / 560 | primary |
| Section description (above the card) | `Typo.Body` at 13px (`--font-size-2`), max 60ch | secondary |
| Field label (`SettingsField`) | `Label` 14px / 500 | primary |
| Field description | `Typo.Caption` 12px | secondary |

The section title keeps 18px outside the card: it is the only level between
the 24px page title and the 14px field labels, and without a card border
around it the size step is what separates it from a field label.

Header spacing (proximity: a header belongs to the card below it):

| Token | Value | Between |
| --- | --- | --- |
| `--settings-field-copy-gap` | 6px | section title and description |
| `--settings-section-header-gap` | 12px | header (title or description) and card |
| `--settings-section-gap` | 40px | card and the next section header (owned by `SettingsShell`) |

The card -> next header gap is at least 3x the header -> card gap.

Field ramp inside the card (tightest to widest):

| Token | Value | Between |
| --- | --- | --- |
| `--settings-field-copy-gap` | 6px | label and description |
| `--settings-field-control-gap` | 12px | description and control, control and meta |
| `--settings-field-gap` | 20px | fields |

The card inset is `--settings-section-padding` (24px; 16px at 760px and
below). There are no separators between fields: stacked fields at a 20px gap
are grouped by proximity alone. Do not add margins or gaps between sections or
fields in product code.

## Accessibility

- Uses a semantic `section` labelled by its title (`aria-labelledby`)
- Title is an `h3` (`Typo.H4`) under the page `h2`
- Description provides context

## Responsive behavior

- Full-width layout
- Fields stack vertically
- Mobile-friendly spacing

## Wrong use cases

- Do not use for navigation sections
- Do not use for non-form content grouping
- Do not use `Section` when the surface needs the settings card border
- Do not put the section title or description inside the card, and do not add a divider under the header
- Do not nest FormSections for repeated editable items; use a repeated row or panel

## Tags

form, section, grouping, settings
