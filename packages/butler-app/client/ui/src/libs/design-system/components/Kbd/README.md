# Kbd

A keyboard shortcut rendered as key caps: `<Kbd keys={["⌘", "K"]} label="Command K" />`.
Each key is its own `<kbd>` inside an outer `<kbd>` combination, as HTML
specifies for key combinations.

## When to use

- Next to a control or in a hint that names its shortcut (search, command
  palette, send).
- In menus, the trailing shortcut column uses `DropdownMenuShortcut` instead.

## Props

- `keys`: keys in press order. Use the platform glyph (`⌘`) or a short name
  (`Esc`, `Enter`, `/`).
- `label`: the spoken name when keys are symbols; the key caps are then hidden
  from assistive technology.
- `size`: `default` or `sm` for dense rows.

## Accessibility

Symbols such as `⌘` are read poorly by screen readers; pass `label`.

## Tags

keyboard, shortcut, hint
