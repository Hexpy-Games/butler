# Badge

## What is this component

Badge is a filled pill naming a plan (Plus, Pro, Enterprise).

## Props

| Prop | Values |
| --- | --- |
| `children` | The plan name in its copy casing. CSS sets it in capitals. |
| `tooltip` | An optional explanation on hover and keyboard focus. It makes the badge a focus stop. |

## How to use this component

```tsx
import { Badge } from "@/butler-ds";

<Badge tooltip="Available on Plus and above.">Plus</Badge>
```

A badge never acts. It cancels its click, so clicking it inside a `<label>` leaves the labelled control unchanged.

## Look

The borderless pill is 18px tall inside the 22px Tag sm slot and uses `--radius-pill`. The label is caption size minus 1px, semibold, with 0.06em tracking. It keeps the same appearance on hover and press, and the cursor stays the default.

## Motion

The static sheen band moves for one `--motion-sheen-lap` lap, then waits for `--motion-sheen-pause`. Laps run only while the badge is on screen in a visible, focused window. Under reduced motion the band stays static.

## Wrong use cases

- Use `Tag` for a status.
- Use `PillButton` for an action.

## Tags

badge, plan, plus, pro, tier
