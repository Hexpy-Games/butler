# AttachmentList

## What is this component
A responsive list of file attachments: square tiles (`variant="tiles"`), a
list with sizes, or removable chips.

## When to use this component
Use it when a composer, message, or form needs to show attached files.

## Where to use this component
Use it in conversation surfaces, upload previews, and message metadata.

## Why to use this component
It separates file display from upload and URL generation logic.

## How to use this component
Map domain file records into `AttachmentListItem` objects.

Image records may provide a safe, existing URL through `thumbnail`. The list
keeps the thumbnail (or icon), name, remove action, and optional size metadata
in that priority order; the size metadata hides first in narrow containers.

Set `blockedReason` on an item the current context cannot send (an image after
switching to a text-only model, or one whose image support is unknown). The chip stays and stays removable; it dims
and its name tooltip shows the few-word reason.

## Tiles
`variant="tiles"` shows each file as a square face: a picture's cover
thumbnail (`thumbnail.src`, lazy and async decoded, fading in once loaded), a
video's first frame (`video.src`, metadata only, muted, never playing in the
tile) with a play badge and its length, or the file's glyph, `extension`
label, name and (on `wrap`) size. The name keeps one line and ends in an
ellipsis; the type label keeps the extension readable and the tooltip shows
the whole name. A picture that fails to load shows the file face.

- `tileLayout="row"` (composer): 64px tiles in one row that scrolls sideways
  under the shared edge fade, keeping `--focus-ring-room`. A new tile grows
  in; a removed one shrinks out and the rest slide into the gap (reduced
  motion: fades only). The ✕ shows on hover and focus, always on touch.
- `tileLayout="wrap"` (a sent message): 96px tiles, end-aligned and wrapping.
  Every file shows; the list is never truncated. `tileAlign="start"` aligns
  them to the start instead (a document, a task description in a detail pane).

`blockedReason` greys a tile and names the reason in its tooltip.

## Upload status
`upload` marks an item that is still uploading (`"uploading"`) or failed to
(`"failed"`); the container
puts how far or what to do in `meta` ("Uploading 40%", "Over 10 MB"), which
joins the item's accessible name. Uploading: the DS `Spinner` (a picture dims
under a centred glass badge; a file face and a list row show it as their
icon) and `aria-busy`. Failed: the alert icon and a `--danger` border on the
tile (danger tone on a list row's icon). Clear `upload` once the upload ends.

## Opening a file
`onOpen(item)` opens a file inside the app (the image viewer over the
conversation, or the inspector). With it the tile (or the list/chip name) is a
button and `href` is not used; without it a `href` stays a link. Product
attachments always pass `onOpen`: a link would leave the conversation.

## Who can use this component
Any product container that owns attachment data.

## Best practice
Format file sizes and download URLs outside the design system. The container
also maps the extension label (a localized word for an unknown type).
Capability feedback copy is terse and non-intrusive: the disabled state plus a
few-word tooltip, and at most a brief transient toast for a refused drop or
paste. No banners, inline paragraphs, persistent notices, or why/how
explanations.

## Wrong use cases
Do not use it for project documents. Use `DocumentTile`.

## Element chips
Items with `element: { site }` (picked page elements) render as
`ElementChip`: the crop (`thumbnail.src`), the title (`name`) and the site.
They lead the list in one wrapping row, removable when `onRemove` is set
(`removeLabel` names the button) and read-only in sent messages.

## Tags
attachment, file, composer, message, tile, thumbnail, video
