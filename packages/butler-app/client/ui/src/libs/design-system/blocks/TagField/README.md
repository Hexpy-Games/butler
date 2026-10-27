# TagField

## What is this block
`TagField` is a tag editor: the item's tags as removable `Tag` chips inside
one field, a typing point after them, and completion rows under the field.
Completions come from existing tags, prefix matches first, then matches inside
the name, each ordered by count (six at most). When no existing tag matches
exactly, a last row creates the typed tag. Matching ignores case, width and
compatibility forms (NFKC).

## When to use this block
Tags on a saved Library item: the card's tag popover, the detail panel.

## Container vs Presenter
The App passes the item's tags (`value`), every existing tag with its count
(`suggestions`) and saves `onChange`.

## Usage

```tsx
<TagField value={tags} onChange={save} label="Tags" placeholder="Add tag" suggestions={all}
  removeLabel={(n) => `Remove ${n}`} createLabel={(n) => `Create tag “${n}”`} />
```

## Accessibility
The input is a combobox with a listbox; ArrowUp/ArrowDown move, Enter or a
comma adds the highlighted row (or the typed text), Backspace on an empty
field removes the last chip, Escape clears the typed text.
The ring is drawn on the field, so the input carries the field's inset as its
scroll margin: keyboard focus inside a fading scroller clears the whole ring.

## Responsive behavior
Chips wrap inside the field; the field fills its container.

## Wrong use cases
- Do not use it to pick one value from a fixed list (use `Select`).

## Tags
tags, chips, autocomplete, combobox
