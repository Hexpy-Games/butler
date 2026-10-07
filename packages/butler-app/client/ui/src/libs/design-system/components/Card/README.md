# Card

`Card` is the primitive visual container for repeated card rows and compact
surfaces. Its base silhouette follows the existing Project Dashboard document
cards: medium padding, `var(--line)` border, `var(--radius-control)`, and
`var(--surface-raised)`.

Use it when a component needs a clearly bounded card shape without taking on a
domain-specific layout. Blocks such as `CardList` compose `Card` for each item
and own their row content layout.

## Running activity

`<Card activity="running">` marks an item whose work is live (a running task in
a task graph). It draws the `--worker-active` border and a ring that breathes on
`--pulse-duration` (opacity only). Under reduced motion, from the OS or the
`data-motion="reduced"` scope, `--motion-loop-count` is `0` and the ring stays
at its resting strength. `selected` still wins the border, so a selected
running card shows the accent border with the green ring. Pair it with a
`LoadingIndicator` in the card's IconSlot; the ring is a cue, not the only
signal. Do not use it for selection, hover or errors.

## Clickable cards

`<Card interactive onClick={open} aria-label={title}>` is a keyboard-operable
button (role `button`, focusable, Enter and Space activate). Use it for work
cards and board cards instead of wrapping content in a restyled `Button` or
`Clickable`. Nested buttons inside should stop propagation.
