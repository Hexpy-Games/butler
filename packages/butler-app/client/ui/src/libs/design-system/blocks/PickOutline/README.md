# PickOutline

## What is this block
`PickOutline` draws the user's pick marks in the transparent overlay layer
above a page (never the page DOM): a dashed outline with a size tag on the
element under the pointer, and solid, tinted outlines with an index badge on
each pick, numbered in pick order. Every mark is the pick ink
(`--browser-pick-ink`) between white keylines, so it reads 3:1 on white,
black and photo pages (`pickOutlineContrast.test.ts`).

## When to use this block
Use it in the overlay renderer while pick mode is on (`hover` and `picks`)
and while a kept selection stays on the tab (`picks` only).

## Container vs Presenter
Pure presenter with no App store, like `AgentPointer`: the overlay renderer
hit-tests the page and passes rects in layer pixels (page CSS pixels × page
scale), the hover tag text and the picks in order. It always draws with the
light inks, since it sits on web pages rather than Butler's chrome.

## Usage

```tsx
<PickOutline width={layer.width} height={layer.height} hover={hoverRect} hoverLabel={`${tag} · ${w} × ${h}`}
  picks={picks.map((pick) => ({ id: pick.id, rect: pick.rect }))} reducedMotion={reduced} />
```

## Accessibility
Decorative (`aria-hidden`); `SelectionBar` names the count and the actions.
Reduced motion (OS, DS scope or `reducedMotion`): the hover outline does not
fade in and new badges do not pop.

## Responsive behavior
Geometry is the caller's. The hover tag sits above the outline's end, inside
the outline at the page's top edge and at the outline's start near the left
edge; badges stay inside the layer.

## Wrong use cases
- Do not draw it inside the page DOM.
- Do not use it for what Butler acts on; that is `AgentPointer`'s ring.

## Tags
browser, pick, highlight, outline, overlay
