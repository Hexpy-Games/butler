# ElementChip

## What is this block
`ElementChip` is a picked page element as an attachment: its crop, a short
title and the site, with remove in the composer and read-only in sent
messages. `AttachmentList` renders it for items with `element`.

## When to use this block
Use it (through `AttachmentList`) for elements picked in the browser and
added to the chat.

## Container vs Presenter
The App maps picks to `AttachmentListItem`s with `element: { site }` and
`thumbnail.src` (the crop).

## Usage

```tsx
<AttachmentList variant="chips" onRemove={remove} items={[{ id, name: title, element: { site: host }, thumbnail: { src: crop } }]} />
```

## Accessibility
Remove reads “Remove: <title>”; the tooltip carries the full title and site.

## Responsive behavior
Chips cap at 220px and wrap; at phone widths they shrink to the row.

## Wrong use cases
- Do not show element picks as bare image chips.

## Tags
attachment, chip, element, composer
