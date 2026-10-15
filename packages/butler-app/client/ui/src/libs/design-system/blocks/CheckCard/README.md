# CheckCard

## What is this component
A card that is picked or not. Several `CheckCard`s in a `CheckCardList` let
people choose the items to act on: tools to import from, files and servers to
bring over, things to include. It uses the ChoiceCard surface (border, radius,
padding, hover, press fill, focus ring, selected look and leading glyph) with
a round check indicator in place of the chevron.

| Export | Props |
| --- | --- |
| `CheckCard` | `icon` (optional), `title`, `description`, `checked`, `onCheckedChange`, `disabled`, `disabledReason` (tooltip; stays focusable) |
| `CheckCardList` | A labelled `ul` with `role="group"`; pass `label` or `aria-labelledby`; each child becomes a list item |

## When to use this component
- Choosing several items before one action runs on them (Import, Next).
- Not for one choice among several: use `ChoiceCard` radio rows.
- Not for a setting that is on or off and takes effect at once: use `Switch`.

## How to use this component
```tsx
import { CheckCard, CheckCardList, ProviderLogo } from "@/butler-ds";

<CheckCardList aria-labelledby="import-title">
  <CheckCard icon={<ProviderLogo name="claude" />} title="Claude Code" description="Instructions · 3 MCP servers"
    checked={picked.claude} onCheckedChange={(checked) => setPicked({ ...picked, claude: checked })} />
  <CheckCard icon={<ProviderLogo name="openai" />} title="Codex" description="Empty file"
    checked={false} disabledReason="Empty file" onCheckedChange={() => undefined} />
</CheckCardList>
```

## Indicator and motion
- Unchecked: a hairline ring (`--line-strong`, `--border-hairline`), the size of
  a trailing chevron (`--icon-size-md`), on the card surface. Checked: the ring fills with `--accent` from the centre and the
  check (CheckIcon geometry) draws in on `--motion-ease-draw`; the card takes
  the ChoiceCard selected look.
- Unchecking reverses quicker (exit tokens): the check undraws, then the fill
  clears. Both layers stay mounted, so toggling mid-animation reverses cleanly.
- Press: the ChoiceCard pressed fill (`--selection-strong`) fades in under the
  content on `--motion-fast`; the card never scales. The border, background
  and focus ring change on `--motion-base` / `--motion-fast`.
- Reduced motion: no scale and no stroke travel; only fades.

## Alignment
Leading icon = title text size, centered on the title line; brand logos are fitted to the icon-pack grid, so all leading icons share one rule. Trailing controls vertically centered.

- The glyph is bare (no IconTile or boxed background), the title's text size,
  and centers on the title's letters (cap height to baseline, ChoiceCard's
  Typo's trimmed text box) in one-line and two-line cards alike.
  Brand logos are fitted to the icon-pack grid, so they follow the same rule.
- The check indicator centers vertically on the card.
- The description starts at the title's left edge. Line heights come from the
  type scale (Label, Caption).

## Tags
check, checkbox, multi-select, card, import
