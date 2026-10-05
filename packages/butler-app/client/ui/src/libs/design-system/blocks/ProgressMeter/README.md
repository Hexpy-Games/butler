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
Pass a 0-100 value and optional label, meta, accessible name, and tone.

Use `ariaLabel` when the visible label and percentage need a complete
accessible description, such as `"5시간 한도: 90% 남음"`.

## Who can use this component
Any UI that has already computed a bounded percentage.

## Best practice
Clamp and label domain units in the caller when the source value is not a percentage.

## Wrong use cases
Do not use it for indeterminate loading. Use an activity/status row.

## Tags
progress, meter, status, inspector

## Bare variant

`bare` renders only the 4px track and fill, without the label row, for inline
bars inside rows and statistics lists. Name it with `ariaLabel`:

```tsx
<ProgressMeter bare value={percent} ariaLabel={copy.changes(count)} />
```

Product code must not rebuild bars with `track`/`fill` spans and inline widths.


## Motion
The fill spans the track and scales with `transform: scaleX(value)` from the inline start over `--motion-deliberate` (decelerate), so value changes never animate `width`. Reduced motion changes it instantly.

### Unknown total

Use `indeterminate` with a label and optional received-byte `meta`. It renders
a 12px spinner beside one caption line, without a track or numeric percentage.
`value` is optional in this state. Under reduced motion the spinner is static.
