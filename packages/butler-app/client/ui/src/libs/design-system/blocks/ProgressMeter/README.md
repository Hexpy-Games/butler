# ProgressMeter

## What is this component
A token-backed horizontal progress meter.

## When to use this component
Use it for percentages, budgets, and compact status quantities.

## Where to use this component
Use it in inspectors, settings, and activity summaries.

## Why to use this component
It provides accessible progress semantics without domain math.

## How to use this component
Pass a 0-100 value and optional label, meta, and tone.

## Who can use this component
Any UI that has already computed a bounded percentage.

## Best practice
Clamp and label domain units in the caller when the source value is not a percentage.

## Wrong use cases
Do not use it for indeterminate loading. Use an activity/status row.

## Tags
progress, meter, status, inspector
