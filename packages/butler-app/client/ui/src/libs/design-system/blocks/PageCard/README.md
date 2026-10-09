# PageCard

## What is this block
`PageCard` is the web page as one elevated card. It wraps `NativeViewSlot`, so
the native view's bounds are exactly the card's content area (inside its 1px
transparent border, under the band; the pane's hairlines bound the card, so it
draws no parallel line of its own), and it reports them with the inner corner `radius`
for `View.setBorderRadius`. It shows who holds the tab, a `PageBand`, a 2px
load line (`ProgressMeter thin`) and, for Butler's fixed 1280×800 tabs, a
letterbox with the scale noted under the page.

## When to use this block
Use it for the page area of `BrowserPane`, one card for the visible tab.

## Container vs Presenter
The App forwards `onBoundsChange` (x, y, width, height, visible, scale,
radius) and `onOcclusion` to the main process and picks the holder:
`none`, `butler` (rotating riso edge on `--motion-agent-edge`), `user` (strong
neutral edge) or `waiting` (static amber). Holder edges are drawn outside the
content area, so changing the holder never moves the native view.

## Usage

```tsx
<PageCard holder="butler" viewport={{ width: 1280, height: 800 }} band={<PageBand tone="agent" … />}
  loading={progress} onBoundsChange={(bounds) => browser.setBounds(tabId, bounds)} onOcclusion={setCovered}
  contentRef={setDialogContainer} overlay={selection ? <SelectionBar … /> : null}>
  {crashed ? <EmptyLine … /> : null}
</PageCard>
```

## Accessibility
The content area is the tab panel (`panelId`). The band is the live region
for holder changes. Under reduced motion the riso edge is static.

## Responsive behavior
The card fills its stage; fixed-size pages scale to the card's width and
letterbox below on `--muted`.

## Wrong use cases
- Do not change the card's border or size per holder in product CSS.
- Do not draw pick highlights or Butler's pointer in the page DOM; use the
  overlay layer (`AgentPointer`, `SelectionBar`).

## Tags
browser, page, native view, holder, riso edge, letterbox, loading
