# Composer decoration

Issue #474's DS viewer candidate, at `index.html?page=patterns/composer-decorations`.
This is not enabled in the application and stores no preferences or draft text.

## Composition

Insert `ComposerDecoration` as the first child of the existing `ComposerCard`.
Pass the card's existing `containerRef` as `edgeHost`. The card, editor, toolbar,
send button, glass surface and radius stay owned by their existing blocks.
The module adds no form, input, border, panel, heading or caption.

TintedGlass's existing backdrop filter establishes the absolute containing and
stacking context. The decoration's local negative paint order places it above
the card background and below existing content; the card's overflow/radius clips
it. `--management-page-veil`, the app's wallpaper content veil, and bounded art
opacity keep the content legible. No new surface token is introduced.

Characters may instead be portaled to the existing card wrapper. They sit across
the upper edge, never take pointer events, and are hidden from accessibility.
`inside` puts them back in the same clipped background as the other themes.

## Motion and cost

- None mounts no canvas or loop.
- Coastal uses the unchanged `butler.shoreline` module and Wallpaper GPU renderer.
  Its clock runs continuously in interactive mode; an input adds a small opacity
  pulse without recompiling the shader or allocating a new scene.
- Cherry blossom has a fixed pool of 24 petals: 16 ambient, eight revealed by
  typing. Flower field has 20 flowers; characters has three cats. Their geometry
  is decorative artwork; colors resolve from existing DS palette tokens.
- Flowers and characters draw once at rest and wake only for committed input.
  Pulse duration is `--pulse-duration`. All drawing shares Wallpaper's 20fps,
  DPR/pixel cap, clock-step bound, watchdog and browser-signal subscriptions.
- Static mode, OS/viewer reduced motion and battery pause hold still frames.
  Hidden documents, offscreen canvases and lost WebGL contexts do no drawing.
  Context restoration redraws; unmount cancels the frame, disconnects observers,
  removes the input listener and releases GPU resources.
- A native input listener reads only the target type and timestamp. It does not
  read, store, serialize or forward draft text. Measurement samples are bounded
  to 128 entries; the readout updates at most once per second during animation,
  and once on a state change. CPU draw time excludes asynchronous GPU work.

## DS references used

- DS skill, `references/catalog.md`, `references/component-map.md`.
- ComposerCard README, showcase, guidance, editor, toolbar and CSS.
- Wallpaper README, showcase, guidance, renderer, scheduler, signals, shoreline
  shader/manifest, Daisy Field shader/manifest and available bundled assets.
- TintedGlass CSS, ManagementPage veil tokens, motion helpers and token contract.
- Viewer PageHeader, ItemPage, PatternPage, RecipesPage, StoryFrame and layout.

The viewer follows PageHeader + Stack + Section, with Field/FieldLabel,
NativeSelect, SegmentedControl, Slider and Switch controls and Typo metrics.
It uses the same access control's `compact="icon"` option as the app.
No component/primitives source or lint baseline is modified. The motion lint
registers this bounded canvas module with its scheduling justification.

## Verification

`tests/smoke/composer-decoration-smoke.ts` serves the built DS site on an ephemeral
loopback port. It compares the composer DOM with the existing ComposerCard story,
checks a single editable area/toolbar and unclipped send button, captures every
theme at 1280/375 in light/dark, and checks motion, input completeness/cost,
offscreen/hidden cancellation, resumption, containment and viewer controls.
The shared `BUTLER_SMOKE_BROWSER_ARGS` helper accepts `["--single-process"]`.
Run all checks with disposable HOME/BUTLER_DATA. Captures and measurements go to
`.tmp/composer-decor2/`; `dist-ds-site` uses relative assets and no source maps.
