# Skeleton

`Skeleton` is a primitive loading placeholder based on the shadcn/ui skeleton
pattern. It accepts normal `className` and `style` sizing and uses Butler design
tokens for surface color, radius, and shimmer animation.

## SkeletonRows

`SkeletonRows` stacks placeholder rows while a list or form loads (`shape`
`list` or `field`, `rows`, optional `label`). Use it wherever a list would
otherwise flash its empty message before the first result (the automations
list; settings sections use it through `SettingsSection state="loading"`).
