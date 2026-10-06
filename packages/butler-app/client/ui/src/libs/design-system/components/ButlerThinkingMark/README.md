# ButlerThinkingMark

## What is this component
Butler's identity mark and its thinking animation (the riso halftone design),
drawn on a canvas inside an `AspectFrame`. `state="idle"` draws the exact
filled logo (fused bowtie and ring). `state="working"` morphs the bowtie straight
into a lit halftone moon in one continuous transformation: the outline, the
fill resolving into dots, the riso blue and fluorescent pink, and the orbiting
light all advance together from one progress value. Back to `idle` is the same
single morph in reverse; it settles on exactly the idle logo and stops drawing.

## Props

| Prop | Values |
| --- | --- |
| `state` | `idle` (default), `working` |
| `size` | Icon size token (`sm` ... `3xl`, 48px); omit to fill the container width |
| `theme` | `dark` (white ink), `light` (near-black ink); omit to follow the nearest `.theme-dark` / `.theme-light` scope, re-read when that scope's class changes (the running simulation continues) |
| `themeColors` | Overrides the key ink per theme |
| `reducedMotion` | Forces reduced motion on or off; default is the OS setting and the DS `data-motion="reduced"` scope |
| `morphKey` | Marks with the same key share one morph: a remount mid-work (pending -> current status) continues instead of restarting from the logo |

## How to use this component

```tsx
import { ButlerThinkingMark } from "@/butler-ds";

<ButlerThinkingMark state={busy ? "working" : "idle"} size="lg" theme={markTheme} />
```

## Motion
- One critically damped spring (`MORPH_SPRING`, k 6, zeta 1: ~0.7s to half,
  ~1.9s to 95%, no overshoot) produces one progress value, and every channel
  reads it with no thresholds or stagger: the outline (ribbon SDF blended into
  the moon's disc SDF, so the lobes pull in while the waist rounds out), the dot
  field (fused fill -> screened dots; each cell keeps its dot, radii change
  continuously, nothing cross-fades), the riso inks and their misregistration,
  and the motion clock. The motion clock runs from the first frame and eases
  (smoothstep, no jolt) to full speed by 30% of the morph (`MOTION_FULL_SPEED_AT`,
  ~0.45s in); from there the thinking loop runs at exactly its intended rate
  while the calm morph finishes, so the loop never crawls. The dots are
  clipped to the traced morph outline, so rest is the exact logo edge; the clip
  is released at 60% of the morph, past the point where it trims nothing.
- The spring starts at zero velocity, so the first frame carries almost none of
  the change; the motion clock stops as the logo returns. The spring and the
  simulation rates are intrinsic to the engine and allowlisted in
  `lint:motion` (`CANVAS_MOTION_ENGINES`).
- Reduced motion (the prop, the OS setting or the DS `data-motion="reduced"`
  scope, via `subscribeReducedMotion()`) stops the frame loop and draws the
  still logo; while working, the canvas breathes in CSS exactly like the
  Spinner's reduced pulse (`calc(--pulse-duration * 2)`, `--spinner-easing`,
  alternate, to opacity 0.45) and settles back from its current opacity over
  `--motion-slow` on `--motion-ease-standard`.
- One shared requestAnimationFrame drives every moving mark on the page (N
  marks, one frame callback). Each mark draws at most 60fps, only while it
  moves, and pauses when offscreen (IntersectionObserver), the tab is hidden,
  or it has settled, and never runs under reduced motion. Canvas is capped at
  DPR 2 and sized on resize only; per-frame drawing allocates nothing.
- If the product must remount a working mark (a different parent for pending
  and current status), give both the same `morphKey`; a shared simulation
  advances once per frame however many marks show it.

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
