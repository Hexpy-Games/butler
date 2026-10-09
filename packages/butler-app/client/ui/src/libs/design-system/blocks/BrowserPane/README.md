# BrowserPane

## What is this block
`BrowserPane` is the browser sheet: a tinted pane (`--browser-pane-bg`) whose two
top corners use the page card radius (`--browser-pane-radius`, 12px). It holds the
tab row, the toolbar row and the page card, inset by `--browser-card-inset`.
`BrowserToolbar` lays out navigation · address · page actions on that row.

## When to use this block
- Beside a conversation: `placement="conversation"` inside the `AdaptiveShellSplit`
  pane. It meets the chat column directly: its leading hairline is the
  chat | pane divider, and its trailing edge tucks under the window frame (one
  edge, one hairline; see Foundations > Spacing > Borders).
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
the toolbar's address takes the remaining width and truncates. Below a 520px
toolbar only the last page action stays (make it More, carrying the others),
so the address keeps at least 120px.

## In the cards frame
Inside `AdaptiveShell frame="cards"` (docked) the sheet is a card of its own:
four 12px corners, one quiet `--shell-card-edge`, no edge tucked under a
window frame. Beside a conversation it is the second card after the chat
card; in the standalone Browser it is the card (do not wrap it in
`AdaptiveShellCard`). The shell sets `--browser-pane-bg` to a
`--shell-sheet-tint` ink tint of the card surface (1% light, 2.5% dark) and
the page card's shadow to `--shell-page-shadow` (tight in light), so the
sheet's strip beside the 8px gap is as light as the chat card, the gap reads
as 8px, and the page card still lifts off the sheet by its edge.

## Wrong use cases
- Do not lay glass over the page top: the page is a native view that glass
  cannot blur (see the approved design's glass verdict).
- Do not restyle the rows in product CSS; pass DS blocks into the slots.

## Tags
browser, pane, sheet, toolbar, tabs, page card
