# GlyphToggle

## What is this component
A row glyph that doubles as a toggle (pin, favorite): the glyph keeps its column width and swaps to the toggle glyph on hover and keyboard focus.

## When to use this component
Use it in sidebar rows where the leading glyph is also the pin control.

## Where to use this component
Sidebar and navigation rows.

## Why to use this component
It keeps a full hit target (`--control-hit-target`) over a small glyph without row CSS.

## How to use this component
`<GlyphToggle glyph={<Briefcase />} toggleGlyph={<Sparkles />} pressed={pinned} label="Butler site Pin" onClick={toggle} />`

## Who can use this component
Sidebar row components.

## Best practice
Stop click, key and pointer propagation when the row itself is clickable or draggable.

## Wrong use cases
Do not use it for standalone actions. Use `IconButton`.

## Tags
pin, favorite, toggle, sidebar, glyph
