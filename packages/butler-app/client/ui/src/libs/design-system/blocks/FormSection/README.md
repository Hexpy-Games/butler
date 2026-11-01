# FormSection

## What is this block

FormSection is a Butler design-system block for a grouped settings section:
a section header (required title, optional description, optional actions)
above a bordered card that contains only fields (the macOS System Settings / iOS grouped list / Vercel
and GitHub settings pattern).

## When to use this block

Use FormSection in settings panels, configuration dialogs, or multi-section forms where fields need logical grouping.

Use it as the top-level group of a settings page. Repeated items inside the
card are list rows (`CardList`, which renders flush inside the card), never
nested bordered cards or panels.

## Container vs Presenter

**FormSection is a presenter block.** It owns section layout and title rendering. It must not import Butler domain logic or form state.

**Container responsibilities:** Domain components provide section title/description from app copy and map form fields.

## Similar blocks

- Use **NavSection** for navigation grouping, not forms
- Use **Section** primitive for general content sections
- Use **PanelHeader** + Stack for custom form layouts

## Usage

```tsx
import { FormSection, SettingsField } from "@/butler-ds";

<FormSection title="Appearance" description="Customize your theme">
  <SettingsField id="theme" label="Theme" control={<Select>...</Select>} />
  <SettingsField id="density" label="Density" control={<Select>...</Select>} />
</FormSection>
```

`title` is required: every section has one, and it names what the card holds
below the page title (MCP's server list is "Servers", Hooks' list is "Your
hooks"). There is no untitled section, so a header action can never stretch
across the header and read as a page-level button.

Inside a `SettingsShell` with `pageTitle` / `pageDescription`, a title that
repeats the page title throws in dev builds (`repeatsSettingsCopy`: equal
after NFKC, case, whitespace and end punctuation normalization; short titles
only match exactly, so "Model settings" stays on "Models" in every locale).
Production renders the title as given rather than dropping it. A description
that repeats the page description (or the page description followed by more
words, for descriptions of three or more words) is not rendered.

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
| `--settings-field-copy-gap` | 4px | section title and description |
| `--settings-section-header-gap` | 12px | header (title or description) and card |
| `--settings-section-gap` | 40px | card and the next section header (owned by `SettingsShell`) |

The card -> next header gap is at least 3x the header -> card gap.

Field ramp inside the card (tightest to widest):

| Token | Value | Between |
| --- | --- | --- |
| `--settings-field-copy-gap` | 4px | label and description |
| `--settings-field-control-gap` | 8px | description and control; control, afterControl, error and meta |
| `--settings-field-gap` | 24px | fields |

Tight inside a setting, loose between settings: the field gap is 3x the
control gap, so a field reads as one unit and the next field as a separate
one. The card inset is `--settings-section-padding` (24px; 16px at 760px and
below). There are no separators between fields: stacked fields at a 24px gap
are grouped by proximity alone. Do not add margins or gaps between sections or
fields in product code: render fields directly in the card (component
wrappers return fragments), and use `SettingsFieldGroup` for fields that show
or hide together in their own element. `bun run lint:ds` rejects a `Stack`,
`Inline`, `Grid` or `gap` wrapper around settings fields or sections
(`butler-ds/settings-field-grouping`).

### Card gap by kind

One rule: **fields are always 24px apart, whatever the card's kind.**

| Kind | Holds | Gap between children |
| --- | --- | --- |
| `form` | fields | `--settings-field-gap` (24px) |
| `list` | repeated rows | 12px plus a hairline and 12px padding (25px between rows, fields included) |
| `status` | live status rows (meters, diagnostics) | 12px; 24px when the card holds a field |
| `info` | read-only `KeyValueRow`s | 12px; 24px when the card holds a field |

A `status` or `info` card that holds a `SettingsField` or
`SettingsActionField` as a direct child (`:has(> [data-settings-field])`)
switches its whole card to the field gap, so rows and fields there are spaced
like a form. A card whose content is all fields uses `kind="form"`.

### Header actions

`actions` holds section actions only: add, refresh or check, filter
(`Select size="sm"`) or period (`SegmentedControl size="sm"`), on a
`kind="list"` or `kind="status"` section. Buttons are
`variant="outline" size="sm"` (or `size="icon-sm"`). They sit at the inline
end of the title and stay right-aligned when they wrap under it. The header
never holds a setting (an input, a switch, a number): that is a
`SettingsField` in the card. Any action that removes or resets something is
a `SettingsActionField` row in the card with a description of its effect.
`bun run lint:ds` rejects `actions` on `form` and `info` sections, setting
controls in `actions`, and header buttons that are not outline and small.

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
- Do not nest FormSections, cards or panels for repeated items; use list rows (`CardList`)
- Do not omit the title or repeat the page title

## Tags

form, section, grouping, settings
