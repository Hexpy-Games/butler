# ProviderLogo

## What is this component
The logo of an AI service or a local model server (ChatGPT/OpenAI, Claude,
Gemini, Grok, Qwen, Kimi, Z.AI, OpenCode, Ollama, LM Studio), drawn from the
vendored SVG files in `logos/` exactly as shipped.

## Props

| Prop | Values |
| --- | --- |
| `name` | `openai`, `claude`, `gemini`, `grok`, `qwen`, `kimi`, `zai`, `opencode`, `ollama`, `lmstudio` |
| `size` | `sm` (14px), `md` (16px, default), `lg` (20px) |
| `label` | Accessible name; omit when visible text names the service |

## How to use this component

```tsx
import { IconTile, ProviderLogo } from "@/butler-ds";

<IconTile><ProviderLogo name="claude" size="lg" /></IconTile>
```

## Source and license
- The files come from `@lobehub/icons-static-svg` 1.95.1 (MIT). Only these ten
  files are vendored; the package is not a dependency. `logos/NOTICE` carries
  the license and the trademark note.
- `providerLogoSvgs.ts` holds the same bytes as strings; `ProviderLogo.test.tsx`
  fails if a string drifts from its file.
- Kimi uses the monochrome file: the color file has white lettering that
  disappears on light surfaces.

## Themes
Monochrome logos paint with `currentColor` (the text color), so they stay
visible in light and dark. Color logos (Claude, Gemini, Qwen) keep their fills,
which read on both themes. Gradient ids are made unique per rendered logo.

## Wrong use cases
- Do not recolor, stretch or crop a logo, and do not draw a brand with a generic icon.
- Do not add a logo without vendoring its file and listing it in `logos/NOTICE`.

## Tags
logo, brand, provider, service, model
