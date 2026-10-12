# MediaFrame

## What is this component
A picture in a fixed-shape frame (`1:1`, `4:5`, `3:4`, `16:10` default, `16:9`)
on the `--muted` matte, with the control radius.

Every picture is whole (`contain`) and never spills. Once it loads, a typical
shape (width/height 0.75–2.4: an object shot, a square, a page view) spans the
frame, letterboxed on the matte. An extreme shape (a heading strip, a line of
text, a tall column) would become a full-width band of its page colour flush
with the frame's edges; it sits inset on the matte with a hairline instead.
`mediaFrameFit(width, height)` is that rule.

States (`data-fit`): `pending` (hidden until the shape is known), `fill`,
`matte`, `failed` (load error) and `empty` (no `src`). Failed and empty draw
the same matte, so a row of cards keeps its rhythm.

## When to use this component
The picture slot of `ItemCard` and `LibraryCard`, gallery rails and thumbnails
of collected pictures.

## How to use this component
```tsx
<MediaFrame aspect="4:5" src={asset.url} alt={asset.alt} />
```
`children` are overlays on the frame (a kind `Tag`, a checkbox); the owner
positions them. `clearTop` keeps a matted picture clear of a top-corner
overlay.

## Accessibility
`alt` defaults to empty (decorative), for frames whose owner names the item.
The frame has no click behavior; the owning card makes it a target.

## Responsive behavior
The frame fills its container's width and keeps its aspect.

## Wrong use cases
- Do not pre-crop or pad pictures to the frame's shape.
- Do not tint or invert pictures in dark mode.
- Do not use it for canvases or animated marks (`AspectFrame`).

## Tags
image, picture, media, aspect, matte, thumbnail
