# BlockColumns

## What is this block
Two or three content blocks side by side. It is the `columns` container of
answer blocks, and renders the same in a 서랍 block scrap and in a document.
It is its own size container: two columns from 30rem of its own width, three
from 40rem, one column below, so the same blocks stack on a phone, in a 서랍
card or in a side panel without knowing the window.

| Export | Props |
| --- | --- |
| `BlockColumns` | `children`: two or three blocks, one per column |

## When to use this block
- Two or three answer blocks that read together (two metrics, a fact list beside a note).
- Not for page layout keyed to the window: use `Grid`.
- Containers never nest: a column holds a leaf block, never `BlockColumns` or `BlockTabs`.

## How to use this block
```tsx
import { BlockColumns, MetricCard } from "@/butler-ds";

<BlockColumns>
  <MetricCard label="This month" value="1.24M" />
  <MetricCard label="Last month" value="1.15M" />
</BlockColumns>
```

## Accessibility
- Columns read in DOM order, which is also the stacked order.

## Tags
answer block, columns, container, layout
