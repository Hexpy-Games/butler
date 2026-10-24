# SettingsField

## What is this component
A responsive label-description-control row for settings.

## When to use this component
Use it for editable settings fields, toggles, selects, and token inputs.

## Where to use this component
Use it in settings pages and configuration forms.

## Why to use this component
It fixes label/control spacing and mobile stacking in one place.

## How to use this component
Pass an id, label, optional description, control node, and meta text.
`afterControl` sits directly under the control: its live state (a download in
progress, a result line with a Cancel) or a small action on its value
(Remove key). `meta` holds facts about the setting (sizes, counts, last
change) and comes last; it renders as a block, so a `MetaList` fits.
Pass `error` (localized, short) when the saved or entered value is invalid:
it renders a `FieldError` under the control, marks the control
`aria-invalid` and adds the error id to its `aria-describedby`. The
description id is merged into `aria-describedby` too, without duplicating ids
the control already names. Clear `error` once the value is valid again.

## Who can use this component
Settings containers and form-oriented blocks.

## Best practice
Use real labels and keep validation state in the caller. Keep label,
description, and control in a vertical rhythm so translations and narrow
viewports do not separate the label from its field.
Tight inside a setting, loose between settings. The label is the medium
body-size `Label`, the description a secondary-tone caption
`--settings-field-copy-gap` (4px) below it, and the control
`--settings-field-control-gap` (8px) below the description (status, error
and meta follow at the same 8px). Fields sit `--settings-field-gap` (24px,
3x the control gap) apart inside a `FormSection` card, so one setting reads
as a unit and the next as a separate one; the card holds only fields, and
the section header sits above it.

The card owns the field gap. Render fields directly in the section card:
never wrap sibling fields in a `Stack`, `Inline` or `Grid` (or any element
with a `gap`), and keep component wrappers to fragments. Fields that show or
hide together and need their own element (an id for `aria-controls`, a
disclosure panel, a list row editor) go in `SettingsFieldGroup`, which spaces
them by the same field gap. `bun run lint:ds` enforces this
(`butler-ds/settings-field-grouping`).
Every control, switches included, stacks under its copy: label, then
description, then control. There is no inline layout; a control beside its
label breaks the reading flow. Buttons that act on the field (add, choose)
go in the control slot too, never to the right of the text. A setting
that is only an action (free up space, reset, clear) is a
`SettingsActionField`.

## Wrong use cases
Do not use it for read-only inspector facts. Use `KeyValueRow`.
Do not put toggles in section headers when the toggle is itself a setting.
Do not space fields with `Stack gap`; the card (or `SettingsFieldGroup`) does.

## Tags
settings, field, form, responsive
