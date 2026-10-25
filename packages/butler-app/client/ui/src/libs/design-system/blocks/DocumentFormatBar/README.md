# DocumentFormatBar

## What is this block
The floating format bar over a document selection: a glass pill of icon
buttons (굵게, 제목, 목록, 블록 추가) centred above the selection, below it when
there is no room above, kept inside the viewport. Pressing a button keeps the
editor's selection.

| Export | Props |
| --- | --- |
| `DocumentFormatBar` | `anchor` (the selection box in viewport coordinates, or null to hide), `actions` (`id`, `label`, `icon`, `pressed`, `onPress`), `label` |

## When to use this block
- Formatting a selection inside a `DocumentEditor`.
- Not for whole-block actions: use `BlockActionFrame`.

## Accessibility
- `role="toolbar"`, named by `label`; buttons carry `aria-pressed` for formats that are on.
- Mouse-down never moves focus out of the text.
- It stays clickable over a modal Dialog (the editor in a document dialog): the bar takes pointer events back itself.

## Tags
document, editor, toolbar, format
