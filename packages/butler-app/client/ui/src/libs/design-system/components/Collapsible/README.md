# Collapsible

## What is this component
Collapsible reveals disclosure content with a height + opacity transition.
Content mounts when `open` turns true, grows from 0 to its natural height
through `interpolate-size: allow-keywords`, and unmounts after the collapse
transition. `DisclosureRow` and the Work Activity tool rows use it, so tool
and activity details expand the same way everywhere.

## Props

| Prop | Values |
| --- | --- |
| `open` | `boolean` |
| `children` | disclosure content |
| other `div` attributes | `id`, `role`, `aria-*`, `data-test-class` |

## How to use this component

```tsx
import { Collapsible } from "@/butler-ds";

<Collapsible open={expanded} id={detailsId}>
  {details}
</Collapsible>
```

## Best practice
- Enter uses `--motion-base`/standard; collapse uses `--motion-exit-base` with
  accelerate. Content that starts open does not replay the reveal.
- Reduced motion keeps the opacity fade; the height changes instantly.
- Keep the toggle (`aria-expanded`, `aria-controls`) on the trigger.

## Wrong use cases
- Do not animate `grid-template-rows` or `max-height` in product CSS for
  reveals; use Collapsible.
- Do not use it for overlays; use Popover or Dialog.

## Tags
motion, disclosure, reveal, expand, collapse, interpolate-size
