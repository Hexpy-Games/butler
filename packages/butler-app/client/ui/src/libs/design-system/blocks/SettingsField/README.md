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
The label is the medium body-size `Label`, the description a secondary-tone
caption `--settings-field-copy-gap` (6px) below it, and the control
`--settings-field-control-gap` (12px) below the description. Fields sit
`--settings-field-gap` (20px) apart inside a `FormSection` card; the card
holds only fields, and the section header sits above it.
Every control, switches included, stacks under its copy: label, then
description, then control. There is no inline layout; a control beside its
label breaks the reading flow. Buttons that act on the field (add, choose)
go in the control slot too, never to the right of the text.

## Wrong use cases
Do not use it for read-only inspector facts. Use `KeyValueRow`.
Do not put toggles in section headers when the toggle is itself a setting.

## Tags
settings, field, form, responsive
