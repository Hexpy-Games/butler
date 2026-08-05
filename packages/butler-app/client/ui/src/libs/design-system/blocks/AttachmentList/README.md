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

## Who can use this component
Any product container that owns attachment data.

## Best practice
Format file sizes and download URLs outside the design system.

## Wrong use cases
Do not use it for project documents. Use `DocumentTile` or `ResourceTile`.

## Tags
attachment, file, composer, message
