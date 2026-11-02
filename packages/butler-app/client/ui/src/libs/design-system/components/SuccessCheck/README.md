# SuccessCheck

## What is this component
SuccessCheck is the DS completion mark: a check, optionally inside a ring, whose stroke draws in with a subtle scale and fade. The finished shape matches `CheckIcon` (plain) and `CheckCircle2` (ring).

## Props

| Prop | Values |
| --- | --- |
| `size` | Pixel box size, default 16 (use `ICON_SIZE`) |
| `ring` | `true` draws the check inside a ring (LoadingIndicator done state) |
| `animate` | `true` (default) draws on mount; `false` renders the finished check |
| `label` | Accessible name; decorative without it |

## Motion
The ring draws over `--motion-slow`, the check follows after `--motion-menu`, and the whole mark pops from `--motion-scale-check` over `--motion-base` (about 310ms in total). Reduced motion drops the stroke travel and the scale, so only the fade remains. Mount it when the work completes; a new `key` replays it.

## How to use this component

```tsx
import { ICON_SIZE, SuccessCheck } from "@/butler-ds";

<SuccessCheck key={saveCount} size={ICON_SIZE.sm} label="Saved" />
```

## Wrong use cases
- Do not animate checks for rows that were already done when they mounted; pass `animate={false}` or use `CheckCircle2`.
- For a spinner that resolves into done, use `LoadingIndicator` instead of swapping icons by hand.

## Tags
check, success, done, complete, motion
