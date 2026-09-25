# FormSection

## What is this block

FormSection is a Butler design-system block for grouping related form fields under a titled section.

## When to use this block

Use FormSection in settings panels, configuration dialogs, or multi-section forms where fields need logical grouping.

Use it as the bordered top-level card for a settings group. Repeated editable
items inside it should be separate bordered rows or panels, not loose text.

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
```

## Hierarchy and spacing

A settings page reads page title -> section -> field -> description:

| Level | Type | Tone |
| --- | --- | --- |
| Page title (`SettingsHeader`) | `Typo.H2` 24px / 620 | primary |
| Section title (FormSection) | `Typo.H4` as `h3`, 18px / 560 | primary |
| Section description | `Typo.Body` at 13px (`--font-size-2`), max 60ch | secondary |
| Field label (`SettingsField`) | `Label` 14px / 500 | primary |
| Field description | `Typo.Caption` 12px | secondary |

Spacing follows a proximity ramp (tokens, tightest to widest):

| Token | Value | Between |
| --- | --- | --- |
| `--settings-field-copy-gap` | 6px | label and description (also section title and description) |
| `--settings-field-control-gap` | 12px | description and control, control and meta |
| `--settings-section-header-gap` | 16px | header divider and first field |
| `--settings-field-gap` | 20px | fields |
| `--settings-section-gap` | 32px | sections (owned by `SettingsShell`) |

The card inset is `--settings-section-padding` (24px; 16px at 760px and
below). The section header (title + description) is its own block: it ends
with `--space-lg` padding and a hairline divider, so the section's copy never
reads as another field (the GitHub Subhead / Vercel / Stripe settings
pattern). There are no separators between fields: stacked fields at a 20px gap
are grouped by proximity alone. Do not add margins or gaps between sections or
fields in product code.

## Accessibility

- Uses semantic section element
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
- Do not nest FormSections for repeated editable items; use a repeated row or panel

## Tags

form, section, grouping, settings
