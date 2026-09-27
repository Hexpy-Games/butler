# ColorSwatchInput

## What is this component

A round native color picker (`<input type="color">`) sized to sit beside a
settings label. The browser owns the picker; the DS owns the swatch shape,
border and focus treatment.

## When to use this component

Use it for a single theme color in settings (main-screen theme colors). Pair it
with a visible label and the current hex value so the choice is readable
without opening the picker. Do not use it for palettes of preset colors; use a
`SegmentedControl` or a list of choices instead.

## Accessibility

Always pass `aria-label` (or associate a `<label>`); the swatch has no text.
