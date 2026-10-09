# PopupWindowChrome

## What is this block
`PopupWindowChrome` is the whole document of a Butler-owned pop-up window
(sign-in, payment): a compact 40px title bar with the native window controls,
the lock and the host, over the page area. Solid, like Butler's other
windows.

## When to use this block
Use it in the separate native window a page opens on a click.

## Container vs Presenter
The App's pop-up window renders it full-size and lays the native view over
the page area (`NativeViewSlot` as `children`).

## Usage

```tsx
<PopupWindowChrome host={origin} secure={secure} securityLabel={copy.secure} platform={platform} windowControls={<WindowControls />}>
  <NativeViewSlot onBoundsChange={place} />
</PopupWindowChrome>
```

## Accessibility
The lock or warning glyph carries its name; the bar is a drag region.

## Responsive behavior
Fills the window; the host truncates.

## Platform layout
On macOS the bar reserves the native lights at the start (they sit at x 12 in
a pop-up) and starts the lock as far from the green light as TitlebarShell's
first leading glyph sits from the main window's lights. Elsewhere nothing is
reserved at the start and `windowControls` sit at the end.

## Wrong use cases
- Do not title the pop-up with the page's own title.

## Tags
browser, pop-up, window, titlebar
