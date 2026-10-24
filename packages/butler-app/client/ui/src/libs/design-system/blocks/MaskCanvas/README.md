# MaskCanvas

## What is this block
A picture with a paint layer. The user paints the region an image edit may
change (brush), removes paint (eraser) and steps back (undo). While the edit
runs the painted region shimmers; the result then fades in inside that region
only.

## When to use this block
The image editor: marking the region to change before sending an edit
instruction, and showing that edit's progress and result.

## Container vs Presenter
The block owns painting, the mask export and the motion. The container owns
the toolbar (tool, brush size, undo button), the instruction and sending, and
which picture is shown (versions, compare).

## Usage

```tsx
const canvas = useRef<MaskCanvasHandle>(null);
<MaskCanvas ref={canvas} src={url} width={1536} height={1024} alt={alt}
  tool={tool} brushSize={size} onChange={({ strokes, empty }) => setCanUndo(strokes > 0)}
  generating={sending} resultSrc={result} onResultShown={showNewVersion}
  compareSrc={holding ? originalUrl : undefined} />

const mask = await canvas.current?.toMask(); // PNG, transparent where painted; null if empty
```

- `width`/`height` are the picture's own pixels; the mask has exactly that
  size, whatever the frame's size on screen.
- `brushSize` is in screen pixels.
- `toMask()` follows the alpha-mask convention: alpha 0 marks the edit region,
  opaque pixels are kept; brush edges are soft.
- `defaultStrokes` restores a kept mask (a retry) on a new picture.
- `compareSrc` shows another picture (the original) and hides the paint while
  set; painting is off meanwhile, as it is while `generating` or `disabled`.

## Motion
`generating`: a light band sweeps through the painted region on
`--shimmer-duration`, looping on `--motion-loop-count`. `resultSrc`: the
picture fades in over `--motion-deliberate`, clipped to the painted region,
then `onResultShown` runs. Reduced motion stops the band; the fade stays.

## Responsive behavior
Fills its container and keeps the picture's ratio inside it (container query
units), so it works in a side panel and full screen on phones.

## Wrong use cases
- Do not export a mask from a scaled copy of the picture.
- Do not use it as a picture viewer; use `ImageViewer`.

## Tags
image, mask, edit, canvas, brush, motion
