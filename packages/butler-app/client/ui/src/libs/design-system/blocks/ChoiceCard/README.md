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
| `ChoiceCheckCard` | `icon`, `title`, `description`, `checked`, `onCheckedChange`, `disabled`, `disabledReason` (tooltip; stays focusable) |
| `ChoiceCardList` | A `ul`; each child becomes a list item |
| `ChoiceTileGrid` | A `ul` grid: two columns, three when the grid is at least 480px wide |

`state`: `default`, `loading` (spinner, `aria-busy`), `error` (danger border
and description), `disabled` (dimmed, `aria-disabled`; clicks are ignored).

## Alignment
In a `ChoiceCard` the logo tile and the trailing chevron or meta center on the
title's line (the first line), never on title + description; the description
runs below the title.

## Multi-select (check cards)
`ChoiceCheckCard` is the multi-select member of the family: the same card
surface, padding, radius and selected look as `ChoiceCard`, the logo tile on the
left on the title line, and a square check box at the right in place of the
chevron. The whole card is a `role="checkbox"` with `aria-checked`; click or
Space toggles it. Put the cards in a `ChoiceCardList role="group"` labelled by
the step title or a legend. Use it to pick several things to bring over (tools,
items, files); use `Switch` only for settings that take effect at once, and
radio rows (`ChoiceCard role="radio"`) for one choice.

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

## Picking several
Pass `role="group"` on `ChoiceCardList`; each card takes `role="checkbox"`,
`aria-checked`, `selected`, `chevron={false}` and, when picked, a `CheckIcon`
as `meta` (the check sits on the right). Use this, not a list of `Switch`es,
when people pick items to bring in or act on.

## Wrong use cases
- Do not use it for a form value; use `Select` or `SegmentedControl`.
- Do not nest buttons inside a card; the whole card is the button.

## Tags
choice, card, tile, picker, grid
