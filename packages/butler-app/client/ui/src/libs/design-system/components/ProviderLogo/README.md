# ProviderLogo

## What is this component
The logo of an AI service or a local model server (ChatGPT/OpenAI, Claude,
Gemini, Grok, Qwen, Kimi, Z.AI, DeepSeek, Upstage, OpenCode, Ollama, LM
Studio), drawn from the vendored SVG files in `logos/` exactly as shipped.

## Props

| Prop | Values |
| --- | --- |
| `name` | `openai`, `claude`, `anthropic`, `gemini`, `grok`, `qwen`, `kimi`, `zai`, `deepseek`, `upstage`, `opencode`, `ollama`, `lmstudio` |
| `size` | `sm` (14px), `md` (16px, default), `lg` (20px) |
| `label` | Accessible name; omit when visible text names the service |

## How to use this component

```tsx
import { IconTile, ProviderLogo } from "@/butler-ds";

<IconTile><ProviderLogo name="claude" size="lg" /></IconTile>
```

## Source and license
- `anthropic` (the provider) and `claude` (the product) share `claude-color.svg`.
- The files come from `@lobehub/icons-static-svg` 1.95.1 (MIT). Only these twelve
  files are vendored; the package is not a dependency. `logos/NOTICE` carries
  the license and the trademark note.
Vendored SVG bytes and license notices are verified by the asset tests; rendered logos are checked in the DS Viewer.
  fails if a string drifts from its file.
- `upstage-color.svg` has one change from upstream: its misspelled `<title>`
  ("Upsate") reads "Upstage". `logos/NOTICE` records it.
- Kimi uses the monochrome file: the color file has white lettering that
  disappears on light surfaces.

## Fitting a logo
The vendored files are full-bleed (the mark touches the 24-unit box), but the
icon pack (Hugeicons) draws on a keyline: a 24 grid whose marks span 20 units
(2 to 22), centred on (12, 12) by their bounding box. So that a logo and a line
glyph at the same size look equally large and equally centred, each logo has a
`fit` viewBox in `providerLogoSvgs.ts`, and `ProviderLogo` renders with it. The
shipped drawing is never edited; the viewBox only moves and scales it.

To fit a new logo:
1. Rasterise the vendored SVG at 40px per unit and take its ink box (alpha above
   0.5): `x, y, w, h` in grid units.
2. `s = max(w, h) / 20`, centre `cx = x + w / 2`, `cy = y + h / 2`.
3. `fit = "${cx - 12s} ${cy - 12s} ${24s} ${24s}"` (three decimals).
4. Check it beside a line glyph in a card in the app: equal visual size, and
   both centred on the title line.

Optical exceptions live in the logo's `fit` only (never in CSS) and carry a
one-line comment saying why. The only one is the Claude mark under the `claude`
name (Claude, Claude Code): the mark is short at the bottom, so its fit sits it
1px lower at 14px. `anthropic` draws the same file on the plain centred fit.

## Themes
Monochrome logos paint with `currentColor` (the text color), so they stay
visible in light and dark. Color logos (Claude, Gemini, Qwen, DeepSeek, Upstage) keep their fills,
which read on both themes. Gradient ids are made unique per rendered logo.

## Wrong use cases
- Do not recolor, stretch or crop a logo, and do not draw a brand with a generic icon.
- Do not add a logo without vendoring its file and listing it in `logos/NOTICE`.

## Tags
logo, brand, provider, service, model
