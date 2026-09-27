# SplitBrowser

## What is this component
A two-pane browser in one flat surface: `nav` (a category list) on the start side, `children` (the selected category's items) on the end side; both panes scroll at `--split-browser-height`.

## When to use this component
Use it to browse documents grouped by category.

## Where to use this component
Project dashboards (specs by area).

## Why to use this component
The pane geometry and divider live in the DS instead of inline styles.

## How to use this component
`<SplitBrowser nav={categories.map(...NavRow)}>{documents.map(...DocumentTile)}</SplitBrowser>`

## Who can use this component
Dashboard components.

## Best practice
Keep the selected category in state; show counts as NavRow badges.

## Wrong use cases
Do not use it for status lanes. Use `KanbanBoard`.

## Tags
browser, categories, master-detail, specs
