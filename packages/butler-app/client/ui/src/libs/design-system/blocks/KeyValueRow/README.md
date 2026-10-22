# KeyValueRow

## What is this component
A compact row for label, value, metadata, and optional swatch.

## When to use this component
Use it for inspector facts, settings summaries, and diagnostics.

## Where to use this component
Use it inside inspector panels, cards, and detail surfaces.

## Why to use this component
It keeps scan-friendly key/value alignment reusable.

## How to use this component
Pass display-ready label, value, description, meta, or swatch nodes.

- `swatchColor`: a color for the 10px round swatch on the label line.
- `swatchPattern`: `solid` (default) or `hatched`, the UsageBars subtask
  hatch on `swatchColor`:
  `repeating-linear-gradient(135deg, c 0 2px, color-mix(in srgb, c var(--hatch-alpha), transparent) 2px 4px)`.
- `onHighlightChange(highlighted)`: links the row to a chart as its legend.
  The row becomes one tab stop, a group named by its label and value, and
  reports mouse hover and keyboard (`:focus-visible`) focus (`true`) and their
  end (`false`); a click alone leaves no highlight once the pointer leaves.
  The caller maps it to the chart, e.g.
  `UsageBars emphasis`. It draws the shared focus ring, whose outer edge stays
  within `--focus-ring-room` of the row.

```tsx
<KeyValueRow label="하위 작업" value="4.5만 · 46%" valueTextSize="caption"
  swatchColor="var(--context-chart-5)" swatchPattern="hatched"
  onHighlightChange={(on) => setEmphasis(on ? "subtask" : null)} />
```

## Who can use this component
Product containers and higher-level blocks.

## Best practice
Format numbers and units before passing them in.

## Wrong use cases
Do not use it for editable fields. Use `SettingsField`. Do not use
`onHighlightChange` as a click action; it only mirrors hover and focus.

## Tags
key-value, inspector, metadata, summary, legend, hatch
