# Card

`Card` is the primitive visual container for repeated card rows and compact
surfaces. Its base silhouette follows the existing Project Dashboard document
cards: medium padding, `var(--line)` border, `var(--radius-control)`, and
`var(--surface-raised)`.

Use it when a component needs a clearly bounded card shape without taking on a
domain-specific layout. Blocks such as `CardList` compose `Card` for each item
and own their row content layout.

## Clickable cards

`<Card interactive onClick={open} aria-label={title}>` is a keyboard-operable
button (role `button`, focusable, Enter and Space activate). Use it for work
cards and board cards instead of wrapping content in a restyled `Button` or
`Clickable`. Nested buttons inside should stop propagation.
