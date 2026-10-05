# Wallpaper

## What is this component

Wallpaper is the Butler wallpaper engine: a WebGL2 canvas that draws a
`WallpaperSource` — a live shader module with parameters, an image, or
nothing — behind a surface. Every wallpaper, built-in or user-authored, is a
module in the same format (`wallpaper.json` + `shader.frag`, contract v1,
engine 1) and runs under the same performance and motion policy.

## When to use this component

Use it for screen and area backgrounds: the new chat, the setup wizard, and
the project dashboard, and (with a transparent decoration module) for art on a
card such as the composer. Product code passes the stored source; it never draws
its own canvas. To let the user choose a source, use `WallpaperPicker`.

## Where to use this component

- `scope="viewport"` (default): a fixed full-screen layer, like the new chat.
  Its leading corners follow `--workspace-left-radius` (18px by default); a
  compact conversation sets it to 0.
- `scope="container"`: fills the nearest positioned parent (dashboards,
  previews).

`PromptSuggestionList` takes a `wallpaper` source and renders this block.

## Why to use this component

One engine keeps the cost of ambient motion bounded everywhere: animated
modules run at most 20fps at DPR 1 within 1.4MP; static modules render once
per change (resize, theme, params, image, plus every 15 minutes when they read
`u_dayPhase`, or on a `contentRect` change when they read `u_contentRect`) at
DPR 2 within 4MP. Nothing renders while the document is hidden (minimized,
occluded, background tab) or the canvas is off-screen; `motion="paused"`,
`pauseOnBattery` on battery, reduced motion, or the frame-time watchdog hold a
still frame. Window focus is not a pause: a visible Butler window behind
another app keeps animating. WebGL context loss is recovered (images are
re-uploaded from cached bytes), and a module that fails to compile or link
falls back to the default (`butler.bloom`) and reports through `onError`.
Unmounting frees every GPU object and gives the context back
(`WEBGL_lose_context`).

Another kind, module, image or filter module crossfades (opacity,
`--motion-slow`): the previous frame is frozen on an overlay canvas and fades
out while the canvas draws the next scene. Params, fit/dim/blur, a tone change
or an equal source (a new but equal object) redraw in place, so dragging a
param slider never flickers.
Once a wallpaper has shown, `none` keeps the canvas mounted: the last frame
fades out and the drawing buffer is released, and the next source fades in
(an image waits for its load first). Reduced motion switches instantly.

## How to use this component

```tsx
<Wallpaper source={{ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }} />
```

Props: `source`, `motion` (`auto` | `paused`), `pauseOnBattery`, `tone` (omit
to follow the nearest theme scope), `scope`, `contentRect` (the main
text/content area in client CSS px, e.g. its `getBoundingClientRect()`),
`registry` (defaults to the nearest `WallpaperRegistryProvider`'s, else the
built-ins), `imageLoader`, `onError`, `dataTestClass`.

Image sources (`{ kind: "image", asset, fit, dim, blur, filter? }`) need an
`imageLoader: (assetId, variant: "full" | "thumbnail") => Promise<Blob>`: the
app's fetch of the asset's encoded bytes (the DS never knows where images
live). Pass it as a prop or once through `WallpaperImageLoaderProvider`
(reaches wallpapers inside DS blocks). The engine asks for `thumbnail` when
the drawing buffer's long edge fits 480px, else `full` (and upgrades on a
resize); it caches bytes per asset and variant while a scene uses them,
decodes with `createImageBitmap`, uploads a mipmapped, edge-clamped texture
and releases both once unused. The previous wallpaper stays until the image
is uploaded (a first image shows its neutral field meanwhile), then
crossfades; a failed load crossfades to `butler.bloom` and reports
`image-load`.

```tsx
<WallpaperImageLoaderProvider loader={(asset, variant) => fetchWallpaper(asset, variant)}>
  <Wallpaper source={{ kind: "image", asset, fit: "cover", dim: 0.2, blur: 0 }} />
</WallpaperImageLoaderProvider>
```

