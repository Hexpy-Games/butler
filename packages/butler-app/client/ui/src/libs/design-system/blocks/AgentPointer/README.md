# AgentPointer

## What is this block
`AgentPointer` is Butler's own pointer for the transparent overlay layer above a
page (never the page DOM). Modes: observe, click, type, scroll, batch and
parked; tones default, waiting and need-input. A riso arrow with a dark halo
and a white keyline (3:1 on white, black and photo pages), a “Butler” tag,
target rings, a dotted trail and a 400ms glide (`--motion-pointer-glide`).

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
motion (OS, DS scope or `reducedMotion`): no glide, trail or ripple.

## Responsive behavior
Scales with the layer; geometry is the caller's.

## Wrong use cases
- Do not draw it inside the page DOM.
- Do not use it for the user's own pick highlights.

## Tags
browser, pointer, overlay, agent, riso
