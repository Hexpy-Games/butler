# ExpandableText

## What is this component
Plain text clamped to `collapsedLines` (1–3) that opens in place. Only text
that really overflows becomes a toggle; text that fits is just text. An
optional `meta` caption sits above it, and a trailing chevron slot (the
DisclosureRow trailing chevron) is kept in every row, empty when the text
fits.

## When to use this component
Use it for lists of user-written text where most entries are short, such as
memory instructions, and for long text beside a trailing action that must not
move.

## Where to use this component
In list rows and settings sections, imported from `@/butler-ds`, usually as
the growing item of a `Stack align="row" cross="start"` next to an
`IconButton`.

## Why to use this component
It keeps one text node and never swaps it: the clamp wraps normally, so line
breaks are the same open and closed, the first line and the caption never
move, and rows below move in one direction only.

## How to use this component

```tsx
import { ExpandableText, IconButton, Stack, Trash2 } from "@/butler-ds";

<Stack align="row" cross="start" gap="md">
  <Stack.Item grow minWidth="0">
    <ExpandableText id={textId} meta={caption}>{instruction.text}</ExpandableText>
  </Stack.Item>
  <IconButton label={copy.delete} aria-describedby={textId}><Trash2 size="md" /></IconButton>
</Stack>
```

- `children`: a plain string (`pre-wrap`, `overflow-wrap: anywhere`).
- `collapsedLines`: 1, 2 or 3 (default 1).
- `meta`: a one-line caption above the text (`--text-secondary`, ellipsis).
- `id`: the text element's id, for `aria-controls` and a sibling action's `aria-describedby`.

Overflow is measured only while clamped (`scrollHeight > clientHeight + 1`,
re-checked by a `ResizeObserver`). Expanding lifts the clamp synchronously and
animates the box from its height to the text's `scrollHeight` over
`--motion-base` (standard easing). Collapsing animates to `line-height ×
collapsedLines` over `--motion-exit-base` (accelerate easing), then re-applies
the clamp before releasing the fixed height. Reduced motion is instant.

## Who can use this component
Product engineers, design-system maintainers and coding agents building Butler client UI.

## Best practice
- Give it an `id` when a sibling action refers to the text.
- Keep the trailing action aligned to the row top (`cross="start"`), so it never moves when the row opens.
- Inside a `ScrollArea`, leave `--focus-ring-room`; the ring is the DS default.

## Wrong use cases
- Do not use it to reveal other content or controls; use `DisclosureRow` or `Collapsible`.
- Do not pass rich content; it is plain text only.
- Do not wrap it in another button or link.

## Tags
text, clamp, disclosure, list
