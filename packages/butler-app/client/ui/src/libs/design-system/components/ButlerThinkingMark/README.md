# ButlerThinkingMark

## What is this component
Butler's identity mark and its thinking animation (the riso halftone design),
drawn on a canvas inside an `AspectFrame`. `state="idle"` draws the exact
filled logo (fused bowtie and ring). `state="working"` granulates the bowtie
into halftone dots from the crossing outward, rounds it into a lit moon, orbits
the light and sweeps riso blue and fluorescent pink across the shadows. Back to
`idle`, it settles exactly to the logo and stops drawing.

## Props

| Prop | Values |
| --- | --- |
| `state` | `idle` (default), `working` |
| `size` | Icon size token (`sm` ... `2xl`); omit to fill the container width |
| `theme` | `dark` (white ink), `light` (near-black ink); omit to follow the nearest `.theme-dark` / `.theme-light` scope |
| `themeColors` | Overrides the key ink per theme |
| `reducedMotion` | Forces reduced motion on or off; default is the OS setting and the DS `data-motion="reduced"` scope |

## How to use this component

```tsx
import { ButlerThinkingMark } from "@/butler-ds";

<ButlerThinkingMark state={busy ? "working" : "idle"} size="lg" theme={markTheme} />
```

## Motion
- The morph is a spring (`MORPH_SPRING`, k 9, zeta 0.95) that starts at zero
  velocity, so the first frame carries almost none of the change; the motion
  clock follows the morph and stops as the logo returns. The spring and the
  simulation rates are intrinsic to the engine and allowlisted in
  `lint:motion` (`CANVAS_MOTION_ENGINES`).
- Reduced motion (the prop, the OS setting or the DS `data-motion="reduced"`
  scope, via `subscribeReducedMotion()`) stops the frame loop and draws the
  still logo; while working, the canvas breathes in CSS exactly like the
  Spinner's reduced pulse (`calc(--pulse-duration * 2)`, `--spinner-easing`,
  alternate, to opacity 0.45) and settles back from its current opacity over
  `--motion-slow` on `--motion-ease-standard`.
- The frame loop runs at most 60fps, only while the mark moves, and pauses
  when the mark is offscreen (IntersectionObserver), the tab is hidden, or it
  has settled, and never runs under reduced motion. Canvas is capped at DPR 2; per-frame drawing allocates nothing.

## Done state
Butler finishing a turn is not a task completing: the mark settles back to the
logo, and the status text changes (Thinking -> Worked for 12s). Do not swap in
a `SuccessCheck`. Task rows and steps inside the turn use `LoadingIndicator`
(Spinner -> ringed check) for their own completion.

## Where
Assistant status label (idle for complete, working for active), Steward
composer capsules (`size="sm"`), and the thinking-mark harness
(`/?visual=thinking-mark`).

## Wrong use cases
- Do not use it as a generic loader; use `Spinner` or `LoadingIndicator`.
- Do not swap between `ButlerMarkIcon` and this mark to show a state change;
  flip `state` on one mounted mark or the transition is lost.
- Do not wrap it in a second spinner, recolor its inks in product CSS, or scale
  it with transforms; pick a `size`.

## Tags
brand, identity, logo, butler, thinking, activity, working, motion, halftone, riso, canvas
