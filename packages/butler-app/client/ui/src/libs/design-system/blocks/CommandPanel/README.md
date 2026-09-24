# CommandPanel

## What is this component
A search-and-results shell for command interfaces.

## When to use this component
Use it for command palette and lightweight search panels.

## Where to use this component
Use it in command dialogs, popovers, or centered overlays.

## Why to use this component
It standardizes command search layout while keeping results domain-owned.

## How to use this component
Pass query state, change handler, and result children.
`CommandPalettePanel` also accepts a `feedback` slot for caller-owned loading,
empty or failed-search feedback; results and retry behavior remain domain-owned.

## Who can use this component
Command palette containers.

## Best practice
`CommandPalettePanel` renders results as a `listbox` of `option` rows and owns
the active row: it starts at the first result, ArrowDown/ArrowUp move it, Enter
runs the active item, and the input exposes `aria-activedescendant`. Command
execution stays in the caller. Callers may pass `<mark>` inside item titles to
highlight query matches; the panel styles marks through tokens.

## Wrong use cases
Do not use it for form search fields without command results. Use `Input`.

## Tags
command, search, palette, overlay
