# StatusChecklist

## What is this block
A read-only checklist: CheckCard's round indicator beside each item's text.
Done items fill the indicator with the accent and read in the secondary tone.
It is the `checklist` answer block, and renders the same in a 서랍 block scrap
and in a document.

| Export | Props |
| --- | --- |
| `StatusChecklist` | `items: { text, done }[]` |

## When to use this block
- Showing which steps or items are done.
- Not for choosing items before an action: use `CheckCard` in a `CheckCardList`.
- Not for a running turn's live progress: use `TodoProgressPanel`.

## How to use this block
```tsx
import { StatusChecklist } from "@/butler-ds";

<StatusChecklist items={[{ text: "Book the venue", done: true }, { text: "Send invitations", done: false }]} />
```

## Accessibility
- Each row is a read-only checkbox (`role="checkbox"`, `aria-checked`, `aria-readonly`); nothing is focusable.

## Tags
checklist, answer block, read-only
