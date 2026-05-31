# Slider

## What is this component
Slider is a native range input styled with Butler design tokens.

## When to use this component
Use it for bounded numeric settings where users benefit from adjusting a value relative to a minimum and maximum.

## Where to use this component
Use it in settings forms, filter controls, and configuration panels alongside a numeric input when exact entry is also important.

## Why to use this component
It communicates range and proportion better than a chip or free text input while keeping native keyboard and accessibility behavior.

## How to use this component
Pass `min`, `max`, `value`, optional `step`, and `onValueChange`. Provide an accessible label or connect it to a field label.

## Who can use this component
Design-system blocks and Butler product containers can use Slider through `@/butler-ds`.

## Best practice
- Pair sliders with a numeric input when exact values matter.
- Use meaningful min, max, and step values.
- Do not use sliders for unbounded or categorical choices.

## Wrong use cases
- Do not use it for tags or token lists; use `TokenInputControl`.
- Do not use it for model or permission choices; use `Select` or `FilteredSelectPopover`.

## Tags
form, range, settings, numeric, slider
