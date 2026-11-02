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

`fit="cover"` instead fills the frame, cropped from the center, for answer
cards and galleries where every frame in a set should read as one picture.

States (`data-fit`): `pending` (hidden until the shape is known), `fill`,
`matte`, `cover`, `failed` (load error) and `empty` (no `src`). Failed and
empty draw the same matte, so a row of cards keeps its rhythm. With
`placeholder`, they draw a soft tinted surface with one centered mark
instead: the `placeholderIcon` favicon on a light plate, or an image glyph.

## Natural size
`natural={{ width, height }}` gives the picture's own display size in CSS px
(its pixel size divided by its pixel ratio). The frame then takes the picture's
exact shape and is `min(100%, width)` wide: a small picture stays small, a large
one shrinks to its container (a column, a tab, a narrow screen), and the shape is
reserved before the picture loads, so nothing shifts. It sits at the inline
start, like text. `aspect` is ignored. Use it for a picture shown on its own
(the image answer block); keep `aspect` for sets of pictures that must line up.

## Loading
The frame's aspect box is reserved from the first render, so a loading
picture never shifts the layout. While it loads the matte shows; once it has
loaded (`data-loaded`) the picture fades in over the matte (`--motion-slow`,
decelerate). It is a transition, so a new `src` fades from wherever the last
one was. A picture already decoded when the frame mounts (a cached one)
shows at once. A picture that fails while loading shows the placeholder (or
the matte), the placeholder fading in. Under reduced motion (the OS, the
app's setting, or `reducedMotion`, which also forces it off) pictures and
placeholders appear at once.

## When to use this component
The picture slot of `ItemCard` and `LibraryCard`, gallery rails and thumbnails
of collected pictures.

## How to use this component
```tsx
<MediaFrame aspect="4:5" src={asset.url} alt={asset.alt} />
```
```tsx
<MediaFrame aspect="1:1" fit="cover" placeholder placeholderIcon={faviconUrl} src={item.imageUrl} />
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
