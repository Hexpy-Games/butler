# AttachmentList

## What is this component
A responsive list of file attachments.

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

## Who can use this component
Any product container that owns attachment data.

## Best practice
Format file sizes and download URLs outside the design system.
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
attachment, file, composer, message
