# IconSlot

## What is this component
A fixed square (`--icon-size-*` or the sidebar density icon size) that centers one glyph.

## When to use this component
Use it for row glyphs, status marks and timeline markers that must keep one column width.

## Where to use this component
Sidebar rows, list rows, timelines.

## Why to use this component
Glyphs of different shapes line up without per-screen CSS.

With text, match the glyph to the type role (`sm` with Caption, `md` with Body).
For multi-line text use a start-aligned row and `minHeight="line"` so the glyph centers
in the first line box, never in the whole paragraph. Use a plain slot rather than a
tinted IconTile for text list glyphs.

## How to use this component
`<IconSlot size="sidebar"><Briefcase /></IconSlot>`; `minHeight="line"` keeps it one line tall; `passive` lets pointer events reach the row beneath.

## Who can use this component
Product components and blocks.

## Best practice
Label status marks (`role="status"`, `aria-label`).

## Wrong use cases
Do not use it for clickable icons. Use `IconButton` or `GlyphToggle`.

## Tags
icon, glyph, status, slot
