# AspectFrame

## What is this component
A square, paint-contained frame (`aspect-ratio: 1`, `contain: layout paint size`) for a canvas or media child that fills it.

## When to use this component
Use it for canvas animations and media marks that must stay square, such as the Butler thinking mark.

## Where to use this component
Status labels, capsules, avatars built from a canvas.

## Why to use this component
Sizing and containment live in the DS instead of inline styles.

## How to use this component
`<AspectFrame size="sm" aria-hidden="true"><canvas ref={ref} /></AspectFrame>`; omit `size` to fill the container width.

## Who can use this component
Product components that draw on a canvas.

## Best practice
Keep drawing code in the product component; the frame only sizes and contains.

## Wrong use cases
Do not use it for icon glyphs. Use `IconSlot`.

## Tags
canvas, media, square, mark

`size="3xl"` follows `--icon-size-3xl` (48px).
