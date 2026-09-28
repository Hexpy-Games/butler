# IconTile

## What is this component
A rounded square that holds one glyph: a `ProviderLogo` on a choice card, an
icon beside a point in a list, or the state glyph of a setup screen. It is
decorative (`aria-hidden`).

## Props

| Prop | Values |
| --- | --- |
| `size` | `sm` (28px), `md` (36px, default), `lg` (56px), `xl` (64px) |
| `tone` | `neutral` (raised square, default), `accent` (info tint), `danger` (error glyph), `plain` (no surface) |

An animated `ButlerThinkingMark` fills half of a tile, or the whole tile when
`tone="plain"` (the welcome screen mark).

## How to use this component

```tsx
import { IconTile, ProviderLogo, ShieldCheck } from "@/butler-ds";

<IconTile><ProviderLogo name="openai" size="lg" /></IconTile>
<IconTile size="sm" tone="accent"><ShieldCheck size="md" /></IconTile>
```

## Wrong use cases
- Do not use it as a button; use `IconButton`.
- Do not use it for row glyphs that only need a fixed column; use `IconSlot`.

## Tags
icon, logo, tile, glyph
