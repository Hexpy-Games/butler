# BrowserPane

## What is this block
`BrowserPane` is the browser sheet: a tinted pane (`--browser-pane-bg`) whose two
top corners use the page card radius (`--browser-pane-radius`, 12px). It holds the
tab row, the toolbar row and the page card, inset by `--browser-card-inset`.
`BrowserToolbar` lays out navigation · address · page actions on that row.

## When to use this block
- Beside a conversation: `placement="conversation"` inside the `AdaptiveShellSplit`
  pane; it stands `--space-xs` off the chat column and the window edge.
- The standalone Browser view: `placement="standalone"` under the view's
  `TitlebarShell`.

## Container vs Presenter
The App owns tabs, navigation, pages, bookmarks and downloads, and passes
DS blocks into the slots: `TabStrip` (with `hideChip` and `trailing`),
`BrowserToolbar` with `AddressField` and `IconButton`s, and `PageCard`.

## Usage

```tsx
<BrowserPane label={copy.browser.title} placement="conversation"
  tabs={<TabStrip hideChip groups={groups} activeTabId={active} panelId="page" trailing={bringIn} … />}
  toolbar={<BrowserToolbar navigation={nav} address={<AddressField url={url} onSubmit={open} />} actions={actions} />}>
  <PageCard panelId="page" holder={holder} band={band} onBoundsChange={placeNativeView} />
</BrowserPane>
```

## Accessibility
The region is labelled; the toolbar row is `role="toolbar"`. Tabs control the
page card through `panelId`.

## Responsive behavior
The pane fills the split pane (or the workspace row) and never sets a width;
the toolbar's address takes the remaining width and truncates.

## Wrong use cases
- Do not lay glass over the page top: the page is a native view that glass
  cannot blur (see the approved design's glass verdict).
- Do not restyle the rows in product CSS; pass DS blocks into the slots.

## Tags
browser, pane, sheet, toolbar, tabs, page card
