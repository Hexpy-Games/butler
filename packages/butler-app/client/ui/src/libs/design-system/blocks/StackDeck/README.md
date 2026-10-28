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

The front card is a normal full-width row and the button (aria-expanded), so
its hover and focus ring are a row's own. One hairline edge per further card
(up to three; the rest only in the front's count) shows past its right side at
the same top and height: the right end of a card behind, no fill,
`--border-hairline` in `--line` (`--line-strong` on hover, `--worker-active`
while any card runs; the front then takes `Card`'s running state). Edge k
starts `--focus-ring-room + --space-xs × (k − 1)` past the card, so neither the
ring nor the running halo covers an edge. The edges sit inside the card, so a
tap on one opens the deck. An edge that joins slides in from behind
(`--motion-slow`, emphasized).

## Fanned

The cards sit side by side to the right in the same row, in a horizontal
`ScrollArea` whose edge padding is given back, so the first card rests on the
column edge. Two cards fill the row; with more it scrolls. 140 ms after a
scroll stops (never while a pointer or finger is down) the row settles on the
nearest whole card. At rest a clip shows only whole cards plus focus-ring room,
and a mirrored edge marks each card out of view at either end (up to three per
side); while the row moves the clip lifts and the ScrollArea edge fades show
the cut. Tapping a card, or Escape, folds the cards back. Focus follows the
toggle between states.

`expanded` / `onExpandedChange` control the state; `defaultExpanded` starts it
fanned. `interactive={false}` (during a drag) makes no card a button.
`cardListeners` forwards pointer handlers per card (`null`: the collapsed deck),
for example a drag sensor's.

## Motion

- Fan-out: card i slides in from the first card's place (i card widths to the
  left), fading in, on `--motion-slow` with the emphasized curve.
- Fold: the reverse, then the collapsed deck.
- Reduced motion: no travel; the deck folds at once.
