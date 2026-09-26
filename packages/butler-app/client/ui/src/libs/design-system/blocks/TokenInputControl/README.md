# TokenInputControl

## What is this component
A token budget setting control: a numeric input, a DS `Slider` over `min`..`max` and a `value / max` readout.

## When to use this component
Use it for token limits bounded by a model (context limit).

## Where to use this component
Use it as the `control` of a `SettingsField`.

## Why to use this component
It owns parsing (commas, underscores and spaces), clamping and the clamped signal passed to `onCommit`.

## How to use this component
Pass the committed `value`, `min`, `max`, `inputLabel`, `sliderLabel`, `describedBy` and `onCommit(value, clamped)`.

## Who can use this component
Settings containers.

## Best practice
Tell the user when `clamped` is true (a status toast).

## Wrong use cases
Do not use it for percentages. Use `PercentInputControl`. Do not use it for tags; use `Input`.

## Tags
settings, tokens, budget, input, slider
