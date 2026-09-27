# Skeleton

`Skeleton` is a primitive loading placeholder based on the shadcn/ui skeleton
pattern. It uses Butler design tokens for surface color, radius, and shimmer
animation, and sizes through props (never `className` or `style`):

- `width`: `full`, `3/4`, `2/3`, `1/2`, `2/5`, `1/3`, `1/4`, or a number of
  characters (`ch`, capped at the container).
- `height`: `line` (`--skeleton-height-line`), `title`
  (`--skeleton-height-title`), `control` (`--control-height-lg`), `row`
  (`--touch-target`).
- `shape`: `rect` (default), `pill`, `circle` (width follows height).
- `lines`: a paragraph of N lines with the DS width ramp (86%, 68%, short
  last line); one `label` announces the group.

## SkeletonRows

`SkeletonRows` stacks placeholder rows while a list or form loads (`shape`
`list` or `field`, `rows`, optional `label`). Use it wherever a list would
otherwise flash its empty message before the first result (the automations
list; settings sections use it through `SettingsSection state="loading"`).
