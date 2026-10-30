# SuggestionList

## What is this component
The listbox under a combobox field. `SuggestionList` is the list; `SuggestionRow` is one option on one line: favicon (or a kind glyph), title, the muted host and path, typed terms in bold, and a star for bookmarks. `SuggestionItemRow` is the same row for app items: a type glyph, the title and muted meta (a project name or a type), typed terms in bold.

## When to use this component
Use it for address suggestions under `AddressField` (history and bookmarks), or any field that suggests pages as you type. Use `SuggestionItemRow` for app items suggested from typed text with no search field, such as the composer `@` menu (conversations and projects).

## Where to use this component
Inside `PopoverContent width="anchor" density="list"`, anchored to the field with `PopoverAnchor`, so the list is exactly as wide as the field. A caret menu (`@`) anchors on the typed character with `PopoverAnchor virtualRef` and `PopoverContent side="top" align="start" density="list" presentation="popover"`.

## Why to use this component
Mainstream browsers show suggestions as dense single-line rows with the site icon and the match emphasized; this keeps that clarity and the combobox semantics in one place.

## How to use this component
Give the field `listbox={{ id, expanded, activeOptionId }}`, `onInputChange` and `onInputKeyDown`. Render one `SuggestionRow` per result with a stable `id`, `active` for the keyboard highlight, `query` for bold matches and `onSelect`. `SuggestionItemRow` takes `icon` (a DS icon at size md), `title`, optional `meta`, and the same `id`, `active`, `query` and `onSelect`.

## Who can use this component
Product containers that own the suggestion data and navigation (AddressSuggestions, ComposerMentionMenu).

## Best practice
Keep focus in the field: rows prevent pointer-down focus; arrows move `active`; Enter chooses; the first Escape closes the list (prevent the default so the field stays in edit mode). When nothing matches, close the list rather than showing an empty row.

## Wrong use cases
Do not use it for a fixed set of values (use `Select`) or a filtered picker with groups (use `FilteredSelectPopover`).

## Tags
browser, address, suggestions, autocomplete, combobox, listbox, history, bookmark, favicon, mention, reference, composer
