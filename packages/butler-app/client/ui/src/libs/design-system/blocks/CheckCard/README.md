# CheckCard

## What is this component
A card that is picked or not. Several `CheckCard`s in a `CheckCardList` let
people choose the items to act on: tools to import from, files and servers to
bring over, things to include. It uses the ChoiceCard surface (border, radius,
padding, hover, focus ring and selected look) with a round check indicator on
the title line instead of a chevron.

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
- Unchecked: a ring (`--line-strong`, `--border-width-strong`) on the card
  surface. Checked: the ring fills with `--accent` from the centre and the
  check (CheckIcon geometry) draws in on `--motion-ease-draw`; the card takes
  the ChoiceCard selected look.
- Unchecking reverses quicker (exit tokens): the check undraws, then the fill
  clears. Both layers stay mounted, so toggling mid-animation reverses cleanly.
- Press scales the card on `--motion-scale-press`; the border, background and
  focus ring change on `--motion-base` / `--motion-fast`.
- Reduced motion: no scale and no stroke travel; only fades.
- The indicator and the logo tile center on the title line, never on title +
  description.

## Review variants
`indicatorSide` (`end` | `start`) and `checkedMark` (`check` | `fill`) exist
while the owner picks one look; they are removed once it is chosen.

## Tags
check, checkbox, multi-select, card, import
