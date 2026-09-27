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

## Opening and motion
Keep `CommandPalettePanel` mounted and toggle `open` so it can animate out.
It opens with `DialogContent motion="palette"`: the panel scales 0.98 -> 1
(`--motion-scale-palette`) and fades with the backdrop over
`--motion-palette` (140ms); it leaves on `--motion-exit-fast`. Reduced
motion fades only. On phones (640px and below) the palette is a full-width
top sheet below the safe area that drops in on `--motion-slow`, and its rows
meet the 44px touch target. Bind Cmd+K with the DS `useHotkey("mod+k", toggle)`,
which ignores IME composition (Korean input) and key repeat.

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
