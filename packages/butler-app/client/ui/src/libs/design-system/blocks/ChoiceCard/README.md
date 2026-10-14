# ChoiceCard

## What is this block
Big, recognizable choices. `ChoiceCard` is a full-width row (logo, title
with an optional Tag, one-line description, trailing chevron or meta);
`ChoiceTile` is a compact grid tile (logo, a name that wraps to two lines, a
one-line description). `ChoiceCardList` and `ChoiceTileGrid` lay them out.

## Parts and props

| Export | Props |
| --- | --- |
| `ChoiceCard` | `icon`, `title`, `description`, `tag`, `meta` (replaces the chevron), `chevron` (default on), `state`, `selected` |
| `ChoiceTile` | `icon`, `title`, `description`, `state`, `selected`, `placeholder` (dashed, not available yet), `cornerIcon` (trailing action glyph, centered on the tile's end) |
| `ChoiceCardList` | A `ul`; each child becomes a list item |
| `ChoiceTileGrid` | A `ul` grid: two columns, three when the grid is at least 480px wide |

`state`: `default`, `loading` (spinner, `aria-busy`), `error` (danger border
and description), `disabled` (dimmed, `aria-disabled`; clicks are ignored).

## Alignment
Leading icon = title text size, centered on the title line; brand logos are fitted to the icon-pack grid, so all leading icons share one rule. Trailing controls vertically centered.

- Leading icon: the glyph is the title's text size, whatever size it was
  given (`--icon-size-sm` beside 13px titles, `--icon-size-md` beside the 15px
  titles at 640px and below), and centers on the title's line in one-line and
  two-line cards alike, with no per-icon offset. "Centered" means on the
  letters, not the line box: Typo trims every text role to cap height and
  baseline (`text-box: trim-both cap alphabetic`) and pads it back to the
  role's line height, so the
  glyph meets the letters' centre in every renderer (browsers round the
  baseline inside the line box differently, up to 1px). Brand logos are fitted to
  the icon-pack grid by `ProviderLogo`, so a logo and a line glyph at the same
  size look equally large and equally centered. Mixed one-line and two-line
  lists look the same on every card.
- Trailing controls (chevron, meta such as a size, the loading spinner, the
  error mark, a tile's corner glyph) center vertically on the card, never
  top-right.
- The description starts at the title's left edge, below it.

## Icons
Cards and tiles show the glyph bare (a `ProviderLogo` or an icon) in an
`IconSlot`: never an `IconTile` or any boxed background behind it.
`lint:design` fails on an IconTile passed as a card icon.

## Surface states
- Selected: a hairline (`--border-hairline`) `--accent` border on the
  `--color-info-bg` tint. No border is thicker than 1px.
- Focus: the DS focus ring (`--focus-ring`), not a thicker border.
- Press: the pressed fill of a stretched `Clickable` row (`--selection-strong`)
  fades in under the content on `--motion-fast`. Wide surfaces never scale;
  `--motion-scale-press` is for compact controls only.

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
