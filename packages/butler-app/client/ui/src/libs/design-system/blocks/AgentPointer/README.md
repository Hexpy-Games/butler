# AgentPointer

## What is this block
`AgentPointer` is Butler's own pointer for the transparent overlay layer above a
page (never the page DOM). Modes: observe, click, type, scroll, batch and
parked; tones default, waiting and need-input. A riso arrow with a dark halo
and a white keyline (3:1 on white, black and photo pages), a “Butler” tag,
target rings, a dotted trail and a 400ms glide (`--motion-pointer-glide`).

## Motion
- **Glide**: each new `at` moves the arrow along a gentle cubic curve (a bow
  of 14% of the travel, at most 64px, arcing upward), eased with
  `--motion-ease-standard`, as transform keyframes (composited). The dotted
  trail is the same curve.
- **Retarget mid-glide**: the new glide starts from the drawn position,
  leaves along the current heading and keeps the current speed, then eases
  into the new target; nothing jumps.
- **Batch**: moves between consecutive stops follow one smooth path through
  every stop (the trail).
- **Rings never morph**: a ring is drawn at its target's geometry from its
  first frame and only fades in (`--motion-fast`); when the target changes,
  the old ring fades out where it was (`--motion-exit-fast`). The same element
  re-measured (85% overlap or more) keeps its ring and moves instantly.
- **Whole-page targets draw no ring**: a target that spans the layer edge to
  edge on one axis and covers 80% of the other (a full or letterboxed page,
  e.g. an observe of the whole viewport) would only outline the PageCard edge,
  which already shows that Butler holds the page.
- **Reduced motion** (OS, DS scope or `reducedMotion`): no glide (the arrow
  jumps), no trail, no ring or stop fades, a static ripple and caret.

## When to use this block
Use it in the overlay renderer while Butler acts on a tab, and parked while
you hold the tab or an approval waits.

## Container vs Presenter
Pure presenter with no App store: the overlay renderer measures targets and
passes layer pixels (page CSS pixels × page scale). It always draws with the
light inks, since it sits on web pages rather than Butler's chrome.

## Usage

```tsx
<AgentPointer mode="click" at={point} target={rect} from={lastPoint} width={layer.width} height={layer.height}
  labels={copy.pointerLabels} reducedMotion={reduced} />
```

## Accessibility
Decorative (`aria-hidden`); `PageBand` announces what Butler does. Reduced
motion (OS, DS scope or `reducedMotion`): no glide, trail, ripple or fades.

## Responsive behavior
Scales with the layer; geometry is the caller's.

## Wrong use cases
- Do not draw it inside the page DOM.
- Do not use it for the user's own pick highlights.
- Do not animate the pointer or its rings from outside (CSS transitions or a
  renderer-side tween): pass the new `at`/`target` and the block moves itself.

## Tags
browser, pointer, overlay, agent, riso
