# SelectionBar

## What is this block
`SelectionBar` is the picked-elements toolbar over the page: a count, the
actions (add to chat, save image, scrap, copy text) and Clear. `compact` is
the small pill kept after picking ends; `dimmed` while the picks are dragged.

## When to use this block
Use it in `PageCard`'s `overlay` while one or more elements are picked.

## Container vs Presenter
The App owns the selection and passes actions as data.

## Usage

```tsx
<SelectionBar count={picks.length} label={copy.picked(picks.length)} actions={actions} onClear={clear} clearLabel={copy.clear} />
```

## Accessibility
`role="toolbar"` named by the count label; actions keep their words as
labels or tooltips.

## Responsive behavior
One line at every width: inside a page card narrower than 560px the actions
become icon buttons with tooltips; below 320px the count label drops.

## Wrong use cases
- Do not build the bar from loose buttons; they wrap on narrow pages.

## Tags
browser, pick, selection, toolbar
