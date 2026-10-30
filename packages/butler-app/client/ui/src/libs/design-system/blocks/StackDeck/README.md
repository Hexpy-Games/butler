# StackDeck

`StackDeck` shows a 묶음 (stack): items that share one place in an order,
such as tasks that run together in one step. It is generic: it takes items
(`id`, `label`, optional `running`) and a `renderCard` slot, and draws the
`Card` around each card (`padding="md"`, a row's card).

```tsx
<StackDeck
  items={tasks}
  labels={{ expand: (count, front) => `${front} 외 ${count - 1}건, 펼치기`, fold: (item) => `${item}, 접기` }}
  renderCard={(task, { index, count, expanded }) => <TaskRowContent task={task} more={!expanded && index === 0 ? count - 1 : 0} />}
/>
```

## Collapsed

The front card is a normal full-width row. The Card itself is not a button:
one transparent toggle button (aria-expanded) covers it, the stretched-link
pattern, and the card content sits above the toggle. A tap anywhere on the
card reaches the toggle; the content's own controls (a grip, ⋯) are the
toggle's siblings, never inside it, and take their own taps. Tab order is
the toggle, then the content's controls in order. The hover fill is a row's
own, and the toggle's focus ring is drawn on the Card. One hairline edge per further card
(up to three; the rest only in the front's count) shows past its right side at
the same top and height: the right end of a card behind, no fill,
`--border-hairline` in `--line` (`--line-strong` on hover, `--worker-active`
while any card runs; the front then takes `Card`'s running state). Edge k
starts `--focus-ring-room + --space-xs × (k − 1)` past the card, so neither the
ring nor the running halo covers an edge. The edges sit inside the toggle, so a
tap on one opens the deck. An edge that joins slides in from behind
(`--motion-slow`, emphasized).

## Open

The cards sit in one column below the front card's place, in order, each a
full-width row card, `--space-xs` apart (more than the focus-ring room, so no
card covers another's ring or running halo; nothing clips). Each card has the
same toggle (aria-expanded=true); tapping a card, or Escape, stacks the cards
again. Focus follows the toggle between states.

`expanded` / `onExpandedChange` control the state; `defaultExpanded` starts it
open. `interactive={false}` (during a drag) renders no toggle and no hover.
`cardListeners` forwards pointer handlers per card (`null`: the collapsed deck),
for example a drag sensor's.

## Motion

- Open: card i slides down from the front card's place into its own (a FLIP
  `translate`), passing behind the cards before it and fading in over the
  first third, on `--motion-slow` with the emphasized curve. The front card
  stays put; rows below the deck take the new height at once.
- Stack: the reverse on the accelerate curve (each card speeds up behind the
  front card, fading over the last third), then the collapsed deck.
- Reduced motion: no travel; the cards fade in and out in place.
