# BlockActionFrame

## What is this block
One content block with its title and a ⋯ menu: an answer block, a 서랍 block
scrap, or a block inside a document. The ⋯ shows on hover or keyboard focus,
only for the innermost block under the pointer, so a container and its
children never show two at once. A right-click, or a long-press on touch, opens
the same menu at the block's ⋯, for the innermost block only: an enclosing
long-press menu (the reply's) is cancelled. Touch screens keep the ⋯ invisible.

| Export | Props |
| --- | --- |
| `BlockActionFrame` | `title`, `level` (`block` · `child`), `actions` (OverflowActionMenu items), `actionsLabel`, `children`, div attributes |
| `flySaveToTarget(source, target)` (`lib/saveFlight`) | Flies a ghost of `source`'s box into `target` over `--motion-flight`; reduced motion or a missing/off-screen target crossfades. Returns `{ cancel }` or null. |

## When to use this block
- Content blocks people save, turn into a document or copy.
- Not for list rows or cards: they have their own action slots.

## How to use this block
```tsx
import { BlockActionFrame, MetricCard, flySaveToTarget } from "@/butler-ds";

<BlockActionFrame ref={blockRef} title="This month" actionsLabel="블록 메뉴" actions={[
  { label: "서랍에 저장", onSelect: () => { void save(); flySaveToTarget(blockRef.current!, libraryEntry); } },
  { label: "복사", onSelect: copy },
]}>
  <MetricCard label="Spending" value="1.24M" />
</BlockActionFrame>
```

## Motion
The save flight moves only a ghost (the block's surface, line and radius), so
the content is never cloned. It travels with translate and scale over
`--motion-flight` on the emphasized curve; the target acknowledges with a
small scale as the ghost lands. Reduced motion: the ghost fades on the block
and the target fades its mark in.

## Accessibility
- The ⋯ stays in the tab order while hidden and appears on focus.
- The frame never clips, so focus rings keep their room.

## Tags
answer block, menu, long-press, scrap, motion
