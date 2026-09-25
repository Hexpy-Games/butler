# Presence

## What is this component
Presence keeps one element mounted through its exit animation. While
`present` is true the child carries `data-state="open"`; when it turns false
the child switches to `data-state="closed"` and unmounts when its CSS exit
animation ends (immediately when it has none). `usePresence(present)` exposes
the same logic for components that render through a portal, such as Tooltip.

## Props

| Prop | Values |
| --- | --- |
| `present` | `boolean` |
| `motion` | `none` (default; the child styles its own `[data-state]` keyframes), `fade`, `rise` (fade + `--motion-distance-sm`) |
| `children` | one element that accepts `ref`, `className` and `data-state` |

## How to use this component

```tsx
import { Presence } from "@/butler-ds";

<Presence present={open} motion="rise">
  <div>{panel}</div>
</Presence>
```

## Best practice
- Enter uses `--motion-base` with decelerate; exit uses `--motion-exit-base`
  with accelerate. Reduced motion keeps the fade and drops the rise.
- Prefer Radix `data-state` for Radix overlays; Presence is for DS surfaces
  that are not Radix primitives.

## Wrong use cases
- Do not wrap virtualized rows; they remount on scroll and would replay the
  entrance. Animate only newly inserted content.
- Do not declare enter/exit keyframes in product CSS; use `motion`.

## Tags
motion, enter, exit, mount, animation, presence
