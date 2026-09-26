# PercentInputControl

## What is this component
A percentage setting control: a numeric input, a DS `Slider` and a percent readout.

## When to use this component
Use it for percentage settings that need both a feel and an exact value (reasoning budgets, thresholds).

## Where to use this component
Use it as the `control` of a `SettingsField`.

## Why to use this component
It owns the commit rules (clamp to `min`/`max`, round, skip unchanged values, roll back when `onCommit` resolves `false`).

## How to use this component
Pass the committed `value`, `inputLabel`, `sliderLabel`, `describedBy` (the field help id) and `onCommit`.

## Who can use this component
Settings containers.

## Best practice
Persist in `onCommit` and resolve `false` on failure so the control shows the saved value again.

## Wrong use cases
Do not use it for read-only progress. Use `ProgressMeter`. Do not use it for token budgets. Use `TokenInputControl`.

## Tags
settings, percent, input, slider
