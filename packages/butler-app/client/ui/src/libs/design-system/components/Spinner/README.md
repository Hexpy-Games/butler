# Spinner

`Spinner` is Butler's official indeterminate loading indicator: candidate 2,
**이동하는 절개**. A rounded, monochrome ring with a traveling open gap makes
short waits and active processing recognizable at icon sizes.

## Use

```tsx
import { Spinner } from "@/butler-ds";

// Existing visible status text owns the accessible name.
<span role="status"><Spinner size={16} />{loadingLabel}</span>

// A standalone indicator needs localized copy from the caller.
<Spinner size={24} label={loadingLabel} />
```

`size` is the pixel box size (default 16); supported product sizes include 14,
15, 16, 18, 24, and 32px. `className`, `style`, and SVG attributes are available
for composition. Set color through inherited design tokens, including inverse
button colors. Without `label`, the icon is decorative and `aria-hidden`.

## Motion and ownership

The circle occupies 79% of its circumference with radius 36.5% of the icon box.
Stroke width is 7.1% of size with a 1.35px optical minimum. The shared tokens
`--spinner-duration` (1320ms) and `--spinner-easing` preserve the approved
rotation rhythm. The easing samples `u − 0.43 sin(2πu)/(2π)` at sixteenth-cycle
intervals. CSS interpolates them; maximum angular approximation error is below
0.48 degrees. Rotation belongs to the internal circle, so parent transforms do
not replace it. No JavaScript animation loop is needed.

Reduced motion disables rotation and retains the open-ring silhouette. Keep
the status label visible. The caller owns busy state, disabling, completion,
failure, and cancellation. Mount only while needed and remove promptly when
the existing operation leaves that state; do not delay completion to finish a
revolution or add an unconditional success check.

## Where and why

The DS owns this primitive and its motion. Product consumers include sidebar
activity, project-board sessions, inspector progress, todo progress, and the
composer's busy button. They share the same geometry and motion instead of
animating independent loading icons. `ComposerSendButton` already composes it
when `busy` is true.

Use `Skeleton` for layout placeholders and `ProgressMeter` when the total is
known. Keep the existing `ButlerThinkingMark` for agent identity/activity.
Do not stack a second spinning ring around that waveform or turn static refresh
actions into continuous spinners. Do not reintroduce `LoaderCircle`, dashed
`Circle` imitations, or feature-local spin keyframes.

## Inspect

Find **Spinner** in DS Viewer (`/?visual=design-system`) or run
`bun run render Spinner --viewport=all`. The fixture shows sizes, standalone
accessible naming, inverse button color, and a caller-owned completion change.

Tags: loading, spinner, busy, indeterminate, progress, activity, motion, circle