Default dim of a new image (`wallpaperImageDefaultDim(luminance)`, from the
asset's average relative luminance measured at upload): brighter images dim
more, `clamp(0.6 × (luminance − 0.2), 0, 0.4)` on the 0.05 slider grid, so
0.2 → 0, 0.5 → 0.2, 0.8 → 0.35 and 0.83 or brighter → 0.4; unknown → 0.2.

The built-in image module (`butler.image`, static: drawn once per change)
applies `fit` (`cover` crops; `contain` letterboxes onto a neutral field that
follows the theme) and `blur` 0..1 (a radius up to 4% of the canvas's short
edge, sampled from mip levels with a few taps). `dim` 0..1 darkens as a final
pass after any module; the dark theme dims one step more (brightness × 0.8).
A total dim of 0.05 or less draws no pass.
`filter` names a module whose manifest says `image: "optional" | "required"`:
the engine pre-fits the image (fit + blur, at drawing-buffer size) and the
filter reads it as `u_image` — sample `gl_FragCoord.xy / u_resolution`;
`u_imageAspectRatio` is the canvas aspect — then dim applies. So fit, blur and
dim look the same under every filter. An unknown filter, or one with
`image: "none"`, draws the plain image and reports `unknown-module` /
`filter-unsupported`.

`u_contentRect` for the new chat is the headline plus the visible suggestion
cards (`PromptSuggestionList` measures it).

Parameter values resolve per tone: light = `params[k] ?? default`; dark =
`paramsDark[k] ?? defaultDark ?? params[k] ?? default`. A palette value is a
preset name (read for the tone) or a hex list.

Modules: `defineWallpaperModule({ manifest, fragment })` validates a parsed
`wallpaper.json` and the `shader.frag` body (GLSL ES 3.00 without `#version`,
precision or engine uniforms; `main()` writes `fragColor`). The engine prelude
declares `u_resolution`, `u_pixelRatio`, `u_time` (seconds, wrapped every
`timePeriod` s — default and maximum 5000π; 0 for static modules), `u_dark`,
`u_dayPhase`, `u_seed`, `u_noiseTexture` (256×256 RGBA, REPEAT + LINEAR),
`u_image`, `u_hasImage`, `u_imageAspectRatio`, `u_contentRect` (the
`contentRect` in drawing-buffer px — x, y, w, h with a bottom-left origin like
`gl_FragCoord`, clipped to the canvas; zeros when unknown), and one `p_<key>`
uniform per param (number/boolean → float, enum → int index, color → vec3,
palette → vec3[size]).

Manifest options beyond the basics: `timePeriod` (seconds in (0, 5000π]; the
module must be seamless where `u_time` wraps), enum `options` entries as
strings or `{ "value": "...", "label": { "en": "...", "ko": "..." } }`
(unlabeled options show their value), and `"control": "shuffle"` on a number
param (the UI shows a shuffle button that picks a random value on the step
grid — `shuffledWallpaperNumber` — instead of a slider; use it for composition
seeds).

More manifest fields (all optional, still `engine: 1`):

- `"overlay": true` — a two-pass module: `shader.frag` must not read `u_time`
  (linking fails otherwise); the engine draws it at `u_time = 0` into a cached
  drawing-buffer-sized texture and redraws it only when the size, pixel ratio,
  `u_contentRect` (if read), tone, 15-minute `u_dayPhase` step (if read),
  seed, params or the image (asset, a new upload of it, fit, blur) change.
  `overlay.frag` (same prelude and `p_*` uniforms plus `uniform sampler2D
  u_base`, NEAREST) runs every frame. Pass its body as
  `defineWallpaperModule({ ..., overlay })`.
- `"pixelRatio": "default" | "device"` — `device` renders at the device pixel
  ratio capped at 2 with no pixel budget (e.g. 1-device-pixel grain).
- `"imageDim": "auto" | "noDarkStep" | "none"` — how image scenes drawn by
  this module (as a filter or on its default image) are dimmed: `auto` is the
  source's `dim` plus the dark step, `noDarkStep` only the `dim`, `none` never.
- `"defaultImage": "photo.jpg"` — a file beside `shader.frag` (modules with
  `image: optional | required`). Selected as a live source, the module draws
  on it (cover, no blur, dimmed for its luminance like an upload, 0 when that
  is 0.05 or less). The loader
  supplies it as `defineWallpaperModule({ ..., defaultImage: { key, load,
  luminance? } })`; built-ins use `bundledWallpaperImage(url, luminance)`.
  Pickers list such modules as live tiles; `image: required` modules with a
  default image are living photos, not image filters.
- `"sceneTone": { "param": "<boolean param>", "darkPhases": [[a, b], ...] }`
  (1–4 ranges in 0..1) — while that switch is on, the scene is dark when
  `u_dayPhase` is inside a range, else light. `useWallpaperSceneTone(source)`
  (and the pure `wallpaperSceneTone`) reads it on the local clock, re-checking
  every 15 s and when the document shows again; the app lets it set its
  appearance (`crossfadeDocumentChange` fades the switch).
- `"transparent": true` (needs `image: none`) — the module draws only its own
  content and the canvas is see-through everywhere else, e.g. art on a
  TintedGlass card. The canvas is created with `alpha: true` and
  `premultipliedAlpha: true` and cleared to 0 every frame; `fragColor` must be
  premultiplied (`rgb` already multiplied by `a`), so the browser composites it
  as is. There is no background colour and no opaque fallback: a transparent
  module that fails to link leaves the canvas empty (and reports through
  `onError`). `Wallpaper` picks the canvas mode from the source's module;
  context attributes are fixed per canvas, so switching between a transparent
  and an opaque module remounts the canvas (no crossfade). Stills draw on a
  second shared, see-through context and encode PNGs with alpha. The frame
  cap, pixel-ratio limits, pauses, watchdog and context-loss recovery are the
  same as for opaque modules; opaque modules keep their original context.
- `"decoration": true` — a scene for a component surface (e.g. the composer
  card), not an app wallpaper: `WallpaperPicker` (live tiles and image
  filters) and the picker posters leave it out. It still resolves as a `live`
  source.

Stills: `renderWallpaperStill(moduleOrLiveSource, { width, height }, tone,
registry?)` draws one frame (the module's `stillTime` clock, midday, fixed
seed, its default image when it has one), composed at screen width (1440 CSS
px) and scaled down, on a single shared offscreen WebGL2 context, and resolves
an encoded PNG `Blob`. Stills
are cached (most recently used, 48 entries) by `wallpaperStillKey`: the
source's content key (a module keys like its bare source), the module's
content revision (an edited shader renders again), tone and size; a failed
render is not cached. Pickers use it for thumbnails; no wallpaper
instance ever disposes the shared context.

Controls: `WallpaperParamControls` renders a labeled control per manifest
param (label above control): number → slider (or a shuffle button), boolean
→ switch, enum → segmented options with their manifest labels, color →
swatch, palette → presets plus "Custom" swatches. Edits land where the tone
reads them (`withWallpaperParam`).

Built-ins live in `modules/<id>/`: `butler.bloom` (the default), `butler.silk`,
the analog collection (`butler.riso-flow`, `butler.lamina`, `butler.diatom`
two-pass, `butler.dusk`, `butler.shoreline` with a real-time `sceneTone`), the
living photos `butler.photo-clouds` and `butler.photo-daisies` (on their bundled
photos, `imageDim: noDarkStep`), `butler.stipple` (an image filter, two-pass,
`pixelRatio: device`, `imageDim: none`, with a sample photo) and the image
filter `butler.grain` (film grain, `amount` and black-and-white `mono`), and
the decoration `butler.cherry-blossom` (transparent, `pixelRatio: device`: a
cherry branch along a card's top-right padding frame with petals drifting
across; boolean `lush`, on by default, fills the top-right corner); register
more with `createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), module])`
and pass the registry (image filters resolve against it too). Built-ins
cannot be shadowed.

User modules: the app loads them, validates them (`defineWallpaperModule`),
checks them with `checkWallpaperModule(module)` — a compile and link on the
shared still context (its stills then reuse the program) that returns
`{ ok: true }`, `{ ok: false, stage, log }` with the trimmed GLSL log
(`trimWallpaperShaderLog`), or null without WebGL2 — and supplies one
registry through `WallpaperRegistryProvider` (`registry`, `userModules` for
pickers, `onError` hearing every wallpaper below). A new registry
re-resolves every wallpaper: a module's new shader (another
`wallpaperModuleRevision`) crossfades in, and a module the registry dropped
falls back to the default with `unknown-module`. Programs are kept per module
id, so an edited shader replaces (and deletes) the previous program. At
runtime the engine also reports the module on screen when the frame-time
watchdog holds a still frame (`degraded`) or the context is lost
(`context-lost`), so the app can retire a user module that overloads the GPU.

## Who can use this component

Butler client containers and DS blocks. Wallpaper choice and persistence stay
in the container (settings, project preferences, agent tools).

## Best practice

- Keep the `source` object stable (module constant or memoized settings); the
  engine also keys by content, so an equal new object never rebuilds.
- Put text over a wallpaper on TintedGlass or keep the module low-contrast.
- Pass `contentRect` (measured from the text/content element) so modules can
  keep detail and contrast away from the text; pass it by value, the engine
  redraws only modules that read it.
- Add new looks as modules (`wallpaper.json` + `shader.frag`), not as
  components or product CSS.

## Wrong use cases

- Do not draw canvases or shaders in product code; add a module.
- Do not use it as a decorative panel fill inside content; use `TintedGlass`
  (a transparent decoration module drawn on that glass is the exception).
- Do not pass raw CSS colors or gradients; wallpapers are modules or images.

## Tags

wallpaper, background, shader, webgl, theme, new-chat, dashboard
