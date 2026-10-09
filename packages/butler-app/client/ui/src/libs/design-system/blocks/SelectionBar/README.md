# SelectionBar

## What is this block
`SelectionBar` is the picked-elements toolbar over the page: a count, the
actions (add to chat, save image, scrap, copy text) and Clear. `compact` is
the small pill kept after picking ends; `dimmed` while the picks are dragged.

At `count={0}` it is the picking state shown as soon as pick mode starts: a
pick glyph and `hint` replace the count and its label, every action stays in
place but unavailable (`aria-disabled`, `emptyReason` as its tooltip), and
Clear is hidden. Any action can also be unavailable on its own with
`disabledReason`. A compact pill at 0 renders nothing.

## When to use this block
Use it in `PageCard`'s `overlay` (or the overlay renderer) from the moment
pick mode starts, and while one or more elements are picked.

## Container vs Presenter
The App owns the selection and passes actions as data.

## Usage

```tsx
<SelectionBar count={picks.length} label={copy.picked(picks.length)} hint={copy.pickEmpty} emptyReason={copy.pickFirst}
  actions={actions} onClear={clear} clearLabel={copy.clear} compact={!picking} />
```

## Accessibility
`role="toolbar"` named by the count label (the hint at 0); actions keep
their words as labels or tooltips. Unavailable actions stay focusable
(`aria-disabled`) so their reason is reachable.

## Responsive behavior
One line at every width: with less than 620px of room the actions become
icon buttons with tooltips (an unavailable one reads "label · reason");
below 340px the count label drops. At 0 the hint ellipsizes before anything
wraps.

## Wrong use cases
- Do not build the bar from loose buttons; they wrap on narrow pages.
- Do not wait for the first pick to show the bar, or hide actions that
  cannot run yet; show them unavailable with a reason.

## Tags
browser, pick, selection, toolbar
