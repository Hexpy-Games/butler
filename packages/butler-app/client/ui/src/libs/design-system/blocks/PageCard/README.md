# PageCard

## What is this block
`PageCard` is the web page as one elevated card. It wraps `NativeViewSlot`, so
the native view's bounds are exactly the card's content area (inside its 1px
transparent border, under the band; the pane's hairlines bound the card, so it
draws no parallel line of its own), and it reports them with the inner corner `radius`
for `View.setBorderRadius`. It shows who holds the tab, a `PageBand`, a 2px
load line (`ProgressMeter thin`) and, for Butler's fixed 1280×800 tabs, the
page fitted to the card's width with the card ending under it and the scale
noted below. With `reserveBand` the band
row is always there, so a band appearing, changing or leaving never moves the
native view. With no band the row is empty and the card surface (fill, shadow,
holder edge) starts under it: the row reads as the pane around the toolbar and
the page carries the card corners. A band extends the surface up over the row,
band and page one card with no line between them.

The native view takes one radius for all four corners, so the reported
`radius` is the inner corner radius only where a page corner meets a corner of
the surface, else 0: square under a band and beside a letterbox. A page that
reaches the card bottom corners keeps the radius under a band; the band fill
runs one corner radius under the page so those corners meet the band without a
notch.

## When to use this block
Use it for the page area of `BrowserPane`, one card for the visible tab.

## Corners
The card corners are `--page-card-radius` (the popover radius, 12px, by
default). `BrowserPane` lays the card flush with its own edges and sets the
radius to its own bottom corners: 0 beside the window frame, the shell card
radius in the cards frame. There the card's hairline and the holder edges
outside it sit under the pane's edges, so the `user` and `waiting` edges show
only along the page's top, under the toolbar. Butler's edge moves to the pane:
`BrowserPane` sets `--page-card-butler-edge: none` and
`--page-card-butler-glow` to the plain card shadow, and draws the riso inks on
its own edge.

## Container vs Presenter
The App forwards `onBoundsChange` (x, y, width, height, visible, scale,
radius) and `onOcclusion` to the main process and picks the holder:
`none`, `butler` (rotating riso edge on `--motion-agent-edge`), `user` (strong
neutral edge) or `waiting` (static amber). Holder edges are drawn outside the
content area, so changing the holder never moves the native view. The App
passes `reserveBand` for every tab and a band only for a real state: Butler
holds the tab (its turn is running), an approval or a hand-off waits, you took
over while a Butler turn is paused, pick mode or a page event. When Butler does
nothing on the tab the row stays empty; it never says whose tab it is.

## Usage

```tsx
<PageCard holder="butler" viewport={{ width: 1280, height: 800 }} reserveBand band={<PageBand tone="agent" … />}
  loading={progress} onBoundsChange={(bounds) => browser.setBounds(tabId, bounds)} onOcclusion={setCovered}
  contentRef={setDialogContainer} overlay={selection ? <SelectionBar … /> : null}>
  {crashed ? <EmptyLine … /> : null}
</PageCard>
```

## Accessibility
The content area is the tab panel (`panelId`). The band is the live region
for holder changes. Under reduced motion the riso edge is static.

## Responsive behavior
A page you browse fills the stage. A fixed-size page fits the stage's width and
the card ends with the page, so no empty band is left under it in the card;
only a stage too short for the page's aspect letterboxes it at the sides on
`--muted`.

## Wrong use cases
- Do not change the card's border or size per holder in product CSS.
- Do not toggle `reserveBand` with the holder or the tab's state; it stays on
  for every tab, so no band ever moves the page.
- Do not fill an empty row with a status line nobody can act on.
- Do not draw pick highlights or Butler's pointer in the page DOM; use the
  overlay layer (`AgentPointer`, `SelectionBar`).
- Do not wrap an `internal` page in a `ScrollArea`: the slot already scrolls
  it, and a ScrollArea bleeds its scrollbar lane past the card's inline end,
  which the slot then scrolls sideways.

## Tags
browser, page, native view, holder, riso edge, letterbox, loading
