# ChoiceCard

## What is this block
Big, recognizable choices. `ChoiceCard` is a full-width row (logo tile, title
with an optional Tag, one-line description, trailing chevron or meta);
`ChoiceTile` is a compact grid tile (logo, a name that wraps to two lines, a
one-line description). `ChoiceCardList` and `ChoiceTileGrid` lay them out.

## Parts and props

| Export | Props |
| --- | --- |
| `ChoiceCard` | `icon`, `title`, `description`, `tag`, `meta` (replaces the chevron), `chevron` (default on), `state`, `selected` |
| `ChoiceTile` | `icon`, `title`, `description`, `state`, `selected`, `placeholder` (dashed, not available yet), `cornerIcon` |
| `ChoiceCardList` | A `ul`; each child becomes a list item |
| `ChoiceTileGrid` | A `ul` grid: two columns, three when the grid is at least 480px wide |

`state`: `default`, `loading` (spinner, `aria-busy`), `error` (danger border
and description), `disabled` (dimmed, `aria-disabled`; clicks are ignored).

## Equal size
Tiles in a grid are always the same size: rows are `1fr`, the name sits in a
fixed two-line box (clamped with an ellipsis after two lines) and the
description is one line. A tile narrower than 160px (185px at 640px and below, where the type ramp grows) stacks the logo above the
name, so names such as "Other (OpenAI-compatible)" stay readable at 320-375px.

## How to use this block

```tsx
import { ChoiceCard, ChoiceCardList, ProviderLogo, Tag } from "@/butler-ds";

<ChoiceCardList aria-label="Which AI should Butler use?">
  <ChoiceCard icon={<ProviderLogo name="openai" size="lg" />} title="ChatGPT"
    tag={<Tag tone="accent">No key needed</Tag>} description="Sign in with ChatGPT" onClick={pick} />
</ChoiceCardList>
```

## Wrong use cases
- Do not use it for a form value; use `Select` or `SegmentedControl`.
- Do not nest buttons inside a card; the whole card is the button.

## Tags
choice, card, tile, picker, grid
