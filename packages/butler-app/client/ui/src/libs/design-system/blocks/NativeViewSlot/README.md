# NativeViewSlot

## What is this component
A rectangle in App layout that a native Electron `WebContentsView` is laid over. It is pure UI: no Electron imports, callbacks only.

- **Bounds.** `onBoundsChange({ x, y, width, height, visible, scale })` gives whole CSS pixels in window coordinates. It fires at most once per animation frame and only when something changed. It keeps sampling while an ancestor animates (sidebar and inspector slides) and reports the settled rect after. `visible` is false while `hidden`, zero-size, `display: none`/`visibility: hidden`, or after unmount.
- **Occlusion.** `onOcclusion(true)` fires while a DS overlay overlaps the slot (dialog, popover, dropdown/context menu, select, tooltip, toast, AdaptiveShell's peeked sidebar; `NATIVE_VIEW_OCCLUDERS`), or while a panel animates across it or moves it, and for a rect change that lands within 120ms of such motion (a track committed as a slide ends). A resize is measured in the same frame it happens (ResizeObserver, before paint), so bounds and coverage go out before that frame paints, and the slot's `data-occluded` attribute flips in that frame too. Overlays paint under a native view, so the App hides the view while covered. The slot shows `stillSrc` in its place meanwhile. `onOcclusion(false)` fires when it clears. `covered` forces the state for occluders the DOM cannot see; `occluderSelector` adds App surfaces.
- **Fixed viewport.** With `viewport={{ width: 1280, height: 800 }}` the frame is the largest box of that aspect that fits the slot, centered across and pinned to the top. `bounds.scale` is frame width / 1280: the page zoom that keeps the agent's 1280×800 layout.

## When to use this component
The Browser area's page, beside or under `TabStrip`.

## Where to use this component
The App's Browser area container.

## Why to use this component
Bounds sync, occlusion and viewport scaling are layout concerns. They belong to the DS that owns overlays and panel motion, not to the Electron bridge.

## How to use this component
```tsx
<NativeViewSlot id="browser-page" role="tabpanel" aria-labelledby={activeTabDomId}
  hidden={!activeTab || activeTab.crashed} stillSrc={still} viewport={activeTab?.agent ? AGENT_VIEWPORT : undefined}
  onBoundsChange={(bounds) => browser.setBounds(activeTab.id, bounds)}
  onOcclusion={(covered) => browser.setCovered(activeTab.id, covered)}>
  {activeTab?.crashed ? <Notice tone="error" message={copy.crashed} action={reload} /> : <EmptyLine message={copy.noTabs} />}
</NativeViewSlot>
```

The slot fills its parent (`width/height: 100%`, `flex: 1 1 0%`), so give it a sized parent such as a filling `Stack`. Overlays render immediately and the native view sits above them until the App hides it. Keep a recent still per tab (capture on load and before covering) so the swap has no blank frame.

## Who can use this component
The Browser area container.

## Best practice
Treat `visible: false` as "detach the view". Treat `scale` as the zoom factor only in fixed-viewport mode.

## Wrong use cases
Do not use it for images of pages; use `ArtifactPreview`.

## Tags
browser, electron, webcontentsview, bounds, occlusion, viewport
