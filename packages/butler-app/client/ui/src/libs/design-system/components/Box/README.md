# Box

## What is this component
Box is the single-surface primitive: padding, radius, background surface and border, all from tokens. It replaces product `.surface`/`.card`/`.rows` CSS module classes.

## Props

| Prop | Values |
| --- | --- |
| `padding`, `paddingX`, `paddingY` | `none`, `xs`, `sm`, `md`, `lg`, `xl`, `2xl` (`--space-*`) |
| `radius` | `none`, `control`, `panel`, `popover`, `pill` (`--radius-*`) |
| `surface` | `none`, `base` (`--surface`), `raised`, `raised-opaque` (`--color-surface-raised-opaque`), `overlay`, `muted` |
| `elevation` | `none`, `card` (`--shadow-card`) |
| `border` | `none`, `hairline` (`--border-hairline` + `--line`), `strong` (`--border-width-strong` + `--line-strong`) |
| `as` | `div`, `section`, `article`, `aside`, `header`, `footer`, `span`, `li` |

Box also takes layout item props (`grow`, `basis`, `minWidth`, `span`, ...).

## How to use this component

```tsx
import { Box, Stack } from "@/butler-ds";

<Box border="hairline" radius="control" paddingX="lg" paddingY="md">
  <Stack gap="md">{content}</Stack>
</Box>
```

## Best practice
- Put layout (gap, direction) on a Stack inside the Box; Box only owns the surface.
- Use Card or SurfacePanel when you need their interaction states.
- A solid card above decorative art (setup wizard, lifecycle windows) is
  `surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg"`.

## Wrong use cases
- Box has no `tone`; use `Notice` or `Tag` for status color.
- Do not pass `className` to add padding or borders; use the props or request a capability.

## Tags
layout, surface, padding, border, radius
