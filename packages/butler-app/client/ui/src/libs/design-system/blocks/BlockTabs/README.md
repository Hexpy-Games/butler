# BlockTabs

## What is this block
Content blocks split over line tabs; the first tab is open. It is the `tabs`
container of answer blocks, and renders the same in a 서랍 block scrap and in
a document. It composes `Tabs` (line variant).

| Export | Props |
| --- | --- |
| `BlockTabs` | `tabs: { label, content }[]`, `ariaLabel` (when no visible title names the list) |

## When to use this block
- Parallel options that each have the same blocks (a city, a plan, a month).
- Not for blocks compared at once: use `BlockColumns`.
- Not for switching page or panel views: use `Tabs`.
- Containers never nest: a tab holds leaf blocks, never `BlockTabs` or `BlockColumns`.

## How to use this block
```tsx
import { BlockTabs, KeyValueRow } from "@/butler-ds";

<BlockTabs ariaLabel="Plans" tabs={[
  { label: "Basic", content: <KeyValueRow label="Price" value="₩9,900" /> },
  { label: "Family", content: <KeyValueRow label="Price" value="₩16,900" /> },
]} />
```

## Accessibility
- Radix tabs: arrow keys move between tabs, Tab moves into the open panel.

## Tags
answer block, tabs, container
