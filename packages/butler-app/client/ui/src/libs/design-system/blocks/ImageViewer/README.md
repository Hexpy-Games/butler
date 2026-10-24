# ImageViewer

## What is this block
`ImageViewer` is the app's one lightbox: a modal that shows one picture of a
set large on a scrim in the theme's surface tone (`--image-viewer-overlay-bg`,
light or dark with the theme) that blurs the app behind it
(`--image-viewer-overlay-filter`); the picture lifts off it on `--shadow-card`.

- a bar: the position (“2 / 5”) on the start side; the container's `actions`
  (IconButtons) and Close on the end side, on tinted-glass capsules
- the stage: the picture fitted to the window (never upscaled), previous and
  next on its sides
- the caption: the visible line and the source line (favicon, “site · read
  time”)

An item with `kind: "video"` plays on the stage instead: a native `<video>`
with controls, `preload="metadata"`, never autoplaying; its focused controls
keep the arrow keys.

`ImageViewerSurface` is the same layout without the modal; previews render it
`contained` (its own scrim, a fixed height).

## When to use this block
Any picture the user wants to see large: answer card pictures, gallery items,
message images and attachments (pictures and videos), and activity screenshots. Pass the pictures of the same message
or block as `images`, so previous/next walks that set.

## Container vs Presenter
The block owns layout, focus, keys and motion. The container maps records to
`ImageViewerImage` (`src`, `alt`, `caption`, `source`), passes localized
`labels` and builds `actions` for the shown index (open the source page, save
as a `DoneIconButton` that confirms on success, copy). It owns no data and no commands.

## Usage

```tsx
const [index, setIndex] = useState<number | null>(null);
<ImageViewer images={images} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)}
  labels={{ close: t("close"), previous: t("previous"), next: t("next"), position: (n, total) => `${n} / ${total}`, failed: t("failed") }}
  actions={<IconButton label={t("open")} onClick={() => open(images[index!])}><Popup size="sm" /></IconButton>} />
```

## Accessibility
A Radix dialog: focus starts on Close, is trapped and returns to the opener.
Esc and a click on the scrim (not on the picture or a capsule) close. Left and
right arrows page the set; the position is the dialog description. The title is
the caption or alt text.

## Zoom
Pictures open fitted to the stage and zoom from 1x to 4x: double-click or
double-tap toggles 2x at the point, pinch and ctrl/cmd + wheel (trackpad
pinch) zoom around the fingers or cursor, and a drag pans while zoomed (never
past the picture's edges). `+`/`=`, `-` and `0` zoom from the keyboard. Pass
`labels.zoomIn` and `labels.zoomOut` to show zoom buttons beside the actions.
Paging to another picture starts it fitted again; videos do not zoom.

## Motion
The scrim fades; the picture fades and scales in on `--motion-scale-dialog`,
which reduced motion sets to 1, so it only fades.

## Responsive behavior
Fills the window inside the titlebar and safe-area insets at every width; the
caption is at most 640px wide and centered.

## Wrong use cases
- Do not open a picture in a bare `Dialog` or a new window.
- Do not add a second zoom layer around the picture; the viewer zooms and pans itself.

## Tags
image, lightbox, viewer, picture, gallery, overlay, provenance
