# Inline

## What is this component
Inline is the row preset of `Stack`: horizontal, cross-axis centered, wrapping by default, with a small (`sm`) gap.

## When to use this component
Use Inline for chip rows, icon + label + metadata runs, badge groups and any short horizontal run that should wrap on narrow screens.

## Where to use this component
Import it from `@/butler-ds` in product code. Use `Stack align="row"` when a row must not center its items or needs `justify`.

## How to use this component

```tsx
import { Inline, Tag, Typo } from "@/butler-ds";

<Inline>{tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Inline>
<Inline gap="xs" wrap={false}><GitBranch size="xs" /><Typo.Caption truncate>{branch}</Typo.Caption></Inline>
```

Inline accepts every Stack prop except `align`, including layout item props (`grow`, `basis`, `minWidth`)
and `rowGap`, which spaces wrapped lines separately from `gap`:

```tsx
<Inline gap="lg" rowGap="sm">{counts}</Inline>
```

## Best practice
- Prefer Inline over a styled `div` with `display: flex; flex-wrap: wrap`.
- Keep gaps on the named spacing scale.

## Wrong use cases
- Do not use Inline for vertical lists; use `Stack`.
- Do not pass `className` to add flex rules; request a capability instead.

## Tags
layout, row, wrap, chips
