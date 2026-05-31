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

## Who can use this component
Settings containers and form-oriented blocks.

## Best practice
Use real labels and keep validation state in the caller. Keep label,
description, and control in a vertical rhythm so translations and narrow
viewports do not separate the label from its field.

## Wrong use cases
Do not use it for read-only inspector facts. Use `KeyValueRow`.
Do not put toggles in section headers when the toggle is itself a setting.

## Tags
settings, field, form, responsive
