# AnimatedNumber

## What is this component
AnimatedNumber shows a number that counts from its previous value to a new one over `--motion-deliberate` with the decelerate easing. It is the DS way to animate metric and usage counts.

## Props

| Prop | Values |
| --- | --- |
| `value` | number to show |
| `format` | `(value: number) => string`; default `Intl.NumberFormat` in the document language |
| `live` | `true` adds `aria-live="polite"` to the final value |

## How to use this component

```tsx
import { AnimatedNumber, Typo } from "@/butler-ds";

<Typo.MetricValue>
  <AnimatedNumber value={usage.requests} format={formatCompact} />
</Typo.MetricValue>
```

## Behavior
- First render shows the value; only changes animate.
- Tabular numerals plus invisible start/end sizers in the same grid cell keep the width stable (no layout shift).
- Reduced motion: the value swaps instantly and fades in over `--motion-fast`.
- The animated digits are `aria-hidden`; assistive tech reads the final formatted value from static visually hidden text.

## Best practice
- Pass a number and a `format`, not a preformatted string.
- Use it inside `Typo.MetricValue`, `MetricCard` or caption text; it inherits font size and color.

## Wrong use cases
- Do not animate identifiers, dates or prices the user is typing.
- Do not count values that change more than a few times per second; show them statically.

## Tags
number, metric, count, motion, tabular
